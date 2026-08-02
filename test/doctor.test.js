import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import test, { after, describe } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

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

const exec = promisify(execFile);
const CLI = fileURLToPath(new URL('../bin/crc.js', import.meta.url));

/** `crc doctor` exits 1 when unhealthy, which is not a test failure. */
async function runCli(flags) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crc-doctor-cli-'));
  // Port 0 on the loopback: the port check gets a real bind without racing a
  // daemon the developer happens to have running on 8787.
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ host: '127.0.0.1', port: 0 }));
  try {
    return await exec(process.execPath, [CLI, 'doctor', ...flags], {
      env: { ...process.env, CRC_CONFIG_DIR: dir, CRC_PROJECTS_DIR: PROJECTS },
    });
  } catch (err) {
    return { stdout: err.stdout ?? '', stderr: err.stderr ?? '' };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

describe('doctor --json', () => {
  test('prints JSON and nothing else', async () => {
    const { stdout } = await runCli(['--json']);
    const report = JSON.parse(stdout);

    assert.equal(typeof report.healthy, 'boolean');
    assert.ok(Array.isArray(report.checks));
    assert.deepEqual(
      report.checks.map((c) => c.label).sort(),
      ['Allowed roots', 'Claude Code', 'Credentials', 'Desktop sessions', 'Node.js', 'Port', 'Tailscale'],
    );
  });

  test('every check carries a level, a detail and a fix slot', async () => {
    const { stdout } = await runCli(['--json']);
    const { checks, healthy } = JSON.parse(stdout);

    for (const check of checks) {
      assert.ok(['ok', 'warn', 'bad'].includes(check.level), `bad level on ${check.label}`);
      assert.equal(typeof check.detail, 'string');
      assert.ok(check.detail.length, `${check.label} has no detail`);
      // Null rather than absent, so a typed client can decode it unconditionally.
      assert.ok(check.fix === null || typeof check.fix === 'string');
      if (check.level !== 'ok') assert.ok(check.fix, `${check.label} offers no fix`);
    }
    assert.equal(healthy, checks.every((c) => c.level !== 'bad'));
  });

  test('leaves the human output alone', async () => {
    const { stdout } = await runCli([]);
    assert.match(stdout, /Node\.js/);
    assert.match(stdout, /[✓!✗]/);
    assert.throws(() => JSON.parse(stdout), 'the table is not JSON');
  });
});
