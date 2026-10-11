"""Web builder requests (tools/build_request.py): parsing, validation, planning.
Offline: nothing here downloads or builds."""

import datetime as dt
import json
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "tools"))
import build_request as br  # noqa: E402

TODAY = dt.date(2026, 10, 11)


def request(**over):
    r = {
        "v": 1,
        "site": {"id": "old-rag", "new": True, "name": "Shenandoah NP: Old Rag", "lat": 38.5512, "lon": -78.3155,
                 "size": 2000, "start": {"lat": 38.5545, "lon": -78.3230, "name": "Saddle"}, "declination": None},
        "landcover": True, "roads": True,
        "courses": [{"id": "old-rag-1", "name": "Old Rag 1", "seed": 501, "night": False, "preset": "woods",
                     "points": 4, "legMin": 200, "legMax": 600, "time": 120}],
    }
    for k, v in over.items():
        r[k] = v
    return r


class BuildRequestTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.sites = Path(self.tmp.name)
        (self.sites / "existing").mkdir()
        (self.sites / "existing" / "site.json").write_text("{}")

    def tearDown(self):
        self.tmp.cleanup()

    def bad(self, req, words):
        with self.assertRaises(br.RequestError) as cm:
            br.validate(req, self.sites)
        self.assertIn(words, str(cm.exception))

    def test_extracts_the_json_block_from_an_issue(self):
        body = "Built by the site builder.\n\n```json\n" + json.dumps(request()) + "\n```\n\nThanks"
        self.assertEqual(br.extract_request(body)["site"]["id"], "old-rag")
        with self.assertRaises(br.RequestError):
            br.extract_request("no request here")
        with self.assertRaises(br.RequestError):
            br.extract_request("```json\n{not json}\n```")

    def test_a_good_request_validates(self):
        r = br.validate(request(), self.sites)
        self.assertEqual(r["site"]["size"], 2000)
        self.assertEqual(r["courses"][0]["legMax"], 600)
        self.assertTrue(r["roads"] and r["landcover"])

    def test_rejects_bad_input(self):
        self.bad({"v": 2}, "version")
        self.bad(request(site={**request()["site"], "id": "Bad Id; rm -rf /"}), "lowercase")
        self.bad(request(site={**request()["site"], "id": "existing"}), "already exists")
        self.bad(request(site={"id": "nowhere", "new": False}), "no site called")
        self.bad(request(site={**request()["site"], "lat": 91}), "between")
        self.bad(request(site={**request()["site"], "lon": "west"}), "number")
        self.bad(request(site={**request()["site"], "name": "x" * 61}), "1-60")
        self.bad(request(site={**request()["site"], "name": "$(curl evil)"}), "1-60")
        self.bad(request(site={**request()["site"], "size": 1234}), "multiple of 500")
        # The start is about 1 km west of the centre: outside a 2 km square.
        self.bad(request(site={**request()["site"], "start": {"lat": 38.5545, "lon": -78.3270, "name": "S"}}), "outside")
        self.bad(request(courses=[{**request()["courses"][0], "preset": "jungle"}]), "woods or open")
        self.bad(request(courses=[{**request()["courses"][0], "legMin": 700}]), "legMin")
        self.bad(request(courses=[request()["courses"][0]] * 2), "different")
        self.bad(request(courses=[{**request()["courses"][0], "id": f"c{i}"} for i in range(11)]), "at most")
        self.bad({"v": 1, "site": {"id": "existing", "new": False}}, "Nothing to do")

    def test_plan_for_a_new_site(self):
        steps = br.plan(br.validate(request(), self.sites), TODAY)
        self.assertEqual([s[1][0] for s in steps], ["make_site", "make_features", "make_landcover", "node"])
        site = steps[0][1]
        self.assertIn("--fetch-dem", site)
        dec = float(site[site.index("--declination") + 1])
        self.assertAlmostEqual(dec, -9.95, delta=0.05)  # WMM 2025 at Old Rag, October 2026
        self.assertEqual(site[site.index("--declination-date") + 1], "2026-10-11")
        self.assertEqual(site[site.index("--start-name") + 1], "Saddle")
        course = steps[3][1]
        self.assertEqual(course[course.index("--leg-max") + 1], "600")
        self.assertNotIn("--night", course)

    def test_plan_for_an_update_with_a_night_course(self):
        req = {"v": 1, "site": {"id": "existing", "new": False}, "landcover": True,
               "courses": [{"id": "night-1", "name": "Night 1", "seed": 7, "night": True}]}
        steps = br.plan(br.validate(req, self.sites), TODAY)
        self.assertEqual([s[1][0] for s in steps], ["make_landcover", "node"])
        self.assertIn("--night", steps[1][1])

    def test_a_given_declination_is_used(self):
        r = request(site={**request()["site"], "declination": -10.5})
        site = br.plan(br.validate(r, self.sites), TODAY)[0][1]
        self.assertEqual(site[site.index("--declination") + 1], "-10.5")

    def test_index_keeps_its_style(self):
        (self.sites / "index.json").write_text('[\n  { "id": "a", "name": "A" }\n]\n')
        br.add_to_index(self.sites, "b", "B: \"quoted\"")
        br.add_to_index(self.sites, "b", "again")
        self.assertEqual((self.sites / "index.json").read_text(),
                         '[\n  { "id": "a", "name": "A" },\n  { "id": "b", "name": "B: \\"quoted\\"" }\n]\n')

    def test_summary_marks_optional_failures_as_skipped(self):
        req = br.validate(request(), self.sites)
        results = [("Elevation", True, "", False), ("Roads", False, "servers busy", True), ("Course", True, "", False)]
        text, ok = br.summary(req, results, self.sites)
        self.assertTrue(ok)
        self.assertIn("⚠️ skipped Roads", text)
        text, ok = br.summary(req, [("Elevation", False, "boom", False)], self.sites)
        self.assertFalse(ok)
        self.assertIn("boom", text)


if __name__ == "__main__":
    unittest.main()
