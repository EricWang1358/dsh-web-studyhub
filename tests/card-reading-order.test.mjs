import test from 'node:test';
import assert from 'node:assert/strict';
import { cardReadingLocation, createReadingOrder, sortCardsByReadingOrder } from '../lib/card-reading-order.js';
import { mergeContinuedDraft } from '../lib/bank-import.js';
import { generateBatched, CHUNK_CHARS } from '../lib/batch.js';
import { qualityPlan, qualityBlueprint, authored, qualityReview } from './helpers/assessment.mjs';
import { requestData } from './helpers/request-data.mjs';

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

test('sortCardsByReadingOrder orders cards by document, page, and quote/selection offset while keeping uncited cards stable', () => {
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

test('mergeContinuedDraft settles multi-round coverage drafts in reading order instead of round weight order', () => {
  const sources = pdfSources([1, 12, 94]);
  // Round 1 picked heavy p.94 first; Round 2 filled lighter p.1 and p.12
  const base = {
    id: 'draft-os',
    title: 'OS 讲义',
    cards: [makeCard('r1-p94', [{ sourceId: sources[2].id, quote: '概念甲' }])],
    editorial: {
      requested: 3,
      generated: 1,
      parts: 1,
      completedParts: 1,
      generation: { sourceIds: sources.map((s) => s.id), course: 'OS', kind: 'quiz' },
      coverage: { sources: [{ id: sources[2].id, planned: 1 }] },
      failures: [],
      audits: [],
      reviewedCards: { 'r1-p94': { hash: 'h94' } },
    },
  };
  const incoming = {
    cards: [
      makeCard('r2-p12', [{ sourceId: sources[1].id, quote: '概念乙' }]),
      makeCard('r2-p1', [{ sourceId: sources[0].id, quote: '概念丙' }]),
    ],
    editorial: {
      parts: 1,
      completedParts: 1,
      generation: { sourceIds: sources.map((s) => s.id), course: 'OS', kind: 'quiz' },
      coverage: { sources: [{ id: sources[0].id, planned: 1 }, { id: sources[1].id, planned: 1 }] },
      failures: [],
      audits: [],
      reviewedCards: { 'r2-p12': { hash: 'h12' }, 'r2-p1': { hash: 'h1' } },
    },
  };
  const merged = mergeContinuedDraft(base, incoming, sources);
  assert.deepEqual(merged.cards.map((card) => card.id), ['r2-p1', 'r2-p12', 'r1-p94']);
});

test('generateBatched with multiple kinds across multi-page chunks orders resulting cards by page rather than grouping all late pages of kind 1 before kind 2', async () => {
  const hash = 'b'.repeat(64);
  const perPage = Math.ceil(CHUNK_CHARS / 2) + 200;
  const sources = [1, 2, 50, 94].map((page) => ({
    id: `p-${page}`,
    title: `Lecture.pdf · p.${page}`,
    text: `Page ${page} architecture connects business goals to technical decisions through principle_${page}.\n`.repeat(Math.ceil(perPage / 90)),
    document: { id: hash, materialId: `document-${hash}-pdf`, format: 'pdf', page, totalPages: 100, filename: 'Lecture.pdf' },
  }));
  let cardSeq = 0;
  const complete = async (system, prompt) => {
    const stage = system.startsWith('Plan ') ? 'planning' : system.startsWith('Prepare supported') ? 'blueprinting' : system.startsWith('You author') ? 'authoring' : 'reviewing';
    const req = requestData(prompt);
    if (stage === 'planning') return JSON.stringify(qualityPlan(req));
    if (stage === 'reviewing') return JSON.stringify(qualityReview(req.candidate));
    const plan = req.assessmentPlan;
    const deck = {
      title: 'Lecture Set',
      cards: plan.targets.map((target, idx) => ({
        id: `${req.kind}-${++cardSeq}`,
        targetId: target.targetId,
        kind: req.kind,
        topic: `Topic ${req.kind} ${idx}`,
        objective: target.objective,
        prompt: `Explain supported distinction for ${target.objective}?`,
        answer: 'Principles connect goals to decisions',
        hint: 'Think about stakeholders',
        explanation: 'Design choices must serve business goals',
        misconception: 'Choosing technology first',
        citations: target.citations,
        ...(req.kind === 'quiz' ? { options: ['a', 'b', 'c'].map((id) => ({ id, text: `${id} option ${cardSeq}`, correct: id === 'a', explanation: `Reason ${id}` })) } : {}),
        ...(req.kind === 'open' ? { rubric: 'Full credit for linking goals to decisions.' } : {}),
      })),
    };
    if (stage === 'blueprinting') return JSON.stringify(qualityBlueprint(req, plan, deck));
    return JSON.stringify(authored(deck, [], plan));
  };
  const result = await generateBatched(complete, {
    sources,
    count: 8,
    kind: 'quiz',
    kinds: ['quiz', 'open'],
    performance: { concurrency: 2, batchSize: 5, fillRounds: 0 },
  });
  assert.equal(result.cards.length, 8);
  assert.ok(result.cards.some((c) => c.kind === 'quiz') && result.cards.some((c) => c.kind === 'open'));
  const pages = result.cards.map((card) => Number(card.citations[0].sourceId.slice(2)));
  const sorted = [...pages].sort((a, b) => a - b);
  assert.deepEqual(pages, sorted, `expected non-decreasing page order, got ${pages.join(', ')}`);
  assert.ok(pages[0] <= 2 && pages.at(-1) >= 50, `front pages come first and late pages last: ${pages.join(', ')}`);
});
