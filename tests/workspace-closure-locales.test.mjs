import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { buildHostClient, englishOnDemand } from '../scripts/build.mjs';

/* #563: Chinese is the source language, so a Chinese interface needs none of the English catalogue (ui/locales/en*.json and
   lib/application-messages-en.js, about 1.1 MB). The host build keeps it out of what the StudyHub workspace loads at start and puts it in a
   chunk of its own, loaded only when the interface is English. Node and the tests keep the ordinary import (ui/i18n.js). */

const englishInput = path => /(?:^|[\\/])ui[\\/]locales[\\/]en[^\\/]*\.json$/.test(path) || /^(?:[^:]*[\\/])?lib[\\/]application-messages-en\.js$/.test(path);

test('the English catalogue is not in the static closure of the host workspace chunk, and is one chunk reached only by a dynamic import', async () => {
  const result = await buildHostClient({ write: false });
  const outputs = new Map(Object.entries(result.metafile.outputs).map(([path, output]) => [basename(path), output]));
  const sizeOf = name => result.outputFiles.find(file => basename(file.path) === name).contents.length;
  const workspace = [...outputs].find(([, output]) => output.entryPoint === 'ui/host/workspace.jsx');
  assert.ok(workspace, 'the workspace is a chunk of its own');
  const closure = new Set();
  const visit = name => {
    if (closure.has(name)) return;
    closure.add(name);
    for (const edge of outputs.get(name).imports) if (!edge.external && edge.kind === 'import-statement') visit(basename(edge.path));
  };
  visit(workspace[0]);
  for (const name of closure) {
    const english = Object.keys(outputs.get(name).inputs).filter(englishInput);
    assert.deepEqual(english, [], `${name} loads with the workspace but holds English catalogue files`);
  }
  // The catalogue itself: every fragment and the app's English messages, in a chunk nothing imports statically.
  const catalogue = [...outputs].filter(([, output]) => Object.keys(output.inputs).some(englishInput));
  assert.equal(catalogue.length, 1, 'the English catalogue is one chunk');
  const [name, output] = catalogue[0];
  assert.equal(output.entryPoint, 'ui/english-catalogue.js');
  assert.ok(Object.keys(output.inputs).some(path => /lib[\\/]application-messages-en\.js$/.test(path)), 'the app messages travel with the interface copy');
  assert.ok(Object.keys(output.inputs).filter(englishInput).length >= 60, 'every ui/locales/en*.json fragment is in it');
  for (const [other, record] of outputs) {
    for (const edge of record.imports) if (basename(edge.path) === name) assert.equal(edge.kind, 'dynamic-import', `${other} imports the English catalogue statically`);
  }
  const closureBytes = [...closure].reduce((sum, chunk) => sum + sizeOf(chunk), 0);
  assert.ok(sizeOf(name) > 900_000, `the catalogue chunk carries the catalogue (${sizeOf(name)} bytes)`);
  console.log(`# workspace static closure ${closureBytes} bytes in ${closure.size} chunks; English catalogue chunk ${sizeOf(name)} bytes`);
});

/* The same seam as the host build (englishOnDemand), as an ES module with real chunks that Node imports: ui() stays synchronous, a switch to
   English waits for the catalogue, and an English interface at boot is ready only once it has it. React is a stub (no component renders here):
   its useSyncExternalStore hands back the subscribe function useUiLanguage gives it, so the test listens the way a component does. */
const reactStub = { name: 'react-stub', setup(b) {
  b.onResolve({ filter: /^react$/ }, () => ({ path: 'react', namespace: 'react-stub' }));
  b.onLoad({ filter: /.*/, namespace: 'react-stub' }, () => ({ contents: 'export const useSyncExternalStore = subscribe => subscribe;', loader: 'js' }));
} };
const SAMPLE = '重新加载状态', MESSAGE = '这个操作现在不可用。';

async function hostI18n(saved) {
  const outdir = await mkdtemp(join(tmpdir(), 'studyhub-i18n-'));
  await build({ stdin: { contents: `export * from './ui/i18n.js';`, resolveDir: process.cwd(), sourcefile: 'host-i18n.js' },
    bundle: true, splitting: true, format: 'esm', platform: 'neutral', outdir, entryNames: 'i18n', chunkNames: '[name]-[hash]',
    plugins: [reactStub, englishOnDemand], logLevel: 'silent' });
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  const store = new Map(saved ? [['study-ui-language', saved]] : []);
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { getItem: key => store.get(key) ?? null, setItem: (key, value) => store.set(key, value) } });
  try {
    const module = await import(pathToFileURL(join(outdir, 'i18n.js')).href);
    return { module, store, cleanup: () => rm(outdir, { recursive: true, force: true }), restore: () => (previous ? Object.defineProperty(globalThis, 'localStorage', previous) : delete globalThis.localStorage) };
  } catch (error) { await rm(outdir, { recursive: true, force: true }); throw error; }
}

test('host path: a Chinese interface has no English until it switches; the switch loads the catalogue first, then re-renders in English', async t => {
  const { module: i18n, store, cleanup, restore } = await hostI18n('zh');
  t.after(async () => { restore(); await cleanup(); });
  assert.equal(i18n.getUiLanguage(), 'zh');
  assert.equal(i18n.englishCatalogueLoaded(), false, 'nothing English is loaded for a Chinese interface');
  assert.equal(i18n.ENGLISH_SOURCES, null);
  await i18n.uiLanguageReady();
  assert.equal(i18n.englishCatalogueLoaded(), false, 'a Chinese interface is ready without the catalogue');
  assert.equal(i18n.ui(SAMPLE), SAMPLE);
  // What a component subscribed through useUiLanguage sees each time it is told to render again.
  const seen = [];
  const unsubscribe = i18n.useUiLanguage()(() => seen.push(i18n.ui(SAMPLE)));
  i18n.setUiLanguage('en');
  assert.equal(i18n.getUiLanguage(), 'zh', 'the language waits for its catalogue: no half-English frame');
  assert.deepEqual(seen, []);
  await i18n.loadEnglishCatalogue();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(i18n.getUiLanguage(), 'en');
  assert.equal(store.get('study-ui-language'), 'en', 'the choice is remembered once it took effect');
  assert.deepEqual(seen, ['Reload status'], 'subscribers re-render once, already in English');
  assert.equal(i18n.ui(SAMPLE), 'Reload status');
  assert.equal(i18n.uiMessage(MESSAGE), 'That is not available right now.', 'the app messages arrived with it (lib/application-messages.js)');
  assert.ok(Object.keys(i18n.ENGLISH_SOURCES).includes('en.json'));
  // Back to Chinese and English again: both synchronous now that the catalogue is here.
  i18n.setUiLanguage('zh');
  assert.equal(i18n.ui(SAMPLE), SAMPLE);
  i18n.setUiLanguage('en');
  assert.equal(i18n.ui(SAMPLE), 'Reload status');
  unsubscribe();
});

test('host path: a switch to English and straight back to Chinese stays Chinese', async t => {
  const { module: i18n, cleanup, restore } = await hostI18n('zh');
  t.after(async () => { restore(); await cleanup(); });
  i18n.setUiLanguage('en');
  i18n.setUiLanguage('zh');
  await i18n.loadEnglishCatalogue();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(i18n.getUiLanguage(), 'zh');
  assert.equal(i18n.ui(SAMPLE), SAMPLE);
});

test('host path: an English interface at boot is ready only with its catalogue, so the first render is already English', async t => {
  const { module: i18n, cleanup, restore } = await hostI18n('en');
  t.after(async () => { restore(); await cleanup(); });
  assert.equal(i18n.getUiLanguage(), 'en');
  await i18n.uiLanguageReady();
  assert.equal(i18n.englishCatalogueLoaded(), true);
  assert.equal(i18n.ui(SAMPLE), 'Reload status');
  assert.equal(i18n.uiMessage(MESSAGE), 'That is not available right now.');
});
