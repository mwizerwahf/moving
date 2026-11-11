// One shape for a reading everywhere: API, live stream, webhooks and the web UI.
//
//   {"id", "device": {...}, "received_at", "envelope": <as received>,
//    "payload": <reading exactly as received>, "derived": {...}}
import { iso, stmt } from "./db.js";
import { deriveFuel } from "./fuel.js";

export const READING_COLUMNS =
  "r.id, r.boot, r.seq, r.ts, r.received_at, r.envelope, r.payload, r.lat, r.lng, r.pos_src, r.acc_m, " +
  "r.device_id, d.imei, d.name, d.plate";

/** Active calibration profiles as {device_id: {tank: profile}}. */
export function profilesFrom(rows) {
  const out = {};
  for (const row of rows) {
    // rows are ordered by id, so the newest active profile per tank wins
    (out[row.device_id] ||= {})[row.tank] = typeof row.profile === "string" ? JSON.parse(row.profile) : row.profile;
  }
  return out;
}

export function profilesStmt(db, deviceIds) {
  const ids = [...new Set(deviceIds)];
  return stmt(db,
    "SELECT device_id, tank, profile FROM calibrations WHERE active = 1 AND device_id IN " +
    "(SELECT value FROM json_each(?)) ORDER BY id", JSON.stringify(ids));
}

export function toItem(row, profiles) {
  const position = row.lat !== null && row.lat !== undefined
    ? { lat: row.lat, lng: row.lng, src: row.pos_src, acc_m: row.acc_m }
    : null;
  const payload = JSON.parse(row.payload);
  return {
    id: row.id,
    device: { imei: row.imei, name: row.name, plate: row.plate },
    received_at: iso(row.received_at),
    envelope: JSON.parse(row.envelope),
    payload,
    derived: {
      time: iso(row.ts || row.received_at),
      time_src: row.ts ? "device" : "server",
      position,
      fuel: deriveFuel(payload, profiles || {}),
    },
  };
}

/** rows: reading rows (READING_COLUMNS). Loads profiles in one query. */
export async function itemsFor(db, rows) {
  if (!rows.length) return [];
  const profiles = profilesFrom((await profilesStmt(db, rows.map((r) => r.device_id)).all()).results);
  return rows.map((r) => toItem(r, profiles[r.device_id]));
}

export function readingsStmt(db, where, params, order = "r.id DESC", limit = 100) {
  return stmt(db,
    `SELECT ${READING_COLUMNS} FROM readings r JOIN devices d ON d.id = r.device_id ` +
    `WHERE ${where} ORDER BY ${order} LIMIT ?`, ...params, limit);
}

export async function fetchItems(db, where, params, order = "r.id DESC", limit = 100) {
  const rows = (await readingsStmt(db, where, params, order, limit).all()).results;
  return itemsFor(db, rows);
}

export const dumps = (obj) => JSON.stringify(obj);
