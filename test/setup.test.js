/**
 * The host-side setup the app can perform. The security-relevant property here
 * is that nothing arbitrary runs: the Terminal helper only accepts commands
 * this app itself suggests.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import test, { after, describe } from 'node:test';

const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'crc-setup-')));
process.env.CRC_CONFIG_DIR = TMP;

const { TASKS, checkTasks, keepAwake, openInTerminal, runTask, suggestedRoots } = await import(
  '../src/setup.js'
);

after(() => {
  keepAwake.disable();
  fs.rmSync(TMP, { recursive: true, force: true });
});

describe('setup tasks', () => {
  test('every task reports a usable verdict', async () => {
    const tasks = await checkTasks();
    assert.ok(tasks.length >= 3);

    for (const task of tasks) {
      assert.equal(typeof task.done, 'boolean');
      assert.ok(task.label, 'has a name');
      assert.ok(task.detail, `${task.label} says something about its state`);
      // A task you cannot press must say what to type instead.
      if (!task.runnable) assert.ok(task.manual, `${task.label} offers a command`);
    }
  });

  test('the tasks that need a password are not runnable', () => {
    // Homebrew's installer and `claude setup-token` both need a TTY.
    assert.equal(typeof TASKS.homebrew.run, 'undefined');
    assert.equal(typeof TASKS.claudeLogin.run, 'undefined');
    assert.match(TASKS.homebrew.manual, /install\.sh/);
    assert.match(TASKS.claudeLogin.manual, /setup-token/);
  });

  test('running a task that is not runnable explains why', async () => {
    await assert.rejects(() => runTask('homebrew'), /has to be run in a terminal/);
  });

  test('an unknown task is a 404, not a crash', async () => {
    await assert.rejects(() => runTask('rm-rf-slash'), /Unknown setup task/);
  });
});

describe('keep awake', () => {
  test('reports whether the platform supports it', () => {
    const state = keepAwake.toJSON();
    assert.equal(state.supported, process.platform === 'darwin');
    assert.ok(state.description.includes('plugged in'));
  });

  test('starts and stops a real caffeinate process', { skip: process.platform !== 'darwin' }, () => {
    assert.equal(keepAwake.active, false);
    keepAwake.enable();
    assert.equal(keepAwake.active, true);
    assert.equal(keepAwake.enable(), true, 'enabling twice does not spawn a second one');

    assert.equal(keepAwake.disable(), true);
    assert.equal(keepAwake.active, false);
    assert.equal(keepAwake.disable(), false, 'disabling twice is a no-op');
  });
});

describe('opening Terminal', () => {
  test('is refused off macOS', { skip: process.platform === 'darwin' }, async () => {
    await assert.rejects(() => openInTerminal('echo hi'), /macOS-only/);
  });
});

describe('suggested roots', () => {
  test('only offers directories that exist, without duplicates', () => {
    const roots = suggestedRoots();
    assert.ok(roots.length > 0);
    assert.equal(new Set(roots).size, roots.length);
    for (const root of roots) assert.ok(fs.existsSync(root), `${root} exists`);
    assert.ok(roots.includes(os.homedir()), 'home is always a fallback');
  });
});
