// Where trees, shrubs, logs and rocks go (spec 5.4: "instanced trees, density from
// seeded noise, sparser on steep slopes"). Pure functions, no Three.js.
//
// Placement is deterministic per site and tile, so the same tree is always in the
// same place. Only tiles near the player are ever generated.

export const TILE_M = 32;

// 32-bit integer hash of a few integers.
export function hashInts(...v) {
  let h = 0x811c9dc5;
  for (const x of v) {
    h = Math.imul(h ^ (x | 0), 0x01000193);
    h ^= h >>> 15;
    h = Math.imul(h, 0x2c1b3c6d);
    h ^= h >>> 12;
  }
  return h >>> 0;
}

export function hashString(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193);
  return h >>> 0;
}

const unit = (h) => h / 4294967296;

// Smooth value noise in [0, 1], one octave, `cell` metres per lattice step.
export function valueNoise(seed, x, z, cell) {
  const fx = x / cell, fz = z / cell;
  const x0 = Math.floor(fx), z0 = Math.floor(fz);
  let tx = fx - x0, tz = fz - z0;
  tx = tx * tx * (3 - 2 * tx);
  tz = tz * tz * (3 - 2 * tz);
  const v = (i, j) => unit(hashInts(seed, x0 + i, z0 + j));
  const a = v(0, 0), b = v(1, 0), c = v(0, 1), d = v(1, 1);
  return (a + (b - a) * tx) * (1 - tz) + (c + (d - c) * tx) * tz;
}

function smoothstep(e0, e1, x) {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
}

// Tree cover in [0, 1]: mostly forest with clearings, thinner on very steep ground.
// slope is the steepest grade at the point (0.3 = 30%).
export function forestCover(seed, x, z, slope) {
  const n = 0.65 * valueNoise(seed, x, z, 210) + 0.35 * valueNoise(seed + 7, x, z, 70);
  const cover = smoothstep(0.3, 0.46, n);
  const steep = 1 - 0.55 * smoothstep(0.55, 1.1, slope);
  return cover * steep;
}

export const SPECIES = Object.freeze(['oak', 'conifer', 'sapling']);

// Trees in one tile: a jittered grid, each candidate kept with probability equal to
// the cover there (times the preset's density). Returns
// [{ x, z, species, scale, rot, tint }].
// opts: { seed, density (0..1 preset multiplier), slopeAt(x,z), size (area metres),
//         spacing (metres between candidates), exclude: [{x,z}], excludeR,
//         densityAt(x,z) (optional 0..1 multiplier: roads, campground) }
export function tileTrees(tx, tz, opts) {
  const { seed, density = 1, slopeAt, size, spacing = 6.5, exclude = [], excludeR = 4, densityAt } = opts;
  const out = [];
  const n = Math.round(TILE_M / spacing);
  const step = TILE_M / n;
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      const h = hashInts(seed, tx, tz, i, j);
      const x = tx * TILE_M + (i + 0.15 + 0.7 * unit(hashInts(h, 1))) * step;
      const z = tz * TILE_M + (j + 0.15 + 0.7 * unit(hashInts(h, 2))) * step;
      if (x < 0 || z < 0 || x > size || z > size) continue;
      const slope = slopeAt(x, z);
      let p = forestCover(seed, x, z, slope) * density;
      if (densityAt && p > 0) p *= densityAt(x, z);
      if (unit(hashInts(h, 3)) >= p) continue;
      if (exclude.some((e) => (e.x - x) ** 2 + (e.z - z) ** 2 < excludeR * excludeR)) continue;
      const r = unit(hashInts(h, 4));
      // Hardwoods dominate here; conifers (hemlock, pine) in patches; saplings fill in.
      const conifery = valueNoise(seed + 99, x, z, 160);
      const species = r < 0.16 ? 'sapling' : (r < 0.16 + 0.55 * conifery ? 'conifer' : 'oak');
      out.push({
        x, z, species,
        scale: 0.75 + 0.55 * unit(hashInts(h, 5)),
        rot: unit(hashInts(h, 6)) * Math.PI * 2,
        tint: unit(hashInts(h, 7)),
      });
    }
  }
  return out;
}

// Ground clutter near the player: shrubs (more in clearings and at edges), fallen
// logs (in the forest), rocks (on steep ground). Returns [{ x, z, kind, scale, rot, tint }].
export function tileClutter(tx, tz, opts) {
  const { seed, slopeAt, size, exclude = [], excludeR = 2.5, densityAt } = opts;
  const out = [];
  const n = 8, step = TILE_M / n;
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      const h = hashInts(seed + 1234, tx, tz, i, j);
      const x = tx * TILE_M + (i + unit(hashInts(h, 1))) * step;
      const z = tz * TILE_M + (j + unit(hashInts(h, 2))) * step;
      if (x < 0 || z < 0 || x > size || z > size) continue;
      if (exclude.some((e) => (e.x - x) ** 2 + (e.z - z) ** 2 < excludeR * excludeR)) continue;
      // Nothing on roads and trails; less in the campground.
      if (densityAt && unit(hashInts(h, 8)) >= densityAt(x, z)) continue;
      const slope = slopeAt(x, z);
      const cover = forestCover(seed, x, z, slope);
      const r = unit(hashInts(h, 3));
      let kind = null;
      const edge = 1 - Math.abs(cover - 0.5) * 2; // 1 at the forest edge
      if (r < 0.07 + 0.12 * edge + 0.06 * (1 - cover)) kind = 'shrub';
      else if (r < 0.2 + 0.1 * edge && r >= 0.19 && cover > 0.5) kind = 'log';
      else if (slope > 0.45 && r > 0.93) kind = 'rock';
      if (!kind) continue;
      out.push({
        x, z, kind,
        scale: 0.7 + 0.7 * unit(hashInts(h, 5)),
        rot: unit(hashInts(h, 6)) * Math.PI * 2,
        tint: unit(hashInts(h, 7)),
      });
    }
  }
  return out;
}
