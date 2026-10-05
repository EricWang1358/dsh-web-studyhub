import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { draftView, seedView } from './helpers/coverage-view.mjs';

// UI wave 2, WP-M: the draft page's notice stack is Banners, its sentences are whole translations, and job states come from lib/job-status (#87 #107 #128).
const read = file => readFileSync(file, 'utf8');
const lacks = (file, ...patterns) => { const text = read(file); for (const pattern of patterns) assert.doesNotMatch(text, pattern, `${file} still has ${pattern}`); };
const has = (file, ...patterns) => { const text = read(file); for (const pattern of patterns) assert.match(text, pattern, `${file} lacks ${pattern}`); };
const require = createRequire(import.meta.url);
const compiled = await build({ stdin: { contents: `export { default as Draft } from './ui/Draft.jsx'; export { seedCoverage, forgetCoverage } from './ui/coverage/use-coverage.js'; export { setUiLanguage } from './ui/i18n.js';`, resolveDir: process.cwd() },
  bundle: true, write: false, platform: 'node', format: 'cjs', external: ['react', 'react-dom'], loader: { '.css': 'text' }, logLevel: 'silent' });
const module = { exports: {} };
new Function('require', 'module', 'exports', compiled.outputFiles[0].text)(require, module, module.exports);
const m = module.exports;
const noop = () => {};
const han = /[㐀-鿿]/;
const card = id => ({ id, kind: 'flashcard', topic: 't', prompt: `p${id}`, answer: 'a', hint: 'h', explanation: 'e', misconception: 'x' });
const draft = (extra = {}) => ({ id: 'd1', title: 'T', draftVersion: 3, cards: [card('c1'), card('c2')],
  editorial: { requested: 10, generated: 2, completedParts: 1, parts: 3, failures: [], generation: { sourceIds: ['s1'], kind: 'quiz' },
    coverage: { cited: 1, selected: 2, sources: [{ id: 's1', title: 'S1', planned: 2, accepted: 1 }, { id: 's2', title: 'S2', planned: 1, accepted: 0 }], uncited: [{ id: 's2', title: 'S2' }] } }, ...extra });
const page = (value, data = {}, props = {}, language = 'zh') => {
  m.setUiLanguage(language);
  try {
    return renderToStaticMarkup(React.createElement(m.Draft, { data: { sources: [{ id: 's1', title: 'S1' }, { id: 's2', title: 'S2' }], decks: [], drafts: [value], jobs: [], modelReady: true, runs: [], ...data },
      busy: false, act: noop, call: noop, draft: value, draftLoaded: JSON.stringify(value), setDraft: noop, draftText: '', setDraftText: noop, jsonMode: false, setJsonMode: noop,
      openDraft: noop, onOpenPublished: noop, onStartPublished: noop, clearRecovery: noop, setPage: noop, setNotice: noop, setError: noop, setModal: noop,
      blankCard: noop, patchCard: noop, parseDraft: JSON.parse, topUpDraft: noop, ...props }));
  } finally { m.setUiLanguage('zh'); }
};
const text = html => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

test('the notices of a draft are Banners, not hand-made quality boxes (#87)', () => {
  m.forgetCoverage(); seedView(m, draftView({ draftId: 'd1', draftVersion: 3, covered: ['r1.p1'] }));
  const out = page(draft());
  assert.match(out, /sh-banner--warning/);
  assert.match(out, /有题没能进入草稿/, 'the reasons keep their banner; a count of questions is not its title');
  assert.match(out, /为没覆盖的部分补题/, 'the one top-up lives in the coverage summary');
  assert.doesNotMatch(out, /比计划少|继续补齐/);
  assert.doesNotMatch(out, /quality-note/);
  const stale = page(draft(), { drafts: [draft({ draftVersion: 4 })] }, { draftLoaded: '' });
  assert.match(stale, /sh-banner--warning[^>]*>(?:(?!<\/div><\/div>).)*草稿已在后台更新/s);
  assert.match(stale, /sh-btn[^>]*>载入最新草稿</);
  const none = page(draft({ editorial: undefined }));
  assert.match(none, /sh-banner--info[^>]*>(?:(?!<\/div><\/div>).)*这份草稿尚未经过模型审阅/s);
  lacks('ui/Draft.jsx', /quality-note warning/, /className="quality-note/, /className="warning"/);
});

test('draft sentences are whole translations that English can reorder (#107)', () => {
  m.forgetCoverage();
  const out = text(page(draft()));
  assert.match(out, /本次生成通过检查 2 \/ 10 题；当前草稿 2 题。/);
  assert.match(out, /本次生成已中断：已完成 1 \/ 3 批。当前草稿只包含已保存的题目；其余批次尚未完成检查。/);
  assert.match(out, /逐份资料出题记录 · 已引用 1 \/ 2 份/);
  assert.match(out, /1 份资料本次没有合格题 · 查看清单/);
  assert.match(out, /当前草稿 2 题/);
  const english = text(page(draft(), {}, {}, 'en'));
  assert.doesNotMatch(english, han);
  assert.match(english, /2 of 10 questions passed the checks/);
  for (const file of ['ui/Draft.jsx', 'ui/Generate.jsx', 'ui/WorkflowLesson.jsx', 'ui/WorkflowScope.jsx']) {
    lacks(file, /\{ui\((["'`])[^"'`]*\1\)\}\{[^{}]*\}\{ui\(/, /ui\((["'])(?: [^"']*|[^"']* )\1\)/);
  }
});

test('job states come from lib/job-status, not private lists (#128)', () => {
  lacks('ui/Draft.jsx', /\["queued", "running", "cancelling"\]/, /\["queued", "running"\]/);
  has('ui/Draft.jsx', /isActiveJob/, /isCancellable/);
  lacks('ui/generation-status.js', /new Set\(\['queued'/);
  lacks('ui/draft-shortfall.js', /new Set\(\['queued'/);
  has('ui/draft-shortfall.js', /isActiveJob/);
  has('ui/generation-status.js', /isActiveJob/);
});
