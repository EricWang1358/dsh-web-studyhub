import { cp, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StudyService } from '../../lib/service.js';
import { Store } from '../../lib/store.js';
import { settleJob, until } from './wait.mjs';
import { authored, qualityPlan, qualityBlueprint, qualityReview } from './assessment.mjs';

/* Shared fixtures of the S3-0 generation-family baseline (docs/plans/unified-job-runtime/s3-0-generation-baseline.md): fake models only.
   A "crash" is a copy of the library folder while a model call is held; a "restart" is a new service over that copy, which is all a restarted host has. */

export const gate = () => { let open; const promise = new Promise(resolve => { open = resolve; }); return { promise, open, entered: false }; };

/** A model wrapper that holds the first call `when(system, prompt, context)` accepts until the gate is opened. */
export const holding = (hold, when = () => true) => complete => async (system, prompt, context = {}) => {
  if (!hold.entered && when(system, prompt, context)) { hold.entered = true; await hold.promise; }
  return complete(system, prompt, context);
};

/** A library folder removed with its service (a held gate is opened, the service disposed, then the folder removed). */
export async function openLibrary(t, { prefix = 'study-s30-', model, options = {}, hold } = {}) {
  const root = await mkdtemp(join(tmpdir(), prefix));
  const service = new StudyService(root, options);
  if (model) service.complete = model;
  t.after(async () => { hold?.open(); await service.dispose(); await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });
  return { root, service };
}

/** A crash leaves the last committed library on disk. The source host is still writing, so copy
 * until the copy reads back without missing or damaged shards (temp files are never durable state). */
async function consistentCopy(root, copy) {
  for (let attempt = 1; ; attempt++) {
    try {
      await cp(root, copy, { recursive: true, force: true, filter: source => !source.endsWith('.tmp') });
      if (!(await new Store(copy).load()).storageIssues?.length) return;
    } catch (error) { if (attempt >= 20) throw error; }
    if (attempt >= 20) throw new Error('no consistent library snapshot after 20 copies');
    await rm(copy, { recursive: true, force: true }); await new Promise(resolve => setTimeout(resolve, 25));
  }
}

/** What a restarted host has: the folder as it is on disk now, a new service, and a model that records and refuses every call (a restart never asks one by itself). */
export async function restartedOver(t, root) {
  const copy = await mkdtemp(join(tmpdir(), 'study-s30-restart-')), calls = [];
  await consistentCopy(root, copy);
  const service = new StudyService(copy);
  service.complete = async (system) => { calls.push(String(system).slice(0, 40)); throw new Error('a restart must not call a model by itself'); };
  t.after(async () => { await service.dispose(); await rm(copy, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });
  return { service, root: copy, calls };
}

/** The jobs a snapshot lists (the snapshot also runs coverage.recover, the only restart restoration of a generation job). */
export const jobsOf = async service => (await service.call('snapshot')).jobs;

/** A wait that fails in seconds, not minutes, when the thing never happens. */
export const soon = (condition, what) => until(condition, what, { timeoutMs: 20_000 });

/** Open the gate and let the original (pre-crash) job finish, so its folder is quiet before the after-hooks remove it. */
export async function finish(service, hold, jobId) { hold.open(); return settleJob(service, jobId); }

/** A fake model for the four stages (plan, blueprint, author, review) of any source: one stage can be held (`holdAt`), every call is logged by stage and the job ids are listed in the order they first called. */
export function stagedModel({ holdAt, hold } = {}) {
  const log = [], jobs = [];
  const complete = async (system, prompt, options = {}) => {
    const stage = system.startsWith('Plan a source-grounded') ? 'plan' : system.startsWith('Prepare supported answers') ? 'blueprint' : system.startsWith('Act as a strict') ? 'review' : 'author';
    log.push(stage);
    if (options.jobId && !jobs.includes(options.jobId)) jobs.push(options.jobId);
    if (stage === holdAt && hold && !hold.entered) { hold.entered = true; await hold.promise; }
    options.signal?.throwIfAborted();
    if (stage === 'plan') return JSON.stringify(qualityPlan(JSON.parse(prompt.split('REQUEST DATA:\n')[1])));
    if (stage === 'review') { const candidate = JSON.parse(prompt).candidate; return JSON.stringify(qualityReview(candidate, [])); }
    const data = JSON.parse(prompt.split('REQUEST DATA:\n')[1]), source = data.sources[0];
    const cards = Array.from({ length: stage === 'blueprint' ? data.assessmentPlan.targets.length : data.count }, (_, index) => ({ id: `q${index + 1}`, kind: 'flashcard', topic: `Topic ${index}`,
      objective: `Explain angle ${index} of ${source.text.slice(0, 20)}`, prompt: `Why does angle ${index} matter for ${source.text.slice(0, 18).toLowerCase()} decisions?`, answer: `Angle ${index} constrains later choices.`,
      hint: 'Compare a description with a rule for permitted changes.', explanation: `The evidence ties angle ${index} to design and later change, so it constrains the choices made afterwards.`,
      misconception: 'It only names existing parts.', citations: [{ sourceId: source.id, quote: source.text.slice(0, 40) }] }));
    const deck = { title: 'Selection', cards };
    return JSON.stringify(stage === 'blueprint' ? qualityBlueprint(data, data.assessmentPlan, deck) : authored(deck, [], data.assessmentPlan));
  };
  return { complete, log, jobs };
}
