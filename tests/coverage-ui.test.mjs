import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { loadUi } from './helpers/ui-module.mjs';
import { inApp } from './helpers/fake-app.mjs';
import { withStudy } from './helpers/study-services.mjs';
import { draftView, seedView, small } from './helpers/coverage-view.mjs';
import { coverageOf, coverageDigest } from '../lib/coverage.js';
import { groupSourcesByDocument } from '../lib/source-groups.js';
import { summarizeLinked } from '../lib/material-summary.js';
import { outlineCoverage, rangeCoverageOf, alignEntries } from '../ui/document-preview/practice/coverage-outline.js';

/* The screens that show coverage, in zh and en: the 任务 console's 资料部分, the draft page, the 资料 row, the reader's chip, outline and 做这几页的题 panel, the home 待发布 row.
   Every number on every screen is the same number: it comes from ONE real coverage of a small transcript (3 recordings of 4 parts) whose checklist is written here, and each
   screen is asserted against that checklist. Static markup and pure logic; interaction and layout are checked in the browser journey (scripts/qa/coverage.mjs). */

const m = await loadUi(`
  export * from './ui/coverage/copy.js';
  export { CoverageSummary, CoverageChip, CoverageMark, CoverageBar } from './ui/coverage/Coverage.jsx';
  export { CoverageTopUp, CoverageTopUpPopover } from './ui/coverage/CoverageTopUp.jsx';
  export { seedCoverage, forgetCoverage } from './ui/coverage/use-coverage.js';
  export { default as GenerationParts } from './ui/tasks/GenerationParts.jsx';
  export { default as OutlinePanel } from './ui/document-preview/reader/OutlinePanel.jsx';
  export { default as ReadingPractice } from './ui/document-preview/practice/ReadingPractice.jsx';
  export { default as Sources } from './ui/Sources.jsx';
  export { default as HomeActivity, HomeDrafts } from './ui/study-map/HomeActivity.jsx';
  export { readingSections } from './ui/document-preview/reader/text-sections.js';
  export { outlineFromSections, structureOutline } from './ui/document-preview/reader/outline.js';
  export { AppContext } from './ui/app/app-context.js';
  export { StudyServicesContext } from './ui/study-context.jsx';
  export { setUiLanguage } from './ui/i18n.js';`);
const han = /[㐀-鿿]/;
const noop = () => {};
const text = html => html.replace(/<[^>]+>/g, ' ').replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/\s+/g, ' ');
const inLanguage = (language, run) => { m.setUiLanguage(language); try { return run(); } finally { m.setUiLanguage('zh'); } };
/** Whatever the page shows of the material itself (recording names, section titles) is the learner's data, in whatever language it is in: never a translation gap. */
const withoutData = html => html.replace(/<span class="cov-groups__name">[\s\S]*?<\/span>/g, '').replace(/<span class="cov-list__name">[\s\S]*?<\/small><\/span>/g, '')
  .replace(/<h3 class="reader-section__title">[\s\S]*?<\/h3>/g, '');

/* ---------- the checklist ---------- */
const COVERED = ['r1.p1', 'r1.p3', 'r2.p2'], FAILED = ['r1.p2', 'r3.p1'];
const NEVER = small.ids.filter(id => !COVERED.includes(id) && !FAILED.includes(id));
const view = draftView({ draftId: 'd1', draftVersion: 3, covered: COVERED, failed: FAILED });
const cov = view.coverage;
const RECORDINGS = [[2, 1, 1], [1, 0, 3], [0, 1, 3]]; // covered, planned-failed, never per recording

test('the coverage under every screen is the checklist', () => {
  assert.deepEqual([cov.covered, cov.plannedFailed, cov.neverPlanned, cov.leaves, cov.percentLeaves], [3, 2, 7, 12, 25]);
  assert.deepEqual(cov.sections.filter(section => section.state === 'covered').map(section => section.id), COVERED);
  assert.deepEqual(cov.sections.filter(section => section.state === 'planned-failed').map(section => section.id), FAILED);
  assert.deepEqual(cov.groups.map(group => [group.covered, group.plannedFailed, group.neverPlanned]), RECORDINGS);
  assert.equal(NEVER.length, 7);
});

/* ---------- one wording ---------- */

test('the words of coverage, once: the line, the chip, the header, the states, in every unit and both languages', () => {
  const line = c => m.coverageLine(c);
  assert.equal(line(cov), '覆盖 3/12 个小节（25%） · 2 个计划了没出成 · 7 个没计划到');
  assert.equal(m.coverageChipText(cov), '覆盖 25%');
  assert.equal(m.coverageOutlineHead(cov), '覆盖 3/12');
  assert.equal(line({ ...cov, plannedFailed: 0, neverPlanned: 9, recorded: false }), '覆盖 3/12 个小节（25%） · 9 个没有记录', 'an old draft says it has no record, not "never planned"');
  assert.equal(line({ covered: 80, leaves: 80, units: 'page', percentLeaves: 100, plannedFailed: 0, neverPlanned: 0, recorded: true }), '覆盖 80/80 页（100%）');
  const units = { part: '1 个小节', page: '1 页', chapter: '1 个章节', heading: '1 个小节', window: '1 个片段', section: '1 个小节' };
  for (const [unit, one] of Object.entries(units)) assert.equal(m.countOf(unit, 1), one, unit);
  assert.equal(m.countOf('part', 81), '81 个小节', '「小节」 is the coverage unit of a transcript too: a generation batch is a 批次');
  inLanguage('en', () => {
    assert.equal(line(cov), 'Covered 3/12 sections (25%) · 2 planned but not produced · 7 never planned');
    assert.equal(m.coverageChipText(cov), 'Covered 25%');
    assert.equal(line({ ...cov, plannedFailed: 0, neverPlanned: 9, recorded: false }), 'Covered 3/12 sections (25%) · 9 with no plan on record');
    assert.equal(m.countOf('part', 1), '1 section');
    assert.equal(m.countOf('page', 1), '1 page');
    assert.equal(m.countOf('page', 5), '5 pages');
    assert.equal(m.countOf('heading', 2), '2 sections');
    assert.equal(m.countOf('window', 2), '2 segments');
    for (const state of ['covered', 'planned-failed', 'never-planned']) { assert.doesNotMatch(m.stateWord(state), han); assert.doesNotMatch(m.stateMeaning(state), han); }
    assert.doesNotMatch(m.stateWord('never-planned', false), han);
  });
  assert.equal(m.stateWord('covered'), '已覆盖');
  assert.equal(m.stateWord('planned-failed'), '计划了没出成');
  assert.equal(m.stateWord('never-planned'), '没计划到');
  assert.equal(m.stateWord('never-planned', false), '没有记录');
  assert.match(m.stateMeaning('covered'), /覆盖只说出没出过题，掌握度才说你答得怎么样/, 'asked, not learned');
});

/* ---------- (a) the 任务 console: 资料部分 ---------- */

const rangeOf = id => { const section = small.leaves.find(item => item.id === id); return { sourceId: section.sourceId, start: section.start, end: section.end }; };
const recording = n => { const first = rangeOf(`r${n}.p1`), last = rangeOf(`r${n}.p4`); return [{ sourceId: first.sourceId, start: first.start, end: last.end }]; };
const part = (n, extra = {}) => ({ part: n, sourceIds: [small.sources[0].id], sourceCount: 1, range: `录音 ${n} · 第 1–4 部分`, ranges: recording(n), stages: {}, status: 'partial', asked: 4, kept: 2, reasons: [], ...extra });
const contract = (parts, extra = {}) => ({ jobId: 'j1', kind: 'generation', status: 'complete', detail: { partList: parts, draftId: 'd1', ...extra }, calls: [] });
const consoleApp = { lib: { taskFocus: null }, host: {}, data: { sources: small.sources }, learn: { openAudioSources: noop, openSourceAt: noop } };
const parts = (job, language = 'zh') => inLanguage(language, () => renderToStaticMarkup(inApp(m, React.createElement(m.GenerationParts, { contract: job }), { data: consoleApp.data, app: consoleApp })));
const seedConsole = (v = view) => { m.forgetCoverage(); m.seedCoverage({ draftId: 'd1' }, 'undefined:', v); };

test('资料部分: every row says how many sections of its range have a question, and the rows add up to the whole', () => {
  seedConsole();
  const out = parts(contract([part(1), part(2), part(3)]));
  const rows = [...out.matchAll(/data-part-coverage="[^"]*"[^>]*aria-label="([^"]*)"/g)].map(match => match[1]);
  assert.deepEqual(rows, ['覆盖 2/4 小节 · 1 个计划了没出成 · 1 个没计划到', '覆盖 1/4 小节 · 3 个没计划到', '覆盖 0/4 小节 · 1 个计划了没出成 · 3 个没计划到']);
  const shown = [...out.matchAll(/<span>(覆盖 \d+\/\d+ 小节)<\/span>/g)].map(match => match[1]);
  assert.deepEqual(shown, ['覆盖 2/4 小节', '覆盖 1/4 小节', '覆盖 0/4 小节']);
  assert.equal(shown.reduce((sum, row) => sum + Number(/(\d+)\//.exec(row)[1]), 0), cov.covered, 'the parts of a run cover the draft once each');
  assert.match(out, /class="cov-meter__bar"/, 'a small bar beside the words');
  const english = inLanguage('en', () => parts(contract([part(1), part(2), part(3)]), 'en'));
  assert.match(text(english), /Covered 2\/4 sections/);
  assert.match(english, /aria-label="Covered 2\/4 sections · 1 planned but not produced · 1 never planned"/);
});

test('资料部分: the strip of the chosen part names the sections with no question and the real reason of each', () => {
  seedConsole();
  const out = text(parts(contract([part(3, { part: 1 })])));
  assert.match(out, /覆盖 0\/4 小节/);
  assert.match(out, /没有题的小节：第一部分：预览段落 1（审阅回复格式不对，重新审阅后仍不行）、第二部分：预览段落 2（没计划到）、第三部分：预览段落 3（没计划到）、第四部分：预览段落 4（没计划到）/);
  const two = text(parts(contract([part(1, { part: 1 })])));
  assert.match(two, /没有题的小节：第二部分：预览段落 2（审阅回复格式不对，重新审阅后仍不行）、第四部分：预览段落 4（没计划到）/);
  assert.doesNotMatch(two, /第一部分：预览段落 1（/, 'a covered section is not listed as missing');
  const english = text(parts(contract([part(3, { part: 1 })]), 'en'));
  assert.match(english, /Sections with no question: .*\(The review reply stayed malformed after being reviewed again\)/);
});

test('资料部分: a record whose draft is gone, and a run with no ranges, show no invented numbers', () => {
  m.forgetCoverage();
  const out = parts(contract([part(1)]));
  assert.doesNotMatch(out, /data-part-coverage/);
  seedConsole();
  const noRanges = parts(contract([part(1, { ranges: undefined })]));
  assert.doesNotMatch(noRanges, /data-part-coverage/, 'an older run has no ranges: nothing is guessed');
  const other = parts(contract([part(1)], { draftId: null }));
  assert.doesNotMatch(other, /data-part-coverage/);
});

/* ---------- (b) the draft page ---------- */

const summary = (v = view, { onOpen = noop, children = null } = {}) => React.createElement(m.CoverageSummary, { coverage: v.coverage, onOpen }, children);
const summaryHtml = (v, language = 'zh', props) => inLanguage(language, () => renderToStaticMarkup(inApp(m, summary(v, props), { data: {} })));

test('the draft page summary: the line, one bar, one row per recording, and every uncovered section with its state', () => {
  const out = summaryHtml(view);
  assert.match(out, /data-coverage-line[^>]*>覆盖 3\/12 个小节（25%） · 2 个计划了没出成 · 7 个没计划到</);
  assert.match(out, /role="img"[^>]*aria-label="覆盖 3\/12 个小节（25%）/);
  const rows = [...out.matchAll(/data-group="(r\d)"[\s\S]*?cov-groups__count">(\d+\/\d+)</g)].map(match => [match[1], match[2]]);
  assert.deepEqual(rows, [['r1', '2/4'], ['r2', '1/4'], ['r3', '0/4']], 'one row per recording, with the same numbers as the checklist');
  assert.equal((out.match(/data-section="[^"]*"/g) || []).length, FAILED.length + NEVER.length, 'nothing is left out of the list of what has no question');
  assert.equal((out.match(/data-state="planned-failed"/g) || []).length, 2 * 2 /* the list row and its mark */, 'planned-failed rows');
  assert.equal((out.match(/data-section-open=/g) || []).length, 9, 'every one has the way to the reader');
  assert.match(text(out), /没覆盖的小节 · 9/);
  assert.match(text(out), /计划了没出成：审阅回复格式不对，重新审阅后仍不行/, 'the real reason');
  assert.equal((out.match(/data-coverage-mark="covered"/g) || []).length, 0, 'covered sections are not in the list of what is missing');
  const english = inLanguage('en', () => text(withoutData(summaryHtml(view, 'en'))));
  assert.doesNotMatch(english, han);
  assert.match(english, /Covered 3\/12 sections \(25%\) · 2 planned but not produced · 7 never planned/);
  assert.match(english, /Uncovered sections · 9/);
  assert.match(english, /Planned, not produced: The review reply stayed malformed after being reviewed again/);
});

test('the summary of a draft from before plans were kept says 没有记录, and names no reason it cannot know', () => {
  const old = draftView({ covered: COVERED, recorded: false });
  const out = text(summaryHtml(old));
  assert.match(out, /覆盖 3\/12 个小节（25%） · 9 个没有记录/);
  assert.doesNotMatch(out, /没计划到|计划了没出成/);
  assert.match(out, /这份草稿生成时没有保存计划/);
  const english = inLanguage('en', () => text(withoutData(summaryHtml(old, 'en'))));
  assert.match(english, /9 with no plan on record/);
});

test('a single recording or a book needs no per-recording rows; a material with nothing covered still shows the whole gap', () => {
  const none = draftView({ covered: [], failed: [] });
  const out = text(summaryHtml(none));
  assert.match(out, /覆盖 0\/12 个小节（0%） · 12 个没计划到/);
  assert.match(out, /没覆盖的小节 · 12/);
});

test('the one top-up: what it covers this round, which part it writes again, the estimate, and the single button', () => {
  m.forgetCoverage();
  const html = (v, props = {}, language = 'zh') => inLanguage(language, () => renderToStaticMarkup(inApp(m, React.createElement(m.CoverageTopUp, { draft: { id: 'd1', title: 'T', draftVersion: 3, cards: [] }, view: v, onTopUp: noop, ...props }), { data: {}, call: async () => ({}) })));
  const out = html(view);
  assert.equal((out.match(/data-coverage-start/g) || []).length, 1, 'one button');
  // ONE sentence for the next round, the same on every screen (lib/shortfall.js): what it covers; with nothing left after it, nothing is promised beyond it. The old three sentences ("这一轮补…约 N 题", "其中…", "另外…") are gone.
  assert.match(text(out), /下一轮补 9 个小节/);
  assert.doesNotMatch(text(out), /还剩|这一轮补|按原来的考点重写/);
  assert.doesNotMatch(out, /data-coverage-more/, 'it fits in one round: nothing is promised beyond it');
  assert.match(text(out), /为没覆盖的部分补题/);
  assert.match(out, /data-token-estimate/);
  const held = html(view, { held: true });
  assert.match(held, /<button[^>]*disabled=""[^>]*data-coverage-start|<button[^>]*data-coverage-start[^>]*disabled=""/);
  assert.match(html(view, { modelReady: false }), /disabled=""/);
  assert.equal(html({ ...view, canTopUp: false }), '', 'a draft the backend says cannot be topped up has no button');
  assert.equal(html(null), '');
  const english = text(html(view, {}, 'en'));
  assert.match(english, /The next round covers 9 sections/);
  assert.doesNotMatch(english, han);
  assert.match(english, /Add questions for the uncovered parts/);
});

test('the one top-up says honestly when more rounds are needed, and when nothing is left to cover', () => {
  const bigRound = { ...view, round: { ...view.round, sections: 30, questions: 30, fresh: 30, reused: 0, plannedFailed: 0, neverPlanned: 30, left: 50, rounds: 3, limit: 30, complete: false } };
  const out = text(renderToStaticMarkup(inApp(m, React.createElement(m.CoverageTopUp, { draft: { id: 'd1', title: 'T', draftVersion: 3, cards: [] }, view: bigRound, onTopUp: noop }), { data: {} })));
  assert.match(out, /下一轮补 30 个小节，还剩 50 个/, 'what the round covers and what it leaves: one sentence');
  assert.doesNotMatch(out, /一轮补不完|约还要/);
  const done = text(renderToStaticMarkup(inApp(m, React.createElement(m.CoverageTopUp, { draft: { id: 'd1', title: 'T', draftVersion: 3, cards: [] }, view: draftView({ covered: small.ids }), onTopUp: noop }), { data: {} })));
  assert.match(done, /每个小节都有题了。/);
  assert.doesNotMatch(done, /为没覆盖的部分补题/);
});

test('while something works on the draft the top-up is that status, with or without the coverage', () => {
  const working = { id: 'j', status: 'running', draftId: 'd1', continued: true, savedCount: 2, requestedTotal: 4 };
  for (const v of [view, null]) {
    const out = renderToStaticMarkup(inApp(m, React.createElement(m.CoverageTopUp, { draft: { id: 'd1', title: 'T', draftVersion: 3, cards: [] }, view: v, jobs: [working], onTopUp: noop }), { data: {} }));
    assert.match(text(out), /补题中 · 草稿 2\/4 题/);
    assert.doesNotMatch(out, /data-coverage-start/);
  }
});

/* ---------- (c) the 资料 row and (d) the reader ---------- */

const rowKey = groupSourcesByDocument(small.sources.map(source => ({ ...source, courses: [], usedBy: [], createdAt: new Date().toISOString() })))[0].key;
const rowData = (coverage) => ({ root: 'lib', sources: small.sources.map(source => ({ ...source, text: undefined, courses: [], usedBy: [], createdAt: new Date().toISOString() })), decks: [], drafts: [], jobs: [], focus: { course: '*', courses: [] }, modelReady: true,
  ...(coverage ? { materialCoverage: { [rowKey]: coverage } } : {}) });
const sourcesPage = (data, language = 'zh') => inLanguage(language, () => renderToStaticMarkup(withStudy(m.StudyServicesContext, React.createElement(m.Sources, { data, setModal: noop, onGenerate: noop }), { call: noop })));

test('the 资料 row shows 覆盖 9% beside the mastery mark, before anything is published (drafts count), and a row without questions shows none', () => {
  const summaryOnly = coverageDigest(cov);
  const out = sourcesPage(rowData(summaryOnly));
  assert.match(text(out), /还没出题/, 'nothing is published: the mastery says so');
  assert.match(text(out), /覆盖 25%/, 'the coverage is there anyway: the draft counts');
  assert.match(out, /<span class="source-doc__quality">[\s\S]*mastery-line[\s\S]*data-coverage-chip/, 'the chip sits next to the mastery line, in the same line');
  assert.equal((out.match(/data-coverage-chip/g) || []).length, 1);
  assert.doesNotMatch(sourcesPage(rowData(null)), /data-coverage-chip/);
  const english = text(sourcesPage(rowData(summaryOnly), 'en'));
  assert.match(english, /Covered 25%/);
});

const entriesOf = (language = 'zh') => {
  const own = small.sources[0], sections = m.readingSections({ text: own.text, sourceId: own.id, group: small.sources });
  const outline = m.structureOutline(m.outlineFromSections(sections));
  return { sections, outline, own };
};

test('the reader outline: a square mark per section and a count per recording, different from the round mastery mark; both can be seen at once', () => {
  const { sections, outline, own } = entriesOf(), oc = outlineCoverage(outline, cov, { sourceId: own.id, sections });
  const mastery = new Map(outline.filter(item => item.kind === 'part').map((item, index) => [item.id, summarizeLinked([{ level: index % 2 ? 'mastered' : 'learning' }])]));
  const html = (props = {}, language = 'zh') => inLanguage(language, () => renderToStaticMarkup(React.createElement(m.OutlinePanel, { items: outline, activeId: 'r1.p1', onJump: noop, labelOf: item => item.kind === 'recording' ? `录音 ${item.recording}` : '',
    coverage: oc, coverageTotals: cov, ...props })));
  const out = html({ meters: mastery });
  const states = state => (out.match(new RegExp(`data-coverage-mark="${state}"`, 'g')) || []).length;
  assert.deepEqual([states('covered'), states('planned-failed'), states('never-planned')], [3, 2, 7], 'exactly the checklist, one mark per section');
  assert.deepEqual([...out.matchAll(/data-coverage-parent[^>]*>(\d+\/\d+)</g)].map(match => match[1]), ['2/4', '1/4', '0/4'], 'the recordings count their parts');
  assert.match(out, /data-coverage-head[\s\S]*覆盖 3\/12/);
  assert.match(out, /只看没覆盖的/);
  assert.match(out, /aria-label="第一部分：预览段落 1：已覆盖"|aria-label="[^"]*第一部分[^"]*：已覆盖"/, 'every mark has an accessible name');
  assert.match(out, /aria-label="[^"]*计划了没出成：审阅回复格式不对，重新审阅后仍不行"/);
  assert.doesNotMatch(out, /<span[^>]*data-coverage-mark[^>]*title=/, 'a tooltip, not a title attribute');
  // the two facts have different marks: coverage is a SQUARE (rect), mastery a RING (circle)
  const coverageMarks = [...out.matchAll(/<span class="cov-mark"[\s\S]*?<\/svg>/g)].map(match => match[0]), masteryMarks = [...out.matchAll(/<span class="mastery-mark[\s\S]*?<\/svg>/g)].map(match => match[0]);
  assert.equal(coverageMarks.length, 12);
  assert.ok(masteryMarks.length >= 6);
  assert.ok(coverageMarks.every(mark => /<rect/.test(mark) && !/<circle/.test(mark)), 'coverage marks are squares');
  assert.ok(masteryMarks.every(mark => /<circle/.test(mark) && !/<rect/.test(mark)), 'mastery marks are rings');
  const none = html({ coverage: null, coverageTotals: null });
  assert.doesNotMatch(none, /data-coverage-/, 'a document with no question at all has no coverage marks');
  const english = text(withoutData(html({ meters: mastery }, 'en')));
  assert.match(english, /Covered 3\/12/);
  assert.match(english, /Only uncovered/);
  assert.match(inLanguage('en', () => html({ meters: mastery }, 'en')), /aria-label="[^"]*Planned, not produced: The review reply stayed malformed after being reviewed again"/);
});

test('只看没覆盖的: the sections with no question and the recordings they are in, in the outline\'s own order', () => {
  const { sections, outline, own } = entriesOf(), oc = outlineCoverage(outline, cov, { sourceId: own.id, sections });
  const out = renderToStaticMarkup(React.createElement(m.OutlinePanel, { items: outline, activeId: 'r1.p1', onJump: noop, coverage: oc, coverageTotals: cov, initialOnlyUncovered: true }));
  const rows = [...out.matchAll(/<li data-depth="(\d)"/g)].map(match => Number(match[1]));
  assert.equal(rows.length, 9 + 3, 'nine sections with no question and the three recordings that hold them');
  assert.equal((out.match(/data-coverage-mark="covered"/g) || []).length, 0, 'what is covered is not listed');
  assert.equal(oc.uncovered.size, 12);
  const all = renderToStaticMarkup(React.createElement(m.OutlinePanel, { items: outline, activeId: 'r1.p1', onJump: noop, coverage: oc, coverageTotals: cov }));
  assert.equal([...all.matchAll(/<li data-depth/g)].length, outline.length);
  assert.match(out, /aria-checked|checked=""/, 'the filter says it is on');
});

test('entries find their sections by id (a transcript), by page (a PDF) and by title (headings), and what cannot be found has no mark', () => {
  const { sections, outline, own } = entriesOf();
  const byId = alignEntries(outline, cov, { sourceId: own.id, sections });
  assert.deepEqual([...byId.values()].map(section => section.id), small.leaves.filter(section => section.sourceId === own.id).map(section => section.id));
  const pages = [1, 2, 3].map(n => ({ id: `p${n}`, text: `Page ${n} text `.repeat(30), document: { page: n } }));
  const pdf = coverageSummaryOf(pages, [{ id: 'c', citations: [{ sourceId: 'p2', quote: 'Page 2 text' }] }]);
  const entries = pages.map(item => ({ id: `page-${item.document.page}-0`, level: 1, title: '', page: item.document.page, parent: null }));
  const aligned = alignEntries(entries, pdf, { sections: pages.map((item, index) => ({ id: `page-${item.document.page}-0`, sourceId: item.id, page: item.document.page, index })) });
  assert.deepEqual([...aligned.entries()].map(([id, section]) => [id, section.state]), [['page-1-0', 'never-planned'], ['page-2-0', 'covered'], ['page-3-0', 'never-planned']]);
  const heading = { id: 'md', text: ['# Book', '', '## One', '', 'Body of one here.', '', '## Two', '', 'Quoted body of two here.', '', '## Three', '', 'Body three.'].join('\n') };
  const md = coverageSummaryOf([heading], [{ id: 'q', citations: [{ sourceId: 'md', quote: 'Quoted body of two here.' }] }]);
  const rendered = [{ id: 'h-0', level: 1, title: 'Book', parent: null }, { id: 'h-1', level: 2, title: 'One', parent: 'h-0' }, { id: 'h-2', level: 2, title: 'Two', parent: 'h-0' }, { id: 'h-3', level: 2, title: 'Three', parent: 'h-0' }, { id: 'h-4', level: 2, title: 'Not a section', parent: 'h-0' }];
  const found = outlineCoverage(rendered, md, { sourceId: 'md' });
  assert.deepEqual([...found.aligned.entries()].map(([id, section]) => [id, section.state]), [['h-1', 'never-planned'], ['h-2', 'covered'], ['h-3', 'never-planned']]);
  assert.equal(found.entries.get('h-0').leaves, 3, 'the title above them counts the sections below');
  assert.equal(found.entries.get('h-4'), undefined, 'a heading the sections do not know has no mark');
  assert.deepEqual(rangeCoverageOf(found, new Set(['h-1', 'h-2']), md), { leaves: 2, covered: 1, uncovered: 1 });
  assert.deepEqual(rangeCoverageOf(found, null, md), { leaves: 3, covered: 1, uncovered: 2 });
});

const coverageSummaryOf = (sources, cards) => coverageOf({ sources, cards });

/* ---------- (e) 做这几页的题 ---------- */

test('the 做这几页的题 panel says in one line when part of its range has no question', () => {
  const { sections, outline, own } = entriesOf(), oc = outlineCoverage(outline, cov, { sourceId: own.id, sections });
  const idsOf = n => new Set(outline.filter(item => item.id === `r${n}` || item.id.startsWith(`r${n}.`)).map(item => item.id));
  const loop = (n, extra = {}) => { const selected = { kind: 'here', count: 5, ids: idsOf(n), cards: [], summary: summarizeLinked([{ level: 'new' }, { level: 'mastered' }]) };
    return { open: true, setOpen: noop, status: 'ready', options: [selected], selected, kind: 'here', setKind: noop, reload: noop, inactiveCourses: [], coverage: cov, outlineCoverage: oc, ...extra }; };
  const html = (props, language = 'zh') => inLanguage(language, () => renderToStaticMarkup(React.createElement(m.ReadingPractice, { unit: 'section', onStart: noop, onGenerate: noop, ...props })));
  assert.match(text(html({ loop: loop(1) })), /其中 2 个小节还没有题（共 4 个）/, 'recording 1: two of its four parts have none');
  assert.match(text(html({ loop: loop(2) })), /其中 3 个小节还没有题（共 4 个）/);
  assert.doesNotMatch(html({ loop: loop(3) }), /practice-coverage/, 'nothing covered in the range: the panel already says there are no questions, not twice');
  const full = draftView({ covered: small.ids }).coverage, ocFull = outlineCoverage(outline, full, { sourceId: own.id, sections });
  assert.doesNotMatch(html({ loop: loop(1, { coverage: full, outlineCoverage: ocFull }) }), /practice-coverage/, 'everything covered: nothing to say');
  assert.doesNotMatch(html({ loop: loop(1, { coverage: null, outlineCoverage: null }) }), /practice-coverage/, 'no coverage yet: nothing is guessed');
  assert.match(text(html({ loop: loop(1) }, 'en')), /2 of the 4 sections here have no question yet/);
  const pages = { ...cov, units: 'page' };
  assert.match(text(html({ loop: loop(1, { coverage: pages }) })), /这几页里有 2 页还没有题（共 4 页）/);
});

/* ---------- the same numbers everywhere (student-side check) ---------- */

test('student-side: before practising, every screen tells the same story about the same material', () => {
  seedConsole();
  const page = text(summaryHtml(view)), row = text(sourcesPage(rowData(coverageDigest(cov))));
  const homeData = { jobs: [], drafts: [{ id: 'd1', title: 'T', draftVersion: 3, cards: [{ id: 'c1' }], editorial: { requested: 10, generated: 1, completedParts: 1, parts: 1, failures: [], generation: { sourceIds: [small.sources[0].id], kind: 'quiz' } } }], decks: [], sources: [] };
  m.forgetCoverage(); seedView(m, view);
const HomeBoth = (props) => React.createElement(React.Fragment, null, React.createElement(m.HomeActivity, props), React.createElement(m.HomeDrafts, { ...props, defaultOpen: true }));
  const home = text(renderToStaticMarkup(React.createElement(HomeBoth, { jobs: [], drafts: homeData.drafts, busy: false, openDraft: noop, openAgent: noop, cancelJob: noop, dismissJob: noop, retryGeneration: noop, manage: noop, start: noop, topUpDraft: noop, modelReady: true, data: homeData })));
  assert.match(home, /覆盖 3\/12 个小节（25%）/, 'the home 待发布 row');
  assert.match(page, /覆盖 3\/12 个小节（25%）/, 'the draft page');
  assert.match(row, /覆盖 25%/, 'the 资料 row: the same percentage');
  const { sections, outline, own } = entriesOf(), oc = outlineCoverage(outline, cov, { sourceId: own.id, sections });
  assert.match(text(renderToStaticMarkup(React.createElement(m.OutlinePanel, { items: outline, activeId: 'r1.p1', onJump: noop, coverage: oc, coverageTotals: cov }))), /覆盖 3\/12/, 'the reader outline');
  seedConsole();
  const rows = [...parts(contract([part(1), part(2), part(3)])).matchAll(/<span>覆盖 (\d+)\/\d+ 小节<\/span>/g)].map(match => Number(match[1]));
  assert.equal(rows.reduce((a, b) => a + b, 0), cov.covered, 'the parts of the run add up to the same covered count');
  // asked is not learned: the coverage chip never speaks of mastery and the mastery line never of coverage
  assert.doesNotMatch(row.replace(/还没出题/, ''), /掌握 \d+%/, 'no mastery is invented for a draft');
});

test('the list of what has no question and "everything is covered" speak in the unit of the material (pages, chapters, sections, segments)', () => {
  assert.deepEqual(['part', 'page', 'chapter', 'heading', 'window', 'section'].map(unit => m.uncoveredHead(unit, 4)), ['没覆盖的小节 · 4', '没覆盖的页 · 4', '没覆盖的章节 · 4', '没覆盖的小节 · 4', '没覆盖的片段 · 4', '没覆盖的小节 · 4']);
  assert.deepEqual(['part', 'page', 'chapter', 'heading', 'window', 'section'].map(unit => m.allCoveredText(unit)), ['每个小节都有题了。', '每一页都有题了。', '每个章节都有题了。', '每个小节都有题了。', '每个片段都有题了。', '每个小节都有题了。']);
  inLanguage('en', () => {
    assert.deepEqual(['part', 'page', 'chapter', 'heading', 'window'].map(unit => m.uncoveredHead(unit, 4)), ['Uncovered sections · 4', 'Uncovered pages · 4', 'Uncovered chapters · 4', 'Uncovered sections · 4', 'Uncovered segments · 4']);
    assert.deepEqual(['part', 'page', 'window'].map(unit => m.allCoveredText(unit)), ['Every section has questions.', 'Every page has questions.', 'Every segment has questions.']);
  });
  assert.equal(m.uncoveredHead('unknown', 2), '没覆盖的小节 · 2', 'an unknown unit is called sections');
});
