#!/usr/bin/env python3
"""Run a site build request from the web builder (builder.html).

The builder page opens a GitHub issue whose body holds a fenced JSON request.
.github/workflows/build-site.yml runs this script on it: validate, then call the
same tools you would run by hand, then write a summary for the PR and the issue.

The request is untrusted text from an issue, so it is checked field by field and
the tools are called with argument lists, never through a shell.

    python3 tools/build_request.py --event "$GITHUB_EVENT_PATH" --summary summary.md
    python3 tools/build_request.py --json request.json --summary summary.md   # locally

Request (version 1):
    {
      "v": 1,
      "site": { "id": "my-site", "new": true, "name": "My Site", "lat": 38.76, "lon": -78.30,
                "size": 2000, "start": { "lat": 38.76, "lon": -78.30, "name": "Trailhead" },
                "declination": null },
      "landcover": true,
      "roads": true,
      "courses": [ { "id": "day-1", "name": "Day 1", "seed": 1001, "night": false,
                     "preset": "woods", "points": 4, "legMin": 200, "legMax": 600, "time": 120 } ]
    }
"declination": null works it out from the World Magnetic Model for today.
"""

import argparse
import datetime as dt
import json
import os
import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
TOOLS = ROOT / "tools"
sys.path.insert(0, str(TOOLS))

ID_RE = re.compile(r"^[a-z0-9][a-z0-9-]{1,40}$")
NAME_RE = re.compile(r"^[\w .,'()&:/-]{1,60}$")
MAX_COURSES = 10


class RequestError(ValueError):
    pass


def extract_request(text):
    """The JSON object in the first ```json fence of an issue body."""
    m = re.search(r"```json\s*(\{.*?\})\s*```", text or "", re.S)
    if not m:
        raise RequestError("No ```json request block found in the issue.")
    try:
        return json.loads(m.group(1))
    except json.JSONDecodeError as exc:
        raise RequestError(f"The request block isn't valid JSON: {exc}") from exc


def _num(obj, key, lo, hi, default=None, integer=False):
    v = obj.get(key, default)
    if v is None and default is None:
        raise RequestError(f"{key} is required")
    if isinstance(v, bool) or not isinstance(v, (int, float)) or v != v:
        raise RequestError(f"{key} must be a number")
    if integer and int(v) != v:
        raise RequestError(f"{key} must be a whole number")
    if not lo <= v <= hi:
        raise RequestError(f"{key} must be between {lo} and {hi}")
    return int(v) if integer else float(v)


def _name(obj, key, default=None):
    v = obj.get(key, default)
    if not isinstance(v, str) or not NAME_RE.match(v):
        raise RequestError(f"{key} must be 1-60 letters, digits, spaces or simple punctuation")
    return v


def _id(obj, key):
    v = obj.get(key)
    if not isinstance(v, str) or not ID_RE.match(v):
        raise RequestError(f"{key} must be lowercase letters, digits and dashes (2-41 characters)")
    return v


def validate(req, sites_dir):
    """A cleaned copy of the request, or RequestError saying what's wrong."""
    if not isinstance(req, dict) or req.get("v") != 1:
        raise RequestError("Unknown request version (expected v: 1)")
    s = req.get("site")
    if not isinstance(s, dict):
        raise RequestError("site is required")
    site = {"id": _id(s, "id"), "new": bool(s.get("new"))}
    exists = (Path(sites_dir) / site["id"] / "site.json").exists()
    if site["new"]:
        if exists:
            raise RequestError(f"A site called {site['id']} already exists; pick another id")
        site["name"] = _name(s, "name")
        site["lat"] = _num(s, "lat", -84, 84)
        site["lon"] = _num(s, "lon", -180, 180)
        site["size"] = _num(s, "size", 1000, 4000, default=2000, integer=True)
        if site["size"] % 500:
            raise RequestError("size must be a multiple of 500 m")
        dec = s.get("declination")
        site["declination"] = None if dec is None else _num(s, "declination", -60, 60)
        start = s.get("start")
        if start is not None:
            if not isinstance(start, dict):
                raise RequestError("start must be an object")
            site["start"] = {"lat": _num(start, "lat", -84, 84), "lon": _num(start, "lon", -180, 180),
                             "name": _name(start, "name", "Start")}
            # Check it's inside the square before downloading anything.
            from pyproj import Transformer
            from make_site import utm_crs_for
            utm, _, _ = utm_crs_for(site["lat"], site["lon"])
            to_utm = Transformer.from_crs("EPSG:4326", utm, always_xy=True)
            ce, cn = to_utm.transform(site["lon"], site["lat"])
            se, sn = to_utm.transform(site["start"]["lon"], site["start"]["lat"])
            if max(abs(se - ce), abs(sn - cn)) > site["size"] / 2 - 20:
                raise RequestError("the start is outside the square (or within 20 m of its edge)")
    elif not exists:
        raise RequestError(f"There is no site called {site['id']} to update")

    courses = req.get("courses") or []
    if not isinstance(courses, list) or len(courses) > MAX_COURSES:
        raise RequestError(f"courses must be a list of at most {MAX_COURSES}")
    clean = []
    for i, c in enumerate(courses):
        if not isinstance(c, dict):
            raise RequestError(f"course {i + 1} must be an object")
        k = {
            "id": _id(c, "id"), "name": _name(c, "name"), "seed": _num(c, "seed", 1, 2**31 - 1, integer=True),
            "night": bool(c.get("night")), "preset": c.get("preset", "woods"),
            "points": _num(c, "points", 1, 10, default=4, integer=True),
            "legMin": _num(c, "legMin", 50, 2000, default=200, integer=True),
            "legMax": _num(c, "legMax", 50, 2000, default=600, integer=True),
            "time": _num(c, "time", 10, 600, default=120, integer=True),
        }
        if k["preset"] not in ("woods", "open"):
            raise RequestError(f"course {k['id']}: preset must be woods or open")
        if k["legMin"] > k["legMax"]:
            raise RequestError(f"course {k['id']}: legMin is more than legMax")
        clean.append(k)
    if len({c["id"] for c in clean}) != len(clean):
        raise RequestError("course ids must be different")

    out = {"site": site, "landcover": bool(req.get("landcover")), "roads": bool(req.get("roads")), "courses": clean}
    if not (site["new"] or out["landcover"] or out["roads"] or clean):
        raise RequestError("Nothing to do: ask for a new site, land cover, roads or courses")
    return out


def wmm_declination(lat, lon, date):
    """Magnetic declination (degrees, east positive) from the World Magnetic Model."""
    from pygeomag import GeoMag
    start = dt.date(date.year, 1, 1)
    days = (dt.date(date.year + 1, 1, 1) - start).days
    year = date.year + (date - start).days / days
    return GeoMag(coefficients_file="wmm/WMM_2025.COF").calculate(glat=lat, glon=lon, alt=0, time=year).d


# Steps whose failure doesn't stop the build: they can be added later with an
# update request (the public servers behind them are sometimes busy).
OPTIONAL = ("make_features", "make_landcover")


def plan(req, today):
    """The tool runs a validated request needs, in order: [(label, argv)]. argv[0] is
    'make_site' etc. for the Python tools, or 'node' for the course tool."""
    s = req["site"]
    steps = []
    if s["new"]:
        dec = s["declination"] if s["declination"] is not None else round(wmm_declination(s["lat"], s["lon"], today), 2)
        argv = ["make_site", "--fetch-dem", "--lat", str(s["lat"]), "--lon", str(s["lon"]), "--id", s["id"],
                "--name", s["name"], "--size", str(s["size"]), "--declination", str(dec),
                "--declination-date", today.isoformat()]
        if s.get("start"):
            argv += ["--start-lat", str(s["start"]["lat"]), "--start-lon", str(s["start"]["lon"]),
                     "--start-name", s["start"]["name"]]
        steps.append(("Elevation, map and site", argv))
    if req["roads"]:
        steps.append(("Roads, trails and buildings (OpenStreetMap)", ["make_features", "--site", s["id"], "--fetch"]))
    if req["landcover"]:
        steps.append(("Tree cover (NLCD)", ["make_landcover", "--site", s["id"]]))
    for c in req["courses"]:
        argv = ["node", str(TOOLS / "make_course.mjs"), "--site", s["id"], "--seed", str(c["seed"]), "--id", c["id"],
                "--name", c["name"], "--points", str(c["points"]), "--leg-min", str(c["legMin"]),
                "--leg-max", str(c["legMax"]), "--time", str(c["time"]), "--preset", c["preset"]]
        if c["night"]:
            argv.append("--night")
        steps.append((f"Course {c['id']}", argv))
    return steps


def run(steps, sites_dir):
    """Run each step, capturing its output. Returns [(label, ok, output, optional)];
    stops at the first failure of a required step."""
    import contextlib
    import io
    results = []
    for label, argv in steps:
        buf = io.StringIO()
        ok = True
        if argv[0] == "node":
            p = subprocess.run(argv, cwd=ROOT, capture_output=True, text=True)
            buf.write(p.stdout + p.stderr)
            ok = p.returncode == 0
        else:
            mod = __import__(argv[0])
            try:
                with contextlib.redirect_stdout(buf), contextlib.redirect_stderr(buf):
                    mod.main(argv[1:] + ["--out", str(sites_dir)])
            except SystemExit as exc:
                if exc.code not in (None, 0):
                    buf.write(f"\n{exc.code}\n")
                    ok = False
            except Exception as exc:  # noqa: BLE001 - report any tool failure
                buf.write(f"\n{type(exc).__name__}: {exc}\n")
                ok = False
        optional = argv[0] in OPTIONAL
        print(f"== {label}: {'ok' if ok else 'skipped' if optional else 'FAILED'}\n{buf.getvalue()}")
        results.append((label, ok, buf.getvalue(), optional))
        if not ok and not optional:
            break
    return results


def add_to_index(sites_dir, site_id, name):
    path = Path(sites_dir) / "index.json"
    index = json.loads(path.read_text()) if path.exists() else []
    if not any(e["id"] == site_id for e in index):
        index.append({"id": site_id, "name": name})
        rows = [f'  {{ "id": {json.dumps(e["id"])}, "name": {json.dumps(e["name"])} }}' for e in index]
        path.write_text("[\n" + ",\n".join(rows) + "\n]\n")


def summary(req, results, sites_dir):
    """Markdown for the PR body and the issue comment."""
    s = req["site"]
    lines = []
    ok = all(r[1] or r[3] for r in results)
    site_path = Path(sites_dir) / s["id"] / "site.json"
    if site_path.exists():
        site = json.loads(site_path.read_text())
        gm = site["gm_angle_deg"]
        lines += [
            f"**{site['name']}** (`{site['id']}`), {site['mgrs_gzd']} {site['mgrs_100km']}, "
            f"{site['size_m'] / 1000:g} km square, elevation {site['elev_min']:.0f}-{site['elev_max']:.0f} m",
            f"- Declination {site['declination_deg']:+.2f}° ({site['declination_date']}), G-M angle "
            f"{abs(gm):.2f}° {'east' if gm >= 0 else 'west'}: grid to magnetic, "
            f"{'subtract' if gm >= 0 else 'add'} {abs(gm):.2f}°",
            f"- Elevation: {', '.join(site.get('sources', []))}",
        ]
        if site.get("default_start"):
            lines.append(f"- Course start: {site['default_start']['name']}")
        if site.get("landcover"):
            lc = site["landcover"]
            lines.append("- Tree cover (NLCD 2021): " + ", ".join(f"{k} {v:.0%}" for k, v in lc["summary"].items())
                         + f"; mean canopy {lc['mean_canopy']:.0%}")
        if site.get("features"):
            f = json.loads((site_path.parent / "features.json").read_text())
            lines.append(f"- OpenStreetMap: {len(f['lines'])} roads/trails/streams, {len(f['areas'])} areas")
    lines.append("")
    for label, good, out, optional in results:
        mark = '✅' if good else '⚠️ skipped' if optional else '❌'
        lines.append(f"- {mark} {label}")
    for label, good, out, optional in results:
        if good:
            continue
        tail = out.strip().splitlines()[-25:]
        title = f"{label}: why it was skipped (add it later from the builder's Update site)" if optional else "What went wrong"
        lines += ["", f"<details{'' if optional else ' open'}><summary>{title}</summary>", "", "```", *tail, "```", "</details>"]
    return "\n".join(lines), ok


def main(argv=None):
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    src = p.add_mutually_exclusive_group(required=True)
    src.add_argument("--event", help="GitHub event JSON (issues event)")
    src.add_argument("--json", help="A request JSON file")
    p.add_argument("--summary", required=True, help="Write the Markdown summary here")
    p.add_argument("--sites", default=str(ROOT / "sites"))
    p.add_argument("--date", help="Build date YYYY-MM-DD (default today, UTC)")
    a = p.parse_args(argv)

    today = dt.date.fromisoformat(a.date) if a.date else dt.datetime.now(dt.timezone.utc).date()
    outputs = {}
    try:
        if a.event:
            issue = json.loads(Path(a.event).read_text())["issue"]
            raw = extract_request(issue.get("body"))
        else:
            raw = json.loads(Path(a.json).read_text())
        req = validate(raw, a.sites)
    except RequestError as exc:
        Path(a.summary).write_text(f"❌ The build request couldn't be used: {exc}\n")
        print(exc)
        return 2

    results = run(plan(req, today), a.sites)
    if req["site"]["new"] and results and results[0][1]:
        add_to_index(a.sites, req["site"]["id"], req["site"]["name"])
    elif req["site"]["new"]:
        # Don't leave half a site behind.
        import shutil
        shutil.rmtree(Path(a.sites) / req["site"]["id"], ignore_errors=True)
    text, ok = summary(req, results, a.sites)
    Path(a.summary).write_text(text + "\n")
    outputs["site_id"] = req["site"]["id"]
    outputs["action"] = "New site" if req["site"]["new"] else "Update"
    if os.environ.get("GITHUB_OUTPUT"):
        with open(os.environ["GITHUB_OUTPUT"], "a") as fh:
            for k, v in outputs.items():
                fh.write(f"{k}={v}\n")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
