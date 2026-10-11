import test from 'node:test';
import assert from 'node:assert/strict';
import { planningInputFor } from '../lib/coverage-state.js';
import { coveragePlan } from '../lib/coverage-plan.js';
import { strengthPlan, roundsOf, assignmentsOf, materialOf, planOfRounds, LIMITS } from '../lib/coverage-strength.js';
import { lengthWeights } from '../lib/section-weights.js';
import { materialIndex, materialPieces, shareAtLeastOne } from '../lib/coverage-materials.js';
import { eightRecordings, pdfBook, notes, recordingBatch, stateOf } from './helpers/materials-fixture.mjs';

/* Flow A (the owner's 2026-10-11 report): the learner selects several materials and every one of them gets questions. The ground truth is stated in plain terms (which material,
   how many), from the owner's real cases: eight recordings asked for 30 questions, a 36-page PDF asked for 25, one recording of 107 parts. */

const planOf = (sources, { level = 'standard', goalCount, limit } = {}) => {
  const { leaves, materials } = planningInputFor(stateOf(sources), sources);
  return { leaves, materials, ...coveragePlan({ leaves, weights: lengthWeights(leaves), level, goalCount, ...(limit ? { limit } : {}) }) };
};
const materialsIn = (assignments) => new Set(assignments.map(item => item.material));

test('materials: a merged transcript of eight recordings is eight materials; a PDF of 36 pages is one; notes are one each', () => {
  const recordings = eightRecordings(), book = pdfBook(), extra = notes(3);
  const all = [...recordings.sources, ...book, ...extra];
  const { materials, leaves } = planningInputFor(stateOf(all), all);
  assert.equal(materials.list.length, 8 + 1 + 3);
  assert.deepEqual(materials.list.slice(0, 8).map(item => item.title), recordings.names, 'a recording is named by its file');
  assert.equal(materials.list.filter(item => item.kind === 'recording').length, 8);
  assert.equal(materials.list[8].sourceIds.length, 36, 'the PDF is one material of 36 pages');
  assert.ok(leaves.every(leaf => typeof leaf.material === 'string' && materials.list.some(item => item.key === leaf.material)), 'every leaf names its material');
});

test('materials: two versions of one document are counted once; a material with no text is listed with its reason', () => {
  const old = notes(1)[0], current = { ...notes(1)[0], id: 'note-1-v2', text: `${old.text} Updated.` }, empty = { id: 'empty', title: 'Scan', text: '' };
  const documents = [{ id: 'doc-1', currentRevision: 2, versions: [{ revision: 1, sourceIds: [old.id] }, { revision: 2, sourceIds: [current.id] }] }];
  const index = materialIndex([old, current, empty], { documents, sections: planningInputFor(stateOf([old, current, empty], { documents }), [old, current, empty]).leaves });
  assert.equal(index.list.length, 2, 'the two versions are one material, the scan another');
  assert.equal(index.list.find(item => item.key === index.keyOfSource.get(current.id)).sourceIds.length, 2);
  assert.equal(index.list.find(item => item.sourceIds.includes('empty')).reason, 'no-text');
});

test('eight recordings, 30 questions: every recording gets a section, and all eight are in round 1 (it was 4 of 8)', () => {
  const { sources } = eightRecordings(), run = planOf(sources, { goalCount: 30 });
  assert.equal(run.plan.goal, 30);
  assert.equal(run.plan.materials, 8);
  assert.equal(materialsIn(run.assignments).size, 8, 'every recording has a quota');
  assert.equal(materialsIn(run.rounds[0].assignments).size, 8, 'round 1 holds a section of every recording');
  assert.ok(run.rounds[0].questions <= 30);
  // The old rule (heaviest first, ties in reading order) kept the first 30 equal parts: recordings 1-4 only.
  const leaves = run.leaves.map(({ material: _m, ...leaf }) => ({ ...leaf, material: 'one' }));
  const unfair = strengthPlan(leaves, lengthWeights(leaves), 'standard', { goalCount: 30 });
  const recordingsKept = new Set(unfair.quotas.map(item => run.leaves.find(leaf => leaf.key === item.sectionId).recording));
  assert.ok(recordingsKept.size < 8, `without materials only ${recordingsKept.size} recordings would be asked`);
});

test('eight recordings at every level: each recording is in round 1', () => {
  const { sources } = eightRecordings();
  for (const level of ['lean', 'standard', 'full']) {
    const run = planOf(sources, { level });
    assert.equal(materialsIn(run.assignments).size, 8, `${level}: every recording has a quota`);
    assert.equal(materialsIn(run.rounds[0].assignments).size, 8, `${level}: round 1 holds every recording`);
    assert.equal(run.rounds.reduce((sum, round) => sum + round.questions, 0), run.plan.goal, `${level}: the rounds hold the whole plan`);
    assert.ok(run.rounds.every(round => round.questions <= 30));
  }
});

test('a custom count below the number of materials is raised to it, and the plan says so', () => {
  const sources = [...pdfBook({ pages: 4 }), ...notes(11)], run = planOf(sources, { goalCount: 5 });
  assert.equal(run.plan.materials, 12);
  assert.deepEqual(run.plan.raised, { from: 5, to: 12 });
  assert.equal(run.plan.goal, 12);
  assert.equal(materialsIn(run.assignments).size, 12, 'each material one question');
  const enough = planOf(sources, { goalCount: 20 });
  assert.equal(enough.plan.raised, undefined, 'a count that covers every material is not touched');
  assert.equal(enough.plan.goal, 20);
  assert.equal(planOf(sources).plan.raised, undefined, 'a level is never raised: it covers every material anyway');
});

test('a 36-page PDF asked for 25: one material, 25 different pages, nothing raised, round 1 holds them all', () => {
  const book = pdfBook(), run = planOf(book, { goalCount: 25 });
  assert.equal(run.plan.materials, 1);
  assert.equal(run.plan.raised, undefined);
  assert.equal(run.plan.quotas.length, 25, 'one question per page for 25 pages');
  assert.equal(run.plan.dropped.length, 11, 'the 11 pages the count does not reach are named');
  assert.equal(run.rounds.length, 1);
  assert.equal(run.rounds[0].questions, 25);
});

test('the PDF and seven notes asked for 25: every material in round 1, the PDF keeps most of the questions', () => {
  const sources = [...pdfBook(), ...notes(7)], run = planOf(sources, { goalCount: 25 });
  assert.equal(run.plan.materials, 8);
  assert.equal(materialsIn(run.rounds[0].assignments).size, 8);
  const pdf = run.plan.quotas.filter(item => item.sectionId.startsWith('pdf-')).length;
  assert.equal(pdf, 25 - 7, 'each note keeps one, the book the rest');
});

test('one recording of 107 parts with a short PDF: round 1 starts with both materials, then the heaviest parts', () => {
  const recording = recordingBatch([[107, 2]], { id: 'long' }).sources, book = pdfBook({ pages: 3, hash: 'b'.repeat(64) });
  const run = planOf([...recording, ...book], { level: 'full' });
  assert.equal(run.plan.materials, 2);
  assert.equal(run.plan.mustCover, 107 + 3);
  assert.equal(materialsIn(run.rounds[0].assignments).size, 2, 'the PDF is not left for round 5');
  assert.ok(run.rounds.length > 1);
  const alone = planOf(recording, { level: 'full' });
  assert.equal(alone.plan.materials, 1);
  assert.ok(alone.rounds[0].assignments.length >= 10, 'one material: round 1 is the heaviest parts, as before');
});

test('lean keeps one section of every material, documents too (it was recordings only)', () => {
  const big = notes(1, 60000)[0], small = notes(3, 700).map((item, index) => ({ ...item, id: `small-${index}` }));
  const run = planOf([big, ...small], { level: 'lean' });
  assert.equal(materialsIn(run.assignments).size, 4);
});

test('roundsOf: seeds that do not all fit are each asked for their share of round 1; more materials than a round holds open round 2', () => {
  const assignments = Array.from({ length: 6 }, (_, index) => ({ key: `m${index}#s`, sectionId: `m${index}#s`, sourceId: `m${index}`, material: `m${index}`, quota: 6, weight: 100 - index }));
  const rounds = roundsOf(assignments, { limit: 30 });
  assert.equal(rounds[0].questions, 30);
  assert.equal(materialsIn(rounds[0].assignments).size, 6, 'six materials of 6 questions each: all six in a round of 30');
  assert.deepEqual(rounds[0].assignments.map(item => item.quota), [5, 5, 5, 5, 5, 5]);
  const fitted = planOfRounds({ goal: 36, quotas: assignments.map(item => ({ sectionId: item.sectionId, quota: 6, reason: 'share' })) }, assignments, rounds);
  assert.equal(fitted.plan.goal, 30, 'the plan is what runs');
  assert.equal(fitted.plan.trimmed, 6);
  const small = roundsOf(assignments, { limit: 4 });
  assert.equal(materialsIn(small[0].assignments).size, 1, 'a round of 4 cannot hold six materials of 6');
  const slots = [{ key: 'a#1~1', sectionId: 'a#1', material: 'a', quota: 6, weight: 5 }, { key: 'a#1~2', sectionId: 'a#1', material: 'a', quota: 6, weight: 5 }, { key: 'b#1', sectionId: 'b#1', material: 'b', quota: 10, weight: 50 }];
  const packed = roundsOf(slots, { limit: 30 });
  assert.equal(packed.length, 1);
  assert.deepEqual(packed[0].assignments.map(item => item.key), ['a#1~1', 'a#1~2', 'b#1'], 'the slots of a section stay together');
});

test('materialOf: a leaf without a stamp counts by its recording, else its source', () => {
  assert.equal(materialOf({ sourceId: 's', recording: 2 }), 'recording:2');
  assert.equal(materialOf({ sourceId: 's' }), 'source:s');
  assert.equal(materialOf({ sourceId: 's', material: 'pdf:x' }), 'pdf:x');
  const leaves = [{ key: 'a', id: 'a', sourceId: 's', chars: 900, leaf: true, start: 0, end: 900 }];
  assert.equal(assignmentsOf(strengthPlan(leaves, [], 'standard'), leaves, [])[0].material, 'source:s');
});

test('the sanity bound still holds: more materials than LIMITS.total are cut, said by capped', () => {
  const many = Array.from({ length: LIMITS.total + 5 }, (_, index) => ({ key: `n${index}#w1`, id: 'w1', sourceId: `n${index}`, chars: 700, leaf: true, start: 0, end: 700 }));
  const plan = strengthPlan(many, [], 'standard', { goalCount: 10 });
  assert.equal(plan.goal, LIMITS.total);
  assert.ok(plan.capped.includes('sections'));
});

test('materialPieces: a merged transcript in a plain run is cut at its recordings, each piece still where it stood', () => {
  const { sources } = eightRecordings(), pieces = materialPieces(sources);
  assert.equal(new Set(pieces.map(item => item.key)).size, pieces.length);
  assert.ok(pieces.filter(item => /#r\d+$/.test(item.key)).length >= 8);
  for (const group of pieces) for (const piece of group.sources) {
    const whole = sources.find(source => source.id === piece.id).text;
    assert.equal(whole.slice(piece.sliceRange.start, piece.sliceRange.end), piece.text, 'a quote from the piece checks against the whole source');
  }
  assert.equal(materialPieces(pdfBook({ pages: 3 })).length, 1, 'the pages of a PDF are one material');
});

test('shareAtLeastOne: every share at least one while the count allows', () => {
  assert.deepEqual(shareAtLeastOne([100, 1, 1], 5), [3, 1, 1]);
  assert.deepEqual(shareAtLeastOne([1, 100, 1], 2), [1, 1, 0]);
  assert.equal(shareAtLeastOne([5, 5, 5, 5], 9).reduce((a, b) => a + b, 0), 9);
});
