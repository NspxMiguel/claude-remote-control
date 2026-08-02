/**
 * Drives the ACP driver against a fixture that speaks the real wire protocol
 * (JSON-RPC 2.0 over stdio), so remote permission approval for Cursor is
 * covered without Cursor being installed.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after, before, describe } from 'node:test';
import { fileURLToPath } from 'node:url';

const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'crc-acp-')));
const WORK = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'crc-acpwork-')));
process.env.CRC_CONFIG_DIR = TMP;

const { loadConfig } = await import('../src/config.js');
const { SessionManager } = await import('../src/agent/manager.js');
const acp = await import('../src/agent/drivers/acp.js');

const FIXTURE = fileURLToPath(new URL('./fixtures/fake-acp-agent.mjs', import.meta.url));

let manager;
let config;

before(() => {
  config = loadConfig();
  config.allowedRoots = [WORK];
  config.defaultCwd = WORK;
  config.acpExecutable = FIXTURE;
  config.permissionTimeoutSec = 5;
  manager = new SessionManager(config);
});

after(async () => {
  await manager.closeAll();
  for (const dir of [TMP, WORK]) fs.rmSync(dir, { recursive: true, force: true });
});

async function waitFor(session, predicate, label, timeoutMs = 15000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (predicate(session)) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  const dump = session.feed.items.map((i) => `${i.kind}:${i.status || i.state || ''}`).join(', ');
  assert.fail(`timed out waiting for ${label}. Feed was: [${dump}] status=${session.status}`);
}

const start = async (extra = {}) => {
  const session = manager.create({ cwd: WORK, driver: 'acp', ...extra });
  await waitFor(session, (s) => s.agentSessionId, 'the ACP handshake');
  return session;
};

describe('acp driver', () => {
  test('declares what it can and cannot do', () => {
    assert.equal(acp.id, 'acp');
    assert.equal(acp.capabilities.permissions, true, 'ACP is the interface that can ask a human');
    assert.equal(acp.capabilities.images, false, 'not implemented for this agent');
  });

  test('detect() reports cleanly when the agent is not installed', async () => {
    const status = await acp.detect({ acpExecutable: '/definitely/not/here/agent' });
    assert.equal(status.available, false);
    assert.match(status.fix, /cursor\.com\/install/);
  });

  test('handshakes and reports the session as ready', async () => {
    const session = await start();
    assert.equal(session.agentSessionId, 'acp-session-0001');
    assert.equal(session.agentVersion, 'fake-acp-1.0');
    assert.equal(session.status, 'idle');
    assert.ok(session.feed.items.some((i) => i.kind === 'system'));
    await manager.close(session.id);
  });

  test('a full turn streams text, asks permission and completes on approval', async () => {
    const session = await start();

    const asked = [];
    session.on('permission', (payload) => {
      asked.push(payload);
      session.decidePermission(payload.requestId, { decision: 'allow' });
    });

    session.send('hello-acp');
    await waitFor(session, (s) => s.feed.items.some((i) => i.kind === 'result'), 'the turn to finish');

    assert.equal(asked.length, 1, 'the phone was asked before the tool ran');
    assert.match(asked[0].title, /hello-acp/);

    const text = session.feed.items.filter((i) => i.kind === 'text').map((i) => i.text).join('');
    assert.match(text, /Working on hello-acp/, 'chunks were assembled in order');
    assert.match(text, /Done: hello-acp/);

    const tool = session.feed.items.find((i) => i.kind === 'tool');
    assert.equal(tool.status, 'done');
    assert.equal(tool.result, 'hello-acp');
    assert.equal(session.status, 'idle');
    await manager.close(session.id);
  });

  test('denying stops the tool and the turn still settles', async () => {
    const session = await start();
    session.on('permission', (p) => session.decidePermission(p.requestId, { decision: 'deny' }));

    session.send('DENYME');
    await waitFor(session, (s) => s.status === 'idle' && s.feed.items.some((i) => i.kind === 'result'), 'settle');

    const tool = session.feed.items.find((i) => i.kind === 'tool');
    assert.ok(['denied', 'error'].includes(tool.status), `expected denied/error, got ${tool.status}`);
    const permission = session.feed.items.find((i) => i.kind === 'permission');
    assert.equal(permission.state, 'denied');
    await manager.close(session.id);
  });

  test('a tool that fails is shown as failed', async () => {
    const session = await start();
    session.on('permission', (p) => session.decidePermission(p.requestId, { decision: 'allow' }));

    session.send('FAILTOOL');
    await waitFor(session, (s) => s.feed.items.some((i) => i.kind === 'result'), 'the turn to finish');
    assert.equal(session.feed.items.find((i) => i.kind === 'tool').status, 'error');
    await manager.close(session.id);
  });

  test('a tool the agent does not ask about still appears', async () => {
    const session = await start();
    let asked = 0;
    session.on('permission', () => {
      asked++;
    });

    session.send('NOPERM');
    await waitFor(session, (s) => s.feed.items.some((i) => i.kind === 'result'), 'the turn to finish');
    assert.equal(asked, 0);
    assert.equal(session.feed.items.find((i) => i.kind === 'tool').status, 'done');
    await manager.close(session.id);
  });

  test('handles several turns in one session', async () => {
    const session = await start();
    session.on('permission', (p) => session.decidePermission(p.requestId, { decision: 'allow' }));

    session.send('first');
    await waitFor(session, (s) => s.feed.items.filter((i) => i.kind === 'result').length === 1, 'turn 1');
    session.send('second');
    await waitFor(session, (s) => s.feed.items.filter((i) => i.kind === 'result').length === 2, 'turn 2');

    assert.equal(session.numTurns, 2);
    assert.equal(session.feed.items.filter((i) => i.kind === 'tool').length, 2);
    await manager.close(session.id);
  });

  test('tool calls are grouped and ordered like any other agent', async () => {
    const session = await start();
    session.on('permission', (p) => session.decidePermission(p.requestId, { decision: 'allow' }));
    session.send('ordering');
    await waitFor(session, (s) => s.feed.items.some((i) => i.kind === 'result'), 'the turn to finish');

    const ords = session.feed.items.map((i) => i.ord);
    assert.deepEqual(ords, [...ords].sort((a, b) => a - b));
    const tool = session.feed.items.find((i) => i.kind === 'tool');
    assert.ok(tool.group, 'tools carry a group id whatever the agent');
    assert.equal(tool.toolKind, 'other');
    await manager.close(session.id);
  });

  test('a missing binary fails the session with an install hint', async () => {
    const previous = config.acpExecutable;
    config.acpExecutable = '/definitely/not/here/agent';
    const session = manager.create({ cwd: WORK, driver: 'acp' });
    try {
      await waitFor(session, (s) => s.status === 'error', 'the failure to surface');
      assert.match(session.lastError, /not installed|cursor\.com\/install/i);
    } finally {
      config.acpExecutable = previous;
      await manager.close(session.id);
    }
  });

  test('images are refused rather than silently dropped', async () => {
    const session = await start();
    const pixel = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
    assert.throws(
      () => session.send('look', [{ mediaType: 'image/png', data: pixel }]),
      /cannot accept images/,
    );
    await manager.close(session.id);
  });
});
