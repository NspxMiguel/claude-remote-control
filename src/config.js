import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const CONFIG_DIR =
  process.env.CRC_CONFIG_DIR || path.join(os.homedir(), '.claude-remote-control');
export const CONFIG_PATH = path.join(CONFIG_DIR, 'config.json');

const DEFAULTS = {
  /** Port the daemon listens on. */
  port: 8787,
  /**
   * Bind address. 0.0.0.0 exposes the daemon to your LAN and to Tailscale.
   * Use 127.0.0.1 to keep it local-only, or a Tailscale IP to expose it to
   * the tailnet exclusively.
   */
  host: '0.0.0.0',
  /** Master token. Anything holding this can drive Claude on this machine. */
  token: null,
  /** Paired devices: { id, token, name, userAgent, createdAt, lastSeenAt }. */
  devices: [],
  /**
   * Directories the remote client may start sessions in. Sessions are refused
   * outside of these roots. Defaults to the home directory.
   */
  allowedRoots: [os.homedir()],
  /** Working directory used when a client does not pick one. */
  defaultCwd: os.homedir(),
  /** Model alias for new sessions: opus | sonnet | haiku, or a full model id. */
  defaultModel: 'sonnet',
  /**
   * Permission mode for new sessions.
   * 'default' routes every permission prompt to your phone.
   * 'acceptEdits' auto-approves file edits, still asks for the rest.
   * 'plan' explores without touching anything.
   * 'bypassPermissions' asks for nothing — dangerous, opt in deliberately.
   */
  defaultPermissionMode: 'default',
  /** Seconds a permission request waits for a human before it is denied. */
  permissionTimeoutSec: 600,
  /**
   * Path to the Claude Code executable. Leave null to let the SDK find it;
   * set it when `claude` lives somewhere unusual (nvm, a pinned version).
   */
  claudeExecutable: null,
  /** Path to Cursor's agent binary, if it is not on PATH or in ~/.local/bin. */
  acpExecutable: null,
  /** Path to Antigravity's `agy` binary, same idea. */
  antigravityExecutable: null,
  /** Keep this many feed items in memory per session. */
  maxFeedItems: 2000,
  /** Cap on concurrent live sessions — each one is a Claude Code process. */
  maxSessions: 8,
  /**
   * Tools remote sessions may not use. AskUserQuestion is refused by default:
   * it expects a client that can render an interactive dialog, and without one
   * the turn stalls until it times out. Denied, Claude asks in plain text
   * instead, which a chat client can actually answer.
   */
  disallowedTools: ['AskUserQuestion'],
};

function ensureDir() {
  fs.mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
}

export function newToken() {
  return randomBytes(32).toString('base64url');
}

export function loadConfig() {
  ensureDir();
  let stored = {};
  if (fs.existsSync(CONFIG_PATH)) {
    try {
      stored = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    } catch (err) {
      throw new Error(`config at ${CONFIG_PATH} is not valid JSON: ${err.message}`);
    }
  }

  const config = { ...DEFAULTS, ...stored };

  // Environment overrides win, so a service file can set them without editing JSON.
  if (process.env.CRC_PORT) config.port = Number(process.env.CRC_PORT);
  if (process.env.CRC_HOST) config.host = process.env.CRC_HOST;
  if (process.env.CRC_TOKEN) config.token = process.env.CRC_TOKEN;

  let dirty = false;
  if (!config.token) {
    config.token = newToken();
    dirty = true;
  }
  if (!Array.isArray(config.devices)) {
    config.devices = [];
    dirty = true;
  }
  if (!Array.isArray(config.allowedRoots) || config.allowedRoots.length === 0) {
    config.allowedRoots = [os.homedir()];
    dirty = true;
  }
  config.allowedRoots = config.allowedRoots.map((p) => realPath(expandHome(p)));
  config.defaultCwd = realPath(expandHome(config.defaultCwd));

  if (dirty || !fs.existsSync(CONFIG_PATH)) saveConfig(config);
  return config;
}

export function saveConfig(config) {
  ensureDir();
  const { ...persisted } = config;
  const tmp = `${CONFIG_PATH}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(persisted, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, CONFIG_PATH);
}

export function expandHome(p) {
  if (typeof p !== 'string') return p;
  if (p === '~') return os.homedir();
  if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2));
  return p;
}

/**
 * Resolve symlinks so a link inside an allowed root cannot point out of it.
 * Falls back to a plain resolve for paths that do not exist yet.
 */
export function realPath(target) {
  const resolved = path.resolve(expandHome(target));
  try {
    return fs.realpathSync(resolved);
  } catch {
    return resolved;
  }
}

/** True when `target` is inside one of the allowed roots. */
export function isPathAllowed(config, target) {
  const resolved = realPath(target);
  return config.allowedRoots.some((root) => {
    const rel = path.relative(root, resolved);
    return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
  });
}
