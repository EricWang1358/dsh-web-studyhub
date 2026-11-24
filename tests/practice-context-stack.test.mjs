import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadUi } from './helpers/ui-module.mjs';
import { StudyService } from '../lib/service.js';
import { parseDraft } from '../lib/review-draft.js';
import { entryForRun } from '../ui/review/session-logic.js';
import {
  capturePracticeFrame,
  clearLastPracticePosition,
  isDraftRestorable,
  originKindForDestination,
  peekPracticeFrame,
  popPracticeFrame,
  popToOriginalFrame,
  pushPracticeFrame,
  readLastPracticePosition,
  restorePracticeFrame,
  rootPracticeFrame,
  saveLastPracticePosition,
} from '../ui/practice-context-stack.js';

let uiCache;
function loadUiComponents() {
  return (uiCache ??= loadUi(`
    export { PracticeReturnChip, PracticeEndedBanner } from './ui/app/PracticeReturnChip.jsx';
    export { SimilarQuestionsList } from './ui/review/SimilarTry.jsx';
  `));
}

function makeMemoryStorage() {
  const map = new Map();
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k),
  };
}

test('#1319-1: multi-hop stack push (原题 -> 原文 -> 同类题 -> 错题本 -> 统计) pops layer by layer back to original and persists last position', () => {
  const root = '/tmp/lib-demo';
  const storage = makeMemoryStorage();

  const origRun = { id: 'run-orig', deckId: 'd1', index: 2, total: 10, card: { id: 'c-orig', kind: 'quiz', topic: 'TCP', prompt: 'Original TCP question?' } };
  const simRun1 = { id: 'run-sim-1', deckId: 'd1', index: 0, total: 1, card: { id: 'c-sim-1', kind: 'quiz', topic: 'TCP', prompt: 'Similar TCP question 1?' } };
  const simRun2 = { id: 'run-sim-2', deckId: 'd1', index: 0, total: 1, card: { id: 'c-sim-2', kind: 'open', topic: 'TCP', prompt: 'Similar TCP question 2?' } };

  let stack = [];
  // Hop 1: 原题 -> 原文 (source)
  const f1 = capturePracticeFrame({
    root,
    run: origRun,
    entry: { selected: ['b'], response: '', clozeValues: [] },
    reading: { sourceId: 'src-1', page: 4, scrollTop: 120 },
    originKind: originKindForDestination('sources', { type: 'source' }),
    now: 1000,
  });
  assert.equal(f1.originKind, 'source');
  stack = pushPracticeFrame(stack, f1);
  saveLastPracticePosition(storage, root, f1);

  // Hop 2: 原文 -> 同类题 1 (similar)
  const f2 = capturePracticeFrame({ root, run: simRun1, entry: { selected: ['a'], response: '', clozeValues: [] }, originKind: 'similar', now: 2000 });
  stack = pushPracticeFrame(stack, f2);

  // Hop 3: 同类题 1 -> 同类题 2 -> 错题本 (wrongbook)
  const f3 = capturePracticeFrame({ root, run: simRun2, entry: { selected: [], response: 'draft on sim 2', clozeValues: [] }, originKind: originKindForDestination('wrongbook'), now: 3000 });
  assert.equal(f3.originKind, 'wrongbook');
  stack = pushPracticeFrame(stack, f3);

  // Hop 4: 错题本 -> 统计 (stats) — originKind classification verified
  assert.equal(originKindForDestination('dashboard'), 'stats');
  assert.equal(originKindForDestination('examcoach'), 'coach');
  assert.equal(originKindForDestination('search'), 'search');

  assert.equal(stack.length, 3);
  assert.equal(rootPracticeFrame(stack).cardId, 'c-orig');
  assert.equal(peekPracticeFrame(stack).cardId, 'c-sim-2');

  // Pop layer by layer: sim-2 -> sim-1 -> orig
  let popped = popPracticeFrame(stack);
  assert.equal(popped.frame.cardId, 'c-sim-2');
  stack = popped.stack;

  popped = popPracticeFrame(stack);
  assert.equal(popped.frame.cardId, 'c-sim-1');
  stack = popped.stack;

  popped = popPracticeFrame(stack);
  assert.equal(popped.frame.cardId, 'c-orig');
  assert.equal(popped.frame.index, 2);
  assert.deepEqual(popped.frame.reading, { sourceId: 'src-1', page: 4, scrollTop: 120 });
  assert.equal(popped.stack.length, 0);

  // One-click popToOriginalFrame jumps straight to bottom-most original frame
  const deepStack = pushPracticeFrame(pushPracticeFrame([f1], f2), f3);
  const direct = popToOriginalFrame(deepStack);
  assert.equal(direct.frame.cardId, 'c-orig');
  assert.equal(direct.stack.length, 0);

  // localStorage persistence for startup "继续上次（第 N 题）"
  const restored = readLastPracticePosition(storage, root);
  assert.equal(restored.runId, 'run-orig');
  assert.equal(restored.cardId, 'c-orig');
  assert.equal(restored.index, 2);
  clearLastPracticePosition(storage, root);
  assert.equal(readLastPracticePosition(storage, root), null);
});

test('#1319-2: returning restores choice, cloze, and open drafts intact without overwriting already-submitted answers', async () => {
  const root = '/tmp/lib-draft';

  // 1) Choice draft
  const choiceFrame = capturePracticeFrame({
    root,
    run: { id: 'r-choice', deckId: 'd1', index: 1, total: 5, card: { id: 'c-choice', kind: 'multi', prompt: 'Pick two' } },
    entry: { selected: ['a', 'c'], response: '', clozeValues: [], hint: true },
  });
  let movedArgs = null;
  const resChoice = await restorePracticeFrame({
    frame: choiceFrame,
    call: async (op, args) => {
      if (op === 'review.get') return { id: 'r-choice', deckId: 'd1', index: 0, card: { id: 'c-other' } };
      if (op === 'review.move') return { id: 'r-choice', deckId: 'd1', index: args.index, card: { id: 'c-choice' } };
      throw new Error(`unexpected op ${op}`);
    },
    enterMovedRun: (run, draft) => { movedArgs = { run, draft }; },
  });
  assert.equal(resChoice.status, 'restored');
  assert.equal(resChoice.draftRestored, true);
  assert.deepEqual(movedArgs.draft.selected, ['a', 'c']);
  assert.equal(movedArgs.draft.hint, true);

  // 2) Cloze draft (plain object { [blankId]: string }, never an array)
  const clozeRun = { id: 'r-cloze', deckId: 'd1', index: 0, total: 3, card: { id: 'c-cloze', kind: 'cloze', prompt: '{{A}} and {{B}}' } };
  const clozeFrame = capturePracticeFrame({
    root,
    run: clozeRun,
    entry: { selected: [], response: '', clozeValues: { b1: 'SYN', b2: 'ACK' } },
  });
  const resCloze = await restorePracticeFrame({
    frame: clozeFrame,
    call: async (op) => (op === 'review.get' ? clozeRun : null),
    enterMovedRun: (run, draft) => { movedArgs = { run, draft }; },
  });
  assert.equal(resCloze.draftRestored, true);
  assert.deepEqual(movedArgs.draft.clozeValues, { b1: 'SYN', b2: 'ACK' });
  const restoredEntry = entryForRun(clozeRun, movedArgs.draft, { draft: () => '' });
  assert.deepEqual(restoredEntry.clozeValues, { b1: 'SYN', b2: 'ACK' });
  assert.doesNotThrow(() => parseDraft({ stepInputs: restoredEntry.clozeValues }), 'restored clozeValues must be valid for review.draft.save');

  // 3) Open-ended draft
  const openFrame = capturePracticeFrame({
    root,
    run: { id: 'r-open', deckId: 'd1', index: 3, total: 6, card: { id: 'c-open', kind: 'open', prompt: 'Explain CAP' } },
    entry: { selected: [], response: 'Partition tolerance requires choosing C or A.', clozeValues: [] },
  });
  const resOpen = await restorePracticeFrame({
    frame: openFrame,
    call: async (op) => (op === 'review.get' ? { id: 'r-open', deckId: 'd1', index: 3, card: { id: 'c-open' } } : null),
    enterMovedRun: (run, draft) => { movedArgs = { run, draft }; },
  });
  assert.equal(resOpen.draftRestored, true);
  assert.equal(movedArgs.draft.response, 'Partition tolerance requires choosing C or A.');

  // 4) Already-submitted card: draft is NOT restored over submitted verdict
  assert.equal(isDraftRestorable(openFrame, { id: 'r-open', index: 3, card: { id: 'c-open' }, feedback: { correct: true, grade: 5 } }), false);
});

test('#1319-3: SimilarQuestionsList highlights original question with one-click 回到原题 and review.similar returns candidate items', async t => {
  const { SimilarQuestionsList } = await loadUiComponents();
  const html = renderToStaticMarkup(React.createElement(SimilarQuestionsList, {
    originCard: { deckId: 'd1', cardId: 'c-orig', prompt: 'Original question stem' },
    items: [
      { deckId: 'd1', cardId: 'c-sim-1', topic: 'TCP', prompt: 'Similar question 1' },
      { deckId: 'd1', cardId: 'c-sim-2', topic: 'TCP', prompt: 'Similar question 2' },
    ],
    activeCardId: 'c-sim-1',
    onSelectItem: () => {},
    onRestoreOriginal: () => {},
    onClose: () => {},
  }));
  assert.match(html, /data-similar-origin="true"/, 'original question row is highlighted');
  assert.match(html, /原题/, 'original badge is shown');
  assert.match(html, /回到原题/, 'one-click return to original is rendered');
  assert.match(html, /Similar question 2/, 'other similar candidate is listed');
  assert.match(html, /当前题/, 'currently active similar question is marked');

  // Verify backend review.similar returns both `item` and `items` array
  const tmp = mkdtempSync(join(tmpdir(), 'studyhub-1319-sim-'));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  const service = new StudyService(tmp);
  await service.store.update(state => {
    state.courses = [{ id: 'c-net', name: 'Networks' }];
    state.decks = [{
      id: 'd-net',
      title: 'TCP Deck',
      course: 'Networks',
      cards: [
        { id: 'c-orig', kind: 'quiz', topic: 'TCP Congestion', prompt: 'What is slow start?', answer: 'Exponential growth', options: [{ id: 'a', text: 'Exponential' }, { id: 'b', text: 'Linear' }, { id: 'c', text: 'Constant' }] },
        { id: 'c-sim-1', kind: 'quiz', topic: 'TCP Congestion', prompt: 'What triggers fast retransmit?', answer: '3 dup ACKs', options: [{ id: 'a', text: '3 dup ACKs' }, { id: 'b', text: 'Timeout' }, { id: 'c', text: 'FIN' }] },
        { id: 'c-sim-2', kind: 'quiz', topic: 'TCP Congestion', prompt: 'How does AIMD adjust cwnd?', answer: '+1 MSS / half', options: [{ id: 'a', text: '+1 MSS / half' }, { id: 'b', text: 'Double' }, { id: 'c', text: 'Reset' }] },
      ],
    }];
  });
  const started = await service.call('review.start', { mode: 'path', scope: [{ deckId: 'd-net', cardId: 'c-orig' }] });
  const sim = await service.call('review.similar', { runId: started.id, cardId: 'c-orig', limit: 6 });
  assert.ok(sim.item, 'backward-compatible single item is returned');
  assert.ok(Array.isArray(sim.items) && sim.items.length === 2, 'items list includes all similar candidates');
});

test('#1319-4: ended original run returns explicit notice and 重新练这道题 without silent jump', async () => {
  const { PracticeEndedBanner } = await loadUiComponents();
  const frame = capturePracticeFrame({
    root: '/tmp/lib-ended',
    run: { id: 'run-ended', deckId: 'd1', index: 4, total: 10, card: { id: 'c-5', kind: 'quiz', prompt: 'Question 5 stem' } },
    entry: { selected: ['a'] },
  });

  let entered = false;
  let endedPayload = null;
  const result = await restorePracticeFrame({
    frame,
    call: async (op) => {
      if (op === 'review.get') return { id: 'run-ended', deckId: 'd1', index: 4, complete: true, closed: true, card: null };
      throw new Error(`unexpected ${op}`);
    },
    enterMovedRun: () => { entered = true; },
    onEnded: (payload) => { endedPayload = payload; },
  });

  assert.equal(result.status, 'ended');
  assert.equal(entered, false, 'must not silently jump to an ended run');
  assert.deepEqual(result.practiceAgainScope, [{ deckId: 'd1', cardId: 'c-5' }]);
  assert.match(result.message, /第 5 题.*已结束/);

  const bannerHtml = renderToStaticMarkup(React.createElement(PracticeEndedBanner, {
    ended: endedPayload,
    onPracticeAgain: () => {},
    onDismiss: () => {},
  }));
  assert.match(bannerHtml, /data-practice-ended-banner/);
  assert.match(bannerHtml, /原来的第 5 题所在练习已结束/);
  assert.match(bannerHtml, /重新练这道题/);
});

test('#1319-5: top-bar chip 回到第 N 题 is visible on every page when stack is non-empty and resumes last on startup', async () => {
  const { PracticeReturnChip } = await loadUiComponents();
  const frame = capturePracticeFrame({
    root: '/tmp/lib-chip',
    run: { id: 'r1', deckId: 'd1', index: 2, total: 8, card: { id: 'c3', kind: 'quiz', prompt: 'Q3' } },
    entry: { selected: ['a'] },
  });
  const stack = pushPracticeFrame([], frame);

  // Visible on EVERY non-review page AND when inside a different review detour
  for (const page of ['sources', 'wrongbook', 'dashboard', 'examcoach', 'library', 'notes', 'book', 'settings']) {
    const html = renderToStaticMarkup(React.createElement(PracticeReturnChip, {
      stack,
      page,
      run: null,
      onRestore: () => {},
    }));
    assert.match(html, /data-practice-return-chip/, `chip visible on page=${page}`);
    assert.match(html, /回到第 3 题/, `chip displays 1-based question number on page=${page}`);
  }

  // Visible on review page when viewing a different question (detour)
  const detourHtml = renderToStaticMarkup(React.createElement(PracticeReturnChip, {
    stack,
    page: 'review',
    run: { id: 'r-sim', index: 0, card: { id: 'c-sim' } },
    onRestore: () => {},
  }));
  assert.match(detourHtml, /回到第 3 题/);

  // Hidden on review page when already back on the exact same question (coexists with Socratic drawer)
  const sameHtml = renderToStaticMarkup(React.createElement(PracticeReturnChip, {
    stack,
    page: 'review',
    run: { id: 'r1', index: 2, card: { id: 'c3' } },
    modal: null,
    onRestore: () => {},
  }));
  assert.equal(sameHtml, '', 'chip hides when already on the exact same question without modal');

  // Startup "继续上次（第 N 题）" chip when stack is empty and localStorage has lastPractice
  const resumeHtml = renderToStaticMarkup(React.createElement(PracticeReturnChip, {
    stack: [],
    page: 'library',
    lastPractice: { runId: 'r1', cardId: 'c3', index: 2, runComplete: false },
    onPracticeResume: () => {},
  }));
  assert.match(resumeHtml, /data-practice-resume-chip/);
  assert.match(resumeHtml, /继续上次（第 3 题）/);
});

test('#1319-6: returning never triggers re-grading or model/billing calls', async () => {
  const frame = capturePracticeFrame({
    root: '/tmp/lib-nobill',
    run: { id: 'r-bill', deckId: 'd1', index: 1, total: 4, card: { id: 'c2', kind: 'open', prompt: 'Open Q' } },
    entry: { response: 'unfinished draft' },
  });

  const calledOps = [];
  const res = await restorePracticeFrame({
    frame,
    call: async (op, args) => {
      calledOps.push(op);
      if (op === 'review.get') return { id: 'r-bill', deckId: 'd1', index: 0, card: { id: 'c1' } };
      if (op === 'review.move') return { id: 'r-bill', deckId: 'd1', index: args.index, card: { id: 'c2' } };
      throw new Error(`Forbidden RPC during return: ${op}`);
    },
    enterMovedRun: () => {},
  });

  assert.equal(res.status, 'restored');
  assert.deepEqual(calledOps, ['review.get', 'review.move']);
  const forbidden = calledOps.filter(op => /answer|grade|assist|socratic|generate|rubric|teach/.test(op));
  assert.deepEqual(forbidden, [], 'return must trigger 0 grading calls and 0 model/billing calls');
});

test('#1323-10: normalizes legacy array clozeValues to {} and preserves courseSwitched on adjacent frame merge', () => {
  const root = '/tmp/lib-1323-10';
  const storage = makeMemoryStorage();
  const run = { id: 'r-open', deckId: 'd1', index: 1, total: 4, card: { id: 'c-open', kind: 'open', prompt: 'Explain TCP' } };

  // Non-cloze / malformed array clozeValues must never survive as []
  const captured = capturePracticeFrame({
    root,
    run,
    entry: { selected: [], response: 'draft', clozeValues: [] },
    course: 'Course A',
    courseSwitched: true,
    now: 100,
  });
  assert.deepEqual(captured.draft.clozeValues, {});
  assert.equal(Array.isArray(captured.draft.clozeValues), false);
  const openEntry = entryForRun(run, captured.draft, { draft: () => '' });
  assert.doesNotThrow(() => parseDraft({ text: openEntry.response, stepInputs: openEntry.clozeValues }));

  // Legacy corrupted storage payload with clozeValues: [] is sanitized on read and in entryForRun
  storage.setItem(`studyhub:last-practice:${root}`, JSON.stringify({
    ...captured,
    draft: { ...captured.draft, clozeValues: ['stale'] },
  }));
  const loaded = readLastPracticePosition(storage, root);
  assert.deepEqual(loaded.draft.clozeValues, {});
  const defendedEntry = entryForRun(run, { ...captured.draft, clozeValues: ['stale'] }, { draft: () => '' });
  assert.deepEqual(defendedEntry.clozeValues, {});

  // Adjacent merge (e.g. rememberContext(courseSwitched: true) followed by leaveReviewRef(courseSwitched: false))
  // MUST keep courseSwitched: true and the original pre-switch course!
  let stack = pushPracticeFrame([], captured);
  const followUp = capturePracticeFrame({
    root,
    run,
    entry: { selected: [], response: 'draft', clozeValues: {} },
    course: 'Course B',
    courseSwitched: false,
    originKind: 'wrongbook',
    now: 200,
  });
  stack = pushPracticeFrame(stack, followUp);
  assert.equal(stack.length, 1);
  assert.equal(stack[0].courseSwitched, true);
  assert.equal(stack[0].course, 'Course A');
  assert.equal(stack[0].originKind, 'wrongbook');
});
