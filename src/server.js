import fs from 'node:fs';
import fsp from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';

import { Auth, clientIp, extractToken } from './auth.js';
import { isPathAllowed, realPath, saveConfig } from './config.js';
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
    if (this.auth.isLockedOut(ip)) {
      socket.write('HTTP/1.1 429 Too Many Requests\r\n\r\n');
      socket.destroy();
      return;
    }
    const identity = this.auth.verify(extractToken(req, url));
    if (!identity) {
      this.auth.recordFailure(ip);
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }
    this.auth.clearFailures(ip);
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
    const payload = JSON.stringify(message);
    for (const [ws, state] of this.clients) {
      if (ws.readyState !== ws.OPEN) continue;
      // Feed patches only go to clients watching that session; state is global.
      if (sessionId && !state.subscribed.has(sessionId)) continue;
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
    if (this.auth.isLockedOut(ip)) {
      throw Object.assign(new Error('Too many failed attempts. Try again later.'), { status: 429 });
    }
    const identity = this.auth.verify(extractToken(req, url));
    if (!identity) {
      this.auth.recordFailure(ip);
      throw Object.assign(new Error('Unauthorized'), { status: 401 });
    }
    this.auth.clearFailures(ip);
    return identity;
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
      json(res, 200, { token: device.token, device: { id: device.id, name: device.name } });
      return;
    }

    if (route === 'health' && method === 'GET') {
      json(res, 200, { ok: true, version: PKG.version });
      return;
    }

    const identity = this.requireAuth(req, url);

    // --- state ---------------------------------------------------------------------
    if (route === 'state' && method === 'GET') {
      const { urls, tailscale } = await reachableUrls(this.config.port);
      const { detectDrivers } = await import('./agent/drivers/index.js');
      json(res, 200, {
        agents: await detectDrivers(this.config),
        version: PKG.version,
        hostname: os.hostname(),
        connectedClients: this.clients.size,
        identity: identity.kind,
        urls,
        tailscale,
        sessions: this.sessions.list(),
        defaults: {
          cwd: this.config.defaultCwd,
          model: this.config.defaultModel,
          permissionMode: this.config.defaultPermissionMode,
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
        permissionMode: body.permissionMode,
        resumeFrom: body.resumeFrom,
        forkSession: body.forkSession !== false,
        title: body.title,
        driver: body.agent,
      });
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
      if (action === 'permission-mode' && method === 'POST') {
        const body = await readJsonBody(req);
        await session.setPermissionMode(body.mode);
        json(res, 200, { session: session.toJSON() });
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

    const mirrorMatch = route.match(/^transcripts\/([^/]+)\/mirror$/);
    if (mirrorMatch && method === 'POST') {
      const mirror = await this.mirrors.openMirror(mirrorMatch[1]);
      json(res, 200, { session: mirror.toJSON() });
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
        log.info(`credentials set for ${agentId}`);
        json(res, 200, { credential: described });
        return;
      }
      if (method === 'DELETE') {
        const cleared = clearCredential(this.config, agentId);
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
      for (const key of ['defaultCwd', 'defaultModel', 'defaultPermissionMode']) {
        if (body[key] !== undefined) this.config[key] = body[key];
      }
      saveConfig(this.config);
      json(res, 200, { ok: true });
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
