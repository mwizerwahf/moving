// The pages of the web interface (ported from the Jinja templates of the Python version).
import { ago, fixed, fmtTime, html, isOnline, pretty, raw, scriptJson } from "./html.js";

// Bump when files in public/static change, so browsers fetch the new version.
const V = "2";
const asset = (p) => `/static/${p}?v=${V}`;
const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const has = (v) => v !== null && v !== undefined;

// ------------------------------------------------------------------ layout
function layout(c, { title, head = "", main, scripts = "" }) {
  const here = c.path;
  const user = c.user;
  const cur = (yes) => (yes ? raw(' aria-current="page"') : "");
  return html`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title} | car.mwizerwa.com</title>
<link rel="stylesheet" href="${asset("style.css")}">
${head}
</head>
<body>
<header class="bar">
  <a class="brand" href="/"><span class="brand-mark" aria-hidden="true"></span>car.mwizerwa.com</a>
  <nav aria-label="Main">
    ${user ? html`<a href="/"${cur(here === "/" || here.startsWith("/devices") || here.startsWith("/readings"))}>Vehicles</a>
    <a href="/admin"${cur(here.startsWith("/admin"))}>Settings</a>` : ""}
    <a href="/developers"${cur(here === "/developers")}>Developers</a>
    ${user
      ? html`<form method="post" action="/logout"><input type="hidden" name="csrf" value="${user.csrf}"><button type="submit">Sign out</button></form>`
      : html`<a href="/login">Sign in</a>`}
  </nav>
</header>
<main>
${c.msg ? html`<p class="note" role="status">${c.msg}</p>` : ""}
${main}
</main>
${scripts}
</body>
</html>`;
}

const leafletHead = html`<link rel="stylesheet" href="${asset("leaflet.css")}">`;
const leafletScripts = html`<script src="${asset("leaflet.js")}"></script><script src="${asset("map.js")}"></script>`;
const csrfField = (c) => html`<input type="hidden" name="csrf" value="${c.user.csrf}">`;

// ------------------------------------------------------------------ macros
function gauge(pct, big = false) {
  const n = has(pct) ? Math.ceil((pct || 0) / 10) : 0;
  const cls = `gauge${big ? " gauge-big" : ""}${has(pct) && pct < 15 ? " low" : ""}`;
  const cells = Array.from({ length: 10 }, (_, i) => (i < n ? raw('<i class="on"></i>') : raw("<i></i>")));
  return html`<span class="${cls}" role="img" aria-label="Fuel ${has(pct) ? pct : "unknown"} percent">${cells}</span>`;
}

function fuelCell(it) {
  const d = it && it.derived.fuel.length ? it.derived.fuel[0] : null;
  const fuel = it ? it.payload.fuel : null;
  const f = Array.isArray(fuel) && fuel.length && isObj(fuel[0]) ? fuel[0] : null;
  if (d && has(d.litres))
    return html`${gauge(d.level_pct)}<span class="nowrap">${fixed(d.litres, 1)} L</span> <span class="small">${fixed(d.level_pct, 0)}%</span>`;
  if (f)
    return html`<span class="small">raw ${has(f.raw) ? f.raw : "—"} ${f.raw_unit || ""}, ${d ? d.note : "no calibration"}</span>`;
  return html`<span class="small">no fuel sensor</span>`;
}

function posCell(it) {
  const p = it ? it.derived.position : null;
  if (!p) return html`<span class="small">no position</span>`;
  return html`<span class="src src-${p.src}">${p.src === "gnss" ? "GPS" : "Cell"}</span>
<span class="mono">${fixed(p.lat, 5)}, ${fixed(p.lng, 5)}</span>${p.acc_m ? html` <span class="small">±${Math.round(p.acc_m)} m</span>` : ""}`;
}

function signalCell(it) {
  const c = it && isObj(it.payload.cell) ? it.payload.cell : null;
  if (!c) return "—";
  const extra = has(c.rsrp_dbm) ? html` <span class="small">${c.rsrp_dbm} dBm</span>`
    : has(c.csq) ? html` <span class="small">CSQ ${c.csq}</span>` : "";
  return html`${c.state || "—"}${extra}`;
}

function ignition(p) {
  return isObj(p.veh) && has(p.veh.ign) ? (p.veh.ign ? "On" : "Off") : "—";
}

function supply(p) {
  return isObj(p.veh) && p.veh.ext_mv ? `${fixed(p.veh.ext_mv / 1000, 1)} V` : "—";
}

// ------------------------------------------------------------------ pages
export function loginPage(error) {
  return html`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Sign in | car.mwizerwa.com</title>
<link rel="stylesheet" href="${asset("style.css")}">
</head>
<body>
<main class="login">
  <span class="brand"><span class="brand-mark" aria-hidden="true"></span>car.mwizerwa.com</span>
  <h1>Sign in</h1>
  <p class="small">Fuel and location of your vehicles.</p>
  ${error ? html`<p class="error" role="alert">${error}</p>` : ""}
  <form class="stack" method="post" action="/login">
    <label>User name <input type="text" name="username" autocomplete="username" required autofocus></label>
    <label>Password <input type="password" name="password" autocomplete="current-password" required></label>
    <div><button type="submit">Sign in</button></div>
  </form>
  <p class="small">Building an app? Read the <a href="/developers">developer guide</a>.</p>
</main>
</body>
</html>`;
}

export function indexPage(c, { rows, nOnline, mapData }) {
  const on = (d) => isOnline(d.last_seen_at, c.cfg.onlineSeconds);
  const main = html`<div class="page-head">
  <h1>Vehicles</h1>
  <p>${nOnline} of ${rows.length} reporting now. Times in ${c.cfg.displayTz}.</p>
</div>
${rows.length ? html`<div id="map" class="map" aria-label="Last known positions"></div>
<script type="application/json" id="map-data">${scriptJson(mapData)}</script>

<div class="table-wrap">
<table>
  <thead><tr>
    <th>Vehicle</th><th>Last report</th><th>Fuel</th><th>Position</th><th>Ignition</th>
    <th class="num">Supply</th><th>4G</th><th class="num">Waiting</th>
  </tr></thead>
  <tbody>
  ${rows.map(({ d, it }) => {
    const p = it ? it.payload : {};
    return html`<tr>
    <td><span class="dot${on(d) ? " on" : ""}" title="${on(d) ? "Reporting" : "Not reporting"}"></span><a href="/devices/${d.imei}">${d.name || d.imei}</a>
      <div class="small">${d.plate || "no plate"}${!d.active ? ", disabled" : ""}</div></td>
    <td class="nowrap">${ago(d.last_seen_at)}<div class="small">${fmtTime(d.last_seen_at, c.cfg.displayTz)}</div></td>
    <td>${fuelCell(it)}</td>
    <td>${posCell(it)}</td>
    <td>${ignition(p)}</td>
    <td class="num nowrap">${supply(p)}</td>
    <td class="nowrap">${signalCell(it)}</td>
    <td class="num">${isObj(p.q) && has(p.q.queued) ? p.q.queued : "—"}</td>
  </tr>`;
  })}
  </tbody>
</table>
</div>` : html`<div class="empty">No vehicles yet. <a href="/admin">Register a unit</a> with its IMEI to get its device key.</div>`}`;
  return layout(c, { title: "Vehicles", head: leafletHead, main, scripts: rows.length ? leafletScripts : "" });
}

export function devicePage(c, { d, items, latest, cals, total, mapData, nextBefore, example }) {
  const tz = c.cfg.displayTz;
  const on = isOnline(d.last_seen_at, c.cfg.onlineSeconds);
  let facts = "";
  if (latest) {
    const f = latest.derived.fuel.length ? latest.derived.fuel[0] : null;
    const p = latest.payload;
    const pos = latest.derived.position;
    facts = html`<dl class="facts">
  <div class="fact"><dt>Fuel</dt>
    <dd>${f && has(f.litres) ? html`${fixed(f.litres, 1)} L <span class="small">${fixed(f.level_pct, 0)}%</span>${gauge(f.level_pct, true)}` : html`<span class="small">${fuelCell(latest)}</span>`}</dd></div>
  <div class="fact"><dt>Position</dt>
    <dd>${pos ? html`${pos.src === "gnss" ? "GPS" : "Cell tower"}${pos.acc_m ? html` <span class="small">±${Math.round(pos.acc_m)} m</span>` : ""}` : html`<span class="small">none yet</span>`}</dd></div>
  <div class="fact"><dt>Ignition</dt>
    <dd>${ignition(p)}</dd></div>
  <div class="fact"><dt>Vehicle supply</dt>
    <dd>${supply(p)}</dd></div>
  <div class="fact"><dt>4G</dt><dd>${signalCell(latest)}</dd></div>
  <div class="fact"><dt>Readings stored</dt><dd>${total}</dd></div>
</dl>`;
  }
  const main = html`<div class="page-head">
  <h1>${d.name || "Unnamed vehicle"}</h1>
  ${d.plate ? html`<span class="plate">${d.plate}</span>` : ""}
  <p><span class="dot${on ? " on" : ""}"></span>${on ? "Reporting" : "Not reporting"}, last report ${ago(d.last_seen_at)}. IMEI <span class="mono">${d.imei}</span>${!d.active ? ". Disabled: new reports are refused" : ""}.</p>
</div>
${facts}
<div id="map" class="map" aria-label="Recent route and last position"></div>
<script type="application/json" id="map-data">${scriptJson(mapData)}</script>

<h2>Readings</h2>
${items.length ? html`<div class="table-wrap">
<table>
  <thead><tr><th>Measured</th><th>Received</th><th class="num">Seq</th><th>Fuel</th><th>Position</th><th>Ignition</th><th>4G</th><th></th></tr></thead>
  <tbody>
  ${items.map((it) => html`<tr>
    <td class="nowrap">${fmtTime(it.derived.time, tz)}${it.derived.time_src === "server" ? html` <span class="small">server</span>` : ""}</td>
    <td class="nowrap small">${fmtTime(it.received_at, tz)}</td>
    <td class="num">${it.payload.seq}</td>
    <td>${fuelCell(it)}</td>
    <td>${posCell(it)}</td>
    <td>${ignition(it.payload)}</td>
    <td class="nowrap">${signalCell(it)}</td>
    <td><a href="/readings/${it.id}">Raw</a></td>
  </tr>`)}
  </tbody>
</table>
</div>
${nextBefore ? html`<p class="pager"><a href="/devices/${d.imei}?before_id=${nextBefore}">Older readings</a></p>` : ""}`
    : html`<div class="empty">No readings yet. The unit sends to <span class="mono">/ingest</span> with its device key once it has a 4G connection.</div>`}

<div class="grid-2">
<section id="calibration">
  <h2>Fuel calibration</h2>
  ${cals.length ? html`<div class="table-wrap"><table>
    <thead><tr><th>Tank</th><th>Method</th><th class="num">Capacity</th><th class="num">Points</th><th>Saved</th><th></th></tr></thead>
    <tbody>${cals.map((cal) => html`
    <tr><td>${cal.tank}</td><td>${cal.profile.method} <span class="small">${cal.profile.model}</span></td>
      <td class="num">${cal.profile.capacity_l} L</td><td class="num">${cal.profile.table.length}</td>
      <td class="small">${fmtTime(cal.created_at, tz)}, ${cal.created_by}</td>
      <td><form class="inline" method="post" action="/devices/${d.imei}/calibration/${cal.tank}/remove">${csrfField(c)}<button class="danger" type="submit">Remove</button></form></td></tr>`)}
    </tbody>
  </table></div>` : html`<p class="small">No calibration yet, so fuel shows as raw sensor values. Fill the tank in known steps, note the raw value at each step, and save the points below.</p>`}
  <h3>Save a calibration</h3>
  <p class="small">Paste an fgt-cal/2.0 profile. Saving replaces the profile for that tank; earlier readings are recalculated.</p>
  <form class="stack" method="post" action="/devices/${d.imei}/calibration">
    ${csrfField(c)}
    <label>Profile <textarea name="profile" spellcheck="false">${example}</textarea></label>
    <div><button type="submit">Save calibration</button></div>
  </form>
</section>

<section>
  <h2>Vehicle details</h2>
  <form class="stack" method="post" action="/devices/${d.imei}/settings">
    ${csrfField(c)}
    <label>Name <input type="text" name="name" value="${d.name}" maxlength="64"></label>
    <label>Number plate <input type="text" name="plate" value="${d.plate}" maxlength="32"></label>
    <label class="check"><input type="checkbox" name="active" value="1"${d.active ? raw(" checked") : ""}> Accept reports from this unit</label>
    <div><button type="submit">Save details</button></div>
  </form>
  <h3>Device key</h3>
  <p class="small">Replace the key if a unit is lost or its key may have leaked. The unit stops reporting until its firmware has the new key.</p>
  <form method="post" action="/devices/${d.imei}/rotate-key">${csrfField(c)}<button class="danger" type="submit">Replace device key</button></form>
</section>
</div>`;
  return layout(c, { title: d.name || d.imei, head: leafletHead, main, scripts: leafletScripts });
}

export function readingPage(c, { it, rawBody }) {
  const main = html`<div class="page-head">
  <h1>Reading ${it.id}</h1>
  <p><a href="/devices/${it.device.imei}">${it.device.name || it.device.imei}</a>, sequence ${it.payload.seq}, received ${fmtTime(it.received_at, c.cfg.displayTz)}.</p>
</div>
<p>This is exactly what the API, the live stream and webhooks send for this reading.</p>
<pre class="json">${pretty(it)}</pre>
${rawBody ? html`<h2>HTTP request body as received</h2>
<p class="small">The unit's original request, which may hold several readings.</p>
<pre class="json">${rawBody}</pre>` : ""}`;
  return layout(c, { title: `Reading ${it.id}`, main });
}

export function secretPage(c, { title, secret, note, backUrl }) {
  const main = html`<h1>${title}</h1>
<p>Copy this now. It is shown only once and cannot be recovered; if it is lost, create a new one.</p>
<div class="secret">${secret}</div>
<p>${note}</p>
<p><a class="button" href="${backUrl}">Done</a></p>`;
  return layout(c, { title, main });
}

export function adminPage(c, { devices, tokens, hooks, publicUrl }) {
  const tz = c.cfg.displayTz;
  const main = html`<div class="page-head"><h1>Settings</h1><p>Units, developer access and your account.</p></div>

<h2>Vehicle units</h2>
<form class="row" method="post" action="/admin/devices">
  ${csrfField(c)}
  <label>IMEI <input type="text" name="imei" inputmode="numeric" pattern="[0-9]{14,16}" required placeholder="866123456789012"></label>
  <label>Name <input type="text" name="name" maxlength="64" placeholder="Hilux 1"></label>
  <label>Number plate <input type="text" name="plate" maxlength="32" placeholder="RAD 123 A"></label>
  <button type="submit">Register unit</button>
</form>
<p class="small">Registering shows the unit's device key once. The IMEI is printed on the 4G module, or read it with <span class="mono">AT+CGSN</span>.</p>
${devices.length ? html`<div class="table-wrap"><table>
  <thead><tr><th>Vehicle</th><th>IMEI</th><th>Registered</th><th>Last report</th><th>Status</th></tr></thead>
  <tbody>${devices.map((d) => html`
  <tr><td><a href="/devices/${d.imei}">${d.name || "Unnamed"}</a> <span class="small">${d.plate}</span></td>
    <td class="mono">${d.imei}</td><td class="small">${fmtTime(d.created_at, tz)}</td>
    <td class="small">${ago(d.last_seen_at)}</td><td>${d.active ? "Accepting reports" : "Disabled"}</td></tr>`)}
  </tbody>
</table></div>` : ""}

<div class="grid-2">
<section>
  <h2>API tokens</h2>
  <p class="small">Give each developer or app its own token, so you can revoke one without affecting the others. Tokens can read every vehicle; they cannot change anything.</p>
  <form class="row" method="post" action="/admin/tokens">
    ${csrfField(c)}
    <label>Who is it for <input type="text" name="name" maxlength="64" required placeholder="Fleet app, Jean"></label>
    <button type="submit">Create token</button>
  </form>
  ${tokens.length ? html`<div class="table-wrap"><table>
    <thead><tr><th>Name</th><th>Starts with</th><th>Last used</th><th></th></tr></thead>
    <tbody>${tokens.map((t) => html`
    <tr><td>${t.name}</td><td class="mono">${t.prefix}</td><td class="small">${ago(t.last_used_at)}</td>
      <td>${t.revoked ? html`<span class="small">Revoked</span>` : html`<form class="inline" method="post" action="/admin/tokens/${t.id}/revoke">${csrfField(c)}<button class="danger" type="submit">Revoke</button></form>`}</td></tr>`)}
    </tbody>
  </table></div>` : ""}
</section>

<section>
  <h2>Webhooks</h2>
  <p class="small">Each new reading is sent to these addresses as it arrives, signed with the webhook's secret. Failed sends are retried for about 2 hours.</p>
  <form class="row" method="post" action="/admin/webhooks">
    ${csrfField(c)}
    <label>Address <input type="url" name="url" required placeholder="https://app.example.com/fgt"></label>
    <button type="submit">Add webhook</button>
  </form>
  ${hooks.length ? html`<div class="table-wrap"><table>
    <thead><tr><th>Address</th><th class="num">Sent</th><th class="num">Waiting</th><th class="num">Gave up</th><th></th></tr></thead>
    <tbody>${hooks.map((h) => html`
    <tr><td class="mono break">${h.url}${h.last_error ? html`<div class="small">Last problem: ${h.last_error}</div>` : ""}${!h.active ? html`<div class="small">Paused</div>` : ""}</td>
      <td class="num">${h.delivered}</td><td class="num">${h.pending}</td><td class="num">${h.failed}</td>
      <td class="nowrap"><form class="inline" method="post" action="/admin/webhooks/${h.id}/toggle">${csrfField(c)}<button class="plain" type="submit">${h.active ? "Pause" : "Resume"}</button></form>
        <form class="inline" method="post" action="/admin/webhooks/${h.id}/delete">${csrfField(c)}<button class="danger" type="submit">Delete</button></form></td></tr>`)}
    </tbody>
  </table></div>` : ""}
</section>
</div>

<h2>Your password</h2>
<form class="stack" method="post" action="/admin/password">
  ${csrfField(c)}
  <label>Current password <input type="password" name="current" autocomplete="current-password" required></label>
  <label>New password, 12 characters or more <input type="password" name="new" autocomplete="new-password" minlength="12" required></label>
  <label>New password again <input type="password" name="repeat" autocomplete="new-password" minlength="12" required></label>
  <div><button type="submit">Change password</button></div>
</form>
<p class="small">Signed in as ${c.user.username}. Units post to <span class="mono">${publicUrl}/ingest</span>.</p>`;
  return layout(c, { title: "Settings", main });
}

export function developersPage(c, { publicUrl }) {
  const main = html`<div class="page-head"><h1>Developer guide</h1>
<p>Read vehicle data from ${publicUrl} to build your own app.</p></div>

<p>Every reading a vehicle sends is stored and passed on unchanged. You can fetch readings, follow them live, or have them pushed to your server. All three give the same JSON object. Ask the account owner for an API token, then send it with every request:</p>
<pre class="json">Authorization: Bearer at_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx</pre>

<h2>The reading object</h2>
<p><span class="mono">payload</span> is the reading exactly as the vehicle sent it, in the fgt/2.0 format. <span class="mono">envelope</span> holds the request-level fields (schema, imei, iccid, fw, boot). <span class="mono">derived</span> is added by the gateway: the chosen position, and litres from the tank's calibration.</p>
<pre class="json">{
  "id": 1842,
  "device": {"imei": "866123456789012", "name": "Hilux 1", "plate": "RAD 123 A"},
  "received_at": "2026-11-01T09:12:44.512Z",
  "envelope": {"schema": "fgt/2.0", "imei": "866123456789012", "iccid": "8925010000123456789",
               "fw": "3.0.0", "boot": "a1b2c3d4"},
  "payload": {"seq": 42, "ts": "2026-11-01T09:12:40Z", "ts_src": "gnss", "uptime_ms": 215004,
              "gnss": {...}, "cell": {...}, "cell_loc": null, "veh": {...}, "fuel": [...], "q": {...}},
  "derived": {
    "time": "2026-11-01T09:12:40Z", "time_src": "device",
    "position": {"lat": -1.944123, "lng": 30.061233, "src": "gnss", "acc_m": 5.5},
    "fuel": [{"tank": 1, "litres": 45.2, "level_pct": 56.5, "calibrated": true, "note": null}]
  }
}</pre>
<p><span class="mono">position.src</span> is <span class="mono">gnss</span> (satellite fix) or <span class="mono">cell</span> (cell tower, with <span class="mono">acc_m</span> often hundreds of metres). <span class="mono">position</span> is null when neither is known. <span class="mono">litres</span> is null until the tank is calibrated; <span class="mono">note</span> says why.</p>

<h2>Endpoints</h2>
<div class="table-wrap"><table>
<thead><tr><th>Request</th><th>Returns</th></tr></thead>
<tbody>
<tr><td class="mono">GET /api/v1/devices</td><td>Every vehicle with its latest reading</td></tr>
<tr><td class="mono">GET /api/v1/devices/{imei}</td><td>One vehicle with its latest reading</td></tr>
<tr><td class="mono">GET /api/v1/devices/{imei}/readings?limit=100&amp;before_id=&amp;since=&amp;until=</td><td>History, newest first. Pass <span class="mono">next_before_id</span> back as <span class="mono">before_id</span> for the next page. since and until are ISO 8601 times.</td></tr>
<tr><td class="mono">GET /api/v1/readings?after_id=0&amp;limit=500&amp;imei=</td><td>Everything in arrival order. Store <span class="mono">next_after_id</span> and call again to stay in sync.</td></tr>
<tr><td class="mono">GET /api/v1/readings/{id}</td><td>One reading</td></tr>
<tr><td class="mono">GET /api/v1/devices/{imei}/calibrations</td><td>Active calibration profile for each tank</td></tr>
<tr><td class="mono">GET /api/v1/stream?imei=&amp;after_id=</td><td>Live Server-Sent Events, one <span class="mono">reading</span> event per new reading</td></tr>
<tr><td class="mono">GET /api/v1/health</td><td>Service check, no token needed</td></tr>
</tbody></table></div>
<p>Errors return a status code with <span class="mono">{"detail": "..."}</span>: 401 for a missing or revoked token, 404 for an unknown IMEI or reading, 422 for a bad query parameter. The full schema is at <a href="/api/docs">/api/docs</a>.</p>

<h2>Follow readings live</h2>
<p>The stream sends each reading within about 3 seconds of its arrival, with its <span class="mono">id</span> as the event id. Each connection lasts about two minutes and then closes; reconnect with the <span class="mono">Last-Event-ID</span> header (browsers' EventSource does this by itself) and missed readings are replayed first, so nothing is lost. A comment line is sent every 15 seconds to keep the connection open.</p>
<pre class="json">curl -N -H "Authorization: Bearer $TOKEN" ${publicUrl}/api/v1/stream

id: 1842
event: reading
data: {"id":1842,"device":{...},"payload":{...},"derived":{...}}</pre>
<p>Browsers cannot add headers to EventSource, so a browser page may pass <span class="mono">?token=</span> instead. Only do this from your own back end; a token in a web page can be copied. For a server, polling <span class="mono">/api/v1/readings?after_id=</span> every few seconds is just as good.</p>

<h2>Receive readings by webhook</h2>
<p>The account owner can add your HTTPS address in Settings. Each new reading is POSTed to it as JSON, the same object with <span class="mono">"event": "reading.created"</span> added. Answer with any 2xx status within 10 seconds; otherwise the gateway retries with growing waits, up to 10 times. The same reading can arrive twice, and readings sent close together may arrive out of order, so use <span class="mono">id</span> to ignore repeats and to sort.</p>
<p>Check every request before trusting it. The headers are <span class="mono">X-FGT-Timestamp</span> (Unix seconds) and <span class="mono">X-FGT-Signature</span>, which is <span class="mono">sha256=</span> followed by the HMAC-SHA256 of <span class="mono">timestamp + "." + raw body</span>, keyed with the webhook secret. Reject requests whose timestamp is more than 5 minutes old.</p>
<pre class="json">import hashlib, hmac, time

def is_genuine(secret: str, timestamp: str, body: bytes, signature: str) -> bool:
    if abs(time.time() - int(timestamp)) > 300:
        return False
    mac = hmac.new(secret.encode(), timestamp.encode() + b"." + body, hashlib.sha256)
    return hmac.compare_digest("sha256=" + mac.hexdigest(), signature)</pre>

<h2>For unit firmware</h2>
<p>Units send fgt/2.0 to <span class="mono">POST ${publicUrl}/ingest</span> with their device key in the <span class="mono">X-Api-Key</span> header. The answer is <span class="mono">{"ok": true, "stored": n, "duplicates": m}</span> with status 200, including for readings already received, so the unit can clear its queue. 400 means the body was rejected and will not be accepted on retry; 401 or 403 means the key or IMEI is wrong.</p>`;
  return layout(c, { title: "Developers", main });
}
