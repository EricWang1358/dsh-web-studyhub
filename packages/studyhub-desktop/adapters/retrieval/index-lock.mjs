import { mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import lockfile from 'proper-lockfile';
import { formatRetrievalError } from '../../domain/retrieval-policy.js';

export const INDEX_LOCK_DEFAULTS = Object.freeze({
  stale: 30_000,
  update: 10_000,
  retries: Object.freeze({
    retries: 6,
    factor: 1.5,
    minTimeout: 100,
    maxTimeout: 1000,
    randomize: true,
  }),
});

function createAbortError(signal) {
  const reason = signal?.reason;
  if (reason instanceof Error) return reason;
  return Object.assign(new Error('Retrieval index operation aborted'), {
    name: 'AbortError',
    code: 'ABORT_ERR',
  });
}

function createLockedError() {
  return Object.assign(
    new Error(formatRetrievalError('retrieval-index-locked', 'zh')),
    { code: 'retrieval-index-locked' }
  );
}

/**
 * Create a cross-process lock around `<studyHome>/retrieval` using `proper-lockfile`
 * to protect concurrent LanceDB writes between DSH and StudyHub Desktop.
 */
export function createIndexLock({
  retrievalDir,
  stale = INDEX_LOCK_DEFAULTS.stale,
  update = INDEX_LOCK_DEFAULTS.update,
  retries = INDEX_LOCK_DEFAULTS.retries,
}) {
  const rootDir = resolve(retrievalDir);
  const lockfilePath = join(rootDir, '.index.lock');
  let queueTail = Promise.resolve();

  async function acquireFileLock(overrideRetries) {
    await mkdir(rootDir, { recursive: true });
    try {
      return await lockfile.lock(rootDir, {
        lockfilePath,
        realpath: false,
        stale,
        update,
        retries: overrideRetries ?? retries,
      });
    } catch (error) {
      if (error?.code === 'ELOCKED') {
        throw createLockedError();
      }
      throw error;
    }
  }

  function withLock(work, { signal, retries: overrideRetries } = {}) {
    if (signal?.aborted) return Promise.reject(createAbortError(signal));

    const turn = queueTail.then(async () => {
      if (signal?.aborted) throw createAbortError(signal);
      const release = await acquireFileLock(overrideRetries);
      try {
        if (signal?.aborted) throw createAbortError(signal);
        return await work();
      } finally {
        await release().catch(() => {});
      }
    });

    queueTail = turn.then(() => {}, () => {});
    return turn;
  }

  return Object.freeze({
    rootDir,
    lockfilePath,
    withLock,
  });
}
