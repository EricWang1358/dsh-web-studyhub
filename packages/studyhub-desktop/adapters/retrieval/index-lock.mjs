import { mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import lockfile from 'proper-lockfile';
import { formatRetrievalError } from '../../domain/retrieval-policy.js';

export const INDEX_LOCK_DEFAULTS = Object.freeze({
  stale: 30_000,
  update: 10_000,
  retries: Object.freeze({
    retries: 200,
    factor: 1.5,
    minTimeout: 200,
    maxTimeout: 5_000,
    maxRetryTime: 15 * 60 * 1000,
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

function normalizeRetryConfig(raw) {
  if (typeof raw === 'number') {
    return { retries: Math.max(0, raw), factor: 1.5, minTimeout: 100, maxTimeout: 5_000, maxRetryTime: 15 * 60 * 1000, randomize: true };
  }
  const src = raw && typeof raw === 'object' ? raw : INDEX_LOCK_DEFAULTS.retries;
  const minTimeout = Math.max(10, Number(src.minTimeout) || 200);
  const maxTimeout = Math.max(minTimeout, Number(src.maxTimeout) || 5_000);
  return {
    retries: Math.max(0, Number.isInteger(src.retries) ? src.retries : 200),
    factor: Number(src.factor) > 0 ? Number(src.factor) : 1.5,
    minTimeout,
    maxTimeout,
    maxRetryTime: Number(src.maxRetryTime) > 0 ? Number(src.maxRetryTime) : 15 * 60 * 1000,
    randomize: src.randomize !== false,
  };
}

function retryDelayMs(cfg, attempt) {
  const jitter = cfg.randomize ? 1 + Math.random() : 1;
  return Math.min(cfg.maxTimeout, Math.round(cfg.minTimeout * (cfg.factor ** attempt) * jitter));
}

function waitAbortable(ms, signal) {
  if (signal?.aborted) return Promise.reject(createAbortError(signal));
  return new Promise((done, fail) => {
    const onAbort = () => {
      clearTimeout(timer);
      fail(createAbortError(signal));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      done();
    }, Math.max(0, ms));
    timer.unref?.();
    signal?.addEventListener('abort', onAbort, { once: true });
  });
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

  async function acquireFileLock(overrideRetries, signal) {
    await mkdir(rootDir, { recursive: true });
    const cfg = normalizeRetryConfig(overrideRetries ?? retries);
    const deadline = Date.now() + cfg.maxRetryTime;
    for (let attempt = 0; attempt <= cfg.retries; attempt += 1) {
      if (signal?.aborted) throw createAbortError(signal);
      try {
        return await lockfile.lock(rootDir, {
          lockfilePath,
          realpath: false,
          stale,
          update,
          retries: 0,
        });
      } catch (error) {
        if (error?.code !== 'ELOCKED') throw error;
        const remaining = deadline - Date.now();
        if (attempt >= cfg.retries || remaining <= 0) throw createLockedError();
        await waitAbortable(Math.min(retryDelayMs(cfg, attempt), remaining), signal);
      }
    }
    throw createLockedError();
  }

  function withLock(work, { signal, retries: overrideRetries } = {}) {
    if (signal?.aborted) return Promise.reject(createAbortError(signal));

    const turn = queueTail.then(async () => {
      if (signal?.aborted) throw createAbortError(signal);
      const release = await acquireFileLock(overrideRetries, signal);
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
