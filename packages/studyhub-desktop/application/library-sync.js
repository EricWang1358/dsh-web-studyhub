const cleanText = (value, fallback) => (
  typeof value === 'string' && value.trim() ? value.trim() : fallback
);

async function forwardNotify(forward, args) {
  const answer = await forward('library.notifyChanged', args);
  if (!answer.ok) {
    throw Object.assign(new Error(answer.error?.message || '刷新通知失败'), { code: answer.error?.code });
  }
  return answer.value;
}

/**
 * Application-layer coordinator that keeps desktop SSE subscribers bound to the active library root
 * across `binding.set` switches and handles explicit `library.notifyChanged` / `ui.refresh` triggers.
 */
export function createDesktopLibrarySync({ libraryEvents = null, getRoot, forward }) {
  const subscribers = new Set();
  let watchedRoot = '';
  let unsubscribeRoot = null;

  const emit = (event) => {
    for (const listener of [...subscribers]) {
      try { listener(event); } catch { /* isolate listener failure */ }
    }
  };

  function syncWatcher() {
    if (!libraryEvents) return;
    const targetRoot = subscribers.size > 0 ? getRoot() : '';
    if (targetRoot === watchedRoot) return;
    unsubscribeRoot?.();
    unsubscribeRoot = null;
    watchedRoot = targetRoot;
    if (targetRoot) unsubscribeRoot = libraryEvents.subscribe(targetRoot, emit);
  }

  function subscribeEvents(listener) {
    if (typeof listener !== 'function') return () => {};
    subscribers.add(listener);
    syncWatcher();
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      subscribers.delete(listener);
      syncWatcher();
    };
  }

  async function runNotifyChanged(args = {}) {
    if (!libraryEvents) return forwardNotify(forward, args);
    const root = getRoot();
    const reason = cleanText(args?.reason, 'explicit');
    const source = cleanText(args?.source, 'desktop');
    const meta = await libraryEvents.readMeta(root);
    const payload = { revision: meta.revision, stamp: meta.stamp, reason };
    if (Array.isArray(args?.changedAreas)) payload.changedAreas = args.changedAreas;
    libraryEvents.publish(root, payload);
    if (args?.broadcastDisk === true) await libraryEvents.writeSignal(root, { source, reason }).catch(() => {});
    return { ok: true, notified: true, root: meta.root, revision: meta.revision, stamp: meta.stamp };
  }

  // Serialize explicit notifications so concurrent readMeta calls publish in invocation order.
  let notifyChain = Promise.resolve();
  function notifyChanged(args = {}) {
    const next = notifyChain.then(() => runNotifyChanged(args), () => runNotifyChanged(args));
    notifyChain = next.catch(() => {});
    return next;
  }

  function dispose() {
    subscribers.clear();
    unsubscribeRoot?.();
    unsubscribeRoot = null;
    watchedRoot = '';
    libraryEvents?.dispose?.();
  }

  return Object.freeze({ subscribeEvents, syncWatcher, notifyChanged, dispose });
}
