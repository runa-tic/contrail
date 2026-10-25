"""contrail — tiny local proxy + static server for a live flight map.

The community ADS-B feeds (adsb.fi, adsb.lol) don't send CORS headers, so the
browser can't call them directly. This forwards area queries, caches them for a
couple of seconds and keeps adsb.fi under its 1 req/s limit. The zoomed-out
globe gets one worldwide snapshot from adsb.lol per minute: that API allows
500 calls a day per IP, so the cache is what keeps the globe usable all day.
Stdlib only.

    python server.py            # http://localhost:8740
"""

import gzip
import json
import os
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

PORT = int(os.environ.get("CONTRAIL_PORT", "8740"))
STATIC = os.path.join(os.path.dirname(os.path.abspath(__file__)), "static")
# planespotters rejects requests whose User-Agent carries no contact URL
UA = "contrail/0.1 (+%s)" % os.environ.get("CONTRAIL_CONTACT", "https://github.com/runa-tic")
CACHE_TTL = 2.0
MIN_GAP = 1.1  # seconds between upstream calls, per source

SOURCES = [
    ("adsb.fi", "https://opendata.adsb.fi/api/v2/lat/{lat}/lon/{lon}/dist/{dist}", "aircraft"),
    ("adsb.lol", "https://api.adsb.lol/v2/point/{lat}/{lon}/{dist}", "ac"),
]

_cache = {}
_cache_lock = threading.Lock()
_last_call = {name: 0.0 for name, _, _ in SOURCES}
_call_lock = threading.Lock()


def fetch_area(lat, lon, dist):
    key = (round(lat, 1), round(lon, 1), int(dist))
    with _cache_lock:
        hit = _cache.get(key)
        if hit and time.time() - hit[0] < CACHE_TTL:
            return dict(hit[1], age=time.time() - hit[0])

    errors = []
    for name, url, field in SOURCES:
        # Serialize upstream calls so concurrent tabs can't burst past the limit.
        with _call_lock:
            wait = MIN_GAP - (time.time() - _last_call[name])
            if wait > 0:
                time.sleep(wait)
            _last_call[name] = time.time()
            try:
                req = urllib.request.Request(
                    url.format(lat=key[0], lon=key[1], dist=key[2]),
                    headers={"User-Agent": UA, "Accept": "application/json"},
                )
                with urllib.request.urlopen(req, timeout=10) as r:
                    raw = json.load(r)
            except (urllib.error.URLError, TimeoutError, ValueError) as e:
                errors.append(f"{name}: {e}")
                continue
        payload = {"source": name, "ac": raw.get(field) or []}
        with _cache_lock:
            _cache[key] = (time.time(), payload)
            if len(_cache) > 256:
                _cache.clear()
        return dict(payload, age=0)

    raise RuntimeError("; ".join(errors) or "no source answered")


WORLD_URL = "https://api.adsb.lol/re-api/?box=-90,90,-180,180"
WORLD_TTL = 60.0
# Only what the map and the detail panel read; the raw snapshot is ~4 MB.
KEEP = ("hex", "flight", "r", "t", "desc", "lat", "lon", "alt_baro", "gs", "track",
        "true_heading", "baro_rate", "geom_rate", "squawk", "category", "seen_pos",
        "seen", "type", "dbFlags", "tas", "mag_heading", "nic", "nac_p", "version",
        "gpsOkBefore", "gpsOkLat", "gpsOkLon")

_world = {"at": 0.0, "payload": None, "backoff_until": 0.0}
_world_lock = threading.Lock()


def fetch_world():
    with _world_lock:
        now = time.time()
        stale = _world["payload"]
        if stale and now - _world["at"] < WORLD_TTL:
            return dict(stale, age=now - _world["at"])
        if now < _world["backoff_until"]:
            if stale:
                return dict(stale, age=now - _world["at"])
            raise RuntimeError("adsb.lol rate-limited, backing off")
        req = urllib.request.Request(
            WORLD_URL,
            headers={"User-Agent": UA, "Accept": "application/json", "Accept-Encoding": "gzip"},
        )
        try:
            with urllib.request.urlopen(req, timeout=30) as r:
                body = r.read()
                if r.headers.get("Content-Encoding") == "gzip":
                    body = gzip.decompress(body)
            raw = json.loads(body)
        except urllib.error.HTTPError as e:
            # 429 means the daily budget is gone; stop asking for a while.
            _world["backoff_until"] = now + (600 if e.code == 429 else 60)
            if stale:
                return dict(stale, age=now - _world["at"])
            raise RuntimeError(f"adsb.lol: {e}")
        except (urllib.error.URLError, TimeoutError, ValueError) as e:
            _world["backoff_until"] = now + 30
            if stale:
                return dict(stale, age=now - _world["at"])
            raise RuntimeError(f"adsb.lol: {e}")
        ac = [{k: a[k] for k in KEEP if k in a} for a in raw.get("aircraft") or [] if "lat" in a]
        _world.update(at=now, payload={"source": "adsb.lol world", "ac": ac})
        return dict(_world["payload"], age=0)


_photos = {}


def fetch_photo(hex_id):
    if hex_id in _photos:
        return _photos[hex_id]
    req = urllib.request.Request(
        "https://api.planespotters.net/pub/photos/hex/" + hex_id,
        headers={"User-Agent": UA, "Accept": "application/json"},
    )
    try:
        with urllib.request.urlopen(req, timeout=10) as r:
            photos = json.load(r).get("photos") or []
    except (urllib.error.URLError, TimeoutError, ValueError):
        return None  # transient: don't cache, the next click retries
    ph = photos[0] if photos else None
    result = ph and {
        "src": (ph.get("thumbnail_large") or ph.get("thumbnail") or {}).get("src"),
        "link": ph.get("link"),
        "by": ph.get("photographer"),
    }
    _photos[hex_id] = result
    return result


AIRLINES_URL = "https://raw.githubusercontent.com/jpatokal/openflights/master/data/airlines.dat"
AIRLINES_CACHE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "cache", "airlines.json")
# OpenFlights is a few years stale; codes it lacks or has wrong.
AIRLINE_OVERRIDES = {"9C": ["CQH"], "HB": ["HGB"], "RF": ["EOK"], "LJ": ["JNA"], "ZE": ["ESR"]}
_airlines = None


def airlines():
    """IATA airline code -> ICAO callsign prefixes, e.g. SU -> [AFL]."""
    global _airlines
    if _airlines is not None:
        return _airlines
    try:
        with open(AIRLINES_CACHE, encoding="utf8") as f:
            _airlines = json.load(f)
            return _airlines
    except (OSError, ValueError):
        pass
    import csv
    import io
    req = urllib.request.Request(AIRLINES_URL, headers={"User-Agent": UA})
    try:
        with urllib.request.urlopen(req, timeout=20) as r:
            rows = list(csv.reader(io.StringIO(r.read().decode("utf8"))))
    except (urllib.error.URLError, TimeoutError):
        return dict(AIRLINE_OVERRIDES)  # try the download again next time
    table = {}
    for row in rows:
        # id, name, alias, IATA, ICAO, callsign, country, active
        if len(row) > 7 and row[7] == "Y" and len(row[3]) == 2 and len(row[4]) == 3 and row[4] != "N/A":
            table.setdefault(row[3].upper(), [])
            if row[4].upper() not in table[row[3].upper()]:
                table[row[3].upper()].append(row[4].upper())
    table.update(AIRLINE_OVERRIDES)
    os.makedirs(os.path.dirname(AIRLINES_CACHE), exist_ok=True)
    with open(AIRLINES_CACHE, "w", encoding="utf8") as f:
        json.dump(table, f)
    _airlines = table
    return table


AIRPORTS_URL = "https://davidmegginson.github.io/ourairports-data/airports.csv"
AIRPORTS_CACHE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "cache", "airports.json")
_airports = None


def airports():
    """Airports with scheduled service: [iata, icao, name, city, lat, lon]."""
    global _airports
    if _airports is not None:
        return _airports
    try:
        with open(AIRPORTS_CACHE, encoding="utf8") as f:
            _airports = json.load(f)
            return _airports
    except (OSError, ValueError):
        pass
    import csv
    import io
    req = urllib.request.Request(AIRPORTS_URL, headers={"User-Agent": UA})
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            rows = csv.DictReader(io.StringIO(r.read().decode("utf8")))
            table = [
                [row["iata_code"], row["gps_code"] or row["ident"], row["name"], row["municipality"],
                 round(float(row["latitude_deg"]), 4), round(float(row["longitude_deg"]), 4)]
                for row in rows
                if row["scheduled_service"] == "yes" and row["iata_code"]
                and row["type"] in ("large_airport", "medium_airport", "small_airport")
            ]
    except (urllib.error.URLError, TimeoutError, KeyError, ValueError):
        return []  # try the download again next time
    os.makedirs(os.path.dirname(AIRPORTS_CACHE), exist_ok=True)
    with open(AIRPORTS_CACHE, "w", encoding="utf8") as f:
        json.dump(table, f, separators=(",", ":"))
    _airports = table
    return table


def _throttled_get(name, url):
    with _call_lock:
        wait = MIN_GAP - (time.time() - _last_call[name])
        if wait > 0:
            time.sleep(wait)
        _last_call[name] = time.time()
        req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": "application/json"})
        with urllib.request.urlopen(req, timeout=10) as r:
            return json.load(r)


FIND_URLS = {
    "callsign": [("adsb.fi", "https://opendata.adsb.fi/api/v2/callsign/{}"), ("adsb.lol", "https://api.adsb.lol/v2/callsign/{}")],
    "reg": [("adsb.fi", "https://opendata.adsb.fi/api/v2/registration/{}"), ("adsb.lol", "https://api.adsb.lol/v2/reg/{}")],
    "hex": [("adsb.fi", "https://opendata.adsb.fi/api/v2/hex/{}"), ("adsb.lol", "https://api.adsb.lol/v2/hex/{}")],
}


def find_aircraft(candidates):
    """Look a callsign / registration / hex up across the whole network.

    The cached world snapshot answers first and costs nothing; only a miss
    goes upstream, one candidate at a time, stopping at the first hit."""
    snap = _world["payload"]
    if snap:
        for kind, value in candidates:
            for a in snap["ac"]:
                field = {"callsign": (a.get("flight") or "").strip(), "reg": a.get("r") or "", "hex": a.get("hex") or ""}[kind]
                if field.upper() == value.upper():
                    return {"ac": [a], "source": "world snapshot", "age": time.time() - _world["at"]}
    heard = None
    for kind, value in candidates:
        for name, url in FIND_URLS[kind]:
            raw = None
            for _ in range(2):  # one retry: a failed call is usually a blip, not an answer
                try:
                    raw = _throttled_get(name, url.format(urllib.parse.quote(value)))
                    break
                except (urllib.error.URLError, TimeoutError, ValueError):
                    pass
            if raw is None:
                continue
            found = raw.get("ac") or raw.get("aircraft") or []
            ac = [a for a in found if "lat" in a]
            if ac:
                return {"ac": ac, "source": name, "age": 0, "matched": value}
            if not found:
                break  # this feed has never heard of it; its twin shares most receivers
            # Heard, but without a position (Mode S only here): the twin may have one.
            heard = heard or {"callsign": (found[0].get("flight") or "").strip(), "hex": found[0].get("hex")}
    return {"ac": [], "source": None, "age": 0, "heard": heard}


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *a, **kw):
        super().__init__(*a, directory=STATIC, **kw)

    def log_message(self, fmt, *args):
        if not self.path.startswith("/api/"):
            return
        sys.stderr.write("%s %s\n" % (time.strftime("%H:%M:%S"), fmt % args))

    def end_headers(self):
        if not self.path.startswith("/api/"):
            self.send_header("Cache-Control", "no-cache")
        super().end_headers()

    def do_GET(self):
        url = urlparse(self.path)
        if url.path.startswith("/api/photo/"):
            hex_id = url.path.rsplit("/", 1)[-1].lower()
            if not (0 < len(hex_id) <= 8 and all(c in "0123456789abcdef~" for c in hex_id)):
                return self._json(400, {"error": "bad hex"})
            return self._json(200, {"photo": fetch_photo(hex_id)})
        if url.path == "/api/airlines":
            return self._json(200, airlines())
        if url.path == "/api/airports":
            return self._json(200, airports())
        if url.path == "/api/find":
            q = parse_qs(url.query)
            candidates = []
            for kind in ("callsign", "reg", "hex"):
                for v in q.get(kind, [])[:4]:
                    v = v.strip().upper()
                    if 2 <= len(v) <= 10 and all(c.isalnum() or c in "-~" for c in v):
                        candidates.append((kind, v))
            if not candidates:
                return self._json(400, {"error": "nothing to look up"})
            return self._json(200, find_aircraft(candidates[:6]))
        if url.path == "/api/world":
            try:
                return self._json(200, fetch_world())
            except RuntimeError as e:
                return self._json(502, {"error": str(e)})
        if url.path != "/api/aircraft":
            return super().do_GET()
        q = parse_qs(url.query)
        try:
            lat = max(-90.0, min(90.0, float(q["lat"][0])))
            lon = ((float(q["lon"][0]) + 180) % 360) - 180
            dist = max(5.0, min(250.0, float(q.get("dist", ["100"])[0])))
        except (KeyError, ValueError):
            return self._json(400, {"error": "lat, lon required"})
        try:
            self._json(200, fetch_area(lat, lon, dist))
        except RuntimeError as e:
            self._json(502, {"error": str(e)})

    def _json(self, code, obj):
        body = json.dumps(obj, separators=(",", ":")).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        if len(body) > 4096 and "gzip" in self.headers.get("Accept-Encoding", ""):
            body = gzip.compress(body, compresslevel=5)
            self.send_header("Content-Encoding", "gzip")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)


if __name__ == "__main__":
    srv = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    print(f"contrail on http://localhost:{PORT}")
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass
