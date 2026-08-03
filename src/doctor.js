import { execFile } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { promisify } from 'node:util';
import { tailscaleInfo } from './net.js';

const exec = promisify(execFile);

const ok = (label, detail) => ({ level: 'ok', label, detail });
const warn = (label, detail, fix) => ({ level: 'warn', label, detail, fix });
const bad = (label, detail, fix) => ({ level: 'bad', label, detail, fix });

async function checkNode() {
  const major = Number(process.versions.node.split('.')[0]);
  return major >= 20
    ? ok('Node.js', `v${process.versions.node}`)
    : bad('Node.js', `v${process.versions.node} is too old`, 'Install Node.js 20 or newer.');
}

async function checkClaudeCode(config) {
  const candidate = config.claudeExecutable;
  if (candidate && !fs.existsSync(candidate)) {
    return bad('Claude Code', `not found at ${candidate}`, 'Fix "claudeExecutable" in your config.');
  }
  try {
    const { stdout } = await exec(candidate || 'claude', ['--version'], { timeout: 10000 });
    return ok('Claude Code', stdout.trim().split('\n')[0]);
  } catch {
    return bad(
      'Claude Code',
      'not found on PATH',
      'Install Claude Code, or set "claudeExecutable" to its full path in the config.',
    );
  }
}

/**
 * Claude Code stores credentials in the login keychain on macOS and in a file
 * elsewhere. Checking for their presence is not proof they are valid, but their
 * absence is proof a remote session will fail — which is the failure worth
 * catching before you're away from the machine.
 */
/**
 * Whether Claude Code has a login on this machine.
 *
 * The keychain is asked last, and only as a fallback. It used to be asked
 * first, and it lied: a daemon launched by the menu bar app queries it from a
 * bundle whose signature changes on every upgrade, so the ACL no longer
 * recognises the caller — the lookup fails and a signed-in machine reads as
 * signed out. It is also what makes macOS put a password dialog on screen for
 * an app you only opened.
 *
 * `~/.claude.json` needs none of that. Claude Code writes the account it is
 * logged in as there, in plain sight, and reading a file cannot prompt.
 */
export async function checkLogin() {
  if (process.env.ANTHROPIC_API_KEY) return ok('Credentials', 'ANTHROPIC_API_KEY is set');

  const account = oauthAccount();
  if (account) return ok('Credentials', `signed in as ${account}`);

  const credentialsFile = path.join(os.homedir(), '.claude', '.credentials.json');
  if (fs.existsSync(credentialsFile)) return ok('Credentials', 'signed in (credentials file)');

  if (process.platform === 'darwin') {
    try {
      await exec('security', ['find-generic-password', '-s', 'Claude Code-credentials'], { timeout: 8000 });
      return ok('Credentials', 'signed in (login keychain)');
    } catch {
      /* fall through to the failure below */
    }
  }

  return bad(
    'Credentials',
    'Claude Code is not signed in',
    'Open the app, go to Settings → Claude Code and press Sign in — it runs the ' +
      'browser login for you. Being signed into the Claude Desktop app is not ' +
      'enough on its own: the daemon launches the CLI, which keeps its own credentials.',
  );
}

/** The address Claude Code says it is logged in as, or null. */
export function oauthAccount() {
  try {
    const file = path.join(os.homedir(), '.claude.json');
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    const email = parsed?.oauthAccount?.emailAddress;
    return typeof email === 'string' && email.includes('@') ? email : null;
  } catch {
    // Missing, unreadable or half-written — none of which is an answer, so
    // the checks after this one get their turn.
    return null;
  }
}

async function checkPort(config) {
  const free = await new Promise((resolve) => {
    const server = net.createServer();
    // Close on both paths: an unclosed server keeps a handle open and the
    // process — including `crc doctor` itself — never exits.
    server.once('error', () => server.close(() => resolve(false)));
    server.once('listening', () => server.close(() => resolve(true)));
    server.listen(config.port, config.host);
  });

  if (free) return ok('Port', `${config.host}:${config.port} is free`);

  // An already-running daemon is the most likely explanation, and is fine.
  const daemon = await probeHealth(config.port);
  return daemon
    ? ok('Port', `${config.port} in use by a running daemon`)
    : bad('Port', `${config.port} is taken by another program`, 'Start with --port <n>.');
}

/**
 * Ask a port whether it is our daemon, returning its health payload or null.
 * Uses `http` with keep-alive disabled rather than fetch: fetch pools its
 * sockets, and a pooled socket to something that never replies keeps the
 * process alive long after the check gave up.
 */
export function probeHealth(port) {
  return new Promise((resolve) => {
    const req = http.get(
      { host: '127.0.0.1', port, path: '/api/health', timeout: 1500, agent: false },
      (res) => {
        if (res.statusCode !== 200) {
          res.resume();
          res.on('end', () => resolve(null));
          return;
        }
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          body += chunk;
        });
        res.on('end', () => {
          try {
            resolve(JSON.parse(body));
          } catch {
            resolve(null);
          }
        });
      },
    );
    req.on('timeout', () => {
      req.destroy();
      resolve(null);
    });
    req.on('error', () => resolve(null));
  });
}

async function checkTailscale() {
  const info = await tailscaleInfo();
  if (!info) {
    return warn(
      'Tailscale',
      'not installed',
      'Optional — install it to reach this machine from outside your network.',
    );
  }
  if (!info.running) {
    return warn('Tailscale', `backend is ${info.backendState}`, 'Run `tailscale up`.');
  }
  return ok('Tailscale', info.dnsName || info.ips?.[0] || 'connected');
}

function checkRoots(config) {
  const missing = config.allowedRoots.filter((root) => !fs.existsSync(root));
  return missing.length
    ? warn('Allowed roots', `missing: ${missing.join(', ')}`, 'Fix "allowedRoots" in your config.')
    : ok('Allowed roots', config.allowedRoots.join(', '));
}

function checkTranscripts() {
  const dir = process.env.CRC_PROJECTS_DIR || path.join(os.homedir(), '.claude', 'projects');
  if (!fs.existsSync(dir)) {
    return warn(
      'Desktop sessions',
      'no transcripts found yet',
      'They appear once you have used Claude Desktop or the CLI on this machine.',
    );
  }
  const count = fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .reduce((total, entry) => {
      try {
        return total + fs.readdirSync(path.join(dir, entry.name)).filter((f) => f.endsWith('.jsonl')).length;
      } catch {
        return total;
      }
    }, 0);
  return ok('Desktop sessions', `${count} transcript${count === 1 ? '' : 's'} available to mirror`);
}

/**
 * Run every check. They are independent and several shell out, so they run
 * concurrently — the report is only as slow as the slowest probe.
 */
export async function runDoctor(config) {
  const results = await Promise.all([
    checkNode(),
    checkClaudeCode(config),
    checkLogin(),
    checkPort(config),
    checkRoots(config),
    checkTranscripts(),
    checkTailscale(),
  ]);
  return { results, healthy: results.every((r) => r.level !== 'bad') };
}
