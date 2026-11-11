// Calibration profiles (fgt-cal/2.0) and raw-to-litres conversion.

const RAW_UNITS = ["count", "mm", "mV"];
const METHODS = ["capacitive", "sender", "ultrasonic_ext", "ultrasonic_top"];

export class CalibrationError extends Error {}

export const isNum = (v) => typeof v === "number" && Number.isFinite(v);
const isInt = (v) => Number.isInteger(v);
const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

/** Check a calibration profile and return it. Throws CalibrationError. */
export function validateProfile(p) {
  if (!isObj(p)) throw new CalibrationError("profile must be a JSON object");
  if (!isInt(p.tank) || p.tank < 1) throw new CalibrationError("tank must be a whole number, 1 or more");
  if (!METHODS.includes(p.method)) throw new CalibrationError("method must be one of " + METHODS.join(", "));
  if (!RAW_UNITS.includes(p.raw_unit)) throw new CalibrationError("raw_unit must be one of " + RAW_UNITS.join(", "));
  if (!isNum(p.capacity_l) || p.capacity_l <= 0) throw new CalibrationError("capacity_l must be a positive number");
  const t = p.table;
  if (!Array.isArray(t) || t.length < 2 || t.length > 50) throw new CalibrationError("table must have 2 to 50 points");
  for (const pt of t) {
    if (!(Array.isArray(pt) && pt.length === 2 && isNum(pt[0]) && isNum(pt[1])))
      throw new CalibrationError("each table point must be [raw, litres]");
    if (pt[1] < 0) throw new CalibrationError("litres cannot be negative");
  }
  if (new Set(t.map((pt) => pt[0])).size !== t.length) throw new CalibrationError("table has the same raw value twice");
  const vr = p.valid_raw;
  if (vr != null && !(Array.isArray(vr) && vr.length === 2 && isNum(vr[0]) && isNum(vr[1]) && vr[0] < vr[1]))
    throw new CalibrationError("valid_raw must be [min, max] with min < max");
  return p;
}

export function interpolate(table, raw) {
  const pts = table.map(([r, l]) => [Number(r), Number(l)]).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (raw <= pts[0][0]) return pts[0][1];
  if (raw >= pts[pts.length - 1][0]) return pts[pts.length - 1][1];
  for (let i = 0; i < pts.length - 1; i++) {
    const [r0, l0] = pts[i];
    const [r1, l1] = pts[i + 1];
    if (r0 <= raw && raw <= r1) return l0 + ((l1 - l0) * (raw - r0)) / (r1 - r0);
  }
  return pts[pts.length - 1][1];
}

const round1 = (x) => Math.round(x * 10) / 10;

/** profiles: {tank: profile} for one device. */
export function deriveFuel(payload, profiles) {
  const out = [];
  const fuel = isObj(payload) ? payload.fuel : null;
  for (const f of Array.isArray(fuel) ? fuel : []) {
    if (!isObj(f)) continue;
    const tank = f.tank === undefined ? null : f.tank;
    const prof = isInt(tank) ? profiles[tank] || null : null;
    const d = { tank, litres: null, level_pct: null, calibrated: prof !== null, note: null };
    const raw = f.raw;
    if (prof === null) d.note = "no calibration";
    else if (f.status !== "ok" || !isNum(raw)) d.note = `sensor status ${f.status === undefined || f.status === null ? "None" : f.status}`;
    else if (f.raw_unit !== prof.raw_unit) d.note = "raw_unit does not match calibration";
    else if (Array.isArray(prof.valid_raw) && prof.valid_raw.length && !(prof.valid_raw[0] <= raw && raw <= prof.valid_raw[1]))
      d.note = "out_of_range";
    else {
      const litres = interpolate(prof.table, raw);
      d.litres = round1(litres);
      d.level_pct = round1((litres / prof.capacity_l) * 100);
    }
    out.push(d);
  }
  return out;
}
