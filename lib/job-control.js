import { TEXT_CONCURRENCY, TRANSCRIBE_CONCURRENCY } from './audio-pool.js';
import { EFFORT_PREFERENCES } from './model-effort.js';
import { EFFORT_STAGES, STAGE_EFFORT_PREFERENCES, effortKey } from './stage-effort.js';
import { GENERATION_SETTINGS_LIMITS } from './generation-settings.js';
import { recordEvent, jobCalls } from './job-calls.js';

/* Instant control of a running job (the 任务 console's 即时控制 row).

   A job that can be adjusted while it runs owns ONE control: a small object of live values with a spec (what each value may be). `patch()` validates
   the whole request first (a refused patch changes nothing, not even its valid half), then applies it; whatever reads a value reads it when its
   next call is about to start, so a change never interrupts a call that is running and takes effect from the next one. The job record shows
   what is adjustable and its value in force (`job.control`), whether it is paused (`job.paused`), and the change is a line of its log.
   The control exists while the job is active; it closes with the job, and a finished job has nothing to adjust.

   spec: { key: { type: 'int', min, max } | { type: 'enum', values } | { type: 'bool' } } */

const ruleOk = (rule, value) => rule.type === 'int' ? Number.isInteger(value) && value >= rule.min && value <= rule.max
  : rule.type === 'enum' ? rule.values.includes(value) : rule.type === 'bool' ? typeof value === 'boolean' : false;
const limitsOf = (spec) => Object.fromEntries(Object.entries(spec).map(([key, rule]) => [key, { ...rule }]));

/** How many calls of the job are running right now: what a pause has to wait for before it is a pause. */
const runningCalls = (job) => jobCalls(job).filter((call) => call.status === 'running').length;
const BOUNDARY_POLL_MS = 120;

export function createJobControl({ job, spec, values, apply = () => {}, inflight = () => runningCalls(job), onPaused }) {
  const live = { ...values }, listeners = new Set(), gates = new Set();
  let watching = null;
  /* Paused is two moments: asked (job.paused) and reached (job.pausedAt): the boundary where nothing is in flight. Only then is it a pause;
     until then the job is `pausing` and says what it waits for. The boundary is polled, because the calls end in code that knows nothing of pausing. */
  const stopWatching = () => { clearInterval(watching); watching = null; };
  const reached = () => {
    if (live.paused !== true) { stopWatching(); return; }
    if (inflight() > 0) return;
    stopWatching();
    job.pausedAt = new Date().toISOString();
    recordEvent(job, { level: 'info', code: 'paused' });
    Promise.resolve().then(() => onPaused?.(job)).catch(() => {});
  };
  const watchBoundary = () => {
    delete job.pausedAt;
    stopWatching();
    reached();
    if (live.paused === true && !job.pausedAt) { watching = setInterval(reached, BOUNDARY_POLL_MS); watching.unref?.(); }
  };
  const show = () => {
    job.control = { values: { ...live }, limits: limitsOf(spec) };
    if (spec.paused) job.paused = live.paused === true;
  };
  show();
  const control = {
    spec, values: live,
    /** Validate every key, then apply. Returns { applied: what was asked, now in force; changed: what actually moved; values: all of them }. */
    patch(input) {
      if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('A control patch must be an object of values');
      const clean = {};
      for (const [key, value] of Object.entries(input)) {
        if (!Object.hasOwn(spec, key)) throw new Error(`Unknown control: ${key}`);
        if (!ruleOk(spec[key], value)) throw new Error(`Invalid value for control ${key}: ${JSON.stringify(value)}`);
        clean[key] = value;
      }
      const changed = Object.fromEntries(Object.entries(clean).filter(([key, value]) => live[key] !== value));
      Object.assign(live, changed);
      if (Object.keys(changed).length) {
        show();
        apply(changed, live);
        for (const listener of [...listeners]) listener(changed, live);
        if (changed.paused !== undefined) { for (const open of [...gates]) open(); if (changed.paused) watchBoundary(); else { stopWatching(); delete job.pausedAt; } }
        recordEvent(job, { level: 'info', code: 'control', args: { changed } });
      }
      return { applied: clean, changed, values: { ...live } };
    },
    /** Be told of a change (the pool, the generation budget); the control forgets its listeners when it closes. */
    on(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    /** Resolve at once unless the job is paused; then when it is resumed. A cancel rejects with the reason. */
    waitIfPaused(signal) {
      if (live.paused !== true) return Promise.resolve();
      signal?.throwIfAborted();
      return new Promise((resolve, reject) => {
        const open = () => { if (live.paused === true) return; cleanup(); resolve(); };
        const stop = () => { cleanup(); reject(signal.reason); };
        const cleanup = () => { gates.delete(open); signal?.removeEventListener('abort', stop); };
        gates.add(open);
        signal?.addEventListener('abort', stop, { once: true });
      });
    },
    /** The job is over: nothing is left to adjust, and anything still waiting on a pause is let go. */
    close() {
      stopWatching();
      listeners.clear();
      live.paused = false;
      for (const open of [...gates]) open();
      delete job.control;
      delete job.paused;
      delete job.pausedAt;
    },
  };
  return control;
}

const int = (limits) => ({ type: 'int', min: limits.min, max: limits.max });

/**
 * An audio import: the windows of proofreading and translation run in `pools.text`, transcription in the host's gate. `setTranscribeLimit`
 * moves that gate (shared by every library of the host). Reasoning is read from the job's own `settings` when each call starts.
 */
export function audioControl({ job, settings, pools, setTranscribeLimit = () => {}, onPaused }) {
  const spec = { textConcurrency: int(TEXT_CONCURRENCY), transcribeConcurrency: int(TRANSCRIBE_CONCURRENCY),
    proofreadReasoning: { type: 'enum', values: [...EFFORT_PREFERENCES] }, translateReasoning: { type: 'enum', values: [...EFFORT_PREFERENCES] },
    autoBackoff: { type: 'bool' }, paused: { type: 'bool' } };
  const pool = pools?.text;
  return createJobControl({ job, spec, onPaused,
    values: { textConcurrency: pool?.state.limit ?? settings.textConcurrency, transcribeConcurrency: settings.transcribeConcurrency,
      proofreadReasoning: settings.proofreadReasoning || 'default', translateReasoning: settings.translateReasoning || 'low', autoBackoff: true, paused: false },
    apply(changed) {
      if (changed.textConcurrency !== undefined) { settings.textConcurrency = changed.textConcurrency; pool?.setLimit(changed.textConcurrency); }
      if (changed.transcribeConcurrency !== undefined) {
        settings.transcribeConcurrency = changed.transcribeConcurrency;
        job.parallel = { ...job.parallel, transcribe: { ...job.parallel?.transcribe, limit: changed.transcribeConcurrency } };
        setTranscribeLimit(changed.transcribeConcurrency);
      }
      for (const key of ['proofreadReasoning', 'translateReasoning']) if (changed[key] !== undefined) settings[key] = changed[key];
      if (changed.autoBackoff !== undefined) pool?.setAdaptive(changed.autoBackoff);
      if (changed.paused !== undefined) pool?.setPaused(changed.paused);
    } });
}

/** A question-generation run (and a top-up that publishes): concurrency and the reasoning of each stage. lib/batch.js and the step closure read `values`.
    No pause: a running generation has nothing checkpointed to stop at, and a pause that only blocked new calls would be a promise the run cannot keep.
    A COVERAGE RUN (lib/coverage-run.js; `rounds`: the executor's own hooks) does have a checkpoint, the boundary between two rounds: the draft keeps every round that is done. Its control adds
    `paused` (the round in flight finishes, no new round starts: `inflight` says whether a round is running, so the pause is reached at the boundary and nowhere else) and `autoComplete`
    (「自动补到完整」: after the round in flight the run goes on by itself, or waits for the learner; `onAuto` is told). */
export function generationControl({ job, request, rounds }) {
  const performance = request?.performance || {};
  const spec = { concurrency: int(GENERATION_SETTINGS_LIMITS.concurrency),
    ...Object.fromEntries(EFFORT_STAGES.map((stage) => [effortKey(stage), { type: 'enum', values: [...STAGE_EFFORT_PREFERENCES] }])),
    applySuggestions: { type: 'bool' },
    ...(rounds ? { autoComplete: { type: 'bool' }, paused: { type: 'bool' } } : {}) };
  return createJobControl({ job, spec, ...(rounds ? { inflight: rounds.inflight, onPaused: rounds.onPaused, apply: (changed) => { if (changed.autoComplete !== undefined) rounds.onAuto?.(changed.autoComplete); } } : {}),
    values: { concurrency: performance.concurrency ?? 4,
      ...Object.fromEntries(EFFORT_STAGES.map((stage) => [effortKey(stage), performance[effortKey(stage)]])),
      applySuggestions: performance.applySuggestions === true,
      ...(rounds ? { autoComplete: rounds.autoComplete !== false, paused: false } : {}) } });
}

/** A translation run: how many paragraphs it takes in the next wave, and pause between waves. */
export function translationControl({ job, limits, concurrency }) {
  return createJobControl({ job, spec: { concurrency: int(limits), paused: { type: 'bool' } }, values: { concurrency, paused: false } });
}
