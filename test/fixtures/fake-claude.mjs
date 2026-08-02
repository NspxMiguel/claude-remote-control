#!/usr/bin/env node
/**
 * A stand-in for the `claude` binary that speaks just enough of the Agent SDK's
 * control protocol to exercise the session driver: initialize, streamed
 * assistant output, a tool call that asks permission, and a result.
 *
 * This lets the test suite drive a full session end to end with no credentials
 * and no network. It is a test fixture, not a Claude Code implementation.
 */
import fs from 'node:fs';
import readline from 'node:readline';

const SESSION_ID = 'fake-0000-0000-0000-000000000001';

// Lets a test assert on the flags the SDK actually launched us with.
if (process.env.FAKE_CLAUDE_ARGV_FILE) {
  try {
    fs.writeFileSync(process.env.FAKE_CLAUDE_ARGV_FILE, JSON.stringify(process.argv.slice(2)));
  } catch {
    /* the test will notice the missing file */
  }
}
const emit = (msg) => process.stdout.write(`${JSON.stringify(msg)}\n`);

/** request_id -> resolve, for permission answers coming back from the SDK. */
const pendingPermissions = new Map();
let turn = 0;

/**
 * The real CLI decides for itself whether a tool needs a human, and in
 * bypassPermissions it never asks — the SDK will not even forward the question.
 * A fixture that asks regardless would hang there waiting for an answer nobody
 * is coming to give.
 */
const modeFlag = process.argv.indexOf('--permission-mode');
let permissionMode = modeFlag === -1 ? 'default' : process.argv[modeFlag + 1] || 'default';

const respond = (requestId, response = {}) =>
  emit({ type: 'control_response', response: { request_id: requestId, subtype: 'success', response } });

function askPermission(toolName, input, toolUseId) {
  const requestId = `perm-${Math.random().toString(36).slice(2, 10)}`;
  return new Promise((resolve) => {
    pendingPermissions.set(requestId, resolve);
    emit({
      type: 'control_request',
      request_id: requestId,
      request: {
        subtype: 'can_use_tool',
        tool_name: toolName,
        input,
        tool_use_id: toolUseId,
        title: `Run ${toolName}`,
        display_name: toolName,
        description: `${toolName} wants to run`,
      },
    });
  });
}

async function runTurn(promptText, imageCount = 0) {
  turn += 1;
  // Echoed back so tests can assert images survived the trip to the process.
  if (imageCount) promptText = `${promptText} [+${imageCount} image]`;
  const messageId = `msg_${turn}`;
  const toolUseId = `toolu_${turn}`;

  // Streamed prose, delivered as deltas the way the real CLI does.
  emit({ type: 'stream_event', session_id: SESSION_ID, event: { type: 'message_start', message: { id: messageId } } });
  emit({
    type: 'stream_event',
    session_id: SESSION_ID,
    event: { type: 'content_block_start', index: 0, content_block: { type: 'text' } },
  });
  for (const chunk of ['Working', ' on', ' it.']) {
    emit({
      type: 'stream_event',
      session_id: SESSION_ID,
      event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: chunk } },
    });
  }
  emit({ type: 'stream_event', session_id: SESSION_ID, event: { type: 'content_block_stop', index: 0 } });

  emit({
    type: 'assistant',
    session_id: SESSION_ID,
    parent_tool_use_id: null,
    message: {
      id: messageId,
      role: 'assistant',
      content: [
        { type: 'text', text: 'Working on it.' },
        { type: 'tool_use', id: toolUseId, name: 'Bash', input: { command: `echo ${promptText}` } },
      ],
    },
  });

  const decision =
    permissionMode === 'bypassPermissions'
      ? { behavior: 'allow' }
      : await askPermission('Bash', { command: `echo ${promptText}` }, toolUseId);

  if (decision?.behavior === 'allow') {
    emit({
      type: 'user',
      session_id: SESSION_ID,
      parent_tool_use_id: null,
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUseId, content: promptText }] },
      tool_use_result: { stdout: promptText, stderr: '' },
    });
    emit({
      type: 'assistant',
      session_id: SESSION_ID,
      parent_tool_use_id: null,
      message: { id: `${messageId}b`, role: 'assistant', content: [{ type: 'text', text: `Done: ${promptText}` }] },
    });
    emit({
      type: 'result',
      subtype: 'success',
      session_id: SESSION_ID,
      is_error: false,
      duration_ms: 12,
      duration_api_ms: 10,
      num_turns: turn,
      result: `Done: ${promptText}`,
      total_cost_usd: 0.0012 * turn,
      usage: { input_tokens: 10, output_tokens: 20 },
      permission_denials: [],
    });
  } else {
    emit({
      type: 'user',
      session_id: SESSION_ID,
      parent_tool_use_id: null,
      message: {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: toolUseId, is_error: true, content: 'Denied by user' }],
      },
    });
    emit({
      type: 'result',
      subtype: 'success',
      session_id: SESSION_ID,
      is_error: false,
      duration_ms: 8,
      duration_api_ms: 5,
      num_turns: turn,
      result: 'Stopped: permission denied',
      total_cost_usd: 0.0005,
      usage: { input_tokens: 5, output_tokens: 5 },
      permission_denials: [{ tool_name: 'Bash', tool_use_id: toolUseId }],
    });
  }
}

const rl = readline.createInterface({ input: process.stdin });

rl.on('line', async (line) => {
  if (!line.trim()) return;
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }

  if (msg.type === 'control_request' && msg.request?.subtype === 'initialize') {
    respond(msg.request_id, { commands: [], outputStyle: 'default' });
    emit({
      type: 'system',
      subtype: 'init',
      session_id: SESSION_ID,
      cwd: process.cwd(),
      tools: ['Bash', 'Read', 'Edit'],
      mcp_servers: [],
      model: 'fake-model',
      permissionMode,
      slash_commands: [],
      apiKeySource: 'oauth',
      claude_code_version: '0.0.0-fake',
      output_style: 'default',
      skills: [],
      plugins: [],
      uuid: 'init-uuid',
    });
    return;
  }

  if (msg.type === 'control_request' && msg.request?.subtype === 'interrupt') {
    respond(msg.request_id, {});
    emit({
      type: 'result',
      subtype: 'success',
      session_id: SESSION_ID,
      is_error: false,
      duration_ms: 1,
      duration_api_ms: 0,
      num_turns: turn,
      result: 'Interrupted',
      total_cost_usd: 0,
      usage: {},
      permission_denials: [],
    });
    return;
  }

  if (msg.type === 'control_request' && msg.request?.subtype === 'set_model') {
    respond(msg.request_id, {});
    return;
  }

  if (msg.type === 'control_request' && msg.request?.subtype === 'set_permission_mode') {
    permissionMode = msg.request.mode || permissionMode;
    respond(msg.request_id, {});
    return;
  }

  if (msg.type === 'control_request') {
    // Anything else the SDK asks for gets a bland success.
    respond(msg.request_id, {});
    return;
  }

  if (msg.type === 'control_response') {
    const resolve = pendingPermissions.get(msg.response?.request_id);
    if (resolve) {
      pendingPermissions.delete(msg.response.request_id);
      resolve(msg.response.response);
    }
    return;
  }

  if (msg.type === 'user') {
    const content = msg.message?.content;
    if (typeof content === 'string') {
      await runTurn(content);
    } else if (Array.isArray(content)) {
      const text = content.find((b) => b?.type === 'text')?.text ?? '';
      const images = content.filter((b) => b?.type === 'image');
      // Verify the image blocks are shaped the way the API expects.
      for (const image of images) {
        if (image.source?.type !== 'base64' || !image.source?.media_type || !image.source?.data) {
          emit({ type: 'result', subtype: 'error', session_id: SESSION_ID, duration_ms: 1, error: 'malformed image block' });
          return;
        }
      }
      await runTurn(text, images.length);
    }
  }
});

rl.on('close', () => process.exit(0));
