import { GENERATION_FIELDS, presentGeneration } from './generation-view.js';
import { gatewayModels } from './gateway-model.js';
import { controlAdapter, linkedController, outcomeOf } from './attempt.js';
import { checkpointOf } from './checkpoint-ref.js';
import { JOB_TITLES } from './messages.js';

/* A question run, and a top-up that publishes into its deck, as jobs of the unified runtime. The runtime owns the identity, the queue turn, the
   lifecycle, every model call and the usage; the executor the entry point hands over (operations.js) still decides what a run does. Attempt-local
   state lives on the admission lease; the bindings are only read.
   A run can be tried again (`retry`): the new Attempt does not repeat the old closure, it prepares the request again from its saved arguments
   (binding.prepare), which continues the draft the earlier Attempt left (the draft is the checkpoint). When the family's restart switch is on
   (binding.runs), the arguments and the runtime's record are kept on disk, so the same applies after the process was restarted. */

const CAPABILITIES = Object.freeze({ cancel: true, set: true, retry: true, pauseMode: 'unsupported', recoveryMode: 'retry-from-start', executionModes: ['direct', 'subagent'] });
// The prepared run an entry point handed over is for the first Attempt only: later Attempts prepare their own.
const handedOver = new WeakSet();

/** The run this Attempt executes: the one the entry point prepared, or - for a retry or after a restart - one prepared again from the saved arguments. */
async function preparedFor(context, input, { task, prepare }) {
  if (task && !handedOver.has(task)) { handedOver.add(task); return task; }
  return prepare({ kind: input.kind, args: input.args, runId: context.jobId });
}

/** Wait for this library's turn. The card is presentable (and its live settings adjustable) from the moment the job is queued. */
async function admit(context, input, binding) {
  const task = await preparedFor(context, input, binding);
  const view = structuredClone(task.seed), reader = presentGeneration(view);
  context.present(reader);
  const control = task.makeControl(view);
  context.controls(controlAdapter(control));
  const turn = binding.queue.enter(binding.root, context.signal);
  await turn.admitted;
  return { finish: turn.leave, state: { task, view, control, reader } };
}

async function run(context, _input, binding) {
  const { task, view, control, reader } = context.admission.state;
  const record = binding.work.jobs.get(view.id);
  const controller = linkedController(context.signal, view, record);
  // `job.message` pushes onto the record it finds in the job table; the executor reads the same list.
  if (record) record.messages = view.messages;
  binding.work.generationControllers.set(view.id, controller);
  const refresh = () => { try { context.present(reader); } catch { /* the Attempt is over: nothing is left to show */ } };
  const models = gatewayModels({ ...task.models, outputs: binding.work.jobOutputs, gateway: context.gateway, control, jobId: () => view.id, refresh });
  // Durable runs keep the draft they just saved as their checkpoint (what a later Attempt must find unchanged).
  const checkpoint = binding.runs ? async draft => { refresh(); await context.saveCheckpoint(checkpointOf(draft)); } : undefined;
  await task.execute({ job: view, control, controller, models, runId: context.jobId, checkpoint });
  return outcomeOf(view);
}

const define = kind => ({ kind, version: 1, title: JOB_TITLES[kind], legacyFields: GENERATION_FIELDS, capabilities: CAPABILITIES, admit, run,
  // A submission that is not durable (the restart switch is off) is declined: an ordinary in-process job.
  persistence: { open: (input, binding) => (binding.runs ? binding.runs.open(input) : null) } });
export const generationDefinition = define('generation');
export const supplementDefinition = define('supplement');
/** "<kind>@<version>" of a definition: the part of a frozen input (input-ref.js) that says which code made the checkpoint. */
export const definitionRef = kind => `${kind}@${{ generation: generationDefinition, supplement: supplementDefinition }[kind].version}`;
