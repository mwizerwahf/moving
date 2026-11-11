// Settings, read from Cloudflare environment variables (wrangler.toml [vars], or the dashboard).

const cache = new WeakMap();

export function settings(env) {
  let s = cache.get(env);
  if (s) return s;
  const int = (k, d) => {
    const v = parseInt(env[k] ?? "", 10);
    return Number.isFinite(v) ? v : d;
  };
  const bool = (k, d) =>
    ["1", "true", "yes", "on"].includes(String(env[k] ?? d).trim().toLowerCase());
  s = {
    // Leave empty to use the address the request came in on (works for *.pages.dev too).
    publicUrl: String(env.PUBLIC_URL || "").replace(/\/+$/, ""),
    cookieSecure: bool("COOKIE_SECURE", "1"),
    sessionHours: int("SESSION_HOURS", 12),
    displayTz: env.DISPLAY_TZ || "Africa/Kigali",
    onlineSeconds: int("ONLINE_SECONDS", 180),
    maxBodyBytes: int("MAX_BODY_BYTES", 65536),
    maxReadings: int("MAX_READINGS", 20),
    retentionDays: int("RETENTION_DAYS", 0), // 0 = keep forever
    rawBodyDays: int("RAW_BODY_DAYS", 7), // raw request bodies; 0 = as long as the readings
    opencellidKey: env.OPENCELLID_KEY || "",
    allowHttpWebhooks: bool("ALLOW_HTTP_WEBHOOKS", "0"),
    allowPrivateWebhooks: bool("ALLOW_PRIVATE_WEBHOOKS", "0"), // local tests only
    webhookMaxAttempts: int("WEBHOOK_MAX_ATTEMPTS", 10),
    // Free plan allows ~10 ms CPU per request; 50k PBKDF2-SHA256 rounds take about 6 ms.
    pbkdf2Iterations: Math.min(int("PBKDF2_ITERATIONS", 50000), 100000),
  };
  cache.set(env, s);
  return s;
}

export function publicUrl(env, request) {
  return settings(env).publicUrl || new URL(request.url).origin;
}
