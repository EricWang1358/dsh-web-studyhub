import { PAGE_IDS, pageOf } from './pages.js';

/* The few numbers a bug report carries about THIS session (#893 S4): how long switching pages took, how many long tasks (over 50 ms) the page ran,
   how large the library snapshots were and how long applying them took. They exist so that "it is slow" arrives with facts.

   The log is a value in memory and nothing else: it is never written to storage, a file or the network, it is not shown anywhere, and it is gone when
   the panel closes. It keeps numbers and the ids of the app's own pages (ui/pages.js) and nothing a learner wrote: no title, no text, no path.
   The summary is computed when it is read. It reaches a person only inside the text 复制诊断信息 copies (ui/diagnostics.js).

   It takes no clock: whoever feeds it passes the times it read (ui/use-session-performance.js), so it is a pure value that a test drives. */

/** `longTaskMs` is the platform's own definition of a long task, not a threshold of ours. */
export const PERFORMANCE_LIMITS = Object.freeze({ switches: 60, snapshots: 40, longTaskMs: 50 });

const whole = value => (Number.isFinite(value) && value >= 0 ? Math.round(value) : null);

/** Keeps the last `limit` numbers; the oldest goes first. */
function ring(limit) {
  const items = [];
  return { push(item) { items.push(item); if (items.length > limit) items.shift(); }, items };
}

/** The lower middle value (nearest rank), so a median is one of the values that were measured. */
function stats(values) {
  if (!values.length) return { count: 0, median: 0, worst: 0 };
  const sorted = [...values].sort((a, b) => a - b);
  return { count: sorted.length, median: sorted[Math.ceil(sorted.length / 2) - 1], worst: sorted[sorted.length - 1] };
}

export function createPerformanceLog() {
  const switches = ring(PERFORMANCE_LIMITS.switches), snapshots = ring(PERFORMANCE_LIMITS.snapshots);
  let pending = null, longTasks = null;
  return {
    /** The learner switched to `page` at `at` (ms on the page's clock). A switch that never drew is replaced by the next. */
    startSwitch(page, at) { pending = pageOf(page) && Number.isFinite(at) ? { page, at } : null; },
    /** The frame that draws `page` began at `at`: the switch took the time between. */
    endSwitch(page, at) {
      if (pending?.page !== page || !Number.isFinite(at)) return;
      const ms = whole(at - pending.at);
      pending = null;
      if (ms !== null) switches.push({ page, ms });
    },
    /** The webview reports long tasks and the observer is (re)started: what it delivers from the start counts from zero. */
    observeLongTasks() { longTasks = { count: 0, totalMs: 0, worstMs: 0 }; },
    recordLongTask(ms) {
      const rounded = whole(ms);
      if (!longTasks || rounded === null) return;
      longTasks.count += 1; longTasks.totalMs += rounded; longTasks.worstMs = Math.max(longTasks.worstMs, rounded);
    },
    /** A snapshot of `chars` characters (its JSON text) was applied in `applyMs`. */
    recordSnapshot(chars, applyMs) {
      const size = whole(chars), took = whole(applyMs);
      if (size !== null && took !== null) snapshots.push({ chars: size, applyMs: took });
    },
    summary() {
      const pages = PAGE_IDS.map(page => ({ page, ...stats(switches.items.filter(item => item.page === page).map(item => item.ms)) })).filter(entry => entry.count);
      return {
        switches: { all: stats(switches.items.map(item => item.ms)), byPage: pages },
        longTasks: longTasks && { ...longTasks }, // null: this webview does not report them, which is not the same as none
        snapshots: { chars: stats(snapshots.items.map(item => item.chars)), applyMs: stats(snapshots.items.map(item => item.applyMs)) },
      };
    },
  };
}

/** The one log of this session. */
export const sessionPerformance = createPerformanceLog();

/**
 * The size of an answer in characters, read from the texts the snapshot diff already made (ui/snapshot-share.js): never a second stringify just to
 * measure. Only the keys the answer carried count, so a partial answer is its own size and not the whole snapshot's.
 */
export function snapshotChars(texts, answer) {
  if (!texts || !answer) return 0;
  return Object.keys(answer).reduce((total, key) => total + (typeof texts[key] === 'string' ? texts[key].length : 0), 0);
}
