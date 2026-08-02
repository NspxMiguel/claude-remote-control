/**
 * Drives a full session against a fake Claude Code executable (see
 * fixtures/fake-claude.mjs), so the whole path — streaming, tool calls, remote
 * permission approval, interrupts, resume — is exercised without credentials.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after, before, describe } from 'node:test';
import { fileURLToPath } from 'node:url';

const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'crc-session-')));
const WORK = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'crc-swork-')));
process.env.CRC_CONFIG_DIR = TMP;

const { loadConfig } = await import('../src/config.js');
const { SessionManager } = await import('../src/agent/manager.js');

const FAKE_CLAUDE = fileURLToPath(new URL('./fixtures/fake-claude.mjs', import.meta.url));

let manager;
let config;

before(() => {
  config = loadConfig();
  config.allowedRoots = [WORK];
  config.defaultCwd = WORK;
  config.claudeExecutable = FAKE_CLAUDE;
  config.permissionTimeoutSec = 5;
  manager = new SessionManager(config);
});

after(async () => {
  await manager.closeAll();
  for (const dir of [TMP, WORK]) fs.rmSync(dir, { recursive: true, force: true });
});

/** Wait until `predicate` holds, or fail with what the feed actually contained. */
async function waitFor(session, predicate, label, timeoutMs = 15000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (predicate(session)) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  const dump = session.feed.items.map((i) => `${i.kind}:${i.status || i.state || ''}`).join(', ');
  assert.fail(`timed out waiting for ${label}. Feed was: [${dump}] status=${session.status}`);
}

describe('session lifecycle', () => {
  test('starts, reports init, and goes idle', async () => {
    const session = manager.create({ cwd: WORK });
    await waitFor(session, (s) => s.claudeSessionId, 'init');

    assert.equal(session.claudeVersion, '0.0.0-fake');
    assert.equal(session.status, 'idle');
    assert.deepEqual(session.tools, ['Bash', 'Read', 'Edit']);
    assert.ok(session.feed.items.some((i) => i.kind === 'system'));
    await manager.close(session.id);
  });

  test('a prompt streams text, asks permission, and finishes on approval', async () => {
    const session = manager.create({ cwd: WORK });
    await waitFor(session, (s) => s.claudeSessionId, 'init');

    const asked = [];
    session.on('permission', (payload) => {
      asked.push(payload);
      session.decidePermission(payload.requestId, { decision: 'allow' });
    });

    session.send('hello-world');
    assert.equal(session.status, 'busy');

    await waitFor(session, (s) => s.feed.items.some((i) => i.kind === 'result'), 'result');

    assert.equal(asked.length, 1);
    assert.equal(asked[0].toolName, 'Bash');
    assert.equal(asked[0].subtitle, 'echo hello-world');

    const kinds = session.feed.items.map((i) => i.kind);
    assert.ok(kinds.includes('user'), 'the prompt is echoed into the feed');
    assert.ok(kinds.includes('text'), 'assistant prose arrived');

    const tool = session.feed.items.find((i) => i.kind === 'tool');
    assert.equal(tool.status, 'done');
    assert.equal(tool.result, 'hello-world');

    const texts = session.feed.items.filter((i) => i.kind === 'text').map((i) => i.text);
    assert.ok(texts.includes('Working on it.'), 'streamed text reconciled without duplication');
    assert.equal(texts.filter((t) => t === 'Working on it.').length, 1);

    assert.equal(session.status, 'idle');
    assert.ok(session.totalCostUsd > 0);
    await manager.close(session.id);
  });

  test('denying a permission marks the tool denied and the turn still completes', async () => {
    const session = manager.create({ cwd: WORK });
    await waitFor(session, (s) => s.claudeSessionId, 'init');

    session.on('permission', (payload) =>
      session.decidePermission(payload.requestId, { decision: 'deny', message: 'no thanks' }),
    );

    session.send('dangerous-thing');
    await waitFor(session, (s) => s.feed.items.some((i) => i.kind === 'result'), 'result');

    const tool = session.feed.items.find((i) => i.kind === 'tool');
    assert.ok(['denied', 'error'].includes(tool.status), `expected denied/error, got ${tool.status}`);

    const permItem = session.feed.items.find((i) => i.kind === 'permission');
    assert.equal(permItem.state, 'denied');
    assert.equal(session.status, 'idle');
    await manager.close(session.id);
  });

  test('an unanswered permission is denied after the timeout', async () => {
    const session = manager.create({ cwd: WORK });
    await waitFor(session, (s) => s.claudeSessionId, 'init');

    session.send('ignored-prompt');
    await waitFor(session, (s) => s.pendingPermissions.size === 1, 'a pending permission');

    // config.permissionTimeoutSec is 5s in this suite.
    await waitFor(
      session,
      (s) => s.feed.items.some((i) => i.kind === 'permission' && i.state === 'timeout'),
      'the permission to time out',
      12000,
    );
    assert.equal(session.pendingPermissions.size, 0);
    await manager.close(session.id);
  });

  test('handles several turns in one session', async () => {
    const session = manager.create({ cwd: WORK });
    await waitFor(session, (s) => s.claudeSessionId, 'init');
    session.on('permission', (p) => session.decidePermission(p.requestId, { decision: 'allow' }));

    session.send('first');
    await waitFor(session, (s) => s.feed.items.filter((i) => i.kind === 'result').length === 1, 'turn 1');
    session.send('second');
    await waitFor(session, (s) => s.feed.items.filter((i) => i.kind === 'result').length === 2, 'turn 2');

    assert.equal(session.numTurns, 2);
    const tools = session.feed.items.filter((i) => i.kind === 'tool');
    assert.equal(tools.length, 2);
    assert.deepEqual(tools.map((t) => t.subtitle), ['echo first', 'echo second']);
    await manager.close(session.id);
  });

  test('feed ordering survives a full turn', async () => {
    const session = manager.create({ cwd: WORK });
    await waitFor(session, (s) => s.claudeSessionId, 'init');
    session.on('permission', (p) => session.decidePermission(p.requestId, { decision: 'allow' }));

    session.send('ordering-check');
    await waitFor(session, (s) => s.feed.items.some((i) => i.kind === 'result'), 'result');

    const ords = session.feed.items.map((i) => i.ord);
    assert.deepEqual(ords, [...ords].sort((a, b) => a - b), 'creation order is monotonic');

    const replay = session.feed.snapshot(0);
    assert.deepEqual(
      replay.map((i) => i.id),
      session.feed.items.map((i) => i.id),
      'replay matches live order',
    );
    await manager.close(session.id);
  });
});

describe('tool policy', () => {
  test('disallowed tools actually reach the Claude Code process', async () => {
    const argvFile = path.join(WORK, 'argv.json');
    process.env.FAKE_CLAUDE_ARGV_FILE = argvFile;

    const session = manager.create({ cwd: WORK });
    try {
      await waitFor(session, (s) => s.claudeSessionId, 'init');
      const argv = JSON.parse(fs.readFileSync(argvFile, 'utf8'));
      const flat = argv.join(' ');

      assert.match(flat, /AskUserQuestion/, 'the default policy is on the command line');
      assert.match(flat, /--disallowed[Tt]ools/, 'passed as the disallowed-tools flag');
    } finally {
      delete process.env.FAKE_CLAUDE_ARGV_FILE;
      await manager.close(session.id);
    }
  });

  test('the default policy refuses the tool that would stall a turn', () => {
    assert.ok(config.disallowedTools.includes('AskUserQuestion'));
  });
});

describe('failure reporting', () => {
  test('a missing Claude Code install explains the fix in this app’s terms', async () => {
    const previous = config.claudeExecutable;
    config.claudeExecutable = '/nonexistent/claude-binary';
    const session = manager.create({ cwd: WORK });
    try {
      await waitFor(session, (s) => s.status === 'error', 'the failure to surface', 20000);
      assert.match(session.lastError, /could not be found/i);
      assert.match(session.lastError, /claudeExecutable/, 'names the config key to set');
      assert.ok(
        !/pathToClaudeCodeExecutable/.test(session.lastError),
        'does not leak SDK option names at the user',
      );
      assert.ok(session.feed.items.some((i) => i.kind === 'error'), 'the phone sees it in the feed');
    } finally {
      config.claudeExecutable = previous;
      await manager.close(session.id);
    }
  });
});

describe('image attachments', () => {
  // A 1x1 PNG, base64.
  const PIXEL =
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

  test('accepts a valid image and records it on the feed without the bytes', async () => {
    const session = manager.create({ cwd: WORK });
    await waitFor(session, (s) => s.claudeSessionId, 'init');
    session.on('permission', (p) => session.decidePermission(p.requestId, { decision: 'allow' }));

    assert.equal(session.send('what is this?', [{ mediaType: 'image/png', data: PIXEL }]), true);

    const userItem = session.feed.items.find((i) => i.kind === 'user');
    assert.equal(userItem.attachments, 1);
    assert.equal(userItem.text, 'what is this?');
    assert.ok(!JSON.stringify(userItem).includes(PIXEL), 'base64 is not replayed in the feed');
    await manager.close(session.id);
  });

  test('the image block actually reaches the Claude process, correctly shaped', async () => {
    const session = manager.create({ cwd: WORK });
    await waitFor(session, (s) => s.claudeSessionId, 'init');
    session.on('permission', (p) => session.decidePermission(p.requestId, { decision: 'allow' }));

    session.send('describe this', [
      { mediaType: 'image/png', data: PIXEL },
      { mediaType: 'image/jpeg', data: PIXEL },
    ]);
    await waitFor(session, (s) => s.feed.items.some((i) => i.kind === 'result'), 'result');

    // The fixture rejects malformed image blocks outright, so reaching a normal
    // result already proves the shape; the echo confirms the count.
    const texts = session.feed.items.filter((i) => i.kind === 'text').map((i) => i.text);
    assert.ok(
      texts.some((t) => t.includes('[+2 image]')),
      `expected the process to report 2 images, got: ${texts.join(' | ')}`,
    );
    assert.ok(!session.feed.items.some((i) => i.kind === 'error'), 'no malformed-image error');
    await manager.close(session.id);
  });

  test('an image with no text is still a message', async () => {
    const session = manager.create({ cwd: WORK });
    await waitFor(session, (s) => s.claudeSessionId, 'init');
    assert.equal(session.send('', [{ mediaType: 'image/png', data: PIXEL }]), true);
    await manager.close(session.id);
  });

  test('rejects unsupported types, bad base64, oversize and too many', async () => {
    const session = manager.create({ cwd: WORK });
    await waitFor(session, (s) => s.claudeSessionId, 'init');

    assert.throws(
      () => session.send('x', [{ mediaType: 'image/svg+xml', data: PIXEL }]),
      /Unsupported image type/,
    );
    assert.throws(() => session.send('x', [{ mediaType: 'image/png', data: 'not base64!' }]), /valid base64/);
    assert.throws(() => session.send('x', [{ mediaType: 'image/png' }]), /data is missing/);
    assert.throws(
      () => session.send('x', [{ mediaType: 'image/png', data: 'A'.repeat(6 * 1024 * 1024) }]),
      /too large/,
    );
    assert.throws(
      () => session.send('x', Array.from({ length: 5 }, () => ({ mediaType: 'image/png', data: PIXEL }))),
      /At most 4 images/,
    );
    await manager.close(session.id);
  });

  test('an empty message with no images is still ignored', async () => {
    const session = manager.create({ cwd: WORK });
    await waitFor(session, (s) => s.claudeSessionId, 'init');
    assert.equal(session.send('', []), false);
    assert.equal(session.send('   ', undefined), false);
    await manager.close(session.id);
  });
});

describe('session control', () => {
  test('interrupt returns the session to idle', async () => {
    const session = manager.create({ cwd: WORK });
    await waitFor(session, (s) => s.claudeSessionId, 'init');

    session.send('long-running');
    await waitFor(session, (s) => s.pendingPermissions.size === 1, 'a pending permission');

    await session.interrupt();
    assert.equal(session.status, 'idle');
    await manager.close(session.id);
  });

  test('sending to a closed session is refused', async () => {
    const session = manager.create({ cwd: WORK });
    await waitFor(session, (s) => s.claudeSessionId, 'init');
    await manager.close(session.id);
    assert.throws(() => session.send('too late'), /has ended/);
  });

  test('empty prompts are ignored', async () => {
    const session = manager.create({ cwd: WORK });
    await waitFor(session, (s) => s.claudeSessionId, 'init');
    assert.equal(session.send('   '), false);
    assert.equal(session.send(''), false);
    await manager.close(session.id);
  });
});

describe('manager', () => {
  test('tracks and lists sessions, then cleans up', async () => {
    const a = manager.create({ cwd: WORK });
    const b = manager.create({ cwd: WORK });
    await waitFor(a, (s) => s.claudeSessionId, 'init a');
    await waitFor(b, (s) => s.claudeSessionId, 'init b');

    const ids = manager.list().map((s) => s.id);
    assert.ok(ids.includes(a.id) && ids.includes(b.id));

    assert.equal(await manager.close(a.id), true);
    assert.equal(await manager.close(a.id), false, 'closing twice is a no-op');
    assert.equal(manager.get(a.id), null);
    await manager.close(b.id);
  });

  test('refuses to start more sessions than the cap allows', async () => {
    const previous = config.maxSessions;
    config.maxSessions = 2;
    const made = [];
    try {
      made.push(manager.create({ cwd: WORK }), manager.create({ cwd: WORK }));
      assert.throws(() => manager.create({ cwd: WORK }), /Already running 2 sessions/);

      // Let both finish starting, so no late init patches leak into later tests.
      for (const session of made) await waitFor(session, (s) => s.claudeSessionId, 'init');

      // Ending one frees a slot.
      await manager.close(made.pop().id);
      const replacement = manager.create({ cwd: WORK });
      await waitFor(replacement, (s) => s.claudeSessionId, 'replacement init');
      made.push(replacement);
    } finally {
      for (const session of made) await manager.close(session.id);
      config.maxSessions = previous;
    }
  });

  test('patches and state changes reach subscribers', async () => {
    const patches = [];
    const states = [];
    manager.on('patch', (p) => patches.push(p));
    manager.on('state', (s) => states.push(s.status));

    const session = manager.create({ cwd: WORK });
    await waitFor(session, (s) => s.claudeSessionId, 'init');
    session.on('permission', (p) => session.decidePermission(p.requestId, { decision: 'allow' }));
    session.send('emit-check');
    await waitFor(session, (s) => s.feed.items.some((i) => i.kind === 'result'), 'result');

    // The manager is shared across tests, so count only this session's patches.
    assert.ok(patches.filter((p) => p.sessionId === session.id).length > 5, 'patches were emitted');
    assert.ok(patches.every((p) => typeof p.sessionId === 'string'), 'every patch is attributed');
    assert.ok(states.includes('busy') && states.includes('idle'));
    await manager.close(session.id);
  });
});
