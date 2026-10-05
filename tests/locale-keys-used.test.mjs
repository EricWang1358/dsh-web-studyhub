import test from 'node:test';
import assert from 'node:assert/strict';
import { englishCatalogues, sourceCorpus, unreferencedKeys } from './helpers/locale-usage.mjs';

/* #230: every English translation key is used by the source. A key nothing calls (left behind when a control, a preset or an option was removed) is
   a translation to keep up for nothing, and it hides the day the same text is needed again with a different meaning. The English catalogues are
   ui/locales/en*.json, keyed by the Chinese source text; "used" means the text stands in a file of ui/ or lib/ (tests/helpers/locale-usage.mjs). */

/* Keys the source does not spell out in one piece, each with where it is built. An entry is checked: it must match a key, and everything it matches
   must still be missing from the source (a key that is spelled out again does not need an exception). */
const BUILT_AT_RUN_TIME = Object.freeze([
  { startsWith: '开始录题：', where: 'ui/agent-prompts/ingest.js: START is one string written as nine concatenated lines, and say() looks the whole of it up' },
]);
const excepted = (key) => BUILT_AT_RUN_TIME.some((entry) => key.startsWith(entry.startsWith));

const catalogues = await englishCatalogues();

test('every English translation key is used by ui/ or lib/ source', async () => {
  const corpus = await sourceCorpus();
  const unused = [];
  for (const { file, keys } of catalogues) for (const key of unreferencedKeys(keys, corpus)) if (!excepted(key)) unused.push(`${file}: ${key.slice(0, 80)}`);
  assert.deepEqual(unused, [], `${unused.length} English key(s) nothing uses; delete them (or list a key built at run time in BUILT_AT_RUN_TIME with where it is built)`);
});

test('the exception list only holds keys that exist and that the source really does not spell out', async () => {
  const corpus = await sourceCorpus(), keys = catalogues.flatMap((catalogue) => catalogue.keys);
  for (const entry of BUILT_AT_RUN_TIME) {
    const matched = keys.filter((key) => key.startsWith(entry.startsWith));
    assert.ok(matched.length > 0, `exception for keys that no longer exist: ${entry.startsWith}`);
    assert.deepEqual(unreferencedKeys(matched, corpus), matched, `the source spells these keys out now, so they need no exception: ${entry.startsWith}`);
    assert.ok(entry.where.length > 20, `say where "${entry.startsWith}" is built`);
  }
});

test('the check finds a key nothing uses, and counts an escaped literal as used', () => {
  const corpus = "ui('保存')\nuiFormat('已选 {0} 项', [n])\nui('it\\'s fine')\nui('第一行\\n第二行')";
  const unescaped = corpus.replace(/\\(['"`])/g, '$1').replace(/\\n/g, '\n');
  assert.deepEqual(unreferencedKeys(['保存', '已选 {0} 项', '没人用的键'], corpus), ['没人用的键']);
  assert.deepEqual(unreferencedKeys(["it's fine", '第一行\n第二行'], `${corpus}\n${unescaped}`), []);
  assert.deepEqual(unreferencedKeys(['保存'], 'no translation call here'), ['保存']);
});
