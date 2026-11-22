// Unit tests for cloze review helpers: `node --test tests/cloze-helpers.test.mjs`
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { tsImport } from 'tsx/esm/api';

const { buildClozeBlankDiffs, formatClozeDisplay } = await tsImport(
  '../src/views/review/review-helpers.ts',
  import.meta.url,
);

describe('buildClozeBlankDiffs', () => {
  const blanks = [{ id: 'b1' }, { id: 'b2' }, { id: 'b3' }];

  test('matches exact answers and normalizes case and whitespace', () => {
    const solution = {
      cloze: {
        answers: [
          { id: 'b1', value: 'Binary Search' },
          { id: 'b2', value: 'O(log n)' },
          { id: 'b3', value: 'Sorted' },
        ],
      },
    };
    const diffs = buildClozeBlankDiffs(
      blanks,
      { b1: '  binary search  ', b2: 'o(LOG n)', b3: 'Sorted' },
      null,
      solution,
    );
    assert.deepEqual(diffs, [
      { id: 'b1', index: 1, userValue: 'binary search', expected: 'Binary Search', matched: true },
      { id: 'b2', index: 2, userValue: 'o(LOG n)', expected: 'O(log n)', matched: true },
      { id: 'b3', index: 3, userValue: 'Sorted', expected: 'Sorted', matched: true },
    ]);
  });

  test('supports accept[] aliases case-insensitively with trimmed whitespace', () => {
    const solution = {
      cloze: {
        answers: [
          { id: 'b1', value: 'Hypertext Transfer Protocol', accept: ['HTTP', 'http/1.1'] },
          { id: 'b2', value: '443', accept: ['port 443'] },
        ],
      },
    };
    const diffs = buildClozeBlankDiffs(
      [{ id: 'b1' }, { id: 'b2' }],
      { b1: '  http ', b2: ' PORT 443 ' },
      null,
      solution,
    );
    assert.deepEqual(diffs, [
      { id: 'b1', index: 1, userValue: 'http', expected: 'Hypertext Transfer Protocol', matched: true },
      { id: 'b2', index: 2, userValue: 'PORT 443', expected: '443', matched: true },
    ]);
  });

  test('marks mismatches and empty answers as matched=false when expected is known', () => {
    const solution = {
      cloze: {
        answers: [
          { id: 'b1', value: 'Stack' },
          { id: 'b2', value: 'Queue' },
        ],
      },
    };
    const diffs = buildClozeBlankDiffs(
      [{ id: 'b1' }, { id: 'b2' }],
      { b1: 'Heap', b2: '   ' },
      null,
      solution,
    );
    assert.deepEqual(diffs, [
      { id: 'b1', index: 1, userValue: 'Heap', expected: 'Stack', matched: false },
      { id: 'b2', index: 2, userValue: '', expected: 'Queue', matched: false },
    ]);
  });

  test('prefers feedback.details for correct and expected and falls back to feedback.answers', () => {
    const solution = {
      cloze: {
        answers: [
          { id: 'b1', value: 'SolutionOne' },
          { id: 'b2', value: 'SolutionTwo' },
        ],
      },
    };
    const feedback = {
      answers: { b1: 'AliasOne', b2: 'WrongTwo' },
      details: [
        { id: 'b1', correct: true, expected: 'DetailOne' },
        { id: 'b2', correct: false, expected: 'DetailTwo' },
      ],
    };
    const diffs = buildClozeBlankDiffs(
      [{ id: 'b1' }, { id: 'b2' }],
      {},
      feedback,
      solution,
    );
    assert.deepEqual(diffs, [
      { id: 'b1', index: 1, userValue: 'AliasOne', expected: 'DetailOne', matched: true },
      { id: 'b2', index: 2, userValue: 'WrongTwo', expected: 'DetailTwo', matched: false },
    ]);
  });

  test('returns matched=null when expected answer is unknown', () => {
    const diffs = buildClozeBlankDiffs([{ id: 'b1' }], { b1: 'draft' }, null, null);
    assert.deepEqual(diffs, [
      { id: 'b1', index: 1, userValue: 'draft', expected: '', matched: null },
    ]);
  });
});

describe('formatClozeDisplay', () => {
  const blanks = [{ id: 'b1' }, { id: 'b2' }];
  const solution = {
    cloze: {
      answers: [
        { id: 'b1', value: 'TCP' },
        { id: 'b2', value: 'UDP' },
      ],
    },
  };

  test('renders Unicode brackets, full-width blanks, and arrows when ascii=false', () => {
    const text = 'Use {{b1}} for reliability and {{b2}} for speed.';
    assert.equal(
      formatClozeDisplay(text, blanks, {}, false, solution, false),
      'Use 〔#1: ＿＿＿〕 for reliability and 〔#2: ＿＿＿〕 for speed.',
    );
    assert.equal(
      formatClozeDisplay(text, blanks, { b1: 'HTTP' }, true, solution, false),
      'Use 〔#1: HTTP → **TCP**〕 for reliability and 〔#2: **UDP**〕 for speed.',
    );
  });

  test('renders pure ASCII brackets, underscores, and arrows when ascii=true', () => {
    const text = 'Use ___ for reliability and ___ for speed.';
    const unrevealed = formatClozeDisplay(text, blanks, { b1: 'QUIC' }, false, solution, true);
    assert.equal(unrevealed, 'Use [#1: QUIC] for reliability and [#2: ___] for speed.');
    assert.ok(!/[^\x20-\x7e]/.test(unrevealed), 'unrevealed ASCII output must be 7-bit ASCII');

    const revealed = formatClozeDisplay(text, blanks, { b1: 'QUIC' }, true, solution, true);
    assert.equal(revealed, 'Use [#1: QUIC -> **TCP**] for reliability and [#2: **UDP**] for speed.');
    assert.ok(!/[^\x20-\x7e]/.test(revealed), 'revealed ASCII output must be 7-bit ASCII');
  });
});
