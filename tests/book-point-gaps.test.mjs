import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StudyService } from '../lib/service.js';
import { createFakeModel } from '../scripts/fake-model.mjs';
import { openCourseBook } from '../lib/course-book-files.js';
import { courseNotesMaterial } from '../lib/course-book.js';
import { courseOutlineMaterial, materialsFingerprint } from '../lib/course-outline-book.js';
import { buildOutlineIndex } from '../lib/course-outline-index.js';
import { coursePointReport } from '../lib/evidence/point-report.js';
import { checkCoverageArgs, coverageAskedOf } from '../lib/contexts/generation/generate/args.js';
import { coursePointTopUpRound } from '../lib/contexts/generation/generate/point-round.js';
import { estimateFromState } from '../lib/token-estimate.js';
import { settleJob } from './helpers/wait.mjs';
import { pinStaged } from './helpers/staged-strategy.mjs';
import { COURSE, SENTENCES, cardOn, itemIds, pointLibrary, pointPages, pointRecords } from './helpers/point-library.mjs';

/* 复习全书接入查缺 (backend): course-level knowledge-point gap reporting in course.book.open (per-chapter, per-section, per-leaf with book hids/numbers),
   unavailable/stale/malformed fallbacks, and course-level 「补这些知识点」 top-up + token estimation without requiring an existing draft. */

function addNotes(state, outline) {
  const leafIds = [];
  const walk = nodes => (nodes || []).forEach(n => (n.children?.length ? walk(n.children) : leafIds.push(n)));
  walk(outline.courseOutline.nodes);
  const p1 = state.sources.find(s => s.id === 'doc-p1');
  state.sources.push({
    ...courseNotesMaterial({
      title: '复习全书 · C',
      course: COURSE,
      outlineId: outline.id,
      language: 'zh',
      papers: [],
      counts: {},
      leaves: leafIds.map(leaf => ({
        id: leaf.id,
        title: leaf.title,
        anchors: leaf.anchors || [],
        body: {
          fingerprint: 'f'.repeat(16),
          points: [`${leaf.title} key point.`],
          explain: `${leaf.title} explanation.`,
          cites: p1 ? [{ n: 1, sourceId: p1.id, quote: p1.text.slice(0, 30), start: 0, end: 30 }] : [],
        },
      })),
    }),
    createdAt: '2026-11-01T01:00:00.000Z',
  });
}

test('course.book.open attaches per-chapter, per-section, and per-leaf pointGaps with book hids and numbers', () => {
  const { state, outline, docKey } = pointLibrary();
  // Nest Point C and Point D inside a sub-section under Chapter 2 to test 3-level hierarchy (chapter -> section -> point).
  const fingerprint = materialsFingerprint(buildOutlineIndex(state, { course: COURSE }).allDocuments);
  const nested = {
    ...courseOutlineMaterial({
      title: '总纲 · C',
      course: COURSE,
      orderBasis: { codes: [] },
      fingerprint,
      from: 'inventory',
      other: { anchors: [] },
      counts: {},
      nodes: [
        {
          id: 'ch1',
          title: 'Chapter 1',
          children: [
            { id: 'pa', title: 'Point A', anchors: [`${docKey}@s0-0`], items: [itemIds.a1, itemIds.a2] },
            { id: 'pb', title: 'Point B', anchors: [], items: [itemIds.b], prereqIds: ['pa'] },
          ],
        },
        {
          id: 'ch2',
          title: 'Chapter 2',
          children: [
            {
              id: 'sec21',
              title: 'Section 2.1',
              children: [
                { id: 'pc', title: 'Point C', anchors: [`${docKey}@s1-1`], items: [itemIds.c], prereqIds: ['pb'] },
                { id: 'pd', title: 'Point D', anchors: [], items: [itemIds.d] },
              ],
            },
          ],
        },
      ],
    }),
    createdAt: '2026-11-01T00:01:00.000Z',
  };
  state.sources = state.sources.map(s => (s.id === outline.id ? { ...s, archived: true } : s)).concat(nested);
  addNotes(state, nested);

  const book = openCourseBook(state, { course: COURSE });
  assert.equal(book.status, 'ok');
  const gaps = book.pointGaps;
  assert.equal(gaps.status, 'ok');
  assert.equal(gaps.scope, 'course');
  assert.deepEqual([gaps.points, gaps.covered, gaps.uncovered, gaps.uncoverable], [4, 2, 2, 1]);
  assert.deepEqual(gaps.topUp, { pointIds: ['pc'], questions: 1 });
  assert.deepEqual(gaps.list.map(p => p.id), ['pc', 'pd']);

  const flat = nodes => nodes.flatMap(n => [n, ...flat(n.children || [])]);
  const byKey = new Map(flat(book.nodes).map(n => [n.key, n]));
  assert.equal(gaps.list[0].hid, byKey.get('bk:pc').hid);
  assert.equal(gaps.list[0].number, '2.1.1');

  assert.equal(gaps.chapters.length, 2);
  const [ch1, ch2] = gaps.chapters;
  assert.deepEqual([ch1.id, ch1.hid, ch1.number, ch1.points, ch1.covered, ch1.uncovered, ch1.topUp],
    ['ch1', byKey.get('bk:ch1').hid, '1', 2, 2, 0, null]);
  assert.deepEqual([ch2.id, ch2.hid, ch2.number, ch2.points, ch2.covered, ch2.uncovered],
    ['ch2', byKey.get('bk:ch2').hid, '2', 2, 0, 2]);
  assert.deepEqual(ch2.topUp, { pointIds: ['pc'], questions: 1 });
  assert.equal(ch2.sections.length, 1);
  assert.deepEqual([ch2.sections[0].id, ch2.sections[0].hid, ch2.sections[0].number, ch2.sections[0].covered, ch2.sections[0].uncovered],
    ['sec21', byKey.get('bk:sec21').hid, '2.1', 0, 2]);
  assert.deepEqual(ch2.sections[0].topUp, { pointIds: ['pc'], questions: 1 });

  assert.equal(gaps.leaves[byKey.get('bk:pa').hid].status, 'covered');
  assert.equal(gaps.leaves[byKey.get('bk:pb').hid].status, 'covered');
  assert.equal(gaps.leaves[byKey.get('bk:pc').hid].status, 'uncovered');
  assert.equal(gaps.leaves[byKey.get('bk:pd').hid].status, 'uncoverable');
});

test('draft questions count as drafted (covered) in Review Book gap report, and archived sources make points uncoverable', () => {
  const { state, sources, outline } = pointLibrary({ cards: [] });
  state.drafts = [{ id: 'dr1', title: 'Draft 1', course: COURSE, cards: [cardOn('dq1', sources.p1, SENTENCES.b)] }];
  addNotes(state, outline);
  const book = openCourseBook(state, { course: COURSE });
  const flat = nodes => nodes.flatMap(n => [n, ...flat(n.children || [])]);
  const byKey = new Map(flat(book.nodes).map(n => [n.key, n]));
  const gaps = book.pointGaps;
  assert.equal(gaps.status, 'ok');
  assert.equal(gaps.covered, 1);
  assert.equal(gaps.uncovered, 3);
  assert.equal(gaps.leaves[byKey.get('bk:pb').hid].status, 'drafted');
  assert.equal(gaps.leaves[byKey.get('bk:pb').hid].drafted, 1);
  assert.equal(gaps.chapters[0].drafted, 1);
  assert.equal(gaps.chapters[0].covered, 1);

  // Archiving p2 makes Point C's verified text unavailable to both coursePointReport and coursePointTopUpRound.
  sources.p2.archived = true;
  state.revision += 1;
  const afterArchive = coursePointReport(state, COURSE);
  assert.equal(afterArchive.status, 'ok');
  assert.equal(afterArchive.leaves.pc.status, 'uncoverable');
  assert.equal(afterArchive.leaves.pc.coverable, false);
  assert.equal(afterArchive.chapters[1].topUp, null);
  assert.deepEqual(coursePointTopUpRound(state, COURSE, { pointIds: ['pc'] }).round, { error: 'point-no-text', key: 'pc' });
});

test('unavailable and unreadable outlines return structured reasons without failing course.book.open', () => {
  const desc = pointLibrary({ from: 'descriptors' });
  addNotes(desc.state, desc.outline);
  assert.deepEqual(openCourseBook(desc.state, { course: COURSE }).pointGaps, { status: 'unavailable', reason: 'descriptors' });

  const noInv = pointLibrary({ withInventory: false });
  addNotes(noInv.state, noInv.outline);
  assert.deepEqual(openCourseBook(noInv.state, { course: COURSE }).pointGaps, { status: 'unavailable', reason: 'no-inventory' });

  const stale = pointLibrary();
  addNotes(stale.state, stale.outline);
  stale.sources.p2.text += '\nUpdated after outline.';
  assert.deepEqual(openCourseBook(stale.state, { course: COURSE }).pointGaps, { status: 'unavailable', reason: 'stale' });

  const broken = pointLibrary();
  addNotes(broken.state, broken.outline);
  Object.defineProperty(broken.inventory.courseInventory, 'items', { get() { throw new TypeError('corrupt inventory'); } });
  const opened = openCourseBook(broken.state, { course: COURSE });
  assert.equal(opened.status, 'ok');
  assert.deepEqual(opened.pointGaps, { status: 'unavailable', reason: 'unreadable' });
});

test('course-level coverage.pointIds arg checks, round builder, and token estimation', () => {
  const say = (zh, en) => `${zh} / ${en}`;
  assert.doesNotThrow(() => checkCoverageArgs({ previous: null, partAsked: false, extraIds: null, publishTarget: false, coverageAsked: coverageAskedOf({ coverage: { pointIds: ['pc'] } }), say }));
  assert.throws(() => checkCoverageArgs({ previous: null, partAsked: false, extraIds: null, publishTarget: true, coverageAsked: coverageAskedOf({ coverage: { pointIds: ['pc'] } }), say }), /resumeDraftId/);
  assert.throws(() => checkCoverageArgs({ previous: null, partAsked: false, extraIds: null, publishTarget: false, coverageAsked: coverageAskedOf({ coverage: { sectionIds: ['s1'] } }), say }), /resumeDraftId/);

  const { state, sources } = pointLibrary();
  const built = coursePointTopUpRound(state, COURSE, { pointIds: ['pc'] });
  assert.equal(built.round.error, undefined);
  assert.deepEqual(built.sourceIds, ['doc-p2']);
  assert.equal(built.round.questions, 1);
  assert.equal(built.request.assignments[0].key, 'point:pc');
  assert.ok(built.request.sources[0].text.includes(SENTENCES.c));

  assert.deepEqual(coursePointTopUpRound(state, COURSE, { pointIds: ['pa'] }).round, { error: 'point-covered', key: 'pa' });
  assert.deepEqual(coursePointTopUpRound(state, COURSE, { pointIds: ['pd'] }).round, { error: 'point-no-text', key: 'pd' });
  assert.deepEqual(coursePointTopUpRound(state, COURSE, { pointIds: ['gone'] }).round, { error: 'point-unknown', key: 'gone' });
  assert.deepEqual(coursePointTopUpRound(state, COURSE, { pointIds: ['pc'], limit: 0 }).round, { error: 'too-many', questions: 1, points: 1, limit: 0 });

  const est = estimateFromState('generate', { course: COURSE, coverage: { pointIds: ['pc'] } }, state, {});
  assert.ok(est.totalTokens.high > 0, 'course-level point top-up has non-zero estimate');
  assert.equal(estimateFromState('generate', { course: COURSE, coverage: { pointIds: ['pa'] } }, state, {}).totalTokens.high, 0, 'covered point estimates 0');
  assert.equal(estimateFromState('generate', { course: COURSE, coverage: { pointIds: ['gone'] } }, state, {}).totalTokens.high, 0, 'unknown point estimates 0');
  assert.ok(sources.p2.text.includes(SENTENCES.c));
});

async function bookService(t, { staged = false } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'study-book-gaps-'));
  const log = [], fake = createFakeModel({ log, usage: true });
  const service = new StudyService(root, { coach: false, complete: fake, coverage: { roundLimit: 8 } });
  t.after(async () => { await service.dispose(); await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });
  if (staged) await pinStaged(service);
  await service.runtime.invoke('materials.v1', 'sources.ingest', { sources: pointPages({ spread: true }) });
  const exported = await service.call('export');
  const { outline, inventory } = pointRecords(exported);
  await service.runtime.invoke('materials.v1', 'sources.ingest', { sources: [outline, inventory] });
  // Start with a published deck covering A and B, and ZERO drafts — the most common Review Book state!
  const p1 = exported.sources.find(s => s.id === 'doc-p1');
  await service.store.update(state => {
    state.decks.push({ id: 'deck-published', title: 'Published Deck', course: COURSE, cards: [cardOn('q1', p1, SENTENCES.a1), cardOn('q2', p1, SENTENCES.b)] });
    addNotes(state, outline);
  });
  return { service, log };
}

test('end-to-end (one-pass): Review Book gap-fill creates a new draft for Point C with no pre-existing draft, and book.pointGaps updates', async t => {
  const { service, log } = await bookService(t);
  const before = await service.call('course.book.open', { course: COURSE });
  assert.equal(before.pointGaps.status, 'ok');
  assert.deepEqual(before.pointGaps.topUp, { pointIds: ['pc'], questions: 1 });
  assert.equal((await service.call('export')).drafts.length, 0, 'starts with zero drafts');

  const estimate = await service.call('usage.estimate', { feature: 'generate', course: COURSE, coverage: { pointIds: ['pc'] } });
  assert.ok(estimate.totalTokens?.high > 0, 'service usage.estimate prices course-level point top-up');

  const started = await service.call('generate', { course: COURSE, title: 'C · 补知识点', language: 'English', coverage: { pointIds: ['pc'] } });
  const job = await settleJob(service, started.jobId);
  assert.equal(job.status, 'complete', job.stage);
  assert.ok(log.some(entry => entry.handler === 'generation.one-pass.write'), 'written in one pass by default');

  const exported = await service.call('export');
  assert.equal(exported.drafts.length, 1);
  assert.equal(exported.drafts[0].course, COURSE);
  assert.equal(exported.drafts[0].title, 'C · 补知识点');
  assert.ok(exported.drafts[0].cards.some(card => card.citations.some(c => c.quote?.includes('Gamma claim'))), 'new draft cites Point C');

  const after = await service.call('course.book.open', { course: COURSE });
  assert.equal(after.pointGaps.covered, before.pointGaps.covered + 1);
  assert.equal(after.pointGaps.uncovered, before.pointGaps.uncovered - 1);
  assert.equal(after.pointGaps.topUp, null, 'only uncoverable Point D remains');
  const pcNode = after.nodes[1].children[0];
  assert.equal(after.pointGaps.leaves[pcNode.hid].status, 'drafted');
});

test('end-to-end (staged): Review Book gap-fill respects staged strategy when configured', async t => {
  const { service, log } = await bookService(t, { staged: true });
  const started = await service.call('generate', { course: COURSE, title: 'C · Staged Fill', language: 'English', coverage: { pointIds: ['pc'] } });
  const job = await settleJob(service, started.jobId);
  assert.equal(job.status, 'complete', job.stage);
  assert.ok(!log.some(entry => entry.handler?.startsWith('generation.one-pass')), 'stays staged when configured');
  const after = await service.call('course.book.open', { course: COURSE });
  assert.equal(after.pointGaps.covered, 3);
});
