"""Forward every new reading to developers' webhook URLs, signed, with retries."""
import asyncio
import ipaddress
import logging
import socket
import time
from urllib.parse import urlsplit

import httpx

from .config import settings
from .db import get_pool
from .items import dumps, fetch_items

log = logging.getLogger("webhooks")


class UnsafeURL(ValueError):
    pass


def check_url_shape(url: str) -> str:
    url = url.strip()
    parts = urlsplit(url)
    allowed = ("https", "http") if settings.allow_http_webhooks else ("https",)
    if parts.scheme not in allowed or not parts.hostname:
        raise UnsafeURL("webhook URL must start with https:// and include a host name")
    if parts.username or parts.password:
        raise UnsafeURL("webhook URL must not contain a user name or password")
    if len(url) > 500:
        raise UnsafeURL("webhook URL is too long")
    return url


def check_url_target(url: str) -> None:
    """Refuse URLs that resolve to private, loopback or cloud-metadata addresses."""
    if settings.allow_private_webhooks:
        return
    host = urlsplit(url).hostname
    try:
        infos = socket.getaddrinfo(host, None)
    except socket.gaierror as exc:
        raise UnsafeURL(f"cannot resolve {host}") from exc
    for info in infos:
        ip = ipaddress.ip_address(info[4][0])
        if not ip.is_global:
            raise UnsafeURL(f"{host} resolves to a non-public address")


def backoff_seconds(attempts: int) -> int:
    return min(10 * 2 ** attempts, 3600)


async def deliver_due(client: httpx.AsyncClient) -> int:
    from .security import sign_webhook

    pool = get_pool()
    async with pool.connection() as conn:
        cur = await conn.execute(
            "SELECT wd.id, wd.reading_id, wd.attempts, w.url, w.secret FROM webhook_deliveries wd "
            "JOIN webhooks w ON w.id = wd.webhook_id WHERE wd.status = 'pending' AND w.active "
            "AND wd.next_attempt_at <= now() ORDER BY wd.id LIMIT 25")
        due = await cur.fetchall()
        for d in due:
            items = await fetch_items(conn, "r.id = %s", (d["reading_id"],), limit=1)
            if not items:
                await conn.execute("UPDATE webhook_deliveries SET status='failed', "
                                   "last_error='reading deleted' WHERE id=%s", (d["id"],))
                continue
            body = dumps({"event": "reading.created", **items[0]}).encode()
            ts = str(int(time.time()))
            headers = {"Content-Type": "application/json", "User-Agent": "car-gateway/1.0",
                       "X-FGT-Event": "reading.created", "X-FGT-Delivery": str(d["id"]),
                       "X-FGT-Timestamp": ts, "X-FGT-Signature": sign_webhook(d["secret"], ts, body)}
            code, error = None, None
            try:
                await asyncio.to_thread(check_url_target, d["url"])
                r = await client.post(d["url"], content=body, headers=headers)
                code = r.status_code
                if not 200 <= code < 300:
                    error = f"HTTP {code}"
            except UnsafeURL as exc:
                error = str(exc)
            except httpx.HTTPError as exc:
                error = type(exc).__name__
            attempts = d["attempts"] + 1
            if error is None:
                await conn.execute("UPDATE webhook_deliveries SET status='delivered', attempts=%s, "
                                   "last_code=%s, last_error=NULL, delivered_at=now() WHERE id=%s",
                                   (attempts, code, d["id"]))
            else:
                status = "failed" if attempts >= settings.webhook_max_attempts else "pending"
                await conn.execute(
                    "UPDATE webhook_deliveries SET status=%s, attempts=%s, last_code=%s, "
                    "last_error=%s, next_attempt_at = now() + make_interval(secs => %s) "
                    "WHERE id=%s", (status, attempts, code, error[:300],
                                    backoff_seconds(attempts), d["id"]))
        return len(due)


async def worker(stop: asyncio.Event) -> None:
    async with httpx.AsyncClient(timeout=10.0, follow_redirects=False) as client:
        while not stop.is_set():
            try:
                n = await deliver_due(client)
            except Exception:
                log.exception("webhook worker error")
                n = 0
            try:
                await asyncio.wait_for(stop.wait(), timeout=0.2 if n else 2.0)
            except asyncio.TimeoutError:
                pass


async def housekeeping(stop: asyncio.Event) -> None:
    while not stop.is_set():
        try:
            async with get_pool().connection() as conn:
                await conn.execute("DELETE FROM sessions WHERE expires_at < now()")
                await conn.execute("DELETE FROM webhook_deliveries WHERE status = 'delivered' "
                                   "AND delivered_at < now() - interval '7 days'")
                if settings.retention_days > 0:
                    await conn.execute(
                        "DELETE FROM readings WHERE received_at < now() - make_interval(days => %s)",
                        (settings.retention_days,))
                    await conn.execute(
                        "DELETE FROM ingests WHERE received_at < now() - make_interval(days => %s)",
                        (settings.retention_days,))
        except Exception:
            log.exception("housekeeping error")
        try:
            await asyncio.wait_for(stop.wait(), timeout=3600)
        except asyncio.TimeoutError:
            pass
