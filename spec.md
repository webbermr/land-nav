# Land Nav Terrain VR: spec

Working title. Rename freely.

## 1. What this is

A WebXR app for the Meta Quest 3 browser that puts you on real terrain, built from USGS elevation data, with a lensatic compass, a topo map, pace beads, and a set of points to find. You plot, shoot an azimuth, walk it, count paces, and punch the stake. Afterward you see your actual track against the ideal one.

The thing VR adds over practicing outside: every step is logged, so the after-action review can show exactly where you drifted and how far off your pace count was.

### Assumptions I made (change any of these)

| Decision | Chosen default | Alternative |
|---|---|---|
| Style | Military: MGRS grids, lensatic compass, degrees with a mils toggle | Orienteering: baseplate compass, 1:10,000 map |
| Stack | Three.js + WebXR, static files on GitHub Pages, no build step | Single HTML file like outpost-lumen |
| Movement | Thumbstick with simulated footfalls you count | Walk-in-place (planned for M5) |
| Terrain size | 2 km x 2 km playable, 4 m grid | Larger area at coarser grid |
| First site | TBD. Pick somewhere you can also walk in person | |

## 2. Goals and non-goals

**Goals**
- Practice the full dead-reckoning loop: plot, measure azimuth and distance, convert grid to magnetic, walk, count paces, confirm.
- Practice terrain association: match contour lines on the map to the ground in front of you.
- Give honest feedback through a track-based after-action review (AAR).
- Run at a steady 72 fps or better in the Quest 3 browser.
- Stay a static site. No server.

**Non-goals for v1**
- Multiplayer.
- Hand tracking (controllers only).
- Photorealistic terrain or Gaussian splats.
- Passthrough or mixed reality.
- Runtime download of elevation data. Sites are prebuilt offline.

## 3. Platform and stack

- **Target:** Meta Quest 3, Meta Quest Browser, WebXR `immersive-vr` session.
- **Rendering:** Three.js. Match the renderer outpost-lumen uses (WebGPURenderer). Nothing here needs WebGPU, so fall back to WebGLRenderer if XR sessions misbehave.
- **Modules:** plain ES modules with an import map. Three.js vendored into `/vendor` so the site works without a CDN.
- **Hosting:** GitHub Pages (HTTPS is required for WebXR).
- **Physics:** none. The player is grounded by sampling the heightmap.
- **Desktop mode:** the same app must run without a headset (WASD + mouse look, keys for tools). This is how most development and testing happens.
- **Offline pipeline:** Python 3 script that turns a DEM GeoTIFF into a site folder.

## 4. Coordinate conventions

Get these right first. Everything else depends on them.

- Each site lives in one UTM zone and one MGRS 100 km square. The pipeline rejects a bounding box that crosses either boundary.
- Scene units are meters. Y is up.
- Scene origin is the **northwest corner** of the playable area:
  - `x = easting - E_west` (increases east)
  - `z = N_north - northing` (increases south)
  - `y = elevation - elev_ref`
- Grid north is `-Z`.
- Grid azimuth of a horizontal direction `(dx, dz)`: `az = atan2(dx, -dz)` in degrees, normalized to 0..360.
- Heightmap row 0 is the north edge, column 0 is the west edge. So `row = z / spacing`, `col = x / spacing`.
- Three norths:
  - The scene is aligned to **grid** north.
  - The compass reads **magnetic** north.
  - `gm_angle_deg` is signed, positive when magnetic north is east of grid north.
  - `magnetic_az = grid_az - gm_angle_deg`
  - The app never does this conversion for the user outside of assisted mode. The map carries a declination diagram and the user does the math.
- 8-digit grid from scene position: `EEEE = floor(((E_west + x) mod 100000) / 10)`, `NNNN = floor(((N_north - z) mod 100000) / 10)`, zero-padded, prefixed with the site's grid zone and 100 km square ID.

## 5. Terrain

### 5.1 Source data
- USGS 3DEP elevation, downloaded as GeoTIFF from the National Map downloader (apps.nationalmap.gov/downloader). Public domain.
- Prefer 1 m lidar-derived DEM where it exists. Fall back to 1/3 arc-second (about 10 m).
- The user downloads the GeoTIFF by hand for v1. Automated fetch is a stretch goal.

### 5.2 Pipeline: `tools/make_site.py`

Input: one or more GeoTIFFs, a center point (lat/lon), playable size (default 2000 m), grid spacing (default 4 m), skirt size (default 6000 m at 30 m spacing), site ID, declination.

Steps:
1. Reproject to the site's UTM zone. Resample (bilinear) to the playable grid and the skirt grid.
2. Write `height.bin`: little-endian Uint16, row-major, with `elev_min` and `elev_max` in `site.json`. Decode: `elev = elev_min + v * (elev_max - elev_min) / 65535`.
3. Write `skirt.bin` the same way for the surrounding low-res ring.
4. Render `map.png` (4096 x 4096) from the DEM:
   - Contours at 10 m, index contours every 50 m, heavier and labeled.
   - 1 km grid lines labeled with two-digit principal digits. 100 m ticks along the edges.
   - Margin: declination diagram with the G-M angle, contour interval, scale bar, site name.
   - Brown contours on a light background. No shaded relief in the default map (it makes terrain association too easy). Optional flag to add it.
5. Compute grid convergence with pyproj. Declination is entered by hand from the NOAA magnetic field calculator for the site and date. `gm_angle_deg = declination - convergence`.
6. Write `site.json`.

Dependencies: rasterio, numpy, pyproj, matplotlib, mgrs.

### 5.3 `site.json`

```json
{
  "id": "example-site",
  "name": "Example Site",
  "utm_zone": "18N",
  "mgrs_gzd": "18S",
  "mgrs_100km": "TJ",
  "e_west": 284000,
  "n_north": 4302000,
  "size_m": 2000,
  "spacing_m": 4,
  "grid": 501,
  "elev_min": 61.2,
  "elev_max": 148.9,
  "elev_ref": 61.2,
  "skirt": { "size_m": 6000, "spacing_m": 30, "grid": 201 },
  "declination_deg": 0.0,
  "convergence_deg": 0.0,
  "gm_angle_deg": 0.0,
  "declination_date": "2026-10-01",
  "contour_interval_m": 10
}
```

Values above are placeholders, not a real site.

### 5.4 Runtime terrain
- Build the playable mesh from `height.bin`, split into 8 x 8 chunks so frustum culling works. About 500k triangles total at defaults.
- Build the skirt as one low-res mesh so distant ridgelines are real. It is not walkable.
- `terrain.heightAt(x, z)`: bilinear sample. `terrain.slopeAt(x, z, dirX, dirZ)`: signed grade in the direction of travel.
- Ground material: procedural color by slope and elevation plus a tiling detail texture so the ground doesn't look flat up close.
- Vegetation: instanced trees, density from seeded noise, sparser on steep slopes. No trunk collision in v1.
- Fog: distance fog, default visibility 150 m in "woods" preset and unlimited in "open" preset.
- Boundary: warn at 50 m from the edge of the playable area, stop at the edge.

## 6. Movement and pace

A pace is two steps. You count every time the left foot lands.

- **Calibration:** the user enters their real pace count per 100 m (default 65). `pace_length = 100 / count`.
- **Thumbstick locomotion:** left stick moves in the direction the head is facing. Base speed 1.3 m/s on flat ground.
- **Footfalls:** the app tracks distance traveled and fires a footfall each half pace. Left footfalls get a haptic pulse on the left controller and a slightly louder sound. That pulse is what the user counts.
- **Slope effects (toggle, on by default):**
  - Speed follows Tobler's hiking function, normalized to flat speed: `speed = base * exp(-3.5 * abs(grade + 0.05)) / exp(-3.5 * 0.05)`.
  - Stride shortens on slopes: `stride_factor = clamp(1 - 0.8 * max(grade, 0) - 0.4 * max(-grade, 0), 0.6, 1)`. These constants are tuning values for training feel, not a validated model. Expose them in settings.
  - Effect: on a hill your pace count per 100 m of map distance goes up, like it does outside.
- **Time compression:** 1x, 2x, 3x. Scales speed and footfall cadence together, so pace counts stay valid.
- **Turning:** physical turning is the default and the intended way to play (standing, swivel in place). Snap turn (30 degrees, right stick) is off by default.
- **Comfort:** vignette while moving, adjustable strength.

## 7. Tools

### 7.1 Compass (right hand)
- Hold right grip to bring the lensatic compass into the right hand.
- The dial rotates so its north arrow points to magnetic north. Reading is the magnetic azimuth of the compass's sighting axis, projected to horizontal.
- Dial shows degrees (inner, red) and mils (outer, black). Legible at arm's length and at the cheek.
- If the compass is tilted more than 15 degrees from level, the dial sticks. Toggle in settings.
- A bezel ring with a luminous line the user can rotate with the thumbstick while holding the compass, for presetting an azimuth.

### 7.2 Map (left hand)
- Hold left grip to bring the map board into the left hand. Board is 40 cm square showing `map.png`.
- With the compass put away, the right controller casts a short ray onto the map:
  - Trigger: place a pencil dot.
  - Trigger on a second dot: draw a line between them.
  - B on a dot: center the protractor overlay there, aligned to grid north. The user reads the grid azimuth off the protractor themselves.
  - The map edge has a printed scale. A movable paper strip measures distance along a line.
- **Assisted mode** (setting, off by default): selecting two dots shows grid azimuth, magnetic azimuth, and distance.
- The map never shows a "you are here" marker.

### 7.3 Pace beads (left wrist)
- 9 lower beads (100 m each) and 4 upper beads (1 km each).
- A button slides one lower bead. On the 10th press, lower beads reset and one upper bead slides.
- Each bead press is logged with a timestamp and true position for the AAR.

### 7.4 Score card (left wrist, X to toggle)
- Lists the assigned points with 8-digit grids, a blank for the code found at each, elapsed time, and time limit.

### 7.5 Controls summary

| Input | Action |
|---|---|
| Left stick | Move (head-relative) |
| Right stick | Snap turn if enabled. Rotates bezel while compass is held |
| Left grip | Hold map |
| Right grip | Hold compass |
| Right trigger | Pencil on map. Punch a stake within 2 m |
| A | Slide a pace bead |
| B | Protractor on selected dot |
| X | Toggle score card |
| Menu | Pause and settings |

Desktop: WASD, mouse look, M map, C compass, Space bead, E punch, Tab score card.

## 8. Courses

### 8.1 Course rules
- A course has a start point and N control points (default 4).
- Each control point is a stake with a placard code (letter plus number, such as "K7").
- The site also contains decoy stakes that belong to no assigned point. Walk sloppy and you'll find the wrong one.
- Stakes render only within 40 m (setting). This stands in for brush hiding them.
- Punching a stake records its code on the score card. No feedback on correctness until the course ends.
- The course ends when the user returns to start and ends it, or time runs out.
- Time limit and pass threshold are per-course settings.

### 8.2 `course.json`

```json
{
  "id": "example-01",
  "site": "example-site",
  "name": "Day course 1",
  "seed": 1234,
  "time_limit_min": 120,
  "pass_threshold": 3,
  "preset": "woods",
  "start": { "x": 1000, "z": 1000 },
  "points": [
    { "code": "K7", "x": 1420, "z": 760 }
  ],
  "decoys": [
    { "code": "B3", "x": 1380, "z": 900 }
  ]
}
```

Positions are scene coordinates in meters. Grids shown to the user are derived at runtime.

### 8.3 Generator
- Seeded random course generator: leg lengths 200 to 600 m, points at least 100 m from the boundary, local slope under 30 percent, at least 150 m between any two stakes.
- Authored courses can be dropped into `sites/<id>/courses/`.

### 8.4 Modes
- **Dead reckoning:** standard course as above.
- **Terrain association:** points placed on distinct features (hilltops, saddles, draws, spurs) found by analyzing the heightmap. Compass allowed, beads disabled.
- **Resection drill:** user is dropped at an unknown spot with landmark beacons visible on two or three known hilltops. Shoot azimuths, convert to back azimuths, plot, then mark your position on the map. Score is the error in meters.
- **Night (M5):** dark scene, red headlamp that lights the map, luminous compass markings, stakes visible at 10 m.

## 9. After-action review

Logged during a run: position every second, compass-out intervals, map-out intervals, bead presses, punches.

Shown at the end on a large table map (and in desktop mode):
- Actual track drawn over the map, with ideal straight legs.
- Per leg: ideal grid azimuth and distance, closest approach to the target, lateral drift at the point where you'd covered the leg distance, time.
- Pace: beads-claimed distance against true map distance for each leg, as a percent error.
- Result: points correct out of N, pass or fail, total time, total distance walked against ideal.
- Export the run as JSON. Stretch: export as GPX.

Run history and settings persist in `localStorage`, wrapped in try/catch. The app must work if storage is unavailable.

## 10. File layout

```
/index.html
/vendor/three/...
/src/main.js          session setup, loop, mode switching
/src/coords.js        scene <-> UTM <-> MGRS, azimuth math
/src/terrain.js       mesh build, heightAt, slopeAt
/src/vegetation.js    instanced trees
/src/locomotion.js    movement, footfalls, slope effects
/src/compass.js
/src/map.js           map board, pencil, protractor
/src/beads.js
/src/course.js        load, generate, stakes, scoring
/src/aar.js
/src/input.js         XR controllers and desktop fallback
/src/settings.js
/sites/<site-id>/site.json, height.bin, skirt.bin, map.png
/sites/<site-id>/courses/*.json
/tools/make_site.py
/tests/coords.test.js
/spec.md
```

## 11. Performance budget

Targets to measure against on the headset, not guarantees:
- 72 fps minimum, no sustained drops.
- Under 750k triangles in view.
- Under 100 draw calls.
- Fixed foveated rendering on.
- Trees: instanced, low-poly near, billboards beyond 60 m.
- One directional light, no real-time shadows in v1.

## 12. Milestones and acceptance

**M0: Pipeline and desktop viewer**
- `make_site.py` produces a complete site folder from a GeoTIFF.
- Desktop mode loads the site and you can fly over it.
- `coords.js` unit tests pass, including: north is 0, east is 90, a known scene position maps to the expected 8-digit grid, and grid-to-magnetic conversion works for both signs of G-M angle.

**M1: Walk in VR**
- Enter VR on the Quest 3, stand on the terrain at the correct height, walk with the stick.
- Left-foot haptics fire at the calibrated pace length. Walking 100 m of flat ground produces the calibrated count, within one pace.

**M2: Compass and map**
- Compass azimuth to a test beacon matches the computed magnetic azimuth within 1 degree.
- Map is readable in the headset. Dots, lines, and the protractor work.

**M3: Courses**
- Load a course, punch stakes, get a score. Beads and score card work. Generator produces valid courses from a seed.

**M4: AAR**
- Full review screen with track, per-leg stats, and JSON export.

**M5: Realism**
- Slope effects, woods and open presets, night mode, optional trunk collision, walk-in-place locomotion using headset vertical motion to detect steps.

**M6: Stretch**
- Shared course format with the iOS land nav trainer, so a course can be rehearsed in VR and then walked for real.
- Import a GPX track from a real walk and view it in the AAR.
- Automated DEM fetch in the pipeline.
- Land cover data driving tree density.

## 13. Risks and things to verify

- **WebGPURenderer in XR.** Confirm the current Three.js release runs an `immersive-vr` session with it on the Quest Browser. If not, use WebGLRenderer.
- **Map legibility.** Contour lines on a 4096 texture may shimmer or blur in the headset. May need mipmaps with anisotropic filtering, a larger board, or a zoom gesture.
- **Triangle count.** 500k triangles plus trees may be too much. Fallback is 6 m spacing or distance-based chunk LOD.
- **10 m DEM looks smooth.** Where no lidar exists, micro-terrain is missing and terrain association gets harder to practice honestly.
- **Motion comfort.** Long stick-walking sessions make some people sick. Vignette and walk-in-place are the mitigations.
- **Declination entry.** Hand-entered for now. A wrong sign silently ruins every azimuth, so the pipeline should print the resulting G-M angle and which way to convert.
- **Desktop emulation.** Meta's Immersive Web Emulator browser extension may help test XR input without the headset. Check that it's still maintained.

## 14. Notes for the coding agent

- Build in milestone order. Don't start a milestone until the previous one meets its acceptance checks.
- `coords.js` is pure functions with tests. Write the tests first.
- Every feature must work in desktop mode before it's tested in the headset.
- No build step, no bundler, no framework. If a dependency is needed, vendor it.
- Keep all tunable numbers (speeds, stride constants, visibility ranges) in `settings.js`.
- Never show the user their true position during a run. That's the whole point.
