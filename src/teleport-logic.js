// Teleport arc (Explore mode): a ballistic curve from the controller to where it
// meets the ground. Pure functions, no Three.js.
//
// The arc's launch speed comes from the range you want on flat ground at 45
// degrees (range = v^2 / g), so the setting reads in metres.

export const GRAVITY = 9.8;
export const EDGE_MARGIN_M = 1; // keep landings this far inside the playable area

export function launchSpeed(range, g = GRAVITY) {
  return Math.sqrt(range * g);
}

// Trace the arc from `origin` along unit `dir` until it meets heightAt(x, z).
// Returns { points: [{x,y,z}], hit: {x,y,z} | null, valid }. Points are spaced
// about `spacing` metres apart for drawing. valid: there's a hit inside the area.
export function traceArc(origin, dir, { range, heightAt, size, spacing = 0.5, maxPoints = 400, g = GRAVITY }) {
  const v = launchSpeed(range, g);
  const vx = dir.x * v, vy = dir.y * v, vz = dir.z * v;
  const dt = spacing / v;
  const at = (t) => ({ x: origin.x + vx * t, y: origin.y + vy * t - 0.5 * g * t * t, z: origin.z + vz * t });
  const below = (p) => p.y <= heightAt(p.x, p.z);
  const points = [{ ...origin }];
  let t0 = 0;
  for (let i = 1; i <= maxPoints; i++) {
    const t1 = i * dt;
    const p = at(t1);
    if (below(p)) {
      // Bisect between the last point above ground and this one.
      let a = t0, b = t1;
      for (let k = 0; k < 24; k++) {
        const m = (a + b) / 2;
        if (below(at(m))) b = m; else a = m;
      }
      const hit = at(b);
      hit.y = heightAt(hit.x, hit.z);
      points.push(hit);
      const valid = hit.x >= EDGE_MARGIN_M && hit.z >= EDGE_MARGIN_M && hit.x <= size - EDGE_MARGIN_M && hit.z <= size - EDGE_MARGIN_M;
      return { points, hit, valid };
    }
    points.push(p);
    t0 = t1;
  }
  return { points, hit: null, valid: false };
}

// Where the rig goes so the head ends up over `target`: shift by the difference.
export function rigShift(head, target) {
  return { dx: target.x - head.x, dz: target.z - head.z };
}

// Where a straight line of sight from `origin` along unit `dir` first meets the
// ground, within maxDist metres (desktop teleport: the spot under the crosshair).
export function rayGround(origin, dir, heightAt, maxDist = 400, step = 1) {
  const at = (s) => ({ x: origin.x + dir.x * s, y: origin.y + dir.y * s, z: origin.z + dir.z * s });
  let a = 0;
  for (let s = step; s <= maxDist; s += step) {
    const p = at(s);
    if (p.y <= heightAt(p.x, p.z)) {
      let lo = a, hi = s;
      for (let k = 0; k < 24; k++) {
        const m = (lo + hi) / 2;
        const q = at(m);
        if (q.y <= heightAt(q.x, q.z)) hi = m; else lo = m;
      }
      const hit = at(hi);
      hit.y = heightAt(hit.x, hit.z);
      return hit;
    }
    a = s;
  }
  return null;
}
