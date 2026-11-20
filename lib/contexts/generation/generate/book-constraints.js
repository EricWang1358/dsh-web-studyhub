import { currentCourseNotes } from '../../../course-book.js';
import { leavesOf, withCardNumbers } from '../../../course-book-card-numbers.js';
import { confusablesView } from '../../../course-book-confusables.js';
import { kitCode } from '../../../course-book-exam-kit.js';
import { currentInventory } from '../../../course-book-inventory.js';
import { currentCourseOutline } from '../../../course-outline-book.js';
import { groupSourcesByDocument } from '../../../source-groups.js';
import { formatNotationFence, resolveCourseNotationLedger } from '../inventory/notation-ledger.js';

/* Read-only T01 (exam-kit templates) & C001 (confusable pairs) generation constraints + merged
   Course Notation Ledger for question generation (StudyHub 5.0.0 Evolution 2 #3 & #6).
   0-token, pure. Review book prose is NEVER added as a citable source; raw source boundaries stay intact. */

const MAX_CONFUSABLES = 6;
const MAX_TEMPLATES = 4;
const KEEP_ASPECTS = new Set(['what', 'difference', 'mistake']);

const clip = (value, max) => {
  const text = typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}...` : text;
};

function flatOutlineLeaves(nodes) {
  const out = [];
  const walk = list => {
    for (const node of Array.isArray(list) ? list : []) {
      if (Array.isArray(node?.children) && node.children.length) walk(node.children);
      else if (node?.id) out.push(node);
    }
  };
  walk(nodes);
  return out;
}

function targetDocKeysOf(state, sourceIds) {
  const keys = new Set();
  if (!sourceIds.size) return keys;
  for (const doc of groupSourcesByDocument(state?.sources || [])) {
    if ((doc.sourceIds || []).some(id => sourceIds.has(id))) keys.add(doc.key);
  }
  return keys;
}

function matchedLeavesAndItems(state, { notes, outline, inventory, sourceIds }) {
  const docKeys = targetDocKeysOf(state, sourceIds);
  const itemIds = new Set();
  for (const item of inventory?.items || []) {
    if ((item?.places || []).some(place => sourceIds.has(place?.sourceId) || docKeys.has(place?.doc))) {
      itemIds.add(item.id);
    }
  }
  const leafIds = new Set();
  const anchorHits = anchor => typeof anchor === 'string' && (docKeys.has(anchor) || docKeys.has(anchor.split('#')[0]));
  for (const leaf of flatOutlineLeaves(outline?.nodes)) {
    if ((leaf.anchors || []).some(anchorHits) || (leaf.items || []).some(id => itemIds.has(id))) {
      leafIds.add(leaf.id);
    }
  }
  for (const leaf of notes?.leaves || []) {
    if (!leaf?.id) continue;
    const hitAnchor = (leaf.anchors || []).some(anchorHits);
    const hitCite = (leaf.body?.cites || []).some(c => sourceIds.has(c?.sourceId));
    const hitUnit = (leaf.body?.units || []).some(u =>
      (u?.read || []).some(r => sourceIds.has(r?.sourceId))
      || (u?.cites || []).some(c => sourceIds.has(c?.sourceId))
      || (u?.covered || []).some(id => itemIds.has(id)));
    if (hitAnchor || hitCite || hitUnit) leafIds.add(leaf.id);
  }
  return { leafIds, itemIds };
}

function extractConfusables({ notes, outline, leafIds, itemIds }) {
  if (!Array.isArray(notes?.confusables) || !notes.confusables.length) return [];
  const rawTree = Array.isArray(outline?.nodes)
    ? outline.nodes
    : (notes.leaves || []).map(leaf => ({
      hid: leaf.id,
      id: leaf.id,
      leaf: true,
      title: leaf.title,
      cards: (leaf.body?.units || []).flatMap(unit => unit.cards || []),
    }));
  const noteCardsByLeaf = new Map((notes.leaves || []).map(leaf => [
    leaf.id,
    (leaf.body?.units || []).flatMap(unit => unit.cards || []),
  ]));
  const hydrate = list => (Array.isArray(list) ? list : []).map(node => {
    if (Array.isArray(node?.children) && node.children.length) return { ...node, children: hydrate(node.children) };
    const cards = Array.isArray(node?.cards) && node.cards.length ? node.cards : (noteCardsByLeaf.get(node.id) || []);
    return { ...node, hid: node.hid || node.id, leaf: true, cards };
  });
  const numbered = withCardNumbers(hydrate(rawTree));
  const byCode = new Map();
  for (const leaf of leavesOf(numbered)) {
    const lid = leaf.id || leaf.hid;
    for (const card of leaf.cards || []) byCode.set(card.code, { leafId: lid, itemId: card.item });
  }
  const all = confusablesView(notes.confusables, numbered);
  const picked = [];
  for (const pair of all) {
    const hits = pair.items.some(code => {
      const ref = byCode.get(code);
      return ref && (leafIds.has(ref.leafId) || itemIds.has(ref.itemId));
    });
    if (!hits) continue;
    const entry = { code: pair.id, names: pair.names };
    for (const row of pair.rows || []) {
      if (KEEP_ASPECTS.has(row.aspect)) entry[row.aspect] = (row.cells || []).map(cell => clip(cell, 180));
    }
    picked.push(entry);
    if (picked.length >= MAX_CONFUSABLES) break;
  }
  return picked;
}

function extractTemplates({ notes, leafIds, kind }) {
  const types = Array.isArray(notes?.examKit?.types) ? notes.examKit.types : [];
  if (!types.length) return [];
  const matched = [];
  for (let i = 0; i < types.length; i++) {
    const type = types[i];
    if ((type.leaves || []).some(id => leafIds.has(id))) matched.push({ type, index: i });
  }
  const chosen = matched.length ? matched : (kind === 'case' ? types.slice(0, MAX_TEMPLATES).map((type, index) => ({ type, index })) : []);
  return chosen.slice(0, MAX_TEMPLATES).map(({ type, index }) => ({
    code: kitCode(index),
    name: clip(type.name, 80),
    family: type.family || 'other',
    signals: (type.signals || []).slice(0, 6).map(sig => clip(sig, 60)),
    asks: clip(type.asks, 220),
    template: clip(type.template, 360),
  }));
}

/** Look up read-only C001 confusable traps and T01 exam-kit templates linked to target `sources`. */
export function bookConstraintsForSources(state, { course, sources = [], kind = 'quiz' } = {}) {
  if (!state || typeof course !== 'string' || !course.trim() || course === '*') return null;
  const notesSrc = currentCourseNotes(state.sources, course);
  const notes = notesSrc?.courseNotes;
  if (!notes) return null;
  const outline = currentCourseOutline(state.sources, course)?.courseOutline || null;
  const inventory = currentInventory(state.sources, course)?.courseInventory || null;
  const sourceIds = new Set((Array.isArray(sources) ? sources : []).map(src => src?.id).filter(Boolean));
  const { leafIds, itemIds } = matchedLeavesAndItems(state, { notes, outline, inventory, sourceIds });
  const confusables = leafIds.size || itemIds.size ? extractConfusables({ notes, outline, leafIds, itemIds }) : [];
  const templates = extractTemplates({ notes, leafIds, kind });
  if (!confusables.length && !templates.length) return null;
  return {
    ...(confusables.length ? { confusables } : {}),
    ...(templates.length ? { templates } : {}),
  };
}

/** Resolve transient read-only notation ledger + T01/C001 constraints for one generation run. */
export function courseGenerationContext(state, { course, sources = [], kind = 'quiz' } = {}) {
  const notationLedger = formatNotationFence(resolveCourseNotationLedger(state, course, { max: 24 }), { max: 24 });
  const bookConstraints = bookConstraintsForSources(state, { course, sources, kind });
  return {
    ...(notationLedger.length ? { notationLedger } : {}),
    ...(bookConstraints ? { bookConstraints } : {}),
  };
}
