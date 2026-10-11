#!/usr/bin/env python3
"""Turn an OpenStreetMap Overpass JSON export into sites/<id>/features.json, then
re-render the site's map with the features on it.

Roads, tracks, trails, streams, the campground outline, parking, buildings and a
few named points are kept, in scene metres (x east, z south from the NW corner).

    # 1. Export from Overpass (any mirror), for a box a little larger than the site:
    #    way(S,W,N,E)[~"^(highway|tourism|amenity|leisure|waterway|building|natural|landuse)$"~"."];
    #    node(S,W,N,E)[~"^(tourism|amenity|natural)$"~"."]; out geom;
    # 2. Convert:
    python3 tools/make_features.py --site shenandoah-matthews-arm --osm export.json

    # Or let it do both (tries a few public Overpass servers):
    python3 tools/make_features.py --site shenandoah-matthews-arm --fetch

OpenStreetMap data is (c) OpenStreetMap contributors, ODbL. The map margin says so.
"""

import argparse
import json
import sys
from pathlib import Path

from pyproj import Transformer

sys.path.insert(0, str(Path(__file__).resolve().parent))
import make_site  # noqa: E402

# Line features: OSM tag value -> (kind, width in metres).
HIGHWAYS = {
    'motorway': ('road', 9), 'trunk': ('road', 8), 'primary': ('road', 7.5), 'secondary': ('road', 7),
    'tertiary': ('road', 6), 'unclassified': ('road', 5), 'residential': ('road', 5), 'service': ('road', 4),
    'track': ('track', 3), 'path': ('trail', 1.2), 'footway': ('trail', 1.2), 'bridleway': ('trail', 1.5),
}
WATERWAYS = {'stream': ('stream', 1.5), 'river': ('stream', 6), 'ditch': ('stream', 1)}


# Public Overpass servers, tried in order. overpass-api.de often refuses busy
# periods; the others are community mirrors.
OVERPASS = [
    'https://overpass.kumi.systems/api/interpreter',
    'https://overpass-api.de/api/interpreter',
    'https://overpass.private.coffee/api/interpreter',
]
QUERY = ('[out:json][timeout:120];('
         'way({s},{w},{n},{e})[~"^(highway|tourism|amenity|leisure|waterway|building|natural|landuse)$"~"."];'
         'node({s},{w},{n},{e})[~"^(tourism|amenity|natural)$"~"."];);out geom;')


def fetch_osm(site, dest, margin_m=400):
    """Download the OSM export for a site's playable area plus a margin."""
    import time
    import urllib.parse
    import urllib.request
    to_ll = Transformer.from_crs(f"EPSG:{site['epsg']}", 'EPSG:4326', always_xy=True)
    e0, n1, size = site['e_west'] - margin_m, site['n_north'] + margin_m, site['size_m'] + 2 * margin_m
    lons, lats = zip(*[to_ll.transform(e, n) for e in (e0, e0 + size) for n in (n1, n1 - size)])
    q = QUERY.format(s=f'{min(lats):.5f}', w=f'{min(lons):.5f}', n=f'{max(lats):.5f}', e=f'{max(lons):.5f}')
    body = urllib.parse.urlencode({'data': q}).encode()
    errors = []
    # The public servers turn requests away when busy; it usually passes in a minute.
    for attempt in range(4):
        for url in OVERPASS:
            try:
                req = urllib.request.Request(url, data=body, headers={'User-Agent': 'land-nav-vr site builder'})
                with urllib.request.urlopen(req, timeout=180) as res:
                    data = res.read()
                if json.loads(data).get('elements') is None:
                    raise ValueError('no elements in the reply')
                Path(dest).write_bytes(data)
                return dest
            except Exception as exc:  # noqa: BLE001 - any failure: try the next server
                errors.append(f'{url}: {exc}')
        if attempt < 3:
            time.sleep(15 * 2 ** attempt)
    raise SystemExit('Could not download OpenStreetMap data:\n  ' + '\n  '.join(errors[-3:]))


def area_kind(tags):
    if tags.get('tourism') in ('camp_site', 'caravan_site'):
        return 'campground'
    if tags.get('amenity') == 'parking':
        return 'parking'
    if tags.get('amenity') in ('toilets', 'shelter') or 'building' in tags:
        return 'building'
    if tags.get('amenity') == 'theatre' or tags.get('leisure') == 'pitch':
        return 'clearing'
    if tags.get('landuse') == 'grass' or tags.get('natural') in ('grassland', 'heath'):
        return 'clearing'
    if tags.get('natural') == 'water':
        return 'water'
    return None


def main(argv=None):
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument('--site', required=True)
    src = p.add_mutually_exclusive_group(required=True)
    src.add_argument('--osm', help='Overpass JSON with geometry (out geom)')
    src.add_argument('--fetch', action='store_true', help='Download it from a public Overpass server')
    p.add_argument('--out', default=str(Path(__file__).resolve().parent.parent / 'sites'))
    a = p.parse_args(argv)

    site_dir = Path(a.out) / a.site
    site = json.loads((site_dir / 'site.json').read_text())
    if a.fetch:
        print('Downloading OpenStreetMap data ...')
        a.osm = str(fetch_osm(site, site_dir / '.osm.json'))
    osm = json.loads(Path(a.osm).read_text())
    if a.fetch:
        Path(a.osm).unlink()
    to_utm = Transformer.from_crs('EPSG:4326', f"EPSG:{site['epsg']}", always_xy=True)
    sk = site['skirt']
    # Keep anything that touches the skirt area; drop the rest.
    lo_x, hi_x = sk['e_west'] - site['e_west'], sk['e_west'] - site['e_west'] + sk['size_m']
    lo_z, hi_z = site['n_north'] - sk['n_north'], site['n_north'] - sk['n_north'] + sk['size_m']

    def scene(lat, lon):
        e, n = to_utm.transform(lon, lat)
        return [round(e - site['e_west'], 2), round(site['n_north'] - n, 2)]

    def touches(pts):
        return any(lo_x <= x <= hi_x and lo_z <= z <= hi_z for x, z in pts)

    lines, areas, points = [], [], []
    for el in osm.get('elements', []):
        tags = el.get('tags', {})
        name = tags.get('name')
        if el['type'] == 'node':
            kind = 'peak' if tags.get('natural') == 'peak' else 'viewpoint' if tags.get('tourism') == 'viewpoint' else None
            if kind:
                x, z = scene(el['lat'], el['lon'])
                points.append({'kind': kind, 'name': name, 'x': x, 'z': z, **({'ele': tags['ele']} if 'ele' in tags else {})})
            continue
        geom = el.get('geometry') or []
        if len(geom) < 2:
            continue
        pts = [scene(g['lat'], g['lon']) for g in geom]
        if not touches(pts):
            continue
        closed = el.get('nodes', [None])[0] == el.get('nodes', [None])[-1] if el.get('nodes') else pts[0] == pts[-1]
        kind = area_kind(tags)
        if kind and (closed or pts[0] == pts[-1] or len(pts) > 3):
            areas.append({'kind': kind, 'name': name, 'pts': pts[:-1] if pts[0] == pts[-1] else pts})
            continue
        if 'highway' in tags and tags['highway'] in HIGHWAYS:
            k, w = HIGHWAYS[tags['highway']]
            surface = tags.get('surface')
            if k == 'road' and surface in ('unpaved', 'gravel', 'dirt', 'ground', 'compacted'):
                k = 'track'
            lines.append({'kind': k, 'name': name, 'width': w, 'surface': surface, 'osm': tags['highway'], 'pts': pts})
        elif 'waterway' in tags and tags['waterway'] in WATERWAYS:
            k, w = WATERWAYS[tags['waterway']]
            lines.append({'kind': k, 'name': name, 'width': w, 'pts': pts})

    features = {
        'source': 'OpenStreetMap contributors, ODbL (openstreetmap.org/copyright)',
        'osm_timestamp': osm.get('osm3s', {}).get('timestamp_osm_base'),
        'lines': lines,
        'areas': areas,
        'points': points,
    }
    (site_dir / 'features.json').write_text(json.dumps(features, separators=(',', ':')) + '\n')
    # Tell the app the file exists (sites without it don't request it).
    if not site.get('features'):
        site['features'] = True
        (site_dir / 'site.json').write_text(json.dumps(site, indent=2) + '\n')
    kinds = {}
    for f in lines + areas + points:
        kinds[f['kind']] = kinds.get(f['kind'], 0) + 1
    print(f"Wrote {site_dir / 'features.json'}: " + ', '.join(f'{v} {k}' for k, v in sorted(kinds.items())))

    print('Re-rendering map.png with features ...')
    make_site.rerender_map(site_dir)
    print('Done.')


if __name__ == '__main__':
    main()
