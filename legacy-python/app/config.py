"""Settings, all read from environment variables (see .env.example)."""
import os


def _bool(name: str, default: str) -> bool:
    return os.environ.get(name, default).strip().lower() in ("1", "true", "yes", "on")


class Settings:
    database_url = os.environ.get("DATABASE_URL", "postgresql://car:car@db:5432/car")
    public_url = os.environ.get("PUBLIC_URL", "https://car.mwizerwa.com").rstrip("/")
    cookie_secure = _bool("COOKIE_SECURE", "1")
    session_hours = int(os.environ.get("SESSION_HOURS", "12"))
    display_tz = os.environ.get("DISPLAY_TZ", "Africa/Kigali")
    online_seconds = int(os.environ.get("ONLINE_SECONDS", "180"))
    max_body_bytes = int(os.environ.get("MAX_BODY_BYTES", "65536"))
    max_readings = int(os.environ.get("MAX_READINGS", "20"))
    retention_days = int(os.environ.get("RETENTION_DAYS", "0"))  # 0 = keep forever
    opencellid_key = os.environ.get("OPENCELLID_KEY", "")
    allow_http_webhooks = _bool("ALLOW_HTTP_WEBHOOKS", "0")
    allow_private_webhooks = _bool("ALLOW_PRIVATE_WEBHOOKS", "0")  # tests only
    webhook_max_attempts = int(os.environ.get("WEBHOOK_MAX_ATTEMPTS", "10"))


settings = Settings()
