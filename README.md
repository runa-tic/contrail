# contrail

A live flight map with a quiet interface. It uses the community ADS-B feeds (adsb.fi, with adsb.lol as fallback), which are unfiltered, so military and "blocked" aircraft show up too.

```
python server.py        # then open http://localhost:8740
```

Stdlib Python, no install. The server exists only because the feeds send no CORS headers: it proxies area queries (cached 2 s, at most 1 req/s per feed) and planespotters photo lookups (which require a User-Agent with a contact URL; set `CONTRAIL_CONTACT` to change it). `CONTRAIL_PORT` changes the port.

The map is CARTO dark-matter recoloured to neutral greys, as a globe (MapLibre 5) when zoomed out. The globe carries every aircraft from one worldwide adsb.lol snapshot, which the server refreshes once a minute because adsb.lol allows 500 calls a day per IP. Zoomed in, positions come from live adsb.fi area queries. Aircraft are dead-reckoned between polls so they glide instead of jumping. Clicking one shows its photo, its route, live stats, and a trail plus altitude history built from what the page has seen since it opened.

Routes come from adsb.lol's VRS standing data, which maps a callsign to its usual route and so knows nothing about today's diversions or reused callsigns. A route is shown only while the aircraft agrees with it. An aircraft on the ground, or low, descending and pointed at an airport, is matched against the OurAirports list (cached in `cache/`) instead, so a diversion shows up as landing at the real airport. A listing the aircraft is nowhere near is reported as unknown rather than drawn.

The night side of the globe is shaded from the sun's real elevation with a soft twilight edge, redrawn every minute.

Aircraft whose own GPS reports no usable accuracy (ADS-B v1+ with NIC and NACp both 0, or readsb's GPS-lost marker) are drawn as hollow dashed amber planes. This is jamming or spoofing, common over the Black Sea and around Kaliningrad. Their spoofed velocity is never extrapolated. When the feed carries a last good fix, the position shown is an estimate flown from it along the real heading.

Search takes a callsign, registration, hex or an airline flight number: `SU213` becomes `AFL213` via the OpenFlights airline table (cached in `cache/`, with overrides for codes it lacks). Anything not on screen can be looked up across every feed: the world snapshot first, then adsb.fi and adsb.lol.

Keys: `/` search, `Esc` close, `f` follow.
