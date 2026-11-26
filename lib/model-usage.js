import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { atomicJson, serializeJsonFile } from './atomic-json.js';
import { addUsage, emptyUsage, usageFromTokenUsage } from './token-usage.js';
import { withUsageSink } from './usage-scope.js';

/* What the study model used, per day and feature, kept with the library (WP27).

   One small file next to the library: `model-usage.json` holds, for each of
   the last 90 days, the four DSH buckets and the request count of each
   feature. That is at most 90 x 8 short rows, whatever the library does, and
   nothing in it is a prompt, an answer or a price. Writes are queued per
   library (every runtime of a library shares one ledger), applied to the
   latest file and replaced atomically; a damaged file starts afresh; a failed
   write is the caller's to ignore: usage is never allowed to break a job. */

export const USAGE_FEATURES = Object.freeze(['generate', 'repair', 'book', 'coach', 'flow', 'case', 'audio', 'other']);
export const RETAIN_DAYS = 90;
const FILE = 'model-usage.json';

const BY_CONTEXT = { generation: 'generate', recording: 'generate', bank: 'generate', authoring: 'repair', book: 'book', outline: 'book', courseBook: 'book', courseOutline: 'book', coach: 'coach', study: 'coach',
  materials: 'coach', workflows: 'flow', skeleton: 'flow', audio: 'audio' };
const BY_ACTION = { 'draft.repair': 'repair', 'case.drills': 'case', 'card.grade': 'case', 'answerCard.build': 'case', 'courseOutline.build': 'book', 'courseBook.build': 'book', 'courseBook.explain': 'book', 'generation.courseOutline.build': 'book', 'generation.courseBook.build': 'book', 'generation.courseBook.explain': 'book', 'book.retell': 'book', 'companion.ask': 'coach', 'companion.build': 'generate', 'generation.companion.build': 'generate', 'course.organize.start': 'other', 'generation.courseOrganize.start': 'other', 'outline.suggest': 'other', 'translation.translate': 'other', 'translation.start': 'other', 'source.folder.suggest': 'other', 'source.folder.classify': 'other', 'source.organize.start': 'other', 'source.organize.suggest': 'other' };
/** The feature a model call belongs to, from the context and action that made it. */
export function featureOf(context, action) {
  return BY_ACTION[action] || BY_CONTEXT[context] || 'other';
}

const localDate = (at) => {
  const date = new Date(at);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
};
const FIELDS = ['uncachedInputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'calls'];
const row = (record) => FIELDS.map((field) => Math.max(0, Math.round(Number(record?.[field]) || 0)));
const unrow = (cells) => Object.fromEntries(FIELDS.map((field, index) => [field, Number(cells?.[index]) || 0]));
const clean = (value) => {
  const days = {};
  for (const [date, features] of Object.entries(value?.days && typeof value.days === 'object' ? value.days : {})) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !features || typeof features !== 'object') continue;
    days[date] = Object.fromEntries(Object.entries(features).filter(([id, cells]) => USAGE_FEATURES.includes(id) && Array.isArray(cells)));
  }
  return { version: 1, days, ...(value?.callIds && typeof value.callIds === 'object' ? { callIds: { ...value.callIds } } : {}) };
};

function validateLedger(value) {
  const object = item => item && typeof item === 'object' && !Array.isArray(item);
  const date = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
  if (!object(value) || value.version !== 1 || !object(value.days) ||
      Object.entries(value.days).some(([day, features]) => !date(day) || !object(features) || Object.entries(features).some(([id, cells]) => !USAGE_FEATURES.includes(id) || !Array.isArray(cells) || cells.length !== 5 || cells.some(n => !Number.isSafeInteger(n) || n < 0))) ||
      (Object.hasOwn(value, 'callIds') && (!object(value.callIds) || Object.entries(value.callIds).some(([id, day]) => !/^[\w:.-]{1,128}$/.test(id) || ['__proto__', 'constructor', 'prototype'].includes(id) || !date(day) || !Object.hasOwn(value.days, day)))))
    throw Object.assign(new Error('Invalid ledger version or stable-call metadata'), { code: 'ledger-invalid' });
  return value;
}

/** The ledger of one library root. Prefer {@link usageLedger}, which shares one instance per root. */
export function createUsageLedger(root, { now = Date.now, retainDays = RETAIN_DAYS } = {}) {
  const path = join(root, FILE);
  let queue = Promise.resolve(), busy = 0;
  let pendingBatch = null;
  const load = async (strict = false) => {
    try { const value = JSON.parse(await readFile(path, 'utf8')); return clean(strict ? validateLedger(value) : value); } catch (error) { if (strict && error.code !== 'ENOENT') throw error; return clean(null); }
  };
  const turn = (work) => {
    busy++;
    const run = queue.then(work).finally(() => { busy--; });
    queue = run.catch(() => {});
    return run;
  };
  const flushEntries = (entries) => serializeJsonFile(path, async () => {
    const strict = entries.some(item => item.callId !== undefined);
    const state = await load(strict);
    const cutoff = localDate(now() - retainDays * 86400000);
    for (const old of Object.keys(state.days)) if (old < cutoff) delete state.days[old];
    if (state.callIds) for (const [key, day] of Object.entries(state.callIds)) if (day < cutoff) delete state.callIds[key];
    let dirty = false;
    for (const item of entries) {
      const date = localDate(item.at);
      if (date < cutoff) continue;
      if (item.callId) {
        state.callIds ||= {};
        if (Object.hasOwn(state.callIds, item.callId)) continue;
        state.callIds[item.callId] = date;
      }
      const day = state.days[date] ||= {};
      day[item.id] = row(addUsage(unrow(day[item.id]), { ...item.buckets, calls: item.count }));
      dirty = true;
    }
    if (!dirty) return;
    // Replace the file atomically: a reader sees the old tally or the new one, never half of it.
    await atomicJson(path, state, { sync: true, ensureDir: true });
  });
  return {
    root,
    isBusy: () => busy > 0,
    validate: () => turn(() => load(true)),
    /** Add what one call (or one job step) used to its day and feature. Ignores unusable usage. */
    record({ feature, usage, at = now(), calls, callId } = {}) {
      if (callId !== undefined && !Number.isFinite(new Date(at).getTime())) return Promise.reject(Object.assign(new Error('Invalid ledger Call timestamp'), { code: 'ledger-invalid' }));
      if (callId !== undefined && (typeof callId !== 'string' || !/^[\w:.-]{1,128}$/.test(callId) || ['__proto__', 'constructor', 'prototype'].includes(callId))) return Promise.reject(new Error('Invalid stable Call identity'));
      const buckets = usageFromTokenUsage({ inputTokens: usage?.uncachedInputTokens, outputTokens: usage?.outputTokens,
        cacheReadTokens: usage?.cacheReadTokens ?? 0, cacheWriteTokens: usage?.cacheWriteTokens ?? 0 });
      if (!buckets) return Promise.resolve();
      const id = USAGE_FEATURES.includes(feature) ? feature : 'other';
      const entry = { id, buckets, at, count: calls ?? usage?.calls ?? 1, callId };
      if (busy === 0) return turn(() => flushEntries([entry]));
      if (!pendingBatch) {
        const items = [];
        let resolveBatch, rejectBatch;
        const promise = new Promise((resolve, reject) => { resolveBatch = resolve; rejectBatch = reject; });
        pendingBatch = { items, promise };
        void turn(async () => {
          pendingBatch = null;
          await flushEntries(items);
        }).then(resolveBatch, rejectBatch);
      }
      pendingBatch.items.push(entry);
      return pendingBatch.promise;
    },
    /** The last `days` days (today included): totals per feature and overall, plus one row per day. */
    async summary({ days = 30, at = now() } = {}) {
      await queue.catch(() => {});
      const state = await load();
      const first = localDate(at - (Math.max(1, days) - 1) * 86400000), last = localDate(at);
      const byFeature = {}, daily = [];
      let total = { ...emptyUsage(), calls: 0 };
      for (const date of Object.keys(state.days).sort()) {
        if (date < first || date > last) continue;
        let day = { ...emptyUsage(), calls: 0 };
        for (const [id, cells] of Object.entries(state.days[date])) {
          const record = unrow(cells);
          byFeature[id] = addUsage(byFeature[id], record);
          day = addUsage(day, record);
        }
        total = addUsage(total, day);
        daily.push({ date, ...day });
      }
      return { days, from: first, to: last, byFeature, total, daily };
    },
  };
}

const MAX_CACHED_LEDGERS = 16;
const ledgers = new Map();
/** One ledger per library root, so every runtime of a library queues behind the same writer. */
export function usageLedger(root) {
  let ledger = ledgers.get(root);
  if (ledger) {
    ledgers.delete(root);
    ledgers.set(root, ledger);
    return ledger;
  }
  ledger = createUsageLedger(root);
  ledgers.set(root, ledger);
  if (ledgers.size > MAX_CACHED_LEDGERS) {
    for (const [oldRoot, oldLedger] of ledgers) {
      if (ledgers.size <= MAX_CACHED_LEDGERS) break;
      if (oldRoot !== root && !oldLedger.isBusy?.()) ledgers.delete(oldRoot);
    }
  }
  return ledger;
}

/** A usage sink that adds each report to `ledger` under its feature; the sink never throws into the call. */
export function ledgerSink(ledger) {
  return (usage, meta = {}) => ledger.record({ feature: meta.feature, usage, calls: meta.calls ?? 1 });
}

/**
 * The model services of one request with their calls tallied in `ledger` under `feature`. Wrapping twice is harmless:
 * the sink has one key, so a call is counted once. Everything else on the model (spawnCorrection) is kept.
 */
export function recordedModels(models, ledger, feature) {
  const entry = { key: 'ledger', sink: ledgerSink(ledger) };
  const wrapFn = (fn) => (typeof fn === 'function'
    ? (...args) => withUsageSink(entry, () => fn(...args), { fallback: feature }) : fn);
  const record = (model) => (typeof model === 'function'
    ? Object.assign(wrapFn(model), model, typeof model.spawnCorrection === 'function' ? { spawnCorrection: wrapFn(model.spawnCorrection) } : {})
    : model);
  return {
    ...models,
    complete: record(models.complete),
    light: record(models.light),
    ...(typeof models?.spawnCorrection === 'function' ? { spawnCorrection: wrapFn(models.spawnCorrection) } : {}),
  };
}
