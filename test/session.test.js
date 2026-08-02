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

    assert.ok(patches.length > 5, 'patches were emitted for the turn');
    assert.ok(patches.every((p) => p.sessionId === session.id));
    assert.ok(states.includes('busy') && states.includes('idle'));
    await manager.close(session.id);
  });
});
