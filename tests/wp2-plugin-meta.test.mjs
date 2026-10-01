import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname } from 'node:path';
import { parse } from 'yaml';

const require = createRequire(import.meta.url);
const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
const rows = parse(await readFile(new URL('../cordis.patch.yml', import.meta.url), 'utf8'))[0].insert;

/* DSH 0.2's plugin manager titles a bundle and each of its component rows with
   `readPluginMeta(specifier)` (@deepseek-ai/dsh-app-boot): it resolves
   `<specifier>/locale/en.json` through package exports, reads `meta.title` /
   `meta.description` from every language file beside it, and otherwise falls
   back to package.json name/description (or the bare specifier). */
function meta(specifier) {
  const english = require.resolve(`${specifier}/locale/en.json`);
  const chinese = require.resolve(`${specifier}/locale/zh.json`);
  assert.equal(dirname(chinese), dirname(english), `${specifier}: translations share the English directory`);
  return { en: require(english).meta, zh: require(chinese).meta };
}

test('the plugin presents itself as StudyHub in the DSH plugin manager', () => {
  assert.match(manifest.description, /^StudyHub/);
  assert.doesNotMatch(manifest.description, /Daily Flashcard/);
  assert.ok(manifest.files.includes('locale'), 'locale files are published');
  const own = meta(manifest.name);
  for (const language of ['en', 'zh']) {
    assert.equal(own[language].title, 'StudyHub');
    assert.ok(own[language].description.length > 10);
  }
});

test('every component row has a readable StudyHub title in both languages', () => {
  const titles = new Set();
  for (const row of rows) {
    const { en, zh } = meta(row.name);
    assert.match(en.title, /^StudyHub/, row.name);
    assert.match(zh.title, /^StudyHub/, row.name);
    assert.ok(en.description && zh.description, `${row.name} explains what it adds`);
    assert.match(zh.description, /[㐀-鿿]/);
    titles.add(en.title);
  }
  assert.equal(titles.size, rows.length, 'components are distinguishable');
});
