import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after, describe } from 'node:test';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'crc-auth-'));
process.env.CRC_CONFIG_DIR = TMP;

// Imported after CRC_CONFIG_DIR is set so the module reads the temp location.
const { Auth, extractToken } = await import('../src/auth.js');
const { loadConfig } = await import('../src/config.js');

after(() => fs.rmSync(TMP, { recursive: true, force: true }));

const freshAuth = () => {
  const config = loadConfig();
  config.devices = [];
  return { auth: new Auth(config), config };
};

describe('token verification', () => {
  test('accepts the master token and rejects anything else', () => {
    const { auth, config } = freshAuth();
    assert.equal(auth.verify(config.token).kind, 'master');
    assert.equal(auth.verify('wrong'), null);
    assert.equal(auth.verify(''), null);
    assert.equal(auth.verify(null), null);
    assert.equal(auth.verify(undefined), null);
  });

  test('rejects a token that only shares a prefix', () => {
    const { auth, config } = freshAuth();
    assert.equal(auth.verify(config.token.slice(0, -1)), null);
    assert.equal(auth.verify(`${config.token}x`), null);
  });

  test('accepts a registered device token and stamps last seen', () => {
    const { auth } = freshAuth();
    const device = auth.registerDevice({ name: 'iPhone', userAgent: 'test-agent' });
    const identity = auth.verify(device.token);
    assert.equal(identity.kind, 'device');
    assert.equal(identity.device.name, 'iPhone');
    assert.ok(identity.device.lastSeenAt);
  });

  test('a revoked device stops working', () => {
    const { auth } = freshAuth();
    const device = auth.registerDevice({ name: 'Old phone' });
    assert.ok(auth.verify(device.token));
    assert.equal(auth.revokeDevice(device.id), true);
    assert.equal(auth.verify(device.token), null);
    assert.equal(auth.revokeDevice(device.id), false, 'revoking twice is a no-op');
  });

  test('rotating the master token invalidates the old one', () => {
    const { auth, config } = freshAuth();
    const old = config.token;
    const next = auth.rotateMasterToken();
    assert.notEqual(old, next);
    assert.equal(auth.verify(old), null);
    assert.equal(auth.verify(next).kind, 'master');
  });

  test('device tokens are long and unique', () => {
    const { auth } = freshAuth();
    const tokens = new Set();
    for (let i = 0; i < 20; i++) tokens.add(auth.registerDevice({ name: `d${i}` }).token);
    assert.equal(tokens.size, 20);
    for (const token of tokens) assert.ok(token.length >= 40);
  });
});

describe('brute force protection', () => {
  test('locks an address out after repeated failures and clears on success', () => {
    const { auth } = freshAuth();
    assert.equal(auth.isLockedOut('1.2.3.4'), false);
    for (let i = 0; i < 10; i++) auth.recordFailure('1.2.3.4');
    assert.equal(auth.isLockedOut('1.2.3.4'), true);
    assert.equal(auth.isLockedOut('5.6.7.8'), false, 'lockout is per address');
    auth.clearFailures('1.2.3.4');
    assert.equal(auth.isLockedOut('1.2.3.4'), false);
  });

  test('a few failures do not lock anyone out', () => {
    const { auth } = freshAuth();
    for (let i = 0; i < 9; i++) auth.recordFailure('9.9.9.9');
    assert.equal(auth.isLockedOut('9.9.9.9'), false);
  });
});

describe('pairing codes', () => {
  test('a code works exactly once', () => {
    const { auth } = freshAuth();
    const { code } = auth.createPairingCode();
    assert.match(code, /^\d{6}$/);
    assert.equal(auth.consumePairingCode(code), true);
    assert.equal(auth.consumePairingCode(code), false);
  });

  test('an unknown code is refused', () => {
    const { auth } = freshAuth();
    assert.equal(auth.consumePairingCode('000000'), false);
  });

  test('an expired code is refused and swept', () => {
    const { auth } = freshAuth();
    const { code } = auth.createPairingCode();
    auth.pairingCodes.get(code).expiresAt = Date.now() - 1;
    assert.equal(auth.consumePairingCode(code), false);

    const { code: other } = auth.createPairingCode();
    auth.pairingCodes.get(other).expiresAt = Date.now() - 1;
    auth.sweepPairingCodes();
    assert.equal(auth.pairingCodes.size, 0);
  });
});

describe('extractToken', () => {
  test('reads the bearer header', () => {
    assert.equal(extractToken({ headers: { authorization: 'Bearer abc123' } }, null), 'abc123');
  });

  test('falls back to the query string for websockets', () => {
    const url = new URL('http://x/ws?token=qs-token');
    assert.equal(extractToken({ headers: {} }, url), 'qs-token');
  });

  test('returns null when nothing is present', () => {
    assert.equal(extractToken({ headers: {} }, new URL('http://x/ws')), null);
    assert.equal(extractToken({ headers: { authorization: 'Basic xyz' } }, null), null);
  });
});
