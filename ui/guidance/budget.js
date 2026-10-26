import { browserStorage, writeJSON } from '../storage.js';

/*
 * The guidance budget and the master switch (3.7 guidance, step 0; docs/qa/click-baseline.md for the click baseline taken with it).
 *
 * One key, in this browser only (ui/storage.js): study-guidance:v1 = { day, shownToday, off, muted }.
 *   day, shownToday  how many PROACTIVE tips (a tip or card that appears without being asked for) were shown on that local calendar day;
 *   off              the master switch of Settings › 引导 is off (default: on, i.e. the key is missing or `off` is not true);
 *   muted            ids of registered items (ui/guidance/registry.js) the learner switched off one by one.
 *
 * The rule a proactive tip claims before it shows (claimProactiveTip, one atomic call): at most ONE a local day, never during a practice or review
 * run, never when the master switch or the item's own switch is off, and never when the storage cannot be read or written (then nothing proactive is
 * shown at all: no budget can be kept, so none is spent). proactiveTipDecision / allowProactiveTip are the same rule without spending, for tests.
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

/** The decision as a yes or no, without spending anything (for tests and previews; a tip that is about to show claims instead). */
export const allowProactiveTip = input => proactiveTipDecision(input).allow;

/* The day this visit already gave its one tip away: a second tip in the same render (or a second component of the same visit) loses at once, before
   the storage is even read. */
let claimedDay = '';

/**
 * Claim today's one proactive tip for item `id`, in ONE call: read, decide, write. True only when the claim was stored; then, and only then, the tip
 * shows. False when the day is spent (in this visit or in the stored count), the learner is in practice, the master switch or the item's own switch is
 * off, or the storage cannot be read or written. Call it from an effect behind a ref (never during render, so StrictMode's second render cannot
 * spend the day without showing anything):
 *
 *   const asked = useRef(false); const [show, setShow] = useState(false);
 *   useEffect(() => { if (!asked.current && wanted) { asked.current = true; setShow(claimProactiveTip({ id, inPractice })); } }, [wanted]);
 *
 * Two tabs: the read and the write happen in one synchronous call, so another tab can only slip in between if it claims in that same moment.
 */
export function claimProactiveTip({ id, now = Date.now(), inPractice = false, storage = browserStorage() } = {}) {
  const day = localDay(now);
  if (claimedDay === day) return false;
  const seen = readGuidanceState(storage);
  if (!proactiveTipDecision({ now, seen, inPractice, today: day }).allow) return false;
  if (id && seen.muted.includes(id)) return false;
  if (!write({ ...seen, day, shownToday: seen.day === day ? seen.shownToday + 1 : 1 }, storage)) return false;
  claimedDay = day;
  return true;
}

/** Start a new visit (tests): the claim of this visit is forgotten, the stored count stays. */
export const forgetVisitClaim = () => { claimedDay = ''; };

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
