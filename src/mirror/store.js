import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Feed } from '../protocol.js';
import { log } from '../log.js';
import { applyTranscriptLine, foldToolResult, isRealModel, parseLines } from './transcript.js';

const PROJECTS_DIR =
  process.env.CRC_PROJECTS_DIR || path.join(os.homedir(), '.claude', 'projects');
/** Cap how much history we replay for a huge transcript. */
const MAX_REPLAY_BYTES = 8 * 1024 * 1024;
const POLL_INTERVAL_MS = 400;

async function readSlice(file, start, length) {
  const handle = await fsp.open(file, 'r');
  try {
    const buf = Buffer.alloc(Math.max(0, length));
    const { bytesRead } = await handle.read(buf, 0, buf.length, start);
    return buf.subarray(0, bytesRead).toString('utf8');
  } finally {
    await handle.close();
  }
}

/** Cheap metadata: read the head for origin/cwd and the tail for the latest title. */
async function describeTranscript(file) {
  const stat = await fsp.stat(file);
  const sessionId = path.basename(file, '.jsonl');
  const head = await readSlice(file, 0, Math.min(stat.size, 64 * 1024));
  const tail =
    stat.size > 64 * 1024
      ? await readSlice(file, stat.size - 64 * 1024, 64 * 1024)
      : '';

  const info = {
    id: sessionId,
    kind: 'mirror',
    file,
    cwd: null,
    title: null,
    /**
     * Kept apart from `title` on purpose. A transcript carries two kinds:
     * `custom-title`, written once near the top and the name Claude Desktop
     * shows in its sidebar, and `ai-title`, regenerated over and over as the
     * conversation grows. Taking whichever came last meant the app named the
     * same conversation something else than the app it is mirroring.
     */
    customTitle: null,
    aiTitle: null,
    /** Whatever model last produced a reply here, straight from the transcript. */
    model: null,
    preview: null,
    entrypoint: null,
    version: null,
    gitBranch: null,
    lastActivityAt: stat.mtimeMs,
    sizeBytes: stat.size,
    messages: 0,
  };

  const scan = (text, isTail) => {
    const { lines } = parseLines(text.slice(isTail ? text.indexOf('\n') + 1 : 0));
    for (const line of lines) {
      if (line.cwd && !info.cwd) info.cwd = line.cwd;
      if (line.entrypoint && !info.entrypoint) info.entrypoint = line.entrypoint;
      if (line.version) info.version = line.version;
      if (line.gitBranch) info.gitBranch = line.gitBranch;
      if (line.type === 'assistant' && isRealModel(line.message?.model)) info.model = line.message.model;
      if (line.type === 'ai-title' && line.aiTitle) info.aiTitle = line.aiTitle;
      if (line.type === 'custom-title' && line.customTitle) info.customTitle = line.customTitle;
      if (!info.preview && line.type === 'user' && !line.isSidechain) {
        const c = line.message?.content;
        const text = typeof c === 'string' ? c : Array.isArray(c) ? (c.find((b) => b?.type === 'text')?.text ?? '') : '';
        if (text.trim()) info.preview = text.trim().slice(0, 140);
      }
      if (line.type === 'user' || line.type === 'assistant') info.messages += 1;
    }
  };

  scan(head, false);
  if (tail) scan(tail, true);

  // A name someone chose beats a name a model wrote, whichever came last.
  info.title =
    info.customTitle || info.aiTitle || info.preview || path.basename(info.cwd || 'session');
  return info;
}

/** One live-followed transcript. Tails the file and rebuilds a feed from it. */
class MirrorSession extends EventEmitter {
  constructor(info, config) {
    super();
    this.info = info;
    this.config = config;
    this.id = info.id;
    this.offset = 0;
    this.carry = '';
    this.watching = false;
    this.feed = new Feed({
      maxItems: config.maxFeedItems,
      onPatch: (patch) => this.emit('patch', patch),
    });
  }

  toJSON() {
    return {
      id: this.id,
      kind: 'mirror',
      title: this.info.title,
      cwd: this.info.cwd,
      origin: this.info.entrypoint || 'unknown',
      // The real one, or nothing. A guess here becomes a label that quietly
      // contradicts the app being mirrored.
      model: this.info.model,
      status: 'mirrored',
      lastActivityAt: this.info.lastActivityAt,
      claudeSessionId: this.id,
      gitBranch: this.info.gitBranch,
      version: this.info.version,
      feedLength: this.feed.seq,
      readOnly: true,
    };
  }

  async load() {
    const stat = await fsp.stat(this.info.file);
    let start = 0;
    if (stat.size > MAX_REPLAY_BYTES) {
      start = stat.size - MAX_REPLAY_BYTES;
      this.feed.append({ kind: 'system', text: 'Older history truncated' });
    }
    const chunk = await readSlice(this.info.file, start, stat.size - start);
    // A mid-file start can slice a line in half; drop the partial first line.
    const usable = start > 0 ? chunk.slice(chunk.indexOf('\n') + 1) : chunk;
    this.ingest(usable);
    this.offset = stat.size;
    return this;
  }

  ingest(chunk) {
    const { lines, remainder } = parseLines(chunk, this.carry);
    this.carry = remainder;
    for (const line of lines) {
      try {
        const meta = applyTranscriptLine(this.feed, line);
        foldToolResult(this.feed, line);
        if (meta.title) {
          if (meta.titleKind === 'custom') this.info.customTitle = meta.title;
          else this.info.aiTitle = meta.title;
          this.info.title = this.info.customTitle || this.info.aiTitle || this.info.title;
        }
        if (meta.model) this.info.model = meta.model;
        if (meta.cwd) this.info.cwd = meta.cwd;
        if (meta.entrypoint) this.info.entrypoint = meta.entrypoint;
        if (meta.lastActivityAt) this.info.lastActivityAt = meta.lastActivityAt;
      } catch (err) {
        log.debug(`mirror ${this.id}: bad line — ${err?.message}`);
      }
    }
  }

  startWatching() {
    if (this.watching) return;
    this.watching = true;
    this.listener = async (curr) => {
      if (curr.size === this.offset) return;
      if (curr.size < this.offset) {
        // File was rewritten; start over rather than emit garbage.
        this.offset = 0;
        this.carry = '';
      }
      try {
        const chunk = await readSlice(this.info.file, this.offset, curr.size - this.offset);
        this.offset = curr.size;
        this.ingest(chunk);
        this.emit('state', this.toJSON());
      } catch (err) {
        log.debug(`mirror ${this.id}: tail failed — ${err?.message}`);
      }
    };
    fs.watchFile(this.info.file, { interval: POLL_INTERVAL_MS }, this.listener);
  }

  stopWatching() {
    if (!this.watching) return;
    fs.unwatchFile(this.info.file, this.listener);
    this.watching = false;
  }
}

export class MirrorStore extends EventEmitter {
  constructor(config) {
    super();
    this.config = config;
    this.open = new Map();
  }

  get projectsDir() {
    return PROJECTS_DIR;
  }

  /** All transcripts on this machine, newest first. */
  async list({ limit = 60 } = {}) {
    if (!fs.existsSync(PROJECTS_DIR)) return [];
    const out = [];
    const projects = await fsp.readdir(PROJECTS_DIR, { withFileTypes: true });

    const files = [];
    for (const project of projects) {
      if (!project.isDirectory()) continue;
      const dir = path.join(PROJECTS_DIR, project.name);
      let entries;
      try {
        entries = await fsp.readdir(dir);
      } catch {
        continue;
      }
      for (const name of entries) {
        if (!name.endsWith('.jsonl')) continue;
        const file = path.join(dir, name);
        try {
          const stat = await fsp.stat(file);
          if (stat.size > 0) files.push({ file, mtimeMs: stat.mtimeMs });
        } catch {
          /* vanished mid-scan */
        }
      }
    }

    files.sort((a, b) => b.mtimeMs - a.mtimeMs);
    for (const { file } of files.slice(0, limit)) {
      try {
        out.push(await describeTranscript(file));
      } catch (err) {
        log.debug(`skipping ${file}: ${err?.message}`);
      }
    }
    return out;
  }

  async findFile(sessionId) {
    if (!/^[a-zA-Z0-9-]+$/.test(sessionId)) return null;
    if (!fs.existsSync(PROJECTS_DIR)) return null;
    const projects = await fsp.readdir(PROJECTS_DIR, { withFileTypes: true });
    for (const project of projects) {
      if (!project.isDirectory()) continue;
      const candidate = path.join(PROJECTS_DIR, project.name, `${sessionId}.jsonl`);
      if (fs.existsSync(candidate)) return candidate;
    }
    return null;
  }

  /** Open (or reuse) a live mirror of a desktop/CLI session. */
  async openMirror(sessionId) {
    const existing = this.open.get(sessionId);
    if (existing) return existing;

    const file = await this.findFile(sessionId);
    if (!file) throw Object.assign(new Error(`No transcript for session ${sessionId}`), { status: 404 });

    const info = await describeTranscript(file);
    const mirror = new MirrorSession(info, this.config);
    mirror.on('patch', (patch) => this.emit('patch', { sessionId, patch }));
    mirror.on('state', (state) => this.emit('state', state));
    await mirror.load();
    mirror.startWatching();
    this.open.set(sessionId, mirror);
    log.info(`mirroring session ${sessionId} (${info.entrypoint || 'unknown'})`);
    return mirror;
  }

  get(sessionId) {
    return this.open.get(sessionId) || null;
  }

  closeMirror(sessionId) {
    const mirror = this.open.get(sessionId);
    if (!mirror) return false;
    mirror.stopWatching();
    this.open.delete(sessionId);
    return true;
  }

  closeAll() {
    for (const id of [...this.open.keys()]) this.closeMirror(id);
  }
}
