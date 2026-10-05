/* A machine-wide lock for full test runs. Several agents (or terminals) running the whole suite at once starve each other's browsers,
   ffmpeg and CLI tests until the timing tests flake, so full runs take turns: the one that holds the lock runs, the others print one
   line and poll. The lock is a file naming the run ({ pid, startedAt, cwd }); it is stale when that process is gone or the run is
   older than 45 minutes, so a killed run never blocks anybody for long. Waiting has a limit, after which a run goes ahead with
   fewer workers. A lock that cannot be written is no lock: tests always run.

   The file lives under the user's home, not os.tmpdir(): runs that each use a private TEMP would never see one another there. */
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { readFileSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export const STALE_AFTER_MS = 45 * 60_000;
export const MAX_WAIT_MS = 20 * 60_000;
export const POLL_MS = 2000;
export const lockFile = () => process.env.STUDY_TEST_LOCK_FILE || join(homedir(), '.cache', 'studyhub-tests', 'full-run.lock');

const alive = pid => { try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; } };
const parse = text => { try { const held = JSON.parse(text); return Number.isInteger(held?.pid) && Number.isFinite(held.startedAt) ? held : null; } catch { return null; } };
const clock = time => new Date(time).toTimeString().slice(0, 8);
const minutes = ms => `${Math.round(ms / 60_000)} min`;
const nap = (ms, signal) => new Promise(resolve => {
  const timer = setTimeout(done, ms);
  function done() { clearTimeout(timer); signal?.removeEventListener('abort', done); resolve(); }
  signal?.addEventListener('abort', done, { once: true });
});

/** The full run that holds the machine right now, or null (no lock, its process is gone, or it has gone on too long). */
export async function fullRunHolder({ file = lockFile(), staleAfterMs = STALE_AFTER_MS } = {}) {
  const held = parse(await readFile(file, 'utf8').catch(() => ''));
  return held && alive(held.pid) && Date.now() - held.startedAt <= staleAfterMs ? held : null;
}

/** Take the lock, waiting for the run that has it. Resolves with { reduced, release }: `reduced` when the wait ran out and this run
 *  goes ahead beside the other one (use fewer workers). Resolves with null when `signal` ends the wait. */
export async function acquireFullRunLock({ file = lockFile(), pollMs = POLL_MS, maxWaitMs = MAX_WAIT_MS, staleAfterMs = STALE_AFTER_MS, signal, log = () => {} } = {}) {
  const free = { reduced: false, release: async () => {} };
  const mine = JSON.stringify({ pid: process.pid, startedAt: Date.now(), cwd: process.cwd() });
  try { await mkdir(dirname(file), { recursive: true }); } catch { return free; }
  const began = Date.now();
  let told = false;
  while (!signal?.aborted) {
    try {
      await writeFile(file, mine, { flag: 'wx' });
      let released = false;
      const releaseSync = () => {
        if (released) return;
        released = true;
        try { if (parse(readFileSync(file, 'utf8'))?.pid === process.pid) rmSync(file, { force: true }); } catch { /* already gone */ }
      };
      process.once('exit', releaseSync);
      return { reduced: false, release: async () => { releaseSync(); process.removeListener('exit', releaseSync); } };
    } catch (error) { if (error.code !== 'EEXIST') return free; }
    const text = await readFile(file, 'utf8').catch(() => null);
    if (text === null) continue; // released between the two calls
    const held = parse(text);
    // A file that cannot be read as a lock is a holder caught mid-write for a moment; after that it is stale.
    const age = held ? Date.now() - held.startedAt : Date.now() - (await stat(file).catch(() => ({ mtimeMs: 0 }))).mtimeMs;
    const stale = held ? !alive(held.pid) || age > staleAfterMs : age > Math.min(staleAfterMs, 10_000);
    if (stale) {
      // Remove it only if it is still the lock that was judged stale: another waiting run may have just replaced it.
      if (await readFile(file, 'utf8').catch(() => null) === text) await rm(file, { force: true });
      continue;
    }
    if (!told) {
      told = true;
      log(held ? `Another full test run is going (pid ${held.pid}, started ${clock(held.startedAt)}${held.cwd ? `, in ${held.cwd}` : ''}); waiting for it, up to ${minutes(maxWaitMs)} (STUDY_TEST_NO_LOCK=1 skips the queue).`
        : 'Another full test run is starting; waiting for it.');
    }
    if (Date.now() - began >= maxWaitMs) {
      log(`Waited ${minutes(maxWaitMs)} for the other full test run; going ahead with fewer workers.`);
      return { reduced: true, release: async () => {} };
    }
    await nap(pollMs, signal);
  }
  return null;
}
