import { AsyncLocalStorage } from 'node:async_hooks';

/* Which library commits a piece of work made (lib/host.js acknowledges a quiet action's own commits, lib/runtime/library-watch.js absorbs them).
   Each record is {from, to, revision}: the library stamp (Store#stamp) the commit was built on and the one it left. Asynchronous context follows every
   promise started inside the work, so a background job started there would count as the work's own: job starts run under detachCommits, and the list
   closes when the work returns. */

const log = new AsyncLocalStorage();

/** Run `work` and return { value, commits }: the commits made inside it, up to its return. */
export async function collectCommits(work) {
  const entry = { commits: [], open: true };
  try {
    const value = await log.run(entry, work);
    return { value, commits: entry.commits };
  } finally {
    entry.open = false;
  }
}

/** Start background work (a job, a task, a queue) outside any caller's list: its commits are its own. */
export function detachCommits(start) {
  return log.exit(start);
}

/** Called by the store once a commit replaced the manifest. */
export function noteCommit(commit) {
  const entry = log.getStore();
  if (entry?.open) entry.commits.push(commit);
}
