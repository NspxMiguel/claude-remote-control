/* Claude Remote Control — PWA client. No framework, no build step. */

import { renderMarkdown } from './markdown.js';

const $ = (sel) => document.querySelector(sel);
const el = (tag, cls, text) => {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text != null) node.textContent = text;
  return node;
};

const TOKEN_KEY = 'crc.token';
const LAST_SESSION_KEY = 'crc.lastSession';

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
};

/** Anthropic recommends no side longer than this; bigger just wastes bandwidth. */
const MAX_IMAGE_EDGE = 1568;
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

function unpair(silent) {
  localStorage.removeItem(TOKEN_KEY);
  state.token = null;
  state.ws?.close();
  $('#app').hidden = true;
  $('#gate').hidden = false;
  if (!silent) toast('Device unpaired');
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
}

// ---------------------------------------------------------------------------
// Feed rendering
// ---------------------------------------------------------------------------

const TOOL_GLYPH = {
  Bash: '›_',
  Read: '◇',
  Write: '✎',
  Edit: '✎',
  Glob: '⌕',
  Grep: '⌕',
  WebFetch: '↗',
  WebSearch: '⌕',
  Task: '⚙',
  Agent: '⚙',
};

function viewFor(sessionId) {
  let view = state.views.get(sessionId);
  if (!view) {
    view = { lastSeq: 0, nodes: new Map(), pinned: true };
    state.views.set(sessionId, view);
  }
  return view;
}

function applyItems(sessionId, items) {
  const view = viewFor(sessionId);
  const feed = $('#feed');
  const wasAtBottom = isAtBottom();

  for (const item of items) {
    if (item.seq > view.lastSeq) view.lastSeq = item.seq;

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
    insertByOrder(feed, node, item.ord);
    view.nodes.set(item.id, node);
  }

  $('#empty-state').hidden = view.nodes.size > 0;
  if (wasAtBottom || view.pinned) scrollToBottom();
  else $('#scroll-pin').hidden = false;
}

/**
 * Items re-render whenever they change — a tool card is rebuilt when its result
 * lands. Without this, a card you opened to watch would snap shut at the exact
 * moment it got interesting.
 */
function carryOverOpenState(oldNode, newNode) {
  const oldBody = oldNode.querySelector?.('.tool-body');
  const newBody = newNode.querySelector?.('.tool-body');
  if (oldBody && newBody) newBody.hidden = oldBody.hidden;

  if (oldNode.tagName === 'DETAILS' && newNode.tagName === 'DETAILS') {
    newNode.open = oldNode.open;
  }
}

/** Keep the transcript chronological even when patches arrive out of order. */
function insertByOrder(container, node, ord) {
  const children = container.children;
  for (let i = children.length - 1; i >= 0; i--) {
    const child = children[i];
    if (child.id === 'empty-state') continue;
    if (Number(child.dataset.ord || 0) <= ord) {
      child.after(node);
      return;
    }
  }
  container.prepend(node);
}

function renderItem(item) {
  switch (item.kind) {
    case 'user': {
      const bubble = el('div', 'item bubble-user', item.text || '');
      if (item.attachments) {
        const chip = el(
          'div',
          'bubble-attach',
          `🖼 ${item.attachments} image${item.attachments === 1 ? '' : 's'}`,
        );
        bubble.prepend(chip);
      }
      return withMeta(bubble, item);
    }

    case 'text': {
      if (!item.text?.trim()) return null;
      const node = el('div', `item assistant${item.streaming ? ' streaming' : ''}`);
      if (item.streaming) {
        // Mid-stream the markdown is half-written — an unclosed fence would
        // flicker, and re-parsing on every token is wasted work on a phone.
        node.textContent = item.text;
      } else {
        node.innerHTML = renderMarkdown(item.text);
      }
      return withMeta(node, item);
    }

    case 'thinking': {
      if (!item.text?.trim()) return null;
      const details = el('details', 'item thinking');
      details.appendChild(el('summary', null, 'Thinking'));
      details.appendChild(el('div', 'body', item.text));
      return withMeta(details, item);
    }

    case 'tool':
      return withMeta(renderTool(item), item);

    case 'permission': {
      if (item.state === 'pending') return null; // the sheet owns pending requests
      const label =
        item.state === 'allowed' || item.state === 'allowed_always'
          ? `Allowed ${item.title}`
          : item.state === 'denied'
            ? `Denied ${item.title}`
            : `${item.title} — ${item.state}`;
      const cls =
        item.state === 'allowed' || item.state === 'allowed_always'
          ? 'allowed'
          : item.state === 'denied'
            ? 'denied'
            : '';
      return withMeta(el('div', `item note perm-note ${cls}`, label), item);
    }

    case 'result': {
      const bits = [];
      if (item.durationMs) bits.push(`${(item.durationMs / 1000).toFixed(1)}s`);
      if (typeof item.costUsd === 'number') bits.push(`$${item.costUsd.toFixed(4)}`);
      if (item.numTurns) bits.push(`${item.numTurns} turn${item.numTurns === 1 ? '' : 's'}`);
      return withMeta(el('div', 'item note', bits.join(' · ') || 'Done'), item);
    }

    case 'error':
      return withMeta(el('div', 'item note error', item.text), item);

    case 'system':
      return withMeta(el('div', 'item note', item.text), item);

    default:
      return null;
  }
}

function withMeta(node, item) {
  node.dataset.itemId = item.id;
  decorateCodeBlocks(node);
  return node;
}

/**
 * Give every code block a copy button. Reading a command off a phone screen and
 * retyping it is exactly the friction this app exists to remove.
 */
function decorateCodeBlocks(root) {
  for (const pre of root.querySelectorAll?.('pre.code-block') ?? []) {
    if (pre.parentElement?.classList.contains('code-wrap')) continue;
    const wrap = el('div', 'code-wrap');
    pre.replaceWith(wrap);
    wrap.appendChild(pre);

    const button = el('button', 'code-copy', 'Copy');
    button.type = 'button';
    button.addEventListener('click', async (event) => {
      event.stopPropagation();
      const ok = await copyText(pre.textContent);
      button.textContent = ok ? 'Copied' : 'Failed';
      setTimeout(() => {
        button.textContent = 'Copy';
      }, 1600);
    });
    wrap.appendChild(button);
  }
}

/**
 * navigator.clipboard is unavailable over plain HTTP, which is exactly how this
 * app is served on a LAN or tailnet — so fall back to the legacy path.
 */
async function copyText(text) {
  try {
    if (navigator.clipboard?.writeText && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* fall through to the legacy path */
  }
  try {
    const area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', '');
    area.style.cssText = 'position:fixed;top:-1000px;opacity:0';
    document.body.appendChild(area);
    area.select();
    area.setSelectionRange(0, text.length);
    const ok = document.execCommand('copy');
    area.remove();
    return ok;
  } catch {
    return false;
  }
}

function renderTool(item) {
  const card = el('div', 'item tool');
  card.dataset.status = item.status || 'pending';

  const head = el('button', 'tool-head');
  head.type = 'button';
  const glyph = el('span', 'tool-icon', TOOL_GLYPH[item.name] || '•');
  const textWrap = el('div', 'tool-text');
  textWrap.appendChild(el('div', 'tool-title', item.title || item.name));
  if (item.subtitle) textWrap.appendChild(el('div', 'tool-sub', item.subtitle));

  const statusLabel = {
    building: '…',
    pending: 'queued',
    running: 'running',
    done: '✓',
    error: 'failed',
    denied: 'denied',
  }[item.status] || '';

  head.append(glyph, textWrap, el('span', 'tool-status', statusLabel));
  card.appendChild(head);

  const body = el('div', 'tool-body');
  body.hidden = true;
  renderToolBody(body, item);
  card.appendChild(body);

  head.addEventListener('click', () => {
    body.hidden = !body.hidden;
  });

  return card;
}

function renderToolBody(body, item) {
  const input = item.input || {};

  if (item.name === 'Edit' && (input.old_string || input.new_string)) {
    body.appendChild(el('p', 'label', input.file_path || 'Edit'));
    const diff = el('div', 'diff');
    for (const line of String(input.old_string || '').split('\n')) {
      diff.appendChild(el('span', 'del', `- ${line}`));
    }
    for (const line of String(input.new_string || '').split('\n')) {
      diff.appendChild(el('span', 'add', `+ ${line}`));
    }
    body.appendChild(diff);
  } else if (item.name === 'Bash' && input.command) {
    body.appendChild(el('p', 'label', 'Command'));
    body.appendChild(el('pre', 'code-block', input.command));
  } else if (item.name === 'Write' && input.content != null) {
    body.appendChild(el('p', 'label', input.file_path || 'Contents'));
    body.appendChild(el('pre', 'code-block', String(input.content).slice(0, 4000)));
  } else if (Object.keys(input).length) {
    body.appendChild(el('p', 'label', 'Input'));
    body.appendChild(el('pre', 'code-block', JSON.stringify(input, null, 2).slice(0, 4000)));
  }

  if (item.result) {
    body.appendChild(el('p', 'label', item.status === 'error' ? 'Error' : 'Output'));
    body.appendChild(el('pre', 'code-block', item.result));
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
      resolve({
        mediaType,
        data: dataUrl.slice(dataUrl.indexOf(',') + 1),
        url: dataUrl,
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

    const remove = el('button', 'attachment-remove', '✕');
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

function renderSessionList() {
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
    $('#session-title').textContent = 'No session';
    $('#session-sub').textContent = '';
    $('#composer-meta').innerHTML = '';
    setComposerEnabled(false, 'Start a session to begin');
    return;
  }

  $('#session-title').textContent = session.title || 'Session';
  const bits = [];
  if (session.cwd) bits.push(session.cwd.replace(/^\/Users\/[^/]+/, '~'));
  if (session.model) bits.push(session.model.replace(/^claude-/, ''));
  if (session.readOnly) bits.push('read-only mirror');
  $('#session-sub').textContent = bits.join(' · ');

  const busy = session.status === 'busy';
  $('#send').hidden = busy;
  $('#stop').hidden = !busy;

  const meta = $('#composer-meta');
  meta.innerHTML = '';
  if (session.readOnly) {
    meta.appendChild(el('span', null, 'Mirroring a desktop session — open “Take over” to continue it here.'));
  } else if (busy) {
    meta.appendChild(el('span', 'spinner'));
    meta.appendChild(el('span', null, 'Claude is working…'));
  } else if (typeof session.totalCostUsd === 'number' && session.totalCostUsd > 0) {
    meta.appendChild(el('span', null, `$${session.totalCostUsd.toFixed(4)} this session`));
  }

  setComposerEnabled(!session.readOnly);
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

function setComposerEnabled(enabled, disabledHint = 'Read-only mirror') {
  $('#input').disabled = !enabled;
  $('#send').disabled = !enabled;
  $('#input').placeholder = enabled ? 'Message Claude…' : disabledHint;
}

// ---------------------------------------------------------------------------
// Permissions
// ---------------------------------------------------------------------------

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

  send({ t: 'permission', sessionId, requestId, decision });
  state.permQueue = state.permQueue.filter((p) => p.requestId !== requestId);
  showNextPermission();
}

async function notifyPermission(payload) {
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  if (!document.hidden) return;
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

async function openPicker(startPath) {
  const listNode = $('#picker-list');
  const pathNode = $('#picker-path');

  const load = async (target) => {
    const data = await api(`/api/fs?path=${encodeURIComponent(target)}`);
    pathNode.textContent = data.path;
    pathNode.dataset.path = data.path;
    listNode.innerHTML = '';

    const up = el('li', null, '../');
    up.addEventListener('click', () => load(data.parent).catch((e) => toast(e.message)));
    listNode.appendChild(up);

    for (const dir of data.dirs) {
      const li = el('li');
      li.appendChild(el('span', null, dir.name));
      const row = document.createElement('span');
      row.style.marginLeft = 'auto';
      li.appendChild(row);
      li.addEventListener('click', () => load(dir.path).catch((e) => toast(e.message)));
      listNode.appendChild(li);
    }
  };

  await load(startPath);
}

async function openSettings() {
  const body = $('#settings-body');
  body.innerHTML = '';
  try {
    const data = await api('/api/state');
    state.serverState = data;

    body.appendChild(el('label', null, 'Reachable at'));
    const urls = el('div', 'url-list');
    for (const u of data.urls) {
      const row = el('div', 'url-row');
      row.appendChild(el('span', null, u.url));
      row.appendChild(el('span', 'tag', u.kind));
      urls.appendChild(row);
    }
    body.appendChild(urls);

    body.appendChild(el('label', null, 'Tailscale'));
    const ts = data.tailscale;
    body.appendChild(
      el(
        'p',
        'small muted',
        !ts
          ? 'Not installed on the host. Install Tailscale to reach this machine from outside your network.'
          : ts.running
            ? `Connected as ${ts.dnsName || ts.ips?.[0]}`
            : `Tailscale is ${ts.backendState}. Run "tailscale up" on the host.`,
      ),
    );

    if (data.devices) {
      body.appendChild(el('label', null, `Paired devices (${data.devices.length})`));
      for (const device of data.devices) {
        const row = el('div', 'device-row');
        const info = el('div');
        info.appendChild(el('div', null, device.name));
        info.appendChild(el('div', 'small muted', `last seen ${relativeTime(Date.parse(device.lastSeenAt))}`));
        row.appendChild(info);
        const revoke = el('button', null, 'Revoke');
        revoke.addEventListener('click', async () => {
          await api(`/api/devices/${device.id}`, { method: 'DELETE' });
          toast('Device revoked');
          openSettings();
        });
        row.appendChild(revoke);
        body.appendChild(row);
      }
    }

    const clients = data.connectedClients ?? 0;
    body.appendChild(
      el(
        'p',
        'small muted',
        `Daemon v${data.version} on ${data.hostname} · ${clients} client${clients === 1 ? '' : 's'} connected`,
      ),
    );
  } catch (err) {
    body.appendChild(el('p', 'error', err.message));
  }
  $('#settings-sheet').hidden = false;
}

function openSessionOptions() {
  const session = currentSession();
  if (!session) return;

  const info = $('#opts-info');
  info.innerHTML = '';
  const rows = [
    ['Directory', session.cwd || '—'],
    ['Status', session.status],
    ['Session id', (session.claudeSessionId || session.id).slice(0, 8)],
  ];
  if (session.origin) rows.push(['Started from', session.origin]);
  if (typeof session.totalCostUsd === 'number') rows.push(['Cost', `$${session.totalCostUsd.toFixed(4)}`]);
  for (const [k, v] of rows) {
    const row = el('div');
    row.appendChild(el('span', null, k));
    row.appendChild(el('span', null, String(v)));
    info.appendChild(row);
  }

  const modelSelect = $('#opt-model');
  modelSelect.innerHTML = '';
  const models = session.availableModels?.length
    ? session.availableModels
    : [
        { id: 'sonnet', name: 'Sonnet' },
        { id: 'opus', name: 'Opus' },
        { id: 'haiku', name: 'Haiku' },
      ];
  for (const model of models) {
    const opt = document.createElement('option');
    opt.value = model.id;
    opt.textContent = model.name;
    if (session.model === model.id) opt.selected = true;
    modelSelect.appendChild(opt);
  }
  $('#opt-perm').value = session.permissionMode || 'default';

  const readOnly = Boolean(session.readOnly);
  modelSelect.disabled = readOnly;
  $('#opt-perm').disabled = readOnly;
  $('#opt-takeover').hidden = !readOnly;
  $('#opt-close-session').textContent = readOnly ? 'Stop mirroring' : 'End session';

  $('#opts-sheet').hidden = false;
}

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------

function wireUp() {
  // Pairing
  $('#pair-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const errorNode = $('#pair-error');
    errorNode.hidden = true;
    try {
      await pair($('#pair-input').value, $('#pair-name').value);
      $('#gate').hidden = true;
      $('#app').hidden = false;
      await boot();
    } catch (err) {
      errorNode.textContent = err.message;
      errorNode.hidden = false;
    }
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
      toast('This is a read-only mirror. Use “Take over” to continue it.');
      return;
    }

    const images = state.pending.map(({ mediaType, data }) => ({ mediaType, data }));
    if (!send({ t: 'prompt', sessionId: state.currentId, text, images })) {
      toast('Not connected — reconnecting…');
      return;
    }
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
      if (event.target === sheet && sheet.id !== 'perm-sheet') sheet.hidden = true;
    });
  }

  // New session
  $('#new-session').addEventListener('click', async () => {
    const start = state.serverState?.defaults?.cwd || '~';
    $('#new-sheet').hidden = false;
    try {
      await openPicker(start);
    } catch (err) {
      toast(err.message);
    }
  });

  $('#create-session').addEventListener('click', async () => {
    const cwd = $('#picker-path').dataset.path;
    const button = $('#create-session');
    button.disabled = true;
    try {
      const { session } = await api('/api/sessions', {
        method: 'POST',
        body: JSON.stringify({
          cwd,
          model: $('#new-model').value,
          permissionMode: $('#new-perm').value,
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

  // Settings
  $('#open-settings').addEventListener('click', openSettings);

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
    if (!('Notification' in window)) return toast('Notifications are unsupported here');
    const result = await Notification.requestPermission();
    toast(result === 'granted' ? 'Alerts on' : 'Alerts not granted');
  });

  // Desktop keyboard shortcuts. Escape always closes the top-most sheet except
  // a permission prompt, which must be answered explicitly.
  document.addEventListener('keydown', (event) => {
    const mod = event.metaKey || event.ctrlKey;

    if (event.key === 'Escape') {
      const open = [...document.querySelectorAll('.sheet')].filter((s) => !s.hidden && s.id !== 'perm-sheet');
      if (open.length) {
        open.at(-1).hidden = true;
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
  wireUp();

  // Changing only the fragment does not reload the page, so links that arrive
  // while the app is already open have to be handled here too.
  window.addEventListener('hashchange', () => {
    if (state.token) openRequestedSession();
  });

  // A pairing link drops the token in the fragment; consume it and clean the URL.
  const hash = new URLSearchParams(location.hash.slice(1));
  const hashToken = hash.get('token');
  if (hashToken) {
    history.replaceState(null, '', location.pathname);
    try {
      await pair(hashToken, defaultDeviceName());
    } catch (err) {
      console.warn(err);
    }
  }

  if (!state.token) {
    $('#gate').hidden = false;
    return;
  }

  $('#app').hidden = false;
  await boot();

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  }
}

main();
