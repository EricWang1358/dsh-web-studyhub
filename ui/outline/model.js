/* 总纲 page: the pure part. The rows on screen (documents, the chapters of the open ones, 未归位), what a key does on them, what is
   picked, and the view the learner left (open rows, the deck filter), kept for the way back from a practice round. No React, no ui(). */

export const UNPLACED = 'unplaced';

/**
 * The rows on screen, in reading order: each document, its chapters when it is open (its `chapters` count says it has some), 未归位 last
 * when it holds a question. `open` is a Set of keys; `details` the answers of course.outline's `open`. A row is { key, level, kind, node,
 * hasChildren, expanded, parentKey }: a document with chapters opens its chapters, any other row its questions.
 */
export function outlineRows(outline, details, open) {
  const rows = [];
  for (const node of outline?.documents || []) {
    const hasChildren = node.chapters > 0, expanded = open.has(node.key);
    rows.push({ key: node.key, level: 1, kind: 'document', node, hasChildren, expanded, parentKey: null });
    if (hasChildren && expanded) for (const chapter of details[node.key]?.chapters || [])
      rows.push({ key: chapter.key, level: 2, kind: chapter.kind, node: chapter, hasChildren: false, expanded: open.has(chapter.key), parentKey: node.key });
  }
  if (outline?.unplaced?.total > 0) rows.push({ key: UNPLACED, level: 1, kind: 'unplaced', node: outline.unplaced, hasChildren: false, expanded: open.has(UNPLACED), parentKey: null });
  return rows;
}

/** What a key does on the rows (the tree pattern of ui/exam-prep/model.js treeKey): { focus: key }, { toggle: key, open }, {} or null (not ours). */
export function outlineKey(rows, current, key) {
  if (!rows.length) return null;
  const at = Math.max(0, rows.findIndex(row => row.key === current)), row = rows[at];
  const focus = target => ({ focus: (target || row).key });
  switch (key) {
    case 'ArrowDown': return focus(rows[Math.min(rows.length - 1, at + 1)]);
    case 'ArrowUp': return focus(rows[Math.max(0, at - 1)]);
    case 'Home': return focus(rows[0]);
    case 'End': return focus(rows.at(-1));
    case 'ArrowRight': return row.expanded ? (row.hasChildren && rows[at + 1]?.parentKey === row.key ? focus(rows[at + 1]) : {}) : { toggle: row.key, open: true };
    case 'ArrowLeft': return row.expanded ? { toggle: row.key, open: false } : row.parentKey ? { focus: row.parentKey } : {};
    default: return null;
  }
}

/** The picked rows and questions: { keys: Set, cards: Map<"deckId|cardId", { deckId, cardId }> }. */
export const emptyPick = () => ({ keys: new Set(), cards: new Map() });
export const isPicked = pick => pick.keys.size > 0 || pick.cards.size > 0;
export function pickRow(pick, key, on) {
  const keys = new Set(pick.keys);
  if (on) keys.add(key); else keys.delete(key);
  return { keys, cards: pick.cards };
}
export function pickCard(pick, ref, on) {
  const cards = new Map(pick.cards), id = `${ref.deckId}|${ref.cardId}`;
  if (on) cards.set(id, { deckId: ref.deckId, cardId: ref.cardId }); else cards.delete(id);
  return { keys: pick.keys, cards };
}
/** The pick as course.outline's `pick` argument. */
export const pickArgs = pick => ({ keys: [...pick.keys], cards: [...pick.cards.values()] });
/** Is a question ticked, by itself or by a row it is in (`rowKeys`: the rows on screen that hold it)? */
export const cardTicked = (pick, ref, rowKeys = []) => pick.cards.has(`${ref.deckId}|${ref.cardId}`) || rowKeys.some(key => pick.keys.has(key));

/* The view the learner left, per library and course: the open rows and the deck filter, so the way back from a round opens the page as it was.
   Memory only (a session), never stored. */
const kept = new Map();
export const keptView = (root, course) => kept.get(JSON.stringify([root, course])) || null;
export function keepView(root, course, view) {
  kept.set(JSON.stringify([root, course]), { open: [...view.open], deckId: view.deckId || '' });
  if (kept.size > 20) kept.delete(kept.keys().next().value);
}
