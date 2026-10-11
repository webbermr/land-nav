# Land Nav VR

A WebXR land navigation trainer for the Meta Quest 3 browser. You stand on real terrain built from USGS elevation data, plot points on a topo map, shoot azimuths with a lensatic compass, count paces, and find stakes. The full design is in [spec.md](spec.md).

## Status

**M0 (pipeline and desktop viewer): done.** Build a site from a GeoTIFF and fly or walk over it in a desktop browser.

**M1 (walk in VR): built, awaiting a headset check.** Enter VR from the page, stand on the terrain at your real height, and walk with the left stick in the direction you're looking. Each footfall plays a footstep. Left footfalls are louder and pulse the left controller: that pulse is what you count. Your pace count (default 65 per 100 m), time compression and the slope effects are in Settings.

**M2 (compass and map): built, awaiting a headset check.** Hold the right grip for a lensatic compass and the left grip for the map board. The compass dial floats and swings toward magnetic north. Red degrees are inside, black mils outside, and the lens at the back shows the graduations under the index. The bezel clicks in 3° steps, and the dial sticks if you tilt it more than 15°. On the map, the right controller's short ray is a pencil: dots, lines between dots, and a protractor centred on a dot and aligned to grid north. Assisted mode (off by default) shows grid azimuth, magnetic azimuth and distance for the last line. The map never shows where you are.

**M3 (courses): built, awaiting a headset check.** Pick a course from the **Course** button. You start at the START flag with the course's grids on your score card. Plot them, navigate, and punch each stake (within 2 m). Count paces on the beads, then come back to the start and end the course. Decoy stakes are scattered at least 150 m from the real points, so you only find them if your navigation drifts. Stakes show within 40 m. The clock starts on your first step and runs faster under time compression. You get no word on whether a punch was right until the course ends. Then the card shows each row, the score, pass or fail, and distance walked against the ideal.

A pass needs at least the course's pass threshold of right codes, inside the time limit, ending within 10 m of the start. Every run is logged (a 1 s track, map and compass time, bead presses, punches) for the after-action review in M4. Run summaries are kept in browser storage.

**M4 (after-action review): built, awaiting a headset check.** When a course ends, the review opens: on desktop as a page over the view, in VR as a table in front of you (B, with the map put away, hides and shows it). The map side shows your track, coloured by leg, over the ideal straight legs. It also marks your punches, every "show my position", and where you were once you'd walked each leg's distance, tied back to the ideal line. The panel side gives, per leg:

- the grid and magnetic azimuth and distance you should have plotted
- the time it took and the distance you walked
- whether you reached the point, or how close you came
- your drift left or right at the leg distance, and how far you still were from the point
- your bead count against the distance you actually walked, as a percent error

Below that come the result, total time, distance against ideal, how long the map and compass were out, and your pace count as it worked out on this terrain. **Download run (JSON)** saves everything: the course, the 1 s track, events, tool times, bead presses, result and settings. The last run is kept in browser storage, so **Course → Review last run** brings it back after a reload.

**M5 (realism): night mode built, awaiting a headset check; walk-in-place not started.** Slope effects, the woods and open presets, trees and collision were already in. At night:

- The sky is dark and tree silhouettes fade out by about 60 m.
- A red headlamp lights the ground a few metres ahead. Switch it with **T** on desktop or the **left trigger** in VR.
- The map, score card, compass dial and lens can only be read under the headlamp, and then in red. As in the field, red map symbols wash out under red light.
- With the headlamp off, only the compass's luminous marks show: the north arrow, the E and W dots, the index dot and the bezel line.
- Stakes appear only within 10 m.

Run any course at night with **Run it at night** in the Course panel. `matthews-arm-night-1` is a night course with shorter legs (150 to 350 m) and 150 minutes. **N** switches day and night when no course is running. A night run is still reviewed in daylight colours.

Legs are split by the stakes you actually reached, not by which score-card row you wrote in. A leg ends when you punch its point's stake. If you never did, it ends at your closest approach to that point before you punched a later one. A code in the wrong row still counts against you on the card, and the review says what you wrote.

Two sites ship with the app. Pick between them in the Course panel.

- **`shenandoah-matthews-arm`** (the default) is real terrain: a 2 km square centred on Matthews Arm Campground in Shenandoah National Park, built from USGS 3DEP 1 m lidar. It uses the 2020 Northern Shenandoah survey, with the 2014 Shenandoah survey filling a corner the 2020 one doesn't cover. Elevation runs from 527 to 1,052 m. Declination is 10.0° W for 2026-10-11 (World Magnetic Model 2025); with 1.7° of grid convergence, the G-M angle is 11.7° W. Roads, trails, streams, the campground, parking and buildings come from OpenStreetMap and appear both on the map and in the world. All three courses start on the campground loop road and keep their stakes out in the woods.
- **`demo-synthetic`** is procedural terrain for testing. It is not a real place, and its map says so.

Shenandoah is a national park: follow park rules if you walk a course for real. The roads and trails are as OpenStreetMap has them (data © OpenStreetMap contributors, ODbL), which may not match the ground today.

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

Pass several `--dem` files if the area spans tiles or one survey has gaps; earlier files win where they overlap. `--start-lat/--start-lon/--start-name` set a default course start such as a trailhead. List the site in `sites/index.json` to offer it in the app. The script refuses a playable area that crosses a UTM zone or MGRS 100 km square, or that has holes in the elevation data. It prints the G-M angle and which way to convert. **Read that line.** A declination with the wrong sign silently ruins every azimuth.

`--relief` adds light hillshade to the map. It's off by default because it makes terrain association too easy.

### Roads, trails and buildings from OpenStreetMap

Optional. Export the area (a little larger than the site) from any Overpass API mirror, with geometry:

```
[out:json];
( way(S,W,N,E)[~"^(highway|tourism|amenity|leisure|waterway|building|natural|landuse)$"~"."];
  node(S,W,N,E)[~"^(tourism|amenity|natural)$"~"."]; );
out geom;
```

Then convert it and re-render the map:

```sh
python3 tools/make_features.py --site my-site --osm export.json
```

That writes `features.json`, sets `"features": true` in `site.json`, and redraws `map.png` with roads, trails, streams, the campground outline, buildings and a legend, plus the OSM credit in the margin. In the world, roads, tracks, trails and streams are laid on the ground, parking lots are paved, and buildings are simple boxes. Trees stay off roads and trails, out of parking lots and away from buildings, and thin out in campgrounds. Run it again after re-running `make_site.py`, which rewrites `site.json` and `map.png`.

To test without downloading anything:

```sh
python3 tools/make_synthetic_dem.py --lat 38.85 --lon -77.45 --out /tmp/synthetic.tif
```

## Courses

A course is `sites/<site>/courses/<id>.json` (format in spec section 8.2), listed in `courses/index.json` so the app offers it. To generate one from a seed and list it:

```sh
node tools/make_course.mjs --site demo-synthetic --seed 1001 --id day-1 --name "Day course 1"
# options: --points N --decoys N --time MIN --pass N --preset woods|open --start x,z
#          --night --leg-min M --leg-max M
```

The generator follows spec 8.3. Legs are 200 to 600 m. Points sit at least 100 m from the boundary, on slopes under 30%. Every stake, the start included, is at least 150 m from every other. Stakes go at the centre of their 10 m grid square, so the 8-digit grid on the card is within about 7 m of the stake. On a site with OpenStreetMap features, stakes stay at least 30 m from roads, tracks, parking, buildings and the campground: a stake you can find by walking a road isn't a navigation problem. Trails and streams are allowed nearby, since they're fair handrails. Shenandoah has `matthews-arm-1` (woods), `matthews-arm-2` (open) and `matthews-arm-3` (woods), all starting on the campground loop road; the demo site has `day-1` (woods) and `day-2` (open, 90 minutes). On a site with a default start, generated courses start there. "New random course" in the Course panel generates one in the browser from a seed.

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
src/aar-logic.js      AAR: legs, drift, closest approach, pace error, run export (pure, tested)
src/aar.js            AAR board: map, track and stats on a canvas; VR table; JSON download
src/wrist.js          bead cord and score card
tools/make_course.mjs generate a course file from a seed
src/ui.js             Enter VR button, settings panel
src/vegetation-logic.js tree cover and placement (pure, tested)
src/vegetation.js     instanced trees, cut-outs, shrubs, logs, rocks
src/features-logic.js OSM features: tree clearing, stake avoidance (pure, tested)
src/features.js       roads, trails, streams, parking, buildings in the world
src/collision.js      walker vs trunks, logs, rocks, buildings (pure, tested)
src/sky.js            gradient sky dome
src/night.js          night sky, red headlamp, red-light tint for what you read
src/settings.js       every tunable number, persisted when storage allows
src/main.js           renderer, player rig, desktop and VR loops
sites/<id>/           site.json, height.bin, skirt.bin, map.png, features.json, courses/
tools/make_site.py    DEM GeoTIFF -> site folder
tools/make_features.py OpenStreetMap export -> features.json and map symbols
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
- **Trees and ground (pulled forward from M5):** instanced trees around you: tall hardwoods with a touch of early-autumn colour, hemlock-like conifers in patches, and saplings, at about 200 per hectare. The cover is mostly forest with clearings, and thinner on very steep ground. Full 3D trees are drawn near you and flat cut-outs farther out. Shrubs, fallen logs and rocks (on steep ground) cover the ground near you. Placement is seeded per site, so the forest is the same every visit, and trees are kept off stakes and the start. The ground is leaf litter under trees and grass in clearings, blending to canopy green in the distance. **Woods** is full forest with 150 m visibility; **open** is open woodland with light haze. Settings → Trees (high, medium, low, off) trades distance for frame rate; medium is the default, sized for the Quest 3, but not yet measured on one.
- **Collision (pulled forward from M5):** tree trunks, fallen logs, rocks and buildings block you, and you slide along them; shrubs don't. Only the distance you actually cover counts toward footfalls, so walking into a tree adds no paces. In VR, physically stepping into a trunk pushes you back out. Trees only block you when they're drawn, so Trees → Off also turns their collision off. Settings → "Trees and buildings block you" switches it all off.
- **Lost lifeline (a deliberate exception to "never show position"):** press **K** on desktop, or hold the **left stick press** for a second in VR. A red arrow shows your true position and facing on the map for 15 seconds, then goes away. The desktop map opens on its own; in VR, hold the left grip to see it. Each use during a course is counted, logged with your position for the AAR, and shown on the score card and the result. It doesn't fail the run. Turn it off in Settings ("Allow 'show my position'") to practise without it.
- **The compass rides the right controller's pointing ray,** not its grip, so the sighting axis is wherever you point. Where the compass and map sit in your hands (`compassOffset*`, `mapOffset*`, `mapTiltDeg` in `settings.js`) is a first guess that needs tuning on the headset.
- **Map line weights** were thickened (minor contours 2.4 px, index 5 px at 4096) so they survive minification in the headset. Regenerate other sites to pick this up.
