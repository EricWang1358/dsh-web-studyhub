import { executeAudioJob } from '../../../audio-job.js';
import { MEMBER_STEP } from '../../../audio-batch-runtime-store.js';
import { admitSlot } from '../../../jobs/scheduler.js';
import { stageText } from '../../../audio-messages.js';

/** The gateway one member's pipeline sees: its steps are named after the file, so no two members share a step key. */
const memberGateway = (gateway, index) => Object.freeze({ ...gateway, step: (key, policy, options) => gateway.step(`${MEMBER_STEP}${index}:${key}`, policy, options) });

/**
 * One file of a batch, from the host's transcription slot to its committed result. Files take the slot one by one in submitted order
 * (the batch itself holds none), a finished result of an earlier attempt is reused, and a requested pause starts no further file.
 * What the batch shares with its files (settings, text pool, result list) is on `state`.
 */
export async function runBatchMember(context, state, { worker, work }, index) {
  const { record, view, settings, pools, results } = state, persistence = context.persistence;
  const member = record.members[index], progress = view.members[index];
  if (member.skipped) return;
  const reuse = saved => {
    results[index] = saved.result;
    Object.assign(progress, saved.progress, { id: view.id, index: member.index, filename: member.filename, reused: true });
    member.status = progress.status = 'complete';
  };
  if (member.status === 'complete') { const saved = await persistence.readMember(record, member); if (saved) return reuse(saved); }
  let touched = false;
  try {
    await admitSlot(work.audioGate, `${context.attemptId}-${index}`, AbortSignal.any([context.signal, context.pauseSignal]), async release => {
      context.signal.throwIfAborted();
      if (context.pauseRequested) return;
      // Look after admission, so asynchronous disk reads cannot reorder the files. A result may be complete even when its commit was not saved.
      const recovered = await persistence.readMember(record, member);
      touched = true;
      if (recovered) { context.signal.throwIfAborted(); return reuse(recovered); }
      Object.assign(progress, { id: view.id, language: view.language, status: 'running', phase: 'read', warnings: [], startedAt: new Date().toISOString() });
      results[index] = await executeAudioJob({ job: progress, args: { ...record.args, path: member.path, inputHash: member.hash }, settings, store: worker.audioStore || worker.store,
        complete: worker.complete, fetch: worker.fetch, signal: context.signal, publish: false, pools, releaseSlot: release, outputs: work.jobOutputs,
        gateway: memberGateway(context.gateway, index) });
      await context.commitArtifact(`${MEMBER_STEP}${index}`, async () => ({ batch: record, member, result: results[index], progress }), persistence.memberPublisher);
      member.status = progress.status = 'complete';
      progress.phase = 'done';
    });
  } catch (error) {
    touched = true;
    member.status = progress.status = context.signal.aborted ? 'cancelled' : 'failed';
    progress.stage = stageText(error);
    throw error;
  } finally {
    if (touched) {
      member.progress = progress;
      progress.finishedAt = new Date().toISOString();
      await persistence.saveMembers(record);
    }
  }
}
