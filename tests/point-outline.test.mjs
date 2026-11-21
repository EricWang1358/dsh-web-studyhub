import test from 'node:test';
import assert from 'node:assert/strict';
import { courseOutline } from '../lib/course-outline.js';
import { courseEvidenceSummary } from '../lib/evidence/course-evidence.js';
import { collectOutlineGapStats } from '../ui/outline/gap-lens.js';
import { draftPointReport, pointBasis } from '../lib/evidence/point-report.js';
import { COURSE, SENTENCES, cardOn, pointLibrary } from './helpers/point-library.mjs';

/* One answer everywhere (知识点查缺 item 2): the 课程总纲 page's per-point counts, its 未出题 lens, the mastery per point and the draft page's point report read
   the SAME link (lib/evidence/point-link.js): a question is about the point whose verified item it quotes; only a question quoting no item goes by its page. */

/** The report of a draft over both pages of the course: the course's whole report. */
const coursePointReport = state => draftPointReport(state, { id: 'whole', title: 'Whole', course: COURSE, draftVersion: 1, cards: [],
  editorial: { requested: 1, generation: { sourceIds: ['doc-p1', 'doc-p2'], course: COURSE } } });
const leaves = outline => outline.book.nodes.flatMap(node => node.children);
const byId = outline => Object.fromEntries(leaves(outline).map(leaf => [leaf.id, leaf]));

test('the outline page counts a question for the point it quotes, not for the page owner; a point that owns no page gets its question', () => {
  const { state } = pointLibrary();
  const outline = courseOutline(state, { course: COURSE });
  const points = byId(outline);
  assert.deepEqual([points.pa.total, points.pb.total, points.pc.total, points.pd.total], [2, 1, 0, 0], 'A: its item + the page-1 sentence of no item; B: its item');
  assert.equal(outline.book.nodes[0].total, 3, 'the chapter holds each question once');
  assert.equal(outline.total, 3);
  const lens = collectOutlineGapStats(outline);
  assert.equal(lens.untestedCount, 2, '未出题: C and D');
  assert.ok(lens.untestedMatchKeys.has(`bk:pc`) && lens.untestedMatchKeys.has(`bk:pd`) && !lens.untestedMatchKeys.has('bk:pb'));
});

test('opening a point lists exactly its questions; practising it takes them', () => {
  const { state } = pointLibrary();
  const opened = courseOutline(state, { course: COURSE, expand: ['bk:pa', 'bk:pb'] }).open;
  assert.deepEqual(opened['bk:pa'].cards.map(card => card.cardId).sort(), ['q1', 'q3']);
  assert.deepEqual(opened['bk:pb'].cards.map(card => card.cardId), ['q2']);
  const practice = courseOutline(state, { course: COURSE, pick: { keys: ['bk:pb'] } }).practice;
  assert.deepEqual(practice.scope.map(ref => ref.cardId), ['q2']);
});

test('drafts count where they point: a draft question on C\'s item leaves 未出题 (the page-span rows never counted drafts)', () => {
  const { state, sources } = pointLibrary();
  state.drafts = [{ id: 'dr1', title: 'Draft', course: COURSE, cards: [cardOn('d1', sources.p2, SENTENCES.c)], editorial: {} }];
  const outline = courseOutline(state, { course: COURSE });
  assert.equal(byId(outline).pc.summary.draftCards, 1);
  assert.equal(collectOutlineGapStats(outline).untestedCount, 1, 'only D is left');
  const report = coursePointReport(state);
  assert.deepEqual([report.points, report.covered, report.uncovered], [4, 3, 1], 'the draft page says the same');
});

test('the mastery per point holds the same questions as the outline page', () => {
  const { state } = pointLibrary();
  const evidence = courseEvidenceSummary(state, { course: COURSE });
  const cards = Object.fromEntries(evidence.points.filter(point => point.nodeId).map(point => [point.nodeId, point.signals.cardsTotal]));
  const outline = byId(courseOutline(state, { course: COURSE }));
  for (const id of ['pa', 'pb', 'pc', 'pd']) assert.equal(cards[id], outline[id].total, id);
});

test('without the inventory, or with an outline of descriptors, every question keeps its page: the page owner A has all three', () => {
  for (const options of [{ withInventory: false }, { from: 'descriptors' }]) {
    const points = byId(courseOutline(pointLibrary(options).state, { course: COURSE }));
    assert.deepEqual([points.pa.total, points.pb.total, points.pc.total], [3, 0, 0], JSON.stringify(options));
  }
});

test('the draft page\'s report: counts, the uncovered points with prerequisites first, what can never be written from, and the questions that reach no point', () => {
  const { state } = pointLibrary();
  const report = coursePointReport(state);
  assert.equal(report.status, 'ok');
  assert.deepEqual([report.points, report.covered, report.uncovered, report.unplaced], [4, 2, 2, 0]);
  assert.deepEqual(report.list.map(point => [point.id, point.title, point.coverable, point.quota]), [['pc', 'Point C', true, 1], ['pd', 'Point D', false, 1]]);
  assert.deepEqual(report.list[0].prereqs, ['Point B'], 'what C rests on, by name');
  assert.equal(report.uncoverable, 1);
  assert.deepEqual(report.topUp, { pointIds: ['pc'], questions: 1 }, 'the one action tops up what can be written from');
});

test('no numbers without a usable outline: why, as a code', () => {
  assert.deepEqual(coursePointReport(pointLibrary({ from: 'descriptors' }).state), { status: 'unavailable', reason: 'descriptors' });
  assert.deepEqual(coursePointReport(pointLibrary({ withInventory: false }).state), { status: 'unavailable', reason: 'no-inventory' });
  assert.deepEqual(pointBasis(pointLibrary().state, 'Other course'), { status: 'unavailable', reason: 'no-outline' });
  assert.deepEqual(pointBasis(pointLibrary().state, ''), { status: 'unavailable', reason: 'no-outline' });
  const { state, sources } = pointLibrary();
  sources.p2.text += '\n\nA new paragraph added after the outline was built.';
  assert.deepEqual(coursePointReport(state), { status: 'unavailable', reason: 'stale' });
});
