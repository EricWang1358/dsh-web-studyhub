import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

/* #196 (button names its deck and is off while a fill runs), #200/#203 and #201 draw from the draft page and the home, rendered here. */
const require = createRequire(import.meta.url);
const compiled = await build({ stdin: { contents: `export { default as Draft } from './ui/Draft.jsx'; export { default as JobCard } from './ui/study-map/JobCard.jsx'; export { setUiLanguage } from './ui/i18n.js';`, resolveDir: process.cwd() },
  bundle: true, write: false, platform: 'node', format: 'cjs', external: ['react', 'react-dom'], loader: { '.css': 'text' }, logLevel: 'silent' });
const module = { exports: {} };
new Function('require', 'module', 'exports', compiled.outputFiles[0].text)(require, module, module.exports);
const m = module.exports;
const noop = () => {};
const han = /[㐀-鿿]/;
const card = id => ({ id, kind: 'flashcard', topic: 't', prompt: `p${id}`, answer: 'a', hint: 'h', explanation: 'e', misconception: 'x' });
const draft = (extra = {}) => ({ id: 'd1', title: '第1步 架构思维', draftVersion: 3, cards: [card('c1'), card('c2')],
  editorial: { requested: 2, generated: 2, completedParts: 1, parts: 1, failures: [], generation: { sourceIds: ['s1', 's2', 's3'], kind: 'quiz' },
    coverage: { cited: 1, selected: 3, sources: [{ id: 's1', title: 'S1', planned: 2, accepted: 2 }, { id: 's2', title: 'S2', planned: 0, accepted: 0 }, { id: 's3', title: 'S3', planned: 0, accepted: 0 }],
      uncited: [{ id: 's2', title: 'S2' }, { id: 's3', title: 'S3' }] } }, ...extra });
const page = (value, data = {}, props = {}, language = 'zh') => {
  m.setUiLanguage(language);
  try {
    return renderToStaticMarkup(React.createElement(m.Draft, { data: { sources: ['s1', 's2', 's3'].map(id => ({ id, title: id.toUpperCase() })), decks: [], drafts: [value], jobs: [], modelReady: true, runs: [], ...data },
      busy: false, act: noop, call: noop, draft: value, draftLoaded: JSON.stringify(value), setDraft: noop, draftText: '', setDraftText: noop, jsonMode: false, setJsonMode: noop,
      openDraft: noop, onOpenPublished: noop, onStartPublished: noop, clearRecovery: noop, setPage: noop, setNotice: noop, setError: noop, setModal: noop,
      setSelectedSources: noop, setGenSource: noop, blankCard: noop, patchCard: noop, parseDraft: JSON.parse, continueDraft: noop, addFromSources: noop, ...props }));
  } finally { m.setUiLanguage('zh'); }
};
const text = html => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
/** The opening tag of the button whose label starts with `label`. */
const buttonTag = (html, label) => new RegExp('<button([^>]*)>(?:<[^>]+>)*' + label).exec(html)?.[0];

test('the add button names the deck it adds to, the sources and the count, and a new deck is a separate choice (#196)', () => {
  const out = page(draft());
  assert.match(text(out), /为「第1步 架构思维」补题：用 2 份未覆盖资料，追加约 4 题/);
  assert.match(text(out), /给「第1步 架构思维」补 4 题 →/);
  assert.match(text(out), /用这些资料新建题组/);
  assert.match(out, /data-add-from-sources/);
  assert.ok(buttonTag(out, '给「第1步'), 'the add button is there');
  assert.doesNotMatch(buttonTag(out, '给「第1步'), /disabled/, 'idle: the button works');
  assert.match(out, /<input[^>]*type="number"[^>]*value="4"/);
  const english = text(page(draft(), {}, {}, 'en'));
  assert.doesNotMatch(english.replaceAll('第1步 架构思维', 'TITLE'), han);
  assert.match(english, /Adding to “第1步 架构思维”: 4 more questions from 2 uncovered sources/);
  assert.match(english, /Create a new deck from these sources/);
});

test('the add button is off, and says 补题中, while a fill or generation runs on that deck (#196)', () => {
  const running = { id: 'j1', status: 'running', draftId: 'd1', continued: true, savedCount: 2, requestedTotal: 4 };
  const out = page(draft(), { jobs: [running] });
  assert.match(text(out), /补题中 · 草稿 2\/4 题/);
  assert.match(buttonTag(out, '补题中'), /disabled/);
  assert.doesNotMatch(text(out), /给「第1步 架构思维」补/, 'the add label gives way to the running label');
  // A fill that publishes straight into the deck this draft merges into owns it too.
  const merging = page(draft({ mergeTargetId: 'deck-9' }), { jobs: [{ id: 'j2', status: 'running', mergeTargetId: 'deck-9', type: 'supplement', continued: false }] });
  assert.match(buttonTag(merging, '补题中'), /disabled/);
  const finished = page(draft(), { jobs: [{ ...running, status: 'complete' }] });
  assert.doesNotMatch(buttonTag(finished, '给「第1步'), /disabled/, 'once the fill is done the deck can be added to again');
});

test('generation details say how many questions the repair kept and how many were dropped (#202)', () => {
  const repaired = draft(); Object.assign(repaired.editorial, { repairedInRun: 3, repairTried: 4, omitted: [{ part: 1, prompt: 'q', reasons: ['x'] }, { part: 1, prompt: 'r', reasons: ['y'] }] });
  assert.match(text(page(repaired)), /修复后保留 3 题 · 丢弃 2 题（其中 1 题修复后仍未通过，原因见「没进入草稿的题」）/);
  assert.doesNotMatch(text(page(draft())), /修复后保留/, 'no repair, no line');
  const english = text(page(repaired, {}, {}, 'en'));
  assert.match(english, /3 kept after repair · 2 dropped \(1 of them still failed after repair/);
  assert.doesNotMatch(english.replaceAll('第1步 架构思维', 'TITLE'), han);
});

test('generation details list the review suggestions apart from the questions that had to be fixed (#216)', () => {
  const suggested = draft(); suggested.editorial.suggestions = [{ cardId: 'c1', text: 'q1：建议把选项压缩为一句话。', kind: 'suggestion' }];
  const out = text(page(suggested));
  assert.match(out, /审阅建议（已记录，不影响通过）· 1/);
  assert.match(out, /建议把选项压缩为一句话/);
  assert.match(text(page(suggested, {}, {}, 'en')), /Review suggestions \(recorded, they do not reject a question\) · 1/);
  assert.doesNotMatch(text(page(draft())), /审阅建议/);
});

test('a failed run caused by the review lists its questions one by one and does not blame the sources (#217)', () => {
  m.setUiLanguage('zh');
  const stage = 'Part 1: Quality gate failed: q1: answerLeak failed or was not checked; q1: optionQuality failed or was not checked; q2: sourceSupport failed or was not checked';
  const out = renderToStaticMarkup(React.createElement(m.JobCard, { job: { id: 'f', status: 'failed', type: 'generate', stage, parts: 1, steps: [] }, jobs: [], drafts: [], busy: false, dismissJob: noop }));
  m.setUiLanguage('zh');
  assert.match(text(out), /出的题都没通过质量审阅/);
  assert.doesNotMatch(text(out), /资料可能太短/);
  assert.match(text(out), /q1 · 提示或题干泄露了答案；选项质量不合格.*（必须修）/);
  assert.match(text(out), /q2 · 资料不足以支撑答案，或引用对不上原文（必须修）/);
  assert.match(out, /job-failure-rows/);
});

test('a running fill says which round it is on and how many questions are still missing (#197)', () => {
  m.setUiLanguage('zh');
  const job = { id: 'r', status: 'running', type: 'generate', stage: 'Parallel generation · up to 3 batches', parts: 2, requestedTotal: 15, savedCount: 7, continued: true, draftId: 'd1',
    steps: [{ id: 's', stage: 'Part 1/2 · Writing replacement questions from reserve targets', part: 1, status: 'running' }], fills: { 1: { round: 2, missing: 3 }, 2: { round: 1, missing: 1 } } };
  const out = text(renderToStaticMarkup(React.createElement(m.JobCard, { job, jobs: [job], drafts: [], busy: false, cancelJob: noop, dismissJob: noop })));
  assert.match(out, /第 2 轮补题 · 还差 4 题/);
  m.setUiLanguage('en');
  const english = text(renderToStaticMarkup(React.createElement(m.JobCard, { job, jobs: [job], drafts: [], busy: false, cancelJob: noop, dismissJob: noop })));
  m.setUiLanguage('zh');
  assert.match(english, /fill round 2 · 4 still missing/);
  const short = draft(); Object.assign(short.editorial, { requested: 6, fillRoundsUsed: 2 });
  assert.match(text(page(short)), /已自动补题 2 轮，仍差 4 题；原因如下。/);
  assert.doesNotMatch(text(page(draft())), /已自动补题/);
});

test('generation details show queue vs model-call time per stage, and a rate limit that slowed the run (#198)', () => {
  m.setUiLanguage('zh');
  const at = (seconds) => new Date(Date.UTC(2026, 9, 5, 12, 0, seconds)).toISOString();
  const usage = (tokens) => ({ uncachedInputTokens: tokens, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, calls: 1 });
  const job = { id: 't', status: 'complete', type: 'generate', stage: 'Draft ready', parts: 1, savedCount: 5, requestedTotal: 5, concurrency: 4,
    throttle: { events: 2, concurrency: 2, configured: 4, lowest: 2 },
    steps: [{ id: 'a', stage: 'Part 1/1 · Writing and self-checking questions', status: 'complete', startedAt: at(10), finishedAt: at(22), queuedMs: 4000, tokenUsage: usage(3000) },
      { id: 'b', stage: 'Part 1/1 · Reviewing ambiguity and source support', status: 'complete', startedAt: at(30), finishedAt: at(40), queuedMs: 0, tokenUsage: usage(2000) }] };
  const out = text(renderToStaticMarkup(React.createElement(m.JobCard, { job, jobs: [], drafts: [], busy: false, dismissJob: noop })));
  assert.match(out, /出题与自查 3,?000 tok 调用 12 秒 · 排队 4 秒/);
  assert.match(out, /独立审阅 2,?000 tok 调用 10 秒/);
  assert.match(out, /排队 4 秒/, 'the step itself shows its wait');
  assert.match(out, /模型服务限流了 2 次，同时调用数已自动降到 2（设置的是 4）/);
  m.setUiLanguage('en');
  const english = text(renderToStaticMarkup(React.createElement(m.JobCard, { job, jobs: [], drafts: [], busy: false, dismissJob: noop })));
  m.setUiLanguage('zh');
  assert.match(english, /Model call 12 s · Queued 4 s/);
  assert.match(english, /rate-limited 2 time\(s\); simultaneous calls were lowered automatically to 2 \(set: 4\)/);
});

test('the add button is not offered for a case paper, an edit of a published deck or an unsaved edit', () => {
  const none = (value) => assert.doesNotMatch(page(value), /data-add-from-sources/);
  none(draft({ editingDeckId: 'deck-1' }));
  const kind = draft(); kind.editorial.generation.kind = 'case'; none(kind);
  const repair = draft(); repair.editorial.repairOfDeckId = 'deck-1'; none(repair);
});
