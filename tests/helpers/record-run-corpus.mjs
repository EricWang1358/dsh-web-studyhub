/* node tests/helpers/record-run-corpus.mjs: what tests/fixtures/generation-run-corpus.json was made with, once, from the run code of v4.1.0 (issue #608).
   Real coverage runs against a fake model, cut at each state a draft can be left in on a learner's disk, and the draft kept as it was written. The corpus stands for libraries already out
   there, so it is NOT recorded again when the code changes; this file is here to say how it was made, and to add a case by running it on old code. */
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { StudyService } from '../../lib/service.js';
import { clusteringModel } from './clustering-model.mjs';
import { mergedTranscript } from './merged-transcript.mjs';
import { managedRuntimeOptions } from './runtime-switch.mjs';
import { settleJob, until } from './wait.mjs';

export const corpusWorld = () => mergedTranscript({ recordings: 2, parts: 6, paragraphs: 4 });
export const CORPUS_ROUND_LIMIT = 8;
const world = corpusWorld(), ids = world.sources.map(source => source.id), PLAN = 'Plan a source-grounded assessment';
export const weighing = async (_system, prompt) => JSON.stringify({ sections: JSON.parse(prompt.split('\n\n')[0]).sections.map(item => ({ id: item.id, importance: 3, kind: 'definition', reason: `Reason for ${item.title}` })) });
const gate = () => { let open; const promise = new Promise(resolve => { open = resolve; }); return { promise, open, entered: false }; };

async function open(options = {}, modelFor) {
  const root = await mkdtemp(join(tmpdir(), 'study-corpus-record-')), service = new StudyService(root, { coverage: { roundLimit: CORPUS_ROUND_LIMIT }, ...options });
  service.light = weighing;
  service.complete = modelFor(service);
  for (const source of world.sources) await service.call('source.add', { id: source.id, title: source.title, text: source.text, audio: source.audio });
  return { root, service };
}
const close = async ({ root, service }) => { await service.dispose(); await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); };
const draftOf = async service => (await service.call('export')).drafts[0];
/** A model that holds the first plan of round `round` once the draft says that round is running. */
const heldAt = (hold, round, inner = clusteringModel().complete) => service => async (system, prompt, context = {}) => {
  if (!hold.entered && system.startsWith(PLAN) && (await draftOf(service))?.editorial.coverageSpec?.rounds[round - 1]?.status === 'running') { hold.entered = true; await hold.promise; }
  return inner(system, prompt, context);
};
const start = (service, extra = {}) => service.call('generate', { sourceIds: ids, coverageLevel: 'standard', kind: 'quiz', ...extra });
const strip = (value, ...keys) => Object.fromEntries(Object.entries(value).filter(([key]) => !keys.includes(key)));

async function record() {
  const drafts = {};
  { // 'running': the host stopped in round 2.
    const hold = gate(), lib = await open({}, heldAt(hold, 2)), { jobId } = await start(lib.service);
    await until(() => hold.entered, 'round 2');
    drafts.running = await draftOf(lib.service);
    await lib.service.call('job.control', { jobId, action: 'cancel' }); hold.open();
    const ended = await settleJob(lib.service, jobId);
    drafts['stopped-learner'] = await draftOf(lib.service);
    if (ended.status !== 'cancelled') throw new Error(`cancel ended as ${ended.status}`);
    await close(lib);
  }
  { // 'paused': the learner paused while the last call of round 1 was in flight, so the run stood at the boundary between rounds; then the host stopped.
    let calls = 0, roundOne = null, paused = false, jobId;
    const inner = clusteringModel().complete;
    const counted = service => async (system, prompt, context = {}) => {
      calls += 1;
      if (roundOne === null && (await draftOf(service))?.editorial.coverageSpec?.rounds[1]?.status === 'running') roundOne = calls - 1;
      return inner(system, prompt, context);
    };
    const count = await open({}, counted);
    await settleJob(count.service, (await start(count.service)).jobId);
    await close(count);
    const again = clusteringModel().complete;
    let asked = 0;
    const lib = await open({}, service => async (system, prompt, context = {}) => {
      asked += 1;
      if (asked === roundOne && !paused) { paused = true; await service.call('job.control', { jobId, action: 'pause' }); }
      return again(system, prompt, context);
    });
    ({ jobId } = await start(lib.service));
    await until(async () => (await draftOf(lib.service))?.editorial.coverageRun?.state === 'paused', 'the pause between rounds');
    drafts.paused = await draftOf(lib.service);
    await lib.service.call('job.control', { jobId, action: 'cancel' }); await settleJob(lib.service, jobId);
    await close(lib);
  }
  { // 'waiting': 自动补到完整 off, the first round done.
    const lib = await open({}, () => clusteringModel().complete), { jobId } = await start(lib.service, { autoComplete: false });
    await settleJob(lib.service, jobId); drafts.waiting = await draftOf(lib.service);
    await close(lib);
  }
  { // 'stopped' by a refused key in round 2: the run can go on once that is fixed.
    const inner = clusteringModel().complete, lib = await open({}, service => async (system, prompt, context = {}) => {
      if (system.startsWith(PLAN) && (await draftOf(service))?.editorial.coverageSpec?.rounds[1]?.status === 'running') throw Object.assign(new Error('401 Unauthorized: invalid api key'), { status: 401 });
      return inner(system, prompt, context);
    }), { jobId } = await start(lib.service);
    await settleJob(lib.service, jobId); drafts['stopped-refused'] = await draftOf(lib.service);
    await close(lib);
  }
  { // 'stopped' with sections left: a section the planner refuses every time.
    const lib = await open({}, () => clusteringModel({ refuse: request => request.sources.some(source => /part 2/.test(source.section?.title || source.text.slice(0, 200))) }).complete), { jobId } = await start(lib.service);
    await settleJob(lib.service, jobId); drafts['stopped-left'] = await draftOf(lib.service);
    await close(lib);
  }
  { // 'complete'.
    const lib = await open({}, () => clusteringModel().complete), { jobId } = await start(lib.service);
    await settleJob(lib.service, jobId); drafts.complete = await draftOf(lib.service);
    await close(lib);
  }
  // Shapes the code of today does not write but a library may hold.
  const clean = structuredClone(drafts.running), spec = clean.editorial.coverageSpec;
  drafts['old-no-round-fields'] = { ...structuredClone(clean), editorial: { ...clean.editorial, coverageSpec: { ...spec, rounds: spec.rounds.map(round => strip(round, 'status', 'askedKeys', 'triedKeys', 'unit', 'startedAt', 'finishedAt', 'planned', 'kept', 'covered', 'tokens', 'ms')) } } };
  drafts['no-marker'] = { ...structuredClone(clean), editorial: strip(clean.editorial, 'coverageRun') };
  drafts['unknown-state'] = { ...structuredClone(clean), editorial: { ...clean.editorial, coverageRun: { ...clean.editorial.coverageRun, state: 'something-new' } } };
  drafts['two-rounds-running'] = { ...structuredClone(clean), editorial: { ...clean.editorial, coverageSpec: { ...spec, rounds: spec.rounds.map(round => ({ ...round, status: 'running' })) } } };
  drafts.editing = { ...structuredClone(clean), editingDeckId: 'some-deck' };

  // A run kept on disk (`generationRestart`): its manifest and its draft, as the process left them.
  const hold = gate(), inner = clusteringModel().complete, host = () => { const { starts: _starts, ...options } = managedRuntimeOptions({ complete: (...args) => live(...args), paths: ['generation', 'generationRestart'] }); return options; };
  let live = inner;
  const lib = await open(host(), service => (live = heldAt(hold, 2, inner)(service), live));
  const { jobId } = await start(lib.service);
  await until(() => hold.entered, 'round 2 of the kept run');
  const directory = join(lib.root, 'generation-runs'), manifests = {};
  for (const name of await readdir(directory)) manifests[name] = JSON.parse(await readFile(join(directory, name), 'utf8'));
  const managed = { manifests, draft: await draftOf(lib.service) };
  await lib.service.call('job.control', { jobId, action: 'cancel' }); hold.open(); await settleJob(lib.service, jobId);
  await close(lib);

  const file = new URL('../fixtures/generation-run-corpus.json', import.meta.url);
  await writeFile(file, `${JSON.stringify({ recordedFrom: 'the run code of v4.1.0, by tests/helpers/record-run-corpus.mjs', drafts, managed })}\n`);
  return { drafts: Object.keys(drafts), manifests: Object.keys(manifests) };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) console.log(await record());
