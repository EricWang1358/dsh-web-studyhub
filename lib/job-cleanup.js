import { rm } from 'node:fs/promises';
import { removeAudioBatch, retireAudioBatch } from './audio-batch.js';

/* Background file cleanup for dismissed jobs. dismissBatch() resolves once the job's files are out of the way
   (renamed to a retired name that no restart will resume); the slow recursive deletion continues afterwards,
   tracked so tests and shutdown can wait for it, and failures are logged instead of surfacing to a user who already
   moved on. Everything is idempotent: removing a missing folder is a no-op and leftovers are swept on the next start. */
export function createJobCleanup({ retire = retireAudioBatch, remove = removeAudioBatch,
  purge = (dir) => rm(dir, { recursive: true, force: true }),
  log = (error) => console.error('[study] background cleanup failed:', error?.message || error) } = {}) {
  const running = new Set();
  const track = (work) => {
    const task = Promise.resolve().then(work).catch(log).finally(() => running.delete(task));
    running.add(task);
  };
  return {
    async dismissBatch(root, batchId) {
      let retired;
      try { retired = await retire(root, batchId); }
      // The folder could not be renamed away (a scanner holding a file, for example). Dismissal is only real
      // once the files are gone, so this rare path waits for the full removal.
      catch { await remove(root, batchId); return; }
      if (retired) track(() => purge(retired));
    },
    pending: () => running.size,
    async idle() { while (running.size) await Promise.all([...running]); },
  };
}

export const jobCleanup = createJobCleanup();
