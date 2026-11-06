/** What the generation context hands the search-index build: the scoped job port, the switch and a way to get request-independent ports.
 * `background()` is only called when a build is submitted; the ports it returns stay valid after the request that started it ended.
 * The switch defaults on (DEFAULT_ON_SWITCHES, lib/runtime-config.js): `true` (what DSH's resolved config holds unless the learner's host
 * config says otherwise) always runs the build as a job, and refuses when no live session can own it; `false` keeps the original background run.
 * A config the host did not resolve has no value: then the build is a job where the host can admit one right now (a live agent and DSH's
 * jobs service), else the original background run (a preview, a host without jobs). */
export const retrievalRuntimePort = (context, background) => Object.freeze({
  enabled: () => {
    if (typeof context.jobs?.submit !== 'function') return false;
    const pilot = context.services.runtimePilot?.retrievalIndex;
    return pilot === true || (pilot !== false && canAdmit(context.services.jobExecutor));
  },
  jobs: context.jobs, background,
});

const canAdmit = executor => {
  if (!executor) return false;
  try { executor.assertAvailable?.(); return true; } catch { return false; }
};
