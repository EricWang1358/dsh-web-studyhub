import { createUsageCollector } from './collector.js';
import { installUsageCapture } from './capture.js';

/* Owns the usage frequency record on the page: asks the host once whether it is on, installs the capture and the page-lifecycle flush only while
   it is on and not paused, and takes both away the moment it is turned off or paused. While it is off there is nothing here but this module's
   own list of subscribers: no DOM listener, no timer, no request after the first status read.

   Settings announces a change with notifyUsageChanged(); a controller then asks the host again. Before the switch is turned off or paused
   Settings calls flushUsageNow() so the counts of the last seconds are not lost (the host refuses records once it is off). */

const listeners = new Set(), controllers = new Set();
/** The page tells every controller that the switch or the pause changed. */
export const notifyUsageChanged = () => { for (const fn of [...listeners]) fn(); };
export const onUsageChanged = fn => { listeners.add(fn); return () => listeners.delete(fn); };
/** Send what every controller is holding. Resolves when all have answered. */
export const flushUsageNow = () => Promise.all([...controllers].map(controller => controller.flush())).then(() => undefined);

const browserLifecycle = () => ({
  addEventListener: (type, fn) => (type === 'visibilitychange' ? document : window).addEventListener(type, fn),
  removeEventListener: (type, fn) => (type === 'visibilitychange' ? document : window).removeEventListener(type, fn),
});

export function createUsageController({ root, call, lifecycle, keyScope, now = Date.now, setTimer, clearTimer } = {}) {
  let collector = null, uninstall = null, queue = Promise.resolve(), disposed = false, flushHandler = null;
  const life = () => lifecycle || browserLifecycle();
  const scope = () => keyScope || (root && root.ownerDocument && typeof root.ownerDocument.addEventListener === 'function' ? root.ownerDocument : root);
  const timers = { ...(setTimer ? { setTimer } : {}), ...(clearTimer ? { clearTimer } : {}) };

  function start() {
    collector = createUsageCollector({ send: records => call('usage.frequency.record', { records }), now, onRefused: () => { void api.refresh(); }, ...timers });
    collector.start();
    uninstall = installUsageCapture(root, { record: (key, area) => collector.record(key, area), keyScope: scope() });
    flushHandler = () => { void collector?.flush(); };
    life().addEventListener('pagehide', flushHandler);
    life().addEventListener('visibilitychange', flushHandler);
    api.active = true;
  }
  async function stop() {
    api.active = false;
    uninstall?.(); uninstall = null;
    if (flushHandler) { life().removeEventListener('pagehide', flushHandler); life().removeEventListener('visibilitychange', flushHandler); flushHandler = null; }
    const old = collector; collector = null;
    await old?.stop();
  }
  const api = {
    active: false,
    /** Ask the host whether the record is on (and not paused) and make the page match. An unreadable status means off. */
    refresh() {
      queue = queue.then(async () => {
        if (disposed) return;
        let status = null;
        try { status = await call('usage.frequency.status', {}); } catch { status = null; }
        const wanted = !!status && status.enabled === true && status.paused !== true;
        if (wanted && !api.active) start();
        else if (!wanted && api.active) await stop();
      }).catch(() => {});
      return queue;
    },
    flush: () => collector?.flush() ?? Promise.resolve(),
    dispose() {
      disposed = true;
      unsubscribe();
      controllers.delete(api);
      void stop();
    },
  };
  const unsubscribe = onUsageChanged(() => { void api.refresh(); });
  controllers.add(api);
  return api;
}
