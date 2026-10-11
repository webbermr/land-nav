#!/usr/bin/env python3
"""Add real tree cover to a site from the National Land Cover Database.

Downloads NLCD 2021 land cover (one class per 30 m cell) and NLCD 2021 tree canopy
cover (percent per 30 m cell) for the playable area, resamples both onto a 10 m
grid aligned with the site, and writes:

    sites/<id>/landcover.bin   grid*grid class bytes, then grid*grid canopy bytes
                               (0-100), row 0 north, column 0 west
    site.json "landcover"      { grid, spacing_m, source, year, summary }

The app then places forest, fields and conifers where they really are, instead of
from noise (src/landcover.js).

    python3 tools/make_landcover.py --site shenandoah-matthews-arm

NLCD is public domain (USGS and MRLC; tree canopy by the USDA Forest Service).
"""

import argparse
import json
import sys
from pathlib import Path

import numpy as np
import rasterio
from rasterio.transform import from_origin
from rasterio.warp import Resampling, reproject

sys.path.insert(0, str(Path(__file__).resolve().parent))
import fetch_usgs  # noqa: E402

SPACING = 10
# NLCD classes, grouped for the summary line.
GROUPS = {
    "forest": (41, 42, 43), "shrub": (51, 52), "grass/field": (71, 72, 73, 74, 81, 82),
    "developed": (21, 22, 23, 24), "water": (11, 12), "wetland": (90, 95), "barren": (31,),
}


def resample(site, lc_path, tcc_path, spacing=SPACING):
    """Land cover classes (nearest) and canopy percent (bilinear) on the site's grid,
    whose sample (row, col) sits at (e_west + col*spacing, n_north - row*spacing)."""
    grid = int(round(site["size_m"] / spacing)) + 1
    dst_crs = f"EPSG:{site['epsg']}"
    transform = from_origin(site["e_west"] - spacing / 2, site["n_north"] + spacing / 2, spacing, spacing)

    with rasterio.open(lc_path) as src:
        classes = np.zeros((grid, grid), dtype=np.uint8)
        reproject(source=src.read(1), destination=classes, src_transform=src.transform, src_crs=src.crs,
                  src_nodata=0, dst_transform=transform, dst_crs=dst_crs, dst_nodata=0,
                  resampling=Resampling.nearest)
    with rasterio.open(tcc_path) as src:
        raw = src.read(1).astype(np.float32)
        raw[raw > 100] = np.nan  # 254 and 255 mark no data
        canopy = np.full((grid, grid), np.nan, dtype=np.float32)
        reproject(source=raw, destination=canopy, src_transform=src.transform, src_crs=src.crs,
                  src_nodata=np.nan, dst_transform=transform, dst_crs=dst_crs, dst_nodata=np.nan,
                  resampling=Resampling.bilinear)
    canopy = np.nan_to_num(canopy, nan=0.0)
    return classes, np.clip(np.rint(canopy), 0, 100).astype(np.uint8)


def summary(classes):
    total = classes.size
    out = {}
    for name, codes in GROUPS.items():
        share = float(np.isin(classes, codes).sum()) / total
        if share > 0:
            out[name] = round(share, 3)
    return out


def write(site_dir, site, classes, canopy, spacing=SPACING):
    grid = classes.shape[0]
    (site_dir / "landcover.bin").write_bytes(classes.tobytes() + canopy.tobytes())
    site["landcover"] = {
        "grid": grid,
        "spacing_m": spacing,
        "year": 2021,
        "source": "NLCD 2021 Land Cover and Tree Canopy Cover (USGS, MRLC, USDA Forest Service)",
        "summary": summary(classes),
        "mean_canopy": round(float(canopy.mean()) / 100, 3),
    }
    (site_dir / "site.json").write_text(json.dumps(site, indent=2) + "\n")


def main(argv=None):
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--site", required=True)
    p.add_argument("--lc", help="NLCD land cover GeoTIFF (skips the download)")
    p.add_argument("--tcc", help="NLCD tree canopy GeoTIFF (skips the download)")
    p.add_argument("--cache", help="Where downloads are kept (default ~/.cache/land-nav)")
    p.add_argument("--out", default=str(Path(__file__).resolve().parent.parent / "sites"))
    a = p.parse_args(argv)

    site_dir = Path(a.out) / a.site
    site = json.loads((site_dir / "site.json").read_text())
    if a.lc and a.tcc:
        lc, tcc = a.lc, a.tcc
    else:
        from pyproj import Transformer
        to_ll = Transformer.from_crs(f"EPSG:{site['epsg']}", "EPSG:4326", always_xy=True)
        e0, n1, size = site["e_west"], site["n_north"], site["size_m"]
        lon0, lat1 = to_ll.transform(e0, n1)
        lon1, lat0 = to_ll.transform(e0 + size, n1 - size)
        print("Downloading NLCD 2021 ...")
        lc, tcc = fetch_usgs.fetch_nlcd(min(lon0, lon1), min(lat0, lat1), max(lon0, lon1), max(lat0, lat1),
                                        Path(a.cache) if a.cache else fetch_usgs.default_cache())
    classes, canopy = resample(site, lc, tcc)
    if not classes.any():
        raise SystemExit("The land cover download has no data for this area (NLCD covers the lower 48 states).")
    write(site_dir, site, classes, canopy)
    s = site["landcover"]
    print(f"Wrote {site_dir / 'landcover.bin'}: {s['grid']} x {s['grid']} at {SPACING} m")
    print("  " + ", ".join(f"{k} {v:.0%}" for k, v in s["summary"].items()) + f"; mean canopy {s['mean_canopy']:.0%}")


if __name__ == "__main__":
    main()
