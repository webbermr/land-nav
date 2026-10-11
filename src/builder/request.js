// The site builder's logic (builder.html): the square a build will make, checks
// on it, and the build request it sends. Pure functions, no DOM.
//
// The request format is checked again, strictly, by tools/build_request.py, which
// is what actually builds. This side only helps you get it right first time.
import { toUtm, fromUtm, utmZone } from '../utm.js';

export const REPO = 'webbermr/land-nav';
export const SIZES = [1000, 1500, 2000, 3000];
const ID_RE = /^[a-z0-9][a-z0-9-]{1,40}$/;
const NAME_RE = /^[\w .,'()&:/-]{1,60}$/;

export function slugify(name) {
  return name.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 41) || '';
}

const snap10 = (v) => Math.floor(v / 10 + 0.5) * 10; // as make_site.py snaps the NW corner

// GZD latitude band index (C..X), as MGRS defines them (X is 12 degrees tall).
function band(lat) {
  return Math.min(19, Math.floor((lat + 80) / 8));
}

function square(zone, north, eWest, nNorth, size) {
  const ll = (e, n) => fromUtm(e, n, zone, north);
  const corners = [ll(eWest, nNorth), ll(eWest + size, nNorth), ll(eWest + size, nNorth - size), ll(eWest, nNorth - size)];
  const problems = [];
  if (Math.floor(eWest / 1e5) !== Math.floor((eWest + size - 1e-6) / 1e5)
    || Math.floor((nNorth - size + 1e-6) / 1e5) !== Math.floor(nNorth / 1e5)) {
    problems.push('The square crosses a 100 km grid line. Move it a little so it sits inside one 100 km square.');
  }
  const inset = [ll(eWest + 1, nNorth - 1), ll(eWest + size - 1, nNorth - 1), ll(eWest + size - 1, nNorth - size + 1), ll(eWest + 1, nNorth - size + 1)];
  if (inset.some((c) => utmZone(c.lon) !== zone)) problems.push('The square crosses a UTM zone boundary. Move it east or west.');
  if (new Set(inset.map((c) => band(c.lat))).size > 1) problems.push('The square crosses an MGRS latitude band. Move it north or south.');
  if (Math.abs(corners[0].lat) > 84) problems.push('UTM stops at 84 degrees north and 80 south.');
  return { zone, north, eWest, nNorth, size, corners, problems };
}

// The square make_site.py builds for a centre point and size.
export function siteSquare(lat, lon, size = 2000) {
  const c = toUtm(lat, lon);
  return square(c.zone, c.north, snap10(c.e - size / 2), snap10(c.n + size / 2), size);
}

// The square of an existing site, from its site.json.
export function existingSquare(site) {
  const zone = site.epsg % 100;
  const north = Math.floor(site.epsg / 100) === 326;
  return square(zone, north, site.e_west, site.n_north, site.size_m);
}

// Is a lat/lon inside the square, at least `margin` metres from its edges?
export function insideSquare(sq, lat, lon, margin = 20) {
  const p = toUtm(lat, lon, sq.zone);
  return p.e >= sq.eWest + margin && p.e <= sq.eWest + sq.size - margin
    && p.n <= sq.nNorth - margin && p.n >= sq.nNorth - sq.size + margin;
}

// Course ids and names that don't clash with the site's existing courses
// (existing: their ids and names).
export function nextCourses(siteId, siteName, existing, { day = 0, night = 0 }) {
  // "Matthews Arm 2 (open)" takes "Matthews Arm 2" too: they'd read as the same course.
  const taken = new Set(existing.flatMap((v) => [v, v.replace(/\s*\(.*\)\s*$/, '')]));
  const out = [];
  const short = siteName.replace(/^.*?:\s*/, '');
  for (const [count, isNight] of [[day, false], [night, true]]) {
    let k = 1;
    for (let i = 0; i < count; i++) {
      const at = (n) => [`${siteId}-${isNight ? 'night-' : ''}${n}`.slice(0, 41), `${short}${isNight ? ' Night' : ''} ${n}`.slice(0, 60)];
      while (at(k).some((v) => taken.has(v))) k++;
      const [id, name] = at(k);
      taken.add(id); taken.add(name);
      out.push({ id, name, night: isNight });
      k++;
    }
  }
  return out;
}

const COURSE_DEFAULTS = { day: { legMin: 200, legMax: 600, time: 120 }, night: { legMin: 150, legMax: 350, time: 150 } };

// Build the request from the page's state. Returns { request, errors }.
//   state: { mode: 'new' | 'update', site: {...}, landcover, roads, courses: [...] }
export function makeRequest(state, randomSeed = () => 1 + Math.floor(Math.random() * 999999)) {
  const errors = [];
  const s = state.site || {};
  const site = { id: s.id, new: state.mode === 'new' };
  if (!ID_RE.test(s.id || '')) errors.push('Give the site an id: lowercase letters, digits and dashes.');
  if (site.new) {
    if (!NAME_RE.test(s.name || '')) errors.push('Give the site a name (up to 60 characters, no symbols).');
    if (!s.square) errors.push('Click the map to place the square.');
    else errors.push(...s.square.problems);
    if (s.existingIds?.includes(s.id)) errors.push(`There's already a site called ${s.id}.`);
    Object.assign(site, {
      name: s.name, lat: round6(s.lat), lon: round6(s.lon), size: s.size ?? 2000,
      start: s.start ? { lat: round6(s.start.lat), lon: round6(s.start.lon), name: s.start.name || 'Start' } : null,
      declination: s.declination === '' || s.declination == null ? null : Number(s.declination),
    });
    if (s.start && s.square && !insideSquare(s.square, s.start.lat, s.start.lon)) errors.push('The start must be inside the square.');
    if (site.start && !NAME_RE.test(site.start.name)) errors.push('Give the start a plain name.');
    if (site.declination !== null && !(Math.abs(site.declination) <= 60)) errors.push('Declination must be a number of degrees (west negative).');
  }
  const courses = (state.courses || []).map((c) => {
    const d = COURSE_DEFAULTS[c.night ? 'night' : 'day'];
    return {
      id: c.id, name: c.name, seed: c.seed || randomSeed(), night: !!c.night, preset: c.preset || 'woods',
      points: c.points || 4, legMin: c.legMin || d.legMin, legMax: c.legMax || d.legMax, time: c.time || d.time,
    };
  });
  for (const c of courses) {
    if (!ID_RE.test(c.id) || !NAME_RE.test(c.name)) errors.push(`Course "${c.name}": needs a plain id and name.`);
    if (c.legMin > c.legMax) errors.push(`Course "${c.name}": shortest leg is longer than the longest.`);
  }
  if (courses.length > 10) errors.push('At most 10 courses per build.');
  const request = { v: 1, site, landcover: !!state.landcover, roads: !!state.roads, courses };
  if (!site.new && !request.landcover && !request.roads && !courses.length) errors.push('Pick something to build.');
  return { request, errors };
}

const round6 = (v) => Math.round(v * 1e6) / 1e6;

export function issueTitle(req) {
  if (req.site.new) return `[build] New site: ${req.site.name}`;
  const parts = [req.landcover && 'tree cover', req.roads && 'roads', req.courses.length && `${req.courses.length} course${req.courses.length > 1 ? 's' : ''}`].filter(Boolean);
  return `[build] ${req.site.id}: ${parts.join(', ')}`;
}

export function issueBody(req) {
  return [
    'Requested from the site builder. Submitting this issue starts the build; a pull request with the result',
    'will be linked here in a few minutes. Merge it to publish.',
    '',
    '```json',
    JSON.stringify(req, null, 2),
    '```',
  ].join('\n');
}

// A "new issue" link with the title and body filled in.
export function issueUrl(req, repo = REPO) {
  const q = new URLSearchParams({ title: issueTitle(req), body: issueBody(req) });
  return `https://github.com/${repo}/issues/new?${q}`;
}

const sh = (v) => (/^[\w.,:/@%+=-]+$/.test(String(v)) ? String(v) : `'${String(v).replace(/'/g, "'\\''")}'`);

// The same build as terminal commands, for running it yourself.
export function cliCommands(req, today = new Date()) {
  const s = req.site;
  const out = [];
  if (s.new) {
    const date = today.toISOString().slice(0, 10);
    const dec = s.declination ?? '<declination>';
    let cmd = `python3 tools/make_site.py --fetch-dem --lat ${s.lat} --lon ${s.lon} --id ${s.id} --name ${sh(s.name)} --size ${s.size} --declination ${dec} --declination-date ${date}`;
    if (s.start) cmd += ` --start-lat ${s.start.lat} --start-lon ${s.start.lon} --start-name ${sh(s.start.name)}`;
    out.push(cmd);
  }
  if (req.roads) out.push(`python3 tools/make_features.py --site ${s.id} --fetch`);
  if (req.landcover) out.push(`python3 tools/make_landcover.py --site ${s.id}`);
  for (const c of req.courses) {
    out.push(`node tools/make_course.mjs --site ${s.id} --seed ${c.seed} --id ${c.id} --name ${sh(c.name)} --points ${c.points} --leg-min ${c.legMin} --leg-max ${c.legMax} --time ${c.time} --preset ${c.preset}${c.night ? ' --night' : ''}`);
  }
  return out;
}
