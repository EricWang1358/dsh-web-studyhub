import { mkdir, readFile, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { atomicWrite } from './mineru-job.js';

/* The conversion history: one small durable record per MinerU conversion (cloud or local), written when the conversion starts and
   updated as it progresses, so "what was converted, when, how, how long it took and where the result went" survives the job card
   being dismissed and the app being restarted.

   It is a job-like record, so it lives where the library keeps its other job records (<library>/conversion-history/<job id>.json,
   like <library>/audio-batches/), never in the DSH home's study/tmp (which is cleaned) and never in the library's exported state.
   A record names the file, the counts, the route, the times, the status and the reason; it never holds document text, the token,
   a temporary path or a folder. Deleting a record never deletes the imported document.

   Retention: the latest 50 records and everything younger than 90 days, whichever is more, pruned whenever one is written. */

export const HISTORY = Object.freeze({ keepLatest: 50, keepMs: 90 * 24 * 60 * 60_000, maxReason: 240, folder: 'conversion-history' });
export const STATUSES = Object.freeze(['running', 'complete', 'failed', 'cancelled', 'interrupted']);
const FINISHED = ['complete', 'failed', 'cancelled'];
const ID = /^[\w-]{8,64}$/;

export const historyDir = root => join(root, HISTORY.folder);
const fileOf = (root, id) => join(historyDir(root), `${checkId(id)}.json`);
function checkId(id) {
  if (!ID.test(String(id))) throw new Error('无效的转换任务');
  return String(id);
}

/* ---------- plain text only ---------- */

const WINDOWS_PATH = /[A-Za-z]:[\\/](?:[^\\/:*?"<>|\r\n]+[\\/])*[^\s\\/:*?"<>|;,]*/g;
const POSIX_PATH = /(?<![\w:./~-])~?\/(?:[^\s/"'<>|;,]+\/)+[^\s/"'<>|;,]*/g;
const URL_QUERY = /(https?:\/\/[^\s?#"']+)[?#][^\s"']*/g;
const JWT = /eyJ[\w-]{5,}(?:\.[\w-]+){1,2}/g;
const BEARER = /Bearer\s+\S+/gi;

/**
 * A sentence a learner can read, with nothing that identifies the machine or the account: no file paths, no token (the learner's own,
 * or anything shaped like one), no signed-URL query. `secrets` are exact strings to remove (the saved token).
 */
export function plainReason(value, { secrets = [], limit = HISTORY.maxReason } = {}) {
  if (typeof value !== 'string') return '';
  let text = value;
  for (const secret of secrets) if (typeof secret === 'string' && secret.length >= 8) text = text.split(secret).join('');
  text = text.replace(URL_QUERY, '$1').replace(JWT, '').replace(BEARER, '').replace(WINDOWS_PATH, '[path]').replace(POSIX_PATH, '[path]');
  return text.replace(/\s+/g, ' ').trim().slice(0, limit);
}

const whole = value => Number.isSafeInteger(value) && value >= 0 ? value : undefined;
const stamp = value => { const time = typeof value === 'number' ? value : Date.parse(value); return Number.isFinite(time) ? new Date(time).toISOString() : undefined; };
const nameOf = value => String(value ?? '').split(/[\\/]/).pop().slice(0, 240);
const clean = object => Object.fromEntries(Object.entries(object).filter(([, value]) => value !== undefined));

function failureOf(failure) {
  if (!failure || typeof failure !== 'object') return undefined;
  return clean({ stage: /^[a-z-]{1,20}$/.test(failure.stage) ? failure.stage : undefined, piece: whole(failure.piece) || undefined,
    reason: plainReason(failure.reason), code: /^[\w.-]{1,40}$/.test(failure.code) ? failure.code : undefined });
}

/** Only these fields are ever written, whatever a caller passes in. */
function shape(record) {
  return clean({ version: 1, id: record.id, filename: nameOf(record.filename), bytes: whole(record.bytes), pages: whole(record.pages), pieces: whole(record.pieces),
    route: record.route === 'local' ? 'local' : 'cloud', tier: record.route === 'local' && /^[\w-]{1,20}$/.test(record.tier) ? record.tier : undefined,
    status: record.status, phase: /^[a-z-]{1,20}$/.test(record.phase) ? record.phase : undefined, piece: whole(record.piece) || undefined,
    pagesDone: whole(record.pagesDone), attempts: whole(record.attempts), elapsedMs: whole(record.elapsedMs),
    startedAt: stamp(record.startedAt), attemptStartedAt: stamp(record.attemptStartedAt), updatedAt: stamp(record.updatedAt), finishedAt: stamp(record.finishedAt),
    failure: failureOf(record.failure), documentId: typeof record.documentId === 'string' ? record.documentId.slice(0, 200) : undefined,
    title: typeof record.title === 'string' ? record.title.slice(0, 240) : undefined, importedPages: whole(record.importedPages), skippedPages: whole(record.skippedPages) });
}

/* ---------- reading and writing ---------- */

const chains = new Map();
/** Writes to one library's history happen one at a time, so a progress update never undoes the end of a conversion. */
function serial(root, work) {
  const run = (chains.get(root) || Promise.resolve()).catch(() => {}).then(work);
  chains.set(root, run);
  void run.finally(() => { if (chains.get(root) === run) chains.delete(root); }).catch(() => {});
  return run;
}

async function readRecord(root, id) {
  try {
    const record = JSON.parse(await readFile(fileOf(root, id), 'utf8'));
    return record?.id === id && record.version === 1 && STATUSES.includes(record.status) ? record : null;
  } catch { return null; }
}
async function writeRecord(root, record) {
  await mkdir(historyDir(root), { recursive: true });
  await atomicWrite(fileOf(root, record.id), JSON.stringify(shape(record)));
}
const startedOf = record => Date.parse(record.startedAt) || 0;
const newestFirst = (a, b) => startedOf(b) - startedOf(a) || (a.id < b.id ? 1 : -1);

async function readAll(root) {
  const found = [];
  for (const name of await readdir(historyDir(root)).catch(() => [])) {
    const match = /^([\w-]{8,64})\.json$/.exec(name);
    if (!match) continue;
    const record = await readRecord(root, match[1]);
    if (record) found.push(record);
  }
  return found.sort(newestFirst);
}

/** Every record of the library, newest first. Damaged or foreign files are skipped. */
export const listRecords = root => readAll(root);

async function pruneNow(root, { now = Date.now, keep = [] } = {}) {
  const time = now(), protectedIds = new Set(keep);
  let removed = 0;
  for (const [index, record] of (await readAll(root)).entries()) {
    if (index < HISTORY.keepLatest || protectedIds.has(record.id) || time - startedOf(record) < HISTORY.keepMs) continue;
    await rm(fileOf(root, record.id), { force: true }); removed++;
  }
  return { removed };
}
/** Drop what retention no longer keeps (`keep`: ids that must stay, e.g. conversions that are running). Also done on every write. */
export const pruneRecords = (root, options) => serial(root, () => pruneNow(root, options));

/* ---------- the life of a record ---------- */

/**
 * A conversion starts (or, for the same job id, starts another attempt after a failure, a restart or "接着做": the record stays,
 * its start time stays, the working time adds up). `input`: id, filename, bytes, pages, pieces, route, tier, pagesDone, phase, title, and
 * startedAt for a conversion that began before its record was made.
 */
export function openRecord(root, input, { now = Date.now } = {}) {
  return serial(root, async () => {
    const id = checkId(input?.id);
    const at = stamp(now()), previous = await readRecord(root, id);
    const base = previous ? { ...previous, attempts: (previous.attempts || 1) + 1 } : { startedAt: stamp(input.startedAt) ?? at, attempts: 1, elapsedMs: 0, pagesDone: 0 };
    const record = { ...base, id, status: 'running', phase: input.phase || 'split', attemptStartedAt: at, updatedAt: at,
      filename: input.filename ?? base.filename, bytes: input.bytes ?? base.bytes, pages: input.pages ?? base.pages, pieces: input.pieces ?? base.pieces,
      route: input.route ?? base.route, tier: input.tier ?? base.tier, title: input.title ?? base.title, pagesDone: input.pagesDone ?? base.pagesDone,
      finishedAt: undefined, failure: undefined, piece: undefined };
    await writeRecord(root, record);
    await pruneNow(root, { now, keep: [id] });
    return shape(record);
  });
}

/** Progress of a running conversion: the phase, the piece it is on, the pages done. A record that is not there is not invented. */
export function updateRecord(root, id, patch = {}, { now = Date.now } = {}) {
  return serial(root, async () => {
    const record = await readRecord(root, checkId(id));
    if (!record) return null;
    const next = { ...record, ...clean({ phase: patch.phase, piece: patch.piece, pagesDone: patch.pagesDone }), updatedAt: stamp(now()) };
    await writeRecord(root, next);
    return shape(next);
  });
}

/**
 * The end of an attempt: `status` is complete, failed or cancelled. `complete` is only for a document that really was imported (the caller
 * passes documentId, title and the counts); a failure carries { stage, piece, reason }. The time of this attempt is added to the working time.
 * `interrupted` (the app was shut down under it) records no end and adds no time: nobody measured it.
 */
export function closeRecord(root, id, outcome = {}, { now = Date.now } = {}) {
  return serial(root, async () => {
    if (![...FINISHED, 'interrupted'].includes(outcome.status)) throw new Error(`status 只能是 ${FINISHED.join('、')}`);
    const record = await readRecord(root, checkId(id));
    if (!record) return null;
    if (outcome.status === 'interrupted') {
      const next = { ...record, status: 'interrupted', updatedAt: stamp(now()), pagesDone: outcome.pagesDone ?? record.pagesDone, failure: outcome.failure };
      await writeRecord(root, next);
      return shape(next);
    }
    const time = now(), began = Date.parse(record.attemptStartedAt);
    const next = { ...record, status: outcome.status, finishedAt: stamp(time), updatedAt: stamp(time),
      elapsedMs: (record.elapsedMs || 0) + (Number.isFinite(began) ? Math.max(0, time - began) : 0),
      pagesDone: outcome.pagesDone ?? record.pagesDone, failure: outcome.status === 'failed' ? outcome.failure : undefined };
    if (outcome.status === 'complete') Object.assign(next, { documentId: outcome.documentId, title: outcome.title ?? record.title, importedPages: outcome.importedPages, skippedPages: outcome.skippedPages });
    await writeRecord(root, next);
    await pruneNow(root, { now, keep: [id] });
    return shape(next);
  });
}

/**
 * Records still "running" whose conversion is not alive (`activeIds` are the live ones): the app was closed or crashed. They become
 * interrupted, with no end time and no duration, because nobody knows when they stopped. Resolves the records that changed.
 */
export function interruptRecords(root, activeIds = [], { now = Date.now } = {}) {
  return serial(root, async () => {
    const live = new Set(activeIds), changed = [];
    for (const record of await readAll(root)) {
      if (record.status !== 'running' || live.has(record.id)) continue;
      const next = { ...record, status: 'interrupted', updatedAt: stamp(now()) };
      await writeRecord(root, next);
      changed.push(shape(next));
    }
    return changed;
  });
}

/** Delete one record (and nothing else: the imported document stays). Resolves whether there was one. */
export function removeRecord(root, id) {
  return serial(root, async () => {
    const file = fileOf(root, id), existed = !!await readRecord(root, id);
    await rm(file, { force: true });
    return existed;
  });
}

/** Delete every record except those of conversions in `keep` (running ones). Resolves { removed }. */
export function clearRecords(root, { keep = [] } = {}) {
  return serial(root, async () => {
    const staying = new Set(keep);
    let removed = 0;
    for (const record of await readAll(root)) { if (staying.has(record.id)) continue; await rm(fileOf(root, record.id), { force: true }); removed++; }
    return { removed };
  });
}
