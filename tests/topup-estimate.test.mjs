import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { loadUi } from './helpers/ui-module.mjs';
import { inApp } from './helpers/fake-app.mjs';
import { transcriptFixture } from './helpers/coverage-fixture.mjs';
import { shortfallOf } from '../lib/shortfall.js';

/* A top-up that goes on by itself spends over several rounds, so the button that starts it says what it is expected to use BEFORE it is pressed: the cost of this round on the button of the
   资料 row's confirmation, and beside the choice 自动补到完整 of the draft page, with the rounds that follow said as such (not folded into the number). The wording of that choice is the form's. */

const m = await loadUi(`
  export { AppContext } from './ui/app/app-context.js';
  export { StudyServicesContext } from './ui/study-context.jsx';
  export { DocumentTopUpBody } from './ui/coverage/DocumentTopUp.jsx';
  export { default as RunPanel } from './ui/coverage/RunPanel.jsx';
  export { default as RoundCost, RoundCostView } from './ui/coverage/RoundCost.jsx';
  export * as copy from './ui/coverage/copy.js';
  export { estimateSummary } from './ui/token-usage.js';
  export { setUiLanguage } from './ui/i18n.js';`);
const han = /[㐀-鿿]/;
const noop = () => {};
const text = html => html.replace(/<[^>]+>/g, ' ').replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&#x27;/g, "'").replace(/\s+/g, ' ').trim();
const inLanguage = (language, run) => { m.setUiLanguage(language); try { return run(); } finally { m.setUiLanguage('zh'); } };
const render = (element, { language = 'zh', data = {} } = {}) => inLanguage(language, () => renderToStaticMarkup(inApp(m, element, { data, app: { lib: { taskFocus: null }, host: {} } })));
const estimate = { totalTokens: { low: 14_300, high: 25_100 }, calls: { low: 5, high: 16 } };

test('the cost of a round, in one sentence: this round, and the rounds that follow on top of it', () => {
  const said = inLanguage('zh', () => m.estimateSummary(estimate));
  assert.equal(m.copy.roundCostLine(said, 0), `本轮：${said}`);
  assert.equal(m.copy.roundCostLine(said, 1), `本轮：${said}；之后还有 1 轮会接着做，另算。`);
  assert.equal(m.copy.roundCostLine(said, 3), `本轮：${said}；之后还有 3 轮会接着做，每轮另算。`);
  inLanguage('en', () => {
    const en = m.estimateSummary(estimate);
    assert.equal(m.copy.roundCostLine(en, 0), `This round: ${en}`);
    assert.equal(m.copy.roundCostLine(en, 1), `This round: ${en}; 1 more round follows by itself, counted separately.`);
    assert.equal(m.copy.roundCostLine(en, 3), `This round: ${en}; 3 more rounds follow by themselves, each counted separately.`);
    assert.doesNotMatch(m.copy.roundCostLine(en, 3), han);
  });
});

test('the cost slot: the estimate when it is ready, 「正在估算…」 while it is asked, nothing it cannot say', () => {
  const view = state => renderToStaticMarkup(React.createElement(m.RoundCostView, { state, roundsAfter: 2 }));
  assert.match(text(view({ status: 'ready', estimate })), /本轮：预计 14\.3K–25\.1K tok · 5–16 次模型调用；之后还有 2 轮会接着做，每轮另算。/);
  assert.match(text(view({ status: 'loading' })), /正在估算…/);
  for (const status of ['idle', 'error']) assert.equal(text(view({ status })), '', `${status}: no number is made up`);
  assert.match(view({ status: 'ready', estimate }), /data-round-cost[^>]*data-status="ready"|data-status="ready"[^>]*data-round-cost/);
});

/* ---------- the 资料 row's confirmation ---------- */

const fx = transcriptFixture({ recordings: 2, parts: 6, paragraphs: 4 });
const round = { sections: 8, questions: 16, left: 4, rounds: 3, allQuestions: 40, picks: fx.leaves.slice(0, 8).map(leaf => ({ key: `${leaf.sourceId}#${leaf.id}` })), error: null };
const view = { key: 'doc:x', coverage: { units: 'part', leaves: 12, covered: 2, percentLeaves: 17, plannedFailed: 0, neverPlanned: 10, recorded: true },
  topUp: { canTopUp: true, inFlight: 0, round, candidates: [{ id: 'D', title: '期中复习', questions: 3, total: 3, nextPart: 2 }] } };

test('the confirm button of the 资料 row carries the cost: inside the button, once, with the rounds after this one', () => {
  const html = render(React.createElement(m.DocumentTopUpBody, { view, onStart: noop }));
  const button = /<button[^>]*data-coverage-start[^>]*>[\s\S]*?<\/button>/.exec(html)?.[0] || '';
  assert.ok(button, 'the confirm button');
  assert.match(button, /data-round-cost/, 'the cost is on the button');
  assert.match(text(button), /^为没覆盖的部分补题/);
  assert.equal((html.match(/data-token-estimate/g) || []).length, 0, 'and nowhere else: one estimate, not two');
  const after = shortfallOf({ coverage: { leaves: 12, covered: 2, units: 'part', percentLeaves: 17 }, round }).roundsToFull;
  assert.ok(after >= 1, 'the fixture has more than one round');
  assert.match(button, new RegExp(`data-rounds-after="${after - 1}"`), 'the button knows how many rounds follow this one');
  inLanguage('en', () => assert.doesNotMatch(text(render(React.createElement(m.DocumentTopUpBody, { view, onStart: noop }), { language: 'en' })).replace('期中复习', ''), han));
});

/* ---------- the draft page's 自动补到完整 ---------- */

const at = seconds => new Date(Date.UTC(2026, 9, 5, 10, 0, seconds)).toISOString();
const spec = (statuses) => ({ version: 1, level: 'standard', goal: 288, leaves: 81, mustCover: 81, weightSource: 'model', weights: [], quotas: [],
  rounds: statuses.map((status, index) => ({ round: index + 1, questions: 24, sectionIds: [`s#a${index}`, `s#b${index}`], ...(status ? { status } : {}), ...(status === 'done' ? { kept: 24, covered: 2, tokens: 400_000, ms: 600_000 } : {}) })) });
const waiting = { id: 'd1', title: 'Platform lectures', draftVersion: 3, cards: [{ id: 'c1' }], editorial: { requested: 24, generation: { sourceIds: ['s'] }, coverageSpec: spec(['done', 'pending', 'pending']),
  coverageRun: { jobId: 'run-1', autoComplete: false, state: 'waiting', tokensUsed: 400_000, startedAt: at(0), updatedAt: at(100) } } };
const runView = { status: 'ok', canTopUp: true, coverage: { percentLeaves: 9, leaves: 81, covered: 7, units: 'part', plannedFailed: 0, neverPlanned: 74, recorded: true }, round: { sections: 6, questions: 24, picks: [], plannedFailed: 0, neverPlanned: 6, left: 0 } };

test('the choice 自动补到完整 says what it does in the form\'s words and what the next round is expected to use, and starts nothing it did not price', () => {
  const html = render(React.createElement(m.RunPanel, { draft: waiting, view: runView, jobs: [] }));
  const auto = /<div class="cov-run__auto"[\s\S]*?<\/div>/.exec(html)?.[0] || '';
  assert.ok(auto, 'the choice is offered');
  assert.match(text(auto), /勾选后，剩下的 2 轮一轮接一轮自动做完；可以随时暂停，或停在这里（已出的题都保留）。/);
  assert.match(auto, /data-round-cost/, 'with the cost beside it');
  assert.match(auto, /data-rounds-after="1"/, 'the 2 rounds left are this one and 1 more');
  // the form's option and this one end in the same words
  const tail = '一轮接一轮自动做完；可以随时暂停，或停在这里（已出的题都保留）。';
  assert.ok(inLanguage('zh', () => m.copy.autoLine(true, 3)).endsWith(tail), 'the form says it');
  assert.ok(text(auto).includes(tail), 'and so does the draft page');
  const last = text(render(React.createElement(m.RunPanel, { draft: { ...waiting, editorial: { ...waiting.editorial, coverageSpec: spec(['done', 'done', 'pending']) } }, view: runView, jobs: [] })));
  assert.match(last, /勾选后，最后 1 轮会自动做完；可以随时暂停，或停在这里（已出的题都保留）。/);
  inLanguage('en', () => {
    const english = text(render(React.createElement(m.RunPanel, { draft: waiting, view: runView, jobs: [] }), { language: 'en' }));
    assert.match(english, /Ticked, the other 2 rounds are made one after another by themselves; you can pause any time, or stop here \(the questions already made stay\)\./);
    assert.doesNotMatch(english, han);
  });
  // nothing is priced for a run that cannot start (a held page): the choice is not there either
  assert.doesNotMatch(render(React.createElement(m.RunPanel, { draft: waiting, view: runView, jobs: [], held: true })), /data-round-cost/);
});
