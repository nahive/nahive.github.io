// Verification harness for app.js — run with: node test.mjs
// Tests the exported LOS math against real Terrarium tiles (decoded with a
// minimal pure-Node PNG reader) plus analytic curvature/refraction checks.

import {
  haversine, analyzeProfile, computeLOS, bilinearElev, lonLatToGlobalPx,
  K_REFRACTION, R_EARTH,
  parseBuildingHeight, pointInPolygon, buildingHeightsForPath,
  geocode,
} from "./app.js";
import zlib from "node:zlib";

// ---- minimal PNG decoder (8-bit depth, color types 0/2/3/4/6, no interlace) ----

function decodePNG(buf) {
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error("not a PNG");
  let pos = 8, ihdr = null, plte = null;
  const idat = [];
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString("ascii", pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + len);
    if (type === "IHDR") {
      ihdr = { w: data.readUInt32BE(0), h: data.readUInt32BE(4), depth: data[8], color: data[9], interlace: data[12] };
    } else if (type === "PLTE") plte = Buffer.from(data);
    else if (type === "IDAT") idat.push(data);
    else if (type === "IEND") break;
    pos += 12 + len;
  }
  if (ihdr.depth !== 8 || ihdr.interlace !== 0) throw new Error(`unsupported PNG (depth ${ihdr.depth}, interlace ${ihdr.interlace})`);
  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[ihdr.color];
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = ihdr.w * channels;
  const out = Buffer.alloc(ihdr.h * stride);
  for (let y = 0; y < ihdr.h; y++) {
    const filter = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const prev = y > 0 ? out.subarray((y - 1) * stride, y * stride) : null;
    const cur = out.subarray(y * stride, (y + 1) * stride);
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? cur[x - channels] : 0;
      const b = prev ? prev[x] : 0;
      const c = x >= channels && prev ? prev[x - channels] : 0;
      let v = line[x];
      switch (filter) {
        case 1: v = (v + a) & 255; break;
        case 2: v = (v + b) & 255; break;
        case 3: v = (v + ((a + b) >> 1)) & 255; break;
        case 4: {
          const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
          v = (v + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)) & 255; break;
        }
      }
      cur[x] = v;
    }
  }
  const n = ihdr.w * ihdr.h;
  const rgb = new Uint8Array(n * 3);
  for (let i = 0; i < n; i++) {
    if (ihdr.color === 2 || ihdr.color === 6) {
      rgb[i * 3] = out[i * channels]; rgb[i * 3 + 1] = out[i * channels + 1]; rgb[i * 3 + 2] = out[i * channels + 2];
    } else if (ihdr.color === 0 || ihdr.color === 4) {
      rgb[i * 3] = rgb[i * 3 + 1] = rgb[i * 3 + 2] = out[i * channels];
    } else {
      const p = out[i] * 3;
      rgb[i * 3] = plte[p]; rgb[i * 3 + 1] = plte[p + 1]; rgb[i * 3 + 2] = plte[p + 2];
    }
  }
  return { width: ihdr.w, height: ihdr.h, rgb };
}

const tileMem = new Map();
async function nodeTileGetter(z, x, y) {
  const key = `${z}/${x}/${y}`;
  if (tileMem.has(key)) return tileMem.get(key);
  const p = (async () => {
    const res = await fetch(`https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${z}/${x}/${y}.png`);
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${key}`);
    const { width, height, rgb } = decodePNG(Buffer.from(await res.arrayBuffer()));
    const out = new Float32Array(width * height);
    for (let i = 0; i < width * height; i++) {
      out[i] = rgb[i * 3] * 256 + rgb[i * 3 + 1] + rgb[i * 3 + 2] / 256 - 32768;
    }
    return out;
  })();
  tileMem.set(key, p);
  return p;
}

async function elevAt(lat, lon, z = 12) {
  const worldPix = 256 * 2 ** z;
  const { gx, gy } = lonLatToGlobalPx(lat, lon, z);
  const tiles = new Map();
  for (const px of [Math.floor(gx - 0.5), Math.floor(gx - 0.5) + 1]) {
    for (const py of [Math.floor(gy - 0.5), Math.floor(gy - 0.5) + 1]) {
      const wx = ((px % worldPix) + worldPix) % worldPix;
      const wy = Math.max(0, Math.min(worldPix - 1, py));
      const key = `${z}/${Math.floor(wx / 256)}/${Math.floor(wy / 256)}`;
      if (!tiles.has(key)) tiles.set(key, await nodeTileGetter(z, Math.floor(wx / 256), Math.floor(wy / 256)));
    }
  }
  return bilinearElev(tiles, z, lat, lon);
}

// ---- assertions ----

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log(`  ok  ${name}${detail ? ` — ${detail}` : ""}`); }
  else { fail++; console.error(`FAIL  ${name}${detail ? ` — ${detail}` : ""}`); }
}
const near = (v, target, tol) => Math.abs(v - target) <= tol;

// ---- 1. Terrarium decode sanity ----

console.log("\n[1] Terrarium decode");
const fuji = await elevAt(35.3606, 138.7274);
check("Mt. Fuji summit ≈ 3776 m", near(fuji, 3776, 40), `got ${fuji.toFixed(1)} m`);
const pacific = await elevAt(30.0, 150.0);
check("mid-Pacific raw elevation is negative (bathymetry)", pacific < -1000, `got ${pacific.toFixed(0)} m`);

// ---- 2. Analytic curvature + refraction (synthetic flat-ocean profile) ----

console.log("\n[2] Curvature/refraction analytic check (30 km over ocean, eye 1.7 m)");
const D = 30000, EYE = 1.7, N = 1000;
const zeros = new Array(N + 1).fill(0);
const expectMinBurst = (k) => {
  const R = k * R_EARTH;
  return (D - Math.sqrt(2 * R * EYE)) ** 2 / (2 * R);
};

const oceanK43 = analyzeProfile(zeros, D, EYE, 10);
check("burst 10 m at 30 km is BLOCKED (below horizon)", oceanK43.status === "blocked");
check(`min burst (k=4/3) ≈ ${expectMinBurst(K_REFRACTION).toFixed(1)} m`,
  near(oceanK43.minBurstAGL, expectMinBurst(K_REFRACTION), 0.5),
  `got ${oceanK43.minBurstAGL.toFixed(2)} m`);

const oceanK1 = analyzeProfile(zeros, D, EYE, 10, 1);
check(`min burst (k=1, no refraction) ≈ ${expectMinBurst(1).toFixed(1)} m and > k=4/3 value`,
  near(oceanK1.minBurstAGL, expectMinBurst(1), 0.5) && oceanK1.minBurstAGL > oceanK43.minBurstAGL,
  `got ${oceanK1.minBurstAGL.toFixed(2)} m`);

const oceanClear = analyzeProfile(zeros, D, EYE, expectMinBurst(K_REFRACTION) + 2);
check("burst just above minimum is VISIBLE", oceanClear.status === "visible");

check("flat 10 km plain, burst 150 m is VISIBLE with big clearance",
  (() => { const r = analyzeProfile(new Array(334).fill(12), 10000, EYE, 150); return r.status === "visible" && r.clearance > 100; })());

// ---- 3. Real-terrain LOS (full pipeline with injected node tile getter) ----

console.log("\n[3] Real terrain, full computeLOS pipeline");
const gotemba = { lat: 35.31, lon: 138.93 };     // east of Mt. Fuji
const fujinomiya = { lat: 35.22, lon: 138.62 };  // west of Mt. Fuji
const acrossFuji = await computeLOS(gotemba, fujinomiya, 1.7, 150, nodeTileGetter);
check("Gotemba ↔ Fujinomiya (across Mt. Fuji), burst 150 m → BLOCKED",
  acrossFuji.status === "blocked", `status=${acrossFuji.status}`);
check("…with min burst in the thousands of meters",
  acrossFuji.minBurstAGL > 1000, `min burst ${acrossFuji.minBurstAGL?.toFixed(0)} m`);
// the great circle passes ~12 km south of the summit, over ~900 m foothills
const bp = acrossFuji.pts?.[acrossFuji.blockIdx];
check("…blocking point lies on Fuji's south flank (lon between endpoints, elev > 800 m)",
  bp && bp.lon > 138.62 && bp.lon < 138.93 && acrossFuji.elevs[acrossFuji.blockIdx] > 800,
  bp ? `block at ${bp.lat.toFixed(4)}, ${bp.lon.toFixed(4)}, elev ${acrossFuji.elevs[acrossFuji.blockIdx].toFixed(0)} m` : "no block point");

const kantoA = { lat: 35.86, lon: 139.65 }, kantoB = { lat: 35.95, lon: 139.78 };
const kanto = await computeLOS(kantoA, kantoB, 1.7, 150, nodeTileGetter);
check("flat Kanto plain ~15 km, burst 150 m → VISIBLE",
  kanto.status === "visible", `status=${kanto.status}, clearance ${kanto.clearance?.toFixed(0)} m`);

const bayA = { lat: 35.15, lon: 139.30 }, bayB = { lat: 34.95, lon: 139.45 };
const bay = await computeLOS(bayA, bayB, 1.7, 5, nodeTileGetter);
const bayD = haversine(bayA, bayB);
const bayExpect = (bayD - Math.sqrt(2 * K_REFRACTION * R_EARTH * 1.7)) ** 2 / (2 * K_REFRACTION * R_EARTH);
check("…path is genuinely open water (max clamped elev 0)", Math.max(...bay.elevs) === 0,
  `max elev ${Math.max(...bay.elevs)}`);
check(`Sagami Bay open water ${(bayD / 1000).toFixed(1)} km, burst 5 m → BLOCKED by curvature`,
  bay.status === "blocked", `status=${bay.status}`);
check(`…real-tile min burst matches analytic ≈ ${bayExpect.toFixed(1)} m`,
  near(bay.minBurstAGL, bayExpect, 3), `got ${bay.minBurstAGL?.toFixed(1)} m`);

// ---- 4. Guards ----

console.log("\n[4] Guards");
check("A ≈ B → 'same'", (await computeLOS({ lat: 35, lon: 139 }, { lat: 35, lon: 139 }, 1.7, 150, nodeTileGetter)).status === "same");
check("40 m apart → 'tooClose'", (await computeLOS({ lat: 35, lon: 139 }, { lat: 35.00036, lon: 139 }, 1.7, 150, nodeTileGetter)).status === "tooClose");
check("antimeridian → rejected", (await computeLOS({ lat: 35, lon: 179.5 }, { lat: 35, lon: -179.5 }, 1.7, 150, nodeTileGetter)).status === "antimeridian");
check("polar → rejected", (await computeLOS({ lat: 87, lon: 0 }, { lat: 85.5, lon: 0 }, 1.7, 150, nodeTileGetter)).status === "polar");
const failing = await computeLOS(gotemba, fujinomiya, 1.7, 150, () => Promise.reject(new Error("boom")));
check("all tiles failing → 'indeterminate'", failing.status === "indeterminate", `status=${failing.status}`);

// ---- 5. Buildings ----

console.log("\n[5] Buildings");
check("parseBuildingHeight: 'height' tag with unit → number", parseBuildingHeight({ height: "12 m" }) === 12);
check("parseBuildingHeight: building:levels ×3", parseBuildingHeight({ "building:levels": "4" }) === 12);
check("parseBuildingHeight: height wins over levels", parseBuildingHeight({ height: "30", "building:levels": "2" }) === 30);
check("parseBuildingHeight: no data → small default (3 m)", parseBuildingHeight({}) === 3);
check("parseBuildingHeight: junk height falls through to levels", parseBuildingHeight({ height: "yes", "building:levels": "5" }) === 15);

// unit square from (0,0) to (0.001, 0.001) in {lat,lon}
const square = [
  { lat: 0, lon: 0 }, { lat: 0, lon: 0.001 },
  { lat: 0.001, lon: 0.001 }, { lat: 0.001, lon: 0 },
];
check("pointInPolygon: center is inside", pointInPolygon(0.0005, 0.0005, square) === true);
check("pointInPolygon: outside point is outside", pointInPolygon(0.002, 0.0005, square) === false);

const fixtureBuildings = [{
  ring: square, height: 25,
  bbox: { s: 0, w: 0, n: 0.001, e: 0.001 },
}];
const pathPts = [
  { lat: 0.0005, lon: 0.0005 }, // inside → 25 m
  { lat: 0.005, lon: 0.005 },   // outside → 0 m
];
const bh = buildingHeightsForPath(pathPts, fixtureBuildings);
check("buildingHeightsForPath: raises interior sample, leaves exterior at 0",
  bh[0] === 25 && bh[1] === 0, `got [${bh[0]}, ${bh[1]}]`);
check("buildingHeightsForPath: empty building set → all zero",
  buildingHeightsForPath(pathPts, []).every((v) => v === 0));

// Integration: a tall injected building on a flat plain becomes the blocker.
// Kanto plain path is VISIBLE terrain-only (test [3]); drop a 400 m tower at the
// midpoint and it must flip to BLOCKED. buildingGetter(bbox) is injected so no
// network — it returns one polygon straddling the whole path bbox at 400 m.
const towerGetter = (bbox) => Promise.resolve([{
  ring: [
    { lat: bbox.s, lon: bbox.w }, { lat: bbox.s, lon: bbox.e },
    { lat: bbox.n, lon: bbox.e }, { lat: bbox.n, lon: bbox.w },
  ],
  height: 400, bbox,
}]);
const kantoBld = await computeLOS(kantoA, kantoB, 1.7, 150, nodeTileGetter,
  { includeBuildings: true, buildingGetter: towerGetter });
check("injected 400 m building flips flat-plain VISIBLE → BLOCKED",
  kantoBld.status === "blocked" && kantoBld.buildingsUsed === true,
  `status=${kantoBld.status}, buildingsUsed=${kantoBld.buildingsUsed}`);
const kantoNoBld = await computeLOS(kantoA, kantoB, 1.7, 150, nodeTileGetter,
  { includeBuildings: false });
check("same path without buildings stays VISIBLE (buildingsUsed=false)",
  kantoNoBld.status === "visible" && kantoNoBld.buildingsUsed === false,
  `status=${kantoNoBld.status}, buildingsUsed=${kantoNoBld.buildingsUsed}`);
const kantoFail = await computeLOS(kantoA, kantoB, 1.7, 150, nodeTileGetter,
  { includeBuildings: true, buildingGetter: () => Promise.reject(new Error("overpass down")) });
check("building fetch failure → terrain-only fallback, never indeterminate",
  kantoFail.status === "visible" && kantoFail.buildingsUsed === false,
  `status=${kantoFail.status}, buildingsUsed=${kantoFail.buildingsUsed}`);

// ---- 6. Geocoding (Photon parse, injected fetch — no network) ----

console.log("\n[6] Geocoding");
const photonFixture = {
  features: [
    { geometry: { coordinates: [138.7274, 35.3606] },
      properties: { name: "Mount Fuji", osm_key: "natural", osm_value: "peak", state: "Shizuoka", country: "Japan" } },
    { geometry: { coordinates: [139.7454, 35.6586] },
      properties: { name: "Tokyo Tower", city: "Tokyo", country: "Japan" } },
  ],
};
const mockFetch = async () => ({ ok: true, json: async () => photonFixture });
const geo = await geocode("fuji", mockFetch);
check("geocode parses Photon features → name/lat/lon/kind",
  geo.length === 2 && geo[0].name === "Mount Fuji" && geo[0].kind === "peak" &&
  near(geo[0].lat, 35.3606, 1e-4) && near(geo[0].lon, 138.7274, 1e-4),
  `first=${JSON.stringify(geo[0])}`);
check("geocode builds a label from name/city/country",
  geo[1].label.includes("Tokyo") && geo[1].label.includes("Japan"), `label=${geo[1].label}`);
check("geocode empty query → [] without fetching",
  (await geocode("  ", () => { throw new Error("should not fetch"); })).length === 0);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
