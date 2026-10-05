import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { loadUi } from './helpers/ui-module.mjs';
import { estimateFromState } from '../lib/token-estimate.js';
import { coveragePlan, coverageSpec } from '../lib/coverage-plan.js';
import { leafSectionsFor, annotateCoverage } from '../lib/coverage-state.js';
import { coverageOf } from '../lib/coverage.js';
import { transcriptFixture } from './helpers/coverage-fixture.mjs';

/* The 覆盖强度 control of the 创建题组 form and the rows that say why a section has the questions it has, in zh and en. Every number on screen comes from the REAL estimator and the REAL
   planner for the audited merged transcript (5 recordings, 80 parts, two volumes); the markup is static, interaction and layout are checked in the browser journey. */

const m = await loadUi(`
  export { default as CoverageStrength } from './ui/coverage/CoverageStrength.jsx';
  export { CoverageSummary } from './ui/coverage/Coverage.jsx';
  export * as copy from './ui/coverage/copy.js';
  export * as form from './ui/generate-form.js';
  export { estimateSummary } from './ui/token-usage.js';
  export { generationStartedNotice } from './ui/generation-status.js';
  export { setUiLanguage } from './ui/i18n.js';`);
const han = /[㐀-鿿]/;
const noop = () => {};
const text = html => html.replace(/<[^>]+>/g, ' ').replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
const inLanguage = (language, run) => { m.setUiLanguage(language); try { return run(); } finally { m.setUiLanguage('zh'); } };

const fx = transcriptFixture();
const state = { sources: fx.sources, decks: [], drafts: [], settings: {} }, ids = fx.sources.map(source => source.id);
const estimateOf = args => estimateFromState('generate', { sourceIds: ids, ...args }, state, { language: 'zh' });
const render = (level, estimate, extra = {}) => renderToStaticMarkup(React.createElement(m.CoverageStrength, { level, customCount: '', onLevel: noop, onCustom: noop,
  state: estimate ? { status: 'ready', estimate } : { status: 'idle' }, stats: { materials: 2, pages: 0, chars: 572427 }, enabled: true, ...extra }));
const lineOf = html => text(/<p class="token-estimate__line">([\s\S]*?)<\/p>/.exec(html)?.[1] || '');

test('the control: three levels, 标准 on by default, the level said in words, the custom number folded away', () => {
  const html = render('standard', estimateOf({ coverageLevel: 'standard' }));
  const labels = [...html.matchAll(/<button[^>]*class="sh-seg__item[^"]*"[^>]*>(.*?)<\/button>/g)].map(match => text(match[1]));
  assert.deepEqual(labels, ['精简', '标准', '完整']);
  assert.match(html, /aria-pressed="true"[^>]*>标准</);
  assert.match(text(html), /标准：每个不少于 600 字的部分都出题，更长、更重要的部分题更多，每万字约 6 题。/);
  assert.match(html, /<details class="sh-disclosure[^"]*cov-strength__custom"(?![^>]*\sopen)/, 'the custom number is a closed disclosure');
  assert.match(text(html), /自定义题数 可选/);
  for (const level of ['lean', 'full']) assert.match(render(level, null), new RegExp(`aria-pressed="true"[^>]*>${level === 'lean' ? '精简' : '完整'}<`));
});

test('the consequence line is the real estimate in plain words: 「标准：约 N 道题，覆盖 M/K 个部分，分 R 轮，预计 X–Y tok · A–B 次模型调用」', () => {
  for (const level of ['lean', 'standard', 'full']) {
    const estimate = estimateOf({ coverageLevel: level }), c = estimate.coverage;
    const line = lineOf(render(level, estimate));
    assert.equal(line, `${text(m.copy.levelLabel(level))}：约 ${c.goal} 道题，覆盖 ${c.sections}/${c.leaves} 个部分，分 ${c.rounds} 轮，${text(m.estimateSummary(estimate))}`, level);
    assert.match(line, /^(精简|标准|完整)：约 \d+ 道题，覆盖 \d+\/81 个部分，分 \d+ 轮，预计 [\d.]+[KM]?–[\d.]+[KM]? tok · \d+–\d+ 次模型调用$/);
  }
  const standard = estimateOf({ coverageLevel: 'standard' });
  assert.match(lineOf(render('standard', standard)), /覆盖 81\/81 个部分/);
  assert.match(text(render('standard', standard)), /精简约 126 题 · 标准约 251 题 · 完整约 419 题/, 'the three levels side by side for the same sources');
  const custom = estimateOf({ coverageLevel: 'standard', count: 100 });
  const html = render('standard', custom, { customCount: '100' });
  assert.equal(lineOf(html), `自定义：100 道题，覆盖 ${custom.coverage.sections}/81 个部分，分 4 轮，${text(m.estimateSummary(custom))}`);
  assert.match(html, /<details class="sh-disclosure[^"]*cov-strength__custom"[^>]*\sopen/, 'a typed number keeps the disclosure open');
  assert.match(html, /<input[^>]*id="generate-count"[^>]*value="100"|<input[^>]*value="100"[^>]*id="generate-count"/);
  assert.doesNotMatch(text(html), /精简约/, 'with a custom number the three levels are not offered side by side');
  const one = estimateOf({ coverageLevel: 'standard', count: 20 });
  assert.match(lineOf(render('standard', one, { customCount: '20' })), /^自定义：20 道题，覆盖 20\/81 个部分，一轮出完，/);
});

test('the line is the same plan the run is planned with: the same function', () => {
  const leaves = leafSectionsFor(state, fx.sources);
  for (const level of ['lean', 'standard', 'full']) {
    const planned = coveragePlan({ leaves, weights: [], level }), c = estimateOf({ coverageLevel: level }).coverage;
    assert.deepEqual([c.goal, c.sections, c.rounds, c.firstRound], [planned.plan.goal, planned.plan.mustCover, planned.rounds.length, planned.rounds[0].questions], level);
  }
});

test('before the estimate arrives and when there is nothing selected, the control says what the level means and no number', () => {
  const waiting = render('standard', null);
  assert.doesNotMatch(text(waiting), /约 \d+ 道题/);
  assert.match(text(waiting), /标准：每个不少于 600 字/);
  const empty = render('standard', null, { enabled: false });
  assert.doesNotMatch(empty, /token-estimate|data-coverage-consequence/);
});

test('the English control has no Chinese text', () => inLanguage('en', () => {
  const standard = estimateOf({ coverageLevel: 'standard' }), html = render('standard', standard);
  assert.doesNotMatch(text(html), han, text(html).match(/.{0,30}[㐀-鿿].{0,30}/)?.[0]);
  assert.match(lineOf(html), /^Standard: about 251 questions, covering 81\/81 parts, in 9 rounds. Estimated [\d.]+[KM]?–[\d.]+[KM]? tok · \d+–\d+ model calls$/);
  const labels = [...html.matchAll(/<button[^>]*class="sh-seg__item[^"]*"[^>]*>(.*?)<\/button>/g)].map(match => text(match[1]));
  assert.deepEqual(labels, ['Lean', 'Standard', 'Full']);
  assert.match(text(html), /Lean about 126 · Standard about 251 · Full about 419/);
  assert.match(text(html), /Custom number of questions/);
  const custom = render('standard', estimateOf({ coverageLevel: 'full', count: 100 }), { customCount: '100' });
  assert.doesNotMatch(text(custom), han);
  assert.match(lineOf(custom), /^Custom: 100 questions, covering 81\/81 parts, in 4 rounds. Estimated /);
}));

test('the started notice says that a plan of several rounds starts with the first', () => {
  assert.equal(m.generationStartedNotice({ status: 'running' }, { title: 'T' }, 2).text, '已开始生成「T」…完成后在这里打开草稿。');
  const text1 = m.generationStartedNotice({ status: 'running', plan: { rounds: 12, goal: 343, questions: 30 } }, { title: 'T' }, 2).text;
  assert.equal(text1, '已开始生成「T」…完成后在这里打开草稿。 共分 12 轮、约 343 题；这次先出第 1 轮（约 30 题），其余在草稿页继续。');
  assert.equal(m.generationStartedNotice({ status: 'running', plan: { rounds: 1, goal: 20, questions: 20 } }, { title: 'T' }, 2).text, '已开始生成「T」…完成后在这里打开草稿。');
  inLanguage('en', () => assert.doesNotMatch(m.generationStartedNotice({ status: 'running', plan: { rounds: 12, goal: 343, questions: 30 } }, {}, 2).text, han));
});

/* ---------- why a section has its questions ---------- */

function draftCoverage({ weights, source = 'model' }) {
  const leaves = leafSectionsFor(state, fx.sources), made = coveragePlan({ leaves, weights, level: 'standard' });
  const spec = coverageSpec({ plan: made.plan, rounds: made.rounds, weights, weightSource: source });
  const covered = coverageOf({ sources: fx.sources, cards: [fx.card(fx.leaves[0])] });
  return { coverage: annotateCoverage({ ...covered, sections: covered.sections }, spec), spec, leaves };
}
const rated = leaves => leaves.map((leaf, at) => ({ sectionId: leaf.key, importance: at % 7 === 3 ? 5 : 3, kind: at % 7 === 3 ? 'definition' : 'method', reason: at % 7 === 3 ? 'The core definition of the platform team' : 'How the teams reuse it', source: 'model' }));

test('a section row says its importance, what it is, how many questions it was planned and why, in one line', () => {
  const leaves = leafSectionsFor(state, fx.sources), { coverage, spec } = draftCoverage({ weights: rated(leaves) });
  const html = renderToStaticMarkup(React.createElement(m.CoverageSummary, { coverage, onOpen: noop }));
  const rows = [...html.matchAll(/<li[^>]*data-section="([^"]+)"[^>]*>([\s\S]*?)<\/li>/g)];
  assert.ok(rows.length >= 70, `${rows.length} uncovered sections are listed`);
  const sectionAt = key => coverage.sections.find(section => section.key === key);
  const important = rows.find(row => sectionAt(row[1]).weight.importance === 5), plain = rows.find(row => sectionAt(row[1]).weight.importance === 3);
  const why = row => text(/<small class="cov-list__why"[^>]*>([\s\S]*?)<\/small>/.exec(row[2])?.[1] || '');
  assert.match(why(important), /^重要性 5\/5 · 定义 · 计划 \d+ 题 — The core definition of the platform team$/);
  assert.match(why(plain), /^重要性 3\/5 · 方法 · 计划 \d+ 题 — How the teams reuse it$/);
  assert.equal([...html.matchAll(/cov-list__why/g)].length, rows.length, 'every row has its line');
  assert.match(text(html), new RegExp(`出题计划：标准，约 ${spec.goal} 题，分 ${spec.rounds.length} 轮（重要性由模型判断）`));
  inLanguage('en', () => {
    const english = renderToStaticMarkup(React.createElement(m.CoverageSummary, { coverage, onOpen: noop }));
    const line = text(/<small class="cov-list__why"[^>]*>([\s\S]*?)<\/small>/.exec(english)?.[1] || '');
    assert.match(line, /^Importance \d\/5 · (definition|method) · \d+ planned — /);
    assert.match(text(english), new RegExp(`Plan: Standard, about ${spec.goal} questions in ${spec.rounds.length} rounds \\(importance judged by the model\\)`));
    const visible = text(english.replace(/<span class="cov-list__name">[\s\S]*?<\/small><\/span>/g, '').replace(/<span class="cov-groups__name">[\s\S]*?<\/span>/g, ''));
    assert.doesNotMatch(visible, han, visible.match(/.{0,30}[㐀-鿿].{0,30}/)?.[0]);
  });
});

test('without the model the rows say the questions were shared out by length, and do not invent an importance', () => {
  const leaves = leafSectionsFor(state, fx.sources), weights = leaves.map(leaf => ({ sectionId: leaf.key, importance: 3, kind: 'other', reason: '', source: 'length' }));
  const { coverage, spec } = draftCoverage({ weights, source: 'length' });
  const html = renderToStaticMarkup(React.createElement(m.CoverageSummary, { coverage, onOpen: noop }));
  const why = text(/<small class="cov-list__why"[^>]*>([\s\S]*?)<\/small>/.exec(html)?.[1] || '');
  assert.match(why, /^按篇幅分配 · 计划 \d+ 题/);
  assert.doesNotMatch(why, /重要性/);
  assert.match(text(html), new RegExp(`出题计划：标准，约 ${spec.goal} 题，分 ${spec.rounds.length} 轮（按篇幅分配，没有用模型判断重要性）`));
  assert.equal(m.copy.weightLine(null), '');
  assert.equal(m.copy.planLine(undefined), '');
});

test('a coverage without a plan (a draft from before, a top-up) shows no plan line and no why line', () => {
  const covered = coverageOf({ sources: fx.sources, cards: [fx.card(fx.leaves[0])] });
  const html = renderToStaticMarkup(React.createElement(m.CoverageSummary, { coverage: covered, onOpen: noop }));
  assert.doesNotMatch(html, /cov-list__why|data-coverage-plan/);
});

test('a draft with a plan says that its later rounds are planned, not "never planned": the line, the bar, the rows', async () => {
  const leaves = leafSectionsFor(state, fx.sources), { coverage, spec } = draftCoverage({ weights: rated(leaves) });
  const first = new Set(spec.rounds[0].sectionIds), later = new Set(spec.rounds.slice(1).flatMap(round => round.sectionIds).filter(key => !first.has(key)));
  const waiting = coverage.sections.filter(section => section.state === 'never-planned' && later.has(section.key));
  assert.ok(waiting.length >= 60, `${waiting.length} sections wait for a later round`);
  assert.equal(coverage.scheduled, waiting.length);
  assert.ok(waiting.every(section => section.scheduled === true));
  const never = coverage.neverPlanned - waiting.length;
  // A plan from phase 3a kept no round states: its first round was the run, so the sections of that round with no question were planned and did not come out (the plan came back short for them), never "no plan".
  const tried = coverage.sections.filter(section => section.attempted);
  assert.equal(tried.length, [...first].filter(key => coverage.sections.find(section => section.key === key).state !== 'covered').length, 'the sections of the first round that have no question');
  assert.ok(tried.every(section => section.state === 'planned-failed' && section.reason === 'plan-short' && first.has(section.key)));
  assert.equal(m.copy.coverageLine(coverage), `覆盖 1/81 个部分（1%） · ${tried.length} 个计划了没出成 · ${waiting.length} 个排在后面的轮次${never ? ` · ${never} 个没有记录` : ''}`);
  const html = renderToStaticMarkup(React.createElement(m.CoverageSummary, { coverage, onOpen: noop }));
  assert.match(text(html), new RegExp(`${waiting.length} 个排在后面的轮次`));
  const rows = [...html.matchAll(/<li[^>]*data-section="([^"]+)"[^>]*>([\s\S]*?)<\/li>/g)];
  assert.equal(rows.filter(row => row[2].includes('排在后面的轮次')).length, waiting.length, 'each of them says so in its row, and nothing else does');
  assert.ok(waiting.every(section => rows.find(row => row[1] === section.key)?.[2].includes('排在后面的轮次')));
  assert.match(html, /aria-label="[^"]*排在后面的轮次"/, 'and in its mark');
  assert.doesNotMatch(html.slice(html.indexOf('data-coverage-bar')), /没计划到 <strong>\d+/, 'the legend does not call them never planned');
  assert.equal(m.copy.coverageLine({ ...coverage, scheduled: undefined }).includes('排在后面'), false, 'a coverage without a plan never says it');
  inLanguage('en', () => {
    assert.match(m.copy.coverageLine(coverage), new RegExp(`${waiting.length} waiting for a later round`));
    assert.match(text(renderToStaticMarkup(React.createElement(m.CoverageSummary, { coverage, onOpen: noop }))), /Waiting for a later round/);
  });
  const range = (await import('../lib/coverage.js')).coverageInRange(coverage, [{ sourceId: fx.sources[0].id, start: 0, end: 60000 }]);
  assert.ok(range.scheduled >= 1 && range.scheduled <= range.neverPlanned);
});
