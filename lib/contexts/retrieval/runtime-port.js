/** What the generation context hands the search-index build: the scoped job port, the switch and a way to get request-independent ports.
 * `background()` is only called when a build is submitted; the ports it returns stay valid after the request that started it ended. */
export const retrievalRuntimePort = (context, background) => Object.freeze({
  enabled: () => context.services.runtimePilot?.retrievalIndex === true && typeof context.jobs?.submit === 'function',
  jobs: context.jobs, background,
});
