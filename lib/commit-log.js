import { AsyncLocalStorage } from 'node:async_hooks';

/* Which library commits a piece of work made (lib/host.js acknowledges a quiet action's own commits, lib/runtime/library-watch.js absorbs them).
   Each record is {from, to, revision}: the library stamp (Store#stamp) the commit was built on and the one it left. */

const log = new AsyncLocalStorage();

/** Run `work` and return { value, commits }: the commits made inside it. */
export async function collectCommits(work) {
  const commits = [];
  const value = await log.run(commits, work);
  return { value, commits };
}

/** Called by the store once a commit replaced the manifest. */
export function noteCommit(commit) {
  log.getStore()?.push(commit);
}
