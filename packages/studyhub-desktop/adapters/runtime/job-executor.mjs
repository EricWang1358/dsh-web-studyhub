import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';

const OUTPUT_CAP = 65536;
const MAX_SETTLED = 512;
const RETIRED_CAP = 4096;

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

function appendRingBuffer(entry, text) {
  const chunk = String(text ?? '');
  if (!chunk || (entry.status !== 'running' && entry.status !== 'stopping')) return;
  entry.log += chunk;
  if (entry.log.length > OUTPUT_CAP) {
    const drop = entry.log.length - OUTPUT_CAP;
    entry.log = entry.log.slice(drop);
    entry.offset += drop;
  }
}

function readRingBuffer(entry, cursor = 0) {
  if (!entry) return { chunks: [], text: '', cursor: 0 };
  const from = Number.isFinite(cursor) && cursor > 0 ? Math.floor(cursor) : 0;
  const end = entry.offset + entry.log.length;
  if (from >= end) return { chunks: [], text: '', cursor: end };
  const text = entry.log.slice(Math.max(0, from - entry.offset));
  return { chunks: text ? [text] : [], text, cursor: end };
}

function trimSettledHandles(handles, retired) {
  if (handles.size <= MAX_SETTLED) return;
  for (const [id, entry] of handles) {
    if (handles.size <= MAX_SETTLED) break;
    if (entry.status === 'completed' || entry.status === 'failed' || entry.status === 'killed') {
      handles.delete(id);
      retired.add(id);
      if (retired.size > RETIRED_CAP) {
        retired.delete(retired.values().next().value);
      }
    }
  }
}

function resolveSettlementStatus(outcome, stopped) {
  if (outcome?.status === 'completed' || outcome?.status === 'failed' || outcome?.status === 'killed') {
    return outcome.status;
  }
  return stopped ? 'killed' : 'completed';
}

function stopJobEntry(entry, reason) {
  if (!entry || entry.stopped) return undefined;
  entry.stopped = true;
  if (entry.status === 'running') entry.status = 'stopping';
  return entry.cancel?.(reason);
}

function inspectJobWitness({ ref, witness, host, instance, alive, handles }) {
  if (!witness || witness.host !== host || !Number.isSafeInteger(witness.pid) || witness.pid <= 0) {
    return { state: 'unknown', reason: 'incompatible-executor-witness' };
  }
  if (witness.instance !== instance) {
    return alive(witness.pid)
      ? { state: 'unknown', reason: 'executor-process-unconfirmed' }
      : { state: 'lost', reason: 'executor-process-exited' };
  }
  const handleId = ref?.handleId;
  if (!handleId) return { state: 'unknown', reason: 'executor-binding-unconfirmed' };
  const entry = handles.get(handleId);
  if (entry && (entry.status === 'running' || entry.status === 'stopping')) {
    return { state: 'alive', reason: 'in-process-active' };
  }
  return { state: 'lost', reason: 'in-process-settled' };
}

function buildDshJobsService(handles, launchEntry) {
  return Object.freeze({
    start({ owner, kind, label, run }) {
      return launchEntry({ owner, kind, label, run }).id;
    },
    get(id, owner) {
      const entry = handles.get(id);
      if (!entry || entry.owner !== owner) return undefined;
      return { id: entry.id, owner: entry.owner, status: entry.status };
    },
    kill(id, owner, reason) {
      const entry = handles.get(id);
      if (!entry || entry.owner !== owner) return undefined;
      return stopJobEntry(entry, reason);
    },
    readAt(id, cursor, owner) {
      const entry = handles.get(id);
      if (!entry || entry.owner !== owner) return { chunks: [], text: '', cursor: 0 };
      return readRingBuffer(entry, cursor);
    },
  });
}

/**
 * In-process background job executor compatible with StudyHub v4.14.0 `lib/jobs/executor.js`.
 * Exposes both direct `jobExecutor` methods (`witness`, `inspect`, `start`, `assertAvailable`)
 * and `asDshJobsService()` for wiring into `lib/host.js`'s `dshJobExecutor`.
 */
export function createInProcessJobExecutor({
  pid = process.pid,
  host = `${process.platform}:${hostname()}`,
  alive = pidAlive,
  ownerAgentId = 'desktop',
  log = console.error,
} = {}) {
  const instance = randomUUID();
  const handles = new Map();
  const retired = new Set();
  let seq = 0;

  function launchEntry({ owner, kind, label, run, cancel }) {
    const id = `desktop-${instance.slice(0, 8)}-${(seq += 1)}`;
    const entry = { id, owner, kind, label: label || kind, status: 'running', log: '', offset: 0, cancel: null, stopped: false };
    handles.set(id, entry);
    const face = Object.freeze({ append: (text) => appendRingBuffer(entry, text) });
    const started = typeof run === 'function' ? run(face) : { done: Promise.resolve(), cancel };
    const donePromise = started && typeof started === 'object' && 'done' in started ? started.done : started;
    entry.cancel = typeof started?.cancel === 'function' ? started.cancel : (typeof cancel === 'function' ? cancel : null);

    void Promise.resolve(donePromise).then(
      (outcome) => { entry.status = resolveSettlementStatus(outcome, entry.stopped); trimSettledHandles(handles, retired); },
      (error) => { entry.status = entry.stopped ? 'killed' : 'failed'; log(`[studyhub-desktop] background job ${id} rejected:`, error?.stack ?? error); trimSettledHandles(handles, retired); },
    );
    return entry;
  }

  function start({ kind, title, run, cancel }) {
    const entry = launchEntry({
      owner: ownerAgentId,
      kind,
      label: title || kind,
      run: () => ({ done: Promise.resolve().then(run), cancel }),
    });
    return Object.freeze({
      service: 'desktop-jobs',
      id: entry.id,
      ownerAgentId,
      stop: (reason) => stopJobEntry(entry, reason),
      append: (text) => appendRingBuffer(entry, text),
      output: (cursor = 0) => readRingBuffer(entry, cursor),
    });
  }

  return Object.freeze({
    ownerAgentId,
    assertAvailable() {},
    witness: () => ({ pid, host, instance }),
    inspect: (ref, witness) => inspectJobWitness({ ref, witness, host, instance, alive, handles }),
    start,
    asDshJobsService: () => buildDshJobsService(handles, launchEntry),
  });
}
