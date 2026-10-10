import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decodeHeights, Heightfield } from '../src/heightfield.js';

const close = (a, b, eps = 1e-5) =>
  assert.ok(Math.abs(a - b) <= eps, `expected ${a} to be within ${eps} of ${b}`);

test('decodeHeights maps 0 and 65535 to elev_min and elev_max', () => {
  const buf = new ArrayBuffer(6);
  const dv = new DataView(buf);
  dv.setUint16(0, 0, true);
  dv.setUint16(2, 65535, true);
  dv.setUint16(4, 32768, true);
  const h = decodeHeights(buf, 61.2, 148.9, 61.2);
  close(h[0], 0);
  close(h[1], 148.9 - 61.2, 1e-4);
  close(h[2], (32768 * (148.9 - 61.2)) / 65535, 1e-4);
});

// A 3x3 tilted plane: h = 2*col + 10*row (spacing 4 m), i.e. rises east and south.
function plane() {
  const g = 3, s = 4;
  const h = new Float32Array(g * g);
  for (let r = 0; r < g; r++) for (let c = 0; c < g; c++) h[r * g + c] = 2 * c + 10 * r;
  return new Heightfield(h, g, s);
}

test('heightAt hits grid samples exactly (row 0 north, col 0 west)', () => {
  const hf = plane();
  close(hf.heightAt(0, 0), 0);
  close(hf.heightAt(8, 0), 4);   // NE corner
  close(hf.heightAt(0, 8), 20);  // SW corner
  close(hf.heightAt(8, 8), 24);
});

test('heightAt interpolates bilinearly and clamps outside', () => {
  const hf = plane();
  close(hf.heightAt(2, 2), 0.5 * 2 + 0.5 * 10);
  close(hf.heightAt(6, 5), 1.5 * 2 + 1.25 * 10);
  close(hf.heightAt(-50, -50), 0);
  close(hf.heightAt(500, 500), 24);
});

test('slopeAt is signed grade in the direction of travel', () => {
  const hf = plane();
  // dh/dx = 2 per 4 m = 0.5; dh/dz = 10 per 4 m = 2.5
  close(hf.slopeAt(4, 4, 1, 0), 0.5);    // walking east: uphill
  close(hf.slopeAt(4, 4, -1, 0), -0.5);  // walking west: downhill
  close(hf.slopeAt(4, 4, 0, 1), 2.5);    // walking south
  close(hf.slopeAt(4, 4, 0, -3), -2.5);  // walking north, direction need not be unit
  close(hf.slopeAt(4, 4, 0, 0), 0);
});

test('normalAt points up on flat ground and tilts away from the rise', () => {
  const flat = new Heightfield(new Float32Array(9).fill(7), 3, 4);
  const n = flat.normalAt(4, 4);
  close(n.x, 0); close(n.y, 1); close(n.z, 0);
  const t = plane().normalAt(4, 4);
  assert.ok(t.x < 0 && t.z < 0 && t.y > 0);
});

test('size and contains', () => {
  const hf = plane();
  assert.equal(hf.size, 8);
  assert.ok(hf.contains(0, 8));
  assert.ok(!hf.contains(8.1, 4));
  assert.ok(!hf.contains(1, 4, 2));
});
