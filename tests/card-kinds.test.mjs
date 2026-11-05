import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CARD_KIND_IDS, CARD_KIND_LIST, EXAM_KIND_IDS, GENERATE_KIND_IDS, GRADED_FIRST_KIND_IDS, INGEST_KIND_IDS, hasOptions, isExamKind, isGraded, kindOf,
  oneAnswer, practiceCost } from '../lib/card-kinds.js';
import { CARD_KINDS } from '../lib/domain.js';
import { BASIC_KINDS, GENERATION_KINDS } from '../lib/generation-settings.js';
import { MOCK_KINDS } from '../lib/course-book-crunch.js';
import { INGEST_KINDS } from '../lib/ingest.js';
import { SUGGEST_KINDS } from '../lib/contexts/generation/suggest.js';
import { selectionSchemas } from '../lib/contexts/generation/contracts.js';

/* The question kinds live in one registry (lib/card-kinds.js); every list the program keeps of them is read from it. */

test('the registry names every kind once, with the facts the program asks about', () => {
  assert.deepEqual([...CARD_KIND_IDS], CARD_KIND_LIST.map(kind => kind.id));
  assert.equal(new Set(CARD_KIND_IDS).size, CARD_KIND_IDS.length);
  for (const kind of CARD_KIND_LIST) {
    assert.equal(typeof kind.label, 'string', kind.id);
    assert.equal(typeof kind.short, 'string', kind.id);
    assert.equal(!!kind.options, kind.answers === 'one' || kind.answers === 'some', `${kind.id}: an option kind says how many answers are correct`);
    if (kind.options) assert.ok(kind.options.min >= 2 && kind.options.min <= kind.options.max, kind.id);
    if (kind.exam) assert.ok(kind.options && kind.graded, `${kind.id}: an exam paper takes graded option kinds only`);
    assert.ok(Number.isInteger(kind.cost) && kind.cost > 0, kind.id);
    assert.ok(Object.isFrozen(kind), kind.id);
  }
});

test('the old hand lists are the registry', () => {
  assert.deepEqual([...CARD_KINDS], [...CARD_KIND_IDS]);
  assert.deepEqual([...BASIC_KINDS], [...GENERATE_KIND_IDS]);
  assert.deepEqual([...GENERATION_KINDS], [...GENERATE_KIND_IDS, 'mixed']);
  assert.deepEqual([...SUGGEST_KINDS], ['mixed', ...GENERATE_KIND_IDS]);
  assert.deepEqual([...MOCK_KINDS], [...EXAM_KIND_IDS]);
  assert.deepEqual(INGEST_KINDS, ['auto', ...INGEST_KIND_IDS]);
  for (const schema of Object.values(selectionSchemas)) {
    const kind = schema.input?.properties?.kind;
    if (kind) assert.deepEqual(kind.enum, [...GENERATE_KIND_IDS]);
  }
});

test('the facts of the five original kinds are what the code always assumed', () => {
  assert.deepEqual(['quiz', 'multi', 'flashcard', 'open', 'cloze'].filter(hasOptions), ['quiz', 'multi']);
  assert.deepEqual(['quiz', 'multi', 'flashcard', 'open', 'cloze'].filter(oneAnswer), ['quiz']);
  assert.deepEqual(['quiz', 'multi', 'flashcard', 'open', 'cloze'].filter(isGraded), ['quiz', 'multi', 'cloze']);
  assert.deepEqual(['quiz', 'multi', 'flashcard', 'open', 'cloze'].filter(isExamKind), ['quiz', 'multi']);
  assert.deepEqual(INGEST_KIND_IDS.filter(id => id !== 'truefalse'), ['quiz', 'multi', 'flashcard', 'open']);
  assert.deepEqual(GRADED_FIRST_KIND_IDS.filter(id => id !== 'truefalse'), ['quiz', 'multi', 'cloze', 'flashcard', 'open']);
  assert.deepEqual(['quiz', 'multi', 'flashcard', 'open', 'cloze'].map(practiceCost), [3, 3, 2, 6, 2]);
  assert.equal(practiceCost('no-such-kind'), 2);
  assert.equal(kindOf('no-such-kind'), null);
  assert.deepEqual(kindOf('quiz').options, { min: 3, max: 6 });
});
