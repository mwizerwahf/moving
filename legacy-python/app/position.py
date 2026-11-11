"""Choose a position for each reading: GNSS, else modem cell location, else cell-tower lookup."""
import logging
import math

import httpx

from .config import settings

log = logging.getLogger("position")


def _num(v) -> bool:
    return isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v)


def _int(v) -> bool:
    return isinstance(v, int) and not isinstance(v, bool) and v >= 0


def _valid(lat, lng) -> bool:
    return _num(lat) and _num(lng) and -90 <= lat <= 90 and -180 <= lng <= 180 \
        and not (lat == 0 and lng == 0)


async def derive_position(conn, payload: dict):
    """Returns (lat, lng, source, accuracy_m) or (None, None, None, None)."""
    g = payload.get("gnss")
    if isinstance(g, dict) and g.get("fix") is True and _valid(g.get("lat"), g.get("lng")):
        hdop = g.get("hdop")
        acc = round(hdop * 5.0, 1) if _num(hdop) and 0 < hdop < 50 else None
        return g["lat"], g["lng"], "gnss", acc
    cl = payload.get("cell_loc")
    if isinstance(cl, dict) and _valid(cl.get("lat"), cl.get("lng")):
        acc = cl.get("acc_m") if _num(cl.get("acc_m")) else None
        return cl["lat"], cl["lng"], "cell", acc
    c = payload.get("cell")
    if isinstance(c, dict) and all(_int(c.get(k)) for k in ("mcc", "mnc", "tac", "ci")):
        hit = await lookup_cell(conn, c["mcc"], c["mnc"], c["tac"], c["ci"], c.get("rat"))
        if hit:
            return hit[0], hit[1], "cell", hit[2]
    return None, None, None, None


async def lookup_cell(conn, mcc: int, mnc: int, tac: int, ci: int, rat):
    cur = await conn.execute(
        "SELECT found, lat, lng, acc_m, "
        "updated_at > now() - (CASE WHEN found THEN interval '30 days' "
        "ELSE interval '1 day' END) AS fresh "
        "FROM cell_cache WHERE mcc=%s AND mnc=%s AND tac=%s AND ci=%s", (mcc, mnc, tac, ci))
    row = await cur.fetchone()
    if row and row["fresh"]:
        return (row["lat"], row["lng"], row["acc_m"]) if row["found"] else None
    if not settings.opencellid_key:
        return None
    found, lat, lng, acc = False, None, None, None
    radio = {"lte": "LTE", "gsm": "GSM", "nbiot": "NBIOT"}.get(str(rat).lower(), "LTE")
    try:
        async with httpx.AsyncClient(timeout=4.0) as client:
            r = await client.get("https://opencellid.org/cell/get", params={
                "key": settings.opencellid_key, "mcc": mcc, "mnc": mnc, "lac": tac,
                "cellid": ci, "radio": radio, "format": "json"})
        data = r.json() if r.status_code == 200 else {}
        if _valid(data.get("lat"), data.get("lon")):
            found, lat, lng = True, data["lat"], data["lon"]
            acc = data.get("range") if _num(data.get("range")) else None
    except Exception as exc:  # network trouble: try again on a later reading
        log.warning("cell lookup failed: %s", exc)
        return None
    await conn.execute(
        "INSERT INTO cell_cache (mcc, mnc, tac, ci, found, lat, lng, acc_m, updated_at) "
        "VALUES (%s,%s,%s,%s,%s,%s,%s,%s, now()) ON CONFLICT (mcc, mnc, tac, ci) DO UPDATE SET "
        "found=EXCLUDED.found, lat=EXCLUDED.lat, lng=EXCLUDED.lng, acc_m=EXCLUDED.acc_m, "
        "updated_at=now()", (mcc, mnc, tac, ci, found, lat, lng, acc))
    return (lat, lng, acc) if found else None
