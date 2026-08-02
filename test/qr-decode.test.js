/**
 * The QR decoder, tested against codes made by the same library that prints
 * the pairing QR. WebKit has no BarcodeDetector, so this file is the only
 * thing standing between "scan the code" and "type 43 characters".
 *
 * Codes are rendered to a bitmap the way a camera would see one — scaled up,
 * with a quiet zone — and then decoded from those pixels, so binarisation,
 * finder detection, sampling, error correction and the bitstream all run.
 */
import assert from 'node:assert/strict';
import test, { describe } from 'node:test';
import QRCode from 'qrcode';

import { binarize, decodeBits, decodeQR, findFinders, orderFinders } from '../web/qr-decode.js';

/** Render a QR to greyscale pixels, as a camera pointed at a screen would. */
function render(text, { ecLevel = 'M', scale = 6, quiet = 4, dark = 20, light = 235 } = {}) {
  const qr = QRCode.create(text, { errorCorrectionLevel: ecLevel });
  const size = qr.modules.size;
  const side = (size + quiet * 2) * scale;
  const data = new Uint8ClampedArray(side * side * 4);

  for (let y = 0; y < side; y += 1) {
    for (let x = 0; x < side; x += 1) {
      const col = Math.floor(x / scale) - quiet;
      const row = Math.floor(y / scale) - quiet;
      const inside = row >= 0 && col >= 0 && row < size && col < size;
      const on = inside && qr.modules.data[row * size + col];
      const v = on ? dark : light;
      const p = (y * side + x) * 4;
      data[p] = v;
      data[p + 1] = v;
      data[p + 2] = v;
      data[p + 3] = 255;
    }
  }
  return { data, width: side, height: side, version: qr.version };
}

const TOKEN_URL = 'http://100.65.155.82:8787/#token=W2hWltdR0zHNiY2QxdDlRkrZ0xJ-iwAHJPDdtMmUK1I';

describe('decoding a pairing code', () => {
  test('reads the exact link the app shows', () => {
    const image = render(TOKEN_URL);
    assert.equal(decodeQR(image), TOKEN_URL);
  });

  test('reads it at every error-correction level', () => {
    for (const ecLevel of ['L', 'M', 'Q', 'H']) {
      assert.equal(decodeQR(render(TOKEN_URL, { ecLevel })), TOKEN_URL, `level ${ecLevel}`);
    }
  });

  test('reads the long tailnet-name form, and a short code', () => {
    const long = 'http://miguels-macbook-pro-1.tail3b97b9.ts.net:8787/#token=W2hWltdR0zHNiY2QxdDlRkrZ0xJ-iwAHJPDdtMmUK1I';
    assert.equal(decodeQR(render(long)), long);
    assert.equal(decodeQR(render('123456')), '123456');
  });

  test('handles versions 1 through 10', () => {
    for (let version = 1; version <= 10; version += 1) {
      // Grow the payload until qrcode picks the version we want.
      let text = 'x';
      let image = render(text);
      while (image.version < version && text.length < 400) {
        text += 'x'.repeat(8);
        image = render(text);
      }
      if (image.version !== version) continue; // some lengths skip a version
      assert.equal(decodeQR(image), text, `version ${version}`);
    }
  });
});

describe('a camera, not a screenshot', () => {
  test('survives low contrast and a bright corner', () => {
    const image = render(TOKEN_URL, { dark: 70, light: 190 });
    // Glare across one corner: everything gets lighter towards the top right.
    for (let y = 0; y < image.height; y += 1) {
      for (let x = 0; x < image.width; x += 1) {
        const lift = Math.max(0, 60 - (y * 60) / image.height + (x * 40) / image.width);
        const p = (y * image.width + x) * 4;
        for (let c = 0; c < 3; c += 1) image.data[p + c] = Math.min(255, image.data[p + c] + lift);
      }
    }
    assert.equal(decodeQR(image), TOKEN_URL, 'an adaptive threshold is the point');
  });

  test('survives sensor noise', () => {
    const image = render(TOKEN_URL, { scale: 8 });
    // Deterministic speckle — a seeded pattern, so a failure is reproducible.
    let seed = 12345;
    for (let i = 0; i < image.data.length; i += 4) {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      const noise = ((seed >> 16) % 41) - 20;
      for (let c = 0; c < 3; c += 1) {
        image.data[i + c] = Math.max(0, Math.min(255, image.data[i + c] + noise));
      }
    }
    assert.equal(decodeQR(image), TOKEN_URL);
  });

  test('repairs a code with a chunk covered', () => {
    // High EC level tolerates ~30% loss; a thumb over a corner is less.
    const image = render(TOKEN_URL, { ecLevel: 'H', scale: 6 });
    const blot = Math.floor(image.width * 0.16);
    for (let y = image.height - blot; y < image.height; y += 1) {
      for (let x = image.width - blot; x < image.width; x += 1) {
        const p = (y * image.width + x) * 4;
        image.data[p] = image.data[p + 1] = image.data[p + 2] = 235;
      }
    }
    assert.equal(decodeQR(image), TOKEN_URL, 'Reed-Solomon earns its keep');
  });
});

/** Rotate an image about its centre, sampling nearest-neighbour. */
function rotate(image, degrees) {
  const angle = (degrees * Math.PI) / 180;
  const cos = Math.cos(-angle);
  const sin = Math.sin(-angle);
  const { width, height } = image;
  const out = new Uint8ClampedArray(width * height * 4).fill(255);
  const cx = width / 2;
  const cy = height / 2;

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const sx = Math.round(cos * (x - cx) - sin * (y - cy) + cx);
      const sy = Math.round(sin * (x - cx) + cos * (y - cy) + cy);
      const p = (y * width + x) * 4;
      if (sx < 0 || sy < 0 || sx >= width || sy >= height) {
        out[p] = out[p + 1] = out[p + 2] = 235;
      } else {
        const q = (sy * width + sx) * 4;
        out[p] = image.data[q];
        out[p + 1] = image.data[q + 1];
        out[p + 2] = image.data[q + 2];
      }
      out[p + 3] = 255;
    }
  }
  return { data: out, width, height };
}

describe('held by a human', () => {
  test('reads a code tilted the way a hand tilts one', () => {
    for (const degrees of [4, 8, 12, 20]) {
      const image = rotate(render(TOKEN_URL, { scale: 8, quiet: 6 }), degrees);
      assert.equal(decodeQR(image), TOKEN_URL, `${degrees}°`);
    }
  });

  test('reads a code turned on its side or upside down', () => {
    // Quarter turns are exact, so they cost nothing: a phone in landscape, or
    // a laptop screen read from the other side of a desk.
    for (const degrees of [90, 180, 270]) {
      const image = rotate(render(TOKEN_URL, { scale: 8, quiet: 6 }), degrees);
      assert.equal(decodeQR(image), TOKEN_URL, `${degrees}°`);
    }
  });

  test('a hard diagonal gives up rather than lying', () => {
    // Beyond ~25° the three centres, measured along the image's axes, skew the
    // frame enough to drift by the far corner. The scanner keeps sampling
    // frames, so this shows up as "keep pointing", never as a wrong token.
    const image = rotate(render(TOKEN_URL, { scale: 8, quiet: 6 }), 45);
    const result = decodeQR(image);
    assert.ok(result === null || result === TOKEN_URL, `got ${JSON.stringify(result)}`);
  });
});

describe('refusing to guess', () => {
  test('a frame with no code returns null, not an exception', () => {
    const width = 200;
    const height = 200;
    const data = new Uint8ClampedArray(width * height * 4).fill(200);
    assert.equal(decodeQR({ data, width, height }), null);
  });

  test('a frame of noise returns null', () => {
    const width = 160;
    const height = 160;
    const data = new Uint8ClampedArray(width * height * 4);
    let seed = 7;
    for (let i = 0; i < data.length; i += 4) {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      const v = (seed >> 16) & 255;
      data[i] = data[i + 1] = data[i + 2] = v;
      data[i + 3] = 255;
    }
    assert.equal(decodeQR({ data, width, height }), null);
  });

  test('a destroyed code returns null rather than a mangled token', () => {
    // Half the code gone is past any correction; the danger is confidently
    // returning a token with a flipped character.
    const image = render(TOKEN_URL, { ecLevel: 'L' });
    for (let y = 0; y < image.height / 2; y += 1) {
      for (let x = 0; x < image.width; x += 1) {
        const p = (y * image.width + x) * 4;
        image.data[p] = image.data[p + 1] = image.data[p + 2] = 235;
      }
    }
    const result = decodeQR(image);
    assert.ok(result === null || result === TOKEN_URL, `got ${JSON.stringify(result)}`);
  });
});

describe('the pieces', () => {
  test('finds exactly three finder patterns and orients them', () => {
    const image = render(TOKEN_URL);
    const bits = binarize(image.data, image.width, image.height);
    const layout = orderFinders(findFinders(bits, image.width, image.height));

    assert.ok(layout, 'three patterns in a right angle');
    // Top-left is up and to the left of both others, in image space.
    assert.ok(layout.topLeft.x < layout.topRight.x);
    assert.ok(layout.topLeft.y < layout.bottomLeft.y);
    assert.ok(Math.abs(layout.topLeft.y - layout.topRight.y) < layout.moduleSize);
  });

  test('decodes from a bit grid without any image', () => {
    const image = render('123456');
    const bits = binarize(image.data, image.width, image.height);
    assert.equal(decodeBits(bits, image.width, image.height), '123456');
  });
});
