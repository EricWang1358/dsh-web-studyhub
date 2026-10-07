import { AsyncLocalStorage } from 'node:async_hooks';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import lockfile from 'proper-lockfile';

/** How long a writer waits for ANOTHER process's lock on the library: 20 tries, 100 ms growing by half each time, each wait randomised between once and twice that and
 * never over 2 s (so contenders do not retry in step): between 29 s and 32 s in all. Writers of this process never use it, they queue first. */
export const STORE_LOCK = Object.freeze({
  retry: Object.freeze({ retries: 20, factor: 1.5, minTimeout: 100, maxTimeout: 2000, randomize: true }),
  stale: 30_000,
});

/** One chain per library folder in this process: its writers go one at a time, in the order they asked, before they touch the file lock. */
const tails = new Map();
const holding = new AsyncLocalStorage();
const keyOf = root => (process.platform === 'win32' ? resolve(root).toLowerCase() : resolve(root));

/** `work()` with the library's lock held: first this process's turn, then the file lock that arbitrates between processes (it refuses cleanly, with ELOCKED, once `retry` is spent).
 * A write started from inside another write of the same library would wait for itself for ever; it is refused at once instead. */
export function withStoreLock(root, work, { retry = STORE_LOCK.retry } = {}) {
  const key = keyOf(root);
  if (holding.getStore()?.has(key)) return Promise.reject(Object.assign(new Error('A library write cannot start from inside another write of the same library'), { code: 'STORE_REENTRANT' }));
  const turn = (tails.get(key) ?? Promise.resolve()).then(async () => {
    await mkdir(root, { recursive: true });
    const release = await lockfile.lock(root, { realpath: true, retries: retry, stale: STORE_LOCK.stale });
    try { return await holding.run(new Set([...(holding.getStore() ?? []), key]), work); } finally { await release(); }
  });
  const tail = turn.then(() => {}, () => {});
  tails.set(key, tail);
  void tail.then(() => { if (tails.get(key) === tail) tails.delete(key); });
  return turn;
}
