// After-action review numbers (spec section 9). Pure functions, no Three.js.
//
// Input is a saved run (see buildRunExport): the course, the run log (a ~1 s track,
// events, tool intervals), the bead log and the result. Everything here is derived,
// so an old export can be re-analysed when these rules change.

import { gridAzimuth, gridToMagnetic, normalizeDeg } from './coords.js';

export const RUN_EXPORT_VERSION = 1;
export const FOUND_M = 2;     // within punch range: you were at the stake
export const BEAD_M = 100;    // each lower bead is 100 m

// Position on the track at time t, interpolated between samples.
export function positionAt(track, t) {
  if (!track.length) return null;
  if (t <= track[0].t) return { x: track[0].x, z: track[0].z };
  for (let i = 1; i < track.length; i++) {
    const a = track[i - 1], b = track[i];
    if (t <= b.t) {
      const f = b.t > a.t ? (t - a.t) / (b.t - a.t) : 1;
      return { x: a.x + (b.x - a.x) * f, z: a.z + (b.z - a.z) * f };
    }
  }
  const last = track[track.length - 1];
  return { x: last.x, z: last.z };
}

// The track between t0 and t1 as a polyline, with interpolated ends.
export function trackBetween(track, t0, t1) {
  if (!track.length || t1 < t0) return [];
  const pts = [{ t: t0, ...positionAt(track, t0) }];
  for (const p of track) if (p.t > t0 && p.t < t1) pts.push(p);
  pts.push({ t: t1, ...positionAt(track, t1) });
  return pts;
}

export function pathLength(pts) {
  let d = 0;
  for (let i = 1; i < pts.length; i++) d += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].z - pts[i - 1].z);
  return d;
}

// Closest point of a polyline to a target: distance, where, and when.
export function closestApproach(pts, target) {
  let best = null;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i], b = pts[Math.min(i + 1, pts.length - 1)];
    const vx = b.x - a.x, vz = b.z - a.z;
    const len2 = vx * vx + vz * vz;
    let f = len2 > 0 ? ((target.x - a.x) * vx + (target.z - a.z) * vz) / len2 : 0;
    f = Math.max(0, Math.min(1, f));
    const x = a.x + vx * f, z = a.z + vz * f;
    const d = Math.hypot(target.x - x, target.z - z);
    if (!best || d < best.d) best = { d, x, z, t: a.t + (b.t - a.t) * f };
  }
  return best;
}

// Where you were once you'd walked `dist` metres along the polyline. If the leg
// ended first, the last point, marked short.
export function pointAtDistance(pts, dist) {
  let walked = 0;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1], b = pts[i];
    const seg = Math.hypot(b.x - a.x, b.z - a.z);
    if (walked + seg >= dist && seg > 0) {
      const f = (dist - walked) / seg;
      return { x: a.x + (b.x - a.x) * f, z: a.z + (b.z - a.z) * f, t: a.t + (b.t - a.t) * f, short: false };
    }
    walked += seg;
  }
  const last = pts[pts.length - 1];
  return last ? { x: last.x, z: last.z, t: last.t, short: true } : null;
}

// Offset of p from the line from `from` toward `to`: lateral is positive to the
// right of the direction of travel, along is metres from `from` toward `to`.
export function offsetFromLine(from, to, p) {
  const dx = to.x - from.x, dz = to.z - from.z;
  const len = Math.hypot(dx, dz) || 1;
  const ux = dx / len, uz = dz / len;
  // Right of travel: facing grid north (0, -1), right is east (+x).
  const rx = -uz, rz = ux;
  const px = p.x - from.x, pz = p.z - from.z;
  return { lateral: px * rx + pz * rz, along: px * ux + pz * uz };
}

// When each leg ended, judged by the stakes you actually reached, not by which
// score-card row you wrote in (a wrong row is a card error, reported separately).
// A leg to a point ends when you punched that point's stake. If you never did, it
// ends at your closest approach to it before you punched any later point (or before
// the run ended). The last leg runs back to the start and ends with the run.
export function legWindows(course, log) {
  const end = log.track.length ? log.track[log.track.length - 1].t : 0;
  const punches = log.events.filter((e) => e.type === 'punch');
  const punchOf = (code, after) => punches.find((e) => e.code === code && e.t >= after);
  const legs = [];
  let t0 = 0;
  course.points.forEach((p, row) => {
    const hit = punchOf(p.code, t0);
    let t1, endedBy;
    if (hit) {
      t1 = hit.t; endedBy = 'punch';
    } else {
      const later = course.points.slice(row + 1).map((q) => punchOf(q.code, t0)?.t).filter((t) => t !== undefined);
      const horizon = later.length ? Math.min(...later) : end;
      const c = closestApproach(trackBetween(log.track, t0, horizon), p);
      t1 = c ? c.t : t0; endedBy = 'closest';
    }
    legs.push({ row, target: p, t0, t1, endedBy, punch: hit || null });
    t0 = t1;
  });
  legs.push({ row: null, target: course.start, t0, t1: Math.max(t0, end), endedBy: 'end', punch: null });
  return legs;
}

// Bead pace check for one leg: lower-bead slides since the leg began (or since you
// last reset the beads within it) against the distance you actually walked up to
// the last slide. error > 0: the beads claim more than you walked.
export function legPace(track, beadLog, t0, t1) {
  const inLeg = beadLog.filter((b) => b.t >= t0 && b.t <= t1);
  // A reset at the very moment the leg ends belongs to the next leg.
  const lastReset = [...inLeg].reverse().find((b) => b.action === 'reset' && b.t < t1);
  const base = lastReset ? lastReset.t : t0;
  const slides = inLeg.filter((b) => b.action === 'slide' && b.t >= base);
  if (!slides.length) return null;
  const tLast = slides[slides.length - 1].t;
  const walked = pathLength(trackBetween(track, base, tLast));
  const claimed = slides.length * BEAD_M;
  return { beads: slides.length, claimed, walked, error: walked > 0 ? (claimed - walked) / walked : null };
}

function overlap(intervals, t0, t1) {
  let s = 0;
  for (const [a, b] of intervals) s += Math.max(0, Math.min(b, t1) - Math.max(a, t0));
  return s;
}

export function analyzeRun(run, site) {
  const { course, log } = run;
  const beadLog = run.beads || [];
  const gm = site?.gm_angle_deg ?? 0;
  const legs = legWindows(course, log).map((w, i) => {
    const from = i === 0 ? course.start : course.points[i - 1];
    const to = w.target;
    const distance = Math.hypot(to.x - from.x, to.z - from.z);
    const gridAz = normalizeDeg(gridAzimuth(to.x - from.x, to.z - from.z));
    const pts = trackBetween(log.track, w.t0, w.t1);
    const closest = closestApproach(pts, to);
    const at = pointAtDistance(pts, distance);
    const drift = at ? { ...at, ...offsetFromLine(from, to, at), toTarget: Math.hypot(to.x - at.x, to.z - at.z) } : null;
    const entered = w.row === null ? null : (run.result?.rows?.[w.row]?.entered ?? null);
    return {
      n: i + 1,
      label: w.row === null ? 'Start' : `Point ${w.row + 1}`,
      code: w.row === null ? null : to.code,
      from: { x: from.x, z: from.z },
      to: { x: to.x, z: to.z },
      gridAz,
      magAz: normalizeDeg(gridToMagnetic(gridAz, gm)),
      distance,
      t0: w.t0,
      t1: w.t1,
      time: w.t1 - w.t0,
      walked: pathLength(pts),
      endedBy: w.endedBy,
      punched: w.punch?.code ?? null,
      entered,
      correct: w.row === null ? null : entered === to.code,
      closest,
      found: closest ? closest.d <= FOUND_M : false,
      drift,
      pace: legPace(log.track, beadLog, w.t0, w.t1),
      mapSec: overlap(log.intervals?.map || [], w.t0, w.t1),
      compassSec: overlap(log.intervals?.compass || [], w.t0, w.t1),
    };
  });
  const paced = legs.filter((l) => l.pace && l.pace.walked > 0);
  const claimed = paced.reduce((s, l) => s + l.pace.claimed, 0);
  const walkedPaced = paced.reduce((s, l) => s + l.pace.walked, 0);
  const end = log.track.length ? log.track[log.track.length - 1].t : 0;
  return {
    legs,
    pace: paced.length ? { claimed, walked: walkedPaced, error: (claimed - walkedPaced) / walkedPaced } : null,
    totals: {
      time: end,
      walked: pathLength(log.track),
      ideal: legs.reduce((s, l) => s + l.distance, 0),
      mapSec: overlap(log.intervals?.map || [], 0, end),
      compassSec: overlap(log.intervals?.compass || [], 0, end),
      reveals: log.events.filter((e) => e.type === 'reveal').length,
    },
  };
}

// Everything needed to review a run later, or elsewhere: the course as run, the
// raw logs, the result and the settings that shaped it. Positions are scene metres
// from the site's NW corner (site.e_west, site.n_north in site.epsg).
export function buildRunExport({ course, site, log, beads, result, settings, date = new Date() }) {
  return {
    format: 'land-nav-run',
    version: RUN_EXPORT_VERSION,
    date: date.toISOString(),
    site: { id: site.id, name: site.name, epsg: site.epsg, e_west: site.e_west, n_north: site.n_north, gm_angle_deg: site.gm_angle_deg },
    course,
    settings: {
      paceCountPer100m: settings.paceCountPer100m,
      timeScale: settings.timeScale,
      slopeEffects: settings.slopeEffects,
      preset: course.preset ?? settings.preset,
    },
    result,
    log: typeof log.toJSON === 'function' ? log.toJSON() : log,
    beads,
  };
}

// Readable formats for the review board and tests.
export function formatDuration(sec) {
  const s = Math.max(0, Math.round(sec));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}` : `${m}:${String(r).padStart(2, '0')}`;
}

export function formatDrift(lateral) {
  const m = Math.round(Math.abs(lateral));
  return m === 0 ? 'on line' : `${m} m ${lateral > 0 ? 'right' : 'left'}`;
}

export function formatPaceError(error) {
  if (error === null || error === undefined) return '';
  const pct = Math.round(error * 100);
  return `${pct > 0 ? '+' : ''}${pct}%`;
}
