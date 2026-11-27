import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import {
  FRAGILE_ROUTES,
  TRIAGE_REASONS,
  TRIAGE_ROUTES,
  matchConfusablePair,
  triageFragileCorrect,
  triageMistake,
} from '../lib/evidence/mistake-triage.js';
import { createTriageProjector } from '../lib/evidence/triage-context.js';
import { COURSE_BOOK_DOC_PROVENANCE, COURSE_NOTES_PROVENANCE, COURSE_OUTLINE_PROVENANCE } from '../lib/exam-point-list.js';
import { wrongBook } from '../lib/insights.js';
import { roundLookBack } from '../lib/contexts/study/round-look-back.js';
import { loadUi } from './helpers/ui-module.mjs';
import { withStudy } from './helpers/study-services.mjs';

const uiMod = await loadUi(`
  export { WrongBookView } from './ui/WrongBook.jsx';
  export { default as RoundLookBack } from './ui/review/RoundLookBack.jsx';
  export { useRescueExperiments } from './ui/companions/use-rescue-experiments.js';
  export { StudyServicesContext } from './ui/study-context.jsx';
  export { AppContext } from './ui/app/app-context.js';
  export { setQueryData } from './ui/host-query.js';
  export { ENGLISH_SOURCES, mergeCatalogues, setUiLanguage, ui, uiCatalogue } from './ui/i18n.js';
  export { leechTriageView } from './ui/wrongbook-model.js';
  export { isActionableTriage, resolveRowTriage } from './ui/review/lookback-recall.js';
`);
Object.assign(uiMod.uiCatalogue(), uiMod.mergeCatalogues(uiMod.ENGLISH_SOURCES).catalogue);

const h = React.createElement;
const noop = () => {};
const han = /\p{Script=Han}/u;
const plainText = html => html.replace(/<style[\s\S]*?<\/style>/g, '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

const SAMPLE_CONFUSABLE = {
  id: 'C001',
  items: ['K001', 'K002'],
  names: ['Type I Error', 'Type II Error'],
  alts: ['False Positive', 'False Negative'],
  hids: ['h10', 'h11'],
  leafIds: ['leaf-10', 'leaf-11'],
  sourcePages: [{ sourceId: 'src-stats', page: 14 }],
  rows: [
    { aspect: 'what', cells: ['Rejecting a true null hypothesis', 'Failing to reject a false null'] },
    { aspect: 'difference', cells: ['Controlled by alpha', 'Controlled by beta (1 - power)'] },
    { aspect: 'mistake', cells: ['Confusing alpha with p-value', 'Ignoring sample size effect on power'] },
  ],
};

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
        useContext: ctx => {
          if (ctx === uiMod.StudyServicesContext) return services;
          if (ctx === uiMod.AppContext) return appData ? { data: appData } : ctx._currentValue;
          return ctx._currentValue;
        },
        useState: init => {
          const i = cursor++;
          if (!(i in hooks)) {
            hooks[i] = [typeof init === 'function' ? init() : init, val => {
              hooks[i][0] = typeof val === 'function' ? val(hooks[i][0]) : val;
            }];
          }
          return hooks[i];
        },
        useRef: init => { const i = cursor++; if (!(i in hooks)) hooks[i] = { current: init }; return hooks[i]; },
        useMemo: (fn, deps) => { const i = cursor++; if (!(i in hooks) || !sameDeps(hooks[i].deps, deps)) hooks[i] = { deps, value: fn() }; return hooks[i].value; },
        useCallback: (fn, deps) => internals.H.useMemo(() => fn, deps),
        useEffect: (fn, deps) => { const i = cursor++; if (!(i in hooks) || !sameDeps(hooks[i].deps, deps)) pending.push({ i, fn, deps }); },
        useLayoutEffect: (fn, deps) => internals.H.useEffect(fn, deps),
        useInsertionEffect: (fn, deps) => internals.H.useEffect(fn, deps),
        useId: () => { const i = cursor++; if (!(i in hooks)) hooks[i] = `:triage-${i}:`; return hooks[i]; },
        useDeferredValue: v => v,
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
      node.props.items.forEach(item => walkTree(node.props.render(item), visit));
    }
    walkTree(node.props.children, visit);
  }
}

function textOf(node) {
  if (node == null || typeof node === 'boolean') return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(textOf).join('');
  if (node.props) {
    if (typeof node.props.render === 'function' && Array.isArray(node.props.items)) {
      return node.props.items.map(item => textOf(node.props.render(item))).join('');
    }
    return textOf(node.props.children);
  }
  return '';
}

function htmlOfElement(el, services, appData) {
  return renderToStaticMarkup(
    h(uiMod.AppContext.Provider, { value: appData ? { data: appData } : undefined },
      h(uiMod.StudyServicesContext.Provider, { value: services }, el)),
  );
}

test('mistake-triage engine: explicit errorReason routing table covers all 6 reasons deterministically', () => {
  assert.deepEqual(TRIAGE_REASONS, ['concept', 'condition', 'derivation', 'slip', 'prerequisite', 'bad_question']);
  assert.deepEqual(TRIAGE_ROUTES, ['fsrs_only', 'confusable_contrast', 'book_retell', 'rescue_companion', 'prereq_branch', 'fix_question']);

  // 1. slip -> fsrs_only even when stubborn and matching C001
  const slipRes = triageMistake({
    errorReason: 'slip',
    stubborn: true,
    hid: 'h10',
    confusables: [SAMPLE_CONFUSABLE],
    wrongOptions: ['Type II Error'],
  });
  assert.deepEqual(slipRes, { route: 'fsrs_only', reason: 'slip', source: 'explicit', tokens: 'zero' });

  // 2. concept -> confusable_contrast (0 tokens) when C001 matches
  const conceptConf = triageMistake({
    errorReason: 'concept',
    course: 'Stats',
    hid: 'h10',
    confusables: [SAMPLE_CONFUSABLE],
    wrongOptions: ['False Positive'],
  });
  assert.equal(conceptConf.route, 'confusable_contrast');
  assert.equal(conceptConf.source, 'explicit');
  assert.equal(conceptConf.tokens, 'zero');
  assert.equal(conceptConf.confusable.id, 'C001');
  assert.equal(conceptConf.confusable.matchBy, 'wrong_option');

  // concept without C001 match -> book_retell when book + hid exist
  const conceptRetell = triageMistake({ errorReason: 'concept', hid: 'h99', hasBook: true, confusables: [SAMPLE_CONFUSABLE] });
  assert.equal(conceptRetell.route, 'book_retell');
  assert.equal(conceptRetell.hid, 'h99');

  // concept without C001 or book -> rescue_companion if stubborn, else fsrs_only
  const conceptStubborn = triageMistake({ errorReason: 'concept', stubborn: true, hasBook: false });
  assert.equal(conceptStubborn.route, 'rescue_companion');
  assert.equal(conceptStubborn.fallback, true);
  const conceptPlain = triageMistake({ errorReason: 'concept', stubborn: false, hasBook: false });
  assert.equal(conceptPlain.route, 'fsrs_only');
  assert.equal(conceptPlain.fallback, true);

  // 3. condition & derivation -> rescue_companion
  const condRes = triageMistake({ errorReason: 'condition', hid: 'h5', course: 'Stats' });
  assert.equal(condRes.route, 'rescue_companion');
  assert.equal(condRes.rescueFocus, 'condition');
  const derivRes = triageMistake({ errorReason: 'derivation', hid: 'h5', course: 'Stats' });
  assert.equal(derivRes.route, 'rescue_companion');
  assert.equal(derivRes.rescueFocus, 'derivation');

  // 4. prerequisite -> prereq_branch ONLY from unresolved card.requires, respecting MAX_RETURN_DEPTH = 5
  const prereqRes = triageMistake({
    errorReason: 'prerequisite',
    prereqCards: [
      { deckId: 'd1', cardId: 'pre-done', level: 'mastered', topic: 'Done' },
      { deckId: 'd1', cardId: 'pre-weak', level: 'weak', topic: 'Hypothesis' },
    ],
    returnDepth: 4,
  });
  assert.equal(prereqRes.route, 'prereq_branch');
  assert.equal(prereqRes.tokens, 'zero');
  assert.equal(prereqRes.prereq.cardId, 'pre-weak');
  assert.deepEqual(prereqRes.prereqRefs, [{ deckId: 'd1', cardId: 'pre-weak' }]);

  // Respects MAX_RETURN_DEPTH = 5 -> graceful fallback
  const depthCapped = triageMistake({
    errorReason: 'prerequisite',
    hid: 'h12',
    hasBook: true,
    prereqCards: [{ deckId: 'd1', cardId: 'pre-weak', level: 'weak' }],
    returnDepth: 5,
  });
  assert.equal(depthCapped.route, 'book_retell');
  assert.equal(depthCapped.fallback, true);

  const depthCappedNoBook = triageMistake({
    errorReason: 'prerequisite',
    hasBook: false,
    prereqCards: [{ deckId: 'd1', cardId: 'pre-weak', level: 'weak' }],
    returnDepth: 5,
  });
  assert.equal(depthCappedNoBook.route, 'rescue_companion');
  assert.equal(depthCappedNoBook.rescueFocus, 'prerequisite');
  assert.equal(depthCappedNoBook.fallback, true);

  const depthAboveCap = triageMistake({
    errorReason: 'prerequisite',
    hid: 'h12',
    hasBook: true,
    prereqCards: [{ deckId: 'd1', cardId: 'pre-weak', level: 'weak' }],
    returnDepth: 6,
  });
  assert.equal(depthAboveCap.route, 'book_retell');
  assert.equal(depthAboveCap.fallback, true);

  const negativeDepth = triageMistake({
    errorReason: 'prerequisite',
    prereqCards: [{ deckId: 'd1', cardId: 'pre-weak', level: 'weak' }],
    returnDepth: -1,
  });
  assert.equal(negativeDepth.route, 'prereq_branch');
  assert.equal(negativeDepth.prereq.cardId, 'pre-weak');

  // §6.3 #3 invariant: outline prereqIds / prereqGaps MUST NOT trigger prereq_branch without card.requires
  const prereqIdsIgnored = triageMistake({
    errorReason: 'prerequisite',
    hid: 'h12',
    hasBook: false,
    prereqIds: ['h1', 'h2'],
    prereqGaps: ['h1'],
    prereqCards: [],
  });
  assert.equal(prereqIdsIgnored.route, 'rescue_companion');
  assert.equal(prereqIdsIgnored.fallback, true);
  assert.notEqual(prereqIdsIgnored.route, 'prereq_branch');

  // 5. bad_question -> fix_question
  const badRes = triageMistake({ errorReason: 'bad_question', course: 'Stats' });
  assert.equal(badRes.route, 'fix_question');
  assert.equal(badRes.reason, 'bad_question');
});

test('mistake-triage engine: mandatory 3-step unlabeled default route (first match wins)', () => {
  // Step 1: C001 match wins even before stubborn
  const step1 = triageMistake({
    stubborn: true,
    wrongOptions: ['Type I Error'],
    confusables: [SAMPLE_CONFUSABLE],
    course: 'Stats',
  });
  assert.equal(step1.route, 'confusable_contrast');
  assert.equal(step1.reason, 'concept');
  assert.equal(step1.source, 'default');
  assert.equal(step1.tokens, 'zero');

  // Step 2: Stubborn (no C001 match) -> rescue_companion
  const step2 = triageMistake({
    stubborn: true,
    hid: 'h99',
    confusables: [SAMPLE_CONFUSABLE],
    wrongOptions: ['Unrelated choice'],
  });
  assert.equal(step2.route, 'rescue_companion');
  assert.equal(step2.reason, null);
  assert.equal(step2.source, 'default');
  assert.equal(step2.rescueFocus, 'stubborn');

  // Step 3: Non-stubborn, non-C001 -> fsrs_only (0 tokens, no remediation)
  const step3 = triageMistake({
    stubborn: false,
    hid: 'h99',
    page: 99,
    sourceId: 'src-stats',
    confusables: [SAMPLE_CONFUSABLE],
    wrongOptions: ['Unrelated choice'],
  });
  assert.deepEqual(step3, { route: 'fsrs_only', reason: null, source: 'default', tokens: 'zero' });
});

test('matchConfusablePair: wrong_option > hid > page specificity and ignores single-char noise', () => {
  const secondPair = {
    id: 'C002',
    items: ['K003', 'K004'],
    names: ['Precision', 'Recall'],
    hids: ['h20'],
    sourcePages: [{ sourceId: 'src-stats', page: 14 }],
    rows: [{ aspect: 'what', cells: ['TP / (TP + FP)', 'TP / (TP + FN)'] }],
  };
  const pairs = [SAMPLE_CONFUSABLE, secondPair];

  // Wrong option naming Precision picks C002 even though hid h10 belongs to C001
  const byOpt = matchConfusablePair(pairs, { wrongOptions: ['Precision drops when FP rises'], hid: 'h10', sourceId: 'src-stats', page: 14 });
  assert.equal(byOpt.id, 'C002');
  assert.equal(byOpt.matchBy, 'wrong_option');

  // Single-character option noise does not false-match
  const noNoise = matchConfusablePair(pairs, { wrongOptions: ['A', 'B'] });
  assert.equal(noNoise, null);

  // hid match beats page match
  const byHid = matchConfusablePair(pairs, { hid: 'h20', sourceId: 'src-stats', page: 14 });
  assert.equal(byHid.id, 'C002');
  assert.equal(byHid.matchBy, 'hid');

  // Source citation page match works
  const byPage = matchConfusablePair([SAMPLE_CONFUSABLE], { citations: [{ selection: { sourceId: 'src-stats', page: 14 } }] });
  assert.equal(byPage.id, 'C001');
  assert.equal(byPage.matchBy, 'page');
});

test('triageFragileCorrect: recommends 0-token lookover/retell/variant without altering errorReason or FSRS', () => {
  assert.deepEqual(FRAGILE_ROUTES, ['book_lookover', 'book_retell', 'unseen_variant']);
  assert.equal(triageFragileCorrect({ grade: 2, slowCorrect: true }), null, 'wrong answers are not fragile-correct');
  assert.equal(triageFragileCorrect({ grade: 5, elapsedMs: 4000, medianMs: 5000 }), null, 'confident fast answers return null');

  const lookover = triageFragileCorrect({ grade: 4, slowCorrect: true, hasBook: true, hid: 'h10', course: 'Stats' });
  assert.equal(lookover.route, 'book_lookover');
  assert.equal(lookover.signal, 'slow_correct');
  assert.equal(lookover.tokens, 'zero');
  assert.equal(lookover.pollutesFsrs, false);

  const retell = triageFragileCorrect({ grade: 3, hasBook: true, hid: 'h10', retellGap: true });
  assert.equal(retell.route, 'book_retell');
  assert.equal(retell.signal, 'barely_pass');
  assert.equal(retell.pollutesFsrs, false);

  const variant = triageFragileCorrect({ grade: 3, hasBook: false });
  assert.equal(variant.route, 'unseen_variant');
  assert.equal(variant.tokens, 'zero');
  assert.equal(variant.pollutesFsrs, false);
});

test('state projection: wrongBook & roundLookBack compute 0-token triage and ignore outline prereqIds (§6.3 #3)', () => {
  const state = {
    settings: { practice: { leechFailures: 3, leechWindow: 5, leechRate: 60 } },
    courses: [{ id: 'course-1', name: 'Stats' }],
    sources: [
      { id: 'src-stats', title: 'Stats Lecture', courses: ['Stats'] },
      {
        id: 'outline-1',
        provenance: COURSE_OUTLINE_PROVENANCE,
        courses: ['Stats'],
        courseOutline: {
          version: 1,
          course: 'Stats',
          nodes: [
            { id: 'leaf-1', title: 'Basics', prereqIds: [] },
            { id: 'leaf-2', title: 'Errors', prereqIds: ['leaf-1'] },
          ],
        },
      },
      {
        id: 'book-1',
        provenance: COURSE_BOOK_DOC_PROVENANCE,
        courses: ['Stats'],
        bookDoc: {
          course: 'Stats',
          revision: 1,
          manifest: {
            nodes: [
              { id: 'leaf-1', hid: 'h1', leaf: true, title: 'Basics' },
              { id: 'leaf-2', hid: 'h2', leaf: true, title: 'Errors' },
            ],
          },
        },
      },
      {
        id: 'notes-1',
        provenance: COURSE_NOTES_PROVENANCE,
        courses: ['Stats'],
        courseNotes: {
          course: 'Stats',
          leaves: [
            {
              id: 'leaf-1',
              title: 'Basics',
              body: { units: [{ cards: [{ item: 'i1', name: 'Type I Error', relations: [{ kind: 'opposite', item: 'i2', name: 'Type II Error' }] }] }], cites: [{ sourceId: 'src-stats', page: 14 }] },
            },
            {
              id: 'leaf-2',
              title: 'Errors',
              body: { units: [{ cards: [{ item: 'i2', name: 'Type II Error', relations: [{ kind: 'opposite', item: 'i1', name: 'Type I Error' }] }] }], cites: [{ sourceId: 'src-stats', page: 15 }] },
            },
          ],
          confusables: [
            {
              items: ['i1', 'i2'],
              print: '0123456789abcdef',
              rows: [
                { aspect: 'what', cells: ['Reject true H0', 'Keep false H0'] },
                { aspect: 'difference', cells: ['Alpha risk', 'Beta risk'] },
              ],
            },
          ],
        },
      },
    ],
    decks: [
      {
        id: 'd1',
        title: 'Stats Deck',
        course: 'Stats',
        cards: [
          {
            id: 'c-conf',
            kind: 'quiz',
            topic: 'Hypothesis',
            prompt: 'Which error rejects a true null?',
            options: [{ id: 'a', text: 'Type I Error', correct: true }, { id: 'b', text: 'Type II Error', correct: false }],
          },
          {
            id: 'c-plain',
            kind: 'quiz',
            topic: 'Mean',
            prompt: 'What is the sample mean?',
            options: [{ id: 'a', text: 'Sum / n', correct: true }, { id: 'b', text: 'Median', correct: false }],
          },
          {
            id: 'c-stubborn',
            kind: 'quiz',
            topic: 'Variance',
            prompt: 'Why divide by n - 1?',
            options: [{ id: 'a', text: 'Unbiasedness', correct: true }, { id: 'b', text: 'Convenience', correct: false }],
          },
          {
            id: 'c-prereq-only-outline',
            kind: 'quiz',
            topic: 'Errors',
            hid: 'h2',
            prompt: 'Outline has prereqIds but card.requires is empty',
            options: [{ id: 'a', text: 'Right', correct: true }, { id: 'b', text: 'Wrong', correct: false }],
          },
          {
            id: 'c-prereq-card-requires',
            kind: 'quiz',
            topic: 'Errors',
            hid: 'h2',
            requires: [{ deckId: 'd1', cardId: 'c-plain' }],
            prompt: 'Card explicitly requires c-plain',
            options: [{ id: 'a', text: 'Right', correct: true }, { id: 'b', text: 'Wrong', correct: false }],
          },
        ],
      },
    ],
    runs: [
      {
        id: 'run-1',
        deckId: 'd1',
        mode: 'path',
        closedAt: '2026-11-20T01:00:00Z',
        index: 3,
        entries: [
          {
            deckId: 'd1',
            card: { id: 'c-conf', kind: 'quiz', prompt: 'Which error rejects a true null?', options: [{ id: 'a', text: 'Type I Error', correct: true }, { id: 'b', text: 'Type II Error', correct: false }] },
            feedback: { grade: 1, selected: ['b'] },
          },
          {
            deckId: 'd1',
            card: { id: 'c-plain', kind: 'quiz', prompt: 'What is the sample mean?', options: [{ id: 'a', text: 'Sum / n', correct: true }, { id: 'b', text: 'Median', correct: false }] },
            feedback: { grade: 1, selected: ['b'] },
          },
          {
            deckId: 'd1',
            card: { id: 'c-stubborn', kind: 'quiz', prompt: 'Why divide by n - 1?', options: [{ id: 'a', text: 'Unbiasedness', correct: true }, { id: 'b', text: 'Convenience', correct: false }] },
            feedback: { grade: 1, selected: ['b'] },
          },
        ],
      },
    ],
    attempts: [
      { deckId: 'd1', quiz_id: 'c-conf', runId: 'run-1', grade: 1, timestamp: '2026-11-20T00:10:00Z' },
      { deckId: 'd1', quiz_id: 'c-plain', runId: 'run-1', grade: 1, timestamp: '2026-11-20T00:11:00Z' },
      { deckId: 'd1', quiz_id: 'c-stubborn', runId: 'run-old-1', grade: 1, timestamp: '2026-11-18T00:10:00Z' },
      { deckId: 'd1', quiz_id: 'c-stubborn', runId: 'run-old-2', grade: 1, timestamp: '2026-11-19T00:10:00Z' },
      { deckId: 'd1', quiz_id: 'c-stubborn', runId: 'run-1', grade: 1, timestamp: '2026-11-20T00:12:00Z' },
    ],
  };

  // 1. wrongBook projects live triage routes
  const wb = wrongBook(state, { course: 'Stats' });
  const byId = new Map(wb.items.map(item => [item.cardId, item]));
  assert.equal(byId.get('c-conf').triage.route, 'confusable_contrast');
  assert.equal(byId.get('c-conf').triage.confusable.id, 'C001');
  assert.equal(byId.get('c-stubborn').triage.route, 'rescue_companion');
  assert.equal(byId.get('c-plain').triage.route, 'fsrs_only');

  // 2. outline prereqIds NEVER triggers prereq_branch when card.requires is absent; card.requires DOES
  const projector = createTriageProjector(state);
  const outlineOnlyPrereq = projector.projectCard({
    deck: state.decks[0],
    card: state.decks[0].cards[3],
    errorReason: 'prerequisite',
    stubborn: false,
  });
  assert.equal(outlineOnlyPrereq.route, 'book_retell', 'falls back to book_retell rather than routing via gated prereqIds');
  assert.equal(outlineOnlyPrereq.fallback, true);

  const cardRequiresPrereq = projector.projectCard({
    deck: state.decks[0],
    card: state.decks[0].cards[4],
    errorReason: 'prerequisite',
    stubborn: false,
  });
  assert.equal(cardRequiresPrereq.route, 'prereq_branch');
  assert.deepEqual(cardRequiresPrereq.prereqRefs, [{ deckId: 'd1', cardId: 'c-plain' }]);

  // 3. roundLookBack projects triage + reactive triageByReason
  const rows = roundLookBack(state, state.runs[0], card => ({ answer: card.options?.[0]?.text || '' }));
  const rById = new Map(rows.map(r => [r.cardId, r]));
  assert.equal(rById.get('c-conf').triage.route, 'confusable_contrast');
  assert.equal(rById.get('c-conf').triageByReason.slip.route, 'fsrs_only');
  assert.equal(rById.get('c-plain').triage.route, 'fsrs_only');
  assert.equal(rById.get('c-plain').triageByReason.derivation.route, 'rescue_companion');
  assert.equal(rById.get('c-stubborn').triage.route, 'rescue_companion');
  assert.equal(rById.get('c-stubborn').triageByReason.slip.route, 'fsrs_only');
});

test('WrongBookView LeechRescue: highlights single triage-selected recommendation across all 6 routes (net -2 controls preserved, zh & en)', () => {
  const decks = [{ id: 'd1', course: 'Stats', title: 'Stats Quiz' }];
  const baseProps = {
    data: { root: 'r', decks, focus: { course: 'Stats', courses: [{ name: 'Stats' }] }, model: { ready: true }, settings: {} },
    course: 'Stats', onCourse: noop, loading: false, err: '', page: 0, pageSize: 100, hasMore: false,
    onReload: noop, onPage: noop, recs: null,
    coach: { enabled: true, consent: true, ready: 0, preparing: false, preparingCards: [], readyCards: [], failedCards: [], tasks: [] },
    details: { c1: { deckId: 'd1', cardId: 'c1', correctAnswer: 'A', explanation: 'Because.', yourAnswer: 'B', missedAt: '2026-11-20T00:00:00Z' } },
    onLoadDetail: noop, onPractice: noop, onPracticePrepared: noop, onGenerate: async () => ({}),
    onOpenSettings: noop, onSettings: noop, onOpenBook: noop, onRescue: noop,
  };
  const makeRow = triage => ({
    deckId: 'd1', deckTitle: 'Stats Quiz', cardId: 'c1', topic: 'Hypothesis', prompt: 'Q1?',
    assessment: 'graded', lastGrade: 1, lastAt: '2026-11-20T00:00:00Z', kind: 'quiz', leech: true, triage,
  });
  const renderLeech = (triage, extra = {}) => renderToStaticMarkup(
    withStudy(uiMod.StudyServicesContext, h(uiMod.WrongBookView, {
      ...baseProps,
      items: [makeRow(triage)],
      counts: { total: 1, graded: 1, self: 0, oral: 0, rubric: 0 },
      initial: { expanded: ['c1'], ...extra },
    }), { openModal: noop, call: async () => ({}) }),
  );
  const leechBlock = html => html.match(/<div class="wb-sub wb-leech"[\s\S]*?<\/div>\s*<\/div>/)?.[0] ?? '';

  const cases = [
    {
      name: 'confusable_contrast',
      triage: { route: 'confusable_contrast', reason: 'concept', source: 'default', tokens: 'zero', course: 'Stats', hid: 'h10', confusable: SAMPLE_CONFUSABLE },
      expectedButtons: 2,
      zhMatch: /对比辨析 C001/,
      enMatch: /Contrast C001/,
      attr: 'data-rescue="confusable"',
    },
    {
      name: 'book_retell',
      triage: { route: 'book_retell', reason: 'concept', source: 'explicit', tokens: 'light', course: 'Stats', hid: 'h10' },
      expectedButtons: 2,
      zhMatch: /去全书讲一遍/,
      enMatch: /Retell in review book/,
      attr: 'data-rescue="book-retell"',
    },
    {
      name: 'rescue_companion',
      triage: { route: 'rescue_companion', reason: 'derivation', source: 'explicit', tokens: 'light', course: 'Stats', rescueFocus: 'derivation' },
      expectedButtons: 2,
      zhMatch: /做一个 4 页交互实验/,
      enMatch: /Try a 4-slide interactive experiment/,
      attr: 'data-rescue="experiment"',
    },
    {
      name: 'prereq_branch',
      triage: { route: 'prereq_branch', reason: 'prerequisite', source: 'explicit', tokens: 'zero', prereq: { deckId: 'd1', cardId: 'p1' }, prereqRefs: [{ deckId: 'd1', cardId: 'p1' }] },
      expectedButtons: 2,
      zhMatch: /先练前置题/,
      enMatch: /Practise prerequisites first/,
      attr: 'data-rescue="prereq"',
    },
    {
      name: 'fix_question',
      triage: { route: 'fix_question', reason: 'bad_question', source: 'explicit', tokens: 'light' },
      expectedButtons: 2,
      zhMatch: /这题有问题，交给后台修/,
      enMatch: /Report a problem: fix it in the background/,
      attr: 'data-rescue="fix"',
    },
    {
      name: 'fsrs_only',
      triage: { route: 'fsrs_only', reason: 'slip', source: 'explicit', tokens: 'zero' },
      expectedButtons: 1,
      zhMatch: /按 FSRS 正常排程复习即可/,
      enMatch: /FSRS scheduling is enough here/,
      attr: 'data-triage-route="fsrs_only"',
    },
  ];

  uiMod.setUiLanguage('zh');
  try {
    for (const c of cases) {
      const html = renderLeech(c.triage);
      const block = leechBlock(html);
      assert.ok(block, `${c.name}: renders wb-leech`);
      assert.ok(html.includes(c.attr), `${c.name}: has ${c.attr}`);
      assert.equal((block.match(/<button\b/g) || []).length, c.expectedButtons, `${c.name}: preserves §2.1 control budget`);
      assert.match(plainText(block), c.zhMatch, `${c.name}: zh copy`);
    }

    // Expanding 其他办法 under fsrs_only keeps all actions quietly reachable
    const fsrsExpanded = renderLeech({ route: 'fsrs_only', reason: 'slip', source: 'explicit', tokens: 'zero' }, { rescueOtherOpen: ['c1'] });
    assert.match(plainText(fsrsExpanded), /做一个 4 页交互实验/);
    assert.match(plainText(fsrsExpanded), /暂停此题/);

    // English UI: zero Chinese characters across all 6 routes
    uiMod.setUiLanguage('en');
    for (const c of cases) {
      const html = renderLeech(c.triage, { rescueOtherOpen: ['c1'] });
      const text = plainText(html);
      assert.doesNotMatch(text, han, `${c.name}: zero Han characters in English WrongBook UI: ${text}`);
      assert.match(text, c.enMatch, `${c.name}: en copy`);
    }
  } finally {
    uiMod.setUiLanguage('zh');
  }
});

test('RoundLookBack reactive triage: zero remediation UI for fsrs_only, instant reactive updates on #1156 tag without re-veiling, zh & en', () => {
  const rows = [
    {
      number: 1,
      entryIndex: 0,
      deckId: 'd1',
      cardId: 'c-plain',
      kind: 'quiz',
      status: 'wrong',
      hid: 'h5',
      card: { id: 'c-plain', kind: 'quiz', prompt: 'Plain non-stubborn miss?', options: [{ id: 'a', text: 'Right' }, { id: 'b', text: 'Wrong' }] },
      feedback: { selected: ['b'] },
      solution: { explanation: 'Plain explanation', options: [{ id: 'a', correct: true }] },
      triage: { route: 'fsrs_only', reason: null, source: 'default', tokens: 'zero' },
      triageByReason: {
        default: { route: 'fsrs_only', reason: null, source: 'default', tokens: 'zero' },
        concept: { route: 'book_retell', reason: 'concept', source: 'explicit', tokens: 'light', course: 'Stats', hid: 'h5' },
        condition: { route: 'rescue_companion', reason: 'condition', source: 'explicit', tokens: 'light', course: 'Stats', rescueFocus: 'condition' },
        derivation: { route: 'rescue_companion', reason: 'derivation', source: 'explicit', tokens: 'light', course: 'Stats', rescueFocus: 'derivation' },
        slip: { route: 'fsrs_only', reason: 'slip', source: 'explicit', tokens: 'zero' },
      },
    },
    {
      number: 2,
      entryIndex: 1,
      deckId: 'd1',
      cardId: 'c-conf',
      kind: 'quiz',
      status: 'wrong',
      card: { id: 'c-conf', kind: 'quiz', prompt: 'Confusable miss?', options: [{ id: 'a', text: 'Type I Error' }, { id: 'b', text: 'Type II Error' }] },
      feedback: { selected: ['b'] },
      solution: { explanation: 'Confusable explanation', options: [{ id: 'a', correct: true }] },
      triage: { route: 'confusable_contrast', reason: 'concept', source: 'default', tokens: 'zero', course: 'Stats', hid: 'h10', confusable: SAMPLE_CONFUSABLE },
      triageByReason: {
        default: { route: 'confusable_contrast', reason: 'concept', source: 'default', tokens: 'zero', course: 'Stats', hid: 'h10', confusable: SAMPLE_CONFUSABLE },
        concept: { route: 'confusable_contrast', reason: 'concept', source: 'explicit', tokens: 'zero', course: 'Stats', hid: 'h10', confusable: SAMPLE_CONFUSABLE },
        condition: { route: 'rescue_companion', reason: 'condition', source: 'explicit', tokens: 'light', course: 'Stats', rescueFocus: 'condition' },
        derivation: { route: 'rescue_companion', reason: 'derivation', source: 'explicit', tokens: 'light', course: 'Stats', rescueFocus: 'derivation' },
        slip: { route: 'fsrs_only', reason: 'slip', source: 'explicit', tokens: 'zero' },
      },
    },
  ];

  const run = { id: 'run-triage', mode: 'path', navigation: [{ answered: true }, { answered: true }], correctionsPending: 0 };
  const calls = [];
  const bookOpens = [];
  const services = {
    call: async (action, args) => { calls.push({ action, args }); return { ok: true }; },
    act: noop, busy: false, notify: noop, openModal: noop,
  };
  const appData = { settings: { practice: { lookBackBlindRecall: true } }, model: { ready: true } };

  uiMod.setUiLanguage('zh');
  try {
    uiMod.setQueryData('review.lookBack', { runId: run.id }, { rows });
    const app = mountSync(services, appData);
    const props = {
      run,
      practiceSettings: { lookBackBlindRecall: true },
      onOpenBook: target => bookOpens.push(target),
      onPracticeWrong: noop,
    };

    let tree = app.render(uiMod.RoundLookBack, props);
    // Expand all rows
    let expandBtn = null;
    walkTree(tree, n => { if (!expandBtn && typeof n.type !== 'string' && typeof n.props?.onClick === 'function' && textOf(n).trim() === '全部展开') expandBtn = n; });
    assert.ok(expandBtn);
    expandBtn.props.onClick();
    tree = app.render(uiMod.RoundLookBack, props);

    // Reveal both rows
    const reveals = [];
    walkTree(tree, n => { if (typeof n.type === 'function' && n.type.name === 'LookBack' && n.props.onReveal) reveals.push(n.props.onReveal); });
    assert.equal(reveals.length, 2);
    reveals[0]();
    reveals[1]();
    tree = app.render(uiMod.RoundLookBack, props);

    // Row 1 (fsrs_only) has NO triage action; Row 2 (C001) has confusable_contrast
    const htmlInitial = htmlOfElement(tree, services, appData);
    assert.match(htmlInitial, /data-triage-route="confusable_contrast"/);
    assert.match(plainText(htmlInitial), /对比辨析 C001/);
    assert.equal((htmlInitial.match(/data-triage-route=/g) || []).length, 1, 'ordinary non-stubborn non-C001 row renders zero triage controls');

    // Tag Row 1 as 'concept' -> immediately switches to book_retell without re-veiling
    const pickers = [];
    walkTree(tree, n => { if (typeof n.type === 'function' && n.type.name === 'LookBack' && n.props.onPickReason) pickers.push(n.props.onPickReason); });
    pickers[0]('concept');
    tree = app.render(uiMod.RoundLookBack, props);
    const htmlConcept = htmlOfElement(tree, services, appData);
    assert.match(htmlConcept, /data-triage-route="book_retell"/);
    assert.match(plainText(htmlConcept), /Plain explanation/, 'tagging reason does NOT re-veil the revealed row');
    assert.equal(calls.at(-1).action, 'attempt.errorReason.set');
    assert.equal(calls.at(-1).args.errorReason, 'concept');

    // Simulate persisted rowReasonsSignature update -> still does NOT re-veil!
    const persistedRows = rows.map(r => (r.cardId === 'c-plain' ? { ...r, errorReason: 'concept' } : r));
    uiMod.setQueryData('review.lookBack', { runId: run.id }, { rows: persistedRows });
    tree = app.render(uiMod.RoundLookBack, props);
    assert.match(htmlOfElement(tree, services, appData), /Plain explanation/, 'persisted signature refresh keeps revealed row un-veiled');

    // Click book_retell action
    let retellBtn = null;
    walkTree(tree, n => { if (!retellBtn && n.props?.['data-triage-route'] === 'book_retell') retellBtn = n; });
    assert.ok(retellBtn);
    retellBtn.props.onClick();
    assert.deepEqual(bookOpens.at(-1), { course: 'Stats', hid: 'h5' });

    // Tag Row 2 (C001) as 'slip' -> confusable_contrast disappears immediately (fsrs_only -> 0 remediation controls)
    const pickersAfter = [];
    walkTree(tree, n => { if (typeof n.type === 'function' && n.type.name === 'LookBack' && n.props.onPickReason) pickersAfter.push(n.props.onPickReason); });
    pickersAfter[1]('slip');
    tree = app.render(uiMod.RoundLookBack, props);
    const htmlSlip = htmlOfElement(tree, services, appData);
    assert.doesNotMatch(htmlSlip, /data-triage-route="confusable_contrast"/);

    // Tag Row 1 as 'derivation' -> switches to rescue_companion
    pickersAfter[0]('derivation');
    tree = app.render(uiMod.RoundLookBack, props);
    const htmlDeriv = htmlOfElement(tree, services, appData);
    assert.match(htmlDeriv, /data-triage-route="rescue_companion"/);

    // English UI: zero Chinese characters
    uiMod.setUiLanguage('en');
    tree = app.render(uiMod.RoundLookBack, props);
    const enText = plainText(htmlOfElement(tree, services, appData));
    assert.doesNotMatch(enText, han, `unexpected Han in English RoundLookBack triage UI: ${enText}`);
    assert.match(enText, /Try a 4-slide interactive experiment/);
    app.unmount();
  } finally {
    uiMod.setUiLanguage('zh');
  }
});

test('mistake-triage P1 regressions: PDF per-page source resolution in wrongBook, persisted prerequisite/bad_question in RoundLookBack, multi-deck run disambiguation, and errorReason forwarding to companion.build', async () => {
  // 1. Per-page PDF source ({ id: 'src-p14', document: { id: 'doc-1', format: 'pdf', page: 14 } }) without card.page/card.hid
  const pdfState = {
    settings: { practice: { leechFailures: 3, leechWindow: 5, leechRate: 60 } },
    courses: [{ id: 'c-pdf', name: 'Physics' }],
    sources: [
      { id: 'src-p14', title: 'Lecture PDF p.14', courses: ['Physics'], document: { id: 'doc-1', format: 'pdf', page: 14 } },
      {
        id: 'book-pdf',
        provenance: COURSE_BOOK_DOC_PROVENANCE,
        courses: ['Physics'],
        bookDoc: {
          course: 'Physics',
          revision: 1,
          manifest: { nodes: [{ id: 'leaf-heat', hid: 'h14', leaf: true, title: 'Heat vs Work' }] },
        },
      },
      {
        id: 'notes-pdf',
        provenance: COURSE_NOTES_PROVENANCE,
        courses: ['Physics'],
        courseNotes: {
          course: 'Physics',
          leaves: [
            {
              id: 'leaf-heat',
              title: 'Heat vs Work',
              body: {
                units: [{
                  cards: [
                    { item: 'it-q', name: 'Heat', relations: [{ kind: 'parallel', item: 'it-w', name: 'Work' }] },
                    { item: 'it-w', name: 'Work', relations: [{ kind: 'parallel', item: 'it-q', name: 'Heat' }] },
                  ],
                }],
                cites: [{ sourceId: 'src-p14' }],
              },
            },
          ],
          confusables: [
            {
              items: ['it-q', 'it-w'],
              print: 'fedcba9876543210',
              rows: [{ aspect: 'what', cells: ['Thermal energy transfer', 'Mechanical energy transfer'] }],
            },
          ],
        },
      },
    ],
    decks: [
      {
        id: 'd-pdf',
        title: 'Thermo Deck',
        course: 'Physics',
        cards: [
          {
            id: 'c-pdf-1',
            kind: 'quiz',
            topic: 'First Law',
            prompt: 'Path-dependent transfer?',
            citations: [{ sourceId: 'src-p14', quote: 'Heat and work are path functions.' }],
            options: [{ id: 'a', text: 'Path function', correct: true }, { id: 'b', text: 'State function', correct: false }],
          },
        ],
      },
      {
        id: 'd-other',
        title: 'Other Deck',
        course: 'Physics',
        cards: [
          {
            id: 'c-dup',
            kind: 'quiz',
            topic: 'Other',
            prompt: 'Other deck dup card',
            options: [{ id: 'a', text: 'Right', correct: true }, { id: 'b', text: 'Heat', correct: false }],
          },
        ],
      },
      {
        id: 'd-clean',
        title: 'Clean Deck',
        course: 'Physics',
        cards: [
          {
            id: 'c-dup',
            kind: 'quiz',
            topic: 'Clean',
            prompt: 'Clean deck dup card',
            options: [{ id: 'a', text: 'Right', correct: true }, { id: 'b', text: 'Unrelated choice', correct: false }],
          },
        ],
      },
    ],
    runs: [
      {
        id: 'run-multi',
        deckId: 'd-clean',
        mode: 'path',
        entries: [
          {
            deckId: 'd-clean',
            card: { id: 'c-dup', kind: 'quiz', options: [{ id: 'a', text: 'Right', correct: true }, { id: 'b', text: 'Unrelated choice', correct: false }] },
            feedback: { grade: 1, selected: ['b'] },
          },
          {
            deckId: 'd-other',
            card: { id: 'c-dup', kind: 'quiz', options: [{ id: 'a', text: 'Right', correct: true }, { id: 'b', text: 'Heat', correct: false }] },
            feedback: { grade: 1, selected: ['b'] },
          },
        ],
      },
    ],
    attempts: [
      { deckId: 'd-pdf', quiz_id: 'c-pdf-1', grade: 1, timestamp: '2026-11-20T02:00:00Z' },
      { deckId: 'd-clean', quiz_id: 'c-dup', runId: 'run-multi', grade: 1, timestamp: '2026-11-20T02:01:00Z' },
    ],
  };

  const wb = wrongBook(pdfState, { course: 'Physics' });
  const pdfItem = wb.items.find(item => item.cardId === 'c-pdf-1');
  assert.ok(pdfItem);
  assert.equal(pdfItem.hid, 'h14', 'wrongBook resolves hid from per-page PDF source document.page');
  assert.equal(pdfItem.triage.route, 'confusable_contrast', 'wrongBook matches C001 by PDF source page');
  assert.equal(pdfItem.triage.confusable.id, 'C001');

  const cleanDupItem = wb.items.find(item => item.deckId === 'd-clean' && item.cardId === 'c-dup');
  assert.equal(cleanDupItem.triage.route, 'fsrs_only', 'multi-deck run disambiguates by deckId and never borrows wrongOptions from d-other');

  // 2. RoundLookBack preserves persisted prerequisite / bad_question routes when not in #1156 4-tag map
  const prereqRow = {
    number: 1,
    entryIndex: 0,
    deckId: 'd1',
    cardId: 'c-pre',
    kind: 'quiz',
    status: 'wrong',
    errorReason: 'prerequisite',
    card: { id: 'c-pre', kind: 'quiz', prompt: 'Prereq miss?', options: [{ id: 'a', text: 'A' }, { id: 'b', text: 'B' }] },
    feedback: { selected: ['b'] },
    solution: { explanation: 'Needs base concept', options: [{ id: 'a', correct: true }] },
    triage: { route: 'prereq_branch', reason: 'prerequisite', source: 'explicit', tokens: 'zero', prereq: { deckId: 'd1', cardId: 'p1' }, prereqRefs: [{ deckId: 'd1', cardId: 'p1' }] },
    triageByReason: {
      default: { route: 'fsrs_only', reason: null, source: 'default', tokens: 'zero' },
      concept: { route: 'fsrs_only', reason: 'concept', source: 'explicit', tokens: 'zero', fallback: true },
      condition: { route: 'rescue_companion', reason: 'condition', source: 'explicit', tokens: 'light', rescueFocus: 'condition' },
      derivation: { route: 'rescue_companion', reason: 'derivation', source: 'explicit', tokens: 'light', rescueFocus: 'derivation' },
      slip: { route: 'fsrs_only', reason: 'slip', source: 'explicit', tokens: 'zero' },
    },
  };
  const badQRow = {
    ...prereqRow,
    number: 2,
    entryIndex: 1,
    cardId: 'c-bad',
    errorReason: 'bad_question',
    triage: { route: 'fix_question', reason: 'bad_question', source: 'explicit', tokens: 'light' },
  };
  assert.equal(uiMod.resolveRowTriage(prereqRow, '').route, 'prereq_branch');
  assert.equal(uiMod.resolveRowTriage(badQRow, '').route, 'fix_question');
  assert.equal(uiMod.resolveRowTriage(prereqRow, 'slip').route, 'fsrs_only');

  const runPersisted = { id: 'run-persisted', mode: 'path', navigation: [{ answered: true }, { answered: true }], correctionsPending: 0 };
  const services = { call: async () => ({ ok: true }), act: noop, busy: false, notify: noop, openModal: noop };
  uiMod.setUiLanguage('zh');
  uiMod.setQueryData('review.lookBack', { runId: runPersisted.id }, { rows: [prereqRow, badQRow] });
  const mounted = mountSync(services, { settings: { practice: { lookBackBlindRecall: false } } });
  let tree = mounted.render(uiMod.RoundLookBack, { run: runPersisted, onPracticeWrong: noop });
  let expandBtn = null;
  walkTree(tree, n => { if (!expandBtn && typeof n.type !== 'string' && typeof n.props?.onClick === 'function' && textOf(n).trim() === '全部展开') expandBtn = n; });
  assert.ok(expandBtn);
  expandBtn.props.onClick();
  tree = mounted.render(uiMod.RoundLookBack, { run: runPersisted, onPracticeWrong: noop });
  const persistedHtml = htmlOfElement(tree, services, null);
  assert.match(persistedHtml, /data-triage-route="prereq_branch"/);
  assert.match(persistedHtml, /data-triage-route="fix_question"/);
  mounted.unmount();

  // 3. useRescueExperiments forwards errorReason to generation.companion.build
  const buildCalls = [];
  let hookApi = null;
  function Probe() {
    hookApi = uiMod.useRescueExperiments({
      call: async (action, args) => { buildCalls.push({ action, args }); return { jobId: 'job-1' }; },
    });
    return null;
  }
  const hookHost = mountSync(services, null);
  hookHost.render(Probe, {});
  await hookApi.start('c1', { course: 'Physics', deckId: 'd-pdf', cardIds: ['c-pdf-1'], hid: 'h14', errorReason: 'condition' });
  hookHost.unmount();
  assert.equal(buildCalls.length, 1);
  assert.equal(buildCalls[0].action, 'generation.companion.build');
  assert.equal(buildCalls[0].args.mode, 'rescue');
  assert.equal(buildCalls[0].args.errorReason, 'condition');
});

test('mistake-triage source invariants: <= 200 lines and zero direct ui/ -> lib/evidence/mistake-triage.js imports', () => {
  const engineLines = readFileSync(new URL('../lib/evidence/mistake-triage.js', import.meta.url), 'utf8').split(/\r?\n/).length;
  const ctxLines = readFileSync(new URL('../lib/evidence/triage-context.js', import.meta.url), 'utf8').split(/\r?\n/).length;
  assert.ok(engineLines <= 200, `mistake-triage.js has ${engineLines} lines (limit 200)`);
  assert.ok(ctxLines <= 200, `triage-context.js has ${ctxLines} lines (limit 200)`);
  const allowList = readFileSync(new URL('../tests/fixtures/ui-lib-allow-list.txt', import.meta.url), 'utf8');
  assert.doesNotMatch(allowList, /mistake-triage|triage-context/);
});
