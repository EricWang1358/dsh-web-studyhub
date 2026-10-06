import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

/* 为你定制, by the day (#234). Preparing variants for the learner's mistakes happens in small batches all day; the 任务 console shows the DAY as one row, not
   one row per batch. This module keeps what that row is drawn from:

   - the batches of each day (when, how many cards, what was written, what passed, what was skipped and why, the tokens in, out and from cache),
   - the three live settings of the day (pause today, limits, reasoning) which the batch about to start reads,
   - and the rows themselves (`coachDailyJobs`): job-shaped records that go through the same contract (lib/job-contract.js) as every other job.

   One small file next to the library (`coach-daily.json`, written atomically, queued per library): the last 14 days, at most 60 batches a day, and nothing in it
   is a prompt, an answer or a card. A batch in flight lives in memory only (a restart does not leave a batch "running" forever). The practice figures (how many
   were practised, how well) are read from the attempts when the row is built, never copied here. */

export const DAILY = Object.freeze({
  file: 'coach-daily.json', retainDays: 14, shownDays: 7, maxBatches: 60, maxMessage: 160,
  defaults: Object.freeze({ maxBatchesPerDay: 24, maxReady: 12, reasoning: 'lowest' }),
  limits: Object.freeze({
    maxBatchesPerDay: Object.freeze({ type: 'int', min: 1, max: 48 }),
    maxReady: Object.freeze({ type: 'int', min: 1, max: 12 }),
    reasoning: Object.freeze({ type: 'enum', values: Object.freeze(['lowest', 'low', 'medium', 'high', 'highest']) }),
  }),
});

const pad = (value) => String(value).padStart(2, '0');
/** The local calendar day of a time, as YYYY-MM-DD. */
export const dayOf = (at) => { const date = new Date(at); return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`; };
const isDay = (value) => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value);
const whole = (value) => (Number.isSafeInteger(value) && value >= 0 ? value : 0);
const tokensOf = (value) => ({ input: whole(value?.input), output: whole(value?.output), cache: whole(value?.cache) });
const STATUSES = new Set(['ok', 'failed', 'skipped']);
/** Why a batch did not write anything, as a code the console puts into words (so the words are translated there, not stored here). */
export const REASONS = Object.freeze(['paused', 'limit', 'full', 'none', 'invalid', 'changed', 'cancelled', 'error']);

function cleanBatch(raw) {
  if (!raw || typeof raw !== 'object' || typeof raw.id !== 'string' || !Number.isFinite(Date.parse(raw.startedAt))) return null;
  return { id: raw.id.slice(0, 64), startedAt: new Date(raw.startedAt).toISOString(), endedAt: Number.isFinite(Date.parse(raw.endedAt)) ? new Date(raw.endedAt).toISOString() : new Date(raw.startedAt).toISOString(),
    status: STATUSES.has(raw.status) ? raw.status : 'failed', targets: whole(raw.targets), generated: whole(raw.generated), passed: whole(raw.passed), skipped: whole(raw.skipped),
    tokens: tokensOf(raw.tokens), message: typeof raw.message === 'string' ? raw.message.slice(0, DAILY.maxMessage) : '', ...(REASONS.includes(raw.reason) ? { reason: raw.reason } : {}), ...(typeof raw.reasoning === 'string' ? { reasoning: raw.reasoning.slice(0, 20) } : {}) };
}

const clean = (value) => {
  const days = {};
  for (const [date, day] of Object.entries(value?.days && typeof value.days === 'object' ? value.days : {})) {
    if (!isDay(date) || !day || typeof day !== 'object') continue;
    days[date] = { batches: (Array.isArray(day.batches) ? day.batches : []).map(cleanBatch).filter(Boolean).slice(-DAILY.maxBatches) };
  }
  const settings = value?.settings && typeof value.settings === 'object' ? value.settings : {};
  const kept = { ...(isDay(settings.pausedDay) ? { pausedDay: settings.pausedDay } : {}) };
  for (const [key, rule] of Object.entries(DAILY.limits)) {
    const given = settings[key];
    if (rule.type === 'int' && Number.isInteger(given) && given >= rule.min && given <= rule.max) kept[key] = given;
    if (rule.type === 'enum' && rule.values.includes(given)) kept[key] = given;
  }
  return { version: 1, settings: kept, days };
};

/** The ledger of one library root. Prefer {@link coachDailyLedger}, which shares one instance per root. */
export function createCoachDaily(root, { now = Date.now } = {}) {
  const path = join(root, DAILY.file);
  let queue = Promise.resolve(), cache = null, revision = 0;
  const inflight = new Map();
  const load = async () => {
    if (cache) return cache;
    try { cache = clean(JSON.parse(await readFile(path, 'utf8'))); } catch { cache = clean(null); }
    return cache;
  };
  const turn = (work) => { const run = queue.then(work); queue = run.catch(() => {}); return run; };
  const save = async (state) => {
    const cutoff = dayOf(now() - DAILY.retainDays * 86400000);
    for (const date of Object.keys(state.days)) if (date < cutoff) delete state.days[date];
    await mkdir(root, { recursive: true });
    const temporary = join(root, `.${DAILY.file}.${randomUUID()}.tmp`);
    await writeFile(temporary, JSON.stringify(state), 'utf8');
    try { await rename(temporary, path); } catch (error) { await rm(temporary, { force: true }); throw error; }
    revision += 1;
  };
  const change = (edit) => turn(async () => { const state = await load(); const result = edit(state); await save(state); return result; });
  const settingsOf = (state) => ({ ...DAILY.defaults, ...Object.fromEntries(Object.entries(state.settings).filter(([key]) => key !== 'pausedDay')) });
  return {
    root,
    /** Changes whenever something the rows are drawn from changed (the snapshot's fingerprint reads it). */
    revision: () => revision,
    /** Read the file again (it was changed from outside). */
    reload() { cache = null; revision += 1; },
    /** What the batch about to start must obey: { ok: false, message } to not start, else the settings in force. */
    async gate() {
      const state = await load(), settings = settingsOf(state), date = dayOf(now());
      if (state.settings.pausedDay === date) return { ok: false, reason: 'paused', message: '今天已暂停备题；继续后才会开始新的一批。', settings };
      const ran = (state.days[date]?.batches || []).filter((batch) => batch.status !== 'skipped').length + inflight.size;
      if (ran >= settings.maxBatchesPerDay) return { ok: false, reason: 'limit', message: '今天的备题次数已用完；明天会继续，也可以在任务里调高。', settings };
      return { ok: true, settings };
    },
    /** A batch begins: kept in memory until it ends. `id` is the batch's own name when something else already names it (a runtime Job). */
    begin({ id, targets = 0, reasoning } = {}) {
      const entry = { id: id || randomUUID(), startedAt: new Date(now()).toISOString(), targets: whole(targets), ...(reasoning ? { reasoning } : {}) };
      inflight.set(entry.id, entry);
      revision += 1;
      return entry;
    },
    /** A batch that turned out to be nothing (the learner never agreed to preparation): it leaves no trace. */
    discard(entry) { if (inflight.delete(entry.id)) revision += 1; },
    /** A batch ends: it joins its day. */
    finish(entry, result = {}) {
      inflight.delete(entry.id);
      revision += 1;
      const batch = cleanBatch({ ...entry, endedAt: new Date(now()).toISOString(), ...result });
      if (!batch) return Promise.resolve();
      const date = dayOf(batch.startedAt);
      return change((state) => { const day = state.days[date] ||= { batches: [] }; day.batches.push(batch); day.batches = day.batches.slice(-DAILY.maxBatches); });
    },
    /** Pause or resume today's preparation. */
    setPaused: (paused) => change((state) => { if (paused) state.settings.pausedDay = dayOf(now()); else delete state.settings.pausedDay; return paused; }),
    /** Apply a patch of settings, whole or not at all. The error names the setting. */
    async patch(patch) {
      if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new Error('job.control set needs a patch object, for example {maxReady: 6}');
      const applied = {};
      for (const [key, value] of Object.entries(patch)) {
        const rule = DAILY.limits[key];
        if (!rule) throw Object.assign(new Error(`${key}：这个任务没有这个设置（可调：${Object.keys(DAILY.limits).join('、')}）`), { code: 'unknown-setting' });
        if (rule.type === 'int' && !(Number.isInteger(value) && value >= rule.min && value <= rule.max)) throw Object.assign(new Error(`${key} 要是 ${rule.min} 到 ${rule.max} 的整数`), { code: 'setting-out-of-range' });
        if (rule.type === 'enum' && !rule.values.includes(value)) throw Object.assign(new Error(`${key} 只能是 ${rule.values.join('、')} 之一`), { code: 'setting-out-of-range' });
        applied[key] = value;
      }
      await change((state) => { Object.assign(state.settings, applied); });
      return applied;
    },
    /** Remove a day's record. */
    dismiss: (date) => change((state) => { delete state.days[date]; }),
    /** A copy of everything the rows need. */
    async read() {
      const state = await load();
      return { settings: settingsOf(state), pausedDay: state.settings.pausedDay || null, days: structuredClone(state.days), inflight: [...inflight.values()].map((entry) => ({ ...entry })) };
    },
  };
}

const ledgers = new Map();
/** One ledger per library root, so every runtime of a library queues behind the same writer. */
export function coachDailyLedger(root) {
  let ledger = ledgers.get(root);
  if (!ledger) ledgers.set(root, ledger = createCoachDaily(root));
  return ledger;
}

/**
 * How many questions of the 为你定制 deck were answered on each of the days, and how many were right (grade 3 or better), from the attempts. The newest are
 * read first and the walk stops at the first day before `from`, so a long history costs nothing.
 */
export function practiceByDay(state, from) {
  const deck = (state?.decks || []).find((item) => item.systemKind === 'coach'), days = new Map(), attempts = state?.attempts || [];
  if (!deck) return days;
  for (let index = attempts.length - 1; index >= 0; index--) {
    const attempt = attempts[index], time = Date.parse(attempt?.timestamp);
    if (!Number.isFinite(time)) continue;
    const date = dayOf(time);
    if (date < from) break;
    if (attempt.deckId !== deck.id || attempt.retry || (attempt.assessment && attempt.assessment !== 'graded') || !Number.isFinite(attempt.grade)) continue;
    const row = days.get(date) || { practised: 0, correct: 0 };
    row.practised += 1;
    if (attempt.grade >= 3) row.correct += 1;
    days.set(date, row);
  }
  return days;
}

const sum = (list, pick) => list.reduce((total, item) => total + pick(item), 0);
const tokenUsageOf = (tokens) => ({ uncachedInputTokens: tokens.input, outputTokens: tokens.output, cacheReadTokens: tokens.cache, cacheWriteTokens: 0 });

/** One day as a job-shaped record for the console (it goes through lib/job-contract.js like every other job). */
function dayJob(date, { today, batches, running, paused, settings, practice }) {
  const tokens = { input: sum(batches, (batch) => batch.tokens.input), output: sum(batches, (batch) => batch.tokens.output), cache: sum(batches, (batch) => batch.tokens.cache) };
  const ran = batches.filter((batch) => batch.status !== 'skipped'), generated = sum(batches, (batch) => batch.generated), passed = sum(batches, (batch) => batch.passed);
  const practised = practice?.practised || 0, correct = practice?.correct || 0;
  const metrics = { generated, passed, practised, correct, accuracy: practised > 0 ? Math.round((correct / practised) * 100) : null, skippedExpired: sum(batches, (batch) => batch.skipped) + batches.filter((batch) => batch.status === 'skipped').length };
  const first = batches[0]?.startedAt, last = batches.at(-1)?.endedAt;
  return {
    id: `coach:${date}`, type: 'coach-daily', date, today, status: running ? 'running' : 'complete', paused,
    startedAt: first || `${date}T00:00:00.000Z`, ...(!running && last ? { finishedAt: last } : {}),
    tasks: batches.map((batch, index) => ({ id: batch.id, kind: 'prep', stage: '备题', part: index + 1, parts: batches.length, runtime: 'direct', reasoning: batch.reasoning,
      status: batch.status === 'ok' ? 'complete' : batch.status === 'failed' ? 'failed' : batch.status === 'running' ? 'running' : 'skipped',
      startedAt: batch.startedAt, ...(batch.status === 'running' ? {} : { finishedAt: batch.endedAt }),
      ...(batch.tokens.input + batch.tokens.output + batch.tokens.cache > 0 ? { tokenUsage: { ...tokenUsageOf(batch.tokens), calls: 1 } } : {}) })),
    tokenUsage: tokens.input + tokens.output + tokens.cache > 0 ? { ...tokenUsageOf(tokens), calls: ran.length } : undefined,
    events: batches.filter((batch) => batch.status !== 'running').map((batch) => ({ id: `batch:${batch.id}`, at: batch.endedAt || batch.startedAt, level: batch.status === 'ok' ? 'done' : batch.status === 'failed' ? 'warn' : 'info', tag: null, code: 'batch',
      args: { status: batch.status, passed: batch.passed, targets: batch.targets, ...(batch.reason ? { reason: batch.reason } : {}) }, text: batch.reason === 'error' ? batch.message : '' })),
    ...(today ? { control: { limits: DAILY.limits, values: { maxBatchesPerDay: settings.maxBatchesPerDay, maxReady: settings.maxReady, reasoning: settings.reasoning } } } : {}),
    coachDaily: { date, batches, metrics, tokens, paused, ...(today ? { limits: { maxBatchesPerDay: settings.maxBatchesPerDay, maxReady: settings.maxReady, reasoning: settings.reasoning } } : {}) },
  };
}

/**
 * The rows of the last seven days, newest first: a day that had batches (or has one in flight, or is paused), today included. `preparing` is the coach's own
 * "a batch is queued or running" flag; `state` supplies the practice figures.
 */
export function coachDailyJobs({ data, preparing = false, state, now = Date.now() }) {
  const todayDate = dayOf(now), from = dayOf(now - (DAILY.shownDays - 1) * 86400000), practice = practiceByDay(state, from);
  const dates = new Set(Object.keys(data.days).filter((date) => date >= from && date <= todayDate && data.days[date].batches.length));
  if (preparing || data.pausedDay === todayDate || data.inflight.length) dates.add(todayDate);
  return [...dates].sort().reverse().map((date) => {
    const today = date === todayDate, own = data.days[date]?.batches || [];
    const live = today ? data.inflight.map((entry) => ({ id: entry.id, startedAt: entry.startedAt, endedAt: null, status: 'running', targets: entry.targets, generated: 0, passed: 0, skipped: 0, tokens: tokensOf(null), message: '', ...(entry.reasoning ? { reasoning: entry.reasoning } : {}) })) : [];
    return dayJob(date, { today, batches: [...own, ...live], running: today && (preparing || live.length > 0), paused: today && data.pausedDay === date, settings: data.settings, practice: practice.get(date) });
  });
}

/** One day's row on its own (what `job.control` judges an action against). Null when the id is not a day of the coach. */
export function coachDayId(jobId) {
  const match = /^coach:(\d{4}-\d{2}-\d{2})$/.exec(String(jobId ?? ''));
  return match ? match[1] : null;
}
