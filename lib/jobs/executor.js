/** DSH-01/03: admission and physical execution stay with the installed host.
 * No Agent creation, controller installation, unowned fallback or host polling.
 */
export function dshJobExecutor(ctx, agent) {
  const service = key => { try { return ctx?.get?.(key); } catch { return undefined; } };
  const assertAvailable = () => {
    if (!agent || service('agents')?.get(agent.id) !== agent) throw new Error('A registered live Agent is required for runtime admission');
    if (!service('jobs')?.start) throw new Error('DSH jobs unavailable');
  };
  return Object.freeze({ assertAvailable, ownerAgentId: agent?.id,
    start({ kind, title, run, cancel }) {
      assertAvailable();
      const jobs = service('jobs');
      // start is the authoritative native controller check. Never inspect private
      // host controller tables or install one on behalf of the caller.
      let face;
      const id = jobs.start({ owner: agent.id, kind, label: title || kind,
        run: handle => { face = handle; return { done: run(), cancel }; } });
      let stopped = false;
      return Object.freeze({ id, ownerAgentId: agent.id,
        stop(reason) { if (!stopped) { stopped = true; return jobs.kill(id, agent.id, reason); } },
        append: text => face.append(text),
        output: cursor => jobs.readAt(id, cursor, agent.id),
      });
    },
  });
}
