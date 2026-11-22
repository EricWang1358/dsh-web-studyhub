// Unit & micro-benchmark tests for O(K) structural snapshot fingerprinting:
// `node --test tests/snapshot-fingerprint.test.mjs`
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { tsImport } from 'tsx/esm/api';

const { computeSnapshotFingerprint } = await tsImport(
  '../src/state/snapshot-fingerprint.ts',
  import.meta.url,
);

function createBaseSnapshot() {
  return {
    root: '/tmp/studyhub-library',
    revision: 42,
    fingerprint: 'rev-42-base',
    modelReady: true,
    sample: { loaded: true },
    focus: { course: 'OS', mode: 'daily' },
    today: { due: 12, reviewed: 8, done: 8, streak: 5, goal: 20, new: 4 },
    inbox: {
      unread: 2,
      items: [
        { id: 'msg-1', read: false, at: '2026-11-22T07:00:00Z', prompt: 'Review overdue' },
        { id: 'msg-2', read: true, at: '2026-11-21T18:00:00Z', prompt: 'Deck published' },
      ],
    },
    courses: [
      { id: 'c-os', name: 'OS', title: 'Operating Systems', active: true, dueCount: 12, deckCount: 2, updatedAt: 1000 },
      { id: 'c-db', name: 'DB', title: 'Databases', active: false, dueCount: 3, deckCount: 1, updatedAt: 900 },
    ],
    decks: [
      {
        id: 'd-1',
        title: 'Virtual Memory',
        course: 'OS',
        folder: 'Core',
        count: 30,
        cardCount: 30,
        due: 7,
        wrong: 2,
        archived: false,
        flagged: 1,
        publishedAt: '2026-11-20T10:00:00Z',
        updatedAt: '2026-11-22T07:30:00Z',
        cards: [{ id: 'card-1', front: 'What is TLB?' }],
      },
      {
        id: 'd-2',
        title: 'Transactions',
        course: 'DB',
        folder: 'ACID',
        count: 20,
        cardCount: 20,
        due: 5,
        wrong: 1,
        archived: false,
        flagged: 0,
        publishedAt: '2026-11-19T10:00:00Z',
        updatedAt: '2026-11-21T12:00:00Z',
        cards: [{ id: 'card-2', front: 'Explain 2PL.' }],
      },
    ],
    progress: {
      'd-1': {
        mastery: 72,
        total: 30,
        due: 7,
        counts: { new: 3, weak: 2, learning: 5, familiar: 8, mastered: 12 },
      },
      'd-2': {
        mastery: 85,
        total: 20,
        due: 5,
        counts: { new: 1, weak: 1, learning: 2, familiar: 4, mastered: 12 },
      },
    },
    sources: [
      {
        id: 's-1',
        title: 'Lecture 04 Paging.pdf',
        archived: false,
        pinned: true,
        folder: 'Lectures',
        updatedAt: '2026-11-20T09:00:00Z',
        chars: 18500,
        courses: ['OS'],
      },
    ],
    drafts: [
      {
        id: 'draft-1',
        title: 'Page Replacement Draft',
        course: 'OS',
        status: 'ready',
        draftVersion: 3,
        editingDeckId: 'd-1',
        cards: [{ id: 'dc-1' }, { id: 'dc-2' }],
        updatedAt: '2026-11-22T06:00:00Z',
      },
    ],
    runs: [
      {
        id: 'run-1',
        mode: 'review',
        status: 'active',
        index: 4,
        total: 20,
        closedAt: null,
        submittedAt: null,
      },
    ],
    jobs: [
      {
        id: 'job-1',
        type: 'generate',
        status: 'running',
        progress: 0.45,
        updatedAt: '2026-11-22T07:55:00Z',
      },
    ],
    oralExams: [
      { id: 'oral-1', runId: 'run-oral-1', status: 'completed', updatedAt: '2026-11-21T20:00:00Z' },
    ],
    attempts: [
      { id: 'att-1', at: '2026-11-22T07:40:00Z', deckId: 'd-1', cardId: 'card-1' },
    ],
    settings: {
      practice: { roundSize: 20, newPerDay: 15, autoReveal: false },
      materialFolders: { folders: ['Lectures'], items: { 'source:s-1': 'Lectures' } },
      pinnedSources: ['s-1'],
    },
  };
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

describe('computeSnapshotFingerprint', () => {
  test('returns deterministic fingerprints for null, undefined, and identical deep-cloned snapshots', () => {
    assert.equal(computeSnapshotFingerprint(null), 'empty');
    assert.equal(computeSnapshotFingerprint(undefined), 'empty');

    const a = createBaseSnapshot();
    const b = structuredClone(a);
    const fpA = computeSnapshotFingerprint(a);
    const fpB = computeSnapshotFingerprint(b);

    assert.equal(typeof fpA, 'string');
    assert.ok(fpA.length > 0 && fpA !== 'empty');
    assert.equal(fpA, fpB);
  });

  test('detects single-field mutations across every tracked structural slice', () => {
    const base = createBaseSnapshot();
    const baseFp = computeSnapshotFingerprint(base);

    const mutations = [
      ['revision', (s) => { s.revision = 43; }],
      ['modelReady', (s) => { s.modelReady = false; }],
      ['sample.loaded', (s) => { s.sample.loaded = false; }],
      ['deck rename', (s) => { s.decks[0].title = 'Virtual Memory v2'; }],
      ['deck due change', (s) => { s.decks[0].due = 8; }],
      ['deck wrong change', (s) => { s.decks[0].wrong = 3; }],
      ['deck archived change', (s) => { s.decks[0].archived = true; }],
      ['deck flagged change', (s) => { s.decks[0].flagged = 2; }],
      ['deck folder change', (s) => { s.decks[0].folder = 'Archived'; }],
      ['progress mastery change', (s) => { s.progress['d-1'].mastery = 73; }],
      ['progress counts.weak change', (s) => { s.progress['d-1'].counts.weak = 4; }],
      ['source archive change', (s) => { s.sources[0].archived = true; }],
      ['source pin change', (s) => { s.sources[0].pinned = false; }],
      ['source folder change', (s) => { s.sources[0].folder = 'Slides'; }],
      ['source chars change', (s) => { s.sources[0].chars = 18501; }],
      ['source courses change', (s) => { s.sources[0].courses.push('CS'); }],
      ['course focus switch', (s) => { s.focus.course = 'DB'; }],
      ['focus mode switch', (s) => { s.focus.mode = 'exam'; }],
      ['course active switch', (s) => { s.courses[1].active = true; }],
      ['course dueCount change', (s) => { s.courses[0].dueCount = 13; }],
      ['draft version bump', (s) => { s.drafts[0].draftVersion = 4; }],
      ['draft cards length change', (s) => { s.drafts[0].cards.push({ id: 'dc-3' }); }],
      ['job status change', (s) => { s.jobs[0].status = 'completed'; }],
      ['job progress change', (s) => { s.jobs[0].progress = 0.8; }],
      ['inbox unread change (object)', (s) => { s.inbox.unread = 3; }],
      ['inbox unread change (array)', (s) => {
        s.inbox = [
          { id: 'msg-1', read: false, at: '2026-11-22T07:00:00Z' },
          { id: 'msg-2', read: false, at: '2026-11-21T18:00:00Z' },
        ];
      }],
      ['today due change', (s) => { s.today.due = 13; }],
      ['today reviewed change', (s) => { s.today.reviewed = 9; }],
      ['today done change', (s) => { s.today.done = 9; }],
      ['today streak change', (s) => { s.today.streak = 6; }],
      ['today goal change', (s) => { s.today.goal = 25; }],
      ['run status change', (s) => { s.runs[0].status = 'completed'; }],
      ['run index change', (s) => { s.runs[0].index = 5; }],
      ['run closedAt change', (s) => { s.runs[0].closedAt = '2026-11-22T08:00:00Z'; }],
      ['oralExam status change', (s) => { s.oralExams[0].status = 'grading'; }],
      ['attempt latest change', (s) => {
        s.attempts.push({ id: 'att-2', at: '2026-11-22T08:01:00Z', deckId: 'd-1', cardId: 'card-1' });
      }],
      ['settings practice change', (s) => { s.settings.practice.roundSize = 30; }],
      ['settings materialFolders change', (s) => {
        s.settings.materialFolders.items['source:s-1'] = 'Exams';
      }],
      ['settings pinnedSources change', (s) => { s.settings.pinnedSources.push('s-2'); }],
    ];

    for (const [label, mutate] of mutations) {
      const copy = structuredClone(base);
      mutate(copy);
      const nextFp = computeSnapshotFingerprint(copy);
      assert.notEqual(nextFp, baseFp, `expected mutation "${label}" to change fingerprint`);
    }

    // Also verify array-shaped inbox change relative to another array-shaped inbox
    const arrInboxBase = createBaseSnapshot();
    arrInboxBase.inbox = [{ id: 'm1', read: false, at: '2026-11-22T07:00:00Z' }];
    const arrInboxRead = structuredClone(arrInboxBase);
    arrInboxRead.inbox[0].read = true;
    assert.notEqual(
      computeSnapshotFingerprint(arrInboxBase),
      computeSnapshotFingerprint(arrInboxRead),
      'expected array-shaped inbox read toggle to change fingerprint',
    );
  });

  test('runs in < 5ms median on a 5,000-card / 250-deck / 500-source snapshot and beats JSON.stringify', () => {
    const longFront = 'Explain virtual memory page table walk, TLB shootdown, and copy-on-write semantics. '.repeat(4);
    const longBack = 'Detailed solution with multi-level page tables, ASID tagging, and fault handling. '.repeat(5);

    const decks = Array.from({ length: 250 }, (_, dIdx) => ({
      id: `deck-${dIdx}`,
      title: `Deck ${dIdx}: Systems Module`,
      course: `COURSE-${dIdx % 8}`,
      folder: `Folder-${dIdx % 5}`,
      count: 20,
      cardCount: 20,
      due: dIdx % 7,
      wrong: dIdx % 3,
      archived: false,
      flagged: dIdx % 2,
      publishedAt: '2026-11-01T00:00:00Z',
      updatedAt: '2026-11-22T07:00:00Z',
      cards: Array.from({ length: 20 }, (_, cIdx) => ({
        id: `card-${dIdx}-${cIdx}`,
        front: `${longFront} [${dIdx}:${cIdx}]`,
        back: `${longBack} [${dIdx}:${cIdx}]`,
        explanation: longBack,
      })),
    }));

    const progress = {};
    for (let i = 0; i < decks.length; i++) {
      progress[decks[i].id] = {
        mastery: (i * 13) % 101,
        total: 20,
        due: i % 7,
        counts: { new: 2, weak: i % 3, learning: 4, familiar: 6, mastered: 8 },
      };
    }

    const sources = Array.from({ length: 500 }, (_, sIdx) => ({
      id: `source-${sIdx}`,
      title: `Source Material ${sIdx}.pdf`,
      archived: false,
      pinned: sIdx < 10,
      folder: `Folder-${sIdx % 6}`,
      updatedAt: '2026-11-20T00:00:00Z',
      chars: 25000 + sIdx,
      courses: [`COURSE-${sIdx % 8}`],
      text: longBack.repeat(8),
    }));

    const bigSnapshot = {
      ...createBaseSnapshot(),
      decks,
      progress,
      sources,
    };

    // Warm up JIT
    for (let i = 0; i < 3; i++) {
      computeSnapshotFingerprint(bigSnapshot);
      JSON.stringify(bigSnapshot);
    }

    const fpTimings = [];
    const jsonTimings = [];
    for (let i = 0; i < 15; i++) {
      const t0 = performance.now();
      const fp = computeSnapshotFingerprint(bigSnapshot);
      const t1 = performance.now();
      const serialized = JSON.stringify(bigSnapshot);
      const t2 = performance.now();

      assert.ok(fp.length > 0);
      assert.ok(serialized.length > 1000);
      fpTimings.push(t1 - t0);
      jsonTimings.push(t2 - t1);
    }

    const fpMedianMs = median(fpTimings);
    const jsonMedianMs = median(jsonTimings);

    assert.ok(
      fpMedianMs < 5,
      `expected computeSnapshotFingerprint median < 5ms, got ${fpMedianMs.toFixed(2)}ms`,
    );
    assert.ok(
      fpMedianMs * 3 < jsonMedianMs,
      `expected computeSnapshotFingerprint (${fpMedianMs.toFixed(2)}ms) to be >3x faster than JSON.stringify (${jsonMedianMs.toFixed(2)}ms)`,
    );
  });
});
