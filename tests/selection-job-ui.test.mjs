import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { nativeSelects } from './helpers/native-selects.mjs';

/* The reader's learning panel no longer waits on one host call. A supplement is a background job shown in place: stage in
   plain words, counts, elapsed time, the estimate and the real usage, a stop button, and, when it finishes, a result block
   with a jump to the new questions. The ask form stays usable the whole time. */

const han = /[㐀-鿿]/;
const require = createRequire(import.meta.url);
const compiled = await build({ stdin: { contents: `
  export * from './ui/i18n.js';
  export * from './ui/document-preview/selection-job.js';
  export { jobHeadline, jobStageLabel } from './ui/generation-status.js';
  export { default as GenerationTrace } from './ui/GenerationTrace.jsx';
  export { SelectionJobCard, SelectionJobList } from './ui/document-preview/SelectionJobs.jsx';
  export { default as DocumentLearning, LearningPanel } from './ui/document-preview/DocumentLearning.jsx';`, resolveDir: process.cwd() },
  bundle: true, write: false, platform: 'node', format: 'cjs', external: ['react'], plugins: [nativeSelects], loader: { '.css': 'text' }, logLevel: 'silent' });
const load = () => {
  const module = { exports: {} };
  new Function('require', 'module', 'exports', compiled.outputFiles[0].text)(require, module, module.exports);
  return module.exports;
};
const lib = load();
const h = React.createElement;
const render = (component, props) => renderToStaticMarkup(h(component, props));
const text = markup => markup.replace(/<[^>]+>/g, ' ').replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/\s+/g, ' ');

const selection = { sourceId: 's1', documentId: 'doc', revision: 'r1', quote: 'Architecture includes the principles guiding design.', start: 10, end: 60 };
const base = { id: 'j1', type: 'supplement', origin: 'selection', operationId: 'op1', deckId: 'd', mergeTargetId: 'd', targetTitle: 'Architecture basics',
  deckTitle: 'Architecture basics', selection, kind: 'flashcard', count: 2, requestedTotal: 2, savedCount: 0, passed: 0, steps: [],
  startedAt: '2026-10-02T10:00:00.000Z', runStartedAt: '2026-10-02T10:00:00.000Z' };
const at = seconds => Date.parse('2026-10-02T10:00:00.000Z') + seconds * 1000;
const running = (extra = {}) => ({ ...base, status: 'running', stage: 'Writing and self-checking questions', stageCode: 'authoring', ...extra });
const done = (extra = {}) => ({ ...base, status: 'complete', stage: 'Added 1 questions to Architecture basics; total 2', stageCode: 'partial', savedCount: 1, passed: 1,
  finishedAt: '2026-10-02T10:01:10.000Z',
  publication: { deckId: 'd', added: 1, total: 2, cardIds: ['c-new'], firstCardId: 'c-new' },
  rejected: [{ prompt: 'Which statement leaks its own answer?', objective: 'x', reasons: ['q2: answerLeak failed or was not checked'] }], ...extra });

test('a job is read as a phase in plain words: queued, planning, writing, reviewing, saving, stopping, done', () => {
  const { jobPhase, phaseLabel } = lib;
  lib.setUiLanguage('zh');
  assert.equal(jobPhase({ ...base, status: 'queued', stageCode: 'queued' }), 'queued');
  assert.equal(jobPhase(running({ stageCode: 'planning' })), 'planning');
  assert.equal(jobPhase(running()), 'writing');
  assert.equal(jobPhase(running({ stageCode: 'reviewing' })), 'reviewing');
  assert.equal(jobPhase(running({ stageCode: 'publishing' })), 'saving');
  assert.equal(jobPhase({ ...base, status: 'cancelling', stageCode: 'cancelling' }), 'cancelling');
  assert.equal(jobPhase(done({ stageCode: 'done', savedCount: 2, passed: 2, rejected: [] })), 'done');
  assert.equal(jobPhase(done()), 'partial', 'saved 1 of 2 is partial, never plain success');
  assert.equal(jobPhase({ ...base, status: 'failed', outcome: 'conflict', stageCode: 'failed' }), 'conflict');
  assert.equal(jobPhase({ ...base, status: 'failed', outcome: 'review-failed', stageCode: 'failed' }), 'failed');
  assert.equal(jobPhase({ ...base, status: 'cancelled', stageCode: 'cancelled' }), 'cancelled');
  assert.deepEqual(['queued', 'planning', 'writing', 'reviewing', 'saving'].map(phaseLabel),
    ['排队中，前面的任务完成后开始', '正在规划考点', '正在出题', '独立审阅中', '正在保存到题组']);
});

test('counts and elapsed time are honest: passed of requested, written candidates, a clock that stops with the job', () => {
  const { countsText, elapsedClock } = lib;
  lib.setUiLanguage('zh');
  assert.equal(countsText(running()), '已通过 0 / 共 2');
  assert.equal(countsText(running({ written: 2 })), '已写出 2 题，等待独立审阅 · 已通过 0 / 共 2');
  assert.equal(countsText(done()), '已通过 1 / 共 2');
  assert.equal(elapsedClock(running(), at(65)), '1:05');
  assert.equal(elapsedClock({ ...base, status: 'queued', runStartedAt: undefined }, at(65)), '', 'queue wait is not run time');
  assert.equal(elapsedClock(done(), at(9999)), '1:10', 'a finished job keeps the time it took');
  lib.setUiLanguage('en');
  assert.equal(countsText(running({ written: 2 })), 'Wrote 2, waiting for independent review · Passed 0 of 2');
  lib.setUiLanguage('zh');
});

test('the same passage and deck cannot be started twice while one runs; another passage or deck is fine', () => {
  const { blockingJob } = lib;
  const jobs = [running()];
  assert.equal(blockingJob(jobs, { ...selection }, 'd')?.id, 'j1');
  assert.equal(blockingJob(jobs, { ...selection, prefix: 'other context' }, 'd')?.id, 'j1', 'context words do not make it another passage');
  assert.equal(blockingJob(jobs, { ...selection, start: 100, end: 150, quote: 'Another passage.' }, 'd'), null);
  assert.equal(blockingJob(jobs, selection, 'other-deck'), null);
  assert.equal(blockingJob([done()], selection, 'd'), null, 'a finished job does not block');
});

test('a running job shows its stage, counts, elapsed time, expected usage and a stop button in place', () => {
  const { SelectionJobCard } = lib;
  lib.setUiLanguage('zh');
  const markup = render(SelectionJobCard, { job: running({ written: 2, estimate: { feature: 'generate', totalTokens: { low: 12000, high: 20000 }, calls: { low: 3, high: 4 },
    inputTokens: { low: 1, high: 2 }, outputTokens: { low: 1, high: 2 } } }), now: at(42), onCancel() {} });
  const words = text(markup);
  assert.match(words, /正在补题/);
  assert.match(words, /Architecture basics/);
  assert.match(words, /正在出题/);
  assert.match(words, /已写出 2 题，等待独立审阅 · 已通过 0 \/ 共 2/);
  assert.match(words, /已用 0:42/);
  assert.match(words, /预计 12K–20K tok · 3–4 次模型调用/);
  assert.match(markup, /role="status"/);
  assert.match(words, /停止/);
  assert.match(words, /Architecture includes the principles guiding design\./, 'the passage it works on');
  assert.match(words, /后台继续生成，关闭阅读器也不会中断/);
});

test('a finished job says what was added and what did not pass, why, and jumps to the new questions', () => {
  const { SelectionJobCard } = lib;
  lib.setUiLanguage('zh');
  const calls = [];
  const markup = render(SelectionJobCard, { job: done(), now: at(9999), canPractice: true, onPractice: refs => calls.push(refs), onOpenDeck: id => calls.push(id), onOpenCard: ref => calls.push(ref) });
  const words = text(markup);
  assert.match(words, /已加入「Architecture basics」1 张，1 张未通过审阅/);
  assert.match(words, /提示或题干泄露了答案/, 'the draft page\'s plain reasons for a dropped question');
  assert.match(words, /Which statement leaks its own answer\?/);
  assert.match(words, /马上练这 1 张/);
  assert.match(words, /打开题组/);
  assert.match(words, /查看这道题与解析/);
  assert.doesNotMatch(words, /草稿/, 'a deck supplement does not talk about drafts');
  const full = text(render(SelectionJobCard, { job: done({ stageCode: 'done', savedCount: 2, passed: 2, rejected: [], publication: { deckId: 'd', added: 2, total: 3, cardIds: ['a', 'b'], firstCardId: 'a' } }), now: at(9999), canPractice: true, onPractice() {} }));
  assert.match(full, /已加入「Architecture basics」2 张/);
  assert.doesNotMatch(full, /未通过审阅/);
  assert.match(full, /马上练这 2 张/);
  const noPractice = text(render(SelectionJobCard, { job: done(), now: at(9999) }));
  assert.doesNotMatch(noPractice, /马上练/, 'a host that cannot start a run shows no such button');
});

test('a failed, stopped or conflicting job says why in plain words and offers the right retry', () => {
  const { SelectionJobCard } = lib;
  lib.setUiLanguage('zh');
  const failed = text(render(SelectionJobCard, { job: { ...base, status: 'failed', outcome: 'review-failed', stage: 'Reviewer unavailable: fetch failed', stageCode: 'failed' }, now: at(5), onRetry() {} }));
  assert.match(failed, /连不上模型服务/);
  assert.match(failed, /题组没有变化/);
  assert.match(failed, /重试/);
  assert.match(failed, /技术详情/);
  const conflict = text(render(SelectionJobCard, { job: { ...base, status: 'failed', outcome: 'conflict', passed: 2, stage: 'Deck version conflict', stageCode: 'failed' }, now: at(5), onRetry() {} }));
  assert.match(conflict, /题组已更新，已审核的题目等待再次保存/);
  assert.match(conflict, /保留审核结果并重试保存/);
  const stopped = text(render(SelectionJobCard, { job: { ...base, status: 'cancelled', outcome: 'cancelled', stageCode: 'cancelled' }, now: at(5), onRetry() {} }));
  assert.match(stopped, /已停止，题组没有变化/);
  assert.match(stopped, /重新开始/);
  const queued = text(render(SelectionJobCard, { job: { ...base, status: 'queued', stage: 'Waiting for the previous generation', stageCode: 'queued' }, now: at(5), onCancel() {} }));
  assert.match(queued, /补题排队中/);
  assert.match(queued, /排队中，前面的任务完成后开始/);
  assert.match(queued, /停止/);
});

test('the English render has no Han characters outside the learner\'s own text', () => {
  const { SelectionJobCard, setUiLanguage } = lib;
  setUiLanguage('en');
  try {
    const own = 'Architecture includes the principles guiding design.';
    for (const job of [running({ written: 1 }), { ...base, status: 'queued', stage: 'Waiting for the previous generation', stageCode: 'queued' }, done(), done({ stageCode: 'done', savedCount: 2, rejected: [] }),
      { ...base, status: 'failed', outcome: 'conflict', stage: 'Deck version conflict', stageCode: 'failed' },
      { ...base, status: 'failed', outcome: 'review-failed', stage: 'rate limit', stageCode: 'failed' }, { ...base, status: 'cancelled', outcome: 'cancelled', stageCode: 'cancelled' }]) {
      const markup = text(render(SelectionJobCard, { job, now: at(30), canPractice: true, onCancel() {}, onRetry() {}, onPractice() {}, onOpenDeck() {}, onOpenCard() {} })).replace(own, '');
      assert.doesNotMatch(markup, han, markup);
    }
    assert.match(text(render(SelectionJobCard, { job: done(), now: at(30), canPractice: true, onPractice() {} })), /Added 1 to .Architecture basics., 1 did not pass review/);
    assert.match(text(render(SelectionJobCard, { job: done(), now: at(30), canPractice: true, onPractice() {} })), /Practise this question now/);
  } finally { setUiLanguage('zh'); }
});

const panel = (extra = {}) => ({ capture: { quote: selection.quote }, resolution: { status: 'resolved', selection }, resolving: false, error: '', question: 'Why?', answer: '', asking: false,
  deckId: 'd', count: 2, kind: 'flashcard', decks: [{ id: 'd', title: 'Architecture basics' }], askReady: true, generateReady: true, modelReady: true, starting: false,
  jobs: [], now: at(10), call() {}, ...extra });

test('the ask form stays usable and the generate form stays editable while a supplement runs', () => {
  const { LearningPanel } = lib;
  lib.setUiLanguage('zh');
  const idle = render(LearningPanel, panel());
  const busy = render(LearningPanel, panel({ jobs: [running()], deckId: 'e', decks: [{ id: 'd', title: 'Architecture basics' }, { id: 'e', title: 'Other' }] }));
  const askButton = html => /<button[^>]*>(?:<[^>]+>)*依据原文回答/.exec(html)?.[0] || '';
  assert.ok(askButton(idle) && !/disabled/.test(askButton(idle)));
  assert.ok(askButton(busy) && !/disabled/.test(askButton(busy)), 'asking is not blocked by the running job');
  assert.doesNotMatch(/<textarea[^>]*>/.exec(busy)[0], /disabled/);
  for (const select of busy.match(/<select[^>]*>/g)) assert.doesNotMatch(select, /disabled/, 'deck and kind stay editable');
  assert.match(text(busy), /正在补题/, 'the job is shown in place');
  assert.doesNotMatch(text(busy), /正在生成与审核…/, 'the old blocking label is gone');
  assert.match(text(busy), /生成、审核并补充题目/, 'another passage or deck can be started');
});

test('starting a second supplement for the same passage and deck is refused in plain words, before any call', () => {
  const { LearningPanel } = lib;
  lib.setUiLanguage('zh');
  const markup = render(LearningPanel, panel({ jobs: [running()] }));
  assert.match(text(markup), /这段原文补到这个题组的任务正在进行/);
  const generate = /<button[^>]*type="submit"[^>]*>(?:<[^>]+>)*生成、审核并补充题目/.exec(markup)?.[0] || '';
  assert.match(generate, /disabled/);
});

test('before it starts the panel states what the run is expected to use, in the same format as other generation', () => {
  const { LearningPanel } = lib;
  lib.setUiLanguage('zh');
  const markup = render(LearningPanel, panel());
  assert.match(markup, /data-token-estimate/);
  assert.match(text(markup), /生成后独立审核，通过的题目增量保存到所选题组/);
});

test('finished jobs stay in the panel when no passage is selected, and the panel says what to do', () => {
  const { LearningPanel } = lib;
  lib.setUiLanguage('zh');
  const markup = text(render(LearningPanel, panel({ capture: null, resolution: null, jobs: [done()] })));
  assert.match(markup, /选中原文中的一段文字/);
  assert.match(markup, /已加入「Architecture basics」1 张，1 张未通过审阅/);
});

test('the running job comes first and older results fold away, so progress never scrolls out of view', () => {
  const { LearningPanel, SelectionJobList } = lib;
  lib.setUiLanguage('zh');
  const finished = ['a', 'b', 'c', 'd'].map(name => done({ id: `f${name}`, operationId: `op-${name}`, targetTitle: `Deck ${name}` }));
  const markup = render(SelectionJobList, { jobs: [...finished, running({ operationId: 'live', id: 'live' })], now: at(5) });
  assert.ok(markup.indexOf('data-job-id="live"') < markup.indexOf('data-job-id="fa"'), 'running jobs lead');
  assert.match(text(markup), /更早的补题结果 · 2/);
  assert.equal((markup.match(/<details class="selection-jobs__older"/g) || []).length, 1);
  assert.equal((render(SelectionJobList, { jobs: finished.slice(0, 2), now: at(5) }).match(/selection-jobs__older/g) || []).length, 0);
  const panelMarkup = render(LearningPanel, panel({ jobs: [running()] }));
  assert.ok(panelMarkup.indexOf('class="selection-jobs"') < panelMarkup.indexOf('<form'), 'the job card sits above the forms');
});

test('notices: a start says it continues in the background, a finish names the deck and carries the jump', () => {
  const { startedNotice, finishedNotice } = lib;
  lib.setUiLanguage('zh');
  assert.equal(startedNotice({ status: 'running' }, 'Architecture basics').text, '已开始补题「Architecture basics」，后台继续生成，完成后进信箱。');
  assert.match(startedNotice({ status: 'queued', queuedBehind: 2 }, 'Architecture basics').text, /排在 2 个任务之后/);
  const notice = finishedNotice(done());
  assert.equal(notice.text, '已加入「Architecture basics」1 张，1 张未通过审阅');
  assert.equal(notice.tone, 'warning');
  assert.deepEqual(notice.jump, { deckId: 'd', cardIds: ['c-new'] });
  assert.equal(finishedNotice(done({ stageCode: 'done', rejected: [], savedCount: 2, publication: { deckId: 'd', added: 2, total: 3, cardIds: ['a', 'b'] } })).tone, 'success');
  assert.equal(finishedNotice({ ...base, status: 'failed', outcome: 'review-failed', stage: 'rate limit' }).tone, 'error');
  assert.equal(finishedNotice({ ...base, status: 'cancelled' }).jump, null);
});

test('the global job card reads a passage supplement as a deck supplement, never as a draft', () => {
  const { jobHeadline, jobStageLabel, GenerationTrace } = lib;
  lib.setUiLanguage('zh');
  assert.equal(jobHeadline(done()), '部分补入 1 题 · 共 2 题 ·「Architecture basics」');
  assert.equal(jobHeadline(done({ stageCode: 'done', savedCount: 2, rejected: [], publication: { deckId: 'd', added: 2, total: 3, cardIds: ['a', 'b'] } })), '已补入 2 题 · 共 3 题 ·「Architecture basics」');
  assert.equal(jobHeadline(running()), '正在审核并补入题组 ·「Architecture basics」');
  assert.equal(jobStageLabel(done({ stageCode: 'done', savedCount: 2, rejected: [] })), '已通过独立审阅，并保存到题组。');
  assert.equal(jobStageLabel(done()), '只有部分题通过了独立审阅；通过的已保存到题组。');
  assert.equal(jobStageLabel({ ...base, status: 'cancelled', stageCode: 'cancelled' }), '已停止，题组没有变化。');
  const trace = text(render(GenerationTrace, { job: running({ totalTimeoutSeconds: 1200, steps: [{ id: 's1', stage: 'Planning evidence and learning targets', status: 'complete' }] }) }));
  assert.match(trace, /只有通过审阅的题才会保存到题组/);
  assert.match(trace, /到时会停止，题组不会有变化/);
  assert.doesNotMatch(trace, /草稿/);
});

test('start errors read in plain words', () => {
  const { startErrorText } = lib;
  lib.setUiLanguage('zh');
  assert.match(startErrorText('Selection is stale; select the current passage again'), /重新选择/);
  assert.match(startErrorText('Append target must be an active ordinary deck'), /题组/);
  assert.equal(startErrorText('这段原文补到这个题组的任务已在进行，请等它完成，或先停止它再重新开始。'), '这段原文补到这个题组的任务已在进行，请等它完成，或先停止它再重新开始。');
  assert.equal(startErrorText('Something nobody planned for'), 'Something nobody planned for');
});
