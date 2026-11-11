"""Command line tasks. Run inside the app container, for example:

    docker compose exec app python -m app.manage create-user admin
    docker compose exec app python -m app.manage add-device 866123456789012 --name "Hilux 1" --plate "RAD 123 A"
    docker compose exec app python -m app.manage add-token "Fleet app"
"""
import argparse
import getpass
import sys
from pathlib import Path

import psycopg

from .config import settings
from .security import API_TOKEN_PREFIX, DEVICE_KEY_PREFIX, hash_password, new_secret, sha256


def connect():
    conn = psycopg.connect(settings.database_url, autocommit=True)
    conn.execute((Path(__file__).parent / "schema.sql").read_text())
    return conn


def create_user(args):
    pw = args.password or getpass.getpass("Password (12+ characters): ")
    if len(pw) < 12:
        sys.exit("Password must be 12 characters or more.")
    if not args.password and pw != getpass.getpass("Again: "):
        sys.exit("Passwords do not match.")
    with connect() as conn:
        conn.execute("INSERT INTO users (username, pw_hash) VALUES (%s, %s) ON CONFLICT (username) "
                     "DO UPDATE SET pw_hash = EXCLUDED.pw_hash", (args.username, hash_password(pw)))
    print(f"User {args.username} saved.")


def add_device(args):
    key = new_secret(DEVICE_KEY_PREFIX)
    with connect() as conn:
        cur = conn.execute("INSERT INTO devices (imei, name, plate, key_hash) VALUES (%s,%s,%s,%s) "
                           "ON CONFLICT (imei) DO NOTHING RETURNING id",
                           (args.imei, args.name, args.plate, sha256(key)))
        if not cur.fetchone():
            sys.exit("That IMEI is already registered. Replace its key in the web interface.")
    print(f"Device {args.imei} registered. Device key (shown once):\n{key}")


def add_token(args):
    token = new_secret(API_TOKEN_PREFIX)
    with connect() as conn:
        conn.execute("INSERT INTO api_tokens (name, prefix, token_hash) VALUES (%s,%s,%s)",
                     (args.name, token[:10], sha256(token)))
    print(f"API token for {args.name} (shown once):\n{token}")


def main():
    p = argparse.ArgumentParser(prog="python -m app.manage")
    sub = p.add_subparsers(dest="cmd", required=True)
    u = sub.add_parser("create-user", help="create a web user, or reset their password")
    u.add_argument("username")
    u.add_argument("--password", help="skip the prompt (avoid: it stays in shell history)")
    u.set_defaults(fn=create_user)
    d = sub.add_parser("add-device", help="register a unit and print its device key")
    d.add_argument("imei")
    d.add_argument("--name", default="")
    d.add_argument("--plate", default="")
    d.set_defaults(fn=add_device)
    t = sub.add_parser("add-token", help="create a developer API token")
    t.add_argument("name")
    t.set_defaults(fn=add_token)
    args = p.parse_args()
    args.fn(args)


if __name__ == "__main__":
    main()
