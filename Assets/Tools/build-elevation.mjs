// Builds Web/data/elevation.bin.gz: the height of the ground over Manhattan, which js/terrain.js reads.
// Run from the app's folder with Node 22 or later (it fetches about 100 map tiles once, kept in the cache folder, by default in the temporary folder):
//
//   node Assets/Tools/build-elevation.mjs [cacheFolder]
//
// The heights are the open Terrain Tiles on AWS (terrarium encoding; bare earth from USGS 3DEP in the US, so
// buildings, bridges and elevated roads aren't in them). They're sampled in the game's world frame (1 unit = 1 m,
// x grid east, z grid south, origin the centreline of 5th Ave & 42nd St, turned 29.02° from north: the frame
// js/nyc-geodata.js is drawn in), only over Manhattan's outline, smoothed so streets don't follow the survey's
// noise, and eased down to 0 within SHORE metres of the water, where the seawalls, waterfront highways, piers
// and bridge landings sit at the waterline and stay flat.
//
// For another place, change LAT0/LON0 and the bearing to the frame its map data is drawn in, and OUTLINES to its
// land. File: "ELV2", six little-endian float32s (x0, z0, step, columns, rows, 0), then columns × rows uint16s,
// row by row from z0, each the height in centimetres; gzip-compressed.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { GEO } from '../../Web/js/nyc-geodata.js';

const here = path.dirname(new URL(import.meta.url).pathname);
// Outside the app's folder: everything in Assets ships inside the app
const cache = process.argv[2] || path.join(os.tmpdir(), 'newyork-elevation-tiles');
fs.mkdirSync(cache, { recursive: true });

const STEP = 8;       // metres between samples
const SMOOTH = 2;     // the smoothing's spread, in samples
const SHORE = 110;    // metres over which heights ease to 0 at the water
const OUTLINES = [GEO.manhattan, GEO.upperManhattan];

// The frame: a local tangent plane at LAT0, LON0, turned by the bearing (tools/geo-base.mjs in Slop New York).
const LAT0 = 40.75318, LON0 = -73.98185, A = 6378137.0, E2 = 6.69437999014e-3;
const PHI0 = (LAT0 * Math.PI) / 180, SIN0 = Math.sin(PHI0);
const KX = (Math.PI / 180) * (A / Math.sqrt(1 - E2 * SIN0 * SIN0)) * Math.cos(PHI0);
const KY = (Math.PI / 180) * ((A * (1 - E2)) / Math.pow(1 - E2 * SIN0 * SIN0, 1.5));
const THETA = (GEO.frame.bearingDeg * Math.PI) / 180, C = Math.cos(THETA), S = Math.sin(THETA);
const gridUV = (lon, lat) => {
  const e = (lon - LON0) * KX, n = (lat - LAT0) * KY;
  return [e * C - n * S, -(e * S + n * C)];
};
// The origin isn't in the data, so it's found from the landmarks the data places by latitude and longitude.
const KNOWN = {
  gwbManhattanTower: [40.85012, -73.94693], gwbNJTower: [40.85361, -73.95804],
  verrazzanoBrooklynTower: [40.60799, -74.03864], statueOfLiberty: [40.68925, -74.0445],
  castleClinton: [40.70355, -74.01686], bowlingGreen: [40.70496, -74.01352]
};
const offsets = Object.entries(KNOWN).map(([k, [lat, lon]]) => {
  const [u, v] = gridUV(lon, lat);
  return [u - GEO.points[k][0], v - GEO.points[k][1]];
});
const ORIGIN = [0, 1].map((i) => offsets.reduce((s, o) => s + o[i], 0) / offsets.length);
const spread = Math.max(...offsets.map((o) => Math.hypot(o[0] - ORIGIN[0], o[1] - ORIGIN[1])));
console.log(`origin ${ORIGIN.map((v) => v.toFixed(1))}, landmarks within ${spread.toFixed(1)} m of it`);
if (spread > 5) throw new Error('the frame does not match the data');
const toLonLat = (x, z) => {
  const u = x + ORIGIN[0], v = z + ORIGIN[1];
  const e = u * C - v * S, n = -(u * S + v * C);
  return [LON0 + e / KX, LAT0 + n / KY];
};

// Terrain Tiles at zoom 15 (about 3.6 m a pixel here), decoded from PNG with zlib alone.
const Z = 15, N = 2 ** Z;
const tiles = new Map();
function decodePNG(buf) {
  let p = 8, width = 0, height = 0;
  const idat = [];
  while (p < buf.length) {
    const len = buf.readUInt32BE(p), type = buf.toString('ascii', p + 4, p + 8);
    if (type === 'IHDR') {
      width = buf.readUInt32BE(p + 8); height = buf.readUInt32BE(p + 12);
      if (buf[p + 16] !== 8 || buf[p + 17] !== 2) throw new Error('expected 8-bit RGB');
    }
    if (type === 'IDAT') idat.push(buf.subarray(p + 8, p + 8 + len));
    p += 12 + len;
  }
  const raw = zlib.inflateSync(Buffer.concat(idat)), bpp = 3, stride = width * bpp;
  const out = Buffer.alloc(height * stride);
  for (let y = 0; y < height; y++) {
    const f = raw[y * (stride + 1)], src = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? out[y * stride + x - bpp] : 0, b = y ? out[(y - 1) * stride + x] : 0;
      const c = x >= bpp && y ? out[(y - 1) * stride + x - bpp] : 0;
      let v = src[x];
      if (f === 1) v += a;
      else if (f === 2) v += b;
      else if (f === 3) v += (a + b) >> 1;
      else if (f === 4) {
        const pa = Math.abs(b - c), pb = Math.abs(a - c), pc = Math.abs(a + b - 2 * c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      out[y * stride + x] = v & 255;
    }
  }
  const h = new Float32Array(width * height);
  for (let i = 0; i < h.length; i++) h[i] = out[i * 3] * 256 + out[i * 3 + 1] + out[i * 3 + 2] / 256 - 32768;
  return h;
}
// Each tile is fetched once, however many samples ask for it at the same time.
function tile(tx, ty) {
  const key = `${tx}/${ty}`;
  if (!tiles.has(key)) tiles.set(key, readTile(tx, ty));
  return tiles.get(key);
}
async function readTile(tx, ty) {
  const file = path.join(cache, `${Z}-${tx}-${ty}.png`);
  if (!fs.existsSync(file)) {
    const res = await fetch(`https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${Z}/${tx}/${ty}.png`);
    if (!res.ok) throw new Error(`tile ${tx}/${ty}: ${res.status}`);
    fs.writeFileSync(file, Buffer.from(await res.arrayBuffer()));
  }
  return decodePNG(fs.readFileSync(file));
}
async function heightAt(lon, lat) {
  const fx = ((lon + 180) / 360) * N * 256;
  const r = (lat * Math.PI) / 180;
  const fy = ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * N * 256;
  const px = Math.floor(fx - 0.5), py = Math.floor(fy - 0.5), ax = fx - 0.5 - px, ay = fy - 0.5 - py;
  const at = async (x, y) => (await tile(Math.floor(x / 256), Math.floor(y / 256)))[(y & 255) * 256 + (x & 255)];
  const [a, b, c, d] = await Promise.all([at(px, py), at(px + 1, py), at(px, py + 1), at(px + 1, py + 1)]);
  return (a * (1 - ax) + b * ax) * (1 - ay) + (c * (1 - ax) + d * ax) * ay;
}

// The grid over the land's outlines, and which samples are on land.
let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
for (const flat of OUTLINES) for (let i = 0; i < flat.length; i += 2) {
  x0 = Math.min(x0, flat[i]); x1 = Math.max(x1, flat[i]); z0 = Math.min(z0, flat[i + 1]); z1 = Math.max(z1, flat[i + 1]);
}
x0 = Math.floor(x0 / STEP) * STEP - STEP * 4; z0 = Math.floor(z0 / STEP) * STEP - STEP * 4;
const cols = Math.ceil((x1 - x0) / STEP) + 8, rows = Math.ceil((z1 - z0) / STEP) + 8;
const land = new Uint8Array(cols * rows);
for (let r = 0; r < rows; r++) {
  // Even-odd crossings of this row with every outline's edges.
  const z = z0 + r * STEP, xs = [];
  for (const flat of OUTLINES) {
    const n = flat.length / 2;
    for (let i = 0, j = n - 1; i < n; j = i++) {
      const ax = flat[j * 2], az = flat[j * 2 + 1], bx = flat[i * 2], bz = flat[i * 2 + 1];
      if ((az > z) !== (bz > z)) xs.push(ax + ((z - az) / (bz - az)) * (bx - ax));
    }
  }
  xs.sort((a, b) => a - b);
  for (let k = 0; k + 1 < xs.length; k += 2) {
    const c0 = Math.max(0, Math.ceil((xs[k] - x0) / STEP)), c1 = Math.min(cols - 1, Math.floor((xs[k + 1] - x0) / STEP));
    for (let c = c0; c <= c1; c++) land[r * cols + c] = 1;
  }
}

// Heights on land; the water's depths don't matter.
const height = new Float32Array(cols * rows);
for (let r = 0; r < rows; r++) {
  const row = await Promise.all(Array.from({ length: cols }, (_, c) =>
    land[r * cols + c] ? heightAt(...toLonLat(x0 + c * STEP, z0 + r * STEP)) : 0));
  for (let c = 0; c < cols; c++) height[r * cols + c] = Math.max(0, row[c]);
}
console.log(`${cols} × ${rows} samples at ${STEP} m, ${tiles.size} tiles read`);

// Smoothed with a Gaussian over land only, so the shore's zeros don't pull the land down.
const kernel = Array.from({ length: SMOOTH * 3 * 2 + 1 }, (_, i) => Math.exp(-((i - SMOOTH * 3) ** 2) / (2 * SMOOTH * SMOOTH)));
const blur = (src, along) => {
  const out = new Float32Array(src.length), R = SMOOTH * 3;
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
    if (!land[r * cols + c]) continue;
    let sum = 0, weight = 0;
    for (let k = -R; k <= R; k++) {
      const rr = along ? r : r + k, cc = along ? c + k : c;
      if (rr < 0 || cc < 0 || rr >= rows || cc >= cols || !land[rr * cols + cc]) continue;
      sum += src[rr * cols + cc] * kernel[k + R];
      weight += kernel[k + R];
    }
    out[r * cols + c] = sum / weight;
  }
  return out;
};
const smooth = blur(blur(height, true), false);

// Distance to the water (two-pass chamfer over the grid), and the heights eased down to 0 near it.
const far = new Float32Array(cols * rows);
for (let i = 0; i < far.length; i++) far[i] = land[i] ? 1e9 : 0;
const D = STEP, DD = STEP * Math.SQRT2;
const relax = (r, c, dr, dc, d) => {
  const rr = r + dr, cc = c + dc;
  if (rr < 0 || cc < 0 || rr >= rows || cc >= cols) return;
  far[r * cols + c] = Math.min(far[r * cols + c], far[rr * cols + cc] + d);
};
for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
  relax(r, c, -1, 0, D); relax(r, c, 0, -1, D); relax(r, c, -1, -1, DD); relax(r, c, -1, 1, DD);
}
for (let r = rows - 1; r >= 0; r--) for (let c = cols - 1; c >= 0; c--) {
  relax(r, c, 1, 0, D); relax(r, c, 0, 1, D); relax(r, c, 1, 1, DD); relax(r, c, 1, -1, DD);
}
const data = new Uint16Array(cols * rows);
let top = 0;
for (let i = 0; i < data.length; i++) {
  const t = Math.min(1, far[i] / SHORE), ease = t * t * (3 - 2 * t);
  const h = land[i] ? smooth[i] * ease : 0;
  top = Math.max(top, h);
  data[i] = Math.round(h * 100);
}
console.log(`highest ${top.toFixed(1)} m`);

const out = path.join(here, '../../Web/data/elevation.bin.gz');
fs.mkdirSync(path.dirname(out), { recursive: true });
const header = Buffer.from(new Float32Array([x0, z0, STEP, cols, rows, 0]).buffer);
fs.writeFileSync(out, zlib.gzipSync(Buffer.concat([Buffer.from('ELV2'), header, Buffer.from(data.buffer)]), { level: 9 }));
console.log(`${path.relative(process.cwd(), out)}: ${(fs.statSync(out).size / 1024).toFixed(0)} KB`);
