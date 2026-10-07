// Run ANY suite with a family's new submissions routed through the unified runtime, without editing the suite:
//   STUDY_RUNTIME_MATRIX=generation node --import ./scripts/qa/test-network.mjs --import ./tests/helpers/runtime-matrix-preload.mjs --test tests/<suite>.test.mjs
// A controlled native executor and model host stand in for DSH (tests/helpers/runtime-switch.mjs); the suite's own `complete` is the model.
// This is how the red list of a migration step is produced; a suite that should stay green on both sides gets a `<suite>.runtime.test.mjs` twin instead.
import { StudyRuntime } from '../../lib/runtime.js';
import { managedRuntimeOptions } from './runtime-switch.mjs';

const family = process.env.STUDY_RUNTIME_MATRIX;
const PILOT_PATHS = { generation: ['generation'], generationRestart: ['generation', 'generationRestart'], generationRepair: ['generation', 'generationRepair'],
  generationRepairRestart: ['generation', 'generationRepair', 'generationRestart'],
  generationPublish: ['generation', 'generationPublish'], generationPublishRestart: ['generation', 'generationPublish', 'generationRestart'], audio: ['audioSingle'] };
const made = new WeakMap(), invoke = StudyRuntime.prototype.invoke;

StudyRuntime.prototype.invoke = function (api, name, args = {}, requestServices = {}) {
  if (!PILOT_PATHS[family] || !requestServices.complete) return invoke.call(this, api, name, args, requestServices);
  if (!made.has(this)) made.set(this, managedRuntimeOptions({ paths: PILOT_PATHS[family] }));
  const { starts: _starts, jobModelHost, ...managed } = made.get(this);
  return invoke.call(this, api, name, args, { ...requestServices, ...managed, workOwner: requestServices.workOwner || managed.workOwner,
    jobModelHost: { ...jobModelHost, complete: requestServices.complete } });
};
