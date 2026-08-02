import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Feed, summarizeTool } from '../protocol.js';
import { getDriver, DEFAULT_DRIVER } from './drivers/index.js';
import { BYPASS_MODE } from '../config.js';
import { log } from '../log.js';

const ALLOWED_IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);
const MAX_IMAGES = 4;
/** Base64 of roughly 3.7 MB of image data — comfortably above a resized photo. */
const MAX_IMAGE_CHARS = 5 * 1024 * 1024;
/** A 240px JPEG preview is a few KB; anything near this is not a thumbnail. */
const MAX_THUMBNAIL_CHARS = 120 * 1024;

/** Reject anything that is not a plausible, in-budget image before it reaches the agent. */
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
    // A small data: URL preview, kept for the transcript. Bounded so a client
    // cannot smuggle a full-size image into the replayed feed.
    const thumbnail =
      typeof image.thumbnail === 'string' &&
      image.thumbnail.startsWith('data:image/') &&
      image.thumbnail.length <= MAX_THUMBNAIL_CHARS
        ? image.thumbnail
        : null;

    return { mediaType, data, thumbnail };
  });
}

const IMAGE_EXTENSION = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/gif': 'gif',
  'image/webp': 'webp',
};

/**
 * Put attachments where an agent without image support can still reach them:
 * a hidden folder inside the working directory, so the paths are ones the agent
 * is already allowed to read.
 */
function writeAttachments(cwd, attachments) {
  const dir = path.join(cwd, '.crc-attachments');
  fs.mkdirSync(dir, { recursive: true });

  return attachments.map((image, index) => {
    const name = `${Date.now().toString(36)}-${index + 1}.${IMAGE_EXTENSION[image.mediaType] || 'png'}`;
    const file = path.join(dir, name);
    fs.writeFileSync(file, Buffer.from(image.data, 'base64'));
    return file;
  });
}

/**
 * Every one of these is a wall you can hit mid-sentence from a phone, where the
 * raw message ("rate_limit_error", exit 1) tells you nothing about whether to
 * wait five minutes, top up, or go find a laptop. `kind` lets the UI show the
 * right shape of notice instead of one red box for everything.
 */
export function classifyError(text, agent = {}) {
  const message = text || '';
  const label = agent.label || 'The agent';
  const configKey = agent.configKey || 'the agent executable path';

  // Checked before the general auth case: an expired credential and never
  // having signed in both mention OAuth, and they need different answers.
  if (/expired|refresh.*failed/i.test(message) && /token|oauth|credential|session/i.test(message)) {
    return {
      kind: 'auth',
      title: 'Sign-in expired',
      text: 'The stored credential is no longer valid.',
      hint: 'Sign in again from Settings.',
    };
  }

  if (/usage limit reached|limit will reset|resets? at/i.test(message)) {
    // Claude's own message usually carries the reset time; keep it verbatim.
    const when = message.match(/reset[s]?\s+at\s+([^.\n]+)/i);
    return {
      kind: 'quota',
      title: 'Plan limit reached',
      text: when
        ? `You have used up this plan's allowance. It resets at ${when[1].trim()}.`
        : 'You have used up this plan\'s allowance for now. It resets on a rolling window.',
      hint: 'Switching to a smaller model, or an API key in Settings, keeps you going meanwhile.',
    };
  }
  if (/rate.?limit|429|too many requests/i.test(message)) {
    return {
      kind: 'rate',
      title: 'Rate limited',
      text: 'The API is throttling requests right now.',
      hint: 'Wait a moment and send it again — nothing was lost.',
    };
  }
  if (/credit balance|insufficient|billing|payment|out of credit/i.test(message)) {
    return {
      kind: 'billing',
      title: 'Out of credit',
      text: 'The account has no credit left for API usage.',
      hint: 'Top up at console.anthropic.com, or sign in with a subscription in Settings.',
    };
  }
  if (/not logged in|authentication_failed|invalid api key|unauthorized|401|oauth/i.test(message)) {
    return {
      kind: 'auth',
      title: 'Not signed in',
      text: 'This agent has no working credentials on the host.',
      hint: 'Settings has a Sign in button — it takes about twenty seconds.',
    };
  }
  if (/binary not found|ENOENT|could not find claude|not found at/i.test(message)) {
    return {
      kind: 'missing',
      title: `${label} is not installed`,
      text: `${label} could not be found on this machine.`,
      hint: `Install it, or set "${configKey}" in ~/.claude-remote-control/config.json.`,
    };
  }
  if (/overloaded|529|capacity/i.test(message)) {
    return {
      kind: 'rate',
      title: 'Servers busy',
      text: 'The model is overloaded at the moment.',
      hint: 'Try again shortly, or switch model from the session menu.',
    };
  }
  if (/context|too long|max.*tokens|token limit/i.test(message)) {
    return {
      kind: 'context',
      title: 'Conversation too long',
      text: 'This session has outgrown the model\'s context window.',
      hint: 'Start a fresh session, or ask it to /compact first.',
    };
  }
  return { kind: 'error', title: null, text: message, hint: null };
}

/** The single line to show when only one line fits. */
function friendlyError(text, agent) {
  const { title, text: body, hint } = classifyError(text, agent);
  if (!title) return body;
  return hint ? `${title}. ${body} ${hint}` : `${title}. ${body}`;
}

/**
 * One conversation with one agent.
 *
 * Everything agent-specific lives in a driver (see ./drivers/README.md); this
 * class owns the transcript, the status, and the permission prompts waiting on
 * a human, so all agents behave identically from the phone's point of view.
 */
export class Session extends EventEmitter {
  constructor({ config, id, cwd, model, permissionMode, resumeFrom, forkSession = true, title, driver }) {
    super();
    this.config = config;
    this.id = id || randomUUID();
    this.cwd = cwd;
    this.driverId = driver || DEFAULT_DRIVER;
    // `defaultModel` names a Claude model, so it only makes sense for Claude
    // Code. Another agent with no explicit choice uses whatever it defaults to —
    // passing "sonnet" to Antigravity is a hard error on its side.
    this.model = model || (this.driverId === DEFAULT_DRIVER ? config.defaultModel : null);
    this.permissionMode = permissionMode || config.defaultPermissionMode;
    this.resumeFrom = resumeFrom || null;
    this.forkSession = forkSession;
    this.title = title || null;

    this.status = 'starting';
    this.createdAt = Date.now();
    this.lastActivityAt = Date.now();
    this.agentSessionId = null;
    this.agentVersion = null;
    this.tools = [];
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

    const module = getDriver(this.driverId);
    if (!module) {
      throw Object.assign(new Error(`Unknown agent: ${this.driverId}`), { status: 400 });
    }
    this.capabilities = module.capabilities;
    this.driverLabel = module.label;
    this.driver = module.createDriver({
      cwd: this.cwd,
      model: this.model,
      permissionMode: this.permissionMode,
      resumeFrom: this.resumeFrom,
      forkSession: this.forkSession,
      config,
      emit: (event) => this.handleEvent(event),
      requestPermission: (toolName, input, opts) => this.requestPermission(toolName, input, opts),
    });
  }

  /**
   * How this agent should be named in its own error messages, and which config
   * key points at its executable — so "not installed" names the right one.
   */
  agentContext() {
    const configKey = {
      'claude-code': 'claudeExecutable',
      antigravity: 'antigravityExecutable',
    }[this.driverId];
    return { label: this.driverLabel, configKey };
  }

  // Kept for callers and tests that predate multiple agents.
  get claudeSessionId() {
    return this.agentSessionId;
  }

  get claudeVersion() {
    return this.agentVersion;
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
      agent: this.driverId,
      agentLabel: this.driverLabel,
      capabilities: this.capabilities,
      title: this.title || this.derivedTitle(),
      cwd: this.cwd,
      model: this.model,
      permissionMode: this.permissionMode,
      status: this.status,
      claudeSessionId: this.agentSessionId,
      agentSessionId: this.agentSessionId,
      agentVersion: this.agentVersion,
      claudeVersion: this.agentVersion,
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
    Promise.resolve(this.driver.start()).catch((err) => {
      this.fail(err?.message || String(err));
    });
    return this;
  }

  fail(text) {
    const message = friendlyError(text, this.agentContext());
    log.error(`session ${this.id} failed:`, message);
    this.lastError = message;
    this.feed.append({ kind: 'error', text: message });
    this.setStatus('error');
    this.rejectAllPermissions('Session ended');
  }

  // ---- driver events ----------------------------------------------------------------

  handleEvent(event) {
    this.lastActivityAt = Date.now();

    switch (event.type) {
      // Some agents are usable before they have a conversation to report — one
      // process per turn means the real init only lands with the first prompt.
      case 'ready':
      case 'init':
        if (event.sessionId) this.agentSessionId = event.sessionId;
        if (event.version) this.agentVersion = event.version;
        if (event.tools?.length) this.tools = event.tools;
        if (event.model) this.model = event.model;
        if (event.permissionMode) this.permissionMode = event.permissionMode;
        // Some agents report init once when they are ready and again per turn;
        // announce the connection only the first time.
        if (!this.announced) {
          this.announced = true;
          this.feed.append({
            kind: 'system',
            text: event.greeting || `Connected to ${this.driverLabel}`,
            model: event.model,
            cwd: event.cwd,
          });
          this.loadModels();
        }
        if (this.status === 'starting') this.setStatus('idle');
        break;

      // Anthropic-shaped messages, passed through for token-level streaming.
      case 'raw_stream':
        this.feed.handleStreamEvent(event.event);
        break;
      case 'raw_assistant':
        this.feed.handleAssistant(event.message);
        break;
      case 'raw_tool_results':
        this.feed.handleToolResults(event.message);
        break;

      case 'text_delta':
        this.feed.appendTextDelta(event.text, 'text');
        break;
      case 'thinking_delta':
        this.feed.appendTextDelta(event.text, 'thinking');
        break;
      case 'text':
        this.feed.finishStreamingText();
        if (event.text?.trim()) this.feed.append({ kind: 'text', text: event.text });
        break;
      case 'thinking':
        if (event.text?.trim()) this.feed.append({ kind: 'thinking', text: event.text });
        break;

      case 'tool':
        this.feed.finishStreamingText();
        this.feed.addTool(event);
        break;
      case 'tool_result':
        this.feed.completeTool(event);
        break;

      case 'notice':
        this.feed.append({ kind: 'system', text: event.text });
        break;

      case 'result':
        this.feed.finishStreamingText();
        if (typeof event.numTurns === 'number') this.numTurns = event.numTurns;
        else this.numTurns += 1;
        if (typeof event.costUsd === 'number') this.totalCostUsd = event.costUsd;
        this.feed.append({
          kind: 'result',
          durationMs: event.durationMs,
          costUsd: event.costUsd,
          numTurns: this.numTurns,
          usage: event.usage || null,
        });
        this.setStatus('idle');
        break;

      case 'error': {
        this.feed.finishStreamingText();
        const classified = classifyError(event.text, this.agentContext());
        this.lastError = friendlyError(event.text, this.agentContext());
        this.feed.append({
          kind: 'error',
          text: classified.text,
          title: classified.title,
          hint: classified.hint,
          errorKind: classified.kind,
        });
        if (event.fatal) {
          this.setStatus('error');
          this.rejectAllPermissions('Session ended');
        } else {
          this.setStatus('idle');
        }
        break;
      }

      case 'ended':
        this.feed.finishStreamingText();
        if (this.status !== 'error') this.setStatus('ended');
        this.rejectAllPermissions('Session ended');
        break;

      default:
        log.debug(`session ${this.id}: unhandled driver event ${event.type}`);
    }
  }

  async loadModels() {
    if (!this.capabilities.models) return;
    try {
      const models = await this.driver.supportedModels?.();
      if (Array.isArray(models) && models.length) {
        this.availableModels = models;
        this.emit('state', this.toJSON());
      }
    } catch (err) {
      log.debug('supportedModels unavailable:', err?.message);
    }
  }

  // ---- input ------------------------------------------------------------------------

  /**
   * @param {string} text
   * @param {{mediaType: string, data: string}[]} [images] base64 image payloads
   */
  send(text, images = []) {
    const attachments = validateImages(images);
    if (!text?.trim() && !attachments.length) return false;
    if (this.status === 'ended' || this.driver.closed) {
      throw Object.assign(new Error('This session has ended — start a new one.'), { status: 409 });
    }
    // An agent with no image support still gets the picture: it is written next
    // to the project and named in the prompt, so the agent can open it with its
    // own file tools. Refusing the attachment would be the worse answer.
    let prompt = text;
    let forDriver = attachments;
    if (attachments.length && !this.capabilities.images) {
      const paths = writeAttachments(this.cwd, attachments);
      const list = paths.map((p) => `- ${p}`).join('\n');
      prompt = `${text ? `${text}\n\n` : ''}Attached image${paths.length === 1 ? '' : 's'} saved to:\n${list}`;
      forDriver = [];
    }

    // The transcript carries thumbnails, never the full-size bytes: it is
    // replayed in full on every reconnect.
    this.feed.append({
      kind: 'user',
      text,
      attachments: attachments.length || undefined,
      thumbnails: attachments.map((a) => a.thumbnail).filter(Boolean),
    });
    this.driver.send(prompt, forDriver);
    this.setStatus('busy');
    return true;
  }

  async interrupt() {
    if (!this.capabilities.interrupt) return false;
    try {
      await this.driver.interrupt?.();
      this.feed.append({ kind: 'system', text: 'Interrupted from remote' });
      this.setStatus('idle');
      return true;
    } catch (err) {
      log.warn(`interrupt failed: ${err?.message}`);
      return false;
    }
  }

  async setModel(model) {
    await this.driver.setModel?.(model);
    this.model = model;
    this.feed.append({ kind: 'system', text: `Model switched to ${model}` });
    this.emit('state', this.toJSON());
  }

  async setPermissionMode(mode) {
    await this.driver.setPermissionMode?.(mode);
    this.permissionMode = mode;
    // Switching to "never ask" while a prompt is on screen has to clear that
    // prompt too, or the switch says one thing and the phone shows another —
    // and the agent sits there waiting for an answer nobody will give.
    if (mode === BYPASS_MODE) this.allowAllPending();
    this.feed.append({ kind: 'system', text: `Permission mode: ${mode}` });
    this.emit('state', this.toJSON());
  }

  // ---- permissions ------------------------------------------------------------------

  /**
   * Called by a driver whenever a tool needs a human. We park the promise and
   * push the decision to every connected phone; whoever answers first wins.
   */
  requestPermission(toolName, input, opts = {}) {
    // "Never ask" has to mean never, whatever the agent underneath believes.
    // Claude Code honours the mode itself and stops calling us; an ACP agent
    // asks regardless; Antigravity asks on the host. Answering here is the one
    // place that covers all three, and it is the last gate before a prompt
    // would be pushed to a phone.
    if (this.permissionMode === BYPASS_MODE) {
      if (opts.toolUseID) this.feed.markToolRunning(opts.toolUseID);
      return Promise.resolve({ behavior: 'allow' });
    }

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
        this.finishPermission(
          requestId,
          { behavior: 'deny', message: 'No answer from the remote device in time.' },
          'timeout',
        );
      }, this.config.permissionTimeoutSec * 1000);

      // If the agent gives up on the request, stop waiting on a human.
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
        result.always = true;
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

  /** Answer everything still waiting with yes. Used when "never ask" comes on. */
  allowAllPending() {
    for (const requestId of [...this.pendingPermissions.keys()]) {
      this.finishPermission(requestId, { behavior: 'allow' }, 'allowed');
    }
  }

  async close() {
    this.rejectAllPermissions('Session closed');
    await this.driver.close?.();
    this.setStatus('ended');
  }
}
