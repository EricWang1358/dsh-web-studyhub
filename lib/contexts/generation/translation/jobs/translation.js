import { controlAdapter, outcomeOf } from '../../jobs/attempt.js';
import { setTimeout as delay } from 'node:timers/promises';
import { gatewayModels } from '../../jobs/gateway-model.js';
import { outsideUsageScope } from '../../../../usage-scope.js';
import { TRANSLATION_FIELDS, presentTranslation } from './translation-view.js';
import { linkedStop } from './linked-stop.js';

export const TRANSLATION_KIND = 'translation';
/* A page or chapter translation as a job of the unified runtime. Pausing is real: at a wave boundary the Attempt ends with its waves kept and a resume is a
   new Attempt that asks what is still to do. The queue turn, the lifecycle, every model call (a Step of the gateway: agent-preferred, as the generation
   path always asked a child when the host had one) and the usage are the runtime's; the waves are the executor's (translate/waves.js). Attempt-local
   state lives on the admission lease; the bindings are only read. */
const CAPABILITIES = Object.freeze({ cancel: true, set: true, retry: false, pauseMode: 'checkpoint', recoveryMode: 'none', executionModes: ['direct', 'subagent'] });

/** Wait for this library's turn (a pause or a stop while waiting leaves the queue). The card is presentable, and its live settings adjustable, from the moment it is queued. */
async function admit(context, _input, { task }) {
  const view = structuredClone(task.seed), reader = presentTranslation(view);
  context.present(reader);
  const control = task.makeControl(view);
  context.controls(controlAdapter(control));
  const turn = task.queue.enter(task.root, AbortSignal.any([context.signal, context.pauseSignal]));
  try { await turn.admitted; }
  catch (error) {
    if (context.pauseRequested && !context.signal.aborted) context.checkpoint('queued');
    if (context.signal.aborted) await task.cancelBeforeStart(view, control);
    throw error;
  }
  // After a pause the paragraphs kept so far are not asked again: what is still to do is planned anew and counted as done.
  let todo = task.todo;
  if (context.checkpointRef) {
    todo = await task.replan();
    view.done = Math.max(0, view.total - todo.length); view.translated = view.done; view.reused = 0; view.rejected = 0; view.savedCount = view.done;
  }
  return { finish: turn.leave, state: { view, control, reader, todo } };
}

async function run(context, _input, { task }) {
  const { view, control, reader, todo } = context.admission.state;
  const record = task.work.jobs.get(view.id);
  const controller = linkedStop(context.signal, view, record);
  task.work.generationControllers.set(view.id, controller);
  const refresh = () => { try { context.present(reader); } catch { /* the Attempt is over: nothing is left to show */ } };
  const models = gatewayModels({ gateway: context.gateway, control, performance: {}, feature: task.feature, outputs: task.work.jobOutputs, jobId: () => view.id, refresh });
  // The translate operation tallies what its model reports for the ledger; the gateway books this call, so the call is made outside that tally.
  const ask = (system, prompt, { stage, part } = {}) => outsideUsageScope(() => models.call(system, prompt, { stage, part, kind: 'translate', signal: controller.signal }));
  // A back-off the provider's rate limit asked for is a Call of this Job (a local wait: no request), so the console draws it like any other family's.
  const backOff = ({ ms, slot, key, signal }) => {
    const step = context.gateway.step(key, { purpose: 'wait', feature: task.feature, budget: null }, { labels: { slot }, signal });
    const wait = stopped => delay(ms, undefined, { signal: AbortSignal.any([stopped, signal]) });
    return step.run(() => step.observe({ boundary: 'local-wait', kind: 'wait', reason: 'rate-limit' }, wait));
  };
  await task.execute({ job: view, control, controller, ask, todo, backOff, beforeWave: at => context.checkpoint(`wave:${at}`) });
  return outcomeOf(view);
}

export const translationDefinition = { kind: TRANSLATION_KIND, version: 1, title: 'Translation', legacyFields: TRANSLATION_FIELDS, capabilities: CAPABILITIES, admit, run };
