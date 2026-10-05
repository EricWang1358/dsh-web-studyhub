/* 覆盖 under the reader's outline: which section of lib/coverage.js each outline entry is, what every entry (and everything below it) has, and what a range of the
   outline holds. Pure, no DOM. The outline's entries come from three places, so an entry finds its section three ways, first match wins:
     by id         a transcript's entries ARE the sections of lib/sections.js (id "r2.p3"), so the entry and its coverage share the id;
     by page       a PDF page / slide: the entry's page number, in the source its reading section says;
     by title      the headings of rendered Markdown and of a kept outline carry no section id: they are matched, in order, to the titled sections of the source.
   An entry that is not matched (a label, a heading the sections do not know) simply has no mark; the counts of the header come from the coverage itself, not from the entries. */

const norm = (text) => String(text ?? '').normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();

/**
 * Map<entryId, section> for the entries of `outline` (structureOutline's entries) that are a leaf section of `coverage`.
 * `sourceId` is the source the reader shows; `sections` the reader's own sections ({ id, sourceId }) for a document whose pages are sources.
 */
export function alignEntries(outline, coverage, { sourceId, sections = [] } = {}) {
  const leaves = Array.isArray(coverage?.sections) ? coverage.sections : [], found = new Map();
  if (!leaves.length || !outline?.length) return found;
  const bySourceOfEntry = new Map(sections.filter(section => section?.sourceId).map(section => [section.id, section.sourceId]));
  const byKey = new Map(leaves.map(section => [`${section.sourceId}|${section.id}`, section])), used = new Set();
  const titled = leaves.filter(section => section.title && (!sourceId || section.sourceId === sourceId));
  let pointer = 0;
  for (const entry of outline) {
    const source = bySourceOfEntry.get(entry.id) ?? sourceId;
    let hit = source ? byKey.get(`${source}|${entry.id}`) : undefined;
    if (!hit && Number.isInteger(entry.page)) hit = leaves.find(section => section.page === entry.page && (!source || section.sourceId === source));
    if (!hit && entry.title && !entry.minor) {
      const wanted = norm(entry.title);
      for (let at = pointer; at < titled.length; at += 1) if (norm(titled[at].title) === wanted) { hit = titled[at]; pointer = at + 1; break; }
    }
    if (hit && !used.has(hit.key)) { used.add(hit.key); found.set(entry.id, hit); }
  }
  return found;
}

/**
 * The coverage of every entry: Map<entryId, { own, leaves, covered, plannedFailed, neverPlanned }>, with `own` the entry's own section (a leaf) or null (a recording, a chapter: its numbers
 * are those of the sections below it). `uncovered` are the entries to keep when only what has no question is shown: the leaves without one and every entry above them.
 */
export function outlineCoverage(outline, coverage, options = {}) {
  const aligned = alignEntries(outline, coverage, options), parents = new Map((outline || []).map(entry => [entry.id, entry.parent ?? null])), entries = new Map(), keep = new Set();
  const at = id => { if (!entries.has(id)) entries.set(id, { own: null, leaves: 0, covered: 0, plannedFailed: 0, neverPlanned: 0 }); return entries.get(id); };
  for (const [id, section] of aligned) {
    at(id).own = section;
    for (let up = id; up !== null && up !== undefined && parents.has(up); up = parents.get(up)) {
      const entry = at(up);
      entry.leaves += 1;
      if (section.state === 'covered') entry.covered += 1; else if (section.state === 'planned-failed') entry.plannedFailed += 1; else entry.neverPlanned += 1;
      if (section.state !== 'covered') keep.add(up);
    }
  }
  return { entries, uncovered: keep, aligned };
}

/** What the entries `ids` (a range of the outline: this page, this chapter, what was just read) hold: { leaves, covered, uncovered } by their own sections, each counted once. `ids: null` is the whole document. */
export function rangeCoverageOf(result, ids, coverage) {
  if (!ids) return { leaves: coverage?.leaves || 0, covered: coverage?.covered || 0, uncovered: (coverage?.leaves || 0) - (coverage?.covered || 0) };
  const seen = new Set();
  let leaves = 0, covered = 0;
  for (const id of ids) {
    const own = result.entries.get(id)?.own;
    if (!own || seen.has(own.key)) continue;
    seen.add(own.key); leaves += 1;
    if (own.state === 'covered') covered += 1;
  }
  return { leaves, covered, uncovered: leaves - covered };
}
