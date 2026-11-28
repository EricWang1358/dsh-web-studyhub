import { AGY_SPARE_MAX_AGE_MS, canServeAgyCall, sameAgySource } from '../../domain/agy-warm-policy.js';

/** Timers that never keep the app running just to count a spare's idle time. */
const UNREF_TIMERS = Object.freeze({
  set(fn, ms) {
    const timer = setTimeout(fn, ms);
    timer.unref?.();
    return timer;
  },
  clear: (timer) => clearTimeout(timer),
});

const fits = (waiting, plan) => (plan.strict ? canServeAgyCall(waiting, plan.spec) : sameAgySource(waiting, plan.spec));

/**
 * One call that cannot use the waiting spare (another effort, no time limit) leaves it for the next one, so calls that alternate do
 * not start a process each; a second in a row means calls now ask for something else. Another program or model is never left.
 */
function passesBy(entry, callSpec) {
  if (!entry || entry.passedBy || !sameAgySource(entry.spare.spec, callSpec)) return false;
  entry.passedBy = true;
  return true;
}

/** Close spares without making anyone wait, and let `allClosed` wait for every one still closing. */
function createCloser() {
  const closing = new Set();
  return Object.freeze({
    close(spare) {
      const done = Promise.resolve(spare.close()).catch(() => {}).finally(() => closing.delete(done));
      closing.add(done);
      return done;
    },
    allClosed: () => Promise.all([...closing]),
  });
}

/**
 * At most one process waiting for the next call. A claimed process belongs to the caller and never comes back.
 * @param {object} ports
 * @param {(spec) => { spec, exited: Promise<void>, close: () => Promise<void> }} ports.open start a spare
 * @param {(spec) => import('../../domain/agy-warm-policy.js').AgyWarmPlan} ports.planOnExpiry what the settings say when a spare has waited its limit
 * @param {{ set: Function, clear: Function }} [ports.timers]
 * @param {() => number} [ports.now] the wall clock: a timer may not count the time the computer was asleep
 */
export function createAgyWarmPool({ open, planOnExpiry, timers = UNREF_TIMERS, now = Date.now }) {
  let waiting = null;
  let disposed = false;
  // Set after a spare died while waiting or a call failed: nothing is started again until the next call asks (strict), so a CLI that
  // cannot run is not restarted every time the settings are read.
  let backedOff = false;
  const closer = createCloser();

  const take = () => {
    const entry = waiting;
    if (!entry) return null;
    waiting = null;
    timers.clear(entry.timer);
    return entry.spare;
  };

  const release = () => {
    const spare = take();
    return spare ? closer.close(spare) : Promise.resolve();
  };

  /* Checked whenever the pool is asked, besides the timer: after a sleep the timer can be hours late. */
  const releaseIfTooOld = () => {
    if (waiting && now() - waiting.startedAt >= AGY_SPARE_MAX_AGE_MS) release();
  };

  /* The clock starts with the process and is never set back, so no spare gets older than the limit. */
  function start(spec) {
    const spare = open(spec);
    const entry = { spare, timer: null, passedBy: false, startedAt: now() };
    waiting = entry;
    entry.timer = timers.set(() => {
      if (waiting !== entry) return;
      release();
      apply(planOnExpiry(spec));
    }, AGY_SPARE_MAX_AGE_MS);
    spare.exited.then(() => {
      if (waiting !== entry) return;
      backedOff = true;
      release();
    });
  }

  function apply(plan) {
    if (disposed) return;
    releaseIfTooOld();
    if (plan.action === 'keep') return;
    if (plan.action === 'release') {
      release();
      return;
    }
    if (plan.strict) backedOff = false;
    else if (backedOff) return;
    if (waiting && fits(waiting.spare.spec, plan)) return;
    release();
    start(plan.spec);
  }

  return Object.freeze({
    apply,
    /** The waiting process when it can answer this call, else null; then `plan` says what waits for the call after this one. */
    claim(callSpec, plan) {
      releaseIfTooOld();
      if (!disposed && plan.action === 'ensure') {
        if (waiting && canServeAgyCall(waiting.spare.spec, callSpec)) {
          const spare = take();
          apply(plan);
          return spare;
        }
        if (passesBy(waiting, callSpec)) return null;
      }
      apply(plan);
      return null;
    },
    /** The settings no longer describe what waits: stop it. What comes next is the next plan's business. */
    drop() {
      backedOff = false;
      release();
    },
    /** A call to the CLI failed: whatever waits may share the cause. */
    fault() {
      backedOff = true;
      release();
    },
    /** The app is closing: stop what waits and wait until every spare this pool closed has gone. */
    async dispose() {
      disposed = true;
      release();
      await closer.allClosed();
    },
  });
}
