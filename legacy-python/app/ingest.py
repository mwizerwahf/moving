"""POST /ingest: the only endpoint the vehicle units call (fgt/2.0 over 4G)."""
import json
import re
from datetime import datetime

from fastapi import APIRouter, Request
from psycopg.types.json import Jsonb
from fastapi.responses import JSONResponse

from .config import settings
from .db import get_pool
from .items import broadcaster, fetch_items
from .position import derive_position
from .security import sha256

router = APIRouter()
IMEI_RE = re.compile(r"^\d{14,16}$")


def err(status: int, message: str) -> JSONResponse:
    return JSONResponse({"ok": False, "error": message}, status_code=status)


def parse_ts(value):
    if not isinstance(value, str):
        return None
    try:
        t = datetime.fromisoformat(value.replace("Z", "+00:00"))
        return t if t.tzinfo else None
    except ValueError:
        return None


def device_key(request: Request) -> str | None:
    key = request.headers.get("x-api-key")
    auth = request.headers.get("authorization", "")
    if not key and auth.lower().startswith("bearer "):
        key = auth[7:].strip()
    return key or None


@router.post("/ingest", tags=["device"], summary="Receive readings from a vehicle unit")
async def ingest(request: Request):
    key = device_key(request)
    if not key:
        return err(401, "missing device key")
    body = await request.body()
    if len(body) > settings.max_body_bytes:
        return err(413, "request too large")

    pool = get_pool()
    async with pool.connection() as conn:
        cur = await conn.execute("SELECT id, imei FROM devices WHERE key_hash = %s AND active",
                                 (sha256(key),))
        device = await cur.fetchone()
        if not device:
            return err(401, "unknown or disabled device key")

        try:
            data = json.loads(body)
        except (ValueError, UnicodeDecodeError):
            return err(400, "body is not valid JSON")
        if not isinstance(data, dict):
            return err(400, "body must be a JSON object")
        schema = data.get("schema")
        if not isinstance(schema, str) or not schema.startswith("fgt/2."):
            return err(400, "unsupported schema; expected fgt/2.x")
        if data.get("imei") != device["imei"]:
            return err(403, "imei does not match this device key")
        boot = data.get("boot")
        if not isinstance(boot, str) or not 1 <= len(boot) <= 32:
            return err(400, "boot must be a string of 1 to 32 characters")
        readings = data.get("readings")
        if not isinstance(readings, list) or len(readings) > settings.max_readings:
            return err(400, f"readings must be an array of at most {settings.max_readings}")
        for r in readings:
            seq = r.get("seq") if isinstance(r, dict) else None
            if not isinstance(seq, int) or isinstance(seq, bool) or seq < 0:
                return err(400, "every reading needs an integer seq of 0 or more")

        envelope = {k: v for k, v in data.items() if k != "readings"}
        remote_ip = request.client.host if request.client else None
        new_ids: list[int] = []
        async with conn.transaction():
            cur = await conn.execute(
                "INSERT INTO ingests (device_id, remote_ip, body, n_readings, n_new) "
                "VALUES (%s, %s, %s, %s, 0) RETURNING id",
                (device["id"], remote_ip, body.decode("utf-8", "replace"), len(readings)))
            ingest_id = (await cur.fetchone())["id"]
            for r in readings:
                lat, lng, src, acc = await derive_position(conn, r)
                cur = await conn.execute(
                    "INSERT INTO readings (device_id, ingest_id, boot, seq, ts, envelope, payload,"
                    " lat, lng, pos_src, acc_m) VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s) "
                    "ON CONFLICT (device_id, boot, seq) DO NOTHING RETURNING id",
                    (device["id"], ingest_id, boot, r["seq"], parse_ts(r.get("ts")),
                     Jsonb(envelope), Jsonb(r), lat, lng, src, acc))
                row = await cur.fetchone()
                if row:
                    new_ids.append(row["id"])
            if new_ids:
                await conn.execute(
                    "INSERT INTO webhook_deliveries (webhook_id, reading_id) "
                    "SELECT w.id, r.id FROM webhooks w CROSS JOIN unnest(%s::bigint[]) AS r(id) "
                    "WHERE w.active", (new_ids,))
            await conn.execute("UPDATE ingests SET n_new = %s WHERE id = %s",
                               (len(new_ids), ingest_id))
            await conn.execute("UPDATE devices SET last_seen_at = now(), last_ip = %s "
                               "WHERE id = %s", (remote_ip, device["id"]))

        if new_ids and broadcaster.queues:
            for item in await fetch_items(conn, "r.id = ANY(%s)", (new_ids,), "r.id ASC",
                                          len(new_ids)):
                broadcaster.publish(item)

    return {"ok": True, "stored": len(new_ids), "duplicates": len(readings) - len(new_ids)}
