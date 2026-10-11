// Real tree cover from the National Land Cover Database (tools/make_landcover.py).
// Pure functions, no Three.js.
//
// landcover.bin is grid*grid NLCD class bytes, then grid*grid tree canopy percent
// bytes, row 0 north, column 0 west, `spacing` metres apart. Where a site has it,
// it decides where the forest, fields and conifers are; noise only adds texture
// below the 30 m the data resolves.
import { valueNoise } from './vegetation-logic.js';

export const NLCD_NAMES = Object.freeze({
  11: 'open water', 12: 'ice', 21: 'developed, open space', 22: 'developed, low', 23: 'developed, medium',
  24: 'developed, high', 31: 'barren', 41: 'deciduous forest', 42: 'evergreen forest', 43: 'mixed forest',
  51: 'dwarf scrub', 52: 'shrub/scrub', 71: 'grassland', 72: 'sedge', 81: 'pasture/hay', 82: 'cultivated crops',
  90: 'woody wetlands', 95: 'herbaceous wetlands',
});

// Share of the trees that are conifers, by class.
const EVERGREEN = { 42: 1, 43: 0.5, 90: 0.25 };

export class LandCover {
  constructor(buffer, { grid, spacing_m: spacing }) {
    const bytes = new Uint8Array(buffer);
    if (bytes.length !== 2 * grid * grid) throw new Error(`landcover.bin should be ${2 * grid * grid} bytes, got ${bytes.length}`);
    this.grid = grid;
    this.spacing = spacing;
    this.classes = bytes.subarray(0, grid * grid);
    this.canopy = bytes.subarray(grid * grid);
    this.evergreen = new Float32Array(grid * grid);
    for (let i = 0; i < this.classes.length; i++) this.evergreen[i] = EVERGREEN[this.classes[i]] ?? 0;
  }

  bilinear(arr, x, z) {
    const g = this.grid;
    const fc = Math.min(g - 1, Math.max(0, x / this.spacing));
    const fr = Math.min(g - 1, Math.max(0, z / this.spacing));
    const c0 = Math.min(g - 2, Math.floor(fc)), r0 = Math.min(g - 2, Math.floor(fr));
    const tc = fc - c0, tr = fr - r0;
    const i = r0 * g + c0;
    const top = arr[i] + (arr[i + 1] - arr[i]) * tc;
    const bot = arr[i + g] + (arr[i + g + 1] - arr[i + g]) * tc;
    return top + (bot - top) * tr;
  }

  // Tree canopy cover 0..1, smooth between cells.
  canopyAt(x, z) {
    return this.bilinear(this.canopy, x, z) / 100;
  }

  // Share of conifers 0..1, smooth between cells.
  evergreenAt(x, z) {
    return this.bilinear(this.evergreen, x, z);
  }

  classAt(x, z) {
    const g = this.grid;
    const c = Math.min(g - 1, Math.max(0, Math.round(x / this.spacing)));
    const r = Math.min(g - 1, Math.max(0, Math.round(z / this.spacing)));
    return this.classes[r * g + c];
  }
}

// Tree cover 0..1 at a point: the canopy percent, roughened by noise at a scale
// finer than the 30 m data, and thinned on very steep ground like forestCover.
export function landcoverCover(lc, seed, x, z, slope) {
  const c = lc.canopyAt(x, z);
  const n = valueNoise(seed + 3, x, z, 14) - 0.5;
  const cover = Math.min(1, Math.max(0, c * 1.05 + 0.4 * n * Math.min(c, 1 - c + 0.3)));
  const t = Math.min(1, Math.max(0, (slope - 0.55) / 0.55));
  return cover * (1 - 0.55 * t * t * (3 - 2 * t));
}
