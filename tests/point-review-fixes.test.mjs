import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { courseOutline } from '../lib/course-outline.js';
import { customReadiness } from '../lib/custom-readiness.js';
import { estimateFromState } from '../lib/token-estimate.js';
import { pointTopUpRound } from '../lib/contexts/generation/generate/point-round.js';
import { draftPointReport } from '../lib/evidence/point-report.js';
import { cardPoints, pointGaps, POINT_LIMITS } from '../lib/evidence/point-link.js';
import { COURSE, SENTENCES, cardOn, itemIds, pointLibrary } from './helpers/point-library.mjs';

/* The gate review of the first slice of 知识点查缺 (plan §19, decisions 98–): each case here failed before its fix. Pure over a library state, no model. */

const draftOf = (extra = {}, generation = {}) => ({ id: 'dr', title: 'D', course: COURSE, draftVersion: 1, cards: [],
  editorial: { requested: 2, generation: { sourceIds: ['doc-p1', 'doc-p2'], course: COURSE, kind: 'quiz', ...generation } }, ...extra });
const withDraft = (draft, options = {}) => { const { state } = pointLibrary({ ...options, drafts: [draft] }); return { state, draft: state.drafts[0] }; };

test('B1: the estimate before 补这些知识点 is the estimate of the point round, even when every section of the draft has a question', () => {
  const p = pointLibrary().sources;
  // The draft's own questions cover both pages: an ordinary top-up has nothing to do, yet B and C have no question.
  const { state } = withDraft(draftOf({ cards: [cardOn('n1', p.p1, SENTENCES.a1), cardOn('n2', p.p2, SENTENCES.d)] }), { cards: [] });
  const ask = pointIds => estimateFromState('generate', { resumeDraftId: 'dr', draftVersion: 1, coverage: { pointIds } }, state, {}).totalTokens;
  assert.equal(estimateFromState('generate', { resumeDraftId: 'dr', draftVersion: 1, coverage: {} }, state, {}).totalTokens.high, 0, 'every section has a question');
  assert.ok(ask(['pb']).high > 0, 'one point is one question to write');
  assert.equal(ask(['gone']).high, 0, 'a round that would be refused costs nothing');
  assert.equal(ask(['pc']).high, 0, 'C has a question of the draft (its page): refused, nothing to write');
  // With page 2 still open, two points are two questions.
  const open = withDraft(draftOf({ cards: [cardOn('n1', p.p1, SENTENCES.a1)] }), { cards: [] }).state;
  const two = pointIds => estimateFromState('generate', { resumeDraftId: 'dr', draftVersion: 1, coverage: { pointIds } }, open, {}).totalTokens.high;
  assert.ok(two(['pb', 'pc']) > two(['pb']), 'two points cost more than one');
});

test('B2: a draft filed under no course still counts its own questions in its own report, and a covered point is refused', () => {
  const p = pointLibrary().sources;
  const draft = draftOf({ course: '', cards: [cardOn('n1', p.p1, SENTENCES.b), cardOn('n2', p.p2, SENTENCES.c)] }, { course: undefined });
  const { state } = withDraft(draft, { cards: [cardOn('q1', p.p1, SENTENCES.a1)] });
  const report = draftPointReport(state, state.drafts[0]);
  assert.deepEqual([report.covered, report.list.map(point => point.id), report.topUp], [3, ['pd'], null], 'A from the deck, B and C from the draft itself');
  assert.deepEqual(pointTopUpRound(state, state.drafts[0], { pointIds: ['pc'] }).round, { error: 'point-covered', key: 'pc' });
});

test('S1: while rounds of the plan have not run, the action is not offered and a request is refused (no planned question is lost)', () => {
  const spec = { rounds: [{ round: 1, status: 'done', sectionIds: ['a'] }, { round: 2, status: 'pending', sectionIds: ['b'], questions: 3 }] };
  const { state, draft } = withDraft(draftOf({ editorial: { requested: 6, coverageSpec: spec, generation: { sourceIds: ['doc-p1', 'doc-p2'], course: COURSE } } }));
  const report = draftPointReport(state, draft);
  assert.deepEqual([report.hold, report.topUp], ['planned-rounds', null]);
  assert.ok(report.list.length > 0, 'the points are still listed');
  assert.deepEqual(pointTopUpRound(state, draft, { pointIds: ['pc'] }).round, { error: 'points-held', reason: 'planned-rounds' });
  // A fill round left pending is not a planned round: it does not hold.
  const filled = withDraft(draftOf({ editorial: { requested: 2, coverageSpec: { rounds: [{ round: 1, status: 'done', sectionIds: ['a'] }, { round: 2, fill: true, status: 'pending', sectionIds: ['a'] }] },
    generation: { sourceIds: ['doc-p1', 'doc-p2'], course: COURSE } } }));
  assert.equal(draftPointReport(filled.state, filled.draft).hold, undefined);
});

test('S2: a case paper, an edit or a repair of a published deck is not offered the action and is refused', () => {
  for (const draft of [draftOf({}, { kind: 'case' }), draftOf({ editingDeckId: 'deck' }), draftOf({ editorial: { requested: 2, repairOfDeckId: 'deck', generation: { sourceIds: ['doc-p1'], course: COURSE } } })]) {
    const found = withDraft(draft);
    const report = draftPointReport(found.state, found.draft);
    assert.equal(report.topUp, null, JSON.stringify(draft).slice(0, 80));
    assert.equal(report.hold, 'cannot-top-up');
    assert.deepEqual(pointTopUpRound(found.state, found.draft, { pointIds: ['pc'] }).round, { error: 'points-held', reason: 'cannot-top-up' });
  }
});

test('S3: a stale outline is not linked (the outline page counts by pages, as the draft page says stale); a question of no row is not counted under a leaf', () => {
  const stale = pointLibrary();
  stale.sources.p2.text += '\n\nA new paragraph added after the outline was built.';
  const points = Object.fromEntries(courseOutline(stale.state, { course: COURSE }).book.nodes.flatMap(node => node.children).map(leaf => [leaf.id, leaf.total]));
  assert.deepEqual([points.pa, points.pb], [3, 0], 'by pages: the page owner A has all three');
  // A question quoting B's item in a material of another course: 未归位, and not B's.
  const { state, sources } = pointLibrary({ cards: [] });
  const x = { id: 'doc-x', title: 'Loose', text: `Intro. ${SENTENCES.b} End.`, createdAt: '2026-11-01T00:00:00.000Z', courses: ['Other'] };
  const item = state.sources.find(source => source.courseInventory).courseInventory.items.find(entry => entry.id === itemIds.b);
  const at = x.text.indexOf(SENTENCES.b);
  item.places.push({ range: 'doc-x#r', doc: 'k', sourceId: 'doc-x', start: at, end: at + SENTENCES.b.length, quote: SENTENCES.b, verified: true });
  state.sources.push(x);
  state.decks[0].cards = [cardOn('q1', sources.p1, SENTENCES.a1), cardOn('qx', x, SENTENCES.b)];
  const outline = courseOutline(state, { course: COURSE });
  const pb = outline.book.nodes[0].children.find(leaf => leaf.id === 'pb');
  assert.equal(pb.total, 0, 'the question stands in no row of the course');
  assert.equal(outline.unplaced.total, 1, 'it is counted once, under 未归位');
});

test('S4: 复习全书 readiness counts drafted questions by the same link as the outline page', () => {
  const p = pointLibrary().sources;
  // A draft question on B's item (page 1, owned by A): drafted for B, not for A.
  const draft = { id: 'dq', title: 'Draft', course: COURSE, cards: [cardOn('d1', p.p1, SENTENCES.b)], editorial: {} };
  const { state } = pointLibrary({ cards: [], drafts: [draft] });
  const readiness = customReadiness(state, { course: COURSE });
  const chapter = readiness.chapters.find(item => item.id === 'ch1');
  assert.equal(chapter.drafted, 1, 'one point of chapter 1 has a drafted question');
  const outline = Object.fromEntries(courseOutline(state, { course: COURSE }).book.nodes.flatMap(node => node.children).map(leaf => [leaf.id, leaf.summary.draftCards ?? 0]));
  assert.deepEqual([outline.pa, outline.pb], [0, 1]);
});

test('decision 85, corrected: an outline built from the inventory but not linked (out of date) counts a draft question inside a page-range leaf, on the outline page and in 复习全书 alike', () => {
  const p = pointLibrary().sources;
  const draft = { id: 'dq', title: 'Draft', course: COURSE, cards: [cardOn('d1', p.p2, SENTENCES.c)], editorial: {} };
  const { state } = pointLibrary({ cards: [], drafts: [draft] });
  state.sources.find(source => source.id === 'doc-p2').text += '\n\nA paragraph added after the outline was built.';
  const outline = courseOutline(state, { course: COURSE });
  assert.equal(outline.book.stale, true, 'out of date, so not linked (S3)');
  const pc = outline.book.nodes.flatMap(node => node.children).find(leaf => leaf.id === 'pc');
  assert.equal(pc.summary.draftCards ?? 0, 1, 'C is anchored to page 2 (a page range): its drafted question counts by the page');
  const ch2 = customReadiness(state, { course: COURSE }).chapters.find(item => item.id === 'ch2');
  assert.equal(ch2.drafted, 1, 'the same number in 章节准备度');
});

test('S5: the gap check reads the link the rows were given, it does not place the questions again', () => {
  const outline = { nodes: [{ id: 'pa', title: 'A', items: ['i1'] }, { id: 'pb', title: 'B', items: ['i2'] }] };
  const inventory = { items: [{ id: 'i1', places: [{ sourceId: 's', start: 0, end: 10, verified: true }] }, { id: 'i2', places: [{ sourceId: 's', start: 20, end: 30, verified: true }] }] };
  // A card that carries its link (found by the rows) is counted by it, whatever its places say.
  const gaps = pointGaps(outline, inventory, [{ places: [{ sourceId: 's', start: 0, end: 5 }], found: { points: ['pb'], tier: 1 } }]);
  assert.deepEqual(gaps.uncovered, ['pa']);
  assert.deepEqual(cardPoints({ places: [{ sourceId: 's', start: 0, end: 5 }] }, new Map([['s', [{ start: 0, end: 10, point: 'pa' }]]])).points, ['pa']);
});

test('S5: only the draft page asks coverage.get for the points; every other caller does not', async () => {
  const files = [];
  const walk = async dir => { for (const entry of await readdir(dir, { withFileTypes: true })) { const path = join(dir, entry.name); if (entry.isDirectory()) await walk(path); else if (/\.(jsx?|mjs)$/.test(entry.name)) files.push(path); } };
  await walk('ui');
  const asking = [];
  for (const file of files) {
    const text = await readFile(file, 'utf8');
    for (const match of text.matchAll(/useCoverage\(([^;]*)/g)) if (/points:\s*true/.test(match[1])) asking.push(file.replace(/\\/g, '/'));
    if (/call\(\s*['"]coverage\.get['"][^)]*points/.test(text)) asking.push(file.replace(/\\/g, '/'));
  }
  assert.deepEqual(asking, ['ui/Draft.jsx']);
});

test('a malformed inventory gives a reason code, never a failed answer', () => {
  const { state, draft } = withDraft(draftOf());
  const inventory = state.sources.find(source => source.courseInventory).courseInventory;
  Object.defineProperty(inventory, 'items', { get() { throw new TypeError('broken record'); } });
  assert.deepEqual(draftPointReport(state, draft), { status: 'unavailable', reason: 'unreadable' });
});

test('R2: the error behind "unreadable" is reported in the host log ([study] …), once per cause and reader, by the report and by the round alike', t => {
  const warned = t.mock.method(console, 'warn', () => {});
  const { state, draft } = withDraft(draftOf());
  const inventory = state.sources.find(source => source.courseInventory).courseInventory;
  Object.defineProperty(inventory, 'items', { get() { throw new TypeError('broken record R2'); } });
  assert.equal(draftPointReport(state, draft).reason, 'unreadable');
  assert.equal(draftPointReport(state, draft).reason, 'unreadable');
  assert.deepEqual(pointTopUpRound(state, draft, { pointIds: ['pc'] }).round, { error: 'points-unavailable', reason: 'unreadable' });
  const lines = warned.mock.calls.map(call => call.arguments.join(' ')).filter(line => line.includes('broken record R2'));
  assert.equal(lines.length, 2, `once by each reader, not once per call: ${JSON.stringify(lines)}`);
  assert.match(lines[0], /^\[study\] knowledge points: the draft report .*broken record R2/);
  assert.match(lines[1], /^\[study\] knowledge points: the point round .*broken record R2/);
});

test('the passage a point is written from is its verified text alone: a question quoting any of it is credited to the point', () => {
  const { state } = withDraft(draftOf(), { cards: [] }), { sources } = pointLibrary();
  const found = pointTopUpRound(state, state.drafts[0], { pointIds: ['pb'] });
  const [assignment] = found.request.assignments;
  const at = sources.p1.text.indexOf(SENTENCES.b);
  assert.deepEqual([assignment.start, assignment.end], [at, at + SENTENCES.b.length], 'no padding the link would not credit');
  assert.ok(!('padChars' in POINT_LIMITS));
});
