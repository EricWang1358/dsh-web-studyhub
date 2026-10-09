import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { loadUi } from './helpers/ui-module.mjs';

/* 模拟考试 交卷: the 还有 N 题未作答 question is asked only when N is more than 0. A full paper is handed in at once (the case paper
   does the same), and the time-limit auto-submit never asks. */

const run = (...keys) => ({ id: 'r1', total: keys.length, picks: keys.map(key => { const [deckId, cardId] = key.split(':'); return { deckId, cardId, selected: null }; }) });

test('the unanswered count follows the picks the learner holds, not the paper size alone', async () => {
  const { unansweredCount } = await loadUi("export * from './ui/exam/exam-written.js';");
  const paper = run('d:a', 'd:b', 'd:c');
  assert.equal(unansweredCount(paper, {}), 3, 'nothing picked: all of them');
  assert.equal(unansweredCount(paper, { 'd:a': ['x'] }), 2);
  assert.equal(unansweredCount(paper, { 'd:a': ['x'], 'd:b': ['y'], 'd:c': ['z'] }), 0, 'every question answered: none left');
  assert.equal(unansweredCount(paper, { 'd:a': ['x'], 'd:b': [], 'd:c': ['z'] }), 1, 'a multi-choice question whose ticks were all taken back is open again');
  assert.equal(unansweredCount(paper, { 'd:a': ['x'], 'd:b': ['y'], 'd:c': ['z'], 'other:q': ['k'] }), 0, 'a pick that is not on this paper does not count, and never makes the count negative');
  assert.equal(unansweredCount(paper, { 'd:a': ['x'], 'other:q': ['k'], 'other:r': ['k'] }), 2, 'nor does it hide an open question');
  assert.equal(unansweredCount({ total: 4 }, { 'd:a': ['x'] }), 3, 'a run without the pick list falls back to total minus answered');
  assert.equal(unansweredCount(null, {}), 0);
});

test('the same cards in two decks count as two questions', async () => {
  const { unansweredCount } = await loadUi("export * from './ui/exam/exam-written.js';");
  const paper = run('d1:q', 'd2:q');
  assert.equal(unansweredCount(paper, { 'd1:q': ['a'] }), 1);
});

test('交卷 asks only when something is unanswered', async () => {
  const source = (await readFile(new URL('../ui/Exam.jsx', import.meta.url), 'utf8')).replace(/\r\n/g, '\n');
  assert.match(source, /expired \|\| !unanswered \? submit : \(\) => setConfirming\(true\)/, 'a full paper is handed in at once; the time-up retry never asks');
  assert.match(source, /\{confirming && unanswered > 0 &&/, 'and the dialog never shows a zero');
});
