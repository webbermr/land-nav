// Site features from OpenStreetMap (roads, trails, streams, the campground,
// parking, buildings): fast lookups for clearing trees, placing stakes and
// collision. Pure functions, no Three.js. Format: tools/make_features.py.

const CELL_M = 32;

// Extra tree-free margin either side of a line feature, beyond its own width.
export const LINE_CLEAR_M = Object.freeze({ road: 2.5, track: 1.5, trail: 0.6, stream: 1 });
// Tree density multiplier inside an area. Buildings also clear a margin around them.
export const AREA_DENSITY = Object.freeze({ campground: 0.35, clearing: 0.04, parking: 0, building: 0, water: 0 });
const BUILDING_CLEAR_M = 2.5;

// Even-odd rule. pts: [[x, z], ...], open (first point not repeated).
export function pointInPolygon(x, z, pts) {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, zi] = pts[i], [xj, zj] = pts[j];
    if ((zi > z) !== (zj > z) && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
}

// Closest point on segment a-b to p, and the distance to it.
export function closestOnSegment(px, pz, ax, az, bx, bz) {
  const vx = bx - ax, vz = bz - az;
  const len2 = vx * vx + vz * vz;
  let t = len2 > 0 ? ((px - ax) * vx + (pz - az) * vz) / len2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const x = ax + vx * t, z = az + vz * t;
  return { x, z, d: Math.hypot(px - x, pz - z) };
}

// Distance from a point to a polygon's boundary.
export function polygonEdgeDistance(x, z, pts) {
  let best = Infinity;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const c = closestOnSegment(x, z, pts[j][0], pts[j][1], pts[i][0], pts[i][1]);
    if (c.d < best) best = c.d;
  }
  return best;
}

function bbox(pts, pad = 0) {
  let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
  for (const [x, z] of pts) {
    if (x < x0) x0 = x; if (x > x1) x1 = x;
    if (z < z0) z0 = z; if (z > z1) z1 = z;
  }
  return { x0: x0 - pad, z0: z0 - pad, x1: x1 + pad, z1: z1 + pad };
}

export class FeatureIndex {
  constructor(features) {
    this.features = features || { lines: [], areas: [], points: [] };
    this.cells = new Map();
    this.buildings = [];
    for (const line of this.features.lines || []) {
      const clear = line.width / 2 + (LINE_CLEAR_M[line.kind] ?? 1);
      for (let i = 1; i < line.pts.length; i++) {
        const [ax, az] = line.pts[i - 1], [bx, bz] = line.pts[i];
        const seg = { kind: line.kind, ax, az, bx, bz, half: line.width / 2, clear };
        this.insert(bbox([[ax, az], [bx, bz]], clear), 'segs', seg);
      }
    }
    for (const area of this.features.areas || []) {
      const a = { ...area, box: bbox(area.pts) };
      const pad = area.kind === 'building' ? BUILDING_CLEAR_M : 0;
      this.insert(bbox(area.pts, pad), 'areas', a);
      if (area.kind === 'building') this.buildings.push(a);
    }
  }

  key(cx, cz) {
    return cx * 100003 + cz;
  }

  insert(box, list, item) {
    for (let cx = Math.floor(box.x0 / CELL_M); cx <= Math.floor(box.x1 / CELL_M); cx++) {
      for (let cz = Math.floor(box.z0 / CELL_M); cz <= Math.floor(box.z1 / CELL_M); cz++) {
        const k = this.key(cx, cz);
        let cell = this.cells.get(k);
        if (!cell) this.cells.set(k, (cell = { segs: [], areas: [] }));
        cell[list].push(item);
      }
    }
  }

  cellAt(x, z) {
    return this.cells.get(this.key(Math.floor(x / CELL_M), Math.floor(z / CELL_M)));
  }

  // Tree density multiplier at a point: 0 on roads, trails, parking and around
  // buildings, thinner in the campground, 1 in open forest.
  density(x, z) {
    const cell = this.cellAt(x, z);
    if (!cell) return 1;
    for (const s of cell.segs) {
      if (closestOnSegment(x, z, s.ax, s.az, s.bx, s.bz).d < s.clear) return 0;
    }
    let d = 1;
    for (const a of cell.areas) {
      const mult = AREA_DENSITY[a.kind] ?? 1;
      if (mult >= d) continue;
      const inside = pointInPolygon(x, z, a.pts);
      if (inside || (a.kind === 'building' && polygonEdgeDistance(x, z, a.pts) < BUILDING_CLEAR_M)) d = mult;
    }
    return d;
  }

  // What kind of surface is underfoot, for footstep sounds and the HUD: the line
  // feature you're on, else the area, else null.
  surfaceAt(x, z) {
    const cell = this.cellAt(x, z);
    if (!cell) return null;
    for (const s of cell.segs) {
      if (closestOnSegment(x, z, s.ax, s.az, s.bx, s.bz).d <= s.half) return s.kind;
    }
    for (const a of cell.areas) if (pointInPolygon(x, z, a.pts)) return a.kind;
    return null;
  }

  // Distance to the nearest feature of the given kinds, searching out to maxR.
  // Returns Infinity if none is that close.
  distanceTo(x, z, kinds, maxR) {
    let best = Infinity;
    const seen = new Set();
    for (let cx = Math.floor((x - maxR) / CELL_M); cx <= Math.floor((x + maxR) / CELL_M); cx++) {
      for (let cz = Math.floor((z - maxR) / CELL_M); cz <= Math.floor((z + maxR) / CELL_M); cz++) {
        const cell = this.cells.get(this.key(cx, cz));
        if (!cell) continue;
        for (const s of cell.segs) {
          if (!kinds.includes(s.kind) || seen.has(s)) continue;
          seen.add(s);
          best = Math.min(best, Math.max(0, closestOnSegment(x, z, s.ax, s.az, s.bx, s.bz).d - s.half));
        }
        for (const a of cell.areas) {
          if (!kinds.includes(a.kind) || seen.has(a)) continue;
          seen.add(a);
          best = Math.min(best, pointInPolygon(x, z, a.pts) ? 0 : polygonEdgeDistance(x, z, a.pts));
        }
      }
    }
    return best <= maxR ? best : Infinity;
  }

  // Buildings near a point, as collision polygons.
  buildingsNear(x, z, r) {
    return this.buildings.filter((b) => x + r >= b.box.x0 && x - r <= b.box.x1 && z + r >= b.box.z0 && z - r <= b.box.z1);
  }
}

// Keeps course stakes off roads, parking, buildings and out of the campground:
// a stake beside a road is found by walking the road, not by navigating.
export const STAKE_AVOID_KINDS = Object.freeze(['road', 'track', 'parking', 'building', 'campground']);
export const STAKE_AVOID_M = 30;

export function stakeAvoider(index, kinds = STAKE_AVOID_KINDS, metres = STAKE_AVOID_M) {
  return (p) => index.distanceTo(p.x, p.z, kinds, metres) < metres;
}
