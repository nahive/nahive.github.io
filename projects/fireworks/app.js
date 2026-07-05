// Fireworks Line-of-Sight Checker
// Terrain data: AWS Open Data terrain-tiles (Terrarium encoding), keyless.
// Pure math functions are exported so they can be unit-tested in Node
// (node test.mjs) — DOM/map code only runs in a browser.

// ===== 1. Constants =====

export const R_EARTH = 6371000;
// Standard atmospheric refraction: light bends toward the earth, effectively
// enlarging its radius. k = 1 disables refraction (for testing).
export const K_REFRACTION = 4 / 3;
export const R_EFF = K_REFRACTION * R_EARTH;

const TERRARIUM_URL = "https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png";
const SAMPLE_SPACING = 30;        // m, ≈ SRTM resolution
const MIN_SAMPLES = 32;
const MAX_SAMPLES = 2000;
const TILE_CACHE_MAX = 256;       // ≈ 64 MB of Float32 tiles
const DEG = Math.PI / 180;

// ===== 2. Geodesy =====

export function haversine(a, b) {
  const dLat = (b.lat - a.lat) * DEG, dLon = (b.lon - a.lon) * DEG;
  const s = Math.sin(dLat / 2) ** 2 +
    Math.cos(a.lat * DEG) * Math.cos(b.lat * DEG) * Math.sin(dLon / 2) ** 2;
  return 2 * R_EARTH * Math.asin(Math.min(1, Math.sqrt(s)));
}

function toVec({ lat, lon }) {
  const φ = lat * DEG, λ = lon * DEG;
  return [Math.cos(φ) * Math.cos(λ), Math.cos(φ) * Math.sin(λ), Math.sin(φ)];
}

// n+1 points along the great circle from a to b (inclusive), via slerp.
export function samplePath(a, b, n) {
  const A = toVec(a), B = toVec(b);
  const cross = [
    A[1] * B[2] - A[2] * B[1],
    A[2] * B[0] - A[0] * B[2],
    A[0] * B[1] - A[1] * B[0],
  ];
  const dot = A[0] * B[0] + A[1] * B[1] + A[2] * B[2];
  const δ = Math.atan2(Math.hypot(...cross), dot);
  const pts = [];
  for (let i = 0; i <= n; i++) {
    const f = i / n;
    let P;
    if (δ < 1e-9) {
      P = A;
    } else {
      const w0 = Math.sin((1 - f) * δ) / Math.sin(δ);
      const w1 = Math.sin(f * δ) / Math.sin(δ);
      P = [w0 * A[0] + w1 * B[0], w0 * A[1] + w1 * B[1], w0 * A[2] + w1 * B[2]];
    }
    pts.push({
      lat: Math.asin(Math.max(-1, Math.min(1, P[2]))) / DEG,
      lon: Math.atan2(P[1], P[0]) / DEG,
    });
  }
  return pts;
}

// ===== 3. Tiles: fetch, decode, cache =====

// 156543.03392 = 2π·6378137/256 — Web Mercator meters/pixel at z0.
export function pickZoom(spacingM, midLatDeg) {
  const z = Math.round(Math.log2(156543.03392 * Math.cos(midLatDeg * DEG) / spacingM));
  return Math.max(4, Math.min(12, z)); // z12 ≈ SRTM's native ~30 m (z13 helps in US-only 3DEP areas)
}

export function lonLatToGlobalPx(lat, lon, z) {
  const worldPix = 256 * 2 ** z;
  const φ = lat * DEG;
  return {
    gx: (lon + 180) / 360 * worldPix,
    gy: (1 - Math.log(Math.tan(φ) + 1 / Math.cos(φ)) / Math.PI) / 2 * worldPix,
  };
}

const tileKey = (z, x, y) => `${z}/${x}/${y}`;

// Tile keys covering the 4-pixel bilinear stencil of one point.
function stencilTileKeys(lat, lon, z) {
  const worldPix = 256 * 2 ** z;
  const { gx, gy } = lonLatToGlobalPx(lat, lon, z);
  const x0 = Math.floor(gx - 0.5), y0 = Math.floor(gy - 0.5);
  const keys = [];
  for (const px of [x0, x0 + 1]) {
    for (const py of [y0, y0 + 1]) {
      const wx = ((px % worldPix) + worldPix) % worldPix;
      const wy = Math.max(0, Math.min(worldPix - 1, py));
      keys.push(tileKey(z, Math.floor(wx / 256), Math.floor(wy / 256)));
    }
  }
  return keys;
}

function pxElev(tiles, z, px, py) {
  const worldPix = 256 * 2 ** z;
  px = ((px % worldPix) + worldPix) % worldPix;
  py = Math.max(0, Math.min(worldPix - 1, py));
  const t = tiles.get(tileKey(z, Math.floor(px / 256), Math.floor(py / 256)));
  if (!t) return NaN;
  return t[(py % 256) * 256 + (px % 256)];
}

// Bilinear elevation from decoded tiles; pixel (i,j) is a sample at its
// center (i+0.5, j+0.5). NaN if any needed tile is missing.
export function bilinearElev(tiles, z, lat, lon) {
  const { gx, gy } = lonLatToGlobalPx(lat, lon, z);
  const u = gx - 0.5, v = gy - 0.5;
  const x0 = Math.floor(u), y0 = Math.floor(v);
  const fx = u - x0, fy = v - y0;
  return pxElev(tiles, z, x0, y0) * (1 - fx) * (1 - fy) +
    pxElev(tiles, z, x0 + 1, y0) * fx * (1 - fy) +
    pxElev(tiles, z, x0, y0 + 1) * (1 - fx) * fy +
    pxElev(tiles, z, x0 + 1, y0 + 1) * fx * fy;
}

const tileCache = new Map(); // key -> Promise<Float32Array>, LRU by insertion order

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchAndDecodeTile(z, x, y, attempt = 0) {
  try {
    const url = TERRARIUM_URL.replace("{z}", z).replace("{x}", x).replace("{y}", y);
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const bmp = await createImageBitmap(await res.blob());
    const cnv = typeof OffscreenCanvas !== "undefined"
      ? new OffscreenCanvas(256, 256)
      : Object.assign(document.createElement("canvas"), { width: 256, height: 256 });
    const ctx = cnv.getContext("2d", { willReadFrequently: true });
    ctx.drawImage(bmp, 0, 0);
    bmp.close?.();
    const rgba = ctx.getImageData(0, 0, 256, 256).data;
    const out = new Float32Array(65536);
    for (let i = 0; i < 65536; i++) {
      out[i] = rgba[i * 4] * 256 + rgba[i * 4 + 1] + rgba[i * 4 + 2] / 256 - 32768;
    }
    return out;
  } catch (err) {
    if (attempt === 0) { await sleep(500); return fetchAndDecodeTile(z, x, y, 1); }
    throw err;
  }
}

function getTileBrowser(z, x, y) {
  const key = tileKey(z, x, y);
  if (tileCache.has(key)) {
    const p = tileCache.get(key);
    tileCache.delete(key); tileCache.set(key, p); // LRU refresh
    return p;
  }
  const p = fetchAndDecodeTile(z, x, y).catch((err) => {
    tileCache.delete(key); // allow retry on next recompute
    throw err;
  });
  tileCache.set(key, p);
  if (tileCache.size > TILE_CACHE_MAX) tileCache.delete(tileCache.keys().next().value);
  return p;
}

// ===== 4. LOS engine =====

// Pure verdict computation from an elevation profile. elevs has n+1 entries
// (NaN = unknown sample); d in meters; eye/burst heights in meters.
export function analyzeProfile(elevs, d, eye, burst, kRefraction = K_REFRACTION) {
  const rEff = kRefraction * R_EARTH;
  const n = elevs.length - 1;
  const xs = elevs.map((_, i) => (d * i) / n);
  // Earth-bulge correction: between the endpoints the earth's surface rises
  // above their connecting chord by x(d-x)/(2R_eff), so raise the terrain by
  // that amount and treat the sight line as a straight segment. Zero
  // correction at the endpoints.
  const adj = elevs.map((e, i) => e + (xs[i] * (d - xs[i])) / (2 * rEff));

  const hA = elevs[0] + eye;
  const hB = elevs[n] + burst;
  const mLos = (hB - hA) / d;

  let mMax = -Infinity, blockIdx = -1, hasGaps = false;
  for (let i = 1; i < n; i++) {
    if (!Number.isFinite(adj[i])) { hasGaps = true; continue; }
    const slope = (adj[i] - hA) / xs[i];
    if (slope > mMax) { mMax = slope; blockIdx = i; }
  }

  let status;
  if (!Number.isFinite(hA) || !Number.isFinite(hB) || hasGaps || mMax === -Infinity) {
    status = "indeterminate";
  } else {
    status = mLos > mMax ? "visible" : "blocked";
  }

  const minBurstAGL = Math.max(0, hA + mMax * d - elevs[n]);
  const clearance = (mLos - mMax) * d;
  return { status, d, n, xs, elevs, adj, hA, hB, mLos, mMax, blockIdx, minBurstAGL, clearance, hasGaps };
}

// Full pipeline: sample the path, fetch tiles via tileGetter, analyze.
// tileGetter(z,x,y) -> Promise<Float32Array> is injectable for testing.
// opts: { includeBuildings, buildingGetter } — buildingGetter(bbox) is
// injectable for testing (defaults to overpassGetter in the browser).
export async function computeLOS(a, b, eye, burst, tileGetter = getTileBrowser, opts = {}) {
  if (Math.abs(a.lat) > 85 || Math.abs(b.lat) > 85) return { status: "polar" };
  if (Math.abs(a.lon - b.lon) > 180) return { status: "antimeridian" };
  const d = haversine(a, b);
  if (d < 1) return { status: "same" };
  if (d < 2 * SAMPLE_SPACING) return { status: "tooClose", d };

  const n = Math.max(MIN_SAMPLES, Math.min(MAX_SAMPLES, Math.ceil(d / SAMPLE_SPACING)));
  const pts = samplePath(a, b, n);
  const z = pickZoom(d / n, (a.lat + b.lat) / 2);

  const needed = new Set();
  for (const p of pts) for (const k of stencilTileKeys(p.lat, p.lon, z)) needed.add(k);

  const keys = [...needed];
  const settled = await Promise.allSettled(
    keys.map((k) => { const [tz, tx, ty] = k.split("/").map(Number); return tileGetter(tz, tx, ty); })
  );
  const tiles = new Map();
  keys.forEach((k, i) => tiles.set(k, settled[i].status === "fulfilled" ? settled[i].value : null));

  // Clamp to sea level: terrarium encodes ocean bathymetry as negative.
  // (Below-sea-level land like Death Valley is treated as 0 too — conservative for LOS.)
  const elevs = pts.map((p) => {
    const e = bilinearElev(tiles, z, p.lat, p.lon);
    return Number.isFinite(e) ? Math.max(0, e) : NaN;
  });

  // Buildings raise the terrain (opt-in). Failures fall back to terrain-only —
  // never let a missing building set turn a verdict INDETERMINATE.
  let buildingsUsed = false;
  if (opts.includeBuildings && d <= BUILDINGS_MAX_D) {
    const buildings = await fetchBuildings(pts, opts.buildingGetter);
    if (buildings) {
      const heights = buildingHeightsForPath(pts, buildings);
      for (let i = 0; i < elevs.length; i++) {
        if (Number.isFinite(elevs[i])) elevs[i] += heights[i];
      }
      buildingsUsed = true;
    }
  }

  return { ...analyzeProfile(elevs, d, eye, burst), pts, zoom: z, buildingsUsed };
}

// ===== 4.5 Buildings: OSM heights raise terrain (pure fns + Overpass fetch) =====

const BUILDINGS_MAX_D = 40000;   // m; beyond this the bbox is too big to be worth it
const DEFAULT_LEVEL_M = 3;       // assumed storey height when only levels are tagged
const DEFAULT_BUILDING_M = 3;    // assumed height for a footprint with no height data

// Height in meters for one OSM building's tags. `height` wins (e.g. "12 m"),
// then `building:levels` × 3 m, else a small default so any footprint occludes.
export function parseBuildingHeight(tags = {}) {
  const h = parseFloat(tags.height);
  if (Number.isFinite(h) && h > 0) return h;
  const lvls = parseFloat(tags["building:levels"]);
  if (Number.isFinite(lvls) && lvls > 0) return lvls * DEFAULT_LEVEL_M;
  return DEFAULT_BUILDING_M;
}

// Ray-casting point-in-polygon. `ring` is an array of {lat, lon} (lat=y, lon=x).
export function pointInPolygon(lat, lon, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const yi = ring[i].lat, xi = ring[i].lon;
    const yj = ring[j].lat, xj = ring[j].lon;
    const intersect = (yi > lat) !== (yj > lat) &&
      lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

// For each sample, the max height of any building polygon containing it (0 if
// none). buildings: [{ ring:[{lat,lon}], height, bbox:{s,w,n,e} }].
export function buildingHeightsForPath(pts, buildings) {
  const out = new Float32Array(pts.length);
  if (!buildings || !buildings.length) return out;
  for (let i = 0; i < pts.length; i++) {
    const { lat, lon } = pts[i];
    let max = 0;
    for (const b of buildings) {
      const bb = b.bbox;
      if (lat < bb.s || lat > bb.n || lon < bb.w || lon > bb.e) continue; // cheap reject
      if (b.height > max && pointInPolygon(lat, lon, b.ring)) max = b.height;
    }
    out[i] = max;
  }
  return out;
}

const OVERPASS_ENDPOINTS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
];

// Parse an Overpass "out geom" JSON response into building polygons.
function parseOverpassBuildings(json) {
  const out = [];
  for (const el of json.elements || []) {
    if (el.type !== "way" || !el.geometry || el.geometry.length < 3) continue;
    const ring = el.geometry.map((g) => ({ lat: g.lat, lon: g.lon }));
    let s = Infinity, w = Infinity, n = -Infinity, e = -Infinity;
    for (const p of ring) {
      if (p.lat < s) s = p.lat; if (p.lat > n) n = p.lat;
      if (p.lon < w) w = p.lon; if (p.lon > e) e = p.lon;
    }
    out.push({ ring, height: parseBuildingHeight(el.tags || {}), bbox: { s, w, n, e } });
  }
  return out;
}

// Fetch all buildings in a bbox from Overpass. Throws if every mirror fails
// (so fetchBuildings can evict the cache entry and retry next recompute).
async function overpassGetter(bbox) {
  const q = `[out:json][timeout:20];way["building"](${bbox.s},${bbox.w},${bbox.n},${bbox.e});out geom;`;
  let lastErr;
  for (const url of OVERPASS_ENDPOINTS) {
    try {
      const res = await fetch(url, { method: "POST", body: "data=" + encodeURIComponent(q) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return parseOverpassBuildings(await res.json());
    } catch (err) { lastErr = err; }
  }
  throw lastErr ?? new Error("overpass unavailable");
}

// Snap a bbox outward to a coarse grid so nearby paths (drags) share one fetch.
function snapBBox({ s, w, n, e }, grid = 0.02) {
  return {
    s: Math.floor(s / grid) * grid, w: Math.floor(w / grid) * grid,
    n: Math.ceil(n / grid) * grid, e: Math.ceil(e / grid) * grid,
  };
}

const BUILDING_CACHE_MAX = 32;
const buildingCache = new Map(); // snapped-bbox key -> Promise<buildings[]|null>

// Buildings covering the path's bbox; null on failure. getter(bbox) is
// injectable (defaults to Overpass). Cached per snapped bbox, LRU, retry-on-fail.
async function fetchBuildings(pts, getter = overpassGetter) {
  let s = Infinity, w = Infinity, n = -Infinity, e = -Infinity;
  for (const p of pts) {
    if (p.lat < s) s = p.lat; if (p.lat > n) n = p.lat;
    if (p.lon < w) w = p.lon; if (p.lon > e) e = p.lon;
  }
  const bbox = snapBBox({ s, w, n, e });
  // Only the default (network) getter is cached — injected getters (tests) run
  // uncached so they stay isolated from one another.
  if (getter !== overpassGetter) {
    return Promise.resolve(getter(bbox)).catch(() => null);
  }
  const key = `${bbox.s.toFixed(3)},${bbox.w.toFixed(3)},${bbox.n.toFixed(3)},${bbox.e.toFixed(3)}`;
  if (buildingCache.has(key)) {
    const p = buildingCache.get(key);
    buildingCache.delete(key); buildingCache.set(key, p); // LRU refresh
    return p;
  }
  const p = Promise.resolve(getter(bbox)).catch(() => { buildingCache.delete(key); return null; });
  buildingCache.set(key, p);
  if (buildingCache.size > BUILDING_CACHE_MAX) buildingCache.delete(buildingCache.keys().next().value);
  return p;
}

// ===== 4.6 Geocoding (Photon, keyless) =====

const PHOTON_URL = "https://photon.komoot.io/api/";

// Search place names → [{ name, label, lat, lon, kind }]. fetchImpl is
// injectable for testing the response parsing without a network call.
export async function geocode(q, fetchImpl = fetch) {
  const query = (q || "").trim();
  if (!query) return [];
  const res = await fetchImpl(`${PHOTON_URL}?q=${encodeURIComponent(query)}&limit=5`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const json = await res.json();
  return (json.features || [])
    .map((f) => {
      const c = f.geometry && f.geometry.coordinates;
      if (!c) return null;
      const [lon, lat] = c;
      const p = f.properties || {};
      const parts = [p.name, p.city, p.state, p.country].filter(Boolean);
      return {
        name: p.name || parts[0] || `${lat.toFixed(4)}, ${lon.toFixed(4)}`,
        label: parts.join(", ") || `${lat.toFixed(4)}, ${lon.toFixed(4)}`,
        lat, lon,
        kind: p.osm_value || p.osm_key || null,
      };
    })
    .filter((r) => r && Number.isFinite(r.lat) && Number.isFinite(r.lon));
}

// ===== Browser app (map, UI, chart) =====

if (typeof window !== "undefined" && typeof document !== "undefined") initApp();

function initApp() {
  // ---- 5. Map + markers ----
  const demTiles = [TERRARIUM_URL];
  // Accents shared by both themes (pins, burst, status lines on the map) —
  // keep in sync with the CSS custom properties.
  const C = {
    ink: "#0b1026", paper: "#f0ece3", spark: "#ffb84d",
    peony: "#ff5d73", aoi: "#5b8def", leaf: "#58c99b",
  };
  // Per-theme map + chart tokens. Panel/UI colors live in CSS under [data-theme].
  const THEMES = {
    dark: {
      basemap: "https://basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png",
      hillshade: {
        "hillshade-exaggeration": 0.45, "hillshade-shadow-color": "#05070f",
        "hillshade-highlight-color": "#8fa3e8", "hillshade-accent-color": "#1d2547",
      },
      lineNeutral: "#f0ece3",
      burstComposite: "lighter", burstFourth: "#f0ece3",
      chart: {
        grid: "rgba(240,236,227,0.08)", tick: "rgba(240,236,227,0.42)",
        gradTop: "#2a3562", gradBottom: "#0e1330", ridge: "rgba(240,236,227,0.3)",
        gap: "rgba(240,236,227,0.07)",
        visible: "#58c99b", blocked: "#ff5d73", minLine: "rgba(255,184,77,0.75)",
        dotA: "#5b8def", dotB: "#ffb84d", dotOutline: "#0b1026",
        label: "rgba(240,236,227,0.75)", crosshair: "rgba(240,236,227,0.3)",
      },
    },
    light: {
      basemap: "https://basemaps.cartocdn.com/light_all/{z}/{x}/{y}.png",
      hillshade: {
        "hillshade-exaggeration": 0.25, "hillshade-shadow-color": "#8a8069",
        "hillshade-highlight-color": "#ffffff", "hillshade-accent-color": "#c9c2b2",
      },
      lineNeutral: "#1c2333",
      burstComposite: "source-over", burstFourth: "#5b8def",
      chart: {
        grid: "rgba(28,35,51,0.08)", tick: "rgba(28,35,51,0.5)",
        gradTop: "#8f9cc0", gradBottom: "#e6e9f2", ridge: "rgba(28,35,51,0.35)",
        gap: "rgba(28,35,51,0.07)",
        visible: "#178f63", blocked: "#d63d53", minLine: "rgba(181,119,8,0.8)",
        dotA: "#2f63d1", dotB: "#c77d0a", dotOutline: "#ffffff",
        label: "rgba(28,35,51,0.75)", crosshair: "rgba(28,35,51,0.3)",
      },
    },
  };
  const THEME_KEY = "fireworks-theme";
  let themeName = localStorage.getItem(THEME_KEY) ??
    (matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark");
  if (!THEMES[themeName]) themeName = "dark";
  const T = () => THEMES[themeName];
  document.documentElement.dataset.theme = themeName;

  const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)");
  const ATTRIBUTION = '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors © <a href="https://carto.com/attributions">CARTO</a> | Terrain: Mapzen/AWS';
  const style = {
    version: 8,
    sources: {
      // CARTO basemaps are keyless with attribution; plain OSM raster
      // (https://tile.openstreetmap.org/{z}/{x}/{y}.png) also works.
      basemap: {
        type: "raster",
        tiles: [T().basemap],
        tileSize: 256, maxzoom: 19,
        attribution: ATTRIBUTION,
      },
      dem: { type: "raster-dem", encoding: "terrarium", tiles: demTiles, tileSize: 256, maxzoom: 15 },
      hillshadeDem: { type: "raster-dem", encoding: "terrarium", tiles: demTiles, tileSize: 256, maxzoom: 15 },
    },
    layers: [
      { id: "basemap", type: "raster", source: "basemap" },
      { id: "hills", type: "hillshade", source: "hillshadeDem", paint: { ...T().hillshade } },
    ],
  };

  const map = new maplibregl.Map({
    container: "map",
    style,
    center: [139.75, 35.66], // Tokyo
    zoom: 9,
    attributionControl: { compact: true },
  });
  map.addControl(new maplibregl.NavigationControl(), "top-right");
  map.getCanvas().style.cursor = "crosshair";

  // drop the intro-stagger class once it has played, so verdict animations
  // (which the #panel.intro rules would out-specify) work from then on
  setTimeout(() => document.getElementById("panel").classList.remove("intro"), 1100);

  const $ = (id) => document.getElementById(id);
  const state = {
    a: null, b: null, markerA: null, markerB: null,
    mode: "fireworks", // "fireworks" | "landmark"
    searchPt: "a",     // which point a search result places
    targetName: null,  // name of the searched target (for landmark verdict copy)
  };
  let computeToken = 0;
  let lastResult = null;

  map.on("load", () => {
    map.addSource("sightline", { type: "geojson", data: emptyGeoJSON() });
    map.addLayer({
      id: "sightline", type: "line", source: "sightline",
      layout: { "line-cap": "round" },
      // [0, 2.2] with round caps renders a chain of dots — surveyor's sight line
      paint: { "line-color": C.paper, "line-opacity": 0.7, "line-width": 2.5, "line-dasharray": [0, 2.2] },
    });
    readHash();
  });

  function emptyGeoJSON() { return { type: "FeatureCollection", features: [] }; }

  // Pulsing ring at the terrain point that blocks the view (DOM marker so CSS animates it).
  let blockMarker = null;
  function setBlockPoint(lngLat) {
    if (blockMarker) { blockMarker.remove(); blockMarker = null; }
    if (!lngLat) return;
    const el = document.createElement("div");
    el.className = "block-pulse";
    blockMarker = new maplibregl.Marker({ element: el }).setLngLat(lngLat).addTo(map);
  }

  // Target glyph depends on mode: a firework spark, or a peak triangle for landmarks.
  function targetGlyph(mode) {
    return mode === "landmark"
      ? `<path d="M15 8l6.4 11.2H8.6z" fill="${C.ink}"/>`
      : `<g stroke="${C.ink}" stroke-width="2.4" stroke-linecap="round">
           <path d="M15 7.5v13M8.5 14h13M10.4 9.4l9.2 9.2M19.6 9.4l-9.2 9.2"/>
         </g>`;
  }
  function pinInnerSVG(which, mode) {
    const color = which === "a" ? C.aoi : C.spark;
    const glyph = which === "a"
      ? `<circle cx="15" cy="14" r="5" fill="${C.ink}"/><circle cx="15" cy="14" r="2" fill="${color}"/>`
      : targetGlyph(mode);
    return `<svg width="30" height="40" viewBox="0 0 30 40" xmlns="http://www.w3.org/2000/svg">
         <path d="M15 39C15 39 28 22.5 28 14A13 13 0 1 0 2 14C2 22.5 15 39 15 39Z"
               fill="${color}" stroke="${C.ink}" stroke-width="2"/>
         ${glyph}
       </svg>`;
  }
  function pinElement(which) {
    const el = document.createElement("div");
    el.className = "pin drop";
    el.innerHTML = pinInnerSVG(which, state.mode);
    el.addEventListener("animationend", () => el.classList.remove("drop"), { once: true });
    return el;
  }

  function makeMarker(which, lngLat) {
    const marker = new maplibregl.Marker({
      element: pinElement(which),
      anchor: "bottom",
      draggable: true,
    }).setLngLat(lngLat).addTo(map);
    let lastDrag = 0;
    marker.on("drag", () => {
      syncFromMarkers();
      const now = performance.now();
      if (now - lastDrag > 200) { lastDrag = now; recompute(); }
    });
    marker.on("dragend", () => { syncFromMarkers(); recompute(); });
    return marker;
  }

  function syncFromMarkers() {
    if (state.markerA) { const p = state.markerA.getLngLat(); state.a = { lat: p.lat, lon: p.lng }; }
    if (state.markerB) { const p = state.markerB.getLngLat(); state.b = { lat: p.lat, lon: p.lng }; }
    updateCoordLabels();
  }

  // Mode-dependent copy. In landmark mode the "fireworks" point becomes a generic "target".
  const targetWord = () => state.mode === "landmark" ? "target" : "fireworks";
  const startHint = () =>
    `Click the map — first the <b class="obs">observer</b>, then the <b class="fw">${targetWord()}</b>. Drag either pin to explore.`;

  map.on("click", (e) => {
    if (!state.markerA) {
      state.markerA = makeMarker("a", e.lngLat);
      $("hint").innerHTML = `Now click the <b class="fw">${targetWord()}</b> location.`;
    } else if (!state.markerB) {
      state.markerB = makeMarker("b", e.lngLat);
      state.targetName = null; // manual placement clears any searched name
      $("hint").innerHTML = "Drag either pin to explore. The verdict updates live.";
      map.getCanvas().style.cursor = "";
    } else {
      return;
    }
    syncFromMarkers();
    recompute();
  });

  // ---- 7. UI state ----

  const fmt = (v, digits = 5) => v.toFixed(digits);

  function updateCoordLabels() {
    $("coordA").textContent = state.a ? `${fmt(state.a.lat)}, ${fmt(state.a.lon)}` : "observer —";
    $("coordB").textContent = state.b
      ? (state.targetName ?? `${fmt(state.b.lat)}, ${fmt(state.b.lon)}`)
      : `${targetWord()} —`;
  }

  function getInputs() {
    const eye = Math.max(0, parseFloat($("eye").value) || 0);
    const burst = Math.max(0, parseFloat($("burst").value) || 0);
    return { eye, burst };
  }

  $("eye").addEventListener("change", recompute);
  $("burst").addEventListener("change", recompute);
  $("buildings").addEventListener("change", recompute);

  // ---- Mode toggle (Fireworks / Landmark) ----

  function setMode(name) {
    state.mode = name === "landmark" ? "landmark" : "fireworks";
    const landmark = state.mode === "landmark";
    $("modeFireworks").classList.toggle("active", !landmark);
    $("modeLandmark").classList.toggle("active", landmark);
    $("modeFireworks").setAttribute("aria-selected", String(!landmark));
    $("modeLandmark").setAttribute("aria-selected", String(landmark));
    $("title").innerHTML = landmark ? "Landmark<br>visibility" : "Fireworks<br>visibility";
    $("burstLabel").textContent = landmark ? "Target height" : "Burst altitude";
    $("burstUnit").textContent = landmark ? "m" : "m AGL";
    $("setmin").textContent = landmark ? "Set target to minimum height" : "Set burst to minimum";
    // gentle default swap between the two canonical values (0 = "see the object itself")
    if (landmark && $("burst").value === "150") $("burst").value = "0";
    if (!landmark && $("burst").value === "0") $("burst").value = "150";
    if (state.markerB) state.markerB.getElement().innerHTML = pinInnerSVG("b", state.mode);
    if (!state.markerA) $("hint").innerHTML = startHint();
    updateCoordLabels();
    writeHash();
    if (state.a && state.b) recompute();
    else if (lastResult) render(lastResult, lastResult.status);
  }
  $("modeFireworks").addEventListener("click", () => setMode("fireworks"));
  $("modeLandmark").addEventListener("click", () => setMode("landmark"));

  // ---- Place search (Photon geocoder) ----

  const searchInput = $("search");
  const resultsEl = $("results");
  const escapeHTML = (s) => String(s).replace(/[&<>"]/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  let searchTimer = 0, searchSeq = 0;

  function setSearchPt(pt) {
    state.searchPt = pt === "b" ? "b" : "a";
    $("segObs").classList.toggle("active", state.searchPt === "a");
    $("segTgt").classList.toggle("active", state.searchPt === "b");
  }
  $("segObs").addEventListener("click", () => setSearchPt("a"));
  $("segTgt").addEventListener("click", () => setSearchPt("b"));

  function hideResults() { resultsEl.classList.add("hidden"); resultsEl.innerHTML = ""; }

  function renderResults(items) {
    resultsEl.innerHTML = "";
    if (!items.length) { hideResults(); return; }
    for (const it of items) {
      const li = document.createElement("li");
      li.setAttribute("role", "option");
      li.innerHTML = `<span class="r-name">${escapeHTML(it.name)}</span>` +
        (it.label && it.label !== it.name ? `<span class="r-sub">${escapeHTML(it.label)}</span>` : "");
      li.addEventListener("click", () => placeSearchResult(it));
      resultsEl.appendChild(li);
    }
    resultsEl.classList.remove("hidden");
  }

  function placeSearchResult(it) {
    const pt = state.searchPt;
    const lngLat = [it.lon, it.lat];
    if (pt === "a") {
      if (state.markerA) state.markerA.setLngLat(lngLat);
      else state.markerA = makeMarker("a", lngLat);
    } else {
      if (state.markerB) state.markerB.setLngLat(lngLat);
      else state.markerB = makeMarker("b", lngLat);
      state.targetName = it.name;
    }
    syncFromMarkers();
    if (state.a && state.b) {
      map.fitBounds([[Math.min(state.a.lon, state.b.lon), Math.min(state.a.lat, state.b.lat)],
                     [Math.max(state.a.lon, state.b.lon), Math.max(state.a.lat, state.b.lat)]],
        { padding: 90, duration: 600 });
      map.getCanvas().style.cursor = "";
    } else {
      map.flyTo({ center: lngLat, zoom: Math.max(map.getZoom(), 10), duration: 600 });
    }
    if (pt === "a" && !state.markerB) setSearchPt("b"); // next search fills the target
    if (state.markerA && !state.markerB) $("hint").innerHTML = `Now click or search the <b class="fw">${targetWord()}</b>.`;
    else if (state.markerA && state.markerB) $("hint").innerHTML = "Drag either pin to explore. The verdict updates live.";
    hideResults();
    searchInput.value = "";
    updateCoordLabels();
    recompute();
  }

  searchInput.addEventListener("input", () => {
    const q = searchInput.value.trim();
    clearTimeout(searchTimer);
    if (q.length < 2) { hideResults(); return; }
    searchTimer = setTimeout(async () => {
      const seq = ++searchSeq;
      try {
        const items = await geocode(q);
        if (seq === searchSeq) renderResults(items);
      } catch { if (seq === searchSeq) hideResults(); }
    }, 250);
  });
  searchInput.addEventListener("keydown", (e) => {
    if (e.key === "Escape") { hideResults(); searchInput.blur(); }
  });
  document.addEventListener("click", (e) => {
    if (!searchInput.closest(".search").contains(e.target)) hideResults();
  });

  $("setmin").addEventListener("click", () => {
    if (lastResult?.status === "blocked") {
      $("burst").value = Math.ceil(lastResult.minBurstAGL + 5); // +5 m safety clearance
      recompute();
    }
  });

  $("reset").addEventListener("click", () => {
    state.markerA?.remove(); state.markerB?.remove();
    state.markerA = state.markerB = state.a = state.b = null;
    state.targetName = null;
    setSearchPt("a");
    lastResult = null;
    map.getSource("sightline")?.setData(emptyGeoJSON());
    setBlockPoint(null);
    $("verdict").className = "verdict hidden";
    $("setmin").classList.add("hidden");
    $("distance").textContent = "";
    $("profileWrap").classList.add("hidden");
    $("hint").innerHTML = startHint();
    map.getCanvas().style.cursor = "crosshair";
    updateCoordLabels();
    writeHash();
  });

  const themeBtn = $("themeToggle");
  function syncThemeButton() {
    themeBtn.textContent = themeName === "dark" ? "☀" : "☾";
    themeBtn.setAttribute("aria-label",
      themeName === "dark" ? "Switch to light mode" : "Switch to dark mode");
  }
  syncThemeButton();

  function setTheme(name) {
    themeName = name;
    localStorage.setItem(THEME_KEY, name);
    document.documentElement.dataset.theme = name;
    syncThemeButton();
    const src = map.getSource("basemap");
    if (!src) { map.once("load", () => setTheme(themeName)); return; }
    if (src.setTiles) {
      src.setTiles([T().basemap]);
    } else {
      // older MapLibre without RasterTileSource.setTiles: rebuild the layer
      map.removeLayer("basemap"); map.removeSource("basemap");
      map.addSource("basemap", {
        type: "raster", tiles: [T().basemap], tileSize: 256, maxzoom: 19, attribution: ATTRIBUTION,
      });
      map.addLayer({ id: "basemap", type: "raster", source: "basemap" }, "hills");
    }
    for (const [k, v] of Object.entries(T().hillshade)) map.setPaintProperty("hills", k, v);
    if (lastResult) {
      updateMapOverlays(lastResult);
      if (lastResult.adj) drawProfile(lastResult);
    }
  }
  themeBtn.addEventListener("click", () => setTheme(themeName === "dark" ? "light" : "dark"));

  $("terrain3d").addEventListener("change", (e) => {
    if (e.target.checked) {
      map.setTerrain({ source: "dem", exaggeration: 1.0 });
      map.easeTo({ pitch: 60, duration: 600 });
    } else {
      map.setTerrain(null);
      map.easeTo({ pitch: 0, duration: 600 });
    }
    writeHash();
  });

  // ---- URL hash sharing ----

  function writeHash() {
    const p = new URLSearchParams();
    if (state.a) p.set("a", `${fmt(state.a.lat)},${fmt(state.a.lon)}`);
    if (state.b) p.set("b", `${fmt(state.b.lat)},${fmt(state.b.lon)}`);
    const { eye, burst } = getInputs();
    p.set("eye", eye); p.set("burst", burst);
    if ($("terrain3d").checked) p.set("terrain", "1");
    if ($("buildings").checked) p.set("bld", "1");
    if (state.mode === "landmark") p.set("mode", "landmark");
    if (state.targetName) p.set("name", state.targetName);
    history.replaceState(null, "", "#" + p.toString());
  }

  function readHash() {
    const p = new URLSearchParams(location.hash.slice(1));
    const parsePt = (s) => {
      const [lat, lon] = (s || "").split(",").map(parseFloat);
      return Number.isFinite(lat) && Number.isFinite(lon) ? { lat, lon } : null;
    };
    const a = parsePt(p.get("a")), b = parsePt(p.get("b"));
    if (p.get("eye")) $("eye").value = p.get("eye");
    if (p.get("burst")) $("burst").value = p.get("burst");
    if (p.get("bld") === "1") $("buildings").checked = true;
    if (p.get("mode") === "landmark") setMode("landmark"); // before markers, so the target pin glyph is right
    if (p.get("terrain") === "1") {
      $("terrain3d").checked = true;
      map.setTerrain({ source: "dem", exaggeration: 1.0 });
      map.setPitch(60);
    }
    if (a && b) {
      state.a = a; state.b = b;
      if (p.get("name")) state.targetName = p.get("name");
      state.markerA = makeMarker("a", [a.lon, a.lat]);
      state.markerB = makeMarker("b", [b.lon, b.lat]);
      $("hint").innerHTML = "Drag either pin to explore. The verdict updates live.";
      map.getCanvas().style.cursor = "";
      map.fitBounds([[Math.min(a.lon, b.lon), Math.min(a.lat, b.lat)],
                     [Math.max(a.lon, b.lon), Math.max(a.lat, b.lat)]], { padding: 90, duration: 0 });
      updateCoordLabels();
      recompute();
    }
  }

  // ---- Recompute + verdict ----

  const kmFmt = (m) => m >= 10000 ? (m / 1000).toFixed(1) + " km"
    : m >= 1000 ? (m / 1000).toFixed(2) + " km" : Math.round(m) + " m";

  function setVerdict(cls, html) {
    const v = $("verdict");
    v.className = "verdict hidden";
    void v.offsetWidth; // reflow so the pop animation replays on every new verdict
    v.className = "verdict " + cls;
    v.innerHTML = html;
  }

  async function recompute() {
    writeHash();
    if (!state.a || !state.b) return;
    const token = ++computeToken;
    const { eye, burst } = getInputs();

    // keep the current verdict on screen during quick recomputes (drags);
    // only show the computing state when there's nothing to show yet
    if (!lastResult) setVerdict("computing", "Computing…");
    $("setmin").classList.add("hidden");

    let res;
    try {
      res = await computeLOS(state.a, state.b, eye, burst, undefined,
        { includeBuildings: $("buildings").checked });
    } catch (err) {
      res = { status: "indeterminate", error: String(err) };
    }
    if (token !== computeToken) return; // stale
    const prevStatus = lastResult?.status;
    lastResult = res;
    render(res, prevStatus);
  }

  function render(res, prevStatus) {
    const longNote = res.d > 300000 ? "<small>⚠ results approximate at this range</small>" : "";
    const bNote = $("buildings").checked
      ? (res.buildingsUsed ? '<small class="bnote">🏢 buildings included</small>'
                           : '<small class="bnote">buildings not applied — terrain only</small>')
      : "";
    $("distance").textContent = res.d ? `distance ${kmFmt(res.d)}` : "";

    // simple statuses without a profile
    if (res.status === "same") { setVerdict("indeterminate", "Move a marker — both points are the same spot."); return; }
    if (res.status === "polar") { setVerdict("indeterminate", "Latitudes beyond ±85° aren't supported."); return; }
    if (res.status === "antimeridian") { setVerdict("indeterminate", "Paths crossing the antimeridian aren't supported."); return; }
    if (res.status === "tooClose") {
      setVerdict("visible", `VISIBLE<small>Points are ${Math.round(res.d)} m apart — too close for terrain to matter.</small>`);
      updateMapOverlays(res); $("profileWrap").classList.add("hidden");
      return;
    }

    const landmark = state.mode === "landmark";
    const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
    const tName = state.targetName || (landmark ? "the target" : "the fireworks");

    if (res.status === "visible") {
      const body = landmark
        ? `${cap(tName)} is in view — the sight line clears terrain by ${Math.round(res.clearance)} m at the tightest point.`
        : `Sight line clears terrain by ${Math.round(res.clearance)} m at the tightest point.`;
      setVerdict("visible", `VISIBLE<small>${body}${longNote}</small>${bNote}`);
      if (prevStatus !== "visible" && state.b) fireworkBurst([state.b.lon, state.b.lat]);
    } else if (res.status === "blocked") {
      const bp = res.pts[res.blockIdx];
      const where = `terrain at ${kmFmt(res.xs[res.blockIdx])} from the observer (${bp.lat.toFixed(4)}, ${bp.lon.toFixed(4)})`;
      const body = landmark
        ? `${cap(tName)} is hidden — ${where} blocks the view.<br>` +
          `The target would need to rise <b>${Math.ceil(res.minBurstAGL)} m</b> above the ground to clear it.`
        : `Terrain at ${kmFmt(res.xs[res.blockIdx])} from the observer ` +
          `(${bp.lat.toFixed(4)}, ${bp.lon.toFixed(4)}) blocks the view.<br>` +
          `Minimum burst altitude to be visible: <b>${Math.ceil(res.minBurstAGL)} m AGL</b>.`;
      setVerdict("blocked", `BLOCKED<small>${body}${longNote}</small>${bNote}`);
      $("setmin").classList.remove("hidden");
    } else {
      setVerdict("indeterminate",
        `INDETERMINATE<small>Some elevation tiles failed to load` +
        (res.error ? ` (${res.error})` : "") +
        `. Nudge a marker or change an input to retry.</small>`);
    }

    updateMapOverlays(res);
    if (res.adj) {
      $("profileWrap").classList.remove("hidden");
      drawProfile(res);
    }
  }

  function updateMapOverlays(res) {
    const coords = res.pts
      ? res.pts.map((p) => [p.lon, p.lat])
      : [[state.a.lon, state.a.lat], [state.b.lon, state.b.lat]];
    map.getSource("sightline")?.setData({
      type: "Feature", geometry: { type: "LineString", coordinates: coords },
    });
    const lineColor = res.status === "blocked" ? C.peony
      : res.status === "visible" || res.status === "tooClose" ? C.leaf : T().lineNeutral;
    map.setPaintProperty("sightline", "line-color", lineColor);
    map.setPaintProperty("sightline", "line-opacity", res.status === "indeterminate" ? 0.45 : 0.9);
    setBlockPoint(res.status === "blocked" && res.blockIdx >= 0
      ? [res.pts[res.blockIdx].lon, res.pts[res.blockIdx].lat] : null);
  }

  // ---- Firework burst (plays once when a verdict turns VISIBLE) ----

  const fx = $("fx");
  let fxRaf = 0;

  function fireworkBurst(lngLat) {
    if (reducedMotion.matches) return;
    const dpr = window.devicePixelRatio || 1;
    fx.width = fx.clientWidth * dpr;
    fx.height = fx.clientHeight * dpr;
    const ctx = fx.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    const p = map.project(lngLat);
    const ox = p.x, oy = p.y - 52; // burst above the pin, roughly at "altitude"
    // 'lighter' additive glow reads on the dark map; on light it washes out,
    // so the theme supplies plain compositing and a cool fourth spark color
    const composite = T().burstComposite;
    const colors = [C.spark, "#ffd98a", C.peony, T().burstFourth];
    // physics in wall-clock seconds — display refresh rate must not change speed
    const GRAVITY = 160;          // px/s²
    const DRAG = 0.4;             // fraction of velocity lost per second
    const RING_LIFE = 0.65;       // s
    const parts = [];
    for (let i = 0; i < 90; i++) {
      const ang = (i / 90) * Math.PI * 2 + Math.random() * 0.12;
      const speed = 70 + Math.random() * 200; // px/s
      parts.push({
        x: ox, y: oy,
        vx: Math.cos(ang) * speed, vy: Math.sin(ang) * speed,
        life: 0.9 + Math.random() * 0.7, age: 0, // s
        color: colors[(Math.random() * colors.length) | 0],
        r: 1 + Math.random() * 1.6,
      });
    }

    cancelAnimationFrame(fxRaf);
    let ringAge = 0;
    let last = performance.now();
    (function frame(now) {
      const dt = Math.min(0.04, (now - last) / 1000); // clamp long/zero frames
      last = now;
      ctx.clearRect(0, 0, fx.clientWidth, fx.clientHeight);
      ctx.globalCompositeOperation = composite;
      let alive = false;

      if (ringAge < RING_LIFE) {
        ringAge += dt;
        const rt = ringAge / RING_LIFE;
        ctx.strokeStyle = `rgba(255, 217, 138, ${0.5 * (1 - rt)})`;
        ctx.lineWidth = 1.5;
        ctx.beginPath(); ctx.arc(ox, oy, 6 + rt * 95, 0, Math.PI * 2); ctx.stroke();
        alive = true;
      }
      const drag = Math.exp(-DRAG * dt);
      for (const q of parts) {
        if (q.age >= q.life) continue;
        alive = true;
        q.age += dt;
        q.vy += GRAVITY * dt;
        q.vx *= drag; q.vy *= drag;
        q.x += q.vx * dt; q.y += q.vy * dt;
        const t = Math.max(0, 1 - q.age / q.life);
        const twinkle = 0.7 + 0.3 * Math.sin(q.age * 36 + q.r * 7);
        ctx.globalAlpha = t * twinkle;
        ctx.fillStyle = q.color;
        ctx.beginPath(); ctx.arc(q.x, q.y, q.r * (0.5 + t * 0.7), 0, Math.PI * 2); ctx.fill();
      }
      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = "source-over";
      if (alive) fxRaf = requestAnimationFrame(frame);
      else ctx.clearRect(0, 0, fx.clientWidth, fx.clientHeight);
    })(last);
  }

  // Console helper: fire a test burst at the fireworks pin (or given [lon, lat])
  window.debugBurst = (lngLat) =>
    fireworkBurst(lngLat ?? (state.b ? [state.b.lon, state.b.lat] : map.getCenter()));

  // ---- 6. Profile chart ----

  const canvas = $("profile");
  const tip = $("profileTip");
  let hoverIdx = -1;

  function drawProfile(res) {
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth, h = canvas.clientHeight;
    if (canvas.width !== w * dpr || canvas.height !== h * dpr) {
      canvas.width = w * dpr; canvas.height = h * dpr;
    }
    const ctx = canvas.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    const ML = 48, MR = 14, MT = 12, MB = 20;
    const pw = w - ML - MR, ph = h - MT - MB;

    const finite = res.adj.filter(Number.isFinite);
    let yMin = Math.min(...finite, res.hA, res.hB, 0);
    let yMax = Math.max(...finite, res.hA, res.hB);
    if (!Number.isFinite(yMin)) yMin = 0;
    if (!Number.isFinite(yMax) || yMax === yMin) yMax = yMin + 10;
    const pad = (yMax - yMin) * 0.12;
    yMin -= pad * 0.4; yMax += pad;

    const X = (m) => ML + (m / res.d) * pw;
    const Y = (e) => MT + ph - ((e - yMin) / (yMax - yMin)) * ph;

    // axes + gridlines
    const TC = T().chart;
    const MONO = '10px "IBM Plex Mono", monospace';
    ctx.font = MONO;
    ctx.fillStyle = TC.tick;
    ctx.strokeStyle = TC.grid; ctx.lineWidth = 1;
    const ySteps = niceTicks(yMin, yMax, 4);
    for (const t of ySteps) {
      const y = Y(t);
      if (y < MT - 1 || y > MT + ph + 1) continue;
      ctx.beginPath(); ctx.moveTo(ML, y); ctx.lineTo(w - MR, y); ctx.stroke();
      ctx.textAlign = "right"; ctx.textBaseline = "middle";
      ctx.fillText(Math.round(t) + " m", ML - 6, y);
    }
    const xSteps = niceTicks(0, res.d / 1000, 6);
    ctx.textAlign = "center"; ctx.textBaseline = "top";
    for (const t of xSteps) {
      const x = X(t * 1000);
      if (x < ML - 1 || x > w - MR + 1) continue;
      ctx.fillText(t + " km", x, MT + ph + 5);
    }

    // terrain silhouette: indigo gradient fill + faint ridge line;
    // NaN runs (failed tiles) become dim bands
    const grad = ctx.createLinearGradient(0, MT, 0, MT + ph);
    grad.addColorStop(0, TC.gradTop);
    grad.addColorStop(1, TC.gradBottom);
    let i = 0;
    while (i <= res.n) {
      if (!Number.isFinite(res.adj[i])) {
        let j = i;
        while (j <= res.n && !Number.isFinite(res.adj[j])) j++;
        ctx.fillStyle = TC.gap;
        ctx.fillRect(X(res.xs[Math.max(0, i - 1)]), MT, X(res.xs[Math.min(res.n, j)]) - X(res.xs[Math.max(0, i - 1)]), ph);
        i = j;
        continue;
      }
      let j = i;
      const ridge = new Path2D();
      ridge.moveTo(X(res.xs[i]), Y(Math.max(yMin, res.adj[i])));
      while (j + 1 <= res.n && Number.isFinite(res.adj[j + 1])) {
        j++;
        ridge.lineTo(X(res.xs[j]), Y(res.adj[j]));
      }
      const fill = new Path2D(ridge);
      fill.lineTo(X(res.xs[j]), MT + ph);
      fill.lineTo(X(res.xs[i]), MT + ph);
      fill.closePath();
      ctx.fillStyle = grad;
      ctx.fill(fill);
      ctx.strokeStyle = TC.ridge; ctx.lineWidth = 1;
      ctx.stroke(ridge);
      i = j + 1;
    }

    // sight + threshold lines stay inside the plot area
    ctx.save();
    ctx.beginPath(); ctx.rect(ML, MT, pw, ph); ctx.clip();

    // sight line A -> B, glowing
    if (Number.isFinite(res.hA) && Number.isFinite(res.hB)) {
      const lc = res.status === "blocked" ? TC.blocked : TC.visible;
      ctx.save();
      ctx.strokeStyle = lc; ctx.lineWidth = 2;
      ctx.shadowColor = lc; ctx.shadowBlur = 8;
      ctx.beginPath(); ctx.moveTo(X(0), Y(res.hA)); ctx.lineTo(X(res.d), Y(res.hB)); ctx.stroke();
      ctx.restore();
    }

    // dashed minimum-visible line + blocking dot
    if (res.status === "blocked") {
      ctx.strokeStyle = TC.minLine; ctx.lineWidth = 1.5; ctx.setLineDash([5, 4]);
      ctx.beginPath(); ctx.moveTo(X(0), Y(res.hA)); ctx.lineTo(X(res.d), Y(res.hA + res.mMax * res.d)); ctx.stroke();
      ctx.setLineDash([]);
      ctx.save();
      ctx.fillStyle = TC.blocked; ctx.shadowColor = TC.blocked; ctx.shadowBlur = 10;
      ctx.beginPath(); ctx.arc(X(res.xs[res.blockIdx]), Y(res.adj[res.blockIdx]), 4.5, 0, Math.PI * 2); ctx.fill();
      ctx.restore();
      ctx.strokeStyle = TC.dotOutline; ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.arc(X(res.xs[res.blockIdx]), Y(res.adj[res.blockIdx]), 4.5, 0, Math.PI * 2); ctx.stroke();
    }
    ctx.restore(); // end plot-area clip

    // endpoint dots + labels (labels wear text ink, dots carry identity)
    for (const [x, y, color, label] of [
      [X(0), Y(res.hA), TC.dotA, "A · eye"],
      [X(res.d), Y(res.hB), TC.dotB, "B · burst"],
    ]) {
      if (!Number.isFinite(y)) continue;
      ctx.save();
      ctx.fillStyle = color; ctx.shadowColor = color; ctx.shadowBlur = 6;
      ctx.beginPath(); ctx.arc(x, y, 4, 0, Math.PI * 2); ctx.fill();
      ctx.restore();
      ctx.font = MONO;
      ctx.fillStyle = TC.label;
      ctx.textAlign = x === X(0) ? "left" : "right";
      ctx.textBaseline = "bottom";
      ctx.fillText(label, x === X(0) ? x + 7 : x - 7, y - 5);
    }

    // hover crosshair
    if (hoverIdx >= 0 && hoverIdx <= res.n) {
      const hx = X(res.xs[hoverIdx]);
      ctx.strokeStyle = TC.crosshair; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(hx, MT); ctx.lineTo(hx, MT + ph); ctx.stroke();
    }
  }

  function niceTicks(min, max, count) {
    const span = max - min;
    if (span <= 0) return [min];
    const step = Math.pow(10, Math.floor(Math.log10(span / count)));
    const err = span / count / step;
    const mult = err >= 7.5 ? 10 : err >= 3.5 ? 5 : err >= 1.5 ? 2 : 1;
    const s = step * mult;
    const ticks = [];
    for (let t = Math.ceil(min / s) * s; t <= max; t += s) ticks.push(Math.round(t * 1e6) / 1e6);
    return ticks;
  }

  canvas.addEventListener("mousemove", (e) => {
    if (!lastResult?.adj) return;
    const rect = canvas.getBoundingClientRect();
    const ML = 48, MR = 14;
    const pw = canvas.clientWidth - ML - MR;
    const f = (e.clientX - rect.left - ML) / pw;
    if (f < 0 || f > 1) { hoverIdx = -1; tip.classList.add("hidden"); drawProfile(lastResult); return; }
    hoverIdx = Math.round(f * lastResult.n);
    const elev = lastResult.elevs[hoverIdx];
    tip.textContent = `${kmFmt(lastResult.xs[hoverIdx])} — terrain ${Number.isFinite(elev) ? Math.round(elev) + " m" : "?"}`;
    tip.style.left = e.clientX - rect.left + "px";
    tip.style.top = e.clientY - rect.top + "px";
    tip.classList.remove("hidden");
    drawProfile(lastResult);
  });
  canvas.addEventListener("mouseleave", () => {
    hoverIdx = -1; tip.classList.add("hidden");
    if (lastResult?.adj) drawProfile(lastResult);
  });
  window.addEventListener("resize", () => { if (lastResult?.adj) drawProfile(lastResult); });

  // Console helper (verification): await debugElev(35.3606, 138.7274) ≈ 3776 (Mt. Fuji)
  window.debugElev = async (lat, lon, z = 12) => {
    const keys = stencilTileKeys(lat, lon, z);
    const tiles = new Map();
    await Promise.all(keys.map(async (k) => {
      const [tz, tx, ty] = k.split("/").map(Number);
      tiles.set(k, await getTileBrowser(tz, tx, ty));
    }));
    return bilinearElev(tiles, z, lat, lon);
  };
}
