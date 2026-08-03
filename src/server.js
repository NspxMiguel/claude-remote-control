import fs from 'node:fs';
import fsp from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';

import { Auth, clientIp, extractToken } from './auth.js';
import { isPathAllowed, PERMISSION_MODES, realPath, saveConfig } from './config.js';
import { EFFORT_LEVELS, isEffort } from './effort.js';
import { SessionManager } from './agent/manager.js';
import { MirrorStore } from './mirror/store.js';
import { reachableUrls } from './net.js';
import { log } from './log.js';

const WEB_DIR = fileURLToPath(new URL('../web/', import.meta.url));
const PKG = JSON.parse(fs.readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8'));

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

/**
 * Permission modes come from a phone, so they get checked here rather than
 * trusted. An unrecognised mode reaching an agent is worse than a 400: most
 * treat it as "ask about everything", which is precisely what someone setting
 * a mode by hand is trying to get away from.
 */
/** Same idea as the permission mode: an unknown level must not reach an agent. */
function checkEffort(effort) {
  if (effort === undefined || effort === null || effort === '') return undefined;
  if (!isEffort(effort)) {
    throw Object.assign(
      new Error(`Unknown effort: ${effort}. Use one of ${EFFORT_LEVELS.join(', ')}.`),
      { status: 400 },
    );
  }
  return effort;
}

function checkPermissionMode(mode) {
  if (mode === undefined || mode === null) return undefined;
  if (!PERMISSION_MODES.includes(mode)) {
    throw Object.assign(
      new Error(`Unknown permission mode: ${mode}. Use one of ${PERMISSION_MODES.join(', ')}.`),
      { status: 400 },
    );
  }
  return mode;
}

const json = (res, status, body) => {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  res.end(payload);
};

async function readJsonBody(req, limit = 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw Object.assign(new Error('Payload too large'), { status: 413 });
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw Object.assign(new Error('Invalid JSON body'), { status: 400 });
  }
}

export class RemoteControlServer {
  constructor(config) {
    this.config = config;
    this.auth = new Auth(config);
    this.sessions = new SessionManager(config);
    this.mirrors = new MirrorStore(config);
    /** ws -> { subscribed:Set<string>, identity } */
    this.clients = new Map();

    this.sessions.on('patch', ({ sessionId, patch }) =>
      this.broadcast({ t: 'patch', sessionId, ...patch }, sessionId),
    );
    this.sessions.on('state', (state) => this.broadcast({ t: 'session', session: state }));
    this.sessions.on('sessions', () => this.broadcastSessions());
    this.sessions.on('permission', (payload) => this.broadcast({ t: 'permission', payload }));
    this.sessions.on('permissionResolved', (info) => this.broadcast({ t: 'permissionResolved', ...info }));

    this.mirrors.on('patch', ({ sessionId, patch }) =>
      this.broadcast({ t: 'patch', sessionId, ...patch }, sessionId),
    );
    this.mirrors.on('state', (state) => this.broadcast({ t: 'session', session: state }));

    this.server = http.createServer((req, res) => this.handle(req, res));
    // Big enough for a few base64 photos, small enough to bound memory.
    this.wss = new WebSocketServer({ noServer: true, maxPayload: 24 * 1024 * 1024 });
    this.server.on('upgrade', (req, socket, head) => this.handleUpgrade(req, socket, head));

    this.sweeper = setInterval(() => {
      this.auth.sweepPairingCodes();
      this.sweepIdleMirrors();
    }, 60_000);
    this.sweeper.unref?.();
  }

  listen() {
    return new Promise((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(this.config.port, this.config.host, () => resolve(this.server.address()));
    });
  }

  async close() {
    clearInterval(this.sweeper);
    clearInterval(this.heartbeat);
    // Hand back the sleep settings we took. Closed-lid mode is a system-wide
    // flag: left set by a daemon that is no longer running, it becomes a Mac
    // that never sleeps and nothing on screen to say why.
    const { closedLid, keepAwake } = await import('./setup.js');
    await closedLid.shutdown();
    keepAwake.disable();
    this.mirrors.closeAll();
    await this.sessions.closeAll();
    for (const ws of this.clients.keys()) ws.close(1001, 'Server shutting down');
    await new Promise((resolve) => this.server.close(resolve));
  }

  // ---- websocket ------------------------------------------------------------------

  handleUpgrade(req, socket, head) {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname !== '/ws') {
      socket.destroy();
      return;
    }
    const ip = clientIp(req);
    if (this.auth.isLockedOut(ip, 'auth')) {
      socket.write('HTTP/1.1 429 Too Many Requests\r\n\r\n');
      socket.destroy();
      return;
    }
    const identity = this.auth.verify(extractToken(req, url));
    if (!identity) {
      this.auth.recordFailure(ip, 'auth');
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }
    this.auth.clearFailures(ip, 'auth');
    this.wss.handleUpgrade(req, socket, head, (ws) => this.onConnection(ws, identity));
  }

  onConnection(ws, identity) {
    this.clients.set(ws, { subscribed: new Set(), identity });
    ws.isAlive = true;
    ws.on('pong', () => {
      ws.isAlive = true;
    });

    ws.send(
      JSON.stringify({
        t: 'hello',
        version: PKG.version,
        sessions: this.sessions.list(),
        identity: identity.kind,
      }),
    );

    ws.on('message', async (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      try {
        await this.onClientMessage(ws, msg);
      } catch (err) {
        ws.send(JSON.stringify({ t: 'error', message: err?.message || 'Request failed' }));
      }
    });

    ws.on('close', () => this.clients.delete(ws));
    ws.on('error', () => this.clients.delete(ws));
  }

  async onClientMessage(ws, msg) {
    const state = this.clients.get(ws);
    if (!state) return;

    switch (msg.t) {
      case 'subscribe': {
        state.subscribed.add(msg.sessionId);
        const feed = await this.feedFor(msg.sessionId, msg.since || 0);
        ws.send(JSON.stringify({ t: 'feed', sessionId: msg.sessionId, ...feed }));
        break;
      }
      case 'unsubscribe':
        state.subscribed.delete(msg.sessionId);
        // The mirror behind it holds a file poller and a feed. Waiting for the
        // next sweep meant browsing the session list left a watcher running
        // for every transcript you glanced at, for up to a minute each.
        this.sweepIdleMirrors();
        break;
      case 'prompt': {
        const session = this.sessions.get(msg.sessionId);
        if (!session) throw new Error('Session not found (or it is a read-only mirror)');
        session.send(msg.text, msg.images);
        break;
      }
      case 'interrupt': {
        const session = this.sessions.get(msg.sessionId);
        if (session) await session.interrupt();
        break;
      }
      case 'permission': {
        const session = this.sessions.get(msg.sessionId);
        if (session) session.decidePermission(msg.requestId, msg);
        break;
      }
      case 'ping':
        ws.send(JSON.stringify({ t: 'pong' }));
        break;
      default:
        log.debug('unknown ws message', msg.t);
    }
  }

  broadcast(message, sessionId) {
    // Serialised only once a real recipient is found. A session left running
    // with the phone away used to stringify every patch — megabytes over one
    // long answer — for nobody, which is exactly the case this app exists for.
    if (this.clients.size === 0) return;
    let payload;
    for (const [ws, state] of this.clients) {
      if (ws.readyState !== ws.OPEN) continue;
      // Feed patches only go to clients watching that session; state is global.
      if (sessionId && !state.subscribed.has(sessionId)) continue;
      payload ??= JSON.stringify(message);
      ws.send(payload);
    }
  }

  broadcastSessions() {
    this.broadcast({ t: 'sessions', sessions: this.sessions.list() });
  }

  startHeartbeat() {
    this.heartbeat = setInterval(() => {
      for (const ws of this.clients.keys()) {
        if (ws.isAlive === false) {
          ws.terminate();
          continue;
        }
        ws.isAlive = false;
        try {
          ws.ping();
        } catch {
          /* socket already gone */
        }
      }
    }, 30_000);
    this.heartbeat.unref?.();
  }

  /**
   * Each open mirror holds a file watcher and a feed in memory. Once nobody is
   * watching one, let it go — otherwise browsing the session list all evening
   * leaves a watcher behind for every transcript opened.
   */
  sweepIdleMirrors() {
    const watched = new Set();
    for (const state of this.clients.values()) {
      for (const id of state.subscribed) watched.add(id);
    }
    for (const id of [...this.mirrors.open.keys()]) {
      if (!watched.has(id)) {
        this.mirrors.closeMirror(id);
        log.debug(`mirror ${id} closed — no subscribers`);
      }
    }
  }

  async feedFor(sessionId, since) {
    const session = this.sessions.get(sessionId);
    if (session) return { items: session.feed.snapshot(since), state: session.toJSON() };
    const mirror = this.mirrors.get(sessionId) || (await this.mirrors.openMirror(sessionId));
    return { items: mirror.feed.snapshot(since), state: mirror.toJSON() };
  }

  // ---- http -----------------------------------------------------------------------

  async handle(req, res) {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    try {
      if (url.pathname.startsWith('/api/')) {
        await this.handleApi(req, res, url);
        return;
      }
      await this.serveStatic(req, res, url);
    } catch (err) {
      const status = err?.status || 500;
      if (status >= 500) log.error(`${req.method} ${url.pathname}:`, err?.message);
      json(res, status, { error: err?.message || 'Internal error' });
    }
  }

  requireAuth(req, url) {
    const ip = clientIp(req);
    if (this.auth.isLockedOut(ip, 'auth')) {
      throw Object.assign(new Error('Too many failed attempts. Try again later.'), { status: 429 });
    }
    const identity = this.auth.verify(extractToken(req, url));
    if (!identity) {
      this.auth.recordFailure(ip, 'auth');
      throw Object.assign(new Error('Unauthorized'), { status: 401 });
    }
    this.auth.clearFailures(ip, 'auth');
    return identity;
  }

  /**
   * Remember an answer for a while.
   *
   * The expensive routes here are expensive because they shell out — tailscale
   * status, agy --version, pmset, the keychain. A phone that reconnects, or a
   * settings screen that saves twice, should not fork a dozen processes to be
   * told the same thing.
   */
  memo(key, ttlMs, build) {
    this.memos ||= new Map();
    const hit = this.memos.get(key);
    const now = Date.now();
    if (hit && now - hit.at < ttlMs) return hit.value;
    const value = Promise.resolve(build()).catch((err) => {
      this.memos.delete(key); // a failure must not be cached
      throw err;
    });
    this.memos.set(key, { at: now, value });
    return value;
  }

  /** Drop what the machine reports about itself, after something changed it. */
  forgetMachineState() {
    this.memos?.delete('machine');
    this.memos?.delete('setup');
  }

  async machineState() {
    return this.memo('machine', 15_000, async () => {
      const [reach, { detectDrivers }] = await Promise.all([
        reachableUrls(this.config.port, this.config.host),
        import('./agent/drivers/index.js'),
      ]);
      return { ...reach, agents: await detectDrivers(this.config) };
    });
  }

  /** The unauthenticated readiness summary, recomputed at most every 15s. */
  async hello() {
    const { tailscale, localOnly, agents } = await this.machineState();
    return {
      ok: true,
      version: PKG.version,
      hostname: os.hostname(),
      port: this.config.port,
      tailscale: Boolean(tailscale?.running),
      localOnly: Boolean(localOnly),
      agents: agents.map(({ id, label, available }) => ({ id, label, available })),
    };
  }

  async handleApi(req, res, url) {
    const route = url.pathname.slice(5);
    const method = req.method;

    // Pairing is the one unauthenticated endpoint; it needs a code or the master token.
    if (route === 'pair' && method === 'POST') {
      const body = await readJsonBody(req);
      const ip = clientIp(req);
      if (this.auth.isLockedOut(ip)) throw Object.assign(new Error('Too many attempts'), { status: 429 });

      const viaToken = body.token && this.auth.verify(body.token);
      const viaCode = body.code && this.auth.consumePairingCode(String(body.code));
      if (!viaToken && !viaCode) {
        this.auth.recordFailure(ip);
        throw Object.assign(new Error('Invalid pairing code or token'), { status: 401 });
      }
      this.auth.clearFailures(ip);
      const device = this.auth.registerDevice({
        name: body.name,
        userAgent: req.headers['user-agent'],
      });
      // The hostname rides along so a phone paired with several Macs can name
      // them apart in its own list.
      json(res, 200, {
        token: device.token,
        hostname: os.hostname(),
        device: { id: device.id, name: device.name },
      });
      return;
    }

    if (route === 'health' && method === 'GET') {
      json(res, 200, { ok: true, version: PKG.version });
      return;
    }

    // What the setup screen shows before anyone has a token: enough to tell
    // someone their Mac is ready, and nothing a stranger on the network could
    // use. No detail strings — those carry paths and the signed-in address —
    // and no device list. Answered from a short cache so an unauthenticated
    // route cannot be used to make this Mac run driver probes in a loop.
    if (route === 'hello' && method === 'GET') {
      json(res, 200, await this.hello());
      return;
    }

    const identity = this.requireAuth(req, url);

    // --- state ---------------------------------------------------------------------
    if (route === 'state' && method === 'GET') {
      const { urls, tailscale, localOnly, agents } = await this.machineState();
      json(res, 200, {
        agents,
        version: PKG.version,
        hostname: os.hostname(),
        connectedClients: this.clients.size,
        identity: identity.kind,
        urls,
        tailscale,
        localOnly,
        boundTo: this.config.host,
        sessions: this.sessions.list(),
        defaults: {
          cwd: this.config.defaultCwd,
          model: this.config.defaultModel,
          permissionMode: this.config.defaultPermissionMode,
          effort: this.config.defaultEffort,
          allowedRoots: this.config.allowedRoots,
        },
        // Tokens are never included. Any paired device can already run commands
        // as you — including reading the config — so hiding the device list from
        // one would be theatre, while being able to revoke a lost phone from the
        // phone in your hand is genuinely useful.
        devices: this.config.devices.map(({ token, ...rest }) => rest),
      });
      return;
    }

    // --- sessions ------------------------------------------------------------------
    if (route === 'sessions' && method === 'GET') {
      json(res, 200, { sessions: this.sessions.list() });
      return;
    }

    if (route === 'sessions' && method === 'POST') {
      const body = await readJsonBody(req);
      const session = this.sessions.create({
        cwd: body.cwd,
        model: body.model,
        permissionMode: checkPermissionMode(body.permissionMode),
        effort: checkEffort(body.effort),
        resumeFrom: body.resumeFrom,
        forkSession: body.forkSession !== false,
        title: body.title,
        driver: body.agent,
      });

      // Resuming a conversation should show the conversation. The agent picks
      // up where it left off either way, but nothing replays the history into
      // a fresh feed, so without this you carry on talking to a blank screen.
      if (body.resumeFrom) {
        const file = await this.mirrors.findFile(body.resumeFrom);
        if (file) {
          session.replaying = true;
          try {
            const { replayTranscriptInto } = await import('./mirror/store.js');
            await replayTranscriptInto(file, session.feed);
          } catch (err) {
            log.debug(`resume replay failed: ${err?.message}`);
          } finally {
            session.replaying = false;
          }
        }
      }

      json(res, 201, { session: session.toJSON() });
      return;
    }

    const sessionMatch = route.match(/^sessions\/([^/]+)(?:\/(.+))?$/);
    if (sessionMatch) {
      const [, id, action] = sessionMatch;

      if (!action && method === 'DELETE') {
        const closed = (await this.sessions.close(id)) || this.mirrors.closeMirror(id);
        json(res, 200, { closed });
        return;
      }

      if (action === 'feed' && method === 'GET') {
        const since = Number(url.searchParams.get('since') || 0);
        json(res, 200, await this.feedFor(id, since));
        return;
      }

      const session = this.sessions.get(id);
      if (!session) throw Object.assign(new Error('Session not found'), { status: 404 });

      if (action === 'message' && method === 'POST') {
        // Images arrive as base64, so allow a bigger body than the default.
        const body = await readJsonBody(req, 24 * 1024 * 1024);
        const ok = session.send(body.text, body.images);
        json(res, ok ? 202 : 400, { accepted: ok });
        return;
      }
      if (action === 'interrupt' && method === 'POST') {
        json(res, 200, { interrupted: await session.interrupt() });
        return;
      }
      if (action === 'model' && method === 'POST') {
        const body = await readJsonBody(req);
        await session.setModel(body.model);
        json(res, 200, { session: session.toJSON() });
        return;
      }
      if (action === 'effort' && method === 'POST') {
        const body = await readJsonBody(req);
        await session.setEffort(checkEffort(body.effort) || null);
        json(res, 200, { session: session.toJSON() });
        return;
      }
      if (action === 'permission-mode' && method === 'POST') {
        const body = await readJsonBody(req);
        await session.setPermissionMode(checkPermissionMode(body.mode));
        json(res, 200, { session: session.toJSON() });
        return;
      }
      const queuedMatch = action?.match(/^queue\/(.+)$/);
      if (queuedMatch && method === 'DELETE') {
        json(res, 200, { cancelled: session.cancelQueued(decodeURIComponent(queuedMatch[1])) });
        return;
      }

      if (action === 'permission' && method === 'POST') {
        const body = await readJsonBody(req);
        const ok = session.decidePermission(body.requestId, body);
        json(res, ok ? 200 : 404, { ok });
        return;
      }
    }

    // --- transcripts (desktop / CLI sessions) --------------------------------------
    if (route === 'transcripts' && method === 'GET') {
      const list = await this.mirrors.list({ limit: Number(url.searchParams.get('limit') || 60) });
      json(res, 200, { transcripts: list });
      return;
    }

    // Better names for the conversations whose own name is a wall of text.
    if (route === 'transcripts/rename' && method === 'POST') {
      const { suggestTitles, MAX_BATCH } = await import('./rename.js');
      const list = await this.mirrors.list({ limit: 60 });

      // Only the ones that need it: a conversation Claude Code already named
      // reads fine, and asking for a new name would just churn the sidebar.
      const needy = list
        .filter((t) => !t.titleOverridden && !t.customTitle && !t.aiTitle && t.preview)
        .slice(0, MAX_BATCH);
      if (!needy.length) {
        json(res, 200, { renamed: 0, considered: 0 });
        return;
      }

      const titles = await suggestTitles(this.config, needy);
      if (Object.keys(titles).length) {
        this.config.titleOverrides = { ...this.config.titleOverrides, ...titles };
        saveConfig(this.config);
        // A mirror already open is holding the old name.
        for (const [id, title] of Object.entries(titles)) {
          const mirror = this.mirrors.get(id);
          if (!mirror) continue;
          mirror.info.title = title;
          mirror.info.titleOverridden = true;
          this.broadcast({ t: 'session', session: mirror.toJSON() });
        }
      }
      json(res, 200, { renamed: Object.keys(titles).length, considered: needy.length });
      return;
    }

    const mirrorMatch = route.match(/^transcripts\/([^/]+)\/mirror$/);
    if (mirrorMatch && method === 'POST') {
      const mirror = await this.mirrors.openMirror(mirrorMatch[1]);
      json(res, 200, { session: mirror.toJSON() });
      return;
    }

    // An image the agent read, served from the transcript rather than carried
    // through the feed — the base64 for one screenshot is a quarter of a
    // megabyte, and it would travel on every reconnect.
    const imageMatch = route.match(/^transcripts\/([^/]+)\/images\/([A-Za-z0-9_-]+)$/);
    if (imageMatch && method === 'GET') {
      const picture = this.mirrors.get(decodeURIComponent(imageMatch[1]))?.images.get(imageMatch[2]);
      if (!picture) throw Object.assign(new Error('No such image'), { status: 404 });
      const bytes = picture.bytes;
      res.writeHead(200, {
        'content-type': picture.mediaType,
        'content-length': bytes.length,
        // The id is content-addressed by the tool call, so it never changes.
        'cache-control': 'private, max-age=86400',
      });
      res.end(bytes);
      return;
    }

    // --- filesystem picker ----------------------------------------------------------
    if (route === 'fs' && method === 'GET') {
      // realPath first: a symlink inside an allowed root must not lead out of it.
      const target = realPath(url.searchParams.get('path') || this.config.defaultCwd);
      if (!isPathAllowed(this.config, target)) {
        throw Object.assign(new Error('Path outside allowed roots'), { status: 403 });
      }
      const entries = await fsp.readdir(target, { withFileTypes: true });
      const dirs = entries
        .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
        .map((e) => ({ name: e.name, path: path.join(target, e.name) }))
        .sort((a, b) => a.name.localeCompare(b.name));
      json(res, 200, {
        path: target,
        parent: path.dirname(target),
        dirs,
        isGitRepo: fs.existsSync(path.join(target, '.git')),
      });
      return;
    }

    // --- device management (master token only) --------------------------------------
    // --- setup tasks ------------------------------------------------------------------
    if (route === 'setup' && method === 'GET') {
      const { checkTasks, closedLid, keepAwake, suggestedRoots } = await import('./setup.js');
      json(res, 200, {
        // Seven processes to answer "is Homebrew there". Cached briefly; the
        // switches below it are not, since those reflect something you just
        // flipped and have to read back true.
        tasks: await this.memo('setup', 30_000, checkTasks),
        keepAwake: keepAwake.toJSON(),
        closedLid: await closedLid.state(),
        suggestedRoots: suggestedRoots(),
        defaultCwd: this.config.defaultCwd,
        allowedRoots: this.config.allowedRoots,
      });
      return;
    }

    if (route === 'setup/terminal' && method === 'POST') {
      const body = await readJsonBody(req);
      const { TASKS, closedLid, openInTerminal } = await import('./setup.js');
      // Only the commands this app itself suggests — never an arbitrary string
      // from a client, which would make this an execution endpoint.
      const known = [
        ...Object.values(TASKS).map((task) => task.manual),
        (await closedLid.state()).setupCommand,
      ].filter(Boolean);
      if (!known.includes(body.command)) {
        throw Object.assign(new Error('Unknown setup command.'), { status: 400 });
      }
      json(res, 200, await openInTerminal(body.command));
      return;
    }

    const setupMatch = route.match(/^setup\/([^/]+)$/);
    if (setupMatch && method === 'POST') {
      const { runTask } = await import('./setup.js');
      const task = await runTask(setupMatch[1]);
      // Running one is precisely how the checklist stops being true.
      this.forgetMachineState();
      json(res, 200, { task });
      return;
    }

    if (route === 'setup/closed-lid' && method === 'PUT') {
      const body = await readJsonBody(req);
      const { closedLid } = await import('./setup.js');
      json(res, 200, { closedLid: await closedLid.set(Boolean(body.enabled)) });
      return;
    }

    if (route === 'setup/keep-awake' && method === 'PUT') {
      const body = await readJsonBody(req);
      const { keepAwake } = await import('./setup.js');
      if (body.enabled) keepAwake.enable();
      else keepAwake.disable();
      json(res, 200, { keepAwake: keepAwake.toJSON() });
      return;
    }

    if (route === 'setup/default-cwd' && method === 'PUT') {
      const body = await readJsonBody(req);
      const target = realPath(body.path || '');
      if (!fs.existsSync(target) || !fs.statSync(target).isDirectory()) {
        throw Object.assign(new Error(`Not a directory: ${target}`), { status: 400 });
      }
      // Choosing a project folder outside the allowed roots should widen them,
      // not fail — the point of the setting is to say "work here".
      if (!isPathAllowed(this.config, target)) this.config.allowedRoots.push(target);
      this.config.defaultCwd = target;
      saveConfig(this.config);
      json(res, 200, { defaultCwd: target, allowedRoots: this.config.allowedRoots });
      return;
    }

    // --- signing in -------------------------------------------------------------------
    const loginMatch = route.match(/^agents\/([^/]+)\/login$/);
    if (loginMatch && method === 'POST') {
      const { startLogin } = await import('./agent/login.js');
      json(res, 200, await startLogin(this.config, loginMatch[1]));
      return;
    }

    if (route === 'login/complete' && method === 'POST') {
      const body = await readJsonBody(req);
      const { completeLogin } = await import('./agent/login.js');
      json(res, 200, await completeLogin(this.config, body.loginId, body.code));
      return;
    }

    if (route === 'login/cancel' && method === 'POST') {
      const body = await readJsonBody(req);
      const { cancelLogin } = await import('./agent/login.js');
      json(res, 200, { cancelled: cancelLogin(body.loginId) });
      return;
    }

    // --- agent credentials ----------------------------------------------------------
    const credentialMatch = route.match(/^agents\/([^/]+)\/credentials$/);
    if (credentialMatch) {
      const { setCredential, clearCredential, describeCredential } = await import(
        './agent/credentials.js'
      );
      const agentId = credentialMatch[1];

      if (method === 'POST') {
        const body = await readJsonBody(req);
        const described = setCredential(this.config, agentId, body.apiKey);
        // Whether an agent is signed in is part of what the machine reports,
        // and this is the moment it changed.
        this.forgetMachineState();
        log.info(`credentials set for ${agentId}`);
        json(res, 200, { credential: described });
        return;
      }
      if (method === 'DELETE') {
        const cleared = clearCredential(this.config, agentId);
        this.forgetMachineState();
        json(res, 200, { cleared, credential: describeCredential(this.config, agentId) });
        return;
      }
    }

    if (route === 'pair/code' && method === 'POST') {
      json(res, 200, this.auth.createPairingCode());
      return;
    }

    const deviceMatch = route.match(/^devices\/([^/]+)$/);
    if (deviceMatch && method === 'DELETE') {
      const revoked = this.auth.revokeDevice(deviceMatch[1]);
      // Revoking yourself is allowed — it is how "sign out everywhere" works.
      json(res, 200, { revoked, self: identity.device?.id === deviceMatch[1] });
      return;
    }

    if (route === 'settings' && method === 'POST') {
      const body = await readJsonBody(req);
      checkPermissionMode(body.defaultPermissionMode);
      checkEffort(body.defaultEffort);
      for (const key of ['defaultCwd', 'defaultModel', 'defaultPermissionMode', 'defaultEffort']) {
        if (body[key] !== undefined) this.config[key] = body[key];
      }
      saveConfig(this.config);

      // A default that only applies to sessions you have not started yet is a
      // strange kind of default when the point is to stop being interrupted.
      let applied = 0;
      if (body.applyToOpenSessions && body.defaultPermissionMode !== undefined) {
        applied = await this.sessions.setPermissionModeAll(body.defaultPermissionMode);
      }
      json(res, 200, { ok: true, applied });
      return;
    }

    throw Object.assign(new Error(`No route for ${method} ${url.pathname}`), { status: 404 });
  }

  async serveStatic(req, res, url) {
    let rel = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
    // Single-page app: unknown paths fall back to the shell.
    let file = path.join(WEB_DIR, rel);
    if (!file.startsWith(WEB_DIR)) throw Object.assign(new Error('Forbidden'), { status: 403 });
    if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      rel = 'index.html';
      file = path.join(WEB_DIR, rel);
    }

    const ext = path.extname(file);
    const stat = await fsp.stat(file);
    // Revalidate everything but the icons: the daemon is local, so a 304 costs
    // nothing, and a stale app.js after an upgrade is a real support problem.
    const etag = `W/"${stat.size.toString(16)}-${stat.mtimeMs.toString(16)}"`;
    const cacheControl = rel.startsWith('icons/') ? 'public, max-age=86400' : 'no-cache';

    if (req.headers['if-none-match'] === etag) {
      res.writeHead(304, { etag, 'cache-control': cacheControl });
      res.end();
      return;
    }

    const body = await fsp.readFile(file);
    res.writeHead(200, {
      'content-type': MIME[ext] || 'application/octet-stream',
      'content-length': body.length,
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'no-referrer',
      etag,
      'cache-control': cacheControl,
    });
    res.end(req.method === 'HEAD' ? undefined : body);
  }
}
