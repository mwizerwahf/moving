"""Developer API, read-only, Bearer-token protected. Returns readings exactly as received."""
import asyncio
from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from fastapi.responses import StreamingResponse

from .db import get_pool
from .items import broadcaster, dumps, fetch_items, iso
from .security import API_TOKEN_PREFIX, sha256

router = APIRouter(prefix="/api/v1", tags=["developer API"])


async def require_token(request: Request) -> dict:
    auth = request.headers.get("authorization", "")
    token = auth[7:].strip() if auth.lower().startswith("bearer ") else None
    if not token and request.url.path.endswith("/stream"):
        token = request.query_params.get("token")  # browsers' EventSource cannot set headers
    if not token or not token.startswith(API_TOKEN_PREFIX):
        raise HTTPException(401, "missing or malformed API token",
                            headers={"WWW-Authenticate": "Bearer"})
    async with get_pool().connection() as conn:
        cur = await conn.execute(
            "UPDATE api_tokens SET last_used_at = now() WHERE token_hash = %s AND NOT revoked "
            "RETURNING id, name", (sha256(token),))
        row = await cur.fetchone()
    if not row:
        raise HTTPException(401, "invalid or revoked API token",
                            headers={"WWW-Authenticate": "Bearer"})
    return row


async def device_or_404(conn, imei: str) -> dict:
    cur = await conn.execute("SELECT id, imei, name, plate, active, created_at, last_seen_at "
                             "FROM devices WHERE imei = %s", (imei,))
    row = await cur.fetchone()
    if not row:
        raise HTTPException(404, "unknown device")
    return row


def device_json(d: dict) -> dict:
    return {"imei": d["imei"], "name": d["name"], "plate": d["plate"], "active": d["active"],
            "created_at": iso(d["created_at"]), "last_seen_at": iso(d["last_seen_at"])}


@router.get("/health", summary="Service health (no token needed)", dependencies=[])
async def health():
    async with get_pool().connection() as conn:
        await conn.execute("SELECT 1")
    return {"ok": True}


@router.get("/devices", summary="All devices with their latest reading")
async def list_devices(_=Depends(require_token)):
    async with get_pool().connection() as conn:
        cur = await conn.execute("SELECT id, imei, name, plate, active, created_at, last_seen_at "
                                 "FROM devices ORDER BY name, imei")
        devices = await cur.fetchall()
        out = []
        for d in devices:
            latest = await fetch_items(conn, "r.device_id = %s", (d["id"],), limit=1)
            out.append({**device_json(d), "latest": latest[0] if latest else None})
    return {"items": out}


@router.get("/devices/{imei}", summary="One device with its latest reading")
async def get_device(imei: str, _=Depends(require_token)):
    async with get_pool().connection() as conn:
        d = await device_or_404(conn, imei)
        latest = await fetch_items(conn, "r.device_id = %s", (d["id"],), limit=1)
    return {**device_json(d), "latest": latest[0] if latest else None}


@router.get("/devices/{imei}/readings", summary="Readings of one device, newest first")
async def device_readings(imei: str, limit: int = Query(100, ge=1, le=1000),
                          before_id: int | None = Query(None, ge=1),
                          since: datetime | None = None, until: datetime | None = None,
                          _=Depends(require_token)):
    where, params = ["r.device_id = %s"], []
    async with get_pool().connection() as conn:
        d = await device_or_404(conn, imei)
        params.append(d["id"])
        if before_id:
            where.append("r.id < %s"), params.append(before_id)
        if since:
            where.append("r.received_at >= %s"), params.append(since)
        if until:
            where.append("r.received_at < %s"), params.append(until)
        items = await fetch_items(conn, " AND ".join(where), tuple(params), limit=limit)
    return {"items": items,
            "next_before_id": items[-1]["id"] if len(items) == limit else None}


@router.get("/readings", summary="All readings in arrival order, for syncing your own database")
async def feed(after_id: int = Query(0, ge=0), limit: int = Query(500, ge=1, le=1000),
               imei: str | None = None, _=Depends(require_token)):
    async with get_pool().connection() as conn:
        if imei:
            d = await device_or_404(conn, imei)
            items = await fetch_items(conn, "r.id > %s AND r.device_id = %s",
                                      (after_id, d["id"]), "r.id ASC", limit)
        else:
            items = await fetch_items(conn, "r.id > %s", (after_id,), "r.id ASC", limit)
    return {"items": items, "next_after_id": items[-1]["id"] if items else after_id}


@router.get("/readings/{reading_id}", summary="One reading by id")
async def one_reading(reading_id: int, _=Depends(require_token)):
    async with get_pool().connection() as conn:
        items = await fetch_items(conn, "r.id = %s", (reading_id,), limit=1)
    if not items:
        raise HTTPException(404, "unknown reading")
    return items[0]


@router.get("/devices/{imei}/calibrations", summary="Active calibration profile per tank")
async def calibrations(imei: str, _=Depends(require_token)):
    async with get_pool().connection() as conn:
        d = await device_or_404(conn, imei)
        cur = await conn.execute(
            "SELECT DISTINCT ON (tank) tank, profile, created_at FROM calibrations "
            "WHERE device_id = %s AND active ORDER BY tank, id DESC", (d["id"],))
        rows = await cur.fetchall()
    return {"items": [{"tank": r["tank"], "created_at": iso(r["created_at"]),
                       "profile": r["profile"]} for r in rows]}


@router.get("/stream", summary="Live Server-Sent Events stream of new readings")
async def stream(request: Request, imei: str | None = None, after_id: int | None = None,
                 _=Depends(require_token)):
    last = request.headers.get("last-event-id")
    if last and last.isdigit():
        after_id = int(last)

    async def events():
        q = broadcaster.subscribe()
        try:
            yield "retry: 5000\n\n"
            sent = after_id or 0
            if after_id is not None:  # replay what the client missed
                async with get_pool().connection() as conn:
                    rows = await fetch_items(conn, "r.id > %s", (after_id,), "r.id ASC", 1000)
                for it in rows:
                    if not imei or it["device"]["imei"] == imei:
                        yield f"id: {it['id']}\nevent: reading\ndata: {dumps(it)}\n\n"
                    sent = max(sent, it["id"])
            while True:
                if await request.is_disconnected():
                    break
                try:
                    it = await asyncio.wait_for(q.get(), timeout=15)
                except asyncio.TimeoutError:
                    yield ": ping\n\n"
                    continue
                if it["id"] <= sent or (imei and it["device"]["imei"] != imei):
                    continue
                sent = it["id"]
                yield f"id: {it['id']}\nevent: reading\ndata: {dumps(it)}\n\n"
        finally:
            broadcaster.unsubscribe(q)

    return StreamingResponse(events(), media_type="text/event-stream",
                             headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})
