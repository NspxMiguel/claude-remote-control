/* Claude Remote Control — PWA client. No framework, no build step. */

import { el, $ } from './dom.js';
import { applyStaticText, LANGUAGES, languageChoice, setLanguage, t } from './i18n.js';
import { icon } from './icons.js';
import { renderMarkdown } from './markdown.js';
import {
  carryOverOpenState,
  ensureGroupNode,
  insertByOrder,
  refreshGroup,
  renderItem,
} from './feed-view.js';

const TOKEN_KEY = 'crc.token';
const LAST_SESSION_KEY = 'crc.lastSession';
/** Every address this Mac answered on, learned while connected. */
const ADDRESSES_KEY = 'crc.addresses';
const INSTALL_PROMPTED_KEY = 'crc.installPrompted';
const NARRATE_KEY = 'crc.narrate';

const state = {
  token: localStorage.getItem(TOKEN_KEY),
  ws: null,
  reconnectDelay: 500,
  sessions: new Map(),
  mirrors: [],
  currentId: null,
  /** sessionId -> { lastSeq, nodes: Map<itemId, HTMLElement>, pinned: boolean } */
  views: new Map(),
  permQueue: [],
  serverState: null,
  /** Images staged for the next message: { mediaType, data, url, name }. */
  pending: [],
  /** The last message sent, kept until the daemon accepts it. */
  lastDraft: null,
  /** Read every finished reply aloud, for when the phone is not in your hand. */
  narrate: localStorage.getItem(NARRATE_KEY) === '1',
};

/** Anthropic recommends no side longer than this; bigger just wastes bandwidth. */
const MAX_IMAGE_EDGE = 1568;
/** Small enough to live in the transcript, big enough to recognise. */
const THUMBNAIL_EDGE = 240;
const MAX_ATTACHMENTS = 4;

// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------

async function api(path, opts = {}) {
  const res = await fetch(path, {
    ...opts,
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${state.token}`,
      ...(opts.headers || {}),
    },
  });
  if (res.status === 401) {
    unpair(true);
    throw new Error('Device is no longer paired');
  }
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `Request failed (${res.status})`);
  return body;
}

function send(message) {
  if (state.ws?.readyState === WebSocket.OPEN) {
    state.ws.send(JSON.stringify(message));
    return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Pairing
// ---------------------------------------------------------------------------

async function pair(secret, name) {
  const isCode = /^\d{6}$/.test(secret.trim());
  const body = isCode ? { code: secret.trim() } : { token: secret.trim() };
  body.name = name || defaultDeviceName();

  const res = await fetch('/api/pair', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Pairing failed');

  state.token = data.token;
  localStorage.setItem(TOKEN_KEY, data.token);
  // Remember which Mac this token belongs to, so a second one can be added
  // without losing the first.
  rememberMachine({ origin: currentOrigin(), token: data.token, name: data.hostname });
  return data;
}

function defaultDeviceName() {
  const ua = navigator.userAgent;
  if (/iPhone/.test(ua)) return 'iPhone';
  if (/iPad/.test(ua)) return 'iPad';
  if (/Android/.test(ua)) return 'Android phone';
  if (/Mac OS X/.test(ua)) return 'Mac';
  if (/Windows/.test(ua)) return 'Windows PC';
  return 'Browser';
}

/**
 * Every way back to the pairing screen goes through here — being unpaired,
 * revoked from another device, or simply arriving without a token. The scanner
 * has to be told which of its two routes this browser allows, and forgetting
 * that on one of the paths leaves a button with no explanation under it.
 */
function showGate() {
  $('#app').hidden = true;
  $('#gate').hidden = false;
  prepareScanner();
}

function unpair(silent) {
  localStorage.removeItem(TOKEN_KEY);
  state.token = null;
  state.ws?.close();
  showGate();
  if (!silent) toast('Device unpaired');
}

// ---------------------------------------------------------------------------
// Knowing where else this Mac lives
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// More than one Mac
// ---------------------------------------------------------------------------

const MACHINES_KEY = 'crc.machines';

/**
 * Every Mac this phone has been paired with.
 *
 * One is the normal case and goes straight in, exactly as before. The moment
 * there is a second, the app has to ask which one you meant — a token belongs
 * to one machine, and silently using the wrong one looks like the app is
 * broken rather than pointed elsewhere.
 */
function knownMachines() {
  try {
    const stored = JSON.parse(localStorage.getItem(MACHINES_KEY) || '[]');
    return Array.isArray(stored) ? stored : [];
  } catch {
    return [];
  }
}

function rememberMachine({ origin, token, name }) {
  const machines = knownMachines().filter((m) => m.origin !== origin);
  machines.unshift({ origin, token, name: name || origin, pairedAt: Date.now() });
  try {
    localStorage.setItem(MACHINES_KEY, JSON.stringify(machines.slice(0, 8)));
  } catch {
    /* private mode — pairing still works, it just is not remembered */
  }
}

/**
 * Move to another Mac, carrying the whole list with you.
 *
 * Browser storage is per-origin, so each machine would otherwise remember only
 * itself and the picker could never show two. The list rides in the fragment —
 * which never leaves the device, the same place the pairing token already
 * travels — and the destination merges it.
 */
function switchToMachine(machine) {
  const luggage = btoa(unescape(encodeURIComponent(JSON.stringify(knownMachines()))));
  location.href = `${machine.origin}/#token=${encodeURIComponent(machine.token)}&machines=${encodeURIComponent(luggage)}`;
}

/** Merge a list handed over by another origin. Local entries win on conflict. */
function mergeMachines(encoded) {
  if (!encoded) return;
  try {
    const incoming = JSON.parse(decodeURIComponent(escape(atob(encoded))));
    if (!Array.isArray(incoming)) return;
    const mine = knownMachines();
    const merged = [...mine];
    for (const machine of incoming) {
      if (!machine?.origin || !machine?.token) continue;
      if (merged.some((m) => m.origin === machine.origin)) continue;
      merged.push(machine);
    }
    localStorage.setItem(MACHINES_KEY, JSON.stringify(merged.slice(0, 8)));
  } catch {
    /* a mangled fragment is not worth failing a boot over */
  }
}

function forgetMachine(origin) {
  const machines = knownMachines().filter((m) => m.origin !== origin);
  localStorage.setItem(MACHINES_KEY, JSON.stringify(machines));
}

/** The Mac this tab is talking to. */
const currentOrigin = () => `${location.protocol}//${location.host}`;

/**
 * The addresses the daemon last reported, kept on the device.
 *
 * A phone that walks out of Wi-Fi range, or that has Tailscale switched off,
 * asks for an address that no longer resolves — and a page that never loads
 * cannot tell you why. The service worker still serves the shell from cache,
 * so the app opens; these are what it can offer instead of a spinner.
 */
function rememberAddresses(urls) {
  if (!Array.isArray(urls) || !urls.length) return;
  try {
    const worth = urls
      .filter((u) => u.kind !== 'local')
      .map((u) => ({ url: u.url, label: u.label, kind: u.kind }));
    if (worth.length) localStorage.setItem(ADDRESSES_KEY, JSON.stringify(worth));
  } catch {
    /* private mode, or a full quota — the app works, it just cannot suggest */
  }
}

function knownAddresses() {
  try {
    const stored = JSON.parse(localStorage.getItem(ADDRESSES_KEY) || '[]');
    return Array.isArray(stored) ? stored : [];
  } catch {
    return [];
  }
}

/** Is the daemon answering here, right now? */
async function daemonReachable(timeoutMs = 4000) {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), timeoutMs);
  try {
    const res = await fetch('/api/health', { signal: abort.signal, cache: 'no-store' });
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Offer the other addresses, carrying the token so the new origin is paired on
 * arrival — a device token belongs to the origin that stored it, and without
 * this you would land on the pairing screen with nothing to type.
 */
function showUnreachable(detail) {
  const sheet = $('#offline-sheet');
  $('#offline-detail').textContent =
    detail || 'This address is not answering. That usually means the Mac is asleep, or this phone is on a different network than it was.';

  const list = $('#offline-addresses');
  list.innerHTML = '';
  const here = `${location.protocol}//${location.host}`;
  const others = knownAddresses().filter((a) => !a.url.startsWith(here));

  if (others.length) {
    list.appendChild(el('label', null, 'Try another address'));
    for (const address of others) {
      const row = el('button', 'address-choice');
      row.type = 'button';
      row.appendChild(el('span', 'address-url', address.url));
      row.appendChild(el('span', 'address-label', address.label || address.kind));
      row.addEventListener('click', () => {
        // The fragment is consumed and wiped by the pairing flow on arrival.
        location.href = state.token ? `${address.url}/#token=${encodeURIComponent(state.token)}` : address.url;
      });
      list.appendChild(row);
    }
    if (others.some((a) => a.kind === 'tailscale')) {
      list.appendChild(
        el('p', 'small muted', 'The 100.x address and the machine name both need Tailscale switched on here.'),
      );
    }
  } else {
    list.appendChild(
      el('p', 'small muted', 'No other address is known yet — connect once on your home network and this list fills itself in.'),
    );
  }

  sheet.hidden = false;
}

// ---------------------------------------------------------------------------
// Add to home screen
// ---------------------------------------------------------------------------

const isStandalone = () =>
  window.matchMedia?.('(display-mode: standalone)').matches || window.navigator.standalone === true;

/** Chromium fires this ahead of time; WebKit never does. */
let deferredInstall = null;
window.addEventListener('beforeinstallprompt', (event) => {
  event.preventDefault();
  deferredInstall = event;
});

function installSteps() {
  const ua = navigator.userAgent;
  // An iPad in its default desktop mode calls itself a Macintosh; the only
  // tell is that Macs do not have touch. Without this the iPad was handed
  // "open the browser menu", which is not where Add to Home Screen lives.
  const iPadAsDesktop = /Macintosh/.test(ua) && navigator.maxTouchPoints > 1;
  if (/iPhone|iPad|iPod/.test(ua) || iPadAsDesktop) {
    return [
      'Tap the Share button at the bottom of the screen.',
      'Scroll down and choose "Add to Home Screen".',
      'Tap Add. It appears with the other apps.',
    ];
  }
  if (/Android/.test(ua)) {
    return ['Open the browser menu (⋮).', 'Choose "Install app" or "Add to Home screen".', 'Confirm.'];
  }
  return ['Open the browser menu.', 'Choose "Install" or "Add to Home screen".'];
}

// ---------------------------------------------------------------------------
// Scanning the pairing code
// ---------------------------------------------------------------------------

/** Loaded on demand: a decoder nobody needs until they press Scan. */
let scannerModule = null;
const loadScanner = async () => (scannerModule ||= await import('./scanner.js'));

let stopCamera = null;

/** Say up front which of the two ways in this browser is going to give us. */
async function prepareScanner() {
  const scanner = await loadScanner();
  const obstacle = scanner.liveCameraObstacle();
  $('#scan-note').textContent =
    obstacle || t('gate.scanNote', 'Opens the camera. Hold it over the code on your Mac.');
  $('#scan-open').textContent = obstacle
    ? t('gate.photo', 'Take a photo of the code')
    : t('gate.scan', 'Scan the QR code');
}

async function handleScan(text) {
  const scanner = await loadScanner();
  const result = scanner.interpretScan(text);

  if (result.kind === 'unknown') {
    toast('That is not a pairing code from this app.');
    return false;
  }

  // A link scanned from another machine's screen points at that machine. Going
  // there is the whole point of scanning it.
  if (result.kind === 'token' && result.origin && result.origin !== location.origin) {
    location.href = `${result.origin}/#token=${encodeURIComponent(result.token)}`;
    return true;
  }

  try {
    await pair(result.kind === 'code' ? result.code : result.token, $('#pair-name').value);
    await enterApp({ paired: true });
    return true;
  } catch (err) {
    const errorNode = $('#pair-error');
    errorNode.textContent = err.message;
    errorNode.hidden = false;
    return false;
  }
}

/** Gate → app, with the one-time install nudge. */
async function enterApp({ paired = true } = {}) {
  $('#gate').hidden = true;
  $('#scan-sheet').hidden = true;
  $('#app').hidden = false;
  await boot();
  if (paired) offerInstall();
}

/** Close the scanner and release the camera. Every dismissal must go here. */
function closeScanner() {
  stopCamera?.();
  stopCamera = null;
  $('#scan-sheet').hidden = true;
}

function wireScanner() {
  $('#scan-close').addEventListener('click', closeScanner);

  $('#scan-open').addEventListener('click', async () => {
    const scanner = await loadScanner();

    // No live camera on this origin: a photo goes through the same decoder,
    // and on a phone the file picker opens the camera anyway.
    if (!scanner.liveCameraAvailable()) {
      $('#scan-file').click();
      return;
    }

    $('#scan-sheet').hidden = false;
    $('#scan-status').textContent = 'Hold the code square on, filling the frame.';
    try {
      stopCamera = await scanner.startCamera(
        $('#scan-video'),
        async (text) => {
          $('#scan-status').textContent = 'Got it.';
          if (!(await handleScan(text))) {
            closeScanner();
          }
        },
        (err) => {
          $('#scan-status').textContent = err?.message || 'The camera stopped.';
        },
      );
    } catch (err) {
      closeScanner();
      // Permission refused, or no camera at all — the photo route still works.
      $('#scan-note').textContent =
        err?.name === 'NotAllowedError'
          ? 'Camera access was refused. Take a photo of the code instead.'
          : 'No camera here. Take a photo of the code instead.';
      $('#scan-open').textContent = 'Take a photo of the code';
      $('#scan-file').click();
    }
  });

  $('#scan-file').addEventListener('change', async (event) => {
    const file = event.target.files?.[0];
    event.target.value = ''; // so picking the same photo twice still fires
    if (!file) return;

    $('#scan-note').textContent = 'Reading the code…';
    try {
      const scanner = await loadScanner();
      const text = await scanner.scanFromFile(file);
      if (!text) {
        $('#scan-note').textContent =
          'No code found in that photo. Get closer, fill the frame, and keep the phone square on.';
        return;
      }
      if (!(await handleScan(text))) $('#scan-note').textContent = 'Try again, or type the code below.';
    } catch (err) {
      $('#scan-note').textContent = err.message;
    }
  });
}

/**
 * Offered once, right after pairing — the moment someone has just proved they
 * want this on their phone. Never again after that, and never when it is
 * already installed.
 */
function offerInstall() {
  if (isStandalone() || localStorage.getItem(INSTALL_PROMPTED_KEY)) return;
  localStorage.setItem(INSTALL_PROMPTED_KEY, '1');

  const steps = $('#install-steps');
  steps.innerHTML = '';

  if (deferredInstall) {
    // A browser that can do it for us needs no instructions.
    steps.appendChild(el('li', null, 'One tap and it is on your home screen.'));
    $('#install-now').hidden = false;
  } else {
    for (const step of installSteps()) steps.appendChild(el('li', null, step));
    $('#install-now').hidden = true;
  }

  $('#install-sheet').hidden = false;
}

// ---------------------------------------------------------------------------
// WebSocket
// ---------------------------------------------------------------------------

function connect() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const ws = new WebSocket(`${proto}://${location.host}/ws?token=${encodeURIComponent(state.token)}`);
  state.ws = ws;
  setConn('connecting');

  ws.onopen = () => {
    state.reconnectDelay = 500;
    setConn('online');
    // Resume exactly where this device left off, without refetching everything.
    if (state.currentId) {
      const view = state.views.get(state.currentId);
      send({ t: 'subscribe', sessionId: state.currentId, since: view?.lastSeq || 0 });
    }
    refreshSessions();
  };

  ws.onclose = () => {
    setConn('offline');
    state.reconnectDelay = Math.min(state.reconnectDelay * 1.8, 15000);
    setTimeout(connect, state.reconnectDelay);
  };

  ws.onerror = () => ws.close();

  ws.onmessage = (event) => {
    let msg;
    try {
      msg = JSON.parse(event.data);
    } catch {
      return;
    }
    handleServerMessage(msg);
  };
}

function handleServerMessage(msg) {
  switch (msg.t) {
    case 'hello':
      for (const s of msg.sessions) state.sessions.set(s.id, s);
      renderSessionList();
      noticeIfSessionVanished();
      // A prompt raised while this phone was asleep only ever arrived as a
      // live broadcast, so reconnecting left the agent blocked on a question
      // nothing on screen was asking. Pick them up from the session state.
      rehydratePermissions(msg.sessions);
      break;

    case 'sessions': {
      // This list covers driven sessions only; open mirrors must survive it.
      const mirrorsOpen = [...state.sessions.values()].filter((s) => s.kind === 'mirror');
      state.sessions = new Map(msg.sessions.map((s) => [s.id, s]));
      for (const mirror of mirrorsOpen) state.sessions.set(mirror.id, mirror);
      renderSessionList();
      noticeIfSessionVanished();
      break;
    }

    case 'session':
      state.sessions.set(msg.session.id, msg.session);
      renderSessionList();
      if (msg.session.id === state.currentId) renderHeader();
      break;

    case 'feed':
      if (msg.sessionId !== state.currentId) break;
      if (msg.state) state.sessions.set(msg.state.id, msg.state);
      applyItems(msg.sessionId, msg.items);
      renderHeader();
      break;

    case 'patch':
      if (msg.sessionId !== state.currentId) break;
      applyItems(msg.sessionId, [msg.item]);
      break;

    case 'permission':
      queuePermission(msg.payload);
      break;

    case 'permissionResolved':
      state.permQueue = state.permQueue.filter((p) => p.requestId !== msg.requestId);
      if ($('#perm-sheet').dataset.requestId === msg.requestId) showNextPermission();
      break;

    case 'error':
      // The daemon refused the message the socket had already carried; give
      // the typing and the attachments back rather than losing them.
      restoreDraft();
      toast(msg.message);
      break;
  }
}

/**
 * The daemon holds sessions in memory, so a restart ends them. Say so plainly
 * instead of letting the next message fail with a bare error.
 */
function noticeIfSessionVanished() {
  if (!state.currentId || state.sessions.has(state.currentId)) return;
  const view = state.views.get(state.currentId);
  if (!view || view.lostNoticed) return;
  view.lostNoticed = true;

  const notice = el(
    'div',
    'item note error',
    'This session is no longer running — the daemon restarted or it was closed elsewhere. ' +
      'The conversation is saved: find it under “On this machine” to pick it back up.',
  );
  $('#feed').appendChild(notice);
  setComposerEnabled(false, 'Session ended');
  $('#send').hidden = false;
  $('#stop').hidden = true;
  scrollToBottom();
}

function setConn(status) {
  const node = $('#conn-state');
  node.className = `conn ${status}`;
  node.lastChild.textContent = ` ${status}`;

  // That indicator lives in the drawer footer, which is off-canvas on a phone —
  // so a dead socket looked exactly like a quiet one until you pressed Send.
  // This says so where you are, and offers the retry the backoff would
  // eventually make on its own.
  const banner = $('#conn-banner');
  const down = status !== 'online';
  banner.hidden = !down;
  banner.className = `conn-banner ${status}`;
  if (down) {
    banner.textContent =
      status === 'connecting'
        ? t('conn.connecting', 'Reconnecting…')
        : t('conn.offline', 'Not connected. Tap to try again.');
  }
}

// ---------------------------------------------------------------------------
// Feed rendering
function viewFor(sessionId) {
  let view = state.views.get(sessionId);
  if (!view) {
    view = {
      lastSeq: 0,
      nodes: new Map(),
      groups: new Map(),
      pinned: true,
      /** Item ids already read aloud, so a re-render does not repeat them. */
      spoken: new Set(),
      /** False until the first batch has landed — see applyItems. */
      primed: false,
    };
    state.views.set(sessionId, view);
  }
  return view;
}

function applyItems(sessionId, items) {
  const view = viewFor(sessionId);
  const feed = $('#feed');
  const wasAtBottom = isAtBottom();

  const touchedGroups = new Set();

  for (const item of items) {
    if (item.seq > view.lastSeq) view.lastSeq = item.seq;

    // Prose that has stopped streaming is a finished thought, which is the
    // only thing worth reading aloud — and only for the session on screen,
    // and only if it arrived after we caught up. Without `primed`, opening a
    // session or reconnecting would recite the entire history at you.
    if (
      view.primed &&
      item.kind === 'text' &&
      !item.streaming &&
      sessionId === state.currentId &&
      !view.spoken.has(item.id)
    ) {
      view.spoken.add(item.id);
      maybeAutoNarrate(item.text);
    }

    // A run of tool calls renders as one collapsible row containing the cards,
    // so the transcript reads as narration instead of a wall of tool output.
    const group = item.kind === 'tool' && item.group
      ? ensureGroupNode(view.groups, feed, item, insertByOrder)
      : null;
    const container = group ? group.list : feed;
    if (group) {
      group.tools.set(item.id, item);
      touchedGroups.add(group);
    }

    const existing = view.nodes.get(item.id);
    if (existing) {
      const replacement = renderItem(item);
      if (!replacement) {
        existing.remove();
        view.nodes.delete(item.id);
        continue;
      }
      replacement.dataset.ord = item.ord;
      carryOverOpenState(existing, replacement);
      existing.replaceWith(replacement);
      view.nodes.set(item.id, replacement);
      continue;
    }

    const node = renderItem(item);
    if (!node) continue;
    node.dataset.ord = item.ord;
    insertByOrder(container, node, item.ord);
    view.nodes.set(item.id, node);
  }

  for (const group of touchedGroups) refreshGroup(group);

  // Everything from here on is live, and may be spoken.
  view.primed = true;
  for (const item of items) if (item.kind === 'text') view.spoken.add(item.id);

  $('#empty-state').hidden = view.nodes.size > 0;
  renderSuggestions();
  if (wasAtBottom || view.pinned) scrollToBottom();
  else $('#scroll-pin').hidden = false;
}

// ---------------------------------------------------------------------------
// Something to say
// ---------------------------------------------------------------------------

/**
 * Openers for a session with nothing in it yet.
 *
 * A blank box is the worst thing to hand someone standing at a bus stop. These
 * are the things you actually ask an agent from a phone — orient me, check
 * something, pick up where I left off — and they disappear the moment the
 * conversation has anything in it.
 */
const OPENERS = [
  { key: 'openers.tour', label: 'What is this project?', text: 'Give me a short tour of this project: what it is, how it is laid out, and how to run it.' },
  { key: 'openers.recent', label: 'What changed recently?', text: 'Summarise the recent git history and what state the working tree is in.' },
  { key: 'openers.broken', label: 'Anything broken?', text: 'Run the test suite and tell me briefly whether anything fails.' },
  { key: 'openers.next', label: 'What should I do next?', text: 'Look for TODOs, failing tests and obvious loose ends, then suggest what to pick up next.' },
];

function renderSuggestions() {
  const container = $('#suggestions');
  const session = currentSession();
  // "Nothing yet" means nothing anyone said — a freshly started session already
  // has a "Connected to…" line, and hiding the openers behind that would mean
  // they are only ever visible for the half second before the agent starts.
  const spoken = $('#feed').querySelector('.bubble-user, .item.assistant, .tool-group');
  const empty = Boolean(session) && !session.readOnly && !spoken;

  container.hidden = !empty;
  if (!empty || container.dataset.filled === session.id) return;

  container.innerHTML = '';
  container.dataset.filled = session.id;
  for (const opener of OPENERS) {
    const chip = el('button', 'suggestion', t(opener.key, opener.label));
    chip.type = 'button';
    chip.addEventListener('click', () => {
      const input = $('#input');
      input.value = opener.text;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.focus();
    });
    container.appendChild(chip);
  }
}
// ---------------------------------------------------------------------------
// Image attachments
// ---------------------------------------------------------------------------

/**
 * Shrink a photo in the browser before it ever crosses the network. A modern
 * phone camera produces 4-12 MB files; downscaling to Anthropic's recommended
 * edge length gets that to a couple hundred KB with no loss of usable detail.
 */
function shrinkImage(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();

    img.onload = () => {
      URL.revokeObjectURL(url);
      const scale = Math.min(1, MAX_IMAGE_EDGE / Math.max(img.width, img.height));
      const width = Math.max(1, Math.round(img.width * scale));
      const height = Math.max(1, Math.round(img.height * scale));

      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0, width, height);

      // PNG keeps screenshots of text crisp; photos are far smaller as JPEG.
      const asPng = file.type === 'image/png' && width * height <= 1200 * 1200;
      const mediaType = asPng ? 'image/png' : 'image/jpeg';
      const dataUrl = canvas.toDataURL(mediaType, 0.82);

      // A separate thumbnail goes into the transcript so the sent image is
      // still visible later. The full-size base64 never does: the feed is
      // replayed in full on every reconnect.
      const thumbScale = Math.min(1, THUMBNAIL_EDGE / Math.max(width, height));
      const thumb = document.createElement('canvas');
      thumb.width = Math.max(1, Math.round(width * thumbScale));
      thumb.height = Math.max(1, Math.round(height * thumbScale));
      thumb.getContext('2d').drawImage(canvas, 0, 0, thumb.width, thumb.height);

      resolve({
        mediaType,
        data: dataUrl.slice(dataUrl.indexOf(',') + 1),
        url: dataUrl,
        thumbnail: thumb.toDataURL('image/jpeg', 0.55),
        name: file.name || 'image',
      });
    };

    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error(`Could not read ${file.name || 'that image'}`));
    };
    img.src = url;
  });
}

async function addAttachments(files) {
  const room = MAX_ATTACHMENTS - state.pending.length;
  if (room <= 0) {
    toast(`Up to ${MAX_ATTACHMENTS} images per message`);
    return;
  }

  for (const file of [...files].slice(0, room)) {
    if (!file.type.startsWith('image/')) {
      toast('Only images can be attached');
      continue;
    }
    try {
      state.pending.push(await shrinkImage(file));
    } catch (err) {
      toast(err.message);
    }
  }
  renderAttachments();
}

function renderAttachments() {
  const bar = $('#attachments');
  bar.innerHTML = '';
  bar.hidden = state.pending.length === 0;

  state.pending.forEach((image, index) => {
    const chip = el('div', 'attachment');
    const thumb = document.createElement('img');
    thumb.src = image.url;
    thumb.alt = image.name;
    chip.appendChild(thumb);

    const remove = el('button', 'attachment-remove');
    remove.appendChild(icon('close', { size: 12 }));
    remove.type = 'button';
    remove.setAttribute('aria-label', `Remove ${image.name}`);
    remove.addEventListener('click', () => {
      state.pending.splice(index, 1);
      renderAttachments();
    });
    chip.appendChild(remove);
    bar.appendChild(chip);
  });
}

// ---------------------------------------------------------------------------
// Scrolling
// ---------------------------------------------------------------------------

function isAtBottom() {
  const feed = $('#feed');
  return feed.scrollHeight - feed.scrollTop - feed.clientHeight < 90;
}

function scrollToBottom() {
  const feed = $('#feed');
  feed.scrollTop = feed.scrollHeight;
  $('#scroll-pin').hidden = true;
  const view = state.views.get(state.currentId);
  if (view) view.pinned = true;
}

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

async function refreshSessions() {
  try {
    const [{ sessions }, { transcripts }] = await Promise.all([
      api('/api/sessions'),
      api('/api/transcripts?limit=40'),
    ]);
    // Keep open mirrors, which the sessions endpoint does not report.
    const mirrorsOpen = [...state.sessions.values()].filter((s) => s.kind === 'mirror');
    state.sessions = new Map(sessions.map((s) => [s.id, s]));
    for (const mirror of mirrorsOpen) state.sessions.set(mirror.id, mirror);
    state.mirrors = transcripts;
    renderSessionList();
    noticeIfSessionVanished();
  } catch (err) {
    console.warn(err);
  }
}

/**
 * The Macs this phone knows, when there is more than one.
 *
 * With a single machine nothing is shown — the app goes straight in, which is
 * the whole point. A second one turns the list on, because a token is bound to
 * one machine and landing on the wrong one looks like a broken app.
 */
function renderMachines() {
  const container = $('#machines');
  const machines = knownMachines();
  const here = currentOrigin();

  container.innerHTML = '';
  container.hidden = machines.length < 2;
  if (machines.length < 2) return;

  container.appendChild(el('h2', null, t('app.machines', 'Machines')));
  for (const machine of machines) {
    const isHere = machine.origin === here;
    const row = el('button', `machine-row${isHere ? ' active' : ''}`);
    row.type = 'button';
    row.appendChild(el('i', `dot ${isHere ? 'idle' : ''}`));
    const text = el('div', 'machine-text');
    text.appendChild(el('strong', null, machine.name || machine.origin));
    text.appendChild(el('span', null, machine.origin.replace(/^https?:\/\//, '')));
    row.appendChild(text);
    if (!isHere) {
      row.addEventListener('click', () => switchToMachine(machine));
    }
    container.appendChild(row);
  }

  const add = el('button', 'ghost-btn wide', t('app.addMachine', 'Add another Mac'));
  add.type = 'button';
  add.addEventListener('click', () => {
    closeDrawer();
    toast(t('toast.addMachine', 'Scan the QR code shown on the other Mac.'));
    $('#scan-open').click();
  });
  container.appendChild(add);
}

function renderSessionList() {
  renderMachines();
  // Sessions this app drives, versus transcripts it only watches.
  const live = [...state.sessions.values()]
    .filter((s) => s.kind !== 'mirror')
    .sort((a, b) => b.lastActivityAt - a.lastActivityAt);

  const liveList = $('#live-list');
  liveList.innerHTML = '';
  $('#live-count').textContent = live.length;
  $('#live-empty').hidden = live.length > 0;
  for (const session of live) liveList.appendChild(sessionRow(session, false));

  const mirrorList = $('#mirror-list');
  mirrorList.innerHTML = '';
  for (const transcript of state.mirrors) {
    // Prefer the open mirror's live state when we have it.
    const opened = state.sessions.get(transcript.id);
    mirrorList.appendChild(sessionRow({ ...transcript, ...(opened || {}) }, true));
  }
}

function sessionRow(session, isMirror) {
  const li = el('li', `session-item${session.id === state.currentId ? ' active' : ''}`);

  const row = el('div', 'row');
  const status = isMirror ? 'mirrored' : session.status;
  row.appendChild(el('i', `dot ${status}`));
  row.appendChild(el('span', 'name', session.title || session.cwd || 'Session'));
  if (isMirror && session.entrypoint) {
    row.appendChild(el('span', 'origin-tag', session.entrypoint === 'claude-desktop' ? 'desktop' : 'cli'));
  }
  if (session.pendingPermissions?.length) {
    row.appendChild(el('span', 'origin-tag', 'needs you'));
  }
  li.appendChild(row);

  const meta = [];
  if (session.cwd) meta.push(session.cwd.split('/').slice(-2).join('/'));
  if (!isMirror && session.model) meta.push(session.model.replace(/^claude-/, ''));
  if (session.lastActivityAt) meta.push(relativeTime(session.lastActivityAt));
  li.appendChild(el('div', 'meta', meta.join(' · ')));

  li.addEventListener('click', () => openSession(session.id, isMirror));
  return li;
}

function relativeTime(ts) {
  const diff = Date.now() - ts;
  if (diff < 60_000) return 'just now';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return `${Math.floor(diff / 86_400_000)}d ago`;
}

async function openSession(sessionId, isMirror) {
  if (isMirror && !state.sessions.has(sessionId)) {
    try {
      const { session } = await api(`/api/transcripts/${sessionId}/mirror`, { method: 'POST' });
      state.sessions.set(session.id, session);
    } catch (err) {
      toast(err.message);
      return;
    }
  }

  // Stop following the previous session so the daemon can release its mirror.
  if (state.currentId && state.currentId !== sessionId) {
    send({ t: 'unsubscribe', sessionId: state.currentId });
  }

  state.currentId = sessionId;
  localStorage.setItem(LAST_SESSION_KEY, sessionId);
  state.views.delete(sessionId);

  const feed = $('#feed');
  for (const child of [...feed.children]) {
    if (child.id !== 'empty-state') child.remove();
  }
  $('#empty-state').hidden = true;

  closeDrawer();
  renderSessionList();
  renderHeader();

  send({ t: 'subscribe', sessionId, since: 0 });
  try {
    const data = await api(`/api/sessions/${sessionId}/feed?since=0`);
    if (data.state) state.sessions.set(data.state.id, data.state);
    applyItems(sessionId, data.items);
    renderHeader();
    scrollToBottom();
  } catch (err) {
    toast(err.message);
  }
}

function currentSession() {
  return state.currentId ? state.sessions.get(state.currentId) : null;
}

function renderHeader() {
  const session = currentSession();
  if (!session) {
    $('#app').dataset.agent = '';
    $('#session-title').textContent = t('app.noSession', 'No session');
    $('#session-sub').textContent = '';
    $('#composer-meta').innerHTML = '';
    setComposerEnabled(false, t('app.composer.start', 'Start a session to begin'));
    return;
  }

  // Recolour the whole app for the agent in this session.
  $('#app').dataset.agent = session.agent || (session.kind === 'mirror' ? 'claude-code' : '');
  $('#session-title').textContent = session.title || 'Session';
  const bits = [];
  // The folder name, not the path to it: this is a pill under the title on a
  // phone, and the full path is one tap away in the session sheet.
  if (session.cwd) bits.push(session.cwd.replace(/\/+$/, '').split('/').pop() || session.cwd);
  // Only name the agent when it is not the default, to keep the line short.
  if (session.agent && session.agent !== 'claude-code') bits.push(session.agentLabel || session.agent);
  if (session.model) bits.push(session.model.replace(/^claude-/, ''));
  if (session.readOnly) bits.push(t('app.composer.readOnly', 'read-only mirror'));
  $('#session-sub').textContent = bits.join(' · ');

  const busy = session.status === 'busy';
  $('#send').hidden = busy;
  $('#stop').hidden = !busy;

  // A whole sentence does not fit in the composer's chip: it clipped off the
  // right edge and pushed the row an extra line tall. Long-form goes above.
  const notice = $('#composer-notice');
  notice.hidden = !session.readOnly;
  if (session.readOnly) {
    notice.textContent = t(
      'app.mirrorNotice',
      'Mirroring a session running elsewhere. Open “Take over” to continue it here.',
    );
  }

  const meta = $('#composer-meta');
  meta.innerHTML = '';
  if (session.readOnly) {
    // the notice above says it
  } else if (busy) {
    meta.appendChild(el('span', 'spinner'));
    meta.appendChild(el('span', null, t('app.working', '{agent} is working…', { agent: session.agentLabel || 'Claude' })));
  } else if (typeof session.totalCostUsd === 'number' && session.totalCostUsd > 0) {
    meta.appendChild(el('span', null, `$${session.totalCostUsd.toFixed(4)} this session`));
  }

  setComposerEnabled(!session.readOnly, undefined, session.agentLabel);
  updateTabTitle();
}

/** Surface state in the tab title so a backgrounded desktop window still tells you. */
function updateTabTitle() {
  const pending = state.permQueue.length;
  const session = currentSession();
  const name = session?.title ? ` — ${session.title.slice(0, 40)}` : '';

  if (pending) document.title = `(${pending}) Permission needed${name}`;
  else if (session?.status === 'busy') document.title = `● Working${name}`;
  else document.title = `Claude Remote Control${name}`;
}

function setComposerEnabled(enabled, disabledHint = 'Read-only mirror', agentLabel) {
  $('#input').disabled = !enabled;
  $('#send').disabled = !enabled;
  $('#dictate').disabled = !enabled;
  $('#input').placeholder = enabled
    ? t('app.composer.placeholder', 'Message {agent}…', { agent: agentLabel || 'Claude' })
    : disabledHint;
}

// ---------------------------------------------------------------------------
// Voice: talking to it, and it talking back
// ---------------------------------------------------------------------------

/** Loaded on demand — nobody pays for it until they press the microphone. */
let voiceModule = null;
const loadVoice = async () => (voiceModule ||= await import('./voice.js'));

let stopDictation = null;

async function toggleDictation() {
  const voice = await loadVoice();
  const button = $('#dictate');

  if (stopDictation) {
    stopDictation();
    return;
  }

  const obstacle = voice.dictationObstacle();
  if (obstacle) {
    toast(obstacle);
    return;
  }

  const input = $('#input');
  // Dictation adds to whatever is already typed rather than replacing it.
  const prefix = input.value ? `${input.value.trim()} ` : '';

  try {
    button.classList.add('listening');
    stopDictation = voice.startDictation({
      onText: (text) => {
        input.value = prefix + text;
        input.dispatchEvent(new Event('input', { bubbles: true }));
      },
      onEnd: () => {
        stopDictation = null;
        button.classList.remove('listening');
        input.focus();
      },
      onError: (message) => toast(message),
    });
  } catch (err) {
    button.classList.remove('listening');
    stopDictation = null;
    toast(err?.message || 'Could not start dictation.');
  }
}

/** Read one reply aloud, or stop if this one is already being read. */
async function narrateText(text, button) {
  const voice = await loadVoice();
  if (!voice.narrationSupported()) {
    toast('This browser cannot read text aloud.');
    return;
  }

  const wasThisOne = button?.classList.contains('speaking');
  voice.stopNarration();
  for (const node of document.querySelectorAll('.speak-btn.speaking')) {
    node.classList.remove('speaking');
  }
  if (wasThisOne) return;

  button?.classList.add('speaking');
  const spoke = await voice.narrate(text, { onDone: () => button?.classList.remove('speaking') });
  if (!spoke) {
    button?.classList.remove('speaking');
    toast('Nothing to read here — it is all code.');
  }
}

/**
 * Auto-narration, for when the phone is in a pocket or a car mount. Only the
 * final prose of a turn is read: narrating every streamed fragment would talk
 * over itself.
 */
function maybeAutoNarrate(text) {
  if (!state.narrate || !text) return;
  loadVoice().then((voice) => voice.narrate(text)).catch(() => {});
}

// ---------------------------------------------------------------------------
// Permissions
// ---------------------------------------------------------------------------

/**
 * Recover prompts raised while this device was not listening.
 *
 * The daemon already ships the full request payload on every session it
 * describes; the client only ever read the live broadcast, so a phone that
 * slept through the question came back to a screen with nothing on it and an
 * agent waiting out its ten-minute timeout.
 */
function rehydratePermissions(sessions = []) {
  let recovered = 0;
  for (const session of sessions) {
    for (const payload of session.pendingPermissions || []) {
      if (state.permQueue.some((p) => p.requestId === payload.requestId)) continue;
      state.permQueue.push(payload);
      recovered += 1;
    }
  }
  if (!recovered) return;
  updateTabTitle();
  if ($('#perm-sheet').hidden) showNextPermission();
}

/** Put a rejected message back in the composer, exactly as it was. */
function restoreDraft() {
  const draft = state.lastDraft;
  if (!draft) return;
  state.lastDraft = null;
  const input = $('#input');
  if (input.value.trim()) return; // something newer is being typed; leave it
  input.value = draft.text;
  state.pending = draft.pending || [];
  renderAttachments();
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

function queuePermission(payload) {
  if (state.permQueue.some((p) => p.requestId === payload.requestId)) return;
  state.permQueue.push(payload);
  notifyPermission(payload);
  updateTabTitle();
  if ($('#perm-sheet').hidden) showNextPermission();
}

function showNextPermission() {
  const sheet = $('#perm-sheet');
  const next = state.permQueue[0];
  updateTabTitle();
  if (!next) {
    sheet.hidden = true;
    sheet.dataset.requestId = '';
    return;
  }

  sheet.dataset.requestId = next.requestId;
  sheet.dataset.sessionId = next.sessionId;
  $('#perm-title').textContent = next.title || next.toolName;
  $('#perm-sub').textContent = next.subtitle || '';
  $('#perm-desc').textContent = next.description || '';

  const detail = $('#perm-detail');
  const rich = $('#perm-rich');
  const input = next.input || {};
  detail.hidden = false;
  rich.hidden = true;

  if (next.toolName === 'ExitPlanMode' && input.plan) {
    // A plan is prose meant to be read and judged, not a payload to inspect.
    rich.innerHTML = renderMarkdown(String(input.plan));
    rich.hidden = false;
    detail.hidden = true;
    $('#perm-title').textContent = 'Review this plan';
    $('#perm-sub').textContent = 'Approving lets Claude start carrying it out.';
  } else if (next.toolName === 'Bash' && input.command) {
    detail.textContent = input.command;
  } else if (input.file_path && input.new_string !== undefined) {
    detail.textContent = `${input.file_path}\n\n- ${String(input.old_string || '').slice(0, 600)}\n+ ${String(input.new_string || '').slice(0, 600)}`;
  } else {
    detail.textContent = JSON.stringify(input, null, 2).slice(0, 2000);
  }

  $('#perm-queue').textContent =
    state.permQueue.length > 1 ? `${state.permQueue.length - 1} more waiting` : '';
  sheet.hidden = false;
}

function decide(decision) {
  const sheet = $('#perm-sheet');
  const requestId = sheet.dataset.requestId;
  const sessionId = sheet.dataset.sessionId;
  if (!requestId) return;

  // A phone that just woke up has a prompt on screen and a socket that has not
  // reconnected yet. Dropping the answer and closing the sheet as if it had
  // been sent is how a tool sits denied ten minutes later for no reason.
  if (!send({ t: 'permission', sessionId, requestId, decision })) {
    toast(t('toast.notConnected', 'Not connected — hold on, reconnecting.'));
    return;
  }
  state.permQueue = state.permQueue.filter((p) => p.requestId !== requestId);
  showNextPermission();
}

async function notifyPermission(payload) {
  if (!document.hidden) return;

  // Served over plain HTTP on a LAN, the Notification API is unavailable — the
  // chime and the tab title are the only ways to get attention there.
  chime();

  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  try {
    const reg = await navigator.serviceWorker?.ready;
    const options = {
      body: payload.subtitle || 'Claude needs your approval',
      tag: payload.requestId,
      icon: '/icons/icon-192.png',
    };
    if (reg) await reg.showNotification(payload.title || 'Permission needed', options);
    else new Notification(payload.title || 'Permission needed', options);
  } catch {
    /* notifications are a nicety, never a hard failure */
  }
}

/** A short two-tone chime. Web Audio works in insecure contexts; notifications don't. */
function chime() {
  try {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return;
    state.audio ||= new Ctx();
    const ctx = state.audio;
    if (ctx.state === 'suspended') ctx.resume();

    const now = ctx.currentTime;
    for (const [index, frequency] of [880, 1174].entries()) {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.frequency.value = frequency;
      osc.type = 'sine';
      const start = now + index * 0.13;
      gain.gain.setValueAtTime(0.0001, start);
      gain.gain.exponentialRampToValueAtTime(0.16, start + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.12);
      osc.connect(gain).connect(ctx.destination);
      osc.start(start);
      osc.stop(start + 0.14);
    }
  } catch {
    /* audio is a nicety too */
  }
}

// ---------------------------------------------------------------------------
// Sheets, drawer, misc UI
// ---------------------------------------------------------------------------

function openDrawer() {
  $('#app').classList.add('drawer-open');
}
function closeDrawer() {
  $('#app').classList.remove('drawer-open');
}

function toast(message) {
  const node = $('#toast');
  node.textContent = message;
  node.hidden = false;
  clearTimeout(node._timer);
  node._timer = setTimeout(() => {
    node.hidden = true;
  }, 3200);
}

/**
 * Run the agent's own sign-in from here: open its authorisation page, approve,
 * paste the code back. The daemon drives the CLI's OAuth flow, so what gets
 * stored bills the subscription rather than an API key.
 */
async function beginSignIn(agent, button) {
  button.disabled = true;
  button.textContent = 'Starting…';

  let session;
  try {
    session = await api(`/api/agents/${agent.id}/login`, { method: 'POST' });
  } catch (err) {
    toast(err.message);
    button.disabled = false;
    button.textContent = `Sign in to ${agent.label}`;
    return;
  }

  const sheet = $('#login-sheet');
  $('#login-title').textContent = `Sign in to ${agent.label}`;
  $('#login-open').href = session.url;
  $('#login-code').value = '';
  $('#login-error').hidden = true;
  sheet.dataset.loginId = session.loginId;
  sheet.hidden = false;
  $('#login-code').focus();

  button.disabled = false;
  button.textContent = `Sign in to ${agent.label}`;
}

// ---------------------------------------------------------------------------
// Settings, as groups of rows
// ---------------------------------------------------------------------------

/**
 * A titled group holding one card of rows.
 *
 * Settings used to be a stack of separate islands with a gap between every
 * line, which reads as a pile of unrelated things. Related rows belong in one
 * card, divided by hairlines, under one small heading — the divider carries the
 * structure so nothing else has to.
 */
function group(title, note) {
  const section = el('section', 's-group');
  if (title) section.appendChild(el('h4', null, title));
  if (note) section.appendChild(el('p', 'muted', note));
  const card = el('div', 's-card');
  section.appendChild(card);
  return { section, card };
}

/**
 * One row: a status dot, a name with a line of detail under it, and at most one
 * control on the right.
 */
function row({ dot, name, detail, control, note }) {
  const node = el('div', 's-row');
  if (dot) node.appendChild(el('i', `dot ${dot}`));

  const text = el('div', 's-row-text');
  text.appendChild(el('strong', null, name));
  if (detail) text.appendChild(el('span', null, detail));
  node.appendChild(text);

  if (control) node.appendChild(control);
  // Anything that needs more than a line of detail — a hint, a command, a form —
  // goes below the row rather than squeezing into it.
  if (note) {
    const wrap = el('div', 's-row-extra');
    wrap.appendChild(node);
    for (const child of [].concat(note)) wrap.appendChild(child);
    return wrap;
  }
  return node;
}

/** A checkbox that looks like a switch. The input keeps its id and listeners. */
function toggle(on, onChange) {
  const label = el('label', 'switch');
  const input = document.createElement('input');
  input.type = 'checkbox';
  input.checked = Boolean(on);
  input.addEventListener('change', () => onChange(input.checked, input));
  label.appendChild(input);
  label.appendChild(document.createElement('i'));
  return label;
}

/** A small pill button on the right of a row. */
function action(text, handler, { neutral = false } = {}) {
  const button = el('button', `s-action${neutral ? ' neutral' : ''}`, text);
  button.type = 'button';
  button.addEventListener('click', () => handler(button));
  return button;
}

/**
 * Sign an agent in from the phone. Every agent here normally authenticates in a
 * terminal on the host, which is exactly what you do not have when you are away
 * from it — so an API key can be pasted instead, and the login command is shown
 * for when you do get back to a keyboard.
 */
function renderAgentSettings(agents) {
  const container = $('#agents-body');
  container.innerHTML = '';
  if (!agents.length) return;

  const { section, card } = group(t('settings.agents', 'Agent accounts'));
  card.classList.add('boxed');

  for (const agent of agents) {
    const extras = [];
    const credential = agent.credential;

    if (credential) {
      if (credential.set) {
        const stored = el('div', 'agent-key');
        stored.appendChild(
          el('span', 'small muted', `${credential.kind || credential.label}: ${credential.hint}`),
        );
        const remove = el('button', 'link-btn', 'Remove');
        remove.type = 'button';
        remove.addEventListener('click', async () => {
          try {
            await api(`/api/agents/${agent.id}/credentials`, { method: 'DELETE' });
            toast(`${agent.label} key removed`);
            openSettings();
          } catch (err) {
            toast(err.message);
          }
        });
        stored.appendChild(remove);
        extras.push(stored);
      } else {
        // The good path: sign in with the account, no token handling at all.
        if (agent.canSignIn) {
          const signIn = el('button', 'primary wide', `Sign in to ${agent.label}`);
          signIn.type = 'button';
          signIn.addEventListener('click', () => beginSignIn(agent, signIn));
          extras.push(signIn);
          extras.push(
            el('p', null, 'Opens the sign-in page. Approve it, paste the code back, done.'),
          );
          extras.push(el('p', null, 'Or paste a token or API key instead:'));
        } else {
          extras.push(el('p', null, credential.loginHint));
        }

        const form = el('div', 'agent-key');
        const input = document.createElement('input');
        input.type = 'password';
        input.placeholder = credential.placeholder || 'API key';
        input.autocomplete = 'off';
        input.spellcheck = false;
        form.appendChild(input);

        const save = el('button', 'link-btn', 'Save');
        save.type = 'button';
        save.addEventListener('click', async () => {
          if (!input.value.trim()) return;
          try {
            await api(`/api/agents/${agent.id}/credentials`, {
              method: 'POST',
              body: JSON.stringify({ apiKey: input.value.trim() }),
            });
            input.value = '';
            toast(`${agent.label} key saved`);
            state.serverState = await api('/api/state');
            openSettings();
          } catch (err) {
            toast(err.message);
          }
        });
        form.appendChild(save);
        extras.push(form);
      }
    } else if (!agent.available && agent.fix) {
      extras.push(el('p', null, agent.fix));
    }

    card.appendChild(
      row({
        dot: agent.available ? 'idle' : 'error',
        name: agent.label,
        detail: agent.available ? 'ready' : agent.detail || 'unavailable',
        note: extras.length ? extras : null,
      }),
    );
  }

  container.appendChild(section);
}

/**
 * Fill the agent picker from what is actually installed.
 *
 * Restored after a refactor deleted it and left the call behind: the new
 * session sheet threw on open, so the agent list and the folder browser were
 * both empty and Start posted undefined for each.
 */
function renderAgentPicker() {
  const select = $('#new-agent');
  const agents = state.serverState?.agents || [];
  select.innerHTML = '';

  for (const agent of agents) {
    const option = document.createElement('option');
    option.value = agent.id;
    // Say why it is unusable — "not signed in" and "not installed" have very
    // different fixes, and the option label is where you notice the difference.
    option.textContent = agent.available ? agent.label : `${agent.label} — ${agent.detail || 'unavailable'}`;
    option.disabled = !agent.available;
    select.appendChild(option);
  }

  const firstAvailable = agents.find((a) => a.available);
  if (firstAvailable) select.value = firstAvailable.id;
  select.parentElement.querySelector('label[for=new-agent]').hidden = agents.length < 2;
  select.hidden = agents.length < 2;
  renderAgentNote();
}

/** Say plainly what the chosen agent cannot do, instead of silent surprises. */
function renderAgentNote() {
  const note = $('#agent-note');
  const agents = state.serverState?.agents || [];
  const agent = agents.find((a) => a.id === $('#new-agent').value);

  // The model list here names Claude models; offering them for another agent
  // would send it a model it has never heard of, which is a hard error.
  $('#new-model').parentElement.hidden = Boolean(agent) && agent.id !== 'claude-code';

  note.textContent = '';
  if (!agent) return;

  if (!agent.available) {
    note.textContent = agent.fix || 'Not installed on this machine.';
    return;
  }
  // An agent that cannot route approvals here still asks — on the host, where
  // nobody is listening, so every tool gets denied. Saying "cannot ask" would
  // be true and useless; this is the sentence that saves a wasted session.
  if (!agent.capabilities?.permissions) {
    note.textContent =
      `${agent.label} asks for tool approval on the host machine. With nobody there to answer, ` +
      'every tool is denied — choose “Bypass all” below for it to get anything done.';
    return;
  }

  const missing = [];
  if (!agent.capabilities?.images) missing.push('images are passed as files, not inline');
  if (!agent.capabilities?.models) missing.push('no model switching');
  note.textContent = missing.length ? `Note: ${missing.join(', ')}.` : '';
}

/**
 * Browse the host's directories.
 *
 * Used by two screens with the same behaviour and different destinations: the
 * new-session sheet, and the setting that says where sessions start by default.
 */
async function openPicker(startPath, { list = '#picker-list', path = '#picker-path' } = {}) {
  const listNode = $(list);
  const pathNode = $(path);

  const load = async (target) => {
    const data = await api(`/api/fs?path=${encodeURIComponent(target)}`);
    pathNode.textContent = prettyPath(data.path);
    pathNode.dataset.path = data.path;
    listNode.innerHTML = '';

    const up = el('li', null, '../');
    up.addEventListener('click', () => load(data.parent).catch((e) => toast(e.message)));
    listNode.appendChild(up);

    for (const dir of data.dirs) {
      const li = el('li');
      li.appendChild(icon('folder', { size: 16 }));
      li.appendChild(el('span', null, dir.name));
      li.addEventListener('click', () => load(dir.path).catch((e) => toast(e.message)));
      listNode.appendChild(li);
    }
  };

  await load(startPath);
}

/**
 * Pick any folder on the Mac as the one new sessions start in.
 *
 * Settings gets out of the way first: two sheets at once stack their scrims
 * and their text, and the result reads as a rendering fault. Closing it comes
 * back automatically when this one is done.
 */
async function openDefaultFolderPicker(startPath) {
  $('#settings-sheet').hidden = true;
  $('#folder-sheet').hidden = false;
  try {
    await openPicker(startPath, { list: '#folder-list', path: '#folder-path' });
  } catch (err) {
    toast(err.message);
  }
}

/** Leave the folder picker and put Settings back where it was. */
function closeFolderPicker() {
  $('#folder-sheet').hidden = true;
  openSettings();
}

/**
 * The host-side setup, done from here. Everything in this section is something
 * you would otherwise have to walk to the machine and type.
 */
async function renderSetup() {
  const container = $('#setup-body');
  container.innerHTML = '';

  let data;
  try {
    data = await api('/api/setup');
  } catch (err) {
    container.appendChild(el('p', 'error', err.message));
    return;
  }

  // --- what this Mac has installed -------------------------------------------
  const machine = group(t('settings.thisMac', 'This Mac'));

  for (const task of data.tasks) {
    const extras = [];
    if (!task.done) {
      extras.push(el('p', null, task.manualHint || task.detail));

      if (task.manual) {
        // It needs a password, so the closest thing to a button is putting the
        // command in a Terminal window on the host, ready to run.
        const command = el('div', 'setup-command');
        command.appendChild(el('code', null, task.manual));
        const copy = el('button', 'link-btn', 'Copy');
        copy.type = 'button';
        copy.addEventListener('click', async () => {
          copy.textContent = (await copyText(task.manual)) ? 'Copied' : 'Failed';
          setTimeout(() => {
            copy.textContent = 'Copy';
          }, 1600);
        });
        command.appendChild(copy);
        extras.push(command);
      }
    }

    let control = null;
    if (!task.done && task.runnable) {
      control = action(`Install`, async (button) => {
        button.disabled = true;
        button.textContent = 'Working…';
        try {
          await api(`/api/setup/${task.id}`, { method: 'POST' });
          toast(`${task.label} ready`);
          openSettings();
        } catch (err) {
          toast(err.message);
          button.disabled = false;
          button.textContent = 'Install';
        }
      });
    } else if (!task.done && task.manual) {
      control = action('Open Terminal', async () => {
        try {
          await api('/api/setup/terminal', {
            method: 'POST',
            body: JSON.stringify({ command: task.manual }),
          });
          toast('Opened on the Mac — press return there');
        } catch (err) {
          toast(err.message);
        }
      });
    }

    machine.card.appendChild(
      row({
        dot: task.done ? 'idle' : 'error',
        name: task.label,
        detail: task.detail || (task.done ? 'ready' : 'missing'),
        control,
        note: extras.length ? extras : null,
      }),
    );
  }
  container.appendChild(machine.section);

  // --- sleep ------------------------------------------------------------------
  const sleep = group(t('settings.sleep', 'Sleep'));

  // Keep awake — what people install Amphetamine for.
  if (data.keepAwake?.supported) {
    sleep.card.appendChild(
      row({
        dot: data.keepAwake.active ? 'idle' : '',
        name: t('settings.keepAwake', 'Keep this Mac awake'),
        detail: data.keepAwake.description,
        control: toggle(data.keepAwake.active, async (wanted, input) => {
          try {
            await api('/api/setup/keep-awake', {
              method: 'PUT',
              body: JSON.stringify({ enabled: wanted }),
            });
            renderSetup();
          } catch (err) {
            toast(err.message);
            input.checked = !wanted;
          }
        }),
      }),
    );
  }

  // Closed-lid mode. Separate from keep-awake because it needs root once:
  // closing the lid is its own sleep event, and only pmset suppresses it.
  if (data.closedLid?.supported) {
    if (data.closedLid.permitted) {
      sleep.card.appendChild(
        row({
          // `wanted` is the switch; `active` is whether it is in force right
          // now, which on battery it deliberately is not.
          dot: data.closedLid.active ? 'idle' : '',
          name: t('settings.lidClosed', 'Run with the lid closed'),
          detail: data.closedLid.status || data.closedLid.description,
          control: toggle(data.closedLid.wanted, async (wanted, input) => {
            try {
              await api('/api/setup/closed-lid', {
                method: 'PUT',
                body: JSON.stringify({ enabled: wanted }),
              });
              renderSetup();
            } catch (err) {
              toast(err.message);
              input.checked = !wanted;
            }
          }),
        }),
      );
    } else {
      sleep.card.appendChild(
        row({
          dot: '',
          name: t('settings.lidClosed', 'Run with the lid closed'),
          detail: 'needs permission once',
          control: action('Grant', async () => {
            try {
              await api('/api/setup/terminal', {
                method: 'POST',
                body: JSON.stringify({ command: data.closedLid.setupCommand }),
              });
              toast('Opened on the Mac — press return and enter your password');
            } catch (err) {
              toast(err.message);
            }
          }),
          note: el(
            'p',
            null,
            'Changing this needs root, so it has to be granted once on the Mac. The script ' +
              'allows exactly two commands — turning this setting on and off — and nothing else.',
          ),
        }),
      );
    }
  }
  if (sleep.card.children.length) container.appendChild(sleep.section);

  // --- where new sessions start -----------------------------------------------
  const folder = group(t('settings.projectFolder', 'Project folder'), prettyPath(data.defaultCwd));
  folder.card.appendChild(
    row({
      name: t('settings.chooseFolder', 'Choose a folder'),
      detail: t('settings.anywhere', 'Anywhere on this Mac'),
      control: action(t('settings.browse', 'Browse'), () => openDefaultFolderPicker(data.defaultCwd)),
    }),
  );
  const options = el('div', 'root-options');
  for (const root of data.suggestedRoots) {
    const choice = el('button', `root-choice${root === data.defaultCwd ? ' active' : ''}`, prettyPath(root));
    choice.type = 'button';
    choice.addEventListener('click', async () => {
      try {
        await api('/api/setup/default-cwd', { method: 'PUT', body: JSON.stringify({ path: root }) });
        state.serverState = await api('/api/state');
        toast('Project folder set');
        renderSetup();
      } catch (err) {
        toast(err.message);
      }
    });
    options.appendChild(choice);
  }
  folder.card.appendChild(options);
  container.appendChild(folder.section);
}

const prettyPath = (p) => String(p || '').replace(/^\/Users\/[^/]+/, '~');

const BYPASS_MODE = 'bypassPermissions';

/**
 * The one switch that stops every prompt. It is deliberately a switch and not
 * another entry in the permission dropdown: picking a mode per session is not
 * the same promise as "do not interrupt me", and the second is what people
 * driving an agent from a phone actually want.
 */
function renderPermissions(defaults = {}) {
  const container = $('#perms-body');
  container.innerHTML = '';
  const on = defaults.permissionMode === BYPASS_MODE;

  const { section, card } = group(t('settings.permissions', 'Permissions'));
  card.appendChild(
    row({
      dot: on ? 'error' : 'idle',
      name: t('settings.neverAsk', 'Never ask for permission'),
      detail: on ? t('settings.neverAskOn', 'Nothing reaches this screen') : t('settings.neverAskOff', 'Every tool waits for you'),
      control: toggle(on, async (wanted, input) => {
        input.disabled = true;
        try {
          const { applied } = await api('/api/settings', {
            method: 'POST',
            body: JSON.stringify({
              defaultPermissionMode: wanted ? BYPASS_MODE : 'default',
              applyToOpenSessions: true,
            }),
          });
          state.serverState = await api('/api/state');
          renderPermissions(state.serverState.defaults);
          const scope = applied ? ` — ${applied} open session${applied === 1 ? '' : 's'} too` : '';
          toast(wanted ? `Nothing will ask${scope}` : `Asking again${scope}`);
        } catch (err) {
          toast(err.message);
          input.checked = !wanted;
          input.disabled = false;
        }
      }),
      note: el(
        'p',
        null,
        on
          ? 'Every tool runs the moment the agent asks for it — edits, shell commands, ' +
              'deletions, network calls.'
          : 'Turn this on to run every tool without asking, in this and every session. ' +
              'Convenient when you are away from the Mac; there is nothing to catch a bad command.',
      ),
    }),
  );
  container.appendChild(section);

  renderVoiceSettings(container);
}

/** Reading replies aloud, and whether this browser can hear you at all. */
function renderVoiceSettings(container) {
  const { section, card } = group(t('settings.voice', 'Voice'));

  card.appendChild(
    row({
      dot: state.narrate ? 'idle' : '',
      name: t('settings.readAloud', 'Read replies aloud'),
      detail: t('settings.readAloudNote', 'Skips code, paths and links'),
      control: toggle(state.narrate, async (wanted) => {
        state.narrate = wanted;
        localStorage.setItem(NARRATE_KEY, wanted ? '1' : '0');
        const voice = await loadVoice();
        if (!wanted) voice.stopNarration();
        else voice.narrate('Reading replies aloud.');
        renderPermissions(state.serverState?.defaults || {});
      }),
    }),
  );

  // Language. `Automatic` follows the phone, which is what almost everyone
  // wants; the explicit choices are for a phone set to one language and a
  // person who thinks in another.
  const picker = document.createElement('select');
  for (const option of LANGUAGES) {
    const node = document.createElement('option');
    node.value = option.id;
    node.textContent = option.label;
    if (option.id === languageChoice()) node.selected = true;
    picker.appendChild(node);
  }
  picker.addEventListener('change', () => {
    setLanguage(picker.value);
    // Redraw everything that was built in JS rather than markup.
    openSettings();
    renderHeader();
    renderSessionList();
  });
  card.appendChild(
    row({ name: t('settings.language', 'Language'), detail: null, control: picker }),
  );

  // Dictation is a property of the browser, not a setting — but when it is
  // unavailable the microphone button needs to explain itself somewhere.
  loadVoice().then((voice) => {
    const obstacle = voice.dictationObstacle();
    card.appendChild(
      row({
        dot: obstacle ? '' : 'idle',
        name: t('settings.dictation', 'Dictation'),
        detail: obstacle ? t('settings.dictationOff', 'unavailable here') : t('settings.dictationOk', 'hold the microphone and talk'),
        note: obstacle ? el('p', null, obstacle) : null,
      }),
    );
  });

  container.appendChild(section);
}

async function openSettings() {
  const body = $('#settings-body');
  body.innerHTML = '';
  renderSetup();
  try {
    const data = await api('/api/state');
    state.serverState = data;
    renderPermissions(data.defaults);

    // Listing a LAN address while bound to loopback would send you chasing an
    // address that cannot answer. Say what is actually true.
    if (data.localOnly) {
      const warn = el('div', 'notice-warn');
      warn.appendChild(
        el(
          'p',
          null,
          'This daemon is listening on localhost only, so no phone can reach it. ' +
            'Restart it with `crc start --host 0.0.0.0`, or set "host" in the config.',
        ),
      );
      body.appendChild(warn);
    }

    // --- addresses ------------------------------------------------------------
    const ts = data.tailscale;
    const addresses = group(
      t('settings.reachableAt', 'Reachable at'),
      !ts
        ? 'Tailscale is not installed. Install it to reach this Mac from outside your network.'
        : ts.running
          ? `Tailscale connected as ${ts.dnsName || ts.ips?.[0]}`
          : `Tailscale is ${ts.backendState}. Run "tailscale up" on the host.`,
    );
    addresses.card.classList.add('boxed');
    for (const u of data.urls) {
      const line = el('div', 's-row');
      const text = el('div', 's-row-text');
      text.appendChild(el('strong', 'address-url', u.url));
      text.appendChild(el('span', null, u.label || u.kind));
      line.appendChild(text);
      line.appendChild(
        action(t('action.copy', 'Copy'), async (button) => {
          button.textContent = (await copyText(u.url)) ? t('action.copied', 'Copied') : t('action.failed', 'Failed');
          setTimeout(() => {
            button.textContent = 'Copy';
          }, 1600);
        }, { neutral: true }),
      );
      addresses.card.appendChild(line);
    }
    body.appendChild(addresses.section);

    // --- paired devices -------------------------------------------------------
    if (data.devices?.length) {
      const devices = group(t('settings.devices', `Paired devices (${data.devices.length})`, { count: data.devices.length }));
      for (const device of data.devices) {
        devices.card.appendChild(
          row({
            name: device.name,
            detail: `last seen ${relativeTime(Date.parse(device.lastSeenAt))}`,
            control: action(t('action.revoke', 'Revoke'), async () => {
              await api(`/api/devices/${device.id}`, { method: 'DELETE' });
              toast('Device revoked');
              openSettings();
            }, { neutral: true }),
          }),
        );
      }
      body.appendChild(devices.section);
    }

    const clients = data.connectedClients ?? 0;
    body.appendChild(
      el(
        'p',
        'small muted center',
        `Daemon v${data.version} on ${data.hostname} · ${clients} client${clients === 1 ? '' : 's'} connected`,
      ),
    );

    renderAgentSettings(data.agents || []);
    renderTestedOn(body);
  } catch (err) {
    body.appendChild(el('p', 'error', err.message));
  }
  $('#settings-sheet').hidden = false;
}

/**
 * The family name, and nothing else.
 *
 * `claude-opus-5`, `claude-3-5-sonnet-20241022`, `opus` — all of them are
 * "Opus" to a person holding a phone. The version is noise on a 4-inch row and
 * the id is still one tap away if anyone wants it.
 */
const MODEL_FAMILIES = ['opus', 'sonnet', 'haiku', 'fable'];

export function prettyModel(id) {
  if (!id) return null;
  const lower = String(id).toLowerCase();
  const family = MODEL_FAMILIES.find((name) => lower.includes(name));
  if (family) return family.charAt(0).toUpperCase() + family.slice(1);
  // Something we do not recognise: show it, tidied, rather than hide it.
  return String(id).replace(/^claude-/, '').replace(/-\d{8}$/, '');
}

/**
 * Mirrors src/effort.js. Not imported across the boundary on purpose: web/ is
 * served as static files and src/ is not, so an import would 404 in the
 * browser — and the server keeps its own copy as the validator anyway.
 */
const EFFORT_LABELS = {
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'Extra high',
  max: 'Max',
};

const PERMISSION_LABEL = {
  default: 'Ask me',
  acceptEdits: 'Auto-accept edits',
  plan: 'Plan only',
  bypassPermissions: 'Bypass all',
};

/**
 * What this session is, and the few things you can do to it.
 *
 * Nothing here invents a value. A mirrored conversation has a model — the
 * transcript names it on every reply — but no permission mode of ours, and
 * showing a dropdown parked on the first entry told people their Opus session
 * was Sonnet and set to "Ask me" when neither was true.
 */
function openSessionOptions() {
  const session = currentSession();
  if (!session) return;

  const body = $('#opts-body');
  body.innerHTML = '';
  const readOnly = Boolean(session.readOnly);

  // --- what it is -------------------------------------------------------------
  const about = group(readOnly ? t('session.mirrored', 'Mirrored conversation') : t('session.title', 'Session'));

  about.card.appendChild(
    row({
      name: t('session.folder', 'Folder'),
      detail: prettyPath(session.cwd) || '—',
      control: session.cwd
        ? action(t('action.copy', 'Copy'), async (button) => {
            button.textContent = (await copyText(session.cwd)) ? 'Copied' : 'Failed';
            setTimeout(() => {
              button.textContent = 'Copy';
            }, 1600);
          }, { neutral: true })
        : null,
    }),
  );

  const agentLabel = session.agentLabel || (session.agent === 'antigravity' ? 'Google Antigravity' : 'Claude Code');
  about.card.appendChild(
    row({ name: t('session.agent', 'Agent'), detail: readOnly ? `${agentLabel} · ${session.origin || 'unknown'}` : agentLabel }),
  );

  const model = prettyModel(session.model);
  if (model) about.card.appendChild(row({ name: t('session.model', 'Model'), detail: model }));

  about.card.appendChild(
    row({
      name: t('session.id', 'Session id'),
      detail: (session.claudeSessionId || session.id).slice(0, 8),
      control: action(t('action.copy', 'Copy'), async (button) => {
        button.textContent = (await copyText(session.claudeSessionId || session.id)) ? 'Copied' : 'Failed';
        setTimeout(() => {
          button.textContent = 'Copy';
        }, 1600);
      }, { neutral: true }),
    }),
  );

  if (typeof session.totalCostUsd === 'number' && session.totalCostUsd > 0) {
    about.card.appendChild(row({ name: t('session.cost', 'Cost so far'), detail: `$${session.totalCostUsd.toFixed(4)}` }));
  }
  body.appendChild(about.section);

  // --- what you can change ----------------------------------------------------
  if (!readOnly) {
    const controls = group(t('session.controls', 'Controls'));

    const models = session.availableModels?.length ? session.availableModels : null;
    if (models) {
      const select = $('#opt-model');
      select.innerHTML = '';
      for (const entry of models) {
        const option = document.createElement('option');
        option.value = entry.id;
        option.textContent = entry.name;
        if (session.model === entry.id) option.selected = true;
        select.appendChild(option);
      }
      select.hidden = false;
      controls.card.appendChild(row({ name: 'Model', detail: model || 'default', control: select }));
    }

    const effortSelect = $('#opt-effort');
    effortSelect.value = session.effort || '';
    effortSelect.hidden = false;
    controls.card.appendChild(
      row({
        name: t('session.thinking', 'Thinking'),
        detail: EFFORT_LABELS[session.effort] || t('session.agentDefault', 'Agent default'),
        control: effortSelect,
      }),
    );

    const perm = $('#opt-perm');
    perm.value = session.permissionMode || 'default';
    perm.hidden = false;
    controls.card.appendChild(
      row({
        name: t('session.permissions', 'Permissions'),
        detail: PERMISSION_LABEL[session.permissionMode] || 'Ask me',
        control: perm,
      }),
    );

    if (controls.card.children.length) body.appendChild(controls.section);
  } else {
    // A mirror is someone else's session; the only verb is to take it over.
    body.appendChild(
      el(
        'p',
        'small muted',
        'This is a live copy of a conversation running elsewhere on your Mac. Taking over forks it into a session you drive from here, leaving the original untouched.',
      ),
    );
  }

  $('#opt-takeover').hidden = !readOnly;
  $('#opt-close-session').textContent = readOnly ? 'Stop mirroring' : 'End session';
  $('#opts-sheet').hidden = false;
}

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------

/**
 * Six boxes that behave like one field.
 *
 * Typing moves forward, backspace moves back, and a pasted code fills them all
 * — the code is read off a screen across the room, so the failure to design
 * for is looking away and losing your place.
 */
function wireCodeBoxes() {
  const boxes = [...document.querySelectorAll('.code-box')];
  const value = () => boxes.map((b) => b.value).join('');

  boxes.forEach((box, index) => {
    box.addEventListener('input', () => {
      box.value = box.value.replace(/\D/g, '').slice(-1);
      if (box.value && index < boxes.length - 1) boxes[index + 1].focus();
      if (value().length === boxes.length) $('#pair-form').requestSubmit();
    });
    box.addEventListener('keydown', (event) => {
      if (event.key === 'Backspace' && !box.value && index > 0) boxes[index - 1].focus();
    });
    box.addEventListener('paste', (event) => {
      const digits = (event.clipboardData?.getData('text') || '').replace(/\D/g, '').slice(0, 6);
      if (!digits) return;
      event.preventDefault();
      digits.split('').forEach((digit, i) => {
        if (boxes[i]) boxes[i].value = digit;
      });
      boxes[Math.min(digits.length, boxes.length - 1)].focus();
      if (digits.length === boxes.length) $('#pair-form').requestSubmit();
    });
  });

  return { value, clear: () => boxes.forEach((b) => (b.value = '')), focus: () => boxes[0]?.focus() };
}

let codeBoxes = null;

function wireUp() {
  // Pairing
  codeBoxes = wireCodeBoxes();
  $('#pair-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const errorNode = $('#pair-error');
    errorNode.hidden = true;
    const code = codeBoxes.value();
    if (code.length < 6) return;
    try {
      await pair(code, $('#pair-name').value);
      await enterApp();
    } catch (err) {
      errorNode.textContent = err.message;
      errorNode.hidden = false;
      codeBoxes.clear();
      codeBoxes.focus();
    }
  });

  $('#pair-token-go').addEventListener('click', async () => {
    const errorNode = $('#pair-error');
    errorNode.hidden = true;
    try {
      await pair($('#pair-token').value.trim(), $('#pair-name').value);
      await enterApp();
    } catch (err) {
      errorNode.textContent = err.message;
      errorNode.hidden = false;
    }
  });

  wireScanner();

  // Project folder
  $('#folder-close').addEventListener('click', closeFolderPicker);
  $('#folder-use').addEventListener('click', async (event) => {
    const chosen = $('#folder-path').dataset.path;
    if (!chosen) return;
    const button = event.currentTarget;
    button.disabled = true;
    try {
      await api('/api/setup/default-cwd', { method: 'PUT', body: JSON.stringify({ path: chosen }) });
      state.serverState = await api('/api/state');
      toast(`New sessions start in ${prettyPath(chosen)}`);
      closeFolderPicker();
    } catch (err) {
      toast(err.message);
    } finally {
      button.disabled = false;
    }
  });

  $('#conn-banner').addEventListener('click', () => {
    setConn('connecting');
    connect();
  });

  // Voice
  $('#dictate').addEventListener('click', toggleDictation);
  // One listener for every speaker button, present and future.
  $('#feed').addEventListener('click', (event) => {
    const button = event.target.closest?.('.speak-btn');
    if (!button) return;
    event.preventDefault();
    narrateText(button.dataset.speak, button);
  });

  // Address switching, when this one stopped answering
  $('#offline-close').addEventListener('click', () => {
    $('#offline-sheet').hidden = true;
  });
  $('#offline-retry').addEventListener('click', async () => {
    const button = $('#offline-retry');
    button.disabled = true;
    button.textContent = 'Checking…';
    if (await daemonReachable()) {
      location.reload();
      return;
    }
    button.disabled = false;
    button.textContent = 'Try this address again';
    toast('Still nothing at this address');
  });

  // Add to home screen
  $('#install-close').addEventListener('click', () => {
    $('#install-sheet').hidden = true;
  });
  $('#install-later').addEventListener('click', () => {
    $('#install-sheet').hidden = true;
  });
  $('#install-now').addEventListener('click', async () => {
    $('#install-sheet').hidden = true;
    try {
      await deferredInstall?.prompt();
    } catch {
      /* the user dismissed it, which is an answer */
    }
    deferredInstall = null;
  });

  // Drawer
  $('#menu-btn').addEventListener('click', openDrawer);
  $('#drawer-close').addEventListener('click', closeDrawer);
  $('#scrim').addEventListener('click', closeDrawer);

  // Composer
  const input = $('#input');
  const autoGrow = () => {
    input.style.height = 'auto';
    input.style.height = `${Math.min(input.scrollHeight, window.innerHeight * 0.4)}px`;
  };
  input.addEventListener('input', autoGrow);
  input.addEventListener('keydown', (event) => {
    // Enter sends on a physical keyboard; on touch it inserts a newline.
    const isDesktop = window.matchMedia('(min-width: 900px)').matches;
    if (event.key === 'Enter' && !event.shiftKey && isDesktop) {
      event.preventDefault();
      $('#composer').requestSubmit();
    }
  });

  $('#attach').addEventListener('click', () => $('#file-input').click());
  $('#file-input').addEventListener('change', async (event) => {
    await addAttachments(event.target.files);
    event.target.value = '';
  });

  // Pasting a screenshot straight into the composer is the desktop path.
  input.addEventListener('paste', (event) => {
    const files = [...(event.clipboardData?.files || [])];
    if (files.length) {
      event.preventDefault();
      addAttachments(files);
    }
  });

  $('#composer').addEventListener('submit', (event) => {
    event.preventDefault();
    const text = input.value.trim();
    if ((!text && !state.pending.length) || !state.currentId) return;
    const session = currentSession();
    if (session?.readOnly) {
      toast(t('toast.readOnly', 'This is a read-only mirror. Use “Take over” to continue it.'));
      return;
    }

    const images = state.pending.map(({ mediaType, data, thumbnail }) => ({ mediaType, data, thumbnail }));
    if (!send({ t: 'prompt', sessionId: state.currentId, text, images })) {
      toast(t('toast.notConnected', 'Not connected — hold on, reconnecting.'));
      return;
    }
    // Held, not discarded: the socket accepting the bytes is not the daemon
    // accepting the message, and "this session has ended" would otherwise take
    // the typing and the photos with it.
    state.lastDraft = { text, pending: state.pending };
    input.value = '';
    state.pending = [];
    renderAttachments();
    autoGrow();
    scrollToBottom();
  });

  $('#stop').addEventListener('click', () => {
    if (state.currentId) send({ t: 'interrupt', sessionId: state.currentId });
  });

  $('#feed').addEventListener('scroll', () => {
    const view = state.views.get(state.currentId);
    if (!view) return;
    view.pinned = isAtBottom();
    $('#scroll-pin').hidden = view.pinned;
  });
  $('#scroll-bottom').addEventListener('click', scrollToBottom);

  // Permission sheet
  $('#perm-allow').addEventListener('click', () => decide('allow'));
  $('#perm-allow-always').addEventListener('click', () => decide('allow_always'));
  $('#perm-deny').addEventListener('click', () => decide('deny'));

  // Sheets
  for (const btn of document.querySelectorAll('.sheet-close')) {
    btn.addEventListener('click', () => {
      btn.closest('.sheet').hidden = true;
    });
  }
  for (const sheet of document.querySelectorAll('.sheet')) {
    sheet.addEventListener('click', (event) => {
      if (event.target !== sheet || sheet.id === 'perm-sheet') return;
      // The scanner holds a camera; hiding its sheet without stopping the
      // tracks leaves the indicator lit and orphans the stream.
      if (sheet.id === 'scan-sheet') closeScanner();
      else sheet.hidden = true;
    });
  }

  // New session
  $('#new-session').addEventListener('click', async () => {
    const start = state.serverState?.defaults?.cwd || '~';
    // Otherwise the sheet quietly proposes "Ask me" to someone who set the
    // default to never ask, and the setting looks broken on the next session.
    $('#new-perm').value = state.serverState?.defaults?.permissionMode || 'default';
    $('#new-sheet').hidden = false;
    renderAgentPicker();
    try {
      await openPicker(start);
    } catch (err) {
      toast(err.message);
    }
  });

  $('#new-agent').addEventListener('change', () => renderAgentNote());

  $('#create-session').addEventListener('click', async () => {
    const cwd = $('#picker-path').dataset.path;
    const button = $('#create-session');
    button.disabled = true;
    try {
      const { session } = await api('/api/sessions', {
        method: 'POST',
        body: JSON.stringify({
          cwd,
          agent: $('#new-agent').value || undefined,
          model: $('#new-model').parentElement.hidden ? undefined : $('#new-model').value,
          permissionMode: $('#new-perm').value,
          effort: $('#new-effort').value || undefined,
        }),
      });
      state.sessions.set(session.id, session);
      $('#new-sheet').hidden = true;
      await openSession(session.id, false);
    } catch (err) {
      toast(err.message);
    } finally {
      button.disabled = false;
    }
  });

  // Session options
  $('#session-menu-btn').addEventListener('click', openSessionOptions);

  $('#opt-model').addEventListener('change', async (event) => {
    try {
      await api(`/api/sessions/${state.currentId}/model`, {
        method: 'POST',
        body: JSON.stringify({ model: event.target.value }),
      });
      toast(`Model set to ${event.target.value}`);
    } catch (err) {
      toast(err.message);
    }
  });

  $('#opt-effort').addEventListener('change', async (event) => {
    const session = currentSession();
    if (!session) return;
    try {
      await api(`/api/sessions/${session.id}/effort`, {
        method: 'POST',
        body: JSON.stringify({ effort: event.target.value || null }),
      });
    } catch (err) {
      toast(err.message);
    }
  });

  $('#opt-perm').addEventListener('change', async (event) => {
    try {
      await api(`/api/sessions/${state.currentId}/permission-mode`, {
        method: 'POST',
        body: JSON.stringify({ mode: event.target.value }),
      });
      toast(`Permissions: ${event.target.value}`);
    } catch (err) {
      toast(err.message);
    }
  });

  $('#opt-takeover').addEventListener('click', async () => {
    const session = currentSession();
    if (!session) return;
    try {
      const { session: created } = await api('/api/sessions', {
        method: 'POST',
        body: JSON.stringify({
          cwd: session.cwd,
          resumeFrom: session.claudeSessionId || session.id,
          forkSession: true,
          title: session.title,
        }),
      });
      $('#opts-sheet').hidden = true;
      state.sessions.set(created.id, created);
      await openSession(created.id, false);
      toast('Took over — continuing here');
    } catch (err) {
      toast(err.message);
    }
  });

  $('#opt-close-session').addEventListener('click', async () => {
    if (!state.currentId) return;
    try {
      await api(`/api/sessions/${state.currentId}`, { method: 'DELETE' });
      state.sessions.delete(state.currentId);
      $('#opts-sheet').hidden = true;
      state.currentId = null;
      renderSessionList();
      renderHeader();
      const feed = $('#feed');
      for (const child of [...feed.children]) if (child.id !== 'empty-state') child.remove();
      $('#empty-state').hidden = false;
    } catch (err) {
      toast(err.message);
    }
  });

  // Sign-in
  $('#login-submit').addEventListener('click', async () => {
    const sheet = $('#login-sheet');
    const button = $('#login-submit');
    const error = $('#login-error');
    error.hidden = true;
    button.disabled = true;
    button.textContent = 'Signing in…';

    try {
      const result = await api('/api/login/complete', {
        method: 'POST',
        body: JSON.stringify({ loginId: sheet.dataset.loginId, code: $('#login-code').value }),
      });
      sheet.hidden = true;
      toast(`Signed in to ${result.agent === 'claude-code' ? 'Claude' : result.agent}`);
      state.serverState = await api('/api/state');
      openSettings();
    } catch (err) {
      error.textContent = err.message;
      error.hidden = false;
    } finally {
      button.disabled = false;
      button.textContent = 'Finish signing in';
    }
  });

  for (const close of document.querySelectorAll('.login-close')) {
    close.addEventListener('click', async () => {
      const sheet = $('#login-sheet');
      sheet.hidden = true;
      // Leaving the CLI waiting on a pty forever helps nobody.
      await api('/api/login/cancel', {
        method: 'POST',
        body: JSON.stringify({ loginId: sheet.dataset.loginId }),
      }).catch(() => {});
    });
  }

  // Settings
  // Three ways in, because one of them was the bottom of a drawer nobody
  // scrolled to: the gear in the drawer header, the row in the session sheet,
  // and the original footer button.
  $('#open-settings').addEventListener('click', openSettings);
  $('#open-settings-top').addEventListener('click', () => {
    closeDrawer();
    openSettings();
  });
  $('#opt-settings').addEventListener('click', () => {
    $('#opts-sheet').hidden = true;
    openSettings();
  });

  $('#pair-another').addEventListener('click', async () => {
    const output = $('#pair-code');
    try {
      const { code, expiresIn } = await api('/api/pair/code', { method: 'POST' });
      output.textContent = `${code} — enter it on the other device within ${Math.round(expiresIn / 60)} min`;
      output.hidden = false;
    } catch (err) {
      toast(err.message);
    }
  });
  $('#unpair').addEventListener('click', () => unpair(false));
  $('#enable-notifs').addEventListener('click', async () => {
    // Browsers only expose notifications over HTTPS (or localhost), which a
    // plain-HTTP LAN address is not. Say why rather than failing silently.
    if (!window.isSecureContext || !('Notification' in window)) {
      chime();
      toast('System alerts need HTTPS — you’ll get a chime and a tab badge instead. See the README for `tailscale serve`.');
      return;
    }
    const result = await Notification.requestPermission();
    if (result === 'granted') chime();
    toast(result === 'granted' ? 'Alerts on' : 'Alerts not granted');
  });

  // Desktop keyboard shortcuts. Escape always closes the top-most sheet except
  // a permission prompt, which must be answered explicitly.
  document.addEventListener('keydown', (event) => {
    const mod = event.metaKey || event.ctrlKey;

    if (event.key === 'Escape') {
      const open = [...document.querySelectorAll('.sheet')].filter((s) => !s.hidden && s.id !== 'perm-sheet');
      if (open.length) {
        const top = open.at(-1);
        if (top.id === 'scan-sheet') closeScanner();
        else top.hidden = true;
        event.preventDefault();
        return;
      }
      if ($('#app').classList.contains('drawer-open')) closeDrawer();
      return;
    }

    if (mod && event.key.toLowerCase() === 'k') {
      event.preventDefault();
      $('#new-session').click();
      return;
    }
    if (mod && event.key === '.') {
      event.preventDefault();
      $('#stop').click();
      return;
    }
    // Answer a pending permission without reaching for the mouse.
    if (!$('#perm-sheet').hidden && mod) {
      if (event.key === 'Enter') {
        event.preventDefault();
        decide('allow');
      } else if (event.key === 'Backspace') {
        event.preventDefault();
        decide('deny');
      }
    }
  });

  // Refresh when the app comes back to the foreground.
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && state.token) {
      if (state.ws?.readyState !== WebSocket.OPEN) connect();
      else refreshSessions();
    }
  });
}

async function boot() {
  connect();
  await refreshSessions();

  try {
    state.serverState = await api('/api/state');
    // Learn the way back in before the way in stops working.
    rememberAddresses(state.serverState.urls);
  } catch {
    /* the socket will retry */
  }

  if (await openRequestedSession()) return;

  const last = localStorage.getItem(LAST_SESSION_KEY);
  if (last && state.sessions.has(last)) {
    await openSession(last, false);
  } else {
    renderHeader();
  }
}

/**
 * A #session=<id> link opens straight into a conversation — how you hand
 * yourself a pointer to one from another device. Returns true if it handled one.
 */
async function openRequestedSession() {
  const requested = new URLSearchParams(location.hash.slice(1)).get('session');
  if (!requested) return false;

  history.replaceState(null, '', location.pathname);
  try {
    await openSession(requested, !state.sessions.has(requested));
    return true;
  } catch (err) {
    toast(err.message);
    return false;
  }
}

async function main() {
  // Buttons declare their icon in markup; fill them in with real shapes.
  for (const node of document.querySelectorAll('[data-icon]')) {
    node.appendChild(icon(node.dataset.icon, { size: 18 }));
  }

  applyStaticText();
  wireUp();

  // Changing only the fragment does not reload the page, so links that arrive
  // while the app is already open have to be handled here too.
  window.addEventListener('hashchange', async () => {
    // A pairing link that arrives while the app is already open only changes
    // the fragment, which does not reload the page — so it has to be handled
    // here too, or scanning a second Mac's code from inside the app does
    // nothing at all.
    const hash = new URLSearchParams(location.hash.slice(1));
    mergeMachines(hash.get('machines'));
    const token = hash.get('token');
    if (token) {
      history.replaceState(null, '', location.pathname);
      try {
        await pair(token, defaultDeviceName());
        await enterApp({ paired: false });
        return;
      } catch (err) {
        toast(err.message);
      }
    }
    if (state.token) openRequestedSession();
  });

  // A pairing link drops the token in the fragment; consume it and clean the URL.
  const hash = new URLSearchParams(location.hash.slice(1));
  mergeMachines(hash.get('machines'));
  const hashToken = hash.get('token');
  let justPaired = false;
  if (hashToken) {
    history.replaceState(null, '', location.pathname);
    try {
      await pair(hashToken, defaultDeviceName());
      justPaired = true;
    } catch (err) {
      console.warn(err);
    }
  }

  if (!state.token) {
    showGate();
    return;
  }

  // Before the app tries to draw itself out of an API that will not answer:
  // the shell comes from the service worker's cache, so this screen opens
  // even when the address it was installed from resolves to nothing.
  if (!(await daemonReachable())) {
    $('#app').hidden = false;
    showUnreachable();
    return;
  }

  $('#app').hidden = false;
  await boot();
  if (justPaired) offerInstall();

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  }
}

main();
