#!/usr/bin/env python3
"""Download elevation and land cover for a site from public USGS services.

Elevation comes from the 3DEP elevation image service, which cuts out exactly the
box asked for, in the site's UTM zone, from the best data it has (1 m lidar where
it exists, coarser elsewhere). That is far smaller than whole 10 km lidar tiles.
The National Map product API lists which lidar surveys cover the area, for the
site's source list.

Land cover is the 2021 National Land Cover Database (class per 30 m cell) and the
2021 NLCD Tree Canopy Cover (percent per 30 m cell), from the MRLC web coverage
service.

Used by make_site.py (--fetch-dem) and make_landcover.py. Standard library only
for the HTTP side; rasterio and pyproj do the geometry.

    python3 tools/fetch_usgs.py --lat 38.764 --lon -78.296 --size 2000 --out /tmp/dem
"""

import argparse
import json
import math
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

TDEP_EXPORT = "https://elevation.nationalmap.gov/arcgis/rest/services/3DEPElevation/ImageServer/exportImage"
TNM_PRODUCTS = "https://tnmaccess.nationalmap.gov/api/v1/products"
MRLC_WCS = "https://www.mrlc.gov/geoserver/ows"
NLCD_LAND_COVER = "mrlc_download__NLCD_2021_Land_Cover_L48"
NLCD_TREE_CANOPY = "mrlc_download__nlcd_tcc_conus_2021_v2021-4"
NLCD_CRS = "EPSG:5070"  # CONUS Albers, the NLCD's native grid
MAX_PX = 4000           # keep each elevation request well inside the service limit
USER_AGENT = "land-nav-vr site builder (github.com/webbermr/land-nav)"


def http_get(url, params, dest=None, retries=4, timeout=180):
    """GET url?params (a list value repeats the parameter). Writes to dest if given,
    else returns the body. Retries with backoff on network errors and 5xx (these
    services are occasionally slow)."""
    full = f"{url}?{urllib.parse.urlencode(params, doseq=True, safe=',():/')}"
    req = urllib.request.Request(full, headers={"User-Agent": USER_AGENT})
    for attempt in range(retries + 1):
        try:
            with urllib.request.urlopen(req, timeout=timeout) as res:
                body = res.read()
                ctype = res.headers.get("Content-Type", "")
            if dest is not None and ("xml" in ctype or "json" in ctype):
                # An error document where an image was expected.
                raise RuntimeError(f"{url} returned {ctype}: {body[:300]!r}")
            if dest is None:
                return body
            Path(dest).write_bytes(body)
            return dest
        except (OSError, RuntimeError) as exc:
            # A 4xx is our request's fault; asking again won't help.
            client_error = isinstance(exc, urllib.error.HTTPError) and 400 <= exc.code < 500
            if attempt == retries or client_error:
                raise RuntimeError(f"Download failed after {retries + 1} tries: {full}\n  {exc}") from exc
            time.sleep(2 ** (attempt + 1))
    return None


def tiles(west, south, east, north, res, max_px=MAX_PX):
    """Split a box into requests of at most max_px pixels a side at res metres."""
    step = max_px * res
    out = []
    y = north
    while y > south + 1e-6:
        y0 = max(south, y - step)
        x = west
        while x < east - 1e-6:
            x1 = min(east, x + step)
            out.append((x, y0, x1, y))
            x = x1
        y = y0
    return out


def export_dem(epsg, west, south, east, north, res, out_dir, tag):
    """Elevation for a UTM box at res metres, as one or more GeoTIFFs (float32
    metres). Cached by box and resolution."""
    out_dir = Path(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    paths = []
    for i, (x0, y0, x1, y1) in enumerate(tiles(west, south, east, north, res)):
        w, h = round((x1 - x0) / res), round((y1 - y0) / res)
        dest = out_dir / f"3dep_{tag}_{epsg}_{x0:.0f}_{y0:.0f}_{x1:.0f}_{y1:.0f}_{res:g}m.tif"
        if not dest.exists():
            print(f"  3DEP {tag} {i + 1}: {w} x {h} px at {res:g} m ...")
            http_get(TDEP_EXPORT, {
                "bbox": f"{x0},{y0},{x1},{y1}", "bboxSR": epsg, "imageSR": epsg,
                "size": f"{w},{h}", "format": "tiff", "pixelType": "F32",
                "noDataInterpretation": "esriNoDataMatchAny",
                "interpolation": "RSP_BilinearInterpolation", "f": "image",
            }, dest)
        paths.append(dest)
    return paths


def lidar_surveys(lon0, lat0, lon1, lat1):
    """Names of the 1 m lidar surveys covering a lat/lon box, newest first. Best
    effort: an empty list if the product API is unreachable."""
    try:
        body = http_get(TNM_PRODUCTS, {
            "datasets": "Digital Elevation Model (DEM) 1 meter",
            "bbox": f"{lon0},{lat0},{lon1},{lat1}", "max": 50, "outputFormat": "JSON",
        }, retries=1, timeout=60)
        items = json.loads(body).get("items", [])
    except (RuntimeError, ValueError):
        return []
    items.sort(key=lambda it: it.get("publicationDate", ""), reverse=True)
    names = []
    for it in items:
        name = survey_name(it.get("title", ""))
        if name and name not in names:
            names.append(name)
    return names


def survey_name(title):
    """The survey part of a 1 m DEM tile title: what follows the tile index.
    "USGS 1 Meter 17 x73y430 VA_NorthernShenandoah_2020_D20" -> "VA_NorthernShenandoah_2020_D20"
    "USGS one meter x73y430 VA Shenandoah 2014" -> "VA Shenandoah 2014"
    """
    parts = title.split()
    for i, t in enumerate(parts):
        if re.fullmatch(r"x\d+y\d+", t):
            return " ".join(parts[i + 1:]) or title
    return title


def fetch_site_dem(epsg, e_west, n_north, size, spacing, s_e_west, s_n_north, skirt_size, skirt_spacing, cache):
    """Elevation for a site: the playable square at 1 m (finer than its grid, so the
    bilinear resample is faithful) and the skirt at its own spacing. Returns paths in
    priority order (playable first), for make_site's --dem."""
    pad = 2 * max(spacing, 1)
    play = export_dem(epsg, e_west - pad, n_north - size - pad, e_west + size + pad, n_north + pad, 1, cache, "play")
    spad = 2 * skirt_spacing
    skirt = export_dem(epsg, s_e_west - spad, s_n_north - skirt_size - spad,
                       s_e_west + skirt_size + spad, s_n_north + spad, skirt_spacing, cache, "skirt")
    return play + skirt


def fetch_nlcd(lon0, lat0, lon1, lat1, cache, pad_m=120):
    """NLCD 2021 land cover and tree canopy GeoTIFFs (EPSG:5070, 30 m) covering a
    lat/lon box plus a margin. Returns (land_cover_path, tree_canopy_path)."""
    from pyproj import Transformer
    to_albers = Transformer.from_crs("EPSG:4326", NLCD_CRS, always_xy=True)
    xs, ys = zip(*[to_albers.transform(lon, lat) for lon in (lon0, lon1) for lat in (lat0, lat1)])
    x0, x1 = math.floor(min(xs) - pad_m), math.ceil(max(xs) + pad_m)
    y0, y1 = math.floor(min(ys) - pad_m), math.ceil(max(ys) + pad_m)
    cache = Path(cache)
    cache.mkdir(parents=True, exist_ok=True)
    out = []
    for cov, tag in ((NLCD_LAND_COVER, "lc"), (NLCD_TREE_CANOPY, "tcc")):
        dest = cache / f"nlcd2021_{tag}_{x0}_{y0}_{x1}_{y1}.tif"
        if not dest.exists():
            print(f"  NLCD 2021 {'land cover' if tag == 'lc' else 'tree canopy'} ...")
            http_get(MRLC_WCS, {
                "service": "WCS", "version": "2.0.1", "request": "GetCoverage", "coverageId": cov,
                "subset": [f"X({x0},{x1})", f"Y({y0},{y1})"], "format": "image/geotiff",
            }, dest)
        out.append(dest)
    return tuple(out)


def default_cache():
    return Path.home() / ".cache" / "land-nav"


def main(argv=None):
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--lat", type=float, required=True)
    p.add_argument("--lon", type=float, required=True)
    p.add_argument("--size", type=float, default=2000, help="Square size in metres")
    p.add_argument("--res", type=float, default=1, help="Metres per pixel")
    p.add_argument("--out", default=str(default_cache()))
    a = p.parse_args(argv)
    from pyproj import Transformer
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    from make_site import utm_crs_for
    utm, _, _ = utm_crs_for(a.lat, a.lon)
    ce, cn = Transformer.from_crs("EPSG:4326", utm, always_xy=True).transform(a.lon, a.lat)
    epsg = int(utm.split(":")[1]) if isinstance(utm, str) else utm.to_epsg()
    h = a.size / 2
    for path in export_dem(epsg, ce - h, cn - h, ce + h, cn + h, a.res, a.out, "dem"):
        print(path)


if __name__ == "__main__":
    main()
