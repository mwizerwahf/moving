-- D1 (SQLite) schema. Every statement is safe to run again:
--   npx wrangler d1 execute car-gateway --remote --file=schema.sql
--
-- Times are UTC ISO-8601 text ("2026-11-01T09:12:44.512Z"), which sorts correctly as text.
-- Built for the D1 free plan: few indexes (each index costs an extra "row written" per insert)
-- and no foreign keys on the high-volume tables (a cascade would scan them on every delete).

CREATE TABLE IF NOT EXISTS users (
    id          INTEGER PRIMARY KEY,
    username    TEXT UNIQUE NOT NULL,
    pw_hash     TEXT NOT NULL,
    created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS sessions (
    token_hash  TEXT PRIMARY KEY,
    user_id     INTEGER NOT NULL,
    csrf        TEXT NOT NULL,
    created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    expires_at  TEXT NOT NULL
);

-- Failed sign-ins, for the throttle (10 per address per 15 minutes).
CREATE TABLE IF NOT EXISTS login_failures (
    ip  TEXT NOT NULL,
    at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS login_failures_ip ON login_failures (ip, at);

CREATE TABLE IF NOT EXISTS devices (
    id               INTEGER PRIMARY KEY,
    imei             TEXT UNIQUE NOT NULL,
    name             TEXT NOT NULL DEFAULT '',
    plate            TEXT NOT NULL DEFAULT '',
    key_hash         TEXT UNIQUE NOT NULL,
    active           INTEGER NOT NULL DEFAULT 1,
    created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    last_seen_at     TEXT,
    last_ip          TEXT,
    last_reading_id  INTEGER,            -- newest reading, so lists need no scan
    n_readings       INTEGER NOT NULL DEFAULT 0
);

-- Every HTTP request from a device, stored exactly as received.
CREATE TABLE IF NOT EXISTS ingests (
    id           INTEGER PRIMARY KEY,
    device_id    INTEGER NOT NULL,
    received_at  TEXT NOT NULL,
    remote_ip    TEXT,
    body         TEXT NOT NULL,
    n_readings   INTEGER NOT NULL
);

-- One row per reading. payload = the reading object exactly as sent (JSON text).
CREATE TABLE IF NOT EXISTS readings (
    id           INTEGER PRIMARY KEY,
    device_id    INTEGER NOT NULL,
    ingest_id    INTEGER,
    boot         TEXT NOT NULL,
    seq          INTEGER NOT NULL,
    ts           TEXT,
    received_at  TEXT NOT NULL,
    envelope     TEXT NOT NULL,
    payload      TEXT NOT NULL,
    lat          REAL,
    lng          REAL,
    pos_src      TEXT,
    acc_m        REAL,
    UNIQUE (device_id, boot, seq)
);
CREATE INDEX IF NOT EXISTS readings_dev ON readings (device_id, id);

CREATE TABLE IF NOT EXISTS calibrations (
    id          INTEGER PRIMARY KEY,
    device_id   INTEGER NOT NULL,
    tank        INTEGER NOT NULL,
    profile     TEXT NOT NULL,
    active      INTEGER NOT NULL DEFAULT 1,
    created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    created_by  TEXT
);
CREATE INDEX IF NOT EXISTS calibrations_dev ON calibrations (device_id, tank, active);

CREATE TABLE IF NOT EXISTS api_tokens (
    id            INTEGER PRIMARY KEY,
    name          TEXT NOT NULL,
    prefix        TEXT NOT NULL,
    token_hash    TEXT UNIQUE NOT NULL,
    created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    last_used_at  TEXT,
    revoked       INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS webhooks (
    id          INTEGER PRIMARY KEY,
    url         TEXT NOT NULL,
    secret      TEXT NOT NULL,
    active      INTEGER NOT NULL DEFAULT 1,
    created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS webhook_deliveries (
    id               INTEGER PRIMARY KEY,
    webhook_id       INTEGER NOT NULL,
    reading_id       INTEGER NOT NULL,
    status           TEXT NOT NULL DEFAULT 'pending',   -- pending | delivered | failed
    attempts         INTEGER NOT NULL DEFAULT 0,
    next_attempt_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    last_code        INTEGER,
    last_error       TEXT,
    delivered_at     TEXT
);
CREATE INDEX IF NOT EXISTS deliveries_due ON webhook_deliveries (status, next_attempt_at);

-- Cache of cell-tower positions (OpenCellID), so each cell is looked up once.
CREATE TABLE IF NOT EXISTS cell_cache (
    mcc         INTEGER NOT NULL,
    mnc         INTEGER NOT NULL,
    tac         INTEGER NOT NULL,
    ci          INTEGER NOT NULL,
    found       INTEGER NOT NULL,
    lat         REAL,
    lng         REAL,
    acc_m       REAL,
    updated_at  TEXT NOT NULL,
    PRIMARY KEY (mcc, mnc, tac, ci)
);

-- Small key/value store: when housekeeping last ran, and so on.
CREATE TABLE IF NOT EXISTS meta (
    key    TEXT PRIMARY KEY,
    value  TEXT NOT NULL
);
INSERT OR IGNORE INTO meta (key, value) VALUES ('housekeeping_at', '1970-01-01T00:00:00.000Z');
