import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { loadUi } from './helpers/ui-module.mjs';
import { inApp } from './helpers/fake-app.mjs';
import { draftView, seedView } from './helpers/coverage-view.mjs';

/* After a failure the learner is offered to CONTINUE (the owner's report of 2026-10-06: 「失败后也没有提供重试或者接续」): a plain run that was asked for 15 questions and kept 13 when its time
   ran out says why (the one sentence of describeFailure), what 接着做 will do (「已出 13/15 题保留，接着补 2 题」), and offers ONE primary action on the home banner, the 待发布 row, the 任务 console
   and the draft page; it is never told about 94 sections it did not promise. 为没覆盖的部分补题 stays, as the other, deliberate thing, and says the way to full coverage before it starts.
   Static markup in Chinese and English; every number is lib/shortfall.js's. */

const m = await loadUi(`
  export { AppContext } from './ui/app/app-context.js';
  export { StudyServicesContext } from './ui/study-context.jsx';
  export { default as HomeActivity, HomeDrafts } from './ui/study-map/HomeActivity.jsx';
  export { default as TaskConsole } from './ui/tasks/TaskConsole.jsx';
  export { CoverageTopUp } from './ui/coverage/CoverageTopUp.jsx';
  export { PartCoverage } from './ui/coverage/PartCoverage.jsx';
  export { seedCoverage, forgetCoverage } from './ui/coverage/use-coverage.js';
  export * as copy from './ui/coverage/copy.js';
  export { shortfallOf } from './lib/shortfall.js';
  export { taskSummary } from './ui/tasks/task-summary.js';
  export { setUiLanguage } from './ui/i18n.js';
`);
const text = html => html.replace(/<[^>]+>/g, ' ').replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&#x27;/g, "'").replace(/\s+/g, ' ').trim();
let current = 'zh';
const inLanguage = (language, run) => { const before = current; m.setUiLanguage(language); current = language; try { return run(); } finally { m.setUiLanguage(before); current = before; } };
const at = seconds => new Date(Date.UTC(2026, 9, 6, 10, 0, seconds)).toISOString();
const noop = () => {};
const render = (element, { language = 'zh', data = {} } = {}) => inLanguage(language, () => renderToStaticMarkup(inApp(m, element, { data, app: { lib: { taskFocus: null }, host: {}, settingsEntry: { openModelSettings: noop } } })));
const buttonsOf = html => [...html.matchAll(/<button[^>]*>([\s\S]*?)<\/button>/g)].map(match => text(match[1]).replace(/\s*→$/, ''));

const view = draftView({ draftId: 'd1', draftVersion: 3, covered: ['r1.p1', 'r1.p2', 'r2.p1', 'r3.p1'] });
const left = view.coverage.leaves - view.coverage.covered;
const KEPT = 13, ASKED = 15;
const draft = { id: 'd1', title: 'Recovered questions', draftVersion: 3, folder: '', cards: Array.from({ length: KEPT }, (_, i) => ({ id: `c${i}`, kind: 'quiz' })),
  editorial: { requested: ASKED, generation: { sourceIds: ['s'], kind: 'quiz' } } };
const BUDGET = 'Generation reached its 20-minute total budget; approved questions were retained';
const failed = (over = {}) => ({ id: 'j1', type: 'generate', status: 'failed', stage: BUDGET, deckTitle: 'Recovered questions', draftId: 'd1', kind: 'quiz', count: ASKED, requestedTotal: ASKED, savedCount: KEPT, parts: 2, steps: [],
  retryable: true, startedAt: at(0), finishedAt: at(100), ...over });
const dataOf = (jobs, extra = {}) => ({ revision: undefined, jobs, drafts: [draft], decks: [], sources: [], model: { ready: true }, ...extra });
const seed = () => { m.forgetCoverage(); seedView(m, view); };
const HomeBoth = (props) => React.createElement(React.Fragment, null, React.createElement(m.HomeActivity, props), React.createElement(m.HomeDrafts, { ...props, defaultOpen: true }));
const home = (jobs, language = 'zh') => { seed(); const d = dataOf(jobs); return render(React.createElement(HomeBoth, { jobs: d.jobs, drafts: d.drafts, busy: false, openDraft: noop, openAgent: noop, cancelJob: noop, dismissJob: noop, retryGeneration: noop,
  manage: noop, start: noop, topUpDraft: noop, openModelSettings: noop, modelReady: true, data: d }), { language, data: d }); };
const consoleOf = (jobs, language = 'zh') => { seed(); const d = dataOf(jobs); return render(React.createElement(m.TaskConsole, { data: d, openers: { resultOf: () => null } }), { language, data: d }); };
const pageOf = (jobs, language = 'zh') => { seed(); const d = dataOf(jobs); return render(React.createElement(m.CoverageTopUp, { draft, view, jobs: d.jobs, onTopUp: noop }), { language, data: d }); };
const shortfall = jobs => m.shortfallOf({ draft, coverage: view.coverage, round: view.round, job: jobs[0] });
const banner = html => html.match(/<article[\s\S]*?<\/article>/)[0], row = html => /<div class="draft-row">[\s\S]*$/.exec(html)[0];

test('the fixture is the owner\'s: 13 of the 15 questions asked for, sections without a question, a time limit that ended it', () => {
  const s = shortfall([failed()]);
  assert.deepEqual([s.questionsKept, s.questionsGoal, s.questionsMissing, s.planned, s.action], [KEPT, ASKED, 2, false, 'continue']);
  assert.ok(left > 1);
});

test('the home banner: why (the time limit), what 接着做 does (13 of 15 kept, 2 more), ONE primary action, and no sections it never promised', () => {
  const html = home([failed()]), said = text(banner(html));
  assert.ok(said.includes('生成用时太长，已自动停止'), `the reason: ${said}`);
  assert.ok(said.includes(`已出 ${KEPT}/${ASKED} 题保留，接着补 ${ASKED - KEPT} 题`), `what 接着做 does: ${said}`);
  assert.doesNotMatch(said, /个小节没有题|小节没有题/, `a plain run promised questions, not sections: ${said}`);
  const buttons = buttonsOf(banner(html));
  assert.ok(buttons.includes('接着做'), `the banner continues: ${buttons}`);
  assert.ok(!buttons.includes('为没覆盖的部分补题'), `the top-up does not compete on the banner: ${buttons}`);
  assert.equal(buttons.filter(label => ['接着做', '为没覆盖的部分补题', '去配置模型', '打开草稿'].includes(label)).length, 1, `one primary action: ${buttons}`);
  inLanguage('en', () => {
    const english = text(banner(home([failed()], 'en')));
    assert.match(english, /13\/15 questions made and kept; Continue makes the 2 still missing/, english);
    assert.match(buttonsOf(banner(home([failed()], 'en'))).join('|'), /Continue/);
  });
});

test('the 待发布 row says the same: the count, the reason in its badge, the one action; no section count', () => {
  const html = row(home([failed()])), said = text(html);
  assert.ok(said.includes(`已出 ${KEPT}/${ASKED} 题`), said);
  assert.match(said, /已停止 · 用时到限/);
  assert.doesNotMatch(said, /还有 \d+ 个小节没有题/, said);
  assert.deepEqual(buttonsOf(html).filter(label => ['接着做', '为没覆盖的部分补题'].includes(label)), ['接着做']);
});

test('the console: the header continues (one primary), the top-up is beside it as the other thing, and the goal is 13 / 15 everywhere', () => {
  const html = consoleOf([failed()]), said = text(html), buttons = buttonsOf(html);
  assert.ok(buttons.includes('接着做'), buttons.join('|'));
  assert.ok(buttons.includes('为没覆盖的部分补题'), 'the top-up is still there');
  assert.match(html, /<button[^>]*class="[^"]*primary[^"]*"[^>]*>[^<]*接着做/, 'and 接着做 is the primary one');
  assert.ok(said.includes(`${KEPT} / ${ASKED}`), `the console counts ${KEPT} / ${ASKED}: ${said.slice(0, 600)}`);
  assert.ok(said.includes(`已出 ${KEPT}/${ASKED} 题保留，接着补 ${ASKED - KEPT} 题`), `the strip says what 接着做 does: ${said}`);
});

test('the draft page offers the same 接着做 with the same sentence, and the top-up beside it, saying the way to full coverage', () => {
  const html = pageOf([failed()]), said = text(html);
  assert.ok(said.includes(`已出 ${KEPT}/${ASKED} 题保留，接着补 ${ASKED - KEPT} 题`), said);
  assert.ok(buttonsOf(html).includes('接着做'));
  const path = m.copy.coveragePathText(shortfall([failed()]));
  assert.ok(path && said.includes(path), `the top-up says where it goes: ${path}`);
  assert.match(path, /^覆盖现在 \d+\/\d+ 个小节（\d+%）→ 本轮后约 \d+% → 目标 100%，还要 \d+ 轮、约 \d+ 题$/);
  inLanguage('en', () => assert.match(m.copy.coveragePathText(shortfall([failed()])), /^Coverage now \d+\/\d+ sections \(\d+%\) → about \d+% after this round → target 100%, \d+ more rounds?, about \d+ questions$/));
});

test('a failed run that was already continued stays in the list as 接着做过了: its numbers are frozen and its buttons are gone', () => {
  const old = failed({ continuedBy: 'j2' }), html = consoleOf([old]), said = text(html);
  assert.ok(!buttonsOf(html).includes('接着做'), 'no continue button on a record that was continued');
  assert.match(said, /接着做过了/, said);
  assert.ok(said.includes(`${KEPT} / ${ASKED}`), 'it keeps its own numbers');
  assert.equal(m.taskSummary(old).line.includes('接着做过了'), true, `the list row says it: ${m.taskSummary(old).line}`);
});

test('a refused key: 去配置模型 is the primary action on the banner, and the console also offers 接着做 for when the key works', () => {
  const refused = failed({ stage: 'Part 1: 401 Unauthorized: Invalid API key' });
  const bannerButtons = buttonsOf(banner(home([refused])));
  assert.ok(bannerButtons.includes('去配置模型'), bannerButtons.join('|'));
  assert.ok(!bannerButtons.includes('接着做'));
  assert.ok(buttonsOf(consoleOf([refused])).includes('接着做'));
  assert.doesNotMatch(text(banner(home([refused]))), /Unauthorized|Invalid API key/);
});

test('while a top-up is the question, 本轮 is said with its way: coverage now, after the round, the target, how many rounds and questions', () => {
  const s = shortfall([failed()]);
  assert.equal(s.roundsToFull, view.round.rounds);
  assert.equal(s.questionsToFull, view.round.allQuestions);
  const path = m.copy.coveragePathText(s);
  assert.ok(path.includes(`${view.coverage.covered}/${view.coverage.leaves} 个小节`), path);
  assert.ok(path.includes(`约 ${view.round.allQuestions} 题`), path);
});

test('a batch that has not finished does not say 「覆盖 0/10 小节」: it says the sections it covers count once its questions are saved', () => {
  const range = { leaves: 10, covered: 0, plannedFailed: 0, neverPlanned: 10, scheduled: 0 };
  const waiting = text(render(React.createElement(m.PartCoverage, { range, units: 'part', pending: true })));
  assert.match(waiting, /10 个小节（出完后计入覆盖）/);
  assert.doesNotMatch(waiting, /覆盖 0\/10/);
  assert.match(text(render(React.createElement(m.PartCoverage, { range, units: 'part', pending: false }))), /覆盖 0\/10 小节/, 'a batch that finished and covered nothing says so');
  assert.match(text(render(React.createElement(m.PartCoverage, { range: { ...range, covered: 3 }, units: 'part', pending: true }))), /覆盖 3\/10 小节/, 'sections that already have a question are said as they are');
});

test('an older record that never knew about continuing (no retryable mark) still points at the draft that owes questions: 接着做 is the draft\'s, in the console header too', () => {
  const html = consoleOf([failed({ retryable: undefined })]);
  assert.match(html, /data-draft-continue/, 'the header offers the draft\'s 接着做');
  assert.equal(buttonsOf(html).filter(label => label === '接着做').length, 1, 'one 接着做, never two');
  const withRetry = consoleOf([failed()]);
  assert.doesNotMatch(withRetry, /data-draft-continue/, 'a record that can be continued itself uses its own button');
  assert.doesNotMatch(consoleOf([failed({ continuedBy: 'j2' })]), /data-draft-continue/, 'a continued record offers nothing');
});

test('the banner of an older failed record (no retryable mark) still says why and what 接着做 does', () => {
  const said = text(banner(home([failed({ retryable: undefined })])));
  assert.ok(said.includes('生成用时太长，已自动停止') && said.includes(`已出 ${KEPT}/${ASKED} 题保留，接着补 ${ASKED - KEPT} 题`), said);
  assert.ok(buttonsOf(banner(home([failed({ retryable: undefined })]))).includes('接着做'));
});
