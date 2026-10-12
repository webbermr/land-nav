// A small GeoTIFF reader: enough for the rasters the USGS and MRLC services send
// (one band, strips or tiles, uncompressed or Deflate, 8/16/32-bit integers or
// 32-bit floats) and the georeferencing that says where the pixels are.
// https://www.adobe.io/open/standards/TIFF.html, http://docs.opengeospatial.org/is/19-008r4/19-008r4.html

const TYPE_SIZE = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 6: 1, 7: 1, 8: 2, 9: 4, 10: 8, 11: 4, 12: 8, 16: 8 };

function readValue(dv, off, type, le) {
  switch (type) {
    case 1: case 2: case 7: return dv.getUint8(off);
    case 6: return dv.getInt8(off);
    case 3: return dv.getUint16(off, le);
    case 8: return dv.getInt16(off, le);
    case 4: return dv.getUint32(off, le);
    case 9: return dv.getInt32(off, le);
    case 5: return dv.getUint32(off, le) / dv.getUint32(off + 4, le);
    case 10: return dv.getInt32(off, le) / dv.getInt32(off + 4, le);
    case 11: return dv.getFloat32(off, le);
    case 12: return dv.getFloat64(off, le);
    case 16: return Number(dv.getBigUint64(off, le));
    default: throw new Error(`TIFF field type ${type} not supported`);
  }
}

// Tags of the first image, as numbers, arrays or strings.
function readTags(buf) {
  const dv = new DataView(buf);
  const le = dv.getUint16(0) === 0x4949;
  if (!le && dv.getUint16(0) !== 0x4d4d) throw new Error('Not a TIFF file');
  const magic = dv.getUint16(2, le);
  const big = magic === 43;
  if (magic !== 42 && !big) throw new Error('Not a TIFF file');
  const ifd = big ? Number(dv.getBigUint64(8, le)) : dv.getUint32(4, le);
  const count = big ? Number(dv.getBigUint64(ifd, le)) : dv.getUint16(ifd, le);
  const entrySize = big ? 20 : 12;
  const tags = {};
  for (let i = 0; i < count; i++) {
    const e = ifd + (big ? 8 : 2) + i * entrySize;
    const tag = dv.getUint16(e, le), type = dv.getUint16(e + 2, le);
    const n = big ? Number(dv.getBigUint64(e + 4, le)) : dv.getUint32(e + 4, le);
    const size = (TYPE_SIZE[type] || 1) * n;
    const inline = big ? 8 : 4;
    const at = size <= inline ? e + (big ? 12 : 8) : (big ? Number(dv.getBigUint64(e + 12, le)) : dv.getUint32(e + 8, le));
    if (type === 2) {
      tags[tag] = new TextDecoder().decode(new Uint8Array(buf, at, Math.max(0, n - 1)));
    } else if (TYPE_SIZE[type]) {
      const vals = [];
      for (let k = 0; k < n; k++) vals.push(readValue(dv, at + k * TYPE_SIZE[type], type, le));
      tags[tag] = n === 1 ? vals[0] : vals;
    }
  }
  return { tags, le };
}

async function inflate(bytes) {
  const ds = new DecompressionStream('deflate');
  const out = new Response(new Blob([bytes]).stream().pipeThrough(ds));
  return new Uint8Array(await out.arrayBuffer());
}

// Decode a GeoTIFF. Returns { width, height, data, nodata, toPixel(x, y), toWorld(col, row) }
// where data is a typed array, row-major from the top, and toPixel/toWorld map
// between pixel coordinates (centres at col + 0.5) and the raster's own CRS.
export async function readGeoTiff(buffer) {
  const { tags, le } = readTags(buffer);
  const width = tags[256], height = tags[257];
  const bits = [].concat(tags[258] ?? 8)[0];
  const compression = tags[259] ?? 1;
  const spp = tags[277] ?? 1;
  const format = [].concat(tags[339] ?? 1)[0]; // 1 uint, 2 int, 3 float
  const predictor = tags[317] ?? 1;
  if (compression !== 1 && compression !== 8 && compression !== 32946) throw new Error(`TIFF compression ${compression} not supported`);
  if (predictor !== 1) throw new Error('TIFF predictor not supported');
  if (tags[284] === 2 && spp > 1) throw new Error('Planar TIFFs not supported');
  const bps = bits / 8;
  const Arr = format === 3 ? (bits === 64 ? Float64Array : Float32Array)
    : format === 2 ? (bits === 8 ? Int8Array : bits === 16 ? Int16Array : Int32Array)
      : (bits === 8 ? Uint8Array : bits === 16 ? Uint16Array : Uint32Array);
  const data = new Arr(width * height);
  const tiled = tags[322] !== undefined;
  const bw = tiled ? tags[322] : width;
  const bh = tiled ? tags[323] : (tags[278] ?? height);
  const offsets = [].concat(tiled ? tags[324] : tags[273]);
  const counts = [].concat(tiled ? tags[325] : tags[279]);
  const across = Math.ceil(width / bw);
  const view = (bytes) => new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const get = format === 3 ? (bits === 64 ? 'getFloat64' : 'getFloat32')
    : `get${format === 2 ? 'Int' : 'Uint'}${bits}`;
  for (let b = 0; b < offsets.length; b++) {
    let bytes = new Uint8Array(buffer, offsets[b], counts[b]);
    if (compression !== 1) bytes = await inflate(bytes);
    const dv = view(bytes);
    const bx = tiled ? (b % across) * bw : 0;
    const by = tiled ? Math.floor(b / across) * bh : b * bh;
    for (let r = 0; r < bh; r++) {
      const y = by + r;
      if (y >= height) break;
      for (let c = 0; c < bw; c++) {
        const x = bx + c;
        if (x >= width) continue;
        const at = ((r * bw + c) * spp) * bps;
        if (at + bps > bytes.byteLength) continue;
        data[y * width + x] = bits === 8 ? dv[get](at) : dv[get](at, le);
      }
    }
  }
  // Georeferencing: a tie point and pixel scale, or a full transformation matrix.
  let a = 1, b2 = 0, c0 = 0, d = 0, e = -1, f0 = 0;
  if (tags[34264]) {
    const m = tags[34264];
    [a, b2, c0, d, e, f0] = [m[0], m[1], m[3], m[4], m[5], m[7]];
  } else if (tags[33922] && tags[33550]) {
    const t = tags[33922], s = tags[33550];
    a = s[0]; e = -s[1]; b2 = d = 0;
    c0 = t[3] - t[0] * s[0];
    f0 = t[4] + t[1] * s[1];
  }
  // GeoKey 1025: 1 = pixel is area (corner), 2 = pixel is point (centre).
  const keys = [].concat(tags[34735] ?? []);
  let pointRaster = false;
  for (let k = 4; k + 3 < keys.length; k += 4) if (keys[k] === 1025) pointRaster = keys[k + 3] === 2;
  const shift = pointRaster ? 0.5 : 0;
  const nodataTag = tags[42113];
  const nodata = nodataTag !== undefined && nodataTag !== '' ? Number(nodataTag) : null;
  const det = a * e - b2 * d;
  return {
    width, height, data, nodata,
    // Raster CRS -> fractional pixel (col, row), pixel centres at .5.
    toPixel(x, y) {
      const dx = x - c0, dy = y - f0;
      return { col: (e * dx - b2 * dy) / det + shift, row: (-d * dx + a * dy) / det + shift };
    },
    toWorld(col, row) {
      const cc = col - shift, rr = row - shift;
      return { x: c0 + a * cc + b2 * rr, y: f0 + d * cc + e * rr };
    },
  };
}

// Sample at a raster-CRS point: 'nearest' or 'bilinear' (skipping no-data).
export function sampleRaster(r, x, y, mode = 'bilinear') {
  const { col, row } = r.toPixel(x, y);
  const fc = col - 0.5, fr = row - 0.5;
  if (mode === 'nearest') {
    const c = Math.round(fc), rr = Math.round(fr);
    if (c < 0 || rr < 0 || c >= r.width || rr >= r.height) return NaN;
    const v = r.data[rr * r.width + c];
    return v === r.nodata ? NaN : v;
  }
  const c0 = Math.max(0, Math.min(r.width - 2, Math.floor(fc))), r0 = Math.max(0, Math.min(r.height - 2, Math.floor(fr)));
  if (fc < -0.5 || fr < -0.5 || fc > r.width - 0.5 || fr > r.height - 0.5) return NaN;
  const tc = Math.min(1, Math.max(0, fc - c0)), tr = Math.min(1, Math.max(0, fr - r0));
  let sum = 0, wsum = 0;
  for (const [dc, dr, w] of [[0, 0, (1 - tc) * (1 - tr)], [1, 0, tc * (1 - tr)], [0, 1, (1 - tc) * tr], [1, 1, tc * tr]]) {
    const v = r.data[(r0 + dr) * r.width + c0 + dc];
    if (w === 0 || v === r.nodata || !Number.isFinite(v) || v < -1e4) continue;
    sum += v * w; wsum += w;
  }
  return wsum > 0 ? sum / wsum : NaN;
}

// Write a one-band float32 or uint8 GeoTIFF (uncompressed, one strip), for tests
// and fakes. origin: [x of the left edge, y of the top edge], pixel: size.
export function writeGeoTiff(width, height, data, { origin = [0, 0], pixel = 1, float = true, nodata = null } = {}) {
  const bps = float ? 4 : 1;
  const entries = [];
  const extra = [];
  let extraLen = 0;
  const addExtra = (bytes) => { const at = extraLen; extra.push(bytes); extraLen += bytes.length; return at; };
  const dbl = (vals) => { const b = new Uint8Array(vals.length * 8); const dv = new DataView(b.buffer); vals.forEach((v, i) => dv.setFloat64(i * 8, v, true)); return b; };
  const tagsList = [
    [256, 3, 1, width], [257, 3, 1, height], [258, 3, 1, bps * 8], [259, 3, 1, 1], [262, 3, 1, 1], [277, 3, 1, 1],
    [278, 3, 1, height], [339, 3, 1, float ? 3 : 1],
  ];
  const n = tagsList.length + 4 + (nodata !== null ? 1 : 0);
  const ifdLen = 2 + n * 12 + 4;
  const header = 8;
  const dataAt = header + ifdLen;
  const pixLen = width * height * bps;
  const extraBase = dataAt + pixLen;
  const scaleAt = extraBase + addExtra(dbl([pixel, pixel, 0]));
  const tieAt = extraBase + addExtra(dbl([0, 0, 0, origin[0], origin[1], 0]));
  let ndAt = 0;
  if (nodata !== null) ndAt = extraBase + addExtra(new TextEncoder().encode(`${nodata}\0`));
  tagsList.push([273, 4, 1, dataAt], [279, 4, 1, pixLen], [33550, 12, 3, scaleAt], [33922, 12, 6, tieAt]);
  if (nodata !== null) tagsList.push([42113, 2, String(nodata).length + 1, ndAt]);
  tagsList.sort((p, q) => p[0] - q[0]);
  const out = new Uint8Array(extraBase + extraLen);
  const dv = new DataView(out.buffer);
  dv.setUint16(0, 0x4949); dv.setUint16(2, 42, true); dv.setUint32(4, 8, true);
  dv.setUint16(8, tagsList.length, true);
  tagsList.forEach(([tag, type, count, val], i) => {
    const e = 10 + i * 12;
    dv.setUint16(e, tag, true); dv.setUint16(e + 2, type, true); dv.setUint32(e + 4, count, true);
    if (type === 3 && count === 1) dv.setUint16(e + 8, val, true); else dv.setUint32(e + 8, val, true);
  });
  for (let i = 0; i < width * height; i++) {
    if (float) dv.setFloat32(dataAt + i * 4, data[i], true); else out[dataAt + i] = data[i];
  }
  let o = extraBase;
  for (const b of extra) { out.set(b, o); o += b.length; }
  return out.buffer;
}
