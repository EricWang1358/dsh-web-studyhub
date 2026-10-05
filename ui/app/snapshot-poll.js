import { failureText } from '../failure.js';
/* What one tick of the library poll does (ui-consistency #125). The loop itself, its hidden-tab silence, its immediate
   catch-up and its backoff table are ui/use-polling.js; this is the part that is the library's own:
     - a snapshot that comes back unchanged slows the rhythm (the loop counts the `unchanged` answers);
     - activity in the panel, or coming back to it, restores the quick rhythm (wake());
     - a request that outlives its library, or its loop, never writes its answer or its failure into the new panel. */

/**
 * deps: { refresh(): the library snapshot, readData(): the snapshot the panel holds, readToken(): names the library and loop this
 * request belongs to (it changes when either goes), setSyncIssue(text), same(before, after): nothing visible changed,
 * isWorking(): a job or coach task is moving (the rhythm stays quick) }.
 */
export function createSnapshotPoll({ refresh, readData, readToken, setSyncIssue, same, isWorking }) {
  let woke = false;
  return {
    wake() { woke = true; },
    /** One poll. Answers { unchanged, running } for the loop; never throws. */
    async run() {
      const token = readToken(), before = readData();
      let unchanged = false;
      try {
        // An unchanged answer hands back the object the panel already holds; the once-a-minute fingerprint rollover alone is not a change.
        const next = await refresh();
        if (token === readToken()) setSyncIssue('');
        unchanged = !woke && same(before, next);
      } catch (error) {
        if (token === readToken()) setSyncIssue(failureText(error));
      }
      woke = false;
      return { unchanged, running: !!isWorking() };
    },
  };
}

/** Activity in the panel, or coming back to it, restores the quick rhythm at once. Returns the function that takes the listeners off. */
export function attachWake(poll, { win = window, doc = document } = {}) {
  const wake = () => poll.wake();
  const visible = () => { if (!doc.hidden) poll.wake(); };
  win.addEventListener('pointerdown', wake, true);
  win.addEventListener('keydown', wake, true);
  doc.addEventListener('visibilitychange', visible);
  return () => {
    win.removeEventListener('pointerdown', wake, true);
    win.removeEventListener('keydown', wake, true);
    doc.removeEventListener('visibilitychange', visible);
  };
}
