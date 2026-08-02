import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { Feed, summarizeTool } from '../protocol.js';
import { log } from '../log.js';

/**
 * Variables the Claude Code harness injects into its own child shells. If the
 * daemon happens to be launched from inside a Claude Code session, inheriting
 * these makes the spawned CLI try to authenticate against the *host* session's
 * proxy and fail. Strip them so sessions always use the machine's own login.
 */
const HOST_SESSION_ENV = [
  'CLAUDECODE',
  'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDE_CODE_SESSION_ID',
  'CLAUDE_CODE_HOST_SESSION_ID',
  'CLAUDE_CODE_CHILD_SESSION',
  'CLAUDE_CODE_EXECPATH',
  'CLAUDE_CODE_SDK_HAS_OAUTH_REFRESH',
  'CLAUDE_CODE_SDK_HAS_HOST_AUTH_REFRESH',
  'CLAUDE_AGENT_SDK_VERSION',
  'CLAUDE_PID',
  'CLAUDE_EFFORT',
  'AI_AGENT',
  'BAGGAGE',
];

function sanitizedEnv() {
  const env = { ...process.env };
  const insideHarness = env.CLAUDECODE === '1' || Boolean(env.CLAUDE_CODE_HOST_SESSION_ID);
  if (!insideHarness) return env;

  for (const key of HOST_SESSION_ENV) delete env[key];
  // The host proxy URL only works with the host's own credentials.
  if (env.CLAUDE_CODE_SDK_HAS_HOST_AUTH_REFRESH || process.env.CLAUDE_CODE_HOST_SESSION_ID) {
    delete env.ANTHROPIC_BASE_URL;
  }
  return env;
}

const ALLOWED_IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);
const MAX_IMAGES = 4;
/** Base64 of roughly 3.7 MB of image data — comfortably above a resized photo. */
const MAX_IMAGE_CHARS = 5 * 1024 * 1024;

/** Reject anything that is not a plausible, in-budget image before it reaches Claude. */
function validateImages(images) {
  if (!Array.isArray(images) || images.length === 0) return [];
  if (images.length > MAX_IMAGES) {
    throw Object.assign(new Error(`At most ${MAX_IMAGES} images per message.`), { status: 400 });
  }

  return images.map((image) => {
    const mediaType = image?.mediaType;
    const data = image?.data;
    if (!ALLOWED_IMAGE_TYPES.has(mediaType)) {
      throw Object.assign(new Error(`Unsupported image type: ${mediaType}`), { status: 400 });
    }
    if (typeof data !== 'string' || !data.length) {
      throw Object.assign(new Error('Image data is missing.'), { status: 400 });
    }
    if (data.length > MAX_IMAGE_CHARS) {
      throw Object.assign(new Error('Image is too large — resize it first.'), { status: 413 });
    }
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(data)) {
      throw Object.assign(new Error('Image data is not valid base64.'), { status: 400 });
    }
    return { mediaType, data };
  });
}

/** Turn the SDK's terse auth failures into something actionable on a phone. */
function friendlyError(text) {
  if (/not logged in|authentication_failed|invalid api key|oauth/i.test(text || '')) {
    return (
      'Claude Code is not logged in on this machine. On the host, run `claude` in a ' +
      'terminal and sign in with /login (or set ANTHROPIC_API_KEY), then start a new session.'
    );
  }
  return text;
}

/**
 * An async iterable you can push into. The SDK keeps a session alive for as
 * long as this stream stays open, which is what lets one `query()` serve a
 * whole back-and-forth conversation instead of one prompt.
 */
class PushStream {
  constructor() {
    this.queue = [];
    this.waiting = null;
    this.closed = false;
  }

  push(value) {
    if (this.closed) return;
    if (this.waiting) {
      const resolve = this.waiting;
      this.waiting = null;
      resolve({ value, done: false });
    } else {
      this.queue.push(value);
    }
  }

  close() {
    this.closed = true;
    if (this.waiting) {
      const resolve = this.waiting;
      this.waiting = null;
      resolve({ value: undefined, done: true });
    }
  }

  [Symbol.asyncIterator]() {
    return {
      next: () => {
        if (this.queue.length) return Promise.resolve({ value: this.queue.shift(), done: false });
        if (this.closed) return Promise.resolve({ value: undefined, done: true });
        return new Promise((resolve) => {
          this.waiting = resolve;
        });
      },
      return: () => {
        this.close();
        return Promise.resolve({ value: undefined, done: true });
      },
    };
  }
}

export class Session extends EventEmitter {
  constructor({ config, id, cwd, model, permissionMode, resumeFrom, forkSession = true, title }) {
    super();
    this.config = config;
    this.id = id || randomUUID();
    this.cwd = cwd;
    this.model = model || config.defaultModel;
    this.permissionMode = permissionMode || config.defaultPermissionMode;
    this.resumeFrom = resumeFrom || null;
    this.forkSession = forkSession;
    this.title = title || null;
    this.origin = 'remote';

    this.status = 'starting';
    this.createdAt = Date.now();
    this.lastActivityAt = Date.now();
    this.claudeSessionId = null;
    this.claudeVersion = null;
    this.tools = [];
    this.slashCommands = [];
    this.availableModels = null;
    this.totalCostUsd = 0;
    this.numTurns = 0;
    this.lastError = null;

    /** requestId -> { resolve, timer, item, payload } */
    this.pendingPermissions = new Map();

    this.feed = new Feed({
      maxItems: config.maxFeedItems,
      onPatch: (patch) => this.emit('patch', patch),
    });

    this.input = new PushStream();
    this.query = null;
    this.abort = new AbortController();
  }

  get busy() {
    return this.status === 'busy';
  }

  setStatus(status) {
    if (this.status === status) return;
    this.status = status;
    this.lastActivityAt = Date.now();
    this.emit('state', this.toJSON());
  }

  toJSON() {
    return {
      id: this.id,
      kind: 'remote',
      title: this.title || this.derivedTitle(),
      cwd: this.cwd,
      model: this.model,
      permissionMode: this.permissionMode,
      status: this.status,
      claudeSessionId: this.claudeSessionId,
      claudeVersion: this.claudeVersion,
      createdAt: this.createdAt,
      lastActivityAt: this.lastActivityAt,
      totalCostUsd: this.totalCostUsd,
      numTurns: this.numTurns,
      pendingPermissions: [...this.pendingPermissions.values()].map((p) => p.payload),
      availableModels: this.availableModels,
      lastError: this.lastError,
      feedLength: this.feed.seq,
    };
  }

  derivedTitle() {
    const first = this.feed.items.find((i) => i.kind === 'user');
    if (first?.text) return first.text.slice(0, 60);
    return this.cwd.split('/').pop() || 'New session';
  }

  start() {
    const options = {
      cwd: this.cwd,
      model: this.model,
      permissionMode: this.permissionMode,
      includePartialMessages: true,
      abortController: this.abort,
      canUseTool: (toolName, input, opts) => this.requestPermission(toolName, input, opts),
      // Load the same CLAUDE.md, settings and MCP servers the desktop app uses,
      // so a remote session behaves like sitting at the machine.
      settingSources: ['user', 'project', 'local'],
      env: sanitizedEnv(),
    };
    if (this.config.claudeExecutable) {
      options.pathToClaudeCodeExecutable = this.config.claudeExecutable;
    }
    if (this.resumeFrom) {
      options.resume = this.resumeFrom;
      options.forkSession = this.forkSession;
    }

    this.query = query({ prompt: this.input, options });
    this.consume();
    return this;
  }

  async consume() {
    try {
      for await (const message of this.query) {
        this.lastActivityAt = Date.now();
        this.handleMessage(message);
      }
      this.setStatus('ended');
    } catch (err) {
      if (this.abort.signal.aborted) {
        this.setStatus('ended');
        return;
      }
      const text = friendlyError(err?.message || String(err));
      log.error(`session ${this.id} failed:`, text);
      this.lastError = text;
      this.feed.append({ kind: 'error', text });
      this.setStatus('error');
    } finally {
      this.rejectAllPermissions('Session ended');
    }
  }

  handleMessage(message) {
    switch (message.type) {
      case 'system':
        if (message.subtype === 'init') {
          this.claudeSessionId = message.session_id;
          this.claudeVersion = message.claude_code_version;
          this.tools = message.tools || [];
          this.slashCommands = message.slash_commands || [];
          if (message.model) this.model = message.model;
          if (message.permissionMode) this.permissionMode = message.permissionMode;
          this.feed.append({
            kind: 'system',
            text: `Connected to Claude Code ${message.claude_code_version || ''}`.trim(),
            model: message.model,
            cwd: message.cwd,
          });
          this.setStatus(this.status === 'starting' ? 'idle' : this.status);
          this.loadModels();
        } else if (message.subtype === 'compact_boundary') {
          this.feed.append({ kind: 'system', text: 'Context compacted' });
        }
        break;

      case 'stream_event':
        this.feed.handleStreamEvent(message);
        break;

      case 'assistant':
        this.feed.handleAssistant(message);
        break;

      case 'user':
        // Echoes of our own prompt carry no tool results; skip those.
        if (message.tool_use_result !== undefined || Array.isArray(message.message?.content)) {
          this.feed.handleToolResults(message);
        }
        break;

      case 'result':
        this.numTurns = message.num_turns ?? this.numTurns;
        if (typeof message.total_cost_usd === 'number') this.totalCostUsd = message.total_cost_usd;
        if (message.subtype === 'error' || message.is_error) {
          this.lastError = friendlyError(message.error || message.result || 'Turn failed');
          this.feed.append({ kind: 'error', text: this.lastError });
        } else {
          this.feed.append({
            kind: 'result',
            durationMs: message.duration_ms,
            costUsd: message.total_cost_usd,
            numTurns: message.num_turns,
            usage: message.usage || null,
          });
        }
        this.setStatus('idle');
        break;

      default:
        log.debug(`session ${this.id}: unhandled message type ${message.type}`);
    }
  }

  async loadModels() {
    try {
      const models = await this.query.supportedModels?.();
      if (Array.isArray(models) && models.length) {
        this.availableModels = models.map((m) =>
          typeof m === 'string' ? { id: m, name: m } : { id: m.value || m.id, name: m.displayName || m.name || m.id },
        );
        this.emit('state', this.toJSON());
      }
    } catch (err) {
      log.debug('supportedModels unavailable:', err?.message);
    }
  }

  // ---- input ----------------------------------------------------------------------

  /**
   * @param {string} text
   * @param {{mediaType: string, data: string}[]} [images] base64 image payloads
   */
  send(text, images = []) {
    const attachments = validateImages(images);
    if (!text?.trim() && !attachments.length) return false;
    if (this.status === 'ended' || this.input.closed) {
      throw Object.assign(new Error('This session has ended — start a new one.'), { status: 409 });
    }

    // The feed keeps a note of attachments, not the bytes: it is replayed in
    // full on every reconnect, and megabytes of base64 would make that painful.
    this.feed.append({ kind: 'user', text, attachments: attachments.length || undefined });

    const content = attachments.length
      ? [
          ...attachments.map((image) => ({
            type: 'image',
            source: { type: 'base64', media_type: image.mediaType, data: image.data },
          })),
          ...(text?.trim() ? [{ type: 'text', text }] : []),
        ]
      : text;

    this.input.push({ type: 'user', message: { role: 'user', content }, parent_tool_use_id: null });
    this.setStatus('busy');
    return true;
  }

  async interrupt() {
    try {
      await this.query?.interrupt?.();
      this.feed.append({ kind: 'system', text: 'Interrupted from remote' });
      this.setStatus('idle');
      return true;
    } catch (err) {
      log.warn(`interrupt failed: ${err?.message}`);
      return false;
    }
  }

  async setModel(model) {
    await this.query?.setModel?.(model);
    this.model = model;
    this.feed.append({ kind: 'system', text: `Model switched to ${model}` });
    this.emit('state', this.toJSON());
  }

  async setPermissionMode(mode) {
    await this.query?.setPermissionMode?.(mode);
    this.permissionMode = mode;
    this.feed.append({ kind: 'system', text: `Permission mode: ${mode}` });
    this.emit('state', this.toJSON());
  }

  // ---- permissions ----------------------------------------------------------------

  /**
   * Called by the SDK whenever a tool needs a human. We park the promise and
   * push the decision to every connected phone; whoever answers first wins.
   */
  requestPermission(toolName, input, opts = {}) {
    const requestId = opts.requestId || randomUUID();
    const { title, subtitle } = summarizeTool(toolName, input);

    const payload = {
      requestId,
      sessionId: this.id,
      toolName,
      input,
      title: opts.title || title,
      subtitle,
      displayName: opts.displayName || title,
      description: opts.description || '',
      toolUseId: opts.toolUseID || null,
      suggestions: opts.suggestions || [],
      requestedAt: Date.now(),
      timeoutSec: this.config.permissionTimeoutSec,
    };

    if (payload.toolUseId) this.feed.markToolRunning(payload.toolUseId);
    const item = this.feed.append({ kind: 'permission', ...payload, state: 'pending' });

    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.finishPermission(requestId, {
          behavior: 'deny',
          message: 'No answer from the remote device in time.',
        }, 'timeout');
      }, this.config.permissionTimeoutSec * 1000);

      // If Claude Code gives up on the request, stop waiting on a human.
      opts.signal?.addEventListener?.('abort', () => {
        this.finishPermission(requestId, { behavior: 'deny', message: 'Cancelled.' }, 'cancelled');
      });

      this.pendingPermissions.set(requestId, { resolve, timer, item, payload });
      this.emit('permission', payload);
      this.emit('state', this.toJSON());
    });
  }

  /** Answer from a client: allow once, allow and remember, or deny. */
  decidePermission(requestId, { decision, message, updatedInput, remember }) {
    const pending = this.pendingPermissions.get(requestId);
    if (!pending) return false;

    if (decision === 'allow' || decision === 'allow_always') {
      const result = { behavior: 'allow' };
      if (updatedInput && typeof updatedInput === 'object') result.updatedInput = updatedInput;
      if (decision === 'allow_always' || remember) {
        result.updatedPermissions = [
          {
            type: 'addRules',
            rules: [{ toolName: pending.payload.toolName }],
            behavior: 'allow',
            destination: 'session',
          },
        ];
      }
      this.finishPermission(requestId, result, decision === 'allow_always' ? 'allowed_always' : 'allowed');
    } else {
      this.finishPermission(
        requestId,
        { behavior: 'deny', message: message || 'Denied from the remote device.' },
        'denied',
      );
    }
    return true;
  }

  finishPermission(requestId, result, state) {
    const pending = this.pendingPermissions.get(requestId);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pendingPermissions.delete(requestId);
    this.feed.update(pending.item, { state, resolvedAt: Date.now() });
    if (result.behavior === 'deny' && pending.payload.toolUseId) {
      const toolItem = this.feed.toolIndex.get(pending.payload.toolUseId);
      if (toolItem) this.feed.update(toolItem, { status: 'denied' });
    }
    pending.resolve(result);
    this.emit('permissionResolved', { requestId, state });
    this.emit('state', this.toJSON());
  }

  rejectAllPermissions(reason) {
    for (const requestId of [...this.pendingPermissions.keys()]) {
      this.finishPermission(requestId, { behavior: 'deny', message: reason }, 'cancelled');
    }
  }

  async close() {
    this.rejectAllPermissions('Session closed');
    this.input.close();
    try {
      this.abort.abort();
    } catch {
      /* already gone */
    }
    this.setStatus('ended');
  }
}
