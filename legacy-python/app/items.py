"""One shape for a reading everywhere: API, live stream, webhooks and the web UI.

    {"id", "device": {...}, "received_at", "envelope": <as received>,
     "payload": <reading exactly as received>, "derived": {...}}
"""
import asyncio
import json

from .fuel import derive_fuel

READING_COLUMNS = ("r.id, r.boot, r.seq, r.ts, r.received_at, r.envelope, r.payload, r.lat, "
                   "r.lng, r.pos_src, r.acc_m, r.device_id, d.imei, d.name, d.plate")


def iso(t):
    return t.isoformat().replace("+00:00", "Z") if t else None


async def load_profiles(conn, device_ids) -> dict[int, dict[int, dict]]:
    ids = list(set(device_ids))
    if not ids:
        return {}
    cur = await conn.execute(
        "SELECT DISTINCT ON (device_id, tank) device_id, tank, profile FROM calibrations "
        "WHERE device_id = ANY(%s) AND active ORDER BY device_id, tank, id DESC", (ids,))
    out: dict[int, dict[int, dict]] = {}
    for row in await cur.fetchall():
        out.setdefault(row["device_id"], {})[row["tank"]] = row["profile"]
    return out


def to_item(row: dict, profiles: dict[int, dict]) -> dict:
    position = None
    if row["lat"] is not None:
        position = {"lat": row["lat"], "lng": row["lng"], "src": row["pos_src"],
                    "acc_m": row["acc_m"]}
    return {
        "id": row["id"],
        "device": {"imei": row["imei"], "name": row["name"], "plate": row["plate"]},
        "received_at": iso(row["received_at"]),
        "envelope": row["envelope"],
        "payload": row["payload"],
        "derived": {
            "time": iso(row["ts"] or row["received_at"]),
            "time_src": "device" if row["ts"] else "server",
            "position": position,
            "fuel": derive_fuel(row["payload"], profiles),
        },
    }


async def items_for(conn, rows: list[dict]) -> list[dict]:
    profiles = await load_profiles(conn, [r["device_id"] for r in rows])
    return [to_item(r, profiles.get(r["device_id"], {})) for r in rows]


async def fetch_items(conn, where: str, params: tuple, order: str = "r.id DESC",
                      limit: int = 100) -> list[dict]:
    cur = await conn.execute(
        f"SELECT {READING_COLUMNS} FROM readings r JOIN devices d ON d.id = r.device_id "
        f"WHERE {where} ORDER BY {order} LIMIT %s", (*params, limit))
    return await items_for(conn, await cur.fetchall())


class Broadcaster:
    """In-process fan-out of new readings to live-stream subscribers."""

    def __init__(self):
        self.queues: set[asyncio.Queue] = set()

    def subscribe(self) -> asyncio.Queue:
        q: asyncio.Queue = asyncio.Queue(maxsize=1000)
        self.queues.add(q)
        return q

    def unsubscribe(self, q: asyncio.Queue) -> None:
        self.queues.discard(q)

    def publish(self, item: dict) -> None:
        for q in list(self.queues):
            try:
                q.put_nowait(item)
            except asyncio.QueueFull:  # a stuck client must not slow the others
                pass


broadcaster = Broadcaster()


def dumps(obj) -> str:
    return json.dumps(obj, separators=(",", ":"), ensure_ascii=False)
