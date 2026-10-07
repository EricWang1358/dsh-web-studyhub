import { id } from '../../../util.js';
import { failStep, unifyCall } from '../../../job-calls.js';
import { replyCounts } from '../../../call-counts.js';
import { withJobUsage } from '../../../usage-scope.js';
import { EFFORT_STAGES, effortKey } from '../../../stage-effort.js';
import { admitCall, pressureCause } from '../../../job-parallel.js';

/** How a generation run asks its model when it is NOT run by the runtime: the executor's own bookkeeping of every call
 * (a step on the card, the usage tally, the live output, the channel to a running worker) around the host model.
 * Same shape as gateway-model.js: `call(system, prompt, context)` for the pipeline's stages and `weigh` for section weights.
 * 要求并行 (lib/job-parallel.js): a call waits at its admission while its job is held in the queue, and a call that fails under pressure (a rate limit, an overload,
 * a timeout) tells `onPressure` BEFORE the error leaves this adapter, so the parallel jobs step back before the failing job's own back-off (lib/batch.js) begins. */
export function legacyModels({ job, control, performance, feature, ask, askLight, outputs, messengers, onPressure }) {
  const stageEffort = () => Object.fromEntries(EFFORT_STAGES.map(name => [name, control.values[effortKey(name)] ?? performance[effortKey(name)]]));
  const toMessenger = step => send => {
    if (send) {
      if (!messengers.has(job.id)) messengers.set(job.id, new Map());
      messengers.get(job.id).set(step.id, send);
    } else messengers.get(job.id)?.delete(step.id);
  };

  const pressed = (error, signal) => { if (!signal?.aborted && pressureCause(error)) onPressure?.(error); };

  async function call(system, prompt, { stage, part, kind, retry, slot, waitedMs, round, signal }) {
    await admitCall(job, signal);
    // `startedAt` is when the model call began; `queuedMs` is what it waited for a free slot before that (generation details show both).
    // A review asked again because its reply was unusable says so (`kind: 'review', retry: n`): the console shows it as a retry, and its tokens are counted like any call.
    const step = { id: id(), stage, part, status: 'starting', startedAt: new Date().toISOString(),
      ...(round !== undefined ? { round } : {}), ...(kind ? { kind } : {}), ...(retry > 0 ? { retry } : {}),
      ...(Number.isInteger(slot) ? { slot } : {}), ...(Number.isFinite(waitedMs) ? { queuedMs: Math.round(waitedMs) } : {}) };
    job.steps.push(step);
    outputs.open(job.id, step.id);
    try {
      const value = await withJobUsage(job, step, () => ask(system, prompt, {
        jobId: job.id, stage, signal,
        // The reasoning level of each stage, as the learner set it when the job was queued (relative; resolved per model).
        stageEffort: stageEffort(), resultOwner: 'plugin',
        onEvent: event => Object.assign(step, event),
        // What this call writes on the way (the console's 实时输出); the buffer lives as long as the call.
        onOutput: text => { step.firstOutputAt ??= new Date().toISOString(); outputs.append(job.id, step.id, text); },
        onReasoning: count => outputs.reasoning(job.id, step.id, count),
        setMessenger: toMessenger(step),
      }), { feature });
      signal.throwIfAborted();
      // What this call's reply says about the questions (written, reviewed and flagged, re-worded), kept on the step for the 任务 console's log.
      const counts = replyCounts(unifyCall(step).kind, value);
      if (counts) step.counts = counts;
      step.runtime ||= 'direct';
      step.status = 'complete';
      return value;
    } catch (error) { failStep(step, error); pressed(error, signal); throw error; }
    finally { messengers.get(job.id)?.delete(step.id); outputs.close(job.id, step.id); step.finishedAt = new Date().toISOString(); }
  }

  async function weigh(system, prompt, { stage, signal }) {
    await admitCall(job, signal);
    const step = { id: id(), stage, kind: 'plan', status: 'starting', startedAt: new Date().toISOString() };
    job.steps.push(step);
    try {
      signal.throwIfAborted();
      const value = await withJobUsage(job, step, () => askLight(system, prompt));
      step.runtime ||= 'direct';
      step.status = 'complete';
      return value;
    } catch (error) { failStep(step, error); throw error; }
    finally { step.finishedAt = new Date().toISOString(); }
  }

  return { call, weigh: askLight ? weigh : undefined };
}
