/* The first-run words that have to be seen on the page, not read in the source: the welcome gate's third step names the real button, the 待发布 line says what it opens,
   and 课程准备 / 今天先做什么 wait on the library home until the learner has published a deck of their own (a sample deck, a draft or a material never counts). */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

const require = createRequire(import.meta.url);
const compiled = await build({
  stdin: { contents: `export * from './ui/i18n.js';
    export { default as Welcome } from './ui/Welcome.jsx';
    export { PAGE_VIEWS } from './ui/app/page-views.jsx';
    export { AppContext } from './ui/app/app-context.js';
    export { HomeDrafts } from './ui/study-map/HomeActivity.jsx';`, resolveDir: process.cwd() },
  bundle: true, write: false, platform: 'node', format: 'cjs', external: ['react', 'react-dom'], loader: { '.css': 'text' }, logLevel: 'silent',
});
const loaded = { exports: {} };
new Function('require', 'module', 'exports', compiled.outputFiles[0].text)(require, loaded, loaded.exports);
const m = loaded.exports;
const h = React.createElement;
const noop = () => {};
const text = (markup) => markup.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

test('the welcome page without a model says the real button in its third step, in both languages', () => {
  for (const [lang, button] of [['zh', '回到这里，点「添加资料」'], ['en', 'Add source']]) {
    m.setUiLanguage(lang);
    const html = text(renderToStaticMarkup(h(m.Welcome, { model: { ready: false }, sample: { loaded: false }, onStartSample: noop, onImport: noop, onSetupModel: noop, onLater: noop, onStartTour: noop, onRemoveSample: noop })));
    assert.ok(html.includes(button), `${lang}: ${button}`);
    if (lang === 'zh') assert.doesNotMatch(html, /导入资料/);
  }
  m.setUiLanguage('zh');
});

test('the 待发布 line opens a draft with the name 检查草稿, and no button of it says 打开草稿 or 看过再发布', () => {
  m.setUiLanguage('zh');
  const html = renderToStaticMarkup(h(m.HomeDrafts, { drafts: [{ id: 'a', title: '索引', cards: [{ id: 1 }] }], data: { decks: [], sources: [], drafts: [], jobs: [] }, modelReady: true, openDraft: noop, topUpDraft: noop, defaultOpen: true }));
  assert.match(text(html), /待发布 1 检查草稿/);
  assert.doesNotMatch(html, /看过再发布|打开草稿/);
});

/* The library home with a context that only has what the page reads. */
const deck = (id, extra = {}) => ({ id, title: id, folder: 'C', course: 'C', topics: [], available: 3, count: 3, quizCount: 1, createdAt: '2026-09-01T00:00:00Z', ...extra });
function home(dataPatch = {}) {
  m.setUiLanguage('zh');
  const data = { root: '/tmp/lib', decks: [], progress: {}, sources: [], drafts: [], jobs: [], runs: [], today: { due: 0, weak: 0, new: 0, size: 0 }, coach: { ready: 0 }, features: { review: true },
    model: { ready: true }, focus: { mode: 'class', course: null, courses: [], fresh: [] }, ...dataPatch };
  const none = new Proxy({}, { get: (_target, key) => (key === 'then' ? undefined : noop) });
  const app = { data, core: { busy: false, notify: noop, act: noop, call: noop }, nav: { navigate: noop }, set: none, session: none, intents: none, drafts: none, notebooks: [],
    tour: { showWelcome: false, modelState: { ready: true } }, dailyPlan: { date: '2026-10-22', state: { date: '2026-10-22', budgetMinutes: 60, spentMinutes: 0, tasks: [], profile: {}, proposal: { id: 'p', method: 'local', items: [], emptyReason: 'nothing-due', warnings: [] } },
      busy: '', error: '', suggest: noop, accept: noop, saveProfile: noop, start: noop, complete: noop, refresh: noop },
    settingsEntry: none, learn: none, lib: {} };
  return renderToStaticMarkup(h(m.AppContext.Provider, { value: app }, h(m.PAGE_VIEWS.library)));
}

test('课程准备 and 今天先做什么 wait until the learner has published a deck of their own', () => {
  const course = { mode: 'class', course: 'Cloud Native', courseId: 'course-1', courses: [{ name: 'Cloud Native' }] };
  const note = { id: 'n1', title: 'Note', text: 'a note', courses: ['Cloud Native'] };
  const own = { focus: course, courses: [{ id: 'course-1', name: 'Cloud Native' }], skeletons: [], sources: [note], decks: [deck('d1', { course: 'Cloud Native', archived: false })],
    progress: { d1: { counts: { mastered: 0, familiar: 0, learning: 1, weak: 0, new: 2 }, total: 3, mastery: 20, due: 0, status: 'active', topics: [] } } };
  const mine = home(own);
  assert.match(mine, /class="daily-plan/, 'with a deck of their own the day plan is on the home');
  assert.match(mine, /data-setup-checklist/, 'and so is the checklist');
  const waiting = { ...own, decks: [], progress: {}, drafts: [{ id: 'dr', title: '草稿', cards: [{ id: 1 }] }] };
  for (const [what, patch] of [['a material and a draft, nothing published', waiting], ['nothing at all', { ...waiting, sources: [], drafts: [] }],
    ['only the sample deck', { ...waiting, decks: [deck('sample-deck-patterns', { sample: true })], sample: { loaded: true, deckId: 'sample-deck-patterns' } }]]) {
    const html = home(patch);
    assert.doesNotMatch(html, /class="daily-plan/, `${what}: no 今天先做什么`);
    assert.doesNotMatch(html, /data-setup-checklist/, `${what}: no 课程准备`);
  }
});
