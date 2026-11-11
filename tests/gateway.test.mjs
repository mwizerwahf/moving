// End-to-end test against the real app running locally in "wrangler pages dev" (workerd + local D1).
//   npm test
// Uses a throw-away database folder; never touches the Cloudflare database.
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createHmac } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { hashPassword } from "../scripts/manage.mjs";

const PORT = 8799;
const BASE = `http://127.0.0.1:${PORT}`;
const IMEI = "866123456789012";
const WRANGLER = join("node_modules", "wrangler", "bin", "wrangler.js");
const persist = mkdtempSync(join(tmpdir(), "car-gateway-test-"));
let server;
let hookServer;

const wrangler = (...args) => execFileSync(process.execPath, [WRANGLER, ...args], { stdio: "pipe" });

function reading(seq, over = {}) {
  return {
    seq, ts: "2026-11-01T09:12:40Z", ts_src: "gnss", uptime_ms: 1000 * seq,
    gnss: { fix: true, lat: -1.944123, lng: 30.061233, alt_m: 1567, speed_kmh: 0.5, heading_deg: null, sats: 8, hdop: 1.1, age_ms: 420 },
    cell: { state: "ready", rat: "lte", mcc: 635, mnc: 10, tac: 1201, ci: 26381057, rsrp_dbm: -97, rsrq_db: -11, csq: 21 },
    cell_loc: null, veh: { ign: false, ext_mv: 12650, bat_mv: 4010 },
    fuel: [{ tank: 1, method: "capacitive", model: "escort_td150", raw: 2310, raw_unit: "count", temp_c: 27, status: "ok" }],
    q: { queued: 0, dropped: 0 }, ...over,
  };
}
const envelope = (readings, imei = IMEI, boot = "a1b2c3d4") =>
  ({ schema: "fgt/2.0", imei, iccid: "8925010000123456789", fw: "3.0.0", boot, readings });

// ------------------------------------------------------------------ tiny browser with a cookie jar
let cookie = "";
async function req(path, { method = "GET", form, json, body, headers = {} } = {}) {
  const h = { ...headers };
  if (cookie) h.cookie = cookie;
  if (form) { h["content-type"] = "application/x-www-form-urlencoded"; body = new URLSearchParams(form).toString(); }
  if (json !== undefined) { h["content-type"] = "application/json"; body = JSON.stringify(json); }
  const r = await fetch(BASE + path, { method, headers: h, body, redirect: "manual" });
  const sc = r.headers.get("set-cookie");
  if (sc) { const v = sc.split(";")[0]; cookie = v.endsWith("=") ? "" : v; }
  return r;
}
const ingest = (body, key, raw) => req("/ingest", {
  method: "POST", headers: key ? { "X-Api-Key": key } : {},
  ...(raw !== undefined ? { body: raw } : { json: body }),
});

before(async () => {
  wrangler("d1", "execute", "car-gateway", "--local", `--persist-to=${persist}`, "--file=schema.sql");
  const sql = `INSERT INTO users (username, pw_hash) VALUES ('admin', '${hashPassword("correct horse battery")}')`;
  wrangler("d1", "execute", "car-gateway", "--local", `--persist-to=${persist}`, `--command=${sql}`);
  server = spawn(process.execPath, [WRANGLER, "pages", "dev", "--port", String(PORT), "--ip", "127.0.0.1",
    `--persist-to=${persist}`, "--binding", "ALLOW_PRIVATE_WEBHOOKS=1", "--binding", "ALLOW_HTTP_WEBHOOKS=1",
    "--binding", "COOKIE_SECURE=0", "--show-interactive-dev-session=false"], { stdio: ["ignore", "pipe", "pipe"] });
  let log = "";
  server.stdout.on("data", (d) => { log += d; });
  server.stderr.on("data", (d) => { log += d; });
  for (let i = 0; i < 120; i++) {
    try { if ((await fetch(BASE + "/api/v1/health")).ok) return; } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error("wrangler pages dev did not start:\n" + log);
});

after(() => {
  server?.kill();
  hookServer?.close();
  try { rmSync(persist, { recursive: true, force: true }); } catch { /* Windows may hold files briefly */ }
});

async function login() {
  const r = await req("/login", { method: "POST", form: { username: "admin", password: "correct horse battery" } });
  assert.equal(r.status, 303);
  const page = await (await req("/admin")).text();
  return page.match(/name="csrf" value="([^"]+)"/)[1];
}

test("full flow", async () => {
  const csrf = await login();

  // register a unit through the web form; the key is shown once
  let r = await req("/admin/devices", { method: "POST", form: { csrf, imei: IMEI, name: "Hilux 1", plate: "RAD 123 A" } });
  assert.equal(r.status, 200);
  const key = (await r.text()).match(/class="secret">(dk_[^<]+)</)[1];

  // CSRF is enforced
  r = await req("/admin/devices", { method: "POST", form: { csrf: "wrong", imei: "866000000000001" } });
  assert.equal(r.status, 403);

  // API token
  r = await req("/admin/tokens", { method: "POST", form: { csrf, name: "Test app" } });
  const token = (await r.text()).match(/class="secret">(at_[^<]+)</)[1];
  const auth = { Authorization: `Bearer ${token}` };

  // webhook receiver on localhost
  const got = [];
  hookServer = createServer((rq, rs) => {
    const chunks = [];
    rq.on("data", (c) => chunks.push(c));
    rq.on("end", () => { got.push([rq.headers, Buffer.concat(chunks)]); rs.writeHead(200); rs.end(); });
  });
  await new Promise((res) => hookServer.listen(0, "127.0.0.1", res));
  r = await req("/admin/webhooks", { method: "POST", form: { csrf, url: `http://127.0.0.1:${hookServer.address().port}/hook` } });
  const secret = (await r.text()).match(/class="secret">(whsec_[^<]+)</)[1];

  // ingest: auth failures and bad bodies
  const body = envelope([reading(0), reading(1)]);
  assert.equal((await ingest(body)).status, 401);
  assert.equal((await ingest(body, "dk_nope")).status, 401);
  assert.equal((await ingest(envelope([reading(0)], "866000000000009"), key)).status, 403);
  assert.equal((await ingest({ ...body, schema: "fgt/1.0" }, key)).status, 400);
  assert.equal((await ingest(null, key, "not json")).status, 400);
  assert.equal((await ingest(envelope(Array.from({ length: 21 }, (_, i) => reading(i))), key)).status, 400);

  // ingest: success and duplicates
  r = await ingest(body, key);
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { ok: true, stored: 2, duplicates: 0 });
  r = await ingest(envelope([reading(1), reading(2, { gnss: { fix: false }, ts: null })]), key);
  assert.deepEqual(await r.json(), { ok: true, stored: 1, duplicates: 1 });

  // API returns the payload exactly as received
  r = await req(`/api/v1/devices/${IMEI}/readings`, { headers: auth });
  const items = (await r.json()).items;
  assert.deepEqual(items.map((i) => i.payload.seq), [2, 1, 0]);
  assert.deepEqual(items[1].payload, reading(1));
  assert.equal(items[1].envelope.iccid, "8925010000123456789");
  assert.equal(items[1].derived.position.src, "gnss");
  assert.equal(items[1].derived.position.acc_m, 5.5);
  assert.equal(items[1].derived.time, "2026-11-01T09:12:40Z");
  assert.equal(items[0].derived.position, null); // no fix, no cell lookup key
  assert.equal(items[0].derived.time_src, "server");
  assert.equal(items[1].derived.fuel[0].note, "no calibration");

  // API auth and parameters
  assert.equal((await req("/api/v1/devices")).status, 401);
  assert.equal((await req("/api/v1/devices", { headers: { Authorization: "Bearer at_x" } })).status, 401);
  assert.equal((await req("/api/v1/readings?limit=5000", { headers: auth })).status, 422);
  assert.equal((await req("/api/v1/devices/000", { headers: auth })).status, 404);
  r = await req("/api/v1/devices", { headers: auth });
  const devs = (await r.json()).items;
  assert.equal(devs[0].latest.payload.seq, 2);
  assert.equal(devs[0].active, true);

  // calibration through the web form, then litres appear in derived
  const prof = { schema: "fgt-cal/2.0", tank: 1, method: "capacitive", model: "escort_td150", raw_unit: "count",
    capacity_l: 80, valid_raw: [0, 4095], table: [[0, 0], [1650, 30], [2480, 45], [4095, 80]] };
  r = await req(`/devices/${IMEI}/calibration`, { method: "POST", form: { csrf, profile: JSON.stringify(prof) } });
  assert.equal(r.status, 303);
  assert.match(decodeURIComponent(r.headers.get("location")), /saved/);
  r = await req(`/devices/${IMEI}/calibration`, { method: "POST", form: { csrf, profile: JSON.stringify({ ...prof, table: [[0, 0]] }) } });
  assert.match(decodeURIComponent(r.headers.get("location")), /Not saved/);
  r = await req("/api/v1/readings?after_id=0", { headers: auth });
  const feed = await r.json();
  assert.equal(feed.items[0].derived.fuel[0].litres, 41.9); // 30 + 15*(660/830)
  assert.equal(feed.items[0].derived.fuel[0].level_pct, 52.4);
  assert.equal(feed.next_after_id, feed.items[feed.items.length - 1].id);
  r = await req(`/api/v1/devices/${IMEI}/calibrations`, { headers: auth });
  assert.equal((await r.json()).items[0].profile.capacity_l, 80);

  // live stream: replay after id 0, then a new reading arrives live
  const ac = new AbortController();
  const events = [];
  const streamDone = (async () => {
    const res = await fetch(`${BASE}/api/v1/stream?after_id=0`, { headers: auth, signal: ac.signal });
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type"), /text\/event-stream/);
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    while (events.length < 4) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        if (line.startsWith("data: ")) events.push(JSON.parse(line.slice(6)));
      }
    }
    ac.abort();
  })().catch((e) => { if (e.name !== "AbortError") throw e; });
  await new Promise((res) => setTimeout(res, 500));
  await ingest(envelope([reading(3)]), key);
  await Promise.race([streamDone, new Promise((_, rej) => setTimeout(() => rej(new Error("stream timeout")), 15000))]);
  assert.deepEqual(events.map((e) => e.payload.seq), [0, 1, 2, 3]);

  // webhooks: 4 readings delivered, signed
  for (let i = 0; i < 50 && got.length < 4; i++) await new Promise((res) => setTimeout(res, 200));
  assert.equal(got.length, 4);
  // deliveries are sent in parallel, so they may arrive in any order
  const [headers, rawBody] = got.find(([, b]) => JSON.parse(b).payload.seq === 0);
  assert.deepEqual(got.map(([, b]) => JSON.parse(b).payload.seq).sort(), [0, 1, 2, 3]);
  const expected = "sha256=" + createHmac("sha256", secret).update(headers["x-fgt-timestamp"] + ".").update(rawBody).digest("hex");
  assert.equal(headers["x-fgt-signature"], expected);
  const sent = JSON.parse(rawBody);
  assert.equal(sent.event, "reading.created");
  assert.deepEqual(sent.payload, reading(0));

  // web pages render
  for (const path of ["/", `/devices/${IMEI}`, "/admin", "/developers", `/readings/${items[1].id}`]) {
    r = await req(path);
    assert.equal(r.status, 200, path);
    assert.ok(r.headers.get("content-security-policy"), path);
    await r.text();
  }
  const page = await (await req(`/devices/${IMEI}`)).text();
  assert.ok(page.includes("41.9 L") && page.includes("RAD 123 A"));
  assert.ok(page.includes("<dd>4</dd>"), "readings stored counter");

  // static files are served by Pages, not the Function
  r = await fetch(`${BASE}/static/style.css?v=2`);
  assert.equal(r.status, 200);
  assert.match(r.headers.get("cache-control") || "", /max-age/);
  r = await fetch(`${BASE}/api/openapi.json`);
  assert.equal(r.status, 200);
  await r.json();

  // revoke token
  const admin = await (await req("/admin")).text();
  const tid = admin.match(/\/admin\/tokens\/(\d+)\/revoke/)[1];
  await req(`/admin/tokens/${tid}/revoke`, { method: "POST", form: { csrf } });
  assert.equal((await req("/api/v1/devices", { headers: auth })).status, 401);

  // disabled device is refused
  await req(`/devices/${IMEI}/settings`, { method: "POST", form: { csrf, name: "Hilux 1", plate: "RAD 123 A", active: "" } });
  assert.equal((await ingest(envelope([reading(9)]), key)).status, 401);

  // logout ends the session
  await req("/logout", { method: "POST", form: { csrf } });
  assert.equal((await req("/admin")).status, 303);
});

test("login throttle", async () => {
  for (let i = 0; i < 10; i++) await (await req("/login", { method: "POST", form: { username: "admin", password: "wrong" } })).text();
  const r = await req("/login", { method: "POST", form: { username: "admin", password: "correct horse battery" } });
  assert.match(await r.text(), /Too many attempts/);
});
