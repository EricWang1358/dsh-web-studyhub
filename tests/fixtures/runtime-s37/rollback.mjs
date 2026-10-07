import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { managedRuntimeOptions } from '../../helpers/runtime-switch.mjs';
import { settleJob, until } from '../../helpers/wait.mjs';
import { driveModel } from './fake-model.mjs';

/* The S3-7 rollback drill, one step per process, every fake and no network (run it with run-drill.mjs):
     prepare <scenario>   the CURRENT code, every generation switch on, makes finished work or work cut short at a chosen point, then the process ENDS HARD (no dispose, no cleanup);
     read <scenario>      a code tree (the fixed older one, or the current one) opens the same library, reports what it sees, and with `act` finishes what is unfinished.
   argv: mode, scenario, workdir, libRoot, switches ('on' | 'off'), act ('act' | 'look'). The result is one line, `RESULT <json>`. */

const [mode, scenario, work, libRoot, switches, act] = process.argv.slice(2);
const root = join(work, 'library'), home = join(work, 'home');
process.env.DSH_HOME = home;
const hash = value => createHash('sha256').update(value).digest('hex').slice(0, 16);
const state = name => join(work, name);
const PATHS = ['generation', 'generationRestart', 'generationRepair', 'generationPublish'];
const ONE_BY_ONE = { concurrency: 1, batchSize: 1, jobTimeoutMinutes: 20, fillRounds: 0, effortPlanning: 'follow', effortReview: 'follow', effortWriting: 'low', effortRepair: 'low' };
const EVIDENCE = 'Bridge separates an abstraction from its implementation so the two can vary independently.';
const OTHER = 'A trade-off analysis weighs the cost of each architectural characteristic against the others.';
const card = (id, sourceId, quote) => ({ id, kind: 'flashcard', topic: 'Bridge', objective: `Explain dimension ${id}`, prompt: `Why separate report and renderer dimension ${id}?`,
  answer: 'They can vary independently.', hint: 'Consider two reasons to change.', explanation: 'Report types and rendering backends vary independently.',
  misconception: 'A subclass for every combination causes a cross product.', citations: [{ sourceId, quote }] });
const SEEDED = ['old', 'a', 'b', 'ra', 'rb'];
const SCHEDULE = { repetitions: 3, interval_days: 16, ease_factor: 2.6, due_at: '2026-10-16T00:00:00.000Z' };
const PASSAGE = "Architecture includes the principles guiding a system's design and evolution.";
const PASTED = {
  title: 'Orchard Cold Chain',
  scenario: ['Orchard Cold Chain stores fresh fruit for supermarkets in three refrigerated warehouses.', 'Temperature sensors report every minute to a desktop program written in Visual Basic in 2009.',
    'In March a warehouse lost power overnight and nobody was alerted until the morning shift arrived.', 'Management wants customers to see live temperatures on their phones next season.'].join('\n\n'),
  questions: [{ prompt: 'Which architecture style would you recommend for the new monitoring platform? Justify.', marks: 6 },
    { prompt: 'Which data stores would you use for the sensor readings and the customer portal? Justify.', marks: 4 }],
};
const answer = n => `I recommend an event-driven architecture ${n} because the sensors already publish readings every minute.\nEach reading becomes an event that an alerting service consumes, so a power loss raises an alarm at once.\nThe case does not say how many sensors there are, so I assume about 500.`;

async function build({ lib, current, complete, wrap }) {
  const { StudyService } = await import(pathToFileURL(join(lib, 'lib/service.js')).href);
  const { starts: _starts, ...managed } = managedRuntimeOptions({ paths: current ? PATHS : [], complete });
  const service = new StudyService(root, { coach: false, complete, ...(current ? managed : {}) });
  service.complete = complete;
  if (wrap) wrap(service);
  return service;
}
const settled = async (service, jobId) => { for (let n = 0; n < 40; n++) { const job = await service.call('job.wait', { jobId, timeoutSeconds: 30 }); if (!['queued', 'running', 'cancelling'].includes(job.status)) return job; } throw new Error('the job did not settle'); };
const crash = () => { console.log(`RESULT ${JSON.stringify({ scenario, prepared: true, endedHard: true })}`); process.exit(0); }; // no dispose, no cleanup
const draftsOf = async service => (await service.call('export')).drafts;

/** The library as a version that has never heard of the runtime can read it, in words both can answer. */
async function view(service) {
  const library = await service.call('export'), jobs = (await service.call('snapshot')).jobs ?? [];
  return {
    // The questions a model wrote are counted (each process writes its own), the ones the drill seeded are named and held to their words.
    decks: library.decks.map(deck => ({ id: deck.id.length > 8 ? 'case' : deck.id, cards: deck.cards.map(item => (SEEDED.includes(item.id) ? item.id : 'written')).sort(),
      hash: hash(JSON.stringify(deck.cards.filter(item => SEEDED.includes(item.id)).map(item => [item.id, item.prompt, item.answer]).sort())) })).sort((a, b) => a.id.localeCompare(b.id)),
    drafts: library.drafts.map(draft => ({ id: draft.id.length > 8 ? 'written' : draft.id, cards: draft.cards.length, fixed: draft.cards.filter(item => /^Fixed:/.test(item.explanation)).length, rejected: Object.keys(draft.editorial?.rejectedIssues ?? {}).sort() }))
      .sort((a, b) => a.id.localeCompare(b.id)),
    graded: library.attempts.filter(item => item.assessment === 'rubric').length,
    selection: (library.selectionJobs ?? []).map(item => item.status).sort(),
    jobs: jobs.map(job => job.status).sort(),
  };
}

async function seed(service) {
  await service.call('source.add', { id: 'p1', title: 'Page 1', text: EVIDENCE, courses: ['A'] });
  await service.call('source.add', { id: 'p2', title: 'Page 2', text: OTHER, courses: ['A'] });
  await service.store.update(library => {
    library.decks.push({ id: 't', title: 'Target', course: 'A', cards: [{ ...card('old', 'p1', EVIDENCE), review: SCHEDULE }], createdAt: '2026-09-29T00:00:00.000Z' });
  });
  const base = (id, n) => ({ ...card(id, 'p1', EVIDENCE), objective: `Explain principle ${n}`, prompt: `What guides design question ${n}?` });
  await service.call('draft.save', { deck: { id: 'd', title: 'Architecture', cards: [base('a', 1), base('b', 2)], course: 'A' } });
  await service.call('draft.save', { deck: { id: 'r', title: 'Repairs', cards: [base('ra', 3), base('rb', 4)], course: 'A',
    editorial: { generation: { sourceIds: ['p1'], kind: 'flashcard' }, rejectedIssues: { ra: ['explanationQuality failed'], rb: ['explanationQuality failed'] } } } });
}
const draftVersion = async (service, id) => (await draftsOf(service)).find(draft => draft.id === id).draftVersion;
const selectionArgs = async service => {
  // The same request every time: the selection (and its document) is made once, by the process that prepares the work.
  const kept = await readFile(state('selection-args.json'), 'utf8').then(JSON.parse, () => null);
  if (kept) return kept;
  const imported = await service.call('materials.document.import', { filename: 'notes.md', dataBase64: Buffer.from(`# Notes\n\n${PASSAGE}`).toString('base64') });
  const selection = (await service.call('materials.selection.resolve', { documentId: imported.documentId, revision: imported.revision, quote: PASSAGE })).selection;
  const target = (await service.call('export')).decks.find(deck => deck.id === 't');
  const args = { selection, deckId: 't', expectedVersion: target.contentVersion ?? 0, count: 1, kind: 'flashcard', operationId: 'op-1' };
  await writeFile(state('selection-args.json'), JSON.stringify(args));
  return args;
};
/** Hold a write of a publication (`where`: before it reaches the library, or after it did) at the authoring context. */
const holdWrite = (where, flag) => service => {
  const invoke = service.runtime.invoke.bind(service.runtime);
  service.runtime.invoke = async (api, action, args, services) => {
    const writing = api === 'authoring.v1' && action === 'draft.publish' && args.mergeTargetId === 't';
    if (writing && where === 'before') { flag.held = true; await new Promise(() => {}); }
    const result = await invoke(api, action, args, services);
    if (writing && where === 'after') { flag.held = true; await new Promise(() => {}); }
    return result;
  };
};

/* What each scenario does with the current code, until the process ends. */
const prepareWork = {
  async 'generate-mid'(service, model) {
    await service.call('generate', { sourceIds: ['p1', 'p2'], count: 3, kind: 'flashcard', performance: ONE_BY_ONE });
    await until(async () => model.state.held && (await draftsOf(service)).some(draft => draft.cards.length === 1 && draft.id !== 'd' && draft.id !== 'r'), 'the first part to be saved');
  },
  async 'repair-mid'(service, model) {
    await service.call('draft.repair', { id: 'r', draftVersion: await draftVersion(service, 'r') });
    await until(async () => model.state.held && !(await draftsOf(service)).find(draft => draft.id === 'r').editorial.rejectedIssues.ra, 'the first card to be repaired');
  },
  async 'publish-before'(service, _model, flag) { await service.call('draft.publish.start', { id: 'd', draftVersion: await draftVersion(service, 'd'), mergeTargetId: 't' }); await until(() => flag.held, 'the write to be held'); },
  async 'publish-after'(service, _model, flag) { await service.call('draft.publish.start', { id: 'd', draftVersion: await draftVersion(service, 'd'), mergeTargetId: 't' }); await until(() => flag.held, 'the write to be done'); },
  async 'supplement-after'(service, _model, flag) {
    await service.call('supplement', { sourceIds: ['p1'], deckId: 't', count: 2, kind: 'flashcard', performance: ONE_BY_ONE });
    await until(() => flag.held, 'the supplement to be written');
  },
  async 'case-grading'(service, _model, flag) {
    await service.call('source.add', { id: 'cloud', title: 'Cloud persistence', text: 'Polyglot persistence chooses a different data store for each workload. Relational databases give ACID transactions.', courses: ['Cloud Native'] });
    await service.call('generate', { kind: 'case', ...PASTED, answers: [answer(1), answer(2)], sourceIds: ['cloud'], language: 'English', course: 'Cloud Native' });
    await until(() => flag.held, 'the first grading to be reached');
  },
  async 'selection-review'(service, model) { await service.call('generation.selection.start', await selectionArgs(service)); await until(() => model.state.held, 'the review to be held'); },
};
const HOLDS = { 'generate-mid': { stage: 'author', nth: 2 }, 'repair-mid': { stage: 'repair', nth: 2 }, 'selection-review': { stage: 'review', nth: 1 } };
const WRAPS = {
  'publish-before': flag => holdWrite('before', flag), 'publish-after': flag => holdWrite('after', flag), 'supplement-after': flag => holdWrite('after', flag),
  'case-grading': flag => service => {
    const invoke = service.runtime.invoke.bind(service.runtime);
    service.runtime.invoke = async (api, action, args, services) => { if (api === 'study.v1' && action === 'card.grade') { flag.held = true; await new Promise(() => {}); } return invoke(api, action, args, services); };
  },
};

/* What a version does to finish the unfinished work: the older one by its own tools, the current one by the job's retry (or the same tools when nothing came back). */
const retryInterrupted = async service => {
  const [job] = ((await service.call('snapshot')).jobs ?? []).filter(item => item.contract?.status === 'interrupted');
  assert.ok(job, 'the current code has an interrupted job to retry');
  const attempt = await service.call('job.control', { jobId: job.id, action: 'retry' });
  return (await settleJob(service, attempt.attemptId)).status;
};
const finishWork = {
  async 'generate-mid'(service, side) {
    if (side === 'current') return { status: await retryInterrupted(service) };
    const draft = (await draftsOf(service)).find(item => item.id !== 'd' && item.id !== 'r');
    return { status: (await settled(service, (await service.call('generate', { resumeDraftId: draft.id, draftVersion: draft.draftVersion })).jobId)).status };
  },
  async 'repair-mid'(service, side) {
    if (side === 'current') return { status: await retryInterrupted(service) };
    return { status: (await settled(service, (await service.call('draft.repair', { id: 'r', draftVersion: await draftVersion(service, 'r') })).jobId)).status };
  },
  async 'publish-before'(service, side) {
    if (side === 'current') return { status: await retryInterrupted(service) };
    return { status: (await settled(service, (await service.call('draft.publish.start', { id: 'd', draftVersion: await draftVersion(service, 'd'), mergeTargetId: 't' })).jobId)).status };
  },
  async 'publish-after'(service, side) {
    if (side === 'current') return { status: await retryInterrupted(service) };
    return { nothingLeft: !(await draftsOf(service)).some(draft => draft.id === 'd') };
  },
  async 'supplement-after'(service, side) {
    if (side === 'current') return { status: await retryInterrupted(service) };
    return { nothingLeft: true };
  },
  async 'case-grading'(service, side) {
    if (side === 'current') return { status: await retryInterrupted(service) };
    const deck = (await service.call('export')).decks.find(item => item.case);
    for (const [index, item] of deck.cards.entries()) await service.call('card.grade', { deckId: deck.id, cardId: item.id, answer: answer(index + 1) });
    return { regraded: deck.cards.length };
  },
  async 'selection-review'(service) {
    const started = await service.call('generation.selection.start', await selectionArgs(service));
    return { status: (await settled(service, started.jobId)).status };
  },
};

if (mode === 'prepare') {
  await mkdir(work, { recursive: true });
  const model = driveModel({ hold: HOLDS[scenario] }), flag = { held: false };
  if (scenario === 'settled') {
    const service = await build({ lib: libRoot, current: true, complete: model.complete });
    await seed(service);
    const done = [];
    done.push((await settled(service, (await service.call('generate', { sourceIds: ['p2'], count: 1, kind: 'flashcard', performance: ONE_BY_ONE })).jobId)).status);
    done.push((await settled(service, (await service.call('draft.repair', { id: 'r', draftVersion: await draftVersion(service, 'r') })).jobId)).status);
    done.push((await settled(service, (await service.call('draft.publish.start', { id: 'd', draftVersion: await draftVersion(service, 'd'), mergeTargetId: 't' })).jobId)).status);
    done.push((await settled(service, (await service.call('supplement', { sourceIds: ['p1'], deckId: 't', count: 1, kind: 'flashcard', performance: ONE_BY_ONE })).jobId)).status);
    done.push((await settled(service, (await service.call('generation.selection.start', await selectionArgs(service))).jobId)).status);
    assert.deepEqual(done, ['complete', 'complete', 'complete', 'complete', 'complete']);
    await writeFile(state('prepared.json'), JSON.stringify(await view(service)));
    await service.dispose();
    console.log(`RESULT ${JSON.stringify({ scenario, prepared: true })}`);
    process.exit(0);
  }
  const caseModel = scenario === 'case-grading' ? (await import(pathToFileURL(join(libRoot, 'scripts/fake-model.mjs')).href)).createFakeModel() : null;
  const service = await build({ lib: libRoot, current: true, complete: caseModel ?? model.complete, wrap: WRAPS[scenario]?.(flag) });
  if (scenario !== 'case-grading') await seed(service);
  await prepareWork[scenario](service, model, flag);
  crash();
}

assert.equal(mode, 'read');
const complete = scenario === 'case-grading' ? (await import(pathToFileURL(join(libRoot, 'scripts/fake-model.mjs')).href)).createFakeModel() : driveModel().complete;
const service = await build({ lib: libRoot, current: switches === 'on', complete });
const result = { scenario, lib: switches === 'on' ? 'current' : 'older', seen: await view(service) };
if (act === 'act' && scenario !== 'settled') { result.finished = await finishWork[scenario](service, switches === 'on' ? 'current' : 'older'); result.after = await view(service); }
if (scenario === 'settled') result.prepared = JSON.parse(await readFile(state('prepared.json'), 'utf8'));
await service.dispose();
console.log(`RESULT ${JSON.stringify(result)}`);
process.exit(0);
