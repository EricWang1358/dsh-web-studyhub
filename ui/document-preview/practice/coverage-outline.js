/* 覆盖 under the reader's outline: which section of lib/coverage.js each outline entry is, what every entry (and everything below it) has, and what a range of the
   outline holds. Pure, no DOM. The outline's entries come from three places, so an entry finds its section three ways, first match wins:
     by id         a transcript's entries ARE the sections of lib/sections.js (id "r2.p3"), so the entry and its coverage share the id;
     by page       a PDF page / slide: the entry's page number, in the source its reading section says;
     by title      the headings of rendered Markdown and of a kept outline carry no section id: they are matched, in order, to the titled sections of the source.
   An entry that is not matched (a label, a heading the sections do not know) simply has no mark; the counts of the header come from the coverage itself, not from the entries. */

import { lastAtOrBefore } from './practice-range.js';

const norm = (text) => String(text ?? '').normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();

/**
 * Map<entryId, section[]> for the entries of `outline` (structureOutline's entries) aligned to leaf sections of `coverage`.
 * Supports 1:1 transcript/page/heading alignment, segmented multi-page AI chapters (`continued: true` slices), and unsegmented
 * paged documents with an AI outline (pages placed under their AI entry in reading order).
 */
export function alignEntrySections(outline, coverage, { sourceId, sections = [] } = {}) {
  const leaves = Array.isArray(coverage?.sections) ? coverage.sections : [], found = new Map();
  if (!leaves.length || !outline?.length) return found;
  const add = (entryId, section) => {
    if (!found.has(entryId)) found.set(entryId, []);
    found.get(entryId).push(section);
  };
  const used = new Set();

  // 1. Segmented AI outline chapters across pages (`lib/sections.js outlineSections`): group slices by chapter index
  //    so multi-page chapters (with `continued: true` slices) aggregate every page slice under the matching outline entry.
  const chapterLeaves = leaves.filter(section => section.kind === 'chapter' && Number.isInteger(section.chapter));
  const hasAnchoredOutline = outline.some(entry => Boolean(entry.sourceId));
  if (chapterLeaves.length && hasAnchoredOutline) {
    const byChapter = new Map();
    for (const leaf of chapterLeaves) {
      if (!byChapter.has(leaf.chapter)) byChapter.set(leaf.chapter, []);
      byChapter.get(leaf.chapter).push(leaf);
    }
    const usedEntries = new Set();
    let pointer = 0;
    for (const chapterIndex of [...byChapter.keys()].sort((a, b) => a - b)) {
      const group = byChapter.get(chapterIndex);
      const starter = group.find(item => !item.continued) || group[0];
      const wantedTitle = norm(starter.title);
      let match = outline.find(entry => !usedEntries.has(entry.id) && entry.sourceId === starter.sourceId && wantedTitle && norm(entry.title) === wantedTitle);
      if (!match && wantedTitle) {
        for (let at = pointer; at < outline.length; at += 1) {
          const entry = outline[at];
          if (!usedEntries.has(entry.id) && norm(entry.title) === wantedTitle) { match = entry; pointer = at + 1; break; }
        }
      }
      if (!match) match = outline.find(entry => !usedEntries.has(entry.id) && entry.sourceId === starter.sourceId);
      if (!match) continue;
      usedEntries.add(match.id);
      for (const slice of group) {
        if (used.has(slice.key)) continue;
        used.add(slice.key);
        add(match.id, slice);
      }
    }
    if (found.size) return found;
  }

  // 2. Standard 1:1 matching: by id (transcripts), by page (page/chapter outline), or by title (Markdown / single-source headings).
  const bySourceOfEntry = new Map(sections.filter(section => section?.sourceId).map(section => [section.id, section.sourceId]));
  const byKey = new Map(leaves.map(section => [`${section.sourceId}|${section.id}`, section]));
  const titled = leaves.filter(section => section.title && (!sourceId || section.sourceId === sourceId));
  let pointer = 0;
  for (const entry of outline) {
    const source = bySourceOfEntry.get(entry.id) ?? entry.sourceId ?? sourceId;
    let hit = source ? byKey.get(`${source}|${entry.id}`) : undefined;
    if (!hit && Number.isInteger(entry.page)) hit = leaves.find(section => section.page === entry.page && (!source || section.sourceId === source));
    if (!hit && entry.title && !entry.minor) {
      const wanted = norm(entry.title);
      for (let at = pointer; at < titled.length; at += 1) if (norm(titled[at].title) === wanted) { hit = titled[at]; pointer = at + 1; break; }
    }
    if (hit && !used.has(hit.key)) { used.add(hit.key); add(entry.id, hit); }
  }

  // 3. Unsegmented paged document with an AI outline: place each page leaf under the last anchored outline entry at or before it.
  if (!found.size && hasAnchoredOutline && sections.length) {
    const order = new Map();
    sections.forEach((section, index) => { if (section?.sourceId && !order.has(section.sourceId)) order.set(section.sourceId, index); });
    const anchors = outline.filter(entry => entry.sourceId && order.has(entry.sourceId)).map(entry => ({ id: entry.id, at: order.get(entry.sourceId) }));
    if (anchors.length) {
      for (const leaf of leaves) {
        if (!leaf?.sourceId || !order.has(leaf.sourceId) || used.has(leaf.key)) continue;
        const at = order.get(leaf.sourceId);
        const idx = lastAtOrBefore(anchors.length, index => anchors[index].at <= at);
        const entryId = anchors[idx < 0 ? 0 : idx].id;
        used.add(leaf.key);
        add(entryId, leaf);
      }
    }
  }
  return found;
}

/**
 * Map<entryId, section> for the entries of `outline` (structureOutline's entries) that are a leaf section of `coverage`.
 * `sourceId` is the source the reader shows; `sections` the reader's own sections ({ id, sourceId }) for a document whose pages are sources.
 */
export function alignEntries(outline, coverage, options = {}) {
  const grouped = alignEntrySections(outline, coverage, options);
  return new Map([...grouped].map(([id, list]) => [id, list[0]]));
}

/**
 * The coverage of every entry: Map<entryId, { own, ownLeaves, leaves, covered, plannedFailed, neverPlanned }>, with `own` the entry's single own section or null
 * (a recording, a chapter, or a multi-page AI entry: its numbers are those of its sections and the sections below it). `uncovered` are the entries to keep when only what has no question is shown: the leaves without one and every entry above them.
 */
export function outlineCoverage(outline, coverage, options = {}) {
  const grouped = alignEntrySections(outline, coverage, options);
  const aligned = new Map([...grouped].map(([id, list]) => [id, list[0]]));
  const parents = new Map((outline || []).map(entry => [entry.id, entry.parent ?? null])), entries = new Map(), keep = new Set();
  const at = id => { if (!entries.has(id)) entries.set(id, { own: null, ownLeaves: [], leaves: 0, covered: 0, plannedFailed: 0, neverPlanned: 0 }); return entries.get(id); };
  for (const [id, sectionList] of grouped) {
    const target = at(id);
    target.ownLeaves.push(...sectionList);
    for (const section of sectionList) {
      for (let up = id; up !== null && up !== undefined && parents.has(up); up = parents.get(up)) {
        const entry = at(up);
        entry.leaves += 1;
        if (section.state === 'covered') entry.covered += 1; else if (section.state === 'planned-failed') entry.plannedFailed += 1; else entry.neverPlanned += 1;
        if (section.state !== 'covered') keep.add(up);
      }
    }
  }
  for (const entry of entries.values()) {
    entry.own = entry.ownLeaves.length === 1 && entry.leaves === 1 ? entry.ownLeaves[0] : null;
  }
  return { entries, uncovered: keep, aligned };
}

/** What the entries `ids` (a range of the outline: this page, this chapter, what was just read) hold: { leaves, covered, uncovered } by their own sections, each counted once. `ids: null` is the whole document. */
export function rangeCoverageOf(result, ids, coverage) {
  if (!ids) return { leaves: coverage?.leaves || 0, covered: coverage?.covered || 0, uncovered: (coverage?.leaves || 0) - (coverage?.covered || 0) };
  const seen = new Set();
  let leaves = 0, covered = 0;
  for (const id of ids) {
    const entry = result.entries.get(id);
    const list = entry?.ownLeaves?.length ? entry.ownLeaves : (entry?.own ? [entry.own] : []);
    for (const own of list) {
      if (!own || seen.has(own.key)) continue;
      seen.add(own.key); leaves += 1;
      if (own.state === 'covered') covered += 1;
    }
  }
  return { leaves, covered, uncovered: leaves - covered };
}
