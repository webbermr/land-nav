// Trees, shrubs, logs and rocks around the player (spec 5.4 and 11): instanced,
// low-poly up close, crossed-quad cut-outs farther out, only near the player.
import * as THREE from 'three';
import { TILE_M, hashString, tileTrees, tileClutter, forestCover } from './vegetation-logic.js';

// Radii in metres for each quality level: full trees, cut-outs, ground clutter.
export const VEGETATION_QUALITY = Object.freeze({
  off: { near: 0, far: 0, clutter: 0 },
  low: { near: 50, far: 140, clutter: 35 },
  medium: { near: 80, far: 200, clutter: 50 },
  high: { near: 110, far: 280, clutter: 70 },
});
export const PRESET_DENSITY = Object.freeze({ woods: 1, open: 0.18 });
const REFRESH_M = 8; // rebuild instance lists after moving this far

// ---- Geometry: built once, merged, coloured per vertex ----

function colored(geo, hex) {
  const c = new THREE.Color(hex);
  const n = geo.attributes.position.count;
  const col = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) { col[i * 3] = c.r; col[i * 3 + 1] = c.g; col[i * 3 + 2] = c.b; }
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  return geo;
}

function merge(geos) {
  const parts = geos.map((g) => (g.index ? g.toNonIndexed() : g));
  const total = parts.reduce((s, g) => s + g.attributes.position.count, 0);
  const pos = new Float32Array(total * 3), nor = new Float32Array(total * 3), col = new Float32Array(total * 3);
  let o = 0;
  for (const g of parts) {
    if (!g.attributes.normal) g.computeVertexNormals();
    pos.set(g.attributes.position.array, o * 3);
    nor.set(g.attributes.normal.array, o * 3);
    col.set(g.attributes.color.array, o * 3);
    o += g.attributes.position.count;
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  out.setAttribute('color', new THREE.BufferAttribute(col, 3));
  out.computeBoundingSphere();
  return out;
}

// Mature Blue Ridge hardwoods are tall: a long bare trunk and a crown well overhead.
function oakParts() {
  const trunk = colored(new THREE.CylinderGeometry(0.2, 0.32, 13, 7, 1, true).translate(0, 6.5, 0), 0x7a6b5b);
  // Six low-poly blobs (20 triangles each) make a fuller crown than a few smooth ones.
  const blobs = [[0, 15.6, 0, 3.4], [2.3, 14.2, 0.9, 2.7], [-2, 14.5, -1.2, 2.9], [0.7, 13.6, -2.3, 2.5], [-0.9, 17.4, 1.1, 2.5], [-1.6, 13.8, 1.8, 2.3]]
    .map(([x, y, z, r]) => colored(new THREE.IcosahedronGeometry(r, 0).scale(1, 0.8, 1).translate(x, y, z), 0xffffff));
  const limbs = [[1.2, 11.5, 0.4, -0.7], [-1, 12, -0.6, 0.8]]
    .map(([x, y, z, a]) => colored(new THREE.CylinderGeometry(0.07, 0.12, 3.4, 5).rotateZ(a).translate(x, y, z), 0x7a6b5b));
  return { trunk: merge([trunk, ...limbs]), crown: merge(blobs) };
}

function coniferParts() {
  const trunk = colored(new THREE.CylinderGeometry(0.16, 0.3, 19.5, 6, 1, true).translate(0, 9.75, 0), 0x6e6152);
  // Forest conifers shed their lower branches, so the foliage starts well overhead.
  // Open-ended cones: a cap would read as a flat black ceiling from underneath.
  const tiers = [[3.2, 5, 8.5], [2.7, 4.6, 11.5], [2.1, 4.2, 14.3], [1.4, 3.6, 16.8], [0.7, 2.8, 19]]
    .map(([r, h, y]) => colored(new THREE.ConeGeometry(r, h, 8, 1, true).translate(0, y, 0), 0xffffff));
  return { trunk, crown: merge(tiers) };
}

function saplingParts() {
  const trunk = colored(new THREE.CylinderGeometry(0.05, 0.08, 4.2, 5, 1, true).translate(0, 2.1, 0), 0x84745f);
  const crown = merge([
    colored(new THREE.IcosahedronGeometry(1.3, 0).scale(1, 0.85, 1).translate(0, 4.3, 0), 0xffffff),
    colored(new THREE.IcosahedronGeometry(0.9, 0).translate(0.7, 3.6, 0.3), 0xffffff),
  ]);
  return { trunk, crown };
}

// A hardwood in winter: the same trunk with its limbs and twigs bare.
function bareParts(height = 13, crownY = 15, spread = 1) {
  let seed = 7;
  const rnd = () => ((seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) / 4294967296);
  const parts = [];
  for (let i = 0; i < 7; i++) {
    const a = (i / 7) * Math.PI * 2 + rnd() * 0.5;
    const tilt = 0.5 + rnd() * 0.35;
    const len = (3.2 + rnd() * 1.6) * spread;
    const y0 = height * (0.72 + rnd() * 0.18);
    const limb = new THREE.CylinderGeometry(0.04, 0.12, len, 5).translate(0, len / 2, 0)
      .rotateZ(-tilt).rotateY(a).translate(0, y0, 0);
    parts.push(colored(limb, 0x6f6152));
    // Two twigs off the end of each limb.
    const ex = Math.sin(tilt) * len, ey = Math.cos(tilt) * len;
    for (let k = 0; k < 2; k++) {
      const tl = 1.6 * spread;
      const twig = new THREE.CylinderGeometry(0.015, 0.04, tl, 4).translate(0, tl / 2, 0)
        .rotateZ(-(tilt + (k ? 0.5 : -0.4))).rotateY(a + (k ? 0.5 : -0.5)).translate(Math.cos(a) * ex, y0 + ey, -Math.sin(a) * ex);
      parts.push(colored(twig, 0x6f6152));
    }
  }
  const leader = new THREE.CylinderGeometry(0.03, 0.12, crownY + 3 - height, 5).translate(0, height + (crownY + 3 - height) / 2, 0);
  parts.push(colored(leader, 0x6f6152));
  return merge(parts);
}

// Crossed-quad cut-out for distant trees, drawn onto a canvas.
function cutoutTexture(kind) {
  const c = document.createElement('canvas');
  c.width = 128; c.height = 256;
  const g = c.getContext('2d');
  g.clearRect(0, 0, 128, 256);
  g.fillStyle = '#5b5046';
  if (kind !== 'bare') g.fillRect(58, 120, 12, 136);
  g.fillStyle = '#ffffff';
  if (kind === 'bare') {
    // Bare branches: a trunk forking upward into twigs.
    g.strokeStyle = '#ffffff';
    g.lineCap = 'round';
    let seed = 3;
    const rnd = () => ((seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) / 4294967296);
    const branch = (x, y, a, len, w, depth) => {
      const x2 = x + Math.sin(a) * len, y2 = y - Math.cos(a) * len;
      g.lineWidth = w;
      g.beginPath(); g.moveTo(x, y); g.lineTo(x2, y2); g.stroke();
      if (depth === 0) return;
      for (const da of [-0.45 - rnd() * 0.3, 0.4 + rnd() * 0.3]) branch(x2, y2, a + da, len * (0.68 + rnd() * 0.12), w * 0.62, depth - 1);
    };
    branch(64, 256, 0, 95, 10, 6);
  } else if (kind === 'conifer') {
    g.beginPath(); g.moveTo(64, 6); g.lineTo(118, 200); g.lineTo(10, 200); g.closePath(); g.fill();
  } else {
    for (const [x, y, r] of [[64, 70, 52], [34, 104, 34], [94, 100, 36], [64, 128, 40], [48, 48, 30], [84, 46, 30]]) {
      g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.fill();
    }
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function cutoutGeometry(height) {
  const a = new THREE.PlaneGeometry(height * 0.55, height).translate(0, height / 2, 0);
  const b = a.clone().rotateY(Math.PI / 2);
  const out = new THREE.BufferGeometry();
  const merged = [a.toNonIndexed(), b.toNonIndexed()];
  const n = merged.reduce((s, g) => s + g.attributes.position.count, 0);
  const pos = new Float32Array(n * 3), uv = new Float32Array(n * 2), nor = new Float32Array(n * 3);
  let o = 0;
  for (const g of merged) {
    pos.set(g.attributes.position.array, o * 3);
    uv.set(g.attributes.uv.array, o * 2);
    nor.set(g.attributes.normal.array, o * 3);
    o += g.attributes.position.count;
  }
  out.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  out.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  out.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  return out;
}

// Leaf colours by season (weather-logic.js phenology): summer greens, the fresh
// yellow-green of spring, and autumn's yellows, oranges, reds and browns.
const SUMMER = [0x4b6a2b, 0x57742f, 0x3f5f27, 0x6a7a2e].map((h) => new THREE.Color(h));
const SPRING = [0x7d9a3a, 0x8aa446, 0x6c8f34].map((h) => new THREE.Color(h));
const AUTUMN = [0xc39a2c, 0xc77a22, 0xb4501f, 0x93361c, 0x8a6a2c, 0xa8902e].map((h) => new THREE.Color(h));
const NEEDLE = [0x2f4a2a, 0x355230, 0x2b4426].map((h) => new THREE.Color(h));
const SHRUB = [0x4d6a2c, 0x5a7333, 0x6c7a35].map((h) => new THREE.Color(h));
const SHRUB_DORMANT = [0x6a5b44, 0x75664a, 0x5f5340].map((h) => new THREE.Color(h));
const BARE_FAR = new THREE.Color(0x6a5f55);
const frac = (v) => v - Math.floor(v);
const pickFrom = (set, t) => set[Math.min(set.length - 1, Math.floor(t * set.length))];

// phen: { leaf, autumn, spring }. Each tree turns (and drops its leaves) at its own
// moment, decided by its tint, so the woods change gradually.
function leafColor(species, tint, out, phen) {
  if (species === 'conifer') return out.copy(pickFrom(NEEDLE, tint));
  if (phen.spring > 0 && frac(tint * 5.3) < phen.spring) return out.copy(pickFrom(SPRING, frac(tint * 11.1)));
  if (frac(tint * 2.9) < phen.autumn) return out.copy(pickFrom(AUTUMN, frac(tint * 7.7)));
  return out.copy(pickFrom(SUMMER, tint));
}

// Has this hardwood lost its leaves yet?
const isBare = (species, tint, phen) => species !== 'conifer' && frac(tint * 3.7) >= phen.leaf;

// Wind: every tree material bends its top with the same gusts (src/weather.js
// sets the strength). Higher up moves more; each tree has its own phase.
export const SWAY = { time: { value: 0 }, amp: { value: 0.15 } };
function swaying(material) {
  material.onBeforeCompile = (sh) => {
    sh.uniforms.swayTime = SWAY.time;
    sh.uniforms.swayAmp = SWAY.amp;
    sh.vertexShader = 'uniform float swayTime;\nuniform float swayAmp;\n' + sh.vertexShader.replace('#include <begin_vertex>', `#include <begin_vertex>
  {
  #ifdef USE_INSTANCING
    float ph = instanceMatrix[3].x * 0.37 + instanceMatrix[3].z * 0.29;
  #else
    float ph = 0.0;
  #endif
    float s = swayAmp * max(0.0, transformed.y - 4.0) * 0.022 * (sin(swayTime * 1.3 + ph) + 0.4 * sin(swayTime * 3.1 + ph * 1.7));
    transformed.x += s;
    transformed.z += s * 0.6;
  }`);
  };
  return material;
}

function instanced(geo, mat, capacity, withColor) {
  const m = new THREE.InstancedMesh(geo, mat, capacity);
  m.count = 0;
  m.frustumCulled = false; // instances surround the player; per-instance culling isn't worth it
  m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  if (withColor) {
    m.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 3), 3);
    m.instanceColor.setUsage(THREE.DynamicDrawUsage);
  }
  return m;
}

// Collision radii at scale 1, metres at ground level. Shrubs are walk-through.
const TRUNK_R = { oak: 0.3, conifer: 0.28, sapling: 0.08 };
const LOG_HALF = 2.5, LOG_R = 0.22, ROCK_R = 0.9;

export class Vegetation {
  // densityAt(x, z): optional 0..1 multiplier from site features (no trees on roads).
  // coverAt(x, z, slope), evergreenAt(x, z): optional real land cover (landcover.js).
  constructor(scene, terrain, site, settings, { densityAt, coverAt, evergreenAt } = {}) {
    this.terrain = terrain;
    this.densityAt = densityAt;
    this.coverFn = coverAt;
    this.evergreenAt = evergreenAt;
    this.site = site;
    this.settings = settings;
    this.seed = hashString(site.id);
    this.density = PRESET_DENSITY[settings.preset] ?? 1;
    this.exclude = [];
    this.treeCache = new Map();
    this.clutterCache = new Map();
    this.last = null;
    this.visibility = 0; // metres you can see in this weather (0: no limit)
    this.group = new THREE.Group();
    this.group.name = 'vegetation';
    scene.add(this.group);

    const bark = swaying(new THREE.MeshLambertMaterial({ vertexColors: true }));
    this.phen = { leaf: 1, autumn: 0, spring: 0 };
    // Two-sided: from under the canopy you see the inside of crowns and cones.
    // A touch of emissive stands in for light scattered through leaves, so shaded
    // undersides read as dark green, not black.
    const leaves = swaying(new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true, side: THREE.DoubleSide, emissive: 0x0e1609 }));
    this.leaves = leaves;
    const parts = { oak: oakParts(), conifer: coniferParts(), sapling: saplingParts() };
    const CAP = 2500;
    this.trees = {};
    for (const [k, p] of Object.entries(parts)) {
      this.trees[k] = { trunk: instanced(p.trunk, bark, CAP, false), crown: instanced(p.crown, leaves, CAP, true) };
      this.group.add(this.trees[k].trunk, this.trees[k].crown);
    }
    // Bare limbs for hardwoods out of leaf.
    this.trees.oak.bare = instanced(bareParts(), bark, CAP, false);
    this.trees.sapling.bare = instanced(bareParts(3.2, 4.2, 0.35), bark, CAP, false);
    this.group.add(this.trees.oak.bare, this.trees.sapling.bare);
    const cutMat = (kind) => swaying(new THREE.MeshBasicMaterial({ map: cutoutTexture(kind), alphaTest: 0.5, side: THREE.DoubleSide, color: 0xc8c8c8 }));
    this.cutouts = {
      broad: instanced(cutoutGeometry(18), cutMat('broad'), 9000, true),
      conifer: instanced(cutoutGeometry(18), cutMat('conifer'), 9000, true),
      bare: instanced(cutoutGeometry(18), cutMat('bare'), 9000, true),
    };
    this.group.add(this.cutouts.broad, this.cutouts.conifer, this.cutouts.bare);

    const flat = new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true });
    this.clutter = {
      shrub: instanced(colored(new THREE.IcosahedronGeometry(0.9, 1).scale(1.2, 0.65, 1).translate(0, 0.35, 0), 0xffffff), flat, 2500, true),
      log: instanced(colored(new THREE.CylinderGeometry(0.18, 0.24, 5, 6).rotateZ(Math.PI / 2).translate(0, 0.15, 0), 0x6b5d4f), flat, 600, true),
      rock: instanced(colored(new THREE.DodecahedronGeometry(0.8, 0).scale(1.3, 0.7, 1).translate(0, 0.1, 0), 0x8a857c), flat, 800, true),
    };
    this.group.add(this.clutter.shrub, this.clutter.log, this.clutter.rock);
    this._m = new THREE.Matrix4();
    this._q = new THREE.Quaternion();
    this._s = new THREE.Vector3();
    this._p = new THREE.Vector3();
    this._c = new THREE.Color();
    this._up = new THREE.Vector3(0, 1, 0);
  }

  // Tree cover at a point, for colouring the ground to match.
  coverAt(x, z) {
    const s = this.slope(x, z);
    const c = this.coverFn ? this.coverFn(x, z, s) : forestCover(this.seed, x, z, s);
    return this.densityAt ? c * this.densityAt(x, z) : c;
  }

  slope(x, z) {
    const t = this.terrain;
    const gx = t.slopeAt(x, z, 1, 0), gz = t.slopeAt(x, z, 0, 1);
    return Math.hypot(gx, gz);
  }

  setPreset(preset) {
    this.density = PRESET_DENSITY[preset] ?? 1;
    this.treeCache.clear();
    this.last = null;
  }

  // Keep trees off stakes and the start flag.
  setExclusions(points) {
    this.exclude = points;
    this.treeCache.clear();
    this.clutterCache.clear();
    this.last = null;
  }

  tile(cache, tx, tz, fn) {
    const key = tx * 100003 + tz;
    let v = cache.get(key);
    if (!v) {
      v = fn(tx, tz, {
        seed: this.seed, density: this.density, size: this.terrain.size,
        slopeAt: (x, z) => this.slope(x, z), exclude: this.exclude, densityAt: this.densityAt,
        coverAt: this.coverFn, evergreenAt: this.evergreenAt,
      });
      for (const t of v) t.y = this.terrain.heightAt(t.x, t.z);
      cache.set(key, v);
    }
    return v;
  }

  update(x, z) {
    if (this.last && (this.last.x - x) ** 2 + (this.last.z - z) ** 2 < REFRESH_M ** 2 && this.last.q === this.settings.vegetation) return;
    this.last = { x, z, q: this.settings.vegetation };
    const q = VEGETATION_QUALITY[this.settings.vegetation] ?? VEGETATION_QUALITY.medium;
    // In the woods or at night, nothing past the fog can be seen anyway.
    let far = this.settings.preset === 'woods' ? Math.min(q.far, this.settings.woodsVisibility + 10) : q.far;
    if (this.settings.night) far = Math.min(far, this.settings.nightVisibility + 10);
    // Fog, rain or snow: nothing past what you can see.
    if (this.visibility) far = Math.min(far, this.visibility + 10);
    const counts = new Map();
    const put = (mesh, t, scale, yaw, color) => {
      const i = counts.get(mesh) ?? 0;
      if (i >= mesh.instanceMatrix.count) return;
      this._p.set(t.x, t.y - 0.15, t.z);
      this._q.setFromAxisAngle(this._up, yaw);
      this._s.setScalar(scale);
      mesh.setMatrixAt(i, this._m.compose(this._p, this._q, this._s));
      if (color && mesh.instanceColor) mesh.setColorAt(i, color);
      counts.set(mesh, i + 1);
    };

    const all = [...Object.values(this.trees).flatMap((t) => [t.trunk, t.crown, t.bare].filter(Boolean)), ...Object.values(this.cutouts), ...Object.values(this.clutter)];
    const phen = this.phen;
    if (far > 0) {
      const t0x = Math.floor((x - far) / TILE_M), t1x = Math.floor((x + far) / TILE_M);
      const t0z = Math.floor((z - far) / TILE_M), t1z = Math.floor((z + far) / TILE_M);
      const near2 = q.near ** 2, far2 = far ** 2;
      for (let tx = t0x; tx <= t1x; tx++) {
        for (let tz = t0z; tz <= t1z; tz++) {
          for (const t of this.tile(this.treeCache, tx, tz, tileTrees)) {
            const d2 = (t.x - x) ** 2 + (t.z - z) ** 2;
            if (d2 > far2) continue;
            const bare = isBare(t.species, t.tint, phen);
            if (bare) this._c.copy(BARE_FAR);
            else leafColor(t.species, t.tint, this._c, phen);
            if (d2 <= near2) {
              put(this.trees[t.species].trunk, t, t.scale, t.rot);
              if (bare) put(this.trees[t.species].bare, t, t.scale, t.rot);
              else put(this.trees[t.species].crown, t, t.scale, t.rot, this._c);
            } else if (t.species !== 'sapling') {
              put(t.species === 'conifer' ? this.cutouts.conifer : bare ? this.cutouts.bare : this.cutouts.broad, t, t.scale, t.rot, this._c);
            }
          }
        }
      }
      const cr = q.clutter, cr2 = cr * cr;
      const c0x = Math.floor((x - cr) / TILE_M), c1x = Math.floor((x + cr) / TILE_M);
      const c0z = Math.floor((z - cr) / TILE_M), c1z = Math.floor((z + cr) / TILE_M);
      for (let tx = c0x; tx <= c1x; tx++) {
        for (let tz = c0z; tz <= c1z; tz++) {
          for (const c of this.tile(this.clutterCache, tx, tz, tileClutter)) {
            if ((c.x - x) ** 2 + (c.z - z) ** 2 > cr2) continue;
            const shrubs = phen.leaf < 0.5 ? SHRUB_DORMANT : SHRUB;
            const col = c.kind === 'shrub' ? this._c.copy(pickFrom(shrubs, c.tint)) : this._c.setScalar(0.85 + 0.3 * c.tint);
            put(this.clutter[c.kind], c, c.scale, c.rot, col);
          }
        }
      }
    }
    for (const mesh of all) {
      mesh.count = counts.get(mesh) ?? 0;
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    }
  }

  // Trunks, logs and rocks within r of (x, z), as collision obstacles (src/collision.js).
  // Empty when trees are switched off: you can't bump into what isn't drawn.
  obstaclesNear(x, z, r) {
    const out = [];
    if ((VEGETATION_QUALITY[this.settings.vegetation] ?? VEGETATION_QUALITY.medium).near === 0) return out;
    const t0x = Math.floor((x - r) / TILE_M), t1x = Math.floor((x + r) / TILE_M);
    const t0z = Math.floor((z - r) / TILE_M), t1z = Math.floor((z + r) / TILE_M);
    for (let tx = t0x; tx <= t1x; tx++) {
      for (let tz = t0z; tz <= t1z; tz++) {
        for (const t of this.tile(this.treeCache, tx, tz, tileTrees)) {
          const tr = TRUNK_R[t.species] * t.scale;
          if (Math.abs(t.x - x) < r + tr && Math.abs(t.z - z) < r + tr) out.push({ type: 'circle', x: t.x, z: t.z, r: tr });
        }
        for (const c of this.tile(this.clutterCache, tx, tz, tileClutter)) {
          if (c.kind === 'rock') {
            out.push({ type: 'circle', x: c.x, z: c.z, r: ROCK_R * c.scale });
          } else if (c.kind === 'log') {
            // The log lies along its local x axis, turned by rot about y.
            const hx = Math.cos(c.rot) * LOG_HALF * c.scale, hz = -Math.sin(c.rot) * LOG_HALF * c.scale;
            out.push({ type: 'capsule', ax: c.x - hx, az: c.z - hz, bx: c.x + hx, bz: c.z + hz, r: LOG_R * c.scale });
          }
        }
      }
    }
    return out;
  }

  // At night the leaves lose their scattered-light glow, and the flat far-tree
  // cut-outs (unlit) go to silhouettes.
  setNight(on) {
    this.nightOn = on;
    this.leaves.emissive.setHex(on ? 0x000000 : 0x0e1609);
    for (const m of Object.values(this.cutouts)) m.material.color.setHex(on ? 0x0a0c10 : 0xc8c8c8);
    this.last = null;
  }

  // Near trees, logs and rocks cast shadows; far cut-outs and shrubs don't (too
  // many, too far, too small to matter).
  castShadows() {
    for (const t of Object.values(this.trees)) {
      t.trunk.castShadow = t.crown.castShadow = true;
      if (t.bare) t.bare.castShadow = true;
    }
    this.clutter.log.castShadow = this.clutter.rock.castShadow = true;
  }

  // How far the weather lets you see (metres, 0 for no limit).
  setVisibility(m) {
    const v = m > 0 && m < 2000 ? Math.round(m / 10) * 10 : 0;
    if (v === this.visibility) return;
    this.visibility = v;
    this.last = null;
  }

  // The season's leaves: phen from weather-logic.js phenology(). Redraws the trees.
  setSeason(phen) {
    const p = this.phen;
    if (Math.abs(p.leaf - phen.leaf) < 0.01 && Math.abs(p.autumn - phen.autumn) < 0.01 && Math.abs(p.spring - phen.spring) < 0.01) return;
    this.phen = { ...phen };
    this.last = null;
  }

  // Daylight 0..1 (dusk, overcast): the unlit far cut-outs and the leaves' glow
  // follow it, so far trees don't stay noon-bright at sunset.
  setLight(k) {
    if (this.nightOn) return;
    const v = Math.round(0x0a + (0xc8 - 0x0a) * Math.max(0, Math.min(1, k)));
    for (const m of Object.values(this.cutouts)) m.material.color.setRGB(v / 255, v / 255, v / 255, THREE.SRGBColorSpace);
    this.leaves.emissive.setHex(0x0e1609).multiplyScalar(Math.max(0, Math.min(1, k)));
  }

  // Instances drawn, for the HUD and tests.
  get stats() {
    const near = Object.values(this.trees).reduce((s, t) => s + t.trunk.count, 0);
    const bare = this.trees.oak.bare.count + this.trees.sapling.bare.count;
    const cut = this.cutouts.broad.count + this.cutouts.conifer.count + this.cutouts.bare.count;
    const clutter = Object.values(this.clutter).reduce((s, m) => s + m.count, 0);
    return { near, cut, clutter, bare };
  }
}
