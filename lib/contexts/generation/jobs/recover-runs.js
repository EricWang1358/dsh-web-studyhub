import { RUN_RECORD_WINDOW_MS } from '../../../generation-limits.js';

// What the last process left on disk is looked at once per runtime (the console reads the job list all the time); `scanned` is that memory.
const scanned = new WeakSet();
const LIVE = ['queued', 'running', 'pausing', 'cancelling', 'interrupted'];

/** Bring back the runs the last process left unfinished: each becomes the same logical job again (interrupted, with its retry), and nothing is asked of a
 * model by itself. A run that ended, or is older than the window, leaves nothing behind. `restore(run)` is the runtime's own restore. */
export async function recoverRuns({ runs, restore, memory, now = Date.now() }) {
  if (scanned.has(memory)) return 0;
  scanned.add(memory);
  let restored = 0;
  for (const run of await runs.scan()) {
    const stale = now - run.at > RUN_RECORD_WINDOW_MS;
    if (!LIVE.includes(run.status) || stale) { await runs.forget(run.id); continue; }
    try { await restore(run); restored++; } catch { /* a record that cannot be restored stays on disk for the next process to try */ }
  }
  return restored;
}
