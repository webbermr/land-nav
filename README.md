# Land Nav VR

A WebXR land navigation trainer for the Meta Quest 3 browser. You stand on real terrain built from USGS elevation data, plot points on a topo map, shoot azimuths with a lensatic compass, count paces, and find stakes. The full design is in [spec.md](spec.md).

## Status

**M0 (pipeline and desktop viewer): done.** Build a site from a GeoTIFF and fly or walk over it in a desktop browser.

**M1 (walk in VR): built, awaiting a headset check.** Enter VR from the page, stand on the terrain at your real height, and walk with the left stick in the direction you're looking. Each footfall plays a footstep. Left footfalls are louder and pulse the left controller: that pulse is what you count. Your pace count (default 65 per 100 m), time compression and the slope effects are in Settings.

Compass, map tools, courses and the AAR come in M2 onward.

The bundled site, `demo-synthetic`, is procedural terrain placed at a real UTM location for testing. It is not a real place, and its map says so. Swap in a real site once one is picked (spec section 1).

## Run it

No build step. Serve the folder over HTTP and open it:

```sh
python3 -m http.server 8080
# then open http://localhost:8080/
```

Options go in the query string:

- `?site=<id>` picks a site folder.
- `?debug` shows your true position, distance walked and paces counted, on the desktop HUD and on a small panel on the left controller in VR. Use it to check your count against the truth. Debug is for development only; the app never shows position or pace count during a run.
- `?debug&start=x,z` starts at a scene position, in metres from the NW corner.

Desktop: click to capture the mouse, WASD to walk (listen for the footsteps), V toggles walk and fly, R and F fly up and down, Shift flies faster, G switches between the woods and open presets, P opens Settings, H hides the help panel.

Quest: press **Enter VR**. Left stick walks where you're looking. Turn by physically turning; snap turn on the right stick is off by default and lives in Settings. A dark vignette closes in while you move, adjustable in Settings.

### Checking the M1 pace acceptance on the headset

Open `https://webbermr.github.io/land-nav/?debug`, set your pace count in Settings, turn slope effects off, enter VR and walk with the stick while counting left-hand pulses. The panel on your left controller shows the true distance and the app's count. At 100 m the count should match your calibration within one pace.

WebXR needs HTTPS, so the headset uses the GitHub Pages build: **https://webbermr.github.io/land-nav/**. Every push to `main` runs the tests and redeploys. Pushes to other branches and pull requests run the tests only. The workflow is `.github/workflows/pages.yml`, and it needs Settings → Pages → Source set to **GitHub Actions**, once.

## Build a site from USGS data

1. Download a DEM GeoTIFF from the [National Map downloader](https://apps.nationalmap.gov/downloader/). Prefer the 1 m lidar DEM; fall back to 1/3 arc-second.
2. Look up the declination for the site and date with the [NOAA magnetic field calculator](https://www.ngdc.noaa.gov/geomag/calculators/magcalc.shtml). East is positive, west is negative.
3. Run the pipeline:

```sh
pip install -r tools/requirements.txt
python3 tools/make_site.py \
    --dem USGS_1M_18_x28y431.tif \
    --lat 38.866 --lon -77.459 \
    --id my-site --name "My Site" \
    --declination -10.6 --declination-date 2026-10-01
```

Pass several `--dem` files if the area spans tiles. The script refuses a playable area that crosses a UTM zone or MGRS 100 km square, or that has holes in the elevation data. It prints the G-M angle and which way to convert. **Read that line.** A declination with the wrong sign silently ruins every azimuth.

`--relief` adds light hillshade to the map. It's off by default because it makes terrain association too easy.

To test without downloading anything:

```sh
python3 tools/make_synthetic_dem.py --lat 38.85 --lon -77.45 --out /tmp/synthetic.tif
```

## Tests

```sh
npm test                                              # coords, heightfield, locomotion (Node 20+)
python3 -m unittest discover -s tests -p 'test_*.py'  # pipeline
node tests/e2e/xr.e2e.mjs http://localhost:8080/      # browser + fake headset (needs Playwright)
```

The browser check loads the app in headless Chromium with a fake WebXR headset (`tests/e2e/xr-mock.js`). It enters VR, walks with a scripted left stick, and checks the haptic pulses against the true distance, along with head-relative steering, the stick deadzone, snap turn, the boundary and exiting VR. CI runs all three suites on every push.

The pipeline test builds a site from a tilted-plane DEM where the right answer is known everywhere, then checks that `height.bin` samples land on the exact UTM grid points with row 0 north and column 0 west.

## Layout

```
index.html            entry point, import map
src/coords.js         scene <-> UTM <-> MGRS, azimuth and declination math (pure, tested)
src/heightfield.js    height decode, bilinear heightAt, slopeAt (pure, tested)
src/terrain.js        site loading, chunked terrain mesh, skirt
src/locomotion.js     speed, Tobler slope factor, stride, footfall cadence (pure, tested)
src/footfalls.js      footstep sounds and the left-hand haptic pulse
src/input.js          desktop keys and mouse, Quest controllers
src/vignette.js       comfort vignette
src/ui.js             Enter VR button, settings panel
src/settings.js       every tunable number, persisted when storage allows
src/main.js           renderer, player rig, desktop and VR loops
sites/<id>/           site.json, height.bin, skirt.bin, map.png, courses/
tools/make_site.py    DEM GeoTIFF -> site folder
vendor/three/         three.js r186, unmodified
```

## Notes and deviations from the spec

- **Renderer:** WebGLRenderer, not WebGPURenderer. WebGL is the proven WebXR path on the Quest Browser and nothing here needs WebGPU. The spec allows this fallback; it's worth revisiting after M1 runs on the headset.
- **site.json** carries a few extra fields beyond the spec's example: the skirt's own origin and elevation range, the map's pixel layout (`map.area` is the terrain square inside `map.png`), EPSG code, center lat/lon and source file names.
- **Desktop fly keys** are R and F because the spec reserves E for punching a stake.
- **Pace distance is horizontal.** Footfalls come from horizontal distance covered, shortened on slopes by the stride factor (spec section 6). Physically walking around your room moves you but doesn't fire footfalls; only the stick does.
- **Settings in VR:** for now, set them on the page before entering VR. The in-headset menu comes with the tools in M2.
