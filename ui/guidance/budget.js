import { browserStorage, writeJSON } from '../storage.js';

/*
 * The guidance budget and the master switch (3.7 guidance, step 0; docs/qa/click-baseline.md for the click baseline taken with it).
 *
 * One key, in this browser only (ui/storage.js): study-guidance:v1 = { day, shownToday, off, muted }.
 *   day, shownToday  how many PROACTIVE tips (a tip or card that appears without being asked for) were shown on that local calendar day;
 *   off              the master switch of Settings › 引导 is off (default: on, i.e. the key is missing or `off` is not true);
 *   muted            ids of registered items (ui/guidance/registry.js) the learner switched off one by one.
 *
 * The rule a proactive tip asks before it shows (allowProactiveTip): at most ONE a local day, never during a practice or review run, never when the
 * master switch is off, and never when the storage cannot be read (then nothing proactive is shown at all: no budget can be kept, so none is spent).
 * Nothing here throws. The master switch never hides the first-run line, the model-setup gate or the help of an error or an empty page: those are
 * not proactive and do not ask.
 */
export const GUIDANCE_KEY = 'study-guidance:v1';
export const TIPS_PER_DAY = 1;

/** "2026-10-26": the local calendar day of `now` (a Date or ms), the day the budget counts in. */
export function localDay(now = Date.now()) {
  const date = new Date(now);
  const pad = value => String(100 + value).slice(1); // a storage key, not a clock on screen (ui/format.js keeps those)
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

const clean = value => {
  const state = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  return {
    day: typeof state.day === 'string' ? state.day : '',
    shownToday: Number.isInteger(state.shownToday) && state.shownToday > 0 ? state.shownToday : 0,
    off: state.off === true,
    muted: Array.isArray(state.muted) ? [...new Set(state.muted.filter(id => typeof id === 'string'))] : [],
  };
};

/**
 * What is stored, cleaned: { day, shownToday, off, muted }, or null when the browser has no storage or refuses to read it.
 * A damaged value reads as nothing stored (the defaults).
 */
export function readGuidanceState(storage = browserStorage()) {
  if (!storage) return null;
  let raw;
  try { raw = storage.getItem(GUIDANCE_KEY); } catch { return null; }
  if (raw === null || raw === undefined) return clean(null);
  try { return clean(JSON.parse(raw)); } catch { return clean(null); }
}

const write = (state, storage) => writeJSON(GUIDANCE_KEY, clean(state), storage);

/**
 * May a proactive tip show now? { allow, reason }: reason is 'ok', 'no-storage' (`seen` is null), 'off' (master switch), 'practice' (`inPractice`)
 * or 'used' (today's one tip was already shown). `seen` is readGuidanceState(); `today` defaults to localDay(now). Pure.
 */
export function proactiveTipDecision({ now = Date.now(), seen, inPractice = false, today } = {}) {
  if (!seen) return { allow: false, reason: 'no-storage' };
  const state = clean(seen);
  if (state.off) return { allow: false, reason: 'off' };
  if (inPractice) return { allow: false, reason: 'practice' };
  const day = today || localDay(now);
  if (state.day === day && state.shownToday >= TIPS_PER_DAY) return { allow: false, reason: 'used' };
  return { allow: true, reason: 'ok' };
}

/** The decision as a yes or no. */
export const allowProactiveTip = input => proactiveTipDecision(input).allow;

/** Count one proactive tip as shown today; true when it was stored. A tip must not show when this answers false (the budget could not be kept). */
export function recordProactiveTip({ now = Date.now(), storage = browserStorage() } = {}) {
  const state = readGuidanceState(storage);
  if (!state) return false;
  const day = localDay(now);
  return write({ ...state, day, shownToday: state.day === day ? state.shownToday + 1 : 1 }, storage);
}

/** Is the master switch on? It is when nothing says otherwise, including a browser without storage (the default stays). */
export const guidanceOn = (storage = browserStorage()) => readGuidanceState(storage)?.off !== true;

/** Turn the master switch on or off; true when it was stored. The day's count and the per-item choices stay. */
export function setGuidanceOn(on, storage = browserStorage()) {
  const state = readGuidanceState(storage);
  return state ? write({ ...state, off: !on }, storage) : false;
}

/** Has the learner switched item `id` off? */
export const itemMuted = (id, storage = browserStorage()) => !!readGuidanceState(storage)?.muted.includes(id);

/** Switch one item on or off; true when it was stored. */
export function setItemMuted(id, muted, storage = browserStorage()) {
  const state = readGuidanceState(storage);
  if (!state) return false;
  const rest = state.muted.filter(item => item !== id);
  return write({ ...state, muted: muted ? [...rest, id] : rest }, storage);
}

/** May the proactive item `id` show at all (the master switch is on and the item is not switched off)? A surface checks this before its own memory. */
export const guidanceAllows = (id, storage = browserStorage()) => guidanceOn(storage) && !itemMuted(id, storage);
