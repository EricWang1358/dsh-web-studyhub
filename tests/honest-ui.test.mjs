import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { loadUi } from './helpers/ui-module.mjs';
import { inApp } from './helpers/fake-app.mjs';
import { draftView, seedView } from './helpers/coverage-view.mjs';

/* The honest states on screen (the evaluation of 2026-10-06, D-1 D-2 D-5 D-6 D-10 D-12 D-16 and the default of 精简): the home banner, the 待发布 row, the 任务 console and the draft page tell ONE story
   about a draft that is short, stopped, refused, interrupted or paused: the same questions, the same sections, the same next round, the same ONE action; no screen says 100% while questions are
   missing; a refused key is one plain sentence; 小节 is the coverage unit and 批次 a generation batch. Static markup in Chinese and English; every number is lib/shortfall.js's. */

const m = await loadUi(`
  export { AppContext } from './ui/app/app-context.js';
  export { StudyServicesContext } from './ui/study-context.jsx';
  export { default as HomeActivity } from './ui/study-map/HomeActivity.jsx';
  export { default as TaskConsole } from './ui/tasks/TaskConsole.jsx';
  export { default as RunPanel } from './ui/coverage/RunPanel.jsx';
  export { CoverageTopUp } from './ui/coverage/CoverageTopUp.jsx';
  export { default as CoverageStrength } from './ui/coverage/CoverageStrength.jsx';
  export { seedCoverage, forgetCoverage } from './ui/coverage/use-coverage.js';
  export * as copy from './ui/coverage/copy.js';
  export { shortfallOf } from './lib/shortfall.js';
  export { jobContract } from './lib/job-contract.js';
  export { taskSummary } from './ui/tasks/task-summary.js';
  export { setUiLanguage } from './ui/i18n.js';
`);
const han = /[㐀-鿿]/;
const text = html => html.replace(/<[^>]+>/g, ' ').replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&#x27;/g, "'").replace(/\s+/g, ' ').trim();
let current = 'zh';
const inLanguage = (language, run) => { const before = current; m.setUiLanguage(language); current = language; try { return run(); } finally { m.setUiLanguage(before); current = before; } };
const at = seconds => new Date(Date.UTC(2026, 9, 6, 10, 0, seconds)).toISOString();
const noop = () => {};
const render = (element, { language = 'zh', data = {} } = {}) => inLanguage(language, () => renderToStaticMarkup(inApp(m, element, { data, app: { lib: { taskFocus: null }, host: {}, settingsEntry: { openModelSettings: noop } } })));

/* ---------- a draft of a plan of 9 rounds that stopped short: 12 sections of a small transcript, 4 of them covered, 174 questions of 251 ---------- */
const GOAL = 251, KEPT = 174;
const view = draftView({ draftId: 'd1', draftVersion: 3, covered: ['r1.p1', 'r1.p2', 'r2.p1', 'r2.p2', 'r2.p3', 'r3.p1', 'r3.p2', 'r3.p3', 'r3.p4', 'r1.p3'], failed: ['r1.p4'] });
const left = view.coverage.leaves - view.coverage.covered;   // sections without a question
const plan = (statuses, over = {}) => ({ version: 1, level: 'standard', goal: GOAL, leaves: view.coverage.leaves, mustCover: view.coverage.leaves, weightSource: 'model', weights: [], quotas: [],
  rounds: statuses.map((status, index) => ({ round: index + 1, questions: 28, sectionIds: [`s#${index}`], ...(status ? { status } : {}), ...(status === 'done' ? { kept: 20, covered: 1, tokens: 300_000, ms: 60_000 } : {}) })), ...over });
const draftOf = ({ marker, statuses = Array(9).fill('done'), cards = KEPT, over = {}, requested = 28 } = {}) => ({ id: 'd1', title: 'Platform lectures', draftVersion: 3, folder: '', cards: Array.from({ length: cards }, (_, i) => ({ id: `c${i}`, kind: 'quiz' })),
  editorial: { requested, generation: { sourceIds: ['s'], kind: 'quiz' }, coverageSpec: plan(statuses, over), ...(marker ? { coverageRun: marker } : {}) } });
const stopped = (stop, extra = {}) => ({ jobId: 'j1', autoComplete: true, state: 'stopped', startedAt: at(0), updatedAt: at(100), tokensUsed: 2_800_000, stop: { reason: 'sections-left', at: at(100), round: 10, left, ...stop }, ...extra });
const mirror = (state, over = {}) => ({ autoComplete: true, state, percent: view.coverage.percentLeaves, tokensUsed: 2_800_000, startedAt: at(0), list: Array.from({ length: 9 }, (_, i) => ({ round: i + 1, questions: 28, status: 'done', fill: false, sections: 1, kept: 20, covered: 1, tokens: 300_000, ms: 60_000 })), ...over });
const jobOf = (over = {}, run = {}) => ({ id: 'j1', status: 'complete', deckTitle: 'Platform lectures', draftId: 'd1', kind: 'quiz', count: 28, requestedTotal: GOAL, savedCount: KEPT, parts: 3, steps: [], startedAt: at(0), finishedAt: at(100),
  coveragePlan: { level: 'standard', goal: GOAL, rounds: 9 }, coverageRun: mirror('stopped', { stop: { reason: 'sections-left', round: 10, left }, ...run }), ...over });

/** Each state of a draft as the surfaces see it: the draft, its job, and what the evaluation printed for it. */
const STATES = {
  stopped: { draft: draftOf({ marker: stopped({}) }), job: jobOf({ retryable: false }), action: 'topup' },
  refused: { draft: draftOf({ cards: 24, marker: stopped({ reason: 'refused', code: 'credential', round: 2 }) }), job: jobOf({ status: 'failed', retryable: true, savedCount: 24, stage: 'Part 1: 401 Unauthorized: Invalid API key; Part 2: 401 Unauthorized: Invalid API key; Part 3: 401 Unauthorized: Invalid API key; Part 4: 401 Unauthorized: Inval',
    contract: undefined }, { stop: { reason: 'refused', round: 2, code: 'credential' } }), action: 'model-settings' },
  interrupted: { draft: draftOf({ cards: 57, statuses: ['done', 'done', 'pending', ...Array(6).fill('pending')], marker: { jobId: 'j1', autoComplete: true, state: 'running', startedAt: at(0), updatedAt: at(50), tokensUsed: 451_000 } }),
    job: jobOf({ status: 'interrupted', retryable: true, savedCount: 57, stage: 'The last run was interrupted before round 3' }, { state: 'running', stop: undefined, list: mirror('running').list.map((round, i) => ({ ...round, status: i < 2 ? 'done' : 'pending' })) }), action: 'continue' },
  paused: { draft: draftOf({ cards: 80, statuses: ['done', 'done', 'done', ...Array(6).fill('pending')], marker: { jobId: 'j1', autoComplete: true, state: 'paused', startedAt: at(0), updatedAt: at(50), tokensUsed: 800_000 } }),
    job: jobOf({ status: 'running', paused: true, savedCount: 80, control: { values: { concurrency: 4, autoComplete: true, paused: true }, limits: {} }, finishedAt: undefined }, { state: 'paused', stop: undefined, list: mirror('paused').list.map((round, i) => ({ ...round, status: i < 3 ? 'done' : 'pending' })) }), action: 'resume' },
};
const data = (state, extra = {}) => ({ revision: undefined, jobs: [STATES[state].job], drafts: [STATES[state].draft], decks: [], sources: [], model: { ready: true }, ...extra });
const seed = () => { m.forgetCoverage(); seedView(m, view); };
const home = (state, language = 'zh') => { seed(); const d = data(state); return render(React.createElement(m.HomeActivity, { jobs: d.jobs, drafts: d.drafts, busy: false, openDraft: noop, openAgent: noop, cancelJob: noop, dismissJob: noop, retryGeneration: noop, manage: noop,
  start: noop, topUpDraft: noop, openModelSettings: noop, modelReady: true, data: d }), { language, data: d }); };
const consoleOf = (state, language = 'zh') => { seed(); const d = data(state); return render(React.createElement(m.TaskConsole, { data: d, openers: { resultOf: () => null } }), { language, data: d }); };
const pageOf = (state, language = 'zh') => { seed(); const d = data(state), draft = STATES[state].draft; return render(React.createElement(React.Fragment, null,
  React.createElement(m.RunPanel, { draft, view, jobs: d.jobs }), React.createElement(m.CoverageTopUp, { draft, view, jobs: d.jobs, onTopUp: noop })), { language, data: d }); };
const shortfall = state => m.shortfallOf({ draft: STATES[state].draft, coverage: view.coverage, round: view.round, job: STATES[state].job });
const buttonsOf = html => [...html.matchAll(/<button[^>]*>([\s\S]*?)<\/button>/g)].map(match => text(match[1]));

test('the fixture is what the evaluation printed: 174 of 251 questions, sections without a question, the next round in view', () => {
  const s = shortfall('stopped');
  assert.deepEqual([s.questionsKept, s.questionsGoal, s.questionsMissing, s.state], [KEPT, GOAL, GOAL - KEPT, 'stopped']);
  assert.equal(s.sectionsUncovered, left);
  assert.ok(left >= 2, `${left} sections have no question`);
  assert.equal(s.nextRoundSections, view.round.sections);
  assert.equal(shortfall('refused').state, 'refused');
  assert.equal(shortfall('interrupted').state, 'interrupted');
  assert.equal(shortfall('paused').state, 'paused');
});

test('ONE story: the banner, the row, the console and the draft page say the same questions, the same sections and the same next round (D-2)', () => {
  const s = shortfall('stopped'), line = m.copy.shortfallLine(s), next = m.copy.nextRoundText(s);
  assert.equal(line, `已出 ${KEPT}/${GOAL} 题 · 还有 ${m.copy.countOf(s.units, left)}没有题`);
  assert.match(next, new RegExp(`^下一轮补 ${m.copy.countOf(s.units, s.nextRoundSections)}`));
  const banner = text(home('stopped').match(/<article[\s\S]*?<\/article>/)[0]);
  assert.ok(banner.includes(line), `the banner says it: ${banner}`);
  const row = text(/<div class="draft-row">[\s\S]*$/.exec(home('stopped'))[0]);
  assert.ok(row.includes(line), `the row says it: ${row}`);
  assert.ok(row.includes(next), `the row says the next round: ${row}`);
  const consoleText = text(consoleOf('stopped'));
  assert.ok(consoleText.includes(line), `the console says it: ${consoleText}`);
  assert.ok(consoleText.includes(next), `the console says the next round: ${consoleText}`);
  const page = text(pageOf('stopped'));
  assert.ok(page.includes(line), `the draft page says it: ${page}`);
  assert.ok(page.includes(next), `the draft page says the next round: ${page}`);
  for (const old of ['少了', '这一轮补', '可以打开草稿补齐', '草稿待补齐 ·']) for (const [where, said] of [['banner', banner], ['row', row], ['console', consoleText], ['page', page]]) assert.ok(!said.includes(old), `${where} still says 「${old}」`);
  inLanguage('en', () => {
    const english = m.copy.shortfallLine(s);
    assert.equal(english, `Made ${KEPT}/${GOAL} questions · ${m.copy.countOf(s.units, left)} still without a question`);
    assert.ok(text(home('stopped', 'en')).includes(english));
    assert.ok(text(consoleOf('stopped', 'en')).includes(english));
    assert.match(m.copy.nextRoundText(s), /^The next round covers \d+ sections/);
  });
});

test('no screen prints 100% for a draft that is short, stopped, refused, interrupted or paused (D-1)', () => {
  for (const state of Object.keys(STATES)) for (const language of ['zh', 'en']) {
    const surfaces = { home: home(state, language), console: consoleOf(state, language), page: pageOf(state, language) };
    for (const [where, html] of Object.entries(surfaces)) {
      // (The way to full coverage — 「覆盖现在 … → 目标 100%，还要 N 轮、约 M 题」 — names the TARGET, which is the point of it; it is not a progress figure.)
      const said = text(html).replace(/(覆盖现在|Coverage now) .*?(题|questions)/g, '').replace(/(覆盖|Covered) ?\d+%/g, '');
      assert.doesNotMatch(said, /\b100%/, `${state}/${language}/${where}: ${(/.{40}\b100%.{20}/.exec(said) || [''])[0]}`);
    }
    assert.ok(m.taskSummary(STATES[state].job).percent < 100, `${state}: the list row's percent`);
    assert.ok(shortfall(state).percent < 100);
  }
  assert.equal(m.taskSummary(STATES.stopped.job).percent, 69, 'questions kept over the plan: 174 of 251');
  assert.match(text(consoleOf('stopped')), /总进度 · 部分完成 69%/);
});

test('the badge says what is true of the draft: never 「已复审，待发布」 while it is short, stopped, refused, interrupted or paused (D-1)', () => {
  const tag = (state, language = 'zh') => text((/data-draft-status[^>]*>([\s\S]*?)<\/span>/.exec(home(state, language)) || [])[1] || '');
  assert.match(tag('stopped'), /^已停止 · 重试后仍没出成/);
  assert.equal(tag('refused'), '模型拒绝');
  assert.equal(tag('interrupted'), '已中断');
  // a paused run is still a live job: its row shows the work's own status (暂停于第 3 轮之后) and 继续, not a badge
  assert.equal(tag('paused'), '');
  assert.match(text(/<div class="draft-row">[\s\S]*$/.exec(home('paused'))[0]), /暂停于第 3 轮之后/);
  for (const state of Object.keys(STATES)) assert.doesNotMatch(home(state), /已复审，待发布/, state);
  assert.equal(inLanguage('en', () => tag('refused', 'en')), 'Model refused');
  // a draft that is complete but short of its goal says so; one that is complete is 「已复审，待发布」
  assert.equal(m.copy.shortfallTag(m.shortfallOf({ draft: draftOf({ cards: 10, marker: undefined, over: { goal: undefined }, requested: 20 }), coverage: { ...view.coverage, covered: view.coverage.leaves, leaves: view.coverage.leaves } }), { reviewed: true }), '已复审 · 少了 10 题');
  assert.equal(m.copy.shortfallTag({ state: 'done', questionsMissing: 0 }, { reviewed: true }), '已复审，待发布');
  assert.equal(m.copy.shortfallTag({ state: 'done', questionsMissing: 0 }, { reviewed: false }), '待发布检查');
});

test('the ONE primary action of each state is the same on the banner and the row (D-12)', () => {
  const labels = { topup: '为没覆盖的部分补题', 'model-settings': '去配置模型', continue: '接着做', resume: '继续' };
  for (const [state, { action }] of Object.entries(STATES)) {
    const html = home(state), banner = html.match(/<article[\s\S]*?<\/article>/)[0], row = /<div class="draft-row">[\s\S]*$/.exec(html)[0];
    const label = labels[action];
    assert.ok(buttonsOf(banner).some(button => button.replace(/\s*→$/, '') === label), `${state}: the banner offers ${label}: ${buttonsOf(banner)}`);
    assert.ok(buttonsOf(row).some(button => button === label), `${state}: the row offers ${label}: ${buttonsOf(row)}`);
    for (const other of Object.values(labels).filter(item => item !== label)) {
      assert.ok(!buttonsOf(row).includes(other), `${state}: the row offers ONE action, not ${other}: ${buttonsOf(row)}`);
    }
    assert.ok(!buttonsOf(banner).some(button => /打开草稿/.test(button)), `${state}: 打开草稿 is not the banner's primary action`);
  }
  // an interrupted run is not "being filled", and its title is the deck's own
  const interrupted = text(home('interrupted').match(/<article[\s\S]*?<\/article>/)[0]);
  assert.match(interrupted, /「Platform lectures」已中断/);
  assert.doesNotMatch(interrupted, /正在补齐|正在出题/);
  assert.match(interrupted, /中断于第 3 轮/);
  inLanguage('en', () => {
    const banner = home('interrupted', 'en').match(/<article[\s\S]*?<\/article>/)[0];
    assert.ok(buttonsOf(banner).some(button => button.replace(/\s*→$/, '') === 'Continue'));
    assert.doesNotMatch(text(home('interrupted', 'en')).replace(/Platform lectures/g, ''), han);
  });
});

test('every state reads in English without a Chinese word on the banner, the row, the console and the draft page (zh and en, D-12)', () => {
  inLanguage('en', () => {
    for (const state of Object.keys(STATES)) for (const [where, html] of Object.entries({ home: home(state, 'en'), console: consoleOf(state, 'en'), page: pageOf(state, 'en') })) {
      const said = text(html).replace(/Platform lectures/g, '');
      assert.doesNotMatch(said, han, `${state}/${where}: ${(/.{0,30}[㐀-鿿].{0,30}/.exec(said) || [''])[0]}`);
    }
  });
});

test('a refused key is ONE plain sentence, never the provider\'s English, said once; 去配置模型 is in the console header with 接着做 beside it (D-5)', () => {
  const sentence = '模型服务拒绝了请求（密钥无效或没有权限）';
  for (const [where, html] of Object.entries({ home: home('refused'), console: consoleOf('refused'), page: pageOf('refused') })) {
    const said = text(html);
    assert.doesNotMatch(said, /Unauthorized|Invalid API key|\b401\b|Part \d+:|Inval\b/, `${where} prints the provider's English`);
    assert.ok(said.includes(sentence), `${where} says the plain sentence`);
  }
  const consoleHtml = consoleOf('refused');
  assert.ok(buttonsOf(consoleHtml).includes('去配置模型'), `the console header has 去配置模型: ${buttonsOf(consoleHtml)}`);
  assert.ok(buttonsOf(consoleHtml).includes('接着做'), `and 接着做, which continues from the next round once the key works: ${buttonsOf(consoleHtml)}`);
  assert.equal((text(consoleHtml).match(new RegExp(sentence.replace(/[()（）]/g, '\\$&'), 'g')) || []).length <= 3, true, 'said in the list row, the strip: not once per part');
  assert.match(text(consoleOf('refused')), /任务 全部 1[\s\S]*失败/);
  inLanguage('en', () => {
    const english = text(consoleOf('refused', 'en'));
    assert.doesNotMatch(english, /Unauthorized|Invalid API key|\b401\b|Part \d+:/);
    assert.match(english, /The model service refused the request \(the key is invalid or lacks permission\)/);
    assert.ok(buttonsOf(consoleOf('refused', 'en')).includes('Set up a model'));
  });
  // the pure description is the one table (generation-status.js describeFailure), not a second one
  assert.equal(m.copy.stopText({ reason: 'refused', round: 2, code: 'credential' }), `${sentence}，已经停下；已通过的题都保留。`);
});

test('the console of a run that is not the draft\'s latest keeps its own numbers and offers no action of the draft', () => {
  seed();
  const old = { ...STATES.refused.job, id: 'old-run' };
  const d = { revision: undefined, jobs: [old], drafts: [{ ...STATES.refused.draft, editorial: { ...STATES.refused.draft.editorial, coverageRun: { ...STATES.refused.draft.editorial.coverageRun, jobId: 'newer-run' } } }], decks: [], sources: [] };
  const html = render(React.createElement(m.TaskConsole, { data: d, openers: { resultOf: () => null } }), { data: d });
  assert.ok(!buttonsOf(html).includes('去配置模型'), 'an older record of the same draft has no 去配置模型');
  assert.doesNotMatch(text(html), /已出 \d+\/\d+ 题 · 还有/, 'its strip does not borrow the draft\'s present numbers');
});

test('小节 is the coverage unit everywhere the learner sees it and 批次 is a generation batch (D-10)', () => {
  assert.equal(m.copy.countOf('part', 81), '81 个小节');
  assert.equal(m.copy.uncoveredHead('part', 3), '没覆盖的小节 · 3');
  assert.equal(m.copy.rangeCoverageText({ covered: 3, leaves: 8 }, 'part'), '覆盖 3/8 小节');
  for (const html of [pageOf('stopped'), home('stopped'), consoleOf('stopped')]) {
    const said = text(html).replace(/第[一二三四五六七八九十]+部分：[^ ]*( \d+)?/g, '');   // the material's own headings are left alone
    assert.doesNotMatch(said, /\d+ 个部分|没覆盖的部分 ·|每个部分都有题/, 'the coverage unit is never 部分');
  }
  const draftReport = m.copy.stopText({ reason: 'complete' });
  assert.match(draftReport, /每个小节都有题了/);
  inLanguage('en', () => {
    assert.equal(m.copy.countOf('part', 81), '81 sections');
    assert.equal(m.copy.countOf('part', 1), '1 section');
  });
});

test('the console says a generation batch in 批次 (the lane, the rows, the tab) and the plan-short cause blames the model, not the section (D-10, D-15 ii)', () => {
  const html = consoleOf('stopped');
  assert.match(html, /轮次与批次/, 'the tab');
  assert.doesNotMatch(text(html), /资料部分/);
  assert.equal(m.copy.reasonWord('plan-short'), '模型给出的考点比计划的少');
  assert.doesNotMatch(m.copy.reasonWord('plan-short'), /这一节能出的/);
  inLanguage('en', () => {
    assert.equal(m.copy.reasonWord('plan-short'), 'The model gave fewer knowledge points than planned');
    assert.match(text(consoleOf('stopped', 'en')), /Rounds and batches/);
  });
});

test('the sections that keep failing are listed with their reason, and a run does not try them by itself (D-16)', () => {
  const attempts = { 'audio#a1': { n: 2, reason: 'review-protocol', round: 11 } };
  const draft = draftOf({ marker: stopped({}), over: { attempts } });
  const found = m.shortfallOf({ draft, coverage: { ...view.coverage, sections: view.coverage.sections.map((section, index) => (index === view.coverage.sections.findIndex(item => item.state !== 'covered') ? { ...section, key: 'audio#a1' } : section)) }, round: view.round });
  assert.equal(found.repeating.length, 1);
  const line = m.copy.repeatingLine(found);
  assert.match(line, /^这几个小节反复失败：.*（审阅回复格式不对，重新审阅后仍不行 · 已试 2 次）$/);
  assert.equal(m.copy.repeatingHead(3), '这几个小节反复失败 · 3');
  assert.match(m.copy.repeatingNote(), /不再重试/);
  inLanguage('en', () => assert.match(m.copy.repeatingLine(found), /^Sections that keep failing: .*stayed malformed/));
});

test('the form says, for a run that waits (自动补到完整 off), what the first round covers and that 12% is by design for 精简; the draft page says it with the real number (DEFAULT)', () => {
  const coverage = { level: 'lean', goal: 126, sections: 49, leaves: 81, units: 'part', rounds: 5, firstRound: 28, firstRoundSections: 10, levels: {} };
  const state = { status: 'ready', estimate: { coverage, totalTokens: { low: 1, high: 2 }, calls: { low: 1, high: 2 }, inputTokens: { low: 1, high: 2 }, outputTokens: { low: 1, high: 2 }, stages: [] } };
  const props = { level: 'lean', customCount: '', state, stats: { materials: 1, pages: 0, chars: 400000 }, onLevel: noop, onCustom: noop, onAuto: noop, onBudget: noop };
  const off = text(render(React.createElement(m.CoverageStrength, { ...props, auto: false, budget: '' })));
  assert.match(off, /精简：先出第 1 轮，覆盖约 12%；点「自动补到完整」继续，或在草稿页点「为没覆盖的部分补题」一次补一轮（剩下 4 轮）。/);
  assert.match(off, /覆盖的小节不多是设计如此/, 'the 精简 note says it is by design');
  const on = text(render(React.createElement(m.CoverageStrength, { ...props, auto: true, budget: '' })));
  assert.doesNotMatch(on, /覆盖约 12%/, 'with the toggle on the run does not stop there');
  inLanguage('en', () => {
    const english = text(render(React.createElement(m.CoverageStrength, { ...props, auto: false, budget: '' }), { language: 'en' }));
    assert.match(english, /Lean: round 1 is made first, covering about 12%\. Tick "Finish automatically" to go on/);
    assert.match(english, /few sections are covered by design/);
    assert.doesNotMatch(english, han);
  });
  const manual = m.shortfallOf({ draft: draftOf({ cards: 28, over: { level: 'lean', goal: 126 }, statuses: ['done', 'pending', 'pending', 'pending', 'pending'],
    marker: { jobId: 'j1', autoComplete: false, state: 'waiting', startedAt: at(0), updatedAt: at(1), tokensUsed: 215_000 } }), coverage: view.coverage, round: view.round });
  assert.equal(manual.reason, 'manual');
  assert.equal(m.copy.shortfallWhy(manual), `精简：先出第 1 轮，覆盖 ${view.coverage.percentLeaves}%；点「自动补到完整」继续`);
});

test('every new sentence has an English twin without Chinese in it', () => {
  const s = shortfall('stopped');
  inLanguage('en', () => {
    for (const sentence of [m.copy.questionsText(s), m.copy.sectionsLeftText(s), m.copy.nextRoundText(s), m.copy.shortfallLine(s), m.copy.shortfallWhy({ ...s, reason: 'manual', level: 'lean', roundsDone: 1, coveragePercent: 12 }),
      m.copy.stopText({ reason: 'refused', code: 'credential' }), m.copy.stopText({ reason: 'refused', code: 'quota' }), m.copy.stopText({ reason: 'no-progress', round: 4, left: 18 }), m.copy.stopText({ reason: 'sections-left', left: 3 }),
      m.copy.shortfallTag({ ...s, state: 'stopped', reason: 'budget' }), m.copy.shortfallTag({ ...s, state: 'stopped', reason: 'manual' }), m.copy.shortfallTag({ ...s, state: 'stopped', reason: 'no-plan' }), m.copy.shortfallTag({ ...s, state: 'refused' }),
      m.copy.shortfallTag({ ...s, state: 'done', questionsMissing: 10 }, { reviewed: true }), m.copy.actionLabel('topup'), m.copy.actionLabel('continue'), m.copy.actionLabel('resume'), m.copy.actionLabel('model-settings'),
      m.copy.failedWhy('credential'), m.copy.failedWhy('timeout'), m.copy.failedWhy('Part 1: Quality gate failed: q1: answerLeak failed')]) assert.doesNotMatch(sentence, han, sentence);
  });
});
