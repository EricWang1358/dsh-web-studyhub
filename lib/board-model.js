/* The board's pure model, shared by the UI (optimistic updates, filtering,
   chips) and by lib/board.js (title and checklist validation). It must stay
   free of Node and browser APIs so both sides can import it. */

export const CHECKLIST_MAX_ITEMS = 50;
export const CHECKLIST_MAX_TEXT = 200;
export const LABEL_HUES = 6;
export const ACTUAL_MINUTES_MAX = 240;
export const TIMER_WORK_MAX = 180;
export const TIMER_BREAK_MAX = 60;
export const TIME_LOG_MAX = 5000;
export const DEFAULT_TIMER_PREFS = Object.freeze({ workMinutes: 25, breakMinutes: 5, sound: false, notify: false });

/** A title needs at least one letter or digit: "?" or "..." is not a task. */
export const isMeaningfulTitle = (title) => typeof title === 'string' && /[\p{L}\p{N}]/u.test(title);

/** `{ done, total }` for the checklist on a card; cards without one count 0/0. */
export function checklistProgress(card) {
  const items = Array.isArray(card?.checklist) ? card.checklist : [];
  return { done: items.filter((item) => item?.done === true).length, total: items.length };
}

/** Today as YYYY-MM-DD in the local time zone (what the date inputs use). */
export function localDate(date = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

const dayNumber = (value) => {
  const [y, m, d] = String(value).split('-').map(Number);
  return Math.round(Date.UTC(y, m - 1, d) / 86400000);
};
const fromDayNumber = (n) => new Date(n * 86400000).toISOString().slice(0, 10);

/** The last day of the "this week" filter: today and the six days after it. */
export const weekEnd = (today) => fromDayNumber(dayNumber(today) + 6);

/**
 * How a due date relates to today: { kind, days } with days = due - today.
 * kind: overdue | today | tomorrow | soon (2-7 days) | later | done. A finished
 * card is never overdue. Returns null when there is no due date.
 */
export function dueState(due, today, done = false) {
  if (!due) return null;
  const days = dayNumber(due) - dayNumber(today);
  if (done) return { kind: 'done', days };
  if (days < 0) return { kind: 'overdue', days };
  if (days === 0) return { kind: 'today', days };
  if (days === 1) return { kind: 'tomorrow', days };
  return { kind: days <= 7 ? 'soon' : 'later', days };
}

/** A stable hue slot (0..LABEL_HUES-1) per label, so a label keeps its colour everywhere. */
export function labelHue(label) {
  let hash = 2166136261;
  for (const char of String(label).trim().toLowerCase()) {
    hash ^= char.codePointAt(0);
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  return hash % LABEL_HUES;
}

const allCards = (board) => [...Object.values(board?.cards || {})];

/** Existing labels with their card counts, most used first (then alphabetical). */
export function labelCounts(board) {
  const counts = new Map();
  for (const card of allCards(board)) for (const label of card.labels || []) counts.set(label, (counts.get(label) || 0) + 1);
  return [...counts].map(([label, count]) => ({ label, count }))
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
}

const words = (text) => String(text || '').toLowerCase().split(/\s+/).filter(Boolean);

export function isFiltering(query = {}) {
  return words(query.text).length > 0 || !!query.labels?.length || !!query.due;
}

/**
 * A copy of the board whose columns only list the cards matching the query:
 * { text, labels: [], due: 'overdue' | 'week', today }. Text must match every
 * word in the title, note or labels; label chips are ANDed. Columns are kept
 * (possibly empty) so the layout does not jump.
 */
export function filterCards(board, query = {}) {
  if (!isFiltering(query)) return board;
  const needles = words(query.text), chosen = (query.labels || []).map((label) => label.toLowerCase());
  const today = query.today || localDate(), end = weekEnd(today);
  const matches = (card, column) => {
    if (needles.length) {
      const haystack = [card.title, card.note, ...(card.labels || [])].join('\n').toLowerCase();
      if (!needles.every((word) => haystack.includes(word))) return false;
    }
    if (chosen.length) {
      const own = (card.labels || []).map((label) => label.toLowerCase());
      if (!chosen.every((label) => own.includes(label))) return false;
    }
    if (query.due === 'overdue') return !!card.due && !column.done && card.due < today;
    if (query.due === 'week') return !!card.due && !column.done && card.due >= today && card.due <= end;
    return true;
  };
  return { ...board, columns: board.columns.map((column) => ({ ...column, cardIds: column.cardIds.filter((id) => board.cards[id] && matches(board.cards[id], column)) })) };
}

/** Counts for a "today" summary: open cards that are overdue or due today. */
export function dueSummary(board, today = localDate()) {
  let overdue = 0, dueToday = 0;
  for (const column of board?.columns || []) {
    if (column.done) continue;
    for (const id of column.cardIds) {
      const due = board.cards[id]?.due;
      if (!due) continue;
      if (due < today) overdue++; else if (due === today) dueToday++;
    }
  }
  return { overdue, today: dueToday };
}

export function locateCard(board, id) {
  for (const column of board?.columns || []) {
    const index = column.cardIds.indexOf(id);
    if (index >= 0) return { column: column.id, index };
  }
  return null;
}

/** Where ticking (or un-ticking) a card sends it, or null when there is nowhere to go. */
export function doneToggleTarget(board, id) {
  const from = locateCard(board, id);
  if (!from) return null;
  const fromDone = board.columns.find((column) => column.id === from.column)?.done;
  const target = board.columns.find((column) => column.done !== fromDone);
  return target ? { column: target.id, index: target.cardIds.length } : null;
}

export const TODAY_SLOTS = Object.freeze(['am', 'pm', 'evening']);
export const TODAY_LANES = Object.freeze(['am', 'pm']);

const isWeekendDay = (ymd) => {
  const [y, m, d] = String(ymd || '').split('-').map(Number);
  if (!Number.isFinite(y) || !Number.isFinite(m) || !Number.isFinite(d)) return false;
  const day = new Date(Date.UTC(y, m - 1, d, 12, 0, 0)).getUTCDay();
  return day === 0 || day === 6;
};

/**
 * Returns the card's explicit slot (`'am' | 'pm' | 'evening'`) ONLY when it was scheduled for `today`;
 * a slot left from an earlier day is ignored automatically (#856).
 */
export function effectiveTodaySlot(card, today = localDate()) {
  if (!card || !TODAY_SLOTS.includes(card.slot)) return null;
  const activeDate = card.slotDate || card.plannedDate || card.learningTask?.createdDate || '';
  return activeDate === today ? card.slot : null;
}

/** Maps any valid `TODAY_SLOTS` value onto the visible lanes (`TODAY_LANES`: `['am', 'pm']` per Decision 2). */
export function resolveTodayLane(slot) {
  if (TODAY_LANES.includes(slot)) return slot;
  if (slot === 'evening') return 'pm';
  return 'am';
}

/**
 * Deterministic AM / PM split for newly accepted learning tasks (#856):
 * Walks `items` in plan order and fills `'am'` until accumulated `'am'` minutes reach roughly half of today's
 * planner budget (`amCount === 0 || amMinutes + itemMinutes / 2 < budgetMinutes / 2`), then places the remaining
 * items in `'pm'`. Never alters `budgetMinutes` or `course.plan`.
 */
export function assignTodaySlots(items, budgetMinutes = 40, { initialAmMinutes = 0, initialAmCount = 0 } = {}) {
  const half = Math.max(0, Number(budgetMinutes) || 0) / 2;
  let amMinutes = Math.max(0, Number(initialAmMinutes) || 0);
  let amCount = Math.max(0, Number(initialAmCount) || 0);
  let inPm = amCount > 0 && amMinutes >= half;
  return (items || []).map((item) => {
    const m = Math.max(0, Number(item?.minutes ?? item?.learningTask?.minutes) || 0);
    if (!inPm && (amCount === 0 || amMinutes + m / 2 < half)) {
      amMinutes += m;
      amCount += 1;
      return 'am';
    }
    inPm = true;
    return 'pm';
  });
}

/** Source badge kind for a card on Today (`'plan' | 'mistake' | 'manual'`, #856). */
export function cardTodaySource(card) {
  if (card?.learningTask) {
    if (card.learningTask.source === 'mistake') return 'mistake';
    if (card.learningTask.source === 'plan') return 'plan';
    if (
      card.learningTask.kind === 'practice' &&
      (/^巩固\s|^Strengthen\s/.test(card.title || '') || /需要巩固|more practice/i.test(card.learningTask.reason || ''))
    ) {
      return 'mistake';
    }
    return 'plan';
  }
  if ((card?.labels || []).some((label) => label === '错题' || /^mistakes?$/i.test(String(label).trim()))) {
    return 'mistake';
  }
  return 'manual';
}

function dropFromTodayOrder(board, id) {
  if (!board.todayOrder || !Array.isArray(board.todayOrder.ids)) return;
  const nextIds = board.todayOrder.ids.filter((entry) => entry !== id);
  if (nextIds.length) board.todayOrder = { ...board.todayOrder, ids: nextIds };
  else delete board.todayOrder;
}

/** Resolved focus timer preferences (`25 / 5` defaults when unset). */
export function resolveTimerPrefs(board) {
  const saved = board?.timerPrefs;
  return {
    workMinutes: Number.isInteger(saved?.workMinutes) && saved.workMinutes >= 1 && saved.workMinutes <= TIMER_WORK_MAX
      ? saved.workMinutes
      : DEFAULT_TIMER_PREFS.workMinutes,
    breakMinutes: Number.isInteger(saved?.breakMinutes) && saved.breakMinutes >= 1 && saved.breakMinutes <= TIMER_BREAK_MAX
      ? saved.breakMinutes
      : DEFAULT_TIMER_PREFS.breakMinutes,
    sound: saved?.sound === true,
    notify: saved?.notify === true,
  };
}

/** Recorded actual minutes on a board card (`learningTask.actualMinutes` for plan tasks, `card.actualMinutes` for manual cards). */
export function cardActualMinutes(card) {
  if (!card) return undefined;
  const value = card.learningTask ? card.learningTask.actualMinutes : card.actualMinutes;
  return Number.isInteger(value) && value >= 0 ? value : undefined;
}

/** Total logged focus minutes in `board.timeLog` linked to `cardId`. */
export function sumCardLoggedMinutes(board, cardId) {
  if (!cardId || !Array.isArray(board?.timeLog)) return 0;
  return board.timeLog.reduce((sum, entry) => sum + (entry?.cardId === cardId && Number.isInteger(entry.minutes) ? entry.minutes : 0), 0);
}

/**
 * Reconciles a card's `actualMinutes` (capped at `ACTUAL_MINUTES_MAX` = 240) after adding, editing, or removing
 * a `board.timeLog` entry, preserving any pre-existing non-timeLog baseline from `daily.plan.complete`.
 */
export function syncCardActualFromTimeLog(board, cardId, loggedBefore = 0) {
  if (!cardId || !board) return;
  const card = board.cards?.[cardId] || board.archived?.find((entry) => entry.id === cardId);
  if (!card) return;
  const current = cardActualMinutes(card) ?? 0;
  const base = Math.max(0, current - Math.min(ACTUAL_MINUTES_MAX, Math.max(0, loggedBefore)));
  const loggedAfter = sumCardLoggedMinutes(board, cardId);
  const nextVal = Math.max(0, Math.min(ACTUAL_MINUTES_MAX, base + loggedAfter));
  if (card.learningTask) {
    if (nextVal === 0 && base === 0 && loggedAfter === 0) delete card.learningTask.actualMinutes;
    else card.learningTask.actualMinutes = nextVal;
  } else if (nextVal === 0 && base === 0 && loggedAfter === 0) {
    delete card.actualMinutes;
  } else {
    card.actualMinutes = nextVal;
  }
  for (const plan of Object.values(board.dailyPlanner?.plans || {})) {
    const record = plan?.effort?.[cardId];
    if (!record) continue;
    if (record.task?.learningTask && card.learningTask) {
      if (card.learningTask.actualMinutes === undefined) delete record.task.learningTask.actualMinutes;
      else record.task.learningTask.actualMinutes = card.learningTask.actualMinutes;
    }
    if (record.actualMinutes !== undefined || (card.learningTask?.completedDate && card.learningTask.completedDate === plan.date)) {
      if (nextVal === 0 && base === 0 && loggedAfter === 0) delete record.actualMinutes;
      else record.actualMinutes = nextVal;
    }
  }
}

/**
 * Pure countdown snapshot for `board.timer` at `nowMs` (#858).
 * Subtracting `pausedMs` + any active pause window means page reloads, tab switches, or sidebar reopens stay exact.
 */
export function timerSnapshot(timer, nowMs = Date.now()) {
  if (!timer || typeof timer !== 'object') return null;
  const startedMs = Date.parse(timer.startedAt);
  const pausedAtMs = timer.pausedAt ? Date.parse(timer.pausedAt) : null;
  const activePauseMs = pausedAtMs !== null && Number.isFinite(pausedAtMs) ? Math.max(0, nowMs - pausedAtMs) : 0;
  const pausedTotalMs = Math.max(0, Number(timer.pausedMs) || 0) + activePauseMs;
  const elapsedMs = Number.isFinite(startedMs) ? Math.max(0, nowMs - startedMs - pausedTotalMs) : 0;
  const durationMinutes = Number.isInteger(timer.durationMinutes) && timer.durationMinutes >= 1 ? timer.durationMinutes : DEFAULT_TIMER_PREFS.workMinutes;
  const durationMs = durationMinutes * 60_000;
  const remainingMs = Math.max(0, durationMs - elapsedMs);
  const running = !timer.pausedAt;
  const finished = remainingMs === 0;
  const loggedMinutes = timer.mode === 'break'
    ? 0
    : finished
      ? Math.min(ACTUAL_MINUTES_MAX, durationMinutes)
      : Math.max(1, Math.min(ACTUAL_MINUTES_MAX, durationMinutes, Math.round(elapsedMs / 60_000)));
  return {
    ...timer,
    durationMinutes,
    running,
    paused: Boolean(timer.pausedAt),
    finished,
    elapsedMs,
    remainingMs,
    durationMs,
    pausedTotalMs,
    loggedMinutes,
  };
}

/** Today's focus records and total minutes from `board.timeLog`, strictly filtered by local calendar `date === today` (#858, #859). */
export function selectTodayTimeLog(board, today = localDate()) {
  const entries = (Array.isArray(board?.timeLog) ? board.timeLog : [])
    .filter((entry) => entry && entry.date === today && Number.isInteger(entry.minutes) && entry.minutes > 0);
  const totalMinutes = entries.reduce((sum, entry) => sum + entry.minutes, 0);
  return { entries, totalMinutes };
}

/**
 * A pure copy of the board with one action applied the way the server will
 * apply it, for optimistic updates. Revision is untouched. An action that
 * cannot be mirrored locally (or would be refused) returns the same object.
 */
export function applyBoardAction(board, action, args = {}) {
  if (!board || board.readOnly) return board;
  const columnOf = (id) => board.columns.findIndex((column) => column.id === id);
  const next = () => structuredClone(board);
  switch (action) {
    case 'board.card.move': {
      const from = locateCard(board, args.id), to = columnOf(args.column);
      if (!from || to < 0) return board;
      const copy = next();
      const source = copy.columns.find((column) => column.id === from.column);
      source.cardIds.splice(from.index, 1);
      const destination = copy.columns[to];
      const index = args.index ?? destination.cardIds.length;
      if (!Number.isInteger(index) || index < 0 || index > destination.cardIds.length) return board;
      destination.cardIds.splice(index, 0, args.id);
      if (copy.cards[args.id]) copy.cards[args.id].updatedAt = new Date().toISOString();
      return copy;
    }
    case 'board.card.archive': {
      const from = locateCard(board, args.id);
      if (!from) return board;
      const copy = next();
      copy.columns.find((column) => column.id === from.column).cardIds.splice(from.index, 1);
      copy.archived.push(copy.cards[args.id]);
      delete copy.cards[args.id];
      dropFromTodayOrder(copy, args.id);
      if (copy.timer?.cardId === args.id) delete copy.timer;
      return copy;
    }
    case 'board.card.remove': {
      const from = locateCard(board, args.id);
      const copy = next();
      const pruneLogs = () => {
        if (copy.timer?.cardId === args.id) delete copy.timer;
        if (Array.isArray(copy.timeLog)) {
          const kept = copy.timeLog.filter((entry) => entry.cardId !== args.id);
          if (kept.length) copy.timeLog = kept;
          else delete copy.timeLog;
        }
      };
      if (from) {
        copy.columns.find((column) => column.id === from.column).cardIds.splice(from.index, 1);
        delete copy.cards[args.id];
        dropFromTodayOrder(copy, args.id);
        pruneLogs();
        return copy;
      }
      const index = copy.archived.findIndex((card) => card.id === args.id);
      if (index < 0) return board;
      copy.archived.splice(index, 1);
      pruneLogs();
      return copy;
    }
    case 'board.card.restore': {
      const index = board.archived.findIndex((card) => card.id === args.id);
      const to = columnOf(args.column ?? board.columns[0]?.id);
      if (index < 0 || to < 0) return board;
      const copy = next();
      const [card] = copy.archived.splice(index, 1);
      const destination = copy.columns[to];
      const at = args.index ?? destination.cardIds.length;
      if (!Number.isInteger(at) || at < 0 || at > destination.cardIds.length) return board;
      copy.cards[card.id] = card;
      destination.cardIds.splice(at, 0, card.id);
      return copy;
    }
    case 'board.card.edit': {
      if (!board.cards[args.id]) return board;
      const copy = next();
      const target = copy.cards[args.id];
      for (const key of ['title', 'note', 'due', 'labels', 'checklist']) if (Object.hasOwn(args, key)) target[key] = structuredClone(args[key]);
      if (Object.hasOwn(args, 'title') && copy.timer?.cardId === args.id) copy.timer.cardTitle = target.title;
      if (Object.hasOwn(args, 'plannedDate')) {
        if (args.plannedDate) {
          target.plannedDate = args.plannedDate;
        } else {
          delete target.plannedDate;
          if (!Object.hasOwn(args, 'slot')) {
            delete target.slot;
            delete target.slotDate;
            dropFromTodayOrder(copy, args.id);
          }
        }
      }
      if (Object.hasOwn(args, 'slot')) {
        if (args.slot && TODAY_SLOTS.includes(args.slot)) {
          target.slot = args.slot;
          target.slotDate = args.slotDate || target.plannedDate || localDate();
        } else {
          delete target.slot;
          delete target.slotDate;
        }
      } else if (Object.hasOwn(args, 'slotDate')) {
        if (args.slotDate && target.slot) target.slotDate = args.slotDate;
        else {
          delete target.slot;
          delete target.slotDate;
        }
      }
      target.updatedAt = new Date().toISOString();
      return copy;
    }
    case 'board.today.move': {
      const clearing = args.slot === '' || args.slot === null;
      if (!board.cards[args.id] || (!clearing && !TODAY_SLOTS.includes(args.slot)) || typeof args.date !== 'string' || !args.date) return board;
      const copy = next();
      const target = copy.cards[args.id];
      if (clearing) {
        delete target.slot;
        delete target.slotDate;
      } else {
        target.slot = args.slot;
        target.slotDate = args.date;
      }
      if (Object.hasOwn(args, 'plannedDate')) {
        if (args.plannedDate) target.plannedDate = args.plannedDate;
        else delete target.plannedDate;
      } else if (args.schedule === true) {
        target.plannedDate = args.date;
      }
      if (Array.isArray(args.order)) {
        const ids = [...new Set(args.order.filter((id) => Object.hasOwn(copy.cards, id)))];
        if (ids.length) copy.todayOrder = { date: args.date, ids };
        else delete copy.todayOrder;
      }
      target.updatedAt = new Date().toISOString();
      return copy;
    }
    case 'board.timer.pause': {
      if (!board.timer || board.timer.pausedAt) return board;
      const copy = next();
      copy.timer.pausedAt = typeof args.now === 'string' ? args.now : new Date().toISOString();
      return copy;
    }
    case 'board.timer.resume': {
      if (!board.timer || !board.timer.pausedAt) return board;
      const copy = next();
      const resumedMs = Date.parse(typeof args.now === 'string' ? args.now : new Date().toISOString());
      const pausedAtMs = Date.parse(copy.timer.pausedAt);
      if (Number.isFinite(resumedMs) && Number.isFinite(pausedAtMs)) {
        copy.timer.pausedMs = Math.max(0, Number(copy.timer.pausedMs) || 0) + Math.max(0, resumedMs - pausedAtMs);
      }
      delete copy.timer.pausedAt;
      return copy;
    }
    case 'board.timer.cancel': {
      if (!board.timer) return board;
      const copy = next();
      delete copy.timer;
      return copy;
    }
    case 'board.timer.prefs': {
      const copy = next();
      const prev = resolveTimerPrefs(copy);
      copy.timerPrefs = {
        workMinutes: Number.isInteger(args.workMinutes) && args.workMinutes >= 1 && args.workMinutes <= TIMER_WORK_MAX ? args.workMinutes : prev.workMinutes,
        breakMinutes: Number.isInteger(args.breakMinutes) && args.breakMinutes >= 1 && args.breakMinutes <= TIMER_BREAK_MAX ? args.breakMinutes : prev.breakMinutes,
        sound: typeof args.sound === 'boolean' ? args.sound : prev.sound,
        notify: typeof args.notify === 'boolean' ? args.notify : prev.notify,
      };
      return copy;
    }
    case 'board.timeLog.edit': {
      if (!Array.isArray(board.timeLog)) return board;
      const idx = board.timeLog.findIndex((entry) => entry.id === args.id);
      if (idx < 0 || !Number.isInteger(args.minutes) || args.minutes < 1 || args.minutes > ACTUAL_MINUTES_MAX) return board;
      const copy = next();
      const target = copy.timeLog[idx];
      const loggedBefore = target.cardId ? sumCardLoggedMinutes(copy, target.cardId) : 0;
      target.minutes = args.minutes;
      if (typeof args.cardTitle === 'string' && isMeaningfulTitle(args.cardTitle)) target.cardTitle = args.cardTitle.trim();
      if (target.cardId) syncCardActualFromTimeLog(copy, target.cardId, loggedBefore);
      return copy;
    }
    case 'board.timeLog.remove': {
      if (!Array.isArray(board.timeLog)) return board;
      const idx = board.timeLog.findIndex((entry) => entry.id === args.id);
      if (idx < 0) return board;
      const copy = next();
      const [removed] = copy.timeLog.splice(idx, 1);
      const loggedBefore = (removed.cardId ? sumCardLoggedMinutes(copy, removed.cardId) : 0) + removed.minutes;
      if (!copy.timeLog.length) delete copy.timeLog;
      if (removed.cardId) syncCardActualFromTimeLog(copy, removed.cardId, loggedBefore);
      return copy;
    }
    case 'board.column.rename': {
      const at = columnOf(args.id);
      if (at < 0) return board;
      const copy = next();
      copy.columns[at].title = args.title;
      return copy;
    }
    case 'board.column.remove': {
      const at = columnOf(args.id);
      if (at < 0 || board.columns[at].cardIds.length || board.columns.length <= 1) return board;
      const copy = next();
      copy.columns.splice(at, 1);
      return copy;
    }
    default:
      return board;
  }
}

/**
 * Validate and normalise a checklist (shared by add, edit and undelete).
 * `makeId` supplies an id for items that have none. Throws Error on any problem.
 */
export function normalizeChecklist(value, makeId, isValidId) {
  const fail = (message) => { throw new Error(message); };
  if (!Array.isArray(value) || value.length > CHECKLIST_MAX_ITEMS) fail(`checklist must be an array of at most ${CHECKLIST_MAX_ITEMS} items`);
  const seen = new Set();
  return value.map((item) => {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) fail('checklist items must be objects');
    const text = typeof item.text === 'string' ? item.text.trim() : '';
    if (!text || text.length > CHECKLIST_MAX_TEXT) fail(`checklist item text must be 1-${CHECKLIST_MAX_TEXT} characters`);
    if (item.done !== undefined && typeof item.done !== 'boolean') fail('checklist item done must be true or false');
    const id = item.id === undefined ? makeId() : item.id;
    if (!isValidId(id) || seen.has(id)) fail('checklist item id must be a unique simple id');
    seen.add(id);
    return { id, text, done: item.done === true };
  });
}

function dailyPlanInfo(board, today, dailyTaskIds = []) {
  const orderedIds = [];
  const seen = new Set();
  const push = (id) => {
    if (!seen.has(id)) {
      seen.add(id);
      orderedIds.push(id);
    }
  };
  let planBudget;
  for (const plan of Object.values(board?.dailyPlanner?.plans || {})) {
    if (plan?.date === today) {
      if (planBudget === undefined && Number.isFinite(plan.budgetMinutes)) planBudget = plan.budgetMinutes;
      for (const id of plan.taskIds || []) push(id);
    }
  }
  for (const id of dailyTaskIds || []) push(id);
  const profile = board?.dailyPlanner?.profile;
  const fallbackBudget = Number.isFinite(profile?.[isWeekendDay(today) ? 'weekendMinutes' : 'weekdayMinutes'])
    ? profile[isWeekendDay(today) ? 'weekendMinutes' : 'weekdayMinutes']
    : 40;
  return { taskSet: seen, orderedTaskIds: orderedIds, budgetMinutes: planBudget ?? fallbackBudget };
}

/** Planned learning budget in minutes for `today` (explicit `daily.plan` budget when loaded, else board's saved dailyPlanner budget/profile). */
export function todayBudgetMinutes(board, today = localDate(), override) {
  if (override !== null && override !== undefined && Number.isFinite(Number(override))) {
    return Math.max(0, Math.round(Number(override)));
  }
  return dailyPlanInfo(board, today).budgetMinutes;
}

/** Whether a card in a done column was completed on `today` (in the local time zone) and stays visible with strikethrough until day end. */
export function isCompletedToday(card, today = localDate(), dailyTaskIds = []) {
  if (!card) return false;
  if (card.learningTask?.completedDate) return card.learningTask.completedDate === today;
  if (Array.isArray(dailyTaskIds) ? dailyTaskIds.includes(card.id) : dailyTaskIds?.has?.(card.id)) return true;
  if (card.plannedDate === today) return true;
  if (typeof card.updatedAt === 'string') {
    const parsed = Date.parse(card.updatedAt);
    if (Number.isFinite(parsed) && localDate(new Date(parsed)) === today) return true;
  }
  return false;
}

/** Whether an open card belongs on the Today view: today's accepted daily-plan tasks, due today or overdue, or scheduled onto today (`plannedDate`). */
export function isOpenTodayCard(card, { today = localDate(), dailyTaskIds = [] } = {}) {
  if (!card) return false;
  const inDaily = Array.isArray(dailyTaskIds) ? dailyTaskIds.includes(card.id) : dailyTaskIds?.has?.(card.id);
  return Boolean(
    inDaily ||
    (card.learningTask && card.learningTask.createdDate === today) ||
    (card.due && card.due <= today) ||
    card.plannedDate === today,
  );
}

/**
 * Pure projection of `board` for the 「今日」 view (#855, #856):
 * - `lanes`: `{ am, pm }`, each `{ id, cards, count, minutes }` ordered by today's saved order (`board.todayOrder`) or plan/column order
 * - `open`: `[...lanes.am.cards, ...lanes.pm.cards]`
 * - `done`: completed cards finished today (kept with strikethrough until local day end)
 * - `unscheduled`: remaining open cards that can be scheduled into Today with one click or drag
 */
export function selectTodayBoard(board, { today = localDate(), dailyTaskIds = [], budgetMinutes } = {}) {
  const emptyLane = (id) => ({ id, cards: [], count: 0, minutes: 0 });
  const emptyLanes = Object.fromEntries(TODAY_LANES.map((id) => [id, emptyLane(id)]));
  const rawOpen = [], done = [], unscheduled = [];
  if (!board?.columns || !board?.cards) return { open: [], done, unscheduled, lanes: emptyLanes };
  const { taskSet, orderedTaskIds, budgetMinutes: inferredBudget } = dailyPlanInfo(board, today, dailyTaskIds);
  const budget = Number.isFinite(budgetMinutes) ? budgetMinutes : inferredBudget;

  for (const column of board.columns) {
    for (const id of column.cardIds || []) {
      const card = board.cards[id];
      if (!card) continue;
      if (column.done) {
        if (isCompletedToday(card, today, taskSet)) done.push(card);
      } else if (isOpenTodayCard(card, { today, dailyTaskIds: taskSet })) {
        rawOpen.push(card);
      } else {
        unscheduled.push(card);
      }
    }
  }

  // Assign lanes: explicit today-scoped slot wins; unslotted learning tasks split AM/PM by ~half budget in plan order; manual/due cards default to AM.
  const planRank = new Map(orderedTaskIds.map((id, idx) => [id, idx]));
  const colRank = new Map(rawOpen.map((card, idx) => [card.id, idx]));
  const laneById = new Map();
  let explicitAmMinutes = 0;
  let explicitAmCount = 0;
  const unslottedLearning = [];

  for (const card of rawOpen) {
    const explicit = effectiveTodaySlot(card, today);
    if (explicit) {
      const lane = resolveTodayLane(explicit);
      laneById.set(card.id, lane);
      if (lane === 'am' && card.learningTask?.minutes) {
        explicitAmMinutes += card.learningTask.minutes;
        explicitAmCount += 1;
      }
    } else if (card.learningTask) {
      unslottedLearning.push(card);
    } else {
      laneById.set(card.id, 'am');
    }
  }

  if (unslottedLearning.length) {
    unslottedLearning.sort((a, b) => {
      const pa = planRank.has(a.id) ? planRank.get(a.id) : Number.MAX_SAFE_INTEGER;
      const pb = planRank.has(b.id) ? planRank.get(b.id) : Number.MAX_SAFE_INTEGER;
      return pa - pb || colRank.get(a.id) - colRank.get(b.id);
    });
    const autoSlots = assignTodaySlots(unslottedLearning, budget, {
      initialAmMinutes: explicitAmMinutes,
      initialAmCount: explicitAmCount,
    });
    unslottedLearning.forEach((card, at) => laneById.set(card.id, resolveTodayLane(autoSlots[at])));
  }

  const orderRank = board.todayOrder?.date === today && Array.isArray(board.todayOrder.ids)
    ? new Map(board.todayOrder.ids.map((id, idx) => [id, idx]))
    : null;
  const compareInLane = (a, b) => {
    if (orderRank) {
      const oa = orderRank.has(a.id) ? orderRank.get(a.id) : Number.MAX_SAFE_INTEGER;
      const ob = orderRank.has(b.id) ? orderRank.get(b.id) : Number.MAX_SAFE_INTEGER;
      if (oa !== ob) return oa - ob;
    }
    return (colRank.get(a.id) ?? 0) - (colRank.get(b.id) ?? 0);
  };

  const lanes = {};
  for (const id of TODAY_LANES) {
    const cards = rawOpen.filter((card) => laneById.get(card.id) === id).sort(compareInLane);
    const minutes = cards.reduce((sum, card) => sum + (Number.isInteger(card.learningTask?.minutes) ? card.learningTask.minutes : 0), 0);
    lanes[id] = { id, cards, count: cards.length, minutes };
  }
  const open = TODAY_LANES.flatMap((id) => lanes[id].cards);
  return { open, done, unscheduled, lanes };
}

/** Whether any active course in the snapshot has an active 备考计划 (`course.plan`). */
export function hasActiveCoursePlan(data) {
  return Array.isArray(data?.courses) && data.courses.some(
    (course) => course && course.active !== false && course.plan && (course.plan.status ?? 'active') === 'active',
  );
}

/** Decision 1 (#854 / #855): land on 「待办 → 今日」 when an active 备考计划 exists or Today has open items; otherwise land on 学习库. */
export function shouldLandOnToday({ data, board, today = localDate(), dailyTaskIds = [] } = {}) {
  if (!data) return false;
  if (hasActiveCoursePlan(data)) return true;
  if (!board) return false;
  return selectTodayBoard(board, { today, dailyTaskIds }).open.length > 0;
}
