import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { loadUi } from './helpers/ui-module.mjs';
import { inApp } from './helpers/fake-app.mjs';
import { shortCauseOf, THIN_CHARS } from '../lib/generation-failure.js';
import { recordAttempts, runFacts, roundList } from '../lib/coverage-run.js';
import { stageArgsOf } from '../lib/contexts/jobs/contracts.js';
import { observeJob } from '../lib/job-calls.js';
import { jobContract } from '../lib/job-contract.js';

/* Why a question run stopped short, said so that a learner understands it (the owner's complaint of 2026-10-07: 「考点不够数」, 「重试了几轮」, 「第 3/3 轮」 told nothing).
   The fixture is the run of 「架构的语境性、动态性与代价权衡」: 14 pages, 19 questions asked, 17 kept, 86% covered; pages 18 and 19 asked for 3 knowledge points each and the model gave 1 and 2,
   in the planned round and again in the retry (补做) round, after which the run stopped. One fact is ONE wording in the plan block, the log and the draft page. */

const m = await loadUi(`
  export { AppContext } from './ui/app/app-context.js';
  export { StudyServicesContext } from './ui/study-context.jsx';
  export { default as RunLine } from './ui/tasks/RunLine.jsx';
  export { default as RunPanel } from './ui/coverage/RunPanel.jsx';
  export { default as RunRounds } from './ui/tasks/RunRounds.jsx';
  export * as copy from './ui/coverage/copy.js';
  export { logLines } from './ui/tasks/call-model.js';
  export { setUiLanguage } from './ui/i18n.js';
`);
const han = /[㐀-鿿]/;
const text = html => html.replace(/<[^>]+>/g, ' ').replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&#x27;/g, "'").replace(/&gt;/g, '>').replace(/\s+/g, ' ').trim();
const inLanguage = (language, run) => { m.setUiLanguage(language); try { return run(); } finally { m.setUiLanguage('zh'); } };
const render = (element, language = 'zh') => inLanguage(language, () => renderToStaticMarkup(inApp(m, element, { data: {}, app: { lib: { taskFocus: null }, host: {} } })));
const at = seconds => new Date(Date.UTC(2026, 9, 7, 15, 20, seconds)).toISOString();

/* ---------- the numbers behind a section that came back short ---------- */

const p18 = { key: 'pdf#p18', page: 18, sourceId: 'pdf', start: 1000, end: 2600, reason: 'plan-short', attempts: 2, rounds: [{ round: 1 }, { round: 2, fill: true }], short: { needed: 3, got: 1, chars: 1600, returned: 1, outside: 0 } };
const p19 = { key: 'pdf#p19', page: 19, sourceId: 'pdf', start: 2600, end: 4000, reason: 'plan-short', attempts: 2, rounds: [{ round: 1 }, { round: 2, fill: true }], short: { needed: 3, got: 2, chars: 1400, returned: 3, outside: 1 } };

test('a section that came back short has ONE cause, told apart from what the run recorded (never a cause the data cannot tell)', () => {
  assert.equal(THIN_CHARS, 300);
  assert.equal(shortCauseOf({ needed: 3, got: 1, returned: 1, outside: 0 }), 'fewer', 'the model gave fewer than asked');
  assert.equal(shortCauseOf({ needed: 3, got: 0, returned: 0, outside: 0 }), 'empty', 'the model gave none');
  assert.equal(shortCauseOf({ needed: 3, got: 0, returned: 2, outside: 2 }), 'quote', 'every point it gave quoted text that is not on the page');
  assert.equal(shortCauseOf({ needed: 3, got: 1, returned: 3, outside: 2 }), 'fewer', 'some quotes were found: it is a shortfall, not a bad quote');
  assert.equal(shortCauseOf({ needed: 3, got: 0, why: 'refused' }), 'refused', 'the model said the page does not support the points');
  assert.equal(shortCauseOf({ needed: 3, got: 0, why: 'reply' }), 'reply');
  assert.equal(shortCauseOf({ needed: 3, got: 0, why: 'invalid' }), 'invalid');
  assert.equal(shortCauseOf({ needed: 3, got: 1 }), 'short', 'only the counts are known: that is all that is said');
  for (const empty of [undefined, null, {}, { needed: NaN, got: NaN, returned: NaN }]) assert.equal(shortCauseOf(empty), 'short', String(JSON.stringify(empty)));
});

test('recordAttempts keeps the rounds a section was tried in (a retry is marked) and, when the plan came back short, how many points were needed and given', () => {
  let spec = recordAttempts({ rounds: [] }, ['pdf#p18'], () => 'plan-short', 1, () => ({ needed: 3, got: 1, chars: 1600, returned: 1, outside: 0 }));
  assert.deepEqual(spec.attempts['pdf#p18'], { n: 1, reason: 'plan-short', round: 1, rounds: [{ round: 1 }], short: { needed: 3, got: 1, chars: 1600, returned: 1, outside: 0 } });
  spec = recordAttempts(spec, ['pdf#p18'], () => 'plan-short', 2, () => ({ needed: 3, got: 1, chars: 1600, returned: 1, outside: 0 }), true);
  assert.deepEqual(spec.attempts['pdf#p18'].rounds, [{ round: 1 }, { round: 2, fill: true }]);
  assert.equal(spec.attempts['pdf#p18'].n, 2);
  // A later failure with another cause does not keep the old numbers: they would describe a failure that is not the last.
  const other = recordAttempts(spec, ['pdf#p18'], () => 'review-protocol', 3, () => null, true);
  assert.equal(other.attempts['pdf#p18'].short, undefined);
  assert.equal(other.attempts['pdf#p18'].reason, 'review-protocol');
  assert.equal(recordAttempts({ rounds: [] }, ['x'], () => 'quote', 1).attempts.x.short, undefined, 'a plan from before detail was kept is read as before');
  assert.equal(recordAttempts({ rounds: [] }, ['x'], () => 'quote', 1).attempts.x.n, 1);
  const many = Array.from({ length: 12 }, (_, index) => index + 1).reduce((next, round) => recordAttempts(next, ['k'], () => 'quote', round, undefined, round > 1), { rounds: [] });
  assert.ok(many.attempts.k.rounds.length <= 6, 'bounded');
  assert.equal(many.attempts.k.rounds.at(-1).round, 12);
});

test('runFacts counts the retry rounds (补做) apart from the planned ones, so 「停在第 1 轮之后」 can say that a retry was made', () => {
  const rounds = roundList({ rounds: [{ round: 1, questions: 4, sectionIds: ['a'], status: 'done' }, { round: 2, questions: 2, sectionIds: ['b'], fill: true, status: 'failed' }] });
  const facts = runFacts({ rounds, run: { state: 'stopped', tokensUsed: 263000 }, percent: 86 });
  assert.deepEqual([facts.fills, facts.fillsFailed, facts.done], [1, 1, 1]);
  assert.deepEqual([runFacts({ rounds: [], run: {} }).fills, runFacts({ rounds: [], run: {} }).fillsFailed], [0, 0]);
});

/* ---------- the words ---------- */

test('what came back short is worded with the numbers the run knew: needed, given, tries', () => {
  assert.equal(m.copy.shortFact(p18), '第 18 页：计划需要 3 个考点，模型只给出了 1 个');
  assert.equal(m.copy.shortFact({ ...p18, short: { needed: 3, got: 0 } }), '第 18 页：计划需要 3 个考点，模型一个也没给出');
  assert.equal(m.copy.shortFact({ ...p18, short: undefined }), '', 'no numbers recorded: nothing is invented');
  assert.equal(m.copy.shortFact({ ...p18, short: { needed: NaN, got: NaN } }), '');
  assert.equal(m.copy.repeatingItem(p18), '第 18 页（要 3 个考点，只给出 1 个 · 已试 2 次）');
  assert.equal(m.copy.repeatingItem({ key: 'a#1', title: '第六部分：缓存', reason: 'review-protocol', attempts: 2 }), '第六部分：缓存（审阅回复格式不对，重新审阅后仍不行 · 已试 2 次）');
  assert.equal(m.copy.repeatingItem({ key: 'a#1', title: '第六部分：缓存', reason: 'review-protocol' }), '第六部分：缓存（审阅回复格式不对，重新审阅后仍不行）', 'no count recorded: no count said');
  inLanguage('en', () => {
    assert.equal(m.copy.shortFact(p18), 'Page 18: the plan needs 3 knowledge points, the model gave only 1');
    assert.equal(m.copy.repeatingItem(p18), 'Page 18 (needs 3 knowledge points, only 1 given · tried 2 times)');
    assert.doesNotMatch(m.copy.repeatingLine({ repeating: [p18, p19] }), han);
  });
  assert.equal(m.copy.repeatingLine({ repeating: [p18, p19] }), '这几个小节反复失败：第 18 页（要 3 个考点，只给出 1 个 · 已试 2 次）、第 19 页（要 3 个考点，只给出 2 个 · 已试 2 次）');
});

test('each cause has its own sentence, and a thin page is said with its real length', () => {
  const why = short => m.copy.shortWhy(short);
  assert.equal(why({ needed: 3, got: 1, returned: 1, outside: 0, chars: 1600 }), '补问一次后，模型仍只给出 1 个');
  assert.equal(why({ needed: 3, got: 1, returned: 3, outside: 2, chars: 1600 }), '补问一次后，模型一共给出 3 个，只有 1 个能在这一页里找到出处并通过检查');
  assert.equal(why({ needed: 3, got: 0, returned: 0, outside: 0, chars: 1600 }), '补问一次后，模型一个考点也没给出');
  assert.equal(why({ needed: 3, got: 0, returned: 2, outside: 2, chars: 1600 }), '模型给出了 2 个考点，但引用的原文在这一页里找不到');
  assert.equal(why({ needed: 3, got: 0, why: 'refused', chars: 1600 }), '模型回复说这一页的内容不足以出考点');
  assert.equal(why({ needed: 3, got: 0, why: 'invalid', chars: 1600 }), '模型给出的考点没有通过检查（引用或格式不对）');
  assert.equal(why({ needed: 3, got: 0, why: 'reply', chars: 1600 }), '模型的回复读不出来（格式错误或被截断）');
  assert.equal(why({ needed: 3, got: 1 }), '记录里只有数量：计划要 3 个，模型给出 1 个', 'only the counts are known: that is what is said');
  assert.equal(why({ needed: 3, got: 0, returned: 0, outside: 0, chars: 120 }), '补问一次后，模型一个考点也没给出；这一页只有约 120 个字，文字很少，可能是空白页、纯图片页或附录');
  assert.equal(why({ needed: 3, got: 1, returned: 1, outside: 0, chars: THIN_CHARS }), '补问一次后，模型仍只给出 1 个', 'a page of the threshold length is not called thin');
  assert.equal(why(undefined), '');
  assert.equal(why({ needed: NaN }), '');
  inLanguage('en', () => { for (const short of [{ needed: 3, got: 0, returned: 0, outside: 0, chars: 120 }, { needed: 3, got: 0, why: 'refused' }, { needed: 3, got: 1 }]) assert.doesNotMatch(why(short), han); });
});

test('the explanation under the failing sections: what happened, why, what the learner can do, only what is true for the cause', () => {
  const found = m.copy.repeatingExplain({ repeating: [p18, p19], coveragePercent: 86 });
  assert.deepEqual(found.items.map(item => item.fact), [
    '第 18 页：计划需要 3 个考点，模型只给出了 1 个 · 已试 2 次（第 1 轮、补做第 2 轮）',
    '第 19 页：计划需要 3 个考点，模型只给出了 2 个 · 已试 2 次（第 1 轮、补做第 2 轮）']);
  assert.equal(found.items[0].why, '补问一次后，模型仍只给出 1 个');
  assert.equal(found.items[1].why, '补问一次后，模型一共给出 3 个，只有 2 个能在这一页里找到出处并通过检查');
  assert.deepEqual(found.advice, [
    '再点「为没覆盖的部分补题」试一次：模型每次的回答不同，可能就够了。总是不行，可以在 设置 › 出题偏好 把规划的推理强度调高，或换一个更强的模型。',
    '不处理也可以：已出的题都保留，现在覆盖 86%，已经可以练习。']);
  const thin = m.copy.repeatingExplain({ repeating: [{ ...p18, short: { needed: 3, got: 0, returned: 0, outside: 0, chars: 90 } }], coveragePercent: 86 });
  assert.ok(thin.advice.some(line => line.startsWith('在资料里打开这一页')), 'a thin page: look at the original, and a blank or appendix page can be left');
  const refused = m.copy.repeatingExplain({ repeating: [{ ...p18, short: { needed: 3, got: 0, why: 'refused', chars: 1600 } }], coveragePercent: 86 });
  assert.ok(refused.advice.some(line => line.startsWith('在资料里打开这一页')) && !refused.advice.some(line => /推理强度/.test(line)), 'the model said the page lacks the points: raising its reasoning is not advised');
  const other = m.copy.repeatingExplain({ repeating: [{ key: 'a#1', title: '第六部分', reason: 'review-protocol', attempts: 2, rounds: [{ round: 1 }] }], coveragePercent: null });
  assert.equal(other.items[0].fact, '第六部分：审阅回复格式不对，重新审阅后仍不行 · 已试 2 次（第 1 轮）');
  assert.equal(other.items[0].why, '');
  assert.ok(!other.advice.some(line => /覆盖 /.test(line)), 'no coverage number known: none said');
  assert.deepEqual(m.copy.repeatingExplain({ repeating: [] }), { items: [], advice: [], needs: [] });
  inLanguage('en', () => {
    const english = m.copy.repeatingExplain({ repeating: [p18, p19], coveragePercent: 86 });
    for (const line of [...english.items.flatMap(item => [item.fact, item.why]), ...english.advice]) assert.doesNotMatch(line, han, line);
    assert.equal(english.items[0].fact, 'Page 18: the plan needs 3 knowledge points, the model gave only 1 · tried 2 times (Round 1, retry round 2)');
  });
});

/* ---------- the log ---------- */

const lost18 = { page: 18, needed: 3, got: 1 }, lost19 = { page: 19, needed: 3, got: 2 };

test('the lines of a round say which sections it tried, how many came out and, for a retry, what it retries; the same in English', () => {
  const copy = m.copy;
  assert.equal(copy.runEventText('round-start', { round: 1, rounds: 1, sections: 4, questions: 4, unit: 'page', names: [{ page: 3 }, { page: 7 }, { page: 18 }, { page: 19 }] }), '第 1/1 轮开始 · 4 页（第 3、7、18、19 页），4 题');
  assert.equal(copy.runEventText('round-start', { round: 2, rounds: 2, sections: 2, questions: 2, fill: true, unit: 'page', names: [{ page: 18 }, { page: 19 }], from: [1] }),
    '补做第 2 轮开始 · 重试第 1 轮里没出成题的 2 页（第 18、19 页），2 题');
  assert.equal(copy.runEventText('round-start', { round: 2, rounds: 2, sections: 2, questions: 2, fill: true }), '补做第 2 轮开始 · 2 个小节，2 题', 'an older record reads as it did');
  assert.equal(copy.runEventText('round-end', { round: 1, rounds: 1, status: 'done', kept: 2, covered: 2, tried: 4, unit: 'page', percent: 86, lost: [lost18, lost19], lostCount: 2 }),
    '第 1/1 轮完成：保留 2 题，新覆盖 2/4 页 · 覆盖 86% · 没出成题：第 18 页（要 3 个考点，只给出 1 个）、第 19 页（要 3 个考点，只给出 2 个）');
  assert.equal(copy.runEventText('round-end', { round: 2, rounds: 2, status: 'failed', fill: true, kept: 0, covered: 0, tried: 2, unit: 'page', code: 'plan-short', lost: [lost18, lost19], lostCount: 2 }),
    '补做第 2 轮没做成：保留 0 题，新覆盖 0/2 页 · 原因：模型给出的考点比计划的少 · 没出成题：第 18 页（要 3 个考点，只给出 1 个）、第 19 页（要 3 个考点，只给出 2 个）');
  assert.equal(copy.runEventText('round-end', { round: 3, rounds: 3, status: 'failed', kept: 0, covered: 0, code: 'plan-short' }), '第 3/3 轮没做成：保留 0 题，新覆盖 0 个小节 · 原因：模型给出的考点比计划的少', 'an older record reads as it did, in the new words');
  assert.equal(copy.runEventText('round-end', { round: 1, rounds: 1, status: 'done', kept: 2, covered: 2, percent: 86 }), '第 1/1 轮完成：保留 2 题，新覆盖 2 个小节 · 覆盖 86%');
  const many = copy.runEventText('round-end', { round: 1, rounds: 3, status: 'done', kept: 5, covered: 5, tried: 9, percent: 40, lost: [{ page: 2 }, { page: 5 }, { page: 6 }, { page: 9 }], lostCount: 4 });
  assert.match(many, /没出成题：第 2、5、6 页 等 4 个$/, 'at most three are named, the rest counted');
  inLanguage('en', () => {
    assert.equal(copy.runEventText('round-start', { round: 2, rounds: 2, sections: 2, questions: 2, fill: true, unit: 'page', names: [{ page: 18 }, { page: 19 }], from: [1] }),
      'Retry round 2 started · retrying 2 pages (Page 18, 19) that Round 1 left without a question, 2 questions');
    assert.equal(copy.runEventText('round-end', { round: 2, rounds: 2, status: 'failed', fill: true, kept: 0, covered: 0, tried: 2, unit: 'page', code: 'plan-short', lost: [lost18, lost19], lostCount: 2 }),
      'Retry round 2 did not work: kept 0 questions, 0/2 pages newly covered · Reason: The model gave fewer knowledge points than planned · No question: Page 18 (needs 3 knowledge points, only 1 given), Page 19 (needs 3 knowledge points, only 2 given)');
  });
});

test('the stop of a run says how many retries were made and in which rounds, and which sections are left', () => {
  const stop = { reason: 'sections-left', round: 2, left: 2, unit: 'page', names: [{ page: 18 }, { page: 19 }], fills: [2] };
  assert.equal(m.copy.stopText(stop), '补做了 1 次（第 2 轮）后，还有 2 页没出成题（第 18、19 页），已经停下；自动补题不再重试它们。');
  assert.equal(m.copy.stopText({ ...stop, fills: [2, 3] }), '补做了 2 次（第 2、3 轮）后，还有 2 页没出成题（第 18、19 页），已经停下；自动补题不再重试它们。');
  assert.equal(m.copy.stopText({ ...stop, fills: [] }), '这些小节之前已经失败过多次，自动补题不再重试，已经停下；还有 2 页没出成题（第 18、19 页）。');
  assert.equal(m.copy.stopText({ reason: 'sections-left', round: 2, left: 2 }), '重试后，还有 2 个小节没出成题，已经停下。', 'an older record: no number of rounds is invented');
  assert.doesNotMatch(m.copy.stopText({ reason: 'sections-left', left: 2 }), /几轮/);
  inLanguage('en', () => assert.equal(m.copy.stopText(stop), 'After 1 retry round(s) (Round 2), 2 pages still have no question (Page 18, 19), so the run stopped; the automatic top-up does not try them again.'));
});

/* ---------- the plan block and the log, rendered: the run of the screenshots ---------- */

const rounds = [{ round: 1, questions: 4, status: 'done', fill: false, sections: 4, kept: 2, covered: 2, tokens: 120000, ms: 300000, unit: 'page' },
  { round: 2, questions: 2, status: 'failed', fill: true, sections: 2, kept: 0, covered: 0, tokens: 143000, ms: 200000, code: 'plan-short', unit: 'page' }];
const stop = { reason: 'sections-left', round: 2, left: 2, unit: 'page', names: [{ page: 18 }, { page: 19 }], fills: [2], at: at(40) };
const job = (over = {}) => ({ id: 'run-1', status: 'complete', deckTitle: '架构的语境性、动态性与代价权衡', draftId: 'd1', kind: 'quiz', count: 2, requestedTotal: 19, savedCount: 17, parts: 1, steps: [], startedAt: at(0), finishedAt: at(50),
  coveragePlan: { level: 'standard', goal: 19, round: 2, rounds: 2 }, coverageRun: { autoComplete: true, state: 'stopped', percent: 86, tokensUsed: 263000, startedAt: at(0), list: rounds, stop }, ...over });
const shortfall = (over = {}) => ({ state: 'stopped', reason: 'sections-left', action: 'topup', questionsKept: 17, questionsGoal: 19, questionsMissing: 2, planned: true, continueKind: 'rounds', units: 'page',
  sectionsTotal: 14, sectionsCovered: 12, sectionsUncovered: 2, sectionsUnderQuota: 0, coveragePercent: 86, afterRoundPercent: 100, roundsToFull: 1, questionsToFull: 2, nextRoundSections: 2, nextRoundQuestions: 2,
  sectionsAfterNextRound: 0, roundsLeft: 1, roundsDone: 1, round: 2, level: 'standard', stop, repeating: [p18, p19], ended: null, ...over });
const planBlock = (language = 'zh', props = {}) => render(React.createElement(m.RunLine, { task: { ...job(), contract: jobContract(job()) }, shortfall: shortfall(), now: Date.parse(at(60)), ...props }), language);

test('the plan block of the stopped run: every line has its numbers, and the explanation is there to open', () => {
  const html = planBlock(), said = text(html);
  assert.match(said, /出题计划 停在第 1 轮之后 · 补做 1 次没成功 · 覆盖 86% · 共用 263K tok/);
  assert.match(said, /已出 17\/19 题 · 还有 2 页没有题 · 下一轮补 2 页/);
  assert.match(said, /覆盖现在 12\/14 页（86%）→ 本轮后约 100% → 目标 100%，还要 1 轮、约 2 题/);
  assert.match(said, /补做了 1 次（第 2 轮）后，还有 2 页没出成题（第 18、19 页），已经停下；自动补题不再重试它们。/);
  assert.match(said, /这几个小节反复失败：第 18 页（要 3 个考点，只给出 1 个 · 已试 2 次）、第 19 页（要 3 个考点，只给出 2 个 · 已试 2 次）/);
  for (const phrase of ['第 18 页：计划需要 3 个考点，模型只给出了 1 个 · 已试 2 次（第 1 轮、补做第 2 轮）', '补问一次后，模型仍只给出 1 个', '为没覆盖的部分补题', '设置 › 出题偏好', '已出的题都保留，现在覆盖 86%，已经可以练习']) assert.ok(said.includes(phrase), phrase);
  assert.doesNotMatch(said, /几轮|若干|不够数/);
  assert.match(html, /<details[^>]*data-repeating-explain/);
});

test('the explanation offers the controls the console has: the page in the reader and the generation preferences, when the host can open them', () => {
  const calls = [];
  const html = planBlock('zh', { onOpenSource: (...args) => calls.push(['source', ...args]), onOpenSettings: (...args) => calls.push(['settings', ...args]) });
  assert.match(html, /data-open-page="pdf#p18"/);
  assert.match(html, /data-open-settings="settings-generation"/);
  assert.doesNotMatch(planBlock(), /data-open-page/, 'without a host that can open them there is no button that does nothing');
});

test('the same plan block in English has no Chinese in it', () => {
  const said = text(planBlock('en'));
  assert.doesNotMatch(said, han, (/.{0,40}[㐀-鿿].{0,40}/.exec(said) || [''])[0]);
  assert.match(said, /Coverage plan Stopped after round 1 · 1 retry did not work · Covered 86%/);
  assert.match(said, /Page 18: the plan needs 3 knowledge points, the model gave only 1/);
});

test('the draft page says the failing sections with the same sentences as the console', () => {
  const html = render(React.createElement(m.RunPanel, { draft: { id: 'd1', title: 'T', draftVersion: 1, cards: [{ id: 'c' }], editorial: { requested: 19, generation: { sourceIds: ['pdf'] }, coverageSpec: { version: 1, level: 'standard', goal: 19, quotas: [], rounds: [{ round: 1, questions: 4, sectionIds: ['pdf#p18'], status: 'done' }], attempts: { 'pdf#p18': { n: 2, reason: 'plan-short', round: 2, rounds: [{ round: 1 }, { round: 2, fill: true }], short: p18.short } } }, coverageRun: { jobId: 'run-1', state: 'stopped', autoComplete: true, tokensUsed: 5, stop } } },
    view: { status: 'ok', canTopUp: true, coverage: { percentLeaves: 86, units: 'page', leaves: 14, covered: 12, sections: [{ key: 'pdf#p18', id: 'p18', title: '', page: 18, state: 'planned-failed', reason: 'plan-short', cards: 0, start: 1000, end: 2600, sourceId: 'pdf' }] }, round: { sections: 1, questions: 3, rounds: 1, left: 0, allQuestions: 3 } }, jobs: [] }));
  assert.match(text(html), /第 18 页（要 3 个考点，只给出 1 个 · 已试 2 次）/);
  assert.match(text(html), /补问一次后，模型仍只给出 1 个/);
});

const eventsOf = () => [
  { id: 'e1', at: at(1), level: 'info', code: 'stage', args: { stage: 'planning', group: 1, groups: 1 }, text: 'Planning evidence and learning targets · Group 1/1' },
  { id: 'e2', at: at(5), level: 'info', code: 'stage', args: { stage: 'parallel', batches: 3 }, text: 'Parallel generation · up to 3 batches' },
  { id: 'e3', at: at(20), level: 'done', code: 'round-end', args: { round: 1, rounds: 1, status: 'done', kept: 2, covered: 2, tried: 4, unit: 'page', percent: 86, lost: [lost18, lost19], lostCount: 2 } },
  { id: 'e4', at: at(21), level: 'done', code: 'round-start', args: { round: 2, rounds: 2, sections: 2, questions: 2, fill: true, unit: 'page', names: [{ page: 18 }, { page: 19 }], from: [1] } },
  { id: 'e5', at: at(30), level: 'warn', code: 'round-end', args: { round: 2, rounds: 2, status: 'failed', fill: true, kept: 0, covered: 0, tried: 2, unit: 'page', code: 'plan-short', lost: [lost18, lost19], lostCount: 2 } },
  { id: 'e6', at: at(31), level: 'warn', code: 'run-stop', args: stop },
  { id: 'e7', at: at(40), level: 'done', code: 'status', args: { status: 'complete' }, text: 'Draft ready' }];

test('the 日志 of the run reads the same facts as the plan block, in compact lines', () => {
  const lines = m.logLines({ events: eventsOf(), calls: [], detail: {} }, 'all').map(line => line.text);
  assert.deepEqual(lines, ['任务完成',
    '补做了 1 次（第 2 轮）后，还有 2 页没出成题（第 18、19 页），已经停下；自动补题不再重试它们。',
    '补做第 2 轮没做成：保留 0 题，新覆盖 0/2 页 · 原因：模型给出的考点比计划的少 · 没出成题：第 18 页（要 3 个考点，只给出 1 个）、第 19 页（要 3 个考点，只给出 2 个）',
    '补做第 2 轮开始 · 重试第 1 轮里没出成题的 2 页（第 18、19 页），2 题',
    '第 1/1 轮完成：保留 2 题，新覆盖 2/4 页 · 覆盖 86% · 没出成题：第 18 页（要 3 个考点，只给出 1 个）、第 19 页（要 3 个考点，只给出 2 个）',
    '并行生成 · 最多 3 批同时进行',
    '生成前：规划考点与证据边界']);
  inLanguage('en', () => {
    const english = m.logLines({ events: eventsOf(), calls: [], detail: {} }, 'all').map(line => line.text);
    for (const line of english) assert.doesNotMatch(line, han, line);
    assert.ok(english.includes('Parallel generation · up to 3 batches'));
    assert.ok(english.includes('Planning evidence and learning targets'));
  });
});

test('the two English lines of the old log are translated through the event code: a stage event carries its words as args, an older record is read by its text', () => {
  assert.deepEqual(stageArgsOf('Parallel generation · up to 3 batches'), { stage: 'parallel', batches: 3 });
  assert.deepEqual(stageArgsOf('Planning evidence and learning targets · Group 2/4'), { stage: 'planning', group: 2, groups: 4 });
  assert.deepEqual(stageArgsOf('Planning evidence and learning targets · Fill round 2'), { stage: 'planning', fill: 2 });
  assert.equal(stageArgsOf('Part 2/3 · Writing and self-checking questions'), null, 'a stage this table does not know keeps its prose as the fallback');
  assert.equal(stageArgsOf(''), null);
  assert.equal(stageArgsOf(undefined), null);
  const job = { id: 'j', type: 'generation', status: 'running', stage: 'Parallel generation · up to 3 batches' };
  observeJob(job);
  job.stage = 'Planning evidence and learning targets · Group 1/2';
  observeJob(job);
  const stages = job.events.filter(event => event.code === 'stage');
  assert.deepEqual(stages.map(event => event.args), [{ stage: 'planning', group: 1, groups: 2 }]);
  assert.equal(stages[0].text, 'Planning evidence and learning targets · Group 1/2', 'the prose stays as the fallback for an agent and an older UI');
  const old = m.logLines({ events: [{ id: 'o1', at: at(1), level: 'step', code: 'stage', text: 'Parallel generation · up to 3 batches' }, { id: 'o2', at: at(2), level: 'step', code: 'stage', text: 'Planning evidence and learning targets · Group 1/1' }], calls: [] }, 'all').map(line => line.text);
  assert.deepEqual(old, ['生成前：规划考点与证据边界', '并行生成 · 最多 3 批同时进行'], 'an older record without args reads in Chinese too, newest first');
  inLanguage('en', () => assert.deepEqual(m.logLines({ events: [{ id: 'x', at: at(1), level: 'step', code: 'stage', args: { stage: 'planning', group: 2, groups: 3 }, text: 'Planning evidence and learning targets · Group 2/3' }], calls: [] }, 'all').map(line => line.text),
    ['Planning evidence and learning targets · Group 2/3']));
});

test('the rounds list says the same of a round as the log does: which of its sections came out', () => {
  const html = render(React.createElement(m.RunRounds, { run: { list: rounds, done: 1, total: 2 }, draft: null, coverage: null }));
  assert.match(text(html), /补做 · 第 2 轮 · 2 题 · 2 页/);
  assert.match(text(html), /保留 0 题，新覆盖 0\/2 页 · .* · 原因：模型给出的考点比计划的少/);
  assert.match(text(html), /第 1 轮 · 4 题 · 4 页/);
  assert.match(text(html), /保留 2 题，新覆盖 2\/4 页/);
});
