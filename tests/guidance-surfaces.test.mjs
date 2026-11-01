/* 3.7 guidance, step 0: each registered surface's OWN writer marks it seen, the registry sees it and clears it, and the surface's OWN reader then says
   it can appear again. The proactive surfaces listen to 设置 › 引导 (master switch, own switch) and are unchanged with nothing stored. The first-run
   line's 以后再说 holds for the visit; only an explicit clear in this tab undoes that. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { nativeSelects } from './helpers/native-selects.mjs';

const require = createRequire(import.meta.url);
const built = await build({ stdin: { contents: `
  export { useReaderHint, forgetClosedHints, closeHint, hintClosed } from './ui/document-preview/reader/hints.js';
  export { default as TopicGroupReminder, topicGroupLaterKey } from './ui/study-map/TopicGroupReminder.jsx';
  export { default as BookMoves, rememberMovesSeen, movesSeenAt } from './ui/book/BookMoves.jsx';
  export { OriginalNotice } from './ui/document-preview/OriginalFile.jsx';
  export { collapseNotice, noticeCollapsed } from './ui/document-preview/original-file.js';
  export { writeSetupLater, readSetupLater, markSetupDone, setupDoneSeen } from './ui/SetupChecklist.jsx';
  export { SETUP_STEP_IDS } from './lib/course-setup.js';
  export { dismissWelcome, welcomeDismissed, hideWelcomeFor, welcomeLater } from './ui/tour/progress.js';
  export { setArchifyPutOff, archifyPutOff } from './ui/archify.js';
  export { rememberJevGuide, jevGuideSeen } from './ui/jev-flow.js';
  export { default as Skeleton } from './ui/Skeleton.jsx';
  export { GUIDANCE_KEY } from './ui/guidance/budget.js';
  export { clearItem, guidanceItem, itemSeen } from './ui/guidance/registry.js';
  export { writeText } from './ui/storage.js';
  export { setUiLanguage } from './ui/i18n.js';`, resolveDir: process.cwd() }, bundle: true, write: false, platform: 'node',
  format: 'cjs', external: ['react', 'react-dom'], plugins: [nativeSelects], loader: { '.css': 'text' }, logLevel: 'silent' });
const module = { exports: {} };
new Function('require', 'module', 'exports', built.outputFiles[0].text)(require, module, module.exports);
const lib = module.exports, h = React.createElement;

function memoryStorage(initial = {}) {
  const map = new Map(Object.entries(initial));
  return { map, get length() { return map.size; }, key: i => [...map.keys()][i] ?? null, getItem: k => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => { map.set(k, String(v)); }, removeItem: k => { map.delete(k); } };
}
/** Run `body` with a browser localStorage (`storage`, or a fresh one holding `initial`). */
function withStorage(initial, body) {
  const before = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  const storage = initial && typeof initial.getItem === 'function' ? initial : memoryStorage(initial || {});
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: storage });
  try { return body(storage); } finally { if (before) Object.defineProperty(globalThis, 'localStorage', before); else delete globalThis.localStorage; }
}
const item = id => lib.guidanceItem(id);
/** TopicGroupReminder reads its 稍后 through a hook, so it is rendered (an empty render = put off or switched off). */
const reminder = () => renderToStaticMarkup(h(lib.TopicGroupReminder, { grouping: { ungrouped: 5, groups: 2, topics: 30 }, root: '/lib' }));
const off = { [`study-guidance:v1`]: JSON.stringify({ off: true }) };
const muted = id => ({ 'study-guidance:v1': JSON.stringify({ muted: [id] }) });

test('each surface writes with its own writer; the registry sees it; after clearItem the surface itself says it can appear again', () => {
  lib.forgetClosedHints();
  const step = lib.SETUP_STEP_IDS[0];
  const cases = [
    ['first-run.later', () => lib.dismissWelcome('/lib'), () => lib.welcomeDismissed('/lib')],
    ['setup.later', () => lib.writeSetupLater('/lib', 'Cloud', [step]), () => lib.readSetupLater('/lib', 'Cloud').length > 0],
    ['setup.done', () => lib.markSetupDone('/lib', 'Cloud'), () => lib.setupDoneSeen('/lib', 'Cloud')],
    ['reader.pdf-page', () => lib.closeHint('pdf-page'), () => lib.hintClosed('pdf-page')],
    ['reader.page-presets', () => lib.closeHint('page-presets'), () => lib.hintClosed('page-presets')],
    ['reader.original-notice', () => lib.collapseNotice('doc-1'), () => lib.noticeCollapsed('doc-1')],
    ['library.topic-groups', () => lib.writeText(lib.topicGroupLaterKey('/lib'), '2:5'), () => reminder() === ''],
    ['skeleton.archify', () => lib.setArchifyPutOff('/lib', true), () => lib.archifyPutOff('/lib')],
    ['book.moves', () => lib.rememberMovesSeen('Cloud', 'rebuild-1'), () => lib.movesSeenAt('Cloud') === 'rebuild-1'],
    ['jev.guide', () => lib.rememberJevGuide(), () => lib.jevGuideSeen()],
  ];
  for (const [id, write, seenBySurface] of cases) withStorage({}, () => {
    assert.equal(seenBySurface(), false, `${id}: not seen at first`);
    write();
    assert.equal(seenBySurface(), true, `${id}: the surface remembers`);
    assert.equal(lib.itemSeen(item(id)), true, `${id}: the registry sees the surface's own key`);
    assert.equal(lib.clearItem(item(id)), true);
    assert.equal(lib.itemSeen(item(id)), false);
    assert.equal(seenBySurface(), false, `${id}: the surface itself can show it again`);
  });
});

const hintShown = id => renderToStaticMarkup(h(function Probe() { const [shown] = lib.useReaderHint(id); return h('i', null, shown ? 'shown' : 'hidden'); }));

test('the reader hints: shown as before; the master switch or their own switch keeps them away', () => {
  lib.forgetClosedHints();
  withStorage({}, () => assert.match(hintShown('pdf-page'), /shown/, 'nothing stored: as before'));
  withStorage(off, () => { assert.match(hintShown('pdf-page'), /hidden/); assert.match(hintShown('page-presets'), /hidden/); });
  withStorage(muted('reader.pdf-page'), () => {
    assert.match(hintShown('pdf-page'), /hidden/, 'its own switch');
    assert.match(hintShown('page-presets'), /shown/, 'the other one is untouched');
  });
});

test('a closed reader hint is held for the visit: another tab clearing the storage does not bring it back; 再显示一次 in this tab does', () => {
  lib.forgetClosedHints();
  withStorage({}, storage => {
    assert.equal(lib.closeHint('pdf-page'), true);
    storage.removeItem('study-reader-hints'); // another tab's reset, or cleared site data
    assert.match(hintShown('pdf-page'), /hidden/, 'held for the visit');
    lib.closeHint('pdf-page');
    assert.equal(lib.clearItem(item('reader.pdf-page')), true);
    assert.match(hintShown('pdf-page'), /shown/, 'this tab cleared it: back without a reload');
  });
  assert.equal(lib.closeHint('pdf-page', null), false, 'no storage: cannot be stored');
  assert.equal(lib.hintClosed('pdf-page', null), true, 'this visit still remembers the closing');
  lib.forgetClosedHints();
});

test('the topic-group reminder: shown as before; hidden by the master switch or its own switch; its 稍后 memory unchanged', () => {
  lib.setUiLanguage('zh');
  withStorage({}, () => assert.match(reminder(), /有 5 个主题还没归入主题组/));
  withStorage(off, () => assert.equal(reminder(), ''));
  withStorage(muted('library.topic-groups'), () => assert.equal(reminder(), ''));
  withStorage({ 'study-topic-group-later:/lib': '2:5' }, () => assert.equal(reminder(), '', '稍后 still holds until the grouping changes'));
});

test('「笔记换了位置」: shown as before; the master switch or its own switch folds it to the one line that leads to the list', () => {
  lib.setUiLanguage('zh');
  const moves = { at: 'rebuild-1', list: [{ from: 'A', to: 'B' }], total: 1 };
  const draw = () => renderToStaticMarkup(h(lib.BookMoves, { course: 'Cloud', moves }));
  withStorage({}, () => assert.match(draw(), /data-book-moves/));
  withStorage(off, () => { assert.doesNotMatch(draw(), /data-book-moves=""/); assert.match(draw(), /data-book-moves-line/); });
  withStorage(muted('book.moves'), () => { assert.doesNotMatch(draw(), /data-book-moves=""/); assert.match(draw(), /data-book-moves-line/); });
});

test('「补全原文件」 note: the full notice as before; switched off it is the quiet line that keeps 补全原文件…', () => {
  lib.setUiLanguage('zh');
  const document = { documentId: 'doc-9', format: 'pdf', originalAvailable: false, original: { mode: null, status: 'none' } };
  const draw = () => renderToStaticMarkup(h(lib.OriginalNotice, { document, onAction() {} }));
  withStorage({}, () => { const html = draw(); assert.doesNotMatch(html, /data-collapsed="true"/); assert.match(html, /补全原文件/); });
  for (const stored of [off, muted('reader.original-notice')]) withStorage(stored, () => {
    const html = draw();
    assert.match(html, /data-collapsed="true"/, 'the quiet line');
    assert.match(html, /补全原文件…/, 'the action stays');
  });
});

test('the Archify card on the knowledge outline: shown as before; gone when the master switch or its own switch is off', () => {
  lib.setUiLanguage('zh');
  const data = { root: '/lib', decks: [], focus: { course: 'A', courses: [{ name: 'A' }] }, skeletons: [], oralExams: [] };
  const draw = () => renderToStaticMarkup(h(lib.Skeleton, { data, library: data, call() {} }));
  withStorage({}, () => assert.match(draw(), /推荐开源插件 Archify/));
  withStorage(off, () => assert.doesNotMatch(draw(), /推荐开源插件 Archify/));
  withStorage(muted('skeleton.archify'), () => assert.doesNotMatch(draw(), /推荐开源插件 Archify/));
});

test('以后再说: stored, it follows the storage; held for the visit, cleared site data does not bring the line back; 再显示一次 in this tab does', () => {
  withStorage({}, storage => {
    const memory = lib.hideWelcomeFor('/lib');
    assert.equal(storage.getItem('study-welcome:/lib'), 'dismissed', 'stored');
    assert.equal(lib.welcomeLater('/lib', memory), true);
    assert.equal(lib.welcomeLater('/lib', null), true, 'a new visit reads it from storage');
    storage.removeItem('study-welcome:/lib'); // another tab's reset, or cleared site data
    assert.equal(lib.welcomeLater('/lib', memory), true, 'held for the visit');
    assert.equal(lib.welcomeLater('/lib', null), false, 'a new visit shows the line again');
    lib.clearItem(item('first-run.later'));
    assert.equal(lib.welcomeLater('/lib', memory), false, 'this tab cleared it: the line is back without a reload');
    assert.equal(lib.welcomeLater('/other', memory), false, 'another library is not put away');
  });
  const refusing = memoryStorage(); refusing.setItem = () => { throw new Error('blocked'); };
  withStorage(refusing, storage => {
    const memory = lib.hideWelcomeFor('/lib');
    assert.equal(storage.getItem('study-welcome:/lib'), null, 'the write was refused');
    assert.equal(lib.welcomeLater('/lib', memory), true, 'held in memory for the visit');
  });
});

test('the app shell decides 以后再说 only through those two helpers (ui/app/use-tour.js)', async () => {
  const { readFile } = await import('node:fs/promises');
  const source = await readFile(new URL('../ui/app/use-tour.js', import.meta.url), 'utf8');
  assert.match(source, /const lineLater = welcomeLater\(data\?\.root, hiddenWelcome\);/);
  assert.match(source, /setHiddenWelcome\(hideWelcomeFor\(data\.root\)\)/);
  assert.doesNotMatch(source, /welcomeDismissed|dismissWelcome/, 'no second way around the visit memory');
});
