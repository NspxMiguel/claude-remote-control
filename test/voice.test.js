/**
 * What a reply sounds like when it is read out loud.
 *
 * The whole feature lives or dies on this function: a spoken code block is
 * half a minute of "open brace const x equals", and a spoken path is a minute
 * of "slash Users slash miguel slash". Everything unspeakable is replaced with
 * a short placeholder rather than dropped, so the sentence still parses.
 */
import assert from 'node:assert/strict';
import test, { describe } from 'node:test';

// The module reaches for window at import time, so give it one. Node has its
// own read-only `navigator`, which is close enough for this.
globalThis.window = { isSecureContext: true };

const { speakableText } = await import('../web/voice.js');

describe('what gets read aloud', () => {
  test('a fenced code block becomes three words, not thirty seconds', () => {
    const spoken = speakableText('Here is the fix:\n\n```js\nconst x = 1;\nfoo(bar, baz);\n```\n\nTry it.');
    assert.match(spoken, /^Here is the fix/);
    assert.match(spoken, /\(code block\)/);
    assert.ok(!spoken.includes('const'), spoken);
    assert.match(spoken, /Try it\.$/);
  });

  test('a short inline span is spoken, a long one is summarised', () => {
    assert.match(speakableText('Pass `--verbose` to see more.'), /Pass --verbose to see more/);
    const long = speakableText('Run `npm install --omit=dev --no-audit --no-fund` first.');
    assert.match(long, /\(command\)/);
    assert.ok(!long.includes('--no-audit'), long);
  });

  test('paths and links do not get spelled out', () => {
    const spoken = speakableText('I wrote /Users/miguel/Documents/notes.md and pushed to https://github.com/x/y');
    assert.match(spoken, /\(a path\)/);
    assert.match(spoken, /\(link\)/);
    assert.ok(!spoken.includes('Users'), spoken);
  });

  test('markdown furniture is dropped but the words survive', () => {
    const spoken = speakableText('## Result\n\n- **Fixed** the parser\n- Added a *test*\n\n> It works now.');
    assert.match(spoken, /Result/);
    assert.match(spoken, /Fixed the parser/);
    assert.match(spoken, /Added a test/);
    assert.match(spoken, /It works now\./);
    assert.ok(!spoken.includes('#'), spoken);
    assert.ok(!spoken.includes('*'), spoken);
    assert.ok(!spoken.includes('>'), spoken);
  });

  test('a reply that is mostly code does not become a chant', () => {
    const spoken = speakableText('```a\n1\n```\n```b\n2\n```\n```c\n3\n```');
    const count = (spoken.match(/code block/g) || []).length;
    assert.ok(count <= 1, `expected the placeholders to collapse, got: ${spoken}`);
  });

  test('a table is named rather than recited cell by cell', () => {
    const spoken = speakableText('Results:\n\n| a | b |\n| --- | --- |\n| 1 | 2 |\n\nDone.');
    assert.match(spoken, /\(a table\)/);
    assert.ok(!spoken.includes('|'), spoken);
    assert.match(spoken, /Done\.$/);
  });

  test('nothing to say returns nothing, so the button can stay quiet', () => {
    assert.equal(speakableText(''), '');
    assert.equal(speakableText(null), '');
    assert.equal(speakableText('```\njust code\n```').replace(/\(code block\)/, '').trim(), '');
  });
});
