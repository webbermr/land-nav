// Keeps the walker out of trees, logs, rocks and buildings. Pure functions, no
// Three.js. The walker is a circle; you slide along whatever you bump into.
//
// Obstacles:
//   { type: 'circle', x, z, r }                    tree trunk, rock
//   { type: 'capsule', ax, az, bx, bz, r }         fallen log
//   { type: 'poly', pts: [[x, z], ...] }           building footprint

import { closestOnSegment, pointInPolygon } from './features-logic.js';

// Push (x, z) out of every obstacle. A few passes settle corners where two
// obstacles touch. Returns { x, z, hit }.
export function resolveCollisions(x, z, radius, obstacles, passes = 3) {
  let hit = false;
  for (let pass = 0; pass < passes; pass++) {
    let moved = false;
    for (const o of obstacles) {
      let cx, cz, reach;
      let inside = false;
      if (o.type === 'circle') {
        cx = o.x; cz = o.z; reach = o.r + radius;
      } else if (o.type === 'capsule') {
        const c = closestOnSegment(x, z, o.ax, o.az, o.bx, o.bz);
        cx = c.x; cz = c.z; reach = o.r + radius;
      } else {
        // Nearest point on the footprint's outline.
        let best = null;
        for (let i = 0, j = o.pts.length - 1; i < o.pts.length; j = i++) {
          const c = closestOnSegment(x, z, o.pts[j][0], o.pts[j][1], o.pts[i][0], o.pts[i][1]);
          if (!best || c.d < best.d) best = c;
        }
        cx = best.x; cz = best.z; reach = radius;
        inside = pointInPolygon(x, z, o.pts);
      }
      let dx = x - cx, dz = z - cz;
      const d = Math.hypot(dx, dz);
      if (!inside && d >= reach) continue;
      if (d < 1e-9) { dx = 1; dz = 0; } else { dx /= d; dz /= d; }
      // Inside a footprint the outward direction is from the point to the edge.
      if (inside) { dx = -dx; dz = -dz; }
      const push = inside ? d + reach : reach - d;
      x += dx * push;
      z += dz * push;
      hit = moved = true;
    }
    if (!moved) break;
  }
  return { x, z, hit };
}
