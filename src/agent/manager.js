import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import { Session } from './session.js';
import { isPathAllowed, realPath } from '../config.js';
import { log } from '../log.js';

export class SessionManager extends EventEmitter {
  constructor(config) {
    super();
    this.config = config;
    this.sessions = new Map();
  }

  list() {
    return [...this.sessions.values()].map((s) => s.toJSON());
  }

  get(id) {
    return this.sessions.get(id) || null;
  }

  create({ cwd, model, permissionMode, resumeFrom, forkSession, title } = {}) {
    const limit = this.config.maxSessions ?? 8;
    if (this.sessions.size >= limit) {
      throw Object.assign(
        new Error(`Already running ${limit} sessions. End one before starting another.`),
        { status: 429 },
      );
    }

    const dir = realPath(cwd || this.config.defaultCwd);
    if (!isPathAllowed(this.config, dir)) {
      throw Object.assign(new Error(`Directory is outside the allowed roots: ${dir}`), { status: 403 });
    }
    if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
      throw Object.assign(new Error(`Not a directory: ${dir}`), { status: 400 });
    }

    const session = new Session({
      config: this.config,
      cwd: dir,
      model,
      permissionMode,
      resumeFrom,
      forkSession,
      title,
    });

    session.on('patch', (patch) => this.emit('patch', { sessionId: session.id, patch }));
    session.on('state', (state) => this.emit('state', state));
    session.on('permission', (payload) => this.emit('permission', payload));
    session.on('permissionResolved', (info) =>
      this.emit('permissionResolved', { sessionId: session.id, ...info }),
    );

    this.sessions.set(session.id, session);
    session.start();
    log.info(`session ${session.id} started in ${dir}`);
    this.emit('sessions', this.list());
    return session;
  }

  async close(id) {
    const session = this.sessions.get(id);
    if (!session) return false;
    await session.close();
    this.sessions.delete(id);
    this.emit('sessions', this.list());
    log.info(`session ${id} closed`);
    return true;
  }

  async closeAll() {
    await Promise.all([...this.sessions.keys()].map((id) => this.close(id)));
  }
}
