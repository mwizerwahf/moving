"""Web interface: login, vehicles, vehicle detail, raw readings, admin."""
import json
import re
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import quote
from zoneinfo import ZoneInfo

from fastapi import APIRouter, Form, Request
from fastapi.responses import HTMLResponse, RedirectResponse
from fastapi.templating import Jinja2Templates
from psycopg.types.json import Jsonb

from .config import settings
from .db import get_pool
from .fuel import CalibrationError, validate_profile
from .ingest import IMEI_RE
from .items import fetch_items
from .security import (API_TOKEN_PREFIX, DEVICE_KEY_PREFIX, SESSION_COOKIE, WEBHOOK_SECRET_PREFIX,
                       create_session, delete_session, hash_password, load_session, login_throttle,
                       new_secret, sha256, verify_password)
from .webhooks import UnsafeURL, check_url_shape, check_url_target

router = APIRouter(include_in_schema=False)
templates = Jinja2Templates(directory=str(Path(__file__).parent / "templates"))
TZ = ZoneInfo(settings.display_tz)


# ------------------------------------------------------------------ template helpers
def fmt_time(t):
    if not t:
        return "—"
    if isinstance(t, str):
        try:
            t = datetime.fromisoformat(t.replace("Z", "+00:00"))
        except ValueError:
            return t
    return t.astimezone(TZ).strftime("%Y-%m-%d %H:%M:%S")


def ago(t):
    if not t:
        return "never"
    if isinstance(t, str):
        t = datetime.fromisoformat(t.replace("Z", "+00:00"))
    s = int((datetime.now(timezone.utc) - t).total_seconds())
    if s < 60:
        return f"{max(s, 0)} s ago"
    if s < 3600:
        return f"{s // 60} min ago"
    if s < 86400:
        return f"{s // 3600} h ago"
    return f"{s // 86400} d ago"


def online(t) -> bool:
    return bool(t) and (datetime.now(timezone.utc) - t).total_seconds() < settings.online_seconds


def script_json(obj) -> str:
    """JSON that is safe inside <script type="application/json">."""
    return (json.dumps(obj).replace("<", "\\u003c").replace(">", "\\u003e")
            .replace("&", "\\u0026"))


def pretty(obj) -> str:
    return json.dumps(obj, indent=2, ensure_ascii=False)


templates.env.filters.update(fmt_time=fmt_time, ago=ago, pretty=pretty)
templates.env.globals.update(online=online, tz_name=settings.display_tz)


# ------------------------------------------------------------------ session handling
class NeedLogin(Exception):
    pass


class BadCsrf(Exception):
    pass


async def current_user(request: Request, conn) -> dict:
    user = await load_session(conn, request.cookies.get(SESSION_COOKIE))
    if not user:
        raise NeedLogin()
    return user


def check_csrf(user: dict, token: str) -> None:
    if not token or token != user["csrf"]:
        raise BadCsrf()


def page(request: Request, name: str, user: dict | None, **ctx) -> HTMLResponse:
    return templates.TemplateResponse(request, name, {"user": user, **ctx})


def back(url: str, msg: str | None = None) -> RedirectResponse:
    path, _, fragment = url.partition("#")
    if msg:
        path += ("&" if "?" in path else "?") + "msg=" + quote(
            re.sub(r"[^A-Za-z0-9 ,._:()-]", "", msg)[:160])
    return RedirectResponse(path + ("#" + fragment if fragment else ""), status_code=303)


# ------------------------------------------------------------------ login
@router.get("/login", response_class=HTMLResponse)
async def login_form(request: Request):
    return page(request, "login.html", None, error=None)


@router.post("/login")
async def login(request: Request, username: str = Form(...), password: str = Form(...)):
    ip = request.client.host if request.client else "?"
    if login_throttle.blocked(ip):
        return page(request, "login.html", None, error="Too many attempts. Try again in 15 minutes.")
    async with get_pool().connection() as conn:
        cur = await conn.execute("SELECT id, pw_hash FROM users WHERE username = %s",
                                 (username.strip(),))
        u = await cur.fetchone()
        if not u or not verify_password(u["pw_hash"], password):
            login_throttle.fail(ip)
            return page(request, "login.html", None, error="Wrong user name or password.")
        login_throttle.reset(ip)
        token, _ = await create_session(conn, u["id"])
    resp = RedirectResponse("/", status_code=303)
    resp.set_cookie(SESSION_COOKIE, token, httponly=True, secure=settings.cookie_secure,
                    samesite="lax", max_age=settings.session_hours * 3600, path="/")
    return resp


@router.post("/logout")
async def logout(request: Request, csrf: str = Form("")):
    async with get_pool().connection() as conn:
        user = await current_user(request, conn)
        check_csrf(user, csrf)
        await delete_session(conn, request.cookies.get(SESSION_COOKIE))
    resp = RedirectResponse("/login", status_code=303)
    resp.delete_cookie(SESSION_COOKIE, path="/")
    return resp


# ------------------------------------------------------------------ vehicles
@router.get("/", response_class=HTMLResponse)
async def index(request: Request):
    async with get_pool().connection() as conn:
        user = await current_user(request, conn)
        cur = await conn.execute("SELECT id, imei, name, plate, active, last_seen_at FROM devices "
                                 "ORDER BY active DESC, name, imei")
        devices = await cur.fetchall()
        rows, points = [], []
        for d in devices:
            latest = await fetch_items(conn, "r.device_id = %s", (d["id"],), limit=1)
            it = latest[0] if latest else None
            rows.append({"d": d, "it": it})
            pos = it and it["derived"]["position"]
            if pos:
                points.append({"label": d["name"] or d["plate"] or d["imei"], "imei": d["imei"],
                               "lat": pos["lat"], "lng": pos["lng"], "src": pos["src"],
                               "acc": pos["acc_m"]})
    n_online = sum(1 for r in rows if online(r["d"]["last_seen_at"]))
    return page(request, "index.html", user, rows=rows, n_online=n_online,
                map_data=script_json({"points": points, "track": []}),
                msg=request.query_params.get("msg"))


@router.get("/devices/{imei}", response_class=HTMLResponse)
async def device_page(request: Request, imei: str, before_id: int | None = None):
    async with get_pool().connection() as conn:
        user = await current_user(request, conn)
        cur = await conn.execute("SELECT * FROM devices WHERE imei = %s", (imei,))
        d = await cur.fetchone()
        if not d:
            return back("/", "Unknown device")
        where, params = "r.device_id = %s", (d["id"],)
        if before_id:
            where, params = "r.device_id = %s AND r.id < %s", (d["id"], before_id)
        items = await fetch_items(conn, where, params, limit=50)
        cur = await conn.execute(
            "SELECT lat, lng FROM readings WHERE device_id = %s AND lat IS NOT NULL "
            "ORDER BY id DESC LIMIT 300", (d["id"],))
        track = [[r["lat"], r["lng"]] for r in await cur.fetchall()][::-1]
        cur = await conn.execute(
            "SELECT DISTINCT ON (tank) id, tank, profile, created_at, created_by FROM calibrations "
            "WHERE device_id = %s AND active ORDER BY tank, id DESC", (d["id"],))
        cals = await cur.fetchall()
        cur = await conn.execute("SELECT count(*) AS n FROM readings WHERE device_id = %s",
                                 (d["id"],))
        total = (await cur.fetchone())["n"]
    latest = items[0] if items and not before_id else None
    pos = latest and latest["derived"]["position"]
    points = [{"label": d["name"] or d["imei"], "imei": imei, "lat": pos["lat"],
               "lng": pos["lng"], "src": pos["src"], "acc": pos["acc_m"]}] if pos else []
    example = {"schema": "fgt-cal/2.0", "imei": imei, "tank": 1, "method": "sender",
               "model": "stock", "raw_unit": "mV", "capacity_l": 50,
               "valid_raw": [0, 8000], "table": [[500, 50], [2500, 25], [4500, 0]],
               "calibrated": datetime.now(TZ).strftime("%Y-%m-%d"), "by": user["username"],
               "notes": ""}
    return page(request, "device.html", user, d=d, items=items, latest=latest, cals=cals,
                total=total, map_data=script_json({"points": points, "track": track}),
                next_before=items[-1]["id"] if len(items) == 50 else None,
                example=pretty(example), msg=request.query_params.get("msg"))


@router.post("/devices/{imei}/settings")
async def device_settings(request: Request, imei: str, csrf: str = Form(""),
                          name: str = Form(""), plate: str = Form(""), active: str = Form("")):
    async with get_pool().connection() as conn:
        user = await current_user(request, conn)
        check_csrf(user, csrf)
        await conn.execute("UPDATE devices SET name=%s, plate=%s, active=%s WHERE imei=%s",
                           (name.strip()[:64], plate.strip()[:32], active == "1", imei))
    return back(f"/devices/{imei}", "Saved")


@router.post("/devices/{imei}/rotate-key", response_class=HTMLResponse)
async def rotate_key(request: Request, imei: str, csrf: str = Form("")):
    key = new_secret(DEVICE_KEY_PREFIX)
    async with get_pool().connection() as conn:
        user = await current_user(request, conn)
        check_csrf(user, csrf)
        await conn.execute("UPDATE devices SET key_hash=%s WHERE imei=%s", (sha256(key), imei))
    return page(request, "secret.html", user, title=f"New device key for {imei}", secret=key,
                note="The old key stopped working now. Put this key in the unit's firmware "
                     "(X-Api-Key header).", back_url=f"/devices/{imei}")


@router.post("/devices/{imei}/calibration")
async def save_calibration(request: Request, imei: str, csrf: str = Form(""),
                           profile: str = Form("")):
    async with get_pool().connection() as conn:
        user = await current_user(request, conn)
        check_csrf(user, csrf)
        cur = await conn.execute("SELECT id FROM devices WHERE imei = %s", (imei,))
        d = await cur.fetchone()
        if not d:
            return back("/", "Unknown device")
        try:
            p = json.loads(profile)
            validate_profile(p)
            if p.get("imei") not in (None, imei):
                raise CalibrationError("imei in the profile belongs to another device")
        except (ValueError, CalibrationError) as exc:
            return back(f"/devices/{imei}#calibration", f"Not saved: {exc}")
        p["imei"] = imei
        async with conn.transaction():
            await conn.execute("UPDATE calibrations SET active=false WHERE device_id=%s AND tank=%s",
                               (d["id"], p["tank"]))
            await conn.execute("INSERT INTO calibrations (device_id, tank, profile, created_by) "
                               "VALUES (%s, %s, %s, %s)",
                               (d["id"], p["tank"], Jsonb(p), user["username"]))
    return back(f"/devices/{imei}#calibration", f"Calibration for tank {p['tank']} saved")


@router.post("/devices/{imei}/calibration/{tank}/remove")
async def remove_calibration(request: Request, imei: str, tank: int, csrf: str = Form("")):
    async with get_pool().connection() as conn:
        user = await current_user(request, conn)
        check_csrf(user, csrf)
        await conn.execute("UPDATE calibrations SET active=false WHERE tank=%s AND device_id = "
                           "(SELECT id FROM devices WHERE imei=%s)", (tank, imei))
    return back(f"/devices/{imei}#calibration", f"Calibration for tank {tank} removed")


@router.get("/readings/{reading_id}", response_class=HTMLResponse)
async def reading_page(request: Request, reading_id: int):
    async with get_pool().connection() as conn:
        user = await current_user(request, conn)
        items = await fetch_items(conn, "r.id = %s", (reading_id,), limit=1)
        raw_body = None
        if items:
            cur = await conn.execute("SELECT i.body FROM readings r JOIN ingests i "
                                     "ON i.id = r.ingest_id WHERE r.id = %s", (reading_id,))
            row = await cur.fetchone()
            raw_body = row["body"] if row else None
    if not items:
        return back("/", "Unknown reading")
    return page(request, "reading.html", user, it=items[0], raw_body=raw_body)


# ------------------------------------------------------------------ admin
@router.get("/admin", response_class=HTMLResponse)
async def admin(request: Request):
    async with get_pool().connection() as conn:
        user = await current_user(request, conn)
        devices = await (await conn.execute(
            "SELECT imei, name, plate, active, created_at, last_seen_at FROM devices "
            "ORDER BY created_at DESC")).fetchall()
        tokens = await (await conn.execute(
            "SELECT id, name, prefix, created_at, last_used_at, revoked FROM api_tokens "
            "ORDER BY revoked, id DESC")).fetchall()
        hooks = await (await conn.execute(
            "SELECT w.id, w.url, w.active, w.created_at, "
            "count(*) FILTER (WHERE d.status='pending') AS pending, "
            "count(*) FILTER (WHERE d.status='failed') AS failed, "
            "count(*) FILTER (WHERE d.status='delivered') AS delivered, "
            "max(d.last_error) FILTER (WHERE d.status<>'delivered') AS last_error "
            "FROM webhooks w LEFT JOIN webhook_deliveries d ON d.webhook_id = w.id "
            "GROUP BY w.id ORDER BY w.id")).fetchall()
    return page(request, "admin.html", user, devices=devices, tokens=tokens, hooks=hooks,
                public_url=settings.public_url, msg=request.query_params.get("msg"))


@router.post("/admin/devices", response_class=HTMLResponse)
async def add_device(request: Request, csrf: str = Form(""), imei: str = Form(""),
                     name: str = Form(""), plate: str = Form("")):
    imei = imei.strip()
    async with get_pool().connection() as conn:
        user = await current_user(request, conn)
        check_csrf(user, csrf)
        if not IMEI_RE.match(imei):
            return back("/admin", "IMEI must be 14 to 16 digits")
        key = new_secret(DEVICE_KEY_PREFIX)
        cur = await conn.execute(
            "INSERT INTO devices (imei, name, plate, key_hash) VALUES (%s,%s,%s,%s) "
            "ON CONFLICT (imei) DO NOTHING RETURNING id",
            (imei, name.strip()[:64], plate.strip()[:32], sha256(key)))
        if not await cur.fetchone():
            return back("/admin", "That IMEI is already registered")
    return page(request, "secret.html", user, title=f"Device {imei} registered", secret=key,
                note="Put this key in the unit's firmware. The unit sends it in the X-Api-Key "
                     "header to " + settings.public_url + "/ingest.", back_url="/admin")


@router.post("/admin/tokens", response_class=HTMLResponse)
async def add_token(request: Request, csrf: str = Form(""), name: str = Form("")):
    token = new_secret(API_TOKEN_PREFIX)
    async with get_pool().connection() as conn:
        user = await current_user(request, conn)
        check_csrf(user, csrf)
        if not name.strip():
            return back("/admin", "Give the token a name, e.g. the developer or app")
        await conn.execute("INSERT INTO api_tokens (name, prefix, token_hash) VALUES (%s,%s,%s)",
                           (name.strip()[:64], token[:10], sha256(token)))
    return page(request, "secret.html", user, title=f"API token for {name.strip()}", secret=token,
                note="Send it as: Authorization: Bearer <token>. It can read all devices.",
                back_url="/admin")


@router.post("/admin/tokens/{token_id}/revoke")
async def revoke_token(request: Request, token_id: int, csrf: str = Form("")):
    async with get_pool().connection() as conn:
        user = await current_user(request, conn)
        check_csrf(user, csrf)
        await conn.execute("UPDATE api_tokens SET revoked=true WHERE id=%s", (token_id,))
    return back("/admin", "Token revoked")


@router.post("/admin/webhooks", response_class=HTMLResponse)
async def add_webhook(request: Request, csrf: str = Form(""), url: str = Form("")):
    async with get_pool().connection() as conn:
        user = await current_user(request, conn)
        check_csrf(user, csrf)
        try:
            url = check_url_shape(url)
            check_url_target(url)
        except UnsafeURL as exc:
            return back("/admin", f"Webhook not added: {exc}")
        secret = new_secret(WEBHOOK_SECRET_PREFIX)
        await conn.execute("INSERT INTO webhooks (url, secret) VALUES (%s, %s)", (url, secret))
    return page(request, "secret.html", user, title="Webhook added", secret=secret,
                note="Every new reading is POSTed to " + url + ". Use this secret to check the "
                     "X-FGT-Signature header.", back_url="/admin")


@router.post("/admin/webhooks/{hook_id}/toggle")
async def toggle_webhook(request: Request, hook_id: int, csrf: str = Form("")):
    async with get_pool().connection() as conn:
        user = await current_user(request, conn)
        check_csrf(user, csrf)
        await conn.execute("UPDATE webhooks SET active = NOT active WHERE id=%s", (hook_id,))
    return back("/admin", "Webhook updated")


@router.post("/admin/webhooks/{hook_id}/delete")
async def delete_webhook(request: Request, hook_id: int, csrf: str = Form("")):
    async with get_pool().connection() as conn:
        user = await current_user(request, conn)
        check_csrf(user, csrf)
        await conn.execute("DELETE FROM webhooks WHERE id=%s", (hook_id,))
    return back("/admin", "Webhook deleted")


@router.post("/admin/password")
async def change_password(request: Request, csrf: str = Form(""), current: str = Form(""),
                          new: str = Form(""), repeat: str = Form("")):
    async with get_pool().connection() as conn:
        user = await current_user(request, conn)
        check_csrf(user, csrf)
        cur = await conn.execute("SELECT pw_hash FROM users WHERE id=%s", (user["id"],))
        if not verify_password((await cur.fetchone())["pw_hash"], current):
            return back("/admin", "Current password is wrong")
        if len(new) < 12 or new != repeat:
            return back("/admin", "New password must be 12 characters or more and match")
        await conn.execute("UPDATE users SET pw_hash=%s WHERE id=%s",
                           (hash_password(new), user["id"]))
        await conn.execute("DELETE FROM sessions WHERE user_id=%s AND token_hash<>%s",
                           (user["id"], sha256(request.cookies.get(SESSION_COOKIE, ""))))
    return back("/admin", "Password changed; other sessions signed out")


@router.get("/developers", response_class=HTMLResponse)
async def developers(request: Request):
    """Public: the developer guide holds no secrets."""
    async with get_pool().connection() as conn:
        user = await load_session(conn, request.cookies.get(SESSION_COOKIE))
    return page(request, "developers.html", user, public_url=settings.public_url)
