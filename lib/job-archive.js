import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { archivedContract, jobContract } from './job-contract.js';

/* 任务 归档 (2.6.1). A finished job can be put away without being lost: its record leaves the console's default list and is kept, read-only, in ONE small file
   next to the library (`job-archive.json`, written atomically, queued per library, the same way as lib/coach-daily.js). What is kept is the job's CONTRACT as the
   console draws it (title, kind, status, times, result refs, progress, a bounded list of calls and of log lines, the kind's detail), with every action switched off
   ("archived") and nothing that could be large or secret: no output previews, no raw buffers, no settings, no library path. Each record is at most
   ARCHIVE.maxRecordChars characters, the file keeps the newest ARCHIVE.maxRecords records of the last ARCHIVE.maxDays days, and the oldest fall off.

   Archiving never touches a file: an audio batch's folder stays where it is (the record remembers it as `files`), so unarchiving brings the job back exactly as a
   restart would, and only deleting the record (or letting it fall off the end) lets that folder go (the caller does that; this module only hands the record back). */

export const ARCHIVE = Object.freeze({ file: 'job-archive.json', maxRecords: 200, maxDays: 90, maxRecordChars: 12000, maxBatch: 100 });

const DAY = 86400000;
const FOLDER = /^[\w-]{8,64}$/;
const isObject = (value) => !!value && typeof value === 'object' && !Array.isArray(value);
const size = (value) => JSON.stringify(value).length;
const time = (text) => { const value = Date.parse(text); return Number.isFinite(value) ? value : null; };

const cut = (value, length) => (typeof value === 'string' && value.length > length ? value.slice(0, length) : value);
const trimLists = (detail, count) => Object.fromEntries(Object.entries(detail || {}).map(([key, value]) => [key, Array.isArray(value) ? value.slice(0, count) : value]));
// What bounds a record, gentlest first. Each step works on a fresh copy of the contract; the first that fits wins.
const STEPS = [
  (c) => ({ ...c, calls: c.calls.slice(-60), events: c.events.slice(-60) }),
  (c) => ({ ...c, calls: c.calls.slice(-30), events: c.events.slice(-30), detail: trimLists(c.detail, 40) }),
  (c) => ({ ...c, calls: c.calls.slice(-12), events: c.events.slice(-12), detail: trimLists(c.detail, 20) }),
  (c) => ({ ...c, calls: [], events: c.events.slice(-6), detail: trimLists(c.detail, 8) }),
  (c) => ({ ...c, calls: [], events: [], detail: trimLists(c.detail, 3) }),
  (c) => ({ ...c, calls: [], events: [], detail: {} }),
];

function bounded(record) {
  const { contract } = record.job;
  const clean = { ...contract, calls: contract.calls.map(({ outputPreview: _preview, ...call }) => call),
    ...(contract.error ? { error: { ...contract.error, message: cut(contract.error.message, 400) } } : {}),
    stage: contract.stage?.text ? { ...contract.stage, text: cut(contract.stage.text, 400) } : contract.stage };
  for (const step of STEPS) {
    const next = { ...record, job: { ...record.job, contract: step(clean) } };
    if (size(next) <= ARCHIVE.maxRecordChars) return next;
  }
  return { ...record, job: { ...record.job, contract: STEPS.at(-1)(clean) } };
}

/**
 * The record of one finished job (the job as it is in memory, not a snapshot): { id, ids, archivedAt, files?, legacy?, auto?, job: { id, archived, contract } }.
 * `id` is what survives a retry (the contract's jobId); `ids` are all the names the job answers to; `files` is the folder of an audio batch or single import.
 * A day of 为你定制 is not archived (null): its file already keeps only the last fourteen days.
 */
export function archiveRecordOf(job, { at = new Date().toISOString(), auto = false } = {}) {
  const contract = jobContract(job);
  if (contract.kind === 'coach-daily') return null;
  const files = [job.batchId, job.singleId, job.restoredArchive?.files].find((value) => typeof value === 'string' && FOLDER.test(value));
  const ids = [...new Set([contract.jobId, job.id, job.batchId, job.singleId, ...(job.restoredArchive?.ids || [])].filter((value) => typeof value === 'string' && value))];
  const mark = { at, ...(auto ? { auto: true } : {}) };
  return bounded({ id: contract.jobId, ids, archivedAt: at, ...(auto ? { auto: true } : {}), ...(files ? { files } : {}), ...(job.legacy === true ? { legacy: true } : {}),
    job: { id: job.id, ...(job.type ? { type: job.type } : {}), status: contract.status, startedAt: contract.startedAt, ...(contract.finishedAt ? { finishedAt: contract.finishedAt } : {}), archived: mark, contract: archivedContract(contract, at) } });
}

/** A record read from the file, or null when it is not one (a damaged record never takes the others with it). */
function cleanRecord(raw) {
  if (!isObject(raw) || typeof raw.id !== 'string' || !raw.id || time(raw.archivedAt) === null) return null;
  const job = raw.job;
  if (!isObject(job) || typeof job.id !== 'string' || !isObject(job.contract) || !isObject(job.contract.actions)) return null;
  const ids = [...new Set([raw.id, job.id, ...(Array.isArray(raw.ids) ? raw.ids : [])].filter((value) => typeof value === 'string' && value))];
  const at = new Date(raw.archivedAt).toISOString();
  return { id: raw.id, ids, archivedAt: at, ...(raw.auto === true ? { auto: true } : {}), ...(typeof raw.files === 'string' && FOLDER.test(raw.files) ? { files: raw.files } : {}),
    ...(raw.legacy === true ? { legacy: true } : {}), job: { ...job, archived: { at, ...(raw.auto === true ? { auto: true } : {}) } } };
}
const clean = (value) => (Array.isArray(value?.records) ? value.records.map(cleanRecord).filter(Boolean) : []);

/** The archive of one library root. Prefer {@link jobArchive}, which shares one instance per root. */
export function createJobArchive(root, { now = Date.now, maxRecords = ARCHIVE.maxRecords, maxDays = ARCHIVE.maxDays } = {}) {
  const path = join(root, ARCHIVE.file);
  let queue = Promise.resolve(), cache = null, revision = 0;
  const load = async () => {
    if (cache) return cache;
    try { cache = clean(JSON.parse(await readFile(path, 'utf8'))); } catch { cache = []; }
    return cache;
  };
  const turn = (work) => { const run = queue.then(work); queue = run.catch(() => {}); return run; };
  const save = async (records) => {
    await mkdir(root, { recursive: true });
    const temporary = join(root, `.${ARCHIVE.file}.${randomUUID()}.tmp`);
    await writeFile(temporary, JSON.stringify({ version: 1, records }), 'utf8');
    try { await rename(temporary, path); } catch (error) { await rm(temporary, { force: true }); throw error; }
    revision += 1;
  };
  const alive = (record) => time(record.archivedAt) >= now() - maxDays * DAY;
  /** Newest archived first. The records that are too old are not part of it even before they are handed back by trim(). */
  const ordered = (records) => records.filter(alive).map((record, index) => ({ record, index })).sort((a, b) => time(b.record.archivedAt) - time(a.record.archivedAt) || b.index - a.index).map(({ record }) => record);
  /** Apply both limits to `records`: { kept, evicted }. */
  const fit = (records) => {
    const kept = ordered(records).slice(0, maxRecords), keptSet = new Set(kept);
    return { kept, evicted: records.filter((record) => !keptSet.has(record)).sort((a, b) => time(a.archivedAt) - time(b.archivedAt)) };
  };
  const change = (edit) => turn(async () => {
    const records = await load(), result = edit(records);
    // Nothing to change (an id the archive does not hold): nothing is written.
    if (result.records === records) return { ...result.reply, evicted: [] };
    const { kept, evicted } = fit(result.records);
    // Kept oldest first: a later record is the newer one when two were archived in the same millisecond.
    const stored = [...kept].reverse();
    await save(stored);
    cache = stored;
    return { ...result.reply, evicted };
  });
  const matches = (record, id) => record.id === id || record.ids.includes(id);
  return {
    root,
    /** Changes whenever the archive changed (the snapshot's fingerprint reads it). */
    revision: () => revision,
    /** Read the file again (it was changed from outside). */
    reload() { cache = null; revision += 1; },
    /** The records, newest archived first (copies). */
    async list() { return structuredClone(ordered(await load())); },
    /** The archived jobs as the snapshot carries them, newest archived first: the lean job with its contract. */
    async jobs() { return (await this.list()).map((record) => record.job); },
    async has(id) { return ordered(await load()).some((record) => matches(record, id)); },
    async find(id) { const found = ordered(await load()).find((record) => matches(record, id)); return found ? structuredClone(found) : null; },
    /** Put records away. A record for a job that is already archived replaces the earlier one. `evicted` are the records that fell off the end because of it. */
    add: (records) => change((all) => {
      const incoming = records.filter(Boolean), names = new Set(incoming.flatMap((record) => record.ids));
      return { records: [...all.filter((record) => !record.ids.some((id) => names.has(id))), ...incoming.map((record) => structuredClone(record))], reply: { added: incoming.map((record) => record.id) } };
    }),
    /** Take records out by any of their ids. */
    remove: (ids) => change((all) => {
      const wanted = new Set(ids), removed = all.filter((record) => record.ids.some((id) => wanted.has(id)));
      return { records: removed.length ? all.filter((record) => !removed.includes(record)) : all, reply: { removed: structuredClone(removed) } };
    }),
    /** Let the oldest fall off now (both limits): the records handed back are the ones that did. Writes only when something did. */
    trim: () => turn(async () => {
      const records = await load(), { kept, evicted } = fit(records);
      if (evicted.length) { const stored = [...kept].reverse(); await save(stored); cache = stored; }
      return { evicted };
    }),
  };
}

const archives = new Map();
/** One archive per library root, so every runtime of a library queues behind the same writer. */
export function jobArchive(root) {
  let archive = archives.get(root);
  if (!archive) archives.set(root, archive = createJobArchive(root));
  return archive;
}
