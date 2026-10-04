import { readFile, rename, writeFile } from 'node:fs/promises';

/* Condition-based waiting for tests that share a machine with a full verify run (30+ test processes) or another build: a fixed delay or a
   short deadline measures the machine's load, not the code. These helpers wait for the thing itself, against a generous deadline. */

export const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

/** Poll `condition` until it returns something truthy (returned), or reject with what was being waited for once `timeoutMs` has passed. */
export async function until(condition, what = 'the condition', { timeoutMs = 90_000, intervalMs = 10 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await condition();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`Timed out after ${timeoutMs} ms waiting for ${what}`);
    await sleep(intervalMs);
  }
}

/** `job.wait` answers after 60 s at the latest whatever the job is doing: ask again until the job has really ended, and return it. */
export async function settleJob(service, jobId, { timeoutMs = 240_000 } = {}) {
  let job;
  await until(async () => {
    job = await service.call('job.wait', { jobId, timeoutSeconds: 60 });
    return !['queued', 'running', 'cancelling'].includes(job.status);
  }, `job ${jobId} to end`, { timeoutMs, intervalMs: 0 });
  return job;
}

/** Read a JSON file another process may be replacing right now: a half-written file is read again, not thrown. */
export async function readJsonFile(path, { timeoutMs = 30_000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try { return JSON.parse(await readFile(path, 'utf8')); }
    catch (error) { if (Date.now() > deadline) throw error; await sleep(15); }
  }
}

/** Replace a JSON file in one step, so a process reading it never sees half of it. */
let counter = 0;
export async function writeJsonFile(path, value) {
  const temporary = `${path}.${process.pid}.${counter++}.tmp`;
  await writeFile(temporary, JSON.stringify(value));
  for (let attempt = 0; ; attempt++) {
    try { return await rename(temporary, path); }
    catch (error) { if (attempt > 200 || !['EPERM', 'EBUSY', 'EACCES'].includes(error.code)) throw error; await sleep(15); }
  }
}

/** The local-CLI fakes start a Node process per call; on a loaded machine that takes seconds, so the library's own per-call time limits are stretched (they still apply). */
export const patientCli = (cli, scale = 12) => (cli ? { ...cli, timeoutScale: scale } : cli);
