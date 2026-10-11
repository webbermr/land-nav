// The far view: aerial photographs on distant ground, and terrain out to 20 km.
//
// Up close the ground is drawn (grass, litter, trees). Past a couple of hundred
// metres it fades into the USDA's NAIP aerial photographs (about 1 m resolution,
// summer), so you see the real fields, forest edges, roads and towns from a
// ridge. Beyond the 6 km skirt a coarse ring of 3DEP elevation carries the real
// mountains to the horizon, draped with NAIP too. Both come from public USGS
// services that allow browser requests; the browser keeps copies (Cache API).
import * as THREE from 'three';
import { GROUND_FX, patchGround } from './ground-fx.js';
import { fetchElevation, fillHoles } from './instant-site.js';
import { Heightfield } from './heightfield.js';

const NAIP = 'https://imagery.nationalmap.gov/arcgis/rest/services/USGSNAIPImagery/ImageServer/exportImage';
const CACHE = 'land-nav-far-v1';

async function cachedFetch(url) {
  let cache = null;
  try { cache = await caches.open(CACHE); } catch { /* no Cache API (not https): fetch every time */ }
  const hit = await cache?.match(url);
  if (hit) return hit;
  // The image service is sometimes slow to wake: one more try after a pause.
  let res;
  for (let attempt = 0; ; attempt++) {
    try {
      res = await fetch(url);
      if (res.ok) break;
      throw new Error(`${res.status} from ${new URL(url).host}`);
    } catch (err) {
      if (attempt >= 1) throw err;
      await new Promise((r) => setTimeout(r, 3000));
    }
  }
  if (cache) await cache.put(url, res.clone()).catch(() => {});
  return res;
}

// NAIP for a UTM square (top-left eWest, nNorth; side sizeM), as a texture.
export async function fetchAerial(epsg, eWest, nNorth, sizeM, px = 2048) {
  const q = new URLSearchParams({
    bbox: `${eWest},${nNorth - sizeM},${eWest + sizeM},${nNorth}`, bboxSR: epsg, imageSR: epsg,
    size: `${px},${px}`, format: 'jpg', f: 'image',
  });
  const res = await cachedFetch(`${NAIP}?${q}`);
  if (!/image/.test(res.headers.get('content-type') || 'image')) throw new Error('NAIP sent no image');
  const bmp = await createImageBitmap(await res.blob(), { imageOrientation: 'flipY' });
  const tex = new THREE.Texture(bmp);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.flipY = false; // flipped when decoded (WebGL can't flip an ImageBitmap)
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.anisotropy = 4;
  tex.needsUpdate = true;
  return tex;
}

// Put NAIP on the site's ground beyond `near` metres, over the skirt's 6 km.
export async function loadSkirtAerial(site) {
  const sk = site.skirt;
  const tex = await fetchAerial(site.epsg, sk.e_west, sk.n_north, sk.size_m);
  GROUND_FX.aerial.value = tex;
  // Scene x, z of the image's north-west corner, and its size.
  GROUND_FX.aerialBox.value.set(sk.e_west - site.e_west, site.n_north - sk.n_north, sk.size_m, 1);
  return tex;
}

// The far ring's elevation, for a site that doesn't carry it (built by the Python tools).
export async function loadFarField(site) {
  const far = { size_m: 40000, spacing_m: 200 };
  far.grid = Math.round(far.size_m / far.spacing_m) + 1;
  far.e_west = Math.floor((site.e_west + site.size_m / 2 - far.size_m / 2) / far.spacing_m) * far.spacing_m;
  far.n_north = Math.floor((site.n_north - site.size_m / 2 + far.size_m / 2) / far.spacing_m) * far.spacing_m;
  const { heights } = await fetchElevation(site.epsg, far.e_west, far.n_north, far.spacing_m, far.grid);
  fillHoles(heights, far.grid);
  for (let i = 0; i < heights.length; i++) heights[i] -= site.elev_ref;
  return { far, field: new Heightfield(heights, far.grid, far.spacing_m) };
}

// The ring: far terrain with a hole where the skirt is, NAIP on top.
export function buildFarRing(site, far, field, texture) {
  const g = far.grid, sp = far.spacing_m;
  const ox = far.e_west - site.e_west, oz = site.n_north - far.n_north;
  const sk = site.skirt;
  const sx0 = sk.e_west - site.e_west, sz0 = site.n_north - sk.n_north, sx1 = sx0 + sk.size_m, sz1 = sz0 + sk.size_m;
  const pos = new Float32Array(g * g * 3), uv = new Float32Array(g * g * 2);
  for (let r = 0; r < g; r++) {
    for (let c = 0; c < g; c++) {
      const i = r * g + c;
      const x = ox + c * sp, z = oz + r * sp;
      // Sink the ring a little under the skirt where they meet, so no crack shows.
      const inSkirt = x >= sx0 && x <= sx1 && z >= sz0 && z <= sz1;
      pos.set([x, field.heights[i] - (inSkirt ? 8 : 0), z], i * 3);
      uv.set([c / (g - 1), 1 - r / (g - 1)], i * 2);
    }
  }
  const idx = [];
  for (let r = 0; r < g - 1; r++) {
    for (let c = 0; c < g - 1; c++) {
      const x0 = ox + c * sp, z0 = oz + r * sp;
      if (x0 >= sx0 && x0 + sp <= sx1 && z0 >= sz0 && z0 + sp <= sz1) continue; // the skirt covers it
      const a = r * g + c, b = a + 1, d = a + g, e = d + 1;
      idx.push(a, d, b, b, d, e);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  geo.computeBoundingSphere();
  const mat = new THREE.MeshLambertMaterial({ color: texture ? 0xffffff : 0x55663f, map: texture || null });
  // The photographs are summer; the season and snow change them like the near ground.
  mat.onBeforeCompile = (sh) => patchGround(sh, { seasonTint: true, snowShare: 0.8 });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.name = 'far-ring';
  mesh.matrixAutoUpdate = false;
  return mesh;
}

// The far ring's own photograph: NAIP over the whole 40 km, coarser.
export function fetchFarAerial(site, far) {
  return fetchAerial(site.epsg, far.e_west, far.n_north, far.size_m, 2048);
}
