import {
  LIBRARY_CHANGED_EVENT,
  createLibraryEventBus,
  readLibraryMeta,
  writeRefreshSignal,
} from '../../../../lib/runtime/library-watch.js';

export { LIBRARY_CHANGED_EVENT };

/**
 * Node filesystem adapter exposing library manifest watching and refresh signaling
 * as a clean port for StudyHub Desktop's application layer.
 */
export function createDesktopLibraryEvents(options = {}) {
  const bus = createLibraryEventBus(options);
  return Object.freeze({
    subscribe: (root, listener) => bus.subscribe(root, listener),
    publish: (root, payload) => bus.publish(root, payload),
    waitForChange: (root, waitOptions) => bus.waitForChange(root, waitOptions),
    readMeta: (root) => readLibraryMeta(root, { includeRevision: true }),
    writeSignal: (root, signalOptions) => writeRefreshSignal(root, signalOptions),
    dispose: () => bus.dispose(),
    activeWatcherCount: () => bus.activeWatcherCount(),
  });
}
