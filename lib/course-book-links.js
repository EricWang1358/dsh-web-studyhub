/* The links, headings and stitching of the 复习全书's Markdown files (lib/course-book-files.js holds the files), browser-safe: the page parses its links,
   builds its 目录 and stitches the files with these. Pure. Design: docs/plans/review-book.md.

   Every heading has a STABLE id at the end of its own line, `## Title <!-- sh:id <id> -->` (it moves with the heading, and plain Markdown hides it). The
   outline's headings get theirs from the manifest (`h<n>`, given once and kept across outline rebuilds); a heading the learner types gets one on save
   (assignHeadingIds; n only grows, so an id is never reused). Inserting, moving or deleting sections leaves the other ids as they are. Footnotes are
   numbered per file; stitching names them per file (`[^<file>-<n>]`) so stitched files never collide. */

/** How many questions a 练 N 道 link practises by default. */
export const CHUNK = 5;
const enc = encodeURIComponent;

/** The only links the book interprets (I5); any other link is an ordinary link. */
export const bookLinks = Object.freeze({
  card: (deckId, cardId) => `studyhub://card/${enc(deckId)}/${enc(cardId)}`,
  practice: (heading, n = CHUNK) => `studyhub://practice?heading=${enc(heading)}&n=${n}`,
  qa: heading => `studyhub://qa?heading=${enc(heading)}`,
  source: sourceId => `studyhub://source/${enc(sourceId)}`,
});

/** A studyhub:// link as { kind: 'card', deckId, cardId } | { kind: 'practice', heading, n } | { kind: 'qa', heading } | { kind: 'source', sourceId }, else null. */
export function parseBookLink(href) {
  const match = /^studyhub:\/\/([a-z]+)(\/[^?#]*)?(?:\?([^#]*))?$/.exec(String(href ?? ''));
  if (!match) return null;
  const [, kind, path = '', query = ''] = match, parts = path.split('/').filter(Boolean).map(part => { try { return decodeURIComponent(part); } catch { return null; } });
  const params = new URLSearchParams(query), heading = params.get('heading');
  if (kind === 'card' && parts.length === 2 && parts.every(Boolean)) return { kind, deckId: parts[0], cardId: parts[1] };
  if (kind === 'source' && parts.length === 1 && parts[0]) return { kind, sourceId: parts[0] };
  if (kind === 'qa' && heading) return { kind, heading };
  if (kind === 'practice' && heading) { const n = Number(params.get('n')); return { kind, heading, n: Number.isInteger(n) && n > 0 && n <= 50 ? n : CHUNK }; }
  return null;
}

const ID_SUFFIX = /\s*<!-- sh:id (\S+) -->\s*$/;
const HEADING = /^(#{1,6})\s+(.*?)\s*$/;
const FENCE = /^\s*(```|~~~)/;
const LINK = /\[([^\]\n]+)\]\((studyhub:\/\/[^)\s]+)\)/g;
const linesOf = text => String(text ?? '').replace(/\r\n?/g, '\n').split('\n');
/** A heading line with its id. */
export const headingLine = (level, title, id) => `${'#'.repeat(Math.min(6, Math.max(1, level)))} ${title} <!-- sh:id ${id} -->`;
/** A line as the page and an export show it: a heading's id suffix taken out. */
export const shownLine = line => line.replace(ID_SUFFIX, '');

/** The headings of a text in order: [{ id, level, title, line }] (`id` null when it has none yet). Lines inside code fences are no headings. */
function headingsOf(lines) {
  const out = [];
  let fenced = false;
  lines.forEach((line, at) => {
    if (FENCE.test(line)) { fenced = !fenced; return; }
    const heading = fenced ? null : HEADING.exec(line);
    if (heading) out.push({ id: ID_SUFFIX.exec(heading[2])?.[1] ?? null, level: heading[1].length, title: heading[2].replace(ID_SUFFIX, '').replace(/\s+#+$/, ''), line: at });
  });
  return out;
}

/**
 * The 目录 of a text: { tree: [{ id, level, title, links, children }], flat, front } where `links` are the question links ({ kind, …, text }: card, practice,
 * qa) written under that heading before the next one, and `front` the ones before the first heading. Reused by the 查找页 and the export later.
 */
export function bookIndex(text) {
  const lines = linesOf(text), headings = headingsOf(lines), linksIn = (from, to) => {
    const found = [];
    for (const line of lines.slice(from, to)) for (const match of line.matchAll(LINK)) { const link = parseBookLink(match[2]); if (link && link.kind !== 'source') found.push({ ...link, text: match[1] }); }
    return found;
  };
  const flat = headings.map((heading, at) => ({ id: heading.id, level: heading.level, title: heading.title, links: linksIn(heading.line + 1, headings[at + 1]?.line ?? lines.length), children: [] }));
  const tree = [], stack = [];
  for (const node of flat) {
    while (stack.length && stack[stack.length - 1].level >= node.level) stack.pop();
    (stack.length ? stack[stack.length - 1].children : tree).push(node);
    stack.push(node);
  }
  return { tree, flat, front: linksIn(0, headings[0]?.line ?? lines.length) };
}

/**
 * Every heading with an id: one without gets `<!-- sh:id h<n> -->` (n from `next`, never an id already in the text), and a copied id (the same id twice) is
 * given a new one on its later heading. -> { text, next }. A text whose headings all have their own id comes back as it was.
 */
export function assignHeadingIds(text, { next = 1, taken: used = [] } = {}) {
  const lines = linesOf(text), headings = headingsOf(lines), taken = new Set([...used, ...headings.map(heading => heading.id).filter(Boolean)]), seen = new Set(used);
  let counter = Math.max(1, Number.isInteger(next) ? next : 1), changed = false;
  const fresh = () => { while (taken.has(`h${counter}`)) counter += 1; const id = `h${counter++}`; taken.add(id); return id; };
  for (const heading of headings) {
    const dup = heading.id && seen.has(heading.id);
    if (heading.id) seen.add(heading.id);
    if (heading.id && !dup) continue;
    changed = true;
    lines[heading.line] = `${lines[heading.line].replace(ID_SUFFIX, '').replace(/\s+$/, '')} <!-- sh:id ${fresh()} -->`;
  }
  return { text: changed ? lines.join('\n') : String(text ?? ''), next: counter };
}

/** A file's footnotes named for the file (`[^3]` -> `[^<file>-3]`, the definitions too), so files stitched together never share one. */
export const namespaceFootnotes = (text, file) => String(text ?? '').replace(/\[\^([\w-]{1,40})\]/g, (mark, n) => `[^${file}-${n}]`);

/**
 * The book as one Markdown text, in order: for each node of `nodes` (the manifest tree: { hid, title, number, leaf, gen?, mine?, children }) its heading,
 * then a leaf's generated file, then the learner's; then 未归位 (`unplaced`: { title, text }) when it holds text. Footnotes are named per file. Deterministic.
 */
export function stitchBook({ title, nodes, unplaced }) {
  const out = [headingLine(1, title, 'book')];
  const walk = (list, depth) => list.forEach(node => {
    out.push('', headingLine(depth + 1, `${node.number} ${node.title}`, node.hid));
    for (const [part, text] of [['g', node.gen], ['m', node.mine]]) if (String(text ?? '').trim()) out.push('', namespaceFootnotes(String(text).trim(), `${node.hid}${part}`));
    walk(node.children || [], depth + 1);
  });
  walk(nodes || [], 1);
  if (String(unplaced?.text ?? '').trim()) out.push('', headingLine(2, unplaced.title, 'unplaced'), '', namespaceFootnotes(unplaced.text.trim(), 'unplaced'));
  return `${out.join('\n')}\n`;
}

/** The text as ordinary Markdown: the headings' id suffixes taken out, nothing else changed (the links stay readable links). */
export const plainBook = text => linesOf(text).map(shownLine).join('\n');
