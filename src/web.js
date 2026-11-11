// Web interface: login, vehicles, vehicle detail, raw readings, admin.
import { devicesWithLatest } from "./api.js";
import { publicUrl, settings } from "./config.js";
import { all, batch, first, run, stmt } from "./db.js";
import { CalibrationError, validateProfile } from "./fuel.js";
import { pretty } from "./html.js";
import { IMEI_RE } from "./ingest.js";
import { profilesFrom, readingsStmt, toItem } from "./items.js";
import {
  API_TOKEN_PREFIX, DEVICE_KEY_PREFIX, SESSION_COOKIE, WEBHOOK_SECRET_PREFIX, clientIp, createSession,
  deleteSession, getCookie, hashPassword, loadSession, loginBlocked, loginFailed, loginReset, newSecret, sha256,
  verifyPassword,
} from "./security.js";
import * as views from "./views.js";
import { UnsafeURL, checkUrlShape, checkUrlTarget, runBackground } from "./webhooks.js";

export class NeedLogin extends Error {}
export class BadCsrf extends Error {}

const htmlResponse = (body, status = 200, headers = {}) =>
  new Response(String(body), { status, headers: { "content-type": "text/html; charset=utf-8", ...headers } });

export function redirect(location, headers = {}) {
  return new Response(null, { status: 303, headers: { location, ...headers } });
}

function back(url, msg = null) {
  let [path, fragment] = url.split("#");
  if (msg) {
    path += (path.includes("?") ? "&" : "?") + "msg=" +
      encodeURIComponent(msg.replace(/[^A-Za-z0-9 ,._:()-]/g, "").slice(0, 160));
  }
  return redirect(path + (fragment ? "#" + fragment : ""));
}

async function currentUser(request, env) {
  const user = await loadSession(env, getCookie(request, SESSION_COOKIE));
  if (!user) throw new NeedLogin();
  return user;
}

async function formOf(request) {
  try {
    const fd = await request.formData();
    return (k) => {
      const v = fd.get(k);
      return typeof v === "string" ? v : "";
    };
  } catch {
    return () => "";
  }
}

/** A signed-in POST: checks session and CSRF, returns [user, field getter]. */
async function signedForm(request, env) {
  const user = await currentUser(request, env);
  const f = await formOf(request);
  const token = f("csrf");
  if (!token || token !== user.csrf) throw new BadCsrf();
  return [user, f];
}

function ctxFor(env, url, user) {
  return { user, path: url.pathname, msg: url.searchParams.get("msg"), cfg: settings(env) };
}

function sessionCookie(env, token, maxAge) {
  const secure = settings(env).cookieSecure ? "; Secure" : "";
  return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure}`;
}

export async function handleWeb(request, env, ctx, url) {
  const path = url.pathname;
  const method = request.method;
  const db = env.DB;
  let p;

  // ---------------------------------------------------------------- login
  if (path === "/login" && method === "GET") return htmlResponse(views.loginPage(null));

  if (path === "/login" && method === "POST") {
    const ip = clientIp(request);
    if (await loginBlocked(env, ip)) return htmlResponse(views.loginPage("Too many attempts. Try again in 15 minutes."));
    const f = await formOf(request);
    const u = await first(db, "SELECT id, pw_hash FROM users WHERE username = ?", f("username").trim());
    if (!u || !(await verifyPassword(u.pw_hash, f("password")))) {
      await loginFailed(env, ip);
      return htmlResponse(views.loginPage("Wrong user name or password."));
    }
    await loginReset(env, ip);
    const token = await createSession(env, u.id);
    return redirect("/", { "set-cookie": sessionCookie(env, token, settings(env).sessionHours * 3600) });
  }

  if (path === "/logout" && method === "POST") {
    await signedForm(request, env);
    await deleteSession(env, getCookie(request, SESSION_COOKIE));
    return redirect("/login", { "set-cookie": sessionCookie(env, "", 0) });
  }

  // ---------------------------------------------------------------- public
  if (path === "/developers" && method === "GET") {
    const user = await loadSession(env, getCookie(request, SESSION_COOKIE));
    return htmlResponse(views.developersPage(ctxFor(env, url, user), { publicUrl: publicUrl(env, request) }));
  }

  // ---------------------------------------------------------------- vehicles
  if (path === "/" && method === "GET") {
    const user = await currentUser(request, env);
    const rows = await devicesWithLatest(db, "", [], "d.active DESC, d.name, d.imei");
    const cfg = settings(env);
    const points = [];
    for (const { d, it } of rows) {
      const pos = it && it.derived.position;
      if (pos) points.push({ label: d.name || d.plate || d.imei, imei: d.imei, lat: pos.lat, lng: pos.lng, src: pos.src, acc: pos.acc_m });
    }
    const nOnline = rows.filter(({ d }) => d.last_seen_at && Date.now() - new Date(d.last_seen_at) < cfg.onlineSeconds * 1000).length;
    ctx.waitUntil(runBackground(env));
    return htmlResponse(views.indexPage(ctxFor(env, url, user), { rows, nOnline, mapData: { points, track: [] } }));
  }

  if ((p = path.match(/^\/devices\/([^/]+)$/)) && method === "GET") {
    const imei = decodeURIComponent(p[1]);
    const user = await currentUser(request, env);
    const d = await first(db, "SELECT * FROM devices WHERE imei = ?", imei);
    if (!d) return back("/", "Unknown device");
    const beforeRaw = url.searchParams.get("before_id");
    const beforeId = /^\d+$/.test(beforeRaw || "") ? parseInt(beforeRaw, 10) : null;
    const [rows, track, cals] = await batch(db, [
      beforeId
        ? readingsStmt(db, "r.device_id = ? AND r.id < ?", [d.id, beforeId], "r.id DESC", 50)
        : readingsStmt(db, "r.device_id = ?", [d.id], "r.id DESC", 50),
      // the route: positions among the last 500 readings, oldest first
      stmt(db, "SELECT lat, lng FROM (SELECT id, lat, lng FROM readings WHERE device_id = ? ORDER BY id DESC LIMIT 500) " +
        "WHERE lat IS NOT NULL ORDER BY id DESC LIMIT 300", d.id),
      stmt(db, "SELECT id, device_id, tank, profile, created_at, created_by FROM calibrations " +
        "WHERE device_id = ? AND active = 1 ORDER BY id", d.id),
    ]);
    const profiles = profilesFrom(cals)[d.id] || {};
    const items = rows.map((r) => toItem(r, profiles));
    const byTank = new Map();
    for (const c of cals) byTank.set(c.tank, { ...c, profile: JSON.parse(c.profile) });
    const calList = [...byTank.values()].sort((a, b) => a.tank - b.tank);
    const latest = items.length && !beforeId ? items[0] : null;
    const pos = latest && latest.derived.position;
    const points = pos ? [{ label: d.name || d.imei, imei, lat: pos.lat, lng: pos.lng, src: pos.src, acc: pos.acc_m }] : [];
    const cfg = settings(env);
    const today = new Intl.DateTimeFormat("en-CA", { timeZone: cfg.displayTz }).format(new Date());
    const example = { schema: "fgt-cal/2.0", imei, tank: 1, method: "sender", model: "stock", raw_unit: "mV",
      capacity_l: 50, valid_raw: [0, 8000], table: [[500, 50], [2500, 25], [4500, 0]],
      calibrated: today, by: user.username, notes: "" };
    return htmlResponse(views.devicePage(ctxFor(env, url, user), {
      d, items, latest, cals: calList, total: d.n_readings,
      mapData: { points, track: track.map((r) => [r.lat, r.lng]).reverse() },
      nextBefore: items.length === 50 ? items[items.length - 1].id : null, example: pretty(example),
    }));
  }

  if ((p = path.match(/^\/devices\/([^/]+)\/settings$/)) && method === "POST") {
    const imei = decodeURIComponent(p[1]);
    const [, f] = await signedForm(request, env);
    await run(db, "UPDATE devices SET name=?, plate=?, active=? WHERE imei=?",
      f("name").trim().slice(0, 64), f("plate").trim().slice(0, 32), f("active") === "1", imei);
    return back(`/devices/${encodeURIComponent(imei)}`, "Saved");
  }

  if ((p = path.match(/^\/devices\/([^/]+)\/rotate-key$/)) && method === "POST") {
    const imei = decodeURIComponent(p[1]);
    const [user] = await signedForm(request, env);
    const key = newSecret(DEVICE_KEY_PREFIX);
    await run(db, "UPDATE devices SET key_hash=? WHERE imei=?", await sha256(key), imei);
    return htmlResponse(views.secretPage(ctxFor(env, url, user), {
      title: `New device key for ${imei}`, secret: key,
      note: "The old key stopped working now. Put this key in the unit's firmware (X-Api-Key header).",
      backUrl: `/devices/${imei}`,
    }));
  }

  if ((p = path.match(/^\/devices\/([^/]+)\/calibration$/)) && method === "POST") {
    const imei = decodeURIComponent(p[1]);
    const [user, f] = await signedForm(request, env);
    const d = await first(db, "SELECT id FROM devices WHERE imei = ?", imei);
    if (!d) return back("/", "Unknown device");
    let prof;
    try {
      try { prof = JSON.parse(f("profile")); } catch (e) { throw new CalibrationError(e.message); }
      validateProfile(prof);
      if (prof.imei !== undefined && prof.imei !== null && prof.imei !== imei)
        throw new CalibrationError("imei in the profile belongs to another device");
    } catch (e) {
      return back(`/devices/${imei}#calibration`, `Not saved: ${e.message}`);
    }
    prof.imei = imei;
    await batch(db, [
      stmt(db, "UPDATE calibrations SET active=0 WHERE device_id=? AND tank=?", d.id, prof.tank),
      stmt(db, "INSERT INTO calibrations (device_id, tank, profile, created_by) VALUES (?, ?, ?, ?)",
        d.id, prof.tank, JSON.stringify(prof), user.username),
    ]);
    return back(`/devices/${imei}#calibration`, `Calibration for tank ${prof.tank} saved`);
  }

  if ((p = path.match(/^\/devices\/([^/]+)\/calibration\/(\d+)\/remove$/)) && method === "POST") {
    const imei = decodeURIComponent(p[1]);
    const tank = parseInt(p[2], 10);
    await signedForm(request, env);
    await run(db, "UPDATE calibrations SET active=0 WHERE tank=? AND device_id = (SELECT id FROM devices WHERE imei=?)", tank, imei);
    return back(`/devices/${imei}#calibration`, `Calibration for tank ${tank} removed`);
  }

  if ((p = path.match(/^\/readings\/(\d+)$/)) && method === "GET") {
    const user = await currentUser(request, env);
    const id = parseInt(p[1], 10);
    const [rows, bodies] = await batch(db, [
      readingsStmt(db, "r.id = ?", [id], "r.id DESC", 1),
      stmt(db, "SELECT i.body FROM readings r JOIN ingests i ON i.id = r.ingest_id WHERE r.id = ?", id),
    ]);
    if (!rows.length) return back("/", "Unknown reading");
    const items = await fetchItemsFromRows(db, rows);
    return htmlResponse(views.readingPage(ctxFor(env, url, user), { it: items[0], rawBody: bodies[0]?.body || null }));
  }

  // ---------------------------------------------------------------- admin
  if (path === "/admin" && method === "GET") {
    const user = await currentUser(request, env);
    const [devices, tokens, hooks] = await batch(db, [
      stmt(db, "SELECT imei, name, plate, active, created_at, last_seen_at FROM devices ORDER BY created_at DESC"),
      stmt(db, "SELECT id, name, prefix, created_at, last_used_at, revoked FROM api_tokens ORDER BY revoked, id DESC"),
      stmt(db,
        "SELECT w.id, w.url, w.active, w.created_at, " +
        "count(CASE WHEN d.status='pending' THEN 1 END) AS pending, " +
        "count(CASE WHEN d.status='failed' THEN 1 END) AS failed, " +
        "count(CASE WHEN d.status='delivered' THEN 1 END) AS delivered, " +
        "max(CASE WHEN d.status<>'delivered' THEN d.last_error END) AS last_error " +
        "FROM webhooks w LEFT JOIN webhook_deliveries d ON d.webhook_id = w.id GROUP BY w.id ORDER BY w.id"),
    ]);
    ctx.waitUntil(runBackground(env));
    return htmlResponse(views.adminPage(ctxFor(env, url, user), { devices, tokens, hooks, publicUrl: publicUrl(env, request) }));
  }

  if (path === "/admin/devices" && method === "POST") {
    const [user, f] = await signedForm(request, env);
    const imei = f("imei").trim();
    if (!IMEI_RE.test(imei)) return back("/admin", "IMEI must be 14 to 16 digits");
    const key = newSecret(DEVICE_KEY_PREFIX);
    const row = await first(db,
      "INSERT INTO devices (imei, name, plate, key_hash) VALUES (?,?,?,?) ON CONFLICT (imei) DO NOTHING RETURNING id",
      imei, f("name").trim().slice(0, 64), f("plate").trim().slice(0, 32), await sha256(key));
    if (!row) return back("/admin", "That IMEI is already registered");
    return htmlResponse(views.secretPage(ctxFor(env, url, user), {
      title: `Device ${imei} registered`, secret: key,
      note: "Put this key in the unit's firmware. The unit sends it in the X-Api-Key header to " + publicUrl(env, request) + "/ingest.",
      backUrl: "/admin",
    }));
  }

  if (path === "/admin/tokens" && method === "POST") {
    const [user, f] = await signedForm(request, env);
    const name = f("name").trim();
    if (!name) return back("/admin", "Give the token a name, e.g. the developer or app");
    const token = newSecret(API_TOKEN_PREFIX);
    await run(db, "INSERT INTO api_tokens (name, prefix, token_hash) VALUES (?,?,?)", name.slice(0, 64), token.slice(0, 10), await sha256(token));
    return htmlResponse(views.secretPage(ctxFor(env, url, user), {
      title: `API token for ${name}`, secret: token,
      note: "Send it as: Authorization: Bearer <token>. It can read all devices.", backUrl: "/admin",
    }));
  }

  if ((p = path.match(/^\/admin\/tokens\/(\d+)\/revoke$/)) && method === "POST") {
    await signedForm(request, env);
    await run(db, "UPDATE api_tokens SET revoked=1 WHERE id=?", parseInt(p[1], 10));
    return back("/admin", "Token revoked");
  }

  if (path === "/admin/webhooks" && method === "POST") {
    const [user, f] = await signedForm(request, env);
    let hookUrl;
    try {
      hookUrl = checkUrlShape(env, f("url"));
      await checkUrlTarget(env, hookUrl);
    } catch (e) {
      if (e instanceof UnsafeURL) return back("/admin", `Webhook not added: ${e.message}`);
      throw e;
    }
    const secret = newSecret(WEBHOOK_SECRET_PREFIX);
    await run(db, "INSERT INTO webhooks (url, secret) VALUES (?, ?)", hookUrl, secret);
    return htmlResponse(views.secretPage(ctxFor(env, url, user), {
      title: "Webhook added", secret,
      note: "Every new reading is POSTed to " + hookUrl + ". Use this secret to check the X-FGT-Signature header.",
      backUrl: "/admin",
    }));
  }

  if ((p = path.match(/^\/admin\/webhooks\/(\d+)\/toggle$/)) && method === "POST") {
    await signedForm(request, env);
    await run(db, "UPDATE webhooks SET active = 1 - active WHERE id=?", parseInt(p[1], 10));
    return back("/admin", "Webhook updated");
  }

  if ((p = path.match(/^\/admin\/webhooks\/(\d+)\/delete$/)) && method === "POST") {
    await signedForm(request, env);
    const id = parseInt(p[1], 10);
    await batch(db, [
      stmt(db, "DELETE FROM webhook_deliveries WHERE webhook_id=?", id),
      stmt(db, "DELETE FROM webhooks WHERE id=?", id),
    ]);
    return back("/admin", "Webhook deleted");
  }

  if (path === "/admin/password" && method === "POST") {
    const [user, f] = await signedForm(request, env);
    const row = await first(db, "SELECT pw_hash FROM users WHERE id=?", user.id);
    if (!(await verifyPassword(row.pw_hash, f("current")))) return back("/admin", "Current password is wrong");
    const pw = f("new");
    if (pw.length < 12 || pw !== f("repeat")) return back("/admin", "New password must be 12 characters or more and match");
    await batch(db, [
      stmt(db, "UPDATE users SET pw_hash=? WHERE id=?", await hashPassword(env, pw), user.id),
      stmt(db, "DELETE FROM sessions WHERE user_id=? AND token_hash<>?", user.id, await sha256(getCookie(request, SESSION_COOKIE) || "")),
    ]);
    return back("/admin", "Password changed; other sessions signed out");
  }

  return null;
}

async function fetchItemsFromRows(db, rows) {
  const cals = await all(db, "SELECT device_id, tank, profile FROM calibrations WHERE active = 1 AND device_id = ? ORDER BY id", rows[0].device_id);
  const profiles = profilesFrom(cals);
  return rows.map((r) => toItem(r, profiles[r.device_id]));
}

