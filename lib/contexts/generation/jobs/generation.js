import { GENERATION_FIELDS, presentGeneration } from './generation-view.js';
import { gatewayModels } from './gateway-model.js';
import { controlAdapter, linkedController, outcomeOf } from './attempt.js';
import { JOB_TITLES } from './messages.js';

/* A question run, and a top-up that publishes into its deck, as jobs of the unified runtime. Nothing is retried, paused or recovered here yet
   (S3-2 and later): the runtime owns the identity, the queue turn, the lifecycle, every model call and the usage; the executor the entry point
   hands over (operations.js) still decides what a run does. Attempt-local state lives on the admission lease; the bindings are only read. */

const CAPABILITIES = Object.freeze({ cancel: true, set: true, retry: false, pauseMode: 'unsupported', recoveryMode: 'none', executionModes: ['direct', 'subagent'] });

/** Wait for this library's turn. The card is presentable (and its live settings adjustable) from the moment the job is queued. */
async function admit(context, _input, { task }) {
  const view = structuredClone(task.seed), reader = presentGeneration(view);
  context.present(reader);
  const control = task.makeControl(view);
  context.controls(controlAdapter(control));
  const turn = task.queue.enter(task.root, context.signal);
  await turn.admitted;
  return { finish: turn.leave, state: { view, control, reader } };
}

async function run(context, _input, { task }) {
  const { view, control, reader } = context.admission.state;
  const record = task.work.jobs.get(view.id);
  const controller = linkedController(context.signal, view, record);
  // `job.message` pushes onto the record it finds in the job table; the executor reads the same list.
  if (record) record.messages = view.messages;
  task.work.generationControllers.set(view.id, controller);
  const refresh = () => { try { context.present(reader); } catch { /* the Attempt is over: nothing is left to show */ } };
  const models = gatewayModels({ ...task.models, outputs: task.work.jobOutputs, gateway: context.gateway, control, jobId: () => view.id, refresh });
  await task.execute({ job: view, control, controller, models });
  return outcomeOf(view);
}

const define = kind => ({ kind, version: 1, title: JOB_TITLES[kind], legacyFields: GENERATION_FIELDS, capabilities: CAPABILITIES, admit, run });
export const generationDefinition = define('generation');
export const supplementDefinition = define('supplement');
/** "<kind>@<version>" of a definition: the part of a frozen input (input-ref.js) that says which code made the checkpoint. */
export const definitionRef = kind => `${kind}@${{ generation: generationDefinition, supplement: supplementDefinition }[kind].version}`;
