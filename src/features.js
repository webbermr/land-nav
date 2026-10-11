// Site features in the world: roads, tracks, trails and streams laid on the ground,
// parking lots, and simple buildings. Data from sites/<id>/features.json
// (OpenStreetMap, via tools/make_features.py). Sites without it get nothing.
import * as THREE from 'three';

// Only sites whose site.json says "features": true have the file, so others don't
// make a request that 404s.
export async function loadFeatures(baseUrl, site) {
  if (!site?.features) return null;
  try {
    const res = await fetch(`${baseUrl}/features.json`);
    return res.ok ? await res.json() : null;
  } catch {
    return null;
  }
}

// Colour and height above the ground (metres) for each kind of strip.
const STRIP = {
  road: { color: 0x47484a, lift: 0.07 },
  track: { color: 0x8a7b60, lift: 0.06 },
  trail: { color: 0x76634a, lift: 0.05 },
  stream: { color: 0x35505c, lift: 0.04 },
};
const PARKING = { color: 0x4f5052, lift: 0.06 };
const SAMPLE_M = 1.5;      // along-strip vertex spacing; the terrain grid is coarser
const MAX_TRI_EDGE_M = 3;  // parking triangles are split until they hug the ground

// Resample a polyline to points at most `step` apart, keeping the originals.
function resample(pts, step) {
  const out = [pts[0]];
  for (let i = 1; i < pts.length; i++) {
    const [ax, az] = pts[i - 1], [bx, bz] = pts[i];
    const n = Math.max(1, Math.ceil(Math.hypot(bx - ax, bz - az) / step));
    for (let k = 1; k <= n; k++) out.push([ax + ((bx - ax) * k) / n, az + ((bz - az) * k) / n]);
  }
  return out;
}

// A little brightness variation by position, so shared vertices agree and the
// surface reads as worn patches rather than a checkerboard.
function jitterColor(hex, x, z, out) {
  const n = Math.sin(x * 0.21 + Math.sin(z * 0.17) * 2) * Math.sin(z * 0.23 + Math.sin(x * 0.13) * 2);
  return out.set(hex).multiplyScalar(0.95 + 0.07 * n);
}

// One strip: three vertices across (edge, centre, edge) so it follows a crowned or
// side-sloping surface, at each resampled point. Points off the terrain are dropped.
function addStrip(line, field, pos, col, nor, idx) {
  const style = STRIP[line.kind];
  const pts = resample(line.pts, SAMPLE_M);
  const half = line.width / 2;
  const size = field.size;
  const c = new THREE.Color();
  let prevBase = -1;
  for (let i = 0; i < pts.length; i++) {
    const [x, z] = pts[i];
    if (x < 0 || z < 0 || x > size || z > size) { prevBase = -1; continue; }
    const [px, pz] = pts[Math.max(0, i - 1)], [nx, nz] = pts[Math.min(pts.length - 1, i + 1)];
    let tx = nx - px, tz = nz - pz;
    const tl = Math.hypot(tx, tz) || 1;
    tx /= tl; tz /= tl;
    const ox = -tz * half, oz = tx * half; // perpendicular, to the left of travel
    const base = pos.length / 3;
    for (const [vx, vz] of [[x + ox, z + oz], [x, z], [x - ox, z - oz]]) {
      const cx = Math.min(size, Math.max(0, vx)), cz = Math.min(size, Math.max(0, vz));
      pos.push(vx, field.meshHeightAt(cx, cz) + style.lift, vz);
      pushNormal(field, cx, cz, nor);
      jitterColor(style.color, vx, vz, c);
      col.push(c.r, c.g, c.b);
    }
    if (prevBase >= 0) {
      for (let k = 0; k < 2; k++) {
        const a = prevBase + k, b = prevBase + k + 1, d = base + k, e = base + k + 1;
        idx.push(a, d, b, b, d, e);
      }
    }
    prevBase = base;
  }
}

// The terrain's own smooth normal, so strips are lit like the ground under them.
function pushNormal(field, x, z, nor) {
  const n = field.normalAt(x, z);
  nor.push(n.x, n.y, n.z);
}

// Split a triangle until no edge is longer than `max`, so it can follow the ground.
function subdivide(a, b, c, max, out) {
  const l = (p, q) => Math.hypot(p[0] - q[0], p[1] - q[1]);
  const ab = l(a, b), bc = l(b, c), ca = l(c, a);
  const m = Math.max(ab, bc, ca);
  if (m <= max) { out.push(a, b, c); return; }
  const mid = (p, q) => [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2];
  if (m === ab) { const p = mid(a, b); subdivide(a, p, c, max, out); subdivide(p, b, c, max, out); }
  else if (m === bc) { const p = mid(b, c); subdivide(a, b, p, max, out); subdivide(a, p, c, max, out); }
  else { const p = mid(c, a); subdivide(a, b, p, max, out); subdivide(p, b, c, max, out); }
}

function addPatch(area, field, style, pos, col, nor) {
  const contour = area.pts.map(([x, z]) => new THREE.Vector2(x, z));
  const tris = THREE.ShapeUtils.triangulateShape(contour, []);
  const flat = [];
  for (const [i, j, k] of tris) subdivide(area.pts[i], area.pts[j], area.pts[k], MAX_TRI_EDGE_M, flat);
  const c = new THREE.Color();
  const size = field.size;
  // Wind every triangle to face up.
  for (let t = 0; t < flat.length; t += 3) {
    let [a, b, d] = [flat[t], flat[t + 1], flat[t + 2]];
    const cross = (b[0] - a[0]) * (d[1] - a[1]) - (b[1] - a[1]) * (d[0] - a[0]);
    if (cross > 0) [b, d] = [d, b];
    for (const [x, z] of [a, b, d]) {
      const cx = Math.min(size, Math.max(0, x)), cz = Math.min(size, Math.max(0, z));
      pos.push(x, field.meshHeightAt(cx, cz) + style.lift, z);
      pushNormal(field, cx, cz, nor);
      jitterColor(style.color, x, z, c);
      col.push(c.r, c.g, c.b);
    }
  }
}

// A plain one-storey building: walls and a flat roof, sunk to the lowest corner so
// it never floats on a slope.
function buildingMesh(area, field, wallMat, roofMat) {
  const size = field.size;
  const ys = area.pts.map(([x, z]) => field.heightAt(Math.min(size, Math.max(0, x)), Math.min(size, Math.max(0, z))));
  const base = Math.min(...ys) - 0.3;
  const top = Math.max(...ys) + 3;
  // Shape in (x, -z): ExtrudeGeometry extrudes along +z, then we stand it up.
  const shape = new THREE.Shape(area.pts.map(([x, z]) => new THREE.Vector2(x, -z)));
  const geo = new THREE.ExtrudeGeometry(shape, { depth: top - base, bevelEnabled: false });
  geo.rotateX(-Math.PI / 2);
  geo.translate(0, base, 0);
  const mesh = new THREE.Mesh(geo, [roofMat, wallMat]);
  mesh.name = area.name || 'building';
  return mesh;
}

export function buildFeatures(features, field) {
  const group = new THREE.Group();
  group.name = 'features';
  if (!features) return group;

  // Laid on the ground, so pull them toward the camera in depth to stop flicker.
  const groundMat = new THREE.MeshLambertMaterial({
    vertexColors: true, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -4,
  });
  // Draw order: streams, trails, tracks, then roads on top where they cross.
  for (const kind of ['stream', 'trail', 'track', 'road']) {
    const pos = [], col = [], nor = [], idx = [];
    for (const line of features.lines) if (line.kind === kind) addStrip(line, field, pos, col, nor, idx);
    if (!idx.length) continue;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    geo.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
    geo.setIndex(idx);
    const mesh = new THREE.Mesh(geo, groundMat);
    mesh.name = `${kind}s`;
    mesh.renderOrder = 1;
    group.add(mesh);
  }

  const pos = [], col = [], nor = [];
  for (const a of features.areas) if (a.kind === 'parking') addPatch(a, field, PARKING, pos, col, nor);
  if (pos.length) {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    geo.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
    const mesh = new THREE.Mesh(geo, groundMat);
    mesh.name = 'parking';
    mesh.renderOrder = 1;
    group.add(mesh);
  }

  const wallMat = new THREE.MeshLambertMaterial({ color: 0x8c7b63 });
  const roofMat = new THREE.MeshLambertMaterial({ color: 0x4a4740 });
  for (const a of features.areas) if (a.kind === 'building') group.add(buildingMesh(a, field, wallMat, roofMat));
  return group;
}
