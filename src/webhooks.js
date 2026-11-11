// Forward every new reading to developers' webhook URLs, signed, with retries.
//
// Cloudflare Pages has no cron and no long-running process, so this work runs "in the
// background" of ordinary requests (ctx.waitUntil): right after each ingest that created
// deliveries, and whenever someone opens the web interface. Housekeeping runs at most hourly.
import { settings } from "./config.js";
import { addSeconds, all, batch, first, now, stmt } from "./db.js";
import { itemsFor, readingsStmt } from "./items.js";
import { signWebhook } from "./security.js";

export class UnsafeURL extends Error {}

export function checkUrlShape(env, url) {
  url = String(url || "").trim();
  let parts;
  try { parts = new URL(url); } catch { throw new UnsafeURL("webhook URL must start with https:// and include a host name"); }
  const allowed = settings(env).allowHttpWebhooks ? ["https:", "http:"] : ["https:"];
  if (!allowed.includes(parts.protocol) || !parts.hostname) throw new UnsafeURL("webhook URL must start with https:// and include a host name");
  if (parts.username || parts.password) throw new UnsafeURL("webhook URL must not contain a user name or password");
  if (url.length > 500) throw new UnsafeURL("webhook URL is too long");
  return url;
}

function privateIp(ip) {
  ip = ip.replace(/^\[|\]$/g, "").toLowerCase();
  const v4 = ip.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    return a === 0 || a === 10 || a === 127 || a >= 224 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || (a === 192 && b === 0) || (a === 198 && (b === 18 || b === 19));
  }
  if (ip.includes(":")) {
    return ip === "::" || ip === "::1" || /^(fc|fd|fe8|fe9|fea|feb|ff)/.test(ip) || ip.startsWith("::ffff:") || ip.startsWith("64:ff9b:");
  }
  return false;
}

/** Refuse URLs that point at private, loopback or link-local addresses (checked with DNS over HTTPS). */
export async function checkUrlTarget(env, url) {
  if (settings(env).allowPrivateWebhooks) return;
  const host = new URL(url).hostname.toLowerCase();
  if (privateIp(host)) throw new UnsafeURL(`${host} is a non-public address`);
  if (/^[\d.]+$/.test(host) || host.startsWith("[")) return; // public IP literal
  if (host === "localhost" || /\.(localhost|local|internal|lan|home\.arpa)$/.test(host) || !host.includes("."))
    throw new UnsafeURL(`${host} resolves to a non-public address`);
  const answers = [];
  for (const type of ["A", "AAAA"]) {
    try {
      const r = await fetch(`https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(host)}&type=${type}`,
        { headers: { accept: "application/dns-json" }, signal: AbortSignal.timeout(4000) });
      const data = await r.json();
      for (const a of data.Answer || []) if (a.type === 1 || a.type === 28) answers.push(a.data);
    } catch { /* treated as unresolvable below */ }
  }
  if (!answers.length) throw new UnsafeURL(`cannot resolve ${host}`);
  if (answers.some(privateIp)) throw new UnsafeURL(`${host} resolves to a non-public address`);
}

export const backoffSeconds = (attempts) => Math.min(10 * 2 ** attempts, 3600);

/** Send up to `limit` due deliveries. Returns how many were attempted. */
export async function deliverDue(env, limit = 10) {
  const db = env.DB;
  const cfg = settings(env);
  // Claim the rows first, so two requests running this at once do not both send them.
  const due = await all(db,
    "UPDATE webhook_deliveries SET next_attempt_at = ? WHERE id IN (" +
    "SELECT wd.id FROM webhook_deliveries wd JOIN webhooks w ON w.id = wd.webhook_id " +
    "WHERE wd.status = 'pending' AND w.active = 1 AND wd.next_attempt_at <= ? ORDER BY wd.id LIMIT ?) " +
    "RETURNING id, webhook_id, reading_id, attempts", addSeconds(120), now(), limit);
  if (!due.length) return 0;

  const [hooks, rows] = await batch(db, [
    stmt(db, "SELECT id, url, secret FROM webhooks WHERE id IN (SELECT value FROM json_each(?))",
      JSON.stringify([...new Set(due.map((d) => d.webhook_id))])),
    readingsStmt(db, "r.id IN (SELECT value FROM json_each(?))", [JSON.stringify(due.map((d) => d.reading_id))], "r.id ASC", limit),
  ]);
  const hookById = new Map(hooks.map((h) => [h.id, h]));
  const itemById = new Map((await itemsFor(db, rows)).map((it) => [it.id, it]));
  const enc = new TextEncoder();

  const outcomes = await Promise.all(due.map(async (d) => {
    const hook = hookById.get(d.webhook_id);
    const item = itemById.get(d.reading_id);
    if (!item || !hook) return { d, gone: true };
    const body = enc.encode(JSON.stringify({ event: "reading.created", ...item }));
    const ts = String(Math.floor(Date.now() / 1000));
    let code = null, error = null;
    try {
      const r = await fetch(hook.url, {
        method: "POST", body, redirect: "manual", signal: AbortSignal.timeout(10000),
        headers: {
          "Content-Type": "application/json", "User-Agent": "car-gateway/2.0",
          "X-FGT-Event": "reading.created", "X-FGT-Delivery": String(d.id),
          "X-FGT-Timestamp": ts, "X-FGT-Signature": await signWebhook(hook.secret, ts, body),
        },
      });
      code = r.status;
      if (code < 200 || code >= 300) error = `HTTP ${code}`;
      try { await r.body?.cancel(); } catch { /* ignore */ }
    } catch (e) {
      error = e?.name === "TimeoutError" ? "Timeout" : (e?.name || "Error") + (e?.message ? ": " + e.message : "");
    }
    return { d, code, error };
  }));

  const t = now();
  await batch(db, outcomes.map(({ d, gone, code, error }) => {
    if (gone) return stmt(db, "UPDATE webhook_deliveries SET status='failed', last_error='reading deleted' WHERE id=?", d.id);
    const attempts = d.attempts + 1;
    if (error === null) {
      return stmt(db, "UPDATE webhook_deliveries SET status='delivered', attempts=?, last_code=?, last_error=NULL, delivered_at=? WHERE id=?",
        attempts, code, t, d.id);
    }
    return stmt(db, "UPDATE webhook_deliveries SET status=?, attempts=?, last_code=?, last_error=?, next_attempt_at=? WHERE id=?",
      attempts >= cfg.webhookMaxAttempts ? "failed" : "pending", attempts, code, error.slice(0, 300),
      addSeconds(backoffSeconds(attempts)), d.id);
  }));
  return due.length;
}

/** Hourly clean-up. Deletes in chunks so each run stays small. */
export async function housekeeping(env) {
  const db = env.DB;
  const claimed = await first(db,
    "UPDATE meta SET value = ? WHERE key = 'housekeeping_at' AND value < ? RETURNING key", now(), addSeconds(-3600));
  if (!claimed) return false;
  const t = now();
  const statements = [
    stmt(db, "DELETE FROM sessions WHERE expires_at < ?", t),
    stmt(db, "DELETE FROM login_failures WHERE at < ?", addSeconds(-900)),
    stmt(db, "DELETE FROM webhook_deliveries WHERE status = 'delivered' AND delivered_at < ?", addSeconds(-7 * 86400)),
    stmt(db, "DELETE FROM webhook_deliveries WHERE status = 'failed' AND next_attempt_at < ?", addSeconds(-30 * 86400)),
  ];
  const cfg = settings(env);
  // Ids grow with time, so "older than cutoff" is "id below the first newer row". The scan
  // stops at that row, so it reads only rows that are about to be deleted. At most 5000 rows
  // per table per run, so a large backlog is cleared over several runs.
  const cutId = (table) =>
    `min(coalesce((SELECT id FROM ${table} WHERE received_at >= ? ORDER BY id LIMIT 1), ` +
    `(SELECT coalesce(max(id), 0) + 1 FROM ${table})), (SELECT coalesce(min(id), 0) + 5000 FROM ${table}))`;
  if (cfg.retentionDays > 0) {
    const cut = await first(db, `SELECT ${cutId("readings")} AS rid`, addSeconds(-cfg.retentionDays * 86400));
    const counts = await all(db, "SELECT device_id, count(*) AS n FROM readings WHERE id < ? GROUP BY device_id", cut.rid);
    for (const c of counts)
      statements.push(stmt(db, "UPDATE devices SET n_readings = max(0, n_readings - ?) WHERE id = ?", c.n, c.device_id));
    statements.push(
      stmt(db, "DELETE FROM readings WHERE id < ?", cut.rid),
      stmt(db, "DELETE FROM webhook_deliveries WHERE reading_id < ?", cut.rid),
    );
  }
  // Raw request bodies only serve the "as received" view of a reading, and they double the
  // storage used. Keep them for RAW_BODY_DAYS (default 7); 0 = as long as the readings.
  const bodyDays = cfg.rawBodyDays > 0 ? cfg.rawBodyDays : cfg.retentionDays;
  if (bodyDays > 0) {
    const cut = await first(db, `SELECT ${cutId("ingests")} AS iid`, addSeconds(-bodyDays * 86400));
    statements.push(stmt(db, "DELETE FROM ingests WHERE id < ?", cut.iid));
  }
  await batch(db, statements);
  return true;
}

/** For ctx.waitUntil(): never throws. */
export async function runBackground(env, { deliver = true } = {}) {
  if (deliver) {
    try { await deliverDue(env); } catch (e) { console.error("webhook delivery error", e); }
  }
  try { await housekeeping(env); } catch (e) { console.error("housekeeping error", e); }
}
