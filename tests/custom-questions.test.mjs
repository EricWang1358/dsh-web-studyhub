/* 深度定制 (4.4 S3): the questions of a plan as runs (lib/custom-questions.js). A run is planned for at most LIMITS.total questions, so the cap is per run: the chosen chapters
   are packed into as many runs as they need and nothing is cut. Pure; the estimate and `course.custom.apply` read the same function. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { HEADROOM, fitUnits, packRuns } from '../lib/custom-questions.js';
import { LIMITS, goalOfChars, strengthPlan } from '../lib/coverage-strength.js';
import { estimateCustom } from '../lib/custom-estimate.js';

const unit = (id, chars, sourceIds) => ({ id, title: id, chars, ...(sourceIds ? { sourceIds } : {}) });
const ROOM = Math.floor(LIMITS.total * HEADROOM);

test('goalOfChars is the density of the level over the length, at least one; strengthPlan plans with the same number', () => {
  assert.equal(goalOfChars(100000, 'standard'), 60);
  assert.equal(goalOfChars(100000, 'lean'), 30);
  assert.equal(goalOfChars(100000, 'full'), 100);
  assert.equal(goalOfChars(10, 'standard'), 1);
  assert.equal(goalOfChars(100000, 'nonsense'), 60, 'an unknown level is the default');
  const sections = [{ sourceId: 's1', id: 'a', chars: 50000, leaf: true }, { sourceId: 's2', id: 'b', chars: 50000, leaf: true }];
  assert.equal(strengthPlan(sections, [], 'standard').goal, goalOfChars(100000, 'standard'));
});

test('chapters are packed in reading order while the run still fits under the cap; a plan of small chapters is a few runs, not one per chapter', () => {
  const units = Array.from({ length: 30 }, (_, at) => unit(`c${at}`, 30000));
  const runs = packRuns(units, 'standard');
  assert.ok(runs.length > 1 && runs.length < 30);
  assert.deepEqual(runs.flatMap(run => run.units.map(item => item.id)), units.map(item => item.id), 'the order is kept and no chapter is left out');
  for (const run of runs) assert.ok(run.goal <= ROOM, `${run.goal} within the run's room`);
  assert.equal(runs.reduce((sum, run) => sum + run.chars, 0), 30 * 30000);
});

test('1,500 questions over 3 chapters are not cut to 500: every chapter asks what its level asks, in as many runs as it takes', () => {
  const units = ['a', 'b', 'c'].map(id => unit(id, 500000));
  const wanted = units.reduce((sum, item) => sum + goalOfChars(item.chars, 'full'), 0);
  assert.equal(wanted, 1500);
  const runs = packRuns(fitUnits(units, 'full'), 'full');
  assert.ok(runs.length >= 3);
  assert.ok(runs.every(run => run.goal <= LIMITS.total));
  assert.ok(Math.abs(runs.reduce((sum, run) => sum + run.goal, 0) - 1500) <= runs.length, 'the sum of the runs is what was asked, up to rounding');
});

test('a chapter over the cap by itself is cut into parts of its own pages; one text that cannot be cut stays one run', () => {
  const pages = Array.from({ length: 40 }, (_, at) => `p${at + 1}`), charsOf = () => 30000;
  const cut = fitUnits([unit('big', 1200000, pages)], 'full', { charsOf });
  assert.ok(cut.length >= 2);
  assert.deepEqual(cut.flatMap(part => part.sourceIds), pages, 'every page once, in order');
  assert.ok(cut.every(part => goalOfChars(part.chars, 'full') <= LIMITS.total));
  assert.deepEqual(cut.map(part => part.id), cut.map((_, at) => `big~${at + 1}`));
  assert.equal(fitUnits([unit('one', 1200000, ['only'])], 'full', { charsOf }).length, 1, 'one source cannot be cut: its run is capped by the run itself');
  assert.equal(fitUnits([unit('est', 1200000)], 'full').length, Math.ceil(goalOfChars(1200000, 'full') / ROOM), 'with no sources (the estimate) it is cut by characters');
});

// 深度定制 is not changed by one pass (gate F1, 2026-11-21): its runs are cut at the staged density exactly as before, so a learner part way through a book who applies the
// plan again gets the same runs, and lib/custom-apply.js `earlier()` (matched by the exact set of sources of a run) still finds the drafts already made. These are the runs
// the code before one pass made of this book (computed with the code of origin/main d36ed392).
test('a plan made before one pass is cut into the same runs after it, at every strength', () => {
  const units = [unit('c1', 120000), unit('c2', 90000), unit('c3', 60000), unit('c4', 900000, ['a', 'b', 'c']), unit('c5', 40000), unit('c6', 250000), unit('c7', 30000)];
  const runsOf = level => packRuns(fitUnits(units, level, { charsOf: () => 300000 }), level).map(run => [run.units.map(item => item.id).join('+'), run.goal]);
  assert.deepEqual(runsOf('lean'), [['c1+c2+c3+c4+c5+c6+c7', 447]]);
  assert.deepEqual(runsOf('standard'), [['c1+c2+c3', 162], ['c4~1', 360], ['c4~2+c5+c6+c7', 372]]);
  assert.deepEqual(runsOf('full'), [['c1+c2+c3', 270], ['c4~1', 600], ['c4~2+c5', 340], ['c6+c7', 280]]);
});

test('the 定制方案 estimate counts the staged questions and calls whatever 出题方式 says', () => {
  const chosen = Array.from({ length: 4 }, (_, index) => ({ id: `c${index + 1}`, doc: 'doc', index, chars: 30000 }));
  const custom = { book: { make: false, parts: [] }, questions: { make: true, kinds: ['quiz'], strength: 'standard' } };
  const onePass = estimateCustom({ chosen, paperChars: 0 }, custom, { strategy: 'one-pass' }).questions, staged = estimateCustom({ chosen, paperChars: 0 }, custom, { strategy: 'staged' }).questions;
  assert.equal(staged.count, goalOfChars(30000, 'standard') * 4);
  assert.deepEqual(onePass, staged);
});
