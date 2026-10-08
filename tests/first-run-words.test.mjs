/* The first run and its words: one name for the first step (添加资料), a welcome page that tells the truth about the tour and the formats it takes, the
   way from the short tour to the full one, and a checklist whose buttons say what they do. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

const han = /[㐀-鿿]/;
const require = createRequire(import.meta.url);
const compiled = await build({
  stdin: { contents: `export * from './ui/i18n.js';
    export { default as Welcome } from './ui/Welcome.jsx';
    export { TourPopover } from './ui/tour/Tour.jsx';
    export { OnboardingPanel } from './ui/tour/SampleControls.jsx';
    export { readTourProgress, writeTourProgress } from './ui/tour/progress.js';
    export { TOUR_STEPS, CORE_TOUR_LENGTH } from './ui/tour/steps.js';
    export { default as SetupChecklist, stepAction } from './ui/SetupChecklist.jsx';`, resolveDir: process.cwd() },
  bundle: true, write: false, platform: 'node', format: 'cjs', external: ['react', 'react-dom'], loader: { '.css': 'text' }, logLevel: 'silent',
});
const loaded = { exports: {} };
new Function('require', 'module', 'exports', compiled.outputFiles[0].text)(require, loaded, loaded.exports);
const m = loaded.exports;
const h = React.createElement;
const noop = () => {};
const text = (markup) => markup.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
const welcome = (props = {}) => renderToStaticMarkup(h(m.Welcome, { model: { ready: true }, sample: { loaded: false }, onStartSample: noop, onImport: noop, onSetupModel: noop, onLater: noop,
  onStartTour: noop, onRemoveSample: noop, ...props }));

test('the first step has one name on the welcome page, the tour and the checklist: 添加资料', () => {
  m.setUiLanguage('zh');
  for (const markup of [welcome(), welcome({ sample: { loaded: true, course: '示例课程 · 设计模式' } })]) {
    assert.match(markup, />添加资料</);
    assert.doesNotMatch(markup, /导入我的第一份资料|添加第一份资料/);
  }
  const last = renderToStaticMarkup(h(m.TourPopover, { step: m.TOUR_STEPS.at(-1), index: 7, total: 8, onNext: noop, onBack: noop, onClose: noop, onSkip: noop, onImport: noop }));
  assert.match(last, />添加资料</);
  assert.doesNotMatch(last, /导入我的第一份资料/);
  assert.match(m.stepAction({ id: 'materials', action: 'import' }, { course: '' }, { import: noop }).label, /^添加资料$/);
  assert.equal(m.stepAction({ id: 'materials', action: 'import' }, { course: '' }, {}).disabled, true, 'no handler, no dead button');
});

test('the welcome page says 网页文件 (.html), the formats the hub takes, and a tour time that is true', () => {
  m.setUiLanguage('zh');
  const words = text(welcome());
  assert.match(words, /网页文件（\.html）/, 'only saved .html files are taken, not an address');
  assert.doesNotMatch(words.replace(/网页文件/g, ''), /网页/, 'no bare 网页');
  assert.match(words, /Word/);
  assert.match(words, /PowerPoint/);
  assert.doesNotMatch(words, /三分钟|两三分钟/);
  assert.match(words, new RegExp(`${m.CORE_TOUR_LENGTH} 步`), 'the step count is the default tour\'s own');
  const loaded = text(welcome({ sample: { loaded: true, course: '示例课程 · 设计模式' } }));
  assert.match(loaded, new RegExp(`${m.CORE_TOUR_LENGTH} 步，一两分钟`));
  assert.doesNotMatch(loaded, /三分钟|两三分钟/);
  assert.match(loaded, /完整导览/, 'the way to the rest is said where the time is');
  m.setUiLanguage('en');
  try {
    for (const markup of [welcome(), welcome({ sample: { loaded: true, course: 'Sample course' } })]) assert.doesNotMatch(text(markup), han);
    assert.match(text(welcome()), /Add source/);
  } finally { m.setUiLanguage('zh'); }
});

test('the last step of the short tour offers the full tour; the full tour (and the paused card) do not', () => {
  m.setUiLanguage('zh');
  const props = { step: m.TOUR_STEPS.at(-1), index: 7, total: 8, onNext: noop, onBack: noop, onClose: noop, onSkip: noop, onImport: noop, onRemoveSample: noop };
  const short = renderToStaticMarkup(h(m.TourPopover, { ...props, onFullTour: noop }));
  assert.match(short, /看完整导览/);
  assert.equal((short.match(/sh-btn--primary/g) || []).length, 1, 'still one primary action: 添加资料');
  assert.doesNotMatch(renderToStaticMarkup(h(m.TourPopover, props)), /看完整导览/);
  const middle = renderToStaticMarkup(h(m.TourPopover, { ...props, step: m.TOUR_STEPS[1], index: 1, onFullTour: noop }));
  assert.doesNotMatch(middle, /看完整导览/, 'only the last step offers it');
  m.setUiLanguage('en');
  try { assert.match(renderToStaticMarkup(h(m.TourPopover, { ...props, onFullTour: noop })), /See the full tour/); } finally { m.setUiLanguage('zh'); }
  // Settings › 学习画像与导览 can start it too.
  const panel = renderToStaticMarkup(h(m.OnboardingPanel, { sample: { loaded: false }, progress: null, onTour: noop, onFullTour: noop }));
  assert.match(panel, /看完整导览/);
  assert.doesNotMatch(renderToStaticMarkup(h(m.OnboardingPanel, { sample: { loaded: false }, progress: null, onTour: noop })), /看完整导览/);
});

test('a paused full tour is remembered as the full tour; the short tour leaves the old shape of the record', () => {
  const store = new Map();
  globalThis.localStorage = { getItem: (key) => store.get(key) ?? null, setItem: (key, value) => store.set(key, String(value)), removeItem: (key) => store.delete(key) };
  try {
    m.writeTourProgress('/a', { stepId: 'exam', full: true });
    assert.deepEqual(m.readTourProgress('/a'), { stepId: 'exam', done: false, full: true });
    m.writeTourProgress('/b', { stepId: 'tasks', done: true, full: false });
    assert.deepEqual(m.readTourProgress('/b'), { stepId: 'tasks', done: true });
  } finally { delete globalThis.localStorage; }
});

test('the checklist button for the skeleton goes to the page, and says so (it generates nothing)', async () => {
  m.setUiLanguage('zh');
  assert.equal(m.stepAction({ id: 'skeleton', action: 'skeleton' }, { course: '' }, { skeleton: noop }).label, '去知识骨架页');
  const source = await readFile('ui/app/setup-handlers.js', 'utf8');
  assert.match(source, /skeleton: \(\) => nav\.navigate\('skeleton'\)/, 'the handler only navigates');
  const checklist = await readFile('ui/SetupChecklist.jsx', 'utf8');
  assert.doesNotMatch(checklist, /ui\("生成知识骨架"\)/);
  assert.doesNotMatch(checklist, /ui\("(导入资料|加入资料)"\)|先加入资料/);
  m.setUiLanguage('en');
  try { assert.match(m.stepAction({ id: 'skeleton', action: 'skeleton' }, { course: '' }, { skeleton: noop }).label, /^Open the knowledge outline page$/); } finally { m.setUiLanguage('zh'); }
});
