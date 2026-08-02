/**
 * What the phone shows when the agent hits a wall. These messages are the whole
 * error UI on a small screen: getting "rate_limit_error" is useless, and telling
 * someone their plan reset time is the difference between waiting and giving up.
 */
import assert from 'node:assert/strict';
import test, { describe } from 'node:test';
import { classifyError } from '../src/agent/session.js';

const classify = (raw) => {
  const result = classifyError(raw);
  // The session copies these onto the feed item verbatim.
  return { ...result, errorKind: result.kind };
};

describe('running out of plan', () => {
  test('a usage limit is its own kind, and keeps the reset time', () => {
    const item = classify('Claude AI usage limit reached. Your limit will reset at 3:00 PM.');
    assert.equal(item.errorKind, 'quota');
    assert.equal(item.title, 'Plan limit reached');
    assert.match(item.text, /resets at 3:00 PM/);
    assert.ok(item.hint, 'says what to do meanwhile');
  });

  test('a usage limit without a time still explains itself', () => {
    const item = classify('usage limit reached');
    assert.equal(item.errorKind, 'quota');
    assert.match(item.text, /allowance/);
  });

  test('no credit is billing, not a plan limit', () => {
    const item = classify('Your credit balance is too low to access the Anthropic API.');
    assert.equal(item.errorKind, 'billing');
    assert.equal(item.title, 'Out of credit');
    assert.match(item.hint, /console\.anthropic\.com|subscription/);
  });
});

describe('temporary walls', () => {
  test('rate limiting says to just try again', () => {
    const item = classify('rate_limit_error: too many requests');
    assert.equal(item.errorKind, 'rate');
    assert.match(item.hint, /nothing was lost/i);
  });

  test('an overloaded model is not the user’s fault either', () => {
    const item = classify('API error: overloaded_error (529)');
    assert.equal(item.errorKind, 'rate');
    assert.equal(item.title, 'Servers busy');
  });

  test('a full context window suggests the fix', () => {
    const item = classify('prompt is too long: 210000 tokens > 200000 maximum');
    assert.equal(item.errorKind, 'context');
    assert.match(item.hint, /compact|fresh session/i);
  });
});

describe('credentials', () => {
  test('not signed in points at the button that fixes it', () => {
    const item = classify('Not logged in · Please run /login');
    assert.equal(item.errorKind, 'auth');
    assert.match(item.hint, /Settings/);
  });

  test('an expired token is distinguished from never having signed in', () => {
    const item = classify('OAuth token expired, refresh failed');
    assert.equal(item.errorKind, 'auth');
    assert.equal(item.title, 'Sign-in expired');
  });

  test('a missing binary names the config key', () => {
    const item = classify('Claude Code native binary not found at /nope/claude');
    assert.equal(item.errorKind, 'missing');
    assert.match(item.hint, /claude-remote-control\/config\.json/);
  });
});

describe('anything else', () => {
  test('an unrecognised failure is passed through verbatim, not swallowed', () => {
    const item = classify('EPIPE: broken pipe writing to worker');
    assert.equal(item.errorKind, 'error');
    assert.equal(item.title, null);
    assert.equal(item.text, 'EPIPE: broken pipe writing to worker');
  });

  test('an empty message does not produce an empty box of nothing', () => {
    const item = classify('');
    assert.equal(item.errorKind, 'error');
    assert.equal(typeof item.text, 'string');
  });
});
