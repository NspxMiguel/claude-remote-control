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
import { fileURLToPath } from 'node:url';

const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'crc-setup-')));
process.env.CRC_CONFIG_DIR = TMP;

const { TASKS, checkTasks, closedLid, keepAwake, openInTerminal, runTask, suggestedRoots } =
  await import('../src/setup.js');

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

describe('closed-lid mode', () => {
  test('reports state without ever prompting for a password', async () => {
    const state = await closedLid.state();
    assert.equal(state.supported, process.platform === 'darwin');

    if (!state.supported) return;
    // `sudo -n` is the whole point: a daemon must be able to ask "may I?"
    // without hanging on a prompt nobody is there to answer.
    assert.equal(typeof state.active, 'boolean');
    assert.equal(typeof state.permitted, 'boolean');
    assert.equal(typeof state.onAC, 'boolean');
    assert.equal(state.wanted, false, 'nothing is armed until someone asks for it');
    assert.match(state.description, /lid closed/);
    assert.match(state.setupCommand, /allow-lid-control\.sh$/);
  });

  test('is refused, not silently ignored, when permission was never granted', async () => {
    const state = await closedLid.state();
    if (!state.supported || state.permitted) return; // already set up on this machine
    await assert.rejects(() => closedLid.set(true), /has not granted permission/);
    // A refusal must not leave the switch looking on.
    assert.equal(closedLid.wanted, false);
    assert.equal(closedLid.timer, null, 'and must not leave a poller behind');
  });

  test('shutting down is safe whether or not it was ever armed', async () => {
    assert.equal(await closedLid.shutdown(), false);
    assert.equal(closedLid.timer, null);
  });

  test('the setup script exists and is executable', () => {
    const script = fileURLToPath(new URL('../scripts/allow-lid-control.sh', import.meta.url));
    assert.ok(fs.existsSync(script));
    assert.doesNotThrow(() => fs.accessSync(script, fs.constants.X_OK));

    // The rule it installs must not be able to run anything else. `-a` matches
    // what the daemon runs; a rule for `-c` would never be used and the switch
    // would ask for a password it cannot collect.
    const source = fs.readFileSync(script, 'utf8');
    assert.match(source, /disablesleep 1, \$\{PMSET\} -a disablesleep 0/);
    assert.ok(!source.includes('ALL=(ALL)'), 'never grants blanket sudo');
    assert.match(source, /visudo -cf/, 'validates before installing');
  });

  test('the daemon runs exactly what the rule allows', async () => {
    // The two have to agree literally: sudoers matches on the command line,
    // so a stray flag anywhere means every toggle silently needs a password.
    const script = fs.readFileSync(
      fileURLToPath(new URL('../scripts/allow-lid-control.sh', import.meta.url)),
      'utf8',
    );
    const daemon = fs.readFileSync(
      fileURLToPath(new URL('../src/setup.js', import.meta.url)),
      'utf8',
    );
    const granted = script.match(/\$\{PMSET\} (-\w disablesleep) 1/)?.[1];
    assert.ok(granted, 'the script grants a pmset command');
    for (const used of daemon.matchAll(/\$\{PMSET\} (-\w disablesleep)/g)) {
      assert.equal(used[1], granted, 'every pmset call matches the granted form');
    }
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
