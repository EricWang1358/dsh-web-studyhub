/* 思维导图 of the reader: the tree of the current chapter, from headings the reader already has. No model call and no tokens; pure, no DOM.
   A paged document (PDF pages, slides) is read from the heading paragraphs of the pages of the chapter that is drawn (text-sections.js decides which
   paragraph is a heading); a text document (Markdown, a transcript, a kept AI outline) from its outline entries, the branch around the current one.
   A node is { id, title, level, depth, target, children }; `target` says where a click goes: { sectionId, page, headingIndex } (the n-th heading of a page
   section) or { outlineId } (an entry of the outline). The root is the chapter itself, id 'root', depth -1. */
import { headingMark } from './text-sections.js';

/** Most nodes a map draws: a chapter of a big book has hundreds of headings, and a map nobody can take in is no map. */
export const MIND_MAP_MAX = 120;
/** A heading met on this many pages of one chapter is a running header (a book's name on every page), not a section. */
const RUNNING_MIN = 3;
const ORDINAL = /^[一二三四五六七八九十百]{1,3}[、．.]\s*\S/, BRACKET_ORDINAL = /^[（(][一二三四五六七八九十\d]{1,3}[)）]\s*\S/;

/** The level a heading line says it has: a Markdown mark's length, the parts of a number ("11.2.3"), 第…章 (1) and 第…节 (2), 一、(2) and （一）(3); null for plain words. */
export function headingLevel(line) {
  const text = String(line ?? '').trim(), mark = headingMark(text);
  if (mark) return Math.min(6, mark.trim().length);
  const numbered = /^(\d{1,3}(?:\.\d{1,3})*)[.)．]?\s+\S/.exec(text);
  if (numbered) return numbered[1].split('.').length;
  if (/^第\s*[一二三四五六七八九十百\d]+\s*[章部篇]/.test(text)) return 1;
  if (/^第\s*[一二三四五六七八九十百\d]+\s*[节]/.test(text)) return 2;
  if (ORDINAL.test(text)) return 2;
  if (BRACKET_ORDINAL.test(text)) return 3;
  return null;
}

/** A heading's words: its Markdown mark and the dollar signs of a formula dropped, spaces collapsed. */
const wordsOf = line => String(line ?? '').trim().slice(headingMark(line).length).replace(/\$/g, '').replace(/\s+/g, ' ').trim();
const same = title => title.normalize('NFKC').toLowerCase();

/** Nest flat entries ({ level, ... }) by level: a deeper entry belongs to the nearest one above with a lower level; a level that skips still nests. */
function nest(entries, make) {
  const root = { id: 'root', title: '', level: 0, depth: -1, target: null, children: [] }, stack = [root];
  entries.forEach((entry, index) => {
    while (stack.length > 1 && stack.at(-1).level >= entry.level) stack.pop();
    const parent = stack.at(-1), node = { ...make(entry, index), level: entry.level, depth: stack.length - 1, children: [] };
    parent.children.push(node);
    stack.push(node);
  });
  return root;
}

/** The heading paragraphs of the page sections, in reading order, as { title, level, target } (levels filled for plain headings from the number above them). */
function pageHeadings(sections) {
  const found = [];
  for (const section of sections) {
    if (section.kind !== 'page') continue;
    let at = 0;
    for (const paragraph of section.paragraphs || []) {
      if (paragraph.kind !== 'heading') continue;
      const title = wordsOf(paragraph.text);
      if (title) found.push({ title, said: headingLevel(paragraph.text), target: { sectionId: section.id, page: section.page, headingIndex: at } });
      at += 1;
    }
  }
  const pages = new Map();
  for (const item of found) { const key = same(item.title); (pages.get(key) ?? pages.set(key, new Set()).get(key)).add(item.target.sectionId); }
  let above = 0;
  return found.filter(item => (pages.get(same(item.title)).size < RUNNING_MIN)).map(item => {
    const level = item.said ?? Math.min(6, above + 1);
    if (item.said) above = item.said;
    return { title: item.title, level, target: item.target };
  });
}

/** The branch of `outline` around `activeId`: its top-level ancestor and everything below that. */
function branchOf(outline, activeId) {
  const byId = new Map(outline.map(item => [item.id, item]));
  let top = byId.get(activeId) ?? outline[0];
  while (top && top.parent != null && byId.has(top.parent)) top = byId.get(top.parent);
  if (!top) return { top: null, items: [] };
  const at = outline.indexOf(top), items = [];
  for (let index = at + 1; index < outline.length && (outline[index].level > top.level); index += 1) items.push(outline[index]);
  return { top, items };
}

/** Entries of an outline as map entries (a page entry without a title says its page). */
const outlineEntries = items => items.filter(item => item.kind !== 'chapter' && item.title).map(item => ({ title: item.title, level: item.level || 1, target: { outlineId: item.id, ...(item.page ? { page: item.page } : {}) } }));

/**
 * The map of one chapter. input: { title (the chapter's), sections (the page sections drawn: text-sections.js), outline (entries of the chapter or the whole
 * document), activeId, branch (a text document: map the branch of the outline around activeId, and let that branch's top entry be the root) }.
 * -> { id: 'root', title, target, children, truncated?, count }. options: { max }.
 */
export function buildMindMap({ title = '', sections = [], outline = [], activeId = null, branch = false }, { max = MIND_MAP_MAX } = {}) {
  let rootTitle = title, rootTarget = null, entries;
  if (branch && outline.length) {
    const { top, items } = branchOf(outline, activeId);
    if (top) { rootTitle = top.title || title; rootTarget = { outlineId: top.id }; }
    entries = outlineEntries(items).map(entry => ({ ...entry, level: entry.level - (top?.level ?? 0) }));
  } else {
    entries = pageHeadings(sections);
    if (!entries.length) entries = outlineEntries(outline);
  }
  const shown = entries.slice(0, max), tree = nest(shown, (entry, index) => ({ id: `n${index}`, title: entry.title, target: entry.target }));
  return { ...tree, title: rootTitle, target: rootTarget, count: shown.length, ...(entries.length > shown.length ? { truncated: true } : {}) };
}

/** Ids of the nodes a new map opens: the root and the top level, so the top two levels are on show. */
export function openByDefault(map) {
  const open = new Set(['root']);
  const walk = nodes => { for (const node of nodes) { if (node.depth < 1) open.add(node.id); walk(node.children); } };
  walk(map.children);
  return open;
}

/** The heading element a page-section target names, inside the reading area (null when the page is not drawn). */
export function headingNode(root, target) {
  if (!root || target?.sectionId == null) return null;
  const section = [...root.querySelectorAll('[data-outline-id]')].find(node => node.dataset.outlineId === String(target.sectionId));
  return section?.querySelectorAll('.reader-p--heading')[target.headingIndex ?? 0] ?? section ?? null;
}

/** The map as an indented text, two spaces a level, each node with its page when it has one: what 交给主会话细化 carries. */
export function mapOutlineText(map) {
  const lines = [map.title];
  const walk = (nodes, depth) => { for (const node of nodes) { lines.push(`${'  '.repeat(depth)}${node.title}${node.target?.page ? ` (p.${node.target.page})` : ''}`); walk(node.children, depth + 1); } };
  walk(map.children, 1);
  return lines.join('\n');
}
