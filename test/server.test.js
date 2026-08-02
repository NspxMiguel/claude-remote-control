import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after, before, describe } from 'node:test';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

// realpath because macOS hands out /var/... paths that are symlinks to /private/var/...,
// and the daemon resolves symlinks before checking them against allowedRoots.
const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'crc-server-')));
const WORK = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'crc-work-')));
const PROJECTS = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'crc-projects-')));
process.env.CRC_CONFIG_DIR = TMP;
process.env.CRC_PROJECTS_DIR = PROJECTS;

const { loadConfig, saveConfig } = await import('../src/config.js');
const { RemoteControlServer } = await import('../src/server.js');

// A transcript that looks like one Claude Desktop would leave behind.
const SESSION_ID = '11111111-2222-3333-4444-555555555555';
fs.mkdirSync(path.join(PROJECTS, '-tmp-demo'), { recursive: true });
fs.writeFileSync(
  path.join(PROJECTS, '-tmp-demo', `${SESSION_ID}.jsonl`),
  [
    JSON.stringify({
      type: 'user',
      cwd: WORK,
      entrypoint: 'claude-desktop',
      timestamp: '2026-08-02T03:00:00.000Z',
      message: { role: 'user', content: 'hello from the desktop app' },
    }),
    JSON.stringify({ type: 'ai-title', aiTitle: 'Desktop conversation' }),
    JSON.stringify({
      type: 'assistant',
      message: { content: [{ type: 'text', text: 'Hi there' }] },
    }),
    '',
  ].join('\n'),
);

fs.mkdirSync(path.join(WORK, 'subdir'), { recursive: true });
fs.mkdirSync(path.join(WORK, '.hidden'), { recursive: true });

let server;
let base;
let config;

before(async () => {
  config = loadConfig();
  config.port = 0;
  config.host = '127.0.0.1';
  config.allowedRoots = [WORK];
  config.defaultCwd = WORK;
  // Live sessions run against the fake Claude Code, so the suite needs no credentials.
  config.claudeExecutable = fileURLToPath(new URL('./fixtures/fake-claude.mjs', import.meta.url));
  config.permissionTimeoutSec = 10;
  saveConfig(config);

  server = new RemoteControlServer(config);
  const address = await server.listen();
  base = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  await server?.close();
  for (const dir of [TMP, WORK, PROJECTS]) fs.rmSync(dir, { recursive: true, force: true });
});

const get = (p, token = config.token, opts = {}) =>
  fetch(base + p, {
    ...opts,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...(opts.headers || {}) },
  });

describe('authentication', () => {
  test('health needs no token', async () => {
    const res = await fetch(`${base}/api/health`);
    assert.equal(res.status, 200);
    assert.equal((await res.json()).ok, true);
  });

  test('api routes reject a missing or wrong token', async () => {
    assert.equal((await fetch(`${base}/api/state`)).status, 401);
    assert.equal((await get('/api/state', 'nonsense')).status, 401);
  });

  test('the master token is accepted', async () => {
    const res = await get('/api/state');
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.identity, 'master');
    assert.ok(Array.isArray(body.urls) && body.urls.length > 0);
  });

  test('a device token is accepted but is not master', async () => {
    const paired = await fetch(`${base}/api/pair`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: config.token, name: 'Test phone' }),
    });
    assert.equal(paired.status, 200);
    const { token } = await paired.json();

    const state = await (await get('/api/state', token)).json();
    assert.equal(state.identity, 'device');
    // A paired device can already run commands as you, so it manages devices too.
    assert.ok(Array.isArray(state.devices));
    assert.ok(
      state.devices.every((d) => d.token === undefined),
      'device tokens are never handed back out',
    );
    assert.equal((await get('/api/pair/code', token, { method: 'POST' })).status, 200);
  });

  test('a device can revoke itself, which is how "sign out" works', async () => {
    const { token, device } = await (
      await fetch(`${base}/api/pair`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ token: config.token, name: 'Self-revoker' }),
      })
    ).json();

    const res = await get(`/api/devices/${device.id}`, token, { method: 'DELETE' });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { revoked: true, self: true });
    assert.equal((await get('/api/state', token)).status, 401, 'the token stops working immediately');
  });

  test('pairing refuses a bad code', async () => {
    const res = await fetch(`${base}/api/pair`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: '000000' }),
    });
    assert.equal(res.status, 401);
  });

  test('a pairing code issued by the master works once', async () => {
    const { code } = await (await get('/api/pair/code', config.token, { method: 'POST' })).json();
    const first = await fetch(`${base}/api/pair`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code, name: 'Coded device' }),
    });
    assert.equal(first.status, 200);

    const second = await fetch(`${base}/api/pair`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code }),
    });
    assert.equal(second.status, 401, 'a pairing code cannot be replayed');
  });

  test('a revoked device loses access', async () => {
    const { token, device } = await (
      await fetch(`${base}/api/pair`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ token: config.token, name: 'Doomed' }),
      })
    ).json();
    assert.equal((await get('/api/state', token)).status, 200);
    await get(`/api/devices/${device.id}`, config.token, { method: 'DELETE' });
    assert.equal((await get('/api/state', token)).status, 401);
  });
});

describe('filesystem picker', () => {
  test('lists directories inside an allowed root, hiding dotfiles', async () => {
    const body = await (await get(`/api/fs?path=${encodeURIComponent(WORK)}`)).json();
    assert.equal(body.path, WORK);
    const names = body.dirs.map((d) => d.name);
    assert.ok(names.includes('subdir'));
    assert.ok(!names.includes('.hidden'));
  });

  test('refuses to escape the allowed roots', async () => {
    assert.equal((await get('/api/fs?path=/etc')).status, 403);
    assert.equal((await get(`/api/fs?path=${encodeURIComponent(`${WORK}/../..`)}`)).status, 403);
  });

  test('refuses a symlink that points out of an allowed root', async () => {
    const link = path.join(WORK, 'escape-hatch');
    fs.symlinkSync('/etc', link);
    try {
      assert.equal((await get(`/api/fs?path=${encodeURIComponent(link)}`)).status, 403);
      const session = await get('/api/sessions', config.token, {
        method: 'POST',
        body: JSON.stringify({ cwd: link }),
      });
      assert.equal(session.status, 403);
    } finally {
      fs.unlinkSync(link);
    }
  });
});

describe('sessions', () => {
  test('creating a session outside the allowed roots is refused', async () => {
    const res = await get('/api/sessions', config.token, {
      method: 'POST',
      body: JSON.stringify({ cwd: '/etc' }),
    });
    assert.equal(res.status, 403);
  });

  test('creating a session in a non-existent directory is refused', async () => {
    const res = await get('/api/sessions', config.token, {
      method: 'POST',
      body: JSON.stringify({ cwd: path.join(WORK, 'does-not-exist') }),
    });
    // Allowed root, but nothing there: a bad request rather than a policy denial.
    assert.equal(res.status, 400);
  });

  test('unknown session ids return 404', async () => {
    assert.equal((await get('/api/sessions/nope/interrupt', config.token, { method: 'POST' })).status, 404);
  });

  test('the session list starts empty', async () => {
    const { sessions } = await (await get('/api/sessions')).json();
    assert.deepEqual(sessions, []);
  });
});

describe('transcript mirroring', () => {
  test('lists transcripts found on disk', async () => {
    const { transcripts } = await (await get('/api/transcripts')).json();
    const found = transcripts.find((t) => t.id === SESSION_ID);
    assert.ok(found, 'the seeded transcript is listed');
    assert.equal(found.entrypoint, 'claude-desktop');
    assert.equal(found.title, 'Desktop conversation');
  });

  test('opens a mirror and replays its feed', async () => {
    const opened = await (await get(`/api/transcripts/${SESSION_ID}/mirror`, config.token, { method: 'POST' })).json();
    assert.equal(opened.session.readOnly, true);

    const feed = await (await get(`/api/sessions/${SESSION_ID}/feed?since=0`)).json();
    const kinds = feed.items.map((i) => i.kind);
    assert.ok(kinds.includes('user'));
    assert.ok(kinds.includes('text'));
  });

  test('picks up lines appended after the mirror opened', async () => {
    const file = path.join(PROJECTS, '-tmp-demo', `${SESSION_ID}.jsonl`);
    const before = await (await get(`/api/sessions/${SESSION_ID}/feed?since=0`)).json();

    fs.appendFileSync(
      file,
      `${JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'appended later' }] } })}\n`,
    );

    // The tailer polls, so wait for it rather than assuming instant delivery.
    let after = before;
    for (let i = 0; i < 40 && after.items.length === before.items.length; i++) {
      await new Promise((r) => setTimeout(r, 100));
      after = await (await get(`/api/sessions/${SESSION_ID}/feed?since=0`)).json();
    }
    assert.ok(after.items.some((i) => i.text === 'appended later'), 'new line reached the feed');
  });

  test('mirrors nobody is watching are released', async () => {
    await get(`/api/transcripts/${SESSION_ID}/mirror`, config.token, { method: 'POST' });
    assert.ok(server.mirrors.get(SESSION_ID), 'the mirror is open');

    // No websocket client is subscribed to it, so the sweep should collect it.
    server.sweepIdleMirrors();
    assert.equal(server.mirrors.get(SESSION_ID), null, 'the mirror was closed');

    // A subscribed client keeps it alive.
    const ws = new WebSocket(`${base.replace('http', 'ws')}/ws?token=${encodeURIComponent(config.token)}`);
    await new Promise((resolve) => ws.on('open', resolve));
    ws.send(JSON.stringify({ t: 'subscribe', sessionId: SESSION_ID, since: 0 }));
    await new Promise((resolve) => {
      ws.on('message', (raw) => {
        if (JSON.parse(raw.toString()).t === 'feed') resolve();
      });
    });

    server.sweepIdleMirrors();
    assert.ok(server.mirrors.get(SESSION_ID), 'a watched mirror survives the sweep');
    ws.close();
  });

  test('a bogus session id is a 404, and path tricks are refused', async () => {
    assert.equal((await get('/api/transcripts/ghost/mirror', config.token, { method: 'POST' })).status, 404);
    assert.equal(
      (await get('/api/transcripts/..%2F..%2Fetc%2Fpasswd/mirror', config.token, { method: 'POST' })).status,
      404,
    );
  });
});

describe('static assets', () => {
  test('serves the app shell', async () => {
    const res = await fetch(`${base}/`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /text\/html/);
    assert.match(await res.text(), /Claude Remote Control/);
  });

  test('revalidates app code and returns 304 when unchanged', async () => {
    const first = await fetch(`${base}/app.js`);
    assert.equal(first.headers.get('cache-control'), 'no-cache');
    const etag = first.headers.get('etag');
    assert.ok(etag);

    const second = await fetch(`${base}/app.js`, { headers: { 'if-none-match': etag } });
    assert.equal(second.status, 304);
  });

  test('unknown paths fall back to the shell for client-side routing', async () => {
    const res = await fetch(`${base}/some/deep/route`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /text\/html/);
  });

  test('cannot read files outside the web directory', async () => {
    const res = await fetch(`${base}/../package.json`, { redirect: 'manual' });
    const body = await res.text();
    assert.ok(!body.includes('"claude-remote-control"') || res.status !== 200, 'package.json is not served');
  });
});

describe('websocket', () => {
  test('rejects a connection without a valid token', async () => {
    const ws = new WebSocket(`${base.replace('http', 'ws')}/ws?token=bad`);
    const error = await new Promise((resolve) => {
      ws.on('error', resolve);
      ws.on('open', () => resolve(null));
    });
    assert.ok(error, 'the socket was refused');
  });

  test('accepts a valid token and greets the client', async () => {
    const ws = new WebSocket(`${base.replace('http', 'ws')}/ws?token=${encodeURIComponent(config.token)}`);
    const hello = await new Promise((resolve, reject) => {
      ws.on('message', (raw) => resolve(JSON.parse(raw.toString())));
      ws.on('error', reject);
      setTimeout(() => reject(new Error('timed out')), 4000);
    });
    assert.equal(hello.t, 'hello');
    assert.ok(Array.isArray(hello.sessions));
    ws.close();
  });

  test('subscribing streams the feed of a mirrored session', async () => {
    const ws = new WebSocket(`${base.replace('http', 'ws')}/ws?token=${encodeURIComponent(config.token)}`);
    await new Promise((resolve) => ws.on('open', resolve));
    ws.send(JSON.stringify({ t: 'subscribe', sessionId: SESSION_ID, since: 0 }));

    const feed = await new Promise((resolve, reject) => {
      ws.on('message', (raw) => {
        const msg = JSON.parse(raw.toString());
        if (msg.t === 'feed') resolve(msg);
      });
      setTimeout(() => reject(new Error('no feed message')), 4000);
    });
    assert.equal(feed.sessionId, SESSION_ID);
    assert.ok(feed.items.length > 0);
    ws.close();
  });

  test('a full turn works over the socket: prompt, permission, result', async () => {
    const { session } = await (
      await get('/api/sessions', config.token, { method: 'POST', body: JSON.stringify({ cwd: WORK }) })
    ).json();

    const ws = new WebSocket(`${base.replace('http', 'ws')}/ws?token=${encodeURIComponent(config.token)}`);
    await new Promise((resolve) => ws.on('open', resolve));
    ws.send(JSON.stringify({ t: 'subscribe', sessionId: session.id, since: 0 }));

    const seen = { tools: new Map(), texts: [], result: null, permission: null };

    const finished = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('turn never completed')), 20000);
      ws.on('message', (raw) => {
        const msg = JSON.parse(raw.toString());

        if (msg.t === 'permission') {
          seen.permission = msg.payload;
          // Approve from "the phone".
          ws.send(
            JSON.stringify({
              t: 'permission',
              sessionId: session.id,
              requestId: msg.payload.requestId,
              decision: 'allow',
            }),
          );
        }
        if (msg.t === 'patch' && msg.item) {
          if (msg.item.kind === 'tool') seen.tools.set(msg.item.id, msg.item);
          if (msg.item.kind === 'text') seen.texts.push(msg.item.text);
          if (msg.item.kind === 'result') {
            seen.result = msg.item;
            clearTimeout(timer);
            resolve();
          }
        }
      });
    });

    // Wait for the session to come up before prompting it.
    for (let i = 0; i < 60; i++) {
      const state = await (await get(`/api/sessions/${session.id}/feed?since=0`)).json();
      if (state.state.status === 'idle') break;
      await new Promise((r) => setTimeout(r, 100));
    }

    ws.send(JSON.stringify({ t: 'prompt', sessionId: session.id, text: 'socket-turn' }));
    await finished;

    assert.ok(seen.permission, 'the phone was asked for permission');
    assert.equal(seen.permission.toolName, 'Bash');
    assert.equal(seen.permission.subtitle, 'echo socket-turn');

    const tool = [...seen.tools.values()].at(-1);
    assert.equal(tool.status, 'done');
    assert.equal(tool.result, 'socket-turn');
    assert.ok(seen.texts.some((t) => t.includes('Done: socket-turn')));
    assert.ok(seen.result.costUsd > 0);

    // A late-joining client can replay the same conversation over REST.
    const replay = await (await get(`/api/sessions/${session.id}/feed?since=0`)).json();
    assert.ok(replay.items.some((i) => i.kind === 'result'));
    assert.deepEqual(
      replay.items.map((i) => i.ord),
      [...replay.items.map((i) => i.ord)].sort((a, b) => a - b),
    );

    ws.close();
    await get(`/api/sessions/${session.id}`, config.token, { method: 'DELETE' });
  });

  test('interrupting over REST settles the session', async () => {
    const { session } = await (
      await get('/api/sessions', config.token, { method: 'POST', body: JSON.stringify({ cwd: WORK }) })
    ).json();

    for (let i = 0; i < 60; i++) {
      const state = await (await get(`/api/sessions/${session.id}/feed?since=0`)).json();
      if (state.state.status === 'idle') break;
      await new Promise((r) => setTimeout(r, 100));
    }

    await get(`/api/sessions/${session.id}/message`, config.token, {
      method: 'POST',
      body: JSON.stringify({ text: 'will-be-interrupted' }),
    });
    const res = await get(`/api/sessions/${session.id}/interrupt`, config.token, { method: 'POST' });
    assert.equal(res.status, 200);

    const after = await (await get(`/api/sessions/${session.id}/feed?since=0`)).json();
    assert.equal(after.state.status, 'idle');
    await get(`/api/sessions/${session.id}`, config.token, { method: 'DELETE' });
  });

  test('two devices see the same session, and one answer settles a permission for both', async () => {
    const { session } = await (
      await get('/api/sessions', config.token, { method: 'POST', body: JSON.stringify({ cwd: WORK }) })
    ).json();

    const open = async () => {
      const ws = new WebSocket(`${base.replace('http', 'ws')}/ws?token=${encodeURIComponent(config.token)}`);
      await new Promise((resolve) => ws.on('open', resolve));
      ws.send(JSON.stringify({ t: 'subscribe', sessionId: session.id, since: 0 }));
      return ws;
    };

    const phone = await open();
    const laptop = await open();

    const asked = { phone: null, laptop: null };
    const resolved = { phone: false, laptop: false };
    const results = { phone: false, laptop: false };

    const track = (ws, who) =>
      ws.on('message', (raw) => {
        const msg = JSON.parse(raw.toString());
        if (msg.t === 'permission') asked[who] = msg.payload;
        if (msg.t === 'permissionResolved') resolved[who] = true;
        if (msg.t === 'patch' && msg.item?.kind === 'result') results[who] = true;
      });
    track(phone, 'phone');
    track(laptop, 'laptop');

    for (let i = 0; i < 60; i++) {
      const state = await (await get(`/api/sessions/${session.id}/feed?since=0`)).json();
      if (state.state.status === 'idle') break;
      await new Promise((r) => setTimeout(r, 100));
    }

    phone.send(JSON.stringify({ t: 'prompt', sessionId: session.id, text: 'two-devices' }));

    // Both devices are asked.
    for (let i = 0; i < 100 && !(asked.phone && asked.laptop); i++) {
      await new Promise((r) => setTimeout(r, 50));
    }
    assert.ok(asked.phone && asked.laptop, 'both devices got the permission request');
    assert.equal(asked.phone.requestId, asked.laptop.requestId);

    // Only the laptop answers.
    laptop.send(
      JSON.stringify({ t: 'permission', sessionId: session.id, requestId: asked.laptop.requestId, decision: 'allow' }),
    );

    for (let i = 0; i < 100 && !(results.phone && results.laptop); i++) {
      await new Promise((r) => setTimeout(r, 50));
    }
    assert.ok(resolved.phone, 'the phone was told the request is settled');
    assert.ok(results.phone && results.laptop, 'both devices saw the turn finish');

    phone.close();
    laptop.close();
    await get(`/api/sessions/${session.id}`, config.token, { method: 'DELETE' });
  });

  test('reconnecting with since= returns only what was missed', async () => {
    const { session } = await (
      await get('/api/sessions', config.token, { method: 'POST', body: JSON.stringify({ cwd: WORK }) })
    ).json();

    for (let i = 0; i < 60; i++) {
      const state = await (await get(`/api/sessions/${session.id}/feed?since=0`)).json();
      if (state.state.status === 'idle') break;
      await new Promise((r) => setTimeout(r, 100));
    }

    const first = await (await get(`/api/sessions/${session.id}/feed?since=0`)).json();
    const mark = Math.max(...first.items.map((i) => i.seq));

    const ws = new WebSocket(`${base.replace('http', 'ws')}/ws?token=${encodeURIComponent(config.token)}`);
    await new Promise((resolve) => ws.on('open', resolve));
    ws.send(JSON.stringify({ t: 'subscribe', sessionId: session.id, since: 0 }));
    ws.on('message', (raw) => {
      const msg = JSON.parse(raw.toString());
      if (msg.t === 'permission') {
        ws.send(
          JSON.stringify({
            t: 'permission',
            sessionId: session.id,
            requestId: msg.payload.requestId,
            decision: 'allow',
          }),
        );
      }
    });
    ws.send(JSON.stringify({ t: 'prompt', sessionId: session.id, text: 'catch-up' }));

    for (let i = 0; i < 200; i++) {
      const state = await (await get(`/api/sessions/${session.id}/feed?since=0`)).json();
      if (state.items.some((it) => it.kind === 'result')) break;
      await new Promise((r) => setTimeout(r, 50));
    }

    const delta = await (await get(`/api/sessions/${session.id}/feed?since=${mark}`)).json();
    const full = await (await get(`/api/sessions/${session.id}/feed?since=0`)).json();

    assert.ok(delta.items.length > 0, 'the catch-up is not empty');
    assert.ok(delta.items.length < full.items.length, 'the catch-up is smaller than a full replay');
    assert.ok(delta.items.every((i) => i.seq > mark), 'nothing already seen is resent');
    assert.deepEqual(
      delta.items.map((i) => i.ord),
      [...delta.items.map((i) => i.ord)].sort((a, b) => a - b),
      'the catch-up is still in order',
    );

    ws.close();
    await get(`/api/sessions/${session.id}`, config.token, { method: 'DELETE' });
  });

  test('prompting a mirror reports an error instead of crashing', async () => {
    const ws = new WebSocket(`${base.replace('http', 'ws')}/ws?token=${encodeURIComponent(config.token)}`);
    await new Promise((resolve) => ws.on('open', resolve));
    ws.send(JSON.stringify({ t: 'prompt', sessionId: SESSION_ID, text: 'hi' }));

    const error = await new Promise((resolve, reject) => {
      ws.on('message', (raw) => {
        const msg = JSON.parse(raw.toString());
        if (msg.t === 'error') resolve(msg);
      });
      setTimeout(() => reject(new Error('no error message')), 4000);
    });
    assert.match(error.message, /not found|read-only/i);
    ws.close();
  });
});
