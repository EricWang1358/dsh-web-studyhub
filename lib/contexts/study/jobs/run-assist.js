import { ASSIST_KIND } from './assist.js';

/** Submit one assistant request as a Job of this context, stop it when the assistant stops it, and answer how it ended. */
export async function runAssistJob(context, { input, work, controller, outputs }) {
  const resultBox = {};
  const receipt = await context.jobs.submit(ASSIST_KIND, { job: input }, {}, { work, controller, outputs, resultBox });
  const cancel = () => context.jobs.control(receipt.jobId, 'cancel').catch(() => {});
  if (controller.signal.aborted) cancel(); else controller.signal.addEventListener('abort', cancel, { once: true });
  const ended = await context.jobs.wait(receipt.jobId);
  const childCall = [...(ended.calls || [])].reverse().find(call => typeof call?.childId === 'string' && call.childId);
  return {
    status: ended.status,
    error: ended.error,
    message: ended.detail.legacy?.message ?? '',
    jobId: ended.runtime?.legacyId ?? ended.jobId,
    ...(resultBox.outcome ? { outcome: resultBox.outcome } : {}),
    ...(resultBox.cardId ? { cardId: resultBox.cardId } : {}),
    ...(childCall?.childId ? { childId: childCall.childId } : {}),
    ...(ended.execution?.mode ? { executionMode: ended.execution.mode } : {}),
  };
}
