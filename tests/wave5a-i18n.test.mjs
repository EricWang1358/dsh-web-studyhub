import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';

// UI wave 5A, #107: no inline bilingual helpers, no sentence assembled from translated halves around a value, and the number of
// locale keys that are sentence fragments (a leading or trailing space) can only go down.
const walk = (dir, extensions) => readdirSync(new URL(`../${dir}`, import.meta.url), { withFileTypes: true }).flatMap(entry =>
  entry.isDirectory() ? walk(`${dir}/${entry.name}`, extensions) : extensions.some(ext => entry.name.endsWith(ext)) ? [`${dir}/${entry.name}`] : []);
const read = file => readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
const sources = walk('ui', ['.js', '.jsx']).map(file => ({ file, text: read(file) }));

test('no inline (zh, en) helper and no language ternary choosing between a Chinese and an English literal', () => {
  const helper = /const\s+\w+\s*=\s*\(\s*(?:zh|cn|chinese)\s*,\s*en(?:glish)?\s*\)\s*=>/;
  const ternary = /(?:language|lang)\s*===\s*['"]en['"]\s*\?\s*['"`][^'"`]*['"`]\s*:\s*['"`][^'"`]*[㐀-鿿]|(?:language|lang)\s*===\s*['"]zh['"]\s*\?\s*['"`][^'"`]*[㐀-鿿][^'"`]*['"`]\s*:\s*['"`][A-Za-z]/;
  // The language switch labels its own two states; topic-group-prompt.js writes the whole agent prompt in both languages by design.
  const own = new Set(['ui/LanguageSwitch.jsx', 'ui/topic-group-prompt.js']);
  assert.deepEqual(sources.filter(({ file, text }) => !own.has(file) && (helper.test(text) || ternary.test(text))).map(({ file }) => file), []);
});

test('no translated sentence is cut around a value: ui("… ") and ui(" …") do not exist', () => {
  const sandwich = /\bui\(\s*(?:"(?: [^"]*|[^"]* )"|'(?: [^']*|[^']* )')\s*\)/;
  assert.deepEqual(sources.filter(({ text }) => sandwich.test(text)).map(({ file }) => file), []);
});

test('locale keys that start or end with a space (fragments) can only go down', () => {
  const FRAGMENTS_NOW = 39; // what is left are the multi-line agent prompts, written in pieces around a value
  let count = 0;
  for (const name of readdirSync(new URL('../ui/locales', import.meta.url))) {
    if (!/^en(\..+)?\.json$/.test(name)) continue;
    count += Object.keys(JSON.parse(read(`ui/locales/${name}`))).filter(key => key !== key.trim()).length;
  }
  assert.ok(count <= FRAGMENTS_NOW, `${count} fragment keys (limit ${FRAGMENTS_NOW}): write one uiFormat / uiRich sentence instead`);
});
