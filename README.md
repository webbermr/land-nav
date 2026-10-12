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

**Explore mode and teleport.** Whenever no course is running you're exploring (the HUD says EXPLORE), and you can teleport. In VR, push the **right stick forward**: a dotted arc comes from your right controller with a ring where you'd land (green: you can; red: off the area). Let go to jump there, with a short blink. The arc throws about 60 m on flat ground (X menu: Teleport range, 20 to 150 m). On desktop, **Q** jumps to the ground in the middle of the screen. Teleport is off during a course, because it would make the pace count meaningless. You never land inside a trunk or a building.

**Turning with the right stick (VR):** **snap** by default (a flick turns 30°), **smooth** (hold to turn, 90°/s, with the comfort vignette) or **off**. Set it in the X menu or Settings, along with the snap angle (15, 30 or 45°) and the smooth speed (45, 90 or 135°/s). While you hold the compass, the stick turns its bezel instead.

**Sun, time of day and sound.** The sun is where it really is over the site, for the real date and time: it rises in the east, sets in the west, and the sky runs from noon blue through a warm sunset and blue dusk to a dark, starry night. Times are the site's local clock (the UTC offset is guessed from the longitude, with US daylight saving). Pick another hour from **Time of day** in the X menu or Settings, or put `?time=HH:MM` in the address; it goes back to the real time on reload. Once the sun is 5° below the horizon the night rules below switch on by themselves: you need the headlamp to read the map, and the woods close in as it gets darker. **N** jumps to night, or back to day (noon, if it's dark out). A course keeps its own time: 10:30 for a day course, 22:00 at night.

The sun casts shadows from trees, rocks, logs and buildings within about 45 m of you (**Shadows**, X menu or Settings; switch them off first if the frame rate drops). The stars are a random field, not real constellations, but they turn about the pole star as the night goes on.

You hear the place: wind that gusts and grows louder up high or in the open, leaves moving where there are trees, birds by day (most at dawn, few in winter), crickets on warm nights and the odd owl, and running water near streams. Birds, crickets and water are placed around you, so in the headset you can turn toward them. Footsteps sound like what you're walking on: road and parking click, gravel tracks crunch, trails thud, leaf litter crackles, grass is soft. It's all made on the fly in the browser, with no recordings to download. **Nature sounds** in the X menu or Settings sets the volume.

**Weather and seasons.** **Weather** (X menu or Settings) is **Live** by default: the current conditions at the site from [Open-Meteo](https://open-meteo.com/), or from the nearest National Weather Service station if Open-Meteo doesn't answer. It refreshes every 10 minutes. **Replay a day** fetches any day from 1940 to yesterday from Open-Meteo's historical archive (ERA5 reanalysis), puts the sun on that date, and plays the day hour by hour as the clock runs; set the day with **Replay date** in the X menu (hold to step quickly) or **Day to replay** in Settings. Or pick the weather yourself: clear, partly cloudy, overcast, fog, drizzle, rain, thunderstorm, snow or blizzard. All of it is free and needs no account or key. Weather data by Open-Meteo.com (CC BY 4.0); NWS data is public domain.

What it does: clouds drift across the sky with the wind and hide the sun; overcast flattens the light and takes the shadows away. Fog, rain and snow close in to the reported visibility, and the trees aren't drawn past it, which helps the frame rate. Rain falls in streaks and darkens the ground; snow drifts down, and lying snow (from the report, or the snow picks) whitens the flatter ground. Thunderstorms flash, with the thunder arriving at the speed of sound. Trees sway harder as the wind picks up, and you hear the wind and rain.

The season follows the date (or pick one under **Season**). Hardwoods leaf out from mid April, go a fresh yellow-green in spring, turn yellow, orange and red through October, and stand bare from mid November, with each tree changing at its own moment. Spring comes later and autumn earlier further north and higher up (about 3 days a degree and a day per 40 m: a rough rule, not a forecast). In winter the grass goes straw-coloured, the far forest turns grey-brown, and bare far trees are drawn as branches. Pines and other conifers stay green.

**Info card and the map while exploring.** With no course running, **X** in VR (or **Tab** on desktop) shows an info card on your wrist instead of the score card. It gives the local time and date; sunrise, sunset and where the sun is now; the weather, temperature, wind and visibility; the season; your grid reference, latitude and longitude, and elevation; which way you're facing (magnetic, and the compass point); and what's underfoot (road, trail, or the land cover). US units by default (°F, mph, ft), or metric (**Info card units**). While you explore, the map also shows where you are, as the red "you are here" arrow (**Exploring: show me on the map**). During a course the card is the score card and the map keeps your position to itself, as before.

The X menu now has three tabs: **World** (time of day, weather, replay date, season, woods or open, headlamp, shadows, trees, sounds), **Moving** (fly, teleport range, turning, collisions, pace counts, time compression, vignette) and **Tools** (compass lens, assisted readout, "show my position", the map while exploring, info card units).

**Explore anywhere in the US, right away.** In the site builder, click the map and press **Explore it now, in this browser**, or open the app with `?at=lat,lon` (add `&name=...`, `&size=1000|1500|2000|3000`). The browser builds the square itself in about 10 to 30 seconds, from the same free sources the GitHub build uses: USGS 3DEP elevation, NLCD 2021 land cover and tree canopy, OpenStreetMap roads, trails and buildings, and the World Magnetic Model 2025 for declination. It draws the topo map too. Nothing goes to GitHub. The browser keeps a copy (IndexedDB), so the second visit opens at once; `&rebuild` fetches it fresh. A square that would straddle a 100 km grid line is nudged to one side of it. Courses on these sites are generated (**New random course**), starting at the parking area nearest the middle if OpenStreetMap has one. If OpenStreetMap or the NLCD is busy, the site builds without roads or real tree cover and says so.

**Travel on: the next square, and saved places.** On any real site, walk (or fly) into the edge of the square and keep going: the next 2 km square is built and you carry on into it at the same spot, with no reload, in VR too. It starts building in the background once you're within 200 m of an edge, so there's usually no wait; the first time over new ground takes 10 to 30 seconds (a message in front of you says what it's doing). Built-in sites lead on into squares built in the browser. Not during a course: the edge holds, as before.

**Places** (the Places tab in the X menu, or the Course panel on the page): **Save this spot** keeps where you're standing, which way you face, and your height if you're flying. Each saved spot, and the last 8 squares you built here, is listed; pick one to go straight there, wherever you are. In the headset the right half of a place's box goes there and the left half, pressed twice, forgets it. Places are kept in this browser. Picking another site in the Course panel now moves you there the same way, without a reload.

**The far view.** On every real site, the ground past about 200 m fades into USDA NAIP aerial photographs (USGS image service), so from a ridge you see the real fields, forest edges, roads and towns. Beyond the 6 km skirt, a 40 km ring of 3DEP elevation (200 m spacing), draped with NAIP too, carries the real mountains to the horizon, and the open-country haze now reaches about 30 km. Season and snow change the photographs' greens like the near ground. The photos are whatever NAIP has most recently flown, which in some states is autumn imagery. Switch it off with **Far view** (X menu, World tab, or Settings) if the frame rate suffers. The browser keeps the images (Cache API).

**M6 (stretch): automatic elevation download and land cover built.** See "Build a site" below. The shared course format with the iOS trainer and GPX import aren't started.

**Jog:** hold **Shift** on desktop, or tap the **left stick press** in VR (it ends once you let go of the stick for a second). Jogging is 2.7 m/s (about a 10-minute mile) with its own pace count, 52 per 100 m by default (Settings: "Jogging pace count"), because your stride is longer. Footfalls and the left-hand pulse follow that count while you jog. On grades steeper than 25%, up or down, you walk whatever you ask for, and the HUD says so. The review shows how much of each leg you jogged. If the run mixed gaits, it says so rather than turning the bead error into a single pace count.

**M5 (realism): night mode built, awaiting a headset check; walk-in-place not started.** Slope effects, the woods and open presets, trees and collision were already in. At night:

- The sky is dark and tree silhouettes fade out by about 60 m.
- A red headlamp lights the ground a few metres ahead. Switch it with **T** on desktop or the **left trigger** in VR.
- The map, score card, compass dial and lens can only be read under the headlamp, and then in red. As in the field, red map symbols wash out under red light.
- With the headlamp off, only the compass's luminous marks show: the north arrow, the E and W dots, the index dot and the bezel line.
- Stakes appear only within 10 m.

Run any course at night with **Run it at night** in the Course panel. `matthews-arm-night-1` is a night course with shorter legs (150 to 350 m) and 150 minutes. When no course is running, night also falls by itself after sunset (see Sun, time of day and sound above), and **N** switches between night and day. A night run is still reviewed in daylight colours.

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
- `?time=HH:MM` puts the sun at that local time instead of the real time (`?time=19:10` for a sunset).
- `?weather=<live|replay|clear|partly|overcast|fog|drizzle|rain|storm|snow|blizzard>`, `?date=YYYY-MM-DD` (the day to replay) and `?season=<auto|spring|summer|autumn|winter>` set the weather and season.
- `?debug&beacon=x,z` puts a tall striped test pole at a scene position. With the compass out, the debug readout shows the dial, the true magnetic azimuth and the true bearing to the beacon.

Desktop: click to capture the mouse, WASD to walk (listen for the footsteps), V toggles walk and fly, R and F fly up and down, Shift flies faster, G switches between the woods and open presets, P opens Settings, H hides the help panel.

Desktop course keys: E punches a stake within 2 m. Space slides a pace bead (Shift+Space resets them). Tab shows the score card, and Up/Down picks the row the next punch fills. Enter twice ends the course. L lays the ruler along the last line drawn on the map. Flying is off during a course.

Desktop tools: C brings out the compass, sighted along your view; the wheel turns its bezel. M brings up the map, and the mouse becomes the pencil. Click to place a dot. Click one dot, then another, to draw a line. Right-click a dot for the protractor. Delete erases the dot under the cursor. The wheel zooms toward the cursor.

Quest: press **Enter VR**. Left stick walks where you're looking. Turn by physically turning, or with the right stick (snap 30° by default; smooth or off in the X menu or Settings). A dark vignette closes in while you move, adjustable in Settings.

Quest course controls: **right trigger** (map put away) punches a stake within 2 m. **A** slides a pace bead; hold A to reset. **X** shows the score card on your left wrist. **Y** moves to the next row; hold Y to end the course. **Right stick press** (map up) lays the ruler along the last line.

Quest tools: hold the **right grip** for the compass. It sights along where the controller points, and the right stick turns the bezel. Hold the **left grip** for the map. With the compass put away, aim the right controller at the map. **Trigger** places a dot. Trigger one dot, then another, to draw a line. Hold the trigger on a dot to erase it. **B** on a dot centres the protractor there.

### Checking the M2 compass acceptance on the headset

Open `https://webbermr.github.io/land-nav/?debug&beacon=1150,880`, enter VR facing north-east, hold the right grip and sight the striped pole through the compass. The panel on your left controller shows the dial reading next to the true bearing to the beacon. They should agree within 1°.

### Checking the M1 pace acceptance on the headset

Open `https://webbermr.github.io/land-nav/?debug`, set your pace count in Settings, turn slope effects off, enter VR and walk with the stick while counting left-hand pulses. The panel on your left controller shows the true distance and the app's count. At 100 m the count should match your calibration within one pace.

WebXR needs HTTPS, so the headset uses the GitHub Pages build: **https://webbermr.github.io/land-nav/**. Every push to `main` runs the tests and redeploys. Pushes to other branches and pull requests run the tests only. The workflow is `.github/workflows/pages.yml`, and it needs Settings → Pages → Source set to **GitHub Actions**, once.

## Build a site from the web

The **[site builder](https://webbermr.github.io/land-nav/builder.html)** (`builder.html`, linked from the Course panel) does everything below without a terminal:

1. Click the map to place the square (1 to 3 km). It's drawn exactly as the build will make it, and it warns if the square crosses a UTM zone, a 100 km grid line or an MGRS band. Optionally place the course start, then name the site.
2. Tick what to add: real tree cover, roads and trails, and how many day and night courses. **Update a site** adds any of these to an existing site.
3. **Send to GitHub** opens a new issue with the request filled in. Press *Submit new issue*.
4. `.github/workflows/build-site.yml` runs it with `tools/build_request.py`:
   - It downloads the elevation, works out the declination from the World Magnetic Model, and builds the site, tree cover, roads and courses.
   - It pushes a branch and comments on the issue with a summary and a pull request.
   - Merge the PR and Pages publishes the site.

This needs no tokens or passwords: you submit the issue on GitHub while signed in. Only issues from the repository's owner, members and collaborators are built. The request is validated field by field, and nothing from it reaches a shell. If OpenStreetMap or the land cover service is busy, the build carries on without that part and says so; add it later with **Update a site**.

One-time setting: for the workflow to open the pull request itself, allow it under repo **Settings → Actions → General → Workflow permissions → Allow GitHub Actions to create and approve pull requests**. Without that, the branch is still pushed and the issue comment links to a one-click "open a pull request" page. Pull requests opened by the workflow don't trigger the test workflow (a GitHub rule for its own token); the tests run when you merge.

The **Run it in a terminal instead** section on the page shows the same build as commands.

## Build a site from USGS data

1. Look up the declination for the site and date with the [NOAA magnetic field calculator](https://www.ngdc.noaa.gov/geomag/calculators/magcalc.shtml). East is positive, west is negative.
2. Run the pipeline. With `--fetch-dem` it downloads the elevation itself, and `--landcover` adds real tree cover:

```sh
pip install -r tools/requirements.txt
python3 tools/make_site.py --fetch-dem --landcover \
    --lat 38.866 --lon -77.459 \
    --id my-site --name "My Site" \
    --declination -10.6 --declination-date 2026-10-01
```

**`--fetch-dem`** asks the [USGS 3DEP elevation service](https://elevation.nationalmap.gov/arcgis/rest/services/3DEPElevation/ImageServer) for exactly the site's box, in its UTM zone. It gets the playable square at 1 m and the skirt at 30 m. The service serves the best data it has, which is 1 m lidar where it exists. That's about 17 MB for a 2 km site, instead of several 10 km lidar tiles at 300 to 500 MB each. The [National Map product API](https://tnmaccess.nationalmap.gov/api/v1/docs) supplies the names of the lidar surveys underneath for `site.json`'s source list. Downloads are cached in `~/.cache/land-nav` (`--cache` to change). Rebuilding Matthews Arm this way matched the hand-built site to 0.17 m RMS (largest difference 1.35 m), with the same corner and G-M angle.

**`--landcover`** (or `tools/make_landcover.py --site my-site` on an existing site) downloads the [NLCD](https://www.mrlc.gov/) 2021 land cover and tree canopy cover, both 30 m and public domain. It resamples them onto a 10 m grid in `landcover.bin`. The app then puts trees where the canopy really is, with conifers where NLCD says evergreen or mixed forest, and noise only adds texture finer than 30 m. Sites without it keep the noise forest. Matthews Arm comes out 99% forest at 87% mean canopy, with gaps on the campground loops, the parking lots and Matthews Arm Road. NLCD covers the lower 48 states only.

To use files you downloaded yourself instead, from the [National Map downloader](https://apps.nationalmap.gov/downloader/) (prefer the 1 m lidar DEM), pass them with `--dem USGS_1M_18_x28y431.tif`. Pass several `--dem` files if the area spans tiles or one survey has gaps; earlier files win where they overlap. `--start-lat/--start-lon/--start-name` set a default course start such as a trailhead. List the site in `sites/index.json` to offer it in the app. The script refuses a playable area that crosses a UTM zone or MGRS 100 km square, or that has holes in the elevation data. It prints the G-M angle and which way to convert. **Read that line.** A declination with the wrong sign silently ruins every azimuth.

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
# or let it download the export itself from a public Overpass server:
python3 tools/make_features.py --site my-site --fetch
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
src/landcover.js      NLCD land cover: canopy, conifer share, class (pure, tested)
src/night.js          night sky, red headlamp, red-light tint for what you read
src/settings.js       every tunable number, persisted when storage allows
src/main.js           renderer, player rig, desktop and VR loops
sites/<id>/           site.json, height.bin, skirt.bin, map.png, features.json, landcover.bin, courses/
tools/make_site.py    DEM GeoTIFF -> site folder
tools/make_features.py OpenStreetMap export -> features.json and map symbols
tools/fetch_usgs.py   downloads: 3DEP elevation, lidar survey names, NLCD land cover
tools/make_landcover.py NLCD land cover and tree canopy -> landcover.bin
tools/build_request.py runs a web builder request (validate, build, summarise)
builder.html          the site builder page
src/builder/          builder page: map and form (main.js), request logic (request.js, tested)
src/utm.js            lat/lon <-> UTM in the browser (tested against PROJ)
vendor/leaflet/       Leaflet 1.9.4 (builder map), unmodified
vendor/three/         three.js r186, unmodified
```

## Notes and deviations from the spec

- **Renderer:** WebGLRenderer, not WebGPURenderer. WebGL is the proven WebXR path on the Quest Browser and nothing here needs WebGPU. The spec allows this fallback; it's worth revisiting after M1 runs on the headset.
- **site.json** carries a few extra fields beyond the spec's example: the skirt's own origin and elevation range, the map's pixel layout (`map.area` is the terrain square inside `map.png`), EPSG code, center lat/lon and source file names.
- **Desktop fly keys** are R and F because the spec reserves E for punching a stake.
- **Pace distance is horizontal.** Footfalls come from horizontal distance covered, shortened on slopes by the stride factor (spec section 6). Physically walking around your room moves you but doesn't fire footfalls; only the stick does.
- **Settings in VR:** hold **X** for the in-headset menu, a panel in front of you that moves with you. Point with the right controller and pull the trigger; the left or right side of a value steps it down or up, and holding the trigger repeats. It has woods/open, day/night, headlamp, fly, trees, collision, both pace counts, time compression, vignette, snap turn, compass units, assisted readout and the position lifeline. Day/night and fly are locked while a course runs. **Flying in VR:** left stick moves, right stick up/down climbs and descends (12 m/s), with the vignette on for comfort. The menu's own button isn't used because the Quest browser keeps it for the system.
- **Paper strip:** distance is measured with a ruler at map scale (0 to 1000 m, 10 m ticks), laid along the last line you drew with its zero on the line's first dot. That's the scale edge of a GTA protractor, rather than a blank strip you tick and carry to the scale bar. It gives the same information in one step fewer.
- **Course end:** the spec says a course ends "when the user returns to start and ends it". Here you can end anywhere, but the run only passes if you ended within 10 m of the start, inside the time limit, with enough right codes.
- **Score card rows:** a punch fills the highlighted row, then the highlight moves on to the next blank. Pick a different row first (Up/Down, or Y in VR) if you navigate the points out of order.
- **Trees and ground (pulled forward from M5):** instanced trees around you: tall hardwoods with a touch of early-autumn colour, hemlock-like conifers in patches, and saplings, at about 200 per hectare. The cover is mostly forest with clearings, and thinner on very steep ground. Full 3D trees are drawn near you and flat cut-outs farther out. Shrubs, fallen logs and rocks (on steep ground) cover the ground near you. Placement is seeded per site, so the forest is the same every visit, and trees are kept off stakes and the start. The ground is leaf litter under trees and grass in clearings, blending to canopy green in the distance. **Woods** is full forest with 150 m visibility; **open** is open woodland with light haze. Settings → Trees (high, medium, low, off) trades distance for frame rate; medium is the default, sized for the Quest 3, but not yet measured on one.
- **Collision (pulled forward from M5):** tree trunks, fallen logs, rocks and buildings block you, and you slide along them; shrubs don't. Only the distance you actually cover counts toward footfalls, so walking into a tree adds no paces. In VR, physically stepping into a trunk pushes you back out. Trees only block you when they're drawn, so Trees → Off also turns their collision off. Settings → "Trees and buildings block you" switches it all off.
- **Lost lifeline (a deliberate exception to "never show position"):** press **K** on desktop, or hold the **left stick press** for a second in VR. A red arrow shows your true position and facing on the map for 15 seconds, then goes away. The desktop map opens on its own; in VR, hold the left grip to see it. Each use during a course is counted, logged with your position for the AAR, and shown on the score card and the result. It doesn't fail the run. Turn it off in Settings ("Allow 'show my position'") to practise without it.
- **The compass rides the right controller's pointing ray,** not its grip, so the sighting axis is wherever you point. Where the compass and map sit in your hands (`compassOffset*`, `mapOffset*`, `mapTiltDeg` in `settings.js`) is a first guess that needs tuning on the headset.
- **Map line weights** were thickened (minor contours 2.4 px, index 5 px at 4096) so they survive minification in the headset. Regenerate other sites to pick this up.
