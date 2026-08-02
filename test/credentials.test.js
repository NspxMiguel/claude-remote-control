/**
 * Agent credentials set from the app. The key is the most sensitive thing this
 * daemon stores after the master token, so these tests pin the two properties
 * that matter: it is written with owner-only permissions, and it never leaves
 * over the API.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after, beforeEach, describe } from 'node:test';

const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'crc-cred-')));
process.env.CRC_CONFIG_DIR = TMP;

const { loadConfig, CONFIG_PATH } = await import('../src/config.js');
const {
  CREDENTIAL_SPECS,
  clearCredential,
  credentialEnv,
  describeCredential,
  hasCredential,
  maskKey,
  setCredential,
} = await import('../src/agent/credentials.js');

after(() => fs.rmSync(TMP, { recursive: true, force: true }));

let config;
beforeEach(() => {
  config = loadConfig();
  config.credentials = {};
});

const KEY = 'sk-ant-api03-0000000000000000000000000000ABCD';

describe('setting a key', () => {
  test('stores it, reports it as set, and exposes only a masked hint', () => {
    const described = setCredential(config, 'claude-code', KEY);
    assert.equal(described.set, true);
    assert.equal(described.hint, 'sk-ant-a…ABCD');
    assert.ok(!described.hint.includes('0000'), 'the middle is not shown');
    assert.equal(hasCredential(config, 'claude-code'), true);
  });

  test('trims what was pasted', () => {
    setCredential(config, 'claude-code', `  ${KEY}\n`);
    assert.equal(config.credentials['claude-code'].apiKey, KEY);
  });

  test('refuses things that are plainly not keys', () => {
    assert.throws(() => setCredential(config, 'claude-code', ''), /empty/);
    assert.throws(() => setCredential(config, 'claude-code', 'short'), /does not look like/);
    assert.throws(() => setCredential(config, 'claude-code', 'claude setup-token'), /does not look like/);
    assert.throws(() => setCredential(config, 'claude-code', KEY.replace('-', ' ')), /does not look like/);
  });

  test('refuses an agent that takes no key', () => {
    assert.throws(() => setCredential(config, 'not-an-agent', KEY), /No credentials for agent/);
  });

  test('is written to a file only the owner can read', () => {
    setCredential(config, 'claude-code', KEY);
    assert.equal(fs.statSync(CONFIG_PATH).mode & 0o777, 0o600);
    assert.match(fs.readFileSync(CONFIG_PATH, 'utf8'), /sk-ant-api03/, 'it really is persisted');
  });

  test('survives a reload', () => {
    setCredential(config, 'claude-code', KEY);
    assert.equal(loadConfig().credentials['claude-code'].apiKey, KEY);
  });

  test('replacing a key overwrites rather than accumulates', () => {
    setCredential(config, 'claude-code', KEY);
    setCredential(config, 'claude-code', `${KEY}XYZ`);
    assert.equal(config.credentials['claude-code'].apiKey, `${KEY}XYZ`);
    assert.equal(Object.keys(config.credentials).length, 1);
  });
});

describe('using a key', () => {
  test('becomes the environment variable that agent reads', () => {
    setCredential(config, 'claude-code', KEY);
    assert.deepEqual(credentialEnv(config, 'claude-code'), { ANTHROPIC_API_KEY: KEY });
  });

  test('each agent has its own variable', () => {
    assert.equal(CREDENTIAL_SPECS['claude-code'].envVar, 'ANTHROPIC_API_KEY');
    assert.equal(CREDENTIAL_SPECS.acp.envVar, 'CURSOR_API_KEY');
    assert.equal(CREDENTIAL_SPECS.antigravity.envVar, 'GEMINI_API_KEY');
  });

  test('a subscription token goes in the OAuth variable, not the API-key one', () => {
    // `claude setup-token` prints sk-ant-oat…, which bills the subscription and
    // only authenticates when exported as CLAUDE_CODE_OAUTH_TOKEN.
    const token = 'sk-ant-oat01-0000000000000000000000000000BEEF';
    setCredential(config, 'claude-code', token);
    assert.deepEqual(credentialEnv(config, 'claude-code'), { CLAUDE_CODE_OAUTH_TOKEN: token });
    assert.equal(describeCredential(config, 'claude-code').kind, 'subscription token');
  });

  test('a console API key still goes in the API-key variable', () => {
    setCredential(config, 'claude-code', KEY);
    assert.deepEqual(credentialEnv(config, 'claude-code'), { ANTHROPIC_API_KEY: KEY });
    assert.equal(describeCredential(config, 'claude-code').kind, 'API key');
  });

  test('no key means no environment change at all', () => {
    assert.deepEqual(credentialEnv(config, 'claude-code'), {});
    assert.deepEqual(credentialEnv(config, 'not-an-agent'), {});
  });

  test('one agent’s key never leaks into another’s environment', () => {
    setCredential(config, 'claude-code', KEY);
    assert.deepEqual(credentialEnv(config, 'antigravity'), {});
  });
});

describe('clearing a key', () => {
  test('removes it and reports the change', () => {
    setCredential(config, 'claude-code', KEY);
    assert.equal(clearCredential(config, 'claude-code'), true);
    assert.equal(hasCredential(config, 'claude-code'), false);
    assert.equal(describeCredential(config, 'claude-code').set, false);
    assert.equal(loadConfig().credentials['claude-code'], undefined, 'and on disk too');
  });

  test('clearing what was never set is a no-op, not an error', () => {
    assert.equal(clearCredential(config, 'claude-code'), false);
  });
});

describe('maskKey', () => {
  test('keeps enough to recognise and too little to use', () => {
    assert.equal(maskKey('sk-ant-api03-secret-tail'), 'sk-ant-a…tail');
    assert.equal(maskKey('short'), 'sh…');
  });
});
