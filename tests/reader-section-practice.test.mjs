import test from 'node:test';
import assert from 'node:assert/strict';
import { loadUi } from './helpers/ui-module.mjs';

/* 本节题目 of the reader (#1013, ui/document-preview/practice/section-practice.js): which questions of the section on screen the panel lists, in the order of
   the text, at most 30, and the line under its heading (错题 n · 追问 n · 批注 n), counted from what the reading loop already placed. Pure. */
const m = await loadUi(`export * from './ui/document-preview/practice/section-practice.js';
  export { SHOWN_MAX as WRONG_SHOWN_MAX } from './ui/document-preview/reader/WrongPanel.jsx';
  export { readingPracticeArgs, practiceArgs } from './ui/learning-navigation.js';`);

const card = (cardId, start = 0, extra = {}) => ({ deckId: 'd', cardId, level: 'new', links: [{ sourceId: 's', start, end: start + 5 }], ...extra });
const option = (kind, cards, ids = ['e1']) => ({ kind, ids: new Set(ids), cards, summary: { total: cards.length } });

test('the panel offers 本节 and 本章 from the loop, and shows 本节 unless it has no question', () => {
  const here = option('here', [card('a')]), chapter = option('chapter', [card('a'), card('b')]), recent = option('recent', [card('c')]), document = option('document', []);
  const ranges = m.sectionRanges([here, chapter, recent, document]);
  assert.deepEqual(ranges.map(item => item.kind), ['here', 'chapter'], 'only this section and this chapter: 刚读过 and 整份资料 stay in 做这几页的题');
  assert.equal(m.shownRange(ranges, null).kind, 'here');
  assert.equal(m.shownRange(ranges, 'chapter').kind, 'chapter', 'the one chosen');
  assert.equal(m.shownRange([option('here', []), chapter], null).kind, 'chapter', 'a section with no question shows its chapter');
  assert.equal(m.shownRange([option('here', [])], 'chapter').kind, 'here', 'a choice that is not offered falls back');
  assert.equal(m.shownRange([], null), null);
});

test('the questions are listed in the order of the text, at most 30, the same number as the reader 错题 panel', () => {
  assert.equal(m.SHOWN_MAX, 30);
  assert.equal(m.WRONG_SHOWN_MAX, m.SHOWN_MAX, 'one number for both panels');
  const order = new Map([['e1', 0], ['e2', 1]]);
  const entries = { 'd|late': 'e2', 'd|early': 'e1', 'd|second': 'e1', 'd|nowhere': null };
  const listed = m.questionsOf(option('here', [card('late', 0), card('nowhere', 0), card('second', 90), card('early', 10)]), { entryOf: key => entries[key], order });
  assert.deepEqual(listed.cards.map(item => item.cardId), ['early', 'second', 'late', 'nowhere'], 'by entry, then by place in it; a question with no place last');
  const many = Array.from({ length: 34 }, (_, at) => card(`c${at}`, at));
  const capped = m.questionsOf(option('chapter', many), { entryOf: () => 'e1', order });
  assert.equal(capped.shown.length, 30);
  assert.equal(capped.rest, 4);
  assert.equal(capped.cards.length, 34);
});

test('错题 · 追问 · 批注 count what the loop and the existing reads already hold, for the range shown', () => {
  const cards = [card('a'), card('b'), card('c')];
  const notes = new Map([['e1', new Map([['note|n1', {}], ['note|n2', {}]])], ['e9', new Map([['note|n3', {}]])]]);
  const followups = m.followupsOf([{ kind: 'card', question: 'why?' }, { kind: 'qa-card' }, { kind: 'card' }, { kind: 'passage' }]);
  assert.equal(followups.length, 2, 'a 追问 is a follow-up kept on a question, not a 问答卡 or a 批注');
  assert.deepEqual(m.sectionStats({ cards, wrongKeys: new Set(['d|b', 'd|z']), followups, ids: new Set(['e1']), noteAssigned: notes }),
    { wrong: 1, followups: 2, notes: 2 });
  assert.deepEqual(m.sectionStats({ cards }), { wrong: 0, followups: 0, notes: 0 }, 'nothing read yet counts nothing');
  assert.equal(m.rangeKey([card('b'), card('a')]), m.rangeKey([card('a'), card('b')]), 'the same questions are the same range, in any order');
});

test('the 批注 are placed like the questions: one per passage, its passage as its link', () => {
  const places = m.notePlaces([{ cardId: 'annotation:k1', selection: { sourceId: 's1', start: 4, end: 9, quote: 'words' } }, { cardId: 'annotation:k2', selection: {} }]);
  assert.equal(places.length, 1, 'a 批注 with no passage has no place');
  assert.deepEqual(places[0].links[0], { sourceId: 's1', start: 4, end: 9, selection: { sourceId: 's1', start: 4, end: 9, quote: 'words' } });
});

test('the reader starts its round with the very arguments of 做这几页的题: a path round of those questions that keeps where the learner was reading', () => {
  const refs = [{ deckId: 'd', cardId: 'a' }], reading = { documentId: 'doc', sectionId: 'e1', sectionOffset: 12 };
  assert.deepEqual(m.readingPracticeArgs(refs, reading, 'library'),
    { ...m.practiceArgs(refs), reading: { ...reading, origin: { page: 'library' } } });
  assert.equal(m.readingPracticeArgs(refs, reading, 'library').mode, 'path');
  assert.equal(m.readingPracticeArgs(refs, reading, 'library').fresh, true);
});

test('a question looks up its own parts inside its own .review-body: the reader round sits over the practice page (#1013)', async () => {
  const { readFile } = await import('node:fs/promises');
  const own = /document\.querySelector(All)?\(\s*['"`]\.(assist-|question-)/;
  for (const file of ['../ui/review/QuestionRun.jsx', '../ui/review/PracticeTip.jsx', '../ui/document-preview/practice/SectionPractice.jsx']) {
    const text = await readFile(new URL(file, import.meta.url), 'utf8');
    assert.doesNotMatch(text, own, `${file}: no page-wide lookup of a question's part`);
  }
  const tip = await readFile(new URL('../ui/review/PracticeTip.jsx', import.meta.url), 'utf8');
  assert.match(tip, /const scope = card\.closest\('\.review-body'\) \|\| document;/);
  assert.doesNotMatch(tip, /document\.querySelectorAll\(control\)/, 'the tip finds its control in its own question');
  const run = await readFile(new URL('../ui/review/QuestionRun.jsx', import.meta.url), 'utf8');
  assert.match(run, /onAskMore=\{\(event\) => \{ const body = event\?\.currentTarget\?\.closest\?\.\("\.review-body"\)/, '继续追问 opens the 追问 box of its own question');
});
