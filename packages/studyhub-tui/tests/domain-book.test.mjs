// Consolidated Book Domain Suite:
// Merged from:
// - round40-book-place (course.book.place + BookStructureModal)
// - round41-book-retell (book.retell + BookRetellModal + P2 ConfirmDialog)
// - round42-book-mock (book.mock.plan + book.mock -> ExamView + BookQaModal)
// - round57-book-explain (generation.courseBook.explain + BookExplainModal)
// - round61-book-history (course.book.revision + course.book.revert + BookHistoryModal)
// - round63-book-aiblock (course.book.block + BookAiBlocksModal + parseAiBlocks)
// - round73-book-toc-filter (BookView / Live TOC Filter)
// node --test tests/domain-book.test.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { mkdir, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { after, describe, test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { render } from 'ink';
import React from 'react';
import { register } from 'tsx/esm/api';
import { StudyService } from '../../../lib/service.js';
import { courseOutlineMaterial, materialsFingerprint } from '../../../lib/course-outline-book.js';
import { courseNotesMaterial } from '../../../lib/course-book.js';
import { buildOutlineIndex } from '../../../lib/course-outline-index.js';
import { groupSourcesByDocument } from '../../../lib/source-groups.js';
import { openCourseBook } from '../../../lib/course-book-files.js';
import { followupDigest } from '../../../lib/followup.js';
import {
  createTempTracker,
  createVirtualTty,
  disposeTerminalPool,
  distDir,
  installNoNetworkGuard,
  loadDistRuntime,
  sanitizedTestEnv,
} from './helpers/virtual-tty.mjs';

const unregisterTsx = register();

const runtime = await loadDistRuntime();
const { StudyHubTuiApp, createTuiHost, saveTuiPreferences } = runtime;
assert.ok(StudyHubTuiApp, 'dist/ must export StudyHubTuiApp');
assert.ok(createTuiHost, 'dist/ must export createTuiHost');
assert.ok(saveTuiPreferences, 'dist/ must export saveTuiPreferences');

const distFiles = (await readdir(distDir)).filter((f) => f.endsWith('.mjs') && f !== 'cli.mjs');
const storeFile = distFiles.find((f) => f.startsWith('store-') && f.endsWith('.mjs'));
assert.ok(storeFile, 'dist/ must include store-*.mjs');
const { useTuiStore, DEFAULT_PREFERENCES } = await import(pathToFileURL(join(distDir, storeFile)).href);
assert.ok(useTuiStore, 'dist/store-*.mjs must export useTuiStore');
assert.ok(DEFAULT_PREFERENCES, 'dist/store-*.mjs must export DEFAULT_PREFERENCES');

const [{ normalizeAsciiChrome }, { displayWidth }] = await Promise.all([
  import('../src/components/Badge.tsx'),
  import('../src/render/cjk.ts'),
]);
assert.equal(typeof normalizeAsciiChrome, 'function', 'Badge.tsx must export normalizeAsciiChrome');
assert.equal(typeof displayWidth, 'function', 'cjk.ts must export displayWidth');

// Lazy-chunk & bundle-isolation invariants (Rounds 57, 61, 63)
const explainChunk = distFiles.find((f) => f.startsWith('BookExplainModal-') && f.endsWith('.mjs'));
assert.ok(explainChunk, 'BookExplainModal must be lazy-split into dist/BookExplainModal-*.mjs');

const historyChunk = distFiles.find((f) => f.startsWith('BookHistoryModal-') && f.endsWith('.mjs'));
assert.ok(historyChunk, `dist/ must emit lazy BookHistoryModal-*.mjs chunk, found: ${distFiles.join(', ')}`);
const historyChunkCode = fs.readFileSync(join(distDir, historyChunk), 'utf8');
assert.equal(/\bmarked\b/.test(historyChunkCode), false, `${historyChunk} must be marked-free`);
assert.equal(/\bcli-highlight\b/.test(historyChunkCode), false, `${historyChunk} must not bundle cli-highlight`);
assert.equal(/src\/components\/MarkdownView\.tsx/.test(historyChunkCode), false, `${historyChunk} must not bundle MarkdownView`);

const aiBlocksChunk = distFiles.find((f) => f.startsWith('BookAiBlocksModal-') && f.endsWith('.mjs'));
assert.ok(aiBlocksChunk, `dist/ must emit lazy BookAiBlocksModal-*.mjs chunk, found: ${distFiles.join(', ')}`);
const aiBlocksChunkCode = fs.readFileSync(join(distDir, aiBlocksChunk), 'utf8');
assert.equal(/\bmarked\b/.test(aiBlocksChunkCode), false, `${aiBlocksChunk} must be marked-free`);
assert.equal(/\bcli-highlight\b/.test(aiBlocksChunkCode), false, `${aiBlocksChunk} must not bundle cli-highlight`);
assert.equal(/src\/components\/MarkdownView\.tsx/.test(aiBlocksChunkCode), false, `${aiBlocksChunk} must not bundle MarkdownView`);

const aiBlocksMod = await import(pathToFileURL(join(distDir, aiBlocksChunk)).href);
assert.equal(typeof aiBlocksMod.parseAiBlocks, 'function', `${aiBlocksChunk} must export parseAiBlocks`);
const { parseAiBlocks } = aiBlocksMod;

const PREV_DSH_HOME = process.env.DSH_HOME;
const restoreNetworkGuard = installNoNetworkGuard();
const temps = createTempTracker('studyhub-tui-dom-book-');

after(async () => {
  restoreNetworkGuard();
  disposeTerminalPool();
  unregisterTsx?.();
  if (PREV_DSH_HOME === undefined) delete process.env.DSH_HOME;
  else process.env.DSH_HOME = PREV_DSH_HOME;
  await temps.cleanup();
});

function resetTuiStore(language = 'zh', asciiMode = false, extra = {}) {
  useTuiStore.setState({
    page: 'library',
    navContext: {},
    history: [],
    snapshot: null,
    binding: null,
    config: null,
    desktopConfig: null,
    loading: false,
    refreshing: false,
    lastError: null,
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
      recentCommands: [...DEFAULT_PREFERENCES.recentCommands],
      language,
      asciiMode,
    },
    ...extra,
  });
}

function assertHealthyBookScreen(tty, screen, expectedCols, expectedRows, label) {
  tty.assertHealthyScreen(screen, expectedCols, expectedRows, label);
  assert.ok(!screen.includes('\uFFFD'), `${label}: replacement char U+FFFD leaked`);
  const lines = screen.split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    const w = displayWidth(lines[i]);
    assert.ok(w <= expectedCols, `${label}: row ${i} width ${w} > ${expectedCols}: ${JSON.stringify(lines[i])}`);
  }
}

/**
 * Seed a course with lecture pages, an outline, an open review book, and optional decks.
 */
async function seedBookLibrary(root, {
  course,
  docs,
  chapters,
  fingerprintChar = 'b',
  citeQuote = 'failure',
  bodyPointBuilder = null,
  decks = null,
}) {
  await mkdir(root, { recursive: true });
  const service = new StudyService(root);
  try {
    await service.call('snapshot');
    await service.store.update((state) => {
    for (const doc of docs) {
      state.sources.push({
        id: doc.id,
        title: doc.title,
        createdAt: doc.createdAt,
        courses: [course],
        text: doc.text,
        document: {
          materialId: doc.materialId ?? 'doc-l1',
          page: doc.page,
          totalPages: docs.length,
          format: 'pdf',
          origin: 'converted',
          converter: 'marker',
          filename: doc.filename ?? 'lecture-1.pdf',
          chapter: { index: doc.chapterIndex ?? doc.page - 1, title: doc.chapterTitle, level: 1 },
          extractionVersion: 2,
        },
      });
    }
    if (Array.isArray(decks) && decks.length > 0) {
      for (const deck of decks) state.decks.push(deck);
    }
    state.focus = { mode: 'class', course, role: '', jd: '', targetTopics: [] };
    const lecture = groupSourcesByDocument(state.sources).find((item) => item.sourceIds.includes(docs[0].id)).key;

    const outlineNodes = chapters.map((ch) => ({
      id: ch.id,
      title: ch.title,
      children: ch.leaves.map((leaf) => ({
        id: leaf.id,
        title: leaf.title,
        anchors: [`${lecture}#${leaf.anchorIndex}`],
      })),
    }));
    const allLeaves = outlineNodes.flatMap((ch) => ch.children);

    const outline = {
      ...courseOutlineMaterial({
        title: `Outline · ${course}`,
        course,
        orderBasis: { codes: ['numbering'] },
        fingerprint: materialsFingerprint(buildOutlineIndex(state, { course }).allDocuments),
        nodes: outlineNodes,
        other: { anchors: [] },
        counts: { units: allLeaves.length, leftover: 0, invalid: 0, repeated: 0 },
      }),
      createdAt: '2026-10-09T00:00:00.000Z',
    };
    state.sources.push(outline);
    state.sources.push({
      ...courseNotesMaterial({
        title: `Review Book · ${course}`,
        course,
        outlineId: outline.id,
        language: 'zh',
        papers: [],
        counts: {},
        leaves: allLeaves.map((leaf, idx) => ({
          ...leaf,
          body: {
            fingerprint: fingerprintChar.repeat(16),
            points: [bodyPointBuilder ? bodyPointBuilder(leaf, idx) : `${leaf.title} core mechanism [^1].`],
            explain: `Detailed notes for ${leaf.title}.`,
            cites: [{
              n: 1,
              sourceId: docs[idx]?.id ?? docs[0].id,
              quote: citeQuote,
              start: 0,
              end: citeQuote.length,
            }],
          },
        })),
      }),
      createdAt: '2026-10-09T01:00:00.000Z',
    });
      openCourseBook(state, { course });
    });
  } finally {
    await service.dispose();
  }
}

function seedResilienceLibrary(root, course, extra = {}) {
  return seedBookLibrary(root, {
    course,
    docs: [
      {
        id: 'doc1-p1',
        title: 'Lecture 1 · p. 1',
        createdAt: '2026-10-01T00:00:00.000Z',
        text: 'Circuit breakers prevent cascading failures by tripping open when failure thresholds are crossed.',
        page: 1,
        chapterTitle: 'Circuit Breaker',
      },
      {
        id: 'doc1-p2',
        title: 'Lecture 1 · p. 2',
        createdAt: '2026-10-01T01:00:00.000Z',
        text: 'Bulkheads isolate resource pools so one slow dependency does not exhaust all threads.',
        page: 2,
        chapterTitle: 'Bulkhead Isolation',
      },
    ],
    chapters: [
      {
        id: 'ch1',
        title: 'Resilience Patterns',
        leaves: [
          { id: 'breaker', title: 'Circuit Breaker', anchorIndex: 0 },
          { id: 'bulkhead', title: 'Bulkhead Isolation', anchorIndex: 1 },
        ],
      },
    ],
    ...extra,
  });
}

async function createBookPtyHost(label, { course, seedFn, injectedComplete, language = 'zh', asciiMode = false }) {
  const base = await temps.make(label);
  const env = sanitizedTestEnv({ DSH_HOME: join(base, 'dsh-home') });
  process.env.DSH_HOME = env.DSH_HOME;
  const libraryRoot = join(base, 'library');
  await seedFn(libraryRoot, course);
  await saveTuiPreferences({ language, asciiMode }, { env });
  resetTuiStore(language, asciiMode);

  const host = await createTuiHost({
    libraryRoot,
    env,
    home: base,
    documentsDir: base,
    skipAutoProbe: true,
    language,
    ...(injectedComplete ? { injectedComplete } : {}),
  });
  return { base, env, libraryRoot, host };
}

async function openBookViewInPty(host, tty, { course, readyPredicate, label }) {
  const inkInstance = render(React.createElement(StudyHubTuiApp, { host, asciiMode: false }), {
    stdin: tty.stdin,
    stdout: tty.stdout,
    stderr: tty.stderr,
    interactive: true,
    exitOnCtrlC: false,
    patchConsole: false,
  });
  await tty.firstFramePromise;
  // Wait for host snapshot to populate activeCourse before pressing '7' so BookView never resets selection mid-test
  await tty.waitFor(
    (s) => Boolean(useTuiStore.getState().snapshot) && s.includes(course),
    { label: `${label}: App snapshot & course loaded` },
  );
  tty.send('7');
  const bookScreen = await tty.waitFor(
    (s) => useTuiStore.getState().page === 'book' && !s.includes('正在打开复习全书') && readyPredicate(s),
    { label: `${label}: BookView rendered` },
  );
  return { inkInstance, bookScreen };
}

// --- Feature-specific helpers ---

async function createUnplacedFromSecondLeaf(host, course, noteText) {
  const openRes = await host.call('course.book.open', { course, language: 'zh' });
  assert.equal(openRes.ok, true, openRes.error?.message);
  const [alpha, beta] = openRes.value.nodes[0].children;
  assert.ok(alpha?.hid, 'first leaf must have hid');
  assert.ok(beta?.hid, 'second leaf must have hid');
  const betaMine = beta.files.mine;
  const betaVer = openRes.value.files[betaMine].version;

  const saved = await host.call('course.book.save', {
    course,
    file: betaMine,
    text: noteText,
    version: betaVer,
  });
  assert.equal(saved.ok, true, saved.error?.message);

  const deleted = await host.call('course.book.delete', {
    course,
    hid: beta.hid,
    children: 'promote',
    version: openRes.value.structureVersion,
  });
  assert.equal(deleted.ok, true, deleted.error?.message);
  assert.ok(deleted.value.structureVersion >= openRes.value.structureVersion);
  return { alpha, beta, structureVersion: deleted.value.structureVersion };
}

async function seedTwoEdits(host, course, firstText, secondText) {
  const openRes = await host.call('course.book.open', { course, language: 'zh' });
  assert.equal(openRes.ok, true, openRes.error?.message);
  const firstLeaf = openRes.value.nodes[0].children[0];
  const file = firstLeaf.files.gen;
  const v1 = openRes.value.files[file].version;
  const initialText = firstLeaf.gen;

  const save1 = await host.call('course.book.save', {
    course,
    file,
    text: firstText,
    version: v1,
  });
  assert.equal(save1.ok, true, save1.error?.message);
  const v2 = save1.value.files[file].version;
  assert.ok(v2 > v1, 'first save must advance version');

  const save2 = await host.call('course.book.save', {
    course,
    file,
    text: secondText,
    version: v2,
  });
  assert.equal(save2.ok, true, save2.error?.message);
  const v3 = save2.value.files[file].version;
  assert.ok(v3 > v2, 'second save must advance version');

  return { file, v1, v2, v3, initialText };
}

async function seedAiBlocksInMineFile(host, course, text) {
  const openRes = await host.call('course.book.open', { course, language: 'zh' });
  assert.equal(openRes.ok, true, openRes.error?.message);
  const firstLeaf = openRes.value.nodes[0].children[0];
  const file = firstLeaf.files.mine;
  const v1 = openRes.value.files[file].version;

  const saveRes = await host.call('course.book.save', {
    course,
    file,
    text,
    version: v1,
  });
  assert.equal(saveRes.ok, true, saveRes.error?.message);
  return { file, leaf: firstLeaf };
}

function buildMockDecks(course) {
  const mcqCard = {
    id: 'q-mcq-1',
    kind: 'quiz',
    topic: 'Circuit Breaker',
    prompt: 'When does a circuit breaker trip open?',
    options: [
      { id: 'a', text: 'When failure threshold is crossed', correct: true },
      { id: 'b', text: 'Only on manual restart', correct: false },
    ],
    citations: [{ sourceId: 'doc1-p1', quote: 'tripping open when failure thresholds are crossed' }],
  };
  mcqCard.followups = [
    {
      id: 'fu-cb-1',
      question: 'Why does half-open state probe before closing?',
      answer: 'Half-open limits probe traffic so a recovering downstream service is not flooded.',
      at: '2026-10-02T00:00:00.000Z',
      digest: followupDigest(mcqCard),
    },
  ];
  return [
    {
      id: 'deck-mock-1',
      title: 'Resilience Questions',
      course,
      cards: [
        mcqCard,
        {
          id: 'q-multi-2',
          kind: 'multi',
          topic: 'Circuit Breaker',
          prompt: 'Which benefits do circuit breakers provide?',
          options: [
            { id: 'a', text: 'Stop cascading failures', correct: true },
            { id: 'b', text: 'Fail fast when downstream is down', correct: true },
            { id: 'c', text: 'Double network bandwidth', correct: false },
          ],
          citations: [{ sourceId: 'doc1-p1', quote: 'Circuit breakers prevent cascading failures' }],
        },
        {
          id: 'q-flash-3',
          kind: 'flashcard',
          topic: 'Circuit Breaker',
          prompt: 'Name the three states of a circuit breaker.',
          answer: 'Closed, Open, Half-Open.',
          citations: [{ sourceId: 'doc1-p1', quote: 'Circuit breakers prevent cascading failures' }],
        },
        {
          id: 'q-bulk-flash',
          kind: 'flashcard',
          topic: 'Bulkhead Isolation',
          prompt: 'What does a bulkhead isolate?',
          answer: 'Resource pools such as thread or connection pools.',
          citations: [{ sourceId: 'doc1-p2', quote: 'Bulkheads isolate resource pools' }],
        },
      ],
    },
  ];
}

// ============================================================================
// Suite 0: Book Unit Tests (parseAiBlocks + normalizeAsciiChrome + displayWidth)
// ============================================================================
describe('Domain Book 0: Unit Tests (parseAiBlocks + ASCII Chrome Normalization)', () => {
  test('parseAiBlocks parses sh:ai syntax, offsets, edge cases, and normalizeAsciiChrome/displayWidth invariants', () => {
    const sample = [
      'Learner own note.',
      '',
      '<!-- sh:ai id=ai-1 at=a1b2c3d4 state=new mode=explain ask=%E4%B8%BA%E4%BB%80%E4%B9%88%E9%9C%80%E8%A6%81%E7%8E%AF -->',
      '关于：「一致性哈希环」',
      '',
      '哈希环能把节点增删的影响局部化。',
      '<!-- /sh:ai -->',
      '',
      '<!-- sh:ai id=ai-2 at=h:h1 state=kept mode=here -->',
      'About: “Virtual nodes”',
      '',
      'Virtual nodes balance uneven key distribution.',
      '<!-- /sh:ai -->',
    ].join('\n');

    const parsed = parseAiBlocks(sample);
    assert.equal(parsed.length, 2);
    assert.equal(parsed[0].id, 'ai-1');
    assert.equal(parsed[0].at, 'a1b2c3d4');
    assert.equal(parsed[0].state, 'new');
    assert.equal(parsed[0].mode, 'explain');
    assert.equal(parsed[0].ask, '为什么需要环');
    assert.equal(parsed[0].about, '一致性哈希环');
    assert.equal(parsed[0].first, '关于：「一致性哈希环」');
    assert.equal(parsed[0].body, '哈希环能把节点增删的影响局部化。');
    assert.equal(sample.slice(parsed[0].start, parsed[0].end), parsed[0].raw);

    assert.equal(parsed[1].id, 'ai-2');
    assert.equal(parsed[1].at, 'h:h1');
    assert.equal(parsed[1].state, 'kept');
    assert.equal(parsed[1].mode, 'here');
    assert.equal(parsed[1].ask, '');
    assert.equal(parsed[1].about, 'Virtual nodes');
    assert.equal(parsed[1].first, 'About: “Virtual nodes”');
    assert.equal(parsed[1].body, 'Virtual nodes balance uneven key distribution.');
    assert.equal(sample.slice(parsed[1].start, parsed[1].end), parsed[1].raw);

    // Edge cases: empty, plain text, malformed unclosed block, malformed URI in ask
    assert.deepEqual(parseAiBlocks(''), []);
    assert.deepEqual(parseAiBlocks('   \n'), []);
    assert.deepEqual(parseAiBlocks('Plain learner notes without markers.'), []);
    assert.deepEqual(parseAiBlocks('<!-- sh:ai id=broken at=h1 state=new -->\nunclosed'), []);

    const malformedAsk = [
      '<!-- sh:ai id=ai-bad at=h:h2 state=new ask=%E0%A4%A -->',
      'Plain heading line',
      'Body detail.',
      '<!-- /sh:ai -->',
    ].join('\n');
    const badParsed = parseAiBlocks(malformedAsk);
    assert.equal(badParsed.length, 1);
    assert.equal(badParsed[0].id, 'ai-bad');
    assert.equal(badParsed[0].mode, 'explain');
    assert.equal(badParsed[0].ask, '%E0%A4%A');
    assert.equal(badParsed[0].about, '');
    assert.equal(badParsed[0].body, 'Body detail.');

    // Pure ASCII formatter invariants moved from BookHistoryModal / BookAiBlocksModal ASCII checks
    assert.equal(normalizeAsciiChrome('ASCII test v2 -> check ✓ …', true), 'ASCII test v2 -> check OK ...');
    assert.equal(normalizeAsciiChrome('ASCII preview body -> ok ✓ …', true), 'ASCII preview body -> ok OK ...');
    assert.equal(normalizeAsciiChrome('About: “Ring balance -> check ✓ …”', true), 'About: “Ring balance -> check OK ...”');
    assert.equal(normalizeAsciiChrome('↑↓ ←→ › ▸ ▾ • ✕ ★ ◆ ● ○ ☑ ☐ ⚠', true), 'Up/Down Left/Right > > v - x * * * o [x] [ ] [!]');
    assert.equal(normalizeAsciiChrome('↑/↓ ←/→', true), 'Up/Down Left/Right');
    assert.equal(normalizeAsciiChrome('Keep ✓ … unchanged when asciiMode=false', false), 'Keep ✓ … unchanged when asciiMode=false');
    assert.equal(normalizeAsciiChrome('', true), '');

    // displayWidth sanity on ASCII and CJK
    assert.equal(displayWidth(''), 0);
    assert.equal(displayWidth('abc'), 3);
    assert.equal(displayWidth('复习全书'), 8);
    assert.equal(displayWidth('1.1 熔断器'), 10);
  });
});

// ============================================================================
// Suite 1: Unplaced Section Placement (Round 40: course.book.place)
// ============================================================================
describe('Domain Book 1: Unplaced Section Placement (course.book.place)', () => {
  const COURSE = 'PlaceCourse';

  function seedPlaceLibrary(root, course = COURSE) {
    return seedBookLibrary(root, {
      course,
      docs: [
        {
          id: 'doc1-p1',
          title: 'Lecture 1 · p. 1',
          createdAt: '2026-10-01T00:00:00.000Z',
          text: 'Alpha Architecture defines components and connectors.',
          page: 1,
          chapterTitle: 'Alpha Basics',
        },
        {
          id: 'doc1-p2',
          title: 'Lecture 1 · p. 2',
          createdAt: '2026-10-01T01:00:00.000Z',
          text: 'Beta Boundaries separate domain rules from infrastructure.',
          page: 2,
          chapterTitle: 'Beta Boundaries',
        },
      ],
      chapters: [
        {
          id: 'ch1',
          title: 'Core Architecture',
          leaves: [
            { id: 'alpha', title: 'Alpha Basics', anchorIndex: 0 },
            { id: 'beta', title: 'Beta Boundaries', anchorIndex: 1 },
          ],
        },
      ],
      fingerprintChar: 'a',
      citeQuote: 'Alpha',
    });
  }

  test('createTuiHost integration: save learner text -> delete leaf -> verify unplaced -> course.book.place moves & clears', async () => {
    const base = await temps.make('place-host');
    const env = sanitizedTestEnv({ DSH_HOME: join(base, 'dsh-home') });
    const libraryRoot = join(base, 'library');
    await seedPlaceLibrary(libraryRoot);

    const host = await createTuiHost({
      libraryRoot,
      env,
      home: base,
      documentsDir: base,
      skipAutoProbe: true,
      language: 'zh',
    });

    try {
      const noteText = 'Learner summary note preserved across deletion.';
      const { alpha } = await createUnplacedFromSecondLeaf(host, COURSE, noteText);

      const afterDelete = await host.call('course.book.open', { course: COURSE, language: 'zh' });
      assert.equal(afterDelete.ok, true, afterDelete.error?.message);
      assert.equal(afterDelete.value.status, 'ok');
      assert.equal(afterDelete.value.nodes[0].children.length, 1);
      assert.match(afterDelete.value.unplaced?.text ?? '', /Learner summary note preserved across deletion/);
      assert.equal(afterDelete.value.unplaced?.sections?.length, 1);

      const sec = afterDelete.value.unplaced.sections[0];
      assert.equal(sec.title, 'Beta Boundaries');
      assert.ok(sec.id, 'unplaced section must have id');

      const placed = await host.call('course.book.place', {
        course: COURSE,
        section: sec.id,
        toHid: alpha.hid,
        version: afterDelete.value.structureVersion,
      });
      assert.equal(placed.ok, true, placed.error?.message);
      assert.equal(typeof placed.value, 'object');
      assert.equal(placed.value.write, 'placed');
      assert.equal(placed.value.hid, alpha.hid);

      const afterPlace = await host.call('course.book.open', { course: COURSE, language: 'zh' });
      assert.equal(afterPlace.ok, true, afterPlace.error?.message);
      assert.equal(afterPlace.value.unplaced?.text?.trim(), '');
      assert.deepEqual(afterPlace.value.unplaced?.sections, []);
      const destNode = afterPlace.value.nodes[0].children.find((n) => n.hid === alpha.hid);
      assert.ok(destNode, 'Destination leaf must exist');
      assert.match(destNode.mine ?? '', /Learner summary note preserved across deletion/);
    } finally {
      await host.dispose();
    }
  });

  test('PTY E2E: BookView U empty toast -> U modal open (120x36 & 80x24) -> Esc cancel -> U + Enter places cleanly', async () => {
    const { host } = await createBookPtyHost('place-pty', { course: COURSE, seedFn: seedPlaceLibrary });
    const tty = createVirtualTty(120, 36);
    let inkInstance = null;
    try {
      const opened = await openBookViewInPty(host, tty, {
        course: COURSE,
        label: 'Place',
        readyPredicate: (s) => s.includes('Core Architecture') && s.includes('Alpha Basics'),
      });
      inkInstance = opened.inkInstance;
      assertHealthyBookScreen(tty, opened.bookScreen, 120, 36, 'BookView empty unplaced');
      assert.equal(useTuiStore.getState().page, 'book');
      assert.ok(opened.bookScreen.includes('Beta Boundaries'));

      // Press 'U' when unplaced is empty -> friendly toast
      tty.send('U');
      const emptyToast = await tty.waitFor((s) => s.includes('当前没有未归位段落'), { label: 'Empty unplaced toast' });
      assertHealthyBookScreen(tty, emptyToast, 120, 36, 'Empty unplaced toast');
      assert.ok(!emptyToast.includes('归位未归位段落'), 'Place modal must stay closed when unplaced is empty');

      // Create an unplaced section via host, then press 'r' to refresh BookView
      const placedBody = 'ZH placed section body text.';
      const { alpha } = await createUnplacedFromSecondLeaf(host, COURSE, placedBody);
      tty.send('r');
      const refreshed = await tty.waitFor(
        (s) => s.includes('未归位 1') && !s.includes('Beta Boundaries'),
        { label: 'BookView refreshed with Unplaced 1' },
      );
      assertHealthyBookScreen(tty, refreshed, 120, 36, 'BookView refreshed with Unplaced 1');
      assert.ok(refreshed.includes('未归位 1'));

      // Press 'U' -> BookStructureModal opens in 'place' mode
      tty.send('U');
      const modalWide = await tty.waitFor(
        (s) =>
          s.includes('归位未归位段落') &&
          s.includes('1. 选择未归位段落') &&
          s.includes('2. 选择目标知识点') &&
          s.includes('Beta Boundaries') &&
          s.includes('Alpha Basics'),
        { label: 'Place modal opened 120x36' },
      );
      assertHealthyBookScreen(tty, modalWide, 120, 36, 'Place modal 120x36');
      assert.ok(modalWide.includes('归位未归位段落'));

      // Check 80x24 responsiveness
      tty.resize(80, 24);
      const modalNarrow = await tty.waitFor(
        (s) => s.includes('归位未归位段落') && s.split('\n').length <= 24,
        { label: 'Place modal 80x24' },
      );
      assertHealthyBookScreen(tty, modalNarrow, 80, 24, 'Place modal 80x24');

      tty.resize(120, 36);
      await tty.waitFor((s) => s.includes('归位未归位段落'), { label: 'Place modal restored 120x36' });

      // Esc cancels cleanly
      tty.send('\x1b');
      const afterEsc = await tty.waitFor(
        (s) => !s.includes('归位未归位段落') && s.includes('未归位 1'),
        { label: 'Place modal canceled on Esc' },
      );
      assertHealthyBookScreen(tty, afterEsc, 120, 36, 'After Esc cancel');
      assert.ok(afterEsc.includes('未归位 1'));

      // Re-open with 'U' and press Enter to place cleanly
      tty.send('U');
      await tty.waitFor((s) => s.includes('归位未归位段落'), { label: 'Place modal reopened' });
      tty.send('\r');
      const afterPlace = await tty.waitFor(
        (s) => !s.includes('归位未归位段落') && !s.includes('未归位 1') && s.includes(placedBody),
        { label: 'Section placed into Alpha Basics' },
      );
      assertHealthyBookScreen(tty, afterPlace, 120, 36, 'After place');
      assert.ok(afterPlace.includes(placedBody));

      const verifyOpen = await host.call('course.book.open', { course: COURSE, language: 'zh' });
      assert.equal(verifyOpen.ok, true);
      assert.equal(verifyOpen.value.unplaced?.text?.trim(), '');
      assert.deepEqual(verifyOpen.value.unplaced?.sections, []);
      const destNode = verifyOpen.value.nodes[0].children.find((n) => n.hid === alpha.hid);
      assert.ok(destNode, 'Destination leaf must remain after PTY place');
      assert.match(destNode?.mine ?? '', /ZH placed section body text/);
    } finally {
      try {
        inkInstance?.unmount();
      } catch {
        // Ignore unmount errors during cleanup
      }
      try {
        tty?.dispose();
      } catch {
        // Ignore tty dispose errors during cleanup
      }
      await host.dispose();
    }
  });
});

// ============================================================================
// Suite 2: Feynman Retell (Round 41: book.retell + BookRetellModal + P2 ConfirmDialog)
// ============================================================================
describe('Domain Book 2: Feynman Retell (book.retell + BookRetellModal + P2 ConfirmDialog)', () => {
  const COURSE = 'RetellCourse';

  test('createTuiHost integration: book.retell persists aggregate in course.book.open & never stores raw text', async () => {
    const base = await temps.make('retell-host');
    const env = sanitizedTestEnv({ DSH_HOME: join(base, 'dsh-home') });
    const libraryRoot = join(base, 'library');
    await seedResilienceLibrary(libraryRoot, COURSE);

    const SECRET_RAW_TEXT = 'SECRET_FEYNMAN_WORDING_NEVER_PERSIST_99182';
    let modelCalls = 0;
    let capturedPrompt = '';

    const host = await createTuiHost({
      libraryRoot,
      env,
      home: base,
      documentsDir: base,
      skipAutoProbe: true,
      language: 'zh',
      injectedComplete: async (_system, prompt) => {
        modelCalls += 1;
        capturedPrompt = String(prompt ?? '');
        return JSON.stringify({
          passed: true,
          right: ['Accurately explained why the circuit breaker trips open to stop cascading failures.'],
          missed: [],
          wrong: [],
          cite: null,
        });
      },
    });

    try {
      const beforeOpen = await host.call('course.book.open', { course: COURSE, language: 'zh' });
      assert.equal(beforeOpen.ok, true, beforeOpen.error?.message);
      const leaf = beforeOpen.value.nodes[0].children[0];
      assert.equal(leaf.retold, undefined);

      const retellRes = await host.call('book.retell', {
        course: COURSE,
        hid: leaf.hid,
        text: SECRET_RAW_TEXT,
        language: 'zh',
      });
      assert.equal(retellRes.ok, true, retellRes.error?.message);
      assert.equal(modelCalls, 1);
      assert.ok(capturedPrompt.includes('Circuit Breaker'), 'point material should be sent to model');
      assert.ok(capturedPrompt.includes(SECRET_RAW_TEXT), 'learner explanation should be sent to model');
      assert.equal(retellRes.value.passed, true);
      assert.equal(retellRes.value.gap, 'none');
      assert.equal(retellRes.value.right?.length, 1);
      assert.deepEqual(retellRes.value.missed, []);
      assert.deepEqual(retellRes.value.wrong, []);
      assert.equal(retellRes.value.record?.tries, 1);
      assert.equal(retellRes.value.record?.passes, 1);
      assert.equal(retellRes.value.record?.gap, 'none');

      const afterOpen = await host.call('course.book.open', { course: COURSE, language: 'zh' });
      assert.equal(afterOpen.ok, true, afterOpen.error?.message);
      const updatedLeaf = afterOpen.value.nodes[0].children[0];
      assert.equal(updatedLeaf.retold?.tries, 1);
      assert.equal(updatedLeaf.retold?.passes, 1);
      assert.equal(updatedLeaf.retold?.gap, 'none');
      assert.equal(typeof updatedLeaf.retold, 'object');
      assert.equal(JSON.stringify(afterOpen.value).includes(SECRET_RAW_TEXT), false, 'raw retell text must never appear in book');

      const exported = await host.call('export');
      assert.equal(exported.ok, true, exported.error?.message);
      assert.equal(JSON.stringify(exported.value).includes(SECRET_RAW_TEXT), false, 'raw retell text must never persist in library export');
    } finally {
      await host.dispose();
    }
  });

  test('PTY E2E: T on chapter toast -> T on leaf -> ConfirmDialog quota guard (0 calls on n/Esc) -> confirm -> 3-part verdict + badge', async () => {
    let modelCalls = 0;
    const SECRET = 'ZH_SECRET_EXPLANATION_42';
    const { host } = await createBookPtyHost('retell-pty', {
      course: COURSE,
      seedFn: (root, c) => seedResilienceLibrary(root, c),
      injectedComplete: async () => {
        modelCalls += 1;
        return JSON.stringify({
          passed: true,
          right: ['讲清了熔断器在故障率过高时自动断开保护下游的核心机制'],
          missed: [],
          wrong: [],
          cite: null,
        });
      },
    });

    const tty = createVirtualTty(120, 36);
    let inkInstance = null;
    try {
      const opened = await openBookViewInPty(host, tty, {
        course: COURSE,
        label: 'Retell',
        readyPredicate: (s) => s.includes('Resilience Patterns') && s.includes('Circuit Breaker'),
      });
      inkInstance = opened.inkInstance;
      assertHealthyBookScreen(tty, opened.bookScreen, 120, 36, 'BookView initial');
      assert.equal(useTuiStore.getState().page, 'book');

      // Press 'T' on chapter header -> friendly toast, 0 model calls
      tty.send('T');
      const nonLeafToast = await tty.waitFor((s) => s.includes('章节标题不支持费曼复述'), { label: 'Non-leaf toast on T' });
      assertHealthyBookScreen(tty, nonLeafToast, 120, 36, 'Non-leaf toast');
      assert.ok(!nonLeafToast.includes('用自己的话讲一遍'), 'Modal must stay closed on chapter header');
      assert.equal(modelCalls, 0);

      // Move down to leaf '1.1 Circuit Breaker' and press 'T'
      tty.send('j');
      await tty.waitFor((s) => s.includes('Linked questions:') || s.includes('关联题目:'), { label: 'Leaf selected' });

      tty.send('T');
      const retellModal = await tty.waitFor(
        (s) => s.includes('用自己的话讲一遍') && s.includes('1.1 Circuit Breaker') && s.includes('0/4000'),
        { label: 'BookRetellModal opened' },
      );
      assertHealthyBookScreen(tty, retellModal, 120, 36, 'BookRetellModal 120x36');
      assert.ok(retellModal.includes('1.1 Circuit Breaker'));
      assert.equal(modelCalls, 0);

      // Check 80x24 responsiveness
      tty.resize(80, 24);
      const modalNarrow = await tty.waitFor(
        (s) => s.includes('用自己的话讲一遍') && s.split('\n').length <= 24,
        { label: 'BookRetellModal 80x24' },
      );
      assertHealthyBookScreen(tty, modalNarrow, 80, 24, 'BookRetellModal 80x24');
      tty.resize(120, 36);
      await tty.waitFor((s) => s.includes('1.1 Circuit Breaker'), { label: 'BookRetellModal restored 120x36' });

      // Type explanation and submit -> ConfirmDialog quota guard opens
      tty.send(SECRET);
      await tty.waitFor((s) => s.includes(`${SECRET.length}/4000`), { label: 'Draft typed' });

      tty.send('\r');
      const confirmScreen = await tty.waitFor(
        (s) => s.includes('确认提交费曼复述评估') && s.includes('1 次 AI 模型调用') && s.includes('不会保存你的原话'),
        { label: 'ConfirmDialog quota guard opened' },
      );
      assertHealthyBookScreen(tty, confirmScreen, 120, 36, 'ConfirmDialog quota guard');
      assert.ok(confirmScreen.includes('不会保存你的原话'));
      assert.equal(modelCalls, 0, 'ConfirmDialog must not call model before confirmation');

      // Cancel ConfirmDialog with 'n' -> 0 model calls, draft preserved
      tty.send('n');
      const afterCancelN = await tty.waitFor(
        (s) => !s.includes('确认提交费曼复述评估') && s.includes(`${SECRET.length}/4000`),
        { label: 'ConfirmDialog canceled with n' },
      );
      assert.ok(afterCancelN.includes(`${SECRET.length}/4000`), 'Draft length must be preserved after n cancel');
      assert.equal(modelCalls, 0, 'Canceling ConfirmDialog with n must result in 0 AI model calls');

      // Re-open ConfirmDialog and cancel with Esc -> 0 model calls, draft preserved
      tty.send('\r');
      await tty.waitFor((s) => s.includes('确认提交费曼复述评估'), { label: 'ConfirmDialog reopened for Esc check' });
      tty.send('\x1b');
      const afterCancelEsc = await tty.waitFor(
        (s) => !s.includes('确认提交费曼复述评估') && s.includes(`${SECRET.length}/4000`),
        { label: 'ConfirmDialog canceled with Esc' },
      );
      assert.ok(afterCancelEsc.includes(`${SECRET.length}/4000`), 'Draft length must be preserved after Esc cancel');
      assert.equal(modelCalls, 0, 'Esc cancel on ConfirmDialog must make 0 AI model calls');

      // Submit via Ctrl+S (\x13) and confirm with 'y'
      tty.send('\x13');
      await tty.waitFor((s) => s.includes('确认提交费曼复述评估'), { label: 'ConfirmDialog reopened via Ctrl+S' });
      tty.send('y');

      const verdictScreen = await tty.waitFor(
        (s) =>
          !s.includes('确认提交费曼复述评估') &&
          s.includes('讲清楚过') &&
          s.includes('1. 讲对了') &&
          s.includes('2. 遗漏与需纠正') &&
          s.includes('3. 下一步提示') &&
          s.includes('讲清了熔断器在故障率过高时自动断开保护下游的核心机制'),
        { label: '3-part Feynman verdict rendered' },
      );
      assertHealthyBookScreen(tty, verdictScreen, 120, 36, 'Verdict rendered');
      assert.ok(verdictScreen.includes('1. 讲对了'));
      assert.equal(modelCalls, 1, 'Confirming ConfirmDialog must trigger exactly 1 AI model call');

      // Close modal -> BookView refreshed with 讲清楚过 badge immediately visible
      tty.send('\x1b');
      const afterClose = await tty.waitFor(
        (s) => !s.includes('用自己的话讲一遍') && s.includes('✓ 讲清楚过'),
        { label: 'BookView updated with 讲清楚过 badge' },
      );
      assertHealthyBookScreen(tty, afterClose, 120, 36, 'BookView badge updated');
      assert.ok(afterClose.includes('✓ 讲清楚过'));

      // Verify raw text never persisted in library export
      const exported = await host.call('export');
      assert.equal(exported.ok, true);
      assert.equal(JSON.stringify(exported.value).includes(SECRET), false, 'raw draft must never persist');
    } finally {
      try {
        inkInstance?.unmount();
      } catch {
        // Ignore unmount errors during cleanup
      }
      try {
        tty?.dispose();
      } catch {
        // Ignore tty dispose errors during cleanup
      }
      await host.dispose();
    }
  });
});

// ============================================================================
// Suite 3: Mock Paper Planner & Section Q&A (Round 42: book.mock + course.outline.qa)
// ============================================================================
describe('Domain Book 3: Mock Paper Planner & Section Q&A (book.mock.plan + book.mock + course.outline.qa)', () => {
  const COURSE = 'MockCourse';

  function seedMockLibrary(root, course = COURSE) {
    return seedResilienceLibrary(root, course, {
      citeQuote: 'isolate',
      decks: buildMockDecks(course),
    });
  }

  test('createTuiHost integration: course.book.open -> book.mock.plan -> book.mock -> course.outline.qa', async () => {
    const base = await temps.make('mock-host');
    const env = sanitizedTestEnv({ DSH_HOME: join(base, 'dsh-home') });
    const libraryRoot = join(base, 'library');
    await seedMockLibrary(libraryRoot);

    const host = await createTuiHost({
      libraryRoot,
      env,
      home: base,
      documentsDir: base,
      skipAutoProbe: true,
      language: 'zh',
    });

    try {
      const opened = await host.call('course.book.open', { course: COURSE, language: 'zh' });
      assert.equal(opened.ok, true, opened.error?.message);
      const breaker = opened.value.nodes[0].children[0];
      const bulkhead = opened.value.nodes[0].children[1];
      assert.equal(breaker.title, 'Circuit Breaker');
      assert.equal(bulkhead.title, 'Bulkhead Isolation');

      // 0-token plan for Circuit Breaker (2 choice + 1 flashcard skipped)
      const planRes = await host.call('book.mock.plan', {
        course: COURSE,
        pointIds: [breaker.hid],
      });
      assert.equal(planRes.ok, true, planRes.error?.message);
      assert.equal(planRes.value.status, 'ok');
      assert.equal(planRes.value.questions, 3);
      assert.equal(planRes.value.eligible, 2);
      assert.equal(planRes.value.count, 2);
      assert.deepEqual(planRes.value.points, [breaker.hid]);
      assert.equal(planRes.value.leftOut?.flashcard, 1);

      // 0-token plan for Bulkhead Isolation (0 choice questions)
      const emptyPlan = await host.call('book.mock.plan', {
        course: COURSE,
        pointIds: [bulkhead.hid],
      });
      assert.equal(emptyPlan.ok, true, emptyPlan.error?.message);
      assert.equal(emptyPlan.value.status, 'ok');
      assert.equal(emptyPlan.value.questions, 1);
      assert.equal(emptyPlan.value.eligible, 0);
      assert.equal(emptyPlan.value.count, 0);
      assert.equal(emptyPlan.value.leftOut?.flashcard, 1);

      // Start mock exam via book.mock
      const mockRes = await host.call('book.mock', {
        course: COURSE,
        pointIds: planRes.value.points,
        count: planRes.value.count,
      });
      assert.equal(mockRes.ok, true, mockRes.error?.message);
      assert.ok(mockRes.value?.id, 'book.mock must return exam run id');
      assert.equal(mockRes.value?.mode, 'exam');
      assert.equal(mockRes.value?.total, 2);
      assert.equal(typeof mockRes.value?.id, 'string');

      const snapRes = await host.call('snapshot');
      assert.equal(snapRes.ok, true);
      const openExam = (snapRes.value?.runs ?? []).find((r) => r.id === mockRes.value.id);
      assert.ok(openExam, 'snapshot.runs must include newly started book.mock exam run');
      assert.equal(openExam.mode, 'exam');
      assert.equal(openExam.total, 2);

      // Inspect section Q&A via course.outline.qa
      const qaRes = await host.call('course.outline.qa', {
        course: COURSE,
        keys: [breaker.key],
      });
      assert.equal(qaRes.ok, true, qaRes.error?.message);
      assert.equal(qaRes.value.status, 'ok');
      assert.equal(qaRes.value.items.length, 1);
      assert.equal(qaRes.value.items[0].kind, 'card');
      assert.equal(typeof qaRes.value.items[0].answer, 'string');
      assert.ok(qaRes.value.items[0].question.includes('half-open'));
      assert.ok(qaRes.value.items[0].answer.includes('probe traffic'));
    } finally {
      await host.dispose();
    }
  });

  test('PTY E2E: 0-choice toast -> [M] plan ConfirmDialog -> n/Esc cancel -> BookQaModal P -> confirm -> ExamView', async () => {
    const { host } = await createBookPtyHost('mock-pty', { course: COURSE, seedFn: seedMockLibrary });
    const tty = createVirtualTty(120, 36);
    let inkInstance = null;
    try {
      const opened = await openBookViewInPty(host, tty, {
        course: COURSE,
        label: 'Mock',
        readyPredicate: (s) => s.includes('Resilience Patterns') && s.includes('Circuit Breaker'),
      });
      inkInstance = opened.inkInstance;
      assertHealthyBookScreen(tty, opened.bookScreen, 120, 36, 'BookView initial');
      assert.equal(useTuiStore.getState().page, 'book');

      // Navigate to 1.1 Circuit Breaker, then 1.2 Bulkhead Isolation (0 choice questions) -> 'M' shows info toast
      tty.send('j');
      await tty.waitFor((s) => s.includes('关联题目: 3') || s.includes('Linked questions: 3'), {
        label: 'Circuit Breaker selected first',
      });
      tty.send('j');
      await tty.waitFor(
        (s) => s.includes('Bulkhead Isolation') && (s.includes('关联题目: 1') || s.includes('Linked questions: 1')),
        { label: 'Bulkhead leaf selected' },
      );
      tty.send('M');
      const noChoiceToast = await tty.waitFor(
        (s) => s.includes('模拟卷仅考选择题'),
        { label: 'No choice questions info toast' },
      );
      assertHealthyBookScreen(tty, noChoiceToast, 120, 36, 'No choice toast');
      assert.ok(!noChoiceToast.includes('章节模拟卷确认'), 'ConfirmDialog must not open for 0 choice questions');

      // Move back up to 1.1 Circuit Breaker -> press 'M'
      tty.send('k');
      await tty.waitFor((s) => s.includes('关联题目: 3') || s.includes('Linked questions: 3'), {
        label: 'Circuit Breaker re-selected',
      });

      tty.send('M');
      const confirmModal = await tty.waitFor(
        (s) => {
          const flat = s.replace(/\s+/g, ' ');
          return (
            flat.includes('章节模拟卷确认') &&
            flat.includes('规划 2') &&
            flat.includes('道选择题') &&
            flat.includes('30 分钟') &&
            flat.includes('已跳过 1') &&
            flat.includes('道非选择题')
          );
        },
        { label: 'Mock ConfirmDialog opened' },
      );
      assertHealthyBookScreen(tty, confirmModal, 120, 36, 'Mock ConfirmDialog 120x36');
      assert.ok(confirmModal.includes('章节模拟卷确认'));

      // 80x24 responsiveness check
      tty.resize(80, 24);
      const confirmNarrow = await tty.waitFor(
        (s) => s.includes('章节模拟卷确认') && s.split('\n').length <= 24,
        { label: 'Mock ConfirmDialog 80x24' },
      );
      assertHealthyBookScreen(tty, confirmNarrow, 80, 24, 'Mock ConfirmDialog 80x24');
      tty.resize(120, 36);
      await tty.waitFor((s) => s.includes('章节模拟卷确认'), { label: 'Mock ConfirmDialog restored 120x36' });

      // Cancel cleanly on 'n' -> stays on BookView
      tty.send('n');
      const afterCancelN = await tty.waitFor(
        (s) => !s.includes('章节模拟卷确认') && useTuiStore.getState().page === 'book',
        { label: 'Mock ConfirmDialog canceled with n' },
      );
      assertHealthyBookScreen(tty, afterCancelN, 120, 36, 'BookView after n cancel');
      assert.equal(useTuiStore.getState().page, 'book');

      // Re-open [M] and cancel cleanly on Esc
      tty.send('M');
      await tty.waitFor((s) => s.includes('章节模拟卷确认'), { label: 'Mock ConfirmDialog reopened for Esc' });
      tty.send('\x1b');
      const afterEsc = await tty.waitFor(
        (s) => !s.includes('章节模拟卷确认') && useTuiStore.getState().page === 'book',
        { label: 'Mock ConfirmDialog canceled with Esc' },
      );
      assertHealthyBookScreen(tty, afterEsc, 120, 36, 'BookView after Esc cancel');
      assert.equal(useTuiStore.getState().page, 'book');

      // Open BookQaModal ('P') and verify section Q&A from course.outline.qa is visible
      tty.send('P');
      const qaScreen = await tty.waitFor(
        (s) => s.includes('本节问答 1') && s.includes('Why does half-open state probe'),
        { label: 'BookQaModal section Q&A rendered' },
      );
      assertHealthyBookScreen(tty, qaScreen, 120, 36, 'BookQaModal section Q&A');
      assert.ok(qaScreen.includes('Why does half-open state probe'));
      tty.send('\x1b');
      await tty.waitFor((s) => !s.includes('本节问答 1'), { label: 'BookQaModal closed' });

      // Re-open [M] and confirm with 'y' -> creates exam run, refreshes snapshot, navigates to ExamView
      tty.send('M');
      await tty.waitFor((s) => s.includes('章节模拟卷确认'), { label: 'Mock ConfirmDialog reopened for confirm' });
      tty.send('y');
      const examScreen = await tty.waitFor(
        (s) => useTuiStore.getState().page === 'exam' && s.includes('继续未交卷考试'),
        { label: 'Navigated to ExamView with active mock run' },
      );
      assertHealthyBookScreen(tty, examScreen, 120, 36, 'ExamView after book.mock');
      assert.equal(useTuiStore.getState().page, 'exam');
      assert.ok(useTuiStore.getState().snapshot?.runs?.some((r) => r.mode === 'exam'));
    } finally {
      try {
        inkInstance?.unmount();
      } catch {
        // Ignore unmount errors during cleanup
      }
      try {
        tty?.dispose();
      } catch {
        // Ignore tty dispose errors during cleanup
      }
      await host.dispose();
    }
  });
});

// ============================================================================
// Suite 4: AI Section Explain / Add Paragraph (Round 57: BookExplainModal)
// ============================================================================
describe('Domain Book 4: AI Section Explain / Add Paragraph (generation.courseBook.explain + BookExplainModal)', () => {
  const COURSE = 'ExplainCourse';

  test('createTuiHost integration (0 model calls): validates missing book/point/request with normalized error codes', async () => {
    const base = await temps.make('explain-host');
    const env = sanitizedTestEnv({ DSH_HOME: join(base, 'dsh-home') });
    const libraryRoot = join(base, 'library');
    await seedResilienceLibrary(libraryRoot, COURSE);

    let modelCalls = 0;
    const host = await createTuiHost({
      libraryRoot,
      env,
      home: base,
      documentsDir: base,
      skipAutoProbe: true,
      language: 'zh',
      injectedComplete: async () => {
        modelCalls += 1;
        return '{}';
      },
    });

    try {
      const noBookRes = await host.call('generation.courseBook.explain', {
        course: 'MissingCourse',
        heading: 'h1',
        mode: 'here',
        instruction: '补充直觉例子',
        language: 'zh',
      });
      assert.equal(noBookRes.ok, false);
      assert.equal(noBookRes.error?.code, 'course-book-ai-no-book');
      assert.ok(noBookRes.error?.message, 'missing book must return normalized error message');
      assert.equal(noBookRes.value, undefined);
      assert.equal(modelCalls, 0);

      const noPointRes = await host.call('generation.courseBook.explain', {
        course: COURSE,
        heading: 'nonexistent-hid',
        mode: 'here',
        instruction: 'Add intuition example',
        language: 'en',
      });
      assert.equal(noPointRes.ok, false);
      assert.equal(noPointRes.error?.code, 'course-book-ai-no-point');
      assert.ok(noPointRes.error?.message, 'missing point must return normalized error message');
      assert.equal(noPointRes.value, undefined);
      assert.equal(modelCalls, 0);

      const openRes = await host.call('course.book.open', { course: COURSE, language: 'zh' });
      assert.equal(openRes.ok, true, openRes.error?.message);
      const leafHid = openRes.value.nodes[0].children[0].hid;
      assert.ok(leafHid, 'opened book leaf must have hid');

      const noRequestRes = await host.call('generation.courseBook.explain', {
        course: COURSE,
        heading: leafHid,
        mode: 'here',
        instruction: '   ',
        language: 'zh',
      });
      assert.equal(noRequestRes.ok, false);
      assert.equal(noRequestRes.error?.code, 'course-book-ai-no-request');
      assert.ok(noRequestRes.error?.message, 'blank request must return normalized error message');
      assert.equal(noRequestRes.value, undefined);
      assert.equal(modelCalls, 0);
    } finally {
      await host.dispose();
    }
  });

  test('PTY E2E: E guard -> BookExplainModal -> ConfirmDialog (n cancels, 0 calls) -> mode switch (2/explain & Tab) -> Esc close', async () => {
    let modelCalls = 0;
    const { host } = await createBookPtyHost('explain-pty', {
      course: COURSE,
      seedFn: (root, c) => seedResilienceLibrary(root, c),
      injectedComplete: async () => {
        modelCalls += 1;
        return '{}';
      },
    });

    const tty = createVirtualTty(120, 36);
    let inkInstance = null;
    try {
      const opened = await openBookViewInPty(host, tty, {
        course: COURSE,
        label: 'Explain',
        readyPredicate: (s) => s.includes('Resilience Patterns') && s.includes('Circuit Breaker'),
      });
      inkInstance = opened.inkInstance;
      assertHealthyBookScreen(tty, opened.bookScreen, 120, 36, 'BookView initial');
      assert.equal(useTuiStore.getState().page, 'book');

      // Pressing 'E' on chapter header notifies info & does not open modal
      tty.send('E');
      const nonLeafToast = await tty.waitFor(
        (s) => s.includes('请先在目录中选择一个具体知识点（叶子节点）'),
        { label: 'Non-leaf info toast on E' },
      );
      assertHealthyBookScreen(tty, nonLeafToast, 120, 36, 'Non-leaf toast');
      assert.ok(!nonLeafToast.includes('AI 补充复习全书讲解'));
      assert.equal(modelCalls, 0);

      // Select leaf node -> footer shows AI讲解 -> press 'E'
      tty.send('j');
      await tty.waitFor((s) => s.includes('AI讲解'), { label: 'Leaf selected with AI讲解 hint' });

      tty.send('E');
      const modalScreen = await tty.waitFor(
        (s) =>
          s.includes('AI 补充复习全书讲解') &&
          s.includes('1.1 Circuit Breaker') &&
          s.includes('1: 补充段落 (here)') &&
          s.includes('2: 深入讲解 (explain)') &&
          s.includes('0/600'),
        { label: 'BookExplainModal opened' },
      );
      assertHealthyBookScreen(tty, modalScreen, 120, 36, 'BookExplainModal 120x36');
      assert.ok(modalScreen.includes('1.1 Circuit Breaker'));
      assert.equal(modelCalls, 0);

      // Enter instruction & submit -> P2 ConfirmDialog opens (0 model calls)
      tty.send('Add intuitive example');
      await tty.waitFor((s) => s.includes('21/600'), { label: 'Instruction typed' });
      tty.send('\r');
      const confirmScreen = await tty.waitFor(
        (s) => s.includes('开始生成') && s.includes('Add intuitive example') && s.includes('1: 补充段落 (here)'),
        { label: 'ConfirmDialog opened' },
      );
      assertHealthyBookScreen(tty, confirmScreen, 120, 36, 'ConfirmDialog 120x36');
      assert.ok(confirmScreen.includes('开始生成'));
      assert.equal(modelCalls, 0);

      // Press 'n' -> cancels back to form (0 model calls)
      tty.send('n');
      const afterCancel = await tty.waitFor(
        (s) => !s.includes('开始生成') && s.includes('21/600'),
        { label: 'ConfirmDialog canceled with n' },
      );
      assert.ok(afterCancel.includes('21/600'));
      assert.equal(modelCalls, 0);

      // Switch mode to 'explain' via UpArrow + '2' -> pre-filled with leaf title
      tty.send('\x1b[A');
      await tty.flush();
      tty.send('2');
      const explainMode = await tty.waitFor(
        (s) => s.includes('深入讲解词句 (words)') && s.includes('Circuit Breaker') && s.includes('15/600'),
        { label: 'Mode switched to 2/explain' },
      );
      assertHealthyBookScreen(tty, explainMode, 120, 36, 'Mode explain 120x36');
      assert.ok(explainMode.includes('15/600'));
      assert.equal(modelCalls, 0);

      // Switch mode via Tab back to 'here' and then Tab back to 'explain'
      tty.send('\t');
      const tabHere = await tty.waitFor(
        (s) => s.includes('21/600') && s.includes('Add intuitive example'),
        { label: 'Mode switched back to here via Tab' },
      );
      assertHealthyBookScreen(tty, tabHere, 120, 36, 'Mode here via Tab');
      assert.ok(tabHere.includes('Add intuitive example'));
      tty.send('\t');
      const tabExplain = await tty.waitFor(
        (s) => s.includes('深入讲解词句 (words)') && s.includes('15/600'),
        { label: 'Mode switched to explain via Tab' },
      );
      assert.ok(tabExplain.includes('15/600'));
      assert.equal(modelCalls, 0);

      // Esc closes modal cleanly
      tty.send('\x1b');
      const closed = await tty.waitFor(
        (s) => !s.includes('AI 补充复习全书讲解') && s.includes('Resilience Patterns'),
        { label: 'BookExplainModal closed on Esc' },
      );
      assertHealthyBookScreen(tty, closed, 120, 36, 'BookView after Esc');
      assert.equal(useTuiStore.getState().page, 'book');
      assert.equal(modelCalls, 0);
    } finally {
      try {
        inkInstance?.unmount();
      } catch {
        // Ignore unmount errors during cleanup
      }
      try {
        tty?.dispose();
      } catch {
        // Ignore tty dispose errors during cleanup
      }
      await host.dispose();
    }
  });
});

// ============================================================================
// Suite 5: Revision History & Revert (Round 61: BookHistoryModal)
// ============================================================================
describe('Domain Book 5: Revision History & Revert (course.book.revision & course.book.revert + BookHistoryModal)', () => {
  const COURSE = 'HistoryCourse';

  test('createTuiHost integration (0 model calls): save twice -> revision history -> revert restores prior text', async () => {
    const base = await temps.make('history-host');
    const env = sanitizedTestEnv({ DSH_HOME: join(base, 'dsh-home') });
    const libraryRoot = join(base, 'library');
    await seedResilienceLibrary(libraryRoot, COURSE);

    let modelCalls = 0;
    const host = await createTuiHost({
      libraryRoot,
      env,
      home: base,
      documentsDir: base,
      skipAutoProbe: true,
      language: 'zh',
      injectedComplete: async () => {
        modelCalls += 1;
        return '{}';
      },
    });

    try {
      const firstEdit = '第一版手写讲义 R61_REV_ALPHA';
      const secondEdit = '第二版手写讲义 R61_REV_BETA';
      const { file, v1, v2, initialText } = await seedTwoEdits(host, COURSE, firstEdit, secondEdit);

      const revRes = await host.call('course.book.revision', {
        course: COURSE,
        history: true,
        file,
      });
      assert.equal(revRes.ok, true, revRes.error?.message);
      assert.equal(revRes.value.course, COURSE);
      assert.equal(typeof revRes.value.revision, 'number');
      assert.ok((revRes.value.files?.[file] ?? 0) >= 2, 'revision.files must count saved versions');
      assert.equal(revRes.value.versions.length, 2, 'versions must contain 2 replaced snapshots');

      // Newest first: v2 (firstEdit), then v1 (initialText)
      const [latestHist, oldestHist] = revRes.value.versions;
      assert.equal(latestHist.version, v2);
      assert.equal(latestHist.text, firstEdit);
      assert.equal(latestHist.by, 'learner');
      assert.equal(latestHist.redo, false);
      assert.equal(typeof latestHist.at, 'string');
      assert.equal(oldestHist.version, v1);
      assert.equal(oldestHist.text, initialText);
      assert.equal(oldestHist.by, 'program');
      assert.equal(oldestHist.redo, false);
      assert.equal(typeof oldestHist.at, 'string');

      // Revert to v2 (firstEdit)
      const revertRes = await host.call('course.book.revert', {
        course: COURSE,
        file,
        at: latestHist.at,
        entryVersion: latestHist.version,
        redo: Boolean(latestHist.redo),
      });
      assert.equal(revertRes.ok, true, revertRes.error?.message);
      assert.equal(revertRes.value.status, 'ok');
      assert.ok(revertRes.value.files?.[file]?.version >= v2);
      const restoredLeaf = revertRes.value.nodes[0].children[0];
      assert.equal(restoredLeaf.gen, firstEdit);
      assert.equal(modelCalls, 0);
    } finally {
      await host.dispose();
    }
  });

  test('PTY E2E: BookView (7) -> H -> BookHistoryModal -> j/k select -> Esc close -> H -> Enter -> ConfirmDialog y -> reverted text & toast', async () => {
    let modelCalls = 0;
    const { host } = await createBookPtyHost('history-pty', {
      course: COURSE,
      seedFn: (root, c) => seedResilienceLibrary(root, c),
      injectedComplete: async () => {
        modelCalls += 1;
        return '{}';
      },
    });

    const firstEdit = '第一版历史正文 R61_ALPHA';
    const secondEdit = '最新当前正文 R61_BETA';
    const { file, v1, v2 } = await seedTwoEdits(host, COURSE, firstEdit, secondEdit);

    const tty = createVirtualTty(120, 36);
    let inkInstance = null;
    try {
      const opened = await openBookViewInPty(host, tty, {
        course: COURSE,
        label: 'History',
        readyPredicate: (s) => s.includes('Resilience Patterns') && s.includes('Circuit Breaker'),
      });
      inkInstance = opened.inkInstance;
      assertHealthyBookScreen(tty, opened.bookScreen, 120, 36, 'BookView initial');

      // Select leaf 1.1 Circuit Breaker
      tty.send('j');
      const leafScreen = await tty.waitFor((s) => s.includes(secondEdit), { label: 'Leaf content visible' });
      assertHealthyBookScreen(tty, leafScreen, 120, 36, 'BookView leaf');
      assert.ok(leafScreen.includes(secondEdit));

      // Press H to open BookHistoryModal
      tty.send('H');
      const modalScreen = await tty.waitFor(
        (s) => s.includes('版本历史与回退') && s.includes(file) && s.includes(`v${v2}`) && s.includes(firstEdit),
        { label: 'BookHistoryModal opened' },
      );
      assertHealthyBookScreen(tty, modalScreen, 120, 36, 'BookHistoryModal');
      assert.ok(modalScreen.includes(file));

      // Exercise j/k selection: j -> v1 (initial text), k -> back to v2 (firstEdit)
      tty.send('j');
      const olderScreen = await tty.waitFor(
        (s) => s.includes(`v${v1}`) && s.includes('Detailed notes for Circuit Breaker'),
        { label: 'Selected older entry with j' },
      );
      assert.ok(olderScreen.includes('Detailed notes for Circuit Breaker'));
      tty.send('k');
      await tty.waitFor((s) => s.includes(firstEdit), { label: 'Returned to v2 with k' });

      // Esc closes BookHistoryModal cleanly without reverting
      tty.send('\x1b');
      const closedOnEsc = await tty.waitFor(
        (s) => !s.includes('版本历史与回退') && s.includes(secondEdit),
        { label: 'BookHistoryModal closed on Esc' },
      );
      assertHealthyBookScreen(tty, closedOnEsc, 120, 36, 'BookView after Esc close');
      assert.ok(closedOnEsc.includes(secondEdit));
      assert.equal(modelCalls, 0);

      // Re-open H -> Enter -> ConfirmDialog -> confirm with y
      tty.send('H');
      await tty.waitFor((s) => s.includes('版本历史与回退') && s.includes(`v${v2}`), {
        label: 'BookHistoryModal reopened',
      });
      tty.send('\r');
      const confirmScreen = await tty.waitFor(
        (s) => s.includes('确认恢复到此历史版本？') && s.includes(`v${v2}`),
        { label: 'ConfirmDialog opened' },
      );
      assertHealthyBookScreen(tty, confirmScreen, 120, 36, 'ConfirmDialog');
      assert.ok(confirmScreen.includes(`v${v2}`));

      tty.send('y');
      const revertedScreen = await tty.waitFor(
        (s) => !s.includes('版本历史与回退') && s.includes('已恢复') && s.includes(firstEdit),
        { label: 'Reverted text & toast visible' },
      );
      assertHealthyBookScreen(tty, revertedScreen, 120, 36, 'BookView after revert');
      assert.ok(revertedScreen.includes(firstEdit));
      assert.equal(modelCalls, 0);

      const afterRevertOpen = await host.call('course.book.open', { course: COURSE, language: 'zh' });
      assert.equal(afterRevertOpen.ok, true);
      assert.equal(afterRevertOpen.value.nodes[0].children[0].gen, firstEdit);
    } finally {
      try {
        inkInstance?.unmount();
      } catch {
        // Ignore unmount errors during cleanup
      }
      try {
        tty?.dispose();
      } catch {
        // Ignore tty dispose errors during cleanup
      }
      await host.dispose();
    }
  });
});

// ============================================================================
// Suite 6: AI Blocks Review (Round 63: BookAiBlocksModal + course.book.block)
// ============================================================================
describe('Domain Book 6: AI Blocks Review (course.book.block + BookAiBlocksModal)', () => {
  const COURSE = 'AiBlockCourse';

  function seedAiBlockLibrary(root, course = COURSE) {
    return seedBookLibrary(root, {
      course,
      docs: [
        {
          id: 'doc1-p1',
          title: 'Lecture 1 · p. 1',
          createdAt: '2026-10-01T00:00:00.000Z',
          text: 'Consistent hashing distributes keys across a ring to minimize re-sharding.',
          page: 1,
          chapterTitle: 'Consistent Hashing',
        },
        {
          id: 'doc1-p2',
          title: 'Lecture 1 · p. 2',
          createdAt: '2026-10-01T01:00:00.000Z',
          text: 'Virtual nodes smooth load imbalance across heterogeneous servers.',
          page: 2,
          chapterTitle: 'Virtual Nodes',
        },
      ],
      chapters: [
        {
          id: 'ch1',
          title: 'Distributed Hashing',
          leaves: [
            { id: 'hashing', title: 'Consistent Hashing', anchorIndex: 0 },
            { id: 'vnodes', title: 'Virtual Nodes', anchorIndex: 1 },
          ],
        },
      ],
      fingerprintChar: 'c',
      citeQuote: 'Consistent',
    });
  }

  test('createTuiHost integration (0 model calls): save 2 state=new AI blocks -> keep block 1 -> delete block 2', async () => {
    const base = await temps.make('aiblock-host');
    const env = sanitizedTestEnv({ DSH_HOME: join(base, 'dsh-home') });
    const libraryRoot = join(base, 'library');
    await seedAiBlockLibrary(libraryRoot);

    let modelCalls = 0;
    const host = await createTuiHost({
      libraryRoot,
      env,
      home: base,
      documentsDir: base,
      skipAutoProbe: true,
      language: 'zh',
      injectedComplete: async () => {
        modelCalls += 1;
        return '{}';
      },
    });

    try {
      const twoBlocksText = [
        '我的原始笔记保留段。',
        '',
        '<!-- sh:ai id=blk-keep at=11223344 state=new mode=explain ask=%E8%A7%A3%E9%87%8A%E4%B8%80%E8%87%B4%E6%80%A7%E5%93%88%E5%B8%8C -->',
        '关于：「一致性哈希环」',
        '',
        '第一段 AI 讲解正文：降低再平衡成本。',
        '<!-- /sh:ai -->',
        '',
        '<!-- sh:ai id=blk-del at=55667788 state=new mode=here -->',
        '关于：「故障转移示例」',
        '',
        '第二段 AI 补充正文：节点下线时顺时针迁移。',
        '<!-- /sh:ai -->',
      ].join('\n');

      const initialBlocks = parseAiBlocks(twoBlocksText);
      assert.equal(initialBlocks.length, 2);
      assert.equal(initialBlocks[0].ask, '解释一致性哈希');

      const { file } = await seedAiBlocksInMineFile(host, COURSE, twoBlocksText);

      // Keep block 1
      const keepRes = await host.call('course.book.block', {
        course: COURSE,
        file,
        id: 'blk-keep',
        action: 'keep',
      });
      assert.equal(keepRes.ok, true, keepRes.error?.message);
      assert.equal(keepRes.value.write, 'kept');
      assert.equal(keepRes.value.status, 'ok');
      const afterKeepMine = keepRes.value.nodes[0].children[0].mine;
      const afterKeepBlocks = parseAiBlocks(afterKeepMine);
      assert.equal(afterKeepBlocks.length, 2);
      assert.equal(afterKeepBlocks[0].id, 'blk-keep');
      assert.equal(afterKeepBlocks[0].state, 'kept');
      assert.equal(afterKeepBlocks[0].ask, '解释一致性哈希');
      assert.equal(afterKeepBlocks[0].about, '一致性哈希环');
      assert.equal(afterKeepBlocks[1].id, 'blk-del');
      assert.equal(afterKeepBlocks[1].state, 'new');

      // Delete block 2
      const delRes = await host.call('course.book.block', {
        course: COURSE,
        file,
        id: 'blk-del',
        action: 'delete',
      });
      assert.equal(delRes.ok, true, delRes.error?.message);
      assert.equal(delRes.value.write, 'deleted');
      assert.equal(delRes.value.status, 'ok');
      const afterDelMine = delRes.value.nodes[0].children[0].mine;
      const afterDelBlocks = parseAiBlocks(afterDelMine);
      assert.equal(afterDelBlocks.length, 1);
      assert.equal(afterDelBlocks[0].id, 'blk-keep');
      assert.equal(afterDelBlocks[0].state, 'kept');
      assert.equal(afterDelBlocks[0].body, '第一段 AI 讲解正文：降低再平衡成本。');
      assert.equal(afterDelMine.includes('blk-del'), false);
      assert.equal(afterDelMine.includes('我的原始笔记保留段。'), true);
      assert.equal(modelCalls, 0);
    } finally {
      await host.dispose();
    }
  });

  test('PTY E2E: BookView (7) -> B -> keep block 1 via a -> j -> d -> ConfirmDialog y deletes block 2 -> Esc close (0 model calls)', async () => {
    let modelCalls = 0;
    const { host } = await createBookPtyHost('aiblock-pty', {
      course: COURSE,
      seedFn: (root, c) => seedAiBlockLibrary(root, c),
      injectedComplete: async () => {
        modelCalls += 1;
        return '{}';
      },
    });

    const twoBlocksText = [
      '<!-- sh:ai id=blk-alpha at=11111111 state=new mode=explain -->',
      '关于：「哈希环局部性」',
      '',
      'R63_KEEP_BODY_ALPHA 局部迁移键区间。',
      '<!-- /sh:ai -->',
      '',
      '<!-- sh:ai id=blk-beta at=22222222 state=new mode=here -->',
      '关于：「虚节点数量选择」',
      '',
      'R63_DEL_BODY_BETA 每个物理机建议 100-200 个虚节点。',
      '<!-- /sh:ai -->',
    ].join('\n');
    const { file } = await seedAiBlocksInMineFile(host, COURSE, twoBlocksText);

    const tty = createVirtualTty(120, 36);
    let inkInstance = null;
    try {
      const opened = await openBookViewInPty(host, tty, {
        course: COURSE,
        label: 'AiBlock',
        readyPredicate: (s) => s.includes('Distributed Hashing') && s.includes('Consistent Hashing'),
      });
      inkInstance = opened.inkInstance;
      assertHealthyBookScreen(tty, opened.bookScreen, 120, 36, 'BookView initial');

      // Press B directly from BookView (auto-picks file with AI blocks)
      tty.send('B');
      const modalScreen = await tty.waitFor(
        (s) =>
          s.includes('AI 补充块审阅') &&
          s.includes(file) &&
          s.includes('blk-alpha') &&
          s.includes('blk-beta') &&
          s.includes('R63_KEEP_BODY_ALPHA'),
        { label: 'BookAiBlocksModal opened with both blocks' },
      );
      assertHealthyBookScreen(tty, modalScreen, 120, 36, 'BookAiBlocksModal');
      assert.ok(modalScreen.includes('blk-alpha'));
      assert.ok(modalScreen.includes('blk-beta'));

      // Keep block 1 via 'a'
      tty.send('a');
      const keptScreen = await tty.waitFor(
        (s) => s.includes('已保留 AI 补充块 (blk-alpha)') && s.includes('已保留'),
        { label: 'Block 1 kept toast & badge' },
      );
      assertHealthyBookScreen(tty, keptScreen, 120, 36, 'After keep blk-alpha');
      assert.ok(keptScreen.includes('已保留'));

      // Select block 2 via 'j'
      tty.send('j');
      const block2Screen = await tty.waitFor((s) => s.includes('R63_DEL_BODY_BETA'), { label: 'Selected block 2 with j' });
      assert.ok(block2Screen.includes('R63_DEL_BODY_BETA'));

      // Press 'd' -> ConfirmDialog
      tty.send('d');
      const confirmScreen = await tty.waitFor(
        (s) => s.includes('确认删除该 AI 补充块？') && s.includes('blk-beta'),
        { label: 'ConfirmDialog opened for blk-beta' },
      );
      assertHealthyBookScreen(tty, confirmScreen, 120, 36, 'ConfirmDialog delete AI block');
      assert.ok(confirmScreen.includes('确认删除该 AI 补充块？'));

      // Confirm with 'y' -> block 2 deleted & toast shown
      tty.send('y');
      const afterDelScreen = await tty.waitFor(
        (s) =>
          !s.includes('确认删除该 AI 补充块？') &&
          s.includes('已删除 AI 补充块 (blk-beta)') &&
          !s.includes('R63_DEL_BODY_BETA') &&
          s.includes('1 块') &&
          s.includes('blk-alpha'),
        { label: 'Block 2 deleted & toast visible' },
      );
      assertHealthyBookScreen(tty, afterDelScreen, 120, 36, 'BookAiBlocksModal after delete');
      assert.ok(afterDelScreen.includes('1 块'));

      // Esc closes BookAiBlocksModal cleanly back to BookView
      tty.send('\x1b');
      const closedScreen = await tty.waitFor(
        (s) => !s.includes('AI 补充块审阅') && s.includes('Distributed Hashing'),
        { label: 'BookAiBlocksModal closed on Esc' },
      );
      assertHealthyBookScreen(tty, closedScreen, 120, 36, 'BookView after Esc');
      assert.equal(useTuiStore.getState().page, 'book');
      assert.equal(modelCalls, 0);

      // Verify persisted state after PTY operations
      const afterPtyOpen = await host.call('course.book.open', { course: COURSE, language: 'zh' });
      assert.equal(afterPtyOpen.ok, true);
      const remaining = parseAiBlocks(afterPtyOpen.value.nodes[0].children[0].mine);
      assert.equal(remaining.length, 1);
      assert.equal(remaining[0].id, 'blk-alpha');
      assert.equal(remaining[0].state, 'kept');
    } finally {
      try {
        inkInstance?.unmount();
      } catch {
        // Ignore unmount errors during cleanup
      }
      try {
        tty?.dispose();
      } catch {
        // Ignore tty dispose errors during cleanup
      }
      await host.dispose();
    }
  });
});

// ============================================================================
// Suite 7: Live TOC Filter (Round 73: BookView / Live TOC Filter)
// ============================================================================
describe('Domain Book 7: Live TOC Filter (BookView /)', () => {
  const COURSE = 'TocFilterCourse';

  function seedMultiPointBook(root, course = COURSE) {
    return seedBookLibrary(root, {
      course,
      docs: [
        {
          id: 'doc1-p1',
          title: 'Systems · p. 1',
          createdAt: '2026-10-01T00:00:00.000Z',
          text: 'Raft elects leaders using randomized election timeouts and term numbers.',
          page: 1,
          chapterTitle: 'Raft Leader Election',
          filename: 'systems.pdf',
          materialId: 'doc-sys',
        },
        {
          id: 'doc1-p2',
          title: 'Systems · p. 2',
          createdAt: '2026-10-01T01:00:00.000Z',
          text: 'Paxos requires majority quorums in Prepare and Accept phases.',
          page: 2,
          chapterTitle: 'Paxos Quorum Protocol',
          filename: 'systems.pdf',
          materialId: 'doc-sys',
        },
        {
          id: 'doc1-p3',
          title: 'Systems · p. 3',
          createdAt: '2026-10-01T02:00:00.000Z',
          text: 'LSM trees batch writes in MemTable and merge SSTables via background compaction.',
          page: 3,
          chapterTitle: 'LSM Tree Compaction',
          filename: 'systems.pdf',
          materialId: 'doc-sys',
        },
      ],
      chapters: [
        {
          id: 'ch1',
          title: 'Distributed Consensus',
          leaves: [
            { id: 'raft-elect', title: 'Raft Leader Election', anchorIndex: 0 },
            { id: 'paxos-quorum', title: 'Paxos Quorum Protocol', anchorIndex: 1 },
          ],
        },
        {
          id: 'ch2',
          title: 'Storage Engines',
          leaves: [
            { id: 'lsm-compact', title: 'LSM Tree Compaction', anchorIndex: 2 },
          ],
        },
      ],
      fingerprintChar: 'd',
      citeQuote: 'term',
      bodyPointBuilder: (leaf) => `UNIQUE_BODY_${leaf.id.toUpperCase()} core summary [^1].`,
    });
  }

  test('PTY E2E: / live TOC filter -> Enter loads right pane -> Esc restores TOC -> 80x24 narrow-pane Enter & h back (0 model calls)', async () => {
    let modelCalls = 0;
    const { host } = await createBookPtyHost('toc-filter-pty', {
      course: COURSE,
      seedFn: (root, c) => seedMultiPointBook(root, c),
      injectedComplete: async () => {
        modelCalls += 1;
        return '{}';
      },
    });

    const tty = createVirtualTty(120, 36);
    let inkInstance = null;
    try {
      const opened = await openBookViewInPty(host, tty, {
        course: COURSE,
        label: 'TocFilter',
        readyPredicate: (s) =>
          s.includes('Distributed Consensus') &&
          s.includes('Raft Leader Election') &&
          s.includes('LSM Tree Compaction') &&
          s.includes('精选问答'),
      });
      inkInstance = opened.inkInstance;
      assertHealthyBookScreen(tty, opened.bookScreen, 120, 36, 'BookView initial');
      assert.equal(useTuiStore.getState().page, 'book');

      // Press '/' to open inline TOC filter
      tty.send('/');
      const filterOpenScreen = await tty.waitFor(
        (s) => s.includes('[筛选 5/5]') && s.includes('Enter 确认 | Esc 清除'),
        { label: 'BookView filter bar opened' },
      );
      assertHealthyBookScreen(tty, filterOpenScreen, 120, 36, 'BookView filter bar opened');
      assert.ok(filterOpenScreen.includes('[筛选 5/5]'));

      // Type unique point title (case-insensitive match)
      tty.send('lsm tree');
      const filteredEditingScreen = await tty.waitFor(
        (s) =>
          s.includes('[筛选 1/5]') &&
          s.includes('LSM Tree Compaction') &&
          !s.includes('Raft Leader Election') &&
          !s.includes('Paxos Quorum Protocol'),
        { label: 'Filtered TOC to 1/5 while editing' },
      );
      assertHealthyBookScreen(tty, filteredEditingScreen, 120, 36, 'BookView filtered editing');
      assert.ok(filteredEditingScreen.includes('[筛选 1/5]'));

      // Press Enter to confirm/blur filter -> right pane loads that exact point
      tty.send('\r');
      const confirmedScreen = await tty.waitFor(
        (s) =>
          s.includes('[筛选 1/5]') &&
          s.includes('/ 编辑 | Esc 清除') &&
          s.includes('UNIQUE_BODY_LSM-COMPACT') &&
          s.includes('Detailed notes for LSM Tree Compaction'),
        { label: 'Confirmed filter & right-pane loaded exact point' },
      );
      assertHealthyBookScreen(tty, confirmedScreen, 120, 36, 'BookView confirmed filter');
      assert.ok(confirmedScreen.includes('UNIQUE_BODY_LSM-COMPACT'));

      // Press Esc in normal mode -> clears filter and restores full TOC
      tty.send('\x1b');
      const restoredScreen = await tty.waitFor(
        (s) =>
          !s.includes('[筛选') &&
          s.includes('Distributed Consensus') &&
          s.includes('Raft Leader Election') &&
          s.includes('Paxos Quorum Protocol') &&
          s.includes('LSM Tree Compaction'),
        { label: 'Esc cleared filter & restored full TOC' },
      );
      assertHealthyBookScreen(tty, restoredScreen, 120, 36, 'BookView restored TOC after Esc');
      assert.ok(!restoredScreen.includes('[筛选'));

      // Narrow 80x24 single-pane filter flow: '/' -> 'paxos' -> Enter confirms -> Enter views Content pane -> Esc -> 'h' back to TOC
      tty.resize(80, 24);
      await tty.waitFor(
        (s) => s.includes('Raft Leader Election') && s.split('\n').length <= 24,
        { label: 'BookView resized to 80x24' },
      );
      tty.send('/');
      await tty.waitFor((s) => s.includes('[筛选 5/5]'), { label: 'Filter bar opened 80x24' });
      tty.send('paxos');
      const narrowFiltered = await tty.waitFor(
        (s) => s.includes('[筛选 1/5]') && s.includes('Paxos Quorum') && !s.includes('Raft Leader'),
        { label: 'Filtered TOC to Paxos 80x24' },
      );
      assertHealthyBookScreen(tty, narrowFiltered, 80, 24, 'Filtered TOC 80x24');
      assert.ok(narrowFiltered.includes('Paxos Quorum'));

      tty.send('\r');
      const narrowConfirmed = await tty.waitFor(
        (s) => s.includes('[筛选 1/5]') && s.includes('1.2 Paxos Quorum Protocol'),
        { label: 'Filter confirmed 80x24' },
      );
      assert.ok(narrowConfirmed.includes('1.2 Paxos Quorum Protocol'));
      tty.send('\r');
      const contentScreen = await tty.waitFor(
        (s) => s.includes('UNIQUE_BODY_PAXOS-QUORUM'),
        { label: 'Content pane shows filtered point 80x24' },
      );
      assertHealthyBookScreen(tty, contentScreen, 80, 24, 'Content pane 80x24');
      assert.ok(contentScreen.includes('UNIQUE_BODY_PAXOS-QUORUM'));

      tty.send('\x1b');
      await tty.waitFor((s) => !s.includes('[筛选'), { label: 'Esc cleared filter 80x24' });
      tty.send('h');
      const narrowRestored = await tty.waitFor(
        (s) => !s.includes('[筛选') && s.includes('Raft Leader') && s.includes('Paxos Quorum'),
        { label: 'Full TOC restored via h 80x24' },
      );
      assertHealthyBookScreen(tty, narrowRestored, 80, 24, 'BookView restored 80x24');
      assert.ok(narrowRestored.includes('Raft Leader'));
      assert.equal(modelCalls, 0);
    } finally {
      try {
        inkInstance?.unmount();
      } catch {
        // Ignore unmount errors during cleanup
      }
      try {
        tty?.dispose();
      } catch {
        // Ignore tty dispose errors during cleanup
      }
      await host.dispose();
    }
  });
});
