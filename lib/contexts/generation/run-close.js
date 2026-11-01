/* A coverage run whose host stopped with nothing left to ask by section: every section has its question, and at most the closing write of the draft was lost. 接着做 has nothing to ask a model, and it must not be
   refused either (the job would stay interrupted for ever, with a button that never works), so the run is closed: one write of the draft, no model call. Like supplement-resume.js, a task of its own for that one step.
   A run cut in its last round can be short of its goal: the goal stays, the same number the interrupted card showed. The draft's `requested` becomes the goal, which is what lib/draft-continuation.js
   counts, so the 接着做 of a short draft asks for exactly what is missing. */
import { get, id } from '../../util.js';
import { recordEvent } from '../../job-calls.js';
import { coverageForDraft } from '../../coverage-state.js';
import { STOP_REASONS, roundList } from '../../coverage-run.js';
import { mirrorOf, restoredJob, runStageText } from './coverage-runs.js';
import { closeRun, isOpenRun } from './run-state.js';

export function createRunClose(ports, { env }) {
  const { state: storagePort, call, language } = ports, { generationControllers, generationMessengers, jobControls, jobOutputs } = ports.work;
  const say = (zh, en) => language === 'en' ? en : zh;

  /** The task that closes the run of `draft`, or null when something is still to be done (or the run is not open: a closed plan is refused as ever). */
  function taskFor({ args, draft, state }) {
    const { coverageRun: marker, coverageSpec: spec } = draft.editorial;
    if (!isOpenRun(marker) || !closeRun({ marker, spec }, coverageForDraft(state, draft), { jobId: marker.jobId, kept: draft.cards.length })) return null;
    const round = roundList(spec).at(-1).round, now = new Date().toISOString();
    const { finishedAt: _finishedAt, retryable: _retryable, ...card } = restoredJob({ draft, spec, marker, round }, { root: storagePort.root, language, say, newId: id, now });
    const seed = { ...card, id: id(), status: 'running', stage: 'Closing the run', startedAt: now };
    // `runId`: what the run is called across Attempts. Every save of a run's draft says it, the closing one too: a retry and a look after a restart find the draft by it (jobs/resume-args.js, jobs/recover-plan.js).
    const execute = async ({ job, controller, runId = job.id, checkpoint }) => {
      job.status = 'running';
      job.runStartedAt ??= new Date().toISOString();
      try {
        controller.signal.throwIfAborted();
        const latest = await storagePort.read(), current = get(latest.drafts, draft.id, 'Draft');
        const closed = closeRun({ marker: current.editorial.coverageRun, spec: current.editorial.coverageSpec }, coverageForDraft(latest, current), { jobId: job.id, at: new Date().toISOString(), kept: current.cards.length });
        if (!closed) throw new Error(say('资料或草稿已变化，请刷新后再试', 'The material or the draft changed; refresh and try again'));
        const { reason } = closed.marker.stop, { ok, level } = STOP_REASONS[reason];
        const editorial = { ...current.editorial, generation: { ...current.editorial.generation, runId }, coverageSpec: closed.spec, coverageRun: closed.marker, ...(ok ? {} : { requested: closed.spec.goal }) };
        const saved = await call('draft.save', { deck: { ...current, editorial }, requireExisting: true });
        await checkpoint?.(saved);
        recordEvent(job, { level, code: 'run-stop', args: { reason, round: closed.marker.stop.round } });
        Object.assign(job, { savedCount: saved.cards.length, ...(ok ? { requestedTotal: saved.cards.length } : {}), coverageRun: mirrorOf(closed.spec, closed.marker, { draftId: saved.id }), status: 'complete' });
        job.stage = runStageText({ reason }, { round: closed.marker.stop.round, spec: closed.spec }, job);
      } catch (error) {
        job.status = controller.signal.aborted && job.cancelRequestedAt ? 'cancelled' : 'failed';
        job.stage = controller.signal.aborted ? controller.signal.reason.message : error.message;
      } finally {
        generationControllers.delete(job.id);
        generationMessengers.delete(job.id);
        jobControls.delete(job.id);
        jobOutputs.endJob(job.id);
        job.finishedAt = new Date().toISOString();
        if (!env.managed) ports.announceJob(job);
      }
    };
    return { kind: 'generation', args, root: storagePort.root, seed, execute, models: { performance: {}, feature: env.feature } };
  }
  return { taskFor };
}
