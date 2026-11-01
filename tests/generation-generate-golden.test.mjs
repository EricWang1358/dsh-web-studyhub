/* The operation `generate` pinned from the outside before it is split (issue #608): every kind of press the way the UI makes it, with a recording fake model. What is pinned: the model calls in order (stage,
   part, round, a digest of the bytes of system and prompt, the length), the RPC answer, the job card as it was seeded and as it ended, and what the draft says. Ids, times and clock readings are
   marked (tests/helpers/generate-golden.mjs), so what is left is what the code decided. tests/fixtures/generation-generate-golden*.json were recorded from the code before the split and must not move
   with a refactoring; a deliberate change records again (STUDY_RECORD_GOLDEN=1) and the diff of the file is the review. Run it on the runtime with STUDY_RUNTIME_MATRIX=generation (a fixture of its own). */
import test from 'node:test';
import { createFakeModel } from '../scripts/fake-model.mjs';
import { clusteringModel } from './helpers/clustering-model.mjs';
import { goldenLibrary, pinned } from './helpers/generate-golden.mjs';
import { settleJob } from './helpers/wait.mjs';

const ONE_BY_ONE = { concurrency: 1, batchSize: 4, jobTimeoutMinutes: 20, fillRounds: 0, effortPlanning: 'follow', effortReview: 'follow', effortWriting: 'low', effortRepair: 'low' };
const PLAIN = { kind: 'quiz', count: 4, performance: ONE_BY_ONE };
const firstDraft = async service => (await service.call('export')).drafts[0];
const continues = (draft, more = {}) => ({ resumeDraftId: draft.id, draftVersion: draft.draftVersion, performance: ONE_BY_ONE, ...more });
const CASE_TEXT = 'Microservices split a system into independently deployable services that own their data. Event-driven architecture lets services react to events published by others, which decouples producers from consumers.\n\nPolyglot persistence chooses a different data store for each workload.\n\nRelational databases give transactions for payments and settlements, while key-value stores serve sessions and carts at low latency.';

test('a plain run: a number of questions, a raised count, a missing source, several kinds', async t => {
  const lib = await goldenLibrary(t);
  pinned('plain.count', await lib.press('generate', { sourceIds: lib.ids, title: 'My deck', focus: 'scope', difficulty: 'advanced', ...PLAIN }));
  const raised = await goldenLibrary(t);
  pinned('plain.raised', await raised.press('generate', { sourceIds: [...raised.ids, 'spare'], ...PLAIN, count: 1 }));
  const gone = await goldenLibrary(t);
  // (With generationRestart the runtime refuses this before it starts, input-unavailable: the manifest must hold what it was asked. That side's fixture says so.)
  pinned('plain.missingSource', await gone.press('generate', { sourceIds: [gone.ids[0], 'no-longer-here'], ...PLAIN }).catch(error => ({ refused: error.code })));
  const kinds = await goldenLibrary(t, { model: createFakeModel() });
  pinned('plain.kinds', await kinds.press('generate', { sourceIds: kinds.ids, kind: 'mixed', kinds: ['quiz', 'flashcard'], count: 6, performance: ONE_BY_ONE }));
});

test('the settings of a run, in English, with a retrieval-free selection and references', async t => {
  const lib = await goldenLibrary(t, { language: 'en' });
  pinned('plain.english', await lib.press('generate', { sourceIds: lib.ids, ...PLAIN, notation: 'latex', constraints: { topicNoAnswer: true }, referenceSourceIds: ['spare'], referenceLimits: { sources: 1, chars: 6000 } }));
});

test('a second run waits behind the first', async t => {
  const lib = await goldenLibrary(t);
  lib.gate.armed = true;
  const first = await lib.service.call('generate', { sourceIds: lib.ids, kind: 'quiz', count: 2 });
  const second = await lib.service.call('generate', { sourceIds: lib.ids, kind: 'quiz', count: 2 });
  pinned('queued', lib.clean.walk({ second, card: await lib.cardOf(second.jobId) }));
  while (!lib.gate.open) await new Promise(resolve => setImmediate(resolve));
  lib.gate.armed = false; lib.gate.open();
  await settleJob(lib.service, first.jobId);
  await settleJob(lib.service, second.jobId);
});

test('a coverage run: weighed, small target, by itself, waiting, and without a light model', async t => {
  const lib = await goldenLibrary(t);
  pinned('coverage.standard', await lib.press('generate', { sourceIds: lib.ids, coverageLevel: 'standard', kind: 'quiz', title: 'All of it', performance: ONE_BY_ONE }));
  const small = await goldenLibrary(t);
  pinned('coverage.smallTarget', await small.press('generate', { sourceIds: small.ids, coverageLevel: 'lean', count: 5, kind: 'quiz', performance: ONE_BY_ONE }));
  const budget = await goldenLibrary(t);
  pinned('coverage.budget', await budget.press('generate', { sourceIds: budget.ids, coverageLevel: 'full', count: 40, tokenBudget: 1000, kind: 'quiz', performance: ONE_BY_ONE }));
  const dark = await goldenLibrary(t, { light: null });
  pinned('coverage.noLight', await dark.press('generate', { sourceIds: dark.ids, coverageLevel: 'standard', autoComplete: false, kind: 'quiz', performance: ONE_BY_ONE }));
});

test('going on with a plan: the next round by hand, the rest by itself, sections chosen', async t => {
  const lib = await goldenLibrary(t);
  pinned('run.waiting', await lib.press('generate', { sourceIds: lib.ids, coverageLevel: 'standard', autoComplete: false, kind: 'quiz', performance: ONE_BY_ONE }));
  let draft = await firstDraft(lib.service);
  const view = await lib.service.call('coverage.get', { draftId: draft.id });
  pinned('run.nextRoundSections', await lib.press('generate', continues(draft, { coverage: { sectionIds: view.round.picks.map(pick => pick.key) } })));
  draft = await firstDraft(lib.service);
  pinned('run.continue', await lib.press('generate', continues(draft, { coverage: { run: true, autoComplete: true } })));
});

test('going on after the host stopped: the round in flight again, and closing what has nothing left to ask', async t => {
  const lib = await goldenLibrary(t);
  await settleJob(lib.service, (await lib.service.call('generate', { sourceIds: lib.ids, coverageLevel: 'standard', kind: 'quiz', performance: ONE_BY_ONE })).jobId);
  const draft = await firstDraft(lib.service), { stop: _stop, ...marker } = draft.editorial.coverageRun;
  const lost = await lib.service.call('draft.save', { deck: { ...draft, editorial: { ...draft.editorial, coverageRun: { ...marker, state: 'running' } } }, requireExisting: true });
  pinned('run.close', await lib.press('generate', { resumeDraftId: lost.id, draftVersion: lost.draftVersion, coverage: { run: true } }, { quietModel: true }));

  const cut = await goldenLibrary(t);
  await settleJob(cut.service, (await cut.service.call('generate', { sourceIds: cut.ids, coverageLevel: 'standard', autoComplete: false, kind: 'quiz', performance: ONE_BY_ONE })).jobId);
  const half = await firstDraft(cut.service), spec = draftSpecWithSecondRunning(half);
  const stopped = await cut.service.call('draft.save', { deck: { ...half, editorial: { ...half.editorial, coverageSpec: spec, coverageRun: { ...half.editorial.coverageRun, state: 'running' } } }, requireExisting: true });
  pinned('run.afterStop', await cut.press('generate', continues(stopped, { coverage: { run: true } })));
});
function draftSpecWithSecondRunning(draft) {
  const { editorial: { coverageSpec: spec } } = draft;
  return { ...spec, rounds: spec.rounds.map((round, index) => index === 1 ? { ...round, status: 'running', startedAt: '2026-01-01T00:00:00.000Z' } : round) };
}

test('topping up a draft that has no plan: the rounds by themselves, the sections chosen, one material by hand', async t => {
  const lib = await goldenLibrary(t);
  await settleJob(lib.service, (await lib.service.call('generate', { sourceIds: lib.ids, ...PLAIN })).jobId);
  const draft = await firstDraft(lib.service), view = await lib.service.call('coverage.get', { draftId: draft.id });
  const manual = await goldenLibrary(t);
  await settleJob(manual.service, (await manual.service.call('generate', { sourceIds: manual.ids, ...PLAIN })).jobId);
  const again = await firstDraft(manual.service), picks = (await manual.service.call('coverage.get', { draftId: again.id })).round.picks.map(pick => pick.key);
  const chosen = await goldenLibrary(t);
  await settleJob(chosen.service, (await chosen.service.call('generate', { sourceIds: chosen.ids, ...PLAIN })).jobId);
  const third = await firstDraft(chosen.service), some = (await chosen.service.call('coverage.get', { draftId: third.id })).round.picks.map(pick => pick.key).slice(0, 2);
  pinned('topup.synthesized', await lib.press('generate', continues(draft, { coverage: {} })));
  pinned('topup.sectionsLeft', view.round.sections);
  pinned('topup.manual', await manual.press('generate', continues(again, { coverage: { sectionIds: picks.slice(0, 2), manual: true } })));
  pinned('topup.chosen', await chosen.press('generate', continues(third, { coverage: { sectionIds: some, tokenBudget: 200000 } })));
});

test('a plain draft cut short goes on by count; extra sources add to it', async t => {
  let failing = true, authors = 0;
  const inner = clusteringModel({ readsExisting: true }).complete;
  const lib = await goldenLibrary(t, { model: async (system, prompt, context) => {
    if (failing && system.startsWith('You author') && ++authors > 1) throw new Error('the model is unavailable');
    return inner(system, prompt, context);
  } });
  pinned('continue.first', await lib.press('generate', { sourceIds: lib.ids, kind: 'quiz', count: 8, performance: ONE_BY_ONE }));
  failing = false;
  const short = await firstDraft(lib.service);
  pinned('continue.count', await lib.press('generate', continues(short)));
  const more = await firstDraft(lib.service);
  pinned('extra.sources', await lib.press('generate', continues(more, { extraSourceIds: ['spare'], count: 2 })));
});

test('a draft of several kinds goes on with the kinds it still owes', async t => {
  let failing = true, authors = 0;
  const inner = createFakeModel();
  const lib = await goldenLibrary(t, { model: async (system, prompt, context) => {
    if (failing && system.startsWith('You author') && ++authors > 1) throw new Error('the model is unavailable');
    return inner(system, prompt, context);
  } });
  pinned('continue.kinds.first', await lib.press('generate', { sourceIds: lib.ids, kind: 'mixed', kinds: ['quiz', 'flashcard'], count: 8, performance: ONE_BY_ONE }));
  failing = false;
  pinned('continue.kinds', await lib.press('generate', continues(await firstDraft(lib.service))));
});

test('a part: a new draft for a published deck, and its next round', async t => {
  const lib = await goldenLibrary(t);
  await settleJob(lib.service, (await lib.service.call('generate', { sourceIds: lib.ids, ...PLAIN, count: 6 })).jobId);
  const draft = await firstDraft(lib.service), receipt = await lib.service.call('draft.publish.quick', { id: draft.id, draftVersion: draft.draftVersion });
  const { key } = await lib.service.call('coverage.get', { sourceId: lib.ids[0] });
  pinned('part.first', await lib.press('generate', { documentId: key, coverage: { autoComplete: false }, performance: ONE_BY_ONE, partOf: receipt.deckId }));
  const part = await firstDraft(lib.service);
  pinned('part.nextRound', await lib.press('generate', continues(part, { coverage: { run: true, autoComplete: false } })));
});

test('into a deck: merged, and a supplement that publishes itself', async t => {
  const lib = await goldenLibrary(t, { model: clusteringModel({ readsExisting: true }).complete });
  await settleJob(lib.service, (await lib.service.call('generate', { sourceIds: lib.ids, ...PLAIN })).jobId);
  const draft = await firstDraft(lib.service), { deckId: madeId } = await lib.service.call('draft.publish.quick', { id: draft.id, draftVersion: draft.draftVersion });
  // The frozen request of the draft names the deck: under a fixed id, its digest is the same every time.
  const deckId = 'target-deck';
  await lib.service.store.update(state => { state.decks.find(deck => deck.id === madeId).id = deckId; });
  pinned('merge.target', await lib.press('generate', { sourceIds: lib.ids, ...PLAIN, count: 2, mergeTargetId: deckId }));
  pinned('supplement', await lib.press('supplement', { sourceIds: lib.ids, deckId, ...PLAIN, count: 2 }));
});

test('a case paper: generated, followed from an earlier one, pasted with answers', async t => {
  const lib = await goldenLibrary(t, { model: createFakeModel(), seed: false });
  const a = await lib.service.call('source.add', { id: 'case-material', title: 'Architectural styles', text: CASE_TEXT, courses: ['Cloud'] });
  pinned('case.generated', await lib.press('generate', { kind: 'case', sourceIds: [a.id], questions: 2, totalMarks: 20, language: 'English', title: 'Harbour case', course: 'Cloud', performance: ONE_BY_ONE }));
  const earlier = await firstDraft(lib.service);
  pinned('case.fromDeck', await lib.press('generate', { kind: 'case', fromDeckId: earlier.id, title: 'Another case', performance: ONE_BY_ONE }));
  pinned('case.pasted', await lib.press('generate', { kind: 'case', sourceIds: [a.id], scenario: CASE_TEXT, questions: [{ prompt: 'What do the services own?', marks: 10 }], language: 'English', title: 'Pasted', course: 'Cloud', answers: ['Services own their data.'], performance: ONE_BY_ONE }));
});

test('a run that ends otherwise: a refused key, a failing round, a cancel', async t => {
  const refusal = Object.assign(new Error('Incorrect API key provided'), { status: 401 });
  const plain = await goldenLibrary(t, { model: async () => { throw refusal; } });
  pinned('end.plainRefused', await plain.press('generate', { sourceIds: plain.ids, ...PLAIN }));
  let wrote = 0;
  const inner = clusteringModel().complete;
  const authorThen = complete => async (system, prompt, context) => { if (system.startsWith('You author')) wrote += 1; return complete(system, prompt, context); };
  const run = await goldenLibrary(t, { model: authorThen(async (system, prompt, context) => {
    if (wrote > 0 && system.startsWith('Plan a source-grounded')) throw refusal;
    return inner(system, prompt, context);
  }) });
  pinned('end.runRefused', await run.press('generate', { sourceIds: run.ids, coverageLevel: 'standard', kind: 'quiz', performance: ONE_BY_ONE }));
  const never = await goldenLibrary(t, { model: async () => { throw new Error('the model is unavailable'); } });
  pinned('end.firstRoundFails', await never.press('generate', { sourceIds: never.ids, coverageLevel: 'standard', kind: 'quiz', performance: ONE_BY_ONE }));
  wrote = 0;
  let failedOnce = false;
  const flaky = await goldenLibrary(t, { model: authorThen(async (system, prompt, context) => {
    if (wrote > 0 && !failedOnce && system.startsWith('Plan a source-grounded')) { failedOnce = true; throw new Error('the model is unavailable'); }
    return inner(system, prompt, context);
  }) });
  pinned('end.roundFails', await flaky.press('generate', { sourceIds: flaky.ids, coverageLevel: 'standard', kind: 'quiz', performance: ONE_BY_ONE }));
  const held = await goldenLibrary(t);
  held.gate.armed = true;
  const { jobId } = await held.service.call('generate', { sourceIds: held.ids, coverageLevel: 'standard', kind: 'quiz', performance: ONE_BY_ONE });
  while (!held.gate.open) await new Promise(resolve => setImmediate(resolve));
  await held.service.call('job.control', { jobId, action: 'cancel' });
  held.gate.armed = false; held.gate.open();
  await settleJob(held.service, jobId);
  pinned('end.cancelledBeforeDraft', { card: await held.cardOf(jobId) });
  const line = await goldenLibrary(t);
  line.gate.armed = true;
  const front = await line.service.call('generate', { sourceIds: line.ids, kind: 'quiz', count: 2 }), behind = await line.service.call('generate', { sourceIds: line.ids, kind: 'quiz', count: 2 });
  while (!line.gate.open) await new Promise(resolve => setImmediate(resolve));
  await line.service.call('job.control', { jobId: behind.jobId, action: 'cancel' });
  line.gate.armed = false; line.gate.open();
  await settleJob(line.service, front.jobId);
  await settleJob(line.service, behind.jobId);
  pinned('end.cancelledInQueue', { card: await line.cardOf(behind.jobId) });
});

/* ---------- what it refuses, in both languages ---------- */

const CARD = (id, sourceId, quote) => ({ id, kind: 'flashcard', topic: 'T', objective: `Objective ${id}`, prompt: `Why ${id}?`, answer: 'Because.', hint: 'Think.', explanation: 'It says so.', misconception: 'None.', citations: [{ sourceId, quote }] });

for (const language of ['zh', 'en']) test(`what generate and supplement refuse (${language})`, async t => {
  const lib = await goldenLibrary(t, { language });
  const { service, ids, refused } = lib;
  const run = async args => { await settleJob(service, (await service.call('generate', args)).jobId); return (await service.call('export')).drafts.at(-1); };
  const plain = await run({ sourceIds: ids, ...PLAIN, count: 2, title: 'plain' });
  const published = await run({ sourceIds: ids, ...PLAIN, count: 2, title: 'to publish' });
  const { deckId } = await service.call('draft.publish.quick', { id: published.id, draftVersion: published.draftVersion });
  const waiting = await run({ sourceIds: ids, coverageLevel: 'standard', autoComplete: false, kind: 'quiz', performance: ONE_BY_ONE, title: 'waiting' });
  const closed = await run({ sourceIds: ids, coverageLevel: 'standard', kind: 'quiz', performance: ONE_BY_ONE, title: 'closed' });
  const quote = lib.world.sources[0].text.slice(0, 60);
  const alone = await service.call('source.add', { title: 'Alone', text: 'A material nobody has published a question of, long enough to be one section of a document.' });
  await service.store.update(state => {
    state.sources.push({ id: 'list', title: 'A list of exam points', text: '# Exam points', provenance: 'exam-blueprint', blueprint: { points: [] }, courses: [] },
      { id: 'blank', title: 'Blank', text: '   ' }, { id: 'huge', title: 'Huge', text: 'x'.repeat(3_000_000) });
    state.decks.push({ id: 'archived', title: 'Archived', course: '', cards: [], archived: true }, { id: 'system', title: 'System', course: '', cards: [], systemKind: 'mistakes' });
    const base = { title: 'x', course: '', cards: [CARD('c1', ids[0], quote)], draftVersion: 1 }, generation = { sourceIds: [ids[0]], kind: 'quiz' };
    state.drafts.push({ ...base, id: 'bare', editorial: {} }, { ...base, id: 'no-requested', editorial: { generation } }, { ...base, id: 'editing', editingDeckId: deckId, editorial: { generation, requested: 2 } },
      { ...base, id: 'gone-source', editorial: { generation: { sourceIds: [ids[0], 'gone'], kind: 'quiz' }, requested: 9 } }, { ...base, id: 'case-draft', editorial: { generation: { sourceIds: [ids[0]], kind: 'case' }, requested: 9 } },
      { ...base, id: 'full', editorial: { generation, requested: 1 } }, { ...base, id: 'bad-kind', editorial: { generation: { sourceIds: [ids[0]], kind: 'riddle' }, requested: 9 } },
      { ...base, id: 'merge-other', mergeTargetId: deckId, editorial: { generation, requested: 9 } });
  });
  const sections = (await service.call('coverage.get', { draftId: plain.id })).coverage.sections.filter(section => section.state !== 'covered').map(section => section.key);
  const covered = (await service.call('coverage.get', { draftId: closed.id })).coverage.sections.map(section => section.key);
  const { key: documentKey } = await service.call('coverage.get', { sourceId: ids[0] });
  const on = (draft, more = {}) => ({ resumeDraftId: draft.id, draftVersion: draft.draftVersion, ...more });
  const byId = id => ({ resumeDraftId: id, draftVersion: 1 });
  const TABLE = {
    'draft.missing': ['generate', { resumeDraftId: 'nope' }],
    'extra.noDraft': ['generate', { extraSourceIds: [ids[0]], count: 1 }],
    'extra.examList': ['generate', on(plain, { extraSourceIds: ['list'], count: 1 })],
    'extra.empty': ['generate', on(plain, { extraSourceIds: [], count: 1 })],
    'extra.notAList': ['generate', on(plain, { extraSourceIds: 'x', count: 1 })],
    'extra.unknown': ['generate', on(plain, { extraSourceIds: ['missing'], count: 1 })],
    'extra.noCount': ['generate', on(plain, { extraSourceIds: ['spare'] })],
    'extra.tooMany': ['generate', on(plain, { extraSourceIds: ['spare'], count: 31 })],
    'part.idNotAName': ['generate', { documentId: '  ', coverage: {} }],
    'part.idNotAString': ['generate', { documentId: 7, coverage: {} }],
    'part.withDraft': ['generate', on(plain, { documentId: documentKey, coverage: {} })],
    'part.withTarget': ['generate', { documentId: documentKey, coverage: {}, mergeTargetId: deckId }],
    'part.bySupplement': ['supplement', { deckId, documentId: documentKey, coverage: {} }],
    'part.noCoverage': ['generate', { documentId: documentKey }],
    'part.run': ['generate', { documentId: documentKey, coverage: { run: true } }],
    'part.partOf': ['generate', { documentId: documentKey, coverage: {}, partOf: '' }],
    'part.unknownDocument': ['generate', { documentId: 'no-such-document', coverage: {} }],
    'part.nothingPublished': ['generate', { documentId: (await service.call('coverage.get', { sourceId: alone.id })).key, coverage: {} }],
    'coverage.noDraft': ['generate', { sourceIds: ids, coverage: {} }],
    'coverage.withExtra': ['generate', on(plain, { extraSourceIds: ['spare'], count: 1, coverage: {} })],
    'coverage.notAnObject': ['generate', on(plain, { coverage: 'all' })],
    'coverage.aList': ['generate', on(plain, { coverage: [] })],
    'coverage.unknownKey': ['generate', on(plain, { coverage: { sections: [] } })],
    'coverage.sectionsNotAList': ['generate', on(plain, { coverage: { sectionIds: 'a' } })],
    'coverage.sectionsNotStrings': ['generate', on(plain, { coverage: { sectionIds: [1] } })],
    'coverage.runNotBoolean': ['generate', on(plain, { coverage: { run: 'yes' } })],
    'coverage.autoNotBoolean': ['generate', on(plain, { coverage: { autoComplete: 1 } })],
    'coverage.manualNotBoolean': ['generate', on(plain, { coverage: { manual: 1, sectionIds: [] } })],
    'coverage.manualNoSections': ['generate', on(plain, { coverage: { manual: true } })],
    'coverage.budgetLow': ['generate', on(plain, { coverage: { tokenBudget: 999 } })],
    'run.withSections': ['generate', on(waiting, { coverage: { run: true, sectionIds: [] } })],
    'run.noPlan': ['generate', on(plain, { coverage: { run: true } })],
    'run.complete': ['generate', on(closed, { coverage: { run: true } })],
    'continue.noRecord': ['generate', byId('bare')],
    'continue.noRequested': ['generate', byId('no-requested')],
    'continue.editing': ['generate', byId('editing')],
    'continue.stale': ['generate', { resumeDraftId: plain.id, draftVersion: plain.draftVersion + 5 }],
    'continue.noVersion': ['generate', { resumeDraftId: plain.id }],
    'continue.nothingLeft': ['generate', byId('full')],
    'continue.sourceGone': ['generate', byId('gone-source')],
    'continue.case': ['generate', byId('case-draft')],
    'continue.unknownKind': ['generate', byId('bad-kind')],
    'level.unknown': ['generate', { sourceIds: ids, coverageLevel: 'huge' }],
    'goal.notWhole': ['generate', { sourceIds: ids, coverageLevel: 'lean', count: 1.5 }],
    'goal.tooMany': ['generate', { sourceIds: ids, coverageLevel: 'lean', count: 100000 }],
    'goal.autoNotBoolean': ['generate', { sourceIds: ids, coverageLevel: 'lean', autoComplete: 'yes' }],
    'goal.budgetLow': ['generate', { sourceIds: ids, coverageLevel: 'lean', tokenBudget: 10 }],
    'goal.noText': ['generate', { sourceIds: ['blank'], coverageLevel: 'lean' }],
    'target.missing': ['generate', { sourceIds: ids, count: 1, mergeTargetId: 'nope' }],
    'target.archived': ['generate', { sourceIds: ids, count: 1, mergeTargetId: 'archived' }],
    'target.system': ['generate', { sourceIds: ids, count: 1, mergeTargetId: 'system' }],
    'target.case': ['generate', { sourceIds: ids, kind: 'case', mergeTargetId: deckId }],
    'supplement.noDeck': ['supplement', { sourceIds: ids, count: 1 }],
    'supplement.blankDeck': ['supplement', { deckId: '  ', sourceIds: ids, count: 1 }],
    'supplement.conflict': ['supplement', { deckId, mergeTargetId: 'other', sourceIds: ids, count: 1 }],
    'supplement.otherTarget': ['supplement', { deckId: 'archived', ...byId('merge-other') }],
    'round.alreadyCovered': ['generate', on(closed, { coverage: { sectionIds: [covered[0]] } })],
    'round.tooMany': ['generate', on(plain, { coverage: { sectionIds: sections, autoComplete: false } })],
    'round.notFound': ['generate', on(plain, { coverage: { sectionIds: ['nope'] } })],
    'round.allCovered': ['generate', on(closed, { coverage: {} })],
    'kind.unknown': ['generate', { sourceIds: ids, kind: 'riddle', count: 1 }],
    'case.noEarlier': ['generate', { kind: 'case', fromDeckId: 'nope' }],
    'case.notACase': ['generate', { kind: 'case', fromDeckId: deckId }],
    'case.questions': ['generate', { kind: 'case', sourceIds: ids, questions: 99 }],
    'constraints.notAnObject': ['generate', { sourceIds: ids, count: 1, constraints: 'none' }],
    'constraints.unknown': ['generate', { sourceIds: ids, count: 1, constraints: { other: true } }],
    'constraints.notBoolean': ['generate', { sourceIds: ids, count: 1, constraints: { topicNoAnswer: 1 } }],
    'count.tooMany': ['supplement', { deckId, sourceIds: ids, count: 31 }],
    'count.none': ['generate', { sourceIds: ids, count: 0 }],
    'count.notANumber': ['generate', { sourceIds: ids, count: 'many' }],
    'materials.examList': ['generate', { sourceIds: ['list'], count: 1 }],
    'materials.none': ['generate', { sourceIds: [], count: 1 }],
    'materials.notAList': ['generate', { count: 1 }],
    'materials.tooLarge': ['generate', { sourceIds: ['huge'], count: 1 }],
    'materials.tooLargeForACase': ['generate', { kind: 'case', sourceIds: ['huge'] }],
    'references.badLimits': ['generate', { sourceIds: ids, count: 1, referenceLimits: { pages: 1 } }],
  };
  for (const [name, [action, args]] of Object.entries(TABLE)) pinned(`refused.${language}.${name}`, await refused(action, args));
  const dark = await goldenLibrary(t, { language });
  dark.service.complete = undefined;
  pinned(`refused.${language}.noModel`, await dark.refused('generate', { sourceIds: dark.ids, count: 1 }));
});

test('what it refuses while another run holds the draft or the document, in both languages', async t => {
  for (const language of ['zh', 'en']) {
    const lib = await goldenLibrary(t, { language });
    const draft = await (async () => { await settleJob(lib.service, (await lib.service.call('generate', { sourceIds: lib.ids, ...PLAIN, count: 6 })).jobId); return firstDraft(lib.service); })();
    lib.gate.armed = true;
    const { jobId } = await lib.service.call('generate', { resumeDraftId: draft.id, draftVersion: draft.draftVersion, coverage: { autoComplete: false } });
    while (!lib.gate.open) await new Promise(resolve => setImmediate(resolve));
    const busy = (await lib.service.call('export')).drafts[0];
    pinned(`refused.${language}.busyDraft`, await lib.refused('generate', { resumeDraftId: busy.id, draftVersion: busy.draftVersion }));
    lib.gate.armed = false; lib.gate.open();
    await settleJob(lib.service, jobId);

    const two = await goldenLibrary(t, { language });
    const make = async () => { const { jobId: made } = await two.service.call('generate', { sourceIds: two.ids, ...PLAIN, count: 2 }); await settleJob(two.service, made); const [own] = (await two.service.call('export')).drafts; return two.service.call('draft.publish.quick', { id: own.id, draftVersion: own.draftVersion }); };
    const { deckId: oneDeck } = await make(), { deckId: otherDeck } = await make();
    const { key } = await two.service.call('coverage.get', { sourceId: two.ids[0] });
    pinned(`refused.${language}.severalDecks`, await two.refused('generate', { documentId: key, coverage: {} }));
    two.gate.armed = true;
    const held = await two.service.call('generate', { documentId: key, partOf: oneDeck, coverage: { autoComplete: false } });
    while (!two.gate.open) await new Promise(resolve => setImmediate(resolve));
    pinned(`refused.${language}.busyDocument`, await two.refused('generate', { documentId: key, partOf: otherDeck, coverage: {} }));
    two.gate.armed = false; two.gate.open();
    await settleJob(two.service, held.jobId);
    // A later round of that part is waiting: what is left of the document is in that draft.
    const left = await two.service.call('coverage.get', { sourceId: two.ids[0] });
    pinned(`refused.${language}.inFlight`, { topUp: left.topUp?.canTopUp ?? null, reply: await two.refused('generate', { documentId: key, partOf: otherDeck, coverage: {} }) });
  }
});
