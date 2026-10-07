import test from 'node:test';
import assert from 'node:assert/strict';
import { loadUi } from './helpers/ui-module.mjs';
import { describePartReport as agentReport } from '../lib/generation-report.js';

/* The wording of the owner's record of 2026-10-08 (a retry round that kept 5 questions, 「新覆盖 0/15」, and sections that said 「被停止」 though nobody stopped anything), in both languages:
   a stop says who stopped it and why; a round that kept questions and credited no section says that, plainly, and is no progress. */

const m = await loadUi(`
  export * as copy from './ui/coverage/copy.js';
  export { describePartReport } from './ui/draft-shortfall.js';
  export { setUiLanguage } from './ui/i18n.js';
`);
const han = /[㐀-鿿]/;
const inLanguage = (language, run) => { m.setUiLanguage(language); try { return run(); } finally { m.setUiLanguage('zh'); } };
const ENGLISH_ROUND = (round) => ({ ...round, lost: round.lost.map((item, index) => ({ ...item, title: `Part ${13 + index}` })) });

const OWNER_ROUND = { round: 7, rounds: 7, status: 'done', fill: true, kept: 5, covered: 0, uncredited: 5, tried: 15, unit: 'part', percent: 76, lostCount: 15,
  lost: [{ title: '第十三部分：分层架构边界与 API 缓存位置', reason: 'cancelled' }, { title: '第十六部分：统一接口四要素与 RMM 合规', reason: 'budget' }, { title: '第十七部分：RMM 语义、分层架构与缓存层级', reason: 'unavailable' }] };

test('a round that kept questions and credited no section says so, in Chinese and in English (never a bare 「新覆盖 0/15」)', () => {
  const zh = inLanguage('zh', () => m.copy.runEventText('round-end', OWNER_ROUND));
  assert.match(zh, /补做第 7 轮完成：保留 5 题，新覆盖 0\/15 个小节 · 5 道题通过了审阅，但没有对上任何小节 · 覆盖 76%/);
  const en = inLanguage('en', () => m.copy.runEventText('round-end', ENGLISH_ROUND(OWNER_ROUND)));
  assert.match(en, /5 question\(s\) passed review but were not credited to any section/);
  assert.doesNotMatch(en, han);
  const quiet = inLanguage('zh', () => m.copy.runEventText('round-end', { ...OWNER_ROUND, uncredited: undefined, covered: 3 }));
  assert.doesNotMatch(quiet, /没有对上任何小节/, 'a round that credited sections says nothing of the kind');
  const result = inLanguage('zh', () => m.copy.roundResult({ status: 'done', kept: 5, covered: 0, sections: 15, unit: 'part', uncredited: 5 }));
  assert.match(result, /保留 5 题，新覆盖 0\/15 个小节 · 5 道题通过了审阅，但没有对上任何小节/);
  assert.equal(m.copy.uncreditedText(0), '');
});

test('a stopped section says who stopped it and why; a request the service cut off is the service\'s, not a stop', () => {
  const zh = inLanguage('zh', () => m.copy.runEventText('round-end', OWNER_ROUND));
  assert.match(zh, /（因为你停止了任务）/);
  assert.match(zh, /（因为这一轮的时间用完了，没做完的批次被停止）/);
  assert.match(zh, /（模型服务暂时不可用，或中断了这次请求）/);
  assert.doesNotMatch(zh, /（被停止）/, 'no bare 「被停止」 any more');
  const en = inLanguage('en', () => m.copy.runEventText('round-end', ENGLISH_ROUND(OWNER_ROUND)));
  assert.match(en, /\(because you stopped the task\)/);
  assert.match(en, /\(because the time for this round ran out; the batches that were not finished were stopped\)/);
  assert.match(en, /\(the model service is temporarily unavailable, or it cut the request off\)/);
  assert.doesNotMatch(en, han);
  assert.equal(inLanguage('zh', () => m.copy.failedWhy('cancelled')), '原因：因为你停止了任务');
  assert.equal(inLanguage('zh', () => m.copy.failedWhy('budget')), '原因：因为这一轮的时间用完了，没做完的批次被停止');
});

test('the part report says who stopped the batches in the job card, the draft page and for the agent', () => {
  const report = { total: 4, passed: 1, partial: 0, failed: 3, reasons: { cancelled: 1, budget: 1, unavailable: 1 } };
  const zh = inLanguage('zh', () => m.describePartReport(report).reasons.join('；'));
  assert.match(zh, /1 个批次因为你停止了任务而没有完成/);
  assert.match(zh, /1 个批次因为这一轮的时间用完了而被停止，没有完成/);
  const en = inLanguage('en', () => m.describePartReport(report).reasons.join('; '));
  assert.match(en, /1 batch\(es\) did not finish because you stopped the task/);
  assert.match(en, /1 batch\(es\) were stopped because the time for this round ran out/);
  assert.doesNotMatch(en, han);
  assert.match(agentReport(report, 'en'), /because you stopped the task.*because the time for this round ran out|because the time for this round ran out.*because you stopped the task/);
  assert.match(agentReport(report, 'zh'), /因为你停止了任务/);
});

test('a run that stops because a round kept questions and credited none says so, with what to do next', () => {
  const stop = { reason: 'no-progress', round: 7, left: 26, uncredited: 5 };
  assert.equal(inLanguage('zh', () => m.copy.stopText(stop)), '第 7 轮保留了 5 道题，但它们没有对上任何还没有题的小节，没有新的进展，为免一直重复，已经停下；还有 26 个小节没有题，可以点「为没覆盖的部分补题」再试。');
  const en = inLanguage('en', () => m.copy.stopText(stop));
  assert.match(en, /Round 7 kept 5 question\(s\), but none of them was credited to a section that had no question/);
  assert.doesNotMatch(en, han);
  assert.match(inLanguage('zh', () => m.copy.stopText({ reason: 'no-progress', round: 7, left: 26 })), /重试后仍没有补到新的小节/, 'a stop without the number reads as it did');
});
