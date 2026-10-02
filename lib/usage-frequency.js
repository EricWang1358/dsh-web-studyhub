import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { parseStoredJson } from './util.js';
import { USAGE_AREA_IDS } from './usage-registry.js';

/* The usage frequency record (Settings › Advanced › Usage frequency record; docs/usage-frequency.md): an opt-in, local-only count of how
   often each control is used. Off by default; nothing is created, kept or counted until the learner turns it on.

   What it holds, and nothing else: per control key, the days it was used (local date, YYYY-MM-DD) with a count, the first and last day,
   a total and the count of days older than the window; per page (area) the same by day. No time of day, no text, no identifier of a
   card, source or course, no input value, no URL, no title. The keys come from the page (ui/usage/keys.js: data-usage, a stable hook or
   the app's own copy of a control's name) and are checked again here: short, plain, never a URL, a path or an address.

   One small file in the StudyHub settings folder of the DSH home (<DSH home>/study/usage-frequency.json), not in the library: exports,
   backups and the snapshot never carry it. Writes are queued and replaced atomically (one writer per process); a damaged file reads as
   "off, nothing recorded" and starting again works. Bounded: at most 800 distinct keys (the rest fold into `other`), 180 days of day
   buckets (older days fold into each key's `older` count, so "all time" stays right) and 24,000 day cells (the oldest days fold first). */

export const usageFrequencyPath = () => join(process.env.DSH_HOME?.trim() || join(homedir(), '.dsh'), 'study', 'usage-frequency.json');

export const USAGE_LIMITS = Object.freeze({ keys: 800, days: 180, cells: 24000, recordsPerBatch: 500, countPerRecord: 10000, pastDays: 365, futureDays: 1, keyLength: 96 });
export const OTHER_KEY = 'other';
const DAY_MS = 86400000;

export const localDay = at => {
  const date = new Date(at);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
};
const validDay = value => {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return '';
  const parsed = new Date(`${value}T12:00:00`);
  return !Number.isNaN(parsed.getTime()) && localDay(parsed) === value ? value : '';
};
const natural = value => (Number.isInteger(value) && value >= 0 ? value : null);

/** A key is a short plain control key. It can name a control; it can never carry a URL, a path, an address or markup. */
const FORBIDDEN_KEY = /[@\\?=&#%<>"'`\u0000-\u001f\u007f]|\/\/|\.\./;
export function validKey(key) {
  return typeof key === 'string' && key.length >= 1 && key.length <= USAGE_LIMITS.keyLength && key === key.trim() && /[\p{L}\p{N}]/u.test(key) && !FORBIDDEN_KEY.test(key);
}

const emptyState = () => ({ version: 1, enabled: false, paused: false, since: '', controls: {}, areas: {} });
function cleanCell(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const days = {};
  if (value.days !== undefined && (!value.days || typeof value.days !== 'object' || Array.isArray(value.days))) return null;
  for (const [day, n] of Object.entries(value.days || {})) if (validDay(day) && natural(n) > 0) days[day] = n;
  const older = natural(value.older) ?? 0, total = natural(value.total);
  if (total === null) return null;
  const counted = Object.values(days).reduce((sum, n) => sum + n, 0) + older;
  const sorted = Object.keys(days).sort();
  return { first: validDay(value.first) || sorted[0] || '', last: validDay(value.last) || sorted.at(-1) || '', older, total: Math.max(total, counted), days };
}
/** What was read from disk, made safe: anything unusable is dropped, never trusted, and a file that is not ours reads as off and empty. */
function clean(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || raw.version !== 1) return emptyState();
  const state = { version: 1, enabled: raw.enabled === true, paused: raw.paused === true, since: validDay(raw.since), controls: {}, areas: {} };
  if (raw.controls && typeof raw.controls === 'object' && !Array.isArray(raw.controls))
    for (const [key, value] of Object.entries(raw.controls)) { const cell = validKey(key) && cleanCell(value); if (cell && Object.keys(state.controls).length <= USAGE_LIMITS.keys + 1) state.controls[key] = cell; }
  if (raw.areas && typeof raw.areas === 'object' && !Array.isArray(raw.areas))
    for (const [area, value] of Object.entries(raw.areas)) { const cell = USAGE_AREA_IDS.includes(area) && cleanCell(value); if (cell) state.areas[area] = cell; }
  return state;
}

const cutoffDay = now => localDay(now - (USAGE_LIMITS.days - 1) * DAY_MS);
/** Fold every day bucket older than the window into the key's `older` count; then fold the oldest days until the file is within its cell budget. */
function fold(state, now) {
  const cutoff = cutoffDay(now);
  const pack = cells => { for (const cell of Object.values(cells)) for (const [day, n] of Object.entries(cell.days)) if (day < cutoff) { cell.older += n; delete cell.days[day]; } };
  pack(state.controls); pack(state.areas);
  const count = () => Object.values(state.controls).reduce((sum, cell) => sum + Object.keys(cell.days).length, 0);
  let cells = count();
  if (cells > USAGE_LIMITS.cells) {
    const days = [...new Set(Object.values(state.controls).flatMap(cell => Object.keys(cell.days)))].sort();
    for (const day of days) {
      for (const cell of Object.values(state.controls)) if (day in cell.days) { cell.older += cell.days[day]; delete cell.days[day]; cells -= 1; }
      for (const cell of Object.values(state.areas)) if (day in cell.days) { cell.older += cell.days[day]; delete cell.days[day]; }
      if (cells <= USAGE_LIMITS.cells) break;
    }
  }
}
function add(cell, day, n, cutoff) {
  cell.total += n;
  if (!cell.first || day < cell.first) cell.first = day;
  if (!cell.last || day > cell.last) cell.last = day;
  if (day < cutoff) cell.older += n; else cell.days[day] = (cell.days[day] || 0) + n;
}
const blank = () => ({ first: '', last: '', older: 0, total: 0, days: {} });

const summary = state => {
  const days = new Set();
  for (const cell of Object.values(state.controls)) for (const day of Object.keys(cell.days)) days.add(day);
  return { hasData: Object.values(state.controls).some(cell => cell.total > 0), daysWithData: days.size };
};
const view = state => ({ enabled: state.enabled, paused: state.paused, ...summary(state), since: state.since, file: usageFrequencyPath(), limits: { keys: USAGE_LIMITS.keys, days: USAGE_LIMITS.days } });

/** The record of this DSH home. Prefer {@link usageFrequency}, which shares one queue per process. */
export function createUsageFrequency({ now = Date.now } = {}) {
  let queue = Promise.resolve();
  const turn = work => { const run = queue.then(work); queue = run.catch(() => {}); return run; };
  const load = async () => { try { return { state: clean(parseStoredJson(await readFile(usageFrequencyPath(), 'utf8'))), existed: true }; } catch { return { state: emptyState(), existed: false }; } };
  const save = async state => {
    const target = usageFrequencyPath(), temporary = `${target}.${randomUUID()}.tmp`;
    await mkdir(join(target, '..'), { recursive: true });
    await writeFile(temporary, JSON.stringify(state), { encoding: 'utf8', mode: 0o600 });
    try { await rename(temporary, target); } catch (error) { await rm(temporary, { force: true }); throw error; }
  };
  return {
    /** The switch and what is recorded, in one small view. Never creates anything. */
    async status() { await queue.catch(() => {}); return view((await load()).state); },
    /** The whole record, made safe (for the report and the export). */
    async read() { await queue.catch(() => {}); return (await load()).state; },
    /** Turn recording on or off, pause or resume it. Nothing is written when nothing changes and no file exists. */
    set({ enabled, paused } = {}) {
      for (const [name, value] of [['enabled', enabled], ['paused', paused]]) if (value !== undefined && typeof value !== 'boolean') return Promise.reject(new Error(`${name} 必须是 true 或 false`));
      return turn(async () => {
        const { state, existed } = await load();
        const next = { ...state, enabled: enabled ?? state.enabled, paused: paused ?? state.paused };
        if (enabled === true && paused === undefined) next.paused = false;
        if (next.enabled && !next.since) next.since = localDay(now());
        if (existed || next.enabled || next.paused) await save(next);
        return view(next);
      });
    },
    /** Add a batch of { key, area, day, n }. While it is off or paused nothing is written and the answer says so. */
    record(records) {
      return turn(async () => {
        const list = Array.isArray(records) ? records : [];
        const { state } = await load();
        if (!state.enabled || state.paused) return { accepted: 0, rejected: 0, enabled: false };
        const at = now(), earliest = localDay(at - USAGE_LIMITS.pastDays * DAY_MS), latest = localDay(at + USAGE_LIMITS.futureDays * DAY_MS), cutoff = cutoffDay(at);
        let accepted = 0, rejected = Math.max(0, list.length - USAGE_LIMITS.recordsPerBatch);
        for (const record of list.slice(0, USAGE_LIMITS.recordsPerBatch)) {
          const day = validDay(record?.day), n = record?.n;
          if (!record || typeof record !== 'object' || !validKey(record.key) || !day || day < earliest || day > latest || !Number.isInteger(n) || n < 1 || n > USAGE_LIMITS.countPerRecord) { rejected += 1; continue; }
          let key = record.key;
          if (!state.controls[key]) {
            const distinct = Object.keys(state.controls).length - (state.controls[OTHER_KEY] ? 1 : 0);
            if (key !== OTHER_KEY && distinct >= USAGE_LIMITS.keys) key = OTHER_KEY;
            state.controls[key] ||= blank();
          }
          add(state.controls[key], day, n, cutoff);
          const area = USAGE_AREA_IDS.includes(record.area) ? record.area : 'other';
          add(state.areas[area] ||= blank(), day, n, cutoff);
          accepted += 1;
        }
        fold(state, at);
        if (accepted) await save(state);
        return { accepted, rejected, enabled: true };
      });
    },
    /** Delete every record. The switch stays as it is. */
    clear() {
      return turn(async () => {
        const { state, existed } = await load();
        const next = { ...emptyState(), enabled: state.enabled, paused: state.paused, since: state.enabled ? localDay(now()) : '' };
        if (existed) await save(next);
        return view(next);
      });
    },
  };
}

let shared;
/** One record per process, so every caller (every tab) queues behind the same writer. */
export const usageFrequency = () => (shared ||= createUsageFrequency());
