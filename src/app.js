// car.mwizerwa.com gateway on Cloudflare Pages Functions + D1.
// Receives fgt/2.0 readings over 4G, stores them, shows them in a web interface and passes
// them on to developers (API, live stream, webhooks). Static files in /public are served by
// Pages directly and never reach this code (see public/_routes.json).
import { HttpError, errorResponse, handleApi } from "./api.js";
import { ingest } from "./ingest.js";
import { BadCsrf, NeedLogin, handleWeb, redirect } from "./web.js";

const CSP =
  "default-src 'self'; img-src 'self' data: https://tile.openstreetmap.org; style-src 'self'; script-src 'self'; " +
  "connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'";

function withHeaders(response, path, https) {
  // Responses from fetch()/redirects can be immutable; copy them so headers can be set.
  const res = new Response(response.body, response);
  const h = res.headers;
  const setDefault = (k, v) => { if (!h.has(k)) h.set(k, v); };
  setDefault("X-Content-Type-Options", "nosniff");
  setDefault("Referrer-Policy", "same-origin");
  setDefault("X-Frame-Options", "DENY");
  setDefault("Content-Security-Policy", CSP);
  if (https) setDefault("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  if (!path.startsWith("/api/") && !path.startsWith("/ingest")) setDefault("Cache-Control", "no-store");
  return res;
}

async function route(request, env, ctx, url) {
  const path = url.pathname;
  if (path === "/ingest") {
    if (request.method !== "POST") return new Response(JSON.stringify({ detail: "Method Not Allowed" }),
      { status: 405, headers: { "content-type": "application/json", allow: "POST" } });
    return ingest(request, env, ctx);
  }
  if (path.startsWith("/api/")) {
    try {
      return await handleApi(request, env, ctx, url);
    } catch (e) {
      if (e instanceof HttpError) return errorResponse(e);
      throw e;
    }
  }
  try {
    const res = await handleWeb(request, env, ctx, url);
    if (res) return res;
  } catch (e) {
    if (e instanceof NeedLogin) return redirect("/login");
    if (e instanceof BadCsrf) return new Response("Form expired. Go back, reload the page and try again.",
      { status: 403, headers: { "content-type": "text/plain; charset=utf-8" } });
    throw e;
  }
  return new Response("Not Found", { status: 404, headers: { "content-type": "text/plain; charset=utf-8" } });
}

export async function handle(context) {
  const { request, env } = context;
  const ctx = { waitUntil: (p) => context.waitUntil(p) };
  const url = new URL(request.url);
  const local = url.hostname === "localhost" || url.hostname === "127.0.0.1";
  const https = url.protocol === "https:";

  // HTTPS everywhere except /ingest, which some 4G modules can only reach over plain HTTP
  // (only if you also turn off "Always Use HTTPS" for the domain; see README).
  if (!https && !local && url.pathname !== "/ingest") {
    url.protocol = "https:";
    return Response.redirect(url.toString(), 308);
  }
  if (!env.DB) {
    return new Response("D1 database binding 'DB' is missing. See README, step 'Bind the database'.", { status: 500 });
  }
  let res;
  try {
    res = await route(request, env, ctx, url);
  } catch (e) {
    console.error("unhandled error", e?.stack || e);
    res = url.pathname.startsWith("/api/") || url.pathname === "/ingest"
      ? new Response(JSON.stringify({ ok: false, detail: "internal error" }), { status: 500, headers: { "content-type": "application/json" } })
      : new Response("Something went wrong. Try again in a moment.", { status: 500, headers: { "content-type": "text/plain; charset=utf-8" } });
  }
  return withHeaders(res, url.pathname, https);
}
