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
import { UNICODE_UI_CHROME_RE } from './helpers/virtual-tty.mjs';

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

const ASCII_FORBIDDEN_CHROME_RE = new RegExp(`${UNICODE_UI_CHROME_RE.source}|[·▤⏸]`);

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

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
    rerender: (nextElement) => {
      instance.rerender(React.createElement(KeyBridgeRoot, { width: cols, height: rows }, nextElement));
    },
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
    assert.equal(ASCII_FORBIDDEN_CHROME_RE.test(mdAscii), false, `ASCII markdown leaked unicode chrome: ${mdAscii}`);
    assert.match(mdAscii, /\+ TLB/);
    assert.match(mdAscii, /o ALU/);
    assert.match(mdAscii, /Slain origin.*Origin Deck/);

    const asciiSelectedSubtitle = model.buildDeckManageSubtitle({
      mode: 'browse',
      lang: 'en',
      suppSelectedCount: 0,
      selectedCount: 2,
      selectedCard: quizCard,
      convertTargetKind: 'flashcard',
      deck,
      filteredCount: 3,
      asciiMode: true,
    });
    assert.equal(
      ASCII_FORBIDDEN_CHROME_RE.test(asciiSelectedSubtitle ?? ''),
      false,
      `ASCII subtitle must not leak unicode chrome or middle-dot: ${asciiSelectedSubtitle}`,
    );
    assert.match(asciiSelectedSubtitle ?? '', /3\/3 cards \| \[2 sel\]/);

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
      assert.equal(ASCII_FORBIDDEN_CHROME_RE.test(initial), false, `ASCII frame must not leak unicode chrome:\n${initial}`);
      assert.match(initial, /3\/3 cards/);

      // Multi-select subtitle in ASCII mode must also contain zero non-ASCII separators
      h.dispatchKey(' ', {});
      const selectedFrame = await h.waitFor((f) => f.includes('[1 sel]'), 2000, '1 card selected in ASCII mode');
      assert.equal(
        ASCII_FORBIDDEN_CHROME_RE.test(selectedFrame),
        false,
        `ASCII multi-select frame must not leak unicode chrome or middle-dot:\n${selectedFrame}`,
      );
      h.dispatchKey('x', {});
      await h.waitFor((f) => !f.includes('[1 sel]'), 2000, 'selection cleared');

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

      // Single-card practice (Enter) -> calls review.start with card scope & navigates to review
      useTuiStore.setState({ page: 'library', navContext: {} });
      h.dispatchKey('', { return: true });
      await h.waitFor(() => calls.some((c) => c.name === 'review.start'), 3000, 'review.start called');
      await h.waitFor(() => useTuiStore.getState().page === 'review', 3000, 'single-card practice navigated');
      const startCall = calls.find((c) => c.name === 'review.start');
      assert.deepEqual(startCall.args.scope, [{ deckId: deck.id, cardId: 'card-1' }]);
      assert.equal(useTuiStore.getState().navContext.runId, 'run-single-1');
      assert.equal(closedCount, 2);

      // Whole-deck practice (p) -> closes modal & navigates to review with deckId
      useTuiStore.setState({ page: 'library', navContext: {} });
      h.dispatchKey('p', {});
      await h.waitFor(() => useTuiStore.getState().page === 'review' && closedCount === 3, 2000, 'deck practice navigated');
      assert.equal(useTuiStore.getState().navContext.deckId, deck.id);
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

      // Convert sub-mode (v since #1748; the title still says k) on quiz card: targets = [flashcard, open, truefalse, cloze]
      h.dispatchKey('v', {});
      await h.waitFor((f) => f.includes('Convert Card Kind') && f.includes('MCQ -> Card'), 2000, 'convert open');
      // Cycle to open -> press [e] to edit rubric -> type custom suffix -> Esc exits edit (stays in convert)
      h.dispatchKey('', { tab: true });
      await h.waitFor((f) => f.includes('MCQ -> Open'), 2000, 'cycled to open');
      h.dispatchKey('e', {});
      await h.waitFor((f) => f.includes('Cancel') && f.includes('Done'), 2000, 'convert edit active');
      h.write(' + TLB miss');
      await h.waitFor((f) => f.includes('TLB miss'), 2000, 'edited convert rubric text');
      h.dispatchKey('', { escape: true });
      await h.waitFor((f) => f.includes('Convert Card Kind') && f.includes('Edit'), 2000, 'Esc exited edit but stayed in convert');
      // Submit open conversion with edited rubric
      h.dispatchKey('', { return: true });
      await h.waitFor(() => calls.some((c) => c.name === 'card.convert'), 3000, 'open card.convert submitted');
      const openConvCall = calls.find((c) => c.name === 'card.convert');
      assert.equal(openConvCall.args.kind, 'open');
      assert.match(openConvCall.args.patch.rubric, /TLB miss/);

      // Re-open convert (v) -> cycle to truefalse -> toggle Space -> submit
      await h.waitFor((f) => f.includes('Manage Deck:'), 2000, 'returned to browse after open convert');
      h.dispatchKey('v', {});
      await h.waitFor((f) => f.includes('Convert Card Kind'), 2000, 'convert reopened');
      h.dispatchKey('', { tab: true });
      h.dispatchKey('', { tab: true });
      await h.waitFor((f) => f.includes('MCQ -> T/F'), 2000, 'cycled to truefalse');
      // Toggle T/F answer with Space
      h.dispatchKey(' ', {});
      await h.waitFor((f) => f.includes('False'), 2000, 'toggled truefalse to False');
      // Submit conversion
      h.dispatchKey('', { return: true });
      await h.waitFor(() => calls.filter((c) => c.name === 'card.convert').length === 2, 3000, 'tf card.convert submitted');
      const convCall = calls.filter((c) => c.name === 'card.convert')[1];
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
      const queuedFrame = await h.waitFor((f) => f.includes('Job ID: job-supp-42'), 3000, 'supplement job queued');
      assert.equal(
        ASCII_FORBIDDEN_CHROME_RE.test(queuedFrame),
        false,
        `ASCII supplement queued screen must not leak unicode chrome or middle-dot:\n${queuedFrame}`,
      );

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

  test('9. Synchronous busyRef mutex blocks same-tick double-submits and Esc dismissal while supplement/convert/practice RPCs are in flight', async () => {
    const deck = makeSampleDeck();
    const snap = makeSampleSnapshot();
    resetStore({ language: 'en', asciiMode: true, snapshot: snap });

    const suppGate = deferred();
    const convertGate = deferred();
    const practiceGate = deferred();
    let closedCount = 0;

    const { host, calls } = makeHost(async (name, args) => {
      if (name === 'deck.get') return { ok: true, value: deck };
      if (name === 'supplement') {
        await suppGate.promise;
        return { ok: true, value: { jobId: 'job-mutex-1', status: 'queued' } };
      }
      if (name === 'card.convert') {
        await convertGate.promise;
        return { ok: true, value: { deckId: args.deckId, cardId: args.cardId, kind: args.kind } };
      }
      if (name === 'review.start') {
        await practiceGate.promise;
        return { ok: true, value: { id: 'run-mutex-1' } };
      }
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
      await h.waitFor((f) => f.includes('Operating Systems Core'), 3000, 'loaded for mutex test');

      // 1) Supplement: same-tick double Ctrl+S fires only once, and Esc while in flight does not dismiss supplement mode
      h.dispatchKey('+', {});
      await h.waitFor((f) => f.includes('Supplement Deck'), 2000, 'supplement open');
      h.dispatchKey(' ', {});
      await h.waitFor((f) => f.includes('2 pg'), 2000, 'source toggled');
      h.dispatchKey('s', { ctrl: true });
      h.dispatchKey('s', { ctrl: true });
      await h.waitFor(() => calls.filter((c) => c.name === 'supplement').length >= 1, 2000, 'supplement RPC started');
      h.dispatchKey('', { escape: true });
      await new Promise((r) => setTimeout(r, 40));
      assert.equal(calls.filter((c) => c.name === 'supplement').length, 1, 'same-tick double Ctrl+S must fire supplement only once');
      assert.equal(h.frame().includes('Supplement Deck'), true, 'Esc while supplement is in flight must not exit supplement mode');
      suppGate.resolve();
      await h.waitFor((f) => f.includes('Job ID: job-mutex-1'), 3000, 'supplement queued result rendered after Esc guard');
      // Esc after completion returns cleanly to browse
      h.dispatchKey('', { escape: true });
      await h.waitFor((f) => f.includes('Manage Deck:'), 2000, 'returned to browse after supplement finished');

      // 2) Convert: same-tick double Enter fires only once, and Esc while in flight does not exit convert mode
      h.dispatchKey('v', {});
      await h.waitFor((f) => f.includes('Convert Card Kind'), 2000, 'convert open');
      h.dispatchKey('', { return: true });
      h.dispatchKey('', { return: true });
      await h.waitFor(() => calls.filter((c) => c.name === 'card.convert').length >= 1, 2000, 'convert RPC started');
      h.dispatchKey('', { escape: true });
      await new Promise((r) => setTimeout(r, 40));
      assert.equal(calls.filter((c) => c.name === 'card.convert').length, 1, 'same-tick double Enter must fire card.convert only once');
      assert.equal(h.frame().includes('Convert Card Kind'), true, 'Esc while card.convert is in flight must not exit convert mode');
      convertGate.resolve();
      await h.waitFor((f) => f.includes('Manage Deck:'), 3000, 'returned to browse after convert finished');

      // 3) Single-card practice: same-tick double Enter fires review.start once, and Esc while in flight does not close modal
      h.dispatchKey('', { return: true });
      h.dispatchKey('', { return: true });
      await h.waitFor(() => calls.filter((c) => c.name === 'review.start').length >= 1, 2000, 'review.start started');
      h.dispatchKey('', { escape: true });
      await new Promise((r) => setTimeout(r, 40));
      assert.equal(calls.filter((c) => c.name === 'review.start').length, 1, 'same-tick double Enter must fire review.start only once');
      assert.equal(closedCount, 0, 'Esc while review.start is in flight must not close modal prematurely');
      practiceGate.resolve();
      await h.waitFor(() => closedCount === 1 && useTuiStore.getState().page === 'review', 3000, 'navigated to review once resolved');
    } finally {
      suppGate.resolve();
      convertGate.resolve();
      practiceGate.resolve();
      h.cleanup();
    }
  });

  test('10. Switching deckId mid-flight resets all sub-mode/busy state cleanly and blocks stale deck-A callbacks from corrupting deck-B', async () => {
    const deckA = makeSampleDeck({ id: 'deck-a', title: 'Deck Alpha', folder: 'Alpha / Root', course: 'CS101' });
    const deckB = makeSampleDeck({
      id: 'deck-b',
      title: 'Deck Beta',
      folder: 'Beta / Root',
      course: 'MATH201',
      cards: [
        {
          id: 'beta-c1',
          kind: 'flashcard',
          topic: 'Vectors',
          prompt: 'Define linear independence.',
          answer: 'Only trivial combination equals zero.',
        },
      ],
    });
    const snap = makeSampleSnapshot();
    resetStore({ language: 'en', asciiMode: true, snapshot: snap });

    const moveAGate = deferred();
    const moveAReplied = deferred();
    const practiceAGate = deferred();
    let updatedCount = 0;
    let closedCount = 0;

    const { host } = makeHost(async (name, args) => {
      if (name === 'deck.get') {
        if (args.id === 'deck-a') return { ok: true, value: structuredClone(deckA) };
        if (args.id === 'deck-b') return { ok: true, value: structuredClone(deckB) };
      }
      if (name === 'snapshot') return { ok: true, value: snap };
      if (name === 'deck.move') {
        if (args.id === 'deck-a') {
          await moveAGate.promise;
          setImmediate(() => moveAReplied.resolve());
          return { ok: true, value: { id: 'deck-a', folder: 'STALE_ALPHA_FOLDER' } };
        }
        return { ok: true, value: { id: args.id, folder: args.folder } };
      }
      if (name === 'review.start') {
        await practiceAGate.promise;
        return { ok: true, value: { id: 'run-stale-a' } };
      }
      return { ok: true, value: {} };
    });

    const onClose = () => {
      closedCount += 1;
    };
    const onUpdated = () => {
      updatedCount += 1;
    };

    const h = createHarness(
      React.createElement(DeckManageModal, {
        host,
        deckId: 'deck-a',
        isActive: true,
        width: 120,
        height: 36,
        onClose,
        onUpdated,
      }),
    );

    try {
      await h.waitFor((f) => f.includes('Deck Alpha') && f.includes('Folder: Alpha / Root'), 3000, 'deck-a loaded');

      // Enter search + folder move on deck-a so sub-mode and in-flight busy are both active
      h.dispatchKey('m', {});
      await h.waitFor((f) => f.includes('Deck folder'), 2000, 'deck-a folder mode open');
      h.write(' / Sub');
      await h.waitFor((f) => f.includes('/ Sub'), 2000, 'deck-a folder typed');
      h.dispatchKey('', { return: true });
      // Wait one tick for deck.move(deck-a) to be in flight
      await new Promise((r) => setTimeout(r, 30));

      // Switch deckId prop to deck-b while deck-a's deck.move is still pending
      h.rerender(
        React.createElement(DeckManageModal, {
          host,
          deckId: 'deck-b',
          isActive: true,
          width: 120,
          height: 36,
          onClose,
          onUpdated,
        }),
      );

      const betaFrame = await h.waitFor(
        (f) => f.includes('Deck Beta') && f.includes('Folder: Beta / Root') && !f.includes('Deck folder'),
        3000,
        'deck-b loaded cleanly in browse mode',
      );
      assert.equal(betaFrame.includes('STALE_ALPHA_FOLDER'), false);

      // Deck B must be immediately interactive (not blocked by deck-a's busy lock)
      h.dispatchKey(' ', {});
      await h.waitFor((f) => f.includes('[1 sel]'), 2000, 'deck-b interactive immediately');
      h.dispatchKey('x', {});
      await h.waitFor((f) => !f.includes('[1 sel]'), 2000, 'deck-b selection cleared');

      // Now resolve deck-a's stale deck.move -> must report toast & onUpdated, but NOT overwrite deck-b's folder
      moveAGate.resolve();
      await moveAReplied.promise;
      await h.waitFor(
        () => updatedCount >= 1 && useTuiStore.getState().toasts.some((t) => t.text.includes('STALE_ALPHA_FOLDER')),
        2000,
        'stale deck-a write still reported truthfully',
      );
      // The toast + onUpdated above run AFTER the stale reply's setDeck/setFolderValue would have run, so the
      // stale reply is fully processed by now. Force a render flush (select, then clear) and read the folder badge
      // with NOTHING selected: with a card selected the meta strip hides the folder (DeckManagePanels), which
      // would make this check vacuous.
      h.dispatchKey(' ', {});
      await h.waitFor((f) => f.includes('[1 sel]'), 2000, 'flushed deck-b render');
      h.dispatchKey('x', {});
      const afterStale = await h.waitFor(
        (f) => !f.includes('[1 sel]') && /Folder: (Beta \/ Root|STALE_ALPHA_FOLDER)/.test(f),
        2000,
        'deck-b folder badge visible with nothing selected after the stale reply',
      );
      assert.equal(afterStale.includes('Folder: Beta / Root'), true, 'deck-b folder badge must still show its own folder');
      assert.equal(afterStale.includes('STALE_ALPHA_FOLDER'), false, 'stale deck-a deck.move must not overwrite deck-b folder');
      assert.equal(afterStale.includes('Deck Beta'), true, 'deck-b title must remain intact');

      // Switch back to deck-a, start review.start (held), switch to deck-b, resolve -> must NOT close or navigate away from deck-b
      h.rerender(
        React.createElement(DeckManageModal, {
          host,
          deckId: 'deck-a',
          isActive: true,
          width: 120,
          height: 36,
          onClose,
          onUpdated,
        }),
      );
      await h.waitFor((f) => f.includes('Deck Alpha'), 3000, 'back to deck-a');
      h.dispatchKey('', { return: true });
      await new Promise((r) => setTimeout(r, 30));

      h.rerender(
        React.createElement(DeckManageModal, {
          host,
          deckId: 'deck-b',
          isActive: true,
          width: 120,
          height: 36,
          onClose,
          onUpdated,
        }),
      );
      await h.waitFor((f) => f.includes('Deck Beta'), 3000, 'switched back to deck-b while deck-a practice pending');
      practiceAGate.resolve();
      await new Promise((r) => setTimeout(r, 50));
      assert.equal(closedCount, 0, 'stale deck-a review.start must not close deck-b');
      assert.equal(useTuiStore.getState().page, 'library', 'stale deck-a review.start must not navigate away from deck-b');
    } finally {
      moveAGate.resolve();
      practiceAGate.resolve();
      h.cleanup();
    }
  });

  test('11. A stale deck-A endBusy must not release the busy lock of a deck-B write that is still in flight', async () => {
    const deckA = makeSampleDeck({ id: 'deck-a', title: 'Deck Alpha', folder: 'Alpha / Root', course: 'CS101' });
    const deckB = makeSampleDeck({ id: 'deck-b', title: 'Deck Beta', folder: 'Beta / Root', course: 'MATH201' });
    const snap = makeSampleSnapshot();
    resetStore({ language: 'en', asciiMode: true, snapshot: snap });

    const moveAGate = deferred();
    const moveBGate = deferred();

    const { host, calls } = makeHost(async (name, args) => {
      if (name === 'deck.get') {
        if (args.id === 'deck-a') return { ok: true, value: structuredClone(deckA) };
        if (args.id === 'deck-b') return { ok: true, value: structuredClone(deckB) };
      }
      if (name === 'snapshot') return { ok: true, value: snap };
      if (name === 'deck.move') {
        if (args.id === 'deck-a') {
          await moveAGate.promise;
          return { ok: true, value: { id: 'deck-a', folder: 'ALPHA_LATE_FOLDER' } };
        }
        await moveBGate.promise;
        return { ok: true, value: { id: args.id, folder: args.folder } };
      }
      return { ok: true, value: {} };
    });

    const moveCalls = (id) => calls.filter((c) => c.name === 'deck.move' && c.args.id === id);
    const element = (deckId) =>
      React.createElement(DeckManageModal, { host, deckId, isActive: true, width: 120, height: 36, onClose: () => {} });
    const hasToast = (needle) => useTuiStore.getState().toasts.some((t) => t.text.includes(needle));

    const h = createHarness(element('deck-a'));

    try {
      await h.waitFor((f) => f.includes('Deck Alpha') && f.includes('Folder: Alpha / Root'), 3000, 'deck-a loaded');

      // 1) deck-A write in flight (held)
      h.dispatchKey('m', {});
      await h.waitFor((f) => f.includes('Deck folder'), 2000, 'deck-a folder mode open');
      h.write(' / Sub');
      await h.waitFor((f) => f.includes('/ Sub'), 2000, 'deck-a folder typed');
      h.dispatchKey('', { return: true });
      await h.waitFor(() => moveCalls('deck-a').length === 1, 2000, 'deck-a deck.move in flight');

      // 2) switch to deck-B, 3) start a deck-B write and hold it
      h.rerender(element('deck-b'));
      await h.waitFor((f) => f.includes('Deck Beta') && f.includes('Folder: Beta / Root') && !f.includes('Deck folder'), 3000, 'deck-b loaded');
      h.dispatchKey('m', {});
      await h.waitFor((f) => f.includes('Deck folder'), 2000, 'deck-b folder mode open');
      h.write(' / Sub');
      await h.waitFor((f) => f.includes('/ Sub'), 2000, 'deck-b folder typed');
      h.dispatchKey('', { return: true });
      await h.waitFor(() => moveCalls('deck-b').length === 1, 2000, 'deck-b deck.move in flight');

      // 4) let deck-A's write finish; its toast is emitted right before its finally -> endBusy(token-A) runs
      moveAGate.resolve();
      await h.waitFor(() => hasToast('ALPHA_LATE_FOLDER'), 3000, 'deck-a late write finished (its endBusy has run)');

      // 5) deck-B's write is still held: a second deck-B submit must be refused as busy
      h.dispatchKey('', { return: true });

      // Release deck-B and wait for its own completion; only then count, so no fixed sleep is needed.
      moveBGate.resolve();
      await h.waitFor(() => hasToast('Beta / Root / Sub'), 3000, 'deck-b write finished');
      assert.equal(
        moveCalls('deck-b').length,
        1,
        'a late deck-a endBusy must not release the deck-b lock: the second deck-b submit must be refused',
      );
    } finally {
      moveAGate.resolve();
      moveBGate.resolve();
      h.cleanup();
    }
  });
});

// #1608 follow-ups to the DeckManageModal split review.
describe('#1608 DeckManageModal: submit returns to browse, replies for a switched deck are dropped, Esc while saving explains itself', () => {
  const hasToast = (needle) => useTuiStore.getState().toasts.some((toast) => toast.text.includes(needle));
  const deckOfCall = (args) => args?.id ?? args?.deckId ?? args?.updates?.[0]?.deckId;

  async function waitCondition(pred, timeoutMs, label) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (pred()) return;
      await new Promise((r) => setTimeout(r, 20));
    }
    throw new Error(`waitCondition(${label}) timed out`);
  }

  test('12. A successful folder or topic submit returns to the browse view (as before the split)', async () => {
    const deck = makeSampleDeck();
    const snap = makeSampleSnapshot();
    resetStore({ language: 'en', asciiMode: true, snapshot: snap });
    const { calls, host } = makeHost(async (name, args) => {
      if (name === 'deck.get') return { ok: true, value: deck };
      if (name === 'snapshot') return { ok: true, value: snap };
      if (name === 'deck.move') return { ok: true, value: { id: args.id, folder: args.folder } };
      return { ok: true, value: {} };
    });
    const h = createHarness(
      React.createElement(DeckManageModal, { host, deckId: deck.id, isActive: true, width: 120, height: 36, onClose: () => {} }),
    );
    try {
      await h.waitFor((f) => f.includes('Operating Systems Core') && f.includes('Folder: Systems / Kernel'), 3000, 'deck loaded');

      h.dispatchKey('m', {});
      await h.waitFor((f) => f.includes('Deck folder'), 2000, 'folder form open');
      h.write(' / Paging');
      await h.waitFor((f) => f.includes('/ Paging'), 2000, 'folder typed');
      h.dispatchKey('', { return: true });
      await h.waitFor(() => hasToast('Moved to folder'), 3000, 'folder saved');
      const afterFolderFrame = await h.waitFor((f) => !f.includes('Deck folder') && f.includes('Sel'), 2000, 'back in browse after the folder submit');
      assert.deepEqual(
        calls.find((c) => c.name === 'deck.move')?.args,
        { id: deck.id, folder: 'Systems / Kernel / Paging' },
        'folder submit sends expected deck.move payload',
      );
      assert.equal(afterFolderFrame.includes('Deck folder'), false);
      assert.equal(afterFolderFrame.includes('Sel'), true);

      h.dispatchKey(' ', {});
      await h.waitFor((f) => f.includes('[1 sel]'), 2000, 'one card selected');
      h.dispatchKey('T', {});
      await h.waitFor((f) => f.includes('Batch retag topic'), 2000, 'topic form open');
      h.write('Memory');
      await h.waitFor((f) => f.includes('Memory'), 2000, 'topic typed');
      h.dispatchKey('', { return: true });
      await h.waitFor(() => hasToast('Retagged 1 card(s)'), 3000, 'topic saved');
      const afterTopicFrame = await h.waitFor((f) => !f.includes('Batch retag topic') && f.includes('Sel'), 2000, 'back in browse after the topic submit');
      const batchCall = calls.find((c) => c.name === 'card.update.batch');
      assert.equal(batchCall?.args?.updates?.length, 1, 'batch topic submit updates 1 selected card');
      assert.equal(batchCall?.args?.updates?.[0]?.patch?.topic, 'Memory');
      assert.equal(afterTopicFrame.includes('Batch retag topic'), false);
      assert.equal(afterTopicFrame.includes('Sel'), true);
      assert.equal(afterTopicFrame.includes('[1 sel]'), false, 'selection cleared after batch retag');
    } finally {
      h.cleanup();
    }
  });

  test('13. Held course, topic and convert replies made for deck A never change deck B after a switch', async () => {
    const deckA = makeSampleDeck({ id: 'deck-a', title: 'Deck Alpha', folder: 'Alpha / Root', course: 'CS101' });
    const deckB = makeSampleDeck({ id: 'deck-b', title: 'Deck Beta', folder: 'Beta / Root', course: 'MATH201' });
    const snap = makeSampleSnapshot();
    resetStore({ language: 'en', asciiMode: true, snapshot: snap });

    const gates = { 'deck.course': deferred(), 'card.update.batch': deferred(), 'card.convert': deferred() };
    const { host, calls } = makeHost(async (name, args) => {
      if (name === 'deck.get') {
        if (args.id === 'deck-a') return { ok: true, value: structuredClone(deckA) };
        if (args.id === 'deck-b') return { ok: true, value: structuredClone(deckB) };
      }
      if (name === 'snapshot') return { ok: true, value: snap };
      const deckOf = deckOfCall(args);
      if (gates[name] && deckOf === 'deck-a') await gates[name].promise;
      if (name === 'deck.course') return { ok: true, value: { id: args.id, course: 'LATE_ALPHA_COURSE' } };
      if (name === 'card.update.batch') {
        return { ok: true, value: { updated: args.updates.length, failed: 0, results: [] } };
      }
      if (name === 'card.convert') return { ok: true, value: { deckId: args.deckId, cardId: args.cardId, kind: args.kind } };
      return { ok: true, value: {} };
    });
    const element = (deckId) =>
      React.createElement(DeckManageModal, { host, deckId, isActive: true, width: 120, height: 36, onClose: () => {} });
    const started = (name) => calls.some((c) => c.name === name && deckOfCall(c.args) === 'deck-a');
    const h = createHarness(element('deck-a'));
    try {
      // 1) deck.course for A is held; switch to B, open B's course form, then let A's reply land.
      await h.waitFor((f) => f.includes('Deck Alpha'), 3000, 'deck-a loaded');
      h.dispatchKey('C', {});
      await h.waitFor((f) => f.includes('Reassign deck course'), 2000, 'deck-a course form');
      h.write('X');
      await h.waitFor((f) => f.includes('CS101X'), 2000, 'deck-a course typed');
      h.dispatchKey('', { return: true });
      await h.waitFor(() => started('deck.course'), 2000, 'deck-a deck.course held');
      h.rerender(element('deck-b'));
      await h.waitFor((f) => f.includes('Deck Beta') && !f.includes('Reassign deck course'), 3000, 'deck-b in browse');
      h.dispatchKey('C', {});
      await h.waitFor((f) => f.includes('Reassign deck course') && f.includes('MATH201'), 2000, 'deck-b course form shows its own course');
      gates['deck.course'].resolve();
      await h.waitFor(() => hasToast('LATE_ALPHA_COURSE'), 3000, 'deck-a late course reply reported');
      h.write('!');
      const courseFrame = await h.waitFor((f) => f.includes('MATH201!') || f.includes('LATE_ALPHA_COURSE!'), 2000, 'deck-b course form re-rendered');
      assert.equal(courseFrame.includes('MATH201!'), true, "deck-a's reply must not overwrite deck-b's course draft");
      assert.equal(courseFrame.includes('Reassign deck course'), true, "deck-a's reply must not close deck-b's course form");
      h.dispatchKey('', { escape: true });
      await h.waitFor((f) => !f.includes('Reassign deck course'), 2000, 'deck-b course form closed');

      // 2) topic retag for A is held; on B a card is selected; A's reply must not clear B's selection.
      h.rerender(element('deck-a'));
      await h.waitFor((f) => f.includes('Deck Alpha'), 3000, 'back on deck-a');
      h.dispatchKey(' ', {});
      await h.waitFor((f) => f.includes('[1 sel]'), 2000, 'deck-a card selected');
      h.dispatchKey('T', {});
      await h.waitFor((f) => f.includes('Batch retag topic'), 2000, 'deck-a topic form');
      h.write('Late');
      await h.waitFor((f) => f.includes('Late'), 2000, 'deck-a topic typed');
      h.dispatchKey('', { return: true });
      await h.waitFor(() => started('card.update.batch'), 2000, 'deck-a topic update held');
      h.rerender(element('deck-b'));
      await h.waitFor((f) => f.includes('Deck Beta') && !f.includes('Batch retag topic'), 3000, 'deck-b in browse');
      h.dispatchKey(' ', {});
      await h.waitFor((f) => f.includes('[1 sel]'), 2000, 'deck-b card selected');
      gates['card.update.batch'].resolve();
      await h.waitFor(() => hasToast('Retagged'), 3000, 'deck-a late topic reply reported');
      h.dispatchKey('', { downArrow: true });
      const topicFrame = await h.waitFor((f) => f.includes('Deck Beta'), 2000, 'deck-b re-rendered');
      assert.equal(topicFrame.includes('[1 sel]'), true, "deck-a's reply must not clear deck-b's selection");
      h.dispatchKey('x', {});
      await h.waitFor((f) => !f.includes('[1 sel]'), 2000, 'deck-b selection cleared');

      // 3) convert for A is held; B is in search mode; A's reply must not pull B back to browse.
      h.rerender(element('deck-a'));
      await h.waitFor((f) => f.includes('Deck Alpha'), 3000, 'back on deck-a again');
      h.dispatchKey('v', {});
      await h.waitFor((f) => f.includes('Convert Card Kind'), 2000, 'deck-a convert open');
      h.dispatchKey('', { return: true });
      await h.waitFor(() => started('card.convert'), 2000, 'deck-a convert held');
      h.rerender(element('deck-b'));
      await h.waitFor((f) => f.includes('Deck Beta') && !f.includes('Convert Card Kind'), 3000, 'deck-b in browse');
      h.dispatchKey('/', {});
      await h.waitFor((f) => f.includes('Filter cards:'), 2000, 'deck-b search open');
      gates['card.convert'].resolve();
      await h.waitFor(() => hasToast('Converted card'), 3000, 'deck-a late convert reply reported');
      h.write('c');
      const searchFrame = await h.waitFor((f) => f.includes('Deck Beta'), 2000, 'deck-b re-rendered after the convert reply');
      assert.equal(searchFrame.includes('Filter cards:'), true, "deck-a's reply must not pull deck-b out of search");
    } finally {
      for (const g of Object.values(gates)) g.resolve();
      h.cleanup();
    }
  });

  test('14. Esc while a write hangs keeps the modal open but says what it is waiting for', async () => {
    const deck = makeSampleDeck();
    const snap = makeSampleSnapshot();
    resetStore({ language: 'zh', asciiMode: true, snapshot: snap });
    const moveGate = deferred();
    const focusGate = deferred();
    let closed = 0;
    const { host } = makeHost(async (name, args) => {
      if (name === 'deck.get') return { ok: true, value: deck };
      if (name === 'snapshot') return { ok: true, value: snap };
      if (name === 'deck.move') {
        await moveGate.promise;
        return { ok: true, value: { id: args.id, folder: args.folder } };
      }
      if (name === 'card.focus') {
        await focusGate.promise;
        return { ok: true, value: { focus: args.focus } };
      }
      return { ok: true, value: {} };
    });
    const WAITING_ZH = '正在保存，完成后可关闭';
    const waitingToasts = () => useTuiStore.getState().toasts.filter((toast) => toast.text === WAITING_ZH).length;
    const h = createHarness(
      React.createElement(DeckManageModal, {
        host,
        deckId: deck.id,
        isActive: true,
        width: 120,
        height: 36,
        onClose: () => {
          closed += 1;
        },
      }),
    );
    try {
      await h.waitFor((f) => f.includes('Operating Systems Core'), 3000, 'deck loaded');

      // Browse: batch focus hangs; Esc must not close and must say why.
      h.dispatchKey(' ', {});
      await h.waitFor((f) => f.includes('已选 1'), 2000, 'one card selected');
      h.dispatchKey('F', {});
      await new Promise((r) => setTimeout(r, 30));
      h.dispatchKey('', { escape: true });
      await waitCondition(() => waitingToasts() >= 1, 2000, 'Esc while browse write hangs explains the wait');
      assert.equal(closed, 0, 'Esc must not close the modal while the write hangs');
      focusGate.resolve();
      await h.waitFor(() => useTuiStore.getState().toasts.some((toast) => toast.text.includes('重点')), 3000, 'focus write finished');

      // Folder form: deck.move hangs; Esc must keep the form and say why (before, Esc did nothing at all here).
      h.dispatchKey('x', {});
      h.dispatchKey('m', {});
      await h.waitFor((f) => f.includes('设置题组目录'), 2000, 'folder form open');
      h.write(' / Hold');
      await h.waitFor((f) => f.includes('/ Hold'), 2000, 'folder typed');
      h.dispatchKey('', { return: true });
      await new Promise((r) => setTimeout(r, 30));
      const before = waitingToasts();
      useTuiStore.setState({ toasts: [] });
      h.dispatchKey('', { escape: true });
      await waitCondition(() => waitingToasts() >= 1, 2000, 'Esc while the folder write hangs explains the wait');
      assert.ok(before >= 0);
      assert.equal(h.frame().includes('设置题组目录'), true, 'the folder form stays while its write hangs');
      assert.equal(closed, 0);

      moveGate.resolve();
      await h.waitFor((f) => !f.includes('设置题组目录'), 3000, 'folder write finished, back to browse');
      h.dispatchKey('', { escape: true });
      await waitCondition(() => closed === 1, 2000, 'Esc closes once nothing is pending');
    } finally {
      moveGate.resolve();
      focusGate.resolve();
      h.cleanup();
    }
  });
});
