/* 总纲 page: the pure part. The rows on screen (documents, the chapters of the open ones, 未归位; or the AI outline's chapters, sections and points), what a
   key does on them, what is picked, and the view the learner left (open rows, the deck filter), kept for the way back from a practice round. No React, no ui(). */
import { contractOf, isRunningTask } from '../tasks/task-model.js';
import { suggestRoles } from '../../lib/exam-prep-roles.js';

export const UNPLACED = 'unplaced';
/** The task kind of a 总纲 build (lib/contexts/generation/outline), as the console lists it. */
export const OUTLINE_BUILD_KIND = 'course-outline-build';

/**
 * The rows of the AI outline (course.outline's `book`), in reading order: a chapter (章, open by default), its sections (节) and points (知识点), a point's
 * rows (the materials' documents and chapters it holds) when it has more than one, a document's chapters, 其他, 未归位. A row is { key, level, kind, node,
 * number?, hasChildren, expanded, parentKey, ancestors }: a chapter or section opens its children (already read), a point or 其他 opens its rows (read
 * on demand) or, with one row, its questions.
 */
function bookRows(outline, details, open) {
  const rows = [], book = outline.book;
  const rowsOf = (key, level, ancestors) => {
    for (const row of details[key]?.anchors || []) {
      const chapters = row.kind === 'document' && row.chapters > 0, expanded = open.has(row.key), path = [...ancestors, key];
      rows.push({ key: row.key, level, kind: 'anchor', node: row, hasChildren: chapters, expanded, parentKey: key, ancestors: path });
      if (chapters && expanded) for (const chapter of details[row.key]?.chapters || [])
        rows.push({ key: chapter.key, level: level + 1, kind: chapter.kind, node: { ...chapter, material: row.title }, hasChildren: false, expanded: open.has(chapter.key), parentKey: row.key,
          ancestors: [...path, row.key] });
    }
  };
  const walk = (node, level, ancestors, number) => {
    const leaf = !node.children, expanded = open.has(node.key);
    rows.push({ key: node.key, level, kind: leaf ? 'point' : level === 1 ? 'part' : 'section', node, number, hasChildren: leaf ? !!node.opensRows : node.children.length > 0, expanded,
      parentKey: ancestors.at(-1) ?? null, ancestors });
    if (!expanded) return;
    if (!leaf) node.children.forEach((child, at) => walk(child, level + 1, [...ancestors, node.key], `${number}.${at + 1}`));
    else if (node.opensRows) rowsOf(node.key, level + 1, ancestors);
  };
  book.nodes.forEach((node, at) => walk(node, 1, [], `${at + 1}`));
  if (book.other) {
    rows.push({ key: book.other.key, level: 1, kind: 'other', node: book.other, hasChildren: !!book.other.opensRows, expanded: open.has(book.other.key), parentKey: null, ancestors: [] });
    if (open.has(book.other.key) && book.other.opensRows) rowsOf(book.other.key, 2, []);
  }
  if (outline.unplaced?.total > 0) rows.push({ key: UNPLACED, level: 1, kind: 'unplaced', node: outline.unplaced, hasChildren: false, expanded: open.has(UNPLACED), parentKey: null, ancestors: [] });
  return rows;
}

/** The course's materials offered as sample papers: the ones that look like one first (lib/exam-prep-roles.js, the 考点清单's guess), none picked by default. */
export function paperChoices(documents) {
  const list = Array.isArray(documents) ? documents : [];
  const roles = suggestRoles(list.map(item => ({ id: item.key, title: item.title, format: item.format })));
  return list.map((item, at) => ({ key: item.key, title: item.title, likely: roles[at]?.role === 'past-paper' })).sort((a, b) => Number(b.likely) - Number(a.likely));
}

/** The keys open when an outline is first shown: its chapters (章 open, 节 closed). */
export const bookDefaultOpen = book => (book?.nodes || []).map(node => node.key);

/** The running 总纲 build of a course, from the snapshot's jobs: { jobId, done, total } or null. */
export function runningBuild(jobs, course) {
  for (const job of Array.isArray(jobs) ? jobs : []) {
    const contract = contractOf(job);
    if (contract.kind !== OUTLINE_BUILD_KIND || contract.detail?.course !== course || !isRunningTask(job)) continue;
    return { jobId: contract.jobId, status: contract.status, done: contract.progress?.done ?? 0, total: contract.progress?.total ?? 0 };
  }
  return null;
}

/**
 * The rows on screen, in reading order: each document, its chapters when it is open (its `chapters` count says it has some), 未归位 last
 * when it holds a question. `open` is a Set of keys; `details` the answers of course.outline's `open`. A row is { key, level, kind, node,
 * hasChildren, expanded, parentKey }: a document with chapters opens its chapters, any other row its questions. With an AI outline (`book`) its rows instead.
 */
export function outlineRows(outline, details, open) {
  if (outline?.book) return bookRows(outline, details, open);
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
  kept.set(JSON.stringify([root, course]), { open: [...view.open], deckId: view.deckId || '', ...(view.bookId ? { bookId: view.bookId } : {}) });
  if (kept.size > 20) kept.delete(kept.keys().next().value);
}
