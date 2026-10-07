import { id } from '../../../util.js';
import { estimateRun } from '../../../token-estimate.js';
import { estimateCalls, planBuild } from './plan.js';
import { EXAM_BLUEPRINT_KIND } from './jobs/exam-blueprint-build.js';
import { REFUSALS } from './jobs/messages.js';

const refuse = (code, language) => Object.assign(new Error(REFUSALS[code](language)), { code });

/** The estimate of a planned build: its real prompts, priced like every other estimate (lib/token-estimate.js). No model, no Job. */
export const estimateOfPlan = plan => estimateRun('blueprint', { calls: estimateCalls(plan) });

/**
 * `generation.blueprint.build`: check the inputs (stage 0: no model, nothing started when it refuses), and with `estimate: true` price the build; otherwise hand it to the
 * unified runtime as one Job and answer with the id the learner and the tools know it by. Only reached behind `runtime.pilot.examBlueprint`; off, it refuses and does nothing.
 * `ports.read()` is the library as this context reads it; `ports.materials(action, payload)` is the materials context; `ports.runtime` is `{ jobs, pilot, sharedQuota }`.
 */
export function createBlueprintJobs(ports) {
  const { runtime, read, materials, work, activeJob } = ports;
  async function build(args = {}, request = {}) {
    const language = args.language === 'en' || request.language === 'en' ? 'en' : 'zh';
    if (runtime?.pilot?.examBlueprint !== true || !runtime.jobs) throw refuse('blueprint-disabled', language);
    const plan = planBuild(await read(), { ...args, language });
    if (args.estimate === true) return { status: 'estimate', estimate: estimateOfPlan(plan), steps: plan.steps, scopeHash: plan.scopeHash };
    // Calls of a Job are not yet observed against a shared provider quota: refuse instead of failing every call.
    if (runtime.sharedQuota) throw refuse('capability-unverified', language);
    const running = [...work.jobs.values()].find(job => job.type === EXAM_BLUEPRINT_KIND && activeJob(job) && job.scopeHash === plan.scopeHash);
    if (running) return { jobId: running.id, status: running.status, alreadyRunning: true };
    const input = { runId: id(), title: plan.title, language, scopeHash: plan.scopeHash, ...(plan.supersedes ? { supersedes: plan.supersedes } : {}) };
    const bindings = { blueprint: { plan, kept: { results: new Map(), resumable: false },
      resolve: selection => materials('materials.selection.resolve', selection, request),
      // The creation time is written here (the record itself is deterministic); the list it replaces is archived in the same write, and only then.
      ingest: async (record, replaces) => { await materials('materials.sources.ingest', { sources: [{ ...record, createdAt: new Date().toISOString() }], ...(replaces ? { archive: [replaces] } : {}) }, request); } } };
    try {
      const started = await runtime.jobs.submit(EXAM_BLUEPRINT_KIND, input, {}, bindings);
      return { jobId: started.runtime.legacyId, status: 'running', steps: plan.steps };
    } catch (error) {
      throw REFUSALS[error?.code] ? refuse(error.code, language) : error;
    }
  }
  return { 'generation.blueprint.build': build };
}
