import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after, describe } from 'node:test';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'crc-config-'));
process.env.CRC_CONFIG_DIR = TMP;

const { loadConfig, saveConfig, isPathAllowed, expandHome, CONFIG_PATH } = await import('../src/config.js');

after(() => fs.rmSync(TMP, { recursive: true, force: true }));

describe('loadConfig', () => {
  test('creates a config with a token on first run', () => {
    const config = loadConfig();
    assert.ok(config.token && config.token.length >= 40);
    assert.ok(fs.existsSync(CONFIG_PATH));
    assert.equal(config.port, 8787);
  });

  test('writes the config file with owner-only permissions', () => {
    loadConfig();
    const mode = fs.statSync(CONFIG_PATH).mode & 0o777;
    assert.equal(mode, 0o600, 'the token must not be world readable');
  });

  test('keeps the same token across loads', () => {
    const first = loadConfig().token;
    assert.equal(loadConfig().token, first);
  });

  test('rejects a corrupt config instead of silently resetting it', () => {
    const backup = fs.readFileSync(CONFIG_PATH, 'utf8');
    fs.writeFileSync(CONFIG_PATH, '{not json');
    assert.throws(() => loadConfig(), /not valid JSON/);
    fs.writeFileSync(CONFIG_PATH, backup);
  });

  test('environment overrides win over the file', () => {
    process.env.CRC_PORT = '9999';
    assert.equal(loadConfig().port, 9999);
    delete process.env.CRC_PORT;
  });

  test('repairs an empty allowedRoots list', () => {
    const config = loadConfig();
    config.allowedRoots = [];
    saveConfig(config);
    assert.deepEqual(loadConfig().allowedRoots, [os.homedir()]);
  });
});

describe('isPathAllowed', () => {
  const config = { allowedRoots: ['/Users/demo/projects', '/srv/work'] };

  test('accepts a root itself and paths inside it', () => {
    assert.equal(isPathAllowed(config, '/Users/demo/projects'), true);
    assert.equal(isPathAllowed(config, '/Users/demo/projects/app/src'), true);
    assert.equal(isPathAllowed(config, '/srv/work/thing'), true);
  });

  test('refuses paths outside every root', () => {
    assert.equal(isPathAllowed(config, '/Users/demo'), false);
    assert.equal(isPathAllowed(config, '/etc'), false);
    assert.equal(isPathAllowed(config, '/'), false);
  });

  test('refuses traversal that climbs back out', () => {
    assert.equal(isPathAllowed(config, '/Users/demo/projects/../../../etc/passwd'), false);
    assert.equal(isPathAllowed(config, '/Users/demo/projects/../secrets'), false);
  });

  test('is not fooled by a sibling with a shared prefix', () => {
    assert.equal(isPathAllowed(config, '/Users/demo/projects-private/x'), false);
    assert.equal(isPathAllowed(config, '/srv/workshop'), false);
  });
});

describe('expandHome', () => {
  test('expands a leading tilde only', () => {
    assert.equal(expandHome('~'), os.homedir());
    assert.equal(expandHome('~/code'), path.join(os.homedir(), 'code'));
    assert.equal(expandHome('/tmp/~/x'), '/tmp/~/x');
    assert.equal(expandHome('~notauser/x'), '~notauser/x');
  });

  test('passes through non-strings untouched', () => {
    assert.equal(expandHome(undefined), undefined);
    assert.equal(expandHome(null), null);
  });
});
