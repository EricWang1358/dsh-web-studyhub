/* Wave 3C (Evolution 4: Dual-Surface Anti-Spoiling Contract):
   - Narrow `attempts`-only `attempt.errorReason.set` contract & StudyService persistence
   - `review.lookBack` + `RoundLookBack` persisted `#1156` errorReason restore & toggle write-back (0 extra prompts)
   - Optional single-line `thinkingNote` inside existing 「帮我弄懂」 / custom follow-up ONLY (0 new toolbar buttons)
   - `skills/study-tutor/SKILL.md` cross-skill continuity, One-Inference-Step Lock, & unconditional immediate release */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { StudyService } from '../lib/service.js';
import { writesFor } from '../lib/runtime/domain-contracts.js';
import {
  ERROR_REASONS,
  normalizeErrorReason,
  normalizeThinkingNote,
} from '../lib/contexts/study/error-reason.js';
import { TRIAGE_REASONS } from '../lib/evidence/mistake-triage.js';
import { projectTrapLedger, TRAP_ERROR_REASONS } from '../lib/contexts/study/trap-projection.js';
import { buildCompactScene } from '../lib/study-scene.js';
import { parseSkill } from '../lib/study-skills.js';
import {
  persistRowReason,
  rowReasonKey,
  seedReasonsFromRows,
} from '../ui/review/lookback-recall.js';
import { nativeSelects } from './helpers/native-selects.mjs';

const require = createRequire(import.meta.url);
const compiled = await build({
  stdin: {
    contents: `export { default as RoundLookBack } from './ui/review/RoundLookBack.jsx';
      export { default as ExplanationFollowup } from './ui/ExplanationFollowup.jsx';
      export { StudyServicesContext } from './ui/study-context.jsx';
      export { AppContext } from './ui/app/app-context.js';
      export { setQueryData } from './ui/host-query.js';
      export { ENGLISH_SOURCES, mergeCatalogues, setUiLanguage, ui, uiCatalogue } from './ui/i18n.js';`,
    resolveDir: process.cwd(),
  },
  bundle: true,
  write: false,
  platform: 'node',
  format: 'cjs',
  external: ['react', 'react-dom'],
  plugins: [nativeSelects],
  loader: { '.css': 'text' },
  logLevel: 'silent',
});
const mod = { exports: {} };
new Function('require', 'module', 'exports', compiled.outputFiles[0].text)(require, mod, mod.exports);
const uiMod = mod.exports;
Object.assign(uiMod.uiCatalogue(), uiMod.mergeCatalogues(uiMod.ENGLISH_SOURCES).catalogue);

const h = React.createElement;
const han = /\p{Script=Han}/u;

function mountSync(services, appData = null) {
  const internals = React.__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE;
  const hooks = [];
  const cleanups = [];
  let cursor = 0;
  let pending = [];
  const sameDeps = (a, b) => Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((v, i) => Object.is(v, b[i]));
  return {
    render(Component, props) {
      cursor = 0;
      pending = [];
      const prev = internals.H;
      internals.H = {
        useContext: (ctx) => {
          if (ctx === uiMod.StudyServicesContext) return services;
          if (ctx === uiMod.AppContext) return appData ? { data: appData } : ctx._currentValue;
          return ctx._currentValue;
        },
        useState: (init) => {
          const i = cursor++;
          if (!(i in hooks)) {
            hooks[i] = [typeof init === 'function' ? init() : init, (val) => {
              hooks[i][0] = typeof val === 'function' ? val(hooks[i][0]) : val;
            }];
          }
          return hooks[i];
        },
        useRef: (init) => { const i = cursor++; if (!(i in hooks)) hooks[i] = { current: init }; return hooks[i]; },
        useMemo: (fn, deps) => { const i = cursor++; if (!(i in hooks) || !sameDeps(hooks[i].deps, deps)) hooks[i] = { deps, value: fn() }; return hooks[i].value; },
        useCallback: (fn, deps) => internals.H.useMemo(() => fn, deps),
        useEffect: (fn, deps) => { const i = cursor++; if (!(i in hooks) || !sameDeps(hooks[i].deps, deps)) pending.push({ i, fn, deps }); },
        useLayoutEffect: (fn, deps) => internals.H.useEffect(fn, deps),
        useInsertionEffect: (fn, deps) => internals.H.useEffect(fn, deps),
        useId: () => { const i = cursor++; if (!(i in hooks)) hooks[i] = `:w3c-${i}:`; return hooks[i]; },
        useDeferredValue: (v) => v,
        useSyncExternalStore: (_sub, getSnap) => getSnap(),
      };
      let tree;
      try { tree = Component(props); } finally { internals.H = prev; }
      for (const eff of pending) {
        cleanups[eff.i]?.();
        cleanups[eff.i] = undefined;
        const done = eff.fn();
        hooks[eff.i] = { deps: eff.deps };
        if (typeof done === 'function') cleanups[eff.i] = done;
      }
      return tree;
    },
    unmount() { for (const c of cleanups) c?.(); },
  };
}

function walkTree(node, visit) {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) { for (const child of node) walkTree(child, visit); return; }
  if (node.props) {
    visit(node);
    if (typeof node.props.render === 'function' && Array.isArray(node.props.items)) {
      node.props.items.forEach((item) => walkTree(node.props.render(item), visit));
    }
    walkTree(node.props.children, visit);
  }
}

function findNodes(tree, pred) {
  const out = [];
  walkTree(tree, (node) => { if (pred(node)) out.push(node); });
  return out;
}

test('domain contract narrows attempt.errorReason.set write lock strictly to attempts', () => {
  assert.deepEqual(writesFor('study', 'attempt.errorReason.set'), ['attempts']);
  assert.deepEqual([...ERROR_REASONS], ['concept', 'condition', 'derivation', 'slip', 'prerequisite', 'bad_question']);
  assert.equal(ERROR_REASONS, TRIAGE_REASONS);
  assert.equal(TRAP_ERROR_REASONS, TRIAGE_REASONS);
  assert.equal(normalizeErrorReason('condition'), 'condition');
  assert.equal(normalizeErrorReason('prerequisite'), 'prerequisite');
  assert.equal(normalizeErrorReason('bad_question'), 'bad_question');
  assert.equal(normalizeErrorReason(''), null);
  assert.equal(normalizeErrorReason(null), null);
  assert.throws(() => normalizeErrorReason('bogus'), { code: 'invalid-error-reason' });
  assert.equal(normalizeThinkingNote('  missed   edge\ncase  '), 'missed edge case');
  const exact200 = `${'a'.repeat(199)}Z`;
  assert.equal(normalizeThinkingNote(exact200), exact200);
  assert.equal(normalizeThinkingNote(`${exact200}!`), exact200);
  assert.equal(normalizeThinkingNote('x'.repeat(250)).length, 200);
  assert.equal(normalizeThinkingNote('   '), null);
  assert.equal(normalizeThinkingNote(null), null);
  assert.throws(() => normalizeThinkingNote(123), { code: 'invalid-thinking-note' });
});

test('StudyService attempt.errorReason.set persists errorReason + thinkingNote without touching FSRS and projects through review.lookBack', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'studyhub-w3c-reason-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const study = new StudyService(dir);

  await study.call('deck.import', {
    text: JSON.stringify({
      title: 'Probability',
      course: 'CS2030',
      cards: [{
        id: 'card-indep-1',
        kind: 'quiz',
        topic: 'Independence',
        objective: 'Check condition for product rule',
        prompt: 'When does P(A and B) = P(A)P(B)?',
        options: [
          { id: 'a', text: 'Always', correct: false, explanation: 'Only under independence.' },
          { id: 'b', text: 'When A and B are independent', correct: true, explanation: 'Definition of independence.' },
          { id: 'c', text: 'When A and B are mutually exclusive', correct: false, explanation: 'Mutually exclusive events with positive probability are dependent.' },
        ],
        answer: 'When A and B are independent',
        explanation: 'Definition of independence.',
        misconception: 'Assuming disjoint events are independent.',
      }],
    }),
  });
  const snapBefore = await study.store.read();
  const deck = snapBefore.decks[0];
  assert.ok(deck, 'imported deck exists');
  const deckId = deck.id;
  const cardId = deck.cards[0].id;

  // Before any attempt exists: clean non-writing response, no crash.
  const missing = await study.call('attempt.errorReason.set', { deckId, cardId, errorReason: 'concept' });
  assert.equal(missing.ok, false);
  assert.equal(missing.updated, false);
  assert.equal(missing.reason, 'attempt-not-found');

  // Answer wrongly in a review run and finish the run.
  const run = await study.call('review.start', { deckId, mode: 'quiz' });
  const wrongOpt = run.card.options.find((opt) => opt.text === 'Always');
  await study.call('review.answer', { runId: run.id, cardId, index: run.index, selected: [wrongOpt.id] });
  await study.call('review.end', { runId: run.id });

  const stateAfterAnswer = await study.store.read();
  const cardFsrsBefore = structuredClone(stateAfterAnswer.decks.find((d) => d.id === deckId).cards[0].fsrs);
  const attemptGradeBefore = stateAfterAnswer.attempts.at(-1).grade;

  // Persist errorReason + overlong thinkingNote.
  const longNote = `  I confused disjoint   with independent ${'z'.repeat(240)}`;
  const saved = await study.call('attempt.errorReason.set', {
    deckId,
    cardId,
    runId: run.id,
    errorReason: 'condition',
    thinkingNote: longNote,
  });
  assert.equal(saved.ok, true);
  assert.equal(saved.updated, true);
  assert.equal(saved.errorReason, 'condition');
  assert.equal(saved.thinkingNote.length, 200);
  assert.match(saved.thinkingNote, /^I confused disjoint with independent z+$/);

  // Verify persisted on store v5 attempt without mutating FSRS or grade.
  const stateAfterTag = await study.store.read();
  const att = stateAfterTag.attempts.at(-1);
  assert.equal(att.errorReason, 'condition');
  assert.equal(att.thinkingNote, saved.thinkingNote);
  assert.equal(typeof att.errorReasonUpdatedAt, 'string');
  assert.equal(att.grade, attemptGradeBefore);
  assert.deepEqual(stateAfterTag.decks.find((d) => d.id === deckId).cards[0].fsrs, cardFsrsBefore);

  // review.lookBack projects both errorReason and thinkingNote onto the look-back row.
  const lookBack = await study.call('review.lookBack', { runId: run.id });
  assert.equal(lookBack.rows.length, 1);
  assert.equal(lookBack.rows[0].errorReason, 'condition');
  assert.equal(lookBack.rows[0].thinkingNote, saved.thinkingNote);

  // Persist the 2 extended 6-state triage reasons (`prerequisite` and `bad_question`) end-to-end through store, trapLedger, and study-scene.
  for (const extendedReason of ['prerequisite', 'bad_question']) {
    const extSaved = await study.call('attempt.errorReason.set', {
      deckId,
      cardId,
      runId: run.id,
      errorReason: extendedReason,
    });
    assert.equal(extSaved.ok, true);
    assert.equal(extSaved.errorReason, extendedReason);

    const extState = await study.store.read();
    const extCard = extState.decks.find((d) => d.id === deckId).cards[0];
    const trap = projectTrapLedger(extState, { card: extCard, cardId, course: 'CS2030' });
    assert.equal(trap.cue.latestErrorReason, extendedReason);
    assert.equal(trap.cue.errorReasons[extendedReason], 1);
    assert.match(trap.cue.trapCue, new RegExp(`${extendedReason}x1`));

    const fallbackScene = buildCompactScene(extState);
    assert.equal(fallbackScene.recentAttempts.at(-1).errorReason, extendedReason);
    assert.equal(fallbackScene.trapLedger.latestErrorReason, extendedReason);
    assert.equal(fallbackScene.trapLedger.errorReasons[extendedReason], 1);
  }

  // Clearing errorReason preserves thinkingNote; invalid errorReason rejects cleanly.
  const cleared = await study.call('attempt.errorReason.set', { deckId, cardId, runId: run.id, errorReason: null });
  assert.equal(cleared.errorReason, null);
  assert.equal(cleared.thinkingNote, saved.thinkingNote);

  await assert.rejects(
    () => study.call('attempt.errorReason.set', { deckId, cardId, runId: run.id, errorReason: 'not-a-reason' }),
    (err) => err.code === 'invalid-error-reason',
  );
});

test('RoundLookBack restores persisted errorReason tags, persists toggles via attempt.errorReason.set, and adds zero extra prompts', async () => {
  const calls = [];
  const row = {
    number: 1,
    entryIndex: 0,
    deckId: 'd1',
    cardId: 'c1',
    kind: 'open',
    status: 'wrong',
    card: { id: 'c1', kind: 'open', prompt: 'What is Bayes rule?' },
    solution: { answer: 'P(A|B) = P(B|A)P(A)/P(B)', explanation: 'Divide by marginal P(B).' },
    errorReason: 'derivation',
    thinkingNote: 'flipped numerator and denominator',
  };
  assert.deepEqual(seedReasonsFromRows([row]), { [rowReasonKey(row)]: 'derivation' });

  await persistRowReason((action, payload) => { calls.push({ action, payload }); }, row, 'run-1', 'condition');
  assert.deepEqual(calls.at(-1), {
    action: 'attempt.errorReason.set',
    payload: { deckId: 'd1', cardId: 'c1', runId: 'run-1', errorReason: 'condition' },
  });

  // Mount RoundLookBack in English mode and verify persisted tag is pre-selected and toggle calls attempt.errorReason.set.
  const prevLang = uiMod.setUiLanguage('en');
  const services = {
    call: async (action, payload) => { calls.push({ action, payload }); return { ok: true, rows: [row] }; },
    act: () => {},
    busy: false,
    notify: () => {},
    openModal: () => {},
  };
  uiMod.setQueryData('review.lookBack', { runId: 'run-lb-w3c' }, { rows: [row] });
  const appData = { settings: { practice: { lookBackBlindRecall: true } } };
  const host = mountSync(services, appData);
  try {
    const props = {
      run: { id: 'run-lb-w3c', mode: 'path', deckId: 'd1', navigation: [{ answered: true }], correctionsPending: 0 },
      practiceSettings: { lookBackBlindRecall: true },
      onPracticeWrong: () => {},
    };
    let tree1 = host.render(uiMod.RoundLookBack, props);
    const rowToggle = findNodes(tree1, (n) => typeof n.props?.onClick === 'function' && String(n.props?.className || '').includes('look-back__line'))[0];
    assert.ok(rowToggle, 'look-back row toggle button rendered');
    rowToggle.props.onClick();
    tree1 = host.render(uiMod.RoundLookBack, props);

    let lookBackRow = findNodes(tree1, (n) => typeof n.type === 'function' && n.type.name === 'LookBack')[0];
    assert.ok(lookBackRow, 'LookBack row rendered');
    assert.equal(lookBackRow.props.reasonId, 'derivation', 'persisted derivation tag is restored on open');
    lookBackRow.props.onReveal();
    tree1 = host.render(uiMod.RoundLookBack, props);
    lookBackRow = findNodes(tree1, (n) => typeof n.type === 'function' && n.type.name === 'LookBack')[0];
    assert.equal(lookBackRow.props.reasonId, 'derivation', 'persisted reason stays active after reveal');

    // Render full static HTML while reason is pre-selected to verify 4 reason pills, pressed state, 0 extra inputs, 0 Han chars.
    const htmlWithTag = renderToStaticMarkup(h(uiMod.AppContext.Provider, { value: { data: appData } },
      h(uiMod.StudyServicesContext.Provider, { value: services }, tree1)));
    assert.match(htmlWithTag, /aria-pressed="true"/, 'persisted derivation pill renders aria-pressed="true"');
    assert.equal(han.test(htmlWithTag), false, 'English RoundLookBack contains zero Chinese characters');

    // Toggle off the persisted reason -> calls attempt.errorReason.set with errorReason: null.
    calls.length = 0;
    lookBackRow.props.onPickReason('derivation');
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0], {
      action: 'attempt.errorReason.set',
      payload: { deckId: 'd1', cardId: 'c1', runId: 'run-lb-w3c', errorReason: null },
    });

    // Re-render and verify zero extra modal/prompt/input appeared after toggling.
    const tree2 = host.render(uiMod.RoundLookBack, props);
    const lookBackAfter = findNodes(tree2, (n) => typeof n.type === 'function' && n.type.name === 'LookBack')[0];
    assert.equal(lookBackAfter.props.reasonId, '', 'toggling off clears reason cleanly');
    const htmlAfter = renderToStaticMarkup(h(uiMod.AppContext.Provider, { value: { data: appData } },
      h(uiMod.StudyServicesContext.Provider, { value: services }, tree2)));
    assert.doesNotMatch(htmlAfter, /<input\b|<textarea\b|data-thinking-note/, 'tagging an error reason pops zero extra input prompts');
  } finally {
    host.unmount();
    uiMod.setUiLanguage(prevLang);
  }
});

test('ExplanationFollowup custom follow-up exposes optional thinkingNote, persists via attempt.errorReason.set, and stays clean in English', async () => {
  const calls = [];
  const services = {
    call: async (action, payload) => {
      calls.push({ action, payload });
      if (action === 'card.followup.suggest') return { questions: [] };
      if (action === 'card.followup') return { item: { id: 'f1', question: payload.question, answer: 'Because independence requires P(A and B)=P(A)P(B).' } };
      return { ok: true };
    },
    notify: () => {},
  };
  const run = {
    id: 'run-fu-1',
    deckId: 'd1',
    mode: 'quiz',
    card: { id: 'c1', prompt: 'Independence test' },
    solution: { followups: [] },
  };
  const prevLang = uiMod.setUiLanguage('en');
  const host = mountSync(services);
  try {
    // Initially closed: no thinkingNote input rendered.
    let tree = host.render(uiMod.ExplanationFollowup, { run });
    assert.equal(findNodes(tree, (n) => n.props?.['data-thinking-note'] !== undefined).length, 0);

    // Open follow-up picker ("追问？" / aria-expanded trigger).
    const askTrigger = findNodes(tree, (n) => typeof n.props?.onClick === 'function' && n.props?.['aria-expanded'] === false)[0];
    assert.ok(askTrigger, 'followup trigger exists');
    await askTrigger.props.onClick();
    tree = host.render(uiMod.ExplanationFollowup, { run });
    const customBtn = findNodes(tree, (n) => typeof n.props?.onClick === 'function' && String(n.props?.className || '').includes('followup-picker__choice') && n.props?.['aria-expanded'] === false)[0];
    assert.ok(customBtn, 'custom follow-up button rendered');
    customBtn.props.onClick();
    tree = host.render(uiMod.ExplanationFollowup, { run });

    const noteInputs = findNodes(tree, (n) => n.props?.['data-thinking-note'] !== undefined);
    assert.equal(noteInputs.length, 1, 'optional single-line thinkingNote input rendered inside custom follow-up');
    assert.equal(noteInputs[0].props.maxLength, 200);

    // Zero Han chars in English custom follow-up form.
    const textNodes = [];
    walkTree(tree, (n) => {
      if (typeof n.props?.children === 'string') textNodes.push(n.props.children);
      if (typeof n.props?.placeholder === 'string') textNodes.push(n.props.placeholder);
    });
    assert.equal(han.test(textNodes.join(' ')), false, 'English custom follow-up has zero Chinese strings');

    // Fill thinkingNote + question and submit form.
    const textarea = findNodes(tree, (n) => n.type === 'textarea')[0];
    textarea.props.onChange({ target: { value: 'Why is disjoint not independent?' } });
    noteInputs[0].props.onChange({ target: { value: 'I assumed mutually exclusive means independent.' } });
    tree = host.render(uiMod.ExplanationFollowup, { run });
    const form = findNodes(tree, (n) => n.type === 'form')[0];
    await form.props.onSubmit({ preventDefault() {} });
    await Promise.resolve();

    const reasonCall = calls.find((c) => c.action === 'attempt.errorReason.set');
    const followupCall = calls.find((c) => c.action === 'card.followup');
    assert.ok(reasonCall, 'persists thinkingNote via attempt.errorReason.set');
    assert.deepEqual(reasonCall.payload, {
      deckId: 'd1',
      cardId: 'c1',
      runId: 'run-fu-1',
      thinkingNote: 'I assumed mutually exclusive means independent.',
    });
    assert.ok(followupCall, 'submits card.followup');
    assert.match(followupCall.payload.question, /Why is disjoint not independent\?/);
    assert.match(followupCall.payload.question, /I assumed mutually exclusive means independent\./);
    assert.equal(han.test(followupCall.payload.question), false, 'English merged follow-up question has zero Chinese text');
  } finally {
    host.unmount();
    uiMod.setUiLanguage(prevLang);
  }
});

test('QuestionRun places optional thinkingNote ONLY inside assistMode === "ask" with zero new toolbar buttons', async () => {
  const [questionRunSrc, toolbarSrc, useSessionSrc] = await Promise.all([
    readFile(new URL('../ui/review/QuestionRun.jsx', import.meta.url), 'utf8'),
    readFile(new URL('../ui/ReviewToolbar.jsx', import.meta.url), 'utf8'),
    readFile(new URL('../ui/review/useReviewSession.js', import.meta.url), 'utf8'),
  ]);
  assert.equal(toolbarSrc.includes('thinkingNote'), false, 'ReviewToolbar adds zero thinkingNote controls');
  assert.equal(toolbarSrc.includes('data-thinking-note'), false, 'ReviewToolbar adds zero thinkingNote inputs');
  assert.match(questionRunSrc, /\{assistMode === "ask" && \(\s*<label className="assist-form__field assist-form__thinking">/);
  assert.match(questionRunSrc, /data-thinking-note=""/);
  assert.match(questionRunSrc, /maxLength=\{200\}/);
  assert.match(useSessionSrc, /call\(['"]attempt\.errorReason\.set['"]/);
});

test('skills/study-tutor/SKILL.md defines cross-skill continuity, One-Inference-Step Lock, unconditional immediate release, and valid actions', async (t) => {
  const raw = await readFile(new URL('../skills/study-tutor/SKILL.md', import.meta.url), 'utf8');
  const parsed = parseSkill(raw);
  assert.equal(parsed.name, 'study-tutor');
  assert.ok(parsed.description.length <= 500, `description (${parsed.description.length}) <= 500`);

  // Cross-skill continuity & anti-spoiling gate
  assert.match(parsed.content, /PointEvidence/);
  assert.match(parsed.content, /prereqGaps/);
  assert.match(parsed.content, /notationLedger/);
  assert.match(parsed.content, /trapLedger/);
  assert.match(parsed.content, /disclosureTier:\s*"cue_only"/);
  assert.match(parsed.content, /trapCue/);
  assert.match(parsed.content, /book\.read/);
  assert.match(parsed.content, /book\.retell/);
  assert.match(parsed.content, /companion\.compile/);

  // One-Inference-Step Lock & immediate unconditional release
  assert.match(parsed.content, /One-Inference-Step Lock/);
  assert.match(parsed.content, /1 causal or intuition step per reply/);
  assert.match(parsed.content, /直接讲完/);
  assert.match(parsed.content, /给我答案/);
  assert.match(parsed.content, /just give me the answer/);
  assert.match(parsed.content, /releaseAnswer":\s*true/);
  assert.match(parsed.content, /askedTutorBeforeAnswer/);
  assert.match(parsed.content, /zero pushback/);

  // Strict en/zh separation rule
  assert.match(parsed.content, /Language rule:/);
  assert.match(parsed.content, /never `《…》` or `「…」`/);

  // Every named study_workspace action (except host-bridge panel.open) is registered in StudyService.
  const dir = await mkdtemp(join(tmpdir(), 'studyhub-w3c-skill-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const study = new StudyService(dir);
  const actionRe = /`((?:study|book|card|case|companion|course|job|library|review|source)\.[a-z]+(?:\.[a-z]+)*)\b/g;
  const named = [...new Set([...parsed.content.matchAll(actionRe)].map((m) => m[1]))]
    .filter((a) => !['companion.ask', 'task.check', 'card.companionRef'].includes(a));
  assert.ok(named.includes('study.scene.get'));
  assert.ok(named.includes('book.read'));
  assert.ok(named.includes('book.retell'));
  assert.ok(named.includes('companion.compile'));
  for (const action of named) {
    assert.ok(study.runtime.hasAction(action), `study-tutor named action "${action}" is registered`);
  }
});
