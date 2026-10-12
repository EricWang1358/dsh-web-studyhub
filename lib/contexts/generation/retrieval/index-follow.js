import { canIngest, contentHash, readManifest } from '../../../retrieval-index.js';
import { autoIndexOn, readRetrievalSettings } from '../../../retrieval-settings.js';
import { knownCourseNames, sourceMatchesCourse, sourcesWithCourses } from '../../../source-courses.js';
import { courseScope } from '../../../course-tree.js';
import { createIndexRuns } from './index-runs.js';

/* Adding new materials to the index by themselves (docs/large-documents.md): when materials arrive (an import, a finished conversion, a saved transcript, a material given a course;
   lib/runtime/builtins.js calls retrieval.index.follow after each), a course that already has pages in the index gets its new or changed pages added by
   the ordinary index build (./index-runs.js: the task console's job when the runtime runs it), a little later and once for a burst of imports. A build
   that is going is followed by one more after it ends. Nothing happens without the search extension, for a course that was never indexed, or when the
   learner turned it off (Settings > Search extension). Local work: no model, no tokens. */

const timing = { quietMs: 5000, pollMs: 3000 };
/** Tests shorten the waits. */
export const setFollowTiming = value => Object.assign(timing, value);
// One follow per library folder: { timer, ports (background ones, valid after the request), runsOf (./index-runs.js), tried (courses started in this burst) }.
const follows = new Map();

/** The courses whose index has gaps: some of their pages are indexed (the learner built it once) and some are new or changed. Parents first. */
export function coursesToFollow(state, manifest) {
  const entries = manifest?.sources || {}, all = sourcesWithCourses(state), names = knownCourseNames(state);
  return [...names].sort((a, b) => a.length - b.length || a.localeCompare(b)).filter(name => {
    const picked = all.filter(source => sourceMatchesCourse(source, courseScope(name, names)));
    return picked.some(source => entries[source.id]) && picked.some(source => entries[source.id]?.hash !== contentHash(source.text));
  });
}

const schedule = (root, ms) => {
  const entry = follows.get(root);
  if (!entry) return;
  clearTimeout(entry.timer);
  entry.timer = setTimeout(() => { void check(root); }, ms);
  entry.timer.unref?.();
};
const stop = root => { const entry = follows.get(root); if (entry) { clearTimeout(entry.timer); follows.delete(root); } };
/** The library's context is going away (lib/runtime/builtins.js dispose): a pending check never runs. */
export const stopFollow = root => stop(root);

async function check(root) {
  const entry = follows.get(root);
  if (!entry) return;
  entry.timer = null;
  try {
    const { ports } = entry, settings = await readRetrievalSettings().catch(() => ({}));
    if (!autoIndexOn(settings) || !canIngest(ports.retrieval)) { stop(root); return; }
    const runs = entry.runsOf(ports);
    // A build is going: look again when it has ended (one follow-up, never a second build beside it).
    if (await runs.building()) { schedule(root, timing.pollMs); return; }
    const course = coursesToFollow(await ports.state.read(), await readManifest(root)).find(name => !entry.tried.has(name));
    if (!course) { stop(root); return; }
    entry.tried.add(course);
    await runs.start({ course });
    schedule(root, timing.pollMs);
  } catch { stop(root); }
}

/**
 * retrieval.index.follow: note that materials arrived. Answers at once; the check runs `timing.quietMs` after the last arrival. -> { following }
 * `ports` are the generation context's; the background ones (ports.retrievalRuntime.background()) are kept, since the request ends first. `runsOf`
 * (tests) stands in for the index runs.
 */
export async function followIndex(ports, { runsOf = createIndexRuns } = {}) {
  const settings = await readRetrievalSettings().catch(() => ({}));
  if (!autoIndexOn(settings) || !canIngest(ports.retrieval)) return { following: false };
  const root = ports.state.root, kept = ports.retrievalRuntime?.background?.() ?? ports;
  const entry = follows.get(root) ?? { timer: null, tried: new Set() };
  // A new arrival is a new burst: every course may be brought up to date again.
  Object.assign(entry, { ports: kept, runsOf, tried: new Set() });
  follows.set(root, entry);
  schedule(root, timing.quietMs);
  return { following: true };
}
