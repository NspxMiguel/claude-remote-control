/**
 * Driver for agents that speak ACP — the Agent Client Protocol: JSON-RPC 2.0
 * over stdio, newline-delimited.
 *
 * ACP is the only interface Cursor exposes that can ask a human before running
 * a tool (`session/request_permission`), which is what makes remote approval
 * work the same way it does for Claude Code. Its print mode streams, but
 * one-way — there is no channel to answer with.
 *
 * Written against the ACP v1 schema and Cursor's ACP documentation. It has not
 * been run against the real binary: `agent` is not installed on the machine
 * this was developed on. The fixture in test/fixtures/fake-acp-agent.mjs
 * implements the same wire protocol, and the tests drive a full turn through it.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { log } from '../../log.js';

export const id = 'acp';
export const label = 'Cursor';

export const capabilities = {
  streaming: true,
  permissions: true,
  interrupt: true,
  models: false,
  resume: true,
  images: false,
};

/**
 * The installer symlinks the binary twice — `agent` is current, `cursor-agent`
 * is the legacy name it still creates — and adds neither to PATH, so look in
 * the install directory as well.
 */
const CANDIDATES = ['agent', 'cursor-agent'];

function resolveBinary(config = {}) {
  if (config.acpExecutable) {
    return fs.existsSync(config.acpExecutable) ? config.acpExecutable : null;
  }
  const local = path.join(os.homedir(), '.local', 'bin');
  for (const name of CANDIDATES) {
    const direct = path.join(local, name);
    if (fs.existsSync(direct)) return direct;
  }
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    for (const name of CANDIDATES) {
      const candidate = path.join(dir, name);
      try {
        fs.accessSync(candidate, fs.constants.X_OK);
        return candidate;
      } catch {
        /* keep looking */
      }
    }
  }
  return null;
}

export async function detect(config = {}) {
  const binary = resolveBinary(config);
  if (!binary) {
    return {
      available: false,
      detail: 'not installed',
      fix: 'Install with: curl https://cursor.com/install -fsS | bash',
    };
  }
  return { available: true, detail: binary };
}

/** Map an ACP permission option list onto the allow/deny the phone offers. */
function pickOption(options, decision) {
  const wanted =
    decision === 'allow_always'
      ? ['allow_always', 'allow_once']
      : decision === 'allow'
        ? ['allow_once', 'allow_always']
        : ['reject_once', 'reject_always'];

  for (const kind of wanted) {
    const match = options.find((o) => o.kind === kind);
    if (match) return match.optionId;
  }
  // Some agents send ids without kinds; fall back to the documented ids.
  const byId = { allow: 'allow-once', allow_always: 'allow-always', deny: 'reject-once' };
  return options[0]?.optionId ?? byId[decision] ?? 'allow-once';
}

export function createDriver({ cwd, model, resumeFrom, config, emit, requestPermission }) {
  const binary = resolveBinary(config);
  let child = null;
  let carry = '';
  let nextId = 1;
  let sessionId = null;
  let busy = false;
  const pending = new Map();
  /** ACP reports tool calls by id and updates them in place. */
  const toolNames = new Map();

  const write = (message) => {
    if (!child?.stdin.writable) return;
    child.stdin.write(`${JSON.stringify(message)}\n`);
  };

  const request = (method, params) =>
    new Promise((resolve, reject) => {
      const requestId = nextId++;
      pending.set(requestId, { resolve, reject });
      write({ jsonrpc: '2.0', id: requestId, method, params });
    });

  const respond = (requestId, result) => write({ jsonrpc: '2.0', id: requestId, result });

  /** Requests the agent makes of us. Leaving one unanswered stalls the agent. */
  async function handleServerRequest(message) {
    const { id: requestId, method, params } = message;

    if (method === 'session/request_permission') {
      const call = params?.toolCall || {};
      const options = params?.options || [];
      const decision = await requestPermission(call.title || call.kind || 'Tool', call.rawInput || {}, {
        title: call.title,
        displayName: call.kind,
        toolUseID: call.toolCallId,
        requestId: `acp-${requestId}`,
      });

      if (decision?.behavior === 'allow') {
        respond(requestId, {
          outcome: { outcome: 'selected', optionId: pickOption(options, decision.always ? 'allow_always' : 'allow') },
        });
      } else {
        respond(requestId, { outcome: { outcome: 'selected', optionId: pickOption(options, 'deny') } });
      }
      return;
    }

    // Cursor extensions that block the agent until answered. Without a UI for
    // them, decline politely rather than let the turn hang forever.
    if (method === 'cursor/ask_question') {
      respond(requestId, { outcome: { outcome: 'skipped', reason: 'No question UI on this client' } });
      return;
    }
    if (method === 'cursor/create_plan') {
      emit({ type: 'text', text: params?.plan || 'The agent proposed a plan.' });
      respond(requestId, { outcome: { outcome: 'accepted' } });
      return;
    }

    // Anything else: answer with an empty result so the agent can continue.
    log.debug(`acp: unhandled request ${method}`);
    respond(requestId, {});
  }

  /** Streaming progress: text chunks, tool calls and their updates. */
  function handleUpdate(params) {
    const update = params?.update || {};

    switch (update.sessionUpdate) {
      case 'agent_message_chunk':
        emit({ type: 'text_delta', text: update.content?.text || '' });
        break;

      case 'agent_thought_chunk':
        emit({ type: 'thinking_delta', text: update.content?.text || '' });
        break;

      case 'tool_call': {
        const name = update.title || update.kind || 'Tool';
        toolNames.set(update.toolCallId, name);
        emit({
          type: 'tool',
          id: update.toolCallId,
          name,
          input: update.rawInput || {},
        });
        break;
      }

      case 'tool_call_update': {
        if (update.status !== 'completed' && update.status !== 'failed') break;
        const text = (update.content || [])
          .map((c) => c?.content?.text ?? c?.text ?? '')
          .filter(Boolean)
          .join('\n');
        emit({
          type: 'tool_result',
          id: update.toolCallId,
          result: text || (update.status === 'failed' ? 'Failed' : 'Done'),
          isError: update.status === 'failed',
        });
        break;
      }

      case 'plan':
        // Todo lists arrive as plans; surface them as prose rather than tools.
        if (Array.isArray(update.entries) && update.entries.length) {
          emit({
            type: 'text',
            text: update.entries.map((e) => `- ${e.content ?? e.title ?? ''}`).join('\n'),
          });
        }
        break;

      default:
        log.debug(`acp: unhandled update ${update.sessionUpdate}`);
    }
  }

  function handleMessage(message) {
    if (message.id !== undefined && message.method) return handleServerRequest(message);

    if (message.id !== undefined) {
      const waiter = pending.get(message.id);
      if (!waiter) return;
      pending.delete(message.id);
      if (message.error) waiter.reject(new Error(message.error.message || 'ACP error'));
      else waiter.resolve(message.result);
      return;
    }

    if (message.method === 'session/update') handleUpdate(message.params);
    else log.debug(`acp: unhandled notification ${message.method}`);
  }

  return {
    id,
    capabilities,

    async start() {
      if (!binary) {
        emit({
          type: 'error',
          fatal: true,
          text: 'Cursor Agent is not installed. Install it with: curl https://cursor.com/install -fsS | bash',
        });
        return;
      }

      child = spawn(binary, ['acp'], { cwd, stdio: ['pipe', 'pipe', 'pipe'] });

      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk) => {
        const text = carry + chunk;
        const lines = text.split('\n');
        carry = lines.pop() ?? '';
        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            handleMessage(JSON.parse(line));
          } catch (err) {
            log.debug(`acp: bad line — ${err?.message}`);
          }
        }
      });

      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (chunk) => log.debug(`acp stderr: ${String(chunk).trim().slice(0, 300)}`));

      child.on('exit', (code) => {
        for (const { reject } of pending.values()) reject(new Error('Agent exited'));
        pending.clear();
        if (code && code !== 0) emit({ type: 'error', text: `Cursor Agent exited with code ${code}`, fatal: true });
        emit({ type: 'ended' });
      });

      try {
        const init = await request('initialize', {
          protocolVersion: 1,
          clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
        });

        const created = resumeFrom
          ? await request('session/load', { sessionId: resumeFrom, cwd, mcpServers: [] }).catch(() => null)
          : null;
        const fresh = created ?? (await request('session/new', { cwd, mcpServers: [] }));
        sessionId = fresh?.sessionId ?? resumeFrom ?? null;

        emit({
          type: 'init',
          sessionId,
          version: init?.agentCapabilities?.version || init?.protocolVersion || 'acp',
          model,
          cwd,
          tools: [],
          greeting: 'Connected to Cursor Agent',
        });
      } catch (err) {
        emit({ type: 'error', text: `Could not start Cursor Agent: ${err?.message}`, fatal: true });
      }
    },

    send(text) {
      if (!sessionId) {
        emit({ type: 'error', text: 'The agent is still starting — try again in a moment.' });
        return;
      }
      if (busy) {
        emit({ type: 'error', text: 'Cursor is still working on the previous message.' });
        return;
      }
      busy = true;
      request('session/prompt', {
        sessionId,
        prompt: [{ type: 'text', text }],
      })
        .then((result) => {
          busy = false;
          emit({ type: 'result', stopReason: result?.stopReason });
        })
        .catch((err) => {
          busy = false;
          emit({ type: 'error', text: err?.message || 'The turn failed' });
        });
    },

    get closed() {
      return !child || child.killed;
    },

    async interrupt() {
      if (!sessionId) return;
      write({ jsonrpc: '2.0', method: 'session/cancel', params: { sessionId } });
      busy = false;
    },

    async close() {
      try {
        child?.stdin.end();
        child?.kill();
      } catch {
        /* already gone */
      }
    },
  };
}
