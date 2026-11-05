/* 深度定制 (4.4 S3): the questions of a plan as runs (lib/custom-questions.js). A run is planned for at most LIMITS.total questions, so the cap is per run: the chosen chapters
   are packed into as many runs as they need and nothing is cut. Pure; the estimate and `course.custom.apply` read the same function. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { HEADROOM, fitUnits, packRuns } from '../lib/custom-questions.js';
import { LIMITS, goalOfChars, strengthPlan } from '../lib/coverage-strength.js';

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
