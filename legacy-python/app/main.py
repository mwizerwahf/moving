"""car.mwizerwa.com gateway: receives fgt/2.0 readings over 4G, stores them in Postgres,
shows them in a web interface and passes them on to developers (API, live stream, webhooks)."""
import asyncio
import logging
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, Request
from fastapi.responses import HTMLResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles

from . import api, ingest, web
from .db import close_pool, open_pool
from .webhooks import housekeeping, worker

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")

CSP = ("default-src 'self'; img-src 'self' data: https://tile.openstreetmap.org; "
       "style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; "
       "base-uri 'none'; form-action 'self'")
# Swagger UI loads its own script and styles from jsdelivr
DOCS_CSP = ("default-src 'self'; img-src 'self' data: https://fastapi.tiangolo.com; "
            "style-src 'self' https://cdn.jsdelivr.net; script-src 'self' 'unsafe-inline' "
            "https://cdn.jsdelivr.net; frame-ancestors 'none'")


@asynccontextmanager
async def lifespan(app: FastAPI):
    await open_pool()
    stop = asyncio.Event()
    tasks = [asyncio.create_task(worker(stop)), asyncio.create_task(housekeeping(stop))]
    yield
    stop.set()
    await asyncio.gather(*tasks, return_exceptions=True)
    await close_pool()


app = FastAPI(title="car.mwizerwa.com gateway", version="1.0.0", lifespan=lifespan,
              docs_url="/api/docs", redoc_url=None, openapi_url="/api/openapi.json",
              description="Fuel and GPS telematics gateway. Devices POST fgt/2.0 to /ingest; "
                          "developers read with a Bearer token. See /developers.")
app.mount("/static", StaticFiles(directory=str(Path(__file__).parent / "static")), name="static")
app.include_router(ingest.router)
app.include_router(api.router)
app.include_router(web.router)


@app.middleware("http")
async def security_headers(request: Request, call_next):
    response = await call_next(request)
    h = response.headers
    h.setdefault("X-Content-Type-Options", "nosniff")
    h.setdefault("Referrer-Policy", "same-origin")
    h.setdefault("X-Frame-Options", "DENY")
    h.setdefault("Content-Security-Policy",
                 DOCS_CSP if request.url.path == "/api/docs" else CSP)
    if request.url.path.startswith(("/api/", "/ingest")) is False:
        h.setdefault("Cache-Control", "no-store")
    return response


@app.exception_handler(web.NeedLogin)
async def need_login(request: Request, exc):
    return RedirectResponse("/login", status_code=303)


@app.exception_handler(web.BadCsrf)
async def bad_csrf(request: Request, exc):
    return HTMLResponse("Form expired. Go back, reload the page and try again.", status_code=403)
