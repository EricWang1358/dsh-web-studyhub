/* The executor that carries StudyHub's background work (generation, review books, transcription …) in the ZCode host.
   DSH runs those attempts in its own jobs service (lib/jobs/executor.js); an MCP server process has none, so they run in
   this process. The job registry, settling, archiving and the console stay the runtime's own; only where the work
   physically runs is here. Ported from BAXUIE's StudyHub for ZCode 0.4.8 (MIT).

   The honest cost: a job ends when ZCode quits (it stops this process). Its record stays in the library, and on the next
   start inspect() answers 'lost' for an attempt whose process is gone, so the runtime marks it interrupted and the
   console offers 接着做 (the reference port answered 'unknown', which left such a job blocked for good). */
import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';

export function inProcessExecutor({ pid = process.pid, host = `${process.platform}:${hostname()}`, alive = pidAlive, log = console.error } = {}) {
  const instance = randomUUID(), running = new Set();
  let started = 0;
  return Object.freeze({
    ownerAgentId: 'zcode-host',
    assertAvailable() {},
    witness: () => ({ pid, host, instance }),
    /** 'alive' while this process runs it; 'lost' once it settled here or its process is gone; 'unknown' when another live process may own it. */
    inspect(ref, witness) {
      if (!witness || witness.host !== host || !Number.isSafeInteger(witness.pid) || witness.pid <= 0)
        return { state: 'unknown', reason: 'incompatible-executor-witness' };
      if (witness.instance === instance)
        return ref?.handleId && running.has(ref.handleId) ? { state: 'alive', reason: 'in-process-active' } : { state: 'lost', reason: 'in-process-settled' };
      return alive(witness.pid) ? { state: 'unknown', reason: 'executor-process-unconfirmed' } : { state: 'lost', reason: 'executor-process-exited' };
    },
    start({ run, cancel }) {
      const id = `zcode-${instance.slice(0, 8)}-${(started += 1)}`;
      running.add(id);
      // Nothing above observes this promise (DSH's jobs service would); a rejection must at least reach the process log.
      void Promise.resolve().then(run).catch((error) => log(`[studyhub] background job ${id} rejected:`, error?.stack ?? error))
        .finally(() => running.delete(id));
      let stopped = false;
      return Object.freeze({ id, ownerAgentId: 'zcode-host',
        stop() { if (!stopped) { stopped = true; return cancel?.(); } },
        append() {}, output: () => ({}) });
    },
  });
}

function pidAlive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) { return error.code === 'EPERM'; }
}
