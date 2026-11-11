# car.mwizerwa.com gateway (Cloudflare Pages edition)

Receives fuel and position readings from the vehicle units over 4G (format fgt/2.0), stores them
in Cloudflare D1, shows them in a web interface, and passes every reading on, unchanged, to
developers through an API, a live stream and webhooks. Runs entirely on Cloudflare's **free** plan.

```
vehicle unit --4G, HTTPS--> Cloudflare Pages
                              |-- /static/*, /api/docs   static files from the CDN (free, unlimited)
                              '-- everything else         Pages Function (src/) --> D1 database
                                    |--> web interface   /
                                    |--> developer API   /api/v1/...
                                    |--> live stream     /api/v1/stream
                                    '--> webhooks        POST to developers' URLs
```

## What is where

| Address | Who uses it | Protection |
|---|---|---|
| `POST /ingest` | vehicle units | per-unit device key (`X-Api-Key` header); IMEI must match the key |
| `/`, `/devices/...`, `/admin` | you, in a browser | user name and password; session cookie; CSRF tokens |
| `/api/v1/...` | developers' apps | API token (`Authorization: Bearer ...`), read-only |
| `/developers`, `/api/docs` | developers | public (no data, only documentation) |

Security: HTTPS (Cloudflare certificates, HSTS); keys and tokens stored only as SHA-256 hashes and
shown once; passwords hashed with PBKDF2-SHA256; sign-in limited to 10 failures per 15 minutes per
address; strict Content-Security-Policy; webhooks signed with HMAC-SHA256 and refused for private
addresses; request size and readings per request limited.

| Folder / file | Contents |
|---|---|
| `functions/[[path]].js` | Pages entry point; hands every request to `src/app.js` |
| `src/` | the application (routes, D1 queries, pages) |
| `public/` | files served as they are: CSS, fonts, Leaflet, API docs, Pages config (`_routes.json`, `_headers`) |
| `schema.sql` | database tables |
| `wrangler.toml` | Cloudflare settings and database binding |
| `scripts/manage.mjs` | creates a web user / resets a password |
| `tests/` | end-to-end test that runs the app locally |
| `legacy-python/` | the previous FastAPI + PostgreSQL version, for reference only; not deployed |

## Host it on Cloudflare Pages: step by step

You need: a computer with [Node.js](https://nodejs.org) 20 or newer and Git, this repository
(`https://github.com/mwizerwahf/moving`), and a free Cloudflare account.

### 1. Create a Cloudflare account

Sign up at https://dash.cloudflare.com/sign-up and confirm your email address. The free plan is enough.

### 2. Get the code and install the tools

```sh
git clone https://github.com/mwizerwahf/moving.git
cd moving
npm install
```

### 3. Sign in to Cloudflare from the command line

```sh
npx wrangler login
```

A browser window opens. Click **Allow**, then return to the terminal.

### 4. Create the database

```sh
npx wrangler d1 create car-gateway
```

The output contains a line like `"database_id": "1a2b3c4d-...."`. If Wrangler asks whether to add the
configuration for you, answer **No**. Open `wrangler.toml`, and replace
`00000000-0000-0000-0000-000000000000` with your id:

```toml
database_id = "1a2b3c4d-...."
```

### 5. Create the tables

```sh
npm run db:init:remote
```

Answer `y` if asked to confirm. The output ends with a success message listing the statements run.

### 6. Create your login

```sh
npm run manage -- create-user admin
```

Type a password of 12 characters or more, twice. The same command resets a forgotten password.

### 7. Save the database id to GitHub

```sh
git add wrangler.toml
git commit -m "Set D1 database id"
git push
```

### 8. Create the Pages project from GitHub

1. Open https://dash.cloudflare.com, then **Workers & Pages** in the left menu.
2. Click **Create** (or **Create application**), choose the **Pages** tab, then **Import an existing
   Git repository** (or **Connect to Git**).
3. Choose **GitHub**, authorise Cloudflare, and allow it access to the `moving` repository.
4. Select `mwizerwahf/moving` and click **Begin setup**.
5. Fill in:
   - Project name: `car-gateway` (this becomes `car-gateway.pages.dev`; if taken, Cloudflare adds letters)
   - Production branch: `main`
   - Framework preset: **None**
   - Build command: *leave empty*
   - Build output directory: `public`
   - Root directory: *leave empty*
6. Click **Save and Deploy** and wait for **Success** (about one minute).

Cloudflare reads `wrangler.toml`, so the database binding (`DB`) and the settings are applied
automatically. You can check under the project's **Settings > Bindings**.

### 9. Check that it works

- Open `https://car-gateway.pages.dev/api/v1/health`. It shows `{"ok":true}`.
- Open `https://car-gateway.pages.dev` and sign in with the user from step 6.

Use the address Cloudflare shows on the project page if it differs from `car-gateway.pages.dev`.

### 10. Optional: cell-tower positions

To place vehicles by cell tower when GPS has no fix, get a free key from https://opencellid.org and run:

```sh
npx wrangler pages secret put OPENCELLID_KEY --project-name car-gateway
```

Paste the key when asked. It takes effect on the next deployment. To trigger one, open
**Deployments**, open the menu next to the latest deployment, and choose **Retry deployment**.

### 11. Use your own domain, car.mwizerwa.com

1. In the Pages project, open **Custom domains**, then **Set up a custom domain**, enter
   `car.mwizerwa.com`, and continue.
2. Where mwizerwa.com's DNS is managed:
   - **On Cloudflare:** click **Activate domain**. The DNS record is created for you. If an older `A`
     record named `car` exists (the old AWS server), delete it first.
   - **Elsewhere:** at your DNS provider, delete any old `car` record, then add a `CNAME` record with
     name `car` and target `car-gateway.pages.dev`. Back in Cloudflare, click **Check DNS records**.
3. Wait until the domain shows **Active**. This takes a few minutes, sometimes up to an hour.
4. In `wrangler.toml`, set `PUBLIC_URL = "https://car.mwizerwa.com"`, then deploy it:
   ```sh
   git commit -am "Use car.mwizerwa.com" && git push
   ```
   Every push to `main` deploys automatically.

### 12. Register each unit

In **Settings**, enter the unit's IMEI (printed on the module, or `AT+CGSN`). Copy the device key,
which is shown only once, into the unit's firmware. The unit then sends:

```
POST https://car.mwizerwa.com/ingest
Content-Type: application/json
X-Api-Key: dk_...
```

On the Air780EU, enable SSL with `AT+HTTPSSL=1` before `AT+HTTPACTION`. Cloudflare requires SNI,
which the module's SSL stack sends when the URL contains the host name.

**Plain HTTP fallback, only if the module cannot complete HTTPS.** This needs the custom domain on a
Cloudflare-managed zone, and it sends the device key unencrypted over the mobile network. In the
mwizerwa.com zone, go to **SSL/TLS > Edge Certificates** and turn **Always Use HTTPS** off. The app
itself still redirects every address except `/ingest` to HTTPS. `*.pages.dev` addresses are always
HTTPS.

### 13. Give developers access and calibrate tanks

In **Settings**, create one API token per developer or app, and point them to `/developers`. Add
webhooks in Settings too. On each vehicle's page, paste its fgt-cal/2.0 calibration profile; until
then, fuel shows as raw sensor values.

## Try it without a vehicle

With a device key from step 12 (the example uses IMEI 866123456789012, so register that IMEI or
change it in the file):

```sh
curl -X POST https://car.mwizerwa.com/ingest \
  -H "Content-Type: application/json" -H "X-Api-Key: dk_..." \
  --data @examples/ingest_example.json
# {"ok":true,"stored":1,"duplicates":0}   sending it again gives stored 0, duplicates 1
```

## Day-to-day

| Task | How |
|---|---|
| Deploy a change | `git push` to `main` (Cloudflare builds and deploys by itself) |
| See live logs | `npx wrangler pages deployment tail --project-name car-gateway` |
| Reset a password | `npm run manage -- create-user admin` |
| Back up | `npx wrangler d1 export car-gateway --remote --output=backup-DATE.sql` |
| Undo a mistake | D1 Time Travel keeps 7 days on the free plan: `npx wrangler d1 time-travel restore car-gateway --timestamp=2026-11-11T08:00:00Z` |
| Database query | `npx wrangler d1 execute car-gateway --remote --command "SELECT count(*) FROM readings"` |
| Run locally | `npm run db:init:local`, `npm run manage -- create-user admin --local`, then `npm run dev` and open http://127.0.0.1:8788 |
| Run the tests | `npm test` |

## Settings (wrangler.toml `[vars]`)

| Name | Meaning |
|---|---|
| `PUBLIC_URL` | `https://car.mwizerwa.com`; empty = the address the site was opened on |
| `DISPLAY_TZ` | time zone in the web interface (default Africa/Kigali) |
| `ONLINE_SECONDS` | seconds since last report to count a vehicle as reporting (180) |
| `RETENTION_DAYS` | delete readings older than this; 0 keeps everything (90) |
| `RAW_BODY_DAYS` | keep the raw HTTP request bodies this long (7); 0 = as long as readings |
| `SESSION_HOURS` | web sign-in lifetime (12) |
| `OPENCELLID_KEY` | secret, set with `wrangler pages secret put` (step 10) |

## How it fits the free plan

| Free limit | What the app does about it |
|---|---|
| Functions: 100,000 requests per day | Static files never run the Function (`public/_routes.json`); crawlers are turned away (`robots.txt`) |
| Functions: 10 ms CPU per request | Pages rendered with plain template strings; password hashing tuned to ~6 ms (PBKDF2, 50,000 rounds) |
| D1: 50 queries per request | Lists use a stored "latest reading" per vehicle instead of one query per vehicle; related queries are batched |
| D1: 100,000 rows written per day | Only the indexes that are needed; token "last used" saved at most every 5 minutes |
| D1: 5 million rows read per day | No full-table counts (a stored counter per vehicle); clean-up reads only rows being deleted |
| D1: 500 MB per database | Readings kept `RETENTION_DAYS`, raw request bodies only `RAW_BODY_DAYS` |
| No cron, no background process | Webhooks are sent right after each ingest; retries and hourly clean-up run alongside normal requests |
| No shared memory | Live stream polls the database every 3 s; each connection lasts ~2 minutes, then clients reconnect with `Last-Event-ID` and miss nothing |

**Rough capacity:** a reading takes about 0.8 KB and about 9 rows written over its life. That is
about **5 vehicles reporting once a minute** with 90 days of history, or 10 vehicles reporting every
2 minutes. Units that send several readings per request use fewer writes. For more vehicles, the
Workers Paid plan (US$5/month) raises the limits a hundredfold, with no code change.

## How positions are chosen

GPS when the reading has a fix. Otherwise the modem's own cell position (`cell_loc`) if sent.
Otherwise the serving cell (`mcc`, `mnc`, `tac`, `ci`) is looked up on OpenCellID, if
`OPENCELLID_KEY` is set, and cached for 30 days. Cell positions are marked `cell` with an accuracy
in metres, often several hundred.

## Limits of this version

- Theft and refuel alerts from the calibration profile are stored but not yet raised.
- If no unit reports and nobody opens the web interface, failed webhooks wait until the next
  request to be retried.
- Data from the old PostgreSQL server is not copied over automatically.
- The map uses OpenStreetMap's public tiles, which are fine for light use. For heavy use, switch
  to a paid tile provider.
