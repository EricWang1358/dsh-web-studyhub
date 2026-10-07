import { StudyService } from '../../lib/service.js';
import { reportUsage } from '../../lib/usage-scope.js';
import { privateRoot } from './model-family-baseline.mjs';
import { managedRuntimeOptions } from './runtime-switch.mjs';
import { until } from './wait.mjs';
import { gate, stagedModel } from './generation-baseline.mjs';
import { card, SCHEDULE, ONE_BY_ONE, evidence, other } from './supplement-fixtures.mjs';

/* Public family submissions for the non-audio console matrix. A driver opens a
   private library, starts real domain work and waits through its public status.
   world.model holds/fails only the fake provider; no projected job is fabricated. */

export { gate };
const soon = (condition, what) => until(condition, what, { timeoutMs: 90_000 });
export const rowOf = async (service, started) => {
  const wanted = typeof started === 'string' ? started : started.jobId ?? started.id;
  return (await service.call('snapshot')).jobs.find(job => job.id === wanted || job.contract?.jobId === wanted);
};
const settled = (service, started) => until(async () => { const row = await rowOf(service, started); return row && !['queued', 'running', 'cancelling'].includes(row.status) && row; }, 'the job to settle', { timeoutMs: 90_000 });

/** A service whose switches can be flipped between two submissions: `pilot` is the object every context reads when it decides how to carry a job out. */
export async function openWorld(t, { complete, prefix = 'console-matrix-', options = {}, setup } = {}) {
  const root = await privateRoot(t, prefix);
  const model = { gate: null, fail: false, calls: 0 };
  const wrap = answer => async (...args) => {
    model.calls++;
    if (model.gate) { model.gate.entered = true; await model.gate.promise; }
    args[2]?.signal?.throwIfAborted();
    if (model.fail) throw new Error('console fixture model failed');
    return answer(...args);
  };
  const controlled = wrap(complete);
  const { starts: _starts, ...managed } = managedRuntimeOptions({ complete: controlled, paths: [] });
  const service = new StudyService(root, { coach: false, ...managed, ...options, complete: controlled,
    ...(options.completeLight ? { completeLight: wrap(options.completeLight) } : {}) });
  const world = { root, service, pilot: managed.runtimePilot, complete: controlled, model, holds: [] };
  t.after(async () => { for (const hold of world.holds) hold.open?.(); await service.dispose(); });
  world.set = (on, switches) => { for (const name of switches) world.pilot[name] = on; };
  await setup?.(world);
  return world;
}

/* ---------- the generation family: generate, supplement, selection, repair, publish ---------- */

const GENERATION_SWITCHES = ['generation', 'generationRepair', 'generationPublish'];
async function generationWorld(t) {
  const staged = stagedModel();
  const complete = async (system, prompt, context = {}) => {
    reportUsage({ uncachedInputTokens: 30, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0 });
    if (system.startsWith('Repair one draft card')) { const input = JSON.parse(prompt); return JSON.stringify({ card: { ...input.card, explanation: `Fixed: ${input.card.explanation}` } }); }
    return staged.complete(system, prompt, context);
  };
  const world = await openWorld(t, { complete, prefix: 'console-generation-', setup: async w => {
    const { service } = w, passage = "Architecture includes the principles guiding a system's design and evolution.";
    await service.call('source.add', { id: 'p1', title: 'Page 1', text: evidence, courses: ['A'] });
    await service.call('source.add', { id: 'p2', title: 'Page 2', text: other, courses: ['A'] });
    await service.store.update(state => { state.decks.push({ id: 't', title: 'Target', course: 'A', cards: [{ ...card('old'), review: SCHEDULE }], createdAt: '2026-09-29T00:00:00.000Z' }); });
    const imported = await service.call('materials.document.import', { filename: 'notes.md', dataBase64: Buffer.from(`# Notes\n\n${passage}`).toString('base64') });
    w.selection = (await service.call('materials.selection.resolve', { documentId: imported.documentId, revision: imported.revision, quote: passage })).selection;
    w.count = 0;
  } });
  return world;
}
const base = (id, n) => ({ ...card(id, 'p1'), objective: `Explain principle ${n}`, prompt: `What guides design question ${n}?` });
const draftOf = async (world, kind) => {
  const n = ++world.count, id = `${kind}-${n}`;
  const rejected = kind === 'repair' ? { rejectedIssues: { [`${id}-a`]: ['explanationQuality failed'] }, generation: { sourceIds: ['p1'], kind: 'flashcard' } } : undefined;
  const saved = await world.service.call('draft.save', { deck: { id, title: `Draft ${n}`, cards: [base(`${id}-a`, n), base(`${id}-b`, n + 100)], course: 'A', ...(rejected ? { editorial: rejected } : {}) } });
  return { id, version: saved.draftVersion };
};
const targetOf = async world => {
  const id = `target-${++world.count}`;
  await world.service.store.update(state => { state.decks.push({ ...structuredClone(state.decks.find(deck => deck.id === 't')), id }); });
  return id;
};
const startGeneration = {
  generate: world => world.service.call('generate', { sourceIds: ['p2'], count: 1, kind: 'flashcard', performance: ONE_BY_ONE }),
  supplement: async world => world.service.call('supplement', { sourceIds: ['p1'], deckId: await targetOf(world), count: 1, kind: 'flashcard', performance: ONE_BY_ONE }),
  selection: async world => world.service.call('generation.selection.start', { selection: world.selection, deckId: await targetOf(world), expectedVersion: 0,
    count: 1, kind: 'flashcard', operationId: `op-${++world.count}` }),
  repair: async world => { const draft = await draftOf(world, 'repair'); return world.service.call('draft.repair', { id: draft.id, draftVersion: draft.version }); },
  publish: async world => { const draft = await draftOf(world, 'publish'); return world.service.call('draft.publish.start', { id: draft.id, draftVersion: draft.version, mergeTargetId: 't' }); },
};
const generationDriver = (name, kind, switches) => ({
  id: `generation:${name}`, title: `出题 · ${name}`, kinds: [kind], switches, message: name !== 'publish',
  open: generationWorld,
  start: startGeneration[name],
  async done(world) { const started = await startGeneration[name](world); await settled(world.service, started); return started; },
});
export const GENERATION_DRIVERS = [
  generationDriver('generate', 'generation', GENERATION_SWITCHES), generationDriver('supplement', 'supplement', GENERATION_SWITCHES), generationDriver('selection', 'supplement', GENERATION_SWITCHES),
  generationDriver('repair', 'draft-repair', GENERATION_SWITCHES), generationDriver('publish', 'draft-publish', GENERATION_SWITCHES),
];
export { settled, soon };
