// #1459: the 0–5 scale stays, but 0 and 1 must read differently. These tests pin the three things the
// issue promises and nothing else: the words are in one place, the preview distinguishes 0 from 1, and
// the unchanged `grade >= 3` line plus old stored grades still produce the same verdicts and statistics.
//
// Run: node --test tests/issue-1459-grade-scale-semantics.test.mjs
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, test } from 'node:test';
import { register } from 'tsx/esm/api';
import { StudyService } from '../../../lib/service.js';
import { importExample } from '../../../ui/json-prompts.js';
import { createFakeModel } from '../../../scripts/fake-model.mjs';

const unregisterTsx = register();
after(() => unregisterTsx?.());

const [{ parseAssistantIntent }, scale] = await Promise.all([
  import('../src/shell/assistant-intent.ts'),
  import('../src/grade-scale.ts'),
]);

const SOURCE_TEXT = 'Bridge separates an abstraction from its implementation so the two can vary independently.';

async function library(t, { options = {} } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'study-1459-'));
  const service = new StudyService(root, options);
  t.after(async () => {
    service.dispose();
    await rm(root, { recursive: true, force: true });
  });
  await service.call('source.add', { id: 's', title: 'Bridge', text: SOURCE_TEXT });
  const base = JSON.parse(importExample('quiz')).cards[0];
  await service.call('draft.save', {
    deck: {
      id: 'd',
      title: 'Round',
      cards: ['q1', 'q2', 'q3', 'q4'].map((id) => ({
        ...base,
        id,
        prompt: `${base.prompt} (${id})`,
        objective: `${base.objective} (${id})`,
        citations: [{ sourceId: 's', quote: SOURCE_TEXT }],
      })),
    },
  });
  await service.call('draft.publish', { id: 'd' });
  return { root, service };
}

const gradeCtx = (lang = 'zh') => ({
  currentCardId: 'o1',
  currentDeckId: 'open-deck',
  card: { cardId: 'o1', deckId: 'open-deck', runId: 'r', cardIndex: 0 },
  lang,
});

const previewFor = (grade) => parseAssistantIntent(`把这道题改判为${grade}分`, gradeCtx()).previewMessage;

describe('#1459 · 1) one place describes 0–5, and it keeps the backend pass line', () => {
  test('all six grades have words, and only 3–5 count as correct', () => {
    assert.deepEqual(scale.GRADE_SEMANTICS.map((item) => item.grade), [0, 1, 2, 3, 4, 5]);
    assert.deepEqual(scale.GRADE_SEMANTICS.map((item) => item.countsCorrect), [false, false, false, true, true, true]);
    assert.equal(scale.countsAsCorrect(2), false);
    assert.equal(scale.countsAsCorrect(3), true);
  });

  test('0 and 1 say different things in both languages', () => {
    assert.equal(scale.gradeLabel(0, 'zh'), '没有作答 / 完全不对');
    assert.equal(scale.gradeLabel(1, 'zh'), '答对一小部分（关键点缺失）');
    assert.notEqual(scale.gradeLabel(0, 'zh'), scale.gradeLabel(1, 'zh'));
    assert.equal(scale.gradeShortLabel(0, 'zh'), '未作答/完全不会');
    assert.equal(scale.gradeShortLabel(1, 'zh'), '部分对');
    assert.match(scale.gradeLabel(0, 'en'), /No answer/);
    assert.match(scale.gradeLabel(1, 'en'), /small part/);
  });

  test('an unknown or missing grade reads as unknown instead of throwing or passing', () => {
    for (const value of [undefined, null, -1, 6, 2.5, Number.NaN]) {
      assert.equal(scale.gradeSemantics(value), undefined, String(value));
      assert.equal(scale.gradeLabel(value, 'zh'), '');
      assert.equal(scale.countsAsCorrect(value), false, String(value));
    }
  });
});

describe('#1459 · 2) the adjustment preview says what the grade means', () => {
  test('0, 1 and 2 are three different previews, all still “not mastered”', () => {
    const zero = previewFor(0);
    const one = previewFor(1);
    const two = previewFor(2);
    assert.match(zero, /没有作答|完全不对/);
    assert.match(one, /答对一小部分|部分对/);
    assert.match(two, /接近正确/);
    assert.notEqual(zero, one);
    assert.notEqual(one, two);
    for (const message of [zero, one, two]) assert.match(message, /仍算未掌握/);
  });

  test('3–5 read as correct and keep the existing “掌握” wording', () => {
    for (const grade of [3, 4, 5]) {
      const message = previewFor(grade);
      assert.match(message, /判定为掌握/, String(grade));
      assert.doesNotMatch(message, /仍算未掌握/, String(grade));
    }
    assert.match(previewFor(3), /正确（及格）/);
    assert.match(previewFor(4), /良好/);
    assert.match(previewFor(5), /完整/);
    assert.notEqual(previewFor(4), previewFor(5));
  });

  test('the English preview distinguishes 0 from 1 too', () => {
    const zero = parseAssistantIntent('把这道题改判为0分', gradeCtx('en')).previewMessage;
    const one = parseAssistantIntent('把这道题改判为1分', gradeCtx('en')).previewMessage;
    assert.match(zero, /No answer/);
    assert.match(one, /small part/);
    assert.match(zero, /still not mastered/);
    assert.notEqual(zero, one);
  });
});

describe('#1459 · 3) the backend line is still grade >= 3', () => {
  test('a real review.grade.adjust keeps 2 wrong and 3 correct', async (t) => {
    const criteria = [
      { id: 'c1', label: 'Core idea', marks: 2, descriptor: 'Names the idea.', keyPoints: ['Bridge'] },
      { id: 'c2', label: 'Link', marks: 1, descriptor: 'Ties it to the case.', keyPoints: ['abstraction'] },
    ];
    const { service } = await library(t, { options: { complete: createFakeModel() } });
    await service.store.update((state) => {
      state.decks.push({
        id: 'open-deck',
        title: 'Open',
        cards: [{
          id: 'o1', kind: 'open', topic: 'Bridge', objective: 'Explain bridge',
          prompt: 'Why does Bridge help?', answer: 'It separates abstraction from implementation.',
          hint: 'Think about variation.', explanation: 'Both sides vary independently.', misconception: 'Confusing it with adapter.',
          marks: 3, rubricCriteria: criteria, rubric: 'core idea 2; link 1',
          citations: [{ sourceId: 's', quote: SOURCE_TEXT }],
        }],
      });
    });
    const run = await service.call('review.start', { mode: 'path', scope: [{ deckId: 'open-deck', cardId: 'o1' }], fresh: true });
    await service.call('card.grade', {
      deckId: 'open-deck',
      cardId: 'o1',
      runId: run.id,
      answer: 'Bridge separates an abstraction from its implementation, so both sides vary on their own.',
    });
    const graded = await service.call('review.get', { runId: run.id });
    assert.ok(graded.feedback?.rubric, 'the answer was graded by rubric');

    const at2 = await service.call('review.grade.adjust', { runId: run.id, cardId: 'o1', entryIndex: 0, grade: 2 });
    assert.equal(at2.feedback.grade, 2);
    assert.equal(at2.feedback.correct, false, 'grade 2 is still a miss');

    const at3 = await service.call('review.grade.adjust', { runId: run.id, cardId: 'o1', entryIndex: 0, grade: 3 });
    assert.equal(at3.feedback.grade, 3);
    assert.equal(at3.feedback.correct, true, 'grade 3 is still a pass');
  });
});

describe('#1459 · 4) old grades are read, never migrated or re-counted', () => {
  test('stored 0/1/2/3 keep their grades and the same statistics before and after the display layer reads them', async (t) => {
    const { service } = await library(t);
    await service.store.update((state) => {
      state.attempts.push(
        { deckId: 'd', quiz_id: 'q1', assessment: 'graded', grade: 0, timestamp: '2026-10-01T01:00:00Z' },
        { deckId: 'd', quiz_id: 'q2', assessment: 'graded', grade: 1, timestamp: '2026-10-01T02:00:00Z' },
        { deckId: 'd', quiz_id: 'q3', assessment: 'graded', grade: 2, timestamp: '2026-10-01T03:00:00Z' },
        { deckId: 'd', quiz_id: 'q4', assessment: 'graded', grade: 1, timestamp: '2026-10-01T04:00:00Z' },
        { deckId: 'd', quiz_id: 'q4', assessment: 'graded', grade: 3, timestamp: '2026-10-01T05:00:00Z' },
      );
    });

    const statsBefore = await service.call('stats', {});
    const weakBefore = await service.call('wrongbook', { view: 'weak', limit: 50 });
    const historyBefore = await service.call('wrongbook', { view: 'history', limit: 50 });

    // The unchanged pass line, read from the same store: 0/1/2 are weak, 3 is history.
    assert.equal(weakBefore.total, 3);
    assert.equal(historyBefore.total, 1);
    assert.deepEqual(weakBefore.items.map((item) => item.lastGrade).sort(), [0, 1, 2]);

    // The display layer reads the old grades (0 and 1 stay distinguishable)…
    for (const item of weakBefore.items) {
      assert.ok(scale.gradeLabel(item.lastGrade, 'zh'), `grade ${item.lastGrade} has words`);
    }
    assert.notEqual(scale.gradeLabel(0, 'zh'), scale.gradeLabel(1, 'zh'));

    // …and changes neither the stored grades nor any statistic.
    const statsAfter = await service.call('stats', {});
    const weakAfter = await service.call('wrongbook', { view: 'weak', limit: 50 });
    const historyAfter = await service.call('wrongbook', { view: 'history', limit: 50 });
    assert.deepEqual(
      { ...statsAfter, generatedAt: null },
      { ...statsBefore, generatedAt: null },
      'statistics do not move',
    );
    assert.deepEqual(weakAfter, weakBefore, 'the wrong book does not move');
    assert.deepEqual(historyAfter, historyBefore, 'the recovered list does not move');

    const state = await service.store.read();
    assert.deepEqual(
      state.attempts.map((attempt) => attempt.grade).sort(),
      [0, 1, 1, 2, 3],
      'no stored grade was rewritten',
    );
  });
});
