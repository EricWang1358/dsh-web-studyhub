import { useCallback, useState } from 'react';
import { useLiveEffect } from '../use-async.js';
import { usePolling } from '../use-polling.js';

/* Where the course's search index stands, for the 复习全书 (BookIndexHint.jsx): read from retrieval.index.plan { course } (the course's pages, how many
   are indexed, which materials still have pages without one, whether the extension can build) and retrieval.index.status (a build that is going). The
   same facts and numbers the 检索扩展 settings show (ui/index-scope.js courseScopeLine), so one fact keeps one number. */

/**
 * The state of a course's index: null while unknown; { kind: 'ready' } (nothing to say), { kind: 'missing' } (not built), { kind: 'partial', missing }
 * (pages not indexed yet), { kind: 'building', done, total } (a build of this course, or of all materials, is going). `canIndex`: the extension can build.
 */
export function bookIndexState(plan, run, course) {
  if (!plan) return null;
  const canIndex = plan.canIndex !== false;
  if (run?.status === 'running' && [course, '*', ''].includes(run.course ?? '')) return { kind: 'building', done: run.done || 0, total: run.total || 0, canIndex };
  if (!plan.pages) return { kind: 'ready', canIndex };
  if (!plan.unchanged) return { kind: 'missing', canIndex };
  if (plan.toIndex > 0) return { kind: 'partial', missing: plan.toIndex, canIndex };
  return { kind: 'ready', canIndex };
}

/** Whether the index can serve the book as it is (nothing missing, nothing being built). */
export const indexReady = state => state?.kind === 'ready';

/**
 * The course's index for the book page: { state, plan } (both null until both answers are in; a failed read leaves them null, and the page shows nothing).
 * While a build of the course is going its progress is asked again every few seconds; when it ends the plan is read again.
 */
export function useBookIndex(call, course) {
  const [seen, setSeen] = useState({ plan: null, run: null, ticket: 0 });
  useLiveEffect(isLive => {
    if (typeof call !== 'function' || course === null || course === undefined) return;
    Promise.all([call('retrieval.index.plan', { course }), call('retrieval.index.status', {}).catch(() => null)])
      .then(([plan, run]) => { if (isLive() && plan) setSeen(current => ({ ...current, plan, run })); }, () => {});
  }, [call, course, seen.ticket]);
  const state = bookIndexState(seen.plan, seen.run, course);
  const follow = useCallback(async () => {
    const run = await call('retrieval.index.status', {}).catch(() => null);
    const over = run?.status !== 'running';
    setSeen(current => (over ? { ...current, run, ticket: current.ticket + 1 } : { ...current, run }));
  }, [call]);
  usePolling(follow, { intervalMs: 3000, enabled: state?.kind === 'building' });
  return { state, plan: seen.plan };
}
