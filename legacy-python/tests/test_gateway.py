"""End-to-end tests against a real Postgres.

    TEST_DATABASE_URL=postgresql://car:car@localhost:5432/car_test pytest -q

The database is wiped at the start. Never point this at production.
"""
import asyncio
import json
import os
import re
import threading
from urllib.parse import unquote
from http.server import BaseHTTPRequestHandler, HTTPServer

import pytest

DB = os.environ.get("TEST_DATABASE_URL")
if not DB:
    pytest.skip("set TEST_DATABASE_URL to run the tests", allow_module_level=True)
os.environ.update(DATABASE_URL=DB, COOKIE_SECURE="0", ALLOW_HTTP_WEBHOOKS="1",
                  ALLOW_PRIVATE_WEBHOOKS="1", OPENCELLID_KEY="")

import httpx  # noqa: E402
import psycopg  # noqa: E402

from app.main import app  # noqa: E402
from app.security import hash_password, sign_webhook  # noqa: E402

IMEI = "866123456789012"


def reading(seq, **over):
    r = {"seq": seq, "ts": "2026-11-01T09:12:40Z", "ts_src": "gnss", "uptime_ms": 1000 * seq,
         "gnss": {"fix": True, "lat": -1.944123, "lng": 30.061233, "alt_m": 1567,
                  "speed_kmh": 0.0, "heading_deg": None, "sats": 8, "hdop": 1.1, "age_ms": 420},
         "cell": {"state": "ready", "rat": "lte", "mcc": 635, "mnc": 10, "tac": 1201,
                  "ci": 26381057, "rsrp_dbm": -97, "rsrq_db": -11, "csq": 21},
         "cell_loc": None, "veh": {"ign": False, "ext_mv": 12650, "bat_mv": 4010},
         "fuel": [{"tank": 1, "method": "capacitive", "model": "escort_td150", "raw": 2310,
                   "raw_unit": "count", "temp_c": 27, "status": "ok"}],
         "q": {"queued": 0, "dropped": 0}}
    r.update(over)
    return r


def envelope(readings, imei=IMEI, boot="a1b2c3d4"):
    return {"schema": "fgt/2.0", "imei": imei, "iccid": "8925010000123456789", "fw": "3.0.0",
            "boot": boot, "readings": readings}


pytestmark = pytest.mark.asyncio(loop_scope="module")


@pytest.fixture(scope="module")
async def client():
    with psycopg.connect(DB, autocommit=True) as c:
        c.execute("DROP SCHEMA public CASCADE; CREATE SCHEMA public;")
    async with app.router.lifespan_context(app):
        transport = httpx.ASGITransport(app=app, client=("203.0.113.9", 1234))
        async with httpx.AsyncClient(transport=transport, base_url="http://test") as cl:
            yield cl


async def login(client):
    with psycopg.connect(DB, autocommit=True) as c:
        c.execute("INSERT INTO users (username, pw_hash) VALUES ('admin', %s) "
                  "ON CONFLICT DO NOTHING", (hash_password("correct horse battery"),))
    r = await client.post("/login", data={"username": "admin", "password": "correct horse battery"})
    assert r.status_code == 303
    page = await client.get("/admin")
    return re.search(r'name="csrf" value="([^"]+)"', page.text).group(1)


async def test_full_flow(client):
    csrf = await login(client)

    # register a unit through the web form; the key is shown once
    r = await client.post("/admin/devices", data={"csrf": csrf, "imei": IMEI, "name": "Hilux 1",
                                                  "plate": "RAD 123 A"})
    assert r.status_code == 200
    key = re.search(r'class="secret">(dk_[^<]+)<', r.text).group(1)

    # CSRF is enforced
    r = await client.post("/admin/devices", data={"csrf": "wrong", "imei": "866000000000001"})
    assert r.status_code == 403

    # API token
    r = await client.post("/admin/tokens", data={"csrf": csrf, "name": "Test app"})
    token = re.search(r'class="secret">(at_[^<]+)<', r.text).group(1)
    auth = {"Authorization": f"Bearer {token}"}

    # webhook receiver on localhost
    got = []

    class Hook(BaseHTTPRequestHandler):
        def do_POST(self):
            body = self.rfile.read(int(self.headers["Content-Length"]))
            got.append((dict(self.headers), body))
            self.send_response(200)
            self.end_headers()

        def log_message(self, *a):
            pass

    srv = HTTPServer(("127.0.0.1", 0), Hook)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    r = await client.post("/admin/webhooks", data={
        "csrf": csrf, "url": f"http://127.0.0.1:{srv.server_port}/hook"})
    secret = re.search(r'class="secret">(whsec_[^<]+)<', r.text).group(1)

    # ingest: auth failures
    body = envelope([reading(0), reading(1)])
    assert (await client.post("/ingest", json=body)).status_code == 401
    assert (await client.post("/ingest", json=body, headers={"X-Api-Key": "dk_nope"})).status_code == 401
    other = envelope([reading(0)], imei="866000000000009")
    assert (await client.post("/ingest", json=other, headers={"X-Api-Key": key})).status_code == 403
    bad = dict(body, schema="fgt/1.0")
    assert (await client.post("/ingest", json=bad, headers={"X-Api-Key": key})).status_code == 400
    assert (await client.post("/ingest", content=b"not json",
                              headers={"X-Api-Key": key})).status_code == 400
    too_many = envelope([reading(i) for i in range(21)])
    assert (await client.post("/ingest", json=too_many, headers={"X-Api-Key": key})).status_code == 400

    # ingest: success and duplicates
    r = await client.post("/ingest", json=body, headers={"X-Api-Key": key})
    assert r.status_code == 200 and r.json() == {"ok": True, "stored": 2, "duplicates": 0}
    r = await client.post("/ingest", json=envelope([reading(1), reading(2, gnss={"fix": False},
                                                                        ts=None)]),
                          headers={"X-Api-Key": key})
    assert r.json() == {"ok": True, "stored": 1, "duplicates": 1}

    # API returns the payload exactly as received
    r = await client.get(f"/api/v1/devices/{IMEI}/readings", headers=auth)
    items = r.json()["items"]
    assert [i["payload"]["seq"] for i in items] == [2, 1, 0]
    assert items[1]["payload"] == reading(1)
    assert items[1]["envelope"]["iccid"] == "8925010000123456789"
    assert items[1]["derived"]["position"]["src"] == "gnss"
    assert items[0]["derived"]["position"] is None          # no fix, no cell lookup key
    assert items[0]["derived"]["time_src"] == "server"
    assert items[1]["derived"]["fuel"][0]["note"] == "no calibration"

    # API auth
    assert (await client.get("/api/v1/devices")).status_code == 401
    assert (await client.get("/api/v1/devices", headers={"Authorization": "Bearer at_x"})).status_code == 401
    r = await client.get("/api/v1/devices", headers=auth)
    assert r.json()["items"][0]["latest"]["payload"]["seq"] == 2

    # calibration through the web form, then litres appear in derived
    prof = {"schema": "fgt-cal/2.0", "tank": 1, "method": "capacitive", "model": "escort_td150",
            "raw_unit": "count", "capacity_l": 80, "valid_raw": [0, 4095],
            "table": [[0, 0], [1650, 30], [2480, 45], [4095, 80]]}
    r = await client.post(f"/devices/{IMEI}/calibration",
                          data={"csrf": csrf, "profile": json.dumps(prof)})
    assert r.status_code == 303 and "saved" in unquote(r.headers["location"])
    bad_prof = dict(prof, table=[[0, 0]])
    r = await client.post(f"/devices/{IMEI}/calibration",
                          data={"csrf": csrf, "profile": json.dumps(bad_prof)})
    assert "Not saved" in unquote(r.headers["location"])
    r = await client.get("/api/v1/readings?after_id=0", headers=auth)
    fuel = r.json()["items"][0]["derived"]["fuel"][0]
    assert fuel["litres"] == 41.9 and fuel["level_pct"] == 52.4   # 30 + 15*(660/830)
    assert r.json()["next_after_id"] == r.json()["items"][-1]["id"]
    r = await client.get(f"/api/v1/devices/{IMEI}/calibrations", headers=auth)
    assert r.json()["items"][0]["profile"]["capacity_l"] == 80

    # live stream: replay after id 0, then a new reading arrives live
    # httpx's ASGI transport buffers whole responses, so serve the stream over real HTTP
    import uvicorn
    server = uvicorn.Server(uvicorn.Config(app, host="127.0.0.1", port=8765, lifespan="off",
                                           log_level="warning"))
    serve_task = asyncio.create_task(server.serve())
    while not server.started:
        await asyncio.sleep(0.05)

    async def collect():
        events = []
        async with httpx.AsyncClient(base_url="http://127.0.0.1:8765") as live, \
                live.stream("GET", "/api/v1/stream?after_id=0", headers=auth) as resp:
            assert resp.status_code == 200
            async for line in resp.aiter_lines():
                if line.startswith("data: "):
                    events.append(json.loads(line[6:]))
                    if len(events) == 4:
                        break
        return events

    task = asyncio.create_task(collect())
    await asyncio.sleep(0.3)
    await client.post("/ingest", json=envelope([reading(3)]), headers={"X-Api-Key": key})
    events = await asyncio.wait_for(task, 10)
    assert [e["payload"]["seq"] for e in events] == [0, 1, 2, 3]
    server.should_exit = True
    await serve_task

    # webhooks: 4 readings delivered, signed
    for _ in range(50):
        if len(got) >= 4:
            break
        await asyncio.sleep(0.2)
    assert len(got) == 4
    headers, raw = got[0]
    assert headers["X-FGT-Signature"] == sign_webhook(secret, headers["X-FGT-Timestamp"], raw)
    sent = json.loads(raw)
    assert sent["event"] == "reading.created" and sent["payload"] == reading(0)

    # web pages render
    for path in ("/", f"/devices/{IMEI}", "/admin", "/developers", f"/readings/{items[1]['id']}"):
        r = await client.get(path)
        assert r.status_code == 200, path
        assert "Content-Security-Policy" in r.headers
    page = (await client.get(f"/devices/{IMEI}")).text
    assert "41.9 L" in page and "RAD 123 A" in page

    # revoke token
    with psycopg.connect(DB, autocommit=True) as c:
        tid = c.execute("SELECT id FROM api_tokens").fetchone()[0]
    await client.post(f"/admin/tokens/{tid}/revoke", data={"csrf": csrf})
    assert (await client.get("/api/v1/devices", headers=auth)).status_code == 401

    # disabled device is refused
    await client.post(f"/devices/{IMEI}/settings", data={"csrf": csrf, "name": "Hilux 1",
                                                         "plate": "RAD 123 A", "active": ""})
    r = await client.post("/ingest", json=envelope([reading(9)]), headers={"X-Api-Key": key})
    assert r.status_code == 401

    # logout ends the session
    await client.post("/logout", data={"csrf": csrf})
    assert (await client.get("/admin")).status_code == 303
    srv.shutdown()


async def test_login_throttle(client):
    for _ in range(10):
        r = await client.post("/login", data={"username": "admin", "password": "wrong"})
    r = await client.post("/login", data={"username": "admin", "password": "correct horse battery"})
    assert "Too many attempts" in r.text
