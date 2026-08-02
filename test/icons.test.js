/**
 * The committed PNGs are compared by decoded pixels, not by file bytes: zlib
 * output differs across platforms and Node versions, so a byte comparison would
 * fail in CI while the images are identical.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import test, { describe } from 'node:test';
import zlib from 'node:zlib';
import { drawIcon, ICONS, iconPath } from '../scripts/generate-icons.mjs';

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Minimal reader for the PNGs this project writes: 8-bit RGBA, filter 0. */
function decodePng(buffer) {
  assert.ok(buffer.subarray(0, 8).equals(PNG_SIGNATURE), 'not a PNG');

  let offset = 8;
  let header = null;
  const idat = [];

  while (offset < buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString('ascii', offset + 4, offset + 8);
    const data = buffer.subarray(offset + 8, offset + 8 + length);

    if (type === 'IHDR') {
      header = {
        width: data.readUInt32BE(0),
        height: data.readUInt32BE(4),
        bitDepth: data[8],
        colorType: data[9],
      };
    } else if (type === 'IDAT') {
      idat.push(data);
    } else if (type === 'IEND') {
      break;
    }
    offset += 12 + length; // length + type + data + crc
  }

  assert.ok(header, 'no IHDR');
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = header.width * 4;
  const pixels = Buffer.alloc(header.height * stride);

  for (let y = 0; y < header.height; y++) {
    const rowStart = y * (stride + 1);
    assert.equal(raw[rowStart], 0, `row ${y} uses an unexpected filter`);
    raw.copy(pixels, y * stride, rowStart + 1, rowStart + 1 + stride);
  }
  return { ...header, pixels };
}

describe('app icons', () => {
  for (const [name, size, options] of ICONS) {
    test(`${name} matches what the generator produces`, () => {
      const committed = decodePng(fs.readFileSync(iconPath(name)));
      const generated = decodePng(drawIcon(size, options));

      assert.equal(committed.width, size);
      assert.equal(committed.height, size);
      assert.equal(committed.bitDepth, 8);
      assert.equal(committed.colorType, 6, 'RGBA');
      assert.ok(
        committed.pixels.equals(generated.pixels),
        `${name} is stale — run "npm run icons"`,
      );
    });
  }

  test('the mark is drawn in the accent colour on a dark field', () => {
    const { pixels, width, height } = decodePng(drawIcon(128));

    // Count accent-ish pixels rather than probing one coordinate, so the test
    // survives the mark being redrawn.
    let accent = 0;
    let opaque = 0;
    for (let i = 0; i < pixels.length; i += 4) {
      const [r, g, b, a] = [pixels[i], pixels[i + 1], pixels[i + 2], pixels[i + 3]];
      if (a === 255) opaque++;
      if (a === 255 && r > 150 && g > 80 && g < 180 && b > 50 && b < 140) accent++;
    }

    const share = accent / (width * height);
    assert.ok(share > 0.02, `expected a visible mark, only ${(share * 100).toFixed(1)}% is accent`);
    assert.ok(share < 0.3, `the mark should not swamp the tile (${(share * 100).toFixed(1)}%)`);
    assert.ok(opaque > width * height * 0.8, 'the tile is mostly opaque');

    // The square icon has rounded corners, so the very corner is transparent.
    assert.equal(pixels[3], 0, 'top-left corner is transparent');
  });

  test('the maskable variant fills every corner so a circular crop is safe', () => {
    const { pixels, width } = decodePng(drawIcon(64, { maskable: true }));
    const alphaAt = (x, y) => pixels[(y * width + x) * 4 + 3];
    for (const [x, y] of [
      [0, 0],
      [width - 1, 0],
      [0, width - 1],
      [width - 1, width - 1],
    ]) {
      assert.equal(alphaAt(x, y), 255, `corner ${x},${y} must be opaque`);
    }
  });
});
