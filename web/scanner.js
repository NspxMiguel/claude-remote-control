/**
 * Reading the pairing QR with the phone that is doing the pairing.
 *
 * Two ways in, because the browser only offers the good one on a secure
 * origin: over `http://10.0.0.x` — how most people reach this app — the live
 * camera is simply not available, and a scanner that only knew how to open a
 * video stream would be a button that does nothing on the network everyone
 * starts on. A photo taken through a file input has no such restriction, and
 * on a phone that opens the same camera anyway.
 */
import { decodeQR } from './qr-decode.js';

/** Widest edge we decode at. Beyond this is detail no module needs. */
const MAX_EDGE = 1200;

export const liveCameraAvailable = () =>
  Boolean(window.isSecureContext && navigator.mediaDevices?.getUserMedia);

/** Why the live camera is not on offer, in words worth showing someone. */
export function liveCameraObstacle() {
  if (liveCameraAvailable()) return null;
  if (!window.isSecureContext) {
    return 'Live camera needs a secure connection, and this page is plain HTTP. Take a photo of the code instead — it works the same.';
  }
  return 'This browser will not open a camera here. Take a photo of the code instead.';
}

function canvasFor(width, height) {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  return canvas;
}

/** Draw whatever we have into a canvas at a sane size, ready to read. */
function frameFrom(source, sourceWidth, sourceHeight) {
  const scale = Math.min(1, MAX_EDGE / Math.max(sourceWidth, sourceHeight));
  const width = Math.max(1, Math.round(sourceWidth * scale));
  const height = Math.max(1, Math.round(sourceHeight * scale));
  const canvas = canvasFor(width, height);
  const context = canvas.getContext('2d', { willReadFrequently: true });
  context.drawImage(source, 0, 0, width, height);
  return { canvas, pixels: () => context.getImageData(0, 0, width, height) };
}

/**
 * Chromium has a decoder in the browser; WebKit does not, which is why
 * qr-decode.js exists. Use theirs when it is there — it handles angles this
 * one gives up on.
 *
 * It is given the source element directly rather than a bitmap built from
 * pixels: `createImageBitmap` hangs outright in at least one Chromium
 * embedding, and a scan loop that awaits it never comes back. One failure or
 * one slow answer and this stops offering itself for the rest of the session.
 */
let nativeDetector = 'unknown';

const NATIVE_BUDGET_MS = 1500;

async function nativeDetect(source) {
  if (nativeDetector === 'unusable') return null;
  if (nativeDetector === 'unknown') {
    if (!('BarcodeDetector' in window)) {
      nativeDetector = 'unusable';
      return null;
    }
    try {
      nativeDetector = new window.BarcodeDetector({ formats: ['qr_code'] });
    } catch {
      nativeDetector = 'unusable';
      return null;
    }
  }

  try {
    const codes = await Promise.race([
      nativeDetector.detect(source),
      new Promise((resolve) => setTimeout(() => resolve('timeout'), NATIVE_BUDGET_MS)),
    ]);
    if (codes === 'timeout') {
      nativeDetector = 'unusable';
      return null;
    }
    return codes?.[0]?.rawValue || null;
  } catch {
    nativeDetector = 'unusable';
    return null;
  }
}

/**
 * `source` is what the browser's own detector can read (a video, a canvas, an
 * image); `pixels` is a lazy fallback for ours, so a frame the native decoder
 * handles never pays for a getImageData.
 */
async function readFrame(source, pixels) {
  const native = await nativeDetect(source);
  if (native) return native;
  return decodeQR(pixels());
}

/** Decode a photo the user just took (or picked). */
export async function scanFromFile(file) {
  const url = URL.createObjectURL(file);
  try {
    const image = new Image();
    image.decoding = 'sync';
    await new Promise((resolve, reject) => {
      image.onload = resolve;
      image.onerror = () => reject(new Error('That file is not an image this browser can open.'));
      image.src = url;
    });

    const full = frameFrom(image, image.naturalWidth, image.naturalHeight);
    const found = await readFrame(full.canvas, full.pixels);
    if (found) return found;

    // A code that fills a small part of a big photo survives the downscale
    // badly. Try the middle again at full resolution before giving up, which
    // is where someone aiming at a code puts it.
    const side = Math.min(image.naturalWidth, image.naturalHeight);
    const cropSide = Math.round(side * 0.7);
    const canvas = canvasFor(cropSide, cropSide);
    const context = canvas.getContext('2d', { willReadFrequently: true });
    context.drawImage(
      image,
      Math.round((image.naturalWidth - cropSide) / 2),
      Math.round((image.naturalHeight - cropSide) / 2),
      cropSide,
      cropSide,
      0,
      0,
      cropSide,
      cropSide,
    );
    return readFrame(canvas, () => context.getImageData(0, 0, cropSide, cropSide));
  } finally {
    URL.revokeObjectURL(url);
  }
}

/**
 * Open the back camera into `video` and call `onResult` with the first code.
 * Returns a stop function; call it on every exit path, or the camera light
 * stays on after the sheet is closed.
 */
export async function startCamera(video, onResult, onError) {
  const stream = await navigator.mediaDevices.getUserMedia({
    video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 } },
    audio: false,
  });

  video.srcObject = stream;
  video.setAttribute('playsinline', ''); // iOS goes fullscreen without it
  video.muted = true;
  await video.play().catch(() => {});

  let stopped = false;
  let timer = null;

  const stop = () => {
    if (stopped) return;
    stopped = true;
    clearTimeout(timer);
    for (const track of stream.getTracks()) track.stop();
    video.srcObject = null;
  };

  const tick = async () => {
    if (stopped) return;
    try {
      if (video.videoWidth && video.videoHeight) {
        // The video element goes to the native detector; only our own decoder
        // pays for the canvas readback, and only when the native one passed.
        const frame = frameFrom(video, video.videoWidth, video.videoHeight);
        const found = await readFrame(video, frame.pixels);
        if (found) {
          stop();
          onResult(found);
          return;
        }
      }
    } catch (err) {
      stop();
      onError?.(err);
      return;
    }
    // Not every frame: decoding is the expensive part and a phone that gets
    // hot lowers its camera frame rate anyway.
    timer = setTimeout(tick, 120);
  };

  tick();
  return stop;
}

/**
 * What a scanned string means to this app.
 *
 * The QR the daemon prints is a link with the token in its fragment; the code
 * someone reads off the Mac is six digits. Anything else is not ours.
 */
export function interpretScan(text) {
  const value = String(text || '').trim();
  if (/^\d{6}$/.test(value)) return { kind: 'code', code: value };

  try {
    const url = new URL(value);
    const token = new URLSearchParams(url.hash.slice(1)).get('token');
    if (token) return { kind: 'token', token, origin: url.origin };
  } catch {
    /* not a URL */
  }

  // A bare token, in case someone shows one as a code.
  if (/^[A-Za-z0-9_-]{32,}$/.test(value)) return { kind: 'token', token: value, origin: null };
  return { kind: 'unknown', value };
}
