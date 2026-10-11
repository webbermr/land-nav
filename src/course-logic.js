// Courses (spec section 8): seeded generation, validation and scoring.
// Pure functions, no Three.js. `field` is a Heightfield (src/heightfield.js).

// Small, fast, seedable PRNG. Same seed, same course, on every machine.
export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Steepest grade at a point, as a fraction (0.3 is 30 percent).
export function slopeAt(field, x, z) {
  const n = field.normalAt(x, z);
  return Math.hypot(n.x, n.z) / n.y;
}

export const GEN_DEFAULTS = Object.freeze({
  points: 4,
  decoys: 4,
  legMin: 200,          // metres
  legMax: 600,
  edgeMargin: 100,      // points stay this far from the boundary
  maxSlope: 0.3,
  minSpacing: 150,      // between any two stakes, start included
  decoyNear: [150, 260], // decoys sit this far from an assigned point
  timeLimitMin: 120,
  passThreshold: 3,
  preset: 'woods',
});

// Letters without I and O (they read as digits), then a digit 1-9: "K7".
const LETTERS = 'ABCDEFGHJKLMNPQRSTUVWXYZ';

function makeCodes(rng, n) {
  const codes = new Set();
  while (codes.size < n) {
    codes.add(LETTERS[Math.floor(rng() * LETTERS.length)] + String(1 + Math.floor(rng() * 9)));
  }
  return [...codes];
}

// Centre of the 10 m grid square, so the 8-digit grid shown to the user sits within
// about 7 m of the stake. Scene x and z line up with 10 m grid lines because the
// pipeline snaps the NW corner to 10 m.
function snap(v) {
  return Math.floor(v / 10) * 10 + 5;
}

const dist = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);

export function generateCourse(site, field, seed, opts = {}) {
  const o = { ...GEN_DEFAULTS, ...opts };
  const rng = mulberry32(seed);
  const size = site.size_m;
  const m = o.edgeMargin;
  const ok = (p, placed) =>
    p.x >= m && p.z >= m && p.x <= size - m && p.z <= size - m
    && slopeAt(field, p.x, p.z) < o.maxSlope
    && !(o.avoid && o.avoid(p))
    && placed.every((q) => dist(p, q) >= o.minSpacing);

  for (let attempt = 0; attempt < 200; attempt++) {
    const placed = [];
    // A fixed start (a trailhead, say) is used as given; it needn't meet the stake rules.
    let start = o.start ? { x: o.start.x, z: o.start.z } : null;
    for (let i = 0; i < 500 && !start; i++) {
      const p = { x: snap(m + rng() * (size - 2 * m)), z: snap(m + rng() * (size - 2 * m)) };
      if (ok(p, placed)) start = p;
    }
    if (!start) continue;
    placed.push(start);

    const points = [];
    let prev = start;
    for (let k = 0; k < o.points; k++) {
      let found = null;
      for (let i = 0; i < 800 && !found; i++) {
        const a = rng() * Math.PI * 2;
        const len = o.legMin + rng() * (o.legMax - o.legMin);
        const p = { x: snap(prev.x + Math.sin(a) * len), z: snap(prev.z - Math.cos(a) * len) };
        const leg = dist(prev, p);
        if (leg >= o.legMin && leg <= o.legMax && ok(p, placed)) found = p;
      }
      if (!found) break;
      points.push(found);
      placed.push(found);
      prev = found;
    }
    if (points.length < o.points) continue;

    const decoys = [];
    for (let k = 0; k < o.decoys; k++) {
      let found = null;
      for (let i = 0; i < 800 && !found; i++) {
        const near = points[Math.floor(rng() * points.length)];
        const a = rng() * Math.PI * 2;
        const r = o.decoyNear[0] + rng() * (o.decoyNear[1] - o.decoyNear[0]);
        const p = { x: snap(near.x + Math.sin(a) * r), z: snap(near.z - Math.cos(a) * r) };
        if (ok(p, placed)) found = p;
      }
      if (!found) break;
      decoys.push(found);
      placed.push(found);
    }
    if (decoys.length < o.decoys) continue;

    const codes = makeCodes(rng, points.length + decoys.length);
    return {
      id: `gen-${seed}`,
      site: site.id,
      name: `Generated course ${seed}`,
      seed,
      time_limit_min: o.timeLimitMin,
      pass_threshold: Math.min(o.passThreshold, points.length),
      preset: o.preset,
      start,
      points: points.map((p, i) => ({ code: codes[i], x: p.x, z: p.z })),
      decoys: decoys.map((p, i) => ({ code: codes[points.length + i], x: p.x, z: p.z })),
    };
  }
  throw new Error(`Could not generate a course for seed ${seed} on this site`);
}

// Problems with a course against the generator's rules, as readable strings.
// Authored courses may break them on purpose; the app only warns.
export function validateCourse(course, site, field, opts = {}) {
  const o = { ...GEN_DEFAULTS, ...opts };
  const problems = [];
  const size = site.size_m;
  const stakes = [{ ...course.start, code: 'START' }, ...course.points, ...course.decoys];
  let prev = course.start;
  course.points.forEach((p, i) => {
    const leg = dist(prev, p);
    if (leg < o.legMin - 1e-6 || leg > o.legMax + 1e-6) problems.push(`leg ${i + 1} is ${leg.toFixed(0)} m`);
    prev = p;
  });
  const s0 = course.start;
  if (s0.x < 0 || s0.z < 0 || s0.x > size || s0.z > size) problems.push('START is outside the area');
  for (const s of [...course.points, ...course.decoys]) {
    if (s.x < o.edgeMargin || s.z < o.edgeMargin || s.x > size - o.edgeMargin || s.z > size - o.edgeMargin) {
      problems.push(`${s.code} is within ${o.edgeMargin} m of the boundary`);
    }
  }
  for (const s of stakes) {
    const g = slopeAt(field, s.x, s.z);
    if (g >= o.maxSlope) problems.push(`${s.code} is on a ${(g * 100).toFixed(0)}% slope`);
  }
  for (let i = 0; i < stakes.length; i++) {
    for (let j = i + 1; j < stakes.length; j++) {
      const d = dist(stakes[i], stakes[j]);
      if (d < o.minSpacing - 1e-6) problems.push(`${stakes[i].code} and ${stakes[j].code} are ${d.toFixed(0)} m apart`);
    }
  }
  const codes = [...course.points, ...course.decoys].map((s) => s.code);
  if (new Set(codes).size !== codes.length) problems.push('stake codes are not unique');
  if (course.pass_threshold > course.points.length) problems.push('pass threshold is more than the number of points');
  return problems;
}

// Straight-line course length: start, each point in order, back to start.
export function idealDistance(course) {
  let total = 0;
  let prev = course.start;
  for (const p of course.points) {
    total += dist(prev, p);
    prev = p;
  }
  return total + dist(prev, course.start);
}

export const END_AT_START_M = 10;

// entries: the code the user recorded against each assigned point (or null).
export function scoreRun(course, entries, { elapsedSec, endedAtStart }) {
  const rows = course.points.map((p, i) => ({
    code: p.code,
    entered: entries[i] ?? null,
    correct: entries[i] === p.code,
  }));
  const correct = rows.filter((r) => r.correct).length;
  const timeOk = elapsedSec <= course.time_limit_min * 60;
  return {
    rows,
    correct,
    total: rows.length,
    timeOk,
    endedAtStart,
    pass: correct >= course.pass_threshold && timeOk && endedAtStart,
    elapsedSec,
  };
}
