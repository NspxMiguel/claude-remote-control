/**
 * A QR decoder, because WebKit does not have one.
 *
 * `BarcodeDetector` exists in Chromium and nowhere else — probed on iOS 26.5,
 * it is absent — so on an iPhone, the browser everyone actually pairs from,
 * "scan the code" has to be done by hand: threshold the frame, find the three
 * finder patterns, sample the grid, undo the mask, repair the codewords with
 * Reed-Solomon and read the bitstream.
 *
 * Scope is deliberately the codes this app produces: versions 1-10, byte,
 * numeric and alphanumeric modes. Not a general-purpose library — it decodes
 * our own pairing links, and returns null on anything it is unsure about
 * rather than guessing at a token.
 */

// ---- geometry ------------------------------------------------------------------

/** Grid dimension for a version: 21, 25, 29 … */
const dimensionOf = (version) => version * 4 + 17;

/** Where alignment patterns sit, per version (row/col centres). */
const ALIGNMENT_CENTRES = [
  [], [], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34],
  [6, 22, 38], [6, 24, 42], [6, 26, 46], [6, 28, 50],
];

/** Total codewords (data + error correction) per version. */
const TOTAL_CODEWORDS = [0, 26, 44, 70, 100, 134, 172, 196, 242, 292, 346];

/**
 * Block structure per version and EC level: [ecPerBlock, blocks1, data1, blocks2, data2].
 * Straight from the standard's table; the second group is absent when blocks2 is 0.
 */
const EC_BLOCKS = {
  L: [
    null, [7, 1, 19, 0, 0], [10, 1, 34, 0, 0], [15, 1, 55, 0, 0], [20, 1, 80, 0, 0],
    [26, 1, 108, 0, 0], [18, 2, 68, 0, 0], [20, 2, 78, 0, 0], [24, 2, 97, 0, 0],
    [30, 2, 116, 0, 0], [18, 2, 68, 2, 69],
  ],
  M: [
    null, [10, 1, 16, 0, 0], [16, 1, 28, 0, 0], [26, 1, 44, 0, 0], [18, 2, 32, 0, 0],
    [24, 2, 43, 0, 0], [16, 4, 27, 0, 0], [18, 4, 31, 0, 0], [22, 2, 38, 2, 39],
    [22, 3, 36, 2, 37], [26, 4, 43, 1, 44],
  ],
  Q: [
    null, [13, 1, 13, 0, 0], [22, 1, 22, 0, 0], [18, 2, 17, 0, 0], [26, 2, 24, 0, 0],
    [18, 2, 15, 2, 16], [24, 4, 19, 0, 0], [18, 2, 14, 4, 15], [22, 4, 18, 2, 19],
    [20, 4, 16, 4, 17], [24, 6, 19, 2, 20],
  ],
  H: [
    null, [17, 1, 9, 0, 0], [28, 1, 16, 0, 0], [22, 2, 13, 0, 0], [16, 4, 9, 0, 0],
    [22, 2, 11, 2, 12], [28, 4, 15, 0, 0], [26, 4, 13, 1, 14], [26, 4, 14, 2, 15],
    [24, 4, 12, 4, 13], [28, 6, 15, 2, 16],
  ],
};

/** Format bits 0-1 name the EC level, in this order. */
const EC_LEVELS = ['M', 'L', 'H', 'Q'];

const MASKS = [
  (r, c) => (r + c) % 2 === 0,
  (r) => r % 2 === 0,
  (r, c) => c % 3 === 0,
  (r, c) => (r + c) % 3 === 0,
  (r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0,
  (r, c) => ((r * c) % 2) + ((r * c) % 3) === 0,
  (r, c) => (((r * c) % 2) + ((r * c) % 3)) % 2 === 0,
  (r, c) => (((r + c) % 2) + ((r * c) % 3)) % 2 === 0,
];

// ---- binarisation ----------------------------------------------------------------

const BLOCK = 8;

/**
 * Adaptive threshold: a camera pointed at a screen gives glare on one side and
 * shadow on the other, and one global cutoff loses a corner of the code. Each
 * 8x8 block is compared against the average of its neighbourhood.
 */
export function binarize(data, width, height) {
  const raw = new Uint8Array(width * height);
  for (let i = 0, p = 0; i < raw.length; i += 1, p += 4) {
    // Luma, integer: the green channel carries most of it.
    raw[i] = (data[p] * 77 + data[p + 1] * 150 + data[p + 2] * 29) >> 8;
  }

  // A 3x3 mean first. Sensor speckle is what makes a blank margin look like it
  // has detail in it, and a block that looks detailed is a block this code
  // thresholds against its own average — which turns the margin into noise and
  // hides the finder patterns behind it. Modules are several pixels wide, so
  // the blur costs edges nothing.
  const grey = new Uint8Array(width * height);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      let sum = 0;
      let n = 0;
      for (let dy = -1; dy <= 1; dy += 1) {
        const yy = y + dy;
        if (yy < 0 || yy >= height) continue;
        for (let dx = -1; dx <= 1; dx += 1) {
          const xx = x + dx;
          if (xx < 0 || xx >= width) continue;
          sum += raw[yy * width + xx];
          n += 1;
        }
      }
      grey[y * width + x] = sum / n;
    }
  }

  const bw = Math.max(1, Math.ceil(width / BLOCK));
  const bh = Math.max(1, Math.ceil(height / BLOCK));
  const averages = new Int32Array(bw * bh);

  for (let by = 0; by < bh; by += 1) {
    for (let bx = 0; bx < bw; bx += 1) {
      let sum = 0;
      let min = 255;
      let max = 0;
      let count = 0;
      for (let y = by * BLOCK; y < Math.min((by + 1) * BLOCK, height); y += 1) {
        for (let x = bx * BLOCK; x < Math.min((bx + 1) * BLOCK, width); x += 1) {
          const v = grey[y * width + x];
          sum += v;
          count += 1;
          if (v < min) min = v;
          if (v > max) max = v;
        }
      }
      // A block of uniform colour has no edge to threshold. Its own average
      // sits in the middle of the noise, so half of a blank quiet zone comes
      // out dark and the finder scan has nothing clean to latch onto. Assume
      // flat means background and put the cut far below it, unless a
      // neighbouring block says this region is genuinely dark.
      let average;
      if (max - min > 24) {
        average = sum / count;
      } else {
        average = min / 2;
        if (by > 0 && bx > 0) {
          const neighbours =
            (averages[(by - 1) * bw + bx] +
              2 * averages[by * bw + bx - 1] +
              averages[(by - 1) * bw + bx - 1]) /
            4;
          if (min < neighbours) average = neighbours;
        }
      }
      averages[by * bw + bx] = average;
    }
  }

  const bits = new Uint8Array(width * height);
  for (let by = 0; by < bh; by += 1) {
    for (let bx = 0; bx < bw; bx += 1) {
      // Average the 3x3 neighbourhood of block averages, so the threshold moves
      // smoothly instead of stepping at block edges.
      let sum = 0;
      let n = 0;
      for (let dy = -1; dy <= 1; dy += 1) {
        for (let dx = -1; dx <= 1; dx += 1) {
          const y = by + dy;
          const x = bx + dx;
          if (y >= 0 && y < bh && x >= 0 && x < bw) {
            sum += averages[y * bw + x];
            n += 1;
          }
        }
      }
      const threshold = sum / n;
      for (let y = by * BLOCK; y < Math.min((by + 1) * BLOCK, height); y += 1) {
        for (let x = bx * BLOCK; x < Math.min((bx + 1) * BLOCK, width); x += 1) {
          bits[y * width + x] = grey[y * width + x] < threshold ? 1 : 0;
        }
      }
    }
  }
  return bits;
}

// ---- finder patterns -------------------------------------------------------------

/** The 1:1:3:1:1 run of a finder pattern, within a fifth of a module. */
function isFinderRatio(runs) {
  const total = runs[0] + runs[1] + runs[2] + runs[3] + runs[4];
  if (total < 7) return false;
  const unit = total / 7;
  const slack = unit * 0.6;
  return (
    Math.abs(unit - runs[0]) < slack &&
    Math.abs(unit - runs[1]) < slack &&
    Math.abs(unit * 3 - runs[2]) < slack * 2 &&
    Math.abs(unit - runs[3]) < slack &&
    Math.abs(unit - runs[4]) < slack
  );
}

/** Centre of the run that just ended at `end`. */
const runCentre = (runs, end) => end - runs[4] - runs[3] - runs[2] / 2;

/**
 * Candidate centres, found by scanning every other row for the ratio and then
 * confirming the same ratio vertically through the candidate.
 */
export function findFinders(bits, width, height) {
  const found = [];

  for (let y = 0; y < height; y += 2) {
    // States 0/2/4 count dark runs, 1/3 count light ones: dark, light, dark,
    // light, dark is the pattern, and a run that ends early shifts the window
    // along rather than starting over — otherwise speckle in the margin eats
    // the code that follows it.
    const runs = [0, 0, 0, 0, 0];
    let state = 0;

    const consider = (end) => {
      if (!isFinderRatio(runs)) return false;
      const cx = runCentre(runs, end);
      const size = (runs[0] + runs[1] + runs[2] + runs[3] + runs[4]) / 7;
      const cy = verticalCentre(bits, width, height, Math.round(cx), y, size);
      if (cy === null) return false;
      record(found, cx, cy, size);
      return true;
    };

    for (let x = 0; x < width; x += 1) {
      const dark = bits[y * width + x] === 1;
      if (dark) {
        if (state % 2 === 1) state += 1; // a light run just ended
        runs[state] += 1;
      } else if (state % 2 === 1) {
        runs[state] += 1; // still in a light run
      } else if (state < 4) {
        state += 1;
        runs[state] += 1;
      } else if (consider(x)) {
        runs.fill(0);
        state = 0;
      } else {
        // Not a finder: slide the window back two runs and keep going.
        runs[0] = runs[2];
        runs[1] = runs[3];
        runs[2] = runs[4];
        runs[3] = 1;
        runs[4] = 0;
        state = 3;
      }
    }
    if (state === 4) consider(width);
  }

  return found
    .filter((c) => c.count >= 2)
    .sort((a, b) => b.count - a.count)
    .slice(0, 12);
}

/** Same ratio check straight down through a candidate, giving its y centre. */
function verticalCentre(bits, width, height, x, y, size) {
  if (x < 0 || x >= width) return null;
  const runs = [0, 0, 0, 0, 0];
  let cy = y;
  // Walk up through dark, light, dark; then down the same way.
  const limit = size * 8;

  let i = y;
  while (i >= 0 && bits[i * width + x] === 1 && runs[2] < limit) {
    runs[2] += 1;
    i -= 1;
  }
  while (i >= 0 && bits[i * width + x] === 0 && runs[1] < limit) {
    runs[1] += 1;
    i -= 1;
  }
  while (i >= 0 && bits[i * width + x] === 1 && runs[0] < limit) {
    runs[0] += 1;
    i -= 1;
  }

  i = y + 1;
  while (i < height && bits[i * width + x] === 1 && runs[2] < limit) {
    runs[2] += 1;
    i += 1;
  }
  while (i < height && bits[i * width + x] === 0 && runs[3] < limit) {
    runs[3] += 1;
    i += 1;
  }
  while (i < height && bits[i * width + x] === 1 && runs[4] < limit) {
    runs[4] += 1;
    i += 1;
  }

  if (!isFinderRatio(runs)) return null;
  cy = i - runs[4] - runs[3] - runs[2] / 2;
  return cy;
}

/** Merge a hit into a nearby candidate, or add it. */
function record(found, x, y, size) {
  for (const c of found) {
    if (Math.abs(c.x - x) < c.size && Math.abs(c.y - y) < c.size) {
      c.x = (c.x * c.count + x) / (c.count + 1);
      c.y = (c.y * c.count + y) / (c.count + 1);
      c.size = (c.size * c.count + size) / (c.count + 1);
      c.count += 1;
      return;
    }
  }
  found.push({ x, y, size, count: 1 });
}

/**
 * Pick the three that form a right-angled isosceles triangle, and say which is
 * which: the corner is the one at the right angle.
 */
export function orderFinders(candidates) {
  let best = null;
  for (let i = 0; i < candidates.length; i += 1) {
    for (let j = i + 1; j < candidates.length; j += 1) {
      for (let k = j + 1; k < candidates.length; k += 1) {
        const trio = [candidates[i], candidates[j], candidates[k]];
        const sizes = trio.map((c) => c.size);
        // Three patterns of a code are the same size; anything else is noise.
        if (Math.max(...sizes) > Math.min(...sizes) * 1.6) continue;

        const scored = scoreTriangle(trio);
        if (scored && (!best || scored.error < best.error)) best = scored;
      }
    }
  }
  return best;
}

function scoreTriangle([a, b, c]) {
  const d = (p, q) => Math.hypot(p.x - q.x, p.y - q.y);
  const sides = [
    { len: d(b, c), corner: a, ends: [b, c] },
    { len: d(a, c), corner: b, ends: [a, c] },
    { len: d(a, b), corner: c, ends: [a, b] },
  ].sort((x, y) => y.len - x.len);

  const [hypotenuse, leg1, leg2] = sides;
  if (leg1.len === 0 || leg2.len === 0) return null;
  // Legs equal, and Pythagoras holds.
  const legError = Math.abs(leg1.len - leg2.len) / leg1.len;
  const rightError = Math.abs(Math.hypot(leg1.len, leg2.len) - hypotenuse.len) / hypotenuse.len;
  if (legError > 0.25 || rightError > 0.25) return null;

  const corner = hypotenuse.corner;
  const [p, q] = hypotenuse.ends;
  // Cross product tells us which of the two is the top-right: with y growing
  // downward, the top-right is the one that leaves the corner clockwise.
  const cross = (p.x - corner.x) * (q.y - corner.y) - (p.y - corner.y) * (q.x - corner.x);
  const [topRight, bottomLeft] = cross > 0 ? [p, q] : [q, p];

  return {
    topLeft: corner,
    topRight,
    bottomLeft,
    error: legError + rightError,
    moduleSize: (corner.size + topRight.size + bottomLeft.size) / 3,
  };
}

// ---- sampling ---------------------------------------------------------------------

/**
 * Walk out from a finder's centre along a direction and measure one module.
 *
 * From the centre, the pattern is 1.5 modules of dark core, 1 light, 1 dark:
 * 3.5 modules to the outer edge, whichever way the code is turned.
 */
function moduleAlong(bits, width, height, from, toward) {
  const dx = toward.x - from.x;
  const dy = toward.y - from.y;
  const length = Math.hypot(dx, dy);
  if (!length) return null;
  const ux = dx / length;
  const uy = dy / length;

  const at = (t) => {
    const x = Math.round(from.x + ux * t);
    const y = Math.round(from.y + uy * t);
    if (x < 0 || y < 0 || x >= width || y >= height) return null;
    return bits[y * width + x];
  };

  /** Distance from the centre to the far edge of the pattern, one way. */
  const halfWidth = (sign) => {
    let t = 0;
    for (const want of [1, 0, 1]) {
      let moved = 0;
      while (at(sign * t) === want) {
        t += 1;
        moved += 1;
        if (t > length) return null;
      }
      if (moved === 0) return null;
    }
    return t;
  };

  // Both ways, so a centre estimate that sits slightly off cancels out instead
  // of biasing the answer: the full crossing is always 7 modules.
  const forward = halfWidth(1);
  const backward = halfWidth(-1);
  if (forward === null || backward === null) return null;
  return (forward + backward) / 7;
}

/** Best estimate of module size, in pixels, from all four walks we can make. */
export function measureModule(bits, width, height, topLeft, topRight, bottomLeft, fallback) {
  const walks = [
    moduleAlong(bits, width, height, topLeft, topRight),
    moduleAlong(bits, width, height, topRight, topLeft),
    moduleAlong(bits, width, height, topLeft, bottomLeft),
    moduleAlong(bits, width, height, bottomLeft, topLeft),
  ].filter((v) => v !== null);

  if (!walks.length) return fallback || null;
  return walks.reduce((a, b) => a + b, 0) / walks.length;
}

/**
 * Read the grid out of the image.
 *
 * The three centres give an affine frame: the code is flat on a screen or a
 * page, and over the small angles a hand holds, the perspective error stays
 * under half a module. Each cell is sampled at its centre.
 */
/**
 * Plausible grid dimensions, best guess first.
 *
 * Every run measurement gains up to a pixel at each colour change, and over
 * fifty modules that is enough to land a version out. So this offers
 * candidates rather than an answer, and the format word — fifteen
 * BCH-protected bits that a wrongly pitched grid will not satisfy — is what
 * decides which one was right.
 */
export function candidateDimensions(bits, width, height, layout) {
  const { topLeft, topRight, bottomLeft } = layout;
  const spanX = Math.hypot(topRight.x - topLeft.x, topRight.y - topLeft.y);
  const spanY = Math.hypot(bottomLeft.x - topLeft.x, bottomLeft.y - topLeft.y);

  // Module size measured along the code's own axes, not from the horizontal
  // scan that found the patterns: a code held at an angle is crossed
  // diagonally, and a diagonal cut through a square finder reports a module
  // up to √2 too wide — enough to pick the wrong version and read nothing.
  const moduleSize = measureModule(bits, width, height, topLeft, topRight, bottomLeft, layout.moduleSize);
  if (!moduleSize) return [];

  // Centres sit 3.5 modules in from each edge, so they are (dimension - 7)
  // apart; every real dimension is 4v + 17.
  const raw = (spanX + spanY) / 2 / moduleSize + 7;
  const nearest = Math.round((raw - 17) / 4) * 4 + 17;
  return [nearest, nearest - 4, nearest + 4, nearest - 8].filter((d) => d >= 21 && d <= 57);
}

export function sampleGrid(bits, width, height, layout, dimension) {
  const { topLeft, topRight, bottomLeft } = layout;
  const version = (dimension - 17) / 4;
  if (!Number.isInteger(version) || version < 1 || version > 10) return null;

  const moduleSize = measureModule(
    bits, width, height, topLeft, topRight, bottomLeft, layout.moduleSize,
  );
  if (!moduleSize) return null;
  const step = dimension - 7;

  // Unit vectors along the code's own axes, in image space.
  const ex = { x: (topRight.x - topLeft.x) / step, y: (topRight.y - topLeft.y) / step };
  const ey = { x: (bottomLeft.x - topLeft.x) / step, y: (bottomLeft.y - topLeft.y) / step };

  // One pixel per module is one speck of sensor noise away from a flipped bit,
  // and a flipped bit costs an error-correction codeword. Vote over a small
  // patch inside the module instead.
  const radius = Math.max(0, Math.min(2, Math.floor(moduleSize / 4)));

  const matrix = new Uint8Array(dimension * dimension);
  for (let row = 0; row < dimension; row += 1) {
    for (let col = 0; col < dimension; col += 1) {
      // The finder centre we measured *is* module (3,3), so steps from it are
      // whole modules. (3.5 is the distance to the code's edge, not to a
      // module centre — using it lands every sample on a module boundary.)
      const u = col - 3;
      const v = row - 3;
      const cx = topLeft.x + ex.x * u + ey.x * v;
      const cy = topLeft.y + ex.y * u + ey.y * v;

      let dark = 0;
      let votes = 0;
      for (let dy = -radius; dy <= radius; dy += 1) {
        for (let dx = -radius; dx <= radius; dx += 1) {
          const x = Math.round(cx) + dx;
          const y = Math.round(cy) + dy;
          if (x < 0 || y < 0 || x >= width || y >= height) return null;
          dark += bits[y * width + x];
          votes += 1;
        }
      }
      matrix[row * dimension + col] = dark * 2 > votes ? 1 : 0;
    }
  }
  return { matrix, dimension, version };
}

// ---- format information -----------------------------------------------------------

const FORMAT_MASK = 0b101010000010010;

/** Hamming distance between two 15-bit words. */
function distance(a, b) {
  let x = a ^ b;
  let n = 0;
  while (x) {
    n += x & 1;
    x >>= 1;
  }
  return n;
}

/** All 32 valid format words, generated rather than tabulated. */
const FORMAT_WORDS = (() => {
  const words = [];
  for (let data = 0; data < 32; data += 1) {
    let rest = data << 10;
    for (let i = 4; i >= 0; i -= 1) {
      if (rest & (1 << (i + 10))) rest ^= 0b10100110111 << i;
    }
    words.push({ data, word: ((data << 10) | rest) ^ FORMAT_MASK });
  }
  return words;
})();

export function readFormat(matrix, dimension) {
  const at = (r, c) => matrix[r * dimension + c];

  // Copy 1: around the top-left finder.
  let a = 0;
  for (let i = 0; i <= 5; i += 1) a = (a << 1) | at(8, i);
  a = (a << 1) | at(8, 7);
  a = (a << 1) | at(8, 8);
  a = (a << 1) | at(7, 8);
  for (let i = 5; i >= 0; i -= 1) a = (a << 1) | at(i, 8);

  // Copy 2: split between the other two finders.
  let b = 0;
  for (let i = dimension - 1; i >= dimension - 7; i -= 1) b = (b << 1) | at(i, 8);
  for (let i = dimension - 8; i < dimension; i += 1) b = (b << 1) | at(8, i);

  for (const candidate of [a, b]) {
    let best = null;
    for (const { data, word } of FORMAT_WORDS) {
      const d = distance(candidate, word);
      if (!best || d < best.d) best = { d, data };
    }
    // More than 3 bit errors and the correction is a coin toss.
    if (best && best.d <= 3) {
      return { ecLevel: EC_LEVELS[(best.data >> 3) & 3], mask: best.data & 7 };
    }
  }
  return null;
}

// ---- function patterns and codeword extraction -------------------------------------

/** Marks every module that carries no data. */
function functionMap(dimension, version) {
  const map = new Uint8Array(dimension * dimension);
  const mark = (r, c) => {
    if (r >= 0 && c >= 0 && r < dimension && c < dimension) map[r * dimension + c] = 1;
  };

  // Finders, their separators, and the format areas beside them.
  for (const [r0, c0] of [[0, 0], [0, dimension - 8], [dimension - 8, 0]]) {
    for (let r = 0; r < 9; r += 1) for (let c = 0; c < 9; c += 1) mark(r0 + r, c0 + c);
  }
  for (let i = 0; i < dimension; i += 1) {
    mark(6, i);
    mark(i, 6);
  }
  for (const r of ALIGNMENT_CENTRES[version]) {
    for (const c of ALIGNMENT_CENTRES[version]) {
      // No alignment pattern sits on top of a finder.
      const onFinder =
        (r <= 8 && c <= 8) || (r <= 8 && c >= dimension - 9) || (r >= dimension - 9 && c <= 8);
      if (onFinder) continue;
      for (let dr = -2; dr <= 2; dr += 1) for (let dc = -2; dc <= 2; dc += 1) mark(r + dr, c + dc);
    }
  }
  if (version >= 7) {
    for (let i = 0; i < 6; i += 1) {
      for (let j = 0; j < 3; j += 1) {
        mark(i, dimension - 11 + j);
        mark(dimension - 11 + j, i);
      }
    }
  }
  return map;
}

/** Read the data modules in their zigzag order, unmasking as we go. */
export function readCodewords(matrix, dimension, version, mask) {
  const map = functionMap(dimension, version);
  const maskFn = MASKS[mask];
  const codewords = [];
  let byte = 0;
  let bits = 0;
  let upward = true;

  for (let right = dimension - 1; right >= 1; right -= 2) {
    // Column 6 is the timing pattern; the pairs step over it.
    if (right === 6) right = 5;
    for (let i = 0; i < dimension; i += 1) {
      const row = upward ? dimension - 1 - i : i;
      for (let c = 0; c < 2; c += 1) {
        const col = right - c;
        if (map[row * dimension + col]) continue;
        let bit = matrix[row * dimension + col];
        if (maskFn(row, col)) bit ^= 1;
        byte = (byte << 1) | bit;
        bits += 1;
        if (bits === 8) {
          codewords.push(byte);
          byte = 0;
          bits = 0;
        }
      }
    }
    upward = !upward;
  }
  return codewords;
}

// ---- Reed-Solomon -------------------------------------------------------------------

const GF_EXP = new Uint8Array(512);
const GF_LOG = new Uint8Array(256);
(() => {
  let x = 1;
  for (let i = 0; i < 255; i += 1) {
    GF_EXP[i] = x;
    GF_LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i += 1) GF_EXP[i] = GF_EXP[i - 255];
})();

const gfMul = (a, b) => (a === 0 || b === 0 ? 0 : GF_EXP[GF_LOG[a] + GF_LOG[b]]);
const gfDiv = (a, b) => (a === 0 ? 0 : GF_EXP[(GF_LOG[a] + 255 - GF_LOG[b]) % 255]);

function polyEval(poly, x) {
  let y = 0;
  for (const coefficient of poly) y = gfMul(y, x) ^ coefficient;
  return y;
}

const gfInverse = (a) => GF_EXP[255 - GF_LOG[a]];
const scalePoly = (poly, x) => poly.map((c) => gfMul(c, x));

/** Berlekamp-Massey: the polynomial whose roots point at the broken bytes. */
function errorLocator(syndromes, ecCount) {
  let locator = [1];
  let previous = [1];

  for (let i = 0; i < ecCount; i += 1) {
    previous = previous.concat([0]);
    let discrepancy = syndromes[i];
    for (let j = 1; j < locator.length; j += 1) {
      discrepancy ^= gfMul(locator[locator.length - 1 - j], syndromes[i - j]);
    }
    if (discrepancy !== 0) {
      if (previous.length > locator.length) {
        const next = scalePoly(previous, discrepancy);
        previous = scalePoly(locator, gfInverse(discrepancy));
        locator = next;
      }
      locator = addPoly(locator, scalePoly(previous, discrepancy));
    }
  }

  while (locator.length && locator[0] === 0) locator.shift();
  return locator;
}

/**
 * Chien search: which byte positions the locator points at.
 *
 * The reciprocal polynomial is what gets evaluated — its roots are the
 * inverses of the locator's, which is what puts them inside α^0…α^(n-1) where
 * a brute-force scan can find them at all.
 */
function errorPositions(locator, length) {
  const expected = locator.length - 1;
  const reciprocal = locator.slice().reverse();
  const positions = [];
  for (let i = 0; i < length; i += 1) {
    if (polyEval(reciprocal, GF_EXP[i]) === 0) positions.push(length - 1 - i);
  }
  return positions.length === expected ? positions : null;
}

/**
 * Correct a block in place. Returns false when the damage is beyond the code's
 * capacity — which must mean a retry on the next frame, never a partial answer.
 * A token that decodes to the wrong string is worse than one that fails.
 */
function correctBlock(block, ecCount) {
  const syndromes = new Array(ecCount);
  let bad = false;
  for (let i = 0; i < ecCount; i += 1) {
    syndromes[i] = polyEval(block, GF_EXP[i]);
    if (syndromes[i] !== 0) bad = true;
  }
  if (!bad) return true;

  const locator = errorLocator(syndromes, ecCount);
  const errorCount = locator.length - 1;
  if (errorCount === 0 || errorCount * 2 > ecCount) return false;

  const positions = errorPositions(locator, block.length);
  if (!positions) return false;

  // Forney. The magnitudes come from the evaluator polynomial over the errata
  // locator built from the positions we just found.
  const coefficients = positions.map((p) => block.length - 1 - p);
  let errata = [1];
  for (const c of coefficients) errata = multiplyPoly(errata, [GF_EXP[c % 255], 1]);

  const evaluator = multiplyPoly(syndromes.slice().reverse(), errata).slice(-(errorCount + 1));
  const roots = coefficients.map((c) => GF_EXP[c % 255]);

  for (let i = 0; i < roots.length; i += 1) {
    const inverse = gfInverse(roots[i]);
    // Denominator: the product form of the formal derivative, which avoids
    // getting the GF(2) derivative subtly wrong.
    let denominator = 1;
    for (let j = 0; j < roots.length; j += 1) {
      if (j !== i) denominator = gfMul(denominator, 1 ^ gfMul(inverse, roots[j]));
    }
    if (denominator === 0) return false;
    // No extra factor of the root here: the usual formulation carries a
    // syndrome polynomial that starts with a zero term, and this one does not.
    block[positions[i]] ^= gfDiv(polyEval(evaluator, inverse), denominator);
  }

  // Verify, because an over-damaged block can "correct" into nonsense.
  for (let i = 0; i < ecCount; i += 1) {
    if (polyEval(block, GF_EXP[i]) !== 0) return false;
  }
  return true;
}

function addPoly(a, b) {
  const out = new Array(Math.max(a.length, b.length)).fill(0);
  for (let i = 0; i < a.length; i += 1) out[out.length - a.length + i] = a[i];
  for (let i = 0; i < b.length; i += 1) out[out.length - b.length + i] ^= b[i];
  return out;
}

function multiplyPoly(a, b) {
  const out = new Array(a.length + b.length - 1).fill(0);
  for (let i = 0; i < a.length; i += 1) {
    for (let j = 0; j < b.length; j += 1) out[i + j] ^= gfMul(a[i], b[j]);
  }
  return out;
}

// ---- de-interleaving and the bitstream ------------------------------------------------

export function extractData(codewords, version, ecLevel) {
  const spec = EC_BLOCKS[ecLevel]?.[version];
  if (!spec) return null;
  const [ecPerBlock, blocks1, data1, blocks2, data2] = spec;

  const total = TOTAL_CODEWORDS[version];
  if (codewords.length < total) return null;

  const blocks = [];
  for (let i = 0; i < blocks1; i += 1) blocks.push({ data: new Array(data1), ec: new Array(ecPerBlock) });
  for (let i = 0; i < blocks2; i += 1) blocks.push({ data: new Array(data2), ec: new Array(ecPerBlock) });

  // Data codewords are interleaved across blocks, shorter blocks first.
  let index = 0;
  const longest = Math.max(data1, data2 || 0);
  for (let i = 0; i < longest; i += 1) {
    for (const block of blocks) {
      if (i < block.data.length) block.data[i] = codewords[index++];
    }
  }
  for (let i = 0; i < ecPerBlock; i += 1) {
    for (const block of blocks) block.ec[i] = codewords[index++];
  }

  const out = [];
  for (const block of blocks) {
    const full = block.data.concat(block.ec);
    if (!correctBlock(full, ecPerBlock)) return null;
    out.push(...full.slice(0, block.data.length));
  }
  return out;
}

const ALNUM = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ $%*+-./:';

export function readBitstream(bytes, version) {
  let bit = 0;
  const read = (n) => {
    let value = 0;
    for (let i = 0; i < n; i += 1) {
      const byte = bytes[bit >> 3];
      if (byte === undefined) return null;
      value = (value << 1) | ((byte >> (7 - (bit & 7))) & 1);
      bit += 1;
    }
    return value;
  };

  const out = [];
  for (;;) {
    const mode = read(4);
    if (mode === null || mode === 0) break; // terminator or out of data

    if (mode === 4) {
      const count = read(version < 10 ? 8 : 16);
      if (count === null) return null;
      for (let i = 0; i < count; i += 1) {
        const byte = read(8);
        if (byte === null) return null;
        out.push(byte);
      }
    } else if (mode === 1) {
      const count = read(version < 10 ? 10 : 12);
      if (count === null) return null;
      let left = count;
      while (left >= 3) {
        const trio = read(10);
        if (trio === null || trio > 999) return null;
        out.push(...String(trio).padStart(3, '0').split('').map((c) => c.charCodeAt(0)));
        left -= 3;
      }
      if (left === 2) {
        const pair = read(7);
        if (pair === null) return null;
        out.push(...String(pair).padStart(2, '0').split('').map((c) => c.charCodeAt(0)));
      } else if (left === 1) {
        const one = read(4);
        if (one === null) return null;
        out.push(String(one).charCodeAt(0));
      }
    } else if (mode === 2) {
      const count = read(version < 10 ? 9 : 11);
      if (count === null) return null;
      let left = count;
      while (left >= 2) {
        const pair = read(11);
        if (pair === null) return null;
        out.push(ALNUM.charCodeAt(Math.floor(pair / 45)), ALNUM.charCodeAt(pair % 45));
        left -= 2;
      }
      if (left === 1) {
        const one = read(6);
        if (one === null) return null;
        out.push(ALNUM.charCodeAt(one));
      }
    } else if (mode === 7) {
      // ECI: skip the assignment number and keep reading. We treat everything
      // as UTF-8 regardless, which is what our own codes are.
      const first = read(8);
      if (first === null) return null;
      if (first >= 0xc0) read(8);
      if (first >= 0xe0) read(8);
    } else {
      return null; // a mode we do not speak — better to fail than to invent text
    }
  }

  if (!out.length) return null;
  return new TextDecoder().decode(new Uint8Array(out));
}

// ---- the whole thing -------------------------------------------------------------------

/**
 * Decode a QR from one frame. Returns the text, or null — a null means "point
 * it a bit better", which is what the next frame is for.
 */
export function decodeQR(imageData) {
  const { data, width, height } = imageData;
  const bits = binarize(data, width, height);
  return decodeBits(bits, width, height);
}

/** Split out so tests can feed a bit grid without an image. */
export function decodeBits(bits, width, height) {
  const candidates = findFinders(bits, width, height);
  if (candidates.length < 3) return null;

  const layout = orderFinders(candidates);
  if (!layout) return null;

  // Try each plausible pitch and let error correction be the judge. A grid read
  // at the wrong pitch fails the format check or the Reed-Solomon pass; it does
  // not quietly produce a different token.
  for (const dimension of candidateDimensions(bits, width, height, layout)) {
    const grid = sampleGrid(bits, width, height, layout, dimension);
    if (!grid) continue;

    const format = readFormat(grid.matrix, grid.dimension);
    if (!format) continue;

    const codewords = readCodewords(grid.matrix, grid.dimension, grid.version, format.mask);
    const bytes = extractData(codewords, grid.version, format.ecLevel);
    if (!bytes) continue;

    const text = readBitstream(bytes, grid.version);
    if (text) return text;
  }
  return null;
}
