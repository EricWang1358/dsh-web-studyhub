/** What the generation context hands the search-index build: the scoped job port, the switch and a way to get request-independent ports.
 * `background()` is only called when a build is submitted; the ports it returns stay valid after the request that started it ended.
 * The switch defaults on (DEFAULT_ON_SWITCHES, lib/runtime-config.js). On (`true`, what DSH's resolved config holds, or no value at all),
 * the build runs as a `retrieval-index` job on the live session's executor or the agent-less host executor (`allowHost: true`), even before a
 * conversation's agent is resumed; only an explicit `false` (or an injected executor that refuses host admission) uses the original background run. */
export const retrievalRuntimePort = (context, background) => Object.freeze({
  enabled: () => {
    if (typeof context.jobs?.submit !== 'function') return false;
    const pilot = context.services.runtimePilot?.retrievalIndex;
    return pilot !== false && canAdmit(context.services.jobExecutor);
  },
  jobs: context.jobs, background,
});

const canAdmit = executor => {
  try { executor?.assertAvailable?.({ allowHost: true }); return true; } catch { return false; }
};
