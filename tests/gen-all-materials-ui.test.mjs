import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { loadUi } from './helpers/ui-module.mjs';
import { estimateFromState } from '../lib/token-estimate.js';
import { eightRecordings, notes, stateOf } from './helpers/materials-fixture.mjs';

/* Flow A on screen, in zh and en: the creation form's 「选了 N 份资料，M 份会出题，K 份不会：原因」 (from the REAL estimator), the raised count, and the draft page's 「选了 N 份，M 份已出题，K 份没出题」
   with each material's reason and its 补题. Static markup; the layout at 1280 and 420 px is checked in the browser. */

const m = await loadUi(`
  export { default as CoverageStrength, MaterialsForecast } from './ui/coverage/CoverageStrength.jsx';
  export { default as MaterialsReport } from './ui/coverage/MaterialsReport.jsx';
  export * as copy from './ui/coverage/copy.js';
  export { topUpArgs } from './ui/coverage/top-up.js';
  export { setUiLanguage } from './ui/i18n.js';`);
const han = /[㐀-鿿]/;
const noop = () => {};
const text = html => html.replace(/<[^>]+>/g, ' ').replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&#x27;/g, "'").replace(/\s+/g, ' ').trim();
const inLanguage = (language, run) => { m.setUiLanguage(language); try { return run(); } finally { m.setUiLanguage('zh'); } };

const many = notes(40, 700), forty = estimateFromState('generate', { sourceIds: many.map(source => source.id), coverageLevel: 'full', autoComplete: false }, stateOf(many), { language: 'zh' });
const eight = eightRecordings().sources, raised = estimateFromState('generate', { sourceIds: eight.map(source => source.id), coverageLevel: 'standard', count: 5 }, stateOf(eight), { language: 'zh' });
const render = (estimate, extra = {}) => renderToStaticMarkup(React.createElement(m.CoverageStrength, { level: estimate.coverage.level, customCount: '', onLevel: noop, onCustom: noop,
  state: { status: 'ready', estimate }, stats: { materials: 2, pages: 0, chars: 30000 }, enabled: true, ...extra }));
const report = { selected: 8, covered: 7, missing: 1, more: 0, raised: { from: 5, to: 8 }, missingSources: 1,
  rows: [{ key: 'audio:b#r5', title: 'lecture-05.mp3', reason: 'plan-short', keys: ['v1#r5.p1'], topUp: { keys: ['v1#r5.p1'], questions: 3 } }] };

test('before the run: the form says how many materials get a question and why the others do not (zh)', () => {
  const html = render(forty), line = text(/<p class="cov-materials__note"[^>]*data-coverage-materials[^>]*>([\s\S]*?)<\/p>/.exec(html)?.[1] || '');
  assert.match(line, /^选了 40 份资料，30 份会出题，10 份不会：Note \d+（排在第 2 轮，这次先只做第 1 轮）、Note \d+（/);
  assert.equal(line.match(/排在第 2 轮/g).length, 10, 'the ten that wait are named, each with its reason');
  const compact = text(renderToStaticMarkup(React.createElement(m.MaterialsForecast, { coverage: raised.coverage })));
  assert.equal(compact, '选了 8 份资料，每份都会出题。');
  const custom = render(raised, { customCount: '5' });
  assert.match(text(custom), /题数少于所选资料的份数，已从 5 题自动提高到 8 题：每份资料至少 1 题。/);
});

test('before the run, in English: no Chinese in the materials line and the raised count', () => {
  const html = inLanguage('en', () => render(forty)), line = text(/data-coverage-materials[^>]*>([\s\S]*?)<\/p>/.exec(html)?.[1] || '');
  assert.match(line, /^40 materials selected: 30 will get questions, 10 will not: Note \d+ \(in round 2; only round 1 runs this time\), Note \d+ \(/);
  assert.doesNotMatch(line, han);
  const custom = inLanguage('en', () => text(render(raised, { customCount: '5' })));
  assert.match(custom, /Fewer questions than materials: raised from 5 to 8, so every material gets at least one\./);
});

test('after the run: the draft page line, the reason of each material without a question and its 补题 (zh and en)', () => {
  let pressed = null;
  const element = React.createElement(m.MaterialsReport, { report, onTopUp: keys => { pressed = keys; } });
  const zh = text(renderToStaticMarkup(element));
  assert.match(zh, /^选了 8 份，7 份已出题，1 份没出题/);
  assert.match(zh, /lecture-05\.mp3 模型没能从里面找到够用的考点 补题（约 3 题）/);
  assert.match(zh, /另有 1 份所选资料在出题前已从资料库删除，没有出题。/);
  const en = inLanguage('en', () => text(renderToStaticMarkup(element)));
  assert.match(en, /^8 materials selected: 7 have questions, 1 have none/);
  assert.match(en, /the model found too few knowledge points in it Add questions \(about 3\)/);
  assert.doesNotMatch(en, han);
  assert.equal(pressed, null);
  assert.equal(renderToStaticMarkup(React.createElement(m.MaterialsReport, { report: { selected: 1, covered: 1, missing: 0, rows: [] } })), '', 'one material with its questions: nothing to say');
  assert.equal(text(renderToStaticMarkup(React.createElement(m.MaterialsReport, { report: { selected: 3, covered: 3, missing: 0, rows: [] } }))), '选了 3 份，都已出题');
});

test('every reason has words in both languages, never the code', () => {
  const reasons = [{ reason: 'no-text' }, { reason: 'squeezed' }, { reason: 'lean' }, { reason: 'round', round: 2 }, { reason: 'waiting', round: 3 }, { reason: 'running', round: 2 },
    { reason: 'stopped', round: 2, stop: 'budget' }, { reason: 'plan-short' }, { reason: 'unavailable' }, { reason: 'refused' }, { reason: 'insufficient-evidence' }, { reason: 'failed', code: 'quote' },
    { reason: 'not-planned' }, { reason: 'plan-short', sparse: true }];
  for (const row of reasons) {
    const zh = m.copy.materialReasonText(row), en = inLanguage('en', () => m.copy.materialReasonText(row));
    assert.ok(zh && han.test(zh), JSON.stringify(row));
    assert.ok(en && !han.test(en), `${JSON.stringify(row)}: ${en}`);
    assert.doesNotMatch(en, /plan-short|insufficient-evidence|not-planned/);
  }
});

test('the 补题 of one material asks its sections only, as a manual fill round', () => {
  const args = m.topUpArgs({ id: 'd1', draftVersion: 4, editorial: { coverageRun: { autoComplete: true } } }, ['a#1', 'a#2'], { manual: true });
  assert.deepEqual(args, { resumeDraftId: 'd1', draftVersion: 4, coverage: { sectionIds: ['a#1', 'a#2'], manual: true, autoComplete: false } });
  assert.deepEqual(m.topUpArgs({ id: 'd1', draftVersion: 4 }, ['a#1']).coverage, { sectionIds: ['a#1'], autoComplete: true }, 'the page-wide top-up is unchanged');
});
