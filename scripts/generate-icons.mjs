#!/usr/bin/env node
/**
 * Renders the app icons as real PNGs — no image libraries, no build step.
 * Shapes are drawn by signed-distance functions so the edges stay smooth at
 * any size. Run `node scripts/generate-icons.mjs` after changing the mark.
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const OUT_DIR = fileURLToPath(new URL('../web/icons/', import.meta.url));

const BG = [0x0f, 0x0f, 0x10];
const FG = [0xe0, 0x85, 0x5f];

// ---- PNG encoding ----------------------------------------------------------

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

export function encodePng(width, height, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // truecolour with alpha
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  // One filter byte (0 = none) per scanline.
  const raw = Buffer.alloc(height * (width * 4 + 1));
  for (let y = 0; y < height; y++) {
    const rowStart = y * (width * 4 + 1);
    raw[rowStart] = 0;
    rgba.copy(raw, rowStart + 1, y * width * 4, (y + 1) * width * 4);
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---- geometry --------------------------------------------------------------

/** Distance from point p to segment ab. */
function distToSegment(px, py, ax, ay, bx, by) {
  const abx = bx - ax;
  const aby = by - ay;
  const apx = px - ax;
  const apy = py - ay;
  const lenSq = abx * abx + aby * aby;
  const t = lenSq === 0 ? 0 : Math.max(0, Math.min(1, (apx * abx + apy * aby) / lenSq));
  const cx = ax + t * abx;
  const cy = ay + t * aby;
  return Math.hypot(px - cx, py - cy);
}

/** Distance to a rounded rectangle centred on the canvas. */
function distToRoundRect(px, py, size, radius) {
  const half = size / 2;
  const dx = Math.abs(px - half) - (half - radius);
  const dy = Math.abs(py - half) - (half - radius);
  const outside = Math.hypot(Math.max(dx, 0), Math.max(dy, 0));
  return outside + Math.min(Math.max(dx, dy), 0) - radius;
}

const mix = (a, b, t) => a + (b - a) * t;

export function drawIcon(size, { maskable = false } = {}) {
  const rgba = Buffer.alloc(size * size * 4);
  const scale = size / 512;

  // A maskable icon must survive being cropped to a circle, so the mark shrinks
  // and the background bleeds to every edge.
  const inset = maskable ? size * 0.14 : 0;
  const radius = maskable ? 0 : 114 * scale;
  const stroke = (maskable ? 34 : 38) * scale;

  // Design coordinates are authored against a 512-unit canvas.
  const unit = (size - inset * 2) / 512;
  const map = (x, y) => [inset + x * unit, inset + y * unit];
  const [c1x, c1y] = map(150, 154);
  const [c2x, c2y] = map(254, 256);
  const [c3x, c3y] = map(150, 358);
  const [u1x, u1y] = map(286, 358);
  const [u2x, u2y] = map(394, 358);

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const px = x + 0.5;
      const py = y + 0.5;

      const bgDist = maskable ? -1 : distToRoundRect(px, py, size, radius);
      const bgAlpha = Math.max(0, Math.min(1, 0.5 - bgDist));

      const markDist =
        Math.min(
          distToSegment(px, py, c1x, c1y, c2x, c2y),
          distToSegment(px, py, c2x, c2y, c3x, c3y),
          distToSegment(px, py, u1x, u1y, u2x, u2y),
        ) - stroke / 2;
      const markAlpha = Math.max(0, Math.min(1, 0.5 - markDist));

      const r = mix(BG[0], FG[0], markAlpha);
      const g = mix(BG[1], FG[1], markAlpha);
      const b = mix(BG[2], FG[2], markAlpha);
      const a = Math.max(bgAlpha, markAlpha * bgAlpha);

      const offset = (y * size + x) * 4;
      rgba[offset] = Math.round(r);
      rgba[offset + 1] = Math.round(g);
      rgba[offset + 2] = Math.round(b);
      rgba[offset + 3] = Math.round(a * 255);
    }
  }

  return encodePng(size, size, rgba);
}

/** The icon set, as (filename, size, options) — shared with the tests. */
export const ICONS = [
  ['icon-192.png', 192, {}],
  ['icon-512.png', 512, {}],
  ['icon-maskable-512.png', 512, { maskable: true }],
];

export const iconPath = (name) => path.join(OUT_DIR, name);

// Only write files when run directly, so tests can import the drawing code.
if (process.argv[1] && fileURLToPath(import.meta.url) === fs.realpathSync(process.argv[1])) {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  for (const [name, size, options] of ICONS) {
    const buffer = drawIcon(size, options);
    fs.writeFileSync(iconPath(name), buffer);
    console.log(`wrote ${name} (${(buffer.length / 1024).toFixed(1)} KB)`);
  }
}
