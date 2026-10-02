/* The reader's outline (目录): where its entries come from, which one is current
   for a scroll position, the neighbours for the previous / next links, and how
   far the reader has read. Entries are { id, level, title, page? }; an element in the
   reading column carries the matching data-outline-id. A page's label ("第 3 页") is
   made when it is drawn, so it follows the interface language. */

/** Entries for the reading sections of text sources; none when there is nothing to navigate. */
export function outlineFromSections(sections) {
  if (sections.length < 2) return [];
  return sections.map(section => ({ id: section.id, level: 1,
    title: section.kind === 'page' ? section.heading : section.title, ...(section.page ? { page: section.page } : {}) }))
    .filter(entry => entry.page || entry.title);
}

const levelOf = node => Number(node.tagName[1]);

/**
 * Entries for the headings (h1–h4) of rendered Markdown or HTML; tags each heading with
 * data-outline-id. Levels are relative to the shallowest heading, so a document that
 * starts at h2 still lists its top headings at level 1.
 */
export function collectHeadings(root, { max = 400 } = {}) {
  if (!root) return [];
  const nodes = [...root.querySelectorAll('h1,h2,h3,h4')].filter(node => !node.closest('[data-study-marker]') && node.textContent.trim());
  const base = nodes.length ? Math.min(...nodes.map(levelOf)) : 1;
  return nodes.slice(0, max).map((node, index) => {
    const id = `h-${index}`;
    node.dataset.outlineId = id;
    return { id, level: levelOf(node) - base + 1, title: node.textContent.trim().replace(/\s+/g, ' ') };
  });
}

/**
 * The current entry: the last one whose top edge has reached `threshold` pixels below the
 * top of the reading area; before the first heading, the first entry.
 * entries: [{ id, top }] in document order.
 */
export function pickActive(entries, threshold = 24) {
  let active = entries[0]?.id ?? null;
  for (const entry of entries) {
    if (entry.top <= threshold) active = entry.id;
    else break;
  }
  return active;
}

export function neighbours(items, id) {
  const index = items.findIndex(item => item.id === id);
  return { previous: index > 0 ? items[index - 1] : null, next: index >= 0 && index < items.length - 1 ? items[index + 1] : null };
}

/* ---------- the outline as a tree ---------- */

/* A heading that repeats under many parents is a label, not a section: 英文原句 / 中文对照 under every part of a bilingual
   transcript, Original / Translation, Question / Answer, "Question 1" … It nests under its part, folded, instead of
   crowding the top level. It takes a repeat under at least three different parents, a short title and no sub-headings. */
const LABEL_MIN_PARENTS = 3, LABEL_MAX_CHARS = 24, OPEN_LIMIT = 60;

/** A heading's identity as a label: case, width, a leading number ("2.1 ") and a trailing one ("Question 3") dropped. */
const labelKey = title => String(title || '').normalize('NFKC').toLowerCase().replace(/^\s*(?:\d+(?:\.\d+)*[.)、．]?|[(（]\d+[)）])\s*/, '')
  .replace(/[\s.:：\-–—]*\d+(?:\.\d+)*\s*$/, '').replace(/\s+/g, ' ').trim();

/**
 * The entries with their place in the tree: `parent` (the nearest entry above with a lower heading level, else null),
 * `depth` (how many parents it has; a level that skips still nests), `children` (direct), and `minor`
 * (a repeated generic label) with `minorCount` on its parent. Order and ids are untouched. `fold: false` marks no labels
 * (a kept AI outline is the learner's own choice).
 */
export function structureOutline(items, { fold = true } = {}) {
  const stack = [], tree = items.map(entry => {
    while (stack.length && stack.at(-1).level >= entry.level) stack.pop();
    const parent = stack.at(-1) || null, node = { ...entry, parent: parent?.id ?? null, depth: stack.length, children: 0, minorCount: 0, minor: false };
    if (parent) parent.children += 1;
    stack.push(node);
    return node;
  });
  const parents = new Map();
  if (!fold) return tree; // an outline the learner chose has no labels to fold
  for (const node of tree) {
    const key = labelKey(node.title);
    if (!node.parent || !key || node.children || node.title.length > LABEL_MAX_CHARS) continue;
    if (!parents.has(key)) parents.set(key, new Set());
    parents.get(key).add(node.parent);
  }
  const byId = new Map(tree.map(node => [node.id, node]));
  for (const node of tree) {
    if (!node.parent || node.children || node.title.length > LABEL_MAX_CHARS || !(parents.get(labelKey(node.title))?.size >= LABEL_MIN_PARENTS)) continue;
    node.minor = true;
    byId.get(node.parent).minorCount += 1;
  }
  return tree;
}

const ancestorsOf = (tree, id) => {
  const byId = new Map(tree.map(node => [node.id, node])), path = [];
  for (let node = byId.get(id); node; node = byId.get(node.parent)) path.unshift(node);
  return path;
};

/**
 * Which entries are open: the path down to the current one, and, while the outline is short enough to scan, every
 * entry that has sections below it. A parent whose children are only labels stays folded until the reader is in it.
 */
export function defaultExpanded(tree, activeId, { limit = OPEN_LIMIT } = {}) {
  const open = new Set(ancestorsOf(tree, activeId).map(node => node.id));
  if (tree.filter(node => !node.minor).length <= limit) {
    const withSections = new Set(tree.filter(node => node.parent && !node.minor).map(node => node.parent));
    for (const id of withSections) open.add(id);
  }
  return open;
}

/** The rows to draw: an entry shows when every entry above it is open. */
export function outlineRows(tree, expanded) {
  const rows = [], hidden = new Set();
  for (const node of tree) {
    if (node.parent && (hidden.has(node.parent) || !expanded.has(node.parent))) { hidden.add(node.id); continue; }
    rows.push(node);
  }
  return rows;
}

/** Entries whose title holds the query (case and width folded), each with the titles above it; a blank query is no filter. */
export function filterOutline(tree, query) {
  const wanted = String(query || '').normalize('NFKC').toLowerCase().trim();
  if (!wanted) return tree;
  const byId = new Map(tree.map(node => [node.id, node]));
  return tree.filter(node => node.title.normalize('NFKC').toLowerCase().includes(wanted)).map(node => {
    const trail = [];
    for (let up = byId.get(node.parent); up; up = byId.get(up.parent)) trail.unshift(up.title);
    return { ...node, trail };
  });
}

/** The section an entry belongs to: itself, or the part above it when it is a label. */
export function sectionOf(tree, id) {
  const node = tree.find(entry => entry.id === id);
  if (!node) return null;
  return node.minor ? node.parent : node.id;
}

/** Previous and next section around an entry; labels are skipped, they belong to their part. */
export function sectionNeighbours(tree, id) {
  const sections = tree.filter(node => !node.minor), anchor = sectionOf(tree, id);
  return neighbours(sections, anchor);
}

/** Where an entry sits, for the toolbar: its title, a label's part first. */
export function outlinePath(tree, id) {
  const node = tree.find(entry => entry.id === id);
  if (!node) return [];
  if (!node.minor) return [node.title].filter(Boolean);
  return [tree.find(entry => entry.id === node.parent)?.title, node.title].filter(Boolean);
}

/** 0..1 for how far a scroll area has been scrolled; 0 when it all fits. */
export function readingProgress({ scrollTop = 0, clientHeight = 0, scrollHeight = 0 } = {}) {
  const range = scrollHeight - clientHeight;
  return range > 0 ? Math.min(1, Math.max(0, scrollTop / range)) : 0;
}
