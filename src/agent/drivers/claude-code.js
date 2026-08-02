/**
 * Driver for Claude Code, via the official Agent SDK.
 *
 * This is the only driver that streams at token granularity and can ask the
 * phone for permission before a tool runs, so it passes the SDK's own message
 * shapes straight through as `raw_*` events rather than flattening them.
 */
import { query } from '@anthropic-ai/claude-agent-sdk';
import { credentialEnv, hasCredential } from '../credentials.js';
import { log } from '../../log.js';

export const id = 'claude-code';
export const label = 'Claude Code';

export const capabilities = {
  streaming: true,
  permissions: true,
  interrupt: true,
  models: true,
  resume: true,
  images: true,
};

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
  // Enables a dialog-based tool this client cannot render.
  'CLAUDE_CODE_ENABLE_ASK_USER_QUESTION_TOOL',
];

function sanitizedEnv(config) {
  const env = { ...process.env };
  const insideHarness = env.CLAUDECODE === '1' || Boolean(env.CLAUDE_CODE_HOST_SESSION_ID);

  if (insideHarness) {
    for (const key of HOST_SESSION_ENV) delete env[key];
    // The host proxy URL only works with the host's own credentials.
    if (env.CLAUDE_CODE_SDK_HAS_HOST_AUTH_REFRESH || process.env.CLAUDE_CODE_HOST_SESSION_ID) {
      delete env.ANTHROPIC_BASE_URL;
    }
  }

  // A key set from the app wins: it was set precisely because the host login
  // was not working.
  return { ...env, ...credentialEnv(config, id) };
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

export async function detect(config = {}) {
  // A key set from the app counts as being signed in — it is what the driver
  // will export when it launches.
  if (hasCredential(config, id)) return { available: true, detail: 'API key set in this app' };

  const { checkLogin } = await import('../../doctor.js');
  const credentials = await checkLogin();
  return {
    available: credentials.level !== 'bad',
    detail: credentials.level === 'bad' ? 'not signed in' : credentials.detail,
    fix: credentials.fix,
  };
}

export function createDriver({
  cwd,
  model,
  permissionMode,
  effort,
  resumeFrom,
  forkSession,
  config,
  emit,
  requestPermission,
}) {
  const input = new PushStream();
  const abort = new AbortController();
  let session = null;

  const options = {
    cwd,
    model,
    permissionMode,
    // Silently downgraded by the SDK on models that do not implement the
    // higher levels, which is the behaviour we want: ask for max, get the most
    // the chosen model can do.
    ...(effort ? { effort } : {}),
    includePartialMessages: true,
    abortController: abort,
    canUseTool: (toolName, toolInput, opts) => requestPermission(toolName, toolInput, opts),
    // Load the same CLAUDE.md, settings and MCP servers the desktop app uses,
    // so a remote session behaves like sitting at the machine.
    settingSources: ['user', 'project', 'local'],
    env: sanitizedEnv(config),
  };
  if (config?.claudeExecutable) options.pathToClaudeCodeExecutable = config.claudeExecutable;
  if (config?.disallowedTools?.length) options.disallowedTools = config.disallowedTools;
  if (resumeFrom) {
    options.resume = resumeFrom;
    options.forkSession = forkSession;
  }

  /** Translate one SDK message into driver events. */
  function handle(message) {
    switch (message.type) {
      case 'system':
        if (message.subtype === 'init') {
          emit({
            type: 'init',
            sessionId: message.session_id,
            version: message.claude_code_version,
            model: message.model,
            tools: message.tools || [],
            cwd: message.cwd,
            permissionMode: message.permissionMode,
            greeting: `Connected to Claude Code ${message.claude_code_version || ''}`.trim(),
          });
        } else if (message.subtype === 'compact_boundary') {
          emit({ type: 'notice', text: 'Context compacted' });
        }
        break;

      case 'stream_event':
        emit({ type: 'raw_stream', event: message });
        break;

      case 'assistant':
        emit({ type: 'raw_assistant', message });
        break;

      case 'user':
        // Echoes of our own prompt carry no tool results; skip those.
        if (message.tool_use_result !== undefined || Array.isArray(message.message?.content)) {
          emit({ type: 'raw_tool_results', message });
        }
        break;

      case 'result':
        if (message.subtype === 'error' || message.is_error) {
          emit({ type: 'error', text: message.error || message.result || 'Turn failed' });
        } else {
          emit({
            type: 'result',
            durationMs: message.duration_ms,
            costUsd: message.total_cost_usd,
            numTurns: message.num_turns,
            usage: message.usage || null,
          });
        }
        break;

      default:
        log.debug(`claude-code: unhandled message type ${message.type}`);
    }
  }

  return {
    id,
    capabilities,

    async start() {
      session = query({ prompt: input, options });
      (async () => {
        try {
          for await (const message of session) handle(message);
          emit({ type: 'ended' });
        } catch (err) {
          if (abort.signal.aborted) {
            emit({ type: 'ended' });
            return;
          }
          emit({ type: 'error', text: err?.message || String(err), fatal: true });
        }
      })();
    },

    send(text, images = []) {
      const content = images.length
        ? [
            ...images.map((image) => ({
              type: 'image',
              source: { type: 'base64', media_type: image.mediaType, data: image.data },
            })),
            ...(text?.trim() ? [{ type: 'text', text }] : []),
          ]
        : text;
      input.push({ type: 'user', message: { role: 'user', content }, parent_tool_use_id: null });
    },

    get closed() {
      return input.closed;
    },

    async interrupt() {
      await session?.interrupt?.();
    },

    async setModel(next) {
      await session?.setModel?.(next);
    },

    async setPermissionMode(mode) {
      await session?.setPermissionMode?.(mode);
    },

    async supportedModels() {
      const models = await session?.supportedModels?.();
      if (!Array.isArray(models)) return [];
      return models.map((m) =>
        typeof m === 'string'
          ? { id: m, name: m }
          : { id: m.value || m.id, name: m.displayName || m.name || m.id },
      );
    },

    async close() {
      input.close();
      try {
        abort.abort();
      } catch {
        /* already gone */
      }
    },
  };
}
