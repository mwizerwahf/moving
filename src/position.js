// Choose a position for each reading: GNSS, else modem cell location, else cell-tower lookup.
import { settings } from "./config.js";
import { addSeconds, first, now, run } from "./db.js";
import { isNum } from "./fuel.js";

const isUInt = (v) => Number.isInteger(v) && v >= 0;
const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const valid = (lat, lng) =>
  isNum(lat) && isNum(lng) && lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180 && !(lat === 0 && lng === 0);

const NONE = [null, null, null, null];

/** Returns [lat, lng, source, accuracy_m] or [null, null, null, null].
 *  `memo` de-duplicates cell lookups within one request. */
export async function derivePosition(env, payload, memo = new Map()) {
  const g = payload.gnss;
  if (isObj(g) && g.fix === true && valid(g.lat, g.lng)) {
    const hdop = g.hdop;
    const acc = isNum(hdop) && hdop > 0 && hdop < 50 ? Math.round(hdop * 5 * 10) / 10 : null;
    return [g.lat, g.lng, "gnss", acc];
  }
  const cl = payload.cell_loc;
  if (isObj(cl) && valid(cl.lat, cl.lng)) return [cl.lat, cl.lng, "cell", isNum(cl.acc_m) ? cl.acc_m : null];
  const c = payload.cell;
  if (isObj(c) && ["mcc", "mnc", "tac", "ci"].every((k) => isUInt(c[k]))) {
    const k = `${c.mcc}/${c.mnc}/${c.tac}/${c.ci}`;
    if (!memo.has(k)) memo.set(k, lookupCell(env, c.mcc, c.mnc, c.tac, c.ci, c.rat));
    const hit = await memo.get(k);
    if (hit) return [hit[0], hit[1], "cell", hit[2]];
  }
  return NONE;
}

async function lookupCell(env, mcc, mnc, tac, ci, rat) {
  const row = await first(env.DB,
    "SELECT found, lat, lng, acc_m, updated_at FROM cell_cache WHERE mcc=? AND mnc=? AND tac=? AND ci=?",
    mcc, mnc, tac, ci);
  if (row && row.updated_at > addSeconds(-(row.found ? 30 : 1) * 86400))
    return row.found ? [row.lat, row.lng, row.acc_m] : null;
  const key = settings(env).opencellidKey;
  if (!key) return null;
  let found = false, lat = null, lng = null, acc = null;
  const radio = { lte: "LTE", gsm: "GSM", nbiot: "NBIOT" }[String(rat).toLowerCase()] || "LTE";
  try {
    const q = new URLSearchParams({ key, mcc, mnc, lac: tac, cellid: ci, radio, format: "json" });
    const r = await fetch(`https://opencellid.org/cell/get?${q}`, { signal: AbortSignal.timeout(4000) });
    const data = r.status === 200 ? await r.json() : {};
    if (valid(data.lat, data.lon)) {
      found = true; lat = data.lat; lng = data.lon;
      acc = isNum(data.range) ? data.range : null;
    }
  } catch (e) { // network trouble: try again on a later reading
    console.warn("cell lookup failed:", e?.message || e);
    return null;
  }
  await run(env.DB,
    "INSERT INTO cell_cache (mcc, mnc, tac, ci, found, lat, lng, acc_m, updated_at) VALUES (?,?,?,?,?,?,?,?,?) " +
    "ON CONFLICT (mcc, mnc, tac, ci) DO UPDATE SET found=excluded.found, lat=excluded.lat, lng=excluded.lng, " +
    "acc_m=excluded.acc_m, updated_at=excluded.updated_at", mcc, mnc, tac, ci, found, lat, lng, acc, now());
  return found ? [lat, lng, acc] : null;
}
