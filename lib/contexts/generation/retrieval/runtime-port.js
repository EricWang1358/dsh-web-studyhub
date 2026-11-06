/** What the generation context hands the search-index build: the scoped job port, the switch and a way to get request-independent ports.
 * `background()` is only called when a build is submitted; the ports it returns stay valid after the request that started it ended.
 * The switch defaults on (DEFAULT_ON_SWITCHES, lib/runtime-config.js). On (`true`, what DSH's resolved config holds, or no value at all),
 * the build is a job where the host can admit one right now (a live agent and DSH's jobs service), else the original background run: after a
 * DSH restart the panel's request has no live agent until the conversation's agent is resumed, and a build is never refused for that.
 * `false` keeps the original background run. */
export const retrievalRuntimePort = (context, background) => Object.freeze({
  enabled: () => {
    if (typeof context.jobs?.submit !== 'function') return false;
    const pilot = context.services.runtimePilot?.retrievalIndex;
    return pilot !== false && canAdmit(context.services.jobExecutor);
  },
  jobs: context.jobs, background,
});

const canAdmit = executor => {
  if (!executor) return false;
  try { executor.assertAvailable?.(); return true; } catch { return false; }
};
