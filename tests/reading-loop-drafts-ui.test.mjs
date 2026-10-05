/* The reading loop's words when a source's questions are still in drafts (a generation run's result is a draft until it is
   published): 还没发布 · 草稿里有 N 题 instead of 还没出题, 另有 N 题在草稿 beside published questions, and the way to the draft in
   the reader's range chooser. One place for the words: ui/document-preview/practice/mastery-copy.js. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { summarizeLinked } from '../lib/material-summary.js';
import { assignCards, draftToOpen, rangeOptions } from '../ui/document-preview/practice/practice-range.js';
import { structureOutline } from '../ui/document-preview/reader/outline.js';

const require = createRequire(import.meta.url);
const han = /[㐀-鿿]/;
const compiled = await build({ stdin: { contents: `export * from './ui/i18n.js';
  export * from './ui/document-preview/practice/mastery-copy.js';
  export { default as ReadingPractice } from './ui/document-preview/practice/ReadingPractice.jsx';
  export { MasteryMark, MasteryLine } from './ui/document-preview/practice/MasteryMark.jsx';
  export { default as OutlinePanel } from './ui/document-preview/reader/OutlinePanel.jsx';
  export { ChapterList } from './ui/Sources.jsx';`, resolveDir: process.cwd() },
  bundle: true, write: false, platform: 'node', format: 'cjs', external: ['react'], loader: { '.css': 'text' }, logLevel: 'silent' });
const instance = { exports: {} };
new Function('require', 'module', 'exports', compiled.outputFiles[0].text)(require, instance, instance.exports);
const load = () => instance.exports;
const render = element => renderToStaticMarkup(element);
const e = React.createElement;

const none = (draftCards = 0) => ({ ...summarizeLinked([]), ...(draftCards ? { draftCards } : {}) });
const some = (draftCards = 0) => ({ ...summarizeLinked([{ level: 'new' }, { level: 'mastered' }]), ...(draftCards ? { draftCards } : {}) });
const attr = html => (html.match(/(?:aria-label|title)="([^"]*)"/g) || []).join(' ');

test('the words: nothing published but drafts, and drafts beside published questions (zh and en)', () => {
  const { setUiLanguage, masteryText, markLabel, draftNoneText, draftExtraText } = load();
  setUiLanguage('zh');
  assert.equal(masteryText(none()), '还没出题');
  assert.equal(masteryText(none(3)), '还没发布 · 草稿里有 3 题');
  assert.equal(draftNoneText(1), '还没发布 · 草稿里有 1 题');
  assert.equal(draftExtraText(2), '另有 2 题在草稿');
  assert.equal(masteryText(some(2)), '掌握 50% · 2 题', 'published questions keep the mastery text');
  assert.equal(markLabel('第 3 页', none(3)), '第 3 页：还没发布 · 草稿里有 3 题');
  assert.equal(markLabel('第 3 页', none()), '第 3 页：还没出题');
  assert.equal(markLabel('第 3 页', some(2)), '第 3 页：学习中 · 掌握 50% · 2 题 · 另有 2 题在草稿');
  setUiLanguage('en');
  assert.equal(masteryText(none(3)), 'Not published yet · 3 questions in drafts');
  assert.equal(draftNoneText(1), 'Not published yet · 1 question in drafts');
  assert.equal(draftExtraText(1), '1 more in drafts');
  assert.equal(draftExtraText(2), '2 more in drafts');
  assert.doesNotMatch(markLabel('Page 3', some(2)), han);
  setUiLanguage('zh');
});

test('a 资料 row says the three cases: 还没出题, 还没发布 · 草稿里有 N 题, and the mastery text with the drafts in its tooltip', () => {
  const { setUiLanguage, MasteryLine } = load();
  setUiLanguage('zh');
  const zero = render(e(MasteryLine, { summary: none(), title: '录音' }));
  assert.ok(zero.includes('还没出题') && !zero.includes('草稿'));
  const drafted = render(e(MasteryLine, { summary: none(2), title: '录音' }));
  assert.ok(drafted.includes('还没发布 · 草稿里有 2 题') && !drafted.includes('还没出题'));
  assert.match(drafted, /data-state="none"/, 'it still has no mastery: the mark is the "none" shape');
  const both = render(e(MasteryLine, { summary: some(2), title: '录音' }));
  assert.ok(both.includes('掌握 50% · 2 题'));
  assert.ok(attr(both).includes('另有 2 题在草稿'), 'the drafts are in the tooltip, not another line');
  assert.ok(!(both.match(/<small|<p[ >]/g) || []).length, 'the row does not grow');
  setUiLanguage('en');
  const en = render(e(MasteryLine, { summary: none(2), title: 'Recording' }));
  assert.doesNotMatch(en, han);
  assert.ok(en.includes('Not published yet · 2 questions in drafts'));
  assert.doesNotMatch(render(e(MasteryLine, { summary: some(2), title: 'Recording' })), han);
  setUiLanguage('zh');
});

test('the 资料 chapter rows and the outline meters use the same words', () => {
  const { setUiLanguage, ChapterList, OutlinePanel } = load();
  const item = { key: 'k', format: 'pdf', chapterUnit: 'page', chapters: [
    { index: 0, title: 'One', level: 1, sourceIds: ['a'], startPage: 1, endPage: 1, chars: 10 }, { index: 1, title: 'Two', level: 1, sourceIds: ['b'], startPage: 2, endPage: 2, chars: 10 },
    { index: 2, title: 'Three', level: 1, sourceIds: ['c'], startPage: 3, endPage: 3, chars: 10 }] };
  setUiLanguage('zh');
  const html = render(e(ChapterList, { item, busy: false, onOpen() {}, onGenerate() {}, listId: 'x', mastery: { chapters: { 0: none(4) } } }));
  assert.ok(html.includes('还没发布 · 草稿里有 4 题'));
  assert.equal((html.match(/mastery-line__text">还没出题/g) || []).length, 2, 'the chapters with neither still say so');
  const items = structureOutline([{ id: 'a', level: 1, title: 'Chapter A' }, { id: 'b', level: 1, title: 'Chapter B' }], { fold: false });
  const meters = new Map([['a', none(2)]]);
  const outline = render(e(OutlinePanel, { items, activeId: 'a', onJump() {}, meters, initialOpen: [] }));
  assert.match(outline, /Chapter A：还没发布 · 草稿里有 2 题/);
  assert.match(outline, /Chapter B：还没出题/);
  setUiLanguage('zh');
});

const option = (kind, summary, extra = {}) => ({ kind, count: 1, ids: new Set(['p1']), cards: [], summary, ...extra });
const loopOf = (options, overrides = {}) => ({ open: true, setOpen() {}, status: 'ready', options, selected: options[0], kind: options[0].kind, setKind() {}, reload() {}, inactiveCourses: [], ...overrides });
const practice = (loop, props = {}) => e(load().ReadingPractice, { loop, unit: 'page', onStart() {}, onGenerate() {}, ...props });
const buttons = html => (html.match(/<button/g) || []).length;

test('the reader: no question and no draft keeps its panel; a draft shows the same words and the way to it, besides 为这几页出题', () => {
  const { setUiLanguage } = load();
  setUiLanguage('zh');
  const plain = render(practice(loopOf([option('here', none())]), { onOpenDraft() {} }));
  assert.ok(plain.includes('这几页还没有题') && !plain.includes('草稿'));
  assert.equal(buttons(plain), 2);
  const drafted = loopOf([option('here', none(), { draftCards: 3, draftIds: ['dr1'] })]);
  const zh = render(practice(drafted, { onOpenDraft() {} }));
  assert.ok(zh.includes('还没发布 · 草稿里有 3 题'), 'the same words as the row');
  assert.ok(zh.includes('打开草稿') && zh.includes('发布草稿后才能练习这几页的题'));
  assert.ok(zh.includes('为这几页出题'), 'making new ones is still possible');
  assert.ok(!zh.includes('这几页还没有题'), 'it is not "no questions"');
  assert.equal(buttons(zh), 3, 'the control, the way to the draft, and the generate button');
  assert.ok(!render(practice(drafted)).includes('打开草稿'), 'no way to open it where the host gave none');
  setUiLanguage('en');
  const en = render(practice(drafted, { onOpenDraft() {} }));
  assert.doesNotMatch(en, han);
  assert.ok(en.includes('Not published yet · 3 questions in drafts') && en.includes('Open draft'));
  setUiLanguage('zh');
});

test('the way to the draft picks the first draft of the option that still exists (one may be published or deleted meanwhile)', () => {
  const drafts = [{ id: 'dr2', title: 'Two' }, { id: 'dr3', title: 'Three' }];
  assert.equal(draftToOpen(['dr9', 'dr2', 'dr3'], drafts).id, 'dr2');
  assert.equal(draftToOpen(['dr9'], drafts), null);
  assert.equal(draftToOpen([], drafts), null);
  assert.equal(draftToOpen(undefined, undefined), null);
});

test('the range chooser says the same in each option and shows the drafts beside published questions', () => {
  const { setUiLanguage } = load();
  const here = option('here', none(), { draftCards: 2, draftIds: ['dr1'] });
  const chapter = option('chapter', none());
  const document = option('document', some(), { draftCards: 4, draftIds: ['dr1', 'dr2'] });
  setUiLanguage('zh');
  const zh = render(practice(loopOf([here, chapter, document]), { onOpenDraft() {} }));
  assert.ok(zh.includes('还没发布 · 草稿里有 2 题'));
  assert.ok(zh.includes('还没出题'), 'the option with nothing anywhere');
  const withDrafts = render(practice(loopOf([document], { selected: document }), { onOpenDraft() {} }));
  assert.ok(withDrafts.includes('开始做这 2 道题') && withDrafts.includes('另有 4 题在草稿') && withDrafts.includes('打开草稿'));
  setUiLanguage('en');
  const en = render(practice(loopOf([here, chapter, document]), { onOpenDraft() {} }));
  assert.doesNotMatch(en, han);
  assert.ok(en.includes('Not published yet · 2 questions in drafts') && en.includes('No questions yet'));
  assert.ok(render(practice(loopOf([document], { selected: document }), { onOpenDraft() {} })).includes('4 more in drafts'));
  setUiLanguage('zh');
});

test('range options carry the draft questions of their own range, once each, and the ids of the drafts they are in', () => {
  const outline = structureOutline([{ id: 'a', level: 1, title: 'A' }, { id: 'b', level: 1, title: 'B' }], { fold: false });
  const place = link => link.sourceId === 's1' ? 'a' : 'b';
  const published = assignCards([{ deckId: 'd', cardId: 'p', links: [{ sourceId: 's1' }] }], place);
  const entries = [{ deckId: 'dr1', cardId: 'x', links: [{ sourceId: 's1' }, { sourceId: 's2' }] }, { deckId: 'dr2', cardId: 'y', links: [{ sourceId: 's2' }] }];
  const drafts = assignCards(entries, place);
  const options = rangeOptions({ outline, activeId: 'a', assigned: published.assigned, all: [{ deckId: 'd', cardId: 'p', links: [] }], draftAssigned: drafts.assigned, draftAll: entries });
  const here = options.find(entry => entry.kind === 'here');
  assert.equal(here.draftCards, 1);
  assert.deepEqual(here.draftIds, ['dr1']);
  const noOutline = rangeOptions({ outline: [], activeId: null, assigned: new Map(), all: [], draftAssigned: new Map(), draftAll: entries });
  assert.equal(noOutline[0].draftCards, 2);
  assert.deepEqual(noOutline[0].draftIds.sort(), ['dr1', 'dr2']);
  assert.equal(rangeOptions({ outline, activeId: 'a', assigned: published.assigned, all: [] })[0].draftCards, undefined, 'a caller that passes no drafts gets no draft fields');
});
