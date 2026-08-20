/**
 * Two languages in a no-build app.
 *
 * The rule that matters: English is the source text and lives in the markup,
 * so a key missing from a dictionary renders a sentence rather than
 * `settings.neverAsk`. These tests hold that line, and check that the
 * Portuguese table has not drifted into holes.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import test, { describe } from 'node:test';
import { fileURLToPath } from 'node:url';

const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
};
globalThis.document = { documentElement: {}, querySelectorAll: () => [] };
// O navegador entra aqui junto de localStorage e document, e por dois motivos: sem
// ele o teste quebra, e com ele a asserção passa a depender do que este arquivo diz
// em vez do que o Node do dia expõe.
// `defineProperty` e não atribuição: a partir da 21 o Node define `navigator` como
// getter no global, e `globalThis.navigator = ...` estoura um TypeError em módulo
// (que é sempre estrito). Antes da 21 o global não existe, e aí `web/i18n.js` estoura
// um ReferenceError já na importação, porque resolveLanguage roda na inicialização do
// módulo. `defineProperty` atende os dois casos.
Object.defineProperty(globalThis, 'navigator', {
  value: { language: 'en-US' },
  configurable: true,
  writable: true,
});

const { LANGUAGES, resolveLanguage, setLanguage, t } = await import('../web/i18n.js');

describe('choosing a language', () => {
  test('automatic follows the phone, explicit choices do not', () => {
    // navigator is stubbed at the top of this file, reporting en-US.
    assert.equal(resolveLanguage('auto'), 'en');
    assert.equal(resolveLanguage('pt'), 'pt');
    assert.equal(resolveLanguage('en'), 'en');
  });

  test('a language nobody translated falls back rather than breaking', () => {
    assert.equal(resolveLanguage('kl'), 'en');
  });

  test('the picker offers exactly what the dictionary supports', () => {
    assert.deepEqual(LANGUAGES.map((l) => l.id), ['auto', 'en', 'pt']);
  });
});

describe('translating', () => {
  test('a missing key renders the English source, never the key', () => {
    setLanguage('pt');
    assert.equal(t('nothing.here.at.all', 'Plain English'), 'Plain English');
    assert.ok(!t('nothing.here.at.all', 'Plain English').includes('.'));
  });

  test('Portuguese is used when Portuguese exists', () => {
    setLanguage('pt');
    assert.equal(t('action.copy', 'Copy'), 'Copiar');
    setLanguage('en');
    assert.equal(t('action.copy', 'Copy'), 'Copy');
  });

  test('interpolation works in both languages', () => {
    setLanguage('pt');
    assert.match(t('settings.devices', 'Paired devices ({count})', { count: 3 }), /\(3\)/);
    setLanguage('en');
    assert.equal(t('settings.devices', 'Paired devices ({count})', { count: 3 }), 'Paired devices (3)');
  });
});

describe('the markup and the dictionary agree', () => {
  const html = fs.readFileSync(fileURLToPath(new URL('../web/index.html', import.meta.url)), 'utf8');
  const source = fs.readFileSync(fileURLToPath(new URL('../web/i18n.js', import.meta.url)), 'utf8');

  test('every data-i18n key in the markup exists in Portuguese', () => {
    const keys = [...html.matchAll(/data-i18n(?:-placeholder|-aria|-title)?="([^"]+)"/g)].map((m) => m[1]);
    assert.ok(keys.length > 20, `expected the markup to be marked up, found ${keys.length}`);

    const missing = keys.filter((key) => !source.includes(`'${key}':`));
    assert.deepEqual(missing, [], `keys with no Portuguese: ${missing.join(', ')}`);
  });

  test('every tagged element still carries its English text', () => {
    // The fallback only works if the source text is in the markup.
    const empties = [...html.matchAll(/data-i18n="([^"]+)"[^>]*>(\s*)</g)].map((m) => m[1]);
    assert.deepEqual(empties, [], `tagged but empty: ${empties.join(', ')}`);
  });
});
