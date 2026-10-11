// Heightfield sampling. Pure functions, no Three.js, so they can be unit tested.
//
// Row 0 is the north edge, column 0 is the west edge.
//   row = z / spacing, col = x / spacing

// Decode little-endian Uint16 samples into elevations relative to elevRef (scene y).
export function decodeHeights(buffer, elevMin, elevMax, elevRef = elevMin) {
  const dv = new DataView(buffer);
  const n = buffer.byteLength / 2;
  const out = new Float32Array(n);
  const scale = (elevMax - elevMin) / 65535;
  for (let i = 0; i < n; i++) {
    out[i] = elevMin + dv.getUint16(i * 2, true) * scale - elevRef;
  }
  return out;
}

export class Heightfield {
  // heights: Float32Array of grid*grid samples, row-major.
  constructor(heights, grid, spacing) {
    if (heights.length !== grid * grid) {
      throw new Error(`Heightfield expects ${grid * grid} samples, got ${heights.length}`);
    }
    this.heights = heights;
    this.grid = grid;
    this.spacing = spacing;
    this.size = (grid - 1) * spacing;
  }

  sample(row, col) {
    const g = this.grid;
    const r = row < 0 ? 0 : row >= g ? g - 1 : row;
    const c = col < 0 ? 0 : col >= g ? g - 1 : col;
    return this.heights[r * g + c];
  }

  // Bilinear height at scene (x, z). Clamped to the edge outside the grid.
  heightAt(x, z) {
    const g = this.grid;
    let fc = x / this.spacing;
    let fr = z / this.spacing;
    fc = fc < 0 ? 0 : fc > g - 1 ? g - 1 : fc;
    fr = fr < 0 ? 0 : fr > g - 1 ? g - 1 : fr;
    let c0 = Math.floor(fc);
    let r0 = Math.floor(fr);
    if (c0 >= g - 1) c0 = g - 2;
    if (r0 >= g - 1) r0 = g - 2;
    const tc = fc - c0;
    const tr = fr - r0;
    const h = this.heights;
    const i = r0 * g + c0;
    const top = h[i] + (h[i + 1] - h[i]) * tc;
    const bot = h[i + g] + (h[i + g + 1] - h[i + g]) * tc;
    return top + (bot - top) * tr;
  }

  // Height of the drawn terrain mesh at (x, z). Each grid cell is two triangles split
  // on the NE-SW diagonal (see buildChunk in terrain.js), so this is planar per
  // triangle rather than bilinear. Things laid on the ground (roads) use it so they
  // sit exactly on the surface you see.
  meshHeightAt(x, z) {
    const g = this.grid;
    let fc = x / this.spacing;
    let fr = z / this.spacing;
    fc = fc < 0 ? 0 : fc > g - 1 ? g - 1 : fc;
    fr = fr < 0 ? 0 : fr > g - 1 ? g - 1 : fr;
    let c0 = Math.floor(fc);
    let r0 = Math.floor(fr);
    if (c0 >= g - 1) c0 = g - 2;
    if (r0 >= g - 1) r0 = g - 2;
    const tc = fc - c0;
    const tr = fr - r0;
    const h = this.heights;
    const a = h[r0 * g + c0], b = h[r0 * g + c0 + 1];
    const d = h[(r0 + 1) * g + c0], e = h[(r0 + 1) * g + c0 + 1];
    if (tc + tr <= 1) return a + (b - a) * tc + (d - a) * tr;
    return e + (d - e) * (1 - tc) + (b - e) * (1 - tr);
  }

  // Signed grade (rise over run) in the direction of travel. Positive is uphill.
  // Uses a central difference over one grid spacing so it is smooth across cells.
  slopeAt(x, z, dirX, dirZ) {
    const len = Math.hypot(dirX, dirZ);
    if (len === 0) return 0;
    const ux = dirX / len;
    const uz = dirZ / len;
    const d = this.spacing * 0.5;
    return (this.heightAt(x + ux * d, z + uz * d) - this.heightAt(x - ux * d, z - uz * d)) / (2 * d);
  }

  // Unit surface normal (scene axes) from central differences.
  normalAt(x, z) {
    const d = this.spacing;
    const dhdx = (this.heightAt(x + d, z) - this.heightAt(x - d, z)) / (2 * d);
    const dhdz = (this.heightAt(x, z + d) - this.heightAt(x, z - d)) / (2 * d);
    const len = Math.hypot(dhdx, 1, dhdz);
    return { x: -dhdx / len, y: 1 / len, z: -dhdz / len };
  }

  contains(x, z, margin = 0) {
    return x >= margin && z >= margin && x <= this.size - margin && z <= this.size - margin;
  }
}
