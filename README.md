# Land Nav VR

A WebXR land navigation trainer for the Meta Quest 3 browser. You stand on real terrain built from USGS elevation data, plot points on a topo map, shoot azimuths with a lensatic compass, count paces, and find stakes. The full design is in [spec.md](spec.md).

## Status

**M0 (pipeline and desktop viewer): done.** Build a site from a GeoTIFF and fly or walk over it in a desktop browser.

**M1 (walk in VR): built, awaiting a headset check.** Enter VR from the page, stand on the terrain at your real height, and walk with the left stick in the direction you're looking. Each footfall plays a footstep. Left footfalls are louder and pulse the left controller: that pulse is what you count. Your pace count (default 65 per 100 m), time compression and the slope effects are in Settings.

**M2 (compass and map): built, awaiting a headset check.** Hold the right grip for a lensatic compass and the left grip for the map board. The compass dial floats and swings toward magnetic north. Red degrees are inside, black mils outside, and the lens at the back shows the graduations under the index. The bezel clicks in 3° steps, and the dial sticks if you tilt it more than 15°. On the map, the right controller's short ray is a pencil: dots, lines between dots, and a protractor centred on a dot and aligned to grid north. Assisted mode (off by default) shows grid azimuth, magnetic azimuth and distance for the last line. The map never shows where you are.

**M3 (courses): built, awaiting a headset check.** Pick a course from the **Course** button. You start at the START flag with the course's grids on your score card. Plot them, navigate, and punch each stake (within 2 m). Count paces on the beads, then come back to the start and end the course. Decoy stakes are scattered at least 150 m from the real points, so you only find them if your navigation drifts. Stakes show within 40 m. The clock starts on your first step and runs faster under time compression. You get no word on whether a punch was right until the course ends. Then the card shows each row, the score, pass or fail, and distance walked against the ideal.

A pass needs at least the course's pass threshold of right codes, inside the time limit, ending within 10 m of the start. Every run is logged (a 1 s track, map and compass time, bead presses, punches) for the after-action review in M4. Run summaries are kept in browser storage.

The AAR comes in M4.

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
- `?course=<id>` loads one of the site's listed courses (for example `?course=day-1`); `?course=gen:<seed>` generates one.
- `?debug&beacon=x,z` puts a tall striped test pole at a scene position. With the compass out, the debug readout shows the dial, the true magnetic azimuth and the true bearing to the beacon.

Desktop: click to capture the mouse, WASD to walk (listen for the footsteps), V toggles walk and fly, R and F fly up and down, Shift flies faster, G switches between the woods and open presets, P opens Settings, H hides the help panel.

Desktop course keys: E punches a stake within 2 m. Space slides a pace bead (Shift+Space resets them). Tab shows the score card, and Up/Down picks the row the next punch fills. Enter twice ends the course. L lays the ruler along the last line drawn on the map. Flying is off during a course.

Desktop tools: C brings out the compass, sighted along your view; the wheel turns its bezel. M brings up the map, and the mouse becomes the pencil. Click to place a dot. Click one dot, then another, to draw a line. Right-click a dot for the protractor. Delete erases the dot under the cursor. The wheel zooms toward the cursor.

Quest: press **Enter VR**. Left stick walks where you're looking. Turn by physically turning; snap turn on the right stick is off by default and lives in Settings. A dark vignette closes in while you move, adjustable in Settings.

Quest course controls: **right trigger** (map put away) punches a stake within 2 m. **A** slides a pace bead; hold A to reset. **X** shows the score card on your left wrist. **Y** moves to the next row; hold Y to end the course. **Right stick press** (map up) lays the ruler along the last line.

Quest tools: hold the **right grip** for the compass. It sights along where the controller points, and the right stick turns the bezel. Hold the **left grip** for the map. With the compass put away, aim the right controller at the map. **Trigger** places a dot. Trigger one dot, then another, to draw a line. Hold the trigger on a dot to erase it. **B** on a dot centres the protractor there.

### Checking the M2 compass acceptance on the headset

Open `https://webbermr.github.io/land-nav/?debug&beacon=1150,880`, enter VR facing north-east, hold the right grip and sight the striped pole through the compass. The panel on your left controller shows the dial reading next to the true bearing to the beacon. They should agree within 1°.

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

## Courses

A course is `sites/<site>/courses/<id>.json` (format in spec section 8.2), listed in `courses/index.json` so the app offers it. To generate one from a seed and list it:

```sh
node tools/make_course.mjs --site demo-synthetic --seed 1001 --id day-1 --name "Day course 1"
# options: --points N --decoys N --time MIN --pass N --preset woods|open
```

The generator follows spec 8.3. Legs are 200 to 600 m. Points sit at least 100 m from the boundary, on slopes under 30%. Every stake, the start included, is at least 150 m from every other. Stakes go at the centre of their 10 m grid square, so the 8-digit grid on the card is within about 7 m of the stake. The demo site has `day-1` (woods) and `day-2` (open, 90 minutes). "New random course" in the Course panel generates one in the browser from a seed.

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
src/compass.js        lensatic compass model, floating dial, bezel, lens
src/compass-math.js   heading, tilt and dial damping (pure, tested)
src/map.js            map board, pencil dots and lines, protractor
src/map-math.js       scene <-> map pixel <-> board conversions (pure, tested)
src/tools.js          holding the tools, pencil ray, desktop map and compass
src/course-logic.js   course generator, validator, scoring (pure, tested)
src/course.js         stakes, punching, course clock, results, run history
src/beads.js          pace bead counter (pure, tested)
src/runlog.js         run log for the AAR (pure, tested)
src/wrist.js          bead cord and score card
tools/make_course.mjs generate a course file from a seed
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
- **Settings in VR:** for now, set them on the page before entering VR. An in-headset menu (the Menu button) is still to come.
- **Paper strip:** distance is measured with a ruler at map scale (0 to 1000 m, 10 m ticks), laid along the last line you drew with its zero on the line's first dot. That's the scale edge of a GTA protractor, rather than a blank strip you tick and carry to the scale bar. It gives the same information in one step fewer.
- **Course end:** the spec says a course ends "when the user returns to start and ends it". Here you can end anywhere, but the run only passes if you ended within 10 m of the start, inside the time limit, with enough right codes.
- **Score card rows:** a punch fills the highlighted row, then the highlight moves on to the next blank. Pick a different row first (Up/Down, or Y in VR) if you navigate the points out of order.
- **Woods preset:** for now it's fog only (150 m). Trees are planned under realism in M5.
- **The compass rides the right controller's pointing ray,** not its grip, so the sighting axis is wherever you point. Where the compass and map sit in your hands (`compassOffset*`, `mapOffset*`, `mapTiltDeg` in `settings.js`) is a first guess that needs tuning on the headset.
- **Map line weights** were thickened (minor contours 2.4 px, index 5 px at 4096) so they survive minification in the headset. Regenerate other sites to pick this up.
