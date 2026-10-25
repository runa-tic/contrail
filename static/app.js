'use strict';

// ---------- config ----------

const POLL_MS = 2500;
const WORLD_POLL_MS = 15000;   // the server refreshes the world snapshot once a minute
const LOCAL_MAX_NM = 250;      // beyond this radius the view switches to the world snapshot
const ICON_MIN_ZOOM = 5;       // below this, aircraft are dots
const STALE_MS = 40000;        // drop aircraft not seen for this long
const MAX_EXTRAPOLATE_S = 120; // never dead-reckon further than this
const BLEND_MS = 1200;         // ease from old to corrected position
const HIST_MAX = 600;
const DEFAULT_VIEW = { center: [114.17, 22.32], zoom: 2.2 };


const ALT_STOPS = [
  [0, '#7c7c7c'], [10000, '#a3a3a3'], [20000, '#c2c2c2'],
  [30000, '#dcdcdc'], [40000, '#f4f4f4'],
];
const GROUND_COLOR = '#555555';
const UNKNOWN_COLOR = '#8a8a8a';
const BAND_FT = 2000;
const BANDS = 23; // 0 … 44 000 ft

const CATEGORY_SIZE = { A1: 0.42, A2: 0.5, A3: 0.58, A4: 0.62, A5: 0.7, A6: 0.5, A7: 0.46, B1: 0.38, B2: 0.4 };
const EMERGENCY = { '7500': 'HIJACK', '7600': 'RADIO FAIL', '7700': 'EMERGENCY' };

// ---------- helpers ----------

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const ease = (k) => 1 - Math.pow(1 - k, 3);
const rad = (d) => (d * Math.PI) / 180;
const deg = (r) => (r * 180) / Math.PI;
const fmt = (n) => Math.round(n).toLocaleString('en-US');

function hexToRgb(h) { const n = parseInt(h.slice(1), 16); return [n >> 16, (n >> 8) & 255, n & 255]; }
function altColor(alt) {
  if (alt === 'ground') return GROUND_COLOR;
  if (typeof alt !== 'number') return UNKNOWN_COLOR;
  if (alt <= ALT_STOPS[0][0]) return ALT_STOPS[0][1];
  for (let i = 1; i < ALT_STOPS.length; i++) {
    const [a1, c1] = ALT_STOPS[i];
    if (alt <= a1) {
      const [a0, c0] = ALT_STOPS[i - 1];
      const k = (alt - a0) / (a1 - a0);
      const p = hexToRgb(c0), q = hexToRgb(c1);
      return `rgb(${p.map((v, j) => Math.round(v + (q[j] - v) * k)).join(',')})`;
    }
  }
  return ALT_STOPS[ALT_STOPS.length - 1][1];
}
function bandOf(alt) {
  if (alt === 'ground') return 'g';
  if (typeof alt !== 'number') return 'u';
  return clamp(Math.round(alt / BAND_FT), 0, BANDS - 1);
}
const iconFor = (alt) => `plane-${bandOf(alt)}`;
// per-band colours, so the per-frame loop never interpolates strings
const BAND_COLOR = { g: GROUND_COLOR, u: UNKNOWN_COLOR };
for (let i = 0; i < BANDS; i++) BAND_COLOR[i] = altColor(i * BAND_FT);

// great-circle distance in nautical miles
function nm(a, b) {
  const [lon1, lat1] = a, [lon2, lat2] = b;
  const h = Math.sin(rad(lat2 - lat1) / 2) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(rad(lon2 - lon1) / 2) ** 2;
  return 2 * 3440.065 * Math.asin(Math.min(1, Math.sqrt(h)));
}
// points along the great circle from a to b, for drawing arcs
function bearing(a, b) {
  const [l1, p1, l2, p2] = [rad(a[0]), rad(a[1]), rad(b[0]), rad(b[1])];
  const y = Math.sin(l2 - l1) * Math.cos(p2);
  const x = Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(l2 - l1);
  return (deg(Math.atan2(y, x)) + 360) % 360;
}

function arc(a, b, steps = 64) {
  const [l1, p1, l2, p2] = [rad(a[0]), rad(a[1]), rad(b[0]), rad(b[1])];
  const d = 2 * Math.asin(Math.sqrt(Math.sin((p2 - p1) / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin((l2 - l1) / 2) ** 2));
  if (d < 1e-6) return [a, b];
  const out = [];
  for (let i = 0; i <= steps; i++) {
    const f = i / steps;
    const A = Math.sin((1 - f) * d) / Math.sin(d), B = Math.sin(f * d) / Math.sin(d);
    const x = A * Math.cos(p1) * Math.cos(l1) + B * Math.cos(p2) * Math.cos(l2);
    const y = A * Math.cos(p1) * Math.sin(l1) + B * Math.cos(p2) * Math.sin(l2);
    const z = A * Math.sin(p1) + B * Math.sin(p2);
    out.push([deg(Math.atan2(y, x)), deg(Math.atan2(z, Math.hypot(x, y)))]);
  }
  // keep the line continuous across the antimeridian
  for (let i = 1; i < out.length; i++) {
    while (out[i][0] - out[i - 1][0] > 180) out[i][0] -= 360;
    while (out[i][0] - out[i - 1][0] < -180) out[i][0] += 360;
  }
  return out;
}
function cardinal(t) { return ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'][Math.round(t / 45) % 8]; }

function store(key, val) { try { localStorage.setItem(key, JSON.stringify(val)); } catch {} }
function recall(key) { try { return JSON.parse(localStorage.getItem(key)); } catch { return null; } }

// ---------- plane icons ----------

const PLANE_PATH = new Path2D('M32 3C34.5 3 35.5 6 35.5 10L35.5 24L60 36.5L60 40.5L35.5 34L35 49.5L43 55.5L43 59L32 56.5L21 59L21 55.5L29 49.5L28.5 34L4 40.5L4 36.5L28.5 24L28.5 10C28.5 6 29.5 3 32 3Z');

const GPS_BAD_COLOR = '#fbbf24';

function planeImage(color, outline) {
  const ratio = 2, size = 64 * ratio;
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d');
  g.scale(ratio, ratio);
  g.lineJoin = 'round';
  g.strokeStyle = 'rgba(5,7,10,0.85)'; g.lineWidth = 4; g.stroke(PLANE_PATH);
  if (outline) {
    // hollow, dashed: "we don't really know where this one is"
    g.fillStyle = 'rgba(5,7,10,0.55)'; g.fill(PLANE_PATH);
    g.setLineDash([5, 3]); g.strokeStyle = color; g.lineWidth = 2.2; g.stroke(PLANE_PATH);
  } else {
    g.fillStyle = color; g.fill(PLANE_PATH);
  }
  return { image: g.getImageData(0, 0, size, size), ratio };
}

function addIcons(map) {
  for (let i = 0; i < BANDS; i++) {
    const { image, ratio } = planeImage(altColor(i * BAND_FT));
    map.addImage(`plane-${i}`, image, { pixelRatio: ratio });
  }
  const g = planeImage(GROUND_COLOR); map.addImage('plane-g', g.image, { pixelRatio: g.ratio });
  const u = planeImage(UNKNOWN_COLOR); map.addImage('plane-u', u.image, { pixelRatio: u.ratio });
  const x = planeImage(GPS_BAD_COLOR, true); map.addImage('plane-gps', x.image, { pixelRatio: x.ratio });
}

// ---------- state ----------

const planes = new Map(); // hex -> plane record
let selected = null;
let following = false;
let lastOk = 0;
let lastSource = '';
let routeCache = new Map();
let photoCache = new Map();
let labelFont = ['Open Sans Regular'];

// The aircraft's own GPS says its position is worthless (jamming/spoofing): no
// integrity and no accuracy. Position, track and groundspeed are all suspect then.
// Version-0 transponders always report zero accuracy, so they say nothing here.
function gpsDegraded(a) {
  if (a.type !== 'adsb_icao') return false;
  return a.gpsOkBefore != null || (a.version >= 1 && a.nic === 0 && a.nac_p === 0);
}

function deadReckon(lon, lat, kt, heading, seconds) {
  const d = (kt * seconds) / 3600 / 60; // degrees of arc
  const tr = rad(heading);
  return [lon + (d * Math.sin(tr)) / Math.cos(rad(lat)), lat + d * Math.cos(tr)];
}

// Spoofed aircraft: estimate from the last trustworthy fix, flown along the
// real heading at true airspeed (no wind, so it drifts; capped at 30 min).
function estimateFromLastGood(p) {
  const d = p.d || {};
  if (d.gpsOkLat == null || d.gpsOkBefore == null) return null;
  const elapsed = Date.now() / 1000 - d.gpsOkBefore;
  const kt = d.tas ?? d.gs, hdg = d.true_heading ?? d.mag_heading;
  if (elapsed < 0 || elapsed > 1800 || typeof kt !== 'number' || typeof hdg !== 'number') return null;
  return deadReckon(d.gpsOkLon, d.gpsOkLat, kt, hdg, elapsed);
}

function predict(p, t) {
  if (p.gpsBad) return estimateFromLastGood(p) || [p.lon, p.lat]; // never extrapolate a spoofed velocity
  const moving = typeof p.gs === 'number' && typeof p.track === 'number' && !(p.alt === 'ground' && p.gs < 30);
  if (!moving) return [p.lon, p.lat];
  let s = clamp((t - p.fixT) / 1000, 0, MAX_EXTRAPOLATE_S);
  // a slowing aircraft (landing rollout) stops where its deceleration runs out
  const acc = p.acc || 0;
  if (acc < 0) s = Math.min(s, p.gs / -acc);
  return deadReckon(p.lon, p.lat, Math.max(0, p.gs + 0.5 * acc * s), p.track, s);
}

function displayPos(p, t) {
  const [lon, lat] = predict(p, t);
  const k = ease(clamp((t - p.offT) / BLEND_MS, 0, 1));
  return [lon + p.off[0] * (1 - k), lat + p.off[1] * (1 - k)];
}

function ingest(list, age = 0) {
  const t = performance.now();
  for (const a of list) {
    if (typeof a.lat !== 'number' || typeof a.lon !== 'number') continue;
    let p = planes.get(a.hex);
    const fixT = t - (age + (a.seen_pos ?? 0)) * 1000;
    // a cached world snapshot must not overwrite a fresher local fix
    if (p && p.fixT > fixT + 1000) { p.seen = t; continue; }
    if (!p) {
      p = { hex: a.hex, hist: [], off: [0, 0], offT: 0 };
      planes.set(a.hex, p);
      Object.assign(p, { lat: a.lat, lon: a.lon, fixT });
    } else {
      const before = displayPos(p, t);
      const dt = (fixT - p.fixT) / 1000;
      if (dt > 0.5 && typeof a.gs === 'number' && typeof p.gs === 'number') {
        // groundspeed trend in kt/s, smoothed; only deceleration is used
        const acc = clamp((a.gs - p.gs) / dt, -6, 3);
        p.acc = dt > 30 ? acc : 0.5 * (p.acc || 0) + 0.5 * acc;
      }
      Object.assign(p, { lat: a.lat, lon: a.lon, fixT, gs: a.gs, track: a.track ?? a.true_heading, alt: a.alt_baro, d: a, gpsBad: gpsDegraded(a) });
      const after = predict(p, t);
      const off = [before[0] - after[0], before[1] - after[1]];
      p.off = Math.abs(off[0]) + Math.abs(off[1]) < 0.3 ? off : [0, 0];
      p.offT = t;
    }
    p.d = a;
    p.gpsBad = gpsDegraded(a);
    p.gs = a.gs;
    // a spoofed track points wherever the fake positions drift; the heading is real
    p.track = (p.gpsBad ? a.true_heading ?? a.mag_heading : null) ?? a.track ?? a.true_heading ?? p.track;
    p.alt = a.alt_baro;
    p.seen = t;
    const last = p.hist[p.hist.length - 1];
    if (!p.gpsBad && (!last || last.lat !== a.lat || last.lon !== a.lon)) {
      p.hist.push({ t: Date.now(), lon: a.lon, lat: a.lat, alt: typeof a.alt_baro === 'number' ? a.alt_baro : 0 });
      if (p.hist.length > HIST_MAX) p.hist.shift();
    }
  }
  for (const [hex, p] of planes) {
    if (t - p.seen > STALE_MS && hex !== selected) planes.delete(hex);
  }
}

// ---------- data ----------

let inflight = false;
let worldMode = false;
let lastWorldPoll = 0;
let dataAge = 0;

function viewRadiusNm(map) {
  if (map.getZoom() < 4) return Infinity; // on the globe the bounds wrap and mean little
  const c = map.getCenter(), b = map.getBounds();
  return Math.max(nm([c.lng, c.lat], [b.getEast(), b.getNorth()]), nm([c.lng, c.lat], [b.getWest(), b.getSouth()]));
}

async function poll(map, force) {
  if (inflight || document.hidden) return;
  const r = viewRadiusNm(map);
  worldMode = r > LOCAL_MAX_NM;
  $('hint').hidden = !worldMode;
  if (worldMode && !force && Date.now() - lastWorldPoll < WORLD_POLL_MS) return;
  inflight = true;
  const c = map.getCenter();
  const url = worldMode
    ? '/api/world'
    : `/api/aircraft?lat=${c.lat.toFixed(3)}&lon=${c.lng.toFixed(3)}&dist=${clamp(Math.ceil(r), 10, LOCAL_MAX_NM)}`;
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(res.status);
    const data = await res.json();
    ingest(data.ac, data.age || 0);
    if (worldMode) lastWorldPoll = Date.now();
    lastOk = Date.now();
    dataAge = data.age || 0;
    lastSource = data.source;
    updateTrails(map);
    if (selected) renderPanel(map);
  } catch (e) {
    console.warn('poll failed', e);
  } finally {
    inflight = false;
    renderStatus();
  }
}

function renderStatus() {
  const since = Date.now() - lastOk;
  const age = since + dataAge * 1000; // how old the positions on screen really are
  const fresh = worldMode ? 90000 : 8000;
  const dot = $('liveDot');
  dot.className = 'live-dot ' + (!lastOk ? 'bad' : age < fresh ? 'ok' : age < fresh * 4 ? 'warn' : 'bad');
  $('count').textContent = fmt(planes.size);
  $('source').textContent = !lastOk ? 'no data'
    : worldMode ? `world · ${Math.round(age / 1000)}s ago`
    : age < fresh ? `live · ${lastSource}` : `${Math.round(age / 1000)}s old · ${lastSource}`;
}

async function getRoute(callsign) {
  if (!callsign || callsign.length < 3) return null;
  if (routeCache.has(callsign)) return routeCache.get(callsign);
  const pending = fetch(`https://vrs-standing-data.adsb.lol/routes/${callsign.slice(0, 2)}/${callsign}.json`)
    .then((r) => (r.ok ? r.json() : null))
    .then((j) => (j && j._airports && j._airports.length >= 2 ? j._airports : null))
    .catch(() => null);
  routeCache.set(callsign, pending);
  return pending;
}

async function getPhoto(hex) {
  if (photoCache.has(hex)) return photoCache.get(hex);
  const pending = fetch(`/api/photo/${encodeURIComponent(hex)}`)
    .then((r) => (r.ok ? r.json() : null))
    .then((j) => (j && j.photo && j.photo.src ? j.photo : null))
    .catch(() => null);
  photoCache.set(hex, pending);
  return pending;
}

let airportList = []; // [iata, icao, name, city, lat, lon], airports with scheduled service
fetch('/api/airports').then((r) => r.json()).then((j) => (airportList = j)).catch(() => {});

// Where an aircraft is landing, from where it is rather than from any schedule:
// on the ground at an airport, or low, descending and pointed at one.
function arrivalAirport(p, pos) {
  const ground = p.alt === 'ground';
  const d = p.d || {};
  const sinking = typeof p.alt === 'number' && p.alt < 5000 && (d.baro_rate ?? d.geom_rate ?? 0) < -250;
  if (p.gpsBad || (!ground && !sinking)) return null;
  const reach = ground ? 4 : 30;
  let best = null;
  for (const [iata, icao, name, , lat, lon] of airportList) {
    if (Math.abs(lat - pos[1]) > reach / 60) continue;
    const dist = nm(pos, [lon, lat]);
    if (dist > reach || (best && dist >= best.dist)) continue;
    if (!ground && dist > 3) {
      const off = Math.abs(((bearing(pos, [lon, lat]) - p.track + 540) % 360) - 180);
      if (off > 40) continue;
    }
    best = { iata, icao, name, location: name.replace(/\s+(international\s+)?airport$/i, ''), lat, lon, dist, ground };
  }
  return best;
}

// pick the leg of a (possibly multi-stop) route the aircraft is actually on
function currentLeg(airports, pos) {
  let best = null;
  for (let i = 0; i < airports.length - 1; i++) {
    const a = [airports[i].lon, airports[i].lat], b = [airports[i + 1].lon, airports[i + 1].lat];
    const da = nm(a, pos), db = nm(pos, b), total = nm(a, b);
    const excess = da + db - total;
    if (!best || excess < best.excess) best = { from: airports[i], to: airports[i + 1], da, db, total, excess };
  }
  best.plausible = best.excess < Math.max(150, best.total * 0.25);
  return best;
}

// ---------- map layers ----------

function emptyFC() { return { type: 'FeatureCollection', features: [] }; }

function addLayers(map) {
  map.addSource('trails', { type: 'geojson', data: emptyFC() });
  map.addSource('route', { type: 'geojson', data: emptyFC() });
  map.addSource('planes', { type: 'geojson', data: emptyFC() });
  map.addSource('heads', { type: 'geojson', data: emptyFC() });

  map.addLayer({
    id: 'trails', type: 'line', source: 'trails', minzoom: 5, filter: ['!', ['has', 'sel']],
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: { 'line-color': ['get', 'color'], 'line-width': ['interpolate', ['linear'], ['zoom'], 5, 0.6, 10, 1.4], 'line-opacity': 0.28 },
  });
  map.addLayer({
    id: 'trail-selected', type: 'line', source: 'trails', filter: ['has', 'sel'],
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: { 'line-color': ['get', 'color'], 'line-width': 2.4, 'line-opacity': 0.95 },
  });
  // the stretch from the last real fix to where the plane is drawn now
  map.addLayer({ ...map.getLayer('trails').serialize(), id: 'heads', source: 'heads' });
  map.addLayer({ ...map.getLayer('trail-selected').serialize(), id: 'head-selected', source: 'heads' });
  map.addLayer({
    id: 'route-ahead', type: 'line', source: 'route', filter: ['==', ['get', 'kind'], 'ahead'],
    paint: { 'line-color': '#ececec', 'line-width': 1.4, 'line-opacity': 0.45, 'line-dasharray': [2, 3] },
  });
  map.addLayer({
    id: 'route-ends', type: 'circle', source: 'route', filter: ['==', ['get', 'kind'], 'airport'],
    paint: { 'circle-radius': 4, 'circle-color': '#080808', 'circle-stroke-color': '#ececec', 'circle-stroke-width': 1.6 },
  });
  map.addLayer({
    id: 'route-labels', type: 'symbol', source: 'route', filter: ['==', ['get', 'kind'], 'airport'],
    layout: { 'text-field': ['get', 'code'], 'text-font': labelFont, 'text-size': 12, 'text-offset': [0, 1.2], 'text-anchor': 'top' },
    paint: { 'text-color': '#ececec', 'text-halo-color': '#080808', 'text-halo-width': 1.5 },
  });
  map.addLayer({
    id: 'emergency', type: 'circle', source: 'planes', filter: ['==', ['get', 'emerg'], true],
    paint: { 'circle-radius': 18, 'circle-color': 'rgba(248,113,113,0.15)', 'circle-stroke-color': '#f87171', 'circle-stroke-width': 1.5 },
  });
  map.addLayer({
    id: 'selected-halo', type: 'circle', source: 'planes', filter: ['==', ['get', 'hex'], ''],
    paint: { 'circle-radius': 20, 'circle-color': 'rgba(255,255,255,0.08)', 'circle-stroke-color': 'rgba(255,255,255,0.85)', 'circle-stroke-width': 1.2 },
  });
  // globe zoom: soft glowing dots instead of thousands of tiny planes
  map.addLayer({
    id: 'dots-glow', type: 'circle', source: 'planes', maxzoom: ICON_MIN_ZOOM,
    paint: {
      'circle-radius': ['interpolate', ['linear'], ['zoom'], 1, 3, 5, 7],
      'circle-color': ['get', 'color'], 'circle-opacity': 0.18, 'circle-blur': 1,
      'circle-pitch-alignment': 'map',
    },
  });
  map.addLayer({
    id: 'dots', type: 'circle', source: 'planes', maxzoom: ICON_MIN_ZOOM,
    paint: {
      'circle-radius': ['interpolate', ['linear'], ['zoom'], 1, 0.9, 5, 2.4],
      'circle-color': ['get', 'color'], 'circle-opacity': 0.95,
      'circle-pitch-alignment': 'map',
    },
  });
  map.addLayer({
    id: 'planes', type: 'symbol', source: 'planes', minzoom: ICON_MIN_ZOOM,
    layout: {
      'icon-image': ['get', 'icon'],
      // zoom must be the top-level input, so the per-aircraft size goes inside each stop
      'icon-size': ['interpolate', ['linear'], ['zoom'],
        3, ['*', ['get', 'size'], 0.55], 8, ['*', ['get', 'size'], 0.9], 12, ['*', ['get', 'size'], 1.25]],
      'icon-rotate': ['get', 'track'],
      'icon-rotation-alignment': 'map',
      'icon-allow-overlap': true,
      'icon-ignore-placement': true,
      'symbol-sort-key': ['get', 'z'],
    },
  });
  map.addLayer({
    id: 'labels', type: 'symbol', source: 'planes', minzoom: 7.5,
    layout: {
      'text-field': ['get', 'label'], 'text-font': labelFont, 'text-size': 10.5,
      'text-offset': [0, 1.6], 'text-anchor': 'top', 'text-letter-spacing': 0.04,
    },
    paint: { 'text-color': '#b0b0b0', 'text-halo-color': 'rgba(8,8,8,0.9)', 'text-halo-width': 1.4 },
  });
}

function updateTrails(map) {
  const features = [];
  const showAll = map.getZoom() >= 5; // the trails layer is hidden below this anyway
  for (const p of planes.values()) {
    if (!showAll || p.hist.length < 2 || p.hex === selected) continue;
    features.push({
      type: 'Feature',
      properties: { color: altColor(p.alt) },
      geometry: { type: 'LineString', coordinates: p.hist.map((h) => [h.lon, h.lat]) },
    });
  }
  // the selected aircraft gets its trail split into altitude-coloured segments
  const s = planes.get(selected);
  if (s && s.hist.length >= 2) {
    for (let i = 1; i < s.hist.length; i++) {
      features.push({
        type: 'Feature',
        properties: { color: altColor(s.hist[i].alt), sel: true },
        geometry: { type: 'LineString', coordinates: [[s.hist[i - 1].lon, s.hist[i - 1].lat], [s.hist[i].lon, s.hist[i].lat]] },
      });
    }
  }
  map.getSource('trails').setData({ type: 'FeatureCollection', features });
}

let lastFrame = 0;
function frame(map) {
  requestAnimationFrame(() => frame(map));
  const t = performance.now();
  const n = planes.size;
  // on the globe nothing visibly moves in a second; up close, glide at frame rate
  const zoom = map.getZoom();
  const interval = zoom < 3 ? 3000 : zoom < ICON_MIN_ZOOM ? 1500 : n < 700 ? 0 : n < 1600 ? 50 : 100;
  if (t - lastFrame < interval) return;
  // Backpressure: re-tiling thousands of points can outlast the interval, and a
  // new setData would abort it, so wait until the worker has caught up.
  if (!map.isSourceLoaded('planes')) return;
  lastFrame = t;

  // up close, only aircraft near the viewport are worth tiling
  let inView = null;
  if (zoom >= ICON_MIN_ZOOM) {
    const b = map.getBounds(), padLon = (b.getEast() - b.getWest()) * 0.3, padLat = (b.getNorth() - b.getSouth()) * 0.3;
    const w = b.getWest() - padLon, e = b.getEast() + padLon, s = b.getSouth() - padLat, nn = b.getNorth() + padLat;
    inView = (lon, lat) => lat >= s && lat <= nn && ((lon >= w && lon <= e) || (lon + 360 >= w && lon + 360 <= e) || (lon - 360 >= w && lon - 360 <= e));
  }

  const features = [], heads = [];
  let selPos = null;
  for (const p of planes.values()) {
    if (inView && p.hex !== selected && !inView(p.lon, p.lat)) continue;
    const pos = displayPos(p, t);
    const d = p.d || {};
    const sq = d.squawk;
    if (p.hex === selected) selPos = pos;
    features.push({
      type: 'Feature',
      properties: {
        hex: p.hex,
        icon: p.gpsBad ? 'plane-gps' : iconFor(p.alt),
        color: p.gpsBad ? GPS_BAD_COLOR : BAND_COLOR[bandOf(p.alt)],
        size: (CATEGORY_SIZE[d.category] || 0.55) * (p.alt === 'ground' ? 0.8 : 1),
        track: p.track || 0,
        label: (d.flight || d.r || '').trim(),
        emerg: !!EMERGENCY[sq],
        z: p.hex === selected ? 1e6 : typeof p.alt === 'number' ? p.alt : -1,
      },
      geometry: { type: 'Point', coordinates: pos },
    });
    const last = p.hist[p.hist.length - 1];
    if (last && !p.gpsBad && (zoom >= ICON_MIN_ZOOM || p.hex === selected)) {
      heads.push({
        type: 'Feature',
        properties: p.hex === selected ? { color: altColor(p.alt), sel: true } : { color: altColor(p.alt) },
        geometry: { type: 'LineString', coordinates: [[last.lon, last.lat], pos] },
      });
    }
  }
  map.getSource('planes').setData({ type: 'FeatureCollection', features });
  map.getSource('heads').setData({ type: 'FeatureCollection', features: heads });
  if (following && selPos) map.jumpTo({ center: selPos });
}

// ---------- detail panel ----------

let panelHex = null;

function select(map, hex, fly) {
  selected = hex;
  following = false;
  $('follow').classList.remove('on');
  map.setFilter('selected-halo', ['==', ['get', 'hex'], hex || '']);
  if (!hex) {
    $('panel').classList.remove('open');
    $('panel').setAttribute('aria-hidden', 'true');
    map.getSource('route').setData(emptyFC());
    updateTrails(map);
    panelHex = null;
    return;
  }
  const p = planes.get(hex);
  if (fly && p) {
    const wide = window.innerWidth > 640;
    map.flyTo({
      center: displayPos(p, performance.now()), zoom: Math.max(map.getZoom(), 8), speed: 1.6,
      offset: wide ? [-190, 0] : [0, -window.innerHeight * 0.25], // keep it clear of the panel
    });
  }
  $('panel').classList.add('open');
  $('panel').setAttribute('aria-hidden', 'false');
  updateTrails(map);
  renderPanel(map);
}

function cell(label, value) {
  return `<div class="cell"><div class="label">${label}</div><div class="value">${value}</div></div>`;
}

async function renderPanel(map) {
  const p = planes.get(selected);
  if (!p) return;
  const d = p.d || {};
  const hex = p.hex;
  const callsign = (d.flight || '').trim();
  const fresh = panelHex !== hex;
  panelHex = hex;

  $('pCallsign').textContent = callsign || d.r || hex.toUpperCase();
  $('pSub').textContent = [d.desc || d.t, d.r && callsign ? d.r : null].filter(Boolean).join(' · ') || 'Unknown type';

  const badges = [];
  if (d.t) badges.push(`<span class="badge">${esc(d.t)}</span>`);
  if (d.category) badges.push(`<span class="badge">CAT ${esc(d.category)}</span>`);
  if (d.dbFlags & 1) badges.push('<span class="badge mil">MILITARY</span>');
  if (String(d.type || '').startsWith('mlat')) badges.push('<span class="badge">MLAT</span>');
  if (EMERGENCY[d.squawk]) badges.push(`<span class="badge emerg">${EMERGENCY[d.squawk]} ${esc(d.squawk)}</span>`);
  if (p.gpsBad) badges.push('<span class="badge mil">GPS DEGRADED</span>');
  $('pBadges').innerHTML = badges.join('');

  const note = $('pNote');
  note.hidden = !p.gpsBad;
  if (p.gpsBad) {
    const est = estimateFromLastGood(p);
    const mins = d.gpsOkBefore != null ? Math.max(0, Math.round((Date.now() / 1000 - d.gpsOkBefore) / 60)) : null;
    note.textContent = est
      ? `Its GPS reports no usable accuracy, typical of jamming or spoofing. Shown at an estimate from its last good fix ${mins} min ago, flown along its heading; the true position may differ by miles.`
      : 'Its GPS reports no usable accuracy, typical of jamming or spoofing. The position it broadcasts, shown here, can be off by a long way, and its track and speed are unreliable.';
  }

  const alt = d.alt_baro;
  const rate = d.baro_rate ?? d.geom_rate;
  const rateHtml = typeof rate === 'number' && Math.abs(rate) > 150
    ? `<span class="${rate > 0 ? 'up' : 'down'}">${rate > 0 ? '↑' : '↓'}</span>` : '';
  const altHtml = alt === 'ground' ? 'Ground' : typeof alt === 'number' ? `${fmt(alt)}<small>ft</small> ${rateHtml}` : '—';
  const gsHtml = typeof d.gs === 'number' ? `${fmt(d.gs)}<small>kt · ${fmt(d.gs * 1.852)} km/h</small>` : '—';
  const trk = p.gpsBad ? d.true_heading ?? d.mag_heading ?? d.track : d.track ?? d.true_heading;
  const seenS = Math.round(d.seen_pos ?? d.seen ?? 0);
  $('pGrid').innerHTML = [
    cell('Altitude', altHtml),
    cell('Speed', gsHtml),
    cell(p.gpsBad ? 'Heading' : 'Track', typeof trk === 'number' ? `${Math.round(trk)}°<small>${cardinal(trk)}</small>` : '—'),
    cell('Vertical', typeof rate === 'number' ? `${rate > 0 ? '+' : ''}${fmt(rate)}<small>fpm</small>` : '—'),
    cell('Squawk', esc(d.squawk || '—')),
    cell('Registration', esc(d.r || '—')),
    cell('ICAO', esc(hex.toUpperCase())),
    cell('Last fix', `${seenS}<small>s ago · ${esc(String(d.type || '').split('_')[0] || '?')}</small>`),
  ].join('');

  renderSpark(p);
  $('globe').href = `https://globe.adsb.fi/?icao=${encodeURIComponent(hex)}`;

  if (fresh) {
    const photo = $('photo');
    photo.innerHTML = `<div class="placeholder">${esc(d.t || '')}</div>`;
    getPhoto(hex).then((ph) => {
      if (!ph || selected !== hex) return;
      const img = new Image();
      img.alt = '';
      img.onload = () => img.classList.add('loaded');
      img.src = ph.src;
      const credit = document.createElement('a');
      credit.className = 'credit';
      credit.href = ph.link;
      credit.target = '_blank';
      credit.rel = 'noopener';
      credit.textContent = `© ${ph.by} · planespotters.net`;
      photo.replaceChildren(img, credit);
    });
  }

  const listed = await getRoute(callsign);
  if (selected !== hex) return;
  const routeEl = $('pRoute');
  const pos = displayPos(p, performance.now());
  const leg = listed ? currentLeg(listed, pos) : null;
  const arrival = arrivalAirport(p, pos);
  const near = (a, b) => nm([a.lon, a.lat], [b.lon, b.lat]) < 30;
  // the listing is a callsign's usual route; trust it only while the aircraft agrees
  const trusted = leg && leg.plausible && (!arrival || near(arrival, leg.from) || near(arrival, leg.to));
  const color = altColor(alt);
  const code = (ap) => esc(ap.iata || ap.icao);
  const end = (ap, fallback) => ap
    ? `<div><div class="code">${code(ap)}</div><div class="city">${esc(ap.location || ap.name)}</div></div>`
    : `<div><div class="code faint">—</div><div class="city">${fallback}</div></div>`;
  const track = (pct) => `<div class="route-track"><div class="fill" style="width:${pct * 100}%;background:${color}"></div><div class="dot" style="left:${pct * 100}%;background:${color}"></div></div>`;
  const airport = (ap) => ({ type: 'Feature', properties: { kind: 'airport', code: ap.iata || ap.icao }, geometry: { type: 'Point', coordinates: [ap.lon, ap.lat] } });
  const ahead = (ap) => ({ type: 'Feature', properties: { kind: 'ahead' }, geometry: { type: 'LineString', coordinates: arc(pos, [ap.lon, ap.lat]) } });
  const features = [];

  if (trusted) {
    const pct = clamp(leg.da / (leg.da + leg.db), 0, 1);
    const etaMin = !p.gpsBad && typeof d.gs === 'number' && d.gs > 80 ? Math.round((leg.db / d.gs) * 60) : null;
    routeEl.innerHTML = `
      <div class="route-ends">${end(leg.from)}${end(leg.to)}</div>
      ${track(pct)}
      <div class="route-meta">
        <span>${p.gpsBad ? '~' : ''}${fmt(leg.da)} nm flown</span>
        <span>${fmt(leg.db)} nm to go${etaMin != null ? ` · ~${etaMin < 60 ? etaMin + 'm' : Math.floor(etaMin / 60) + 'h ' + (etaMin % 60) + 'm'}` : ''}</span>
      </div>`;
    // Only the way ahead is drawn as a great circle. Behind the aircraft the map
    // shows its real trail; an arc from the origin would invent a path it never flew.
    features.push(ahead(leg.to), airport(leg.from), airport(leg.to));
  } else if (arrival) {
    // landing somewhere the listing doesn't say: a diversion, or a reused callsign
    const diverted = leg && leg.plausible;
    const from = diverted ? leg.from : null;
    const pct = arrival.ground ? 1 : from ? clamp(leg.da / (leg.da + arrival.dist), 0, 1) : 0.9;
    routeEl.innerHTML = `
      <div class="route-ends">${end(from, 'origin unknown')}${end(arrival)}</div>
      ${track(pct)}
      <div class="route-meta">
        <span>${arrival.ground ? 'on the ground' : `landing · ${fmt(arrival.dist)} nm out`}</span>
        ${diverted ? `<span class="warn">listed to ${code(leg.to)}</span>`
          : leg ? `<span class="warn">not ${code(leg.from)}→${code(leg.to)}</span>` : ''}
      </div>`;
    if (!arrival.ground) features.push(ahead(arrival));
    features.push(airport(arrival));
    if (from) features.push(airport(from));
  } else if (leg) {
    routeEl.innerHTML = `
      <div class="label">Route unknown</div>
      <p class="route-unknown">${esc(callsign)} is listed as <b>${code(leg.from)} → ${code(leg.to)}</b>, but this aircraft is nowhere near that route. Airlines reuse callsigns, so the listing is probably for a different flight.</p>`;
  }
  routeEl.hidden = !(trusted || arrival || leg);
  map.getSource('route').setData({ type: 'FeatureCollection', features });
}

function renderSpark(p) {
  const svg = $('pSpark');
  const h = p.hist;
  if (h.length < 2) {
    svg.innerHTML = '<text x="0" y="34" fill="#5c5c5c" font-size="11" font-family="Geist Mono, monospace">collecting…</text>';
    return;
  }
  const t0 = h[0].t, t1 = h[h.length - 1].t || t0 + 1;
  const alts = h.map((x) => x.alt);
  const maxAlt = Math.max(...alts), minAlt = Math.min(...alts);
  const span = Math.max(2000, maxAlt - minAlt); // flat cruise stays a flat line mid-chart, not a wiggle
  const lo = Math.max(0, (maxAlt + minAlt) / 2 - span / 2 - span * 0.1), hi = lo + span * 1.2;
  const xs = (t) => ((t - t0) / Math.max(1, t1 - t0)) * 300;
  const ys = (a) => 52 - ((a - lo) / (hi - lo)) * 46;
  const pts = h.map((x) => `${xs(x.t).toFixed(1)},${ys(x.alt).toFixed(1)}`);
  svg.innerHTML = `
    <defs>
      <linearGradient id="sg" x1="0" y1="${ys(0)}" x2="0" y2="${ys(44000)}" gradientUnits="userSpaceOnUse">${ALT_STOPS.map(([a, c]) => `<stop offset="${a / 44000}" stop-color="${c}"/>`).join('')}</linearGradient>
      <linearGradient id="sf" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#f4f4f4" stop-opacity=".14"/><stop offset="1" stop-color="#f4f4f4" stop-opacity="0"/></linearGradient>
    </defs>
    <polygon points="0,56 ${pts.join(' ')} 300,56" fill="url(#sf)"/>
    <polyline points="${pts.join(' ')}" stroke="url(#sg)" stroke-width="2" fill="none" vector-effect="non-scaling-stroke"/>
    <text x="300" y="${ys(maxAlt) - 4}" text-anchor="end" fill="#8f8f8f" font-size="10" font-family="Geist Mono, monospace">${fmt(maxAlt)} ft</text>`;
}

// ---------- search ----------

let airlineCodes = {}; // IATA → ICAO callsign prefixes, e.g. SU → [AFL]
fetch('/api/airlines').then((r) => r.json()).then((j) => (airlineCodes = j)).catch(() => {});

// "SU213" / "su 0213" → ["SU213", "AFL213"]: what an airline sells is not what
// the transponder broadcasts, so a flight number has to become a callsign.
function expandQuery(raw) {
  const q = raw.toUpperCase().replace(/\s+/g, '');
  const out = [q];
  const iata = q.match(/^([A-Z0-9]{2})0*(\d{1,4}[A-Z]{0,2})$/);
  if (iata && /[A-Z]/.test(iata[1])) for (const icao of airlineCodes[iata[1]] || []) out.push(icao + iata[2]);
  const icao = q.match(/^([A-Z]{3})0+(\d{1,4}[A-Z]{0,2})$/);
  if (icao) out.push(icao[1] + icao[2]);
  return [...new Set(out)];
}

function setupSearch(map) {
  const input = $('search'), list = $('results');
  let active = 0, hits = [], world = null; // world: null | 'searching' | 'missing' | 'heard'
  let token = 0;

  function match(raw) {
    if (!raw.trim()) return [];
    const terms = expandQuery(raw).map((s) => s.toLowerCase());
    const out = [];
    for (const p of planes.values()) {
      const d = p.d || {};
      const fields = [(d.flight || '').trim(), d.r, p.hex, d.t].filter(Boolean).map((s) => s.toLowerCase());
      let score = 0;
      for (const q of terms) {
        score = Math.max(score, fields.some((f) => f === q) ? 3 : fields.some((f) => f.startsWith(q)) ? 2 : fields.some((f) => f.includes(q)) ? 1 : 0);
      }
      if (score) out.push({ p, score });
    }
    return out.sort((a, b) => b.score - a.score).slice(0, 7).map((x) => x.p);
  }

  const canSearchWorld = () => input.value.trim().length >= 3;

  function render() {
    if (!input.value.trim()) { list.hidden = true; return; }
    list.hidden = false;
    const rows = hits.map((p, i) => {
      const d = p.d || {};
      const alt = d.alt_baro === 'ground' ? 'GND' : typeof d.alt_baro === 'number' ? `${fmt(d.alt_baro)} ft` : '';
      return `<li data-hex="${esc(p.hex)}" class="${i === active ? 'active' : ''}">
        <span class="swatch" style="background:${altColor(d.alt_baro)}"></span>
        <span class="cs">${esc((d.flight || '').trim() || d.r || p.hex.toUpperCase())}</span>
        <span class="meta">${esc([d.t, d.r, alt].filter(Boolean).join(' · '))}</span></li>`;
    });
    const terms = expandQuery(input.value);
    if (world === 'searching') {
      rows.push(`<li class="empty">Searching every feed for ${esc(terms.join(' / '))}…</li>`);
    } else if (world === 'heard') {
      rows.push(`<li class="empty">${esc(terms.join(' / '))} is being heard by receivers, but none of them has a position for it yet. Try again in a minute.</li>`);
    } else if (world === 'missing') {
      rows.push(`<li class="empty">${esc(terms.join(' / '))} isn't on any feed right now. It may be on the ground with its transponder off, or outside receiver coverage.</li>`);
    } else if (canSearchWorld()) {
      rows.push(`<li data-world class="${active === hits.length ? 'active' : ''}">
        <span class="swatch world"></span><span class="cs">Search worldwide</span>
        <span class="meta">${esc(terms.join(' / '))} ↵</span></li>`);
    } else if (!hits.length) {
      rows.push('<li class="empty">Nothing in view matches</li>');
    }
    list.innerHTML = rows.join('');
  }

  function choose(hex) {
    input.value = ''; list.hidden = true; input.blur();
    select(map, hex, true);
  }

  async function searchWorld() {
    const terms = expandQuery(input.value);
    const params = new URLSearchParams();
    // most specific first: converted callsigns, then the text as typed, as a reg, as a hex
    for (const t of [...terms.slice(1), terms[0]]) params.append('callsign', t);
    params.append('reg', terms[0]);
    if (/^[0-9A-F]{6}$/.test(terms[0])) params.append('hex', terms[0]);
    const mine = ++token;
    world = 'searching'; render();
    try {
      const res = await (await fetch('/api/find?' + params)).json();
      if (mine !== token) return;
      if (res.ac && res.ac.length) {
        ingest(res.ac, res.age || 0);
        world = null;
        choose(res.ac[0].hex);
        return;
      }
      if (res.heard) { world = 'heard'; render(); return; }
    } catch {}
    if (mine !== token) return;
    world = 'missing'; render();
  }

  input.addEventListener('input', () => { token++; world = null; hits = match(input.value); active = 0; render(); });
  input.addEventListener('keydown', (e) => {
    const last = canSearchWorld() && !world ? hits.length : hits.length - 1;
    if (e.key === 'ArrowDown') { active = Math.min(active + 1, last); render(); e.preventDefault(); }
    else if (e.key === 'ArrowUp') { active = Math.max(active - 1, 0); render(); e.preventDefault(); }
    else if (e.key === 'Enter') {
      if (hits[active]) choose(hits[active].hex);
      else if (canSearchWorld() && !world) searchWorld();
    }
    else if (e.key === 'Escape') { input.value = ''; list.hidden = true; input.blur(); }
  });
  list.addEventListener('mousedown', (e) => {
    const li = e.target.closest('li[data-hex], li[data-world]');
    if (!li) return;
    e.preventDefault();
    if (li.dataset.hex) choose(li.dataset.hex);
    else searchWorld();
  });
  input.addEventListener('blur', () => setTimeout(() => { if (world !== 'searching') list.hidden = true; }, 150));
}

// ---------- boot ----------

function tuneBasemap(map) {
  const style = map.getStyle();
  for (const l of style.layers) {
    const f = l.type === 'symbol' && l.layout && l.layout['text-font'];
    if (Array.isArray(f) && !f.some((n) => /italic/i.test(n))) { labelFont = f; break; }
  }
  // strictly neutral greys: land a step above black, water black, no blue cast
  for (const l of style.layers) {
    try {
      if (l.type === 'background') map.setPaintProperty(l.id, 'background-color', '#121212');
      else if (l.type === 'fill' && /water/.test(l.id)) map.setPaintProperty(l.id, 'fill-color', '#050505');
      else if (l.type === 'fill' && /landcover|landuse|park|wood/.test(l.id)) map.setPaintProperty(l.id, 'fill-color', '#161616');
      else if (l.type === 'line' && /water|river/.test(l.id)) map.setPaintProperty(l.id, 'line-color', '#050505');
      else if (l.type === 'line' && /boundary|admin/.test(l.id)) map.setPaintProperty(l.id, 'line-color', '#333333');
      else if (l.type === 'symbol' && /place|poi|road/.test(l.id)) map.setPaintProperty(l.id, 'text-opacity', 0.55);
      if (l.type === 'symbol' && l.paint && 'text-color' in l.paint) map.setPaintProperty(l.id, 'text-color', '#8a8a8a');
    } catch {}
  }

  map.setProjection({ type: 'globe' });
  map.setSky({
    'sky-color': '#0d0d0d',
    'horizon-color': '#5a5a5a',
    'fog-color': '#121212',
    'sky-horizon-blend': 0.6,
    'horizon-fog-blend': 0.6,
    'fog-ground-blend': 0.9,
    'atmosphere-blend': ['interpolate', ['linear'], ['zoom'], 0, 1, 5, 1, 7, 0],
  });
}

// ---------- day / night terminator ----------

// The whole world in web mercator, so a mercator-projected canvas lines up with the tiles.
const WORLD_CORNERS = [[-180, 85.051129], [180, 85.051129], [180, -85.051129], [-180, -85.051129]];
const MASK_PX = 512;     // night-ness is smooth, so a coarse mask upscaled by the canvas is enough
const NIGHT_SHADE = 0.5; // how much the night side is dimmed, black over the map
const NIGHT_FADE = [5, 8]; // a globe-scale effect; gone by city zoom

// Sub-solar point from the low-precision solar ephemeris (good to ~0.1°).
function subsolar(date) {
  const d = date.getTime() / 86400000 - 10957.5; // days since J2000.0
  const g = rad((357.529 + 0.98560028 * d) % 360);
  const L = rad((280.459 + 0.98564736 * d + 1.915 * Math.sin(g) + 0.02 * Math.sin(2 * g)) % 360);
  const e = rad(23.439 - 0.00000036 * d);
  const ra = Math.atan2(Math.cos(e) * Math.sin(L), Math.cos(L));
  const dec = Math.asin(Math.sin(e) * Math.sin(L));
  const gmst = (18.697374558 + 24.06570982441908 * d) % 24;
  const lon = ((deg(ra) - gmst * 15) % 360 + 540) % 360 - 180;
  return { lat: deg(dec), lon };
}

function nightMask(date) {
  const sun = subsolar(date);
  const sd = Math.sin(rad(sun.lat)), cd = Math.cos(rad(sun.lat));
  const cosH = new Float32Array(MASK_PX);
  for (let x = 0; x < MASK_PX; x++) cosH[x] = Math.cos(rad(-180 + ((x + 0.5) / MASK_PX) * 360 - sun.lon));
  const img = new ImageData(MASK_PX, MASK_PX);
  for (let y = 0; y < MASK_PX; y++) {
    const lat = Math.atan(Math.sinh(Math.PI * (1 - (2 * (y + 0.5)) / MASK_PX)));
    const a = Math.sin(lat) * sd, b = Math.cos(lat) * cd;
    for (let x = 0; x < MASK_PX; x++) {
      const alt = deg(Math.asin(clamp(a + b * cosH[x], -1, 1))); // sun elevation, degrees
      const k = clamp((0.5 - alt) / 9, 0, 1);                     // dusk starts at sunset, full night by ~-8.5°
      img.data[(y * MASK_PX + x) * 4 + 3] = Math.round(k * k * (3 - 2 * k) * 255);
    }
  }
  const c = document.createElement('canvas');
  c.width = c.height = MASK_PX;
  c.getContext('2d').putImageData(img, 0, 0);
  return c;
}

let nightUrl = null;
async function drawNightside(map) {
  const size = 1024;
  const out = document.createElement('canvas');
  out.width = out.height = size;
  const g = out.getContext('2d');
  g.imageSmoothingEnabled = true;
  g.imageSmoothingQuality = 'high';
  g.drawImage(nightMask(new Date()), 0, 0, size, size); // black, alpha = how far into night
  const blob = await new Promise((r) => out.toBlob(r, 'image/webp', 0.9));
  if (!blob) return;
  const url = URL.createObjectURL(blob);
  const src = map.getSource('nightside');
  if (src) src.updateImage({ url, coordinates: WORLD_CORNERS });
  else {
    map.addSource('nightside', { type: 'image', url, coordinates: WORLD_CORNERS });
    // above the basemap (labels and borders dim too), below every aircraft layer
    map.addLayer({
      id: 'nightside', type: 'raster', source: 'nightside',
      paint: {
        'raster-opacity': ['interpolate', ['linear'], ['zoom'], NIGHT_FADE[0], NIGHT_SHADE, NIGHT_FADE[1], 0],
        'raster-fade-duration': 0,
      },
    }, 'trails');
  }
  if (nightUrl) setTimeout(((old) => () => URL.revokeObjectURL(old))(nightUrl), 5000);
  nightUrl = url;
}

function startTerminator(map) {
  drawNightside(map);
  setInterval(() => drawNightside(map), 60000); // the terminator moves ~0.25° a minute
}

function boot() {
  const view = recall('contrail.view') || DEFAULT_VIEW;
  const map = new maplibregl.Map({
    container: 'map',
    style: 'https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json',
    center: view.center,
    zoom: view.zoom,
    attributionControl: false,
    dragRotate: false,
    pitchWithRotate: false,
    fadeDuration: 0,
    minZoom: 1,
  });
  map.touchZoomRotate.disableRotation();
  map.addControl(new maplibregl.AttributionControl({ compact: true, customAttribution: 'Aircraft: adsb.fi / adsb.lol feeders' }), 'bottom-right');

  map.on('load', () => {
    tuneBasemap(map);
    addIcons(map);
    addLayers(map);
    startTerminator(map);
    frame(map);
    poll(map, true);
    setInterval(() => poll(map), POLL_MS);
    setInterval(renderStatus, 1000);
  });

  map.on('moveend', () => store('contrail.view', { center: map.getCenter().toArray(), zoom: map.getZoom() }));
  map.on('moveend', () => (lastFrame = 0)); // the culled set or the cadence may have changed: redraw now
  let moveTimer;
  map.on('moveend', () => { clearTimeout(moveTimer); moveTimer = setTimeout(() => poll(map), 250); });
  map.on('dragstart', () => { if (following) { following = false; $('follow').classList.remove('on'); } });

  map.on('click', (e) => {
    const hit = map.queryRenderedFeatures([[e.point.x - 8, e.point.y - 8], [e.point.x + 8, e.point.y + 8]], { layers: ['planes', 'dots'] });
    select(map, hit.length ? hit[0].properties.hex : null, map.getZoom() < ICON_MIN_ZOOM);
  });
  for (const layer of ['planes', 'dots']) {
    map.on('mouseenter', layer, () => (map.getCanvas().style.cursor = 'pointer'));
    map.on('mouseleave', layer, () => (map.getCanvas().style.cursor = ''));
  }

  $('close').onclick = () => select(map, null);
  $('follow').onclick = () => {
    following = !following;
    $('follow').classList.toggle('on', following);
    if (following) map.easeTo({ zoom: Math.max(map.getZoom(), 9), duration: 600 });
  };
  $('locate').onclick = () => {
    navigator.geolocation?.getCurrentPosition(
      (pos) => map.flyTo({ center: [pos.coords.longitude, pos.coords.latitude], zoom: 9 }),
      () => {},
      { timeout: 8000 },
    );
  };

  document.addEventListener('keydown', (e) => {
    if (e.target.tagName === 'INPUT') return;
    if (e.key === '/') { e.preventDefault(); $('search').focus(); }
    else if (e.key === 'Escape') select(map, null);
    else if (e.key === 'f' && selected) $('follow').click();
  });
  document.addEventListener('visibilitychange', () => { if (!document.hidden) poll(map); });

  setupSearch(map);
  window.contrail = { map, planes, select: (hex) => select(map, hex, true) }; // devtools handle
}

boot();
