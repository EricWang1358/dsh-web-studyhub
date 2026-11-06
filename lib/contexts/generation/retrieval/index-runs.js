import { createIndexPlanner } from './index-plan.js';
import { createLegacyIndexRuns } from './legacy-index-run.js';
import { createJobIndexRuns } from './jobs/submit-retrieval-index.js';
import { joinedView } from './jobs/retrieval-index-view.js';

/** The pilot switch's one reader for the search-index build: retrieval.index.start/status/cancel (and the "building" of the coverage).
 * A new build runs on the runtime when runtime.pilot.retrievalIndex is on (the default) and the host can admit a job (see ./runtime-port.js),
 * and as the original background run otherwise, including when the job is refused at the submit for want of a live agent: a build is never
 * refused for that. Within one running StudyHub, a build the other path is running is the library's one build: a start joins it, the status
 * and the stop are its own; the manifest stays the checkpoint. Two StudyHub copies (an old one still loaded beside an updated one) do not see
 * each other's builds, so DSH is restarted after an update. */
export function createIndexRuns(ports) {
  const planner = createIndexPlanner(ports), runtime = ports.retrievalRuntime;
  const paths = {};
  paths.legacy = createLegacyIndexRuns({ ports, planner, busy: () => paths.job?.running() ?? null });
  if (typeof runtime?.jobs?.list === 'function') paths.job = createJobIndexRuns({ ports, planner, busy: () => paths.legacy.running() });
  const chosen = (runtime?.enabled() && paths.job) || paths.legacy;
  const startOn = async a => {
    if (chosen === paths.legacy) return paths.legacy.start(a);
    try { return await chosen.start(a); } catch (error) {
      if (error?.code !== 'executor-unavailable') throw error;
      return paths.legacy.start(a);
    }
  };
  const all = [paths.legacy, paths.job].filter(Boolean);
  const runningPath = () => all.find(path => path.running());
  const status = async () => {
    const views = await Promise.all(all.map(path => path.status()));
    return views.find(view => view.status === 'running') ?? newest(views);
  };
  return Object.freeze({
    async start(a) {
      const other = all.find(path => path !== chosen && path.running());
      return other ? joinedView(other.running(), a.course) : startOn(a);
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
