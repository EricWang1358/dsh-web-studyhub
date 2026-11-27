// Consolidated Review & Coaching Domain Suite
// Merges: round41-review-draft, round52-review-grade-adj, round53-round-debrief, round54-card-retry, round60-coach-nudge
// node --test tests/domain-review.test.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { after, describe, test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { Box, render } from 'ink';
import React from 'react';
import { register } from 'tsx/esm/api';
import {
  UNICODE_UI_CHROME_RE,
  cloneSampleLibrary,
  createTempTracker,
  createVirtualTty,
  disposeTerminalPool,
  distDir,
  installNoNetworkGuard,
  loadDistRuntime,
  sanitizedTestEnv,
} from './helpers/virtual-tty.mjs';

const unregisterTsx = register();

const { StudyHubTuiApp, createTuiHost, saveTuiPreferences } = await loadDistRuntime();
assert.ok(StudyHubTuiApp, 'dist/ must export StudyHubTuiApp');
assert.ok(createTuiHost, 'dist/ must export createTuiHost');
assert.ok(saveTuiPreferences, 'dist/ must export saveTuiPreferences');

const distFiles = (await readdir(distDir)).filter((f) => f.endsWith('.mjs') && f !== 'cli.mjs');
const storeFile = distFiles.find((f) => f.startsWith('store-') && f.endsWith('.mjs'));
assert.ok(storeFile, 'dist/ must include store-*.mjs');
const { useTuiStore: useDistTuiStore, DEFAULT_PREFERENCES } = await import(
  pathToFileURL(join(distDir, storeFile)).href
);
assert.ok(useDistTuiStore, 'dist/store-*.mjs must export useTuiStore');
assert.ok(DEFAULT_PREFERENCES, 'dist/store-*.mjs must export DEFAULT_PREFERENCES');

const coachChunk = distFiles.find((f) => f.startsWith('CoachNudgeModal-'));
assert.ok(coachChunk, `dist/ must emit lazy CoachNudgeModal-*.mjs chunk, found: ${distFiles.join(', ')}`);
const coachChunkCode = fs.readFileSync(join(distDir, coachChunk), 'utf8');
assert.equal(/\bmarked\b/.test(coachChunkCode), false, `${coachChunk} must be marked-free`);

const [Helpers, { normalizeAsciiChrome }] = await Promise.all([
  import('../src/views/review/review-helpers.ts'),
  import('../src/components/Badge.tsx'),
]);

const PREV_DSH_HOME = process.env.DSH_HOME;
const restoreNetworkGuard = installNoNetworkGuard();
const temps = createTempTracker('studyhub-tui-review-');

after(async () => {
  restoreNetworkGuard();
  disposeTerminalPool();
  unregisterTsx?.();
  if (PREV_DSH_HOME === undefined) delete process.env.DSH_HOME;
  else process.env.DSH_HOME = PREV_DSH_HOME;
  await temps.cleanup();
});

const RESOURCE_KINDS = new Set(['FSEventWrap', 'StatWatcher', 'ProcessWrap', 'TCPWrap', 'PipeWrap']);
function resourceCounts() {
  const counts = {};
  for (const kind of process.getActiveResourcesInfo()) {
    if (RESOURCE_KINDS.has(kind)) counts[kind] = (counts[kind] || 0) + 1;
  }
  return counts;
}

function refTimeoutCount() {
  if (typeof process._getActiveHandles !== 'function') return 0;
  return process._getActiveHandles().filter((h) => h?.constructor?.name === 'Timeout').length;
}

function assertNoLeakedHandles(beforeResources, kinds = RESOURCE_KINDS) {
  const afterResources = resourceCounts();
  for (const kind of kinds) {
    assert.ok(
      (afterResources[kind] || 0) <= (beforeResources[kind] || 0),
      `Leaked ${kind} handles after unmount/dispose: before=${beforeResources[kind] || 0}, after=${afterResources[kind] || 0}`,
    );
  }
}

async function waitForNoLeakedHandles(beforeResources, kinds = RESOURCE_KINDS, timeoutMs = 1500, beforeRefTimeouts = 0) {
  const deadline = Date.now() + timeoutMs;
  await new Promise((r) => setImmediate(r));
  while (Date.now() < deadline) {
    const afterResources = resourceCounts();
    let leaked = refTimeoutCount() > beforeRefTimeouts;
    if (!leaked) {
      for (const kind of kinds) {
        if ((afterResources[kind] || 0) > (beforeResources[kind] || 0)) {
          leaked = true;
          break;
        }
      }
    }
    if (!leaked) return;
    await new Promise((r) => {
      let timerId = null;
      timerId = setTimeout(() => {
        clearTimeout(timerId);
        setImmediate(r);
      }, 25);
      timerId.unref?.();
    });
  }
  assert.ok(
    refTimeoutCount() <= beforeRefTimeouts,
    `Leaked ref'd Timeout handles after unmount/dispose: before=${beforeRefTimeouts}, after=${refTimeoutCount()}`,
  );
  assertNoLeakedHandles(beforeResources, kinds);
}

function resetDistStore(language = 'zh', asciiMode = false, extra = {}) {
  useDistTuiStore.setState({
    page: 'library',
    navContext: {},
    history: [],
    snapshot: null,
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
    ...extra,
  });
}

function fakeDiscovery() {
  const result = () => [
    { id: 'agy', supported: true, status: 'not-installed', executablePath: null, version: null, reasonCode: 'not-installed', reason: '' },
    { id: 'claude', supported: false, status: 'coming-soon', executablePath: null, version: null, reasonCode: 'coming-soon-not-installed', reason: '' },
    { id: 'codex', supported: true, status: 'not-installed', executablePath: null, version: null, reasonCode: 'not-installed', reason: '' },
  ];
  return {
    async scan() {
      return result();
    },
    getCached: () => result(),
    findReadyPath: () => '',
    findReadyAgyPath: () => '',
    findReadyCodexPath: () => '',
  };
}

async function waitForHostCondition(checkFn, { timeoutMs = 4_000, intervalMs = 40, label = 'host condition' } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const val = await checkFn();
    if (val) return val;
    await new Promise((resolveWait) => setTimeout(resolveWait, intervalMs));
  }
  throw new Error(`Timed out waiting for ${label} after ${timeoutMs}ms`);
}

function createRubricStubComplete(onCall) {
  return async (_system, prompt) => {
    onCall?.();
    let cardId = 'card-1';
    let criteriaIds = ['c1'];
    try {
      const m = /"questions"\s*:\s*\[\s*\{[\s\S]*?"cardId"\s*:\s*"([^"]+)"/.exec(prompt);
      if (m) cardId = m[1];
      const critMatches = [...prompt.matchAll(/"id"\s*:\s*"([^"]+)"/g)].map((x) => x[1]);
      if (critMatches.length > 0) criteriaIds = critMatches;
    } catch {
      // use defaults
    }
    return JSON.stringify({
      questions: [
        {
          cardId,
          criteria: criteriaIds.map((id) => ({
            id,
            score: 0,
            evidence: [],
            covered: [],
            missing: ['Key reasoning step'],
            suggestion: 'Explain the core mechanism clearly',
          })),
          summary: 'Missing core mechanism',
        },
      ],
      summary: 'Partial attempt',
    });
  };
}

function createDebriefStubComplete(onCall) {
  return async (_system, prompt) => {
    onCall?.();
    let defaultNext = 'continue_path';
    try {
      const parsed = JSON.parse(prompt);
      if (typeof parsed?.defaultNext === 'string' && parsed.defaultNext) {
        defaultNext = parsed.defaultNext;
      }
    } catch {
      // use default
    }
    return JSON.stringify({
      headline: 'Stubbed AI Coach Headline',
      why: 'Stubbed AI Coach explanation grounded in this round performance.',
      next: defaultNext,
      summary: 'Learner summary updated from round debrief.',
      bullets: [],
    });
  };
}

function createNudgeStubComplete({ onNudge, onFollowup, lang = 'zh', includeChrome = false } = {}) {
  let followupIdx = 0;
  return async (_system, _prompt, opts = {}) => {
    const task = opts?.task || '';
    if (task === 'coach.reply') {
      followupIdx += 1;
      onFollowup?.(followupIdx);
      const chrome = includeChrome ? ' … ✓ → •' : '';
      return JSON.stringify({
        explain:
          lang === 'en'
            ? `Simpler analogy angle ${followupIdx}: think of TCP as a signed receipt before delivery${chrome}.`
            : `生活类比角度 ${followupIdx}：把 TCP 三次握手想象成双方互发回执确认收发能力${chrome}。`,
      });
    }
    onNudge?.();
    const chrome = includeChrome ? ' … ✓ → •' : '';
    return JSON.stringify(
      lang === 'en'
        ? {
            point: `TCP vs UDP reliability confusion${chrome}`,
            explain: `You picked UDP, which skips handshake and retransmission; TCP ensures ordered delivery${chrome}.`,
            check: {
              q: `Which protocol guarantees ordered byte stream delivery?${chrome}`,
              options: [`TCP with ACK${chrome}`, 'UDP datagram'],
              answer: 0,
              why: `TCP uses sequence numbers and ACKs to guarantee order${chrome}.`,
            },
          }
        : {
            point: `混淆了 TCP 与 UDP 的可靠性机制${chrome}`,
            explain: `你选了 UDP，但 UDP 无连接且不重传；TCP 通过三次握手和确认应答保障可靠有序传输${chrome}。`,
            check: {
              q: `哪种传输协议提供面向连接的可靠字节流？${chrome}`,
              options: [`TCP 协议${chrome}`, 'UDP 协议'],
              answer: 0,
              why: `TCP 通过序列号、ACK 确认与超时重传保证数据可靠到达${chrome}。`,
            },
          },
    );
  };
}

async function seedPendingRubricRun(host, language = 'zh') {
  const sampleRes = await host.call('sample.status', {});
  assert.equal(sampleRes.ok, true, sampleRes.error?.message);
  const caseDeckId = sampleRes.value?.caseDeckId;
  assert.ok(caseDeckId, 'sample.status must expose caseDeckId');

  const startRes = await host.call('review.start', { mode: 'quiz', deckId: caseDeckId, fresh: true });
  assert.equal(startRes.ok, true, startRes.error?.message);
  const run = startRes.value;
  assert.ok(run?.id && run?.card?.id, 'review.start must return active run');
  assert.ok((run.navigation?.length ?? 0) >= 2, 'case deck must have at least 2 questions');

  const card0Id = run.card.id;
  const card1Id = run.navigation[1].cardId;

  const move1 = await host.call('review.move', { runId: run.id, index: 1 });
  assert.equal(move1.ok, true, move1.error?.message);

  const gradeRes = await host.call('card.grade', {
    deckId: caseDeckId,
    cardId: card0Id,
    runId: run.id,
    answer: 'Brief incomplete draft',
    language,
  });
  assert.equal(gradeRes.ok, true, gradeRes.error?.message);
  assert.equal(gradeRes.value?.correctionPending, true, 'grading card0 after moving away with grade<=1 must set correctionPending');

  const move0 = await host.call('review.move', { runId: run.id, index: 0 });
  assert.equal(move0.ok, true, move0.error?.message);

  return { caseDeckId, run: move0.value, card0Id, card1Id };
}

async function seedFlashcardRun(host, count = 1) {
  const sampleRes = await host.call('sample.status', {});
  assert.equal(sampleRes.ok, true, sampleRes.error?.message);
  const deckId = sampleRes.value?.deckId;
  assert.ok(deckId, 'sample.status must expose deckId');

  const deckRes = await host.call('deck.get', { id: deckId });
  assert.equal(deckRes.ok, true, deckRes.error?.message);
  const flashcards = (deckRes.value?.cards || []).filter((c) => c.kind === 'flashcard');
  assert.ok(flashcards.length >= count, `sample deck must have at least ${count} flashcards`);

  const scope = flashcards.slice(0, count).map((c) => ({ deckId, cardId: c.id }));
  const startRes = await host.call('review.start', {
    mode: 'path',
    scope,
    fresh: true,
  });
  assert.equal(startRes.ok, true, startRes.error?.message);
  const run = startRes.value;
  assert.ok(run?.id, 'review.start must return a run id');
  return { deckId, run, cards: flashcards.slice(0, count) };
}

async function seedTwoCardQuizDeckAndRun(host, lang = 'zh') {
  const imp = await host.call('deck.import', {
    text: JSON.stringify({
      title: lang === 'en' ? 'Network Protocols Quiz' : '计算机网络测验',
      course: lang === 'en' ? 'Computer Networks' : '计算机网络',
      cards: [
        {
          kind: 'quiz',
          topic: lang === 'en' ? 'Transport Layer' : '传输层',
          objective: lang === 'en' ? 'Distinguish TCP and UDP' : '区分 TCP 与 UDP',
          prompt:
            lang === 'en'
              ? 'Which protocol guarantees reliable ordered delivery?'
              : '哪种协议提供可靠的面向连接字节流传输？',
          options: [
            { id: 'a', text: 'TCP', correct: true, explanation: 'TCP uses sequence numbers and ACKs.' },
            { id: 'b', text: 'UDP', correct: false, explanation: 'UDP is connectionless and unreliable.' },
            { id: 'c', text: 'ICMP', correct: false, explanation: 'ICMP is for network diagnostics.' },
          ],
          answer: 'TCP',
          hint: 'Think about handshake and ACKs.',
          explanation: 'TCP uses handshake, sequence numbers, and ACKs.',
          misconception: 'Confusing TCP with UDP.',
        },
        {
          kind: 'quiz',
          topic: lang === 'en' ? 'Application Layer' : '应用层',
          objective: lang === 'en' ? 'Know default HTTPS port' : '掌握 HTTPS 默认端口',
          prompt:
            lang === 'en'
              ? 'Which port does HTTPS use by default?'
              : 'HTTPS 默认使用哪个端口？',
          options: [
            { id: 'a', text: '443', correct: true, explanation: 'HTTPS uses TCP port 443.' },
            { id: 'b', text: '80', correct: false, explanation: 'Port 80 is HTTP.' },
            { id: 'c', text: '22', correct: false, explanation: 'Port 22 is SSH.' },
          ],
          answer: '443',
          hint: 'Not port 80.',
          explanation: 'HTTPS defaults to port 443.',
          misconception: 'Confusing HTTP port 80 with HTTPS port 443.',
        },
      ],
    }),
  });
  assert.equal(imp.ok, true, `deck.import failed: ${imp.error?.message}`);
  assert.equal(imp.value?.imported, 1, `deck.import failed: ${JSON.stringify(imp.value?.results)}`);
  const snapRes = await host.refreshSnapshot();
  const deck = (snapRes.snapshot?.decks ?? []).find((d) => !d.archived && !d.systemKind);
  assert.ok(deck, 'seeded deck must exist in snapshot');

  const startRes = await host.call('review.start', {
    mode: 'quiz',
    deckId: deck.id,
    fresh: true,
  });
  assert.equal(startRes.ok, true, `review.start failed: ${startRes.error?.message}`);
  assert.ok(startRes.value?.id, 'review.start must return a run id');
  return { deckId: deck.id, run: startRes.value };
}

function findWrongOptionKey(screen) {
  for (const line of screen.split('\n')) {
    const match = /\[([1-3])\/[a-c]\]/.exec(line);
    if (!match) continue;
    if (/\b(UDP|ICMP|80|22)\b/.test(line)) {
      return match[1];
    }
  }
  throw new Error(`Could not locate wrong option on screen:\n${screen}`);
}

describe('Round 41: Review Draft Persistence (review.draft.save) & Card Placement (card.place)', () => {
  test('1) createTuiHost integration: review.draft.save -> review.get preserves draft & stale/closed run returns { ok: false, stale }', async () => {
    const base = await temps.make('r41-host-draft');
    const env = sanitizedTestEnv({ DSH_HOME: join(base, 'dsh-home') });
    const libraryRoot = join(base, 'library');
    await cloneSampleLibrary('en', libraryRoot);
    const host = await createTuiHost({
      libraryRoot,
      env,
      home: base,
      documentsDir: base,
      providerDiscovery: fakeDiscovery(),
      skipAutoProbe: true,
      language: 'en',
    });

    try {
      const sampleRes = await host.call('sample.status', {});
      assert.equal(sampleRes.ok, true, sampleRes.error?.message);

      const snap = await host.call('snapshot', {});
      assert.equal(snap.ok, true);
      const deck = (snap.value?.decks ?? []).find((d) => !d.systemKind);
      assert.ok(deck, 'sample course must include at least one ordinary deck');

      const startRes = await host.call('review.start', { mode: 'quiz', deckId: deck.id, fresh: true });
      assert.equal(startRes.ok, true, startRes.error?.message);
      const run = startRes.value;
      assert.ok(run?.id && run?.card?.id, 'review.start must return an active run and card');

      const saveRes = await host.call('review.draft.save', {
        runId: run.id,
        cardId: run.card.id,
        index: run.index,
        draft: { text: 'Bridge separates abstraction from implementation', stepInputs: { b1: 'Bridge' } },
      });
      assert.equal(saveRes.ok, true, saveRes.error?.message);
      assert.equal(saveRes.value?.ok, true);
      assert.equal(saveRes.value?.runId, run.id);
      assert.equal(saveRes.value?.cardId, run.card.id);
      assert.equal(saveRes.value?.draft?.text, 'Bridge separates abstraction from implementation');
      assert.deepEqual(saveRes.value?.draft?.stepInputs, { b1: 'Bridge' });
      assert.equal(typeof saveRes.value?.draft?.updatedAt, 'number');

      const getRes = await host.call('review.get', { runId: run.id });
      assert.equal(getRes.ok, true, getRes.error?.message);
      assert.equal(getRes.value?.draft?.text, 'Bridge separates abstraction from implementation');
      assert.deepEqual(getRes.value?.draft?.stepInputs, { b1: 'Bridge' });

      const staleQuestion = await host.call('review.draft.save', {
        runId: run.id,
        cardId: 'non-existent-card',
        index: run.index,
        draft: { text: 'ignored' },
      });
      assert.equal(staleQuestion.ok, true, 'noWrite stale response must not throw');
      assert.equal(staleQuestion.value?.ok, false);
      assert.equal(staleQuestion.value?.stale, 'question');

      const afterStaleGet = await host.call('review.get', { runId: run.id });
      assert.equal(afterStaleGet.ok, true);
      assert.equal(afterStaleGet.value?.draft?.text, 'Bridge separates abstraction from implementation');

      const endRes = await host.call('review.end', { runId: run.id });
      assert.equal(endRes.ok, true, endRes.error?.message);

      const staleClosed = await host.call('review.draft.save', {
        runId: run.id,
        cardId: run.card.id,
        index: run.index,
        draft: { text: 'after close' },
      });
      assert.equal(staleClosed.ok, true, 'closed run draft save must fail soft via noWrite');
      assert.equal(staleClosed.value?.ok, false);
      assert.equal(staleClosed.value?.stale, 'run');

      const staleMissing = await host.call('review.draft.save', {
        runId: 'missing-run-id',
        cardId: run.card.id,
        index: 0,
        draft: { text: 'after missing' },
      });
      assert.equal(staleMissing.ok, true);
      assert.equal(staleMissing.value?.ok, false);
      assert.equal(staleMissing.value?.stale, 'run');
    } finally {
      await host.dispose();
    }
  });

  test('2) createTuiHost integration: card.place { deckId, cardId } returns exact placement shape', async () => {
    const base = await temps.make('r41-host-place');
    const env = sanitizedTestEnv({ DSH_HOME: join(base, 'dsh-home') });
    const libraryRoot = join(base, 'library');
    await cloneSampleLibrary('en', libraryRoot);
    const host = await createTuiHost({
      libraryRoot,
      env,
      home: base,
      documentsDir: base,
      providerDiscovery: fakeDiscovery(),
      skipAutoProbe: true,
      language: 'en',
    });

    try {
      const sampleRes = await host.call('sample.status', {});
      assert.equal(sampleRes.ok, true, sampleRes.error?.message);

      const snap = await host.call('snapshot', {});
      assert.equal(snap.ok, true);
      const deck = (snap.value?.decks ?? []).find((d) => !d.systemKind);
      assert.ok(deck, 'sample library must include a non-system deck');
      const deckDetail = await host.call('deck.get', { id: deck.id });
      assert.equal(deckDetail.ok, true);
      const citedCard = (deckDetail.value?.cards ?? []).find((c) => Array.isArray(c.citations) && c.citations.length > 0);
      assert.ok(citedCard?.id, 'sample deck must include a card with source citations');

      const placeRes = await host.call('card.place', { deckId: deck.id, cardId: citedCard.id });
      assert.equal(placeRes.ok, true, placeRes.error?.message);
      const place = placeRes.value;
      assert.ok(place && typeof place === 'object', 'card.place must return an object');
      assert.ok('course' in place && typeof place.course === 'string' && place.course.length > 0, 'place.course must be non-empty string');
      assert.ok('document' in place, 'place must expose document key');
      assert.ok('chapter' in place, 'place must expose chapter key');
      assert.ok('leaf' in place, 'place must expose leaf key');
      if (place.document !== null) {
        assert.equal(typeof place.document.key, 'string');
        assert.equal(typeof place.document.title, 'string');
      }
      if (place.chapter !== null) {
        assert.equal(typeof place.chapter.key, 'string');
        assert.equal(typeof place.chapter.title, 'string');
      }
      if (place.leaf !== null) {
        assert.equal(typeof place.leaf.key, 'string');
        assert.equal(typeof place.leaf.title, 'string');
        assert.equal(typeof place.leaf.built, 'boolean');
      }

      const emptyPlace = await host.call('card.place', { deckId: deck.id, cardId: 'nonexistent-card-id' });
      assert.equal(emptyPlace.ok, true, emptyPlace.error?.message);
      assert.deepEqual(emptyPlace.value, { course: null, document: null, chapter: null, leaf: null });
    } finally {
      await host.dispose();
    }
  });

  test('3) PTY E2E: ReviewView restores pre-saved draft, debounces new edits, shows card.place in CardToolsModal (--ascii), and leaks zero handles', async () => {
    disposeTerminalPool();
    const beforeResources = resourceCounts();

    const base = await temps.make('r41-pty-draft');
    const dshHome = join(base, 'dsh-home');
    process.env.DSH_HOME = dshHome;
    await saveTuiPreferences(
      { language: 'en', asciiMode: true, theme: 'tokyo-night', mathUnicode: false, showHints: true },
      { env: sanitizedTestEnv({ DSH_HOME: dshHome }) },
    );

    const libraryRoot = join(base, 'library');
    await cloneSampleLibrary('en', libraryRoot);
    const host = await createTuiHost({
      libraryRoot,
      env: sanitizedTestEnv({ DSH_HOME: dshHome }),
      home: join(base, 'home'),
      documentsDir: base,
      providerDiscovery: fakeDiscovery(),
      skipAutoProbe: true,
      language: 'en',
      eventDebounceMs: 30,
    });

    const tty = createVirtualTty(120, 36);
    let inkInst = null;
    let openRunId = null;

    try {
      const sampleRes = await host.call('sample.status', {});
      assert.equal(sampleRes.ok, true, sampleRes.error?.message);

      const snap = await host.call('snapshot', {});
      assert.equal(snap.ok, true);
      let targetDeckId = null;
      let targetCardId = null;
      for (const d of snap.value?.decks ?? []) {
        if (d.systemKind) continue;
        const det = await host.call('deck.get', { id: d.id });
        if (!det.ok) continue;
        const cards = det.value?.cards ?? [];
        const openFirst = cards[0] && (cards[0].kind === 'open' || cards[0].kind === 'task');
        if (openFirst) {
          targetDeckId = d.id;
          targetCardId = cards[0].id;
          break;
        }
        const anyOpen = cards.find((c) => c.kind === 'open' || c.kind === 'task');
        if (anyOpen && !targetDeckId) {
          targetDeckId = d.id;
          targetCardId = anyOpen.id;
        }
      }
      assert.ok(targetDeckId && targetCardId, 'sample library must include an open/task card');

      const startRes = await host.call('review.start', { mode: 'quiz', deckId: targetDeckId, fresh: true });
      assert.equal(startRes.ok, true, startRes.error?.message);
      let startedRun = startRes.value;
      if (startedRun.card?.kind !== 'open' && startedRun.card?.kind !== 'task') {
        const navIdx = (startedRun.navigation ?? []).findIndex((n) => n.cardId === targetCardId);
        if (navIdx >= 0) {
          const moved = await host.call('review.move', { runId: startedRun.id, index: navIdx });
          assert.equal(moved.ok, true, moved.error?.message);
          startedRun = moved.value;
        }
      }
      assert.ok(startedRun.card?.kind === 'open' || startedRun.card?.kind === 'task', `expected open/task card, got ${startedRun.card?.kind}`);
      openRunId = startedRun.id;

      const preSavedDraft = 'PRE_SAVED_DRAFT_R41';
      const saveRes = await host.call('review.draft.save', {
        runId: startedRun.id,
        cardId: startedRun.card.id,
        index: startedRun.index,
        draft: { text: preSavedDraft },
      });
      assert.equal(saveRes.ok, true);
      assert.equal(saveRes.value?.ok, true);

      resetDistStore('en', true, {
        page: 'review',
        activeRunId: startedRun.id,
        navContext: { runId: startedRun.id },
      });

      inkInst = render(
        React.createElement(StudyHubTuiApp, {
          host,
          initialPage: 'review',
          initialLanguage: 'en',
          initialAsciiMode: true,
          autoLaunchpad: false,
          onExit: () => inkInst?.unmount(),
        }),
        {
          stdin: tty.stdin,
          stdout: tty.stdout,
          stderr: tty.stderr,
          interactive: true,
          exitOnCtrlC: false,
          patchConsole: false,
        },
      );
      await tty.firstFramePromise;

      const restoredScreen = await tty.waitFor(
        (s) => s.includes(preSavedDraft) && s.includes('[D]Tools'),
        { timeoutMs: 10_000, label: 'ReviewView restored pre-saved draft' },
      );
      tty.assertHealthyScreen(restoredScreen, 120, 36, 'en ASCII ReviewView restored draft');
      tty.assertAsciiPure(restoredScreen, 'en ASCII ReviewView restored draft');
      assert.equal(useDistTuiStore.getState().page, 'review');
      assert.equal(useDistTuiStore.getState().activeRunId, openRunId);
      assert.ok(restoredScreen.includes(preSavedDraft));

      tty.send('i');
      await tty.flush(30);
      tty.send('_TYPED');
      const typedScreen = await tty.waitFor(
        (s) => s.includes(`${preSavedDraft}_TYPED`),
        { timeoutMs: 5_000, label: 'typed draft text rendered' },
      );
      assert.ok(typedScreen.includes(`${preSavedDraft}_TYPED`));

      const afterTypeRun = await waitForHostCondition(
        async () => {
          const r = await host.call('review.get', { runId: openRunId });
          return r.ok && r.value?.draft?.text === `${preSavedDraft}_TYPED` ? r : null;
        },
        { timeoutMs: 4_000, label: 'debounced draft persisted to host' },
      );
      assert.equal(afterTypeRun.ok, true);
      assert.equal(afterTypeRun.value?.draft?.text, `${preSavedDraft}_TYPED`);
      assert.equal(typeof afterTypeRun.value?.draft?.updatedAt, 'number');

      tty.send('\x1b');
      await tty.waitFor(() => !useDistTuiStore.getState().inputCaptured, {
        timeoutMs: 5_000,
        label: 'Esc exited edit mode',
      });
      assert.equal(useDistTuiStore.getState().inputCaptured, false);
      await tty.flush(60);
      tty.send('D');
      const toolsScreen = await tty.waitFor(
        (s) =>
          s.includes('Card Tools') &&
          (s.includes('Source:') || s.includes('Review Book:') || s.includes('Course:')),
        { timeoutMs: 8_000, label: 'CardToolsModal with card.place placement summary' },
      );
      tty.assertHealthyScreen(toolsScreen, 120, 36, 'en ASCII CardToolsModal with placement');
      tty.assertAsciiPure(toolsScreen, 'en ASCII CardToolsModal with placement');
      assert.ok(toolsScreen.includes('Card Tools'));
      assert.ok(toolsScreen.includes('Source:') || toolsScreen.includes('Review Book:') || toolsScreen.includes('Course:'));

      tty.send('\x1b');
      await tty.flush(60);
      const afterCloseTools = await tty.waitFor(
        (s) => !s.includes('Card Tools') && s.includes(`${preSavedDraft}_TYPED`),
        { timeoutMs: 5_000, label: 'CardToolsModal closed back to ReviewView' },
      );
      assert.ok(!afterCloseTools.includes('Card Tools'));
      assert.ok(afterCloseTools.includes(`${preSavedDraft}_TYPED`));

      tty.send('i');
      await tty.flush();
      tty.send('_UNMOUNT');
    } finally {
      try {
        inkInst?.unmount();
      } catch {
        // ignore
      }
      try {
        await host.dispose();
      } catch {
        // ignore
      }
      try {
        tty.dispose();
      } catch {
        // ignore
      }
      disposeTerminalPool();
    }

    await waitForNoLeakedHandles(beforeResources);
  });
});

describe('Round 52: ReviewView Manual AI Grade Adjust (review.grade.adjust) & Delayed Correction Ack (review.correction.ack)', () => {
  test('1) Helper unit tests + createTuiHost integration: extractFeedback/canAdjustAiGrade, card.grade -> review.correction.ack -> review.grade.adjust (0 model calls)', async () => {
    assert.equal(Helpers.extractFeedback(null), null);
    assert.equal(Helpers.extractFeedback({}), null);
    assert.equal(Helpers.extractFeedback({ feedback: {} })?.hasRubric, false);
    const fbRubric = Helpers.extractFeedback({
      feedback: {
        grade: 2,
        rubric: { total: 4, max: 10 },
        gradeOriginal: 0,
        adjustedAt: '2026-11-22T10:00:00.000Z',
        correctionPending: true,
        correctionSeenAt: '2026-11-22T10:01:00.000Z',
      },
    });
    assert.equal(fbRubric?.grade, 2);
    assert.equal(fbRubric?.hasRubric, true);
    assert.equal(fbRubric?.taskCheck, false);
    assert.equal(fbRubric?.gradeOriginal, 0);
    assert.equal(fbRubric?.adjustedAt, '2026-11-22T10:00:00.000Z');
    assert.equal(fbRubric?.correctionPending, true);
    assert.equal(fbRubric?.correctionSeenAt, '2026-11-22T10:01:00.000Z');

    const fbTask = Helpers.extractFeedback({
      feedback: { grade: 3, rubric: { total: 5, max: 5 }, taskCheck: { counts: { satisfied: 1 } } },
    });
    assert.equal(fbTask?.grade, 3);
    assert.equal(fbTask?.hasRubric, true);
    assert.equal(fbTask?.taskCheck, true);

    assert.equal(Helpers.canAdjustAiGrade(null, { retry: false }, fbRubric), false);
    assert.equal(Helpers.canAdjustAiGrade({ mode: 'quiz' }, { retry: false }, null), false);
    assert.equal(Helpers.canAdjustAiGrade({ mode: 'quiz' }, { retry: false }, fbRubric), true);
    assert.equal(Helpers.canAdjustAiGrade({ mode: 'exam' }, { retry: false }, fbRubric), false);
    assert.equal(Helpers.canAdjustAiGrade({ mode: 'quiz', closedAt: '2026-11-22T10:05:00.000Z' }, { retry: false }, fbRubric), false);
    assert.equal(Helpers.canAdjustAiGrade({ mode: 'quiz', closed: true }, { retry: false }, fbRubric), false);
    assert.equal(Helpers.canAdjustAiGrade({ mode: 'quiz' }, { retry: true }, fbRubric), false);
    assert.equal(Helpers.canAdjustAiGrade({ mode: 'quiz' }, null, fbRubric), false);
    assert.equal(Helpers.canAdjustAiGrade({ mode: 'quiz' }, { retry: false }, fbTask), false);
    assert.equal(Helpers.canAdjustAiGrade({ mode: 'quiz' }, { retry: false }, { hasRubric: false, taskCheck: false }), false);

    const base = await temps.make('r52-host');
    const libraryRoot = join(base, 'library');
    await cloneSampleLibrary('en', libraryRoot);
    let modelCalls = 0;
    const host = await createTuiHost({
      libraryRoot,
      env: sanitizedTestEnv({ DSH_HOME: join(base, 'dsh-home') }),
      home: base,
      documentsDir: base,
      injectedComplete: createRubricStubComplete(() => {
        modelCalls += 1;
      }),
      providerDiscovery: fakeDiscovery(),
      skipAutoProbe: true,
      language: 'en',
    });

    try {
      const { caseDeckId, run, card0Id, card1Id } = await seedPendingRubricRun(host, 'en');
      assert.equal(modelCalls, 1, 'card.grade should have made 1 model call');

      const fb0 = Helpers.extractFeedback(run);
      assert.equal(fb0?.hasRubric, true);
      assert.equal(fb0?.correctionPending, true);
      assert.equal(fb0?.grade, 0);
      assert.equal(Helpers.canAdjustAiGrade(run, { retry: run.retry }, fb0), true);

      await host.call('review.move', { runId: run.id, index: 1 });
      const grade1Res = await host.call('card.grade', {
        deckId: caseDeckId,
        cardId: card1Id,
        runId: run.id,
        answer: 'Another brief answer',
        language: 'en',
      });
      assert.equal(grade1Res.ok, true, grade1Res.error?.message);
      assert.notEqual(grade1Res.value?.correctionPending, true);
      assert.equal(modelCalls, 2);

      const ackGuard = await host.call('review.correction.ack', {
        runId: run.id,
        entryIndex: 1,
        cardId: card1Id,
      });
      assert.equal(ackGuard.ok, false, 'review.correction.ack must reject when !correctionPending');

      const ackRes = await host.call('review.correction.ack', {
        runId: run.id,
        entryIndex: 0,
        cardId: card0Id,
      });
      assert.equal(ackRes.ok, true, ackRes.error?.message);
      assert.equal(modelCalls, 2, 'review.correction.ack must use 0 model calls');

      const back0 = await host.call('review.move', { runId: run.id, index: 0 });
      assert.equal(back0.ok, true);
      const fb0AfterAck = Helpers.extractFeedback(back0.value);
      assert.equal(fb0AfterAck?.correctionPending, false);
      assert.equal(typeof fb0AfterAck?.correctionSeenAt, 'string');

      const adjRes = await host.call('review.grade.adjust', {
        runId: run.id,
        entryIndex: 0,
        cardId: card0Id,
        grade: 4,
      });
      assert.equal(adjRes.ok, true, adjRes.error?.message);
      assert.equal(modelCalls, 2, 'review.grade.adjust must use 0 model calls');
      const fb0AfterAdj = Helpers.extractFeedback(adjRes.value);
      assert.equal(fb0AfterAdj?.gradeOriginal, 0);
      assert.equal(fb0AfterAdj?.grade, 4);
      assert.equal(fb0AfterAdj?.correct, true);
      assert.equal(typeof fb0AfterAdj?.adjustedAt, 'string');
    } finally {
      await host.dispose();
    }
  });

  test('2) @xterm/headless PTY E2E (120x36 zh): ReviewView [K] correction ack & [J] GradeAdjustModal (Esc cancel + j/Enter adjust) with zero handle leaks', async () => {
    disposeTerminalPool();
    const beforeResources = resourceCounts();

    const base = await temps.make('r52-pty-zh');
    const dshHome = join(base, 'dsh-home');
    const libraryRoot = join(base, 'library');
    process.env.DSH_HOME = dshHome;
    await saveTuiPreferences(
      { language: 'zh', asciiMode: false, theme: 'dsh-dark', mathUnicode: false, showHints: true },
      { env: sanitizedTestEnv({ DSH_HOME: dshHome }) },
    );
    await cloneSampleLibrary('zh', libraryRoot);

    let modelCalls = 0;
    const host = await createTuiHost({
      libraryRoot,
      env: sanitizedTestEnv({ DSH_HOME: dshHome }),
      home: join(base, 'home'),
      documentsDir: base,
      injectedComplete: createRubricStubComplete(() => {
        modelCalls += 1;
      }),
      providerDiscovery: fakeDiscovery(),
      skipAutoProbe: true,
      language: 'zh',
      eventDebounceMs: 30,
    });

    const tty = createVirtualTty(120, 36);
    let inkInst = null;
    try {
      const { run } = await seedPendingRubricRun(host, 'zh');
      const callsBeforeUi = modelCalls;

      resetDistStore('zh', false, {
        page: 'review',
        activeRunId: run.id,
        navContext: { runId: run.id },
      });

      inkInst = render(
        React.createElement(StudyHubTuiApp, {
          host,
          initialPage: 'review',
          initialLanguage: 'zh',
          initialAsciiMode: false,
          autoLaunchpad: false,
          onExit: () => inkInst?.unmount(),
        }),
        {
          stdin: tty.stdin,
          stdout: tty.stdout,
          stderr: tty.stderr,
          interactive: true,
          exitOnCtrlC: false,
          patchConsole: false,
        },
      );
      await tty.firstFramePromise;

      const initialScreen = await tty.waitFor(
        (s) => s.includes('待确认订正 · 按 [K] 确认并加入本轮重练') && s.includes('J  改分') && s.includes('K  确认订正'),
        { timeoutMs: 10_000, label: 'zh ReviewView correction pending notice & [K]/[J] hints' },
      );
      tty.assertHealthyScreen(initialScreen, 120, 36, '120x36 zh initial correctionPending');

      tty.send('K');
      const afterAckScreen = await tty.waitFor(
        (s) => s.includes('已确认订正并加入本轮重练') && !s.includes('待确认订正'),
        { timeoutMs: 8_000, label: 'zh ReviewView after [K] correction ack' },
      );
      tty.assertHealthyScreen(afterAckScreen, 120, 36, '120x36 zh after [K] ack');
      assert.ok(afterAckScreen.includes('已确认订正并加入本轮重练'));
      assert.ok(!afterAckScreen.includes('待确认订正'));
      assert.equal(modelCalls, callsBeforeUi);

      // Open GradeAdjustModal with [J], verify Esc cancels cleanly
      tty.send('J');
      const modalScreen = await tty.waitFor(
        (s) => s.includes('手动调整 AI 评分') && s.includes('[4]'),
        { timeoutMs: 5_000, label: 'zh GradeAdjustModal opened' },
      );
      tty.assertHealthyScreen(modalScreen, 120, 36, '120x36 zh GradeAdjustModal');
      assert.ok(modalScreen.includes('手动调整 AI 评分'));
      assert.ok(modalScreen.includes('[4]'));

      tty.send('\x1b');
      await tty.flush(60);
      const afterEscAdj = await tty.waitFor(
        (s) => !s.includes('手动调整 AI 评分'),
        { timeoutMs: 5_000, label: 'zh GradeAdjustModal Esc cancel' },
      );
      assert.ok(!afterEscAdj.includes('手动调整 AI 评分'));
      assert.equal(modelCalls, callsBeforeUi);

      // Reopen [J], navigate with 'j' x 4 to grade 4 and confirm with Enter
      tty.send('J');
      await tty.waitFor(
        (s) => s.includes('手动调整 AI 评分'),
        { timeoutMs: 5_000, label: 'zh GradeAdjustModal reopened' },
      );
      for (let step = 0; step < 4; step += 1) {
        tty.send('j');
        await tty.flush(20);
      }
      await tty.flush();
      tty.send('\r');

      const afterAdjScreen = await tty.waitFor(
        (s) => s.includes('已改分 4 (AI 原评 0)') && s.includes('已将 AI 评分调整为 4'),
        { timeoutMs: 8_000, label: 'zh ReviewView after [J] -> j/Enter grade 4 adjust' },
      );
      tty.assertHealthyScreen(afterAdjScreen, 120, 36, '120x36 zh after grade adjust');
      assert.ok(afterAdjScreen.includes('已改分 4 (AI 原评 0)'));
      assert.ok(afterAdjScreen.includes('已将 AI 评分调整为 4'));
      assert.equal(modelCalls, callsBeforeUi, 'ack & adjust in UI must trigger 0 model calls');

      const adjCheck = await host.call('review.get', { runId: run.id });
      assert.equal(adjCheck.ok, true);
      const fbAfterAdj = Helpers.extractFeedback(adjCheck.value);
      assert.equal(fbAfterAdj?.grade, 4);
      assert.equal(fbAfterAdj?.gradeOriginal, 0);
      assert.equal(fbAfterAdj?.correctionPending, false);
    } finally {
      try {
        inkInst?.unmount();
      } catch {
        // ignore
      }
      try {
        await host.dispose();
      } catch {
        // ignore
      }
      try {
        tty.dispose();
      } catch {
        // ignore
      }
      disposeTerminalPool();
    }

    await waitForNoLeakedHandles(beforeResources);
  });
});

describe('Round 53: RoundSummary Post-Round Coaching Debrief (coach.debrief) with P2 ConfirmDialog Guard', () => {
  test('1) createTuiHost integration: coach.debrief returns version 2 debrief, caches on second call (0 extra model calls), and rejects exam runs', async () => {
    const base = await temps.make('r53-host');
    const libraryRoot = join(base, 'library');
    await cloneSampleLibrary('en', libraryRoot);
    let modelCalls = 0;
    const host = await createTuiHost({
      libraryRoot,
      env: sanitizedTestEnv({ DSH_HOME: join(base, 'dsh-home') }),
      home: base,
      documentsDir: base,
      injectedComplete: createDebriefStubComplete(() => {
        modelCalls += 1;
      }),
      providerDiscovery: fakeDiscovery(),
      skipAutoProbe: true,
      language: 'en',
    });

    try {
      const { deckId, run } = await seedFlashcardRun(host, 3);
      assert.equal(modelCalls, 0, 'seeding run must make 0 model calls');

      let currentRun = run;
      const total = currentRun.navigation?.length ?? 0;
      assert.equal(total, 3, 'seeded path run must have 3 cards');
      for (let i = 0; i < total; i += 1) {
        if (currentRun.index !== i) {
          const moved = await host.call('review.move', { runId: currentRun.id, index: i });
          assert.equal(moved.ok, true, moved.error?.message);
          currentRun = moved.value;
        }
        const cardId = currentRun.card?.id || currentRun.navigation?.[i]?.cardId;
        assert.ok(cardId, `run must expose active cardId at step ${i}`);
        const rev = await host.call('review.reveal', { runId: currentRun.id, cardId });
        assert.equal(rev.ok, true, rev.error?.message);
        const ans = await host.call('review.answer', { runId: currentRun.id, cardId, grade: 4 });
        assert.equal(ans.ok, true, ans.error?.message);
        currentRun = ans.value;
      }
      assert.equal(currentRun.answered, 3, 'all 3 cards must be answered');
      assert.equal(modelCalls, 0, 'answering flashcards must make 0 model calls');

      const firstDebrief = await host.call('coach.debrief', { runId: run.id });
      assert.equal(firstDebrief.ok, true, firstDebrief.error?.message);
      assert.equal(firstDebrief.value?.version, 2);
      assert.equal(firstDebrief.value?.answered, 3);
      assert.equal(firstDebrief.value?.headline, 'Stubbed AI Coach Headline');
      assert.equal(firstDebrief.value?.why, 'Stubbed AI Coach explanation grounded in this round performance.');
      assert.equal(firstDebrief.value?.next, 'continue_path');
      assert.equal(typeof firstDebrief.value?.headline, 'string');
      assert.equal(modelCalls, 1, 'first coach.debrief with 3 answered must make exactly 1 model call');

      const secondDebrief = await host.call('coach.debrief', { runId: run.id });
      assert.equal(secondDebrief.ok, true, secondDebrief.error?.message);
      assert.equal(secondDebrief.value?.version, 2);
      assert.equal(secondDebrief.value?.answered, 3);
      assert.equal(secondDebrief.value?.headline, firstDebrief.value?.headline);
      assert.equal(secondDebrief.value?.why, firstDebrief.value?.why);
      assert.equal(secondDebrief.value?.next, firstDebrief.value?.next);
      assert.equal(modelCalls, 1, 'cached coach.debrief must trigger 0 extra model calls');

      const examStart = await host.call('review.start', { mode: 'exam', deckId, count: 2, fresh: true });
      assert.equal(examStart.ok, true, examStart.error?.message);
      assert.ok(examStart.value?.id);
      const examDebrief = await host.call('coach.debrief', { runId: examStart.value.id });
      assert.equal(examDebrief.ok, false, 'coach.debrief must reject exam mode');
      assert.match(String(examDebrief.error?.message || ''), /模拟考试请看成绩单/);
      assert.equal(modelCalls, 1, 'rejected exam coach.debrief must trigger 0 extra model calls');
    } finally {
      await host.dispose();
    }
  });

  test('2) @xterm/headless PTY E2E (120x36 zh): RoundSummary [d] -> ConfirmDialog (n cancels 0 calls, y loads debrief modal, Esc & d close) with zero handle leaks', async () => {
    disposeTerminalPool();
    const beforeResources = resourceCounts();

    const base = await temps.make('r53-pty-zh');
    const dshHome = join(base, 'dsh-home');
    const libraryRoot = join(base, 'library');
    process.env.DSH_HOME = dshHome;
    await saveTuiPreferences(
      { language: 'zh', asciiMode: false, theme: 'dsh-dark', mathUnicode: false, showHints: true },
      { env: sanitizedTestEnv({ DSH_HOME: dshHome }) },
    );
    await cloneSampleLibrary('zh', libraryRoot);

    let modelCalls = 0;
    const host = await createTuiHost({
      libraryRoot,
      env: sanitizedTestEnv({ DSH_HOME: dshHome }),
      home: join(base, 'home'),
      documentsDir: base,
      injectedComplete: createDebriefStubComplete(() => {
        modelCalls += 1;
      }),
      providerDiscovery: fakeDiscovery(),
      skipAutoProbe: true,
      language: 'zh',
      eventDebounceMs: 30,
    });

    const tty = createVirtualTty(120, 36);
    let inkInst = null;
    try {
      const { run } = await seedFlashcardRun(host, 1);

      resetDistStore('zh', false, {
        page: 'review',
        activeRunId: run.id,
        navContext: { runId: run.id },
      });

      inkInst = render(
        React.createElement(StudyHubTuiApp, {
          host,
          initialPage: 'review',
          initialLanguage: 'zh',
          initialAsciiMode: false,
          autoLaunchpad: false,
          onExit: () => inkInst?.unmount(),
        }),
        {
          stdin: tty.stdin,
          stdout: tty.stdout,
          stderr: tty.stderr,
          interactive: true,
          exitOnCtrlC: false,
          patchConsole: false,
        },
      );
      await tty.firstFramePromise;

      await tty.waitFor(
        (s) => s.includes('按 [Space] 或 [Enter] 翻开答案'),
        { timeoutMs: 10_000, label: 'zh ReviewView 1-card flashcard ready' },
      );

      tty.send(' ');
      await tty.waitFor(
        (s) => s.includes('答案与解析') && s.includes('良好'),
        { timeoutMs: 8_000, label: 'zh ReviewView revealed' },
      );

      tty.send('3');
      const summaryScreen = await tty.waitFor(
        (s) => s.includes('本轮练习总结') && s.includes('AI复盘') && !s.includes('加载本轮回顾'),
        { timeoutMs: 10_000, label: 'zh RoundSummary rendered with [d] AI复盘 hint' },
      );
      tty.assertHealthyScreen(summaryScreen, 120, 36, '120x36 zh RoundSummary');
      assert.ok(summaryScreen.includes('本轮练习总结'));
      assert.ok(summaryScreen.includes('AI复盘'));

      const callsBeforeD = modelCalls;
      tty.send('d');
      const confirmScreen = await tty.waitFor(
        (s) =>
          s.includes('AI 教练本轮复盘') &&
          s.includes('获取点评 (y)') &&
          s.replace(/\s+/g, ' ').includes('教练本轮复盘点评'),
        { timeoutMs: 5_000, label: 'zh ConfirmDialog opened on [d]' },
      );
      tty.assertHealthyScreen(confirmScreen, 120, 36, '120x36 zh ConfirmDialog');
      assert.ok(confirmScreen.includes('获取点评 (y)'));
      assert.equal(modelCalls, callsBeforeD, 'opening ConfirmDialog must make 0 model calls');

      tty.send('n');
      const cancelledScreen = await tty.waitFor(
        (s) => s.includes('本轮练习总结') && !s.includes('获取点评 (y)'),
        { timeoutMs: 5_000, label: 'zh ConfirmDialog cancelled with [n]' },
      );
      tty.assertHealthyScreen(cancelledScreen, 120, 36, '120x36 zh after cancel');
      assert.ok(!cancelledScreen.includes('获取点评 (y)'));
      assert.equal(modelCalls, callsBeforeD, 'cancelling ConfirmDialog must make 0 model calls');

      tty.send('d');
      await tty.waitFor(
        (s) => s.includes('获取点评 (y)'),
        { timeoutMs: 5_000, label: 'zh ConfirmDialog reopened' },
      );
      tty.send('y');
      const debriefScreen = await tty.waitFor(
        (s) =>
          s.includes('AI 教练本轮复盘') &&
          s.includes('建议下一步') &&
          (s.includes('状态不错') || s.includes('继续学习路径')) &&
          s.includes('原因分析'),
        { timeoutMs: 8_000, label: 'zh DebriefModal rendered' },
      );
      tty.assertHealthyScreen(debriefScreen, 120, 36, '120x36 zh DebriefModal');
      assert.ok(debriefScreen.includes('AI 教练本轮复盘'));
      assert.ok(debriefScreen.includes('建议下一步'));
      assert.ok(debriefScreen.includes('原因分析'));
      assert.equal(modelCalls, callsBeforeD, '1-card run uses rules debrief with 0 model calls');

      tty.send('\x1b');
      await tty.flush(60);
      const closedScreen = await tty.waitFor(
        (s) => s.includes('本轮练习总结') && s.includes('查看复盘') && !s.includes('原因分析'),
        { timeoutMs: 5_000, label: 'zh DebriefModal closed via Esc' },
      );
      tty.assertHealthyScreen(closedScreen, 120, 36, '120x36 zh after Esc close');
      assert.ok(closedScreen.includes('查看复盘'));
      assert.ok(!closedScreen.includes('原因分析'));

      // Pressing 'd' again opens cached debrief directly without ConfirmDialog, and pressing 'd' closes it cleanly
      tty.send('d');
      const reopenedScreen = await tty.waitFor(
        (s) => s.includes('AI 教练本轮复盘') && s.includes('原因分析') && !s.includes('获取点评 (y)'),
        { timeoutMs: 5_000, label: 'zh DebriefModal reopened from cache directly' },
      );
      tty.assertHealthyScreen(reopenedScreen, 120, 36, '120x36 zh cached DebriefModal');
      assert.ok(!reopenedScreen.includes('获取点评 (y)'));
      assert.equal(modelCalls, callsBeforeD, 'cached debrief reopen must make 0 extra model calls');

      tty.send('d');
      const closedWithDScreen = await tty.waitFor(
        (s) => s.includes('本轮练习总结') && !s.includes('原因分析'),
        { timeoutMs: 5_000, label: 'zh DebriefModal closed via [d]' },
      );
      tty.assertHealthyScreen(closedWithDScreen, 120, 36, '120x36 zh after [d] close');
      assert.ok(closedWithDScreen.includes('本轮练习总结'));
      assert.ok(!closedWithDScreen.includes('原因分析'));
    } finally {
      try {
        inkInst?.unmount();
      } catch {
        // ignore
      }
      try {
        await host.dispose();
      } catch {
        // ignore
      }
      try {
        tty.dispose();
      } catch {
        // ignore
      }
      disposeTerminalPool();
    }

    await waitForNoLeakedHandles(beforeResources);
  });
});

describe('Round 54: CardToolsModal [R] Failed Rewrite Retry (coach.rewrite.retry) with P2 Guard & HelpOverlay Sync', () => {
  test('1) createTuiHost integration: coach.rewrite.retry on card without failed rewrite returns normalized error with 0 model calls', async () => {
    const base = await temps.make('r54-host');
    const libraryRoot = join(base, 'library');
    await cloneSampleLibrary('zh', libraryRoot);
    let modelCalls = 0;
    const host = await createTuiHost({
      libraryRoot,
      env: sanitizedTestEnv({ DSH_HOME: join(base, 'dsh-home') }),
      home: base,
      documentsDir: base,
      injectedComplete: async () => {
        modelCalls += 1;
        throw new Error('Unexpected model call during coach.rewrite.retry negative test');
      },
      providerDiscovery: fakeDiscovery(),
      skipAutoProbe: true,
      language: 'zh',
    });

    try {
      const { deckId, cards } = await seedFlashcardRun(host, 1);
      const cardId = cards[0].id;
      assert.equal(modelCalls, 0, 'seeding sample deck must make 0 model calls');

      const retryRes = await host.call('coach.rewrite.retry', { deckId, cardId });
      assert.equal(retryRes.ok, false, 'coach.rewrite.retry without failed rewrite must fail cleanly');
      assert.match(String(retryRes.error?.message || ''), /没有待重试的改题/);
      assert.equal(modelCalls, 0, 'coach.rewrite.retry without failed rewrite must trigger 0 model calls');
    } finally {
      await host.dispose();
    }
  });

  test('2) @xterm/headless PTY E2E (120x36 zh): CardToolsModal [R] -> P2 ConfirmDialog (n cancels 0 calls, y handles error toast) + HelpOverlay with zero handle leaks', async () => {
    disposeTerminalPool();
    const beforeResources = resourceCounts();

    const base = await temps.make('r54-pty-zh');
    const dshHome = join(base, 'dsh-home');
    const libraryRoot = join(base, 'library');
    process.env.DSH_HOME = dshHome;
    await saveTuiPreferences(
      { language: 'zh', asciiMode: false, theme: 'dsh-dark', mathUnicode: false, showHints: true },
      { env: sanitizedTestEnv({ DSH_HOME: dshHome }) },
    );
    await cloneSampleLibrary('zh', libraryRoot);

    let modelCalls = 0;
    const host = await createTuiHost({
      libraryRoot,
      env: sanitizedTestEnv({ DSH_HOME: dshHome }),
      home: join(base, 'home'),
      documentsDir: base,
      injectedComplete: async () => {
        modelCalls += 1;
        throw new Error('Unexpected model call in Round 54 zh PTY E2E');
      },
      providerDiscovery: fakeDiscovery(),
      skipAutoProbe: true,
      language: 'zh',
      eventDebounceMs: 30,
    });

    const tty = createVirtualTty(120, 36);
    let inkInst = null;
    try {
      const { run } = await seedFlashcardRun(host, 1);

      resetDistStore('zh', false, {
        page: 'review',
        activeRunId: run.id,
        navContext: { runId: run.id },
      });

      inkInst = render(
        React.createElement(StudyHubTuiApp, {
          host,
          initialPage: 'review',
          initialLanguage: 'zh',
          initialAsciiMode: false,
          autoLaunchpad: false,
          onExit: () => inkInst?.unmount(),
        }),
        {
          stdin: tty.stdin,
          stdout: tty.stdout,
          stderr: tty.stderr,
          interactive: true,
          exitOnCtrlC: false,
          patchConsole: false,
        },
      );
      await tty.firstFramePromise;

      await tty.waitFor(
        (s) => s.includes('按 [Space] 或 [Enter] 翻开答案'),
        { timeoutMs: 10_000, label: 'zh ReviewView ready' },
      );

      tty.send('D');
      const menuScreen = await tty.waitFor(
        (s) => s.includes('题目工具箱') && s.includes('[R] 重试失败的 AI 改题') && s.includes('重试任务'),
        { timeoutMs: 8_000, label: 'zh CardToolsModal menu rendered with [R]' },
      );
      tty.assertHealthyScreen(menuScreen, 120, 36, '120x36 zh CardToolsModal menu');
      assert.ok(menuScreen.includes('题目工具箱'));
      assert.ok(menuScreen.includes('[R] 重试失败的 AI 改题'));
      assert.equal(modelCalls, 0, 'opening CardToolsModal must make 0 model calls');

      tty.send('R');
      const confirmScreen = await tty.waitFor(
        (s) =>
          s.includes('重试 AI 改题任务') &&
          s.includes('确认重试 (y)') &&
          s.includes('重新排队'),
        { timeoutMs: 5_000, label: 'zh ConfirmDialog opened on [R]' },
      );
      tty.assertHealthyScreen(confirmScreen, 120, 36, '120x36 zh ConfirmDialog');
      assert.ok(confirmScreen.includes('重试 AI 改题任务'));
      assert.ok(confirmScreen.includes('确认重试 (y)'));
      assert.equal(modelCalls, 0, 'opening P2 ConfirmDialog must make 0 model calls');

      tty.send('n');
      const cancelledScreen = await tty.waitFor(
        (s) => s.includes('[R] 重试失败的 AI 改题') && !s.includes('确认重试 (y)'),
        { timeoutMs: 5_000, label: 'zh ConfirmDialog cancelled via [n]' },
      );
      tty.assertHealthyScreen(cancelledScreen, 120, 36, '120x36 zh CardToolsModal after cancel');
      assert.ok(!cancelledScreen.includes('确认重试 (y)'));
      assert.equal(modelCalls, 0, 'cancelling ConfirmDialog must make 0 model calls');

      tty.send('R');
      await tty.waitFor(
        (s) => s.includes('确认重试 (y)'),
        { timeoutMs: 5_000, label: 'zh ConfirmDialog reopened on [R]' },
      );
      tty.send('y');
      const retryResultScreen = await tty.waitFor(
        (s) =>
          s.includes('[R] 重试失败的 AI 改题') &&
          !s.includes('确认重试 (y)') &&
          s.includes('没有待重试的改题'),
        { timeoutMs: 8_000, label: 'zh coach.rewrite.retry handled cleanly with error toast/info' },
      );
      tty.assertHealthyScreen(retryResultScreen, 120, 36, '120x36 zh after coach.rewrite.retry');
      assert.ok(retryResultScreen.includes('没有待重试的改题'));
      assert.equal(modelCalls, 0, 'coach.rewrite.retry without failed task must make 0 model calls');

      // Round 77: CardToolsModal edit mode Esc dirty guard (clean Esc immediate, dirty Esc confirms)
      tty.send('1');
      await tty.waitFor((s) => s.includes('1. 题干 (prompt)') && !s.includes('未保存'), {
        timeoutMs: 5_000,
        label: 'CardToolsModal edit mode opened clean',
      });
      tty.send('\x1b');
      await tty.waitFor((s) => s.includes('[R] 重试失败的 AI 改题') && !s.includes('1. 题干 (prompt)'), {
        timeoutMs: 5_000,
        label: 'Clean CardToolsModal edit Esc returned immediately to menu',
      });
      tty.send('1');
      await tty.waitFor((s) => s.includes('1. 题干 (prompt)'), {
        timeoutMs: 5_000,
        label: 'CardToolsModal edit mode reopened',
      });
      tty.send('UNSAVED_R77_CARD');
      await tty.waitFor((s) => s.includes('UNSAVED_R77_CARD') && s.includes('未保存'), {
        timeoutMs: 5_000,
        label: 'CardToolsModal edit shows unsaved badge',
      });
      tty.send('\x1b');
      const cardDiscardScreen = await tty.waitFor((s) => s.includes('放弃未保存的题目修改'), {
        timeoutMs: 5_000,
        label: 'CardToolsModal dirty Esc opened ConfirmDialog',
      });
      tty.assertHealthyScreen(cardDiscardScreen, 120, 36, 'CardToolsModal discard ConfirmDialog');
      tty.send('n');
      await tty.waitFor(
        (s) => !s.includes('放弃未保存的题目修改') && s.includes('1. 题干 (prompt)') && s.includes('UNSAVED_R77_CARD'),
        { timeoutMs: 5_000, label: 'CardToolsModal cancel discard preserved edit' },
      );
      tty.send('\x1b');
      await tty.waitFor((s) => s.includes('放弃未保存的题目修改'), {
        timeoutMs: 5_000,
        label: 'CardToolsModal discard ConfirmDialog reopened',
      });
      tty.send('y');
      await tty.waitFor(
        (s) => !s.includes('放弃未保存的题目修改') && !s.includes('1. 题干 (prompt)') && s.includes('[R] 重试失败的 AI 改题'),
        { timeoutMs: 5_000, label: 'CardToolsModal confirm discard restored menu' },
      );

      tty.send('\x1b');
      await tty.flush(60);
      const closedTools = await tty.waitFor(
        (s) => !s.includes('题目工具箱') && s.includes('按 [Space] 或 [Enter] 翻开答案'),
        { timeoutMs: 5_000, label: 'zh CardToolsModal closed' },
      );
      assert.ok(!closedTools.includes('题目工具箱'));

      tty.send('?');
      const helpOpenScreen = await tty.waitFor(
        (s) => s.includes('快捷键') && s.includes('全局'),
        { timeoutMs: 5_000, label: 'zh HelpOverlay opened' },
      );
      tty.assertHealthyScreen(helpOpenScreen, 120, 36, '120x36 zh HelpOverlay');

      let helpReviewScreen = helpOpenScreen;
      for (let step = 0; step < 20 && !helpReviewScreen.includes('卡片工具 (编辑/反馈/重试改题)'); step += 1) {
        const prev = helpReviewScreen;
        tty.send('\x04');
        helpReviewScreen = await tty.waitFor((s) => s !== prev, {
          timeoutMs: 2_000,
          label: `zh HelpOverlay scroll #${step + 1} for Review [D]`,
        }).catch(() => tty.readScreen());
      }
      assert.ok(
        helpReviewScreen.includes('卡片工具 (编辑/反馈/重试改题)'),
        `zh HelpOverlay must include updated Review [D] label.\n${helpReviewScreen}`,
      );
      tty.assertHealthyScreen(helpReviewScreen, 120, 36, '120x36 zh HelpOverlay Review [D]');

      let helpNotesScreen = helpReviewScreen;
      for (
        let step = 0;
        step < 20 && !(helpNotesScreen.includes('AI起草笔记正文') && helpNotesScreen.includes('停止笔记/每日总结生成'));
        step += 1
      ) {
        const prev = helpNotesScreen;
        tty.send('\x04');
        helpNotesScreen = await tty.waitFor((s) => s !== prev, {
          timeoutMs: 2_000,
          label: `zh HelpOverlay scroll #${step + 1} for Skeleton & Notes`,
        }).catch(() => tty.readScreen());
      }
      assert.ok(
        helpNotesScreen.includes('AI起草笔记正文') && helpNotesScreen.includes('停止笔记/每日总结生成'),
        `zh HelpOverlay must include Skeleton & Notes [g] and [C] labels.\n${helpNotesScreen}`,
      );
      tty.assertHealthyScreen(helpNotesScreen, 120, 36, '120x36 zh HelpOverlay Skeleton & Notes');

      tty.send('\x1b');
      await tty.flush(60);
      const helpClosed = await tty.waitFor(
        (s) => !s.includes('快捷键'),
        { timeoutMs: 5_000, label: 'zh HelpOverlay closed' },
      );
      assert.ok(!helpClosed.includes('快捷键'));
      assert.equal(useDistTuiStore.getState().helpOpen, false);
      assert.equal(useDistTuiStore.getState().page, 'review');
      assert.equal(modelCalls, 0);
    } finally {
      try {
        inkInst?.unmount();
      } catch {
        // ignore
      }
      try {
        await host.dispose();
      } catch {
        // ignore
      }
      try {
        tty.dispose();
      } catch {
        // ignore
      }
      disposeTerminalPool();
    }

    await waitForNoLeakedHandles(beforeResources);
  });
});

describe('Round 60 Track 1: CoachNudgeModal (coach.nudge + coach.reply) with P2 ConfirmDialog Guard', () => {
  test('1) Unit & live render guard: normalizeAsciiChrome strips Unicode chrome from LLM nudge/followup text and CoachNudgeModal renders ASCII-clean output', async () => {
    const rawNudge = 'TCP vs UDP reliability … ✓ → •';
    const clean = normalizeAsciiChrome(rawNudge, true);
    assert.equal(clean.match(UNICODE_UI_CHROME_RE), null, `ASCII sanitized output must have zero Unicode chrome: ${clean}`);
    assert.ok(clean.includes('...'), 'ellipsis must downgrade to ... in ASCII mode');
    assert.ok(clean.includes('OK'), 'checkmark must downgrade to OK in ASCII mode');
    assert.ok(clean.includes('Right'), 'arrow must downgrade to Right in ASCII mode');
    assert.equal(normalizeAsciiChrome('keep original ✓', false), 'keep original ✓');
    assert.equal(normalizeAsciiChrome('▸ Item • ☑ Done ☐ Todo ⚠ Warn', true).match(UNICODE_UI_CHROME_RE), null);

    const [{ CoachNudgeModal }, { useTuiStore }] = await Promise.all([
      import('../src/views/review/CoachNudgeModal.tsx'),
      import('../src/state/store.ts'),
    ]);
    const prevPrefs = useTuiStore.getState().preferences;
    useTuiStore.setState({ preferences: { ...DEFAULT_PREFERENCES, language: 'en', asciiMode: true } });
    const tty = createVirtualTty(100, 26);
    let inst = null;
    try {
      inst = render(
        React.createElement(
          Box,
          { width: 100, height: 26 },
          React.createElement(CoachNudgeModal, {
            host: {
              call: async () => ({ ok: true, value: {} }),
              onEvent: () => () => {},
              dispose: async () => {},
            },
            run: {
              id: 'run-ascii',
              title: 'Network',
              index: 0,
              total: 1,
              answered: 0,
              revealed: false,
              card: { id: 'c1', deckId: 'd1', kind: 'short', prompt: 'Explain TCP vs UDP' },
            },
            cardId: 'c1',
            width: 96,
            height: 24,
            isActive: false,
            initialNote: {
              id: 'n1',
              type: 'nudge',
              runId: 'run-ascii',
              entryIndex: 0,
              point: 'TCP vs UDP reliability … ✓',
              explain: 'Ordered delivery → • check ACK',
            },
            onClose: () => {},
          }),
        ),
        { stdin: tty.stdin, stdout: tty.stdout, stderr: tty.stderr, interactive: true, exitOnCtrlC: false, patchConsole: false },
      );
      await tty.waitFor((s) => s.includes('TCP vs UDP reliability'), { timeoutMs: 4_000, label: 'CoachNudgeModal ASCII render' });
      const screen = tty.readScreen();
      assert.equal(screen.match(UNICODE_UI_CHROME_RE), null, `CoachNudgeModal ASCII screen must not leak Unicode chrome:\n${screen}`);
      assert.ok(screen.includes('...'), 'CoachNudgeModal must downgrade ellipsis to ... in ASCII mode');
    } finally {
      try {
        inst?.unmount();
      } catch {
        // ignore
      }
      tty.dispose();
      useTuiStore.setState({ preferences: prevPrefs });
    }
  });

  test('2) createTuiHost integration: coach.nudge + coach.reply (check / got / confused) round-trip cleanly with strict call counts', async () => {
    const base = await temps.make('r60-host');
    let nudgeCalls = 0;
    let followupCalls = 0;
    const host = await createTuiHost({
      libraryRoot: join(base, 'library'),
      env: sanitizedTestEnv({ DSH_HOME: join(base, 'dsh-home') }),
      home: base,
      documentsDir: base,
      injectedComplete: createNudgeStubComplete({
        lang: 'en',
        onNudge: () => {
          nudgeCalls += 1;
        },
        onFollowup: () => {
          followupCalls += 1;
        },
      }),
      providerDiscovery: fakeDiscovery(),
      skipAutoProbe: true,
      language: 'en',
    });

    try {
      const { deckId, run } = await seedTwoCardQuizDeckAndRun(host, 'en');
      const cardId = run.card?.id || run.navigation?.[0]?.cardId;
      assert.ok(cardId, 'first card id must exist');

      const wrongAns = await host.call('review.answer', {
        runId: run.id,
        cardId,
        selected: ['b'],
        queueVersion: run.queueVersion ?? 0,
      });
      assert.equal(wrongAns.ok, true, wrongAns.error?.message);
      assert.equal(nudgeCalls + followupCalls, 0, 'answering quiz card must make 0 coach calls');

      const nudgeRes = await host.call('coach.nudge', { runId: run.id, index: 0 });
      assert.equal(nudgeRes.ok, true, nudgeRes.error?.message);
      assert.equal(nudgeCalls, 1, 'first coach.nudge must make 1 model call');
      assert.equal(followupCalls, 0);
      const note = (nudgeRes.value?.thread || []).find((n) => n.type === 'nudge' && n.runId === run.id && n.entryIndex === 0);
      assert.ok(note?.id, 'nudge note must be returned');
      assert.equal(note.type, 'nudge');
      assert.equal(note.entryIndex, 0);
      assert.equal(note.point, 'TCP vs UDP reliability confusion');
      assert.ok(note.explain?.includes('TCP ensures ordered delivery'));
      assert.ok(note.check?.q && Array.isArray(note.check.options) && note.check.options.length === 2);
      assert.equal(note.check.answer, undefined, 'unanswered check must hide answer key');

      const cachedNudge = await host.call('coach.nudge', { runId: run.id, index: 0 });
      assert.equal(cachedNudge.ok, true, cachedNudge.error?.message);
      assert.equal(nudgeCalls, 1, 'cached coach.nudge must trigger 0 extra model calls');

      const checkRes = await host.call('coach.reply', { noteId: note.id, reply: 'check', choice: 0 });
      assert.equal(checkRes.ok, true, checkRes.error?.message);
      assert.equal(nudgeCalls, 1);
      assert.equal(followupCalls, 0, 'reply: check must make 0 model calls');
      const checkedNote = (checkRes.value?.thread || []).find((n) => n.id === note.id);
      assert.deepEqual(checkedNote?.checked, { choice: 0, correct: true });
      assert.ok(checkedNote?.check?.why, 'answered check must reveal why');

      const f1 = await host.call('coach.reply', { noteId: note.id, reply: 'confused' });
      assert.equal(f1.ok, true, f1.error?.message);
      assert.equal(followupCalls, 1, 'first confused reply must make 1 followup model call');
      const f1Note = (f1.value?.thread || []).find((n) => n.id === note.id);
      assert.equal(f1Note?.followups?.length, 1);
      assert.ok(f1Note?.followups?.[0]?.explain?.includes('Simpler analogy angle 1'));
      assert.equal(f1Note?.reply, 'confused');

      const f2 = await host.call('coach.reply', { noteId: note.id, reply: 'confused' });
      assert.equal(f2.ok, true, f2.error?.message);
      assert.equal(followupCalls, 2, 'second confused reply must make 1 followup model call');
      const f2Note = (f2.value?.thread || []).find((n) => n.id === note.id);
      assert.equal(f2Note?.followups?.length, 2);
      assert.ok(f2Note?.followups?.[1]?.explain?.includes('Simpler analogy angle 2'));

      const f3 = await host.call('coach.reply', { noteId: note.id, reply: 'confused' });
      assert.equal(f3.ok, true, f3.error?.message);
      assert.equal(followupCalls, 2, 'third confused reply must make 0 extra model calls');
      const f3Note = (f3.value?.thread || []).find((n) => n.id === note.id);
      assert.equal(f3Note?.followups?.length, 2);

      const gotRes = await host.call('coach.reply', { noteId: note.id, reply: 'got' });
      assert.equal(gotRes.ok, true, gotRes.error?.message);
      assert.equal(followupCalls, 2, 'reply: got must make 0 model calls');
      const gotNote = (gotRes.value?.thread || []).find((n) => n.id === note.id);
      assert.equal(gotNote?.reply, 'got');

      const examStart = await host.call('review.start', { mode: 'exam', deckId, count: 2, fresh: true });
      assert.equal(examStart.ok, true, examStart.error?.message);
      const examCardId = examStart.value.card?.id || examStart.value.navigation?.[0]?.cardId;
      assert.ok(examCardId);
      const examAns = await host.call('review.answer', {
        runId: examStart.value.id,
        cardId: examCardId,
        selected: ['b'],
        queueVersion: examStart.value.queueVersion ?? 0,
      });
      assert.equal(examAns.ok, true);
      const examNudge = await host.call('coach.nudge', { runId: examStart.value.id, index: 0 });
      assert.equal(examNudge.ok, false, 'coach.nudge must reject exam mode');
      assert.ok(examNudge.error?.message);
      assert.equal(nudgeCalls, 1, 'rejected exam coach.nudge must make 0 model calls');
    } finally {
      await host.dispose();
    }
  });

  test('3) @xterm/headless PTY E2E (120x36 zh): wrong answer -> [N] preview (0 calls) -> [g] ConfirmDialog -> [n] cancel -> [g]+[y] (1 call) -> [1] check -> [c]+[y] followup (2nd call) -> [o] got -> Esc closes', async () => {
    disposeTerminalPool();
    const beforeResources = resourceCounts();
    const base = await temps.make('r60-pty-zh');
    const dshHome = join(base, 'dsh-home');
    process.env.DSH_HOME = dshHome;
    await saveTuiPreferences(
      { language: 'zh', asciiMode: false, theme: 'dsh-dark', mathUnicode: false, showHints: true },
      { env: sanitizedTestEnv({ DSH_HOME: dshHome }) },
    );

    let modelCalls = 0;
    const host = await createTuiHost({
      libraryRoot: join(base, 'library'),
      env: sanitizedTestEnv({ DSH_HOME: dshHome }),
      home: join(base, 'home'),
      documentsDir: base,
      injectedComplete: createNudgeStubComplete({
        lang: 'zh',
        onNudge: () => {
          modelCalls += 1;
        },
        onFollowup: () => {
          modelCalls += 1;
        },
      }),
      providerDiscovery: fakeDiscovery(),
      skipAutoProbe: true,
      language: 'zh',
      eventDebounceMs: 30,
    });

    const tty = createVirtualTty(120, 36);
    let inkInst = null;
    try {
      const { run } = await seedTwoCardQuizDeckAndRun(host, 'zh');

      resetDistStore('zh', false, {
        page: 'review',
        activeRunId: run.id,
        navContext: { runId: run.id },
      });

      inkInst = render(
        React.createElement(StudyHubTuiApp, {
          host,
          initialPage: 'review',
          initialLanguage: 'zh',
          initialAsciiMode: false,
          autoLaunchpad: false,
          onExit: () => inkInst?.unmount(),
        }),
        {
          stdin: tty.stdin,
          stdout: tty.stdout,
          stderr: tty.stderr,
          interactive: true,
          exitOnCtrlC: false,
          patchConsole: false,
        },
      );
      await tty.firstFramePromise;

      const qScreen = await tty.waitFor(
        (s) => s.includes('哪种协议提供可靠的面向连接字节流传输') || s.includes('HTTPS 默认使用哪个端口'),
        { timeoutMs: 10_000, label: 'zh ReviewView question ready' },
      );
      assert.ok(qScreen.includes('哪种协议提供可靠的面向连接字节流传输') || qScreen.includes('HTTPS 默认使用哪个端口'));

      tty.send('N');
      const beforeAnsHint = await tty.waitFor(
        (s) => s.includes('请先作答且答错或自评低于3分'),
        { timeoutMs: 5_000, label: 'zh friendly hint on N before answering' },
      );
      assert.ok(beforeAnsHint.includes('请先作答且答错或自评低于3分'));
      assert.equal(modelCalls, 0);

      tty.send(findWrongOptionKey(qScreen));
      const wrongScreen = await tty.waitFor(
        (s) => s.includes('回答有误') && s.includes('陪学点拨'),
        { timeoutMs: 8_000, label: 'zh wrong answer feedback with N nudge hint' },
      );
      tty.assertHealthyScreen(wrongScreen, 120, 36, '120x36 zh wrong feedback');
      assert.ok(wrongScreen.includes('回答有误'));
      assert.ok(wrongScreen.includes('陪学点拨'));
      assert.equal(modelCalls, 0);

      tty.send('N');
      const previewScreen = await tty.waitFor(
        (s) => s.includes('AI 陪学点拨') && s.includes('0 模型调用预览') && s.includes('生成陪学点拨'),
        { timeoutMs: 8_000, label: 'zh CoachNudgeModal preview opened' },
      );
      tty.assertHealthyScreen(previewScreen, 120, 36, '120x36 zh CoachNudgeModal preview');
      assert.ok(previewScreen.includes('0 模型调用预览'));
      assert.equal(modelCalls, 0, 'opening CoachNudgeModal must trigger 0 model calls');

      tty.send('g');
      const confirmNudgeScreen = await tty.waitFor(
        (s) => s.includes('开启 AI 陪学点拨') && s.includes('生成点拨 (y)'),
        { timeoutMs: 5_000, label: 'zh ConfirmDialog for coach.nudge' },
      );
      tty.assertHealthyScreen(confirmNudgeScreen, 120, 36, '120x36 zh ConfirmDialog nudge');
      assert.ok(confirmNudgeScreen.includes('生成点拨 (y)'));
      assert.equal(modelCalls, 0, 'opening ConfirmDialog must trigger 0 model calls');

      tty.send('n');
      const afterCancelScreen = await tty.waitFor(
        (s) => s.includes('0 模型调用预览') && !s.includes('生成点拨 (y)'),
        { timeoutMs: 5_000, label: 'zh ConfirmDialog cancelled with n' },
      );
      tty.assertHealthyScreen(afterCancelScreen, 120, 36, '120x36 zh after cancel');
      assert.ok(!afterCancelScreen.includes('生成点拨 (y)'));
      assert.equal(modelCalls, 0, 'cancelling ConfirmDialog must trigger 0 model calls');

      tty.send('g');
      await tty.waitFor(
        (s) => s.includes('生成点拨 (y)'),
        { timeoutMs: 5_000, label: 'zh ConfirmDialog reopened' },
      );
      tty.send('y');
      const nudgeLoadedScreen = await tty.waitFor(
        (s) =>
          s.includes('混淆了 TCP 与 UDP 的可靠性机制') &&
          s.includes('你选了 UDP') &&
          s.includes('有序传输') &&
          s.includes('哪种传输协议提供面向连接的可靠字节流') &&
          s.includes('TCP 协议'),
        { timeoutMs: 8_000, label: 'zh nudge loaded with point, explain, check' },
      );
      tty.assertHealthyScreen(nudgeLoadedScreen, 120, 36, '120x36 zh nudge loaded');
      assert.ok(nudgeLoadedScreen.includes('混淆了 TCP 与 UDP 的可靠性机制'));
      assert.ok(nudgeLoadedScreen.includes('TCP 协议'));
      assert.equal(modelCalls, 1, 'confirming coach.nudge must trigger exactly 1 model call');

      tty.send('1');
      const checkDoneScreen = await tty.waitFor(
        (s) => s.includes('小检查答对了') && s.includes('超时重传保证数据可靠到达'),
        { timeoutMs: 8_000, label: 'zh quick check answered with why' },
      );
      tty.assertHealthyScreen(checkDoneScreen, 120, 36, '120x36 zh check answered');
      assert.ok(checkDoneScreen.includes('小检查答对了'));
      assert.equal(modelCalls, 1, 'answering quick check must trigger 0 extra model calls');

      tty.send('c');
      const confirmConfusedScreen = await tty.waitFor(
        (s) => s.includes('换个角度再讲') && s.includes('继续讲解 (y)'),
        { timeoutMs: 5_000, label: 'zh ConfirmDialog for confused' },
      );
      tty.assertHealthyScreen(confirmConfusedScreen, 120, 36, '120x36 zh ConfirmDialog confused');
      assert.ok(confirmConfusedScreen.includes('继续讲解 (y)'));
      assert.equal(modelCalls, 1, 'opening confused ConfirmDialog must trigger 0 extra model calls');

      tty.send('y');
      const followupScreen = await tty.waitFor(
        (s) => s.includes('生活类比角度 1') && s.includes('互发回执确认收发能力'),
        { timeoutMs: 8_000, label: 'zh followup angle rendered' },
      );
      tty.assertHealthyScreen(followupScreen, 120, 36, '120x36 zh followup rendered');
      assert.ok(followupScreen.includes('生活类比角度 1'));
      assert.equal(modelCalls, 2, 'confirming confused must trigger 2nd model call');

      tty.send('o');
      const gotScreen = await tty.waitFor(
        (s) => s.includes('已理解'),
        { timeoutMs: 8_000, label: 'zh got reply marked understood' },
      );
      tty.assertHealthyScreen(gotScreen, 120, 36, '120x36 zh got reply');
      assert.ok(gotScreen.includes('已理解'));
      assert.equal(modelCalls, 2, 'reply got must trigger 0 extra model calls');

      tty.send('\u001b');
      await tty.flush(60);
      const closedScreen = await tty.waitFor(
        (s) => s.includes('回答有误') && !s.includes('0 模型调用预览') && !s.includes('混淆了 TCP 与 UDP 的可靠性机制'),
        { timeoutMs: 5_000, label: 'zh Esc closes CoachNudgeModal cleanly' },
      );
      tty.assertHealthyScreen(closedScreen, 120, 36, '120x36 zh after Esc');
      assert.ok(!closedScreen.includes('混淆了 TCP 与 UDP 的可靠性机制'));
    } finally {
      try {
        inkInst?.unmount();
      } catch {
        // ignore
      }
      try {
        tty.dispose();
      } catch {
        // ignore
      }
      try {
        await host.dispose();
      } catch {
        // ignore
      }
      disposeTerminalPool();
    }

    await waitForNoLeakedHandles(beforeResources, ['ProcessWrap', 'TCPWrap', 'PipeWrap']);
  });
});
