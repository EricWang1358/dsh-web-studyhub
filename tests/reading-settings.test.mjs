/* 学习内容的阅读设置: the source reader's size, line width, typeface and background are ONE per-browser setting shared by every
   long-form reading surface (review explanations and Q&A, results, notes, lessons, the skeleton detail pane, the exam report).
   The reader keeps its storage key and shape, so a choice made before this change survives; changing it in one place changes it in
   every open panel; 恢复默认 resets all of them. Pure logic, the shared store and static markup; the real layout is checked in the
   browser (scripts/qa/reading.mjs). */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import * as shared from '../ui/reading-settings/settings.js';
import * as reader from '../ui/document-preview/reader/settings.js';
import { createReadingStore } from '../ui/reading-settings/store.js';

const han = /[㐀-鿿]/;
const memory = (initial = {}) => {
  const data = new Map(Object.entries(initial));
  return { getItem: key => data.has(key) ? data.get(key) : null, setItem: (key, value) => { data.set(key, String(value)); }, removeItem: key => data.delete(key), data };
};

/* ---------- the module the reader and every other surface share ---------- */

test('the reader keeps its names, its storage key and its defaults: they are the shared module', () => {
  for (const name of ['SIZES', 'WIDTHS', 'FACES', 'TONES', 'UNDERLINES', 'READER_DEFAULTS', 'READER_STORAGE_KEY', 'normalizeReaderSettings', 'underlineShown',
    'resetReaderSettings', 'stepSize', 'readerVars', 'loadReaderSettings', 'saveReaderSettings'])
    assert.equal(reader[name], shared[name], name);
  assert.equal(shared.READER_STORAGE_KEY, 'study-reader-settings', 'the key the reader always used');
  assert.deepEqual({ ...shared.READER_DEFAULTS }, { size: 16, width: 'standard', face: 'sans', tone: 'auto', underline: 'show', outline: true, tools: true });
});

test('a value stored by an earlier version still loads: kept choices stay, missing ones fall back, junk is dropped', () => {
  // 2.3.0 stored no underline choice and no tone; an even older one stored a size outside today's scale.
  const old = memory({ [shared.READER_STORAGE_KEY]: JSON.stringify({ size: 18, width: 'wide', face: 'serif', outline: false }) });
  assert.deepEqual(shared.loadReaderSettings(old), { size: 18, width: 'wide', face: 'serif', tone: 'auto', underline: 'show', outline: false, tools: true });
  const odd = memory({ [shared.READER_STORAGE_KEY]: JSON.stringify({ size: 13, width: 'huge', face: 'comic', tone: 'sepia', underline: 'x', tools: 'yes', extra: 1 }) });
  assert.deepEqual(shared.loadReaderSettings(odd), { ...shared.READER_DEFAULTS });
  for (const raw of ['{broken', 'null', '[]', '""', '7']) assert.deepEqual(shared.loadReaderSettings(memory({ [shared.READER_STORAGE_KEY]: raw })), { ...shared.READER_DEFAULTS }, raw);
  assert.deepEqual(shared.loadReaderSettings(null), { ...shared.READER_DEFAULTS });
});

test('the reading text never goes below 15px and the measure follows the size', () => {
  assert.ok(shared.SIZES.every(size => size >= 15));
  const vars = shared.readingVars({ size: 20, width: 'wide' });
  assert.equal(vars['--reader-size'], '20px');
  assert.equal(vars['--reader-measure'], '56em');
  assert.equal(vars['--reading-measure'], `${56 * 20}px`, 'the same measure for a block whose own font size is not the reading size');
  assert.equal(vars['--reader-leading'], '1.7');
  assert.equal(vars['--reading-leading'], '1.55', 'study text is set a little tighter than the reader column');
  assert.equal(shared.readingVars({ size: 16 })['--reading-leading'], '1.65');
  assert.equal(shared.readingVars({ size: 6 })['--reader-size'], '16px', 'a size outside the scale is the default, never smaller than 15px');
  assert.deepEqual(shared.readerVars({ size: 20, width: 'wide' }), { '--reader-size': '20px', '--reader-measure': '56em', '--reader-leading': '1.7' }, 'the reader keeps exactly its own variables');
});

test('the props of a reading block carry the face and tone as data attributes and the sizes as variables', () => {
  const props = shared.readingProps({ size: 18, width: 'narrow', face: 'serif', tone: 'paper' });
  assert.equal(props['data-face'], 'serif');
  assert.equal(props['data-tone'], 'paper');
  assert.equal(props.style['--reader-size'], '18px');
  assert.equal(shared.readingProps(undefined)['data-face'], 'sans');
});

/* ---------- the store: one setting, every open panel ---------- */

test('the store loads what the reader stored, saves every change and tells every open panel at once', () => {
  const storage = memory({ [shared.READER_STORAGE_KEY]: JSON.stringify({ size: 20, face: 'serif' }) });
  const store = createReadingStore({ storage });
  assert.equal(store.get().size, 20);
  assert.equal(store.get().face, 'serif');
  const seen = [[], []];
  const stops = seen.map(log => store.subscribe(() => log.push(store.get().size)));
  store.update({ size: 22 });
  assert.deepEqual(seen, [[22], [22]], 'both panels hear it');
  assert.equal(JSON.parse(storage.data.get(shared.READER_STORAGE_KEY)).size, 22, 'and it is kept for the next visit');
  store.update({ size: 22 });
  assert.deepEqual(seen, [[22], [22]], 'an unchanged value is not a change');
  store.update({ size: 99, face: 'serif' });
  assert.equal(store.get().size, 16, 'an out-of-scale size is not kept');
  assert.deepEqual(seen, [[22, 16], [22, 16]]);
  assert.equal(store.get(), store.get(), 'the same object until something changes (a stable snapshot)');
  stops.forEach(stop => stop());
  store.update({ size: 17 });
  assert.deepEqual(seen, [[22, 16], [22, 16]], 'a closed panel no longer listens');
});

test('another tab changing the setting reaches this one (the storage event)', () => {
  const storage = memory();
  const store = createReadingStore({ storage });
  assert.equal(store.get().size, 16);
  let heard = 0;
  store.subscribe(() => { heard += 1; });
  storage.setItem(shared.READER_STORAGE_KEY, JSON.stringify({ size: 24, width: 'wide' }));
  store.reload();
  assert.equal(store.get().size, 24);
  assert.equal(store.get().width, 'wide');
  assert.equal(heard, 1);
});

test('恢复默认 resets the display everywhere and never closes a panel the reader had open', () => {
  const store = createReadingStore({ storage: memory({ [shared.READER_STORAGE_KEY]: JSON.stringify({ size: 22, width: 'wide', face: 'serif', tone: 'paper', underline: 'hide', outline: false, tools: false }) }) });
  let heard = 0;
  store.subscribe(() => { heard += 1; });
  store.reset();
  assert.deepEqual(store.get(), { ...shared.READER_DEFAULTS, outline: false, tools: false });
  assert.equal(heard, 1);
});

test('a blocked or throwing storage only costs the memory of the choice', () => {
  const store = createReadingStore({ storage: { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); } } });
  assert.equal(store.get().size, 16);
  store.update({ size: 20 });
  assert.equal(store.get().size, 20, 'it still applies for this session');
});

/* ---------- the markup ---------- */

const compiled = await build({ stdin: { contents: `
  export { ReadingSettingsButton, ReadingBlock, DisplayControls } from './ui/reading-settings/ReadingSettings.jsx';
  export { default as ReaderDisplaySettings, DisplayControls as ReaderDisplayControls } from './ui/document-preview/reader/DisplaySettings.jsx';
  export { setUiLanguage } from './ui/i18n.js';`, resolveDir: process.cwd() },
  bundle: true, write: false, platform: 'node', format: 'cjs', external: ['react', 'react-dom'], loader: { '.css': 'text' }, logLevel: 'silent' });
const module = { exports: {} };
new Function('require', 'module', 'exports', compiled.outputFiles[0].text)(createRequire(import.meta.url), module, module.exports);
const lib = module.exports;
const h = React.createElement;
const text = html => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
const inLanguage = (language, run) => { try { lib.setUiLanguage(language); return run(); } finally { lib.setUiLanguage('zh'); } };

test('the Aa button is the reader\'s own control, with the underline row only where passages are underlined', () => {
  const alone = renderToStaticMarkup(h(lib.ReadingSettingsButton, {}));
  assert.match(alone, /class="reader-popover/);
  assert.match(alone, /aria-label="显示设置"/);
  assert.match(alone, /aria-expanded="false"/);
  const controls = (props = {}) => renderToStaticMarkup(h(lib.DisplayControls, { settings: { ...shared.READER_DEFAULTS }, onChange() {}, onReset() {}, ...props }));
  const withUnderline = controls();
  const without = controls({ underline: false });
  for (const label of ['字号', '版心宽度', '字体', '背景', '恢复默认']) { assert.match(withUnderline, new RegExp(label)); assert.match(without, new RegExp(label)); }
  assert.match(withUnderline, /下划线/);
  assert.doesNotMatch(without, /下划线/);
  assert.equal(renderToStaticMarkup(h(lib.ReaderDisplayControls, { settings: { ...shared.READER_DEFAULTS }, onChange() {}, onReset() {} })), withUnderline, 'the reader still shows the underline row');
  inLanguage('en', () => {
    const english = text(controls({ underline: false }));
    assert.doesNotMatch(english, han);
    for (const word of ['Text size', 'Line width', 'Typeface', 'Background', 'Sans', 'Serif', 'Paper', 'Reset']) assert.match(english, new RegExp(word, 'i'), word);
    assert.doesNotMatch(english, /underline/i);
    assert.match(renderToStaticMarkup(h(lib.ReadingSettingsButton, {})), /aria-label="Display settings"/);
  });
});

test('a reading block is a class, a face, a tone and variables on the long-form container, and nothing else', () => {
  const html = renderToStaticMarkup(h(lib.ReadingBlock, { className: 'explanation', as: 'section' }, h('p', null, 'text'), h('button', null, 'ok')));
  assert.match(html, /^<section class="study-reading explanation" data-face="sans" data-tone="auto" style="[^"]*--reader-size:16px/);
  assert.match(html, /<p>text<\/p><button>ok<\/button>/);
  assert.match(renderToStaticMarkup(h(lib.ReadingBlock, { prose: true })), /class="study-reading study-reading--prose study-reading--measure"/, 'an article is held to the chosen text width');
  assert.match(renderToStaticMarkup(h(lib.ReadingBlock, { measure: true, className: 'explanation' })), /class="study-reading study-reading--measure explanation"/);
  assert.doesNotMatch(renderToStaticMarkup(h(lib.ReadingBlock, {})), /study-reading--measure/, 'a block laid out in columns keeps its own width');
  assert.match(renderToStaticMarkup(h(lib.ReadingBlock, { as: 'article', dangerouslySetInnerHTML: { __html: '<p>x</p>' } })), /^<article class="study-reading"[^>]*><p>x<\/p><\/article>$/);
});

test('the shared stylesheet scopes everything to .study-reading, never touches controls, and keeps 15px as the floor', async () => {
  const css = await readFile(new URL('../ui/reading-settings/reading.css', import.meta.url), 'utf8');
  assert.match(css, /\.study-reading/);
  assert.doesNotMatch(css, /(^|[,{}\s])(button|input|textarea|select)\s*[,{]/m, 'no bare control selectors');
  assert.doesNotMatch(css, /font-size:\s*(?:1[0-4]|[0-9])px/, 'no size under 15px is ever written');
  for (const rule of css.match(/\.study-reading[^{}]*\{/g) || []) assert.doesNotMatch(rule, /\b(?:button|input|select|textarea)\b/, rule);
});
