/**
 * Reading a model's answer when you asked it for names. It will sometimes wrap
 * the JSON in a fence, sometimes in a sentence, and occasionally in both.
 */
import assert from 'node:assert/strict';
import test, { describe } from 'node:test';

const { parseTitles } = await import('../src/rename.js');

describe('reading back suggested names', () => {
  test('plain JSON', () => {
    assert.deepEqual(parseTitles('{"a":"Queue player","b":"GitHub migration"}'), {
      a: 'Queue player',
      b: 'GitHub migration',
    });
  });

  test('wrapped in a fence, with prose around it', () => {
    const reply = 'Sure, here they are:\n```json\n{"a": "Radar refactor"}\n```\nHope that helps!';
    assert.deepEqual(parseTitles(reply), { a: 'Radar refactor' });
  });

  test('strips the quoting and punctuation a model adds to a title', () => {
    assert.deepEqual(parseTitles('{"a":"\\"Catalogue import\\".","b":"Player bar:"}'), {
      a: 'Catalogue import',
      b: 'Player bar',
    });
  });

  test('a name in the conversation’s own language survives intact', () => {
    assert.deepEqual(parseTitles('{"a":"Configuração do Mac novo"}'), { a: 'Configuração do Mac novo' });
  });

  test('anything that is not a string is dropped, not coerced', () => {
    assert.deepEqual(parseTitles('{"a":"Fine","b":null,"c":42,"d":{"nested":true}}'), { a: 'Fine' });
  });

  test('an empty name is not a name', () => {
    assert.deepEqual(parseTitles('{"a":"   ","b":"Real one"}'), { b: 'Real one' });
  });

  test('a reply with no JSON at all renames nothing rather than throwing', () => {
    assert.deepEqual(parseTitles('I could not do that.'), {});
    assert.deepEqual(parseTitles(''), {});
    assert.deepEqual(parseTitles(undefined), {});
  });

  test('a very long name is cut rather than allowed to fill the sidebar', () => {
    const long = 'x'.repeat(200);
    assert.equal(parseTitles(`{"a":"${long}"}`).a.length, 60);
  });
});
