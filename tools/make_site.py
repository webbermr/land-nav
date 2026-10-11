#!/usr/bin/env python3
"""Turn one or more DEM GeoTIFFs into a Land Nav site folder.

Writes sites/<id>/site.json, height.bin, skirt.bin and map.png (spec section 5.2).

Example:
    python3 tools/make_site.py \\
        --dem USGS_1M_18_x28y431.tif \\
        --lat 38.866 --lon -77.459 \\
        --id bull-run --name "Bull Run" \\
        --declination -10.6 --declination-date 2026-10-01

Or let it download the elevation itself (USGS 3DEP; see tools/fetch_usgs.py), and
add real tree cover from the National Land Cover Database:

    python3 tools/make_site.py --fetch-dem --landcover \\
        --lat 38.764 --lon -78.296 --id my-site --name "My Site" \\
        --declination -10.0 --declination-date 2026-10-11

Declination comes from the NOAA magnetic field calculator for the site and date
(https://www.ngdc.noaa.gov/geomag/calculators/magcalc.shtml). Enter east as
positive, west as negative.

Dependencies: rasterio, numpy, pyproj, matplotlib, mgrs.
"""

import argparse
import json
import math
import sys
from pathlib import Path

import numpy as np

try:
    import mgrs
    import rasterio
    from pyproj import CRS, Transformer
    from rasterio.transform import from_origin
    from rasterio.warp import Resampling, reproject
except ImportError as exc:  # pragma: no cover
    sys.exit(f"Missing dependency: {exc.name}. Install with: pip install rasterio numpy pyproj matplotlib mgrs")


# ---------------------------------------------------------------------------
# Geometry helpers


def utm_crs_for(lat, lon):
    """UTM CRS for a point. Uses the standard 6-degree zones."""
    if 56 <= lat < 64 and 3 <= lon < 12 or lat >= 72:
        raise SystemExit("Norway/Svalbard UTM zone exceptions are not supported.")
    zone = int(math.floor((lon + 180) / 6)) + 1
    north = lat >= 0
    epsg = (32600 if north else 32700) + zone
    return CRS.from_epsg(epsg), zone, north


def snap(v, step):
    return math.floor(v / step + 0.5) * step


def mgrs_parts(m, lat, lon):
    """Return (gzd, 100km square ID) for a lat/lon."""
    s = m.toMGRS(lat, lon, MGRSPrecision=5)
    if isinstance(s, bytes):
        s = s.decode()
    s = s.replace(" ", "")
    # Format: zone digits + band letter + two square letters + 10 digits.
    gzd = s[:-12]
    sq = s[-12:-10]
    return gzd, sq


def check_single_square(to_ll, e_west, n_north, size):
    """Reject a playable area that crosses a UTM zone, GZD or 100 km square boundary."""
    e_east = e_west + size
    n_south = n_north - size
    if math.floor(e_west / 100000) != math.floor((e_east - 1e-6) / 100000) or math.floor(
        (n_south + 1e-6) / 100000
    ) != math.floor(n_north / 100000):
        raise SystemExit(
            "Playable area crosses a 100 km grid line. Move the center so the whole "
            f"{size:g} m square sits inside one 100 km square."
        )
    m = mgrs.MGRS()
    ids = set()
    # Check corners and edge midpoints; GZD band edges are lines of latitude.
    # Sample 0.5 m inside the edges: an edge lying exactly on a grid line is fine, but
    # the lat/lon round trip can land a hair over it and read as the neighbour.
    inset = 0.5
    for fx in (0, 0.5, 1):
        for fz in (0, 0.5, 1):
            e = e_west + inset + fx * (size - 2 * inset)
            n = n_north - inset - fz * (size - 2 * inset)
            lon, lat = to_ll.transform(e, n)
            ids.add(mgrs_parts(m, lat, lon))
    if len(ids) != 1:
        raise SystemExit(f"Playable area spans more than one MGRS grid zone or square: {sorted(ids)}")
    return ids.pop()


def grid_convergence_deg(to_ll, to_utm, e, n):
    """Angle of grid north from true north at (e, n), positive when grid north is east of true north.

    Computed numerically: step due north along the meridian and measure the grid
    azimuth of that step. True north's grid azimuth is the negative of convergence.
    """
    lon, lat = to_ll.transform(e, n)
    e2, n2 = to_utm.transform(lon, lat + 0.01)
    az_true_north_in_grid = math.degrees(math.atan2(e2 - e, n2 - n))
    return -az_true_north_in_grid


# ---------------------------------------------------------------------------
# Raster resampling


def resample_to_grid(dem_paths, dst_crs, e_west, n_north, spacing, grid):
    """Bilinear resample all DEMs onto a grid whose sample (row, col) sits at
    (e_west + col*spacing, n_north - row*spacing). Missing data is NaN."""
    dst = np.full((grid, grid), np.nan, dtype=np.float32)
    # Pixel-is-area transform whose pixel centres land on the sample points.
    transform = from_origin(e_west - spacing / 2, n_north + spacing / 2, spacing, spacing)
    for path in dem_paths:
        with rasterio.open(path) as src:
            part = np.full((grid, grid), np.nan, dtype=np.float32)
            src_nodata = src.nodata
            reproject(
                source=rasterio.band(src, 1),
                destination=part,
                src_transform=src.transform,
                src_crs=src.crs,
                src_nodata=src_nodata,
                dst_transform=transform,
                dst_crs=dst_crs,
                dst_nodata=np.nan,
                resampling=Resampling.bilinear,
            )
            # Some USGS tiles use huge negative sentinels without declaring nodata.
            part[part < -1000] = np.nan
            fill = np.isnan(dst) & ~np.isnan(part)
            dst[fill] = part[fill]
    return dst


def fill_nans(a, max_iter=500):
    """Fill NaN holes by repeatedly averaging valid 4-neighbours. Used for the skirt only."""
    a = a.copy()
    for _ in range(max_iter):
        mask = np.isnan(a)
        if not mask.any():
            return a
        padded = np.pad(a, 1, mode="edge")
        neigh = np.stack([padded[:-2, 1:-1], padded[2:, 1:-1], padded[1:-1, :-2], padded[1:-1, 2:]])
        valid = ~np.isnan(neigh)
        count = valid.sum(axis=0)
        total = np.where(valid, neigh, 0).sum(axis=0)
        grow = mask & (count > 0)
        a[grow] = total[grow] / count[grow]
        if not grow.any():
            break
    if np.isnan(a).any():
        a[np.isnan(a)] = np.nanmin(a) if not np.isnan(a).all() else 0.0
    return a


def quantize(a, lo, hi):
    span = max(hi - lo, 1e-6)
    q = np.round((a - lo) / span * 65535.0)
    return np.clip(q, 0, 65535).astype("<u2")


# ---------------------------------------------------------------------------
# Map rendering


def map_layout(map_px):
    """Pixel layout of map.png. The terrain area is a square; the rest is margin."""
    side = round(map_px * 3450 / 4096)
    left = (map_px - side) // 2
    top = round(map_px * 110 / 4096)
    return {"px": map_px, "area": [left, top, left + side, top + side]}


def draw_features(ax, fig, features, s, ppm, x0, y0, px, paper):
    """Roads, trails, streams, the campground and buildings, in topo-map style."""
    import matplotlib.pyplot as plt
    from matplotlib import patheffects

    halo = [patheffects.withStroke(linewidth=6 * s, foreground=paper)]
    area_style = {
        'campground': dict(facecolor='#cfe3b8', edgecolor='#2f7a2f', linewidth=2.5 * s, linestyle=(0, (6, 3)), alpha=0.85, zorder=1.5),
        'clearing': dict(facecolor='#e6ecc2', edgecolor='none', alpha=0.9, zorder=1.4),
        'parking': dict(facecolor='#c9c6c0', edgecolor='#555', linewidth=1.5 * s, zorder=3.6),
        'water': dict(facecolor='#9cc3e6', edgecolor='#2f6fb5', linewidth=1.5 * s, zorder=3.5),
        'building': dict(facecolor='#111', edgecolor='#111', linewidth=1 * s, zorder=3.9),
    }
    for f in features.get('areas', []):
        st = area_style.get(f['kind'])
        if st:
            ax.add_patch(plt.Polygon(f['pts'], closed=True, **st))
    for f in features.get('lines', []):
        xs = [p[0] for p in f['pts']]
        zs = [p[1] for p in f['pts']]
        k = f['kind']
        if k == 'stream':
            ax.plot(xs, zs, color='#2f6fb5', linewidth=2.4 * s, zorder=3.5, solid_capstyle='round')
        elif k == 'road' and f.get('osm') in ('motorway', 'trunk', 'primary', 'secondary'):
            ax.plot(xs, zs, color='#111', linewidth=8 * s, zorder=3.8, solid_capstyle='round')
            ax.plot(xs, zs, color='#d23a2a', linewidth=4.6 * s, zorder=3.81, solid_capstyle='round')
        elif k == 'road':
            ax.plot(xs, zs, color='#111', linewidth=6 * s, zorder=3.8, solid_capstyle='round')
            ax.plot(xs, zs, color='#fbfaf4', linewidth=3 * s, zorder=3.81, solid_capstyle='round')
        elif k == 'track':
            ax.plot(xs, zs, color='#111', linewidth=2.6 * s, linestyle=(0, (8, 3)), zorder=3.8)
        elif k == 'trail':
            ax.plot(xs, zs, color='#111', linewidth=2 * s, linestyle=(0, (3.5, 2.5)), zorder=3.8)
    # One label per named line, at the middle of its longest run.
    seen = set()
    for f in sorted(features.get('lines', []), key=lambda f: -len(f['pts'])):
        name = f.get('name')
        if not name or name.lower() in seen or f['kind'] == 'stream':
            continue
        pts = f['pts']
        length = sum(math.hypot(pts[i + 1][0] - pts[i][0], pts[i + 1][1] - pts[i][1]) for i in range(len(pts) - 1))
        if length < 250:
            continue
        seen.add(name.lower())
        half, acc = length / 2, 0
        for i in range(len(pts) - 1):
            seg = math.hypot(pts[i + 1][0] - pts[i][0], pts[i + 1][1] - pts[i][1])
            if acc + seg >= half:
                t = (half - acc) / seg if seg else 0
                mx = pts[i][0] + t * (pts[i + 1][0] - pts[i][0])
                mz = pts[i][1] + t * (pts[i + 1][1] - pts[i][1])
                ang = math.degrees(math.atan2(-(pts[i + 1][1] - pts[i][1]), pts[i + 1][0] - pts[i][0]))
                if ang > 90:
                    ang -= 180
                elif ang < -90:
                    ang += 180
                ax.text(mx, mz, name, fontsize=17 * s, rotation=ang, rotation_mode='anchor', ha='center', va='bottom',
                        color='#111', path_effects=halo, zorder=5, clip_on=True)
                break
            acc += seg
    for f in features.get('areas', []):
        if f['kind'] == 'campground' and f.get('name'):
            cx = sum(p[0] for p in f['pts']) / len(f['pts'])
            cz = sum(p[1] for p in f['pts']) / len(f['pts'])
            ax.text(cx, cz, f['name'], fontsize=19 * s, ha='center', va='center', color='#2f7a2f', fontweight='bold',
                    path_effects=halo, zorder=5, clip_on=True)
    for f in features.get('points', []):
        if f['kind'] == 'peak':
            ax.plot([f['x']], [f['z']], marker='^', color='#111', markersize=9 * s, zorder=5)
        elif f['kind'] == 'viewpoint':
            ax.plot([f['x']], [f['z']], marker='*', color='#111', markersize=12 * s, zorder=5)
        if f.get('name'):
            ax.text(f['x'] + 25, f['z'], f['name'], fontsize=16 * s, color='#111', va='center', path_effects=halo, zorder=5, clip_on=True)


def render_map(path, heights_abs, site, layout, contour_interval, index_interval, relief, features=None):
    import matplotlib

    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    from matplotlib import patheffects

    px = layout["px"]
    x0, y0, x1, y1 = layout["area"]
    area_px = x1 - x0
    size = site["size_m"]
    spacing = site["spacing_m"]
    grid = site["grid"]
    ppm = area_px / size  # pixels per metre
    s = px / 4096  # scale linework for non-default map sizes

    paper = "#f6f1e3"
    brown = "#9a5b2c"
    ink = "#1d1d1d"
    grid_blue = "#1f3f78"

    dpi = 100
    fig = plt.figure(figsize=(px / dpi, px / dpi), dpi=dpi, facecolor=paper)

    # Terrain axes in scene metres: x east, z south (inverted so north is up).
    ax = fig.add_axes([x0 / px, 1 - y1 / px, area_px / px, area_px / px])
    ax.set_xlim(0, size)
    ax.set_ylim(size, 0)
    ax.set_axis_off()
    ax.set_facecolor(paper)
    ax.add_patch(plt.Rectangle((0, 0), size, size, facecolor=paper, edgecolor="none", zorder=0))

    xs = np.arange(grid) * spacing
    zs = np.arange(grid) * spacing

    if relief:
        gy, gx = np.gradient(heights_abs, spacing)
        az, alt = math.radians(315), math.radians(45)
        slope = np.arctan(np.hypot(gx, gy))
        aspect = np.arctan2(-gx, gy)
        shade = np.sin(alt) * np.cos(slope) + np.cos(alt) * np.sin(slope) * np.cos(az - aspect)
        ax.imshow(
            shade, extent=(0, size, size, 0), cmap="gray", vmin=-0.2, vmax=1.2, alpha=0.25, zorder=1,
            interpolation="bilinear",
        )

    lo = math.floor(np.nanmin(heights_abs) / contour_interval) * contour_interval
    hi = math.ceil(np.nanmax(heights_abs) / contour_interval) * contour_interval
    levels = np.arange(lo, hi + contour_interval, contour_interval)
    is_index = np.isclose(np.mod(levels, index_interval), 0)
    minor = levels[~is_index]
    major = levels[is_index]

    if len(minor):
        ax.contour(xs, zs, heights_abs, levels=minor, colors=brown, linewidths=2.4 * s, zorder=2)
    if len(major):
        cs = ax.contour(xs, zs, heights_abs, levels=major, colors=brown, linewidths=5.0 * s, zorder=3)
        labels = ax.clabel(cs, fmt="%d", fontsize=26 * s, inline=True, inline_spacing=14 * s)
        for t in labels:
            t.set_color(brown)
            t.set_fontweight("bold")

    if features:
        draw_features(ax, fig, features, s, ppm, x0, y0, px, paper)

    # 1 km grid lines, labelled with the two principal digits.
    e_west, n_north = site["e_west"], site["n_north"]
    label_kw = dict(color=grid_blue, fontsize=44 * s, fontweight="bold")
    halo = [patheffects.withStroke(linewidth=8 * s, foreground=paper)]
    first_e = math.ceil(e_west / 1000) * 1000
    for e in range(first_e, int(e_west + size) + 1, 1000):
        x = e - e_west
        ax.plot([x, x], [0, size], color=grid_blue, linewidth=2.6 * s, zorder=4)
        lab = f"{(e // 1000) % 100:02d}"
        fig.text((x0 + x * ppm) / px, 1 - (y0 - 8 * s) / px, lab, ha="center", va="bottom", **label_kw)
        fig.text((x0 + x * ppm) / px, 1 - (y1 + 8 * s) / px, lab, ha="center", va="top", **label_kw)
    first_n = math.ceil((n_north - size) / 1000) * 1000
    for n in range(first_n, int(n_north) + 1, 1000):
        z = n_north - n
        ax.plot([0, size], [z, z], color=grid_blue, linewidth=2.6 * s, zorder=4)
        lab = f"{(n // 1000) % 100:02d}"
        fig.text((x0 - 14 * s) / px, 1 - (y0 + z * ppm) / px, lab, ha="right", va="center", **label_kw)
        fig.text((x1 + 14 * s) / px, 1 - (y0 + z * ppm) / px, lab, ha="left", va="center", **label_kw)

    # 100 m ticks along all four edges (outside the neatline, so they never hide contours).
    tick_kw = dict(color=grid_blue, linewidth=2.2 * s, clip_on=False, zorder=5)
    for e in range(math.ceil(e_west / 100) * 100, int(e_west + size) + 1, 100):
        x = e - e_west
        ln = 26 if e % 1000 == 0 else (18 if e % 500 == 0 else 12)
        d = ln * s / ppm
        ax.plot([x, x], [0, -d], **tick_kw)
        ax.plot([x, x], [size, size + d], **tick_kw)
    for n in range(math.ceil((n_north - size) / 100) * 100, int(n_north) + 1, 100):
        z = n_north - n
        ln = 26 if n % 1000 == 0 else (18 if n % 500 == 0 else 12)
        d = ln * s / ppm
        ax.plot([0, -d], [z, z], **tick_kw)
        ax.plot([size, size + d], [z, z], **tick_kw)

    ax.add_patch(plt.Rectangle((0, 0), size, size, fill=False, edgecolor=ink, linewidth=4 * s, zorder=6, clip_on=False))

    # ---- Margin (below the terrain area) ----
    mtop = y1 + 70 * s  # top of the margin content, in pixels from the top
    def fx(p):
        return p / px

    def fy(p):
        return 1 - p / px

    fig.text(fx(x0), fy(mtop), site["name"], ha="left", va="top", fontsize=64 * s, fontweight="bold", color=ink)
    sub = (
        f"{site['mgrs_gzd']} {site['mgrs_100km']}   UTM {site['utm_zone']}   "
        f"Contour interval {contour_interval:g} m, index every {index_interval:g} m"
    )
    fig.text(fx(x0), fy(mtop + 105 * s), sub, ha="left", va="top", fontsize=30 * s, color=ink)
    fig.text(
        fx(x0), fy(mtop + 155 * s), "Grid lines 1 km. Ticks every 100 m. Elevations in metres.",
        ha="left", va="top", fontsize=26 * s, color=ink,
    )
    if site.get("synthetic"):
        fig.text(
            fx(x0), fy(mtop + 200 * s), "SYNTHETIC TERRAIN - NOT A REAL PLACE",
            ha="left", va="top", fontsize=30 * s, color="#a01010", fontweight="bold",
        )
    elif features:
        fig.text(
            fx(x0), fy(mtop + 200 * s), "Roads, trails, streams and campground (c) OpenStreetMap contributors (ODbL)",
            ha="left", va="top", fontsize=22 * s, color=ink,
        )
        # Legend, between the scale bar and the declination diagram.
        lx, ly = x0 + 1880 * s, mtop + 40 * s
        lax = fig.add_axes([fx(lx), fy(ly + 330 * s), 120 * s / px, 330 * s / px])
        lax.set_xlim(0, 1); lax.set_ylim(5.5, -0.5); lax.set_axis_off()
        rows = [
            ('Paved road', [('#111', 8), ('#d23a2a', 4.6)], '-'),
            ('Road', [('#111', 6), ('#fbfaf4', 3)], '-'),
            ('Track', [('#111', 2.6)], (0, (8, 3))),
            ('Trail', [('#111', 2)], (0, (3.5, 2.5))),
            ('Stream', [('#2f6fb5', 2.4)], '-'),
        ]
        for i, (label, strokes, style) in enumerate(rows):
            for color, w in strokes:
                lax.plot([0.05, 0.95], [i, i], color=color, linewidth=w * s, linestyle=style)
            fig.text(fx(lx + 140 * s), fy(ly + (i + 0.5) * 60 * s), label, ha='left', va='center', fontsize=22 * s, color=ink)
        lax.add_patch(plt.Rectangle((0.05, 4.75), 0.9, 0.5, facecolor='#cfe3b8', edgecolor='#2f7a2f', linewidth=2 * s, linestyle=(0, (6, 3))))
        fig.text(fx(lx + 140 * s), fy(ly + 5.5 * 60 * s), 'Campground', ha='left', va='center', fontsize=22 * s, color=ink)

    # Scale bar: 0..1000 m, alternating 100 m blocks for the first 500 m.
    sb_left = x0
    sb_top = mtop + 250 * s
    sb_h = 22 * s
    sax = fig.add_axes([fx(sb_left), fy(sb_top + sb_h), 1000 * ppm / px, sb_h / px])
    sax.set_xlim(0, 1000)
    sax.set_ylim(0, 1)
    sax.set_axis_off()
    for i, (a, b) in enumerate([(0, 100), (100, 200), (200, 300), (300, 400), (400, 500), (500, 1000)]):
        sax.add_patch(plt.Rectangle((a, 0), b - a, 1, facecolor=ink if i % 2 == 0 else paper, edgecolor=ink, linewidth=2 * s))
    for m in (0, 100, 200, 300, 400, 500, 1000):
        fig.text(fx(sb_left + m * ppm), fy(sb_top + sb_h + 10 * s), str(m), ha="center", va="top", fontsize=24 * s, color=ink)
    fig.text(fx(sb_left + 1000 * ppm + 30 * s), fy(sb_top + sb_h / 2), "metres", ha="left", va="center", fontsize=24 * s, color=ink)
    scale_den = size / (0.40 * area_px / px)  # on the 40 cm board
    fig.text(
        fx(sb_left), fy(sb_top + sb_h + 60 * s), f"About 1:{snap(scale_den, 100):,.0f} on the 40 cm map board",
        ha="left", va="top", fontsize=24 * s, color=ink,
    )

    # Declination diagram (angles not to scale, values are).
    gm = site["gm_angle_deg"]
    conv = site["convergence_deg"]
    decl = site["declination_deg"]
    # Diagram on the left of the block, the numbers and conversion rules to its right.
    dcx = x1 - 1050 * s
    base = mtop + 380 * s
    length = 260 * s
    dax = fig.add_axes([fx(dcx - 160 * s), fy(base), 320 * s / px, (length + 60 * s) / px])
    dax.set_xlim(-160 * s, 160 * s)
    dax.set_ylim(0, length + 60 * s)
    dax.set_axis_off()

    def ray(angle_deg, label, style):
        a = math.radians(angle_deg)
        ex, ey = length * math.sin(a), length * math.cos(a)
        dax.plot([0, ex], [0, ey], color=ink, linewidth=3 * s, linestyle=style)
        dax.text(ex, ey + 10 * s, label, ha="center", va="bottom", fontsize=22 * s, color=ink, fontweight="bold")

    # Exaggerate small angles so the labels don't collide, but keep each line on its
    # true side of grid north, and keep MN and TN in their true order when they share
    # a side.
    def shown(v):
        return 0.0 if v == 0 else math.copysign(min(max(abs(v), 14), 30), v)

    a_mn, a_tn = shown(gm), shown(-conv)
    if a_mn * a_tn > 0 and abs(a_mn - a_tn) < 12:
        far, near = (a_mn, a_tn) if abs(gm) >= abs(conv) else (a_tn, a_mn)
        sign = math.copysign(1, far)
        near, far = sign * 14, sign * 28
        a_mn, a_tn = (far, near) if abs(gm) >= abs(conv) else (near, far)
    ray(0, "GN", "-")
    ray(a_mn, "MN", "-")
    ray(a_tn, "TN", ":")

    tx = dcx + 200 * s
    side = "east" if gm >= 0 else "west"
    mils = abs(gm) * 6400 / 360
    lines = [
        (f"G-M angle {abs(gm):.1f}\u00b0 {side} ({mils:.0f} mils)", 30, "bold"),
        ("Grid to magnetic: " + ("subtract" if gm >= 0 else "add") + " G-M angle", 24, "normal"),
        ("Magnetic to grid: " + ("add" if gm >= 0 else "subtract") + " G-M angle", 24, "normal"),
        (f"Declination {abs(decl):.1f}\u00b0 {'E' if decl >= 0 else 'W'} ({site.get('declination_date', '?')})", 22, "normal"),
        (f"Grid convergence {abs(conv):.1f}\u00b0 {'E' if conv >= 0 else 'W'}", 22, "normal"),
        ("Diagram angles not to scale", 20, "normal"),
    ]
    y = mtop + 40 * s
    for text, size_pt, weight in lines:
        fig.text(fx(tx), fy(y), text, ha="left", va="top", fontsize=size_pt * s, color=ink, fontweight=weight)
        y += (size_pt * 1.9 + 8) * s

    fig.savefig(path, dpi=dpi, facecolor=paper)
    plt.close(fig)


def rerender_map(site_dir, relief=False):
    """Redraw map.png from an existing site folder (used after adding features.json)."""
    site_dir = Path(site_dir)
    site = json.loads((site_dir / "site.json").read_text())
    g = site["grid"]
    q = np.fromfile(site_dir / "height.bin", dtype="<u2").astype(np.float64).reshape(g, g)
    heights = site["elev_min"] + q * (site["elev_max"] - site["elev_min"]) / 65535
    feats_path = site_dir / "features.json"
    features = json.loads(feats_path.read_text()) if feats_path.exists() else None
    render_map(
        site_dir / "map.png", heights, site, site["map"], site["contour_interval_m"],
        site.get("index_contour_interval_m", 50), relief, features,
    )


# ---------------------------------------------------------------------------


def main(argv=None):
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--dem", nargs="+", help="DEM GeoTIFF(s). Earlier files win where they overlap.")
    p.add_argument("--fetch-dem", action="store_true", help="Download elevation from USGS 3DEP instead of --dem")
    p.add_argument("--landcover", action="store_true", help="Also download NLCD land cover and tree canopy (make_landcover.py)")
    p.add_argument("--cache", help="Where downloads are kept (default ~/.cache/land-nav)")
    p.add_argument("--lat", type=float, required=True, help="Center latitude (WGS84)")
    p.add_argument("--lon", type=float, required=True, help="Center longitude (WGS84)")
    p.add_argument("--id", required=True, help="Site ID, used as the folder name")
    p.add_argument("--name", help="Display name (defaults to the ID)")
    p.add_argument("--declination", type=float, required=True, help="Magnetic declination in degrees, east positive")
    p.add_argument("--declination-date", required=True, help="Date the declination is for, YYYY-MM-DD")
    p.add_argument("--size", type=float, default=2000, help="Playable size in metres (default 2000)")
    p.add_argument("--spacing", type=float, default=4, help="Playable grid spacing in metres (default 4)")
    p.add_argument("--skirt-size", type=float, default=6000, help="Skirt size in metres (default 6000)")
    p.add_argument("--skirt-spacing", type=float, default=30, help="Skirt grid spacing in metres (default 30)")
    p.add_argument("--contour-interval", type=float, default=10)
    p.add_argument("--index-interval", type=float, default=50)
    p.add_argument("--map-px", type=int, default=4096)
    p.add_argument("--relief", action="store_true", help="Add light shaded relief to the map (makes association easier)")
    p.add_argument("--start-lat", type=float, help="Default course start (WGS84), e.g. a trailhead")
    p.add_argument("--start-lon", type=float)
    p.add_argument("--start-name", default="Start", help="Name of the default start")
    p.add_argument("--synthetic", action="store_true", help=argparse.SUPPRESS)
    p.add_argument("--out", default=str(Path(__file__).resolve().parent.parent / "sites"))
    a = p.parse_args(argv)
    if bool(a.dem) == bool(a.fetch_dem):
        raise SystemExit("Give either --dem files or --fetch-dem")

    if a.size % a.spacing:
        raise SystemExit("--size must be a multiple of --spacing")
    if a.skirt_size % a.skirt_spacing:
        raise SystemExit("--skirt-size must be a multiple of --skirt-spacing")

    utm, zone, north = utm_crs_for(a.lat, a.lon)
    to_utm = Transformer.from_crs("EPSG:4326", utm, always_xy=True)
    to_ll = Transformer.from_crs(utm, "EPSG:4326", always_xy=True)

    ce, cn = to_utm.transform(a.lon, a.lat)
    # Snap the NW corner to 10 m so the 8-digit grid squares line up with the heightmap.
    e_west = snap(ce - a.size / 2, 10)
    n_north = snap(cn + a.size / 2, 10)
    gzd, sq = check_single_square(to_ll, e_west, n_north, a.size)

    sgrid = int(round(a.skirt_size / a.skirt_spacing)) + 1
    s_e_west = snap(e_west + a.size / 2 - a.skirt_size / 2, a.skirt_spacing)
    s_n_north = snap(n_north - a.size / 2 + a.skirt_size / 2, a.skirt_spacing)
    surveys = []
    if a.fetch_dem:
        import fetch_usgs
        cache = Path(a.cache) if a.cache else fetch_usgs.default_cache()
        print("Downloading elevation from USGS 3DEP ...")
        a.dem = [str(p) for p in fetch_usgs.fetch_site_dem(
            utm.to_epsg(), e_west, n_north, a.size, a.spacing,
            s_e_west, s_n_north, a.skirt_size, a.skirt_spacing, cache)]
        (lo0, la1), (lo1, la0) = to_ll.transform(e_west, n_north), to_ll.transform(e_west + a.size, n_north - a.size)
        surveys = fetch_usgs.lidar_surveys(lo0, la0, lo1, la1)
        print("  lidar surveys here: " + (", ".join(surveys) if surveys else "(could not list them)"))

    grid = int(round(a.size / a.spacing)) + 1
    print(f"Resampling playable area: {grid} x {grid} at {a.spacing:g} m ...")
    play = resample_to_grid(a.dem, utm, e_west, n_north, a.spacing, grid)
    missing = np.isnan(play).mean()
    if missing > 0:
        raise SystemExit(
            f"{missing:.1%} of the playable area has no elevation data. Download the neighbouring "
            "DEM tiles and pass them all to --dem."
        )

    print(f"Resampling skirt: {sgrid} x {sgrid} at {a.skirt_spacing:g} m ...")
    skirt = resample_to_grid(a.dem, utm, s_e_west, s_n_north, a.skirt_spacing, sgrid)
    skirt_missing = np.isnan(skirt).mean()
    if skirt_missing > 0:
        print(f"  note: {skirt_missing:.1%} of the skirt has no data; filled from neighbours.")
        skirt = fill_nans(skirt)

    elev_min = float(np.min(play))
    elev_max = float(np.max(play))
    s_min = float(np.min(skirt))
    s_max = float(np.max(skirt))

    conv = grid_convergence_deg(to_ll, to_utm, e_west + a.size / 2, n_north - a.size / 2)
    gm = a.declination - conv

    out = Path(a.out) / a.id
    out.mkdir(parents=True, exist_ok=True)
    quantize(play, elev_min, elev_max).tofile(out / "height.bin")
    quantize(skirt, s_min, s_max).tofile(out / "skirt.bin")

    layout = map_layout(a.map_px)
    site = {
        "id": a.id,
        "name": a.name or a.id,
        "utm_zone": f"{zone}{'N' if north else 'S'}",
        "epsg": utm.to_epsg(),
        "mgrs_gzd": gzd,
        "mgrs_100km": sq,
        "center_lat": a.lat,
        "center_lon": a.lon,
        "e_west": e_west,
        "n_north": n_north,
        "size_m": a.size,
        "spacing_m": a.spacing,
        "grid": grid,
        "elev_min": elev_min,
        "elev_max": elev_max,
        "elev_ref": elev_min,
        "skirt": {
            "size_m": a.skirt_size,
            "spacing_m": a.skirt_spacing,
            "grid": sgrid,
            "e_west": s_e_west,
            "n_north": s_n_north,
            "elev_min": s_min,
            "elev_max": s_max,
        },
        "declination_deg": a.declination,
        "convergence_deg": round(conv, 4),
        "gm_angle_deg": round(gm, 4),
        "declination_date": a.declination_date,
        "contour_interval_m": a.contour_interval,
        "index_contour_interval_m": a.index_interval,
        "map": layout,
        "sources": (["USGS 3DEP elevation service"] + [f"lidar: {s}" for s in surveys]) if a.fetch_dem
        else [Path(d).name for d in a.dem],
    }
    if a.synthetic:
        site["synthetic"] = True
    if a.start_lat is not None and a.start_lon is not None:
        se, sn = to_utm.transform(a.start_lon, a.start_lat)
        sx, sz = se - e_west, n_north - sn
        if not (0 <= sx <= a.size and 0 <= sz <= a.size):
            raise SystemExit("--start-lat/--start-lon is outside the playable area")
        # Centre of its 10 m grid square, like generated stakes.
        site["default_start"] = {"name": a.start_name, "x": math.floor(sx / 10) * 10 + 5, "z": math.floor(sz / 10) * 10 + 5}

    print("Rendering map.png ...")
    feats_path = out / "features.json"
    features = json.loads(feats_path.read_text()) if feats_path.exists() else None
    render_map(out / "map.png", play, site, layout, a.contour_interval, a.index_interval, a.relief, features)

    # Keep what other tools added to an earlier site.json, while their files exist.
    old_path = out / "site.json"
    old = json.loads(old_path.read_text()) if old_path.exists() else {}
    if old.get("features") and (out / "features.json").exists():
        site["features"] = True
    if old.get("landcover") and (out / "landcover.bin").exists():
        site["landcover"] = old["landcover"]
    if "default_start" not in site and old.get("default_start"):
        site["default_start"] = old["default_start"]
    (out / "site.json").write_text(json.dumps(site, indent=2) + "\n")
    (out / "courses").mkdir(exist_ok=True)
    if a.landcover:
        import make_landcover
        make_landcover.main(["--site", a.id, "--out", str(Path(a.out))] + (["--cache", a.cache] if a.cache else []))

    side = "EAST" if gm >= 0 else "WEST"
    print()
    print(f"Site written to {out}")
    print(f"  {gzd} {sq}  NW corner E {e_west:.0f} N {n_north:.0f}  elevation {elev_min:.1f}..{elev_max:.1f} m")
    print(f"  Declination {a.declination:+.2f} deg, grid convergence {conv:+.3f} deg")
    print(f"  G-M angle {gm:+.2f} deg: magnetic north is {abs(gm):.2f} deg {side} of grid north")
    if gm >= 0:
        print(f"  Grid to magnetic: SUBTRACT {abs(gm):.2f}.  Magnetic to grid: ADD {abs(gm):.2f}.")
    else:
        print(f"  Grid to magnetic: ADD {abs(gm):.2f}.  Magnetic to grid: SUBTRACT {abs(gm):.2f}.")
    print("  If that direction looks wrong, check the sign of --declination (east is positive).")


if __name__ == "__main__":
    main()
