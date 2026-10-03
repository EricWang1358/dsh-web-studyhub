/* The panel's single-flight action runner (App's act()).
   One write at a time: a second act() while one is in flight is dropped, so an
   answer or a generation job can never be submitted twice. The lock covers the
   host call and its `after` callback. The library snapshot that follows
   (about 1MB with sources, seconds on a big library) is awaited for at most
   `holdMs`: long enough that list-changing actions normally finish with fresh
   data, short enough that 下一题 / 继续学习 / 回到之前的第 N 题 never sit
   disabled behind a slow snapshot ("有时候下一题点了会卡住"). */
export const REFRESH_HOLD_MS = 800;

/** `read()` returns { call, refresh, epoch, navigation?, setBusy, setError, holdMs? } at call time.
 * `afterNavigation` keeps essential follow-up work running; its UI still uses the supplied `isCurrent` guard. */
export function createActRunner(read) {
  let current = null;
  async function act(action, args = {}, after, { refreshAfter = true, rethrow = false, afterNavigation = false } = {}) {
    if (current) return;
    const deps = read(), operation = {}, epoch = deps.epoch(), navigation = deps.navigation?.();
    const isCurrent = () => epoch === deps.epoch() && navigation === deps.navigation?.();
    current = operation;
    deps.setBusy(true);
    deps.setError("");
    try {
      const result = await deps.call(action, args);
      if (epoch !== deps.epoch()) return;
      if (after && (afterNavigation || isCurrent())) await after(result, { isCurrent });
      const reload = typeof refreshAfter === "function" ? refreshAfter(result) : refreshAfter;
      if (reload && epoch === deps.epoch()) {
        // The failure belongs to the sync, not to the action that already succeeded.
        const pending = Promise.resolve().then(() => deps.refresh()).catch((error) => {
          if (isCurrent()) deps.setError(error?.message || String(error));
        });
        let timer;
        await Promise.race([pending, new Promise((done) => { timer = setTimeout(done, deps.holdMs ?? REFRESH_HOLD_MS); })]);
        clearTimeout(timer);
      }
      return result;
    } catch (error) {
      if (epoch !== deps.epoch()) return;
      if (rethrow) throw error;
      if (isCurrent()) deps.setError(error?.message || String(error));
    } finally {
      if (current === operation) { current = null; deps.setBusy(false); }
    }
  }
  return {
    act,
    busy: () => !!current,
    /** The library changed: whatever was in flight no longer owns the lock. */
    reset() { current = null; },
  };
}
