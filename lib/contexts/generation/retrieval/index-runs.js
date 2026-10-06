import { createIndexPlanner } from './index-plan.js';
import { createLegacyIndexRuns } from './legacy-index-run.js';
import { createJobIndexRuns } from './jobs/submit-retrieval-index.js';

/** The pilot switch's one reader for the search-index build: retrieval.index.start/status/cancel (and the "building" of the coverage)
 * are served by the runtime when runtime.pilot.retrievalIndex is on and by the original background run otherwise. */
export function createIndexRuns(ports) {
  const planner = createIndexPlanner(ports);
  return ports.retrievalRuntime?.enabled() ? createJobIndexRuns({ ports, planner }) : createLegacyIndexRuns({ ports, planner });
}
