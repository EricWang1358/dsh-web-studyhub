/* The board's pure model, shared by the UI (optimistic updates, filtering,
   chips) and by lib/board.js (title and checklist validation). It must stay
   free of Node and browser APIs so both sides can import it. */

export const CHECKLIST_MAX_ITEMS = 50;
export const CHECKLIST_MAX_TEXT = 200;
export const LABEL_HUES = 6;

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
      return copy;
    }
    case 'board.card.archive': {
      const from = locateCard(board, args.id);
      if (!from) return board;
      const copy = next();
      copy.columns.find((column) => column.id === from.column).cardIds.splice(from.index, 1);
      copy.archived.push(copy.cards[args.id]);
      delete copy.cards[args.id];
      return copy;
    }
    case 'board.card.remove': {
      const from = locateCard(board, args.id);
      const copy = next();
      if (from) {
        copy.columns.find((column) => column.id === from.column).cardIds.splice(from.index, 1);
        delete copy.cards[args.id];
        return copy;
      }
      const index = copy.archived.findIndex((card) => card.id === args.id);
      if (index < 0) return board;
      copy.archived.splice(index, 1);
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
      for (const key of ['title', 'note', 'due', 'labels', 'checklist']) if (Object.hasOwn(args, key)) copy.cards[args.id][key] = structuredClone(args[key]);
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
