import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { loadUi } from './helpers/ui-module.mjs';
import { inApp } from './helpers/fake-app.mjs';
import { draftView, seedView, small } from './helpers/coverage-view.mjs';

/* #662 and #663 (the UI scoring of 2026-11-04): a draft whose PLAN is done but whose material has a section the plan never reached said 「出题计划做完了：计划里的每个小节都有题了」 and, one line
   under it, 「还有 1 个小节没有题」; and the same coverage figure was written four times on the draft page and three times in the console. Now ONE sentence names the two facts apart (the plan is
   done; this section is not in it), the percent says what it is the percent of, and the figure is written once per page by one component (ui/coverage/CoverageFact.jsx). */

const m = await loadUi(`
  export { AppContext } from './ui/app/app-context.js';
  export { StudyServicesContext } from './ui/study-context.jsx';
  export { default as DraftCoverage } from './ui/coverage/DraftCoverage.jsx';
  export { default as TaskConsole } from './ui/tasks/TaskConsole.jsx';
  export { default as Metrics } from './ui/tasks/Metrics.jsx';
  export { default as HomeActivity, HomeDrafts } from './ui/study-map/HomeActivity.jsx';
  export { seedCoverage, forgetCoverage } from './ui/coverage/use-coverage.js';
  export * as copy from './ui/coverage/copy.js';
  export { shortfallOf } from './lib/shortfall.js';
  export { taskSummary } from './ui/tasks/task-summary.js';
  export { setUiLanguage } from './ui/i18n.js';
`);
const text = (html) => html.replace(/<[^>]+>/g, ' ').replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&#x27;/g, "'").replace(/\s+/g, ' ').trim();
const noop = () => {};
const at = (seconds) => new Date(Date.UTC(2026, 10, 4, 10, 0, seconds)).toISOString();
const inLanguage = (language, run) => { m.setUiLanguage(language); try { return run(); } finally { m.setUiLanguage('zh'); } };

/* 12 sections of a small transcript; the plan covered 11 of them and every round is done, the 12th was never in it. */
const covered = small.ids.slice(0, -1), view = draftView({ draftId: 'd1', draftVersion: 3, covered });
const KEPT = covered.length;
const spec = { version: 1, level: 'standard', goal: KEPT, leaves: view.coverage.leaves, mustCover: KEPT, weightSource: 'model', weights: [], quotas: [],
  rounds: [{ round: 1, questions: KEPT, sectionIds: covered, status: 'done', kept: KEPT, covered: KEPT, tokens: 300_000, ms: 60_000 }] };
const marker = { jobId: 'j1', autoComplete: true, state: 'complete', startedAt: at(0), updatedAt: at(100), tokensUsed: 300_000, stop: { reason: 'complete', at: at(100), round: 1 } };
const draft = { id: 'd1', title: 'Platform lectures', draftVersion: 3, folder: '', cards: Array.from({ length: KEPT }, (_, i) => ({ id: `c${i}`, kind: 'quiz' })),
  editorial: { requested: KEPT, generation: { sourceIds: ['s'], kind: 'quiz' }, coverageSpec: spec, coverageRun: marker } };
const job = { id: 'j1', status: 'complete', deckTitle: 'Platform lectures', draftId: 'd1', kind: 'quiz', count: KEPT, requestedTotal: KEPT, savedCount: KEPT, parts: 1, steps: [], startedAt: at(0), finishedAt: at(100),
  coveragePlan: { level: 'standard', goal: KEPT, rounds: 1 }, coverageRun: { autoComplete: true, state: 'complete', percent: 92, tokensUsed: 300_000, startedAt: at(0), stop: { reason: 'complete', round: 1 },
    list: [{ round: 1, questions: KEPT, status: 'done', fill: false, sections: KEPT, kept: KEPT, covered: KEPT, tokens: 300_000, ms: 60_000 }] } };
const data = { revision: undefined, jobs: [job], drafts: [draft], decks: [], sources: [], model: { ready: true } };
const seed = () => { m.forgetCoverage(); seedView(m, view); };
const render = (element, language = 'zh') => inLanguage(language, () => renderToStaticMarkup(inApp(m, element, { data, app: { lib: { taskFocus: null }, host: {}, settingsEntry: { openModelSettings: noop } } })));
const page = (language) => { seed(); return render(React.createElement(m.DraftCoverage, { draft, view, jobs: data.jobs, modelReady: true }), language); };
const consoleOf = (language) => { seed(); return render(React.createElement(m.TaskConsole, { data, openers: { resultOf: () => null } }), language); };
const shortfall = () => m.shortfallOf({ draft, coverage: view.coverage, round: view.round, job });
const count = (haystack, needle) => haystack.split(needle).length - 1;

test('the fixture is the issue: the plan is met, every question is made, one section is not in the plan', () => {
  const s = shortfall();
  assert.deepEqual([s.state, s.ready, s.questionsMissing, s.sectionsUncovered, s.planned], ['done', true, 0, 1, true]);
});

test('#662: one sentence names the two facts apart: the plan is done, and what it left out', () => {
  const s = shortfall();
  assert.equal(m.copy.shortfallLine(s), `计划内 ${KEPT} 题已全部出完；还有 1 个小节不在计划里，可以补题`);
  inLanguage('en', () => assert.equal(m.copy.shortfallLine(s), `All ${KEPT} planned questions are made; 1 section outside the plan can be topped up`));
  // Nothing left out: the plan's own words, never the sentence about a section that is not covered.
  const whole = m.shortfallOf({ draft, coverage: draftView({ covered: small.ids }).coverage, round: draftView({ covered: small.ids }).round, job });
  assert.doesNotMatch(m.copy.shortfallLine(whole), /不在计划里/);
  // A run that stopped short is still told as before: there the plan is NOT done.
  const short = m.shortfallOf({ draft: { ...draft, cards: draft.cards.slice(0, 5), editorial: { ...draft.editorial, coverageRun: { ...marker, state: 'stopped', stop: { reason: 'sections-left', round: 2, left: 7 } } } },
    coverage: draftView({ covered: small.ids.slice(0, 5) }).coverage, round: draftView({ covered: small.ids.slice(0, 5) }).round });
  assert.doesNotMatch(m.copy.shortfallLine(short), /已全部出完/);
});

test('#662: the run\'s own stop reason does not say 「每个小节都有题」 while a section has none', () => {
  const s = shortfall();
  assert.equal(m.copy.runStopText(marker.stop, s), '', 'the sentence above already says it');
  assert.equal(m.copy.runStopText(marker.stop, { ...s, sectionsUncovered: 0 }), '', 'with nothing left out the coverage line says it (planFinishedLine), once');
  assert.match(m.copy.runStopText(marker.stop, undefined), /每个小节都有题了/, 'a screen that knows nothing else keeps the run\'s own words');
  assert.match(m.copy.runStopText(marker.stop, { ...s, ready: false, sectionsUncovered: 0 }), /每个小节都有题了/, 'a plan that is not met is told as before');
});

test('#662: the draft page and the console never say 「都有题」 and 「没有题」 together; both name the section that is not in the plan', () => {
  for (const [where, html] of [['draft page', page()], ['console', consoleOf()]]) {
    const said = text(html);
    assert.match(said, /计划内 11 题已全部出完；还有 1 个小节不在计划里，可以补题/, where);
    assert.doesNotMatch(said, /每个小节都有题了|计划里的每个小节都有题/, `${where}: ${said}`);
    assert.doesNotMatch(said, /还有 1 个小节没有题/, where);
  }
  for (const [where, html] of [['draft page', page('en')], ['console', consoleOf('en')]]) assert.match(text(html), /All 11 planned questions are made; 1 section outside the plan/, where);
});

test('#662: the home row says the same sentence (it reads the same function)', () => {
  seed();
  const props = { jobs: data.jobs, drafts: data.drafts, busy: false, openDraft: noop, openAgent: noop, cancelJob: noop, dismissJob: noop, retryGeneration: noop, start: noop, topUpDraft: noop, openModelSettings: noop, modelReady: true, data };
  const html = render(React.createElement(React.Fragment, null, React.createElement(m.HomeActivity, props), React.createElement(m.HomeDrafts, { ...props, defaultOpen: true })));
  assert.match(text(html), /计划内 11 题已全部出完；还有 1 个小节不在计划里，可以补题/);
});

test('#662: the percent of a plan says it is the plan\'s: 「计划进度」, never a bare 「总进度」 next to sections without a question', () => {
  const html = render(React.createElement(m.Metrics, { job, summary: m.taskSummary(job), now: Date.parse(at(200)) }));
  assert.match(text(html), /计划进度 · 已完成/);
  assert.doesNotMatch(text(html), /总进度/);
  inLanguage('en', () => assert.match(text(renderToStaticMarkup(React.createElement(m.Metrics, { job, summary: m.taskSummary(job), now: Date.parse(at(200)) }))), /Plan progress · Complete/));
});

test('#663: the coverage figure is written once on the draft page and once in the console, by the same component', () => {
  const draftPage = page(), tasks = consoleOf();
  for (const [where, html] of [['draft page', draftPage], ['console', tasks]]) {
    const said = text(html);
    assert.equal(count(said, '覆盖 11/12'), 1, `${where}: ${said}`);
    assert.equal(count(html, 'data-coverage-fact'), 1, `${where}: one fact component`);
    assert.doesNotMatch(said, /共 1 轮 · 覆盖/, `${where}: the run line does not repeat the figure`);
    assert.doesNotMatch(said, /覆盖现在/, `${where}: nor the path that starts from it`);
    assert.equal(count(said, '92%'), 1, `${where}: the percent once: ${said}`);
  }
  assert.match(draftPage, /data-coverage-fact[^>]*>[\s\S]*?data-coverage-line[^>]*>覆盖 11\/12 个小节（92%）</);
  assert.match(tasks, /data-coverage-fact[^>]*>[\s\S]*?data-coverage-line[^>]*>覆盖 11\/12 个小节（92%）</);
  inLanguage('en', () => assert.match(text(page('en')), /Covered 11\/12 sections \(92%\)/));
});

test('#663: with every section covered the plan says it once ("每个小节都有题了" is not repeated by the run\'s stop or by the top-up)', () => {
  const full = draftView({ draftId: 'd1', draftVersion: 3, covered: small.ids });
  const whole = { ...draft, cards: Array.from({ length: small.ids.length }, (_, i) => ({ id: `c${i}`, kind: 'quiz' })),
    editorial: { ...draft.editorial, requested: small.ids.length, coverageSpec: { ...spec, goal: small.ids.length, rounds: [{ ...spec.rounds[0], sectionIds: small.ids, questions: small.ids.length }] } } };
  const everything = { ...data, drafts: [whole] };
  const draftPage = (language) => { m.forgetCoverage(); seedView(m, full); return inLanguage(language, () => renderToStaticMarkup(inApp(m, React.createElement(m.DraftCoverage, { draft: whole, view: full, jobs: everything.jobs, modelReady: true }),
    { data: everything, app: { lib: { taskFocus: null }, host: {}, settingsEntry: { openModelSettings: noop } } }))); };
  const said = text(draftPage('zh'));
  assert.match(said, /计划内 12 题已全部出完。每个小节都有题了。/);
  assert.equal(count(said, '每个小节都有题'), 1, said);
  assert.doesNotMatch(said, /出题计划做完了/);
  assert.match(text(draftPage('en')), /All 12 planned questions are made\. Every section has questions\./);
  assert.equal(count(text(draftPage('en')), 'Every section has questions'), 1);
});
