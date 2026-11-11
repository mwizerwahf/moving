"""Secrets, hashing, sessions, CSRF and a small login throttle."""
import hashlib
import hmac
import secrets
import time
from collections import defaultdict, deque
from datetime import datetime, timedelta, timezone

from argon2 import PasswordHasher
from argon2.exceptions import VerificationError, InvalidHashError

from .config import settings

_ph = PasswordHasher()

DEVICE_KEY_PREFIX = "dk_"
API_TOKEN_PREFIX = "at_"
WEBHOOK_SECRET_PREFIX = "whsec_"
SESSION_COOKIE = "sid"


def new_secret(prefix: str) -> str:
    return prefix + secrets.token_urlsafe(32)


def sha256(value: str) -> str:
    return hashlib.sha256(value.encode()).hexdigest()


def hash_password(password: str) -> str:
    return _ph.hash(password)


def verify_password(pw_hash: str, password: str) -> bool:
    try:
        return _ph.verify(pw_hash, password)
    except (VerificationError, InvalidHashError):
        return False


def sign_webhook(secret: str, timestamp: str, body: bytes) -> str:
    mac = hmac.new(secret.encode(), timestamp.encode() + b"." + body, hashlib.sha256)
    return "sha256=" + mac.hexdigest()


async def create_session(conn, user_id: int) -> tuple[str, str]:
    token = secrets.token_urlsafe(32)
    csrf = secrets.token_urlsafe(24)
    expires = datetime.now(timezone.utc) + timedelta(hours=settings.session_hours)
    await conn.execute("INSERT INTO sessions (token_hash, user_id, csrf, expires_at) "
                       "VALUES (%s, %s, %s, %s)", (sha256(token), user_id, csrf, expires))
    return token, csrf


async def load_session(conn, token: str | None):
    if not token:
        return None
    cur = await conn.execute(
        "SELECT s.csrf, u.id, u.username FROM sessions s JOIN users u ON u.id = s.user_id "
        "WHERE s.token_hash = %s AND s.expires_at > now()", (sha256(token),))
    return await cur.fetchone()


async def delete_session(conn, token: str | None) -> None:
    if token:
        await conn.execute("DELETE FROM sessions WHERE token_hash = %s", (sha256(token),))


class LoginThrottle:
    """At most `limit` failed logins per IP per `window` seconds."""

    def __init__(self, limit: int = 10, window: int = 900):
        self.limit, self.window = limit, window
        self.fails: dict[str, deque] = defaultdict(deque)

    def _trim(self, ip: str) -> deque:
        q = self.fails[ip]
        now = time.monotonic()
        while q and now - q[0] > self.window:
            q.popleft()
        return q

    def blocked(self, ip: str) -> bool:
        return len(self._trim(ip)) >= self.limit

    def fail(self, ip: str) -> None:
        self._trim(ip).append(time.monotonic())

    def reset(self, ip: str) -> None:
        self.fails.pop(ip, None)


login_throttle = LoginThrottle()
