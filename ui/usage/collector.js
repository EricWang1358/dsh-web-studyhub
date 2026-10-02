/* The in-memory side of the usage frequency record: counts per (day, page, control key), sent to the host in batches. Plain functions, no React:
   nothing here can re-render anything. One event costs a Map lookup and an increment.

   - nothing is started until `start()`, and no timer exists until the first event after a flush: while idle (or off) there is no timer;
   - the same key twice inside `throttleMs` counts once (double events, held keys);
   - at most `maxPending` distinct (day, page, key) cells wait; beyond that new ones fold into `other`;
   - a flush that fails keeps its counts for the next one; a flush the host refuses (the record was turned off or paused) drops them. */

const DAY_START = date => new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
const label = date => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;

export function createUsageCollector({ send, now = Date.now, setTimer = (fn, ms) => setTimeout(fn, ms), clearTimer = id => clearTimeout(id),
  flushMs = 30000, throttleMs = 150, maxPending = 400, onRefused } = {}) {
  const pending = new Map(), last = new Map();
  let running = false, timer = null, day = '', dayUntil = 0, dayFrom = Infinity;
  // The local date, recomputed only when the clock leaves the day it was last computed for (midnight, or a clock change).
  const today = at => {
    if (at < dayFrom || at >= dayUntil) { const date = new Date(at); day = label(date); dayFrom = DAY_START(date); dayUntil = new Date(date.getFullYear(), date.getMonth(), date.getDate() + 1).getTime(); }
    return day;
  };
  const add = (cellDay, area, key, n) => {
    let id = `${cellDay}\u0000${area}\u0000${key}`;
    let cell = pending.get(id);
    if (!cell && pending.size >= maxPending) { key = 'other'; id = `${cellDay}\u0000${area}\u0000other`; cell = pending.get(id); }
    if (cell) cell.n += n; else pending.set(id, { key, area, day: cellDay, n });
  };
  const arm = () => { if (running && !timer && pending.size) timer = setTimer(() => { timer = null; void api.flush(); }, flushMs); };
  const api = {
    start() { running = true; },
    /** Count one use of `key` on page `area`. False when it was throttled or the collector is stopped. */
    record(key, area) {
      if (!running) return false;
      const at = now(), before = last.get(key);
      if (before !== undefined && at - before >= 0 && at - before < throttleMs) return false;
      last.set(key, at);
      if (last.size > 2000) last.clear();
      add(today(at), area, key, 1);
      arm();
      return true;
    },
    pending: () => pending.size,
    /** Send what is waiting as one batch. Resolves when the host has answered; never throws. */
    async flush() {
      if (!pending.size) return;
      const batch = [...pending.values()];
      pending.clear();
      if (timer) { clearTimer(timer); timer = null; }
      try {
        const answer = await send(batch);
        if (answer && answer.enabled === false) { pending.clear(); running = false; onRefused?.(); }
      } catch {
        for (const cell of batch) add(cell.day, cell.area, cell.key, cell.n);
        arm();
      }
    },
    /** Send what is left and stop: no timer, nothing recorded afterwards. */
    async stop() {
      if (timer) { clearTimer(timer); timer = null; }
      await api.flush();
      running = false;
      pending.clear();
      last.clear();
    },
  };
  return api;
}
