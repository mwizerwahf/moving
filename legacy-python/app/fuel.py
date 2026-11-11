"""Calibration profiles (fgt-cal/2.0) and raw-to-litres conversion."""
import math

RAW_UNITS = {"mV", "mm", "count"}
METHODS = {"sender", "ultrasonic_ext", "capacitive", "ultrasonic_top"}


class CalibrationError(ValueError):
    pass


def _num(v) -> bool:
    return isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v)


def validate_profile(p: dict, tank_expected: int | None = None) -> dict:
    """Check a calibration profile and return it. Raises CalibrationError."""
    if not isinstance(p, dict):
        raise CalibrationError("profile must be a JSON object")
    tank = p.get("tank")
    if not isinstance(tank, int) or isinstance(tank, bool) or tank < 1:
        raise CalibrationError("tank must be a whole number, 1 or more")
    if tank_expected is not None and tank != tank_expected:
        raise CalibrationError("tank does not match")
    if p.get("method") not in METHODS:
        raise CalibrationError("method must be one of " + ", ".join(sorted(METHODS)))
    if p.get("raw_unit") not in RAW_UNITS:
        raise CalibrationError("raw_unit must be one of " + ", ".join(sorted(RAW_UNITS)))
    cap = p.get("capacity_l")
    if not _num(cap) or cap <= 0:
        raise CalibrationError("capacity_l must be a positive number")
    table = p.get("table")
    if not isinstance(table, list) or not 2 <= len(table) <= 50:
        raise CalibrationError("table must have 2 to 50 points")
    for pt in table:
        if not (isinstance(pt, list) and len(pt) == 2 and _num(pt[0]) and _num(pt[1])):
            raise CalibrationError("each table point must be [raw, litres]")
        if pt[1] < 0:
            raise CalibrationError("litres cannot be negative")
    raws = [pt[0] for pt in table]
    if len(set(raws)) != len(raws):
        raise CalibrationError("table has the same raw value twice")
    vr = p.get("valid_raw")
    if vr is not None and not (isinstance(vr, list) and len(vr) == 2 and _num(vr[0])
                               and _num(vr[1]) and vr[0] < vr[1]):
        raise CalibrationError("valid_raw must be [min, max] with min < max")
    return p


def interpolate(table: list, raw: float) -> float:
    pts = sorted((float(r), float(l)) for r, l in table)
    if raw <= pts[0][0]:
        return pts[0][1]
    if raw >= pts[-1][0]:
        return pts[-1][1]
    for (r0, l0), (r1, l1) in zip(pts, pts[1:]):
        if r0 <= raw <= r1:
            return l0 + (l1 - l0) * (raw - r0) / (r1 - r0)
    return pts[-1][1]


def derive_fuel(payload: dict, profiles: dict[int, dict]) -> list[dict]:
    out = []
    fuel = payload.get("fuel") if isinstance(payload, dict) else None
    for f in fuel if isinstance(fuel, list) else []:
        if not isinstance(f, dict):
            continue
        tank = f.get("tank")
        prof = profiles.get(tank) if isinstance(tank, int) else None
        d = {"tank": tank, "litres": None, "level_pct": None, "calibrated": prof is not None,
             "note": None}
        raw = f.get("raw")
        if prof is None:
            d["note"] = "no calibration"
        elif f.get("status") != "ok" or not _num(raw):
            d["note"] = f"sensor status {f.get('status')}"
        elif f.get("raw_unit") != prof.get("raw_unit"):
            d["note"] = "raw_unit does not match calibration"
        elif prof.get("valid_raw") and not prof["valid_raw"][0] <= raw <= prof["valid_raw"][1]:
            d["note"] = "out_of_range"
        else:
            litres = interpolate(prof["table"], raw)
            d["litres"] = round(litres, 1)
            d["level_pct"] = round(litres / prof["capacity_l"] * 100, 1)
        out.append(d)
    return out
