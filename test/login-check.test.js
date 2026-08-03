/**
 * Whether Claude Code is signed in, read without touching the keychain.
 *
 * The keychain answer is the one that lied: a daemon launched by the menu bar
 * app asks it from a bundle whose signature changes on every upgrade, the ACL
 * stops recognising the caller, and a signed-in machine reads as signed out.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after, before, describe } from 'node:test';

const HOME = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'crc-home-')));
const realHome = os.homedir;
const realKey = process.env.ANTHROPIC_API_KEY;

before(() => {
  os.homedir = () => HOME;
  delete process.env.ANTHROPIC_API_KEY;
});

after(() => {
  os.homedir = realHome;
  if (realKey) process.env.ANTHROPIC_API_KEY = realKey;
  fs.rmSync(HOME, { recursive: true, force: true });
});

const { oauthAccount } = await import('../src/doctor.js');
const write = (contents) => fs.writeFileSync(path.join(HOME, '.claude.json'), contents);

describe('reading the signed-in account', () => {
  test('finds the address Claude Code recorded', () => {
    write(JSON.stringify({ oauthAccount: { emailAddress: 'someone@example.com' }, other: 1 }));
    assert.equal(oauthAccount(), 'someone@example.com');
  });

  test('no file is not an answer', () => {
    fs.rmSync(path.join(HOME, '.claude.json'), { force: true });
    assert.equal(oauthAccount(), null);
  });

  test('a half-written file is not an answer either, and does not throw', () => {
    write('{"oauthAccount": {"emailAddr');
    assert.equal(oauthAccount(), null);
  });

  test('a logged-out file says nothing rather than something empty', () => {
    write(JSON.stringify({ userID: 'abc' }));
    assert.equal(oauthAccount(), null);
    write(JSON.stringify({ oauthAccount: { emailAddress: '' } }));
    assert.equal(oauthAccount(), null);
    write(JSON.stringify({ oauthAccount: { emailAddress: 'not-an-address' } }));
    assert.equal(oauthAccount(), null);
  });
});
