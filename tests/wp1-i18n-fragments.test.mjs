import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { build } from 'esbuild';

// C2: ui/i18n.js merges ui/locales/en.json with one fragment per work package.
// esbuild cannot glob, so every fragment must be imported explicitly; these
// tests catch a fragment that exists on disk but never reaches the catalogue,
// and the same Chinese key translated two different ways.
const require = createRequire(import.meta.url);
const compiled = await build({ stdin: { contents: `export * from './ui/i18n.js';`, resolveDir: process.cwd() },
  bundle: true, write: false, platform: 'node', format: 'cjs', external: ['react'], logLevel: 'silent' });
function load() {
  const module = { exports: {} };
  new Function('require', 'module', 'exports', compiled.outputFiles[0].text)(require, module, module.exports);
  return module.exports;
}
const REQUIRED = ['en.json', 'en.components.json', 'en.import.json', 'en.generate.json', 'en.audio.json',
  'en.practice.json', 'en.agent.json', 'en.host.json', 'en.shell.json', 'en.onboarding.json', 'en.copy.json'];

test('every English locale file on disk is merged into the catalogue', async () => {
  const { ENGLISH_SOURCES } = load();
  assert.ok(ENGLISH_SOURCES, 'i18n.js exports the catalogue sources');
  const onDisk = (await readdir('ui/locales')).filter(name => /^en(\..+)?\.json$/.test(name)).sort();
  for (const name of REQUIRED) assert.ok(onDisk.includes(name), `ui/locales/${name} exists`);
  assert.deepEqual(Object.keys(ENGLISH_SOURCES).sort(), onDisk);
  for (const name of onDisk) {
    const parsed = JSON.parse(await readFile(`ui/locales/${name}`, 'utf8'));
    assert.deepEqual(ENGLISH_SOURCES[name], parsed, `${name} is imported verbatim`);
    for (const [key, value] of Object.entries(parsed)) assert.equal(typeof value, 'string', `${name}: ${key}`);
  }
});

test('the same source text translated differently in two files is a conflict', () => {
  const { mergeCatalogues } = load();
  const same = mergeCatalogues({ 'en.json': { 保存: 'Save' }, 'en.import.json': { 保存: 'Save', 导入: 'Import' } });
  assert.deepEqual(same.conflicts, []);
  assert.deepEqual(same.catalogue, { 保存: 'Save', 导入: 'Import' });
  const clash = mergeCatalogues({ 'en.json': { 保存: 'Save' }, 'en.audio.json': { 保存: 'Keep' } });
  assert.equal(clash.conflicts.length, 1);
  assert.deepEqual(clash.conflicts[0], { key: '保存', files: ['en.json', 'en.audio.json'], values: ['Save', 'Keep'] });
  assert.equal(clash.catalogue.保存, 'Save', 'the base catalogue wins at runtime');
});

test('the shipped locale files have no conflicting translations', () => {
  const { mergeCatalogues, ENGLISH_SOURCES } = load();
  const { conflicts } = mergeCatalogues(ENGLISH_SOURCES);
  assert.deepEqual(conflicts.map(item => `${item.key}: ${item.files.join(' vs ')}`), []);
});

test('ui() translates keys that only exist in a fragment', async () => {
  const { ui, setUiLanguage } = load();
  const fragment = JSON.parse(await readFile('ui/locales/en.components.json', 'utf8'));
  const base = JSON.parse(await readFile('ui/locales/en.json', 'utf8'));
  const own = Object.keys(fragment).filter(key => !Object.hasOwn(base, key));
  assert.ok(own.length > 0, 'en.components.json carries component copy');
  setUiLanguage('en');
  for (const key of own) assert.equal(ui(key), fragment[key]);
  setUiLanguage('zh');
  assert.equal(ui(own[0]), own[0]);
});
