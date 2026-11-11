// POST /ingest: the only endpoint the vehicle units call (fgt/2.0 over 4G).
import { settings } from "./config.js";
import { batch, first, now, stmt } from "./db.js";
import { derivePosition } from "./position.js";
import { clientIp, sha256 } from "./security.js";
import { runBackground } from "./webhooks.js";

export const IMEI_RE = /^\d{14,16}$/;

const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json" } });
const err = (status, message) => json({ ok: false, error: message }, status);
const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

const TS_RE = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})$/i;

/** A device time with a time zone, as UTC ISO text; anything else is null. */
export function parseTs(value) {
  if (typeof value !== "string" || !TS_RE.test(value)) return null;
  const t = Date.parse(value.replace(" ", "T"));
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}

function deviceKey(request) {
  let key = request.headers.get("x-api-key");
  const auth = request.headers.get("authorization") || "";
  if (!key && auth.toLowerCase().startsWith("bearer ")) key = auth.slice(7).trim();
  return key || null;
}

export async function ingest(request, env, ctx) {
  const cfg = settings(env);
  const key = deviceKey(request);
  if (!key) return err(401, "missing device key");
  if (Number(request.headers.get("content-length") || 0) > cfg.maxBodyBytes) return err(413, "request too large");
  const bytes = new Uint8Array(await request.arrayBuffer());
  if (bytes.byteLength > cfg.maxBodyBytes) return err(413, "request too large");

  const db = env.DB;
  const device = await first(db, "SELECT id, imei, last_reading_id FROM devices WHERE key_hash = ? AND active = 1",
    await sha256(key));
  if (!device) return err(401, "unknown or disabled device key");

  let body, data;
  try {
    body = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    data = JSON.parse(body);
  } catch {
    return err(400, "body is not valid JSON");
  }
  if (!isObj(data)) return err(400, "body must be a JSON object");
  if (typeof data.schema !== "string" || !data.schema.startsWith("fgt/2.")) return err(400, "unsupported schema; expected fgt/2.x");
  if (data.imei !== device.imei) return err(403, "imei does not match this device key");
  const boot = data.boot;
  if (typeof boot !== "string" || boot.length < 1 || boot.length > 32) return err(400, "boot must be a string of 1 to 32 characters");
  const readings = data.readings;
  if (!Array.isArray(readings) || readings.length > cfg.maxReadings)
    return err(400, `readings must be an array of at most ${cfg.maxReadings}`);
  for (const r of readings) {
    if (!isObj(r) || !Number.isInteger(r.seq) || r.seq < 0) return err(400, "every reading needs an integer seq of 0 or more");
  }

  const { readings: _omit, ...envelope } = data;
  const envelopeText = JSON.stringify(envelope);
  const remoteIp = clientIp(request);
  const receivedAt = now();
  const after = device.last_reading_id || 0;
  const memo = new Map();
  const positions = await Promise.all(readings.map((r) => derivePosition(env, r, memo)));

  // One round trip, one transaction. Inside it, max(id) of ingests is the row just inserted.
  const THIS_INGEST = "(SELECT max(id) FROM ingests)";
  const statements = [
    stmt(db, "INSERT INTO ingests (device_id, received_at, remote_ip, body, n_readings) VALUES (?, ?, ?, ?, ?)",
      device.id, receivedAt, remoteIp, body, readings.length),
    ...readings.map((r, i) => {
      const [lat, lng, src, acc] = positions[i];
      return stmt(db,
        "INSERT INTO readings (device_id, ingest_id, boot, seq, ts, received_at, envelope, payload, lat, lng, pos_src, acc_m) " +
        `VALUES (?, ${THIS_INGEST}, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (device_id, boot, seq) DO NOTHING RETURNING id`,
        device.id, boot, r.seq, parseTs(r.ts), receivedAt, envelopeText, JSON.stringify(r), lat, lng, src, acc);
    }),
    stmt(db,
      "INSERT INTO webhook_deliveries (webhook_id, reading_id, next_attempt_at) SELECT w.id, r.id, ? " +
      `FROM webhooks w JOIN readings r ON r.device_id = ? AND r.id > ? AND r.ingest_id = ${THIS_INGEST} ` +
      "WHERE w.active = 1 RETURNING id", receivedAt, device.id, after),
    stmt(db,
      "UPDATE devices SET last_seen_at = ?, last_ip = ?, " +
      `n_readings = n_readings + (SELECT count(*) FROM readings WHERE device_id = ? AND id > ? AND ingest_id = ${THIS_INGEST}), ` +
      "last_reading_id = coalesce((SELECT max(id) FROM readings WHERE device_id = ?), last_reading_id) WHERE id = ?",
      receivedAt, remoteIp, device.id, after, device.id, device.id),
  ];
  const results = await batch(db, statements);
  const stored = results.slice(1, 1 + readings.length).filter((rows) => rows.length).length;
  const deliveries = results[1 + readings.length].length;

  // Webhooks are sent after the answer, so the unit is not kept waiting.
  ctx.waitUntil(runBackground(env, { deliver: deliveries > 0 }));
  return json({ ok: true, stored, duplicates: readings.length - stored });
}
