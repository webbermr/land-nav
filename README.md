# Land Nav VR

A WebXR land navigation trainer for the Meta Quest 3 browser. You stand on real terrain built from USGS elevation data, plot points on a topo map, shoot azimuths with a lensatic compass, count paces, and find stakes. The full design is in [spec.md](spec.md).

## Status

**M0 (pipeline and desktop viewer): done.** You can build a site from a GeoTIFF and fly or walk over it in a desktop browser. VR, compass, map tools, courses and the AAR come in M1 onward.

The bundled site, `demo-synthetic`, is procedural terrain placed at a real UTM location for testing. It is not a real place, and its map says so. Swap in a real site once one is picked (spec section 1).

## Run it

No build step. Serve the folder over HTTP and open it:

```sh
python3 -m http.server 8080
# then open http://localhost:8080/
```

Options go in the query string: `?site=<id>` picks a site folder, `?debug` shows your true scene position and heading in the HUD. Debug is for development only. The app never shows position during a run.

Desktop controls: click to capture the mouse, WASD to move, Shift for faster, V toggles fly and walk, R and F fly up and down, G switches between the woods and open presets, H hides the help panel.

WebXR needs HTTPS, so testing on the headset means GitHub Pages or another HTTPS host.

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
npm test                                              # coords.js and heightfield.js (Node 20+)
python3 -m unittest discover -s tests -p 'test_*.py'  # pipeline
```

The pipeline test builds a site from a tilted-plane DEM where the right answer is known everywhere, then checks that `height.bin` samples land on the exact UTM grid points with row 0 north and column 0 west.

## Layout

```
index.html            entry point, import map
src/coords.js         scene <-> UTM <-> MGRS, azimuth and declination math (pure, tested)
src/heightfield.js    height decode, bilinear heightAt, slopeAt (pure, tested)
src/terrain.js        site loading, chunked terrain mesh, skirt
src/input.js          desktop input (XR controllers land in M1)
src/settings.js       every tunable number, persisted when storage allows
src/main.js           renderer, loop, fly/walk modes
sites/<id>/           site.json, height.bin, skirt.bin, map.png, courses/
tools/make_site.py    DEM GeoTIFF -> site folder
vendor/three/         three.js r186, unmodified
```

## Notes and deviations from the spec

- **Renderer:** WebGLRenderer, not WebGPURenderer. WebGL is the proven WebXR path on the Quest Browser and nothing here needs WebGPU. The spec allows this fallback; it's worth revisiting after M1 runs on the headset.
- **site.json** carries a few extra fields beyond the spec's example: the skirt's own origin and elevation range, the map's pixel layout (`map.area` is the terrain square inside `map.png`), EPSG code, center lat/lon and source file names.
- **Desktop fly keys** are R and F because the spec reserves E for punching a stake.
