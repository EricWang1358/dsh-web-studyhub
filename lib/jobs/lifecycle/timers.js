/** Per-Attempt timers. Expiry runs the real stop protocol, never a Promise.race. */
export function timerOps(k) {
  const clearTimers = entry => { for (const timer of entry.timers) clearTimeout(timer); entry.timers.clear(); };
  const timer = (entry, ms, code) => {
    if (ms == null) return;
    if (!Number.isFinite(ms) || ms < 0) throw new Error(`Invalid ${code} duration`);
    const token = setTimeout(() => { entry.timers.delete(token); k.stop(entry, code); }, ms);
    entry.timers.add(token); return token;
  };
  const removeTimer = (entry, token) => { clearTimeout(token); entry.timers.delete(token); };
  return { clearTimers, timer, removeTimer };
}
