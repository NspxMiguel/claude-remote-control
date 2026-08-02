import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test, { after, describe } from 'node:test';

const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'crc-doctor-')));
const PROJECTS = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'crc-dprojects-')));
process.env.CRC_CONFIG_DIR = TMP;
process.env.CRC_PROJECTS_DIR = PROJECTS;

const { loadConfig } = await import('../src/config.js');
const { runDoctor } = await import('../src/doctor.js');

after(() => {
  for (const dir of [TMP, PROJECTS]) fs.rmSync(dir, { recursive: true, force: true });
});

const baseConfig = () => {
  const config = loadConfig();
  config.host = '127.0.0.1';
  config.port = 0;
  return config;
};

const find = (results, label) => results.find((r) => r.label === label);

describe('doctor', () => {
  test('reports on every dimension, with a level and a description', async () => {
    const { results } = await runDoctor(baseConfig());
    const labels = results.map((r) => r.label);
    for (const expected of [
      'Node.js',
      'Claude Code',
      'Credentials',
      'Port',
      'Allowed roots',
      'Desktop sessions',
      'Tailscale',
    ]) {
      assert.ok(labels.includes(expected), `missing check: ${expected}`);
    }
    for (const result of results) {
      assert.ok(['ok', 'warn', 'bad'].includes(result.level), `bad level on ${result.label}`);
      assert.ok(result.detail, `${result.label} has no detail`);
      if (result.level !== 'ok') assert.ok(result.fix, `${result.label} says what is wrong but not how to fix it`);
    }
  });

  test('the running Node version passes', async () => {
    const { results } = await runDoctor(baseConfig());
    assert.equal(find(results, 'Node.js').level, 'ok');
  });

  test('a missing Claude Code executable is fatal, not a warning', async () => {
    const config = baseConfig();
    config.claudeExecutable = '/definitely/not/here/claude';
    const { results, healthy } = await runDoctor(config);

    assert.equal(find(results, 'Claude Code').level, 'bad');
    assert.equal(healthy, false, 'the daemon cannot work without it');
  });

  test('a missing allowed root is a warning, not fatal', async () => {
    const config = baseConfig();
    config.allowedRoots = [path.join(TMP, 'gone')];
    const { results } = await runDoctor(config);
    assert.equal(find(results, 'Allowed roots').level, 'warn');
  });

  test('an occupied port is reported', async () => {
    // Stands in for "some other program has the port": it accepts and hangs up,
    // so the doctor's health probe fails fast and leaves no socket behind.
    const server = net.createServer((socket) => socket.destroy());
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const config = baseConfig();
    config.port = server.address().port;

    try {
      const { results } = await runDoctor(config);
      assert.equal(find(results, 'Port').level, 'bad');
      assert.match(find(results, 'Port').fix, /--port/);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  test('counts transcripts available to mirror', async () => {
    const dir = path.join(PROJECTS, '-tmp-project');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'a.jsonl'), '{}\n');
    fs.writeFileSync(path.join(dir, 'b.jsonl'), '{}\n');

    const { results } = await runDoctor(baseConfig());
    const sessions = find(results, 'Desktop sessions');
    assert.equal(sessions.level, 'ok');
    assert.match(sessions.detail, /2 transcripts/);
  });

  test('Tailscale being absent never blocks startup', async () => {
    const { results } = await runDoctor(baseConfig());
    assert.notEqual(find(results, 'Tailscale').level, 'bad', 'Tailscale is optional');
  });
});
