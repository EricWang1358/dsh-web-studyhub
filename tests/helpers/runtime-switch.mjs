// One place for "run this service test with the unified runtime switched on".
// A controlled native executor and model host stand in for DSH; no provider is reachable.

/** Service options that route new submissions of `paths` through the runtime. */
export function managedRuntimeOptions({ complete, paths = ['audioSingle'], owner = Symbol('controlled-runtime-owner'), inspect } = {}) {
  let starts = 0;
  const jobExecutor = {
    assertAvailable() {},
    witness: () => ({ pid: process.pid, host: 'fixture', instance: 'controlled' }),
    inspect: inspect || (() => ({ state: 'lost', reason: 'controlled' })),
    start({ run, cancel }) { void run(); return { id: `controlled-${++starts}`, ownerAgentId: 'controlled-owner', stop: cancel, append() {} }; },
  };
  const runtimePilot = Object.fromEntries(paths.map(path => [path, true]));
  return { runtimePilot, workOwner: owner, jobExecutor, jobModelHost: { ctx: {}, route: { provider: 'fixture', model: 'fixture' }, complete }, starts: () => starts };
}

/** Both sides of a migration switch, for `for (const mode of SWITCH_MODES)` test loops. */
export const SWITCH_MODES = Object.freeze(['legacy', 'runtime']);

/** Extra StudyService options for one side of the switch. */
export function switchOptions(mode, { complete, paths } = {}) {
  if (mode === 'legacy') return {};
  const { starts: _starts, ...options } = managedRuntimeOptions({ complete, paths });
  return options;
}
