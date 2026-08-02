/**
 * Signing an agent in from the phone, without anyone touching a token.
 *
 * The flow is the CLI's own OAuth: the daemon starts `claude setup-token`,
 * shows you the authorisation link, you approve it in a browser and paste back
 * the code it gives you. The credential this produces bills your subscription
 * rather than an API key.
 *
 * `setup-token` refuses to run without a terminal, so it is driven through
 * scripts/oauth-login.exp — expect ships with macOS and allocates a pty, which
 * keeps this free of a native dependency.
 */
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { setCredential } from './credentials.js';
import { log } from '../log.js';

const SCRIPT = fileURLToPath(new URL('../../scripts/oauth-login.exp', import.meta.url));

/** How long a half-finished sign-in is kept before it is abandoned. */
const LOGIN_TTL_MS = 10 * 60 * 1000;
/**
 * How long to wait for the authorisation link. The request is held open until
 * it arrives, so this has to fail well before any client gives up — otherwise
 * a CLI that never prints a link leaves the phone staring at a spinner.
 */
const LINK_TIMEOUT_MS = 45 * 1000;

/** Agents whose sign-in this can drive. Others still take a pasted key. */
const SUPPORTED = {
  'claude-code': { command: 'claude', label: 'Claude' },
};

/** loginId -> { child, url, agentId, timer, resolve, reject } */
const pending = new Map();

export function canSignIn(agentId) {
  return Boolean(SUPPORTED[agentId]);
}

/**
 * Start a sign-in. Resolves once the agent has printed its authorisation link,
 * which is what the phone needs to show; the flow then waits for the code.
 */
export function startLogin(config, agentId) {
  const spec = SUPPORTED[agentId];
  if (!spec) {
    throw Object.assign(new Error(`${agentId} cannot be signed in from here.`), { status: 400 });
  }

  const loginId = randomUUID();
  const executable = agentId === 'claude-code' ? config.claudeExecutable || spec.command : spec.command;
  const child = spawn('expect', ['-f', SCRIPT, executable], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, TERM: 'xterm-256color' },
  });

  const entry = { child, agentId, url: null, error: null, token: null };
  pending.set(loginId, entry);

  let buffer = '';
  const handleLine = (line) => {
    if (line.startsWith('CRC_URL:')) {
      entry.url = line.slice(8).trim();
      entry.onUrl?.(entry.url);
    } else if (line.startsWith('CRC_TOKEN:')) {
      entry.token = line.slice(10).trim();
      entry.onToken?.(entry.token);
    } else if (line.startsWith('CRC_ERROR:')) {
      entry.error = line.slice(10).trim();
      entry.onError?.(entry.error);
    }
  };

  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    buffer += chunk;
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const line of lines) handleLine(line);
  });
  child.stderr.on('data', (chunk) => log.debug(`login stderr: ${String(chunk).trim().slice(0, 200)}`));

  child.on('exit', () => {
    if (!entry.token && !entry.error) entry.error = 'Sign-in ended unexpectedly.';
    entry.onError?.(entry.error);
  });

  // Nobody comes back to a half-finished sign-in an hour later.
  entry.timer = setTimeout(() => cancelLogin(loginId), LOGIN_TTL_MS);
  entry.timer.unref?.();

  return new Promise((resolve, reject) => {
    const giveUp = setTimeout(() => {
      cancelLogin(loginId);
      reject(
        Object.assign(
          new Error(
            `${spec.label} did not return a sign-in link. Check that \`${executable}\` runs on this machine.`,
          ),
          { status: 504 },
        ),
      );
    }, LINK_TIMEOUT_MS);
    giveUp.unref?.();

    const settle = (fn, value) => {
      clearTimeout(giveUp);
      fn(value);
    };

    if (entry.url) return settle(resolve, { loginId, url: entry.url });
    entry.onUrl = (url) => settle(resolve, { loginId, url });
    entry.onError = (message) => {
      pending.delete(loginId);
      settle(reject, Object.assign(new Error(message || 'Could not start sign-in.'), { status: 502 }));
    };
  });
}

/** Hand the code back to the agent and store whatever credential it returns. */
export function completeLogin(config, loginId, code) {
  const entry = pending.get(loginId);
  if (!entry) {
    throw Object.assign(new Error('That sign-in has expired — start it again.'), { status: 404 });
  }
  const trimmed = String(code || '').trim();
  if (!trimmed) throw Object.assign(new Error('The code is empty.'), { status: 400 });

  return new Promise((resolve, reject) => {
    const finish = (fn, value) => {
      clearTimeout(entry.timer);
      pending.delete(loginId);
      fn(value);
    };

    entry.onToken = (token) => {
      try {
        const described = setCredential(config, entry.agentId, token);
        log.info(`signed in: ${entry.agentId}`);
        finish(resolve, { agent: entry.agentId, credential: described });
      } catch (err) {
        finish(reject, err);
      }
    };
    entry.onError = (message) => {
      finish(reject, Object.assign(new Error(message || 'Sign-in failed.'), { status: 502 }));
    };

    entry.child.stdin.write(`${trimmed}\n`);
  });
}

export function cancelLogin(loginId) {
  const entry = pending.get(loginId);
  if (!entry) return false;
  clearTimeout(entry.timer);
  try {
    entry.child.kill();
  } catch {
    /* already gone */
  }
  pending.delete(loginId);
  return true;
}

export function cancelAllLogins() {
  for (const loginId of [...pending.keys()]) cancelLogin(loginId);
}
