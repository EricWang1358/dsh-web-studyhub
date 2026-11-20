/* `card.place` read-only lookup (Issue #1197): resolves a card's course, document, chapter (#N), and review-book leaf without mutating state or calling a model. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StudyService } from '../lib/service.js';
import { writesFor } from '../lib/runtime/domain-contracts.js';
import { courseOutlineMaterial, materialsFingerprint } from '../lib/course-outline-book.js';
import { courseNotesMaterial } from '../lib/course-book.js';
import { bookKey } from '../lib/course-outline-book-view.js';
import { buildOutlineIndex } from '../lib/course-outline-index.js';
import { genFile, recordOf } from '../lib/course-book-files.js';
import { groupSourcesByDocument } from '../lib/source-groups.js';
import { COURSE, outlineLibrary } from './helpers/course-outline-library.mjs';

const at = '2026-10-01T08:00:00.000Z';
const fact = (prefix, i) => `${prefix} fact ${i}: every service keeps one bounded responsibility.`;
const passage = (prefix, count = 4) => Array.from({ length: count }, (_, i) => fact(prefix, i)).join(' ');
const makeCard = (id, citations = []) => ({ id, kind: 'flashcard', topic: 'T', prompt: `Question ${id}?`, answer: 'A', citations });

async function makeService(t, populate) {
  const root = await mkdtemp(join(tmpdir(), 'study-card-place-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const service = new StudyService(root);
  await service.call('snapshot');
  if (populate) await service.store.update(populate);
  return service;
}

test('card.place resolves chaptered PDF, chapterless doc, #rest, multiple citations, and unplaced/missing cards without writing', async t => {
  assert.deepEqual(writesFor('library', 'card.place'), [], 'card.place is declared read-only in domain-contracts');

  const service = await makeService(t, (state) => {
    state.sources.push(
      {
        id: 'pdf-1-p1', title: 'Architecture Guide · p. 1', text: passage('Front'), createdAt: at, courses: ['Arch'],
        document: { materialId: 'doc-pdf-1', page: 1, totalPages: 4, format: 'pdf', origin: 'converted', converter: 'marker', filename: 'Architecture Guide.pdf', extractionVersion: 2 },
      },
      {
        id: 'pdf-1-p2', title: 'Architecture Guide · p. 2', text: passage('Ch1'), createdAt: at, courses: ['Arch'],
        document: { materialId: 'doc-pdf-1', page: 2, totalPages: 4, format: 'pdf', origin: 'converted', converter: 'marker', filename: 'Architecture Guide.pdf', chapter: { index: 1, title: 'Core Layers', level: 1 }, extractionVersion: 2 },
      },
      {
        id: 'pdf-1-p3', title: 'Architecture Guide · p. 3', text: passage('Ch2'), createdAt: at, courses: ['Arch'],
        document: { materialId: 'doc-pdf-1', page: 3, totalPages: 4, format: 'pdf', origin: 'converted', converter: 'marker', filename: 'Architecture Guide.pdf', chapter: { index: 2, title: 'Event Flow', level: 1 }, extractionVersion: 2 },
      },
      {
        id: 'pdf-1-old', title: 'Architecture Guide (old) · p. 1', text: passage('OldVersion'), createdAt: at, courses: ['Arch'], historical: true,
        document: { id: 'old-v', materialId: 'doc-pdf-1', materialRevision: 'r1', page: 1, totalPages: 1, format: 'pdf', origin: 'converted', converter: 'marker', filename: 'Architecture Guide.pdf', extractionVersion: 2 },
      },
      {
        id: 'doc-plain', title: 'Plain Notes', text: passage('Plain'), createdAt: at, courses: ['Arch'],
        document: { materialId: 'doc-plain', format: 'md', filename: 'Plain Notes.md' },
      },
    );
    state.documents = [{ id: 'doc-pdf-1', title: 'Architecture Guide', format: 'pdf', currentRevision: 'r2', versions: [{ revision: 'r1', sourceIds: ['pdf-1-old'] }, { revision: 'r2', sourceIds: ['pdf-1-p1', 'pdf-1-p2', 'pdf-1-p3'] }] }];
    state.decks.push({
      id: 'd-arch', title: 'Arch Deck', course: 'Arch', cards: [
        makeCard('c-ch1', [{ sourceId: 'pdf-1-p2', quote: fact('Ch1', 0) }]),
        makeCard('c-front', [{ sourceId: 'pdf-1-p1', quote: fact('Front', 0) }]),
        makeCard('c-rest', [{ sourceId: 'pdf-1-old', quote: fact('OldVersion', 0) }]),
        makeCard('c-plain', [{ sourceId: 'doc-plain', quote: fact('Plain', 0) }]),
        makeCard('c-multi-ch', [
          { sourceId: 'pdf-1-p3', quote: fact('Ch2', 1) },
          { sourceId: 'pdf-1-p2', quote: fact('Ch1', 1) },
        ]),
        makeCard('c-plain-then-ch', [
          { sourceId: 'doc-plain', quote: fact('Plain', 1) },
          { sourceId: 'pdf-1-p2', quote: fact('Ch1', 2) },
        ]),
        makeCard('c-uncited', []),
        makeCard('c-missing-src', [{ sourceId: 'deleted-src', quote: 'Missing quote from deleted source' }]),
      ],
    });
    state.focus = { mode: 'class', course: 'Arch', role: '', jd: '', targetTopics: [] };
  });

  const beforeRev = (await service.call('snapshot')).revision;

  const pdfKey = 'pdf:doc-pdf-1';
  const plainKey = 'doc:doc-plain';

  assert.deepEqual(await service.call('card.place', { deckId: 'd-arch', cardId: 'c-ch1' }), {
    course: 'Arch',
    document: { key: pdfKey, title: 'Architecture Guide.pdf' },
    chapter: { key: `${pdfKey}#1`, title: 'Core Layers' },
    leaf: null,
  });

  assert.deepEqual(await service.call('card.place', { deckId: 'd-arch', cardId: 'c-front' }), {
    course: 'Arch',
    document: { key: pdfKey, title: 'Architecture Guide.pdf' },
    chapter: null,
    leaf: null,
  }, 'front matter (#-1) leaves chapter null');

  assert.deepEqual(await service.call('card.place', { deckId: 'd-arch', cardId: 'c-rest' }), {
    course: 'Arch',
    document: { key: pdfKey, title: 'Architecture Guide.pdf' },
    chapter: null,
    leaf: null,
  }, '#rest maps to document only, chapter null');

  assert.deepEqual(await service.call('card.place', { deckId: 'd-arch', cardId: 'c-plain' }), {
    course: 'Arch',
    document: { key: plainKey, title: 'Plain Notes' },
    chapter: null,
    leaf: null,
  });

  assert.deepEqual(await service.call('card.place', { deckId: 'd-arch', cardId: 'c-multi-ch' }), {
    course: 'Arch',
    document: { key: pdfKey, title: 'Architecture Guide.pdf' },
    chapter: { key: `${pdfKey}#2`, title: 'Event Flow' },
    leaf: null,
  }, 'multiple citations pick the first citation chapter');

  assert.deepEqual(await service.call('card.place', { deckId: 'd-arch', cardId: 'c-plain-then-ch' }), {
    course: 'Arch',
    document: { key: pdfKey, title: 'Architecture Guide.pdf' },
    chapter: { key: `${pdfKey}#1`, title: 'Core Layers' },
    leaf: null,
  }, 'prefers chapter node over document-only node');

  assert.deepEqual(await service.call('card.place', { deckId: 'd-arch', cardId: 'c-uncited' }), {
    course: 'Arch',
    document: null,
    chapter: null,
    leaf: null,
  });

  assert.deepEqual(await service.call('card.place', { deckId: 'd-arch', cardId: 'c-missing-src' }), {
    course: 'Arch',
    document: null,
    chapter: null,
    leaf: null,
  });

  assert.deepEqual(await service.call('card.place', { deckId: 'd-arch', cardId: 'does-not-exist' }), {
    course: null,
    document: null,
    chapter: null,
    leaf: null,
  });

  assert.equal((await service.call('snapshot')).revision, beforeRev, 'card.place never writes state');
});

test('card.place reads leaf built status without calling openCourseBook when outline/book exists', async t => {
  const { sources, decks } = outlineLibrary();
  const lectureKey = groupSourcesByDocument(sources).find(item => item.sourceIds.includes('document-l1-p1')).key;
  const baseState = { sources, decks, focus: { mode: 'class', course: COURSE, role: '', jd: '', targetTopics: [] } };
  const outline = {
    ...courseOutlineMaterial({
      title: '总纲 · SA',
      course: COURSE,
      orderBasis: { codes: ['numbering'] },
      fingerprint: materialsFingerprint(buildOutlineIndex({ ...baseState, documents: [], drafts: [], attempts: [] }, { course: COURSE }).allDocuments),
      nodes: [
        {
          id: 'c1',
          title: 'Introduction',
          children: [
            { id: 'what', title: 'What architects do', anchors: [`${lectureKey}#0`] },
            { id: 'who', title: 'Stakeholders', anchors: [`${lectureKey}#1`] },
          ],
        },
      ],
      other: { anchors: [] },
      counts: { units: 2, leftover: 0, invalid: 0, repeated: 0 },
    }),
    createdAt: '2026-10-09T00:00:00.000Z',
  };

  const service = await makeService(t, (state) => {
    state.sources.push(...sources, outline);
    state.decks.push(...decks);
    state.focus = baseState.focus;
  });

  const deck = decks.find(item => item.id === 'deck-l1');
  const ch0Card = deck.cards[0];
  const ch1Card = deck.cards[25];

  // Outline exists, but book has NOT been opened yet -> must stay read-only and return leaf: null!
  const beforeBook = await service.call('card.place', { deckId: deck.id, cardId: ch0Card.id });
  assert.equal(beforeBook.leaf, null);
  assert.equal(recordOf(await service.store.read(), COURSE), null, 'card.place does not create bookDoc');

  // Add partial notes: only 'what' has a body; 'who' is unbuilt! Then open course book.
  const page1 = sources.find(source => source.id === 'document-l1-p1');
  await service.store.update((state) => {
    state.sources.push({
      ...courseNotesMaterial({
        title: '复习全书 · SA',
        course: COURSE,
        outlineId: outline.id,
        language: 'zh',
        papers: [],
        counts: {},
        leaves: [
          {
            id: 'what',
            title: 'What architects do',
            anchors: [`${lectureKey}#0`],
            body: {
              fingerprint: 'f'.repeat(16),
              points: ['What architects do [^1].'],
              explain: 'About What architects do.',
              cites: [{ n: 1, sourceId: page1.id, quote: page1.text.slice(0, 30), start: 0, end: 30 }],
            },
          },
          {
            id: 'who',
            title: 'Stakeholders',
            anchors: [`${lectureKey}#1`],
          },
        ],
      }),
      createdAt: '2026-10-09T01:00:00.000Z',
    });
  });
  await service.call('course.book.open');

  const builtPlace = await service.call('card.place', { deckId: deck.id, cardId: ch0Card.id });
  assert.deepEqual(builtPlace.leaf, { key: bookKey('what'), title: 'What architects do', built: true });

  const unbuiltPlace = await service.call('card.place', { deckId: deck.id, cardId: ch1Card.id });
  assert.deepEqual(unbuiltPlace.leaf, { key: bookKey('who'), title: 'Stakeholders', built: false });

  // Also test when notes record does NOT exist and genFile was emptied manually -> built: false.
  await service.store.update((state) => {
    const record = recordOf(state, COURSE);
    record.bookDoc.files[genFile('what')].text = '   ';
  });
  const emptyGenPlace = await service.call('card.place', { deckId: deck.id, cardId: ch0Card.id });
  assert.deepEqual(emptyGenPlace.leaf, { key: bookKey('what'), title: 'What architects do', built: false });
});

test('benchmark: single card.place latency on ~500-card chaptered course', async t => {
  const chapterCount = 10;
  const totalCards = 500;
  const perChapter = totalCards / chapterCount;
  const service = await makeService(t, (state) => {
    const cards = [];
    for (let ch = 0; ch < chapterCount; ch++) {
      const sourceId = `bench-p${ch + 1}`;
      state.sources.push({
        id: sourceId,
        title: `Systems Handbook · p. ${ch + 1}`,
        text: passage(`Chapter-${ch}`, 8),
        createdAt: at,
        courses: ['BenchCourse'],
        document: {
          materialId: 'bench-doc-1',
          page: ch + 1,
          totalPages: chapterCount,
          format: 'pdf',
          origin: 'converted',
          converter: 'marker',
          filename: 'Systems Handbook.pdf',
          chapter: { index: ch, title: `Chapter ${ch + 1}`, level: 1 },
          extractionVersion: 2,
        },
      });
      for (let i = 0; i < perChapter; i++) {
        const id = `bc-${ch}-${i}`;
        cards.push(makeCard(id, [{ sourceId, quote: fact(`Chapter-${ch}`, i % 8) }]));
      }
    }
    state.decks.push({ id: 'bench-deck', title: 'Bench Deck', course: 'BenchCourse', cards });
    state.focus = { mode: 'class', course: 'BenchCourse', role: '', jd: '', targetTopics: [] };
  });

  const t0 = performance.now();
  const cold = await service.call('card.place', { deckId: 'bench-deck', cardId: 'bc-9-49' });
  const coldMs = performance.now() - t0;

  const t1 = performance.now();
  const warm = await service.call('card.place', { deckId: 'bench-deck', cardId: 'bc-4-12' });
  const warmMs = performance.now() - t1;

  t.diagnostic(`500-card course card.place latency: cold=${coldMs.toFixed(2)}ms, warm=${warmMs.toFixed(2)}ms`);
  assert.equal(cold.chapter?.title, 'Chapter 10');
  assert.equal(warm.chapter?.title, 'Chapter 5');
});
