# Fireworks Line-of-Sight Checker

Single-page static website that checks whether two points on a map can see each other given terrain — e.g. "are fireworks bursting at point B visible from where I'm standing at point A?" Shademap-style, but for point-to-point visibility. No build step, no API keys, no dependencies beyond MapLibre GL from CDN.

## Run & test

```sh
python3 -m http.server 8000        # then open http://localhost:8000
node test.mjs                       # verification suite (needs network; hits real elevation tiles)
```

There is no package.json, bundler, or linter. Don't add one for small changes.

## Files

- `index.html` — page shell, CDN tags (`maplibre-gl@5.6.0`), controls-card markup, profile canvas
- `app.js` — everything: tile fetch/decode/cache, LOS engine, map + markers, profile chart, URL-hash state. Pure math functions are **exported** and DOM/map code is gated behind `typeof window !== "undefined"`, so Node can import the module for testing.
- `style.css` — full-viewport map, floating control card, bottom profile strip
- `test.mjs` — Node test harness; includes a minimal pure-Node PNG decoder (no canvas in Node) and injects its own `tileGetter` into `computeLOS`
- `fireworks-visibility-plan.md` — original implementation plan (kept as design doc; contains the phase-2 viewshed design)

## Architecture

1. **Elevation data**: AWS Open Data Terrarium tiles, keyless, CORS `*`:
   `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png`, decode `elev = R*256 + G + B/256 − 32768`. Same tiles double as MapLibre `raster-dem` for hillshade and the 3D-terrain toggle. Basemap is keyless CARTO raster with a light/dark toggle (`dark_all` / `light_all`) — the default UI is a night-sky "hanabi" theme. Theme system: CSS tokens under `:root` / `:root[data-theme="light"]` in `style.css`; map + chart tokens in the `THEMES` object in `app.js` (shared accents in `C`). Choice persists in `localStorage` key `fireworks-theme`, defaulting to `prefers-color-scheme`; `setTheme()` swaps basemap tiles via `RasterTileSource.setTiles` (with rebuild fallback), re-paints hillshade, and redraws overlays/chart. A firework particle burst plays on the `#fx` canvas when a verdict turns VISIBLE.
2. **Sampling**: haversine distance → `N = clamp(ceil(d/30), 32, 2000)` samples along the great circle (unit-vector slerp) → zoom chosen so tile resolution ≈ sample spacing (capped at z12 ≈ SRTM's 30 m).
3. **Lookup**: Web-Mercator global pixel coords, pixel-center bilinear interpolation; tiles decoded once into `Float32Array(65536)` and LRU-cached (256 entries) as *promises* to dedupe concurrent fetches. A failed tile's promise is evicted so the next recompute retries.
4. **Verdict** (`analyzeProfile`, pure): raise terrain by the earth-bulge, then over interior samples take `m_max = max((e'_i − h_A)/x_i)`; visible iff the sight-line slope `(h_B − h_A)/d` exceeds `m_max`. The argmax is the blocking point and `h_A + m_max·d − elev(B)` is the minimum burst altitude — no second pass. Any missing sample ⇒ INDETERMINATE, never a guess.

## Gotchas (learned the hard way)

- **Curvature sign**: terrain must be **raised** by `x(d−x)/(2·R_eff)` relative to the A–B chord (ITU earth-bulge convention), `R_eff = k·R_earth`, `k = 4/3` standard refraction. The original plan had a minus sign; that version passes casual tests but wrongly reports over-the-horizon targets as VISIBLE. The analytic check in `test.mjs` §2 (open-water min burst ≈ closed-form horizon formula) is the regression test for this — keep it.
- **Elevations are clamped to ≥ 0** because Terrarium encodes ocean bathymetry as negative. Side effect: below-sea-level land (Death Valley, Dead Sea) is treated as sea level — conservative for LOS.
- **"Open water" test coordinates must actually be open water** — an earlier test point sat on the tip of the Miura Peninsula and 29 m of land next to the observer dominated the whole verdict (correctly!). `test.mjs` now asserts `max(elevs) === 0` on that path first.
- The Gotemba↔Fujinomiya fixture does **not** cross Fuji's summit — the great circle passes ~12 km south over ~900 m foothills. Expected blocking elevation is ~943 m, not ~3776 m.
- SRTM shaves peaks: Fuji summit reads ~3750 m vs true 3776 m. Tests use ±40 m tolerance.
- Headless-Chrome `--screenshot` of MapLibre (WebGL) is flaky/blank; use Playwright (`playwright-core` with `channel: "chrome"`) for browser verification instead.
- A `<canvas>` is a replaced element: `position: absolute; inset: 0` does NOT stretch it — it keeps its intrinsic 300×150 unless you also set `width/height: 100%`. This silently broke the firework overlay once.
- Animate canvas physics in wall-clock seconds (RAF timestamp deltas), never per-frame steps — headless RAF runs unthrottled and 120 Hz displays run 2× fast.
- CSS animations on `#panel` children must live under the `.intro` class (removed by JS after load): bare `#panel > *` rules out-specify `.verdict`'s own animations and re-trigger the intro stagger on every verdict update.

## Limitations / phase 2

Terrain-only: buildings and trees don't exist in the model, so urban results are optimistic. Antimeridian paths and |lat| > 85° are rejected by design. Phase 2 — a viewshed overlay (color the map by where the burst is visible from, radial sweep in a Web Worker) — is fully designed in `fireworks-visibility-plan.md` §Phase 2 but not built.
