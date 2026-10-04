/* The study map's data helpers: scope keys, mastery roll-ups and the fold /
   selection transitions of the deck tree. No React, so each can be tested alone. */

export const BAR_ORDER = ['mastered', 'familiar', 'learning', 'weak', 'new'];
export const EMPTY_PROGRESS = {};
export const EMPTY_NOTEBOOKS = [];

/** A deck, or one topic of it, as a selection key. */
export const topicKey = (deckId, topic) => JSON.stringify([deckId, topic || '']);

/** Selection keys as the scope list `start` and the graph take. */
export const scopeOf = (keys) => [...keys].map((key) => {
  const [deckId, topic] = JSON.parse(key);
  return topic ? { deckId, topic } : { deckId };
});

export const sameScope = (a = [], b = []) => a.length === b.length
  && a.every((x) => b.some((y) => y.deckId === x.deckId && (y.topic || '') === (x.topic || '')));

/** The mastery bucket a deck or topic row shows as its dot. */
export function dotLevel(node) {
  if (node.status === 'todo') return 'new';
  if (node.status === 'done') return 'mastered';
  if (node.counts.weak) return 'weak';
  return node.mastery >= 60 ? 'familiar' : 'learning';
}

/** Several decks' progress as one node (a folder's bar, the course's mastery). */
export function mergeProgress(list) {
  const counts = Object.fromEntries(BAR_ORDER.map((level) => [level, 0]));
  let total = 0, weighted = 0, due = 0;
  for (const p of list) {
    for (const level of BAR_ORDER) counts[level] += p.counts[level];
    total += p.total ?? BAR_ORDER.reduce((n, level) => n + p.counts[level], 0);
    weighted += p.mastery * (p.total ?? 0);
    due += p.due;
  }
  return { counts, total, due, mastery: total ? Math.round(weighted / total) : 0, status: !total || counts.new === total ? 'todo' : 'active' };
}

const openKey = (root) => `study-map-open:${root}`;

/** The folds this browser remembered for a library, or null. */
export function readExpanded(root, storage = globalThis.localStorage) {
  try {
    const saved = storage?.getItem(openKey(root));
    return saved ? new Set(JSON.parse(saved)) : null;
  } catch {
    return null;
  }
}

export function writeExpanded(root, expanded, storage = globalThis.localStorage) {
  try { storage?.setItem(openKey(root), JSON.stringify([...expanded])); } catch { /* the folds just are not remembered */ }
}

/** Every course open, and the decks too while the library is small. */
export const defaultExpanded = (decks) => new Set([
  ...decks.map((deck) => `folder:${deck.folder}`),
  ...(decks.length <= 3 ? decks.map((deck) => deck.id) : []),
]);

export function toggleInSet(set, id) {
  const next = new Set(set);
  if (next.has(id)) next.delete(id); else next.add(id);
  return next;
}

/** Select or clear keys; a whole deck supersedes its individual topics. */
export function applySelection(selected, keys, on) {
  const next = new Set(selected);
  for (const key of keys) { if (on) next.add(key); else next.delete(key); }
  for (const key of keys) {
    const [deckId, topic] = JSON.parse(key);
    if (!topic && on) for (const other of [...next]) if (other !== key && JSON.parse(other)[0] === deckId) next.delete(other);
  }
  return next;
}
