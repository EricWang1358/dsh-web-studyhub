import { randomUUID } from 'node:crypto';
import { watch as fsWatch } from 'node:fs';
import { access, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { parseStoredJson } from '../util.js';

export const MANIFEST_FILENAME = 'study-workspace.json';
export const SIGNAL_FILENAME = '.studyhub-sync-signal';
export const LIBRARY_CHANGED_EVENT = 'study:library-changed';

const DEFAULT_DEBOUNCE_MS = 200;
const RETRY_READ_MS = 50;
const RETRY_CODES = new Set(['EPERM', 'EACCES', 'EBUSY']);

function normalizeRootKey(root) {
  const resolved = resolve(String(root || ''));
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function matchesFilename(candidate, expected) {
  if (!candidate) return true;
  const name = String(candidate);
  if (process.platform === 'win32') return name.toLowerCase() === expected.toLowerCase();
  return name === expected;
}

async function statToken(filePath, statImpl = stat) {
  try {
    const info = await statImpl(filePath, { bigint: true });
    return `${info.mtimeNs}:${info.size}:${info.ino}`;
  } catch (error) {
    if (error?.code === 'ENOENT') return 'missing';
    throw error;
  }
}

async function replaceFile(tempPath, targetPath) {
  for (let attempt = 0; ; attempt++) {
    try {
      await rename(tempPath, targetPath);
      return;
    } catch (error) {
      if (!RETRY_CODES.has(error?.code) || attempt >= 5) throw error;
      await new Promise((done) => {
        const timer = setTimeout(done, 15 * (attempt + 1));
        timer.unref?.();
      });
    }
  }
}

/**
 * Cheaply inspect a library's manifest stamp (single `stat`) and optionally parse its `revision`.
 * Reading the small manifest file never touches any shards.
 */
export async function readLibraryMeta(root, { statImpl = stat, readFileImpl = readFile, includeRevision = true } = {}) {
  const resolvedRoot = resolve(String(root || ''));
  const manifestPath = join(resolvedRoot, MANIFEST_FILENAME);
  const stamp = await statToken(manifestPath, statImpl);
  if (stamp === 'missing' || !includeRevision) {
    return { root: resolvedRoot, stamp, revision: stamp === 'missing' ? 0 : null };
  }
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const raw = await readFileImpl(manifestPath, 'utf8');
      const parsed = parseStoredJson(raw);
      const revision = Number.isSafeInteger(parsed?.revision) ? parsed.revision : null;
      return { root: resolvedRoot, stamp, revision };
    } catch (error) {
      if (error?.code === 'ENOENT') return { root: resolvedRoot, stamp: 'missing', revision: 0 };
      if (attempt === 0) {
        await new Promise((done) => {
          const timer = setTimeout(done, RETRY_READ_MS);
          timer.unref?.();
        });
        continue;
      }
      return { root: resolvedRoot, stamp, revision: null };
    }
  }
  return { root: resolvedRoot, stamp, revision: null };
}

/**
 * Write an idempotent local refresh signal beside `study-workspace.json` so any running StudyHub
 * desktop/web host watching `root` pushes an immediate UI refresh. Silent no-op if no host is running
 * or if `root` does not exist yet.
 */
export async function writeRefreshSignal(root, { source = 'cli', reason = 'explicit', now = Date.now, statImpl = stat, readFileImpl = readFile } = {}) {
  const resolvedRoot = resolve(String(root || ''));
  try {
    await access(resolvedRoot);
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return { ok: true, notified: false, root: resolvedRoot, revision: null, stamp: 'missing' };
    }
    throw error;
  }
  const meta = await readLibraryMeta(resolvedRoot, { statImpl, readFileImpl, includeRevision: true });
  const target = join(resolvedRoot, SIGNAL_FILENAME);
  const temp = `${target}.${randomUUID()}.tmp`;
  const payload = {
    revision: meta.revision,
    stamp: meta.stamp,
    source: String(source || 'cli'),
    reason: String(reason || 'explicit'),
    at: now(),
  };
  try {
    await writeFile(temp, `${JSON.stringify(payload)}\n`, { encoding: 'utf8', flag: 'wx' });
    await replaceFile(temp, target);
  } finally {
    await rm(temp, { force: true }).catch(() => {});
  }
  return {
    ok: true,
    notified: true,
    root: resolvedRoot,
    revision: meta.revision,
    stamp: meta.stamp,
    at: payload.at,
  };
}

/**
 * Event-driven watcher for one library directory. Watches the parent directory so atomic
 * `rename(tmp, study-workspace.json)` commits are always observed on Windows, macOS, and Linux.
 * Uses debounced `stat` verification and zero background polling timers while idle.
 */
export function createLibraryWatcher({
  root,
  debounceMs = DEFAULT_DEBOUNCE_MS,
  onChange,
  watchImpl = fsWatch,
  statImpl = stat,
  readFileImpl = readFile,
  now = Date.now,
}) {
  const resolvedRoot = resolve(String(root || ''));
  const signalPath = join(resolvedRoot, SIGNAL_FILENAME);
  let closed = false;
  let watcher = null;
  let debounceTimer = null;
  let checking = false;
  let pendingCheck = false;
  let pendingSignal = false;
  let quietWrites = 0;
  let lastStamp = null;
  let lastRevision = null;
  let lastSignalStamp = null;
  let initialized = false;
  let baselinePromise = null;

  function initBaseline() {
    if (baselinePromise) return baselinePromise;
    baselinePromise = (async () => {
      if (closed) return;
      try {
        const [meta, sigStamp] = await Promise.all([
          readLibraryMeta(resolvedRoot, { statImpl, readFileImpl, includeRevision: true }),
          statToken(signalPath, statImpl),
        ]);
        if (closed) return;
        if (lastStamp === null) lastStamp = meta.stamp;
        if (lastRevision === null) lastRevision = meta.revision;
        if (lastSignalStamp === null) lastSignalStamp = sigStamp;
      } catch {
        // Directory may not exist yet; subsequent checks re-read cleanly.
      } finally {
        if (!closed) initialized = true;
      }
    })();
    return baselinePromise;
  }

  async function checkNow({ force = false, signalTriggered = false } = {}) {
    if (closed) return null;
    if (quietWrites > 0 && !force && !signalTriggered) {
      pendingCheck = true;
      return null;
    }
    if (!initialized) await initBaseline();
    if (closed) return null;
    if (quietWrites > 0 && !force && !signalTriggered) {
      pendingCheck = true;
      return null;
    }
    if (checking) {
      pendingCheck = true;
      if (signalTriggered || force) pendingSignal = true;
      return null;
    }
    checking = true;
    try {
      const [manifestStamp, sigStamp] = await Promise.all([
        statToken(join(resolvedRoot, MANIFEST_FILENAME), statImpl),
        signalTriggered || force ? statToken(signalPath, statImpl) : Promise.resolve(lastSignalStamp),
      ]);
      if (closed) return null;
      if (quietWrites > 0 && !force && !signalTriggered) {
        pendingCheck = true;
        return null;
      }

      const manifestChanged = lastStamp !== null && manifestStamp !== lastStamp;
      const signalChanged = (signalTriggered || force) && sigStamp !== 'missing' && sigStamp !== lastSignalStamp;

      if (!manifestChanged && !signalChanged && !force) {
        if (lastStamp === null) lastStamp = manifestStamp;
        if (lastSignalStamp === null) lastSignalStamp = sigStamp;
        return null;
      }

      let revision = lastRevision;
      if (manifestChanged || lastRevision === null || force) {
        const meta = await readLibraryMeta(resolvedRoot, { statImpl, readFileImpl, includeRevision: true });
        if (closed) return null;
        if (quietWrites > 0 && !force && !signalTriggered) {
          pendingCheck = true;
          return null;
        }
        lastStamp = meta.stamp;
        lastRevision = meta.revision;
        revision = meta.revision;
      }
      if (sigStamp !== undefined) lastSignalStamp = sigStamp;

      const event = {
        type: LIBRARY_CHANGED_EVENT,
        root: resolvedRoot,
        revision,
        stamp: lastStamp,
        reason: signalChanged || force ? 'explicit' : 'disk',
        at: now(),
      };
      onChange?.(event);
      return event;
    } catch {
      return null;
    } finally {
      checking = false;
      if (pendingCheck && !closed) {
        const nextSignal = pendingSignal;
        pendingCheck = false;
        pendingSignal = false;
        void checkNow({ signalTriggered: nextSignal });
      }
    }
  }

  function scheduleCheck(signalTriggered = false) {
    if (closed) return;
    if (signalTriggered) pendingSignal = true;
    if (debounceTimer !== null) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      const sig = pendingSignal;
      pendingSignal = false;
      void checkNow({ signalTriggered: sig });
    }, Math.max(0, debounceMs));
    debounceTimer.unref?.();
  }

  function startWatching() {
    if (closed || watcher) return;
    try {
      watcher = watchImpl(resolvedRoot, { persistent: false }, (_eventType, filename) => {
        if (closed) return;
        const isManifest = matchesFilename(filename, MANIFEST_FILENAME);
        const isSignal = matchesFilename(filename, SIGNAL_FILENAME);
        if (!isManifest && !isSignal) return;
        scheduleCheck(isSignal && Boolean(filename));
      });
      watcher?.on?.('error', () => {
        try { watcher?.close?.(); } catch { /* ignore */ }
        watcher = null;
      });
    } catch {
      watcher = null;
    }
  }

  void initBaseline();
  startWatching();

  return Object.freeze({
    root: resolvedRoot,
    checkNow,
    recordBroadcast(stamp, revision) {
      if (stamp !== undefined && stamp !== null) lastStamp = stamp;
      if (revision !== undefined) lastRevision = revision;
      initialized = true;
    },
    beginQuietWrite() {
      quietWrites += 1;
      let released = false;
      return () => {
        if (released) return;
        released = true;
        quietWrites = Math.max(0, quietWrites - 1);
        if (quietWrites === 0 && pendingCheck && !closed) {
          const nextSignal = pendingSignal;
          pendingCheck = false;
          pendingSignal = false;
          void checkNow({ signalTriggered: nextSignal });
        }
      };
    },
    getMeta: () => ({ root: resolvedRoot, stamp: lastStamp, revision: lastRevision }),
    dispose() {
      if (closed) return;
      closed = true;
      if (debounceTimer !== null) {
        clearTimeout(debounceTimer);
        debounceTimer = null;
      }
      try { watcher?.close?.(); } catch { /* ignore */ }
      watcher = null;
    },
  });
}

/**
 * Ref-counted per-root watcher and pub/sub bus shared by a host process.
 * Directories are watched only while at least one subscriber is active.
 */
export function createLibraryEventBus({
  debounceMs = DEFAULT_DEBOUNCE_MS,
  watchImpl = fsWatch,
  statImpl = stat,
  readFileImpl = readFile,
  now = Date.now,
} = {}) {
  const roots = new Map();
  const waiters = new Set();
  let disposed = false;

  function ensureEntry(root) {
    const resolvedRoot = resolve(String(root || ''));
    const key = normalizeRootKey(resolvedRoot);
    let entry = roots.get(key);
    if (!entry) {
      const listeners = new Set();
      const watcher = createLibraryWatcher({
        root: resolvedRoot,
        debounceMs,
        watchImpl,
        statImpl,
        readFileImpl,
        now,
        onChange(event) {
          for (const listener of [...listeners]) {
            try { listener(event); } catch { /* isolate subscriber errors */ }
          }
        },
      });
      entry = { key, root: resolvedRoot, watcher, listeners };
      roots.set(key, entry);
    }
    return entry;
  }

  function subscribe(root, listener) {
    if (disposed || !root || typeof listener !== 'function') return () => {};
    const entry = ensureEntry(root);
    entry.listeners.add(listener);
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      entry.listeners.delete(listener);
      if (entry.listeners.size === 0) {
        entry.watcher.dispose();
        if (roots.get(entry.key) === entry) roots.delete(entry.key);
      }
    };
  }

  function publish(root, payload = {}) {
    if (disposed || !root) return null;
    const resolvedRoot = resolve(String(root));
    const key = normalizeRootKey(resolvedRoot);
    const event = {
      type: LIBRARY_CHANGED_EVENT,
      root: resolvedRoot,
      revision: payload.revision ?? null,
      stamp: payload.stamp ?? null,
      reason: payload.reason || 'explicit',
      ...(Array.isArray(payload.changedAreas) ? { changedAreas: payload.changedAreas } : {}),
      at: payload.at ?? now(),
    };
    const entry = roots.get(key);
    if (!entry) return event;
    if (event.stamp) entry.watcher.recordBroadcast(event.stamp, event.revision);
    for (const listener of [...entry.listeners]) {
      try { listener(event); } catch { /* isolate subscriber errors */ }
    }
    return event;
  }

  /** Record a host-initiated local write so its own manifest rename does not trigger a redundant disk refresh event. */
  function acknowledgeWrite(root, { stamp = null, revision = null } = {}) {
    if (disposed || !root || !stamp) return false;
    const resolvedRoot = resolve(String(root));
    const entry = roots.get(normalizeRootKey(resolvedRoot));
    if (!entry) return false;
    entry.watcher.recordBroadcast(stamp, revision);
    return true;
  }

  /** Defer disk-watcher emissions while a quiet local mutation commits and acknowledges its resulting manifest stamp. */
  function beginQuietWrite(root) {
    if (disposed || !root) return () => {};
    const resolvedRoot = resolve(String(root));
    const entry = roots.get(normalizeRootKey(resolvedRoot));
    if (!entry) return () => {};
    return entry.watcher.beginQuietWrite();
  }

  async function waitForChange(root, { sinceStamp = null, sinceRevision = null, timeoutMs = 25000, signal } = {}) {
    const resolvedRoot = resolve(String(root || ''));
    if (disposed) return { changed: false, root: resolvedRoot, revision: null, stamp: null };
    const current = await readLibraryMeta(resolvedRoot, { statImpl, readFileImpl, includeRevision: true });
    const stampChanged = typeof sinceStamp === 'string' && sinceStamp.length > 0 && current.stamp !== sinceStamp;
    const revisionChanged = Number.isSafeInteger(sinceRevision) && Number.isSafeInteger(current.revision) && current.revision !== sinceRevision;
    if (stampChanged || revisionChanged) {
      return {
        changed: true,
        root: resolvedRoot,
        revision: current.revision,
        stamp: current.stamp,
        reason: 'disk',
        at: now(),
      };
    }

    const boundedTimeout = Math.min(Math.max(Number(timeoutMs) || 25000, 50), 30000);
    return new Promise((resolveWait) => {
      let settled = false;
      let timer = null;
      let unsubscribe = () => {};

      const finish = (result) => {
        if (settled) return;
        settled = true;
        waiters.delete(onDispose);
        if (timer !== null) {
          clearTimeout(timer);
          timer = null;
        }
        signal?.removeEventListener?.('abort', onAbort);
        unsubscribe();
        resolveWait(result);
      };

      const onDispose = () => finish({
        changed: false,
        root: resolvedRoot,
        revision: current.revision,
        stamp: current.stamp,
      });
      waiters.add(onDispose);

      const onAbort = () => onDispose();

      if (signal?.aborted) {
        onAbort();
        return;
      }
      signal?.addEventListener?.('abort', onAbort, { once: true });

      unsubscribe = subscribe(resolvedRoot, (event) => {
        finish({
          changed: true,
          root: event.root,
          revision: event.revision,
          stamp: event.stamp,
          reason: event.reason || 'disk',
          at: event.at,
        });
      });

      timer = setTimeout(() => {
        finish({
          changed: false,
          root: resolvedRoot,
          revision: current.revision,
          stamp: current.stamp,
        });
      }, boundedTimeout);
    });
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    for (const wake of [...waiters]) wake();
    waiters.clear();
    for (const entry of roots.values()) {
      entry.watcher.dispose();
      entry.listeners.clear();
    }
    roots.clear();
  }

  return Object.freeze({
    subscribe,
    publish,
    acknowledgeWrite,
    beginQuietWrite,
    waitForChange,
    dispose,
    activeWatcherCount: () => roots.size,
  });
}
