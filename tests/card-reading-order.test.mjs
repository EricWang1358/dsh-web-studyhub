import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cardReadingLocation, createReadingOrder, sortCardsByReadingOrder } from '../lib/reading-order/card-reading-order.js';
import { StudyService } from '../lib/service.js';

function makeCard(id, citations, extra = {}) {
  return {
    id,
    kind: 'quiz',
    topic: `Topic ${id}`,
    objective: `Objective ${id}`,
    prompt: `Prompt ${id}?`,
    options: [
      { id: 'a', text: 'Right', correct: true, explanation: 'Right.' },
      { id: 'b', text: 'Wrong', correct: false, explanation: 'Wrong.' },
    ],
    answer: 'Right',
    hint: 'Hint',
    explanation: 'Exp',
    misconception: 'Mis',
    citations,
    ...extra,
  };
}

function pdfSources(pages, hash = 'a'.repeat(64)) {
  return pages.map((page) => ({
    id: `pdf-${hash.slice(0, 8)}-p${page}`,
    title: `操作系统讲义.pdf · 第 ${page} 页`,
    text: `第 ${page} 页正文第一段：概念甲。第二段：概念乙。第三段：概念丙。`,
    document: { id: hash, materialId: `document-${hash}-pdf`, format: 'pdf', page, totalPages: 100, filename: '操作系统讲义.pdf' },
  }));
}

test('sortCardsByReadingOrder orders cards by document, page, and quote/selection offset while keeping uncited cards anchored in place', () => {
  const sources = pdfSources([1, 12, 94]);
  const cards = [
    makeCard('c-p94', [{ sourceId: sources[2].id, quote: '概念甲' }]),
    makeCard('c-p12-late', [{ sourceId: sources[1].id, quote: '概念丙', at: { start: 22, end: 25 } }]),
    makeCard('c-p12-early', [{ sourceId: sources[1].id, quote: '概念甲', at: { start: 9, end: 12 } }]),
    makeCard('c-p1', [{ sourceId: sources[0].id, quote: '概念乙' }]),
  ];
  assert.deepEqual(
    sortCardsByReadingOrder(cards, sources).map((card) => card.id),
    ['c-p1', 'c-p12-early', 'c-p12-late', 'c-p94'],
  );

  // Manual / uncited deck stays untouched in exact original order
  const manual = [makeCard('m3', []), makeCard('m1', []), makeCard('m2', [])];
  assert.deepEqual(sortCardsByReadingOrder(manual, sources).map((card) => card.id), ['m3', 'm1', 'm2']);

  // An uncited card inside a cited deck stays anchored beside its neighbor instead of jumping to the end
  const mixed = [
    makeCard('q0', [{ sourceId: sources[0].id, quote: '概念甲' }]),
    makeCard('q1-uncited', []),
    makeCard('q2', [{ sourceId: sources[0].id, quote: '概念甲' }]),
  ];
  assert.deepEqual(sortCardsByReadingOrder(mixed, sources).map((card) => card.id), ['q0', 'q1-uncited', 'q2']);

  // Fallback page parsing works even when sources array is unavailable (e.g. standalone planPath call)
  assert.deepEqual(
    sortCardsByReadingOrder([
      makeCard('raw-94', [{ sourceId: 'doc-os-p94', quote: 'x' }]),
      makeCard('raw-2', [{ sourceId: 'doc-os-p2', quote: 'y' }]),
      makeCard('raw-15', [{ sourceId: 'doc-os-p15', quote: 'z' }]),
    ]).map((card) => card.id),
    ['raw-2', 'raw-15', 'raw-94'],
  );
});

test('cardReadingLocation returns answer-safe page and document metadata without exposing quote or selection', () => {
  const sources = pdfSources([1, 12, 94]);
  const card = makeCard('c-94', [{ sourceId: sources[2].id, quote: '答案机密原句', selection: { sourceId: sources[2].id, start: 4, end: 10, quote: '答案机密原句' } }]);
  const loc = cardReadingLocation(card, sources);
  assert.ok(loc);
  assert.equal(loc.sourceId, sources[2].id);
  assert.equal(loc.documentSourceId, sources[0].id);
  assert.equal(loc.title, '操作系统讲义');
  assert.equal(loc.page, 94);
  assert.equal(loc.unit, 'page');
  assert.equal(loc.paged, true);
  assert.equal('quote' in loc, false, 'quote must never leak before answering');
  assert.equal('selection' in loc, false, 'selection must never leak before answering');

  const compare = createReadingOrder(sources);
  assert.ok(compare({ card: makeCard('a', [{ sourceId: sources[0].id, quote: '概念甲' }]) }, { card }) < 0);
});

test('draft.publish.quick settles source-generated multi-round drafts in reading order while keeping mergeTargetId supplements behind existing cards', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'study-publish-reading-order-'));
  const service = new StudyService(root);
  t.after(async () => {
    service.dispose();
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  const sources = pdfSources([1, 12, 94]);
  await service.store.update((s) => { s.sources.push(...sources); });

  const saved = await service.call('draft.save', {
    deck: {
      id: 'os-coverage',
      title: 'OS 讲义',
      cards: [
        makeCard('r1-p94', [{ sourceId: sources[2].id, quote: '概念甲' }]),
        makeCard('r2-p12', [{ sourceId: sources[1].id, quote: '概念乙' }]),
        makeCard('r2-p1', [{ sourceId: sources[0].id, quote: '概念丙' }]),
      ],
      editorial: {
        generation: { sourceIds: sources.map((s) => s.id), course: 'OS', kind: 'quiz' },
      },
    },
  });

  const published = await service.call('draft.publish.quick', { id: saved.id, draftVersion: saved.draftVersion });
  const deck = await service.call('deck.get', { id: published.id });
  assert.deepEqual(deck.cards.map((card) => card.id), ['r2-p1', 'r2-p12', 'r1-p94']);

  const run = await service.call('review.start', { deckId: published.id, mode: 'new', count: 10, ordered: true, fresh: true });
  assert.equal(run.card.id, 'r2-p1');
});
