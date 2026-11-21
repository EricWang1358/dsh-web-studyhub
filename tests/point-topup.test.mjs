import test from 'node:test';
import assert from 'node:assert/strict';
import { checkCoverageArgs, coverageAskedOf } from '../lib/contexts/generation/generate/args.js';
import { checkRound } from '../lib/contexts/generation/generate/covering.js';
import { POINTS } from '../lib/contexts/generation/generate/messages.js';
import { passageOf, pointTopUpRound } from '../lib/contexts/generation/generate/point-round.js';
import { POINT_LIMITS } from '../lib/evidence/point-link.js';
import { draftPointReport } from '../lib/evidence/point-report.js';
import { COURSE, SENTENCES, cardOn, pointLibrary } from './helpers/point-library.mjs';

/* 补这些知识点 (coverage.pointIds): validated with the other coverage keys, turned into assignments of the existing shape by one builder and run through the
   same roundRequest as any top-up; anything it cannot run as asked is refused as a whole. */

const say = (zh, en) => `${zh} / ${en}`;
const judged = coverage => () => checkCoverageArgs({ previous: { id: 'd' }, partAsked: false, extraIds: null, coverageAsked: coverageAskedOf({ coverage }), say });
const draftOf = (state, extra = {}) => ({ id: 'dr', title: 'Draft', course: COURSE, draftVersion: 1, cards: [],
  editorial: { requested: 3, generation: { sourceIds: ['doc-p1', 'doc-p2'], course: COURSE } }, ...extra });

test('coverage.pointIds: a list of point ids, a round of its own (manual, not going on by itself), never with sections or the continue action', () => {
  assert.deepEqual(coverageAskedOf({ coverage: { pointIds: ['pa'] } }), { manual: true, autoComplete: false, pointIds: ['pa'] });
  assert.doesNotThrow(judged({ pointIds: ['pa', 'pc'] }));
  const shape = new RegExp(POINTS.shape[1].replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  for (const bad of [{ pointIds: [] }, { pointIds: ['pa', 3] }, { pointIds: 'pa' }, { pointIds: ['pa'], sectionIds: ['s'] }, { pointIds: ['pa'], run: true },
    { pointIds: ['pa'], autoComplete: true }, { pointIds: ['pa'], manual: false }, { pointIds: Array.from({ length: 201 }, (_, n) => `p${n}`) }]) {
    assert.throws(judged(bad), error => shape.test(error.message) || /coverage takes/.test(error.message), JSON.stringify(bad).slice(0, 80));
  }
  assert.throws(() => checkCoverageArgs({ previous: null, partAsked: true, extraIds: null, coverageAsked: coverageAskedOf({ coverage: { pointIds: ['pa'] } }), say }), shape,
    'a new part of a deck is not topped up by points');
});

test('the builder: one assignment per point in the existing shape (its passage, its title, its quota), credited to the section holding it', () => {
  const { state, sources } = pointLibrary();
  const found = pointTopUpRound(state, draftOf(state), { pointIds: ['pc'] });
  assert.equal(found.round.error, undefined, JSON.stringify(found.round));
  const [assignment] = found.request.assignments;
  const at = sources.p2.text.indexOf(SENTENCES.c);
  assert.deepEqual(assignment, { key: 'point:pc', sectionId: found.round.picks[0].key, sourceId: 'doc-p2', start: Math.max(0, at - POINT_LIMITS.padChars),
    end: Math.min(sources.p2.text.length, at + SENTENCES.c.length + POINT_LIMITS.padChars), quota: 1, title: 'Point C' });
  assert.deepEqual([found.round.questions, found.request.count, found.round.sections], [1, 1, 1]);
  assert.equal(found.request.sources.length, 1, 'the round is written from the point\'s passage only');
  assert.ok(found.request.sources[0].text.includes(SENTENCES.c));
  assert.deepEqual(found.request.sectionKeys, [found.round.picks[0].key], 'recorded by the section, like every round');
  assert.ok(found.request.titles.includes('Point C'));
});

test('refusals: a stale id, a point that has a question, one with no verified text, too many questions, and no usable outline; nothing in part', () => {
  const { state } = pointLibrary();
  const draft = draftOf(state);
  const error = ids => pointTopUpRound(state, draft, { pointIds: ids }).round;
  assert.deepEqual(error(['pc', 'gone']), { error: 'point-unknown', key: 'gone' });
  assert.deepEqual(error(['pc', 'pa']), { error: 'point-covered', key: 'pa' });
  assert.deepEqual(error(['pc', 'pd']), { error: 'point-no-text', key: 'pd' });
  assert.deepEqual(pointTopUpRound(state, draft, { pointIds: ['pc'], limit: 0 }).round, { error: 'too-many', questions: 1, points: 1, limit: 0 });
  assert.deepEqual(pointTopUpRound(pointLibrary({ from: 'descriptors' }).state, draft, { pointIds: ['pc'] }).round, { error: 'points-unavailable', reason: 'descriptors' });
  const refused = round => { try { checkRound({ round }, say); return null; } catch (e) { return e.message; } };
  assert.equal(refused(error(['gone'])), say(...POINTS.unknown));
  assert.equal(refused(error(['pa'])), say(...POINTS.covered));
  assert.equal(refused(error(['pd'])), say(...POINTS.noText));
  assert.equal(refused({ error: 'too-many', points: 1, limit: 30 }), say(...POINTS.tooMany(30)));
  assert.equal(refused({ error: 'points-unavailable', reason: 'stale' }), say(...POINTS.unavailable.stale));
});

test('a point outside the draft\'s materials is not this draft\'s to top up, and is not in its report', () => {
  const { state } = pointLibrary();
  const draft = draftOf(state, { editorial: { requested: 1, generation: { sourceIds: ['doc-p1'], course: COURSE } } });
  assert.deepEqual(pointTopUpRound(state, draft, { pointIds: ['pc'] }).round, { error: 'point-unknown', key: 'pc' });
  const report = draftPointReport(state, draft);
  assert.deepEqual([report.points, report.covered, report.uncovered, report.topUp], [2, 2, 0, null], 'page 1 teaches A and B, both have questions');
});

test('a draft of no course has no report at all: an outline belongs to a course', () => {
  const { state } = pointLibrary();
  for (const source of state.sources) source.courses = [];
  const draft = draftOf(state, { course: undefined, editorial: { requested: 1, generation: { sourceIds: ['doc-p1'] } } });
  assert.equal(draftPointReport(state, draft), null);
});

test('a point whose verified text is all in another material is listed for the draft but not sent: the round would refuse it', () => {
  const { state, inventory } = pointLibrary();
  const gamma = inventory.courseInventory.items.find(item => item.name === 'Gamma claim');
  gamma.places.push({ range: 'doc-p1#r', doc: 'k', sourceId: 'doc-p1', start: 0, end: 0, quote: 'Gamma', verified: false });
  const draft = draftOf(state, { editorial: { requested: 1, generation: { sourceIds: ['doc-p1'], course: COURSE } } });
  const report = draftPointReport(state, draft);
  assert.deepEqual(report.list.map(point => [point.id, point.coverable]), [['pc', false]]);
  assert.deepEqual([report.uncoverable, report.topUp], [1, null]);
  assert.deepEqual(pointTopUpRound(state, draft, { pointIds: ['pc'] }).round, { error: 'point-no-text', key: 'pc' });
});

test('the draft report counts questions anywhere in the course, the draft\'s own included; after one lands on C, C leaves the list', () => {
  const { state, sources } = pointLibrary();
  const draft = draftOf(state);
  assert.deepEqual(draftPointReport(state, draft).list.map(point => point.id), ['pc', 'pd']);
  state.drafts = [{ ...draft, cards: [cardOn('n1', sources.p2, SENTENCES.c)] }];
  state.revision = 2;
  assert.deepEqual(draftPointReport(state, state.drafts[0]).list.map(point => point.id), ['pd']);
});

test('a long passage is cut to the limit from its start; a short one gets its surroundings', () => {
  assert.deepEqual(passageOf({ start: 1000, end: 1100 }, 'x'.repeat(5000)), { start: 1000 - POINT_LIMITS.padChars, end: 1100 + POINT_LIMITS.padChars });
  assert.deepEqual(passageOf({ start: 10, end: 20 }, 'x'.repeat(30)), { start: 0, end: 30 });
  assert.deepEqual(passageOf({ start: 0, end: POINT_LIMITS.maxChars + 10 }, 'x'.repeat(POINT_LIMITS.maxChars * 2)), { start: 0, end: POINT_LIMITS.maxChars });
});
