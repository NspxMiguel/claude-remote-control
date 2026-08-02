/* Claude Remote Control — PWA client. No framework, no build step. */

import { el, $ } from './dom.js';
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
function viewFor(sessionId) {
  let view = state.views.get(sessionId);
  if (!view) {
    view = { lastSeq: 0, nodes: new Map(), groups: new Map(), pinned: true };
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

  $('#empty-state').hidden = view.nodes.size > 0;
  if (wasAtBottom || view.pinned) scrollToBottom();
  else $('#scroll-pin').hidden = false;
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
  // Only name the agent when it is not the default, to keep the line short.
  if (session.agent && session.agent !== 'claude-code') bits.push(session.agentLabel || session.agent);
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
 * Sign an agent in from the phone. Every agent here normally authenticates in a
 * terminal on the host, which is exactly what you do not have when you are away
 * from it — so an API key can be pasted instead, and the login command is shown
 * for when you do get back to a keyboard.
 */
function renderAgentSettings(agents) {
  const container = $('#agents-body');
  container.innerHTML = '';
  if (!agents.length) return;

  container.appendChild(el('label', null, 'Agents'));

  for (const agent of agents) {
    const row = el('div', 'agent-row');

    const head = el('div', 'agent-head');
    head.appendChild(el('i', `dot ${agent.available ? 'idle' : 'error'}`));
    head.appendChild(el('span', 'agent-name', agent.label));
    head.appendChild(el('span', 'agent-state', agent.available ? 'ready' : agent.detail || 'unavailable'));
    row.appendChild(head);

    const credential = agent.credential;
    if (credential) {
      if (credential.set) {
        const stored = el('div', 'agent-key');
        stored.appendChild(el('span', 'small muted', `${credential.label}: ${credential.hint}`));
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
        row.appendChild(stored);
      } else {
        row.appendChild(el('p', 'small muted', credential.loginHint));

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
        row.appendChild(form);
      }
    } else if (!agent.available && agent.fix) {
      row.appendChild(el('p', 'small muted', agent.fix));
    }

    container.appendChild(row);
  }
}

/**
 * Offer the agents that are actually installed. One that is missing still
 * appears, disabled, with the command that installs it — more useful than
 * pretending the app only ever supported one.
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
  const missing = [];
  if (!agent.capabilities?.permissions) missing.push('cannot ask before running tools');
  if (!agent.capabilities?.images) missing.push('no image attachments');
  if (!agent.capabilities?.models) missing.push('no model switching');
  note.textContent = missing.length ? `Note: ${missing.join(', ')}.` : '';
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

    renderAgentSettings(data.agents || []);
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
