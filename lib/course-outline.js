/* 课程总纲 (course outline), step 1: `course.outline`, read on demand by the 总纲 page (never in the snapshot). Pure, no I/O.
   Where the questions stand is lib/course-outline-index.js; this file makes the answer: the tree with counts and mastery, the questions of the rows
   the caller opened, and a practice scope for what the learner picked.

   course.outline { course?, deckId?, expand?: [key], pick?: { keys?: [key], cards?: [{ deckId, cardId }] } }
   -> { status: 'ok' | 'empty', course, total, placed, summary, draftCards, limit, decks: [{ id, title, total }], deckId,
        documents: [{ key, title, format, chapters, total, summary, deckCount, resume? }], unplaced: { key, total, summary, reasons, materials: [{ key, title }] (at most 20), materialCount },
        open: { [key]: { chapters: [node] } | { cards: [ref], more } } }
   A node is { key, kind: 'chapter' | 'rest', index?, title, level?, front?, total, summary, deckCount, resume? }; a ref is { deckId, cardId, deckTitle,
   prompt, level, due, shared?, inactive?, reason? }. `total` counts a question once however many rows hold it; `summary` is lib/material-summary.js's
   (the 资料 list's words), with `draftCards` when drafts of the course point there (drafts never count). `resume` is an unfinished practice run of
   exactly a row's questions (review.start with fresh:false goes on with it).
   With `pick` the answer is only { status, course, practice: { scope, total, capped, limit } }: the picked rows and questions once each; more than
   `limit` (review.start takes 200) are cut to the first 200 in the order a practice round takes them (lib/mastery.js planPath: due, weak, new).
   Step 2: when the course has an organised outline (lib/course-outline-book.js), the answer also has `book` (bookView below): its nodes are rows too, keyed
   `bk:…`, so `expand` and `pick` take them; a leaf's questions are those of the engine rows it names, computed here like every other row. */
import { planPath, latestOutcomes, scopeKey } from './mastery.js';
import { currentCourse } from './focus.js';
import { summarizeLinked } from './material-summary.js';
import { runOpen, runKey } from './study-state.js';
import { buildOutlineIndex, UNPLACED_KEY, chapterKey, restKey } from './course-outline-index.js';
import { currentCourseOutline, leafPapers, leafTier, materialsFingerprint } from './course-outline-book.js';
import { bookLayout, OTHER_KEY } from './course-outline-book-view.js';

export { UNPLACED_KEY, OTHER_KEY };
/** The most questions one practice round takes (lib/prereq.js checkScope). */
export const PRACTICE_LIMIT = 200;
/** The most questions an opened row lists; the rest are counted (`more`) and practised with the row. */
export const CARDS_SHOWN = 400;

const memo = { key: null, parts: null, value: null };
const partsOf = state => ['sources', 'documents', 'decks', 'drafts', 'attempts'].map(field => state?.[field]);
/** The placement of a course, built once per library revision, minute (due dates move), course and deck filter. */
export function courseOutlineIndex(state, { course, deckId } = {}, { root = '', now = Date.now() } = {}) {
  // A library revision, or the store's deep-frozen shared collections (a read through storagePort.view()), say the library has not changed.
  const parts = partsOf(state), known = state?.revision !== undefined || parts.every(part => part === undefined || Object.isFrozen(part));
  const key = known ? JSON.stringify([root, state?.revision ?? null, Math.floor(now / 60000), course, deckId || '']) : null;
  if (key && memo.key === key && memo.parts.every((part, at) => part === parts[at])) return memo.value;
  const value = buildOutlineIndex(state, { course, deckId, now });
  Object.assign(memo, { key, parts, value });
  return value;
}

const summaryOf = (entries, drafts) => drafts > 0 ? { ...summarizeLinked(entries), draftCards: drafts } : summarizeLinked(entries);
const byReading = (a, b) => a.order[0] - b.order[0] || a.order[1] - b.order[1] || a.entry.rank[0] - b.entry.rank[0] || a.entry.rank[1] - b.entry.rank[1];
const refView = entry => ({ deckId: entry.deckId, cardId: entry.cardId, deckTitle: entry.deckTitle, prompt: entry.prompt, level: entry.level, due: entry.due,
  ...(entry.nodes.size > 1 ? { shared: true } : {}), ...(entry.inactive ? { inactive: true } : {}), ...(entry.reason ? { reason: entry.reason } : {}) });

/** The rows of the outline: every key with what it is and which node keys its questions are in. */
function layoutOf(index) {
  const rows = new Map();
  for (const item of index.documents) {
    const chapters = (item.chapters || []).map(chapter => ({ key: chapterKey(item.key, chapter.index), kind: 'chapter', index: chapter.index, title: chapter.title,
      level: chapter.level, ...(chapter.front ? { front: true } : {}), nodes: [chapterKey(item.key, chapter.index)] }));
    if (chapters.length && (index.nodes.has(restKey(item.key)) || index.draftNodes.has(restKey(item.key)))) chapters.push({ key: restKey(item.key), kind: 'rest', title: '', nodes: [restKey(item.key)] });
    for (const chapter of chapters) rows.set(chapter.key, chapter);
    rows.set(item.key, { key: item.key, kind: 'document', item, chapters, nodes: chapters.length ? chapters.flatMap(chapter => chapter.nodes) : [item.key] });
  }
  return rows;
}

/** The questions of a row (a document, a chapter, 未归位), once each. */
function entriesOf(index, row) {
  if (row === UNPLACED_KEY) return [...index.cards.values()].filter(entry => entry.reason);
  const refs = new Set(row.nodes.flatMap(node => [...(index.nodes.get(node)?.keys() || [])]));
  return [...refs].map(ref => index.cards.get(ref));
}

function openRuns(state) {
  const runs = new Map();
  for (const run of Array.isArray(state.runs) ? state.runs : []) if (run && !run.workflowSessionId && run.mode === 'path' && Array.isArray(run.entries) && runOpen(run)) runs.set(runKey(run), run);
  return runs;
}

function rowView(index, row, runs, extra) {
  const entries = entriesOf(index, row), drafts = new Set(row.nodes.flatMap(node => [...(index.draftNodes.get(node) || [])])).size;
  const run = entries.length && entries.length <= PRACTICE_LIMIT ? runs.get(scopeKey('path', entries.map(entry => ({ deckId: entry.deckId, cardId: entry.cardId })))) : null;
  return { key: row.key, ...extra, total: entries.length, summary: summaryOf(entries, drafts), deckCount: new Set(entries.map(entry => entry.deckId)).size,
    ...(run ? { resume: { runId: run.id, index: run.index, total: run.entries.length } } : {}) };
}

function cardsOf(index, row) {
  const list = row === UNPLACED_KEY ? entriesOf(index, row).map(entry => ({ entry, order: [0, 0] }))
    : [...new Map(row.nodes.flatMap(node => [...(index.nodes.get(node) || [])]).map(([ref, order]) => [ref, { entry: index.cards.get(ref), order }])).values()];
  list.sort(byReading);
  return { cards: list.slice(0, CARDS_SHOWN).map(({ entry }) => refView(entry)), more: Math.max(0, list.length - CARDS_SHOWN) };
}

/** The practice scope of some rows and questions: once each, at most PRACTICE_LIMIT, in the order a practice round takes them. */
function practiceOf(state, index, rowOf, { keys = [], cards = [] } = {}, now) {
  const chosen = new Set();
  for (const key of Array.isArray(keys) ? keys : []) {
    const row = rowOf(key);
    if (row) for (const entry of entriesOf(index, row)) chosen.add(entry);
  }
  for (const ref of Array.isArray(cards) ? cards : []) { const entry = index.cards.get(`${ref?.deckId}|${ref?.cardId}`); if (entry) chosen.add(entry); }
  // planPath over the chosen questions alone: the order of a practice round on an explicit scope (due by date, weak, new, then the rest).
  const wanted = new Map();
  for (const entry of chosen) { if (!wanted.has(entry.deckId)) wanted.set(entry.deckId, new Set()); wanted.get(entry.deckId).add(entry.cardId); }
  const decks = (Array.isArray(state.decks) ? state.decks : []).filter(deck => wanted.has(deck.id)).map(deck => ({ ...deck, cards: deck.cards.filter(card => wanted.get(deck.id).has(card.id)) }));
  const ordered = chosen.size ? planPath(decks, latestOutcomes(state.attempts || []), { scope: decks.map(deck => ({ deckId: deck.id })), now }).entries : [];
  const seen = new Set(), scope = [];
  for (const { deckId, card } of ordered) {
    const key = `${deckId}|${card.id}`;
    if (seen.has(key) || !wanted.get(deckId)?.has(card.id)) continue;
    seen.add(key);
    if (scope.length < PRACTICE_LIMIT) scope.push({ deckId, cardId: card.id });
  }
  return { scope, total: chosen.size, capped: chosen.size > PRACTICE_LIMIT, limit: PRACTICE_LIMIT };
}

const strings = (value, max) => (Array.isArray(value) ? value.filter(item => typeof item === 'string').slice(0, max) : []);

/** A row an anchor of the AI outline stands for, as the page lists it under a leaf: the document or the chapter, named with its material. */
function anchorView(index, layout, key, runs) {
  const row = layout.get(key);
  if (row.kind === 'document') return rowView(index, row, runs, { kind: 'document', title: row.item.title, format: row.item.format, chapters: row.chapters.length });
  const doc = [...layout.values()].find(item => item.kind === 'document' && item.chapters.some(chapter => chapter.key === key));
  const { nodes: _nodes, key: _key, ...chapter } = row;
  return rowView(index, row, runs, { ...chapter, material: doc?.item.title ?? '' });
}

/** Documents of one name under a leaf, as one row: the first one's name, how many there are, their questions once each. */
function copiesView(index, layout, row, runs) {
  const first = layout.get(row.copies[0]).item;
  return rowView(index, row, runs, { kind: 'document', title: first.title, format: first.format, chapters: 0, copies: row.copies.length });
}

/**
 * The AI outline of the course (lib/course-outline-book.js), when there is one: its nodes with the counts, mastery and practice runs of the questions their anchors
 * hold (computed now), 其他 with every row no leaf holds, `stale` when the course's materials changed since it was made. With a deck filter, nodes without a question
 * of that deck are left out. A leaf says how many anchors it has (its rows are read with `expand`) and, when the outline rests on sample papers, its tier.
 */
function bookView(index, record, book, runs, deckId) {
  const outline = record.courseOutline, papers = outline.papers || [];
  const view = entry => {
    const children = entry.children.map(view).filter(Boolean);
    const exam = entry.leaf && papers.length && entry.key !== OTHER_KEY ? { tier: leafTier(entry.node, papers), papers: leafPapers(entry.node, papers) } : {};
    const shown = rowView(index, entry, runs, { id: entry.node.id, depth: entry.depth, title: entry.node.title, ...(entry.node.intro ? { intro: entry.node.intro } : {}),
      ...(entry.leaf ? { anchors: entry.shown.length, opensRows: entry.opensRows } : { children }), ...exam });
    return deckId && !shown.total ? null : shown;
  };
  const other = book.other.anchors.length ? view(book.other) : null;
  return { id: record.id, title: record.title, createdAt: record.createdAt ?? null, supersedes: outline.supersedes ?? null, orderBasis: outline.orderBasis,
    papers: papers.length, counts: outline.counts, stale: outline.fingerprint !== materialsFingerprint(index.allDocuments),
    nodes: book.tree.map(view).filter(Boolean), other };
}

/** `course.outline` (see the top of this file). `root` keys the cache. */
export function courseOutline(state, args = {}, { root = '', now = Date.now() } = {}) {
  const course = args.course === undefined ? currentCourse(state) : args.course;
  if (course !== null && typeof course !== 'string') throw new Error('course.outline: course must be a course name, an empty string (uncategorised) or *');
  const deckId = typeof args.deckId === 'string' && args.deckId ? args.deckId : null;
  if (course === null || course === undefined) {
    return args.pick ? { status: 'empty', course: null, practice: { scope: [], total: 0, capped: false, limit: PRACTICE_LIMIT } }
      : { status: 'empty', course: null, total: 0, placed: 0, summary: summarizeLinked([]), draftCards: 0, limit: PRACTICE_LIMIT, decks: [], deckId, documents: [],
        unplaced: { key: UNPLACED_KEY, total: 0, summary: summarizeLinked([]), reasons: { none: 0, uncategorised: 0, elsewhere: 0, missing: 0 }, materials: [], materialCount: 0 }, book: null, open: {} };
  }
  const index = courseOutlineIndex(state, { course, deckId }, { root, now }), layout = layoutOf(index);
  const record = currentCourseOutline(state.sources, course), book = record ? bookLayout(layout, record.courseOutline) : null;
  const rowOf = key => (key === UNPLACED_KEY ? UNPLACED_KEY : layout.get(key) || book?.rows.get(key));
  if (args.pick) return { status: 'ok', course, practice: practiceOf(state, index, rowOf, { keys: strings(args.pick.keys, 2000), cards: Array.isArray(args.pick.cards) ? args.pick.cards.slice(0, 5000) : [] }, now) };
  const runs = openRuns(state), all = [...index.cards.values()], unplaced = all.filter(entry => entry.reason);
  const open = {};
  for (const key of strings(args.expand, 100)) {
    const row = rowOf(key);
    if (!row) continue;
    // A leaf of the AI outline opens its rows (one row: its questions at once); a chapter or section of it is drawn from the answer's `book`, nothing to read.
    if (row !== UNPLACED_KEY && row.kind === 'book') {
      if (row.leaf) open[key] = row.opensRows ? { anchors: row.shown.map(item => (item.anchors.length > 1 ? copiesView(index, layout, book.rows.get(item.key), runs)
        : anchorView(index, layout, item.key, runs))) } : cardsOf(index, row);
      continue;
    }
    open[key] = row !== UNPLACED_KEY && row.kind === 'document' && row.chapters.length
      ? { chapters: row.chapters.map(({ nodes: _nodes, ...chapter }) => rowView(index, { key: chapter.key, nodes: _nodes }, runs, chapter)) }
      : cardsOf(index, row);
  }
  return { status: 'ok', course, total: all.length, placed: all.length - unplaced.length, summary: summarizeLinked(all), draftCards: index.draftCards, limit: PRACTICE_LIMIT,
    decks: index.decks, deckId,
    documents: index.documents.map(item => rowView(index, layout.get(item.key), runs, { title: item.title, format: item.format, chapters: layout.get(item.key).chapters.length })),
    unplaced: { key: UNPLACED_KEY, total: unplaced.length, summary: summarizeLinked(unplaced),
      reasons: Object.fromEntries(['none', 'uncategorised', 'elsewhere', 'missing'].map(reason => [reason, unplaced.filter(entry => entry.reason === reason).length])),
      // The uncategorised materials its questions cite (at most 20): filing one under the course moves its questions into its row.
      materials: [...index.looseCited.values()].slice(0, 20), materialCount: index.looseCited.size },
    book: record ? bookView(index, record, book, runs, deckId) : null,
    open };
}
