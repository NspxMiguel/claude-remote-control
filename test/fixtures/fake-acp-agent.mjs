#!/usr/bin/env node
/**
 * Stands in for an ACP agent (`agent acp`) — JSON-RPC 2.0 over stdio,
 * newline-delimited — so the ACP driver can be tested without installing
 * Cursor. It implements the parts of the protocol the driver relies on:
 * initialize, session/new, session/load, session/prompt, session/update
 * notifications, and a blocking session/request_permission.
 *
 * Behaviour is steered by the prompt text: "DENYME" expects to be refused,
 * "NOPERM" runs a tool without asking, "FAILTOOL" reports a failed tool.
 */
import readline from 'node:readline';

const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
const respond = (id, result) => send({ jsonrpc: '2.0', id, result });
const notify = (method, params) => send({ jsonrpc: '2.0', method, params });

const SESSION_ID = 'acp-session-0001';
let nextId = 1000;
const pending = new Map();

/** Ask the client for permission and wait for its answer. */
function requestPermission(toolCall) {
  const id = nextId++;
  return new Promise((resolve) => {
    pending.set(id, resolve);
    send({
      jsonrpc: '2.0',
      id,
      method: 'session/request_permission',
      params: {
        sessionId: SESSION_ID,
        toolCall,
        options: [
          { optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' },
          { optionId: 'allow-always', name: 'Allow always', kind: 'allow_always' },
          { optionId: 'reject-once', name: 'Reject', kind: 'reject_once' },
        ],
      },
    });
  });
}

const chunk = (text) =>
  notify('session/update', {
    sessionId: SESSION_ID,
    update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } },
  });

async function runTurn(promptText, replyId) {
  for (const piece of ['Working', ' on ', promptText]) chunk(piece);

  const toolCallId = `call-${replyId}`;
  const toolCall = {
    toolCallId,
    title: `Run ${promptText}`,
    kind: 'execute',
    rawInput: { command: `echo ${promptText}` },
  };

  notify('session/update', {
    sessionId: SESSION_ID,
    update: { sessionUpdate: 'tool_call', ...toolCall, status: 'pending' },
  });

  let allowed = true;
  if (!promptText.includes('NOPERM')) {
    const outcome = await requestPermission(toolCall);
    allowed = outcome?.outcome === 'selected' && !String(outcome.optionId).startsWith('reject');
  }

  if (!allowed) {
    notify('session/update', {
      sessionId: SESSION_ID,
      update: {
        sessionUpdate: 'tool_call_update',
        toolCallId,
        status: 'failed',
        content: [{ type: 'content', content: { type: 'text', text: 'Denied by user' } }],
      },
    });
    respond(replyId, { stopReason: 'refusal' });
    return;
  }

  const failed = promptText.includes('FAILTOOL');
  notify('session/update', {
    sessionId: SESSION_ID,
    update: {
      sessionUpdate: 'tool_call_update',
      toolCallId,
      status: failed ? 'failed' : 'completed',
      content: [{ type: 'content', content: { type: 'text', text: failed ? 'boom' : promptText } }],
    },
  });

  chunk(`. Done: ${promptText}`);
  respond(replyId, { stopReason: 'end_turn' });
}

const rl = readline.createInterface({ input: process.stdin });

rl.on('line', async (line) => {
  if (!line.trim()) return;
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }

  // A response to something we asked (a permission decision).
  if (message.id !== undefined && !message.method) {
    const resolve = pending.get(message.id);
    if (resolve) {
      pending.delete(message.id);
      resolve(message.result?.outcome);
    }
    return;
  }

  switch (message.method) {
    case 'initialize':
      respond(message.id, {
        protocolVersion: 1,
        agentCapabilities: { version: 'fake-acp-1.0', promptCapabilities: { image: false } },
      });
      break;

    case 'session/new':
      respond(message.id, { sessionId: SESSION_ID });
      break;

    case 'session/load':
      respond(message.id, { sessionId: message.params?.sessionId || SESSION_ID });
      break;

    case 'session/prompt': {
      const text = (message.params?.prompt || [])
        .map((p) => p.text || '')
        .join(' ')
        .trim();
      await runTurn(text, message.id);
      break;
    }

    case 'session/cancel':
      // The spec requires answering every outstanding permission with cancelled.
      for (const [id, resolve] of pending) {
        resolve({ outcome: 'cancelled' });
        pending.delete(id);
      }
      break;

    default:
      if (message.id !== undefined) respond(message.id, {});
  }
});

rl.on('close', () => process.exit(0));
