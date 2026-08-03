/**
 * Messages typed while the agent is working.
 *
 * The queue lives on the daemon rather than the phone, so locking the screen
 * does not lose what you typed — which means these are unit tests over the
 * Session's own bookkeeping, with a driver that never answers on its own.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after, before, describe } from 'node:test';

const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'crc-queue-')));
const WORK = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'crc-qwork-')));
process.env.CRC_CONFIG_DIR = TMP;

const { loadConfig } = await import('../src/config.js');
const { Session } = await import('../src/agent/session.js');
const { DRIVERS } = await import('../src/agent/drivers/index.js');

/** A driver that receives prompts and does nothing else, so nothing drains by itself. */
const sent = [];
const stub = {
  id: 'stub',
  label: 'Stub',
  capabilities: { streaming: false, permissions: false, interrupt: true, models: false, resume: false, images: true },
  createDriver: () => ({
    id: 'stub',
    capabilities: stub.capabilities,
    start: () => {},
    send: (text) => sent.push(text),
    closed: false,
    interrupt: async () => {},
    close: async () => {},
  }),
};

let config;

before(() => {
  DRIVERS.push(stub);
  config = loadConfig();
  config.allowedRoots = [WORK];
  config.defaultCwd = WORK;
});

after(() => {
  for (const dir of [TMP, WORK]) fs.rmSync(dir, { recursive: true, force: true });
});

function session() {
  sent.length = 0;
  const s = new Session({ config, cwd: WORK, driver: 'stub' });
  s.setStatus('idle');
  return s;
}

describe('the queue', () => {
  test('the first message goes straight out, the rest wait', () => {
    const s = session();
    s.send('one');
    assert.equal(s.status, 'busy');
    assert.deepEqual(sent, ['one']);

    s.send('two');
    s.send('three');
    assert.deepEqual(sent, ['one'], 'nothing else reaches the agent while it works');
    assert.equal(s.queue.length, 2);
    assert.equal(s.toJSON().queued, 2);
  });

  test('what is waiting is in the feed, marked as waiting', () => {
    const s = session();
    s.send('one');
    s.send('two');

    const users = s.feed.items.filter((i) => i.kind === 'user');
    assert.equal(users.length, 2, 'you can see what you typed, not just a counter');
    assert.equal(users[0].queued, undefined);
    assert.equal(users[1].queued, true);
  });

  test('finishing a turn sends the next one, and only the next one', () => {
    const s = session();
    s.send('one');
    s.send('two');
    s.send('three');

    s.setStatus('idle');
    assert.deepEqual(sent, ['one', 'two']);
    assert.equal(s.status, 'busy', 'sending the next one makes it busy again');
    assert.equal(s.queue.length, 1);

    s.setStatus('idle');
    assert.deepEqual(sent, ['one', 'two', 'three']);
    assert.equal(s.queue.length, 0);
  });

  test('a queued message can be taken back before it goes', () => {
    const s = session();
    s.send('one');
    s.send('regret');
    const waiting = s.feed.items.filter((i) => i.kind === 'user').at(-1);

    assert.equal(s.cancelQueued(waiting.id), true);
    assert.equal(s.queue.length, 0);
    assert.equal(waiting.cancelled, true);
    assert.equal(waiting.queued, undefined);

    s.setStatus('idle');
    assert.deepEqual(sent, ['one'], 'a cancelled message never reaches the agent');
  });

  test('one already sent cannot be taken back', () => {
    const s = session();
    s.send('gone');
    const item = s.feed.items.find((i) => i.kind === 'user');
    assert.equal(s.cancelQueued(item.id), false);
  });

  test('interrupting drops the queue rather than restarting a second later', async () => {
    const s = session();
    s.send('one');
    s.send('two');
    s.send('three');

    await s.interrupt();
    assert.equal(s.queue.length, 0);
    assert.deepEqual(sent, ['one'], 'stop means stop');
    assert.match(s.feed.items.at(-1).text, /2 queued messages dropped/);
  });

  test('typing before the agent has started still queues rather than vanishing', () => {
    sent.length = 0;
    const s = new Session({ config, cwd: WORK, driver: 'stub' }); // status: starting
    s.send('early');
    assert.equal(s.queue.length, 1);
    assert.deepEqual(sent, []);

    s.setStatus('idle');
    assert.deepEqual(sent, ['early']);
  });
});
