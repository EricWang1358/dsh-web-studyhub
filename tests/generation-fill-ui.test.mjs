import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

/* #196 (button names its deck and is off while a fill runs), #200/#203 and #201 draw from the draft page and the home, rendered here. */
const require = createRequire(import.meta.url);
const compiled = await build({ stdin: { contents: `export { default as Draft } from './ui/Draft.jsx'; export { default as JobCard } from './ui/study-map/JobCard.jsx'; export { default as HomeActivity } from './ui/study-map/HomeActivity.jsx'; export { foldJobsByDraft } from './ui/job-visibility.js'; export { DraftTopUp } from './ui/DraftShortfall.jsx'; export { setUiLanguage } from './ui/i18n.js';`, resolveDir: process.cwd() },
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

/* #200 / #203: one card per deck. */
const home = (jobs, drafts, extra = {}) => renderToStaticMarkup(React.createElement(m.HomeActivity, { jobs, drafts, busy: false, openDraft: noop, openAgent: noop, cancelJob: noop, dismissJob: noop, retryGeneration: noop,
  manage: noop, start: noop, call: noop, continueDraft: noop, modelReady: true, data: { jobs, drafts, decks: [], sources: [] }, ...extra }));
const steps = (n, label = 'Part 1/1 · Writing and self-checking questions') => Array.from({ length: n }, (_, index) => ({ id: `s${n}-${index}`, stage: label, status: 'complete' }));
const fillJob = (id, status, extra = {}) => ({ id, status, type: undefined, stage: 'Draft ready with 12/15 questions', parts: 2, draftId: 'd1', continued: true, deckTitle: '架构的语境性', savedCount: 12, requestedTotal: 15, count: 8,
  startedAt: `2026-10-05T10:0${id.length}:00.000Z`, steps: steps(3), ...extra });
const shortDraft = () => draft({ title: '架构的语境性', editorial: { requested: 15, generated: 12, completedParts: 2, parts: 2, failures: [], generation: { sourceIds: ['s1'], kind: 'quiz' } }, cards: Array.from({ length: 12 }, (_, i) => card(`c${i}`)) });
const cardsIn = (html) => (html.match(/class="sh-job sh-job--/g) || []).length;

test('while a fill runs the deck has one card: the earlier 草稿待补齐 card folds into it (#200)', () => {
  m.setUiLanguage('zh');
  const older = fillJob('old', 'complete', { startedAt: '2026-10-05T10:00:00.000Z', steps: steps(18) });
  const running = fillJob('new-running', 'running', { stage: 'Parallel generation · up to 4 batches', startedAt: '2026-10-05T10:05:00.000Z', steps: steps(5), savedCount: 7, requestedTotal: 15 });
  const out = home([running, older], [shortDraft()]);
  assert.equal(cardsIn(out), 1, 'one task card, not the running one above the old warning');
  assert.match(text(out), /正在补齐「架构的语境性」/);
  assert.doesNotMatch(text(out), /草稿待补齐/, 'the old 草稿待补齐 card is gone: what it said now lives inside the fold');
  assert.match(text(out), /之前的任务 · 1/);
  assert.match(out, /18 步/, 'the earlier task keeps its own process log inside the fold');
  assert.match(out, /5 步/);
});

test('the list row says 补题中 as a Badge, not 已复审，待发布, and not as a button (#200)', () => {
  m.setUiLanguage('zh');
  const running = fillJob('r', 'running', { stage: 'Parallel generation · up to 4 batches', savedCount: 12 });
  const out = home([running], [shortDraft()]);
  const row = /<div class="draft-row">[\s\S]*$/.exec(out)[0];
  assert.match(text(row), /补题中/);
  assert.doesNotMatch(text(row), /已复审，待发布|待发布检查/, 'a deck being filled is not "reviewed, waiting to publish"');
  assert.match(row, /<span[^>]*sh-badge[^>]*data-draft-work[^>]*>(?:<span[^>]*><\/span>)?补题中/, 'the status is a Badge');
  assert.doesNotMatch(row, /<button[^>]*disabled[^>]*>[^<]*补题中/, 'not a disabled button dressed as a status');
  const idle = home([], [shortDraft()]);
  assert.match(text(idle), /待发布检查|已复审，待发布/);
  assert.doesNotMatch(idle, /data-draft-work/);
  assert.match(idle, /<button[^>]*>[^<]*继续补齐 3 题/, 'the action is still a button when nothing runs');
});

test('the row says its status once: the meta line is the count, the Badge carries status and progress (#228)', () => {
  m.setUiLanguage('zh');
  const rowOf = (html) => /<div class="draft-row">[\s\S]*?<\/small>[\s\S]*$/.exec(html)[0];
  const metaOf = (html) => /<div class="draft-row">[\s\S]*?<small>([\s\S]*?)<\/small>/.exec(html)[1];
  const running = fillJob('r', 'running', { stage: 'Parallel generation · up to 4 batches', savedCount: 6, requestedTotal: 10 });
  const six = draft({ title: '架构的语境性', editorial: { requested: 10, generated: 6, completedParts: 2, parts: 2, failures: [], generation: { sourceIds: ['s1'], kind: 'quiz' } }, cards: Array.from({ length: 6 }, (_, i) => card(`c${i}`)) });
  const filling = home([running], [six]), row = rowOf(filling);
  assert.equal((text(row).match(/补题中/g) || []).length, 1, 'the status is said once in the row');
  assert.equal(text(metaOf(filling)).trim(), '6 道题', 'the meta line is the count only while the Badge shows the fill');
  assert.match(row, /sh-badge[^>]*data-draft-work[^>]*>(?:<span[^>]*><\/span>)?补题中 · 草稿 6\/10 题/);
  const idle = home([], [six]);
  assert.equal((text(rowOf(idle)).match(/待发布检查|已复审，待发布/g) || []).length, 1, 'idle: one status too');
  assert.match(rowOf(idle), /sh-badge[^>]*data-draft-status[^>]*>[^<]*(?:待发布检查|已复审，待发布)/, 'the idle status is a Badge as well');
  assert.doesNotMatch(text(metaOf(idle)), /待发布检查|已复审，待发布/, 'not in the meta line');
  assert.doesNotMatch(text(metaOf(idle)), /还差/, 'the button already names how many are missing');
  m.setUiLanguage('en');
  const english = rowOf(home([running], [six]));
  m.setUiLanguage('zh');
  assert.equal((text(english).match(/Adding questions/g) || []).length, 1, 'once in English too');
});

test('after a fill ends short only one 草稿待补齐 card remains: the newest job, with its own numbers and process (#203)', () => {
  m.setUiLanguage('zh');
  const oldest = fillJob('a1', 'complete', { startedAt: '2026-10-05T09:00:00.000Z', savedCount: 7, steps: steps(18), stage: 'Draft ready with 7/15 questions' });
  const newest = fillJob('b22', 'complete', { startedAt: '2026-10-05T09:30:00.000Z', savedCount: 12, steps: steps(27), stage: 'Draft ready with 12/15 questions' });
  const out = home([newest, oldest], [shortDraft()]);
  assert.equal(cardsIn(out), 1, 'two partial jobs of one deck, one card');
  assert.equal((text(out).match(/草稿待补齐 · 12\/15 题/g) || []).length, 1, 'one headline with the draft\'s numbers');
  assert.match(text(out), /补题 · 当时草稿 7\/15 题/, 'the earlier job in the fold says what it saw then');
  assert.match(out, /27 步/, 'the process log is the newest job\'s');
  assert.match(text(out), /之前的任务 · 1/);
  assert.match(out, /18 步/, 'the older job\'s log is only inside the fold');
  const other = home([newest, oldest], [shortDraft()], {});
  assert.doesNotMatch(other.replace(/之前的任务[\s\S]*?<\/details>/, ''), /18 步/, 'outside the fold the old process does not appear');
  m.setUiLanguage('en');
  const english = text(home([newest, oldest], [shortDraft()]));
  m.setUiLanguage('zh');
  assert.match(english, /Earlier tasks · 1/);
});

test('jobs of different decks, publish and repair jobs and jobs without a draft are never folded', () => {
  const generation = (id, draftId, startedAt, extra = {}) => ({ id, status: 'complete', draftId, startedAt, ...extra });
  const jobs = [generation('a', 'd1', '2026-10-05T10:00:00.000Z'), generation('b', 'd2', '2026-10-05T10:01:00.000Z'), generation('c', undefined, '2026-10-05T10:02:00.000Z'),
    generation('d', 'd1', '2026-10-05T10:03:00.000Z', { type: 'draft-repair' }), generation('e', 'd1', '2026-10-05T10:04:00.000Z', { type: 'draft-publish' }),
    generation('f', 'd1', '2026-10-05T10:05:00.000Z', { type: 'supplement' }), generation('g', 'd1', '2026-10-05T10:06:00.000Z')];
  const cards = m.foldJobsByDraft(jobs);
  assert.deepEqual(cards.map((item) => item.job.id), ['b', 'c', 'd', 'e', 'f', 'g'], 'a is folded into the newer job of the same draft; everything else stays; order is kept');
  assert.deepEqual(cards.find((item) => item.job.id === 'g').earlier.map((job) => job.id), ['a']);
  assert.deepEqual(cards.find((item) => item.job.id === 'b').earlier, []);
  const running = m.foldJobsByDraft([generation('x', 'd9', '2026-10-05T10:00:00.000Z'), generation('y', 'd9', '2026-10-05T10:09:00.000Z', { status: 'running' })]);
  assert.deepEqual(running.map((item) => item.job.id), ['y'], 'a running job is the newest of its deck');
});

test('the add button is not offered for a case paper, an edit of a published deck or an unsaved edit', () => {
  const none = (value) => assert.doesNotMatch(page(value), /data-add-from-sources/);
  none(draft({ editingDeckId: 'deck-1' }));
  const kind = draft(); kind.editorial.generation.kind = 'case'; none(kind);
  const repair = draft(); repair.editorial.repairOfDeckId = 'deck-1'; none(repair);
});
