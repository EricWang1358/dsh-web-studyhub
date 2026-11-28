// Consolidated Notes & Board Domain Suite (NotesView & BoardView):
// Merged from: round38-notes-e2e, round52-notes-material, round54-notes-gen-cancel,
//              round56-note-publish, round69-notes-ux, round66-board-ux
// node --test tests/domain-notes-board.test.mjs
import assert from 'node:assert/strict';
import { mkdir, readdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { after, describe, test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { render } from 'ink';
import React from 'react';
import { tsImport } from 'tsx/esm/api';
import {
  cloneSampleLibrary,
  createTempTracker,
  createVirtualTty,
  disposeTerminalPool,
  distDir,
  findExportedBackupFile,
  loadDistRuntime,
} from './helpers/virtual-tty.mjs';

const runtime = await loadDistRuntime();
const { StudyHubTuiApp, createTuiHost, saveTuiPreferences, loadTuiPreferences } = runtime;
assert.ok(StudyHubTuiApp, 'dist/ must export StudyHubTuiApp');
assert.ok(createTuiHost, 'dist/ must export createTuiHost');
assert.ok(saveTuiPreferences, 'dist/ must export saveTuiPreferences');
assert.ok(loadTuiPreferences, 'dist/ must export loadTuiPreferences');

const distFiles = (await readdir(distDir)).filter((f) => f.endsWith('.mjs') && f !== 'cli.mjs');
const storeFile = distFiles.find((f) => f.startsWith('store-') && f.endsWith('.mjs'));
assert.ok(storeFile, 'dist/ must include store-*.mjs');
const { useTuiStore, DEFAULT_PREFERENCES } = await import(pathToFileURL(join(distDir, storeFile)).href);
assert.ok(useTuiStore, 'dist/store-*.mjs must export useTuiStore');
assert.ok(DEFAULT_PREFERENCES, 'dist/store-*.mjs must export DEFAULT_PREFERENCES');

const [{ formatBoardMarkdown }, { saveBoard, todayLocalYmd }] = await Promise.all([
  tsImport('../src/views/board/BoardView.tsx', import.meta.url),
  tsImport('../src/views/board/board-store.ts', import.meta.url),
]);
assert.equal(typeof formatBoardMarkdown, 'function', 'BoardView must export formatBoardMarkdown');
assert.equal(typeof saveBoard, 'function', 'board-store must export saveBoard');
assert.equal(typeof todayLocalYmd, 'function', 'board-store must export todayLocalYmd');

const PREV_DSH_HOME = process.env.DSH_HOME;
const temps = createTempTracker('studyhub-tui-dom-notes-board-');

const SAMPLE_GENERATED_MARKDOWN = [
  '# Operating System Virtual Memory Summary',
  '',
  'Virtual memory decouples process address spaces from physical RAM frames using multi-level page tables and TLB caching.',
  '',
  '## Worked Example',
  '',
  'Given a 4 KB page size ($2^{12}$ bytes) and a 32-bit virtual address, the low 12 bits form the page offset while the upper 20 bits select the page frame mapping.',
].join('\n');

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
      sidebarCollapsed: false,
      showKeyHints: true,
    },
    ...extra,
  });
}

after(async () => {
  resetTuiStore();
  disposeTerminalPool();
  if (PREV_DSH_HOME === undefined) delete process.env.DSH_HOME;
  else process.env.DSH_HOME = PREV_DSH_HOME;
  await temps.cleanup();
});

function waitForGateOrAbort(gatePromise, signal) {
  return new Promise((resolveFn, rejectFn) => {
    if (signal?.aborted) {
      rejectFn(signal.reason || new Error('Aborted'));
      return;
    }
    const onAbort = () => rejectFn(signal.reason || new Error('Aborted'));
    signal?.addEventListener('abort', onAbort, { once: true });
    gatePromise.then(() => {
      signal?.removeEventListener('abort', onAbort);
      resolveFn();
    });
  });
}

async function waitForNoteDone(host, noteId, timeoutMs = 8000) {
  const initial = await host.call('note.get', { id: noteId });
  if (initial.ok && initial.value?.generation?.status === 'done') return initial.value;
  return new Promise((resolveFn, rejectFn) => {
    let settled = false;
    let checking = false;
    let unsub = () => {};
    let poll = null;
    const cleanup = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (poll) clearInterval(poll);
      unsub();
    };
    // Keep timers ref'd while waiting so Node's test runner never exits early with
    // "Promise resolution is still pending but the event loop has already resolved".
    const timer = setTimeout(() => {
      if (settled) return;
      cleanup();
      rejectFn(new Error(`Timed out waiting for note ${noteId} generation=done after ${timeoutMs}ms`));
    }, timeoutMs);
    const check = async () => {
      if (settled || checking) return;
      checking = true;
      try {
        const res = await host.call('note.get', { id: noteId });
        if (!settled && res.ok && res.value?.generation?.status === 'done') {
          cleanup();
          resolveFn(res.value);
        }
      } finally {
        checking = false;
      }
    };
    poll = setInterval(() => {
      void check();
    }, 40);
    unsub = host.subscribeEvents(() => {
      void check();
    });
    void check();
  });
}

async function saveNoteStrictlyNewer(host, payload, prevUpdatedAt) {
  let res = await host.call('note.save', payload);
  while (res.ok && prevUpdatedAt && res.value?.updatedAt <= prevUpdatedAt) {
    await new Promise((r) => setImmediate(r));
    res = await host.call('note.save', {
      ...payload,
      expectedRevision: res.value?.revision ?? payload.expectedRevision,
    });
  }
  return res;
}

async function seedSampleDeckAndCard(host) {
  const snapRes = await host.call('library.snapshot', {});
  assert.equal(snapRes.ok, true, 'library.snapshot failed');
  const deckSummary =
    snapRes.value?.decks?.find((d) => !d.archived && (d.cardCount > 0 || (Array.isArray(d.cards) && d.cards.length > 0))) ||
    snapRes.value?.decks?.find((d) => !d.archived) ||
    snapRes.value?.decks?.[0];
  assert.ok(deckSummary?.id, 'sample library must contain a deck');

  const deckRes = await host.call('deck.get', { id: deckSummary.id });
  assert.equal(deckRes.ok, true, 'deck.get failed');
  const deck = deckRes.value;
  const card = deck?.cards?.[0];
  assert.ok(card?.id, 'sample deck must contain at least one card');
  return { deck, card };
}

async function scrollHelpOverlayForTargets(tty, cols, rows, targets, label, asciiMode = false) {
  const seen = new Set();
  const maxSteps = 16;
  for (let step = 0; step < maxSteps && seen.size < targets.length; step += 1) {
    const scr = tty.readScreen();
    tty.assertHealthyScreen(scr, cols, rows, `HelpOverlay scroll ${step} (${label})`);
    if (asciiMode) tty.assertAsciiPure(scr, `HelpOverlay scroll ${step} (${label})`);
    for (const target of targets) {
      if (scr.includes(target)) seen.add(target);
    }
    if (seen.size < targets.length) {
      const before = scr;
      tty.send('\x04');
      await tty.waitFor((s) => s !== before, { timeoutMs: 400, label: `HelpOverlay scroll step ${step}` }).catch(() => {});
      await tty.flush();
    }
  }
  for (const target of targets) {
    assert.ok(seen.has(target), `HelpOverlay (${label}) missing expected entry: ${target}`);
  }
}

describe('Domain Notes & Board: Host Integration & Pure Unit Tests', () => {
  test('1) Notes publish link & daily recap cancel: note.create -> note.link validation -> note.daily.generate -> note.daily.cancel', async () => {
    const base = await temps.make('notes-link-host');
    const env = { DSH_HOME: join(base, 'dsh-home') };
    const libraryRoot = join(base, 'library');
    await cloneSampleLibrary('en', libraryRoot);

    let releaseRecap = null;
    const recapGate = new Promise((resolveFn) => {
      releaseRecap = resolveFn;
    });
    let recapModelCalls = 0;

    const host = await createTuiHost({
      libraryRoot,
      env,
      home: base,
      documentsDir: base,
      skipAutoProbe: true,
      language: 'en',
      injectedComplete: async (_system, _prompt, execution = {}) => {
        recapModelCalls += 1;
        execution.signal?.throwIfAborted?.();
        await recapGate;
        execution.signal?.throwIfAborted?.();
        return '# Daily Recap\n\nSummary generated.';
      },
    });

    try {
      const { deck, card } = await seedSampleDeckAndCard(host);

      const createRes = await host.call('note.create', {
        title: 'Round 38 Publish Link Note',
        cards: [{ deckId: deck.id, cardId: card.id }],
        language: 'en',
      });
      assert.equal(createRes.ok, true, `note.create failed: ${createRes.error?.message || ''}`);
      const created = createRes.value;
      assert.ok(created?.id, 'note.create must return note id');
      assert.equal(created.title, 'Round 38 Publish Link Note');
      assert.equal(created.status, 'draft');
      assert.equal(created.cards?.length, 1);
      assert.equal(created.cards?.[0]?.deckId, deck.id);
      assert.equal(created.cards?.[0]?.cardId, card.id);
      assert.equal(created.publicUrl, undefined);
      assert.equal(typeof created.revision, 'number');

      const noHomeLinkRes = await host.call('note.link', {
        id: created.id,
        url: 'https://blog.csdn.net/r38tester/article/details/10001',
        expectedRevision: created.revision,
      });
      assert.equal(noHomeLinkRes.ok, false, 'note.link must fail before CSDN home is configured');
      assert.ok(noHomeLinkRes.error?.message, 'missing-home note.link failure must return error message');
      assert.equal(recapModelCalls, 0, 'note.link before home must make 0 model calls');

      const homeRes = await host.call('note.home', { home: 'https://blog.csdn.net/r38tester' });
      assert.equal(homeRes.ok, true, `note.home failed: ${homeRes.error?.message || ''}`);
      assert.equal(homeRes.value?.home, 'https://blog.csdn.net/r38tester');

      for (const badUrl of [
        'not-a-valid-url',
        'http://example.com/article/123',
        'https://blog.csdn.net/someone_else/article/details/12345',
      ]) {
        const badRes = await host.call('note.link', {
          id: created.id,
          url: badUrl,
          expectedRevision: created.revision,
        });
        assert.equal(badRes.ok, false, `note.link must reject invalid URL: ${badUrl}`);
        assert.ok(badRes.error?.message, `invalid URL (${badUrl}) must include error message`);
      }

      const targetUrl = 'https://blog.csdn.net/r38tester/article/details/987654';
      const linkRes = await host.call('note.link', {
        id: created.id,
        url: targetUrl,
        expectedRevision: created.revision,
      });
      assert.equal(linkRes.ok, true, `note.link failed: ${linkRes.error?.message || ''}`);
      assert.equal(linkRes.value?.id, created.id);
      assert.equal(linkRes.value?.publicUrl, targetUrl);
      assert.equal(linkRes.value?.status, 'published');
      assert.ok((linkRes.value?.revision ?? 0) > created.revision, 'note.link must increment revision');
      assert.equal(recapModelCalls, 0, 'note.link must trigger 0 model calls');

      const getRes = await host.call('note.get', { id: created.id });
      assert.equal(getRes.ok, true, 'note.get failed');
      assert.equal(getRes.value?.id, created.id);
      assert.equal(getRes.value?.title, 'Round 38 Publish Link Note');
      assert.equal(getRes.value?.publicUrl, targetUrl);
      assert.equal(getRes.value?.status, 'published');
      assert.ok(getRes.value?.createdAt, 'note.get must include createdAt');
      assert.ok(getRes.value?.updatedAt, 'note.get must include updatedAt');

      const listRes = await host.call('note.list', {});
      assert.equal(listRes.ok, true, 'note.list failed');
      assert.equal(listRes.value?.home, 'https://blog.csdn.net/r38tester');
      assert.ok((listRes.value?.notes?.length ?? 0) >= 1, 'note.list must include at least 1 note');
      const listed = listRes.value?.notes?.find((n) => n.id === created.id);
      assert.ok(listed, 'note.list must include linked note');
      assert.equal(listed.publicUrl, targetUrl);
      assert.equal(listed.status, 'published');

      const missingCancelRes = await host.call('note.daily.cancel', { id: 'nonexistent-daily-id' });
      assert.equal(missingCancelRes.ok, false, 'note.daily.cancel must fail for unknown id');
      assert.ok(missingCancelRes.error?.message, 'missing daily id error message required');

      const recapCourse = 'Round38RecapCourse';
      const importRes = await host.call('deck.import', {
        folder: recapCourse,
        text: JSON.stringify({
          title: recapCourse,
          course: recapCourse,
          cards: Array.from({ length: 10 }, (_, idx) => ({
            id: `r38-card-${idx}`,
            kind: 'quiz',
            topic: `Topic ${idx % 3}`,
            prompt: `Round 38 Question ${idx}`,
            answer: 'Right',
            explanation: 'Explanation',
            options: [
              { id: 'a', text: 'Right', correct: true },
              { id: 'b', text: 'Wrong', correct: false },
            ],
          })),
        }),
      });
      assert.equal(importRes.ok, true, `deck.import failed: ${importRes.error?.message || ''}`);
      const importedDeckId = importRes.value?.results?.[0]?.deckId;
      assert.ok(importedDeckId, 'deck.import must return imported deckId');

      const importedDeckRes = await host.call('deck.get', { id: importedDeckId });
      assert.equal(importedDeckRes.ok, true, 'deck.get for imported deck failed');
      const importedCards = importedDeckRes.value?.cards || [];
      assert.equal(importedCards.length, 10, 'imported deck must have 10 cards');

      const batchRes = await host.call('card.review.batch', {
        items: importedCards.map((c) => ({ deckId: importedDeckId, cardId: c.id, grade: 4 })),
      });
      assert.equal(batchRes.ok, true, `card.review.batch failed: ${batchRes.error?.message || ''}`);

      const genRes = await host.call('note.daily.generate', {
        course: recapCourse,
        timeZone: 'Asia/Shanghai',
      });
      assert.equal(genRes.ok, true, `note.daily.generate failed: ${genRes.error?.message || ''}`);
      assert.equal(genRes.value?.status, 'running');
      assert.ok(genRes.value?.id, 'note.daily.generate must return daily note id');
      assert.ok(genRes.value?.jobId, 'note.daily.generate must return jobId');

      const cancelRes = await host.call('note.daily.cancel', { id: genRes.value.id });
      assert.equal(cancelRes.ok, true, `note.daily.cancel failed: ${cancelRes.error?.message || ''}`);
      assert.equal(cancelRes.value?.id, genRes.value.id);
      assert.equal(cancelRes.value?.generation?.status, 'cancelled');

      const cancelledGet = await host.call('note.get', { id: genRes.value.id });
      assert.equal(cancelledGet.ok, true);
      assert.equal(cancelledGet.value?.id, genRes.value.id);
      assert.equal(cancelledGet.value?.generation?.status, 'cancelled');
    } finally {
      releaseRecap?.();
      await host.dispose();
    }
  });

  test('2) Notes material import (0 model calls): note.material.prepare -> source.add -> snapshot.sources + empty-markdown error', async () => {
    const base = await temps.make('notes-material-host');
    const env = { DSH_HOME: join(base, 'dsh-home') };
    const libraryRoot = join(base, 'library');
    await cloneSampleLibrary('zh', libraryRoot);

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
        return 'should-never-run';
      },
    });

    try {
      const { deck, card } = await seedSampleDeckAndCard(host);

      const emptyCreate = await host.call('note.create', {
        title: 'Empty Draft Note',
        cards: [{ deckId: deck.id, cardId: card.id }],
        prefill: false,
        language: 'zh',
      });
      assert.equal(emptyCreate.ok, true, `empty note.create failed: ${emptyCreate.error?.message || ''}`);
      assert.equal(emptyCreate.value?.status, 'draft');

      const emptyCleared = await host.call('note.save', {
        id: emptyCreate.value.id,
        markdown: '',
        expectedRevision: emptyCreate.value.revision ?? 0,
      });
      assert.equal(emptyCleared.ok, true, `empty note.save failed: ${emptyCleared.error?.message || ''}`);
      const emptyPrep = await host.call('note.material.prepare', {
        id: emptyCleared.value.id,
        expectedRevision: emptyCleared.value.revision ?? 0,
      });
      assert.equal(emptyPrep.ok, false, 'empty markdown note must fail note.material.prepare');
      assert.ok(
        String(emptyPrep.error?.message || '').includes('请先生成或填写正文'),
        `unexpected empty markdown error: ${emptyPrep.error?.message}`,
      );

      const noteTitle = 'Round 52 OS Note';
      const noteMarkdown = '# 虚拟内存与页表\n\n页表项包含有效位、脏位与物理页框号。\n';
      const savedRes = await host.call('note.save', {
        id: emptyCleared.value.id,
        title: noteTitle,
        markdown: noteMarkdown,
        expectedRevision: emptyCleared.value.revision ?? 0,
      });
      assert.equal(savedRes.ok, true, `note.save failed: ${savedRes.error?.message || ''}`);
      assert.equal(savedRes.value.id, emptyCreate.value.id);
      assert.equal(savedRes.value.title, noteTitle);
      assert.ok((savedRes.value.revision ?? 0) > (emptyCleared.value.revision ?? 0), 'note.save must increment revision');

      const prep1 = await host.call('note.material.prepare', {
        id: savedRes.value.id,
        expectedRevision: savedRes.value.revision ?? 0,
      });
      assert.equal(prep1.ok, true, `note.material.prepare failed: ${prep1.error?.message || ''}`);
      assert.match(prep1.value.id, /^note-material-[0-9a-f]{64}$/);
      assert.equal(prep1.value.title, noteTitle);
      assert.equal(prep1.value.text, noteMarkdown.trim());
      assert.equal(prep1.value.format, 'md');
      assert.ok(Array.isArray(prep1.value.courses));

      const prep2 = await host.call('note.material.prepare', {
        id: savedRes.value.id,
        expectedRevision: savedRes.value.revision ?? 0,
      });
      assert.equal(prep2.ok, true);
      assert.equal(prep2.value.id, prep1.value.id);
      assert.equal(prep2.value.text, prep1.value.text);

      const preGet = await host.call('source.get', { id: prep1.value.id, limit: 1 });
      assert.equal(preGet.ok, false);
      assert.ok(preGet.error?.message, 'missing source.get must include error message');

      const addRes = await host.call('source.add', prep1.value);
      assert.equal(addRes.ok, true, `source.add failed: ${addRes.error?.message || ''}`);
      assert.equal(addRes.value.id, prep1.value.id);
      assert.equal(addRes.value.title, noteTitle);
      assert.equal(addRes.value.format, 'md');

      const postGet = await host.call('source.get', { id: prep1.value.id, limit: 1 });
      assert.equal(postGet.ok, true, 'imported source must be readable via source.get');

      const refreshed = await host.refreshSnapshot();
      const matched = refreshed.snapshot?.sources?.find((s) => s.id === prep1.value.id);
      assert.ok(matched, 'imported note source must appear in refreshSnapshot().snapshot.sources');
      assert.equal(matched.id, prep1.value.id);
      assert.equal(matched.title, noteTitle);
      assert.equal(matched.format, 'md');

      const dupAddRes = await host.call('source.add', prep1.value);
      assert.equal(dupAddRes.ok, false, 'repeat source.add with existing deterministic id must reject duplicate');
      assert.ok(dupAddRes.error?.message, 'duplicate source.add must include error message');
      const refreshedAfterDup = await host.refreshSnapshot();
      assert.equal(
        refreshedAfterDup.snapshot?.sources?.filter((s) => s.id === prep1.value.id).length,
        1,
        'repeat source.add must not duplicate deterministic note source',
      );

      assert.equal(modelCalls, 0, 'note material preparation & import must trigger 0 model calls');
    } finally {
      await host.dispose();
    }
  });

  test('3) Notes AI draft generation & cancel: idle note.cancel (0 calls), running/cancel/complete via subscribeEvents, published refusal (0 calls)', async () => {
    const base = await temps.make('notes-gen-host');
    const env = { DSH_HOME: join(base, 'dsh-home') };
    const libraryRoot = join(base, 'library');
    await cloneSampleLibrary('zh', libraryRoot);

    let modelCalls = 0;
    let releaseGate = null;
    let gatePromise = new Promise((resolveFn) => {
      releaseGate = resolveFn;
    });

    const host = await createTuiHost({
      libraryRoot,
      env,
      home: base,
      documentsDir: base,
      skipAutoProbe: true,
      language: 'zh',
      injectedComplete: async (_system, _prompt, execution = {}) => {
        modelCalls += 1;
        await waitForGateOrAbort(gatePromise, execution.signal);
        execution.signal?.throwIfAborted?.();
        return SAMPLE_GENERATED_MARKDOWN;
      },
    });

    try {
      const { deck, card } = await seedSampleDeckAndCard(host);

      const draftCreate = await host.call('note.create', {
        title: 'Round 54 Draft Note',
        cards: [{ deckId: deck.id, cardId: card.id }],
        prefill: false,
        language: 'zh',
      });
      assert.equal(draftCreate.ok, true, `note.create failed: ${draftCreate.error?.message || ''}`);
      const draftNote = draftCreate.value;
      assert.equal(draftNote.status, 'draft');

      const idleCancel = await host.call('note.cancel', { id: draftNote.id });
      assert.equal(idleCancel.ok, true, `idle note.cancel failed: ${idleCancel.error?.message || ''}`);
      assert.equal(idleCancel.value?.id, draftNote.id);
      assert.equal(idleCancel.value?.status, 'draft');
      assert.equal(modelCalls, 0, 'idle note.cancel must trigger 0 model calls');

      const genStart = await host.call('note.generate', {
        id: draftNote.id,
        expectedRevision: draftNote.revision ?? 0,
      });
      assert.equal(genStart.ok, true, `note.generate failed: ${genStart.error?.message || ''}`);
      assert.equal(genStart.value?.id, draftNote.id);
      assert.ok(genStart.value?.jobId, 'note.generate must return jobId');
      assert.equal(genStart.value?.status, 'running');
      assert.equal(modelCalls, 1, 'note.generate must invoke injectedComplete once');

      const cancelRunning = await host.call('note.cancel', { id: draftNote.id });
      assert.equal(cancelRunning.ok, true, `running note.cancel failed: ${cancelRunning.error?.message || ''}`);
      assert.equal(cancelRunning.value?.id, draftNote.id);
      assert.equal(cancelRunning.value?.status, 'draft');
      assert.equal(cancelRunning.value?.generation?.status, 'cancelled');
      assert.equal(cancelRunning.value?.generation?.jobId, undefined);

      releaseGate?.();
      gatePromise = Promise.resolve();
      const draft2Create = await host.call('note.create', {
        title: 'Round 54 Completed Draft',
        cards: [{ deckId: deck.id, cardId: card.id }],
        prefill: false,
        language: 'zh',
      });
      assert.equal(draft2Create.ok, true);
      const genDoneStart = await host.call('note.generate', {
        id: draft2Create.value.id,
        expectedRevision: draft2Create.value.revision ?? 0,
      });
      assert.equal(genDoneStart.ok, true);
      assert.equal(genDoneStart.value?.id, draft2Create.value.id);
      assert.equal(genDoneStart.value?.status, 'running');
      assert.ok(genDoneStart.value?.jobId, 'second note.generate must return jobId');

      const completedNote = await waitForNoteDone(host, draft2Create.value.id);
      assert.ok(completedNote, 'note.generate must transition to done once model completes');
      assert.equal(completedNote.id, draft2Create.value.id);
      assert.equal(completedNote.title, 'Round 54 Completed Draft');
      assert.equal(completedNote.status, 'draft');
      assert.equal(completedNote.generation?.status, 'done');
      assert.ok(completedNote.markdown.includes('Virtual memory decouples process address spaces'));
      assert.ok(completedNote.markdown.includes('## Worked Example'));
      assert.equal(modelCalls, 2);

      const homeRes = await host.call('note.home', { home: 'https://blog.csdn.net/r54tester' });
      assert.equal(homeRes.ok, true);
      const linked = await host.call('note.link', {
        id: completedNote.id,
        url: 'https://blog.csdn.net/r54tester/article/details/540001',
        expectedRevision: completedNote.revision ?? 0,
      });
      assert.equal(linked.ok, true, `note.link failed: ${linked.error?.message || ''}`);
      assert.equal(linked.value?.id, completedNote.id);
      assert.equal(linked.value?.status, 'published');
      assert.equal(linked.value?.publicUrl, 'https://blog.csdn.net/r54tester/article/details/540001');

      const callsBeforePublished = modelCalls;
      const pubGen = await host.call('note.generate', {
        id: linked.value.id,
        expectedRevision: linked.value.revision ?? 0,
      });
      assert.equal(pubGen.ok, false, 'published note must reject note.generate');
      assert.ok(
        String(pubGen.error?.message || '').includes('已发布文章不能重新起草'),
        `unexpected published refusal message: ${pubGen.error?.message}`,
      );
      assert.equal(modelCalls, callsBeforePublished, 'published note refusal must trigger 0 model calls');
    } finally {
      releaseGate?.();
      await host.dispose();
    }
  });

  test('4) Notes CSDN publish assist (0 model calls, offline-safe): note.preparePublish & note.lookup without csdnHome & published refusal', async () => {
    const base = await temps.make('notes-publish-host');
    const env = { DSH_HOME: join(base, 'dsh-home') };
    const libraryRoot = join(base, 'library');
    await cloneSampleLibrary('zh', libraryRoot);

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
        throw new Error('Model must not be called during note.preparePublish or note.lookup');
      },
    });

    try {
      const { deck, card } = await seedSampleDeckAndCard(host);

      const createRes = await host.call('note.create', {
        title: 'Round 56 Offline Publish Assist Draft',
        cards: [{ deckId: deck.id, cardId: card.id }],
        language: 'zh',
      });
      assert.equal(createRes.ok, true, `note.create failed: ${createRes.error?.message || ''}`);
      const draft = createRes.value;
      assert.equal(draft?.title, 'Round 56 Offline Publish Assist Draft');
      assert.equal(draft?.status, 'draft');

      const prepRes = await host.call('note.preparePublish', { id: draft.id });
      assert.equal(prepRes.ok, true, `note.preparePublish failed: ${prepRes.error?.message || ''}`);
      assert.equal(prepRes.value?.autoLookupReady, false);
      assert.ok(
        typeof prepRes.value?.reason === 'string' && prepRes.value.reason.includes('尚未设置 CSDN 公开主页'),
        `expected missing CSDN home reason, got: ${JSON.stringify(prepRes.value)}`,
      );

      const lookupRes = await host.call('note.lookup', {
        id: draft.id,
        expectedRevision: draft.revision ?? 0,
      });
      assert.equal(lookupRes.ok, false, 'note.lookup must fail when csdnHome is not set');
      assert.ok(
        lookupRes.error?.message?.includes('请先设置 CSDN 公开博客主页'),
        `expected normalized missing-home error, got: ${lookupRes.error?.message || ''}`,
      );

      // Link the note and verify note.preparePublish rejects published notes offline with 0 model calls
      await host.call('note.home', { home: 'https://blog.csdn.net/r56tester' });
      const linked = await host.call('note.link', {
        id: draft.id,
        url: 'https://blog.csdn.net/r56tester/article/details/560001',
        expectedRevision: draft.revision ?? 0,
      });
      assert.equal(linked.ok, true);
      const prepPublished = await host.call('note.preparePublish', { id: draft.id });
      assert.equal(prepPublished.ok, false, 'note.preparePublish must reject already-published notes');
      assert.ok(
        String(prepPublished.error?.message || '').includes('已发布'),
        `expected already-published error, got: ${prepPublished.error?.message}`,
      );

      assert.equal(modelCalls, 0, 'note.preparePublish & note.lookup must trigger 0 model calls');
    } finally {
      await host.dispose();
    }
  });

  test('5) Board pure formatBoardMarkdown generates GFM Markdown in zh and en with checkboxes, metadata, Pomodoro stats & empty board', () => {
    const sampleDoc = {
      version: 1,
      cards: [
        {
          id: 'c1',
          title: 'Review Eigenvalues',
          column: 'todo',
          course: 'Linear Algebra',
          dueDate: '2026-11-30',
          priority: 'high',
          tags: ['math', 'midterm'],
          description: 'Prove spectral theorem for symmetric matrices.',
          createdAt: '2026-11-22T01:00:00.000Z',
          updatedAt: '2026-11-22T01:00:00.000Z',
        },
        {
          id: 'c2',
          title: 'Implement B-Tree Split',
          column: 'doing',
          course: 'Database',
          dueDate: '2026-11-25',
          priority: 'medium',
          tags: ['storage'],
          description: 'Handle leaf and internal node splits cleanly.',
          createdAt: '2026-11-22T02:00:00.000Z',
          updatedAt: '2026-11-22T02:00:00.000Z',
        },
        {
          id: 'c3',
          title: 'Setup Lab Environment',
          column: 'done',
          course: 'Systems',
          createdAt: '2026-11-22T03:00:00.000Z',
          updatedAt: '2026-11-22T03:00:00.000Z',
        },
      ],
      focusStats: {
        date: '2026-11-22',
        completedPomodoros: 3,
        focusedMinutes: 75,
      },
      updatedAt: '2026-11-22T04:00:00.000Z',
    };

    const enMd = formatBoardMarkdown(sampleDoc, 'en');
    assert.ok(enMd.includes('# StudyHub Kanban Board'));
    assert.ok(enMd.includes('Cards: 3 (Todo: 1, Doing: 1, Done: 1)'));
    assert.ok(enMd.includes('Pomodoro: 3 (75m)'));
    assert.ok(enMd.includes('## Todo'));
    assert.ok(enMd.includes('## Doing'));
    assert.ok(enMd.includes('## Done'));
    assert.ok(enMd.includes('- [ ] Review Eigenvalues'));
    assert.ok(enMd.includes('priority:high'));
    assert.ok(enMd.includes('course:Linear Algebra'));
    assert.ok(enMd.includes('due:2026-11-30'));
    assert.ok(enMd.includes('tags:#math #midterm'));
    assert.ok(enMd.includes('Prove spectral theorem for symmetric matrices.'));
    assert.ok(enMd.includes('- [ ] Implement B-Tree Split'));
    assert.ok(enMd.includes('priority:medium'));
    assert.ok(enMd.includes('course:Database'));
    assert.ok(enMd.includes('due:2026-11-25'));
    assert.ok(enMd.includes('tags:#storage'));
    assert.ok(enMd.includes('Handle leaf and internal node splits cleanly.'));
    assert.ok(enMd.includes('- [x] Setup Lab Environment'));
    assert.ok(enMd.includes('course:Systems'));

    const zhMd = formatBoardMarkdown(sampleDoc, 'zh');
    assert.ok(zhMd.includes('# StudyHub Kanban Board'));
    assert.ok(zhMd.includes('任务总计: 3 (待办: 1, 进行中: 1, 已完成: 1)'));
    assert.ok(zhMd.includes('番茄专注: 3 次 (75 分钟)'));
    assert.ok(zhMd.includes('## 待办 Todo'));
    assert.ok(zhMd.includes('## 进行中 Doing'));
    assert.ok(zhMd.includes('## 已完成 Done'));
    assert.ok(zhMd.includes('- [ ] Review Eigenvalues'));
    assert.ok(zhMd.includes('优先级:high'));
    assert.ok(zhMd.includes('课程:Linear Algebra'));
    assert.ok(zhMd.includes('截止:2026-11-30'));
    assert.ok(zhMd.includes('tags:#math #midterm'));
    assert.ok(zhMd.includes('Prove spectral theorem for symmetric matrices.'));
    assert.ok(zhMd.includes('- [ ] Implement B-Tree Split'));
    assert.ok(zhMd.includes('优先级:medium'));
    assert.ok(zhMd.includes('课程:Database'));
    assert.ok(zhMd.includes('截止:2026-11-25'));
    assert.ok(zhMd.includes('tags:#storage'));
    assert.ok(zhMd.includes('- [x] Setup Lab Environment'));
    assert.ok(zhMd.includes('课程:Systems'));

    const emptyEnMd = formatBoardMarkdown({ version: 1, cards: [], updatedAt: '2026-11-22T00:00:00.000Z' }, 'en');
    assert.ok(emptyEnMd.includes('# StudyHub Kanban Board'));
    assert.ok(emptyEnMd.includes('Cards: 0 (Todo: 0, Doing: 0, Done: 0)'));
    assert.ok(emptyEnMd.includes('Pomodoro: 0 (0m)'));
    assert.ok(emptyEnMd.includes('## Todo'));
    assert.ok(emptyEnMd.includes('## Done'));
    assert.ok(emptyEnMd.includes('_(none)_'));

    const emptyZhMd = formatBoardMarkdown({ version: 1, cards: [], updatedAt: '2026-11-22T00:00:00.000Z' }, 'zh');
    assert.ok(emptyZhMd.includes('任务总计: 0 (待办: 0, 进行中: 0, 已完成: 0)'));
    assert.ok(emptyZhMd.includes('番茄专注: 0 次 (0 分钟)'));
    assert.ok(emptyZhMd.includes('_（暂无）_'));
  });
});

describe('Domain Notes & Board: NotesView PTY E2E (zh & --ascii en)', () => {
  test('6) NotesView [L] Publish Link modal, preview URL badge, [C] idle toast & 80x24 compact modal (default zh & --ascii en)', async () => {
    const base = await temps.make('notes-link-pty');
    const dshHome = join(base, 'dsh-home');
    const env = { DSH_HOME: dshHome };
    const libraryRoot = join(base, 'library');
    await cloneSampleLibrary('zh', libraryRoot);

    let modelCalls = 0;
    const host = await createTuiHost({
      libraryRoot,
      env,
      home: base,
      documentsDir: base,
      skipAutoProbe: true,
      language: 'zh',
      eventDebounceMs: 25,
      injectedComplete: async () => {
        modelCalls += 1;
        throw new Error('Unexpected LLM call in NotesView [L]/[C] PTY test');
      },
    });

    const publishedUrl = 'https://blog.csdn.net/r38pty/article/details/556677';
    try {
      const { deck, card } = await seedSampleDeckAndCard(host);
      const homeRes = await host.call('note.home', { home: 'https://blog.csdn.net/r38pty' });
      assert.equal(homeRes.ok, true);
      const created = await host.call('note.create', {
        title: 'PTY Linked Note',
        cards: [{ deckId: deck.id, cardId: card.id }],
        language: 'zh',
      });
      assert.equal(created.ok, true);
      const linked = await host.call('note.link', {
        id: created.value.id,
        url: publishedUrl,
        expectedRevision: created.value.revision,
      });
      assert.equal(linked.ok, true);
      assert.equal(linked.value.publicUrl, publishedUrl);

      process.env.DSH_HOME = dshHome;
      await saveTuiPreferences({ language: 'zh', asciiMode: false }, { env });
      resetTuiStore('zh', false);

      const tty = createVirtualTty(120, 36);
      let inkInstance = null;
      try {
        inkInstance = render(
          React.createElement(StudyHubTuiApp, {
            host,
            initialPage: 'notes',
            initialLanguage: 'zh',
            initialAsciiMode: false,
            autoLaunchpad: false,
            onExit: () => inkInstance?.unmount(),
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

        const passes = [
          { name: 'default zh', language: 'zh', asciiMode: false },
          { name: '--ascii en', language: 'en', asciiMode: true },
        ];

        for (const [idx, pass] of passes.entries()) {
          if (idx > 0) {
            tty.resize(120, 36);
            host.setLanguage(pass.language);
            useTuiStore.getState().setPreferences({ language: pass.language, asciiMode: pass.asciiMode });
            useTuiStore.setState({ toasts: [] });
          }

          const initial = await tty.waitFor(
            (s) =>
              s.includes('PTY Linked Note') &&
              s.includes('blog.csdn.net/r38pty') &&
              (pass.language === 'zh' ? s.includes('外链') : s.includes('Link')),
            { label: `NotesView initial (${pass.name})` },
          );
          assert.equal(useTuiStore.getState().page, 'notes');
          tty.assertHealthyScreen(initial, 120, 36, `NotesView 120x36 (${pass.name})`);
          if (pass.asciiMode) tty.assertAsciiPure(initial, `NotesView 120x36 (${pass.name})`);

          tty.send('C');
          const afterIdleCancel = await tty.waitFor(
            (s) =>
              pass.language === 'zh'
                ? s.includes('当前没有正在生成的每日总结')
                : s.includes('No daily recap is currently running'),
            { label: `[C] idle toast (${pass.name})` },
          );
          tty.assertHealthyScreen(afterIdleCancel, 120, 36, `NotesView after [C] (${pass.name})`);
          if (pass.asciiMode) tty.assertAsciiPure(afterIdleCancel, `NotesView after [C] (${pass.name})`);

          tty.send('L');
          const modalOpen = await tty.waitFor(
            (s) =>
              (pass.language === 'zh' ? s.includes('关联公开文章链接') : s.includes('Link Published Article URL')) &&
              s.includes('556677'),
            { label: `[L] modal open 120x36 (${pass.name})` },
          );
          tty.assertHealthyScreen(modalOpen, 120, 36, `Publish Link Modal 120x36 (${pass.name})`);
          if (pass.asciiMode) tty.assertAsciiPure(modalOpen, `Publish Link Modal 120x36 (${pass.name})`);

          tty.send('\x1b');
          const modalClosed = await tty.waitFor(
            (s) => !s.includes('关联公开文章链接') && !s.includes('Link Published Article URL'),
            { label: `[L] modal Esc close (${pass.name})` },
          );
          assert.ok(modalClosed.includes('PTY Linked Note'), `note must stay visible after Esc (${pass.name})`);
          tty.assertHealthyScreen(modalClosed, 120, 36, `NotesView after Esc 120x36 (${pass.name})`);
          if (pass.asciiMode) tty.assertAsciiPure(modalClosed, `NotesView after Esc 120x36 (${pass.name})`);

          tty.resize(80, 24);
          await tty.flush();
          const compactScreen = await tty.waitFor(
            (s) => s.includes('PTY Linked Note') && s.split('\n').length <= 24,
            { label: `NotesView 80x24 (${pass.name})` },
          );
          tty.assertHealthyScreen(compactScreen, 80, 24, `NotesView 80x24 (${pass.name})`);
          if (pass.asciiMode) tty.assertAsciiPure(compactScreen, `NotesView 80x24 (${pass.name})`);

          tty.send('L');
          const compactModal = await tty.waitFor(
            (s) => (pass.language === 'zh' ? s.includes('关联公开文章链接') : s.includes('Link Published Article URL')),
            { label: `[L] modal open 80x24 (${pass.name})` },
          );
          tty.assertHealthyScreen(compactModal, 80, 24, `Publish Link Modal 80x24 (${pass.name})`);
          if (pass.asciiMode) tty.assertAsciiPure(compactModal, `Publish Link Modal 80x24 (${pass.name})`);

          tty.send('\x1b');
          await tty.waitFor(
            (s) => !s.includes('关联公开文章链接') && !s.includes('Link Published Article URL'),
            { label: `[L] modal Esc close 80x24 (${pass.name})` },
          );
        }
      } finally {
        try {
          inkInstance?.unmount();
        } catch {
          // ignore unmount errors
        }
        tty.dispose();
      }
      assert.equal(modelCalls, 0, 'NotesView [L]/[C] PTY flow must trigger 0 model calls');
    } finally {
      await host.dispose();
    }
  });

  test('7) NotesView [M] imports note to Sources, duplicate & empty guards, HelpOverlay Round 52 keys (default zh & --ascii en)', async () => {
    const base = await temps.make('notes-mat');
    const dshHome = join(base, 'dsh-home');
    const env = { DSH_HOME: dshHome };
    const libraryRoot = join(base, 'library');
    await cloneSampleLibrary('zh', libraryRoot);

    let modelCalls = 0;
    const host = await createTuiHost({
      libraryRoot,
      env,
      home: base,
      documentsDir: base,
      skipAutoProbe: true,
      language: 'zh',
      eventDebounceMs: 25,
      injectedComplete: async () => {
        modelCalls += 1;
        return 'should-never-run';
      },
    });

    try {
      const { deck, card } = await seedSampleDeckAndCard(host);

      const emptyRes = await host.call('note.create', {
        title: 'R52 Empty Note',
        cards: [{ deckId: deck.id, cardId: card.id }],
        prefill: false,
        language: 'zh',
      });
      assert.equal(emptyRes.ok, true);
      const emptyCleared = await host.call('note.save', {
        id: emptyRes.value.id,
        markdown: '',
        expectedRevision: emptyRes.value.revision ?? 0,
      });
      assert.equal(emptyCleared.ok, true);

      const zhCreate = await host.call('note.create', {
        title: 'R52 Markdown 笔记',
        cards: [{ deckId: deck.id, cardId: card.id }],
        prefill: false,
        language: 'zh',
      });
      assert.equal(zhCreate.ok, true);
      const zhSaved = await saveNoteStrictlyNewer(
        host,
        {
          id: zhCreate.value.id,
          title: 'R52 Markdown 笔记',
          markdown: '# 进程调度\n\n时间片轮转与多级反馈队列。\n',
          expectedRevision: zhCreate.value.revision ?? 0,
        },
        emptyCleared.value.updatedAt,
      );
      assert.equal(zhSaved.ok, true);

      const zhPrep = await host.call('note.material.prepare', {
        id: zhSaved.value.id,
        expectedRevision: zhSaved.value.revision ?? 0,
      });
      assert.equal(zhPrep.ok, true);

      process.env.DSH_HOME = dshHome;
      await saveTuiPreferences({ language: 'zh', asciiMode: false }, { env });
      resetTuiStore('zh', false);

      const tty = createVirtualTty(120, 36);
      let inkInstance = null;
      try {
        inkInstance = render(
          React.createElement(StudyHubTuiApp, {
            host,
            initialPage: 'notes',
            initialLanguage: 'zh',
            initialAsciiMode: false,
            autoLaunchpad: false,
            onExit: () => inkInstance?.unmount(),
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

        const passes = [
          {
            name: 'default zh',
            language: 'zh',
            asciiMode: false,
            noteTitle: 'R52 Markdown 笔记',
            emptyTitle: 'R52 Empty Note',
            expectedSourceId: zhPrep.value.id,
            successToast: '已将笔记「R52 Markdown 笔记」导入资料库',
            dupToast: '已在资料库中',
            emptyToast: '请先生成或填写正文',
            helpTargets: ['手动改AI分 / 确认订正', '骨架互动图 / 笔记入资料库', '阅读问答存为闪卡'],
            downStepsToEmpty: 1,
          },
          {
            name: '--ascii en',
            language: 'en',
            asciiMode: true,
            noteTitle: 'R52 Note',
            noteBody: '# Virtual Memory\n\nTLB hit rate and page fault handling.\n',
            emptyTitle: 'R52 Empty Note',
            successToast: 'Imported note "R52 Note" to Sources',
            dupToast: 'Note "R52 Note" is already in Sources',
            emptyToast: 'Please generate or enter note content',
            helpTargets: ['Adjust AI grade / Ack fix', 'Skeleton diagrams / Note to source', 'Save reader Q&A as card'],
            downStepsToEmpty: 2,
          },
        ];

        for (const [idx, pass] of passes.entries()) {
          if (idx > 0) {
            const enCreate = await host.call('note.create', {
              title: pass.noteTitle,
              cards: [{ deckId: deck.id, cardId: card.id }],
              prefill: false,
              language: pass.language,
            });
            assert.equal(enCreate.ok, true);
            const enSaved = await saveNoteStrictlyNewer(
              host,
              {
                id: enCreate.value.id,
                title: pass.noteTitle,
                markdown: pass.noteBody,
                expectedRevision: enCreate.value.revision ?? 0,
              },
              zhSaved.value.updatedAt,
            );
            assert.equal(enSaved.ok, true);
            const enPrep = await host.call('note.material.prepare', {
              id: enSaved.value.id,
              expectedRevision: enSaved.value.revision ?? 0,
            });
            assert.equal(enPrep.ok, true);
            pass.expectedSourceId = enPrep.value.id;

            host.setLanguage(pass.language);
            useTuiStore.getState().setPreferences({ language: pass.language, asciiMode: pass.asciiMode });
            useTuiStore.setState({ toasts: [] });
            await tty.waitFor(
              (s) => s.includes('R52 Note') && s.includes('To Sources'),
              { label: 'New en note appeared in list' },
            );
            tty.send('k');
            await tty.waitFor(
              (s) => s.includes('TLB hit rate'),
              { label: 'Select newly created R52 Note at index 0' },
            );
          }

          const initial = await tty.waitFor(
            (s) =>
              s.includes(pass.noteTitle) &&
              (pass.language === 'zh' ? s.includes('入资料库') : s.includes('To Sources')),
            { label: `NotesView initial (${pass.name})` },
          );
          assert.equal(useTuiStore.getState().page, 'notes');
          tty.assertHealthyScreen(initial, 120, 36, `NotesView 120x36 (${pass.name})`);
          if (pass.asciiMode) tty.assertAsciiPure(initial, `NotesView 120x36 (${pass.name})`);

          tty.send('M');
          const afterImport = await tty.waitFor(
            (s) => s.includes(pass.successToast),
            { label: `[M] import success toast (${pass.name})` },
          );
          tty.assertHealthyScreen(afterImport, 120, 36, `NotesView after [M] (${pass.name})`);
          if (pass.asciiMode) tty.assertAsciiPure(afterImport, `NotesView after [M] (${pass.name})`);

          const storeSnap = useTuiStore.getState().snapshot;
          const sourcesCountAfterImport = storeSnap?.sources?.length ?? 0;
          assert.ok(
            storeSnap?.sources?.some((src) => src.id === pass.expectedSourceId),
            `store snapshot must contain imported source ${pass.expectedSourceId} (${pass.name})`,
          );
          const getAdded = await host.call('source.get', { id: pass.expectedSourceId, limit: 1 });
          assert.equal(getAdded.ok, true, 'imported source must be retrievable via source.get');
          assert.equal(getAdded.value?.source?.title ?? getAdded.value?.title, pass.noteTitle);

          tty.send('M');
          const afterDup = await tty.waitFor(
            (s) => s.includes(pass.dupToast),
            { label: `[M] duplicate info toast (${pass.name})` },
          );
          tty.assertHealthyScreen(afterDup, 120, 36, `NotesView duplicate [M] (${pass.name})`);
          if (pass.asciiMode) tty.assertAsciiPure(afterDup, `NotesView duplicate [M] (${pass.name})`);
          assert.equal(
            useTuiStore.getState().snapshot?.sources?.length ?? 0,
            sourcesCountAfterImport,
            `duplicate [M] must not add extra source (${pass.name})`,
          );

          for (let step = 0; step < pass.downStepsToEmpty; step += 1) {
            tty.send('j');
            await tty.flush();
          }
          await tty.waitFor(
            (s) => s.includes(pass.emptyTitle),
            { label: `Select empty note (${pass.name})` },
          );
          tty.send('M');
          const afterEmpty = await tty.waitFor(
            (s) => s.includes(pass.emptyToast),
            { label: `[M] empty note error toast (${pass.name})` },
          );
          tty.assertHealthyScreen(afterEmpty, 120, 36, `NotesView empty [M] (${pass.name})`);
          if (pass.asciiMode) tty.assertAsciiPure(afterEmpty, `NotesView empty [M] (${pass.name})`);
          assert.equal(
            useTuiStore.getState().snapshot?.sources?.length ?? 0,
            sourcesCountAfterImport,
            `empty note [M] must not add source (${pass.name})`,
          );

          tty.resize(80, 24);
          await tty.flush();
          const compact = await tty.waitFor(
            (s) => s.includes(pass.emptyTitle) && s.includes(pass.noteTitle) && s.split('\n').length <= 24,
            { label: `NotesView 80x24 (${pass.name})` },
          );
          tty.assertHealthyScreen(compact, 80, 24, `NotesView 80x24 (${pass.name})`);
          if (pass.asciiMode) tty.assertAsciiPure(compact, `NotesView 80x24 (${pass.name})`);

          tty.resize(120, 36);
          const notesHeader = pass.language === 'zh' ? '学习笔记' : 'Notes';
          await tty.waitFor(
            (s) => s.includes(pass.emptyTitle) && s.includes(notesHeader),
            { label: `NotesView restored 120x36 (${pass.name})` },
          );
          tty.send('?');
          await tty.waitFor(
            (s) => s.includes(pass.language === 'zh' ? '快捷键' : 'Keyboard Shortcuts'),
            { label: `HelpOverlay opened (${pass.name})` },
          );

          await scrollHelpOverlayForTargets(tty, 120, 36, pass.helpTargets, pass.name, pass.asciiMode);

          tty.send('\x1b');
          const closedHelp = await tty.waitFor(
            (s) =>
              !s.includes(pass.language === 'zh' ? '快捷键' : 'Keyboard Shortcuts') &&
              s.includes(pass.emptyTitle) &&
              s.includes(notesHeader),
            { label: `NotesView restored after HelpOverlay Esc (${pass.name})` },
          );
          assert.ok(
            closedHelp.includes(pass.emptyTitle),
            `NotesView must reappear after HelpOverlay Esc (${pass.name})`,
          );

          // Return selection to index 0 before next pass inserts a newer note at top
          if (idx === 0) {
            tty.send('k');
            await tty.flush();
          }
        }
        assert.equal(modelCalls, 0, 'PTY passes must trigger 0 model calls');
      } finally {
        try {
          inkInstance?.unmount();
        } catch {
          // ignore unmount errors
        }
        tty.dispose();
      }
    } finally {
      await host.dispose();
    }
  });

  test('8) NotesView AI draft P2 ConfirmDialog (120x36 zh & 80x24 --ascii en): [g] -> [n] 0 calls -> [g]+[y] launches -> [C]+[y] cancels', async () => {
    const base = await temps.make('notes-gen');
    const dshHome = join(base, 'dsh-home');
    const env = { DSH_HOME: dshHome };
    const libraryRoot = join(base, 'library');
    await cloneSampleLibrary('zh', libraryRoot);

    let modelCalls = 0;
    let releaseGate = null;
    let gatePromise = new Promise((resolveFn) => {
      releaseGate = resolveFn;
    });

    const host = await createTuiHost({
      libraryRoot,
      env,
      home: base,
      documentsDir: base,
      skipAutoProbe: true,
      language: 'zh',
      eventDebounceMs: 25,
      injectedComplete: async (_system, _prompt, execution = {}) => {
        modelCalls += 1;
        await waitForGateOrAbort(gatePromise, execution.signal);
        execution.signal?.throwIfAborted?.();
        return SAMPLE_GENERATED_MARKDOWN;
      },
    });

    try {
      const { deck, card } = await seedSampleDeckAndCard(host);

      const createdZh = await host.call('note.create', {
        title: 'R54 虚拟内存草稿',
        cards: [{ deckId: deck.id, cardId: card.id }],
        prefill: false,
        language: 'zh',
      });
      assert.equal(createdZh.ok, true, `note.create failed: ${createdZh.error?.message || ''}`);

      process.env.DSH_HOME = dshHome;
      await saveTuiPreferences({ language: 'zh', asciiMode: false }, { env });
      resetTuiStore('zh', false);

      const tty = createVirtualTty(120, 36);
      let inkInstance = null;
      try {
        inkInstance = render(
          React.createElement(StudyHubTuiApp, {
            host,
            initialPage: 'notes',
            initialNavContext: { noteId: createdZh.value.id },
            initialLanguage: 'zh',
            initialAsciiMode: false,
            autoLaunchpad: false,
            onExit: () => inkInstance?.unmount(),
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

        const passes = [
          {
            name: '120x36 zh',
            cols: 120,
            rows: 36,
            language: 'zh',
            asciiMode: false,
            noteId: createdZh.value.id,
            noteTitle: 'R54 虚拟内存草稿',
            confirmTitle: 'AI 起草笔记正文',
            startedToast: '已启动 AI 笔记起草任务',
            cancelTitle: '停止 AI 起草笔记',
            cancelledToast: '已停止笔记 AI 起草',
          },
          {
            name: '80x24 --ascii en',
            cols: 80,
            rows: 24,
            language: 'en',
            asciiMode: true,
            noteTitle: 'R54 Memory Draft',
            confirmTitle: 'AI Draft Note',
            startedToast: 'Started AI note draft',
            cancelTitle: 'Stop AI Note Draft',
            cancelledToast: 'Stopped note AI drafting',
          },
        ];

        for (const [idx, pass] of passes.entries()) {
          if (idx > 0) {
            releaseGate?.();
            gatePromise = new Promise((resolveFn) => {
              releaseGate = resolveFn;
            });
            await new Promise((r) => setTimeout(r, 2));
            const createdEn = await host.call('note.create', {
              title: pass.noteTitle,
              cards: [{ deckId: deck.id, cardId: card.id }],
              prefill: false,
              language: pass.language,
            });
            assert.equal(createdEn.ok, true, `note.create(en) failed: ${createdEn.error?.message || ''}`);
            pass.noteId = createdEn.value.id;

            tty.resize(pass.cols, pass.rows);
            host.setLanguage(pass.language);
            useTuiStore.getState().setPreferences({ language: pass.language, asciiMode: pass.asciiMode });
            useTuiStore.setState({ toasts: [] });
          }

          const callsBeforePass = modelCalls;
          const initial = await tty.waitFor(
            (s) =>
              s.includes(pass.noteTitle) &&
              (pass.language === 'zh' ? s.includes('AI起草') : s.includes('AI Draft')) &&
              s.split('\n').length <= pass.rows,
            { label: `NotesView initial (${pass.name})` },
          );
          assert.equal(useTuiStore.getState().page, 'notes');
          tty.assertHealthyScreen(initial, pass.cols, pass.rows, `NotesView initial (${pass.name})`);
          if (pass.asciiMode) tty.assertAsciiPure(initial, `NotesView initial (${pass.name})`);

          if (idx > 0) {
            // Move selection to the newly created top note (VirtualList `g` no longer jumps to top per #1349)
            tty.send('\x1b[H');
            await tty.waitFor((s) => s.includes(`> - ${pass.noteTitle}`) || s.includes(`▸`), {
              timeoutMs: 3_000,
              label: `Select ${pass.noteTitle} via Home`,
            });
          }

          tty.send('g');
          const confirmOpen = await tty.waitFor(
            (s) =>
              s.includes(pass.confirmTitle) &&
              s.includes(pass.noteTitle) &&
              (pass.language === 'zh'
                ? s.includes('关联 1') && s.includes('张题卡')
                : /\b1\b/.test(s) && s.includes('linked card')),
            { label: `[g] ConfirmDialog open (${pass.name})` },
          );
          assert.equal(modelCalls, callsBeforePass, `[g] opening ConfirmDialog must trigger 0 model calls (${pass.name})`);
          tty.assertHealthyScreen(confirmOpen, pass.cols, pass.rows, `ConfirmDialog (${pass.name})`);
          if (pass.asciiMode) tty.assertAsciiPure(confirmOpen, `ConfirmDialog (${pass.name})`);

          tty.send('n');
          const afterCancel = await tty.waitFor(
            (s) => !s.includes(pass.confirmTitle),
            { label: `[n] cancel ConfirmDialog (${pass.name})` },
          );
          assert.equal(modelCalls, callsBeforePass, `[n] cancelling ConfirmDialog must trigger 0 model calls (${pass.name})`);
          tty.assertHealthyScreen(afterCancel, pass.cols, pass.rows, `NotesView after [n] (${pass.name})`);
          if (pass.asciiMode) tty.assertAsciiPure(afterCancel, `NotesView after [n] (${pass.name})`);

          tty.send('g');
          await tty.waitFor(
            (s) => s.includes(pass.confirmTitle),
            { label: `[g] reopen ConfirmDialog (${pass.name})` },
          );
          tty.send('y');
          const startedScreen = await tty.waitFor(
            (s) => s.includes(pass.startedToast) && modelCalls === callsBeforePass + 1,
            { label: `[y] note.generate started (${pass.name})` },
          );
          assert.equal(modelCalls, callsBeforePass + 1, `[g]+[y] must trigger exactly 1 model call (${pass.name})`);
          tty.assertHealthyScreen(startedScreen, pass.cols, pass.rows, `NotesView after [g]+[y] (${pass.name})`);
          if (pass.asciiMode) tty.assertAsciiPure(startedScreen, `NotesView after [g]+[y] (${pass.name})`);

          const runningScreen = await tty.waitFor(
            (s) =>
              pass.cols >= 86
                ? pass.language === 'zh'
                  ? s.includes('AI 正在生成内容') && s.includes('停生成')
                  : s.includes('Generating') && s.includes('Stop Gen')
                : s.includes(`${pass.asciiMode ? '~' : '⟳'} ${pass.noteTitle}`),
            { label: `running draft state (${pass.name})` },
          );
          tty.assertHealthyScreen(runningScreen, pass.cols, pass.rows, `NotesView running (${pass.name})`);
          if (pass.asciiMode) tty.assertAsciiPure(runningScreen, `NotesView running (${pass.name})`);

          tty.send('C');
          const cancelDialog = await tty.waitFor(
            (s) => s.includes(pass.cancelTitle),
            { label: `[C] ConfirmDialog open (${pass.name})` },
          );
          tty.assertHealthyScreen(cancelDialog, pass.cols, pass.rows, `Cancel ConfirmDialog (${pass.name})`);
          if (pass.asciiMode) tty.assertAsciiPure(cancelDialog, `Cancel ConfirmDialog (${pass.name})`);

          tty.send('y');
          const cancelledScreen = await tty.waitFor(
            (s) => s.includes(pass.cancelledToast),
            { label: `[C]+[y] note.cancel toast (${pass.name})` },
          );
          tty.assertHealthyScreen(cancelledScreen, pass.cols, pass.rows, `NotesView after [C]+[y] (${pass.name})`);
          if (pass.asciiMode) tty.assertAsciiPure(cancelledScreen, `NotesView after [C]+[y] (${pass.name})`);

          const postCancelNote = await host.call('note.get', { id: pass.noteId });
          assert.equal(postCancelNote.ok, true);
          assert.equal(postCancelNote.value?.generation?.status, 'cancelled');
          assert.equal(modelCalls, callsBeforePass + 1, `cancelling draft must not invoke model again (${pass.name})`);
        }
      } finally {
        try {
          inkInstance?.unmount();
        } catch {
          // ignore unmount errors
        }
        tty.dispose();
      }
    } finally {
      releaseGate?.();
      await host.dispose();
    }
  });

  test('9) NotesView Link Modal Ctrl+P / Ctrl+L offline guards & HelpOverlay Round 56 parity (default zh & --ascii en)', async () => {
    const base = await temps.make('notes-publish-pty');
    const dshHome = join(base, 'dsh-home');
    const env = { DSH_HOME: dshHome };
    const libraryRoot = join(base, 'library');
    await cloneSampleLibrary('zh', libraryRoot);

    let modelCalls = 0;
    const host = await createTuiHost({
      libraryRoot,
      env,
      home: base,
      documentsDir: base,
      skipAutoProbe: true,
      language: 'zh',
      eventDebounceMs: 25,
      injectedComplete: async () => {
        modelCalls += 1;
        throw new Error('Model must not be called in NotesView Link Modal PTY test');
      },
    });

    try {
      const { deck, card } = await seedSampleDeckAndCard(host);

      const created = await host.call('note.create', {
        title: 'R56 Publish Assist Note',
        cards: [{ deckId: deck.id, cardId: card.id }],
        language: 'zh',
      });
      assert.equal(created.ok, true, `note.create failed: ${created.error?.message || ''}`);

      process.env.DSH_HOME = dshHome;
      await saveTuiPreferences({ language: 'zh', asciiMode: false }, { env });
      resetTuiStore('zh', false);

      const tty = createVirtualTty(120, 36);
      let inkInstance = null;
      try {
        inkInstance = render(
          React.createElement(StudyHubTuiApp, {
            host,
            initialPage: 'notes',
            initialLanguage: 'zh',
            initialAsciiMode: false,
            autoLaunchpad: false,
            onExit: () => inkInstance?.unmount(),
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

        const passes = [
          { name: 'default zh', language: 'zh', asciiMode: false },
          { name: '--ascii en', language: 'en', asciiMode: true },
        ];

        for (const [idx, pass] of passes.entries()) {
          if (idx > 0) {
            tty.resize(120, 36);
            host.setLanguage(pass.language);
            useTuiStore.getState().setPreferences({ language: pass.language, asciiMode: pass.asciiMode });
            useTuiStore.setState({ toasts: [] });
          }

          const initial = await tty.waitFor(
            (s) =>
              s.includes('R56 Publish Assist Note') &&
              (pass.language === 'zh' ? s.includes('外链') : s.includes('Link')),
            { label: `NotesView initial (${pass.name})` },
          );
          assert.equal(useTuiStore.getState().page, 'notes');
          tty.assertHealthyScreen(initial, 120, 36, `NotesView 120x36 (${pass.name})`);
          if (pass.asciiMode) tty.assertAsciiPure(initial, `NotesView 120x36 (${pass.name})`);

          tty.send('L');
          const linkModal = await tty.waitFor(
            (s) =>
              (pass.language === 'zh' ? s.includes('关联公开文章链接') : s.includes('Link Published Article URL')) &&
              s.includes('Ctrl+P') &&
              s.includes('Ctrl+L') &&
              (pass.language === 'zh' ? s.includes('准备发布') && s.includes('自动查找') : s.includes('Prepare') && s.includes('Lookup')),
            { label: `Link modal open with Ctrl+P / Ctrl+L hints (${pass.name})` },
          );
          tty.assertHealthyScreen(linkModal, 120, 36, `Link Modal 120x36 (${pass.name})`);
          if (pass.asciiMode) tty.assertAsciiPure(linkModal, `Link Modal 120x36 (${pass.name})`);

          tty.send('\x10');
          const afterPrep = await tty.waitFor(
            (s) => s.includes('尚未设置 CSDN 公开主页'),
            { label: `Ctrl+P missing CSDN home feedback (${pass.name})` },
          );
          tty.assertHealthyScreen(afterPrep, 120, 36, `Link Modal after Ctrl+P (${pass.name})`);
          if (pass.asciiMode) tty.assertAsciiPure(afterPrep, `Link Modal after Ctrl+P (${pass.name})`);

          tty.send('\x0c');
          const afterLookup = await tty.waitFor(
            (s) => s.includes('请先设置 CSDN 公开博客主页'),
            { label: `Ctrl+L missing CSDN home error (${pass.name})` },
          );
          tty.assertHealthyScreen(afterLookup, 120, 36, `Link Modal after Ctrl+L (${pass.name})`);
          if (pass.asciiMode) tty.assertAsciiPure(afterLookup, `Link Modal after Ctrl+L (${pass.name})`);

          tty.send('\x1b');
          const afterEsc = await tty.waitFor(
            (s) => !s.includes('关联公开文章链接') && !s.includes('Link Published Article URL'),
            { label: `Link Modal Esc close (${pass.name})` },
          );
          assert.ok(afterEsc.includes('R56 Publish Assist Note'), `note title must remain visible after Esc (${pass.name})`);
          tty.assertHealthyScreen(afterEsc, 120, 36, `NotesView after Esc (${pass.name})`);
          if (pass.asciiMode) tty.assertAsciiPure(afterEsc, `NotesView after Esc (${pass.name})`);

          tty.send('?');
          const helpOpen = await tty.waitFor(
            (s) => (pass.language === 'zh' ? s.includes('快捷键') : s.includes('Keyboard Shortcuts')),
            { label: `HelpOverlay open (${pass.name})` },
          );
          tty.assertHealthyScreen(helpOpen, 120, 36, `HelpOverlay 120x36 (${pass.name})`);
          if (pass.asciiMode) tty.assertAsciiPure(helpOpen, `HelpOverlay 120x36 (${pass.name})`);

          const expectedEntries =
            pass.language === 'zh'
              ? ['题组更改所属课程', '填入课程薄弱知识点', '发布与查找链接']
              : ['Deck change course', 'Fill weak topics', 'Publish & lookup'];
          await scrollHelpOverlayForTargets(tty, 120, 36, expectedEntries, pass.name, pass.asciiMode);

          tty.send('\x1b');
          const closedHelp = await tty.waitFor(
            (s) => !s.includes('快捷键') && !s.includes('Keyboard Shortcuts'),
            { label: `HelpOverlay Esc close (${pass.name})` },
          );
          assert.ok(closedHelp.includes('R56 Publish Assist Note'));

          tty.resize(80, 24);
          await tty.flush();
          const compactScreen = await tty.waitFor(
            (s) => s.includes('R56 Publish Assist Note') && s.split('\n').length <= 24,
            { label: `NotesView 80x24 (${pass.name})` },
          );
          tty.assertHealthyScreen(compactScreen, 80, 24, `NotesView 80x24 (${pass.name})`);
          if (pass.asciiMode) tty.assertAsciiPure(compactScreen, `NotesView 80x24 (${pass.name})`);

          tty.send('L');
          const compactModal = await tty.waitFor(
            (s) =>
              (pass.language === 'zh' ? s.includes('关联公开文章链接') : s.includes('Link Published Article URL')) &&
              s.includes('Ctrl+P') &&
              s.includes('Ctrl+L'),
            { label: `Link modal 80x24 (${pass.name})` },
          );
          tty.assertHealthyScreen(compactModal, 80, 24, `Link Modal 80x24 (${pass.name})`);
          if (pass.asciiMode) tty.assertAsciiPure(compactModal, `Link Modal 80x24 (${pass.name})`);

          tty.send('\x1b');
          await tty.waitFor(
            (s) => !s.includes('关联公开文章链接') && !s.includes('Link Published Article URL'),
            { label: `Link modal Esc close 80x24 (${pass.name})` },
          );
        }
      } finally {
        try {
          inkInstance?.unmount();
        } catch {
          // ignore unmount errors
        }
        tty.dispose();
      }

      assert.equal(modelCalls, 0, 'PTY flow must trigger 0 model calls');
    } finally {
      await host.dispose();
    }
  });

  test('10) NotesView "/" live keyword filter & atomic Markdown export (120x36 zh normal Esc & 80x24 --ascii en edit Esc, 0 model calls)', async () => {
    const base = await temps.make('notes-filter');
    const dshHome = join(base, 'dsh-home');
    process.env.DSH_HOME = dshHome;
    const env = { DSH_HOME: dshHome };
    const libraryRoot = join(base, 'library');
    await cloneSampleLibrary('zh', libraryRoot);

    let modelCalls = 0;
    const host = await createTuiHost({
      libraryRoot,
      env,
      home: base,
      documentsDir: base,
      skipAutoProbe: true,
      language: 'zh',
      eventDebounceMs: 25,
      injectedComplete: async () => {
        modelCalls += 1;
        throw new Error('Unexpected LLM call in NotesView filter/export test');
      },
    });

    const { deck, card } = await seedSampleDeckAndCard(host);
    const note2Title = 'R69 Beta';
    const note2Markdown = '# R69 Beta\n\nUnique keyword: R69_ATOMIC_EXPORT_BODY\nAtomic write check.\n';
    const n2 = await host.call('note.create', {
      title: note2Title,
      cards: [{ deckId: deck.id, cardId: card.id }],
      prefill: false,
      language: 'zh',
    });
    assert.equal(n2.ok, true, `note.create 2 failed: ${n2.error?.message || ''}`);
    const s2 = await host.call('note.save', {
      id: n2.value.id,
      title: note2Title,
      markdown: note2Markdown,
      expectedRevision: n2.value.revision ?? 0,
    });
    assert.equal(s2.ok, true, `note.save 2 failed: ${s2.error?.message || ''}`);

    const n1 = await host.call('note.create', {
      title: 'R69 Alpha',
      cards: [{ deckId: deck.id, cardId: card.id }],
      prefill: false,
      language: 'zh',
    });
    assert.equal(n1.ok, true, `note.create 1 failed: ${n1.error?.message || ''}`);
    const s1 = await saveNoteStrictlyNewer(
      host,
      {
        id: n1.value.id,
        title: 'R69 Alpha',
        markdown: '# R69 Alpha\n\nAlpha virtual memory paging overview.\n',
        expectedRevision: n1.value.revision ?? 0,
      },
      s2.value.updatedAt,
    );
    assert.equal(s1.ok, true, `note.save 1 failed: ${s1.error?.message || ''}`);

    await saveTuiPreferences({ language: 'zh', asciiMode: false, sidebarCollapsed: false, showKeyHints: true }, { env });
    resetTuiStore('zh', false);
    const tty = createVirtualTty(120, 36);
    let app = null;
    try {
      app = render(
        React.createElement(StudyHubTuiApp, {
          host,
          initialPage: 'library',
          showLaunchpad: false,
          onExit: () => app?.unmount(),
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
        (s) => s.includes('示例 · Memento 与 Bridge') && !s.includes('正在打开学习库') && !s.includes('正在加载页面'),
        { label: 'LibraryView ready (zh)' },
      );

      tty.send('n');
      const notesReady = await tty.waitFor(
        (s) =>
          s.includes('R69 Alpha') &&
          s.includes('R69 Beta') &&
          !s.includes('载入笔记中') &&
          !s.includes('正在加载页面'),
        { label: 'NotesView with both seeded notes' },
      );
      assert.equal(useTuiStore.getState().page, 'notes');
      tty.assertHealthyScreen(notesReady, 120, 36, 'NotesView initial (120x36 zh)');

      tty.send('/');
      await tty.waitFor((s) => /\[筛选\s+\d+\/\d+\]/.test(s), { label: 'NotesView filter bar opened' });

      tty.send('R69_ATOMIC_EXPORT_BODY');
      const filteredEditing = await tty.waitFor(
        (s) => /\[筛选\s+1\/\d+\]/.test(s) && s.includes('R69 Beta') && !s.includes('R69 Alpha'),
        { label: 'NotesView live-filtered to note 2 while typing' },
      );
      tty.assertHealthyScreen(filteredEditing, 120, 36, 'NotesView filter editing');

      tty.send('\r');
      const filteredConfirmed = await tty.waitFor(
        (s) => /\[已筛选\s+1\/\d+\]/.test(s) && s.includes('R69 Beta') && s.includes('R69_ATOMIC_EXPORT_BODY'),
        { label: 'NotesView filter confirmed with [已筛选 1/Y] badge and note 2 selected' },
      );
      tty.assertHealthyScreen(filteredConfirmed, 120, 36, 'NotesView filter confirmed');

      tty.send('x');
      const exportModal = await tty.waitFor(
        (s) => s.includes('导出 Markdown 笔记') && s.includes('R69 Beta'),
        { label: 'Export modal opened for filtered note 2' },
      );
      tty.assertHealthyScreen(exportModal, 120, 36, 'NotesView export modal');

      tty.send('\r');
      const afterExport = await tty.waitFor(
        (s) => !s.includes('导出 Markdown 笔记') && s.includes('已导出到'),
        { label: 'Export completed and toast displayed' },
      );
      tty.assertHealthyScreen(afterExport, 120, 36, 'NotesView after atomic export');

      const backupsDir = join(libraryRoot, 'backups');
      const entries = await readdir(backupsDir);
      assert.equal(entries.filter((name) => name.includes('.tmp')).length, 0, 'must leave zero .tmp files');
      const noteExport = await findExportedBackupFile(backupsDir, 'studyhub-note', 'md', todayLocalYmd());
      assert.ok(noteExport, `expected studyhub-note-*-${todayLocalYmd()}-HHmmss.md in ${backupsDir}, found: ${JSON.stringify(entries)}`);
      assert.ok(noteExport.name.includes('R69-Beta'), `expected R69-Beta slug in ${noteExport.name}`);
      const written = await readFile(noteExport.path, 'utf8');
      assert.equal(written, note2Markdown);
      assert.ok(written.includes('R69_ATOMIC_EXPORT_BODY'));

      tty.send('\x1b');
      const afterClear = await tty.waitFor(
        (s) => !s.includes('[已筛选') && !s.includes('[筛选') && s.includes('R69 Alpha') && s.includes('R69 Beta'),
        { label: 'Esc cleared filter in normal mode' },
      );
      tty.assertHealthyScreen(afterClear, 120, 36, 'NotesView after Esc clear');

      // Round 76: NoteEditorModal Esc unsaved-draft guard (clean Esc closes immediately; dirty Esc confirms)
      tty.send('e');
      await tty.waitFor((s) => s.includes('编辑笔记') && !s.includes('未保存'), { label: 'NoteEditorModal edit opened clean' });
      tty.send('\x1b');
      await tty.waitFor((s) => !s.includes('编辑笔记') && !s.includes('放弃未保存'), { label: 'Clean edit Esc closes immediately' });

      tty.send('e');
      await tty.waitFor((s) => s.includes('编辑笔记'), { label: 'NoteEditorModal edit reopened' });
      tty.send('UNSAVED_R76_EDIT');
      await tty.waitFor((s) => s.includes('UNSAVED_R76_EDIT') && s.includes('未保存'), { label: 'NoteEditorModal dirty badge shown' });
      tty.send('\x1b');
      const discardDialog = await tty.waitFor(
        (s) => s.includes('放弃未保存的笔记修改'),
        { label: 'NoteEditorModal dirty Esc opened ConfirmDialog' },
      );
      tty.assertHealthyScreen(discardDialog, 120, 36, 'NoteEditorModal discard ConfirmDialog');
      tty.send('n');
      await tty.waitFor(
        (s) => !s.includes('放弃未保存的笔记修改') && s.includes('编辑笔记') && s.includes('UNSAVED_R76_EDIT'),
        { label: 'Cancel discard preserves unsaved edits' },
      );
      tty.send('\x1b');
      await tty.waitFor((s) => s.includes('放弃未保存的笔记修改'), { label: 'Discard ConfirmDialog reopened' });
      tty.send('y');
      await tty.waitFor(
        (s) => !s.includes('编辑笔记') && !s.includes('放弃未保存的笔记修改'),
        { label: 'Confirm discard closed NoteEditorModal' },
      );

      // Switch in-place to 80x24 --ascii en — filter -> Esc while editing clears filter & closes bar
      tty.resize(80, 24);
      host.setLanguage('en');
      useTuiStore.getState().setPreferences({ language: 'en', asciiMode: true });
      useTuiStore.setState({ toasts: [] });

      const notesInitEn = await tty.waitFor(
        (s) => s.includes('R69 Alpha') && s.includes('R69 Beta') && s.includes('To Sources') && s.split('\n').length <= 24,
        { label: 'NotesView rendered (80x24 --ascii en)' },
      );
      assert.equal(useTuiStore.getState().page, 'notes');
      tty.assertHealthyScreen(notesInitEn, 80, 24, 'NotesView initial (80x24 --ascii en)');
      tty.assertAsciiPure(notesInitEn, 'NotesView initial (80x24 --ascii en)');

      tty.send('/');
      await tty.waitFor((s) => /\[Filter\s+\d+\/\d+\]/.test(s), { label: 'Filter bar opened (en)' });

      tty.send('R69_ATOMIC_EXPORT_BODY');
      const filteredEn = await tty.waitFor(
        (s) => /\[Filter\s+1\/\d+\]/.test(s) && s.includes('R69 Beta') && !s.includes('R69 Alpha'),
        { label: 'Filtered to note 2 (80x24 --ascii en)' },
      );
      tty.assertHealthyScreen(filteredEn, 80, 24, 'NotesView filtered (80x24 --ascii en)');
      tty.assertAsciiPure(filteredEn, 'NotesView filtered (80x24 --ascii en)');

      tty.send('\x1b');
      const clearedEn = await tty.waitFor(
        (s) => !s.includes('[Filter') && !s.includes('[Filtered') && s.includes('R69 Alpha') && s.includes('R69 Beta'),
        { label: 'Esc cleared filter (80x24 --ascii en)' },
      );
      tty.assertHealthyScreen(clearedEn, 80, 24, 'NotesView cleared (80x24 --ascii en)');
      tty.assertAsciiPure(clearedEn, 'NotesView cleared (80x24 --ascii en)');
      assert.equal(modelCalls, 0, 'Must make 0 LLM calls');
    } finally {
      try {
        app?.unmount();
      } catch {
        // ignore unmount errors
      }
      tty.dispose();
      await host.dispose();
    }
  });
});

describe('Domain Notes & Board: BoardView PTY E2E (zh & --ascii en)', () => {
  test('11) BoardView (120x36 zh & 80x24 --ascii en): "/" live filter, "x" atomic Markdown export, Esc clear, and SGR 1006 mouse wheel', async () => {
    const box = await temps.make('board-e2e');
    const dshHome = join(box, 'dsh-home');
    const env = { DSH_HOME: dshHome };
    const libraryRoot = join(box, 'library');
    await mkdir(libraryRoot, { recursive: true });
    process.env.DSH_HOME = dshHome;

    await saveBoard(libraryRoot, {
      version: 1,
      cards: [
        {
          id: 'r66-c1',
          title: 'Alpha Algebra Review',
          column: 'todo',
          course: 'LinearMath',
          dueDate: '2026-12-01',
          createdAt: '2026-11-22T01:00:00.000Z',
          updatedAt: '2026-11-22T01:00:00.000Z',
        },
        {
          id: 'r66-c2',
          title: 'Beta Systems Lab',
          column: 'todo',
          course: 'OSKernel',
          dueDate: '2026-12-02',
          createdAt: '2026-11-22T02:00:00.000Z',
          updatedAt: '2026-11-22T02:00:00.000Z',
        },
        {
          id: 'r66-c3',
          title: 'Gamma Neural Nets',
          column: 'todo',
          course: 'DeepLearn',
          dueDate: '2026-12-03',
          createdAt: '2026-11-22T03:00:00.000Z',
          updatedAt: '2026-11-22T03:00:00.000Z',
        },
      ],
      focusStats: {
        date: todayLocalYmd(),
        completedPomodoros: 2,
        focusedMinutes: 50,
      },
      updatedAt: '2026-11-22T04:00:00.000Z',
    });

    await saveTuiPreferences({ language: 'zh', asciiMode: false }, { env });
    let modelCalls = 0;
    const host = await createTuiHost({
      env,
      home: join(box, 'home'),
      libraryRoot,
      skipAutoProbe: true,
      language: 'zh',
      eventDebounceMs: 25,
      injectedComplete: async () => {
        modelCalls += 1;
        throw new Error('Unexpected LLM call in BoardView PTY test');
      },
    });

    resetTuiStore('zh', false);
    const tty = createVirtualTty(120, 36);
    let inst = null;
    try {
      inst = render(
        React.createElement(StudyHubTuiApp, {
          host,
          autoLaunchpad: false,
          onExit: () => inst?.unmount(),
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
      await tty.waitFor((s) => !s.includes('正在打开学习库'), { label: 'LibraryView ready (zh)' });

      tty.send('b');
      const initialBoard = await tty.waitFor(
        (s) =>
          s.includes('待办 Todo') &&
          s.includes('Alpha Algebra Review') &&
          s.includes('Beta Systems Lab') &&
          s.includes('Gamma Neural Nets') &&
          s.includes('正在专注: Alpha Algebra Review'),
        { label: 'BoardView rendered with 3 seeded cards (120x36 zh)' },
      );
      assert.equal(useTuiStore.getState().page, 'board');
      tty.assertHealthyScreen(initialBoard, 120, 36, 'BoardView initial 120x36 zh');

      tty.send('/');
      await tty.waitFor((s) => s.includes('[过滤 3/3]'), { label: 'Inline filter bar opened' });
      tty.send('Beta');
      const filteredEditing = await tty.waitFor(
        (s) =>
          s.includes('[过滤 1/3]') &&
          s.includes('Beta Systems Lab') &&
          !s.includes('Alpha Algebra Review') &&
          !s.includes('Gamma Neural Nets') &&
          s.includes('正在专注: Beta Systems Lab'),
        { label: 'Live keyword filter narrowed to Beta Systems Lab' },
      );
      tty.assertHealthyScreen(filteredEditing, 120, 36, 'BoardView filter editing');

      tty.send('\r');
      const filteredConfirmed = await tty.waitFor(
        (s) => s.includes('[已过滤 1/3]') && s.includes('Beta Systems Lab') && !s.includes('Alpha Algebra Review'),
        { label: 'Enter confirmed filter bar' },
      );
      tty.assertHealthyScreen(filteredConfirmed, 120, 36, 'BoardView filter confirmed');

      tty.send('x');
      const exportToastScreen = await tty.waitFor(
        (s) => s.includes('已导出 3 张卡片'),
        { label: 'Markdown export success toast (zh)' },
      );
      tty.assertHealthyScreen(exportToastScreen, 120, 36, 'BoardView after export');

      const backupsDir = join(libraryRoot, 'backups');
      const backupEntries = await readdir(backupsDir);
      assert.equal(backupEntries.filter((n) => n.includes('.tmp')).length, 0, 'Board export must leave zero .tmp files');
      const boardExport = await findExportedBackupFile(backupsDir, 'studyhub-board', 'md', todayLocalYmd());
      assert.ok(boardExport, `expected studyhub-board-${todayLocalYmd()}-HHmmss.md in ${backupsDir}`);
      const exportedMd = await readFile(boardExport.path, 'utf8');
      assert.ok(exportedMd.includes('# StudyHub Kanban Board'));
      assert.ok(exportedMd.includes('任务总计: 3 (待办: 3, 进行中: 0, 已完成: 0)'));
      assert.ok(exportedMd.includes('番茄专注: 2 次 (50 分钟)'));
      assert.ok(exportedMd.includes('- [ ] Alpha Algebra Review'));
      assert.ok(exportedMd.includes('课程:LinearMath'));
      assert.ok(exportedMd.includes('截止:2026-12-01'));
      assert.ok(exportedMd.includes('- [ ] Beta Systems Lab'));
      assert.ok(exportedMd.includes('课程:OSKernel'));
      assert.ok(exportedMd.includes('- [ ] Gamma Neural Nets'));
      assert.ok(exportedMd.includes('课程:DeepLearn'));

      tty.send('\u001b');
      const clearedScreen = await tty.waitFor(
        (s) =>
          !s.includes('[已过滤') &&
          s.includes('Alpha Algebra Review') &&
          s.includes('Beta Systems Lab') &&
          s.includes('Gamma Neural Nets') &&
          s.includes('正在专注: Alpha Algebra Review'),
        { label: 'Esc cleared active filter cleanly' },
      );
      tty.assertHealthyScreen(clearedScreen, 120, 36, 'BoardView filter cleared');

      tty.send('\x1b[<65;10;10M');
      const wheelDown1 = await tty.waitFor(
        (s) => s.includes('正在专注: Beta Systems Lab'),
        { label: 'SGR wheel down moved selection to Beta Systems Lab' },
      );
      tty.assertHealthyScreen(wheelDown1, 120, 36, 'BoardView wheel down 1');

      tty.send('\x1b[<65;10;10M');
      const wheelDown2 = await tty.waitFor(
        (s) => s.includes('正在专注: Gamma Neural Nets'),
        { label: 'SGR wheel down moved selection to Gamma Neural Nets' },
      );
      tty.assertHealthyScreen(wheelDown2, 120, 36, 'BoardView wheel down 2');

      tty.send('\x1b[<64;10;10M');
      const wheelUp = await tty.waitFor(
        (s) => s.includes('正在专注: Beta Systems Lab'),
        { label: 'SGR wheel up moved selection back to Beta Systems Lab' },
      );
      tty.assertHealthyScreen(wheelUp, 120, 36, 'BoardView wheel up');

      // Round 78: BoardCardModal Esc dirty guard (clean Esc immediate; dirty Esc -> ConfirmDialog)
      tty.send('e');
      await tty.waitFor((s) => s.includes('编辑看板任务') && !s.includes('未保存'), {
        label: 'BoardCardModal edit opened clean',
      });
      tty.send('\x1b');
      await tty.waitFor((s) => !s.includes('编辑看板任务') && !s.includes('放弃未保存'), {
        label: 'Clean BoardCardModal Esc closed immediately',
      });
      tty.send('e');
      await tty.waitFor((s) => s.includes('编辑看板任务'), { label: 'BoardCardModal edit reopened' });
      tty.send(' R78_DIRTY');
      await tty.waitFor((s) => s.includes('R78_DIRTY') && s.includes('未保存'), {
        label: 'BoardCardModal shows unsaved badge',
      });
      tty.send('\x1b');
      const boardDiscardDialog = await tty.waitFor((s) => s.includes('放弃未保存的看板卡片修改'), {
        label: 'BoardCardModal dirty Esc opened ConfirmDialog',
      });
      tty.assertHealthyScreen(boardDiscardDialog, 120, 36, 'BoardCardModal discard ConfirmDialog');
      tty.send('n');
      await tty.waitFor(
        (s) => !s.includes('放弃未保存的看板卡片修改') && s.includes('编辑看板任务') && s.includes('R78_DIRTY'),
        { label: 'BoardCardModal discard cancel preserved typed edit' },
      );
      tty.send('\x1b');
      await tty.waitFor((s) => s.includes('放弃未保存的看板卡片修改'), {
        label: 'BoardCardModal discard ConfirmDialog reopened',
      });
      tty.send('y');
      await tty.waitFor((s) => !s.includes('编辑看板任务') && !s.includes('放弃未保存的看板卡片修改'), {
        label: 'BoardCardModal confirm discard closed cleanly',
      });

      // Switch in-place to 80x24 --ascii en (reuses single mounted app)
      await rm(backupsDir, { recursive: true, force: true });
      tty.resize(80, 24);
      host.setLanguage('en');
      useTuiStore.getState().setPreferences({ language: 'en', asciiMode: true });
      useTuiStore.setState({ toasts: [] });

      const boardScreenEn = await tty.waitFor(
        (s) => s.includes('Todo') && s.includes('Beta Systems Lab') && s.includes('Focus: Beta Systems Lab') && s.split('\n').length <= 24,
        { label: 'BoardView rendered at 80x24 --ascii en' },
      );
      assert.equal(useTuiStore.getState().page, 'board');
      tty.assertHealthyScreen(boardScreenEn, 80, 24, 'BoardView 80x24 ascii en');
      tty.assertAsciiPure(boardScreenEn, 'BoardView 80x24 ascii en');

      tty.send('/');
      await tty.waitFor((s) => s.includes('[Filter 3/3]'), { label: 'Ascii filter bar opened' });
      tty.send('Algebra');
      const filteredScreenEn = await tty.waitFor(
        (s) =>
          s.includes('[Filter 1/3]') &&
          s.includes('Alpha Algebra Review') &&
          !s.includes('Beta Systems Lab') &&
          s.includes('Focus: Alpha Algebra Review'),
        { label: 'Ascii filter narrowed to Alpha Algebra Review' },
      );
      tty.assertHealthyScreen(filteredScreenEn, 80, 24, 'BoardView 80x24 ascii filter');
      tty.assertAsciiPure(filteredScreenEn, 'BoardView 80x24 ascii filter');

      tty.send('\r');
      const confirmedScreenEn = await tty.waitFor(
        (s) => s.includes('[Filtered 1/3]') && s.includes('Alpha Algebra Review'),
        { label: 'Ascii filter confirmed' },
      );
      tty.assertHealthyScreen(confirmedScreenEn, 80, 24, 'BoardView 80x24 ascii filter confirmed');
      tty.assertAsciiPure(confirmedScreenEn, 'BoardView 80x24 ascii filter confirmed');

      tty.send('x');
      const exportedScreenEn = await tty.waitFor(
        (s) => s.includes('Exported 3 cards ->'),
        { label: 'Ascii export toast rendered' },
      );
      tty.assertHealthyScreen(exportedScreenEn, 80, 24, 'BoardView 80x24 ascii export toast');
      tty.assertAsciiPure(exportedScreenEn, 'BoardView 80x24 ascii export toast');

      const boardExportEn = await findExportedBackupFile(backupsDir, 'studyhub-board', 'md', todayLocalYmd());
      assert.ok(boardExportEn, `expected studyhub-board-${todayLocalYmd()}-HHmmss.md in ${backupsDir}`);
      const exportedMdEn = await readFile(boardExportEn.path, 'utf8');
      assert.ok(exportedMdEn.includes('# StudyHub Kanban Board'));
      assert.ok(exportedMdEn.includes('Cards: 3 (Todo: 3, Doing: 0, Done: 0)'));
      assert.ok(exportedMdEn.includes('Pomodoro: 2 (50m)'));
      assert.ok(exportedMdEn.includes('- [ ] Alpha Algebra Review'));
      assert.ok(exportedMdEn.includes('course:LinearMath'));
      assert.ok(exportedMdEn.includes('due:2026-12-01'));
      assert.ok(exportedMdEn.includes('- [ ] Beta Systems Lab'));
      assert.ok(exportedMdEn.includes('course:OSKernel'));
      assert.ok(exportedMdEn.includes('- [ ] Gamma Neural Nets'));
      assert.ok(exportedMdEn.includes('course:DeepLearn'));
      assert.equal(modelCalls, 0, 'BoardView PTY flow must make 0 model calls');
    } finally {
      try {
        inst?.unmount();
      } catch {
        // Ignore unmount error
      }
      tty.dispose();
      await host.dispose();
    }
  });
});
