import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StudyService } from '../lib/service.js';
import { BASIC_KINDS, GENERATION_SETTINGS_DEFAULTS, kindsOfLegacyKind, legacyKindOf, mergeGenerationSettings, normalizeGenerationSettings,
  requestKinds, resolveGenerationRequest, splitCount, validateGenerationPatch } from '../lib/generation-settings.js';
import { generateBatched, planGeneration } from '../lib/batch.js';
import { continuationKindCounts } from '../lib/draft-continuation.js';
import { inputRefOf } from '../lib/contexts/generation/jobs/input-ref.js';
import { estimateRun } from '../lib/token-estimate.js';
import { qualityPlan, qualityBlueprint, authored, qualityReview } from './helpers/assessment.mjs';

/* 默认题型 is a combination (decision 2026-10-07): `kinds` is the ordered list of 1..5 basic kinds; the legacy `kind` stays beside it (one kind, or 'mixed' for exactly quiz + flashcard,
   else the first kind) so a library rolled back to 2.7.1 / 3.0.0 and assistants that send `kind` keep working. */

const source = { id: 's1', title: 'Notes', text: 'Architecture connects business goals to technical decisions through principles.\n'.repeat(40) };

test('the five basic kinds, and how a legacy kind reads as a list and a list as a legacy kind', () => {
  assert.deepEqual([...BASIC_KINDS], ['quiz', 'multi', 'flashcard', 'open', 'cloze']);
  assert.deepEqual(kindsOfLegacyKind('mixed'), ['quiz', 'flashcard']);
  assert.deepEqual(kindsOfLegacyKind('cloze'), ['cloze']);
  assert.equal(kindsOfLegacyKind('case'), null);
  assert.equal(kindsOfLegacyKind('klingon'), null);
  assert.equal(legacyKindOf(['multi']), 'multi');
  assert.equal(legacyKindOf(['quiz', 'flashcard']), 'mixed');
  assert.equal(legacyKindOf(['flashcard', 'quiz']), 'mixed', 'exactly quiz + flashcard, whichever order, is what the old "mixed" said');
  assert.equal(legacyKindOf(['cloze', 'quiz', 'open']), 'cloze', 'any other combination: the first kind, so an older version still writes a valid single-kind draft');
  assert.equal(legacyKindOf(['quiz', 'flashcard', 'open']), 'quiz');
});

test('saved settings: defaults, legacy-only libraries, new libraries, disagreeing and corrupt fields', () => {
  assert.deepEqual(GENERATION_SETTINGS_DEFAULTS.kinds, ['quiz']);
  const fresh = normalizeGenerationSettings();
  assert.deepEqual([fresh.kind, fresh.kinds], ['quiz', ['quiz']]);
  fresh.kinds.push('open');
  assert.deepEqual(normalizeGenerationSettings().kinds, ['quiz'], 'the defaults are never shared');
  // An old library has only `kind`.
  assert.deepEqual(pair(normalizeGenerationSettings({ kind: 'mixed' })), ['mixed', ['quiz', 'flashcard']]);
  assert.deepEqual(pair(normalizeGenerationSettings({ kind: 'multi' })), ['multi', ['multi']]);
  // A new library has both; the order is kept.
  assert.deepEqual(pair(normalizeGenerationSettings({ kind: 'cloze', kinds: ['cloze', 'quiz', 'open'] })), ['cloze', ['cloze', 'quiz', 'open']]);
  assert.deepEqual(pair(normalizeGenerationSettings({ kinds: ['flashcard', 'quiz'] })), ['mixed', ['flashcard', 'quiz']]);
  // They disagree: kinds wins.
  assert.deepEqual(pair(normalizeGenerationSettings({ kind: 'mixed', kinds: ['open'] })), ['open', ['open']]);
  assert.deepEqual(pair(normalizeGenerationSettings({ kind: 'cloze', kinds: ['quiz', 'multi'] })), ['quiz', ['quiz', 'multi']]);
  // Corrupt values fall back without dropping what is valid; duplicates go.
  assert.deepEqual(pair(normalizeGenerationSettings({ kind: 'multi', kinds: 'quiz' })), ['multi', ['multi']]);
  assert.deepEqual(pair(normalizeGenerationSettings({ kind: 'multi', kinds: [] })), ['multi', ['multi']]);
  assert.deepEqual(pair(normalizeGenerationSettings({ kinds: [] })), ['quiz', ['quiz']]);
  assert.deepEqual(pair(normalizeGenerationSettings({ kinds: ['quiz', 'bogus', 'open', 'quiz', 7, 'mixed'] })), ['quiz', ['quiz', 'open']]);
  assert.deepEqual(pair(normalizeGenerationSettings({ kind: 'bogus', kinds: null })), ['quiz', ['quiz']]);
  const siblings = normalizeGenerationSettings({ kinds: 'nope', language: 'English', batchSize: 2, count: '20' });
  assert.deepEqual([siblings.language, siblings.batchSize, siblings.count, siblings.kinds], ['English', 2, 10, ['quiz']]);
});
const pair = settings => [settings.kind, settings.kinds];

test('patches: an explicit bad list is refused, a kind-only patch (old assistants) sets the list, kinds win over kind', () => {
  for (const kinds of [[], 'quiz', null, ['mixed'], ['case'], ['quiz', 'nope'], [1], {}]) assert.throws(() => validateGenerationPatch({ kinds }), /Invalid generation setting: kinds/);
  assert.deepEqual(validateGenerationPatch({ kinds: ['quiz', 'open', 'quiz'] }), { kinds: ['quiz', 'open'] }, 'duplicates are removed');
  const saved = { ...GENERATION_SETTINGS_DEFAULTS, kind: 'quiz', kinds: ['quiz', 'cloze'], language: 'English' };
  assert.deepEqual(pair(mergeGenerationSettings(saved, { kind: 'multi' })), ['multi', ['multi']], 'kind only behaves as today');
  assert.deepEqual(pair(mergeGenerationSettings(saved, { kind: 'mixed' })), ['mixed', ['quiz', 'flashcard']]);
  assert.deepEqual(pair(mergeGenerationSettings(saved, { kinds: ['open', 'quiz'] })), ['open', ['open', 'quiz']]);
  assert.deepEqual(pair(mergeGenerationSettings(saved, { kind: 'multi', kinds: ['cloze', 'open'] })), ['cloze', ['cloze', 'open']], 'kinds wins');
  assert.deepEqual(pair(mergeGenerationSettings(saved, { count: 12 })), ['quiz', ['quiz', 'cloze']], 'an unrelated patch leaves the combination alone');
  assert.equal(mergeGenerationSettings(saved, { count: 12 }).language, 'English');
  assert.throws(() => validateGenerationPatch({ kind: 'case' }), /Invalid generation setting: kind/);
});

test('resolving a request: saved combination, kind-only caller, explicit kinds, continuation keeps its own', () => {
  const saved = { ...GENERATION_SETTINGS_DEFAULTS, kind: 'quiz', kinds: ['quiz', 'cloze', 'open'] };
  const fromSaved = resolveGenerationRequest(saved);
  assert.deepEqual(pair(fromSaved), ['quiz', ['quiz', 'cloze', 'open']]);
  assert.deepEqual(pair(resolveGenerationRequest(saved, { kind: 'multi' })), ['multi', ['multi']], 'a caller that gives kind only gets that kind, as today');
  assert.deepEqual(pair(resolveGenerationRequest(saved, { kind: 'mixed' })), ['mixed', ['quiz', 'flashcard']]);
  assert.deepEqual(pair(resolveGenerationRequest(saved, { kinds: ['flashcard', 'cloze'] })), ['flashcard', ['flashcard', 'cloze']]);
  assert.deepEqual(pair(resolveGenerationRequest(saved, { kind: 'multi', kinds: ['open', 'quiz'] })), ['open', ['open', 'quiz']], 'kinds wins');
  assert.deepEqual(pair(resolveGenerationRequest(saved, { kinds: ['quiz', 'flashcard', 'quiz'] })), ['mixed', ['quiz', 'flashcard']]);
  assert.ok(!('kinds' in resolveGenerationRequest(saved, { kind: 'case' })), 'a case paper has no list');
  for (const kinds of [[], 'quiz', ['mixed'], ['nope']]) assert.throws(() => resolveGenerationRequest(saved, { kinds }), /Unknown question kind/);
  // A continued draft never takes today's changed defaults, kinds included.
  const today = { ...GENERATION_SETTINGS_DEFAULTS, kind: 'open', kinds: ['open'] };
  assert.deepEqual(pair(resolveGenerationRequest(today, {}, { continuation: { kind: 'quiz', kinds: ['quiz', 'cloze', 'open'] } })), ['quiz', ['quiz', 'cloze', 'open']]);
  assert.deepEqual(pair(resolveGenerationRequest(today, {}, { continuation: { kind: 'mixed' } })), ['mixed', ['quiz', 'flashcard']], 'an old draft only has kind');
  assert.deepEqual(pair(resolveGenerationRequest(today, {}, { continuation: { kind: 'multi' } })), ['multi', ['multi']]);
  assert.deepEqual(pair(resolveGenerationRequest(today, {}, { continuation: {} })), ['quiz', ['quiz']]);
});

test('the split: as even as possible, the remainder to the first kinds in the chosen order', () => {
  assert.deepEqual(splitCount(['quiz', 'cloze', 'open'], 10), [['quiz', 4], ['cloze', 3], ['open', 3]]);
  assert.deepEqual(splitCount(['open', 'quiz', 'cloze'], 11), [['open', 4], ['quiz', 4], ['cloze', 3]]);
  assert.deepEqual(splitCount(['quiz', 'flashcard'], 7), [['quiz', 4], ['flashcard', 3]], 'exactly what mixed always did: the odd one a quiz');
  assert.deepEqual(splitCount(['quiz', 'flashcard'], 1), [['quiz', 1], ['flashcard', 0]]);
  assert.deepEqual(splitCount(['multi'], 9), [['multi', 9]]);
  assert.deepEqual(splitCount(['quiz', 'multi', 'flashcard'], 2), [['quiz', 1], ['multi', 1], ['flashcard', 0]], 'fewer questions than kinds: one each for the first kinds, the others are left out');
  assert.deepEqual(splitCount(['quiz', 'multi'], 0), [['quiz', 0], ['multi', 0]]);
  assert.deepEqual(requestKinds({ kind: 'mixed' }), ['quiz', 'flashcard']);
  assert.deepEqual(requestKinds({ kind: 'cloze' }), ['cloze']);
  assert.deepEqual(requestKinds({}), ['quiz']);
  assert.deepEqual(requestKinds({ kind: 'quiz', kinds: ['open', 'cloze'] }), ['open', 'cloze']);
});

const totals = parts => parts.reduce((map, part) => map.set(part.kind, (map.get(part.kind) || 0) + part.count), new Map());

test('planning: several kinds share the count by the same rule mixed used, each kind in parts of its own', () => {
  const performance = { batchSize: 5 };
  const plan = planGeneration({ sources: [source], count: 10, kind: 'quiz', kinds: ['quiz', 'cloze', 'open'], performance });
  assert.deepEqual([...totals(plan)], [['quiz', 4], ['cloze', 3], ['open', 3]]);
  assert.deepEqual(plan.map(part => [part.kind, part.count]), [['quiz', 4], ['cloze', 3], ['open', 3]]);
  const legacy = planGeneration({ sources: [source], count: 13, kind: 'mixed', performance });
  assert.deepEqual(planGeneration({ sources: [source], count: 13, kind: 'mixed', kinds: ['quiz', 'flashcard'], performance }), legacy, 'kinds beside mixed plan exactly what mixed planned');
  assert.deepEqual(planGeneration({ sources: [source], count: 8, kind: 'multi', kinds: ['multi'], performance }), planGeneration({ sources: [source], count: 8, kind: 'multi', performance }));
  assert.deepEqual(planGeneration({ sources: [source], count: 6, kind: 'quiz', performance }).map(part => part.kind), ['quiz', 'quiz']);
  // Fewer questions than kinds: the first kinds get one, the rest no part at all.
  assert.deepEqual(planGeneration({ sources: [source], count: 2, kinds: ['quiz', 'multi', 'cloze'], kind: 'quiz', performance }).map(part => [part.kind, part.count]), [['quiz', 1], ['multi', 1]]);
  // The counts of a continuation are per kind.
  const counts = planGeneration({ sources: [source], count: 7, kinds: ['quiz', 'open', 'cloze'], kind: 'quiz', kindCounts: { quiz: 1, open: 5, cloze: 1 }, performance: { batchSize: 2 } });
  assert.deepEqual([...totals(counts)], [['quiz', 1], ['open', 5], ['cloze', 1]]);
  assert.ok(counts.every(part => part.count <= 2));
  for (const kindCounts of [{ quiz: 1, open: 1, cloze: 1 }, { quiz: 3, open: 3, cloze: -1 }, { quiz: 2.5, open: 2.5, cloze: 2 }, { quiz: 3, open: 2, cloze: 1, multi: 1 }, { quiz: 4, open: 3 }])
    assert.throws(() => planGeneration({ sources: [source], count: 7, kinds: ['quiz', 'open', 'cloze'], kind: 'quiz', kindCounts, performance }), /Invalid mixed question counts/);
  assert.throws(() => planGeneration({ sources: [source], count: 7, kind: 'quiz', kindCounts: { quiz: 7 }, performance }), /Invalid mixed question counts/, 'counts per kind are only for several kinds');
  // Questions to write again alternate over the chosen kinds.
  const reuse = [0, 1, 2].map(i => ({ sources: [source], targets: [{ objective: `again ${i}` }] }));
  assert.deepEqual(planGeneration({ sources: [source], count: 0, kinds: ['open', 'cloze'], kind: 'open', reuse, performance }).filter(part => part.preplan).map(part => part.kind), ['open', 'cloze', 'open']);
});

test('the continuation of a draft with several kinds restores the split it was asked for', () => {
  const card = kind => ({ kind });
  const draft = { cards: [card('quiz'), card('quiz'), card('quiz'), card('cloze'), card('cloze'), card('open')],
    editorial: { requested: 10, generation: { kind: 'quiz', kinds: ['quiz', 'cloze', 'open'] } } };
  assert.deepEqual(continuationKindCounts(draft), { quiz: 1, cloze: 1, open: 2 });
  const single = { cards: [card('quiz')], editorial: { requested: 4, generation: { kind: 'quiz' } } };
  assert.equal(continuationKindCounts(single), undefined);
  const legacy = { cards: [card('quiz'), card('quiz'), card('quiz'), card('flashcard')], editorial: { requested: 7, generation: { kind: 'mixed' } } };
  assert.deepEqual(continuationKindCounts(legacy), { quiz: 1, flashcard: 2 }, 'an old mixed draft: ceil / floor as before');
  const lopsided = { cards: [card('open'), card('open'), card('open'), card('open')], editorial: { requested: 10, generation: { kind: 'quiz', kinds: ['quiz', 'cloze', 'open'] } } };
  assert.equal(continuationKindCounts(lopsided), undefined, 'when the missing questions cannot restore the split, no split is forced');
});

test('the input reference of a run ignores a one-kind list, so old checkpoints still fit, and tells several kinds apart', () => {
  const base = { count: 10, language: '中文', performance: { batchSize: 5 } }, sources = [source];
  const ref = request => inputRefOf({ definition: 'generation@1', request, sources }).hash;
  assert.equal(ref({ ...base, kind: 'quiz' }), ref({ ...base, kind: 'quiz', kinds: ['quiz'] }));
  assert.equal(ref({ ...base, kind: 'mixed' }), ref({ ...base, kind: 'mixed', kinds: ['quiz', 'flashcard'] }), 'an old mixed checkpoint still fits');
  assert.notEqual(ref({ ...base, kind: 'quiz', kinds: ['quiz', 'cloze'] }), ref({ ...base, kind: 'quiz', kinds: ['quiz', 'open'] }));
  assert.notEqual(ref({ ...base, kind: 'quiz', kinds: ['quiz', 'cloze'] }), ref({ ...base, kind: 'quiz' }));
});

test('the estimate prices several kinds like a run: one call group, parts per kind', () => {
  const inputs = { sources: [source], count: 10, difficulty: 'mixed', language: 'English', performance: { batchSize: 5 } };
  const mixed = estimateRun('generate', { ...inputs, kind: 'mixed' }), same = estimateRun('generate', { ...inputs, kind: 'mixed', kinds: ['quiz', 'flashcard'] });
  assert.deepEqual(same, mixed, 'kinds beside mixed are priced exactly as mixed was');
  const several = estimateRun('generate', { ...inputs, kind: 'quiz', kinds: ['quiz', 'cloze', 'open'] }), one = estimateRun('generate', { ...inputs, kind: 'quiz' });
  assert.ok(several.calls.high > one.calls.high, 'three kinds are three parts (4 + 3 + 3) where one kind is two (5 + 5)');
  assert.ok(several.totalTokens.high > 0 && several.totalTokens.low > 0 && several.calls.high > 0, 'the estimate is not empty');
  assert.equal(several.stages.filter(stage => stage.id === 'plan').length, 1);
});

/* A model that writes the card of whatever kind the part asks for, through the same stages as the real run. */
const cardOf = (kind, target, index) => ({ id: `${kind}-${index + 1}`, targetId: target.targetId, kind, topic: `Topic ${kind} ${index}`, objective: target.objective,
  prompt: kind === 'cloze' ? `Architecture connects business goals to {{b1}} decisions, as ${target.objective} asks.` : `Explain the supported distinction for ${target.objective}`,
  answer: 'Principles connect goals to decisions', hint: 'Think about stakeholders', explanation: 'Design choices must serve business goals', misconception: 'Choosing technology first',
  citations: target.citations,
  ...(kind === 'quiz' || kind === 'multi' ? { options: ['a', 'b', 'c'].map(id => ({ id, text: `${id} option ${index}`, correct: kind === 'multi' ? id !== 'c' : id === 'a', explanation: `Reason ${id} for ${index}` })) } : {}),
  ...(kind === 'open' ? { rubric: 'Full credit for linking business goals to technical decisions; half for naming only one side.' } : {}),
  ...(kind === 'cloze' ? { cloze: { text: `Architecture connects business goals to {{b1}} decisions, as ${target.objective} asks.`, answers: [{ id: 'b1', value: 'technical' }] } } : {}) });
function kindModel() {
  const asked = [];
  return { asked, complete: async (system, prompt) => {
    const stage = system.startsWith('Plan ') ? 'planning' : system.startsWith('Prepare supported') ? 'blueprinting' : system.startsWith('You author') ? 'authoring' : 'reviewing';
    const request = JSON.parse(stage === 'reviewing' ? prompt : prompt.split('REQUEST DATA:\n')[1]);
    if (stage === 'planning') { asked.push(['planning', request.kind, request.count]); return JSON.stringify(qualityPlan(request)); }
    if (stage === 'reviewing') return JSON.stringify(qualityReview(request.candidate));
    const plan = request.assessmentPlan;
    const deck = { title: 'Kinds fixture', cards: plan.targets.map((target, index) => cardOf(request.kind, target, index)) };
    if (stage === 'blueprinting') { asked.push(['blueprinting', request.kind, plan.targets.length]); return JSON.stringify(qualityBlueprint(request, plan, deck)); }
    return JSON.stringify(authored(deck, [], plan));
  } };
}

test('a run of several kinds writes each chosen kind with its own authoring, in one draft that remembers the combination', async () => {
  const model = kindModel();
  const result = await generateBatched(model.complete, { sources: [source], count: 10, kind: 'quiz', kinds: ['quiz', 'cloze', 'open'], title: 'Kinds', performance: { concurrency: 2, batchSize: 5, fillRounds: 0 } });
  const count = kind => result.cards.filter(card => card.kind === kind).length;
  assert.deepEqual([count('quiz'), count('cloze'), count('open')], [4, 3, 3]);
  assert.equal(result.cards.length, 10);
  assert.equal(result.editorial.requested, 10);
  assert.deepEqual(result.editorial.generation.kinds, ['quiz', 'cloze', 'open']);
  assert.equal(result.editorial.generation.kind, 'quiz');
  assert.deepEqual(model.asked.filter(([stage]) => stage === 'blueprinting').map(([, kind]) => kind).sort(), ['cloze', 'open', 'quiz']);
  assert.ok(result.cards.filter(card => card.kind === 'cloze').every(card => card.cloze?.answers?.length), 'a cloze card keeps what only a cloze card has');
  assert.ok(result.cards.filter(card => card.kind === 'open').every(card => card.rubric), 'an open card keeps its rubric');
});

test('a run of all five kinds, and a run of a single kind that is written exactly as before', async () => {
  const all = await generateBatched(kindModel().complete, { sources: [source], count: 10, kind: 'quiz', kinds: [...BASIC_KINDS], performance: { concurrency: 2, batchSize: 5, fillRounds: 0 } });
  for (const kind of BASIC_KINDS) assert.equal(all.cards.filter(card => card.kind === kind).length, 2, kind);
  const single = await generateBatched(kindModel().complete, { sources: [source], count: 3, kind: 'multi', performance: { concurrency: 2, batchSize: 5, fillRounds: 0 } });
  assert.deepEqual(single.cards.map(card => card.kind), ['multi', 'multi', 'multi']);
  assert.equal(single.editorial.generation.kind, 'multi');
  assert.ok(!('kinds' in single.editorial.generation), 'a draft of one kind is saved as it always was');
  const mixed = await generateBatched(kindModel().complete, { sources: [source], count: 3, kind: 'mixed', performance: { concurrency: 2, batchSize: 5, fillRounds: 0 } });
  assert.deepEqual(mixed.cards.map(card => card.kind).sort(), ['flashcard', 'quiz', 'quiz']);
  assert.equal(mixed.editorial.generation.kind, 'mixed');
});

test('fewer questions than kinds: the first kinds get one question each and the other kinds are left out, not asked for', async () => {
  const model = kindModel();
  const result = await generateBatched(model.complete, { sources: [source], count: 2, kind: 'cloze', kinds: ['cloze', 'open', 'quiz'], performance: { concurrency: 2, batchSize: 5, fillRounds: 0 } });
  assert.deepEqual(result.cards.map(card => card.kind).sort(), ['cloze', 'open']);
  assert.equal(result.editorial.requested, 2);
  assert.equal(model.asked.some(([stage, kind]) => stage === 'blueprinting' && kind === 'quiz'), false);
});

async function library(t) {
  const root = await mkdtemp(join(tmpdir(), 'study-kinds-'));
  const service = new StudyService(root);
  t.after(async () => { service.dispose(); await rm(root, { recursive: true, force: true }); });
  return service;
}
// What 3.0.0 / 2.7.1 does with a stored library: its own normalizeGenerationSettings over the keys it knows, `kind` among them (the six values below).
const OLD_KINDS = ['quiz', 'multi', 'flashcard', 'open', 'cloze', 'mixed'];
const readByOldCode = generation => ({ kind: OLD_KINDS.includes(generation.kind) ? generation.kind : 'quiz' });

test('a library saved with a combination still reads in an older version: kind is a valid single kind or mixed, and an old library reads in the new one', async t => {
  const service = await library(t);
  const cases = [[['quiz', 'flashcard'], 'mixed'], [['flashcard', 'quiz'], 'mixed'], [['cloze', 'open', 'quiz'], 'cloze'], [['multi'], 'multi'], [['open', 'quiz'], 'open']];
  for (const [kinds, kind] of cases) {
    const saved = await service.call('settings', { generation: { kinds } });
    assert.deepEqual([saved.generation.kind, saved.generation.kinds], [kind, kinds]);
    const stored = (await service.call('export')).settings.generation;
    assert.deepEqual([stored.kind, stored.kinds], [kind, kinds], 'both fields are written');
    assert.equal(readByOldCode(stored).kind, kind, 'the older version keeps the kind that is in the library');
    assert.ok(OLD_KINDS.includes(stored.kind));
  }
  // An assistant of an older version sends kind only.
  const old = await service.call('settings', { generation: { kind: 'mixed' } });
  assert.deepEqual([old.generation.kind, old.generation.kinds], ['mixed', ['quiz', 'flashcard']]);
  // A backup written by the old version has no list at all.
  const backup = await service.call('export');
  backup.settings.generation = { kind: 'flashcard', language: 'English' };
  await service.call('restore', { state: backup });
  const snap = (await service.call('snapshot')).settings.generation;
  assert.deepEqual([snap.kind, snap.kinds, snap.language], ['flashcard', ['flashcard'], 'English']);
  await assert.rejects(service.call('settings', { generation: { kinds: [] } }), /generation/i);
  await assert.rejects(service.call('settings', { generation: { kinds: ['mixed'] } }), /generation/i);
});

test('the generate action takes kinds, falls back on kind, and refuses an unknown list', async t => {
  const service = await library(t);
  await service.call('source.add', { id: 'src', title: 'Notes', text: source.text });
  const model = kindModel();
  service.complete = model.complete;
  const started = await service.call('generate', { sourceIds: ['src'], count: 4, kinds: ['flashcard', 'open'] });
  assert.equal((await service.call('job.wait', { jobId: started.jobId })).status, 'complete');
  const draft = (await service.call('snapshot')).drafts.find(item => item.cards.length);
  assert.deepEqual(draft.cards.map(card => card.kind).sort(), ['flashcard', 'flashcard', 'open', 'open']);
  assert.deepEqual(draft.editorial.generation.kinds, ['flashcard', 'open']);
  assert.equal(draft.editorial.generation.kind, 'flashcard');
  await assert.rejects(service.call('generate', { sourceIds: ['src'], count: 2, kinds: ['flashcard', 'nope'] }), /Unknown question kind/);
  await assert.rejects(service.call('generate', { sourceIds: ['src'], count: 2, kinds: [] }), /Unknown question kind/);
});
