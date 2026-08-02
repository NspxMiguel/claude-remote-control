/**
 * The things you would otherwise do in a terminal on the host — installing
 * Homebrew, bringing Tailscale up, signing an agent in, keeping the Mac awake —
 * exposed so the app can do them for you.
 *
 * Everything here shells out to a tool the user already trusts, and nothing
 * runs without an explicit request from an authenticated client. Each task
 * reports back what it ran, so nothing happens invisibly.
 */
import { exec as execCallback, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { promisify } from 'node:util';
import { log } from './log.js';

const exec = promisify(execCallback);

/** Where GUI-launched processes have to look, since they get no login shell. */
const EXTRA_PATH = ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin'];

function shellEnv() {
  const merged = new Set([...(process.env.PATH || '').split(':'), ...EXTRA_PATH]);
  return { ...process.env, PATH: [...merged].filter(Boolean).join(':') };
}

async function which(command) {
  try {
    const { stdout } = await exec(`command -v ${command}`, { env: shellEnv(), shell: '/bin/bash' });
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

/**
 * Tasks the app can run. `check` says whether it is already done; `run` does it.
 * A task with no `run` is one only a human at the keyboard can complete, and
 * carries the command to type instead.
 */
export const TASKS = {
  homebrew: {
    label: 'Homebrew',
    detail: 'The package manager the rest of this uses',
    async check() {
      const found = await which('brew');
      return { done: Boolean(found), detail: found || 'not installed' };
    },
    // Homebrew's installer asks for a sudo password on a TTY, which a daemon
    // does not have. Hand over the command rather than pretend.
    manual: '/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"',
    manualHint: 'Homebrew needs your password, so it has to be run in a terminal.',
  },

  tailscale: {
    label: 'Tailscale',
    detail: 'Reach this Mac from anywhere',
    async check() {
      const found = await which('tailscale');
      if (!found) return { done: false, detail: 'not installed' };
      try {
        const { stdout } = await exec('tailscale status --json', { env: shellEnv(), timeout: 5000 });
        const status = JSON.parse(stdout);
        return {
          done: status.BackendState === 'Running',
          detail: status.BackendState === 'Running' ? status.Self?.DNSName?.replace(/\.$/, '') : status.BackendState,
        };
      } catch {
        return { done: false, detail: 'installed, not running' };
      }
    },
    async run() {
      if (!(await which('tailscale'))) {
        if (!(await which('brew'))) throw new Error('Install Homebrew first.');
        await exec('brew install --cask tailscale', { env: shellEnv(), timeout: 15 * 60 * 1000 });
      }
      // `tailscale up` opens a browser for login when it needs one, which is
      // the intended flow — it returns as soon as the machine is connected.
      await exec('tailscale up', { env: shellEnv(), timeout: 5 * 60 * 1000 });
      return { ran: 'tailscale up' };
    },
  },

  claudeLogin: {
    label: 'Claude Code sign-in',
    detail: 'Uses your Claude subscription',
    async check() {
      const { checkLogin } = await import('./doctor.js');
      const result = await checkLogin();
      return { done: result.level !== 'bad', detail: result.detail };
    },
    // `claude setup-token` is an interactive OAuth flow: it opens a browser and
    // waits for a code to be pasted back. The app shows the command and takes
    // the token it prints.
    manual: 'claude setup-token',
    manualHint:
      'Run this on the host. It signs in with your Claude subscription and prints a token — ' +
      'paste that token here and this Mac is set up.',
  },
};

export async function checkTasks() {
  const entries = await Promise.all(
    Object.entries(TASKS).map(async ([id, task]) => {
      let state;
      try {
        state = await task.check();
      } catch (err) {
        state = { done: false, detail: err?.message || 'check failed' };
      }
      return {
        id,
        label: task.label,
        detail: task.detail,
        runnable: typeof task.run === 'function',
        manual: task.manual || null,
        manualHint: task.manualHint || null,
        ...state,
      };
    }),
  );
  return entries;
}

/**
 * Open Terminal with a command typed in, ready to run.
 *
 * Some steps need a password, which a daemon cannot supply and should not ask
 * for. This is as close to a button as those can honestly get: the command is
 * put in front of you on the host, and you press return. Nothing runs on its
 * own — AppleScript's `do script` types it into a new window.
 */
export async function openInTerminal(command) {
  if (process.platform !== 'darwin') {
    throw Object.assign(new Error('Opening Terminal is macOS-only.'), { status: 400 });
  }
  // Escaping for AppleScript's own string literal, not for the shell.
  const escaped = String(command).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  const script = `tell application "Terminal"\nactivate\ndo script "${escaped}"\nend tell`;

  await exec(`osascript -e ${JSON.stringify(script)}`, { env: shellEnv(), timeout: 15000 });
  log.info('opened Terminal with a setup command');
  return { opened: true, command };
}

export async function runTask(id) {
  const task = TASKS[id];
  if (!task) throw Object.assign(new Error(`Unknown setup task: ${id}`), { status: 404 });
  if (typeof task.run !== 'function') {
    throw Object.assign(new Error(`${task.label} has to be run in a terminal.`), { status: 400 });
  }
  log.info(`running setup task: ${id}`);
  const result = await task.run();
  return { id, ...(await task.check()), ...result };
}

/**
 * Keep the Mac awake while it is on mains power.
 *
 * `caffeinate -s` asserts the "system sleep" prevention that macOS honours only
 * while plugged in — exactly the behaviour people install Amphetamine for, with
 * nothing to install. The process is a child of the daemon, so it dies with it
 * and cannot leave the machine awake forever by accident.
 */
class KeepAwake {
  constructor() {
    this.child = null;
  }

  get active() {
    return Boolean(this.child && !this.child.killed);
  }

  enable() {
    if (this.active) return true;
    if (process.platform !== 'darwin') {
      throw Object.assign(new Error('Keeping the machine awake is macOS-only.'), { status: 400 });
    }
    this.child = spawn('/usr/bin/caffeinate', ['-s'], { stdio: 'ignore', detached: false });
    this.child.on('exit', () => {
      this.child = null;
    });
    log.info('keep-awake on (caffeinate -s)');
    return true;
  }

  disable() {
    if (!this.active) return false;
    this.child.kill();
    this.child = null;
    log.info('keep-awake off');
    return true;
  }

  toJSON() {
    return {
      supported: process.platform === 'darwin',
      active: this.active,
      description: 'Prevents sleep while plugged in. On battery, the Mac sleeps as usual.',
    };
  }
}

export const keepAwake = new KeepAwake();

/** Directories worth offering as a project root, so the picker starts useful. */
export function suggestedRoots() {
  const home = os.homedir();
  const candidates = [
    path.join(home, 'Documents', 'Claude', 'Projetos'),
    path.join(home, 'Developer'),
    path.join(home, 'Projects'),
    path.join(home, 'code'),
    path.join(home, 'Documents'),
    path.join(home, 'Desktop'),
    home,
  ];

  const seen = new Set();
  return candidates.filter((dir) => {
    if (seen.has(dir) || !fs.existsSync(dir)) return false;
    seen.add(dir);
    return true;
  });
}
