/**
 * Per-agent credentials.
 *
 * Every agent here authenticates on the host: you sign in once in a terminal
 * and the CLI keeps its own tokens. That breaks down when the daemon runs
 * somewhere you cannot easily reach a terminal — so an agent can also be given
 * a key from the app, which is stored in the daemon config (mode 600) and
 * injected into that agent's environment when it launches.
 *
 * The key never comes back out over the API: endpoints report only whether one
 * is set, and what it looks like from the outside (`sk-ant-…3f9a`).
 */
import { saveConfig } from '../config.js';

/**
 * How each agent takes a key, and where to get one. `envVar` is what the driver
 * exports; `login` is the command that avoids needing a key at all.
 */
export const CREDENTIAL_SPECS = {
  'claude-code': {
    envVar: 'ANTHROPIC_API_KEY',
    label: 'Anthropic API key',
    placeholder: 'sk-ant-…',
    login: 'claude',
    loginHint:
      'Run `claude` in a terminal on the host and sign in with /login — that uses your Claude ' +
      'subscription and needs no key here. `claude setup-token` prints a long-lived token you ' +
      'can paste instead.',
  },
  acp: {
    envVar: 'CURSOR_API_KEY',
    label: 'Cursor API key',
    placeholder: 'key_…',
    login: 'agent login',
    loginHint: 'Run `agent login` on the host, or paste a key from cursor.com/dashboard.',
  },
  antigravity: {
    envVar: 'GEMINI_API_KEY',
    label: 'Gemini API key',
    placeholder: 'AIza…',
    login: 'agy',
    loginHint:
      'Run `agy` in a terminal on the host and sign in with your Google account. Antigravity ' +
      'signs in interactively; a key is only a fallback.',
  },
};

/** What the app may say about a stored key: that it exists, and its tail. */
export function describeCredential(config, agentId) {
  const spec = CREDENTIAL_SPECS[agentId];
  if (!spec) return null;
  const stored = config.credentials?.[agentId]?.apiKey;
  return {
    envVar: spec.envVar,
    label: spec.label,
    placeholder: spec.placeholder,
    login: spec.login,
    loginHint: spec.loginHint,
    set: Boolean(stored),
    hint: stored ? maskKey(stored) : null,
  };
}

/** `sk-ant-api03-…9f2a` — enough to recognise, not enough to use. */
export function maskKey(key) {
  const text = String(key);
  if (text.length <= 12) return `${text.slice(0, 2)}…`;
  return `${text.slice(0, 8)}…${text.slice(-4)}`;
}

export function setCredential(config, agentId, apiKey) {
  const spec = CREDENTIAL_SPECS[agentId];
  if (!spec) throw Object.assign(new Error(`No credentials for agent: ${agentId}`), { status: 404 });

  const key = String(apiKey || '').trim();
  if (!key) throw Object.assign(new Error('The key is empty.'), { status: 400 });
  // Keys are opaque, but a pasted password or a whole shell command is not a key.
  if (key.length < 12 || /\s/.test(key)) {
    throw Object.assign(new Error('That does not look like an API key.'), { status: 400 });
  }

  config.credentials = { ...config.credentials, [agentId]: { apiKey: key, setAt: new Date().toISOString() } };
  saveConfig(config);
  return describeCredential(config, agentId);
}

export function clearCredential(config, agentId) {
  if (!config.credentials?.[agentId]) return false;
  const next = { ...config.credentials };
  delete next[agentId];
  config.credentials = next;
  saveConfig(config);
  return true;
}

/** The environment additions an agent needs, if a key was stored for it. */
export function credentialEnv(config, agentId) {
  const spec = CREDENTIAL_SPECS[agentId];
  const key = config?.credentials?.[agentId]?.apiKey;
  if (!spec || !key) return {};
  return { [spec.envVar]: key };
}

export function hasCredential(config, agentId) {
  return Boolean(config?.credentials?.[agentId]?.apiKey);
}
