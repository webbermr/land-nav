#!/usr/bin/env python3
"""Write a synthetic DEM GeoTIFF for testing the pipeline without downloading USGS data.

The terrain is procedural (ridges, a valley, hills, noise). It is placed at a real
UTM location only so the coordinate math has something to chew on. It is not a
real place.

    python3 tools/make_synthetic_dem.py --lat 38.85 --lon -77.45 --out /tmp/synthetic.tif
"""

import argparse
import math

import numpy as np
import rasterio
from pyproj import CRS, Transformer
from rasterio.transform import from_origin


def value_noise(shape, cell, rng):
    """Smooth value noise: random lattice values, bicubic-ish (smoothstep) interpolation."""
    h, w = shape
    gh, gw = h // cell + 2, w // cell + 2
    lattice = rng.random((gh, gw))
    y = np.arange(h) / cell
    x = np.arange(w) / cell
    y0 = np.floor(y).astype(int)
    x0 = np.floor(x).astype(int)
    ty = y - y0
    tx = x - x0
    ty = ty * ty * (3 - 2 * ty)
    tx = tx * tx * (3 - 2 * tx)
    a = lattice[y0][:, x0]
    b = lattice[y0][:, x0 + 1]
    c = lattice[y0 + 1][:, x0]
    d = lattice[y0 + 1][:, x0 + 1]
    top = a + (b - a) * tx[None, :]
    bot = c + (d - c) * tx[None, :]
    return top + (bot - top) * ty[:, None]


def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--lat", type=float, required=True)
    p.add_argument("--lon", type=float, required=True)
    p.add_argument("--size", type=float, default=8000, help="Side length in metres (default 8000)")
    p.add_argument("--res", type=float, default=2, help="Pixel size in metres (default 2)")
    p.add_argument("--seed", type=int, default=7)
    p.add_argument("--out", required=True)
    a = p.parse_args()

    zone = int(math.floor((a.lon + 180) / 6)) + 1
    crs = CRS.from_epsg((32600 if a.lat >= 0 else 32700) + zone)
    ce, cn = Transformer.from_crs("EPSG:4326", crs, always_xy=True).transform(a.lon, a.lat)

    n = int(a.size / a.res)
    rng = np.random.default_rng(a.seed)
    xs = (np.arange(n) - n / 2) * a.res  # metres east of centre
    zs = (np.arange(n) - n / 2) * a.res  # metres south of centre
    X, Z = np.meshgrid(xs, zs)

    h = np.full((n, n), 90.0)
    # Fractal noise for rolling ground and micro-terrain.
    for cell_m, amp in ((1600, 45), (700, 22), (300, 9), (120, 3.5), (40, 1.2), (12, 0.35)):
        h += amp * (value_noise((n, n), max(2, int(cell_m / a.res)), rng) - 0.5) * 2
    # A NE-trending ridge with a saddle.
    d_ridge = (X * 0.6 - Z * 0.8 - 300) / 260
    saddle = 1 - 0.45 * np.exp(-((X * 0.8 + Z * 0.6 - 250) / 220) ** 2)
    h += 55 * np.exp(-d_ridge**2) * saddle
    # Two distinct hilltops.
    for hx, hz, r, ht in ((-650, 520, 220, 38), (720, -480, 260, 46)):
        h += ht * np.exp(-((X - hx) ** 2 + (Z - hz) ** 2) / (2 * r * r))
    # A meandering valley cutting roughly N-S, with spurs and draws on its flanks.
    meander = 180 * np.sin(Z / 700) + 60 * np.sin(Z / 210)
    h -= 30 * np.exp(-((X + 900 - meander) / 160) ** 2)

    transform = from_origin(ce - a.size / 2, cn + a.size / 2, a.res, a.res)
    with rasterio.open(
        a.out, "w", driver="GTiff", height=n, width=n, count=1, dtype="float32",
        crs=crs, transform=transform, nodata=-9999.0, compress="deflate",
    ) as dst:
        dst.write(h.astype(np.float32), 1)
    print(f"Wrote {a.out}: {n}x{n} at {a.res} m, {h.min():.1f}..{h.max():.1f} m, EPSG:{crs.to_epsg()}")


if __name__ == "__main__":
    main()
