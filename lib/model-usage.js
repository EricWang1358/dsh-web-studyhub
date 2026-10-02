import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { addUsage, emptyUsage, usageFromTokenUsage } from './token-usage.js';
import { withUsageSink } from './usage-scope.js';

/* What the study model used, per day and feature, kept with the library (WP27).

   One small file next to the library: `model-usage.json` holds, for each of
   the last 90 days, the four DSH buckets and the request count of each
   feature. That is at most 90 x 7 short rows, whatever the library does, and
   nothing in it is a prompt, an answer or a price. Writes are queued per
   library (every runtime of a library shares one ledger), applied to the
   latest file and replaced atomically; a damaged file starts afresh; a failed
   write is the caller's to ignore: usage is never allowed to break a job. */

export const USAGE_FEATURES = Object.freeze(['generate', 'repair', 'coach', 'flow', 'case', 'audio', 'other']);
export const RETAIN_DAYS = 90;
const FILE = 'model-usage.json';

const BY_CONTEXT = { generation: 'generate', recording: 'generate', bank: 'generate', authoring: 'repair', coach: 'coach', study: 'coach',
  materials: 'coach', workflows: 'flow', skeleton: 'flow', audio: 'audio' };
const BY_ACTION = { 'draft.repair': 'repair', 'case.drills': 'case', 'card.grade': 'case', 'outline.suggest': 'other', 'translation.translate': 'other', 'translation.start': 'other' };
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
  return { version: 1, days };
};

/** The ledger of one library root. Prefer {@link usageLedger}, which shares one instance per root. */
export function createUsageLedger(root, { now = Date.now, retainDays = RETAIN_DAYS } = {}) {
  const path = join(root, FILE);
  let queue = Promise.resolve();
  const load = async () => {
    try { return clean(JSON.parse(await readFile(path, 'utf8'))); } catch { return clean(null); }
  };
  const turn = (work) => {
    const run = queue.then(work);
    queue = run.catch(() => {});
    return run;
  };
  return {
    root,
    /** Add what one call (or one job step) used to its day and feature. Ignores unusable usage. */
    record({ feature, usage, at = now(), calls } = {}) {
      const buckets = usageFromTokenUsage({ inputTokens: usage?.uncachedInputTokens, outputTokens: usage?.outputTokens,
        cacheReadTokens: usage?.cacheReadTokens ?? 0, cacheWriteTokens: usage?.cacheWriteTokens ?? 0 });
      if (!buckets) return Promise.resolve();
      const id = USAGE_FEATURES.includes(feature) ? feature : 'other';
      return turn(async () => {
        const state = await load();
        const date = localDate(at), cutoff = localDate(now() - retainDays * 86400000);
        for (const old of Object.keys(state.days)) if (old < cutoff) delete state.days[old];
        if (date < cutoff) return;
        const day = state.days[date] ||= {};
        day[id] = row(addUsage(unrow(day[id]), { ...buckets, calls: calls ?? usage?.calls ?? 1 }));
        await mkdir(root, { recursive: true });
        // Replace the file atomically: a reader sees the old tally or the new one, never half of it.
        const temporary = join(root, `.${FILE}.${randomUUID()}.tmp`);
        await writeFile(temporary, JSON.stringify(state), 'utf8');
        try { await rename(temporary, path); } catch (error) { await rm(temporary, { force: true }); throw error; }
      });
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

const ledgers = new Map();
/** One ledger per library root, so every runtime of a library queues behind the same writer. */
export function usageLedger(root) {
  let ledger = ledgers.get(root);
  if (!ledger) ledgers.set(root, ledger = createUsageLedger(root));
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
  const record = (model) => typeof model === 'function'
    ? Object.assign((...args) => withUsageSink(entry, () => model(...args), { fallback: feature }), model) : model;
  return { ...models, complete: record(models.complete), light: record(models.light) };
}
