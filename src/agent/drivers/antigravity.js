/**
 * Google Antigravity (`agy`) — headless driver.
 *
 * Verified against agy 1.1.9 on macOS: real turns run through this driver,
 * including tool calls. The flag surface came from the binary's own `--help`,
 * and the stream-json shapes were confirmed by capturing a live run — a
 * `tool_info` carries `{name, parameters}` and, for a write, only the target
 * path, which is why such a call reports no diffstat. Parsers still treat an
 * unfamiliar payload as "ignore" rather than "crash", since the format is not
 * a stable published contract.
 *
 * Two properties of this CLI shape the whole driver:
 *
 * 1. `agy -p` is one prompt per process: it answers, then exits. A conversation
 *    continues by spawning again with `--conversation <id>`, so a session here is
 *    a series of processes sharing one conversation id, and a second turn has to
 *    wait for the first rather than being written to a running process.
 * 2. The stream is one-way. Permission notices go to stderr and there is no
 *    channel to answer them, so `capabilities.permissions` is false and
 *    `requestPermission` is never called. Claiming otherwise would leave a turn
 *    hanging on an answer the CLI cannot receive.
 */
import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { log } from '../../log.js';
import { parseLines } from '../../mirror/transcript.js';

const exec = promisify(execFile);

export const id = 'antigravity';
export const label = 'Google Antigravity';

export const capabilities = {
  /**
   * agy streams prose as `text_delta`s, which map onto this app's own
   * `text_delta` event. The finished text is never emitted as well: the feed
   * closes the streamed bubble on `result`, and sending both would render every
   * reply twice.
   */
  streaming: true,
  permissions: false,
  interrupt: true,
  models: true,
  resume: true,
  /** `agy --help` (1.1.9) has no flag for attachments. */
  images: false,
};

const BINARY = 'agy';

const NOT_INSTALLED =
  'The Antigravity CLI (agy) could not be found on this machine. Install it, or set ' +
  '"antigravityExecutable" to the full path of agy in ~/.claude-remote-control/config.json.';

/**
 * This app speaks Claude Code's permission vocabulary. agy's `--help` documents
 * only `accept-edits` and `plan` for `--mode`, so "default" is expressed by
 * passing no mode at all rather than by guessing that `--mode default` parses.
 */
const MODE_FLAG = {
  acceptEdits: 'accept-edits',
  'accept-edits': 'accept-edits',
  plan: 'plan',
};

/** Result statuses that mean the turn produced no answer. */
const FAILED_STATUSES = new Set(['ERROR', 'INVALID']);
/** Step states that mean "more of this step is still coming". */
const PENDING_STEP_STATES = new Set(['RUNNING', 'WAITING', 'PENDING', 'QUEUED', 'IN_PROGRESS']);

/** How much stderr to keep for the error message — the tail is the useful part. */
const STDERR_TAIL = 4000;

function isExecutableFile(candidate) {
  try {
    if (!fs.statSync(candidate).isFile()) return false;
    fs.accessSync(candidate, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Config wins when set, the way `claudeExecutable` does, so a pinned or unusual
 * install can be named explicitly — and so a wrong path produces an error that
 * names the key instead of silently falling back to some other agy. Otherwise
 * PATH, then the installer's own directory: `agy install` is what puts that on
 * PATH, and a daemon started outside a login shell will not have run it.
 */
export function resolveExecutable(config = {}) {
  if (config.antigravityExecutable) return config.antigravityExecutable;

  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, BINARY);
    if (isExecutableFile(candidate)) return candidate;
  }

  const fallback = path.join(os.homedir(), '.local', 'bin', BINARY);
  return isExecutableFile(fallback) ? fallback : null;
}

/**
 * Turn agy's terse failures into something a person holding a phone can act on.
 * These strings are the whole error UI on a small screen, so they name the fix in
 * this app's terms rather than the CLI's.
 */
export function friendlyError(text) {
  const message = text || '';

  if (/sign in|signed out|not (logged in|authenticated)|unauthenticated|auth(entication)? (failed|required)/i.test(message)) {
    return (
      'Antigravity is not signed in on this machine. On the host, run `agy` in a terminal ' +
      'and sign in, then start a new session.'
    );
  }
  if (/ENOENT|command not found|no such file/i.test(message)) return NOT_INSTALLED;
  if (/rate.?limit/i.test(message)) return 'Rate limited by Antigravity. Wait a moment and try again.';
  if (/quota|billing|credit/i.test(message)) {
    return 'Antigravity rejected the request for quota reasons — check the plan on this account.';
  }
  return message;
}

/**
 * Report whether this machine can run the driver. Never throws: a driver that
 * cannot be probed is simply reported as unavailable.
 */
export async function detect(config = {}) {
  const executable = resolveExecutable(config);
  if (!executable) {
    return { available: false, path: null, version: null, detail: 'agy is not on PATH', fix: NOT_INSTALLED };
  }
  if (config.antigravityExecutable && !fs.existsSync(executable)) {
    return {
      available: false,
      path: executable,
      version: null,
      detail: `not found at ${executable}`,
      fix: 'Fix "antigravityExecutable" in your config.',
    };
  }

  try {
    const { stdout } = await exec(executable, ['--version'], { timeout: 10000 });
    return {
      available: true,
      path: executable,
      version: stdout.trim().split('\n')[0] || null,
      detail: executable,
    };
  } catch (err) {
    return {
      available: false,
      path: executable,
      version: null,
      detail: friendlyError(err?.message || `${executable} did not answer --version`),
      fix: NOT_INSTALLED,
    };
  }
}

/** Keep agy's own token names, and add the alias the rest of this app reads. */
function normalizeUsage(usage) {
  if (!usage || typeof usage !== 'object') return null;
  const normalized = { ...usage };
  if (typeof usage.cache_read_tokens === 'number' && normalized.cache_read_input_tokens === undefined) {
    normalized.cache_read_input_tokens = usage.cache_read_tokens;
  }
  return normalized;
}

const isPending = (state) => PENDING_STEP_STATES.has(String(state || '').toUpperCase());

class AntigravityDriver {
  constructor(options = {}) {
    const { cwd, model, permissionMode, resumeFrom, config = {}, emit } = options;

    this.id = id;
    this.capabilities = capabilities;
    this.config = config;
    this.cwd = cwd || process.cwd();
    this.model = model || config.antigravityModel || null;
    this.permissionMode = permissionMode || 'default';
    this.effort = options.effort || config.antigravityEffort || null;
    this.printTimeout = options.printTimeout || config.antigravityPrintTimeout || null;
    // The session's folder has to be *in the workspace*, not merely the process
    // working directory. Without it, agy writes into its own scratch — I asked
    // it for a file in a project I had picked, and it landed in
    // ~/.gemini/antigravity-cli/scratch, reported as done. Nothing was wrong on
    // screen; the file was simply somewhere else.
    const extra = options.addDirs || config.antigravityAddDirs || [];
    this.addDirs = [...new Set([this.cwd, ...extra])];
    this.emit = typeof emit === 'function' ? emit : () => {};

    /** Set from init/result, and passed to every later turn as `--conversation`. */
    this.conversationId = resumeFrom || null;
    this.version = null;
    this.tools = [];
    this.closed = false;
    this.announcedInit = false;
    /** Resolves once `agy --version` has answered; the first turn waits for it. */
    this.ready = null;

    // Resolved here, not in start(): the session layer fires start() off without
    // awaiting it and may hand over a prompt before it has finished.
    const resolved = this.resolveBinary();
    this.executable = resolved.executable;
    this.startError = resolved.error;
    this.available = !resolved.error;

    /** Prompts waiting for the current process to exit. */
    this.queue = [];
    this.child = null;
    this.turn = null;
    /** True between taking a prompt off the queue and its process existing. */
    this.starting = false;
  }

  // ---- lifecycle ------------------------------------------------------------------

  /** @returns {{executable: string|null, error: string|null}} */
  resolveBinary() {
    const executable = resolveExecutable(this.config);
    if (!executable) return { executable: null, error: NOT_INSTALLED };
    if (this.config.antigravityExecutable && !fs.existsSync(executable)) {
      return {
        executable,
        error: `Antigravity CLI not found at ${executable} — fix "antigravityExecutable" in your config.`,
      };
    }
    return { executable, error: null };
  }

  /**
   * There is no agent process to launch until a prompt exists, so starting only
   * asks the binary for a version and announces readiness. The session layer does
   * not await this, which is why the binary was resolved in the constructor:
   * `send()` has to work the moment a prompt arrives.
   */
  async start() {
    if (this.startError) {
      this.fail(this.startError);
      return this;
    }

    this.ready = (async () => {
      try {
        const { stdout } = await exec(this.executable, ['--version'], { timeout: 10000, cwd: this.cwd });
        this.version = stdout.trim().split('\n')[0] || null;
      } catch (err) {
        // Version is cosmetic; a binary that cannot even print one will fail
        // loudly on the first turn, which is a better place to report it.
        log.debug(`agy --version failed: ${err?.message}`);
      }
    })();
    await this.ready;

    // Say we are usable now rather than at the first turn. `agy -p` only runs
    // when there is a prompt, so without this the session sits in "starting"
    // and the composer stays disabled with nothing to type into. The real
    // `init` — conversation id, tool list — still arrives with that first turn.
    this.emit({
      type: 'ready',
      version: this.version,
      cwd: this.cwd,
      greeting: `Connected to Antigravity${this.version ? ` ${this.version}` : ''}`,
    });
    return this;
  }

  /** A setup failure, not a turn failure: the session can never recover from it. */
  fail(text) {
    this.available = false;
    this.emit({ type: 'error', text, fatal: true });
  }

  /**
   * @param {string} text
   * @param {{mediaType: string, data: string}[]} [images]
   */
  send(text, images = []) {
    if (this.closed) {
      throw Object.assign(new Error('This session has ended — start a new one.'), { status: 409 });
    }
    if (!this.available) {
      throw Object.assign(new Error(this.startError || NOT_INSTALLED), { status: 503 });
    }
    if (Array.isArray(images) && images.length) {
      throw Object.assign(
        new Error('Antigravity cannot take image attachments — send the prompt as text.'),
        { status: 400 },
      );
    }

    const prompt = typeof text === 'string' ? text.trim() : '';
    if (!prompt) return false;

    // One process per prompt, so a second send waits its turn instead of racing
    // a competing agy against the same conversation.
    this.queue.push(prompt);
    this.pump();
    return true;
  }

  pump() {
    if (this.child || this.starting || this.closed) return;
    const prompt = this.queue.shift();
    if (prompt === undefined) return;

    // `starting` closes the window between taking a prompt off the queue and the
    // child existing — without it a second send() would spawn a rival process.
    this.starting = true;
    Promise.resolve(this.ready).then(() => {
      this.starting = false;
      if (this.closed) return;
      this.runTurn(prompt);
    });
  }

  buildArgs(prompt) {
    const args = ['-p', prompt, '--output-format', 'stream-json'];
    if (this.model) args.push('--model', this.model);
    if (this.effort) args.push('--effort', this.effort);
    if (this.conversationId) args.push('--conversation', this.conversationId);
    if (this.permissionMode === 'bypassPermissions') {
      args.push('--dangerously-skip-permissions');
    } else if (MODE_FLAG[this.permissionMode]) {
      args.push('--mode', MODE_FLAG[this.permissionMode]);
    }
    if (this.printTimeout) args.push('--print-timeout', String(this.printTimeout));
    for (const dir of this.addDirs) args.push('--add-dir', dir);
    return args;
  }

  runTurn(prompt) {
    const turn = {
      carry: '',
      stderr: '',
      bytes: 0,
      sawResult: false,
      emittedText: false,
      settled: false,
      interrupted: false,
      /** step_index -> tool call already announced. */
      tools: new Map(),
    };
    this.turn = turn;

    let child;
    try {
      child = spawn(this.executable, this.buildArgs(prompt), {
        cwd: this.cwd,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (err) {
      this.turn = null;
      this.emit({ type: 'error', text: friendlyError(err?.message || String(err)) });
      this.pump();
      return;
    }
    this.child = child;

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      turn.bytes += chunk.length;
      const { lines, remainder } = parseLines(chunk, turn.carry);
      turn.carry = remainder;
      for (const line of lines) this.handleLine(line);
    });

    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => {
      turn.stderr = (turn.stderr + chunk).slice(-STDERR_TAIL);
    });

    // A spawn failure emits 'error' and may or may not be followed by 'close';
    // settling from either path keeps the queue moving exactly once.
    child.on('error', (err) => this.settleTurn(turn, null, err));
    child.on('close', (code) => this.settleTurn(turn, code, null));
  }

  settleTurn(turn, code, err) {
    if (turn.settled) return;
    turn.settled = true;

    // The last line arrives without its newline when the process exits.
    if (turn.carry.trim()) {
      const { lines } = parseLines('\n', turn.carry);
      for (const line of lines) this.handleLine(line);
    }
    turn.carry = '';

    if (!turn.sawResult && !turn.interrupted) {
      const detail = turn.stderr.trim().split('\n').filter(Boolean).pop() || '';
      let text;
      if (err) text = friendlyError(err.message || String(err));
      else if (detail) text = friendlyError(detail);
      else if (turn.bytes === 0) text = `Antigravity exited (code ${code}) without saying anything.`;
      else text = `Antigravity exited (code ${code}) without finishing the turn.`;
      this.emit({ type: 'error', text });
    }

    this.child = null;
    this.turn = null;
    this.pump();
  }

  // ---- stream-json ----------------------------------------------------------------

  /**
   * Every line carries a top-level `event` discriminator and nests its payload
   * under a key of the same name — unlike Claude Code, where the fields are flat.
   */
  handleLine(line) {
    const kind = line?.event;
    if (typeof kind !== 'string') return;
    const payload = line[kind] && typeof line[kind] === 'object' ? line[kind] : {};

    switch (kind) {
      case 'init':
        this.handleInit(line, payload);
        break;
      case 'step_update':
        this.handleStep(payload);
        break;
      case 'result':
        this.handleResult(line, payload);
        break;
      default:
        log.debug(`antigravity: ignoring unknown event "${kind}"`);
    }
  }

  handleInit(line, init) {
    this.conversationId = line.conversation_id || init.conversation_id || this.conversationId;
    if (Array.isArray(init.tools)) this.tools = init.tools;
    if (init.model) this.model = init.model;

    // Every turn is a fresh process and re-announces itself, but only the first
    // one tells the session anything it does not already know: the conversation
    // id it needs to resume, the tool list, and the mode agy actually chose.
    if (this.announcedInit) return;
    this.announcedInit = true;
    this.emit({
      type: 'init',
      sessionId: this.conversationId,
      version: this.version,
      model: init.model || this.model || null,
      tools: this.tools,
      cwd: init.cwd || this.cwd,
      permissionMode: init.permission_mode || this.permissionMode,
      // No greeting: `ready` already announced the connection at start.
    });

    // Under review mode agy asks for approval on the machine it runs on, and this
    // client has no way to answer. Saying so beats a turn that appears to hang.
    if ((init.permission_mode || '').toLowerCase() === 'request-review') {
      this.emit({
        type: 'notice',
        text: 'Antigravity asks for tool approval on the host machine — this client cannot answer those prompts.',
      });
    }
  }

  handleStep(step) {
    const turn = this.turn;
    if (!turn || !step || typeof step !== 'object') return;

    const index = step.step_index ?? 0;
    const type = step.step_type;

    // Our own prompt, echoed back; the feed already has it.
    if (type === 'user_input') return;

    if (step.tool_info) {
      this.handleToolStep(turn, index, step);
      return;
    }

    // Deltas go straight out; the feed closes the bubble when the result lands.
    // `text_delta` is read as incremental, as its name says — a build that sent
    // the whole message on every line would repeat itself here.
    if (type === 'agent_response') {
      if (typeof step.text_delta === 'string' && step.text_delta.length) {
        turn.emittedText = true;
        this.emit({ type: 'text_delta', text: step.text_delta });
      }
      return;
    }

    log.debug(`antigravity: ignoring step_type "${type}"`);
  }

  /**
   * The docs say tool steps "carry tool_info" without saying what is in it, so
   * every plausible spelling is read and a missing one is not an error.
   */
  handleToolStep(turn, index, step) {
    const info = step.tool_info || {};
    let entry = turn.tools.get(index);

    if (!entry) {
      entry = {
        id: info.tool_call_id || info.tool_use_id || info.id || `${this.conversationId || 'turn'}:${index}`,
        name: info.tool_name || info.name || step.step_type || 'tool',
      };
      turn.tools.set(index, entry);
      this.emit({
        type: 'tool',
        id: entry.id,
        name: entry.name,
        input: info.input ?? info.args ?? info.parameters ?? {},
      });
    }

    if (isPending(step.state) || step.state === undefined) return;

    const raw = info.result ?? info.output ?? info.error ?? step.text_delta ?? '';
    this.emit({
      type: 'tool_result',
      id: entry.id,
      result: typeof raw === 'string' ? raw : JSON.stringify(raw),
      isError: String(step.state).toUpperCase() === 'ERROR' || Boolean(info.is_error || info.error),
    });
  }

  handleResult(line, result) {
    const turn = this.turn;
    if (turn) turn.sawResult = true;
    this.conversationId = line.conversation_id || result.conversation_id || this.conversationId;

    const status = String(result.status || '').toUpperCase();
    if (FAILED_STATUSES.has(status)) {
      const detail = result.error || result.response || turn?.stderr?.trim() || '';
      this.emit({
        type: 'error',
        text: friendlyError(detail) || `Antigravity returned ${status || 'no status'}.`,
      });
      return;
    }

    // A turn whose prose never arrived as a step would otherwise be lost. Safe to
    // send whole: nothing was streamed, so there is no bubble to duplicate.
    if (turn && !turn.emittedText && typeof result.response === 'string' && result.response.trim()) {
      turn.emittedText = true;
      this.emit({ type: 'text', text: result.response });
    }

    this.emit({
      type: 'result',
      durationMs:
        typeof result.duration_seconds === 'number' ? Math.round(result.duration_seconds * 1000) : null,
      // agy reports tokens, not money. A blank cost beats an invented one.
      costUsd: typeof result.total_cost_usd === 'number' ? result.total_cost_usd : null,
      numTurns: typeof result.num_turns === 'number' ? result.num_turns : null,
      usage: normalizeUsage(result.usage),
      status: status || null,
    });
  }

  // ---- control --------------------------------------------------------------------

  /**
   * Killing the process is the only stop agy offers. The session layer is what
   * announces the interruption and returns to idle, so nothing is emitted here —
   * a result event would add an empty row for a turn that never finished.
   */
  async interrupt() {
    if (!this.child || !this.turn) {
      this.queue.length = 0;
      return false;
    }
    // Prompts typed ahead are stale once someone has hit stop.
    this.queue.length = 0;
    this.turn.interrupted = true;
    await this.killChild();
    return true;
  }

  /** Applies to the next turn: each turn is a fresh process with its own flags. */
  setModel(model) {
    this.model = model;
  }

  setPermissionMode(mode) {
    this.permissionMode = mode;
  }

  /**
   * `agy models` prints a plain list and has no JSON flag (checked against 1.1.9),
   * and its exact layout is unverified — it needs a signed-in CLI to produce one.
   * So this accepts only lines that unmistakably look like a model slug and gives
   * up entirely on anything else, leaving the picker empty rather than wrong.
   */
  async supportedModels() {
    const executable = this.executable || resolveExecutable(this.config);
    if (!executable) return [];

    let stdout;
    try {
      ({ stdout } = await exec(executable, ['models'], { timeout: 15000, cwd: this.cwd }));
    } catch (err) {
      log.debug(`antigravity: agy models failed: ${err?.message}`);
      return [];
    }

    const models = [];
    for (const raw of String(stdout).split('\n')) {
      const line = raw.trim().replace(/^[*\-•]\s+/, '');
      if (!line) continue;
      // Any complaint means the list is not a list; do not mine it for slugs.
      if (/^(error|warning|please|usage)\b/i.test(line)) return [];
      const slug = line.split(/\s{2,}|\t|\s+—\s+|\s+-\s+/)[0].trim();
      // Slugs carry a digit or a separator; prose headings do not.
      if (!/^[A-Za-z][A-Za-z0-9._:/-]{1,79}$/.test(slug) || !/[0-9._:/-]/.test(slug)) continue;
      if (!models.some((m) => m.id === slug)) models.push({ id: slug, name: slug });
    }
    return models;
  }

  killChild() {
    const child = this.child;
    if (!child) return Promise.resolve();

    return new Promise((resolve) => {
      // A hung agy must not keep the daemon alive, and the escalation timer must
      // not keep the event loop alive either.
      const timer = setTimeout(() => {
        try {
          child.kill('SIGKILL');
        } catch {
          /* already gone */
        }
      }, 2000);
      timer.unref?.();

      child.once('close', () => {
        clearTimeout(timer);
        resolve();
      });

      try {
        child.kill('SIGTERM');
      } catch {
        clearTimeout(timer);
        resolve();
      }
    });
  }

  async close() {
    this.closed = true;
    this.queue.length = 0;
    if (this.turn) this.turn.interrupted = true;
    await this.killChild();
    this.child = null;
    this.turn = null;
  }
}

export function createDriver(options = {}) {
  return new AntigravityDriver(options);
}
