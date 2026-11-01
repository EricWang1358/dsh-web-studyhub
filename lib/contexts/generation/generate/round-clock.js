/* The time limit of a round of a coverage run. A COVERAGE RUN has `jobTimeoutMinutes` per ROUND (a long run is rounds on rounds, and each may take as long as a run
    did), and no limit as a whole:
   it ends by its stop conditions. A round that reaches its limit keeps the questions that passed review (they are saved as they pass) and the run goes on from there.
   The limit is the time the round WORKS: the clock stops when the pause is reached (no call is running) and goes on with what is left when the learner resumes, so a
   long pause never costs the round.
   The same holds for the `ms` a round records (what the projection of the time left is made of): the time it stood still in a pause is not in it. */

/** `signal` is the job's, and the round's own while a round is armed. `plan` is read for when the round started (`plan.t0`). */
export function createRoundClock({ job, controller, plan, roundMs }) {
  let signal = controller.signal, abort = null, timer, link;
  let left = roundMs, since = 0, stopped = false, idleSince = 0, idleMs = 0;
  const start = () => {
    since = Date.now();
    timer = setTimeout(() => {
      job.stage = 'Time budget of this round reached; stopping workers';
      const minutes = Math.max(1, Math.round(roundMs / 60000));
      abort.abort(Object.assign(new Error(`Generation reached its ${minutes}-minute budget for this round; approved questions were retained`), { code: 'GENERATION_BUDGET' }));
    }, left);
  };
  const stop = () => {
    if (!since) return;
    clearTimeout(timer);
    left = Math.max(1, left - (Date.now() - since));
    since = 0;
    stopped = true;
  };
  return {
    get signal() { return signal; },
    workedMs() {
      const now = Date.now();
      return Math.max(0, now - (plan.t0 || now) - idleMs - (idleSince ? now - idleSince : 0));
    },
    /** Nothing is running: a pause was reached, or the queue holds the job after a model error. */
    hold() { idleSince ||= Date.now(); stop(); },
    resume() {
      if (idleSince) { idleMs += Date.now() - idleSince; idleSince = 0; }
      if (stopped) { stopped = false; start(); }
    },
    /** A round begins: what it records as its time is counted from here. */
    restartMeasure() { idleMs = 0; },
    arm() {
      abort = new AbortController();
      link = () => abort.abort(controller.signal.reason);
      if (controller.signal.aborted) link(); else controller.signal.addEventListener('abort', link, { once: true });
      left = roundMs;
      stopped = false;
      start();
      signal = abort.signal;
    },
    disarm() {
      clearTimeout(timer);
      since = 0;
      stopped = false;
      if (link) controller.signal.removeEventListener('abort', link);
      signal = controller.signal;
    },
    /** A failure of the round that is its own limit, not a stop of the job. */
    timedOut: failure => !!failure && !controller.signal.aborted && abort?.signal.aborted && abort.signal.reason?.code === 'GENERATION_BUDGET',
    clear() { clearTimeout(timer); },
  };
}
