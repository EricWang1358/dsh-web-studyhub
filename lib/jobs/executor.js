import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';

const processWitness = Object.freeze({ pid: process.pid, host: `${process.platform}:${hostname()}`, instance: randomUUID() });

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
    witness: () => ({ ...processWitness }),
    inspect(ref, witness) {
      if (!witness || witness.host !== processWitness.host || !Number.isSafeInteger(witness.pid) || witness.pid <= 0)
        return { state: 'unknown', reason: 'incompatible-executor-witness' };
      if (witness.instance !== processWitness.instance) {
        try { process.kill(witness.pid, 0); }
        catch (error) { if (error.code === 'ESRCH') return { state: 'lost', reason: 'executor-process-exited' }; }
        return { state: 'unknown', reason: 'executor-process-unconfirmed' };
      }
      if (witness.pid !== process.pid || ref?.service !== 'dsh-jobs' || !ref.handleId || !ref.ownerAgentId)
        return { state: 'unknown', reason: 'executor-binding-unconfirmed' };
      try {
        const view = service('jobs')?.get?.(ref.handleId, ref.ownerAgentId);
        if (view?.id !== ref.handleId || view.owner !== ref.ownerAgentId) return { state: 'unknown', reason: 'executor-identity-mismatch' };
        if (['running', 'stopping'].includes(view.status)) return { state: 'alive', reason: 'native-executor-active' };
        if (['completed', 'failed', 'killed'].includes(view.status)) return { state: 'lost', reason: 'native-executor-settled' };
      } catch { /* Unknown job/access/service failures are not proof of death. */ }
      return { state: 'unknown', reason: 'executor-lookup-unconfirmed' };
    },
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
