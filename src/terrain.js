// Terrain loading and mesh building (spec section 5.4).
import * as THREE from 'three';
import { decodeHeights, Heightfield } from './heightfield.js';
import { dataUrl } from './data-url.js';
import { GROUND_FX, patchGround } from './ground-fx.js';

const CHUNKS = 8;
const DETAIL_TILE_M = 6; // detail texture repeats every this many metres

async function fetchOk(url, kind) {
  const res = await fetch(dataUrl(url));
  if (!res.ok) throw new Error(`Could not load ${url} (${res.status})`);
  return kind === 'json' ? res.json() : res.arrayBuffer();
}

export async function loadSite(baseUrl) {
  const site = await fetchOk(`${baseUrl}/site.json`, 'json');
  const [hBuf, sBuf] = await Promise.all([
    fetchOk(`${baseUrl}/height.bin`),
    fetchOk(`${baseUrl}/skirt.bin`),
  ]);
  const heights = decodeHeights(hBuf, site.elev_min, site.elev_max, site.elev_ref);
  const field = new Heightfield(heights, site.grid, site.spacing_m);
  const sk = site.skirt;
  const skirtHeights = decodeHeights(sBuf, sk.elev_min, sk.elev_max, site.elev_ref);
  const skirtField = new Heightfield(skirtHeights, sk.grid, sk.spacing_m);
  return { site, field, skirtField, baseUrl };
}

// Small deterministic hash for per-vertex colour jitter.
function hash2(x, z) {
  let h = (Math.imul(x | 0, 374761393) + Math.imul(z | 0, 668265263)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

const GRASS_LOW = new THREE.Color(0x4f6b32);
const GRASS_HIGH = new THREE.Color(0x6d7442);
const DIRT = new THREE.Color(0x6b5a3e);
const ROCK = new THREE.Color(0x77706a);
const tmp = new THREE.Color();

// Ground colour from slope (0 flat .. 1 vertical normal.y inverse) and relative elevation.
const LITTER = new THREE.Color(0x5e4e36);

// cover: tree cover 0..1. Under trees the floor is leaf litter, in clearings grass.
function groundColor(out, normalY, elevT, jitter, cover = 0) {
  out.copy(GRASS_LOW).lerp(GRASS_HIGH, elevT);
  out.lerp(LITTER, cover * 0.85);
  const steep = THREE.MathUtils.smoothstep(1 - normalY, 0.06, 0.25);
  tmp.copy(DIRT).lerp(ROCK, THREE.MathUtils.smoothstep(1 - normalY, 0.2, 0.45));
  out.lerp(tmp, steep);
  const j = 0.9 + jitter * 0.2;
  out.r *= j; out.g *= j; out.b *= j;
  return out;
}

function makeDetailTexture(renderer) {
  const n = 256;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = n;
  const ctx = canvas.getContext('2d');
  const img = ctx.createImageData(n, n);
  // Two octaves of tileable value noise plus fine grain, centred near white so it
  // modulates the vertex colour instead of darkening it.
  const octave = (cells, seed) => {
    const lat = new Float32Array(cells * cells);
    for (let i = 0; i < lat.length; i++) lat[i] = hash2(i + seed * 7919, seed);
    return (x, y) => {
      const fx = (x / n) * cells, fy = (y / n) * cells;
      const x0 = Math.floor(fx), y0 = Math.floor(fy);
      const tx = fx - x0, ty = fy - y0;
      const sx = tx * tx * (3 - 2 * tx), sy = ty * ty * (3 - 2 * ty);
      const at = (i, j) => lat[((j % cells) * cells) + (i % cells)];
      const a = at(x0, y0), b = at(x0 + 1, y0), c = at(x0, y0 + 1), d = at(x0 + 1, y0 + 1);
      return (a + (b - a) * sx) * (1 - sy) + (c + (d - c) * sx) * sy;
    };
  };
  const o1 = octave(8, 1), o2 = octave(32, 2);
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const v = 0.72 + 0.16 * o1(x, y) + 0.08 * o2(x, y) + 0.06 * hash2(x, y + 99);
      const c = Math.round(Math.min(1, v) * 255);
      const i = (y * n + x) * 4;
      img.data[i] = c; img.data[i + 1] = c; img.data[i + 2] = c; img.data[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = renderer.capabilities.getMaxAnisotropy();
  return tex;
}

const slopeOf = (ny) => Math.sqrt(Math.max(0, 1 - ny * ny)) / ny;

function buildChunk(field, r0, r1, c0, c1, elevSpan, coverAt) {
  const g = field.grid;
  const sp = field.spacing;
  const h = field.heights;
  const rows = r1 - r0 + 1;
  const cols = c1 - c0 + 1;
  const count = rows * cols;
  const pos = new Float32Array(count * 3);
  const nor = new Float32Array(count * 3);
  const col = new Float32Array(count * 3);
  const uv = new Float32Array(count * 2);
  const cov = new Float32Array(count);
  const c = new THREE.Color();
  let v = 0;
  for (let r = r0; r <= r1; r++) {
    for (let cc = c0; cc <= c1; cc++) {
      const x = cc * sp;
      const z = r * sp;
      const y = h[r * g + cc];
      pos[v * 3] = x; pos[v * 3 + 1] = y; pos[v * 3 + 2] = z;
      // Normal from the full field so chunk seams shade identically.
      const hl = field.sample(r, cc - 1), hr = field.sample(r, cc + 1);
      const hu = field.sample(r - 1, cc), hd = field.sample(r + 1, cc);
      const dx = (cc > 0 && cc < g - 1 ? 2 : 1) * sp;
      const dz = (r > 0 && r < g - 1 ? 2 : 1) * sp;
      let nx = -(hr - hl) / dx, ny = 1, nz = -(hd - hu) / dz;
      const len = Math.hypot(nx, ny, nz);
      nx /= len; ny /= len; nz /= len;
      nor[v * 3] = nx; nor[v * 3 + 1] = ny; nor[v * 3 + 2] = nz;
      cov[v] = coverAt ? coverAt(x, z, slopeOf(ny)) : 0;
      groundColor(c, ny, elevSpan > 0 ? y / elevSpan : 0, hash2(cc, r), cov[v]);
      col[v * 3] = c.r; col[v * 3 + 1] = c.g; col[v * 3 + 2] = c.b;
      uv[v * 2] = x / DETAIL_TILE_M; uv[v * 2 + 1] = z / DETAIL_TILE_M;
      v++;
    }
  }
  const idx = [];
  for (let r = 0; r < rows - 1; r++) {
    for (let k = 0; k < cols - 1; k++) {
      const a = r * cols + k, b = a + 1, d = a + cols, e = d + 1;
      idx.push(a, d, b, b, d, e);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  geo.setAttribute('cover', new THREE.BufferAttribute(cov, 1));
  geo.setIndex(idx);
  geo.computeBoundingBox();
  geo.computeBoundingSphere();
  return geo;
}

function buildSkirt(site, field, skirtField, material, coverAt) {
  const sk = site.skirt;
  const g = sk.grid;
  const sp = sk.spacing_m;
  const ox = sk.e_west - site.e_west;
  const oz = site.n_north - sk.n_north;
  const size = site.size_m;
  const pos = new Float32Array(g * g * 3);
  const col = new Float32Array(g * g * 3);
  const uv = new Float32Array(g * g * 2);
  const cov = new Float32Array(g * g);
  const inside = (x, z) => x >= 0 && z >= 0 && x <= size && z <= size;
  const span = site.elev_max - site.elev_min;
  const c = new THREE.Color();
  for (let r = 0; r < g; r++) {
    for (let k = 0; k < g; k++) {
      const i = r * g + k;
      const x = ox + k * sp;
      const z = oz + r * sp;
      // Where the skirt overlaps the playable mesh, tuck it just under the real surface.
      const y = inside(x, z) ? field.heightAt(x, z) - 0.6 : skirtField.heights[i];
      pos[i * 3] = x; pos[i * 3 + 1] = y; pos[i * 3 + 2] = z;
      const ny = 1 / Math.hypot(1, skirtField.slopeAt(x - ox, z - oz, 1, 0), skirtField.slopeAt(x - ox, z - oz, 0, 1));
      cov[i] = coverAt ? coverAt(x, z, slopeOf(ny)) : 0;
      groundColor(c, ny, span > 0 ? THREE.MathUtils.clamp(y / span, 0, 1) : 0, hash2(k + 7, r + 3), cov[i]);
      col[i * 3] = c.r; col[i * 3 + 1] = c.g; col[i * 3 + 2] = c.b;
      uv[i * 2] = x / DETAIL_TILE_M; uv[i * 2 + 1] = z / DETAIL_TILE_M;
    }
  }
  const idx = [];
  for (let r = 0; r < g - 1; r++) {
    for (let k = 0; k < g - 1; k++) {
      const x0 = ox + k * sp, x1 = x0 + sp, z0 = oz + r * sp, z1 = z0 + sp;
      // Skip cells the playable mesh covers completely.
      if (x0 >= 0 && z0 >= 0 && x1 <= size && z1 <= size) continue;
      const a = r * g + k, b = a + 1, d = a + g, e = d + 1;
      idx.push(a, d, b, b, d, e);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  geo.setAttribute('cover', new THREE.BufferAttribute(cov, 1));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  geo.computeBoundingSphere();
  const mesh = new THREE.Mesh(geo, material);
  mesh.name = 'skirt';
  return mesh;
}

// coverAt(x, z, slope): tree cover 0..1, for colouring the ground. Close up, the
// ground under trees is leaf litter; past the edge of the drawn trees it blends to
// canopy green, which is what a forested hillside looks like from a distance.
export function buildTerrain(renderer, { site, field, skirtField }, { coverAt } = {}) {
  const group = new THREE.Group();
  group.name = 'terrain';

  const detail = makeDetailTexture(renderer);
  const ground = new THREE.MeshLambertMaterial({ vertexColors: true, map: detail });
  const canopyRange = { value: new THREE.Vector2(1e6, 2e6) };
  ground.onBeforeCompile = (sh) => {
    sh.uniforms.canopyColor = GROUND_FX.canopyColor;
    sh.uniforms.canopyRange = canopyRange;
    sh.vertexShader = 'attribute float cover;\nvarying float vCover;\n'
      + sh.vertexShader.replace('#include <begin_vertex>', '#include <begin_vertex>\n  vCover = cover;');
    sh.uniforms.gfxAerialOn = { get value() { return GROUND_FX.aerialBox.value.w; } };
    // Past the drawn trees the ground reads as canopy, unless the aerial photographs
    // are there to show the real thing.
    sh.fragmentShader = 'uniform vec3 canopyColor;\nuniform vec2 canopyRange;\nuniform float gfxAerialOn;\nvarying float vCover;\n'
      + sh.fragmentShader.replace('#include <color_fragment>',
        '#include <color_fragment>\n  diffuseColor.rgb = mix(diffuseColor.rgb, canopyColor, (1.0 - gfxAerialOn) * vCover * smoothstep(canopyRange.x, canopyRange.y, length(vViewPosition)));');
    patchGround(sh, { withCover: true, aerial: true });
  };

  const cells = field.grid - 1;
  const span = site.elev_max - site.elev_min;
  let triangles = 0;
  for (let i = 0; i < CHUNKS; i++) {
    const r0 = Math.round((i * cells) / CHUNKS);
    const r1 = Math.round(((i + 1) * cells) / CHUNKS);
    for (let j = 0; j < CHUNKS; j++) {
      const c0 = Math.round((j * cells) / CHUNKS);
      const c1 = Math.round(((j + 1) * cells) / CHUNKS);
      const geo = buildChunk(field, r0, r1, c0, c1, span, coverAt);
      triangles += geo.index.count / 3;
      const mesh = new THREE.Mesh(geo, ground);
      mesh.name = `chunk-${i}-${j}`;
      mesh.matrixAutoUpdate = false;
      group.add(mesh);
    }
  }
  const skirt = buildSkirt(site, field, skirtField, ground, coverAt);
  skirt.matrixAutoUpdate = false;
  triangles += skirt.geometry.index.count / 3;
  group.add(skirt);

  return {
    group,
    triangles,
    heightAt: (x, z) => field.heightAt(x, z),
    slopeAt: (x, z, dx, dz) => field.slopeAt(x, z, dx, dz),
    size: field.size,
    // Where the ground starts reading as canopy (metres from the eye). Off: pass 0, 0.
    setCanopyRange(near, far) {
      canopyRange.value.set(near > 0 ? near : 1e6, far > 0 ? far : 2e6);
    },
  };
}
