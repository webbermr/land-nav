import { test } from 'node:test';
import assert from 'node:assert/strict';
import { declination, toAlbers5070, mgrsSquare, gridConvergence, decimalYear } from '../src/geo/geodesy.js';
import { readGeoTiff, writeGeoTiff, sampleRaster } from '../src/geo/tiff.js';
import { osmToFeatures, overpassQuery, siteLatLonBox } from '../src/geo/osm.js';
import { contourSegments, mapLayout } from '../src/topo-map.js';
import { instantSquare, fillHoles } from '../src/instant-site.js';
import { fromUtm } from '../src/utm.js';

const near = (a, b, eps, msg = '') => assert.ok(Math.abs(a - b) <= eps, `${msg} ${a} vs ${b} (±${eps})`);
const OCT11 = new Date(Date.UTC(2026, 9, 11));

test('WMM 2025 declination matches pygeomag (NOAA coefficients) to 0.001 degree', () => {
  // pygeomag 1.x with WMM_2025.COF, 11 October 2026, sea level.
  for (const [lat, lon, want] of [[38.764, -78.296, -9.986], [40.291394, -78.563919, -10.057], [47.6205, -122.3493, 14.877],
    [25.76, -80.19, -7.3884], [61.2, -149.9, 13.9839], [21.3, -157.8, 9.2709], [44, -69, -14.9031]]) {
    near(declination(lat, lon, OCT11), want, 0.001, `${lat},${lon}`);
  }
  near(decimalYear(new Date(Date.UTC(2026, 6, 2, 12))), 2026.5, 0.002);
});

test('NLCD Albers (EPSG:5070) matches pyproj to a millimetre', () => {
  const p = toAlbers5070(38.764, -78.296);
  near(p.x, 1515164.6263, 0.001); near(p.y, 1889999.9828, 0.001);
  const q = toAlbers5070(47.6205, -122.3493);
  near(q.x, -1968811.3000, 0.001); near(q.y, 3010986.2713, 0.001);
});

test('MGRS grid zone and 100 km square letters', () => {
  assert.deepEqual(mgrsSquare(38.764, -78.296), { gzd: '17S', sq: 'QC' });
  assert.deepEqual(mgrsSquare(40.291394, -78.563919), { gzd: '17T', sq: 'QE' });
  assert.deepEqual(mgrsSquare(38.85, -77.45), { gzd: '18S', sq: 'TJ' }); // the demo site
  assert.deepEqual(mgrsSquare(61.2, -149.9), { gzd: '06V', sq: 'UN' });
  assert.deepEqual(mgrsSquare(21.3, -157.8), { gzd: '04Q', sq: 'FJ' });
});

test('grid convergence matches make_site.py (Blue Knob: 1.5761 E)', () => {
  near(gridConvergence(17, true, 707070, 4462950), 1.5761, 0.0001);
});

test('GeoTIFF: write and read back a float raster, and sample it', async () => {
  const w = 5, h = 4, data = Float32Array.from({ length: w * h }, (_, i) => i * 1.5);
  const buf = writeGeoTiff(w, h, data, { origin: [1000, 2000], pixel: 10, nodata: -9999 });
  const r = await readGeoTiff(buf);
  assert.equal(r.width, 5); assert.equal(r.height, 4); assert.equal(r.nodata, -9999);
  assert.deepEqual([...r.data], [...data]);
  assert.deepEqual(r.toWorld(0.5, 0.5), { x: 1005, y: 1995 });
  assert.equal(sampleRaster(r, 1005, 1995, 'nearest'), 0);
  assert.equal(sampleRaster(r, 1015, 1985, 'nearest'), data[6]);
  near(sampleRaster(r, 1010, 1995), (data[0] + data[1]) / 2, 1e-6);
  assert.ok(Number.isNaN(sampleRaster(r, 900, 1995, 'nearest')));
  const bytes = await readGeoTiff(writeGeoTiff(2, 1, [41, 42], { float: false }));
  assert.deepEqual([...bytes.data], [41, 42]);
  assert.ok(bytes.data instanceof Uint8Array);
});

const SITE = {
  epsg: 32617, e_west: 731000, n_north: 4292000, size_m: 2000,
  skirt: { e_west: 729000, n_north: 4294000, size_m: 6000 },
};

test('OpenStreetMap to features: kinds, widths, closed areas, out-of-range ways dropped', () => {
  const ll = (dx, dz) => fromUtm(SITE.e_west + dx, SITE.n_north - dz, 17, true);
  const way = (id, tags, pts, nodes) => ({ type: 'way', id, tags, geometry: pts.map(([x, z]) => ll(x, z)), nodes });
  const osm = { elements: [
    way(1, { highway: 'secondary', name: 'Skyline Drive' }, [[100, 100], [900, 120]]),
    way(2, { highway: 'residential', surface: 'gravel' }, [[200, 200], [300, 260]]),
    way(3, { highway: 'path' }, [[400, 400], [500, 500]]),
    way(4, { waterway: 'stream' }, [[50, 900], [60, 1200]]),
    way(5, { building: 'yes' }, [[600, 600], [620, 600], [620, 620], [600, 620], [600, 600]], [1, 2, 3, 4, 1]),
    way(6, { highway: 'path' }, [[90000, 90000], [90010, 90010]]),
    { type: 'node', id: 7, tags: { natural: 'peak', name: 'Old Rag', ele: '1001' }, ...ll(1000, 1000) },
  ] };
  const f = osmToFeatures(osm, SITE);
  assert.deepEqual(f.lines.map((l) => [l.kind, l.width]), [['road', 7], ['track', 5], ['trail', 1.2], ['stream', 1.5]]);
  assert.equal(f.lines[0].name, 'Skyline Drive');
  assert.equal(f.areas.length, 1);
  assert.equal(f.areas[0].kind, 'building');
  assert.equal(f.areas[0].pts.length, 4); // closing point dropped
  assert.equal(f.points[0].kind, 'peak');
  near(f.lines[0].pts[0][0], 100, 0.02);
  near(f.lines[0].pts[0][1], 100, 0.02);
  const b = siteLatLonBox(SITE, 0);
  assert.ok(b.s < b.n && b.w < b.e);
  assert.match(overpassQuery(38.5, -78.4, 38.6, -78.3), /way\(38\.50000,-78\.40000,38\.60000,-78\.30000\)/);
});

test('contours: a cone gives closed rings at the right radius', () => {
  const grid = 41, spacing = 5;
  const h = new Float32Array(grid * grid);
  for (let r = 0; r < grid; r++) for (let c = 0; c < grid; c++) h[r * grid + c] = 100 - Math.hypot(c * spacing - 100, r * spacing - 100);
  const segs = contourSegments(h, grid, spacing, 70);
  assert.ok(segs.length > 40);
  for (let k = 0; k < segs.length; k += 2) near(Math.hypot(segs[k] - 100, segs[k + 1] - 100), 30, 0.6);
  assert.deepEqual(mapLayout(4096), { px: 4096, area: [323, 110, 3773, 3560] });
});

test('instant square: snapped like make_site.py, nudged into one 100 km square', () => {
  const ok = instantSquare(38.5515, -78.3155);
  assert.equal(ok.problems.length, 0);
  assert.equal(ok.eWest % 10, 0);
  // Right on a 100 km easting line: moved wholly to the centre's side of it.
  const sq = instantSquare(38.55, -78.4285);
  assert.equal(sq.problems.length, 0, sq.problems.join());
  assert.equal(Math.floor(sq.eWest / 1e5), Math.floor((sq.eWest + 1999) / 1e5));
});

test('fillHoles fills gaps from the neighbours', () => {
  const a = Float32Array.from([1, NaN, 3, NaN, NaN, NaN, 7, NaN, 9]);
  fillHoles(a, 3);
  assert.ok(a.every(Number.isFinite));
  near(a[4], 5, 2);
});
