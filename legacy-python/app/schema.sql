-- Applied automatically at start-up. Every statement is safe to run again.

CREATE TABLE IF NOT EXISTS users (
    id          serial PRIMARY KEY,
    username    text UNIQUE NOT NULL,
    pw_hash     text NOT NULL,
    created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS sessions (
    token_hash  text PRIMARY KEY,
    user_id     int NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    csrf        text NOT NULL,
    created_at  timestamptz NOT NULL DEFAULT now(),
    expires_at  timestamptz NOT NULL
);

CREATE TABLE IF NOT EXISTS devices (
    id            serial PRIMARY KEY,
    imei          text UNIQUE NOT NULL,
    name          text NOT NULL DEFAULT '',
    plate         text NOT NULL DEFAULT '',
    key_hash      text UNIQUE NOT NULL,
    active        boolean NOT NULL DEFAULT true,
    created_at    timestamptz NOT NULL DEFAULT now(),
    last_seen_at  timestamptz,
    last_ip       text
);

-- Every HTTP request from a device, stored exactly as received.
CREATE TABLE IF NOT EXISTS ingests (
    id           bigserial PRIMARY KEY,
    device_id    int REFERENCES devices(id) ON DELETE CASCADE,
    received_at  timestamptz NOT NULL DEFAULT now(),
    remote_ip    text,
    body         text NOT NULL,
    n_readings   int NOT NULL,
    n_new        int NOT NULL
);
CREATE INDEX IF NOT EXISTS ingests_dev ON ingests (device_id, id DESC);

-- One row per reading. payload = the reading object exactly as sent.
CREATE TABLE IF NOT EXISTS readings (
    id           bigserial PRIMARY KEY,
    device_id    int NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
    ingest_id    bigint REFERENCES ingests(id) ON DELETE SET NULL,
    boot         text NOT NULL,
    seq          bigint NOT NULL,
    ts           timestamptz,
    received_at  timestamptz NOT NULL DEFAULT now(),
    envelope     jsonb NOT NULL,
    payload      jsonb NOT NULL,
    lat          double precision,
    lng          double precision,
    pos_src      text,
    acc_m        real,
    UNIQUE (device_id, boot, seq)
);
CREATE INDEX IF NOT EXISTS readings_dev ON readings (device_id, id DESC);
CREATE INDEX IF NOT EXISTS readings_received ON readings (received_at);

CREATE TABLE IF NOT EXISTS calibrations (
    id          serial PRIMARY KEY,
    device_id   int NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
    tank        int NOT NULL,
    profile     jsonb NOT NULL,
    active      boolean NOT NULL DEFAULT true,
    created_at  timestamptz NOT NULL DEFAULT now(),
    created_by  text
);
CREATE INDEX IF NOT EXISTS calibrations_dev ON calibrations (device_id, tank, active);

CREATE TABLE IF NOT EXISTS api_tokens (
    id            serial PRIMARY KEY,
    name          text NOT NULL,
    prefix        text NOT NULL,
    token_hash    text UNIQUE NOT NULL,
    created_at    timestamptz NOT NULL DEFAULT now(),
    last_used_at  timestamptz,
    revoked       boolean NOT NULL DEFAULT false
);

CREATE TABLE IF NOT EXISTS webhooks (
    id          serial PRIMARY KEY,
    url         text NOT NULL,
    secret      text NOT NULL,
    active      boolean NOT NULL DEFAULT true,
    created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS webhook_deliveries (
    id               bigserial PRIMARY KEY,
    webhook_id       int NOT NULL REFERENCES webhooks(id) ON DELETE CASCADE,
    reading_id       bigint NOT NULL REFERENCES readings(id) ON DELETE CASCADE,
    status           text NOT NULL DEFAULT 'pending',   -- pending | delivered | failed
    attempts         int NOT NULL DEFAULT 0,
    next_attempt_at  timestamptz NOT NULL DEFAULT now(),
    last_code        int,
    last_error       text,
    delivered_at     timestamptz
);
CREATE INDEX IF NOT EXISTS deliveries_due ON webhook_deliveries (status, next_attempt_at);

-- Cache of cell-tower positions (OpenCellID), so each cell is looked up once.
CREATE TABLE IF NOT EXISTS cell_cache (
    mcc         int NOT NULL,
    mnc         int NOT NULL,
    tac         bigint NOT NULL,
    ci          bigint NOT NULL,
    found       boolean NOT NULL,
    lat         double precision,
    lng         double precision,
    acc_m       real,
    updated_at  timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (mcc, mnc, tac, ci)
);
