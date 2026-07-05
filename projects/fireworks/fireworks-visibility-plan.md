# Fireworks Line-of-Sight Checker (terrain visibility map)

## Context

Szymon asked whether a shademap.app-style site can check if two points are mutually visible given terrain — concretely: "are fireworks launched at point B visible from where I'm standing at point A?" Answer: yes. Free, keyless global elevation tiles (the AWS Open Data Terrarium set, ~30 m SRTM-based) let us sample terrain along the sight-line and check for blocking ridges, with the same tiles doubling as MapLibre 3D terrain for visualization. This plan builds a single-page static site in the empty directory `/Users/user/Developer/ai/testing`.

Decisions (defaults chosen; user was AFK when asked): terrain-only obstructions (no buildings), two-point check as core with viewshed as a phase-2 stretch, plain HTML/JS static site with CDN libraries, no build step.

**Per Szymon's standing preference: on approval, first save this plan to `fireworks-visibility-plan.md` in the project root for later execution rather than building immediately — confirm before implementing.**

## Files (all new)

- `index.html` — page shell, CDN tags (`maplibre-gl@5.6.0` from unpkg), controls-card markup, profile `<canvas>`
- `app.js` — `<script type="module">`; sections: constants → tile cache/decode → elevation sampling → LOS engine → map/markers → profile chart → UI/state/URL-hash
- `style.css` — full-viewport map, floating control card top-left, bottom profile strip (~180 px, hidden until both markers placed)

No chart library — the profile is a filled polygon + sight line + one dot, ~60 lines of canvas 2D.

## Data sources (verified keyless + CORS `*` on 2026-07-03)

- **Elevation**: `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png` (256×256, z 0–15). Decode: `elev_m = (R*256 + G + B/256) − 32768`.
- **Basemap**: OSM raster `https://tile.openstreetmap.org/{z}/{x}/{y}.png` via an inline MapLibre style JSON (raster source + attribution). Same terrarium tiles registered twice as `raster-dem` sources: one for a hillshade layer (exaggeration 0.3), one for an optional 3D-terrain checkbox (`map.setTerrain({source:"dem"})`). Comment CARTO light tiles as a drop-in basemap alternative.

**Tile decode/cache** (for the algorithm, separate from MapLibre's own fetches): `fetch → blob → createImageBitmap → OffscreenCanvas → getImageData` → decode once into a `Float32Array(65536)`. Cache `Map<"z/x/y", Promise<Float32Array>>` (promise caching dedupes concurrent requests), LRU cap 256 entries (~64 MB), 1 retry w/ 500 ms backoff, evict rejected promises so recompute retries.

## LOS algorithm

Constants: `R_earth = 6371000`, refraction factor `k = 4/3`, `R_eff = k·R_earth` (expose k so k=1 disables refraction for testing).

1. **Sampling**: haversine distance `d`; `N = clamp(ceil(d/30), 32, 2000)` samples along the great circle via unit-vector slerp (`P(f) = (sin((1−f)δ)A + sin(fδ)B)/sin δ`).
2. **Zoom**: `z = clamp(round(log2(156543.03392·cos(φ_mid)/spacing)), 4, 12)` — z12 ≈ SRTM's native 30 m.
3. **Elevation lookup**: global Web-Mercator pixel coords at z, pixel-center bilinear interpolation across the 4-neighbor stencil; resolves tile id + offset transparently across tile boundaries. Prefetch all needed tiles with `Promise.all` before sampling. Clamp elevations to ≥ 0 (terrarium encodes bathymetry as negative; document that below-sea-level basins like Death Valley are treated as sea level — conservative).
4. **Curvature+refraction** (earth-bulge method): `e'_i = e_i + x_i(d − x_i)/(2·R_eff)` — the earth's surface rises above the endpoint chord between A and B, so terrain is *raised* by the bulge and the sight line treated as straight. *(Corrected during implementation: the original plan had a minus sign, which fails the over-the-horizon ocean test.)*
5. **Verdict**: `h_A = elev(A) + eyeHeight` (default 1.7 m), `h_B = elev(B) + burstAlt` (default 150 m AGL). Over interior samples, `m_max = max((e'_i − h_A)/x_i)` with argmax `i*`; sight slope `m_los = (h_B − h_A)/d`. **VISIBLE iff `m_los > m_max`**. Min burst: `minBurstAGL = max(0, h_A + m_max·d − elev(B))`; clearance `= (m_los − m_max)·d`. Any failed tile ⇒ verdict **INDETERMINATE** (never guess).

## UI/UX

- Click 1 drops draggable Observer marker (blue), click 2 drops Fireworks marker (orange); GeoJSON line connects them; red dot at blocking sample when blocked. Reset button.
- Controls card: coordinate readouts, eye-height + burst-altitude inputs, distance, 3D toggle, verdict banner — green "VISIBLE, clears by N m" / red "BLOCKED at X.X km — min burst N m AGL" (+ one-click "set burst to minimum") / gray INDETERMINATE.
- Profile canvas: curvature-adjusted terrain fill, straight sight line, dashed min-visible line when blocked, hover crosshair, hatched gaps for failed tiles.
- Recompute on `dragend`, throttled `drag` (200 ms), input change; token-guard stale async results.
- Shareable state in URL hash: `#a=lat,lon&b=lat,lon&eye=1.7&burst=150&terrain=1` via `history.replaceState`; parsed on load.

## Edge cases

Points <60 m apart → trivially VISIBLE; A≈B guard; antimeridian crossing → "not supported" message (out of scope); |lat|>85° rejected; tile 404/failure → INDETERMINATE with retry on next recompute; >300 km soft "approximate" warning (N capped at 2000 so spacing grows).

## Implementation order

1. HTML/CSS + MapLibre boot (OSM + hillshade + 3D toggle) — confirm keyless render.
2. Markers, controls, state, hash.
3. Tile fetch/decode/cache + `elevationAt()` — sanity-check via console helper.
4. LOS engine + verdict.
5. Profile chart + blocking marker + verdict polish.
6. Edge-case guards.

## Verification

- Expose `window.debugElev(lat,lon)`: Mt. Fuji summit (35.3606, 138.7274) ≈ 3776 m ±30; mid-ocean → 0.
- Flat Kanto-plain pair ~10 km, burst 150 m → VISIBLE, near-flat profile.
- Gotemba (35.31, 138.93) ↔ Fujinomiya (35.22, 138.62), burst 150 m → BLOCKED on Fuji's flank, min burst in the thousands of meters.
- Analytic curvature check over open water, eye 1.7 m, d = 30 km: min burst ≈ `(d − √(2·R_eff·h_A))²/(2·R_eff)` ≈ 35.7 m (k=4/3); flipping k=1 → ≈ 50.4 m confirms refraction wiring. *(Plan originally said 46 m for k=1; the correct closed-form value is 50.4 m.)*
- Cross-check a profile against heywhatsthat.com/profiler.html.
- Serve with `python3 -m http.server` and drive the flow in a browser (markers, drag, verdict, hash reload, offline → INDETERMINATE → recovery).

## Phase 2 (stretch, not in core scope)

Viewshed overlay: from the burst point, radial sweep (~720 azimuths × ~30 m steps, running max elevation-angle) in a Web Worker, rendered to a canvas added as a MapLibre `image` source with green tint where visible. One extra button; reuses `elevationAt`.
