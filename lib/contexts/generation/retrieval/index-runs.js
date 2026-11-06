import { createIndexPlanner } from './index-plan.js';
import { createLegacyIndexRuns } from './legacy-index-run.js';
import { createJobIndexRuns } from './jobs/submit-retrieval-index.js';
import { joinedView } from './jobs/retrieval-index-view.js';

/** The pilot switch's one reader for the search-index build: retrieval.index.start/status/cancel (and the "building" of the coverage).
 * A new build runs on the runtime when runtime.pilot.retrievalIndex is on (the default, see ./runtime-port.js) and as the original
 * background run otherwise. Whichever path is chosen, a build the other path is running is the library's one build: a start joins it,
 * the status and the stop are its own (a build started before an upgrade or a switch change keeps going; the manifest stays the checkpoint). */
export function createIndexRuns(ports) {
  const planner = createIndexPlanner(ports), runtime = ports.retrievalRuntime;
  const paths = {};
  paths.legacy = createLegacyIndexRuns({ ports, planner, busy: () => paths.job?.running() ?? null });
  if (typeof runtime?.jobs?.list === 'function') paths.job = createJobIndexRuns({ ports, planner, busy: () => paths.legacy.running() });
  const chosen = (runtime?.enabled() && paths.job) || paths.legacy;
  const all = [paths.legacy, paths.job].filter(Boolean);
  const runningPath = () => all.find(path => path.running());
  const status = async () => {
    const views = await Promise.all(all.map(path => path.status()));
    return views.find(view => view.status === 'running') ?? newest(views);
  };
  return Object.freeze({
    async start(a) {
      const other = all.find(path => path !== chosen && path.running());
      return other ? joinedView(other.running(), a.course) : chosen.start(a);
    },
    status,
    async cancel() { const path = runningPath(); return path ? path.cancel() : status(); },
    async building() {
      for (const path of all) { const view = await path.building(); if (view) return view; }
      return null;
    },
  });
}

/** The most recent of the finished builds of both paths, or idle. */
const newest = views => views.filter(view => view.status !== 'idle')
  .sort((a, b) => String(b.startedAt ?? '').localeCompare(String(a.startedAt ?? '')))[0] ?? { status: 'idle' };
