// Roads, trails, streams, buildings and the rest from OpenStreetMap, for a site
// built in the browser: the Overpass query and the conversion to features.json's
// shape. A port of tools/make_features.py; keep the two in step.
//
// OpenStreetMap data is (c) OpenStreetMap contributors, ODbL.
import { toUtm, fromUtm } from '../utm.js';

// Line features: OSM tag value -> [kind, width in metres].
const HIGHWAYS = {
  motorway: ['road', 9], trunk: ['road', 8], primary: ['road', 7.5], secondary: ['road', 7],
  tertiary: ['road', 6], unclassified: ['road', 5], residential: ['road', 5], service: ['road', 4],
  track: ['track', 3], path: ['trail', 1.2], footway: ['trail', 1.2], bridleway: ['trail', 1.5],
};
const WATERWAYS = { stream: ['stream', 1.5], river: ['stream', 6], ditch: ['stream', 1] };

export const OVERPASS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
];

export function overpassQuery(s, w, n, e) {
  const box = `${s.toFixed(5)},${w.toFixed(5)},${n.toFixed(5)},${e.toFixed(5)}`;
  return `[out:json][timeout:90];(way(${box})[~"^(highway|tourism|amenity|leisure|waterway|building|natural|landuse)$"~"."];`
    + `node(${box})[~"^(tourism|amenity|natural)$"~"."];);out geom;`;
}

// The lat/lon box of a site's playable area plus a margin.
export function siteLatLonBox(site, marginM = 400) {
  const zone = site.epsg % 100, north = Math.floor(site.epsg / 100) === 326;
  const e0 = site.e_west - marginM, n1 = site.n_north + marginM, size = site.size_m + 2 * marginM;
  const pts = [[e0, n1], [e0 + size, n1], [e0, n1 - size], [e0 + size, n1 - size]].map(([e, n]) => fromUtm(e, n, zone, north));
  return {
    s: Math.min(...pts.map((p) => p.lat)), n: Math.max(...pts.map((p) => p.lat)),
    w: Math.min(...pts.map((p) => p.lon)), e: Math.max(...pts.map((p) => p.lon)),
  };
}

function areaKind(tags) {
  if (tags.tourism === 'camp_site' || tags.tourism === 'caravan_site') return 'campground';
  if (tags.amenity === 'parking') return 'parking';
  if (tags.amenity === 'toilets' || tags.amenity === 'shelter' || 'building' in tags) return 'building';
  if (tags.amenity === 'theatre' || tags.leisure === 'pitch') return 'clearing';
  if (tags.landuse === 'grass' || tags.natural === 'grassland' || tags.natural === 'heath') return 'clearing';
  if (tags.natural === 'water') return 'water';
  return null;
}

// Overpass JSON (out geom) -> { source, lines, areas, points } in scene metres.
export function osmToFeatures(osm, site) {
  const zone = site.epsg % 100;
  const sk = site.skirt;
  const loX = sk.e_west - site.e_west, hiX = loX + sk.size_m;
  const loZ = site.n_north - sk.n_north, hiZ = loZ + sk.size_m;
  const r2 = (v) => Math.round(v * 100) / 100;
  const scene = (lat, lon) => {
    const u = toUtm(lat, lon, zone);
    return [r2(u.e - site.e_west), r2(site.n_north - u.n)];
  };
  const touches = (pts) => pts.some(([x, z]) => x >= loX && x <= hiX && z >= loZ && z <= hiZ);
  const lines = [], areas = [], points = [];
  for (const el of osm.elements || []) {
    const tags = el.tags || {};
    const name = tags.name ?? null;
    if (el.type === 'node') {
      const kind = tags.natural === 'peak' ? 'peak' : tags.tourism === 'viewpoint' ? 'viewpoint' : null;
      if (kind) {
        const [x, z] = scene(el.lat, el.lon);
        points.push({ kind, name, x, z, ...('ele' in tags ? { ele: tags.ele } : {}) });
      }
      continue;
    }
    const geom = el.geometry || [];
    if (geom.length < 2) continue;
    const pts = geom.map((g) => scene(g.lat, g.lon));
    if (!touches(pts)) continue;
    const same = pts[0][0] === pts.at(-1)[0] && pts[0][1] === pts.at(-1)[1];
    const closed = el.nodes ? el.nodes[0] === el.nodes.at(-1) : same;
    const kind = areaKind(tags);
    if (kind && (closed || same || pts.length > 3)) {
      areas.push({ kind, name, pts: same ? pts.slice(0, -1) : pts });
      continue;
    }
    if (tags.highway in HIGHWAYS) {
      let [k, w] = HIGHWAYS[tags.highway];
      const surface = tags.surface ?? null;
      if (k === 'road' && ['unpaved', 'gravel', 'dirt', 'ground', 'compacted'].includes(surface)) k = 'track';
      lines.push({ kind: k, name, width: w, surface, osm: tags.highway, pts });
    } else if (tags.waterway in WATERWAYS) {
      const [k, w] = WATERWAYS[tags.waterway];
      lines.push({ kind: k, name, width: w, pts });
    }
  }
  return {
    source: 'OpenStreetMap contributors, ODbL (openstreetmap.org/copyright)',
    osm_timestamp: osm.osm3s?.timestamp_osm_base ?? null,
    lines, areas, points,
  };
}

// Ask the public Overpass servers in turn. Returns the parsed JSON.
export async function fetchOsm(site, { signal } = {}) {
  const b = siteLatLonBox(site);
  const body = new URLSearchParams({ data: overpassQuery(b.s, b.w, b.n, b.e) });
  const errors = [];
  for (const url of OVERPASS) {
    try {
      const res = await fetch(url, { method: 'POST', body, signal });
      if (!res.ok) throw new Error(`${res.status}`);
      const j = await res.json();
      if (!Array.isArray(j.elements)) throw new Error('no elements');
      return j;
    } catch (err) {
      if (signal?.aborted) throw err;
      errors.push(`${new URL(url).host}: ${err.message}`);
    }
  }
  throw new Error(`OpenStreetMap servers busy (${errors.join('; ')})`);
}
