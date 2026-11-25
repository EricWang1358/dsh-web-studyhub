/* 总纲 page: the pure part. The rows on screen (documents, the chapters of the open ones, 未归位; or the AI outline's chapters, sections and points), what a
   key does on them, what is picked, and the view the learner left (open rows, the deck filter), kept for the way back from a practice round. No React, no ui(). */
import { contractOf, isRunningTask } from '../tasks/task-model.js';
import { browserStorage, readJSON, writeJSON } from '../storage.js';
import { silentPaper, suggestRoles } from '../../lib/exam-prep-roles.js';

export const UNPLACED = 'unplaced';
/** The task kind of a 总纲 build (lib/contexts/generation/outline), as the console lists it. */
export const OUTLINE_BUILD_KIND = 'course-outline-build';
/** The task kind of a 复习全书 build (lib/contexts/generation/book): it may organise the outline first. */
export const BOOK_BUILD_KIND = 'course-book-build';

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
  // `silent`: the build uses it without asking (a paper-like marker in the name, the build's own rule); `likely` only puts it first.
  return list.map((item, at) => ({ key: item.key, title: item.title, likely: roles[at]?.role === 'past-paper', silent: roles[at]?.role === 'past-paper' && silentPaper(item) }))
    .sort((a, b) => Number(b.likely) - Number(a.likely));
}

/** The keys open when an outline is first shown: its chapters (章 open, 节 closed). */
export const bookDefaultOpen = book => (book?.nodes || []).map(node => node.key);

/** The running 总纲 build of a course (or, with `kind`, its 复习全书 build), from the snapshot's jobs: { jobId, done, total } or null. */
export function runningBuild(jobs, course, kind = OUTLINE_BUILD_KIND) {
  for (const job of Array.isArray(jobs) ? jobs : []) {
    const contract = contractOf(job);
    if (contract.kind !== kind || contract.detail?.course !== course || !isRunningTask(job)) continue;
    return { jobId: contract.jobId, status: contract.status, done: contract.progress?.done ?? 0, total: contract.progress?.total ?? 0 };
  }
  return null;
}

/**
 * The one main action of the 总纲 page's line: 'outline' (生成总纲, no outline yet), 'book' (生成复习全书: an outline without notes), 'sample' (the book's sample
 * waits for the learner: 生成其余, ui/book/BookSample.jsx) or 'update' (更新全书: notes that are out of date); null when the notes are current (更新全书 stays, quiet).
 */
export function mainAction(book) {
  if (!book) return 'outline';
  if (!book.notes) return 'book';
  if (book.notes.sample) return 'sample';
  return book.notes.stale ? 'update' : null;
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

const matchesOutlineNeedle = (text, needle) => Boolean(text && String(text).toLowerCase().includes(needle));
const cardsMatchNeedle = (detail, needle) => (detail?.cards || []).some(card => matchesOutlineNeedle(card.prompt, needle) || matchesOutlineNeedle(card.deckTitle, needle));

/** Filter the outline rows by search query while keeping matching chapters, sections, points, documents and their ancestor rows visible without mutating saved fold state. */
export function filterOutline(outline, details, open, query) {
  const needle = String(query ?? '').trim().toLowerCase();
  if (!needle) return { rows: outlineRows(outline, details, open), filtering: false, matchCount: 0 };
  if (!outline) return { rows: [], filtering: true, matchCount: 0 };
  if (outline.book) {
    const matchedKeys = new Set(), selfHitKeys = new Set(), forceOpen = new Set();
    const visit = (node, ancestors) => {
      const selfHit = matchesOutlineNeedle(node.title, needle)
        || matchesOutlineNeedle(node.intro, needle)
        || cardsMatchNeedle(details[node.key], needle)
        || (details[node.key]?.anchors || []).some(anchor => matchesOutlineNeedle(anchor.title, needle)
          || cardsMatchNeedle(details[anchor.key], needle)
          || (details[anchor.key]?.chapters || []).some(ch => matchesOutlineNeedle(ch.title, needle) || cardsMatchNeedle(details[ch.key], needle)));
      let childHit = false;
      for (const child of node.children || []) {
        if (visit(child, [...ancestors, node.key])) childHit = true;
      }
      if (selfHit || childHit) {
        matchedKeys.add(node.key);
        if (selfHit) selfHitKeys.add(node.key);
        for (const anc of ancestors) { matchedKeys.add(anc); forceOpen.add(anc); }
        if (childHit || (selfHit && node.children?.length)) forceOpen.add(node.key);
      }
      return selfHit || childHit;
    };
    (outline.book.nodes || []).forEach(node => visit(node, []));
    if (outline.book.other) {
      const otherKey = outline.book.other.key;
      const otherHit = matchesOutlineNeedle(outline.book.other.title, needle) || cardsMatchNeedle(details[otherKey], needle)
        || (details[otherKey]?.anchors || []).some(anchor => matchesOutlineNeedle(anchor.title, needle));
      if (otherHit) { matchedKeys.add(otherKey); selfHitKeys.add(otherKey); }
    }
    if (outline.unplaced?.total > 0 && (matchesOutlineNeedle('未归位 not placed', needle) || cardsMatchNeedle(details[UNPLACED], needle))) {
      matchedKeys.add(UNPLACED);
      selfHitKeys.add(UNPLACED);
    }
    const effectiveOpen = new Set([...open, ...forceOpen]);
    const allOpenRows = bookRows(outline, details, effectiveOpen);
    const rows = allOpenRows.filter(row => matchedKeys.has(row.key) || row.ancestors?.some(anc => selfHitKeys.has(anc)));
    return { rows, filtering: true, matchCount: rows.length };
  }
  const matchedKeys = new Set(), forceOpen = new Set();
  for (const doc of outline.documents || []) {
    const docHit = matchesOutlineNeedle(doc.title, needle) || cardsMatchNeedle(details[doc.key], needle);
    const chapters = details[doc.key]?.chapters || [];
    let chHit = false;
    for (const ch of chapters) {
      if (matchesOutlineNeedle(ch.title, needle) || cardsMatchNeedle(details[ch.key], needle)) {
        matchedKeys.add(ch.key);
        chHit = true;
      }
    }
    if (docHit || chHit) {
      matchedKeys.add(doc.key);
      if (chHit || (docHit && chapters.length)) forceOpen.add(doc.key);
      if (docHit) for (const ch of chapters) matchedKeys.add(ch.key);
    }
  }
  if (outline.unplaced?.total > 0 && (matchesOutlineNeedle('未归位 not placed', needle) || cardsMatchNeedle(details[UNPLACED], needle))) {
    matchedKeys.add(UNPLACED);
  }
  const effectiveOpen = new Set([...open, ...forceOpen]);
  const rows = outlineRows(outline, details, effectiveOpen).filter(row => matchedKeys.has(row.key));
  return { rows, filtering: true, matchCount: rows.length };
}

/* The view the learner left, per library and course: the open rows and the deck filter, persisted in localStorage (`study-outline-view:${root}:${course}`)
   with an in-memory mirror so both reload restoration and headless tests work identically. */
const kept = new Map();
const MAX_STORED_OPEN = 500;
export const outlineViewKey = (root, course) => `study-outline-view:${root ?? ''}:${course ?? ''}`;

function normalizeStoredView(raw) {
  if (!raw || typeof raw !== 'object' || !Array.isArray(raw.open)) return null;
  const open = raw.open.filter(item => typeof item === 'string').slice(0, MAX_STORED_OPEN);
  return {
    open,
    deckId: typeof raw.deckId === 'string' ? raw.deckId : '',
    ...(typeof raw.bookId === 'string' && raw.bookId ? { bookId: raw.bookId } : {}),
  };
}

export function keptView(root, course, storage) {
  const explicitStorage = arguments.length >= 3;
  const memKey = JSON.stringify([root, course]);
  if (!explicitStorage && kept.has(memKey)) return kept.get(memKey);
  const stored = normalizeStoredView(readJSON(outlineViewKey(root, course), null, explicitStorage ? storage : browserStorage()));
  if (stored && !explicitStorage) kept.set(memKey, stored);
  return stored;
}

export function keepView(root, course, view, storage) {
  const explicitStorage = arguments.length >= 4;
  const openList = [...(view?.open || [])].filter(item => typeof item === 'string').slice(0, MAX_STORED_OPEN);
  const payload = {
    open: openList,
    deckId: view?.deckId || '',
    ...(view?.bookId ? { bookId: view.bookId } : {}),
  };
  const memKey = JSON.stringify([root, course]);
  if (!explicitStorage) {
    kept.set(memKey, payload);
    if (kept.size > 20) kept.delete(kept.keys().next().value);
  }
  writeJSON(outlineViewKey(root, course), payload, explicitStorage ? storage : browserStorage());
}

/* One-shot target for opening 总纲 at a specific document or chapter (e.g. from 题目页「出处」), kept in memory only and never written to localStorage. */
const outlineTargets = new Map();
/** Maximum age of an unused one-shot outline target before it expires on read (ms). */
export const OUTLINE_TARGET_TTL_MS = 15000;

/** Resolve the initial or switched deck filter: arriving with a one-shot target shows all decks instead of a stale deck filter. */
export const resolveOutlineDeckFilter = (kept, target) => (target ? '' : kept?.deckId || '');

function pathToBookKey(nodes, key) {
  for (const node of Array.isArray(nodes) ? nodes : []) {
    if (node.key === key) return [node.key];
    if (node.children?.length) {
      const childPath = pathToBookKey(node.children, key);
      if (childPath.length) return [node.key, ...childPath];
    }
  }
  return [];
}

/** Expand keys needed to reveal `targetInfo` (`target`, optional `leafKey`) inside `outline` (either document tree or AI outline tree). */
export function outlineTargetExpandKeys(targetInfo, book = null) {
  const target = targetInfo?.target;
  if (typeof target !== 'string' || !target) return [];
  const hashAt = target.indexOf('#');
  const docKey = hashAt > 0 ? target.slice(0, hashAt) : null;
  const bookPath = book?.nodes && targetInfo?.leafKey ? pathToBookKey(book.nodes, targetInfo.leafKey) : [];
  return [...new Set([...(bookPath || []), ...(docKey ? [docKey] : []), target])];
}

export function keepOutline(root, course, { target = null, leafKey = null } = {}, now = Date.now()) {
  const memKey = JSON.stringify([root ?? '', course ?? '']);
  if (!target) {
    outlineTargets.delete(memKey);
    return;
  }
  outlineTargets.set(memKey, { target, ...(leafKey ? { leafKey } : {}), at: now });
  if (outlineTargets.size > 20) outlineTargets.delete(outlineTargets.keys().next().value);
}

export function keptOutlineTarget(root, course, now = Date.now()) {
  const memKey = JSON.stringify([root ?? '', course ?? '']);
  const entry = outlineTargets.get(memKey);
  if (!entry) return null;
  if (!Number.isFinite(entry.at) || now - entry.at > OUTLINE_TARGET_TTL_MS) {
    outlineTargets.delete(memKey);
    return null;
  }
  return { target: entry.target, ...(entry.leafKey ? { leafKey: entry.leafKey } : {}) };
}

export function clearOutlineTarget(root, course) {
  outlineTargets.delete(JSON.stringify([root ?? '', course ?? '']));
}
