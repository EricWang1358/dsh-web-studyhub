import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StudyService } from '../lib/service.js';
import { createModelGateway } from '../lib/jobs/gateway.js';
import { gatewayModels } from '../lib/contexts/generation/jobs/gateway-model.js';
import { resumeArgs } from '../lib/contexts/generation/jobs/resume-args.js';
import { planPrompts, blueprintPrompts } from '../lib/assessment-quality.js';
import { authorPrompts, reviewPrompts } from '../lib/generation.js';
import { GENERATION_STAGE_TEXT } from '../lib/contexts/jobs/contracts.js';
import { GENERATION_SYSTEM, LEAD_SOURCE_CHARS, REQUEST_DATA, stageSystem } from '../lib/prompt-order.js';
import { withEffortPreference } from '../lib/reasoning-effort.js';
import { goldenRuntimeContracts } from './fixtures/unified-runtime-contract.mjs';
import { qualityPlan, qualityBlueprint, qualityReview, authored } from './helpers/assessment.mjs';
import { gate, soon } from './helpers/generation-baseline.mjs';
import { mergedTranscript } from './helpers/merged-transcript.mjs';
import { requestData } from './helpers/request-data.mjs';
import { SWITCH_MODES, managedRuntimeOptions } from './helpers/runtime-switch.mjs';
import { ONE_BY_ONE } from './helpers/supplement-fixtures.mjs';
import { settleJob } from './helpers/wait.mjs';

const STRONG = { provider: 'preview', model: 'strong-model' };
const FAST = { provider: 'preview', model: 'fast-model' };

const bigText = size => Array.from({ length: Math.ceil(size / 96) }, (_, i) =>
  `Paragraph ${i}: distributed consensus requires quorum intersection under condition ${i % 5} so conflicting commits cannot both seal.`).join(' ').slice(0, size);

const commonPrefix = (left, right) => {
  const limit = Math.min(left.length, right.length);
  let at = 0;
  while (at < limit && left[at] === right[at]) at++;
  return at;
};

test('gatewayModels applies stageRequest on unified-runtime direct and subagent paths so Plan, Blueprint, Author and Review share the sources-first prefix', async () => {
  const sources = [{ id: 'lecture-1', title: 'Consensus Notes', text: bigText(LEAD_SOURCE_CHARS + 3200) }];
  const target = { targetId: 'target-1', objective: 'Explain quorum intersection', knowledge: 'Quorums intersect.',
    citations: [{ sourceId: 'lecture-1', quote: sources[0].text.slice(0, 48) }] };
  const plan = { targets: [target] };
  const blueprint = { items: [{ targetId: 'target-1', answer: 'Quorum overlap.', reasoning: 'Any two quorums share a node.',
    comparisonAxis: 'safety', scenario: { kind: 'none', facts: [], decisiveConditions: [] } }] };
  const deck = { title: 'D', cards: [{ id: 'q1', targetId: 'target-1', kind: 'flashcard', prompt: 'Why do quorums overlap?', answer: 'Quorum overlap.' }] };
  const req = { kind: 'flashcard', count: 1, difficulty: 'mixed', language: 'English', focus: '', role: '', constraints: {}, sources, existing: ['Earlier objective'] };
  const prompts = [
    ['plan', GENERATION_STAGE_TEXT.planning, planPrompts(req).system, planPrompts(req).prompt],
    ['blueprint', GENERATION_STAGE_TEXT.blueprinting, blueprintPrompts(req, plan).system, blueprintPrompts(req, plan).prompt],
    ['author', GENERATION_STAGE_TEXT.authoring, authorPrompts(req, plan, blueprint).system, authorPrompts(req, plan, blueprint).prompt],
    ['review', GENERATION_STAGE_TEXT.reviewing, reviewPrompts({ ...req, deck, structuralErrors: [], assessmentPlan: plan, answerBlueprint: blueprint }).system,
      reviewPrompts({ ...req, deck, structuralErrors: [], assessmentPlan: plan, answerBlueprint: blueprint }).payload],
  ];
  const expectedDataPrefix = `${REQUEST_DATA}{"sources":${JSON.stringify(sources)},`;

  // 1. Direct host path.
  {
    const record = structuredClone(goldenRuntimeContracts.running); record.calls = []; record.runtime.steps = [];
    const controller = new AbortController(), seen = [];
    const host = { ctx: {}, sessionId: 'fixture', route: () => STRONG,
      complete: async (system, prompt) => { seen.push({ system, prompt }); return '{}'; } };
    const context = { jobId: record.jobId, attemptId: record.attemptId, signal: controller.signal, assertCurrent() {} };
    const gateway = createModelGateway({ context, record, host });
    const models = gatewayModels({ gateway, control: { values: {} }, performance: {}, feature: 'generate',
      outputs: { open() {}, append() {}, reasoning() {}, close() {} }, jobId: () => 'j1', refresh() {} });
    for (const [kind, stage, system, prompt] of prompts) await models.call(system, prompt, { kind, stage, part: 1, signal: controller.signal });
    assert.equal(seen.length, 4);
    for (const call of seen) {
      assert.equal(call.system, GENERATION_SYSTEM);
      assert.ok(call.prompt.startsWith(expectedDataPrefix), 'prompt leads with identical REQUEST DATA + sources prefix');
    }
    const wire = seen.map(call => `${call.system}\n\n${call.prompt}`);
    const minShared = GENERATION_SYSTEM.length + 2 + expectedDataPrefix.length;
    for (let i = 1; i < wire.length; i++) assert.ok(commonPrefix(wire[0], wire[i]) >= minShared, `stage 0 and stage ${i} share full sources prefix`);
  }

  // 2. Subagent path (`startBoundedChild` single-message prompt).
  {
    const record = structuredClone(goldenRuntimeContracts.running);
    record.calls = []; record.runtime.steps = []; record.capabilities.executionModes = ['direct', 'subagent'];
    const controller = new AbortController(), childTexts = [];
    const subagents = {
      start: async (_provider, spec) => {
        childTexts.push(spec.prompt[0].text);
        return { id: 'child-1', result: Promise.resolve({ stopReason: 'completed', output: [{ type: 'text', text: '{}' }] }), dispose: async () => {} };
      },
      getProvider: name => name === 'spawn' ? { capabilities: { agentOptions: true, toolFilter: true } } : null,
    };
    const agents = new Map([['parent-1', { id: 'parent-1' }]]);
    const ctx = { get: key => key === 'subagents' ? subagents : key === 'agents' ? agents : undefined };
    const host = { ctx, sessionId: 'parent-1', route: () => STRONG };
    const context = { jobId: record.jobId, attemptId: record.attemptId, signal: controller.signal, assertCurrent() {} };
    const gateway = createModelGateway({ context, record, host });
    const models = gatewayModels({ gateway, control: { values: {} }, performance: {}, feature: 'generate',
      outputs: { open() {}, append() {}, reasoning() {}, close() {} }, jobId: () => 'j1', refresh() {} });
    for (const [kind, stage, system, prompt] of prompts) await models.call(system, prompt, { kind, stage, part: 1, signal: controller.signal });
    assert.equal(childTexts.length, 4);
    const expectedSubagentPrefix = `${GENERATION_SYSTEM}\n\n${expectedDataPrefix}`;
    for (const text of childTexts) assert.ok(text.startsWith(expectedSubagentPrefix), 'subagent message leads with shared GENERATION_SYSTEM + sources prefix');
  }
});

function classifyCall(system, prompt) {
  const head = stageSystem(system, prompt);
  if (head.startsWith('You rate how much')) return 'weigh';
  if (head.startsWith('Plan a source-grounded')) return 'plan';
  if (head.startsWith('Prepare supported answers')) return 'blueprint';
  if (head.startsWith('You author')) return 'author';
  if (head.startsWith('Rewrite only the wording')) return 'patch';
  if (head.startsWith('Repair one draft card')) return 'draft-repair';
  if (head.startsWith('Act as a strict')) return 'review';
  return 'other';
}

function createRoutingHarness({ providers = ['preview'], efforts = null, onCall = null } = {}) {
  const calls = [];
  let firstReviewFlagged = false;
  const ctx = {
    llm: {
      listProviders: () => providers.map(id => ({ id, name: id })),
      ...(efforts ? { resolveModelInfo: async () => ({ reasoning: { efforts: efforts.map(id => ({ id })), defaultEffort: 'medium' } }) } : {}),
    },
  };

  const routeNameOf = options => options?.lightRoute?.model ?? options?.route?.model ?? options?.model?.model ?? STRONG.model;
  const effortNameOf = options => options?.reasoningEffort ?? options?.route?.reasoningEffort ?? null;

  const complete = async (system, prompt, options = {}) => {
    const stage = classifyCall(system, prompt);
    const model = routeNameOf(options);
    const effort = effortNameOf(options);
    calls.push({ stage, model, effort });
    if (onCall) await onCall({ stage, model, effort, options });
    if (stage === 'weigh') {
      const sections = JSON.parse(prompt.split('\n\n')[0]).sections;
      return JSON.stringify({ sections: sections.map(item => ({ id: item.id, importance: 4, kind: 'mechanism', reason: `Core section ${item.title}` })) });
    }
    if (stage === 'plan') return JSON.stringify(qualityPlan(requestData(prompt)));
    if (stage === 'blueprint') {
      const data = requestData(prompt), source = data.sources[0];
      const cards = data.assessmentPlan.targets.map((target, index) => ({
        id: `q${index + 1}`, targetId: target.targetId, kind: 'flashcard', topic: `Consensus ${index + 1}`,
        objective: target.objective, prompt: `How does principle ${index + 1} maintain quorum safety?`,
        answer: `Principle ${index + 1} prevents split-brain commits.`,
        hint: 'Check whether two quorums can be disjoint.',
        explanation: `Because quorums intersect, principle ${index + 1} guarantees at least one witness.`,
        misconception: 'Assuming majority count alone suffices without overlap.',
        citations: target.citations || [{ sourceId: source.id, quote: source.text.slice(0, 40) }],
      }));
      return JSON.stringify(qualityBlueprint(data, data.assessmentPlan, { title: 'Consensus', cards }));
    }
    if (stage === 'author') {
      const data = requestData(prompt);
      const cards = data.assessmentPlan.targets.map((target, index) => ({
        id: `q${index + 1}`, targetId: target.targetId, kind: 'flashcard', topic: `Consensus ${index + 1}`,
        objective: target.objective, prompt: `How does principle ${index + 1} maintain quorum safety?`,
        answer: data.answerBlueprint.items[index].answer,
        hint: 'Check whether two quorums can be disjoint.',
        explanation: `Because quorums intersect, principle ${index + 1} guarantees at least one witness.`,
        misconception: 'Assuming majority count alone suffices without overlap.',
        citations: target.citations,
      }));
      return JSON.stringify(authored({ title: 'Consensus', cards }, [], data.assessmentPlan));
    }
    if (stage === 'review') {
      const candidate = requestData(prompt).candidate;
      if (!firstReviewFlagged && candidate.cards.some(card => card.id === 'q1' && !card.prompt.includes('(reworded)'))) {
        firstReviewFlagged = true;
        const review = qualityReview(candidate, ['q1: selfContained failed — state the quorum condition explicitly in the stem']);
        review.checks = review.checks.map(check => check.cardId === 'q1' ? { ...check, selfContained: 'fail', explanation: 'State the quorum condition explicitly.' } : check);
        return JSON.stringify(review);
      }
      return JSON.stringify(qualityReview(candidate, []));
    }
    if (stage === 'patch') {
      const data = requestData(prompt);
      return JSON.stringify({ cards: data.cards.map(card => ({ id: card.id, prompt: `${card.prompt} (reworded)` })) });
    }
    if (stage === 'draft-repair') {
      const input = JSON.parse(prompt);
      return JSON.stringify({ card: { ...input.card, explanation: `Repaired explanation: ${input.card.explanation}` } });
    }
    throw new Error(`Unexpected stage: ${stage}`);
  };

  return { calls, ctx, complete, reset: () => { calls.length = 0; firstReviewFlagged = false; } };
}

async function openModeService(t, mode, harness, { route = STRONG, paths = ['generation', 'generationRepair'] } = {}) {
  const root = await mkdtemp(join(tmpdir(), `study-light-stages-${mode}-`));
  const runtimeOpts = mode === 'runtime'
    ? (() => {
        const { starts: _starts, ...managed } = managedRuntimeOptions({ complete: harness.complete, paths, host: { ctx: harness.ctx } });
        return { ...managed, jobModelHost: { ...managed.jobModelHost, route, complete: harness.complete } };
      })()
    : { jobModelHost: { ctx: harness.ctx, route, complete: harness.complete } };
  const service = new StudyService(root, { complete: harness.complete, ...runtimeOpts });
  t.after(async () => { await service.dispose(); await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });
  return service;
}

for (const mode of SWITCH_MODES) {
  test(`${mode}: lightModel routes only weigh, in-run patchPrompts and draft.repair rewrite to the fast model while keeping Plan, Blueprint, Author, Review and post-repair reviewDeck on the strong model`, async t => {
    const harness = createRoutingHarness();
    const service = await openModeService(t, mode, harness);
    const world = mergedTranscript({ recordings: 1, parts: 3, paragraphs: 4 });
    for (const source of world.sources) await service.call('source.add', source);
    await service.call('settings', { generation: { concurrency: 1, fillRounds: 0, lightModel: 'preview/fast-model' } });

    const started = await service.call('generate', { sourceIds: world.sources.map(item => item.id), coverageLevel: 'lean', kind: 'flashcard' });
    const job = await settleJob(service, started.jobId);
    assert.equal(job.status, 'complete', job.stage);

    const byStage = stage => harness.calls.filter(call => call.stage === stage).map(call => call.model);
    assert.deepEqual(byStage('weigh'), [FAST.model], 'weigh uses lightModel');
    assert.deepEqual(byStage('patch'), [FAST.model], 'in-run patchPrompts wording repair uses lightModel');
    for (const mainStage of ['plan', 'blueprint', 'author']) {
      assert.ok(byStage(mainStage).length >= 1, `${mainStage} ran`);
      assert.ok(byStage(mainStage).every(model => model === STRONG.model), `${mainStage} stays on main strong model`);
    }
    assert.ok(byStage('review').length >= 2, 'initial review + post-patch reviewDeck both ran');
    assert.ok(byStage('review').every(model => model === STRONG.model), 'all review calls including post-patch reviewDeck stay on main strong model');

    const exported = await service.call('export');
    const generatedDraft = exported.drafts.find(item => item.id === job.draftId);
    assert.ok(generatedDraft.editorial.repairedInRun >= 1, 'patched card passed post-repair reviewDeck');

    // Now verify `draft.repair` routes ONLY the card rewrite to `lightModel` and keeps its `reviewDeck` on the main model.
    harness.reset();
    const firstCard = generatedDraft.cards[0];
    const saved = await service.call('draft.save', {
      deck: {
        ...generatedDraft,
        editorial: { ...generatedDraft.editorial, rejectedIssues: { [firstCard.id]: ['explanationQuality failed'] } },
      },
    });
    const repairStarted = await service.call('draft.repair', { id: generatedDraft.id, draftVersion: saved.draftVersion });
    const repairDone = await settleJob(service, repairStarted.jobId);
    assert.equal(repairDone.status, 'complete', repairDone.stage);
    assert.deepEqual(byStage('draft-repair'), [FAST.model], 'draft.repair card rewrite uses lightModel');
    assert.deepEqual(byStage('review'), [STRONG.model], 'draft.repair post-rewrite reviewDeck stays on main strong model');
  });

  test(`${mode}: unset lightModel or a lightModel unavailable on the host cleanly uses the main run model without failing`, async t => {
    for (const [label, providers, lightModel] of [
      ['unset empty string', ['preview'], ''],
      ['unset null', ['preview'], null],
      ['provider unavailable on host', ['preview'], 'unavailable-provider/fast-model'],
    ]) {
      const harness = createRoutingHarness({ providers });
      const service = await openModeService(t, mode, harness);
      const world = mergedTranscript({ recordings: 1, parts: 3, paragraphs: 4 });
      for (const source of world.sources) await service.call('source.add', source);
      await service.call('settings', { generation: { concurrency: 1, fillRounds: 0, lightModel } });

      const started = await service.call('generate', { sourceIds: world.sources.map(item => item.id), coverageLevel: 'lean', kind: 'flashcard' });
      const job = await settleJob(service, started.jobId);
      assert.equal(job.status, 'complete', `${label}: generate completes`);
      assert.ok(harness.calls.some(call => call.stage === 'weigh'), `${label}: weigh ran`);
      assert.ok(harness.calls.some(call => call.stage === 'patch'), `${label}: patch ran`);
      assert.ok(harness.calls.every(call => call.model === STRONG.model), `${label}: all calls cleanly use main model (${JSON.stringify(harness.calls)})`);

      harness.reset();
      const generatedDraft = (await service.call('export')).drafts.find(item => item.id === job.draftId);
      const firstCard = generatedDraft.cards[0];
      const saved = await service.call('draft.save', {
        deck: { ...generatedDraft, editorial: { ...generatedDraft.editorial, rejectedIssues: { [firstCard.id]: ['explanationQuality failed'] } } },
      });
      const repairDone = await settleJob(service, (await service.call('draft.repair', { id: generatedDraft.id, draftVersion: saved.draftVersion })).jobId);
      assert.equal(repairDone.status, 'complete', `${label}: draft.repair completes`);
      assert.ok(harness.calls.some(call => call.stage === 'draft-repair'), `${label}: draft.repair ran`);
      assert.ok(harness.calls.every(call => call.model === STRONG.model), `${label}: draft.repair falls back to main model`);
    }
  });
}

test('session high reasoningEffort does not leak onto patch or draft.repair (both with lightModel set and with lightModel === ""), while plan and review keep high', async t => {
  const highRoute = () => withEffortPreference({ ...STRONG, reasoningEffort: 'high' }, 'high');
  for (const [label, lightModel, expectedRepairModel] of [
    ['lightModel configured', 'preview/fast-model', FAST.model],
    ['lightModel follow ("")', '', STRONG.model],
  ]) {
    const harness = createRoutingHarness({ efforts: ['low', 'medium', 'high'] });
    const service = await openModeService(t, 'runtime', harness, { route: highRoute });
    const world = mergedTranscript({ recordings: 1, parts: 3, paragraphs: 4 });
    for (const source of world.sources) await service.call('source.add', source);
    await service.call('settings', { generation: { concurrency: 1, fillRounds: 0, lightModel } });

    const started = await service.call('generate', { sourceIds: world.sources.map(item => item.id), coverageLevel: 'lean', kind: 'flashcard' });
    const job = await settleJob(service, started.jobId);
    assert.equal(job.status, 'complete', `${label}: generate completes`);

    const ofStage = stage => harness.calls.filter(call => call.stage === stage);
    assert.ok(ofStage('plan').every(call => call.model === STRONG.model && call.effort === 'high'), `${label}: plan keeps high reasoning`);
    assert.ok(ofStage('review').every(call => call.model === STRONG.model && call.effort === 'high'), `${label}: review keeps high reasoning`);
    assert.deepEqual(ofStage('patch'), [{ stage: 'patch', model: expectedRepairModel, effort: 'low' }], `${label}: patch runs at low reasoning`);

    // Verify `draft.repair` also resolves `low` for card rewrite and `high` for `reviewDeck`, even if `effortRepair` were `'follow'` when `lightModel` is set.
    harness.reset();
    const generatedDraft = (await service.call('export')).drafts.find(item => item.id === job.draftId);
    const firstCard = generatedDraft.cards[0];
    const saved = await service.call('draft.save', {
      deck: { ...generatedDraft, editorial: { ...generatedDraft.editorial, rejectedIssues: { [firstCard.id]: ['explanationQuality failed'] } } },
    });
    const repairDone = await settleJob(service, (await service.call('draft.repair', { id: generatedDraft.id, draftVersion: saved.draftVersion })).jobId);
    assert.equal(repairDone.status, 'complete', `${label}: draft.repair completes`);
    assert.deepEqual(ofStage('draft-repair'), [{ stage: 'draft-repair', model: expectedRepairModel, effort: 'low' }], `${label}: draft.repair rewrite runs at low reasoning`);
    assert.deepEqual(ofStage('review'), [{ stage: 'review', model: STRONG.model, effort: 'high' }], `${label}: draft.repair reviewDeck keeps high reasoning`);
  }
});

test('explicit per-call generate({ lightModel }) is preserved across checkpoint draft retry (resumeArgs)', async t => {
  // Direct unit check on resumeArgs for both explicit override and explicit empty-string override.
  const state = { drafts: [{ id: 'd1', draftVersion: 3, editorial: { generation: { runId: 'run-1' } } }] };
  assert.deepEqual(resumeArgs({ sourceIds: ['s1'], lightModel: 'preview/fast-model' }, state, 'run-1'),
    { resumeDraftId: 'd1', draftVersion: 3, lightModel: 'preview/fast-model' });
  assert.deepEqual(resumeArgs({ sourceIds: ['s1'], lightModel: '' }, state, 'run-1'),
    { resumeDraftId: 'd1', draftVersion: 3, lightModel: '' });
  assert.deepEqual(resumeArgs({ sourceIds: ['s1'] }, state, 'run-1'),
    { resumeDraftId: 'd1', draftVersion: 3 });

  // End-to-end runtime check: library setting is '', per-call `lightModel: 'preview/fast-model'` is cancelled after part 1 saves, then retried.
  const hold = gate();
  let authors = 0;
  const harness = createRoutingHarness({
    onCall: async ({ stage }) => {
      if (stage === 'author' && ++authors === 2 && !hold.entered) { hold.entered = true; await hold.promise; }
    },
  });
  const service = await openModeService(t, 'runtime', harness);
  const world = mergedTranscript({ recordings: 1, parts: 3, paragraphs: 4 });
  for (const source of world.sources) await service.call('source.add', source);
  await service.call('settings', { generation: { lightModel: '' } });

  const started = await service.call('generate', {
    sourceIds: world.sources.map(item => item.id), count: 2, kind: 'flashcard',
    performance: ONE_BY_ONE, lightModel: 'preview/fast-model',
  });
  await soon(async () => (await service.call('export')).drafts[0]?.cards.length === 1 && hold.entered, 'part 1 saved and part 2 held');
  await service.call('job.cancel', { jobId: started.jobId });
  hold.open();
  assert.equal((await settleJob(service, started.jobId)).status, 'cancelled');

  harness.reset();
  const retried = await service.call('job.control', { jobId: started.jobId, action: 'retry' });
  const done = await settleJob(service, retried.attemptId);
  assert.equal(done.status, 'complete', done.stage);
  assert.deepEqual(harness.calls.filter(call => call.stage === 'patch').map(call => call.model), [FAST.model],
    'retried attempt after checkpoint draft still uses per-call lightModel');
});
