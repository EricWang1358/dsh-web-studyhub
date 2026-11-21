import test from 'node:test';
import assert from 'node:assert/strict';
import { checkRound, coveringOf, runStartOf } from '../lib/contexts/generation/generate/covering.js';
import { closeRun } from '../lib/contexts/generation/run-state.js';
import { coverageForDraft } from '../lib/coverage-state.js';
import { roundList } from '../lib/coverage-run.js';
import { COURSE, SENTENCES, cardOn, pointLibrary } from './helpers/point-library.mjs';

/* 接着做 after a host stopped in a round of knowledge points (gate review of 245c675d, R1): the round is finished when its points can still be written; when
   they cannot (the outline was rebuilt with new ids, deleted, or went out of date) or another draft gave them a question meanwhile, the round is skipped with
   why, and 接着做 goes on with the plan: it never stays behind a round that is refused on every try. */

const lib0 = pointLibrary();
/** A draft whose both pages have a question, a plan whose fill round of points (B) was in flight when the host stopped. */
function stopped(pointIds = ['pb'], { change } = {}) {
  const draft = { id: 'dr', title: 'D', course: COURSE, draftVersion: 1, cards: [cardOn('n1', lib0.sources.p1, SENTENCES.a1), cardOn('n2', lib0.sources.p2, SENTENCES.c)],
    editorial: { requested: 2, generation: { sourceIds: ['doc-p1', 'doc-p2'], course: COURSE, kind: 'quiz' } } };
  const { state } = pointLibrary({ cards: [], drafts: [draft] });
  const keys = coverageForDraft(state, state.drafts[0]).sections.map(section => section.key);
  const spec = { level: 'lean', goal: 2, mustCover: keys, quotas: keys.map(sectionId => ({ sectionId, questions: 1 })),
    rounds: [{ round: 1, status: 'done', questions: 2, sectionIds: keys, kept: 2 }, { round: 2, fill: true, status: 'running', questions: 1, sectionIds: [keys[0]], pointIds }] };
  state.drafts[0].editorial.coverageSpec = spec;
  state.drafts[0].editorial.coverageRun = { state: 'running', jobId: 'j1', autoComplete: false };
  change?.(state);
  state.revision = 2;
  return { state, draft: state.drafts[0], spec };
}

const resume = ({ state, draft, spec }) => runStartOf({ s: state, previous: draft, plannedSpec: spec, fillRounds: 2, roundLimit: 30 });
const pointRound = start => roundList(start.settled).at(-1);

test('the points can still be written: 接着做 finishes that round', () => {
  const at = stopped();
  const start = resume(at);
  assert.deepEqual([start.type, start.pointIds, start.settled], ['points', ['pb'], undefined]);
  assert.doesNotThrow(() => checkRound(coveringOf({ s: at.state, previous: at.draft, runStart: start, request: { performance: {} }, roundLimit: 30 }), (zh, en) => en));
});

for (const [label, ids, change, reason] of [
  ['the outline was rebuilt with new ids', ['p-old'], null, 'points-changed'],
  ['the outline was deleted', ['pb'], state => { state.sources = state.sources.filter(source => !source.courseOutline); }, 'points-changed'],
  ['the outline went out of date', ['pb'], state => { state.sources.find(source => source.id === 'doc-p2').text += '\n\nA paragraph added after the outline was built.'; }, 'points-changed'],
  ['another draft gave the points a question', ['pb'], state => {
    state.drafts.push({ id: 'other', title: 'O', course: COURSE, cards: [cardOn('o1', lib0.sources.p1, SENTENCES.b)], editorial: {} });
  }, 'covered'],
]) {
  test(`${label}: the round is skipped with why, and 接着做 goes on with the plan`, () => {
    const at = stopped(ids, { change });
    const start = resume(at);
    assert.notEqual(start.type, 'points', 'not the round that would be refused (or has nothing to write)');
    assert.deepEqual([pointRound(start).status, pointRound(start).reason], ['skipped', reason]);
    assert.ok(!roundList(start.settled).some(round => round.status === 'pending' || round.status === 'running'), 'no round is left pending');
    // Every section has a question: 接着做 closes the run, one write, nothing refused.
    assert.equal(start.type, 'stop');
    const closed = closeRun({ marker: at.draft.editorial.coverageRun, spec: start.settled }, coverageForDraft(at.state, at.draft), { jobId: 'j2', at: '2026-11-21T00:00:00.000Z', kept: 2 });
    assert.ok(closed, 'the run closes');
    assert.equal(roundList(closed.spec).at(-1).reason, reason, 'the close keeps why');
  });
}
