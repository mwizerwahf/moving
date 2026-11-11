// Draws the map from <script type="application/json" id="map-data">.
(function () {
  var el = document.getElementById("map");
  var src = document.getElementById("map-data");
  if (!el || !src || typeof L === "undefined") return;
  var data = JSON.parse(src.textContent);
  var map = L.map(el, { scrollWheelZoom: false });
  L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
  }).addTo(map);
  var bounds = [];
  if (data.track && data.track.length > 1) {
    L.polyline(data.track, { color: "#15181b", weight: 3, opacity: 0.8 }).addTo(map);
    data.track.forEach(function (p) { bounds.push(p); });
  }
  (data.points || []).forEach(function (p) {
    var colour = p.src === "gnss" ? "#7a0f14" : "#9a5b00";
    if (p.src === "cell" && p.acc) {
      L.circle([p.lat, p.lng], { radius: p.acc, color: colour, weight: 1, fillOpacity: 0.08 })
        .addTo(map);
    }
    var m = L.circleMarker([p.lat, p.lng], {
      radius: 7, color: "#ffffff", weight: 2, fillColor: colour, fillOpacity: 1
    }).addTo(map);
    var a = document.createElement("a");
    a.href = "/devices/" + encodeURIComponent(p.imei);
    a.textContent = p.label;
    var box = document.createElement("div");
    box.appendChild(a);
    var info = document.createElement("div");
    info.textContent = (p.src === "gnss" ? "GPS" : "Cell tower") +
      (p.acc ? ", about " + Math.round(p.acc) + " m" : "");
    box.appendChild(info);
    m.bindPopup(box);
    bounds.push([p.lat, p.lng]);
  });
  if (bounds.length) {
    map.fitBounds(bounds, { padding: [30, 30], maxZoom: 16 });
  } else {
    map.setView([-1.95, 30.06], 8);  // Rwanda
  }
})();
