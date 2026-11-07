import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';

const OUTPUT_CAP = 65536, MAX_SETTLED = 512;
const unavailable = message => Object.assign(new Error(message), { code: 'executor-unavailable' });
const processWitness = Object.freeze({ pid: process.pid, host: `${process.platform}:${hostname()}`, instance: randomUUID() });
const handles = new Map();

function checkWitness(witness) {
  if (!witness || witness.host !== processWitness.host || !Number.isSafeInteger(witness.pid) || witness.pid <= 0)
    return { state: 'unknown', reason: 'incompatible-executor-witness' };
  if (witness.instance !== processWitness.instance) {
    try { process.kill(witness.pid, 0); }
    catch (error) { if (error.code === 'ESRCH') return { state: 'lost', reason: 'executor-process-exited' }; }
    return { state: 'unknown', reason: 'executor-process-unconfirmed' };
  }
  if (witness.pid !== process.pid) return { state: 'unknown', reason: 'executor-binding-unconfirmed' };
  return null;
}

function trimSettled() {
  if (handles.size <= MAX_SETTLED) return;
  for (const [id, entry] of handles) {
    if (handles.size <= MAX_SETTLED) break;
    if (['completed', 'failed', 'killed'].includes(entry.status)) handles.delete(id);
  }
}

/** Agent-less in-process executor for model-free definitions that opt in (`hostExecutor: true`).
 * Shares the process witness with `dshJobExecutor`; work ownership stays with `workOwner`. */
export function hostJobExecutor() {
  return Object.freeze({
    assertAvailable() {},
    witness: () => ({ ...processWitness }),
    inspect(ref, witness) {
      const mismatch = checkWitness(witness);
      if (mismatch) return mismatch;
      if (ref?.service !== 'study-host' || !ref.handleId) return { state: 'unknown', reason: 'executor-binding-unconfirmed' };
      const view = handles.get(ref.handleId);
      if (view?.id !== ref.handleId) return { state: 'unknown', reason: 'executor-lookup-unconfirmed' };
      if (['running', 'stopping'].includes(view.status)) return { state: 'alive', reason: 'host-executor-active' };
      if (['completed', 'failed', 'killed'].includes(view.status)) return { state: 'lost', reason: 'host-executor-settled' };
      return { state: 'unknown', reason: 'executor-lookup-unconfirmed' };
    },
    start({ kind, title, run, cancel }) {
      const id = randomUUID(), entry = { id, kind, label: title || kind, status: 'running', log: '', offset: 0 };
      handles.set(id, entry);
      let stopped = false;
      Promise.resolve().then(run).then(
        outcome => {
          entry.status = ['completed', 'failed', 'killed'].includes(outcome?.status)
            ? outcome.status
            : stopped ? 'killed' : 'completed';
          trimSettled();
        },
        () => { entry.status = stopped ? 'killed' : 'failed'; trimSettled(); },
      );
      return Object.freeze({
        service: 'study-host',
        id,
        stop(reason) {
          if (stopped) return undefined;
          stopped = true;
          if (entry.status === 'running') entry.status = 'stopping';
          return cancel?.(reason);
        },
        append(text) {
          const chunk = String(text ?? '');
          if (!chunk || !['running', 'stopping'].includes(entry.status)) return;
          entry.log += chunk;
          if (entry.log.length > OUTPUT_CAP) {
            const drop = entry.log.length - OUTPUT_CAP;
            entry.log = entry.log.slice(drop);
            entry.offset += drop;
          }
        },
        output(cursor = 0) {
          const from = Number.isFinite(cursor) && cursor > 0 ? Math.floor(cursor) : 0, end = entry.offset + entry.log.length;
          if (from >= end) return { text: '', cursor: end };
          return { text: entry.log.slice(Math.max(0, from - entry.offset)), cursor: end };
        },
      });
    },
  });
}

/** Default executor when no host `jobExecutor` is injected: admits only `allowHost: true` definitions. */
export function hostOnlyJobExecutor() {
  const host = hostJobExecutor();
  const assertAvailable = ({ allowHost = false } = {}) => {
    if (!allowHost) throw unavailable('A registered live Agent is required for runtime admission');
  };
  return Object.freeze({
    assertAvailable,
    witness: () => host.witness(),
    inspect: (ref, witness) => host.inspect(ref, witness),
    start({ allowHost = false, ...spec }) {
      assertAvailable({ allowHost });
      return host.start(spec);
    },
  });
}

/** DSH-01/03: admission and physical execution stay with the installed host.
 * Model-backed jobs require a registered live Agent; model-free `allowHost` jobs fall back to `hostJobExecutor`.
 */
export function dshJobExecutor(ctx, agent) {
  const host = hostJobExecutor();
  const service = key => { try { return ctx?.get?.(key); } catch { return undefined; } };
  const nativeReady = () => Boolean(agent && service('agents')?.get(agent.id) === agent && service('jobs')?.start);
  const assertNative = () => {
    if (!agent || service('agents')?.get(agent.id) !== agent) throw unavailable('A registered live Agent is required for runtime admission');
    if (!service('jobs')?.start) throw unavailable('DSH jobs unavailable');
  };
  const assertAvailable = ({ allowHost = false } = {}) => {
    if (nativeReady()) return;
    if (allowHost) { host.assertAvailable(); return; }
    assertNative();
  };
  return Object.freeze({ assertAvailable, ownerAgentId: agent?.id,
    witness: () => ({ ...processWitness }),
    inspect(ref, witness) {
      if (ref?.service === 'study-host') return host.inspect(ref, witness);
      const mismatch = checkWitness(witness);
      if (mismatch) return mismatch;
      if (ref?.service !== 'dsh-jobs' || !ref.handleId || !ref.ownerAgentId)
        return { state: 'unknown', reason: 'executor-binding-unconfirmed' };
      try {
        const view = service('jobs')?.get?.(ref.handleId, ref.ownerAgentId);
        if (view?.id !== ref.handleId || view.owner !== ref.ownerAgentId) return { state: 'unknown', reason: 'executor-identity-mismatch' };
        if (['running', 'stopping'].includes(view.status)) return { state: 'alive', reason: 'native-executor-active' };
        if (['completed', 'failed', 'killed'].includes(view.status)) return { state: 'lost', reason: 'native-executor-settled' };
      } catch { /* Unknown job/access/service failures are not proof of death. */ }
      return { state: 'unknown', reason: 'executor-lookup-unconfirmed' };
    },
    start({ kind, title, run, cancel, allowHost = false }) {
      if (!nativeReady()) {
        if (allowHost) return host.start({ kind, title, run, cancel });
        assertNative();
      }
      const jobs = service('jobs');
      // start is the authoritative native controller check. Never inspect private
      // host controller tables or install one on behalf of the caller.
      let face;
      const id = jobs.start({ owner: agent.id, kind, label: title || kind,
        run: handle => { face = handle; return { done: run(), cancel }; } });
      let stopped = false;
      return Object.freeze({ service: 'dsh-jobs', id, ownerAgentId: agent.id,
        stop(reason) { if (!stopped) { stopped = true; return jobs.kill(id, agent.id, reason); } },
        append: text => face.append(text),
        output: cursor => jobs.readAt(id, cursor, agent.id),
      });
    },
  });
}
