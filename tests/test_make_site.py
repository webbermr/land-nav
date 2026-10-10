"""Pipeline tests. Run with: python3 -m unittest discover -s tests -p 'test_*.py'"""

import json
import math
import sys
import tempfile
import unittest
from pathlib import Path

import numpy as np
import rasterio
from pyproj import Transformer
from rasterio.transform import from_origin

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "tools"))
import make_site  # noqa: E402

LAT, LON = 38.85, -77.45  # zone 18N, well inside one 100 km square
EPSG = 32618
# Plane: rises 0.02 m per metre east and 0.05 m per metre north.
A, B = 0.02, 0.05


def plane(e, n):
    return A * (e - 280000) + B * (n - 4300000) + 150


def write_plane_dem(path, ce, cn, size=3000, res=2.0):
    n = int(size / res)
    west, north = ce - size / 2, cn + size / 2
    cols = west + (np.arange(n) + 0.5) * res
    rows = north - (np.arange(n) + 0.5) * res
    E, N = np.meshgrid(cols, rows)
    with rasterio.open(
        path, "w", driver="GTiff", height=n, width=n, count=1, dtype="float32",
        crs=f"EPSG:{EPSG}", transform=from_origin(west, north, res, res), nodata=-9999.0,
    ) as dst:
        dst.write(plane(E, N).astype(np.float32), 1)


class MakeSiteTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory()
        tmp = Path(cls.tmp.name)
        ce, cn = Transformer.from_crs("EPSG:4326", f"EPSG:{EPSG}", always_xy=True).transform(LON, LAT)
        dem = tmp / "plane.tif"
        write_plane_dem(dem, ce, cn)
        make_site.main([
            "--dem", str(dem), "--lat", str(LAT), "--lon", str(LON), "--id", "plane",
            "--declination", "-10.5", "--declination-date", "2026-10-01",
            "--size", "400", "--spacing", "4", "--skirt-size", "1200", "--skirt-spacing", "30",
            "--map-px", "1024", "--out", str(tmp),
        ])
        cls.dir = tmp / "plane"
        cls.site = json.loads((cls.dir / "site.json").read_text())

    @classmethod
    def tearDownClass(cls):
        cls.tmp.cleanup()

    def decode(self, name, grid, lo, hi):
        v = np.fromfile(self.dir / name, dtype="<u2").astype(np.float64)
        self.assertEqual(v.size, grid * grid)
        return (lo + v * (hi - lo) / 65535).reshape(grid, grid)

    def test_files_exist(self):
        for f in ("site.json", "height.bin", "skirt.bin", "map.png"):
            self.assertTrue((self.dir / f).exists(), f)
        self.assertTrue((self.dir / "courses").is_dir())

    def test_site_json_fields(self):
        s = self.site
        self.assertEqual(s["grid"], 101)
        self.assertEqual(s["utm_zone"], "18N")
        self.assertEqual(s["mgrs_gzd"], "18S")
        self.assertEqual(len(s["mgrs_100km"]), 2)
        self.assertEqual(s["e_west"] % 10, 0)
        self.assertEqual(s["n_north"] % 10, 0)
        self.assertAlmostEqual(s["gm_angle_deg"], s["declination_deg"] - s["convergence_deg"], places=3)

    def test_convergence_sign_and_size(self):
        # West of the zone 18 central meridian (-75) in the northern hemisphere, grid
        # north is west of true north. Approx magnitude: dlon * sin(lat).
        expected = -(-75 - LON) * math.sin(math.radians(LAT))
        self.assertAlmostEqual(self.site["convergence_deg"], -abs(expected), delta=0.02)

    def test_height_samples_land_on_grid_points(self):
        s = self.site
        h = self.decode("height.bin", s["grid"], s["elev_min"], s["elev_max"])
        sp = s["spacing_m"]
        for row, col in ((0, 0), (0, 100), (100, 0), (100, 100), (37, 81)):
            e = s["e_west"] + col * sp
            n = s["n_north"] - row * sp
            # Quantization step is (max-min)/65535, well under a millimetre here.
            self.assertAlmostEqual(h[row, col], plane(e, n), delta=0.01, msg=f"row {row} col {col}")
        # Row 0 is north (higher on this plane), col 0 is west (lower).
        self.assertGreater(h[0, 50], h[100, 50])
        self.assertLess(h[50, 0], h[50, 100])

    def test_skirt_samples_land_on_grid_points(self):
        sk = self.site["skirt"]
        h = self.decode("skirt.bin", sk["grid"], sk["elev_min"], sk["elev_max"])
        for row, col in ((0, 0), (40, 40), (17, 33)):
            e = sk["e_west"] + col * sk["spacing_m"]
            n = sk["n_north"] - row * sk["spacing_m"]
            self.assertAlmostEqual(h[row, col], plane(e, n), delta=0.02)


class GuardsTest(unittest.TestCase):
    def test_rejects_area_crossing_100km_line(self):
        to_ll = Transformer.from_crs(f"EPSG:{EPSG}", "EPSG:4326", always_xy=True)
        with self.assertRaises(SystemExit):
            make_site.check_single_square(to_ll, 299000, 4301000, 2000)  # spans E 300000
        with self.assertRaises(SystemExit):
            make_site.check_single_square(to_ll, 285000, 4300500, 2000)  # spans N 4300000

    def test_accepts_area_inside_one_square(self):
        to_ll = Transformer.from_crs(f"EPSG:{EPSG}", "EPSG:4326", always_xy=True)
        gzd, sq = make_site.check_single_square(to_ll, 284000, 4302000, 2000)
        self.assertEqual(gzd, "18S")
        self.assertEqual(len(sq), 2)

    def test_missing_coverage_is_an_error(self):
        with tempfile.TemporaryDirectory() as d:
            ce, cn = Transformer.from_crs("EPSG:4326", f"EPSG:{EPSG}", always_xy=True).transform(LON, LAT)
            dem = Path(d) / "small.tif"
            write_plane_dem(dem, ce + 1500, cn, size=1000)  # does not cover the centre
            with self.assertRaises(SystemExit):
                make_site.main([
                    "--dem", str(dem), "--lat", str(LAT), "--lon", str(LON), "--id", "x",
                    "--declination", "0", "--declination-date", "2026-10-01",
                    "--size", "400", "--map-px", "512", "--out", d,
                ])


if __name__ == "__main__":
    unittest.main()
