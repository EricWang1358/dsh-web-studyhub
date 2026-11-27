// P4 (#1354 D12): Behavioral & interaction regression suite protecting the DeckManageModal.tsx split.
// Exercises line-limit/baseline ratchet guardrails, pure model helpers, chunked batch executors,
// and real Ink + KeyBridge keyboard interactions across browse, search, preview scroll, rename
// (draft guard + atomic rollback), folder/course edits, multi-select batch focus/suspend/topic/link/slay,
// slain restore, supplement queueing, card kind conversion, ASCII/narrow layouts, and unmount safety.
// Run: node --test tests/p4-deck-manage-modal-split-regression.test.mjs
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { after, describe, test } from 'node:test';
import { Box, render } from 'ink';
import React from 'react';
import stripAnsi from 'strip-ansi';
import { register } from 'tsx/esm/api';
import {
  MAX_SOURCE_FILE_LINES,
  evaluateLineLimitRatchet,
  formatLineLimitReport,
  loadLineLimitBaseline,
  scanSourceLineCounts,
} from '../scripts/line-limit-guard.mjs';

const unregisterTsx = register();
after(() => {
  unregisterTsx?.();
});

const [
  deckManageMod,
  { useTuiStore, DEFAULT_PREFERENCES },
  { useKeyDispatcherBridge },
  { getHub, dispatchToHub },
  { useMouseClickInputFallback },
] = await Promise.all([
  import('../src/views/library/DeckManageModal.tsx'),
  import('../src/state/store.ts'),
  import('../src/input/hooks.ts'),
  import('../src/input/dispatcher.ts'),
  import('../src/components/mouse.tsx'),
]);

const {
  DeckManageModal,
  chunkItems,
  executeBatchSlay,
  executeBatchTopicUpdate,
  executeBatchLink,
} = deckManageMod;

const UNICODE_CHROME_RE = /[›…✓✕↑↓←→•★⚑⚠☑☐●○◆▸▾▤⏸]/;

function KeyBridgeRoot({ width, height, children }) {
  useKeyDispatcherBridge();
  useMouseClickInputFallback(true);
  return React.createElement(Box, { width, height }, children);
}

function createHarness(element, { cols = 120, rows = 36 } = {}) {
  const stdin = new PassThrough();
  stdin.isTTY = true;
  stdin.setRawMode = () => stdin;
  stdin.ref = () => stdin;
  stdin.unref = () => stdin;

  const stdout = new PassThrough();
  stdout.isTTY = true;
  stdout.columns = cols;
  stdout.rows = rows;
  stdout.getColorDepth = () => 1;

  let latest = '';
  stdout.on('data', (chunk) => {
    const plain = stripAnsi(Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk));
    if (plain.trim()) latest = plain;
  });

  const instance = render(
    React.createElement(KeyBridgeRoot, { width: cols, height: rows }, element),
    { stdout, stdin, exitOnCtrlC: false, patchConsole: false, debug: true },
  );

  return {
    write: (data) => stdin.write(data),
    dispatchKey: (input, key = {}) => dispatchToHub(getHub(stdin), input, key),
    frame: () => latest,
    async waitFor(pred, timeoutMs = 4000, label = 'condition') {
      const start = Date.now();
      while (Date.now() - start < timeoutMs) {
        if (pred(latest)) return latest;
        await new Promise((r) => setTimeout(r, 20));
      }
      throw new Error(`waitFor(${label}) timed out. Last frame:\n${latest}`);
    },
    cleanup() {
      instance.unmount();
      stdin.destroy();
      stdout.destroy();
    },
  };
}

function resetStore({ language = 'zh', asciiMode = false, snapshot = null } = {}) {
  useTuiStore.setState({
    page: 'library',
    navContext: {},
    history: [],
    snapshot,
    binding: null,
    config: null,
    loading: false,
    refreshing: false,
    toasts: [],
    footerHints: [],
    commandPaletteOpen: false,
    helpOpen: false,
    coursePickerOpen: false,
    inboxOpen: false,
    voicePackOpen: false,
    showLaunchpad: false,
    inputCaptured: false,
    activeRunId: null,
    preferences: {
      ...DEFAULT_PREFERENCES,
      recentCommands: [...(DEFAULT_PREFERENCES.recentCommands ?? [])],
      language,
      asciiMode,
    },
  });
}

function makeHost(callImpl) {
  const calls = [];
  return {
    calls,
    host: {
      mode: 'embedded',
      snapshot: async () => null,
      call: async (name, args) => {
        calls.push({ name, args });
        return callImpl(name, args);
      },
      stream: async () => {},
      close: async () => {},
    },
  };
}

function makeSampleDeck(overrides = {}) {
  return {
    id: 'deck-os-1',
    title: 'Operating Systems Core',
    course: 'CS301',
    folder: 'Systems / Kernel',
    archived: false,
    cards: [
      {
        id: 'card-1',
        kind: 'quiz',
        topic: 'Paging',
        prompt: 'What hardware caches virtual-to-physical translations?',
        answer: 'TLB',
        explanation: 'The Translation Lookaside Buffer caches recent page table entries.',
        options: [
          { id: 'A', text: 'TLB', correct: true, explanation: 'Caches translations.' },
          { id: 'B', text: 'ALU', correct: false, explanation: 'Arithmetic unit.' },
          { id: 'C', text: 'DMA', correct: false, explanation: 'Direct memory access.' },
        ],
        focus: false,
        suspended: false,
      },
      {
        id: 'card-2',
        kind: 'flashcard',
        topic: 'Scheduling',
        prompt: 'Define convoy effect in FCFS scheduling.',
        answer: 'Short jobs wait behind one long CPU-bound job.',
        focus: true,
        suspended: false,
      },
      {
        id: 'card-3',
        kind: 'cloze',
        topic: 'Synchronization',
        prompt: '',
        cloze: {
          text: 'A {{b1}} guarantees mutual exclusion using an atomic counter.',
          answers: [{ id: 'b1', value: 'semaphore' }],
        },
        answer: 'semaphore',
        flag: 'review-later',
        focus: false,
        suspended: true,
      },
    ],
    ...overrides,
  };
}

function makeSampleSnapshot(overrides = {}) {
  return {
    decks: [
      { id: 'deck-os-1', title: 'Operating Systems Core', course: 'CS301', folder: 'Systems / Kernel', cardCount: 3 },
      { id: 'deck-math-1', title: 'Linear Algebra', course: 'MATH201', cardCount: 2 },
    ],
    sources: [
      {
        id: 'src-math-1',
        title: 'Eigenvalues Lecture',
        format: 'pdf',
        course: 'MATH201',
        archived: false,
        document: { materialId: 'mat-math', format: 'pdf', page: 1 },
      },
      {
        id: 'src-os-1',
        title: 'Virtual Memory Notes · p.1',
        format: 'md',
        course: 'CS301',
        archived: false,
        document: { materialId: 'mat-os', format: 'md', page: 1 },
      },
      {
        id: 'src-os-2',
        title: 'Virtual Memory Notes · p.2',
        format: 'md',
        course: 'CS301',
        archived: false,
        document: { materialId: 'mat-os', format: 'md', page: 2 },
      },
      {
        id: 'src-archived-1',
        title: 'Old Archived Handout',
        format: 'txt',
        course: 'CS301',
        archived: true,
        document: { materialId: 'mat-old', format: 'txt', page: 1 },
      },
    ],
    drafts: [],
    ...overrides,
  };
}

describe('P4 (#1354 D12): DeckManageModal Split Guardrail & Behavioral Regressions', () => {
  test('1. Line-limit guardrail: DeckManageModal.tsx and its split modules stay <= MAX_SOURCE_FILE_LINES and out of baseline', async () => {
    const baseline = loadLineLimitBaseline();
    const lineCounts = scanSourceLineCounts();

    const targetModules = [
      'views/library/DeckManageModal.tsx',
      'views/library/deck-manage-model.ts',
      'views/library/useDeckManageActions.ts',
      'views/library/DeckManagePanels.tsx',
    ];

    assert.equal(
      Object.hasOwn(baseline.files, 'views/library/DeckManageModal.tsx'),
      false,
      'views/library/DeckManageModal.tsx must be removed from file-line-limit-baseline.json once split',
    );

    for (const relPath of targetModules) {
      assert.equal(
        typeof lineCounts[relPath],
        'number',
        `Expected split module ${relPath} to exist under packages/studyhub-tui/src/`,
      );
      assert.ok(
        lineCounts[relPath] <= MAX_SOURCE_FILE_LINES,
        `${relPath} has ${lineCounts[relPath]} lines, exceeding ${MAX_SOURCE_FILE_LINES}`,
      );
    }

    const ratchet = evaluateLineLimitRatchet({ lineCounts, baseline, maxLines: MAX_SOURCE_FILE_LINES });
    assert.equal(ratchet.ok, true, formatLineLimitReport(ratchet));
  });

  test('2. Pure deck-manage-model helpers: chunkItems, convert drafts/patches, markdown summary, filtering, sorting, folder normalization, and hints', async () => {
    const model = await import('../src/views/library/deck-manage-model.ts');

    // chunkItems edge cases
    assert.deepEqual(model.chunkItems([], 100), []);
    assert.deepEqual(model.chunkItems(['a', 'b', 'c'], 0), [['a'], ['b'], ['c']]);
    assert.deepEqual(chunkItems(['a', 'b', 'c', 'd', 'e'], 2), [['a', 'b'], ['c', 'd'], ['e']]);

    const deck = makeSampleDeck();
    const quizCard = deck.cards[0];
    const clozeCard = deck.cards[2];

    // Default convert drafts across target kinds
    const flashDraft = model.buildDefaultConvertDraft(quizCard, 'flashcard', 'en');
    assert.equal(flashDraft.primaryText, 'TLB');

    const openDraft = model.buildDefaultConvertDraft(quizCard, 'open', 'en');
    assert.match(openDraft.primaryText, /TLB/);

    const tfDraftFalse = model.buildDefaultConvertDraft(
      { id: 'c-tf', kind: 'flashcard', prompt: 'Statement', answer: 'False' },
      'truefalse',
      'en',
    );
    assert.equal(tfDraftFalse.tfIsTrue, false);

    const clozeDraft = model.buildDefaultConvertDraft(
      { id: 'c-clz', kind: 'flashcard', prompt: 'The kernel manages memory.', answer: 'kernel' },
      'cloze',
      'en',
    );
    assert.equal(clozeDraft.primaryText, 'The {{b1}} manages memory.');
    assert.equal(clozeDraft.secondaryText, 'kernel');

    // Convert patches preserve cloze prompt cleanup, hint anti-leak, and option constraints
    const flashFromCloze = model.buildConvertPatch(
      { ...clozeCard, hint: 'semaphore' },
      'flashcard',
      { primaryText: 'semaphore', secondaryText: '', tfIsTrue: true },
      'en',
    );
    assert.equal(flashFromCloze.answer, 'semaphore');
    assert.equal(flashFromCloze.prompt, 'A ____ guarantees mutual exclusion using an atomic counter.');
    assert.notEqual(flashFromCloze.hint, 'semaphore');

    const tfPatch = model.buildConvertPatch(
      quizCard,
      'truefalse',
      { primaryText: '', secondaryText: '', tfIsTrue: false },
      'zh',
    );
    assert.equal(tfPatch.answer, '错');
    assert.equal(tfPatch.options.length, 2);
    assert.equal(tfPatch.options[0].correct, false);
    assert.equal(tfPatch.options[1].correct, true);

    const quizFromFlashPatch = model.buildConvertPatch(
      deck.cards[1],
      'quiz',
      { primaryText: 'Short jobs wait behind one long job.', secondaryText: '', tfIsTrue: true },
      'en',
    );
    assert.equal(quizFromFlashPatch.options.length, 3);
    assert.equal(quizFromFlashPatch.options[0].correct, true);
    assert.equal(quizFromFlashPatch.options[0].text, 'Short jobs wait behind one long job.');

    const clozePatch = model.buildConvertPatch(
      quizCard,
      'cloze',
      { primaryText: 'Cache {{b1}} speeds up {{b2}}.', secondaryText: 'TLB', tfIsTrue: true },
      'en',
    );
    assert.deepEqual(clozePatch.cloze.answers, [
      { id: 'b1', value: 'TLB' },
      { id: 'b2', value: 'TLB' },
    ]);

    // Markdown summary respects asciiMode (zero Unicode chrome glyphs in ASCII mode)
    const mdAscii = model.summarizeCardMarkdown(
      {
        ...quizCard,
        flag: 'check',
        slain: { deckId: 'deck-origin', deckTitle: 'Origin Deck' },
      },
      'en',
      true,
    );
    assert.equal(UNICODE_CHROME_RE.test(mdAscii), false, `ASCII markdown leaked unicode chrome: ${mdAscii}`);
    assert.match(mdAscii, /\+ TLB/);
    assert.match(mdAscii, /o ALU/);
    assert.match(mdAscii, /Slain origin.*Origin Deck/);

    // Filter cards & normalize folder
    assert.equal(model.filterDeckCards(deck.cards, '').length, 3);
    assert.deepEqual(
      model.filterDeckCards(deck.cards, 'mutual exclusion').map((c) => c.id),
      ['card-3'],
    );
    assert.deepEqual(
      model.filterDeckCards(deck.cards, 'PAGING').map((c) => c.id),
      ['card-1'],
    );
    assert.equal(model.normalizeFolderInput('  CS /  Algorithms / / Graphs '), 'CS / Algorithms / Graphs');
    assert.equal(model.normalizeFolderInput('a'.repeat(250)).length, 200);

    // Sort available supplement docs: excludes archived, course-matched first
    const sortedDocs = model.sortAvailableSupplementDocs(makeSampleSnapshot(), 'CS301');
    assert.equal(sortedDocs.length, 2);
    assert.equal(sortedDocs[0].title, 'Virtual Memory Notes');
    assert.equal(sortedDocs[1].title, 'Eigenvalues Lecture');

    // Hints & title/subtitle builders
    const batchHints = model.buildDeckManageHints({
      mode: 'browse',
      lang: 'en',
      suppJobResult: null,
      convertEditActive: false,
      convertTargetKind: 'flashcard',
      selectedCount: 2,
      isSlainDeck: false,
      hasSystemKind: false,
      hasSlainCard: false,
    });
    assert.ok(batchHints.some((h) => h.key === 'X' && h.label === 'Slay'));
    const slainHints = model.buildDeckManageHints({
      mode: 'browse',
      lang: 'en',
      suppJobResult: null,
      convertEditActive: false,
      convertTargetKind: 'flashcard',
      selectedCount: 0,
      isSlainDeck: true,
      hasSystemKind: true,
      hasSlainCard: true,
    });
    assert.ok(slainHints.some((h) => h.key === 'u' && h.label === 'Restore'));
    assert.equal(model.buildDeckManageModalTitle('convert', deck, 'en'), 'Convert Card Kind');
  });

  test('3. Batch executors handle >100 chunking, partial failures, self-link exclusion, and all-failed topic results', async () => {
    const ids120 = Array.from({ length: 120 }, (_, idx) => `c-${idx + 1}`);
    let topicAttempts = 0;
    const { host: failAllTopicHost } = makeHost(async (name) => {
      if (name === 'card.update.batch') {
        topicAttempts += 1;
        return {
          ok: true,
          value: {
            updated: 0,
            failed: 2,
            results: [
              { cardId: 'c-1', ok: false, error: 'Card locked' },
              { cardId: 'c-2', ok: false, error: 'Card locked' },
            ],
          },
        };
      }
      return { ok: false, error: { message: 'unexpected' } };
    });
    const zeroTopic = await executeBatchTopicUpdate(failAllTopicHost, 'deck-1', ['c-1', 'c-2'], 'Memory', 'en');
    assert.equal(topicAttempts, 1);
    assert.equal(zeroTopic.ok, false);
    assert.equal(zeroTopic.error, 'Card locked');

    // Self-link only returns immediate error without hitting host
    let linkCalls = 0;
    const { host: linkHost } = makeHost(async (name, args) => {
      if (name === 'card.link.batch') {
        linkCalls += 1;
        if (linkCalls === 2) return { ok: false, error: { message: 'storage busy' } };
        return { ok: true, value: { linked: args.links.length, failed: 0 } };
      }
      return { ok: false, error: { message: 'unexpected' } };
    });

    const selfOnly = await executeBatchLink(linkHost, 'deck-1', ['c-1'], 'c-1', 'en');
    assert.equal(selfOnly.ok, false);
    assert.equal(linkCalls, 0);

    // Mixed with self: excludes self (119 remaining => 100 + 19), fails on chunk 2 => partial=true
    const partialLink = await executeBatchLink(linkHost, 'deck-1', ids120, 'c-1', 'en');
    assert.equal(linkCalls, 2);
    assert.equal(partialLink.ok, false);
    assert.equal(partialLink.partial, true);
    assert.equal(partialLink.linked, 100);
    assert.match(partialLink.error, /100\/119.*batch 2\/2/i);

    // Slay failure on first chunk => partial=false
    const { host: slayFailHost } = makeHost(async () => ({ ok: false, error: { message: 'read-only db' } }));
    const firstSlayFail = await executeBatchSlay(slayFailHost, 'deck-1', ['c-1', 'c-2'], 'en');
    assert.equal(firstSlayFail.ok, false);
    assert.equal(firstSlayFail.partial, false);
    assert.equal(firstSlayFail.error, 'read-only db');
  });

  test('4. Interactive browse, search filter/clear, preview scroll (J/K), narrow 80x24 ASCII cleanliness, and deck.get error state', async () => {
    const deck = makeSampleDeck();
    resetStore({ language: 'en', asciiMode: true, snapshot: makeSampleSnapshot() });
    const { host } = makeHost(async (name) => {
      if (name === 'deck.get') return { ok: true, value: deck };
      return { ok: true, value: {} };
    });

    let closed = 0;
    const h = createHarness(
      React.createElement(DeckManageModal, {
        host,
        deckId: deck.id,
        isActive: true,
        width: 80,
        height: 24,
        onClose: () => {
          closed += 1;
        },
      }),
      { cols: 80, rows: 24 },
    );

    try {
      const initial = await h.waitFor((f) => f.includes('Operating Systems Core') && f.includes('Paging'), 4000, 'deck loaded');
      assert.equal(UNICODE_CHROME_RE.test(initial), false, `ASCII frame must not leak unicode chrome:\n${initial}`);
      assert.match(initial, /3\/3 cards/);

      // Move cursor to bottom (G) then top (g), scroll preview (J/K)
      h.dispatchKey('G', {});
      await h.waitFor((f) => f.includes('semaphore') || f.includes('Synchronization'), 2000, 'jump bottom');
      h.dispatchKey('J', {});
      h.dispatchKey('K', {});
      h.dispatchKey('g', {});
      await h.waitFor((f) => f.includes('TLB'), 2000, 'jump top');

      // Search mode (/ -> type "Scheduling" -> Enter -> verify 1/3 -> c to clear)
      h.dispatchKey('/', {});
      await h.waitFor((f) => f.includes('Filter cards:'), 2000, 'search input open');
      h.write('Scheduling');
      await h.waitFor((f) => f.includes('1/3 cards'), 2000, 'filtered to 1 card');
      h.dispatchKey('', { return: true });
      await h.waitFor((f) => f.includes('Filter: Scheduling'), 2000, 'filter badge visible');
      h.dispatchKey('c', {});
      await h.waitFor((f) => f.includes('3/3 cards'), 2000, 'filter cleared');

      // Esc in browse closes modal
      h.dispatchKey('', { escape: true });
      await h.waitFor(() => closed === 1, 2000, 'modal closed via Esc');
    } finally {
      h.cleanup();
    }

    // Error state when deck.get fails
    resetStore({ language: 'en', asciiMode: true });
    const { host: errHost } = makeHost(async () => ({ ok: false, error: { message: 'Deck file corrupted' } }));
    const hErr = createHarness(
      React.createElement(DeckManageModal, {
        host: errHost,
        deckId: 'missing-deck',
        isActive: true,
        width: 90,
        height: 26,
        onClose: () => {},
      }),
      { cols: 90, rows: 26 },
    );
    try {
      await hErr.waitFor((f) => f.includes('Deck file corrupted'), 3000, 'error rendered');
    } finally {
      hErr.cleanup();
    }
  });

  test('5. Interactive multi-select batch focus (F), suspend (S), topic (T), link (L), and atomic slay (X + ConfirmDialog)', async () => {
    let liveDeck = makeSampleDeck();
    const snap = makeSampleSnapshot();
    let updatedCount = 0;

    resetStore({ language: 'en', asciiMode: true, snapshot: snap });
    const { host, calls } = makeHost(async (name, args) => {
      if (name === 'deck.get') return { ok: true, value: structuredClone(liveDeck) };
      if (name === 'snapshot') return { ok: true, value: snap };
      if (name === 'card.focus') {
        liveDeck = {
          ...liveDeck,
          cards: liveDeck.cards.map((c) => (c.id === args.cardId ? { ...c, focus: args.focus } : c)),
        };
        return { ok: true, value: { ok: true, focus: args.focus } };
      }
      if (name === 'card.suspend') {
        liveDeck = {
          ...liveDeck,
          cards: liveDeck.cards.map((c) => (c.id === args.cardId ? { ...c, suspended: args.suspended } : c)),
        };
        return { ok: true, value: { ok: true } };
      }
      if (name === 'card.update.batch') {
        const byId = new Map(args.updates.map((u) => [u.cardId, u.patch.topic]));
        liveDeck = {
          ...liveDeck,
          cards: liveDeck.cards.map((c) => (byId.has(c.id) ? { ...c, topic: byId.get(c.id) } : c)),
        };
        return { ok: true, value: { updated: args.updates.length, failed: 0 } };
      }
      if (name === 'card.link.batch') {
        return { ok: true, value: { linked: args.links.length, failed: 0 } };
      }
      if (name === 'card.review.batch') {
        const slainIds = new Set(args.items.map((it) => it.cardId));
        liveDeck = {
          ...liveDeck,
          cards: liveDeck.cards.filter((c) => !slainIds.has(c.id)),
        };
        return { ok: true, value: { slain: args.items.length } };
      }
      return { ok: true, value: {} };
    });

    const h = createHarness(
      React.createElement(DeckManageModal, {
        host,
        deckId: liveDeck.id,
        isActive: true,
        width: 120,
        height: 36,
        onClose: () => {},
        onUpdated: () => {
          updatedCount += 1;
        },
      }),
    );

    try {
      await h.waitFor((f) => f.includes('3/3 cards'), 4000, 'loaded 3 cards');

      // Select card-1 and card-2 with Space
      h.dispatchKey(' ', {});
      await h.waitFor((f) => f.includes('1 sel'), 2000, '1 selected');
      h.dispatchKey('j', {});
      await h.waitFor((f) => f.includes('Short jobs wait'), 2000, 'cursor moved to card-2');
      h.dispatchKey(' ', {});
      await h.waitFor((f) => f.includes('2 sel'), 2000, '2 selected');

      // Batch Focus (F): card-1 was false, card-2 was true => not all focused => sets both to true
      h.dispatchKey('F', {});
      await h.waitFor(() => calls.filter((c) => c.name === 'card.focus').length === 2, 3000, 'batch focus calls');
      assert.deepEqual(
        calls.filter((c) => c.name === 'card.focus').map((c) => [c.args.cardId, c.args.focus]),
        [
          ['card-1', true],
          ['card-2', true],
        ],
      );

      // Batch Suspend (S): neither suspended => sets both suspended=true
      h.dispatchKey('S', {});
      await h.waitFor(() => calls.filter((c) => c.name === 'card.suspend').length === 2, 3000, 'batch suspend calls');
      assert.deepEqual(
        calls.filter((c) => c.name === 'card.suspend').map((c) => [c.args.cardId, c.args.suspended]),
        [
          ['card-1', true],
          ['card-2', true],
        ],
      );

      // Batch Topic (T -> input "VirtualMemory" -> Enter)
      h.dispatchKey('T', {});
      await h.waitFor((f) => f.includes('Batch retag topic (2 selected)'), 2000, 'topic mode open');
      h.write('VirtualMemory');
      await h.waitFor((f) => f.includes('VirtualMemory'), 2000, 'topic typed');
      h.dispatchKey('', { return: true });
      await h.waitFor(() => calls.some((c) => c.name === 'card.update.batch'), 3000, 'topic batch sent');
      const topicCall = calls.find((c) => c.name === 'card.update.batch');
      assert.equal(topicCall.args.updates.length, 2);
      assert.equal(topicCall.args.updates[0].patch.topic, 'VirtualMemory');
      await h.waitFor((f) => !f.includes('2 sel'), 2000, 'selection cleared after topic batch');

      // Re-select card-1 and card-2, open Link mode (L), pick card-3 as prerequisite
      h.dispatchKey('g', {});
      await h.waitFor((f) => f.includes('TLB'), 2000, 'cursor back to card-1');
      h.dispatchKey(' ', {});
      await h.waitFor((f) => f.includes('1 sel'), 2000, '1 re-selected');
      h.dispatchKey('j', {});
      await h.waitFor((f) => f.includes('Short jobs wait'), 2000, 'cursor to card-2 for link');
      h.dispatchKey(' ', {});
      await h.waitFor((f) => f.includes('2 sel'), 2000, '2 re-selected for link');
      h.dispatchKey('L', {});
      await h.waitFor((f) => f.includes('Batch Link Prerequisite'), 2000, 'link mode open');
      h.dispatchKey('', { return: true });
      await h.waitFor(() => calls.some((c) => c.name === 'card.link.batch'), 3000, 'link batch sent');
      const linkCall = calls.find((c) => c.name === 'card.link.batch');
      assert.equal(linkCall.args.links.length, 2);
      assert.equal(linkCall.args.links[0].requires.cardId, 'card-3');

      // Re-select card-1, open Batch Slay confirm (X -> cancel Esc -> X -> confirm Enter)
      await h.waitFor((f) => !f.includes('Batch Link Prerequisite'), 2000, 'back to browse after link');
      h.dispatchKey('g', {});
      await h.waitFor((f) => f.includes('TLB'), 2000, 'cursor at card-1 for slay');
      h.dispatchKey(' ', {});
      await h.waitFor((f) => f.includes('1 sel'), 2000, '1 selected for slay');
      h.dispatchKey('X', {});
      await h.waitFor((f) => f.includes('Confirm Batch Slay'), 2000, 'slay confirm open');
      h.dispatchKey('', { escape: true });
      await h.waitFor((f) => !f.includes('Confirm Batch Slay'), 2000, 'slay confirm cancelled');
      assert.equal(calls.some((c) => c.name === 'card.review.batch'), false);

      h.dispatchKey('X', {});
      await h.waitFor((f) => f.includes('Confirm Batch Slay'), 2000, 'slay confirm reopened');
      h.dispatchKey('', { return: true });
      await h.waitFor(() => calls.some((c) => c.name === 'card.review.batch'), 3000, 'slay batch executed');
      await h.waitFor((f) => f.includes('2/2 cards'), 3000, 'deck reloaded with 2 remaining cards');
      assert.ok(updatedCount >= 5, `expected onUpdated to fire for all batch ops, got ${updatedCount}`);
    } finally {
      h.cleanup();
    }
  });

  test('6. Rename (n): unpublished draft guard, atomic draft.delete rollback on draft.save failure, and quick-publish fallback', async () => {
    const deck = makeSampleDeck();

    // Case A: unpublished edit draft exists -> warning toast, no deck.edit call
    resetStore({
      language: 'en',
      asciiMode: true,
      snapshot: makeSampleSnapshot({ drafts: [{ id: 'dr-existing', editingDeckId: deck.id }] }),
    });
    const hostA = makeHost(async (name) => {
      if (name === 'deck.get') return { ok: true, value: deck };
      if (name === 'snapshot') return { ok: true, value: { drafts: [{ id: 'dr-existing', editingDeckId: deck.id }] } };
      return { ok: true, value: {} };
    });
    const hA = createHarness(
      React.createElement(DeckManageModal, {
        host: hostA.host,
        deckId: deck.id,
        isActive: true,
        width: 110,
        height: 30,
        onClose: () => {},
      }),
      { cols: 110, rows: 30 },
    );
    try {
      await hA.waitFor((f) => f.includes('Operating Systems Core'), 3000, 'loaded A');
      hA.dispatchKey('n', {});
      await hA.waitFor((f) => f.includes('New deck title'), 2000, 'rename input open A');
      hA.write(' Renamed');
      await hA.waitFor((f) => f.includes('Renamed'), 2000, 'rename text typed A');
      hA.dispatchKey('', { return: true });
      await hA.waitFor(
        () => useTuiStore.getState().toasts.some((toast) => /unpublished edit draft/i.test(toast.text)),
        3000,
        'edit draft warning toast',
      );
      assert.equal(hostA.calls.some((c) => c.name === 'deck.edit'), false);
    } finally {
      hA.cleanup();
    }

    // Case B: draft.save fails -> runAtomicSteps triggers draft.delete rollback for orphan draft
    resetStore({ language: 'en', asciiMode: true, snapshot: makeSampleSnapshot() });
    const hostB = makeHost(async (name) => {
      if (name === 'deck.get') return { ok: true, value: deck };
      if (name === 'snapshot') return { ok: true, value: { drafts: [] } };
      if (name === 'deck.edit') return { ok: true, value: { id: 'dr-orphan-99', title: deck.title, draftVersion: 1 } };
      if (name === 'draft.save') return { ok: false, error: { message: 'disk full' } };
      if (name === 'draft.delete') return { ok: true, value: { ok: true } };
      return { ok: true, value: {} };
    });
    const hB = createHarness(
      React.createElement(DeckManageModal, {
        host: hostB.host,
        deckId: deck.id,
        isActive: true,
        width: 110,
        height: 30,
        onClose: () => {},
      }),
      { cols: 110, rows: 30 },
    );
    try {
      await hB.waitFor((f) => f.includes('Operating Systems Core'), 3000, 'loaded B');
      hB.dispatchKey('n', {});
      await hB.waitFor((f) => f.includes('New deck title'), 2000, 'rename input open B');
      hB.write(' v2');
      await hB.waitFor((f) => f.includes('Core v2'), 2000, 'rename text typed B');
      hB.dispatchKey('', { return: true });
      await hB.waitFor(() => hostB.calls.some((c) => c.name === 'draft.delete'), 3000, 'orphan draft rolled back');
      const delCall = hostB.calls.find((c) => c.name === 'draft.delete');
      assert.equal(delCall.args.id, 'dr-orphan-99');
    } finally {
      hB.cleanup();
    }

    // Case C: draft.publish.quick fails -> closes modal and navigates to generate with draftId
    resetStore({ language: 'en', asciiMode: true, snapshot: makeSampleSnapshot() });
    let closedC = 0;
    const hostC = makeHost(async (name) => {
      if (name === 'deck.get') return { ok: true, value: deck };
      if (name === 'snapshot') return { ok: true, value: { drafts: [] } };
      if (name === 'deck.edit') return { ok: true, value: { id: 'dr-pub-7', title: deck.title, draftVersion: 1 } };
      if (name === 'draft.save') return { ok: true, value: { id: 'dr-pub-7', draftVersion: 2 } };
      if (name === 'draft.publish.quick') return { ok: false, error: { message: 'validation required' } };
      return { ok: true, value: {} };
    });
    const hC = createHarness(
      React.createElement(DeckManageModal, {
        host: hostC.host,
        deckId: deck.id,
        isActive: true,
        width: 110,
        height: 30,
        onClose: () => {
          closedC += 1;
        },
      }),
      { cols: 110, rows: 30 },
    );
    try {
      await hC.waitFor((f) => f.includes('Operating Systems Core'), 3000, 'loaded C');
      hC.dispatchKey('n', {});
      await hC.waitFor((f) => f.includes('New deck title'), 2000, 'rename input open C');
      hC.write(' v3');
      await hC.waitFor((f) => f.includes('Core v3'), 2000, 'rename text typed C');
      hC.dispatchKey('', { return: true });
      await hC.waitFor(() => closedC === 1 && useTuiStore.getState().page === 'generate', 3000, 'navigated to generate');
      assert.equal(useTuiStore.getState().navContext.draftId, 'dr-pub-7');
    } finally {
      hC.cleanup();
    }
  });

  test('7. Folder move (m), course reassign (C), slain card restore (u), system-deck guards, and practice/draft navigation (Enter/p/e)', async () => {
    const deck = makeSampleDeck();
    const snap = makeSampleSnapshot();
    resetStore({ language: 'en', asciiMode: true, snapshot: snap });

    let closedCount = 0;
    const { host, calls } = makeHost(async (name, args) => {
      if (name === 'deck.get') return { ok: true, value: deck };
      if (name === 'snapshot') return { ok: true, value: snap };
      if (name === 'deck.move') return { ok: true, value: { id: args.id, folder: 'Systems / OS / Final' } };
      if (name === 'deck.course') return { ok: true, value: { id: args.id, course: args.course } };
      if (name === 'deck.edit') return { ok: true, value: { id: 'dr-open-1' } };
      if (name === 'review.start') return { ok: true, value: { id: 'run-single-1' } };
      return { ok: true, value: {} };
    });

    const h = createHarness(
      React.createElement(DeckManageModal, {
        host,
        deckId: deck.id,
        isActive: true,
        width: 120,
        height: 36,
        onClose: () => {
          closedCount += 1;
        },
      }),
    );

    try {
      await h.waitFor((f) => f.includes('Folder: Systems / Kernel'), 3000, 'folder badge visible');

      // Folder move (m)
      h.dispatchKey('m', {});
      await h.waitFor((f) => f.includes('Deck folder'), 2000, 'folder input open');
      h.write(' / Final');
      await h.waitFor((f) => f.includes('/ Final'), 2000, 'folder text typed');
      h.dispatchKey('', { return: true });
      await h.waitFor(() => calls.some((c) => c.name === 'deck.move'), 3000, 'deck.move called');
      await h.waitFor((f) => f.includes('Systems / OS / Final'), 2000, 'folder badge updated');

      // Course reassign (C)
      h.dispatchKey('C', {});
      await h.waitFor((f) => f.includes('Reassign deck course'), 2000, 'course input open');
      h.write('2');
      await h.waitFor((f) => f.includes('CS3012'), 2000, 'course text typed');
      h.dispatchKey('', { return: true });
      await h.waitFor(() => calls.some((c) => c.name === 'deck.course'), 3000, 'deck.course called');
      assert.equal(calls.find((c) => c.name === 'deck.course').args.course, 'CS3012');
      await h.waitFor((f) => !f.includes('Reassign deck course'), 2000, 'returned to browse after course');

      // Open draft (e) -> navigates to generate
      h.dispatchKey('e', {});
      await h.waitFor(() => useTuiStore.getState().page === 'generate', 3000, 'open draft navigated');
      assert.equal(useTuiStore.getState().navContext.draftId, 'dr-open-1');
      assert.equal(closedCount, 1);
    } finally {
      h.cleanup();
    }

    // Slain deck: [u] restores card; [m], [C], [+] are guarded on system decks
    let slainDeck = {
      id: 'sys-slain',
      title: 'Slain',
      systemKind: 'slain',
      cards: [
        {
          id: 'slain-c1',
          kind: 'flashcard',
          prompt: 'Slain sample card',
          answer: 'Answer',
          slain: { deckId: 'deck-os-1', deckTitle: 'Operating Systems Core' },
        },
      ],
    };
    resetStore({ language: 'en', asciiMode: true, snapshot: snap });
    const slainHost = makeHost(async (name) => {
      if (name === 'deck.get') return { ok: true, value: structuredClone(slainDeck) };
      if (name === 'snapshot') return { ok: true, value: snap };
      if (name === 'card.restore') {
        slainDeck = { ...slainDeck, cards: [] };
        return { ok: true, value: { deckId: 'deck-os-1', cardId: 'slain-c1', title: 'Operating Systems Core' } };
      }
      return { ok: true, value: {} };
    });

    const hSlain = createHarness(
      React.createElement(DeckManageModal, {
        host: slainHost.host,
        deckId: 'sys-slain',
        isActive: true,
        width: 110,
        height: 30,
        onClose: () => {},
      }),
      { cols: 110, rows: 30 },
    );

    try {
      await hSlain.waitFor((f) => f.includes('Origin: Operating Systems Core'), 3000, 'slain origin badge');
      hSlain.dispatchKey('m', {});
      hSlain.dispatchKey('C', {});
      hSlain.dispatchKey('+', {});
      await hSlain.waitFor(
        () => useTuiStore.getState().toasts.length >= 3,
        2000,
        'system deck warning toasts',
      );
      assert.equal(slainHost.calls.some((c) => c.name === 'deck.move' || c.name === 'deck.course'), false);

      hSlain.dispatchKey('u', {});
      await hSlain.waitFor(() => slainHost.calls.some((c) => c.name === 'card.restore'), 3000, 'card.restore called');
      await hSlain.waitFor((f) => f.includes('No slain cards remaining'), 3000, 'slain deck emptied');
    } finally {
      hSlain.cleanup();
    }
  });

  test('8. Supplement (+) and Convert (k) sub-modes: source selection, job queueing -> Tasks nav, kind cycling, field edit, and unmount safety', async () => {
    const deck = makeSampleDeck();
    const snap = makeSampleSnapshot();
    resetStore({ language: 'en', asciiMode: true, snapshot: snap });

    let closedCount = 0;
    const { host, calls } = makeHost(async (name, args) => {
      if (name === 'deck.get') return { ok: true, value: deck };
      if (name === 'card.convert') return { ok: true, value: { deckId: args.deckId, cardId: args.cardId, kind: args.kind } };
      if (name === 'supplement') return { ok: true, value: { jobId: 'job-supp-42', status: 'queued' } };
      return { ok: true, value: {} };
    });

    const h = createHarness(
      React.createElement(DeckManageModal, {
        host,
        deckId: deck.id,
        isActive: true,
        width: 120,
        height: 36,
        onClose: () => {
          closedCount += 1;
        },
      }),
    );

    try {
      await h.waitFor((f) => f.includes('Operating Systems Core'), 3000, 'deck loaded for convert/supp');

      // Convert sub-mode (k) on quiz card: targets = [flashcard, open, truefalse, cloze]
      h.dispatchKey('k', {});
      await h.waitFor((f) => f.includes('Convert Card Kind') && f.includes('MCQ -> Card'), 2000, 'convert open');
      // Cycle to open -> truefalse
      h.dispatchKey('', { tab: true });
      await h.waitFor((f) => f.includes('MCQ -> Open'), 2000, 'cycled to open');
      h.dispatchKey('', { tab: true });
      await h.waitFor((f) => f.includes('MCQ -> T/F'), 2000, 'cycled to truefalse');
      // Toggle T/F answer with Space
      h.dispatchKey(' ', {});
      await h.waitFor((f) => f.includes('False'), 2000, 'toggled truefalse to False');
      // Submit conversion
      h.dispatchKey('', { return: true });
      await h.waitFor(() => calls.some((c) => c.name === 'card.convert'), 3000, 'card.convert submitted');
      const convCall = calls.find((c) => c.name === 'card.convert');
      assert.equal(convCall.args.kind, 'truefalse');
      assert.equal(convCall.args.patch.answer, 'False');

      // Supplement sub-mode (+)
      await h.waitFor((f) => f.includes('Manage Deck:'), 2000, 'returned to browse after convert');
      h.dispatchKey('+', {});
      await h.waitFor((f) => f.includes('Supplement Deck') && f.includes('Virtual Memory Notes'), 2000, 'supplement open');

      // Try submitting with 0 sources -> inline warning
      h.dispatchKey('s', { ctrl: true });
      await h.waitFor((f) => f.includes('select at least one source'), 2000, 'empty source validation');

      // Toggle first (course-matched) source with Space, adjust count (+ -> 10), cycle kind (t -> MCQ), submit Ctrl+S
      h.dispatchKey(' ', {});
      await h.waitFor((f) => f.includes('2 pg'), 2000, '2 pages selected for doc-os');
      h.dispatchKey('+', {});
      await h.waitFor((f) => f.includes('Count: 10'), 2000, 'count bumped to 10');
      h.dispatchKey('t', {});
      await h.waitFor((f) => f.includes('Kind: MCQ'), 2000, 'kind cycled to MCQ');
      h.dispatchKey('s', { ctrl: true });
      await h.waitFor((f) => f.includes('Job ID: job-supp-42'), 3000, 'supplement job queued');

      const suppCall = calls.find((c) => c.name === 'supplement');
      assert.deepEqual(suppCall.args, {
        deckId: deck.id,
        sourceIds: ['src-os-1', 'src-os-2'],
        count: 10,
        kind: 'quiz',
      });

      // Press [t] on queued screen -> closes modal and navigates to tasks with jobId
      h.dispatchKey('t', {});
      await h.waitFor(() => closedCount === 1 && useTuiStore.getState().page === 'tasks', 2000, 'navigated to tasks');
      assert.equal(useTuiStore.getState().navContext.jobId, 'job-supp-42');
    } finally {
      h.cleanup();
    }

    // Unmount mid-flight safety: hold card.focus promise, unmount, then resolve -> zero throw
    let releaseFocus;
    const focusStarted = new Promise((resolve) => {
      releaseFocus = resolve;
    });
    let resolveFocusCall;
    resetStore({ language: 'en', asciiMode: true, snapshot: snap });
    const holdHost = makeHost(async (name) => {
      if (name === 'deck.get') return { ok: true, value: deck };
      if (name === 'card.focus') {
        releaseFocus();
        return await new Promise((resolve) => {
          resolveFocusCall = () => resolve({ ok: true, value: { ok: true, focus: true } });
        });
      }
      return { ok: true, value: {} };
    });

    const hHold = createHarness(
      React.createElement(DeckManageModal, {
        host: holdHost.host,
        deckId: deck.id,
        isActive: true,
        width: 100,
        height: 28,
        onClose: () => {},
      }),
      { cols: 100, rows: 28 },
    );

    await hHold.waitFor((f) => f.includes('3/3 cards'), 3000, 'loaded for unmount test');
    hHold.dispatchKey(' ', {});
    await hHold.waitFor((f) => f.includes('1 sel'), 2000, 'selected for unmount test');
    hHold.dispatchKey('F', {});
    await focusStarted;
    hHold.cleanup();
    resolveFocusCall();
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(holdHost.calls.some((c) => c.name === 'card.focus'), true);
  });
});
