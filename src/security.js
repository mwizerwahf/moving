// Secrets, hashing, sessions, CSRF and the login throttle. Web Crypto only (no dependencies).
import { settings } from "./config.js";
import { addSeconds, first, now, run } from "./db.js";

export const DEVICE_KEY_PREFIX = "dk_";
export const API_TOKEN_PREFIX = "at_";
export const WEBHOOK_SECRET_PREFIX = "whsec_";
export const SESSION_COOKIE = "sid";

const enc = new TextEncoder();

function b64url(bytes) {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromB64(s) {
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");

export function randomToken(nbytes = 32) {
  return b64url(crypto.getRandomValues(new Uint8Array(nbytes)));
}

export function newSecret(prefix) {
  return prefix + randomToken(32);
}

export async function sha256(value) {
  return hex(await crypto.subtle.digest("SHA-256", enc.encode(value)));
}

function equalBytes(a, b) {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a[i] ^ b[i];
  return d === 0;
}

async function pbkdf2(password, salt, iterations) {
  const key = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations }, key, 256);
  return new Uint8Array(bits);
}

/** Format: pbkdf2_sha256$<iterations>$<salt b64url>$<hash b64url> (same as scripts/manage.mjs). */
export async function hashPassword(env, password) {
  const iterations = settings(env).pbkdf2Iterations;
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const hash = await pbkdf2(password, salt, iterations);
  return `pbkdf2_sha256$${iterations}$${b64url(salt)}$${b64url(hash)}`;
}

export async function verifyPassword(pwHash, password) {
  try {
    const [algo, it, salt, hash] = String(pwHash).split("$");
    const iterations = parseInt(it, 10);
    if (algo !== "pbkdf2_sha256" || !(iterations > 0 && iterations <= 100000)) return false;
    return equalBytes(await pbkdf2(password, fromB64(salt), iterations), fromB64(hash));
  } catch {
    return false;
  }
}

export async function signWebhook(secret, timestamp, body) {
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const msg = new Uint8Array([...enc.encode(timestamp + "."), ...body]);
  return "sha256=" + hex(await crypto.subtle.sign("HMAC", key, msg));
}

// ------------------------------------------------------------------ sessions
export async function createSession(env, userId) {
  const token = randomToken(32);
  const csrf = randomToken(24);
  await run(env.DB, "INSERT INTO sessions (token_hash, user_id, csrf, expires_at) VALUES (?, ?, ?, ?)",
    await sha256(token), userId, csrf, addSeconds(settings(env).sessionHours * 3600));
  return token;
}

export async function loadSession(env, token) {
  if (!token) return null;
  return await first(env.DB,
    "SELECT s.csrf, u.id, u.username FROM sessions s JOIN users u ON u.id = s.user_id " +
    "WHERE s.token_hash = ? AND s.expires_at > ?", await sha256(token), now());
}

export async function deleteSession(env, token) {
  if (token) await run(env.DB, "DELETE FROM sessions WHERE token_hash = ?", await sha256(token));
}

export function getCookie(request, name) {
  const header = request.headers.get("cookie") || "";
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return null;
}

// ------------------------------------------------------------------ login throttle (in D1,
// because Workers have no shared memory between requests)
const LIMIT = 10;
const WINDOW_S = 900;

export async function loginBlocked(env, ip) {
  const row = await first(env.DB, "SELECT count(*) AS n FROM login_failures WHERE ip = ? AND at > ?",
    ip, addSeconds(-WINDOW_S));
  return (row?.n || 0) >= LIMIT;
}

export async function loginFailed(env, ip) {
  await run(env.DB, "INSERT INTO login_failures (ip, at) VALUES (?, ?)", ip, now());
}

export async function loginReset(env, ip) {
  await run(env.DB, "DELETE FROM login_failures WHERE ip = ?", ip);
}

export function clientIp(request) {
  return request.headers.get("cf-connecting-ip") || request.headers.get("x-real-ip") || "?";
}
