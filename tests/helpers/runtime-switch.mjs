// One place for "run this service test with the unified runtime switched on".
// A controlled native executor and model host stand in for DSH; no provider is reachable.

/** Service options that route new submissions of `paths` through the runtime. */
export function managedRuntimeOptions({ complete, paths = ['audioSingle'], owner = Symbol('controlled-runtime-owner'), inspect, host } = {}) {
  let starts = 0;
  const jobExecutor = {
    assertAvailable() {},
    witness: () => ({ pid: process.pid, host: 'fixture', instance: 'controlled' }),
    inspect: inspect || (() => ({ state: 'lost', reason: 'controlled' })),
    start({ run, cancel }) { void run(); return { id: `controlled-${++starts}`, ownerAgentId: 'controlled-owner', stop: cancel, append() {} }; },
  };
  const runtimePilot = Object.fromEntries(paths.map(path => [path, true]));
  return { runtimePilot, workOwner: owner, jobExecutor, jobModelHost: { ctx: host?.ctx ?? {}, ...(host ? { sessionId: 'parent' } : {}), route: { provider: 'fixture', model: 'fixture' }, complete }, starts: () => starts };
}

/** The side a characterization suite runs on. A `<suite>.runtime.test.mjs` twin sets
 * STUDY_RUNTIME_SWITCH=runtime and imports the suite, so one suite covers both sides. */
export const SWITCH_MODE = process.env.STUDY_RUNTIME_SWITCH === 'runtime' ? 'runtime' : 'legacy';

/** A `<suite>.parallel.test.mjs` twin sets STUDY_TRANSLATION_PARALLEL=1: the same suite with translations no longer behind the library's generation (S4-3). */
export const TRANSLATION_PARALLEL = process.env.STUDY_TRANSLATION_PARALLEL === '1';

/** Both sides of a migration switch, for `for (const mode of SWITCH_MODES)` test loops. */
export const SWITCH_MODES = Object.freeze(['legacy', 'runtime']);

/** Extra StudyService options for one side of the switch. */
export function switchOptions(mode, { complete, paths = ['audioSingle'], host } = {}) {
  const parallel = TRANSLATION_PARALLEL ? { translationParallel: true } : {};
  if (mode === 'legacy') return TRANSLATION_PARALLEL ? { runtimePilot: parallel } : {};
  // A twin that also turns a family's follow-up switch on names it in STUDY_RUNTIME_PATHS (e.g. "generationRestart").
  const more = (process.env.STUDY_RUNTIME_PATHS || '').split(',').filter(Boolean);
  const { starts: _starts, ...options } = managedRuntimeOptions({ complete, paths: [...new Set([...paths, ...more])], host });
  return { ...options, runtimePilot: { ...options.runtimePilot, ...parallel } };
}
