/* 总纲缺口筛选与无题直出 (pure helpers): derives lowest-level weak/due practice keys and empty-row generate eligibility without double-counting parent chapters or mutating saved folds. */
import { UNPLACED, filterOutline, outlineRows } from './model.js';

export const OUTLINE_GAP_FILTERS = Object.freeze(['all', 'weak-due', 'untested']);
const GENERATABLE_KINDS = new Set(['part', 'section', 'point', 'document', 'chapter']);

/** Whether a node has at least one weak or already-learned due card in its summary. */
export const isWeakOrDueNode = node => ((node?.summary?.weak ?? 0) > 0) || ((node?.summary?.due ?? 0) > 0);
/** Whether a node already has unpublished draft questions counted in its summary. */
export const hasDraftCards = node => (node?.summary?.draftCards ?? 0) > 0;
/** Whether a non-pending node has neither published questions nor unpublished drafts yet. */
export const isUntestedNode = node => Boolean(node && !node.pending && (node.total ?? 0) === 0 && !hasDraftCards(node));

/** Whether an outline row may offer a focus-prefilled jump to Create deck (excludes pending placeholders, drafts, Other, and Unplaced). */
export function canGenerateRow(row) {
  return Boolean(row && GENERATABLE_KINDS.has(row.kind) && isUntestedNode(row.node));
}

function recordMatch(key, ancestors, matchKeys, forceOpen) {
  matchKeys.add(key);
  for (const ancestor of ancestors) {
    matchKeys.add(ancestor);
    forceOpen.add(ancestor);
  }
}

/**
 * Summarize actionable gap targets over the whole outline (`weak-due` keys at the lowest available granularity + `untested` leaf/chapter/doc counts)
 * and compute branch closures so filtering reveals matching nodes even when parent chapters were folded.
 */
export function collectOutlineGapStats(outline, details = {}) {
  const weakOrDueKeys = [], weakOrDueSeen = new Set();
  const weakOrDueMatchKeys = new Set(), weakOrDueForceOpen = new Set();
  const untestedMatchKeys = new Set(), untestedForceOpen = new Set();
  let untestedCount = 0;

  if (!outline) {
    return { weakOrDueKeys, weakOrDueCount: 0, untestedCount, weakOrDueMatchKeys, weakOrDueForceOpen, untestedMatchKeys, untestedForceOpen };
  }

  const pushWeakKey = key => {
    if (!key || weakOrDueSeen.has(key)) return;
    weakOrDueSeen.add(key);
    weakOrDueKeys.push(key);
  };

  if (outline.book) {
    const visitBook = (node, ancestors) => {
      if (node.pending) return;
      const children = Array.isArray(node.children) ? node.children : [];
      if (children.length > 0) {
        children.forEach(child => visitBook(child, [...ancestors, node.key]));
        return;
      }
      if (isWeakOrDueNode(node)) {
        pushWeakKey(node.key);
        recordMatch(node.key, ancestors, weakOrDueMatchKeys, weakOrDueForceOpen);
      }
      if (isUntestedNode(node)) {
        untestedCount++;
        recordMatch(node.key, ancestors, untestedMatchKeys, untestedForceOpen);
      }
    };
    (outline.book.nodes || []).forEach(node => visitBook(node, []));
    if (outline.book.other && isWeakOrDueNode(outline.book.other)) {
      pushWeakKey(outline.book.other.key);
      weakOrDueMatchKeys.add(outline.book.other.key);
    }
  } else {
    for (const doc of outline.documents || []) {
      const chapters = details?.[doc.key]?.chapters;
      if (Array.isArray(chapters) && chapters.length > 0) {
        let docChildWeak = false;
        for (const ch of chapters) {
          if (isWeakOrDueNode(ch)) {
            docChildWeak = true;
            pushWeakKey(ch.key);
            recordMatch(ch.key, [doc.key], weakOrDueMatchKeys, weakOrDueForceOpen);
          }
          if (ch.kind !== 'rest' && isUntestedNode(ch)) {
            untestedCount++;
            recordMatch(ch.key, [doc.key], untestedMatchKeys, untestedForceOpen);
          }
        }
        if (!docChildWeak && isWeakOrDueNode(doc)) {
          pushWeakKey(doc.key);
          weakOrDueMatchKeys.add(doc.key);
        }
      } else {
        if (isWeakOrDueNode(doc)) {
          pushWeakKey(doc.key);
          weakOrDueMatchKeys.add(doc.key);
        }
        if (isUntestedNode(doc)) {
          untestedCount++;
          untestedMatchKeys.add(doc.key);
        }
      }
    }
  }

  if (outline.unplaced?.total > 0 && isWeakOrDueNode(outline.unplaced)) {
    pushWeakKey(UNPLACED);
    weakOrDueMatchKeys.add(UNPLACED);
  }

  return {
    weakOrDueKeys,
    weakOrDueCount: weakOrDueKeys.length,
    untestedCount,
    weakOrDueMatchKeys,
    weakOrDueForceOpen,
    untestedMatchKeys,
    untestedForceOpen,
  };
}

/** Drop expanded parent container headings whose descendants were all eliminated when combining text search and gap lens. */
function pruneEmptyContainers(rows, details) {
  const kept = [];
  for (let i = rows.length - 1; i >= 0; i--) {
    const row = rows[i];
    const hasLoadedChapters = row.kind === 'document' && Array.isArray(details?.[row.key]?.chapters) && details[row.key].chapters.length > 0;
    const isExpandedContainer = row.hasChildren && (row.kind === 'part' || row.kind === 'section' || hasLoadedChapters);
    const next = kept.at(-1);
    const hasKeptChild = Boolean(next && next.level > row.level);
    if (isExpandedContainer && !hasKeptChild) continue;
    kept.push(row);
  }
  return kept.reverse();
}

/** Whether a row is matched directly by the gap lens or is an expanded child (anchor/chapter) of a kept leaf or Other node. */
function matchesGapSelection(row, matchKeys, forceOpen) {
  if (matchKeys.has(row.key)) return true;
  return Boolean(row.ancestors?.some(anc => matchKeys.has(anc) && !forceOpen.has(anc)));
}

/**
 * Filter outline rows by optional gap lens (`all` | `weak-due` | `untested`) composed cleanly with text search `query`,
 * using temporary expansion without mutating persisted `open` fold state.
 */
export function filterOutlineWithLens(outline, details, open, query, lens = 'all', stats = null) {
  const activeLens = OUTLINE_GAP_FILTERS.includes(lens) ? lens : 'all';
  if (activeLens === 'all') return filterOutline(outline, details, open, query);
  if (!outline) return { rows: [], filtering: true, matchCount: 0 };

  const computed = stats || collectOutlineGapStats(outline, details);
  const matchKeys = activeLens === 'weak-due' ? computed.weakOrDueMatchKeys : computed.untestedMatchKeys;
  const forceOpen = activeLens === 'weak-due' ? computed.weakOrDueForceOpen : computed.untestedForceOpen;
  const effectiveOpen = new Set([...(open || []), ...forceOpen]);
  const needle = String(query ?? '').trim();

  if (!needle) {
    const rows = outlineRows(outline, details, effectiveOpen).filter(row => matchesGapSelection(row, matchKeys, forceOpen));
    return { rows, filtering: false, matchCount: rows.length };
  }

  const textResult = filterOutline(outline, details, effectiveOpen, query);
  const rows = pruneEmptyContainers(textResult.rows.filter(row => matchesGapSelection(row, matchKeys, forceOpen)), details);
  return { rows, filtering: true, matchCount: rows.length };
}
