import { StudyService } from '../../lib/service.js';
import { reportUsage } from '../../lib/usage-scope.js';
import { privateRoot } from './model-family-baseline.mjs';
import { managedRuntimeOptions } from './runtime-switch.mjs';
import { until } from './wait.mjs';
import { stagedModel } from './generation-baseline.mjs';
import { card, SCHEDULE, ONE_BY_ONE, evidence, other } from './supplement-fixtures.mjs';

/* The families of the 任务 console, each as a DRIVER: how to open a library for it with its migration switches flippable at any moment (so old and new jobs can sit in one service), and how to
   bring a job of each kind of the family to the three states the matrix looks at: finished, running (held at its model or process) and failed. Fakes only; nothing leaves the machine.
   A driver: { id, title, switches, kinds, open(t) -> world, done(world), held(world) -> { id, release }, failed?(world) }; a job is named by what its own door answered (`started`); `rowOf` finds it. */

export const gate = () => { let open; const promise = new Promise(resolve => { open = resolve; }); return { promise, open, entered: false }; };
const soon = (condition, what) => until(condition, what, { timeoutMs: 90_000 });
export const rowOf = async (service, started) => {
  const wanted = typeof started === 'string' ? started : started.jobId ?? started.id;
  return (await service.call('snapshot')).jobs.find(job => job.id === wanted || job.contract?.jobId === wanted);
};
const settled = (service, started) => until(async () => { const row = await rowOf(service, started); return row && !['queued', 'running', 'cancelling'].includes(row.status) && row; }, 'the job to settle', { timeoutMs: 90_000 });

/** A service whose switches can be flipped between two submissions: `pilot` is the object every context reads when it decides how to carry a job out. */
export async function openWorld(t, { complete, prefix = 'console-matrix-', options = {}, setup } = {}) {
  const root = await privateRoot(t, prefix);
  const { starts: _starts, ...managed } = managedRuntimeOptions({ complete, paths: [] });
  const service = new StudyService(root, { complete, coach: false, ...managed, ...options });
  const world = { root, service, pilot: managed.runtimePilot, complete, holds: [] };
  t.after(async () => { for (const hold of world.holds) hold.open?.(); await service.dispose(); });
  world.set = (on, switches) => { for (const name of switches) world.pilot[name] = on; };
  await setup?.(world);
  return world;
}

/* ---------- the generation family: generate, supplement, selection, repair, publish ---------- */

const GENERATION_SWITCHES = ['generation', 'generationRepair', 'generationPublish'];
async function generationWorld(t) {
  const hold = gate(), staged = stagedModel({ holdAt: 'plan', hold });
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
    w.hold = hold; w.staged = staged; w.count = 0; w.holds.push(hold);
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
const startGeneration = {
  generate: world => world.service.call('generate', { sourceIds: ['p2'], count: 1, kind: 'flashcard', performance: ONE_BY_ONE }),
  supplement: world => world.service.call('supplement', { sourceIds: ['p1'], deckId: 't', count: 1, kind: 'flashcard', performance: ONE_BY_ONE }),
  selection: async world => world.service.call('generation.selection.start', { selection: world.selection, deckId: 't', expectedVersion: (await world.service.call('export')).decks.find(deck => deck.id === 't').version ?? 0,
    count: 1, kind: 'flashcard', operationId: `op-${++world.count}` }),
  repair: async world => { const draft = await draftOf(world, 'repair'); return world.service.call('draft.repair', { id: draft.id, draftVersion: draft.version }); },
  publish: async world => { const draft = await draftOf(world, 'publish'); return world.service.call('draft.publish.start', { id: draft.id, draftVersion: draft.version, mergeTargetId: 't' }); },
};
const generationDriver = (name, kind, switches) => ({
  id: `generation:${name}`, title: `出题 · ${name}`, kinds: [kind], switches, message: name === 'generate' || name === 'supplement',
  open: generationWorld,
  async done(world) { world.hold.open(); const started = await startGeneration[name](world); await settled(world.service, started); return started; },
  async held(world) {
    // the hold of the model stage: the first call of the next job waits for it (a publication or a repair that asks no plan is held by a generate in front of it)
    world.hold.entered = false; world.hold.promise = new Promise(resolve => { world.hold.open = resolve; });
    const started = await startGeneration[name](world);
    if (['generate', 'supplement', 'selection'].includes(name)) await soon(() => world.hold.entered, 'the model to be asked');
    else await soon(async () => (await rowOf(world.service, started))?.status === 'running' || (await rowOf(world.service, started))?.status === 'complete', 'the job to run');
    return { started, release: () => world.hold.open() };
  },
});
export const GENERATION_DRIVERS = [
  generationDriver('generate', 'generation', GENERATION_SWITCHES), generationDriver('supplement', 'supplement', GENERATION_SWITCHES), generationDriver('selection', 'supplement', GENERATION_SWITCHES),
  generationDriver('repair', 'draft-repair', GENERATION_SWITCHES), generationDriver('publish', 'draft-publish', GENERATION_SWITCHES),
];
export { settled, soon };
