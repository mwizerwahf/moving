// Developer API, read-only, Bearer-token protected. Returns readings exactly as received.
import { addSeconds, all, batch, first, iso, now, run, stmt } from "./db.js";
import { fetchItems, profilesFrom, READING_COLUMNS, toItem } from "./items.js";
import { API_TOKEN_PREFIX, sha256 } from "./security.js";

export class HttpError extends Error {
  constructor(status, detail, headers = {}) {
    super(detail);
    this.status = status;
    this.headers = headers;
  }
}

const json = (obj, status = 200, headers = {}) =>
  new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json", ...headers } });

export function errorResponse(e) {
  return json({ detail: e.message }, e.status, e.headers);
}

async function requireToken(request, env, ctx, url) {
  const auth = request.headers.get("authorization") || "";
  let token = auth.toLowerCase().startsWith("bearer ") ? auth.slice(7).trim() : null;
  if (!token && url.pathname.endsWith("/stream")) token = url.searchParams.get("token"); // EventSource cannot set headers
  const www = { "WWW-Authenticate": "Bearer" };
  if (!token || !token.startsWith(API_TOKEN_PREFIX)) throw new HttpError(401, "missing or malformed API token", www);
  const row = await first(env.DB, "SELECT id, name, last_used_at FROM api_tokens WHERE token_hash = ? AND revoked = 0",
    await sha256(token));
  if (!row) throw new HttpError(401, "invalid or revoked API token", www);
  // Record use at most every 5 minutes: D1's free plan counts every row written.
  if (!row.last_used_at || row.last_used_at < addSeconds(-300))
    ctx.waitUntil(run(env.DB, "UPDATE api_tokens SET last_used_at = ? WHERE id = ?", now(), row.id).catch(() => {}));
  return row;
}

function intParam(url, name, { def = null, min = -Infinity, max = Infinity } = {}) {
  const v = url.searchParams.get(name);
  if (v === null || v === "") return def;
  if (!/^-?\d+$/.test(v)) throw new HttpError(422, `${name} must be a whole number`);
  const n = parseInt(v, 10);
  if (n < min || n > max) throw new HttpError(422, `${name} must be between ${min} and ${max === Infinity ? "any" : max}`);
  return n;
}

function timeParam(url, name) {
  let v = url.searchParams.get(name);
  if (!v) return null;
  v = v.trim().replace(" ", "T");
  if (/^\d{4}-\d{2}-\d{2}$/.test(v)) v += "T00:00:00";
  if (!/(Z|[+-]\d{2}:?\d{2})$/i.test(v)) v += "Z"; // no time zone given: UTC
  const t = Date.parse(v);
  if (!Number.isFinite(t)) throw new HttpError(422, `${name} must be an ISO 8601 date-time`);
  return new Date(t).toISOString();
}

const DEVICE_COLS = "id, imei, name, plate, active, created_at, last_seen_at";

async function deviceOr404(env, imei) {
  const d = await first(env.DB, `SELECT ${DEVICE_COLS} FROM devices WHERE imei = ?`, imei);
  if (!d) throw new HttpError(404, "unknown device");
  return d;
}

const deviceJson = (d) => ({
  imei: d.imei, name: d.name, plate: d.plate, active: !!d.active,
  created_at: iso(d.created_at), last_seen_at: iso(d.last_seen_at),
});

/** Devices with their latest reading in two queries, via devices.last_reading_id (no scans). */
export async function devicesWithLatest(db, where = "", params = [], order = "d.name, d.imei") {
  const cols = READING_COLUMNS.split(", ").filter((c) => c.startsWith("r.")).map((c) => `${c} AS ${c.slice(2)}`).join(", ");
  const [rows, cals] = await batch(db, [
    stmt(db,
      `SELECT d.id AS dev_id, d.imei, d.name, d.plate, d.active, d.created_at AS dev_created_at, d.last_seen_at, ` +
      `d.n_readings, ${cols} FROM devices d LEFT JOIN readings r ON r.id = d.last_reading_id ${where} ORDER BY ${order}`, ...params),
    stmt(db, "SELECT device_id, tank, profile FROM calibrations WHERE active = 1 ORDER BY id"),
  ]);
  const profiles = profilesFrom(cals);
  return rows.map((row) => ({
    d: { id: row.dev_id, imei: row.imei, name: row.name, plate: row.plate, active: row.active,
      created_at: row.dev_created_at, last_seen_at: row.last_seen_at, n_readings: row.n_readings },
    it: row.id ? toItem({ ...row, device_id: row.dev_id }, profiles[row.dev_id]) : null,
  }));
}

export async function handleApi(request, env, ctx, url) {
  const path = url.pathname.replace(/\/+$/, "") || "/";
  const m = (re) => path.match(re);
  if (request.method !== "GET" && request.method !== "HEAD") throw new HttpError(405, "method not allowed");

  if (path === "/api/v1/health") {
    await first(env.DB, "SELECT 1 AS ok");
    return json({ ok: true });
  }

  await requireToken(request, env, ctx, url);
  const db = env.DB;
  let p;

  if (path === "/api/v1/devices") {
    const rows = await devicesWithLatest(db);
    return json({ items: rows.map(({ d, it }) => ({ ...deviceJson(d), latest: it })) });
  }

  if ((p = m(/^\/api\/v1\/devices\/([^/]+)$/))) {
    const rows = await devicesWithLatest(db, "WHERE d.imei = ?", [decodeURIComponent(p[1])]);
    if (!rows.length) throw new HttpError(404, "unknown device");
    return json({ ...deviceJson(rows[0].d), latest: rows[0].it });
  }

  if ((p = m(/^\/api\/v1\/devices\/([^/]+)\/readings$/))) {
    const limit = intParam(url, "limit", { def: 100, min: 1, max: 1000 });
    const beforeId = intParam(url, "before_id", { min: 1 });
    const since = timeParam(url, "since");
    const until = timeParam(url, "until");
    const d = await deviceOr404(env, decodeURIComponent(p[1]));
    const where = ["r.device_id = ?"], params = [d.id];
    if (beforeId) { where.push("r.id < ?"); params.push(beforeId); }
    if (since) { where.push("r.received_at >= ?"); params.push(since); }
    if (until) { where.push("r.received_at < ?"); params.push(until); }
    const items = await fetchItems(db, where.join(" AND "), params, "r.id DESC", limit);
    return json({ items, next_before_id: items.length === limit ? items[items.length - 1].id : null });
  }

  if (path === "/api/v1/readings") {
    const afterId = intParam(url, "after_id", { def: 0, min: 0 });
    const limit = intParam(url, "limit", { def: 500, min: 1, max: 1000 });
    const imei = url.searchParams.get("imei");
    let items;
    if (imei) {
      const d = await deviceOr404(env, imei);
      items = await fetchItems(db, "r.id > ? AND r.device_id = ?", [afterId, d.id], "r.id ASC", limit);
    } else {
      items = await fetchItems(db, "r.id > ?", [afterId], "r.id ASC", limit);
    }
    return json({ items, next_after_id: items.length ? items[items.length - 1].id : afterId });
  }

  if ((p = m(/^\/api\/v1\/readings\/(\d+)$/))) {
    const items = await fetchItems(db, "r.id = ?", [parseInt(p[1], 10)], "r.id DESC", 1);
    if (!items.length) throw new HttpError(404, "unknown reading");
    return json(items[0]);
  }

  if ((p = m(/^\/api\/v1\/devices\/([^/]+)\/calibrations$/))) {
    const d = await deviceOr404(env, decodeURIComponent(p[1]));
    const rows = await all(db, "SELECT tank, profile, created_at FROM calibrations WHERE device_id = ? AND active = 1 ORDER BY tank, id DESC", d.id);
    const seen = new Set();
    const items = [];
    for (const r of rows) {
      if (seen.has(r.tank)) continue;
      seen.add(r.tank);
      items.push({ tank: r.tank, created_at: iso(r.created_at), profile: JSON.parse(r.profile) });
    }
    return json({ items });
  }

  if (path === "/api/v1/stream") return stream(request, env, ctx, url);

  throw new HttpError(404, "Not Found");
}

// ------------------------------------------------------------------ live stream (SSE)
// Workers share no memory between requests, so the stream polls D1 every few seconds.
// The free plan allows 50 D1 queries per request, so a stream ends after about two minutes;
// the client reconnects by itself (EventSource does; see the "retry" line) with
// Last-Event-ID and nothing is lost.
const POLL_MS = 3000;
const MAX_QUERIES = 40;
const PING_MS = 15000;

async function stream(request, env, ctx, url) {
  const db = env.DB;
  const imei = url.searchParams.get("imei");
  let afterId = intParam(url, "after_id", { min: 0 });
  const last = request.headers.get("last-event-id");
  if (last && /^\d+$/.test(last)) afterId = parseInt(last, 10);

  let deviceId = null;
  if (imei) deviceId = (await deviceOr404(env, imei)).id;
  if (afterId === null) { // only new readings from now on
    afterId = (await first(db, "SELECT coalesce(max(id), 0) AS m FROM readings")).m;
  }

  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter();
  const enc = new TextEncoder();
  const write = (s) => writer.write(enc.encode(s));
  let queries = 3;
  let profiles = null;

  const pump = async () => {
    let sent = afterId;
    let lastWrite = Date.now();
    try {
      await write(`retry: ${POLL_MS}\n\n`);
      while (queries < MAX_QUERIES) {
        const where = deviceId ? "r.id > ? AND r.device_id = ?" : "r.id > ?";
        const params = deviceId ? [sent, deviceId] : [sent];
        const rows = (await stmt(db,
          `SELECT ${READING_COLUMNS} FROM readings r JOIN devices d ON d.id = r.device_id WHERE ${where} ORDER BY r.id ASC LIMIT 200`,
          ...params).all()).results;
        queries++;
        if (rows.length) {
          if (!profiles) { // the calibrations table is small: load it once per stream
            profiles = profilesFrom(await all(db, "SELECT device_id, tank, profile FROM calibrations WHERE active = 1 ORDER BY id"));
            queries++;
          }
          let out = "";
          for (const r of rows) {
            const it = toItem(r, profiles[r.device_id]);
            out += `id: ${it.id}\nevent: reading\ndata: ${JSON.stringify(it)}\n\n`;
            sent = it.id;
          }
          await write(out);
          lastWrite = Date.now();
          if (rows.length === 200) continue; // catching up
        } else if (Date.now() - lastWrite >= PING_MS) {
          await write(": ping\n\n");
          lastWrite = Date.now();
        }
        await new Promise((res) => setTimeout(res, POLL_MS));
      }
    } catch {
      // client went away
    } finally {
      try { await writer.close(); } catch { /* already closed */ }
    }
  };
  ctx.waitUntil(pump());
  return new Response(readable, {
    headers: { "content-type": "text/event-stream", "cache-control": "no-cache", "x-accel-buffering": "no" },
  });
}
