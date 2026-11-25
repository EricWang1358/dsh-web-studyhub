import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StudyService } from '../lib/service.js';
import { planCourseOrganize, runCourseOrganize, MAX_PREREQS_PER_CARD } from '../lib/contexts/generation/course-organize/organize.js';
import { translateSource } from '../lib/translation-source.js';
import { usageLedger } from '../lib/model-usage.js';
import { createFakeModel } from '../scripts/fake-model.mjs';
import { loadUi } from './helpers/ui-module.mjs';
import { managedRuntimeOptions } from './helpers/runtime-switch.mjs';

const CJK_RE = /[\u4e00-\u9fff]/;

/** A library on the job runtime as DSH runs it: a live executor, and the job's model host when `model` is given (the suite's fake model). */
async function createLibrary(t, model = null) {
  const root = await mkdtemp(join(tmpdir(), 'study-course-organize-1293-'));
  const { starts: _starts, ...runtime } = managedRuntimeOptions({ complete: model || undefined, paths: [] });
  const service = new StudyService(root, { ...(model ? { complete: model, completeLight: model } : {}), ...runtime });
  t.after(async () => { await service.dispose(); await rm(root, { recursive: true, force: true }); });
  return { root, service };
}

const organizeJobs = service => [...service.runtime.work.jobs.values()].filter(job => job.type === 'course-organize');

/** Two chapters of a neutral course: the second card mentions the first card's topic, so the planner offers one link; neither card has cached terms. */
async function seedCompilers(service) {
  await service.call('deck.import', {
    course: 'Compilers',
    text: JSON.stringify({
      title: 'Ch1 Intro',
      course: 'Compilers',
      cards: [
        { id: 'm1', kind: 'flashcard', topic: 'Lexer', prompt: 'What does a Lexer produce?', answer: 'A stream of tokens from source characters.', explanation: 'Feeds the parser.' },
      ],
    }),
  });
  await service.call('deck.import', {
    course: 'Compilers',
    text: JSON.stringify({
      title: 'Ch2 Parsing',
      course: 'Compilers',
      cards: [
        { id: 'm2', kind: 'flashcard', topic: 'AST', prompt: 'How does a parser build an AST from Lexer tokens?', answer: 'Applies grammar productions.', explanation: 'Produces a syntax tree.' },
      ],
    }),
  });
}

async function waitForJobTerminal(service, jobId, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const status = await service.call('job.status', { jobId });
    if (['complete', 'failed', 'cancelled'].includes(status?.status)) return status;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for job ${jobId}`);
}

test('#1293-1: deterministic prerequisite planner links glossary and earlier-chapter topics acyclically, caps at 12, and never overwrites existing requires or cached card.terms', async () => {
  const cachedCard = {
    id: 'c-cached',
    kind: 'flashcard',
    topic: 'Deadlock',
    prompt: 'Explain Deadlock avoidance with Lock Ordering.',
    answer: 'Acquire locks in a global order.',
    explanation: 'Prevents circular wait.',
  };
  cachedCard.terms = { at: '2026-11-01T00:00:00Z', digest: translateSource(cachedCard).digest, items: ['Lock Ordering'] };

  // Build 13 earlier prerequisite cards to verify the 12-prerequisite cap
  const twelvePrereqs = Array.from({ length: 13 }, (_, i) => ({
    id: `pre-${i + 1}`,
    kind: 'flashcard',
    topic: `BaseConcept${i + 1}`,
    prompt: `Define BaseConcept${i + 1}.`,
    answer: `Definition ${i + 1}.`,
    explanation: `Details ${i + 1}.`,
  }));

  const state = {
    courses: [
      {
        id: 'course-db',
        name: 'Databases',
        terms: {
          version: 1,
          items: [
            { term: 'Snapshot Isolation', at: '2026-11-01T00:00:00Z', card: { deckId: 'd-ch1', cardId: 'c-snap' } },
          ],
        },
      },
    ],
    decks: [
      {
        id: 'd-ch1',
        title: 'Chapter 1 Foundations',
        course: 'Databases',
        cards: [
          { id: 'c-snap', kind: 'flashcard', topic: 'Snapshot Isolation', prompt: 'What is Snapshot Isolation?', answer: 'Each transaction reads a consistent snapshot.', explanation: 'Uses MVCC.' },
          { id: 'c-mvcc', kind: 'flashcard', topic: 'MVCC', prompt: 'How does MVCC work?', answer: 'Keeps multiple row versions.', explanation: 'Readers do not block writers.', requires: [{ deckId: 'd-ch2', cardId: 'c-adv' }] },
          ...twelvePrereqs,
        ],
      },
      {
        id: 'd-ch2',
        title: 'Chapter 2 Concurrency',
        course: 'Databases',
        cards: [
          {
            id: 'c-adv',
            kind: 'flashcard',
            topic: 'Write Skew',
            prompt: 'Why can Snapshot Isolation under MVCC allow write skew?',
            answer: 'Disjoint writes after overlapping reads.',
            explanation: 'SSI detects rw-antidependency cycles.',
          },
          {
            id: 'c-capped',
            kind: 'flashcard',
            topic: 'Mega Synthesis',
            prompt: twelvePrereqs.map(c => c.topic).join(' and '),
            answer: 'Combines all concepts.',
            explanation: 'Cap must stop at 12.',
            requires: twelvePrereqs.slice(0, 11).map(c => ({ deckId: 'd-ch1', cardId: c.id })),
          },
          cachedCard,
        ],
      },
    ],
    attempts: [],
  };

  const plan = planCourseOrganize(state, 'Databases', { maxLinksPerCard: 12 });
  assert.equal(plan.cachedTermCards, 1, 'detects already-cached card.terms');

  const res = await runCourseOrganize({ state, course: 'Databases', mode: 'all', ask: null });
  // c-adv -> c-snap should succeed; c-adv -> c-mvcc MUST be rejected as would-create-cycle because c-mvcc already requires c-adv!
  const adv = state.decks[1].cards.find(c => c.id === 'c-adv');
  assert.ok(adv.requires.some(r => r.cardId === 'c-snap'), 'glossary prerequisite linked');
  assert.equal(adv.requires.some(r => r.cardId === 'c-mvcc'), false, 'cyclic link rejected');
  assert.ok((res.skippedReasons['would-create-cycle'] || 0) >= 1, 'records cycle skip reason');

  // c-capped started with 11 requires -> can only add 1 more (total 12), 13th must be skipped with max-prerequisites
  const capped = state.decks[1].cards.find(c => c.id === 'c-capped');
  assert.equal(capped.requires.length, MAX_PREREQS_PER_CARD);
  assert.ok((res.skippedReasons['max-prerequisites'] || 0) >= 1, 'records max-prerequisites skip reason');

  // Existing cached terms untouched; no-model explicitly reported
  assert.deepEqual(cachedCard.terms.items, ['Lock Ordering']);
  assert.equal(res.termsNote, 'no-model');
  assert.ok(res.termsSkippedNoModel > 0);
  assert.ok(res.skippedReasons['no-model'] > 0);
});

test('#1293-2: StudyService course.organize.start runs offline without a model, appears in jobs list, and reports no-model cleanly', async t => {
  const { service } = await createLibrary(t);
  await service.call('deck.import', {
    course: 'Systems',
    text: JSON.stringify({
      title: 'Ch1 Basics',
      course: 'Systems',
      cards: [
        { id: 's1', kind: 'flashcard', topic: 'Page Table', prompt: 'What is a Page Table?', answer: 'Maps virtual to physical pages.', explanation: 'Used by MMU.' },
      ],
    }),
  });
  await service.call('deck.import', {
    course: 'Systems',
    text: JSON.stringify({
      title: 'Ch2 Virtual Memory',
      course: 'Systems',
      cards: [
        { id: 's2', kind: 'flashcard', topic: 'TLB', prompt: 'How does the TLB accelerate Page Table lookups?', answer: 'Caches recent translations.', explanation: 'Avoids multi-level walks.' },
      ],
    }),
  });

  // Dry-run preview works with zero writes
  const preview = await service.call('course.organize.start', { course: 'Systems', dryRun: true });
  assert.equal(preview.status, 'preview');
  assert.equal(preview.hasModel, false);
  assert.equal(preview.preview.candidateLinks, 1);

  // Actual run without model: still creates prerequisite link & completes in Task Console
  const started = await service.call('course.organize.start', { course: 'Systems', mode: 'all' });
  assert.ok(started.jobId);
  const done = await waitForJobTerminal(service, started.jobId);
  assert.equal(done.status, 'complete');
  assert.equal(done.linksAdded, 1);
  assert.equal(done.termsNote, 'no-model');
  assert.ok((done.skippedReasons?.['no-model'] || 0) >= 2);

  // Verify link actually persisted on the deck
  const exported = await service.call('export');
  const ch1 = exported.decks.find(d => d.title === 'Ch1 Basics');
  const ch2 = exported.decks.find(d => d.title === 'Ch2 Virtual Memory');
  assert.equal(ch2.cards[0].requires?.length, 1);
  assert.equal(ch2.cards[0].requires[0].cardId, ch1.cards[0].id);
});

test('#1293-3: StudyService course.organize.start with mock light model links prerequisites and pre-extracts card.terms without overwriting existing cache, and supports cancellation', async t => {
  let modelCalls = 0;
  const fake = createFakeModel({ usage: true });
  const { service } = await createLibrary(t, async (...args) => { modelCalls += 1; return fake(...args); });
  await seedCompilers(service);

  const started = await service.call('course.organize.start', { course: 'Compilers', mode: 'all' });
  const done = await waitForJobTerminal(service, started.jobId);
  assert.equal(done.status, 'complete');
  assert.equal(done.linksAdded, 1);
  assert.equal(done.termsExtracted, 2);
  assert.equal(modelCalls, 2);

  // Running a second time skips both existing links and cached card.terms (0 new model calls!)
  const second = await service.call('course.organize.start', { course: 'Compilers', mode: 'all' });
  const done2 = await waitForJobTerminal(service, second.jobId);
  assert.equal(done2.status, 'complete');
  assert.equal(done2.linksAdded, 0);
  assert.equal(done2.termsExtracted, 0);
  assert.equal(done2.termsCached, 2);
  assert.equal(modelCalls, 2, 'second run makes zero model calls because terms are cached');

  // Cancellation mid-run via AbortController
  const controller = new AbortController();
  const state = await service.call('export');
  // Clear cached terms so cancel triggers on step 1
  for (const d of state.decks) for (const c of d.cards) delete c.terms;
  let callsBeforeAbort = 0;
  await assert.rejects(
    runCourseOrganize({
      state,
      course: 'Compilers',
      mode: 'terms',
      signal: controller.signal,
      ask: async () => {
        callsBeforeAbort += 1;
        controller.abort(new Error('user cancelled'));
        return JSON.stringify({ terms: ['Lexer'] });
      },
    }),
  );
  assert.equal(callsBeforeAbort, 1, 'stops immediately after abort signal');
});

test('#1293-6: every model call of the job goes through its own gateway: a Step and a Call per call on the job record, booked once in the usage ledger', async t => {
  const log = [];
  const { root, service } = await createLibrary(t, createFakeModel({ log, usage: true }));
  await seedCompilers(service);
  const ledger = usageLedger(root);
  const before = (await ledger.summary({ days: 1 })).byFeature.other?.calls || 0;

  const started = await service.call('course.organize.start', { course: 'Compilers', mode: 'all' });
  const done = await waitForJobTerminal(service, started.jobId);
  assert.equal(done.status, 'complete');
  assert.equal(done.termsExtracted, 2);
  const asked = log.filter(entry => entry.handler === 'card.terms').length;
  assert.equal(asked, 2);

  const [job] = organizeJobs(service);
  const { contract } = job;
  const steps = contract.runtime.steps.filter(step => step.stepKey.startsWith('terms:'));
  assert.equal(steps.length, asked, 'one Step per model call');
  assert.ok(steps.every(step => step.status === 'complete'));
  assert.equal(contract.calls.length, asked, 'one Call per model call on the job record');
  for (const call of contract.calls) {
    assert.deepEqual([call.status, call.observation.boundary, call.feature, call.runner], ['ok', 'host-attempt', 'other', 'direct']);
    assert.ok(call.tokens > 0, 'the usage the host reported rides on the Call');
  }
  assert.equal(contract.result.completeness, 'complete');
  const after = (await ledger.summary({ days: 1 })).byFeature.other?.calls || 0;
  assert.equal(after - before, asked, 'the usage ledger counted each call once, by the gateway');
});

test('#1293-4: CourseSettings exposes secondary batch organize UI with Tooltip and clean English i18n', async () => {
  const ui = await loadUi(`
    export { setUiLanguage, ui } from './ui/i18n.js';
    export { default as CourseSettings } from './ui/CourseSettings.jsx';
  `);
  ui.setUiLanguage('en');
  try {
    for (const key of [
      '批量整理前置依赖与生词',
      '开始整理前置依赖与生词',
      '去任务台查看进度',
      '新增前置链接后，未掌握的前置题会在学习路径中提前出现；已有前置与生词缓存不会被覆盖。',
    ]) {
      const en = ui.ui(key);
      assert.ok(en && !CJK_RE.test(en), `Missing/leaked EN translation for "${key}": ${en}`);
    }
  } finally {
    ui.setUiLanguage('zh');
  }
});
