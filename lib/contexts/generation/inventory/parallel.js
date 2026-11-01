import { TEXT_CONCURRENCY, clampCount, createPool } from '../../../audio-pool.js';

/* The parallel calls of one attempt (the inventory, the outline's grouping, the book's writing, review and repair): ONE sliding pool per attempt (lib/audio-pool.js, the
   audio pipeline's), so a finished call is replaced at once and no more than the learner's text concurrency run together. A refusal for a rate or concurrency
   reason (429) lowers the pool, waits (a 'wait' Call the console draws) and asks again; after calm calls it climbs back to the setting.
   Each call is a Step of the gateway, answered from `kept.results` when this Job finished it before (a retry, a resume). An unreadable answer is asked once
   more, a provider error once more; then the call fails ALONE (null): the caller marks its part and goes on. A pause lets the running calls finish, starts no
   new one, and stops at a checkpoint; a stop aborts. */

const REASK = '\n\nYour previous reply could not be read. Reply with the JSON only, exactly in the shape described.';
const FATAL_CODES = new Set(['book-paused', 'model-unavailable', 'capability-unverified', 'model-policy-required', 'agent-unavailable', 'execution-mode-unsupported']);
const paused = () => Object.assign(new Error('paused at a checkpoint'), { code: 'book-paused' });
const stepKey = (key, tries) => (tries === 0 ? key : `${key}:r${tries}`);

/** @param ctx { context, kept, state, show, boundary }; `limit` the learner's text concurrency. -> { ask, each, pool } */
export function createParallel(ctx, { limit } = {}) {
  const { context, kept, state, show } = ctx, waits = new Map(), tag = String(context.attemptId ?? 'a').slice(0, 8);
  const openWait = ({ id, slot }) => {
    let release;
    const done = new Promise(resolve => { release = resolve; });
    waits.set(id, release);
    const step = context.gateway.step(`wait:${tag}:${id}`, { purpose: 'wait', feature: 'other', budget: null }, { labels: Number.isInteger(slot) ? { slot } : {} });
    void step.run(() => step.observe({ boundary: 'local-wait', kind: 'wait', reason: 'rate-limit' }, () => done)).catch(() => {});
  };
  const pool = createPool({ limit: clampCount(limit, TEXT_CONCURRENCY),
    onChange: now => { state.pool = { limit: now.limit, effective: now.effective, lowered: now.lowered }; show(); },
    onWait: event => { if (event.phase === 'start') openWait(event); else { waits.get(event.id)?.(); waits.delete(event.id); } } });

  /** One call: the parsed answer, or null when it failed (unreadable twice, or a provider error twice). `policy` is the gateway policy of its stage. */
  async function ask(key, labels, policy, { system, prompt }, read) {
    if (kept.results.has(key)) { await context.gateway.step(key, policy, { labels }).reuse('kept'); state.reused++; return kept.results.get(key); }
    let unreadable = 0, threw = 0, tries = 0;
    while (unreadable < 2) {
      if (context.pauseRequested) throw paused();
      let text;
      try {
        text = await pool.run(async (_attempt, slot) => {
          if (context.pauseRequested) throw paused();
          return context.gateway.step(stepKey(key, tries++), policy, { labels: { ...labels, slot } }).complete(system, unreadable ? `${prompt}${REASK}` : prompt);
        }, { signal: context.signal });
      } catch (error) {
        if (FATAL_CODES.has(error?.code) || error?.fatal || context.signal.aborted || error?.name === 'AbortError') throw error;
        if (threw++ >= 1) { state.failedCalls = (state.failedCalls ?? 0) + 1; return null; }
        continue;
      }
      const parsed = read(text);
      if (parsed) { kept.results.set(key, parsed); return parsed; }
      unreadable++;
    }
    state.failedCalls = (state.failedCalls ?? 0) + 1;
    return null;
  }

  /** Runs `worker(item)` for every item at once (the pool admits them); a pause stops at checkpoint `ref` once the running calls are done, and a resume of the
      same attempt (pause lifted) goes on with what is left. -> the workers' results in order. A stop or a bug of a worker is thrown. */
  async function each(items, worker, ref) {
    const results = new Array(items.length);
    let left = items.map((item, at) => ({ item, at }));
    while (left.length) {
      const settled = await Promise.allSettled(left.map(({ item }) => worker(item)));
      const failure = settled.find(entry => entry.status === 'rejected' && entry.reason?.code !== 'book-paused');
      if (failure) throw failure.reason;
      const next = [];
      settled.forEach((entry, k) => { if (entry.status === 'fulfilled') results[left[k].at] = entry.value; else next.push(left[k]); });
      left = next;
      if (left.length && !ctx.boundary(ref)) continue;
    }
    return results;
  }
  return { ask, each, pool };
}
