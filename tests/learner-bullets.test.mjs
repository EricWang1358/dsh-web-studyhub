/* StudyHub 5.0.0 Wave 3B (Evolution 4):
   Traceable editable learner bullets (`learner.bullets`), optimistic `memoryRevision` CAS protection
   across `coach.profile` / `coach.debrief` / `coach.preferences` / `coach.goal` / `coach.forget`,
   `learnerFacts` / `learnerBrief` projection, and Settings Profile UI with clickable `card` / `hid` / `companion` refs. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { build as esbuild } from 'esbuild';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { StudyService } from '../lib/service.js';
import { LATEST_VERSION } from '../lib/store.js';
import {
  LEARNER_BULLETS_MAX,
  LEARNER_BULLET_MAX_CHARS,
  cleanLearnerBulletRef,
  cleanLearnerBullets,
  emptyLearner,
  normalizeLearner,
} from '../lib/learner.js';
import { learnerBrief, mergeDebriefBullets } from '../lib/coach.js';
import { learnerFacts } from '../lib/learner-facts.js';
import { createFakeModel } from '../scripts/fake-model.mjs';
import { loadUi } from './helpers/ui-module.mjs';
import { inApp } from './helpers/fake-app.mjs';
import { nativeSelects } from './helpers/native-selects.mjs';

const require = createRequire(import.meta.url);
const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
const HAN_RE = /\p{Script=Han}/u;

const SAMPLE_SOURCE = {
  id: 'src-os',
  title: 'OS Synchronization Notes',
  course: 'OS',
  text: 'Mutex enforces strict thread ownership when unlocking. Semaphores count available permits and can be signaled by any thread.',
};

const makeCard = (n, extra = {}) => ({
  id: `c${n}`,
  kind: 'quiz',
  topic: 'Synchronization',
  objective: `Sync objective ${n}`,
  prompt: `Question ${n}: Which primitive enforces strict thread ownership?`,
  answer: 'Mutex',
  hint: 'Check unlock ownership.',
  explanation: 'Only the thread that locked a Mutex may unlock it.',
  misconception: 'Assuming any thread may release a Mutex.',
  citations: [{ sourceId: 'src-os', quote: 'Mutex enforces strict thread ownership when unlocking.' }],
  options: [
    { id: 'a', text: 'Mutex', correct: true, explanation: 'Enforces single-thread ownership.' },
    { id: 'b', text: 'Semaphore', correct: false, explanation: 'Tracks permits without owner checks.' },
    { id: 'c', text: 'Barrier', correct: false, explanation: 'Synchronizes threads at a phase point.' },
  ],
  ...extra,
});

async function setupCoachService(t, { completeLight } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'study-learner-bullets-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const light = completeLight || createFakeModel();
  const service = new StudyService(root, { complete: light, completeLight: light, coach: true });
  t.after(() => service.dispose?.());
  await service.call('course.save', { name: 'OS' });
  await service.call('source.add', SAMPLE_SOURCE);
  await service.call('draft.save', {
    deck: {
      id: 'd-os',
      title: 'OS Sync',
      course: 'OS',
      cards: [
        makeCard(1, { hid: 'h2', companionRef: { companionId: 'comp-sync', slide: 2 } }),
        makeCard(2, { hid: 'h2' }),
        makeCard(3, { hid: 'h3' }),
        makeCard(4, { hid: 'h3' }),
      ],
    },
  });
  await new StudyService(root).call('draft.publish', { id: 'd-os' });
  return { root, service };
}

/* ---------- 1. Schema, Cap, Typed Refs & Legacy Fallback ---------- */

test('learner.bullets enforces store v5 compatibility, max 10 items, <=140 chars, typed refs, and strict validation', async (t) => {
  assert.equal(LATEST_VERSION, 5);
  assert.deepEqual(emptyLearner().bullets, []);

  // Legacy learner object without `bullets` normalizes cleanly while preserving read-only `summary`
  const legacy = normalizeLearner({ summary: 'Legacy summary preserved.', goal: 'exam' });
  assert.deepEqual(legacy.bullets, []);
  assert.equal(legacy.summary, 'Legacy summary preserved.');
  assert.equal(legacy.memoryRevision, 0);

  // Non-strict normalization clips long text, drops invalid refs, deduplicates refs, and caps at 10
  const normalized = cleanLearnerBullets([
    {
      id: 'b1',
      text: `  ${'x'.repeat(200)}  `,
      course: 'OS',
      source: 'coach',
      refs: [
        { kind: 'card', deckId: 'd1', cardId: 'c1' },
        { kind: 'card', deckId: 'd1', cardId: 'c1' },
        { kind: 'hid', course: 'OS', hid: 'h2' },
        { kind: 'companion', companionId: 'comp-1', slide: 3 },
        { kind: 'bogus', id: 'bad' },
        { kind: 'companion', companionId: 'comp-2', slide: 0 },
      ],
    },
    ...Array.from({ length: 15 }, (_, idx) => ({ id: `extra-${idx}`, text: `Bullet ${idx}`, source: 'user', refs: [] })),
  ]);
  assert.equal(normalized.length, LEARNER_BULLETS_MAX);
  assert.equal(normalized[0].text.length, LEARNER_BULLET_MAX_CHARS);
  assert.deepEqual(normalized[0].refs, [
    { kind: 'card', deckId: 'd1', cardId: 'c1' },
    { kind: 'hid', course: 'OS', hid: 'h2' },
    { kind: 'companion', companionId: 'comp-1', slide: 3 },
  ]);

  // Strict ref & bullet validation rejects malformed inputs
  assert.throws(() => cleanLearnerBulletRef({ kind: 'unknown' }, { strict: true }));
  assert.throws(() => cleanLearnerBulletRef({ kind: 'card', deckId: 'd1' }, { strict: true }));
  assert.throws(() => cleanLearnerBulletRef({ kind: 'hid', course: 'OS' }, { strict: true }));
  assert.throws(() => cleanLearnerBulletRef({ kind: 'companion', companionId: 'comp-1', slide: 0 }, { strict: true }));
  assert.throws(() => cleanLearnerBullets([{ id: 'b1', text: 'a'.repeat(LEARNER_BULLET_MAX_CHARS + 1) }], { strict: true }));
  assert.throws(() => cleanLearnerBullets(
    Array.from({ length: LEARNER_BULLETS_MAX + 1 }, (_, i) => ({ id: `b${i}`, text: `Note ${i}` })),
    { strict: true },
  ));

  // Service CRUD + CAS revision enforcement
  const { service } = await setupCoachService(t);
  const initial = await service.call('coach.profile', {});
  assert.equal(initial.memoryRevision, 0);
  assert.deepEqual(initial.bullets, []);

  const afterAdd = await service.call('coach.profile', {
    expectedRevision: 0,
    addBullet: {
      text: 'Unlocking a Mutex requires the same owning thread.',
      course: 'OS',
      refs: [{ kind: 'card', deckId: 'd-os', cardId: 'c1' }, { kind: 'hid', course: 'OS', hid: 'h2' }],
      source: 'user',
    },
  });
  assert.equal(afterAdd.memoryRevision, 1);
  assert.equal(afterAdd.bullets.length, 1);
  const bulletId = afterAdd.bullets[0].id;

  // Stale expectedRevision is rejected on profile, preferences, and goal writes
  await assert.rejects(
    service.call('coach.profile', { expectedRevision: 0, removeBullet: bulletId }),
    err => err.code === 'MEMORY_REVISION_CONFLICT',
  );
  await assert.rejects(
    service.call('coach.preferences', { expectedRevision: 0, preferences: ['Use diagrams'] }),
    err => err.code === 'MEMORY_REVISION_CONFLICT',
  );
  await assert.rejects(
    service.call('coach.goal', { expectedRevision: 0, goal: 'exam' }),
    err => err.code === 'MEMORY_REVISION_CONFLICT',
  );

  // Update & delete with current expectedRevision succeed and advance memoryRevision
  const afterEdit = await service.call('coach.profile', {
    expectedRevision: 1,
    updateBullet: { id: bulletId, text: 'Always check Mutex owner before unlock.' },
  });
  assert.equal(afterEdit.memoryRevision, 2);
  assert.equal(afterEdit.bullets[0].text, 'Always check Mutex owner before unlock.');

  const afterRemove = await service.call('coach.profile', {
    expectedRevision: 2,
    removeBullet: bulletId,
  });
  assert.equal(afterRemove.memoryRevision, 3);
  assert.deepEqual(afterRemove.bullets, []);
});

/* ---------- 2. Concurrency / Anti-Resurrection CAS Tests ---------- */

test('memoryRevision CAS blocks stale in-flight coach.debrief after coach.forget or manual bullet deletion', async (t) => {
  // Scenario A: coach.debrief writes traceable bullets when uncontested, ignoring fabricated refIds
  const mockDebriefModel = async (_sys, prompt) => {
    const input = JSON.parse(prompt);
    const firstRefId = input.candidateRefs?.[0]?.refId;
    const secondRefId = input.candidateRefs?.[1]?.refId;
    return JSON.stringify({
      headline: 'Check Mutex ownership rules.',
      why: 'Missed ownership condition on synchronization items.',
      next: input.defaultNext,
      summary: 'Frequently confuses Mutex ownership with Semaphore permits.',
      bullets: [
        { text: 'Confuses Mutex ownership with Semaphore signaling.', refIds: [firstRefId, secondRefId, 'r999'].filter(Boolean) },
      ],
    });
  };
  const { service } = await setupCoachService(t, { completeLight: mockDebriefModel });
  await service.call('coach.goal', { goal: 'exam' });
  await service.call('coach.profile', {
    addBullet: { text: 'Keep user retell note.', course: 'OS', source: 'retell', refs: [{ kind: 'hid', course: 'OS', hid: 'h2' }] },
  });

  let run1 = await service.call('review.start', { deckId: 'd-os', mode: 'quiz' });
  while (!run1.complete) {
    const wrong = run1.card.options.find(o => !o.correct).id;
    run1 = await service.call('review.answer', { runId: run1.id, cardId: run1.card.id, selected: [wrong] });
    run1 = await service.call('review.move', { runId: run1.id, direction: 1 });
  }
  const res1 = await service.call('coach.debrief', { runId: run1.id });
  assert.equal(res1.version, 2);
  const prof1 = await service.call('coach.profile', {});
  assert.equal(prof1.bullets.length, 2, 'preserves retell bullet and appends traceable coach bullet');
  const coachBullet = prof1.bullets.find(b => b.source === 'coach');
  assert.ok(coachBullet);
  assert.ok(coachBullet.refs.some(r => r.kind === 'card' && r.deckId === 'd-os'));
  assert.ok(coachBullet.refs.every(r => r.kind === 'card' || r.kind === 'hid' || r.kind === 'companion'));

  // Scenario B: Manual bullet deletion while a new coach.debrief is in flight MUST block resurrection
  let run2 = await service.call('review.start', { deckId: 'd-os', mode: 'quiz', fresh: true });
  while (!run2.complete) {
    const wrong = run2.card.options.find(o => !o.correct).id;
    run2 = await service.call('review.answer', { runId: run2.id, cardId: run2.card.id, selected: [wrong] });
    run2 = await service.call('review.move', { runId: run2.id, direction: 1 });
  }
  const startedDelete = Promise.withResolvers();
  const releaseDelete = Promise.withResolvers();
  service.light = async (...args) => {
    startedDelete.resolve();
    await releaseDelete.promise;
    return mockDebriefModel(...args);
  };
  const inflightDelete = service.call('coach.debrief', { runId: run2.id });
  await startedDelete.promise;
  try {
    await service.call('coach.profile', {
      expectedRevision: prof1.memoryRevision,
      removeBullet: coachBullet.id,
    });
  } finally {
    releaseDelete.resolve();
  }
  await inflightDelete;
  const afterDeleteRace = await service.call('coach.profile', {});
  assert.equal(afterDeleteRace.bullets.some(b => b.source === 'coach'), false, 'stale debrief cannot resurrect manually deleted bullet');
  assert.equal(afterDeleteRace.bullets.length, 1, 'user retell bullet survives');

  // Scenario C: coach.forget while another coach.debrief is in flight MUST block resurrection & clear bullets
  let run3 = await service.call('review.start', { deckId: 'd-os', mode: 'quiz', fresh: true });
  while (!run3.complete) {
    const wrong = run3.card.options.find(o => !o.correct).id;
    run3 = await service.call('review.answer', { runId: run3.id, cardId: run3.card.id, selected: [wrong] });
    run3 = await service.call('review.move', { runId: run3.id, direction: 1 });
  }
  const startedForget = Promise.withResolvers();
  const releaseForget = Promise.withResolvers();
  service.light = async (...args) => {
    startedForget.resolve();
    await releaseForget.promise;
    return mockDebriefModel(...args);
  };
  const inflightForget = service.call('coach.debrief', { runId: run3.id });
  await startedForget.promise;
  try {
    const forgotten = await service.call('coach.forget', {});
    assert.deepEqual(forgotten.bullets, []);
  } finally {
    releaseForget.resolve();
  }
  await inflightForget;
  const afterForgetRace = await service.call('coach.profile', {});
  assert.deepEqual(afterForgetRace.bullets, [], 'stale debrief cannot resurrect cleared bullets after coach.forget');
  assert.equal(afterForgetRace.summary, '', 'stale debrief cannot restore summary after coach.forget');

  // mergeDebriefBullets preserves user bullets when capping at LEARNER_BULLETS_MAX
  const manyUser = Array.from({ length: 8 }, (_, i) => ({ id: `u${i}`, text: `User ${i}`, source: 'user', refs: [], updatedAt: '2026-11-20T00:00:00Z' }));
  const manyCoach = Array.from({ length: 5 }, (_, i) => ({ text: `Coach ${i}`, refs: [] }));
  const merged = mergeDebriefBullets(manyUser, manyCoach, { course: 'OS' });
  assert.equal(merged.length, LEARNER_BULLETS_MAX);
  assert.equal(merged.filter(b => b.source === 'user').length, 8, 'all user bullets preserved under cap');
});

/* ---------- 3. learnerFacts & learnerBrief Projection ---------- */

test('learnerFacts and learnerBrief project course-scoped traceable bullets while respecting coach consent gate', () => {
  const baseState = {
    focus: { mode: 'class', course: 'OS' },
    courses: [{ id: 'c-os', name: 'OS' }, { id: 'c-alg', name: 'Algorithms' }],
    sources: [],
    decks: [],
    drafts: [],
    attempts: [],
    settings: {},
    learner: {
      consent: { prep: false },
      goal: '',
      preferences: [],
      summary: 'Legacy gated summary',
      bullets: [
        { id: 'b-coach', text: 'Coach-inferred OS pattern', course: 'OS', source: 'coach', refs: [{ kind: 'hid', course: 'OS', hid: 'h2' }], updatedAt: '2026-11-20T00:00:00Z' },
        { id: 'b-user', text: 'User OS note', course: 'OS', source: 'user', refs: [{ kind: 'card', deckId: 'd-os', cardId: 'c1' }], updatedAt: '2026-11-20T00:00:00Z' },
        { id: 'b-other', text: 'Other course note', course: 'Algorithms', source: 'user', refs: [], updatedAt: '2026-11-20T00:00:00Z' },
      ],
    },
  };

  const withoutConsent = learnerFacts(baseState, 'OS');
  assert.equal(withoutConsent.summary, undefined, 'legacy summary stays gated when consent.prep is false');
  assert.deepEqual(withoutConsent.bullets.map(b => b.id), ['b-user'], 'user bullet surfaces for OS while coach bullet is gated and other course excluded');

  const withConsent = learnerFacts({ ...baseState, learner: { ...baseState.learner, consent: { prep: true } } }, 'OS');
  assert.equal(withConsent.summary, 'Legacy gated summary');
  assert.deepEqual(withConsent.bullets.map(b => b.id), ['b-coach', 'b-user']);

  const brief = learnerBrief(baseState.learner, withConsent, 'en');
  assert.equal(brief.bullets.length, 2);
  assert.equal(brief.profile, 'Legacy gated summary');

  // Privacy gate: learnerBrief must NEVER bypass learnerFacts to leak learner.summary or coach bullets when consent is revoked or debrief is disabled.
  const briefNoConsent = learnerBrief(baseState.learner, withoutConsent, 'en');
  assert.equal(briefNoConsent.profile, undefined, 'learnerBrief omits legacy summary when consent.prep is false');
  assert.deepEqual(briefNoConsent.bullets.map(b => b.id), ['b-user'], 'learnerBrief omits coach bullets when consent.prep is false');

  const debriefOffFacts = learnerFacts({
    ...baseState,
    learner: { ...baseState.learner, consent: { prep: true } },
    settings: { practice: { debrief: false } },
  }, 'OS');
  const briefDebriefOff = learnerBrief({ ...baseState.learner, consent: { prep: true } }, debriefOffFacts, 'en');
  assert.equal(briefDebriefOff.profile, undefined, 'learnerBrief omits legacy summary when settings.practice.debrief is false');
  assert.deepEqual(briefDebriefOff.bullets.map(b => b.id), ['b-user']);

  const briefNullFacts = learnerBrief({ ...baseState.learner, consent: { prep: true } }, null, 'en');
  assert.equal(briefNullFacts.profile, undefined, 'learnerBrief does not leak raw learner.summary when facts is null');
  assert.deepEqual(briefNullFacts.bullets.map(b => b.id), ['b-user', 'b-other'], 'learnerBrief filters out coach bullets when facts is null');
});

/* ---------- 4. Settings Profile UI & Clickable Anchor Navigation ---------- */

const uiMod = await loadUi(`
  export { CoachSection, bulletRefLabel } from './ui/settings/CoachSection.jsx';
  export { AppContext } from './ui/app/app-context.js';
  export { StudyServicesContext } from './ui/study-context.jsx';
  export { setUiLanguage } from './ui/i18n.js';
`);

const h = React.createElement;
const noop = () => {};
const stripTags = html => html.replace(/<style[\s\S]*?<\/style>/g, '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

test('CoachSection renders editable traceable bullets with card/hid/companion anchors in zh & en (0 Han in en) and legacy summary fallback', () => {
  const data = {
    focus: { course: 'OS' },
    decks: [{ id: 'd-os', title: 'OS Sync', cards: [{ id: 'c1', topic: 'Mutex' }] }],
    courses: [{ id: 'c-os', name: 'OS', companions: [{ id: 'comp-sync', title: 'Mutex Contrast Lab' }] }],
  };
  const profileWithBullets = {
    consent: true,
    goal: 'exam',
    preferences: [],
    summary: 'Old summary',
    memoryRevision: 4,
    bullets: [
      {
        id: 'b1',
        text: 'Watch Mutex owner checks on unlock.',
        course: 'OS',
        source: 'coach',
        refs: [
          { kind: 'card', deckId: 'd-os', cardId: 'c1' },
          { kind: 'hid', course: 'OS', hid: 'h2' },
          { kind: 'companion', companionId: 'comp-sync', slide: 2 },
        ],
        updatedAt: '2026-11-20T00:00:00Z',
      },
    ],
    signals: { got: 2, confused: 1, up: 1, down: 0 },
    ready: 0,
  };

  uiMod.setUiLanguage('zh');
  const zhHtml = renderToStaticMarkup(inApp(uiMod, h(uiMod.CoachSection, {
    data,
    profile: profileWithBullets,
    setProfile: noop,
    onOpenRef: noop,
  }), { data }));
  assert.match(stripTags(zhHtml), /Watch Mutex owner checks on unlock/);
  assert.match(zhHtml, /data-bullet-ref="card"/);
  assert.match(zhHtml, /data-bullet-ref="hid"/);
  assert.match(zhHtml, /data-bullet-ref="companion"/);
  assert.match(stripTags(zhHtml), /原题 · Mutex/);
  assert.match(stripTags(zhHtml), /全书 · OS h2/);
  assert.match(stripTags(zhHtml), /Mutex Contrast Lab · 伴学第 2 页/);

  // English path has zero Chinese characters
  uiMod.setUiLanguage('en');
  let enHtml = '';
  let enLegacyHtml = '';
  try {
    enHtml = renderToStaticMarkup(inApp(uiMod, h(uiMod.CoachSection, {
      data,
      profile: profileWithBullets,
      setProfile: noop,
      onOpenRef: noop,
    }), { data }));
    enLegacyHtml = renderToStaticMarkup(inApp(uiMod, h(uiMod.CoachSection, {
      data,
      profile: { consent: false, goal: 'exam', preferences: [], summary: 'Legacy read-only summary.', bullets: [], memoryRevision: 1, signals: {}, ready: 0 },
      setProfile: noop,
      onOpenRef: noop,
    }), { data }));
  } finally {
    uiMod.setUiLanguage('zh');
  }
  assert.doesNotMatch(stripTags(enHtml), HAN_RE, 'zero Chinese in English CoachSection with bullets');
  assert.match(stripTags(enHtml), /Question · Mutex/);
  assert.match(stripTags(enHtml), /Review book · OS h2/);
  assert.match(stripTags(enHtml), /Mutex Contrast Lab · Slide 2/);
  assert.doesNotMatch(stripTags(enLegacyHtml), HAN_RE, 'zero Chinese in English legacy fallback');
  assert.match(stripTags(enLegacyHtml), /Legacy profile summary/);
  assert.match(stripTags(enLegacyHtml), /Legacy read-only summary\./);
});

/* ---------- 5. Interactive Anchor Jump + Edit/Delete/Add CAS Wiring ---------- */

const liveBundle = await esbuild({
  stdin: {
    contents: `
      export { CoachSection } from './ui/settings/CoachSection.jsx';
      export { StudyServicesContext } from './ui/study-context.jsx';
    `,
    resolveDir: REPO_ROOT,
  },
  bundle: true,
  write: false,
  platform: 'node',
  format: 'cjs',
  external: ['react', 'react-dom', 'react/*', 'react-dom/*', '@base-ui/*'],
  plugins: [nativeSelects],
  loader: { '.css': 'text' },
  logLevel: 'silent',
});

function createHookHarness(studyValue) {
  const state = { cursor: 0, slots: [] };
  let studyCtx = null;
  const mockReact = {
    ...React,
    useState: init => {
      const idx = state.cursor++;
      if (!(idx in state.slots)) state.slots[idx] = typeof init === 'function' ? init() : init;
      return [state.slots[idx], next => { state.slots[idx] = typeof next === 'function' ? next(state.slots[idx]) : next; }];
    },
    useMemo: (calc, deps) => {
      const idx = state.cursor++;
      const slot = state.slots[idx];
      if (!slot || !Array.isArray(deps) || !Array.isArray(slot.deps) || deps.length !== slot.deps.length || deps.some((v, i) => !Object.is(v, slot.deps[i]))) {
        state.slots[idx] = { deps, value: calc() };
      }
      return state.slots[idx].value;
    },
    useCallback: (cb, deps) => mockReact.useMemo(() => cb, deps),
    useRef: init => {
      const idx = state.cursor++;
      if (!(idx in state.slots)) state.slots[idx] = { current: init };
      return state.slots[idx];
    },
    useContext: ctx => (ctx === studyCtx ? studyValue : { success: noop, error: noop }),
    useEffect: noop,
    useLayoutEffect: noop,
    useInsertionEffect: noop,
    useId: () => `id-${state.cursor++}`,
  };
  const mod = { exports: {} };
  const customRequire = id => (id === 'react' ? mockReact : require(id));
  new Function('require', 'module', 'exports', liveBundle.outputFiles[0].text)(customRequire, mod, mod.exports);
  studyCtx = mod.exports.StudyServicesContext;
  return {
    render(fn) { state.cursor = 0; return fn(mod.exports); },
  };
}

function collectNodes(node, pred, out = []) {
  if (!node || typeof node !== 'object') return out;
  if (Array.isArray(node)) { for (const child of node) collectNodes(child, pred, out); return out; }
  if (pred(node)) out.push(node);
  if (node.props?.children !== undefined) collectNodes(node.props.children, pred, out);
  return out;
}

test('CoachSection interactive clicks route card/hid/companion refs and send expectedRevision CAS on add/edit/delete', () => {
  const actCalls = [];
  const openedRefs = [];
  const harness = createHookHarness({
    busy: false,
    act: (action, args, after) => { actCalls.push([action, args]); after?.(props.profile); },
    call: async () => null,
    host: { capabilities: { chat: true } },
  });
  const props = {
    data: { focus: { course: 'OS' }, decks: [], courses: [] },
    profile: {
      consent: true,
      goal: 'exam',
      preferences: [],
      summary: '',
      memoryRevision: 7,
      bullets: [{
        id: 'b1',
        text: 'Watch boundary conditions.',
        course: 'OS',
        source: 'coach',
        refs: [
          { kind: 'card', deckId: 'd-os', cardId: 'c1' },
          { kind: 'hid', course: 'OS', hid: 'h2' },
          { kind: 'companion', companionId: 'comp-sync', slide: 2 },
        ],
        updatedAt: '2026-11-20T00:00:00Z',
      }],
      signals: {},
      ready: 0,
    },
    setProfile: noop,
    onOpenRef: ref => openedRefs.push(ref),
  };

  let tree = harness.render(live => live.CoachSection(props));
  const refBtns = collectNodes(tree, n => n.props?.['data-bullet-ref'] && typeof n.props?.onClick === 'function');
  assert.equal(refBtns.length, 3);
  for (const btn of refBtns) btn.props.onClick();
  assert.deepEqual(openedRefs, props.profile.bullets[0].refs);

  // Add bullet with expectedRevision: 7
  const addInput = collectNodes(tree, n => n.props?.className === 'coach-bullet-input')[0];
  addInput.props.onChange({ target: { value: 'Check base case first.' } });
  tree = harness.render(live => live.CoachSection(props));
  const addBtn = collectNodes(tree, n => n.props?.children === '添加要点')[0];
  addBtn.props.onClick();

  // Edit bullet inline and save with expectedRevision: 7
  tree = harness.render(live => live.CoachSection(props));
  const editBtn = collectNodes(tree, n => n.props?.children === '编辑')[0];
  editBtn.props.onClick();
  tree = harness.render(live => live.CoachSection(props));
  const editInput = collectNodes(tree, n => n.props?.className === 'coach-bullet-input' && n.props?.value === 'Watch boundary conditions.')[0];
  editInput.props.onChange({ target: { value: 'Check boundary conditions first.' } });
  tree = harness.render(live => live.CoachSection(props));
  const saveBtn = collectNodes(tree, n => n.props?.children === '保存')[0];
  saveBtn.props.onClick();

  // Delete bullet with expectedRevision: 7
  tree = harness.render(live => live.CoachSection(props));
  const delBtn = collectNodes(tree, n => n.props?.children === '删除')[0];
  delBtn.props.onClick();

  assert.deepEqual(actCalls, [
    ['coach.profile', { addBullet: { text: 'Check base case first.', course: 'OS', source: 'user', refs: [] }, expectedRevision: 7 }],
    ['coach.profile', { updateBullet: { id: 'b1', text: 'Check boundary conditions first.' }, expectedRevision: 7 }],
    ['coach.profile', { removeBullet: 'b1', expectedRevision: 7 }],
  ]);
});
