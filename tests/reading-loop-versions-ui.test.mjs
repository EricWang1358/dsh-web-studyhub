/* The reader's 整份资料 range counts every question of the document, those written from an older version included (2.6.2): the
   range chooser says so ("含旧版本 N 题", one set of words in practice/mastery-copy.js), starts exactly the questions it counts,
   and the other ranges (本节 / 刚读过的 / 本章) still hold only what is placed in the version being read. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { summarizeLinked } from '../lib/material-summary.js';
import { assignCards, rangeOptions, refsOf } from '../ui/document-preview/practice/practice-range.js';
import { structureOutline } from '../ui/document-preview/reader/outline.js';

const require = createRequire(import.meta.url);
const han = /[㐀-鿿]/;
const compiled = await build({ stdin: { contents: `export * from './ui/i18n.js';
  export * from './ui/document-preview/practice/mastery-copy.js';
  export { default as ReadingPractice } from './ui/document-preview/practice/ReadingPractice.jsx';`, resolveDir: process.cwd() },
  bundle: true, write: false, platform: 'node', format: 'cjs', external: ['react'], loader: { '.css': 'text' }, logLevel: 'silent' });
const instance = { exports: {} };
new Function('require', 'module', 'exports', compiled.outputFiles[0].text)(require, instance, instance.exports);
const load = () => instance.exports;
const render = element => renderToStaticMarkup(element);
const e = React.createElement;

const entry = (id, level, sourceId, extra = {}) => ({ deckId: 'd', cardId: id, level, due: false, inactive: false, links: [{ sourceId, start: 0, end: 3 }], ...extra });
const outline = structureOutline([{ id: 'a', level: 1, title: 'A' }, { id: 'b', level: 1, title: 'B' }], { fold: false });
/** Two questions of the version being read (placed in section a), three of an older version (never placed in this text). */
const cards = [entry('n1', 'new', 'cur'), entry('n2', 'mastered', 'cur'),
  entry('o1', 'weak', 'old', { due: true, otherVersion: true }), entry('o2', 'new', 'old', { otherVersion: true }), entry('o3', 'new', 'old', { otherVersion: true })];
const place = link => link.sourceId === 'cur' ? 'a' : null;

test('the other ranges hold only what is placed in the visible version; the whole document holds everything, older questions included', () => {
  const { assigned, unplaced } = assignCards(cards, place);
  assert.deepEqual(unplaced.map(card => card.cardId), ['o1', 'o2', 'o3'], 'an old version\'s question has no place in the text being read');
  const options = rangeOptions({ outline, activeId: 'a', visited: [], assigned, all: cards });
  assert.deepEqual(options.map(option => option.kind), ['here', 'document']);
  const [here, whole] = options;
  assert.equal(here.summary.total, 2, 'this section: the placed questions only');
  assert.equal(here.olderCards, undefined);
  assert.equal(whole.summary.total, 5);
  assert.equal(whole.olderCards, 3);
  assert.equal(whole.summary.due, 1);
  assert.deepEqual(refsOf(whole.cards).map(ref => ref.cardId), ['n1', 'n2', 'o1', 'o2', 'o3'], 'start practising exactly the cards counted, the old ones included');
  assert.equal(refsOf(whole.cards).length, whole.summary.total);
});

test('with no outline the one option is the whole document and carries the older count too', () => {
  const options = rangeOptions({ outline: [], activeId: null, visited: [], assigned: new Map(), all: cards });
  assert.deepEqual(options.map(option => option.kind), ['document']);
  assert.equal(options[0].olderCards, 3);
  assert.equal(options[0].summary.total, 5);
  assert.equal(rangeOptions({ outline: [], activeId: null, visited: [], assigned: new Map(), all: cards.slice(0, 2) })[0].olderCards, 0);
});

test('the words: 含旧版本 N 题 / Includes N questions from older versions', () => {
  const { setUiLanguage, olderText } = load();
  setUiLanguage('zh');
  assert.equal(olderText(1), '含旧版本 1 题');
  assert.equal(olderText(4), '含旧版本 4 题');
  setUiLanguage('en');
  assert.equal(olderText(1), 'Includes 1 question from an older version');
  assert.equal(olderText(4), 'Includes 4 questions from older versions');
  assert.doesNotMatch(olderText(4), han);
  setUiLanguage('zh');
});

const loopOf = (options, selectedKind = options[0].kind) => ({ open: true, setOpen() {}, status: 'ready', options, selected: options.find(option => option.kind === selectedKind),
  kind: selectedKind, setKind() {}, reload() {}, inactiveCourses: [] });
const practice = loop => e(load().ReadingPractice, { loop, unit: 'section', onStart() {}, onGenerate() {} });

test('the range chooser says so on the whole-document option only, in both languages, and never with a title attribute', () => {
  const { setUiLanguage } = load();
  const { assigned } = assignCards(cards, place), options = rangeOptions({ outline, activeId: 'a', visited: [], assigned, all: cards });
  setUiLanguage('zh');
  const zh = render(practice(loopOf(options, 'document')));
  assert.ok(zh.includes('含旧版本 3 题'));
  assert.equal((zh.match(/含旧版本/g) || []).length, 1, 'once: on the 整份资料 option');
  assert.ok(zh.includes('开始做这 5 道题'));
  assert.ok(zh.includes('5 道题 · 1 道到期'), 'the counts line is the row\'s');
  assert.doesNotMatch(zh, /title="[^"]*含旧版本/);
  const here = render(practice(loopOf(options, 'here')));
  assert.equal((here.match(/含旧版本/g) || []).length, 1, 'the note belongs to the option, so it does not appear or vanish when the selection moves');
  setUiLanguage('en');
  const en = render(practice(loopOf(options, 'document')));
  assert.doesNotMatch(en, han);
  assert.ok(en.includes('Includes 3 questions from older versions'));
  assert.ok(en.includes('Practise these 5 questions'));
  setUiLanguage('zh');
});

test('a document with no outline: the single scope line carries the note; no note when nothing is older', () => {
  const { setUiLanguage } = load();
  setUiLanguage('zh');
  const options = rangeOptions({ outline: [], activeId: null, visited: [], assigned: new Map(), all: cards });
  const html = render(practice(loopOf(options)));
  assert.ok(html.includes('整份资料') && html.includes('含旧版本 3 题'));
  const clean = render(practice(loopOf(rangeOptions({ outline: [], activeId: null, visited: [], assigned: new Map(), all: cards.slice(0, 2) }))));
  assert.doesNotMatch(clean, /含旧版本/);
  setUiLanguage('en');
  assert.doesNotMatch(render(practice(loopOf(options))), han);
  setUiLanguage('zh');
});

test('summarizeLinked of the counted cards is what the panel prints (the 资料 row prints the same summary of the same set)', () => {
  const { assigned } = assignCards(cards, place), whole = rangeOptions({ outline, activeId: 'a', visited: [], assigned, all: cards }).find(option => option.kind === 'document');
  assert.deepEqual(whole.summary, summarizeLinked(cards));
});

/* ---------- other materials of the same recording, and the recordings a merged material contains ---------- */

const mixed = [entry('n1', 'new', 'cur'), entry('n2', 'weak', 'cur', { due: true }),
  entry('o1', 'new', 'old', { otherVersion: true }),
  entry('s1', 'new', 'dup', { otherMaterial: 'same' }), entry('s2', 'new', 'dup', { otherMaterial: 'same' }),
  entry('p1', 'mastered', 'rec1', { otherMaterial: 'part' }), entry('p2', 'new', 'rec2', { otherMaterial: 'part' }), entry('p3', 'new', 'rec2', { otherMaterial: 'part' })];

test('the whole-document option counts older, same-recording and constituent questions apart and starts exactly all of them', () => {
  const { assigned } = assignCards(mixed, place), options = rangeOptions({ outline, activeId: 'a', visited: [], assigned, all: mixed });
  const whole = options.find(option => option.kind === 'document');
  assert.deepEqual([whole.summary.total, whole.olderCards, whole.sameRecordingCards, whole.partCards], [8, 1, 2, 3]);
  assert.equal(options.find(option => option.kind === 'here').summary.total, 2, 'the placed questions only');
  assert.equal(refsOf(whole.cards).length, 8, 'start practising exactly the cards counted');
  assert.deepEqual(new Set(refsOf(whole.cards).map(ref => ref.cardId)), new Set(mixed.map(card => card.cardId)));
});

test('the words of the other two counts, separate from 含旧版本, in both languages', () => {
  const { setUiLanguage, sameRecordingText, partsText, inclusionNote } = load();
  setUiLanguage('zh');
  assert.equal(sameRecordingText(2), '含同一录音的其他资料 2 题');
  assert.equal(sameRecordingText(1), '含同一录音的其他资料 1 题');
  assert.equal(partsText(3), '含分录音资料 3 题');
  assert.equal(partsText(1), '含分录音资料 1 题');
  assert.equal(inclusionNote({ olderCards: 1, sameRecordingCards: 2, partCards: 3 }), '含旧版本 1 题 · 含同一录音的其他资料 2 题 · 含分录音资料 3 题');
  assert.equal(inclusionNote({ olderCards: 0, sameRecordingCards: 0, partCards: 3 }), '含分录音资料 3 题');
  assert.equal(inclusionNote({ summary: {} }), '');
  setUiLanguage('en');
  assert.equal(sameRecordingText(2), 'Includes 2 questions from other materials of the same recording');
  assert.equal(sameRecordingText(1), 'Includes 1 question from another material of the same recording');
  assert.equal(partsText(3), 'Includes 3 questions from the separate recordings it contains');
  assert.equal(partsText(1), 'Includes 1 question from a separate recording');
  assert.doesNotMatch(inclusionNote({ olderCards: 1, sameRecordingCards: 2, partCards: 3 }), han);
  setUiLanguage('zh');
});

test('the range chooser shows one note line on the whole-document option, listing every count that is above zero, in both languages', () => {
  const { setUiLanguage } = load();
  const { assigned } = assignCards(mixed, place), options = rangeOptions({ outline, activeId: 'a', visited: [], assigned, all: mixed });
  setUiLanguage('zh');
  const zh = render(practice(loopOf(options, 'document')));
  assert.ok(zh.includes('含旧版本 1 题 · 含同一录音的其他资料 2 题 · 含分录音资料 3 题'));
  assert.equal((zh.match(/reader-practice__older/g) || []).length, 1, 'one note line');
  assert.ok(zh.includes('开始做这 8 道题'));
  assert.doesNotMatch(zh, /title="[^"]*含/);
  const onlyParts = rangeOptions({ outline, activeId: 'a', visited: [], assigned: assignCards(mixed.slice(5), place).assigned, all: mixed.slice(5) });
  const parts = render(practice(loopOf(onlyParts)));
  assert.ok(parts.includes('含分录音资料 3 题') && !parts.includes('含旧版本') && !parts.includes('含同一录音'));
  setUiLanguage('en');
  const en = render(practice(loopOf(options, 'document')));
  assert.doesNotMatch(en, han);
  assert.ok(en.includes('Includes 1 question from an older version · Includes 2 questions from other materials of the same recording · Includes 3 questions from the separate recordings it contains'));
  setUiLanguage('zh');
});
