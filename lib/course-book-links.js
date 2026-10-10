/* The links, headings and markers of the 复习全书's Markdown (lib/course-book-doc.js), browser-safe: the page parses its links, builds its 目录 and splits
   the text with these. Pure.

   Every heading has a STABLE id at the end of its own line, `## Title <!-- sh:id <id> -->` (it moves with the heading, and plain Markdown hides it):
   `bk:<node>` for the outline's headings (the program writes them), `h<n>` for one the learner typed (given on save, assignHeadingIds; n only grows, so an
   id is never reused). Inserting, moving or deleting sections leaves the other ids as they are; the 目录 and the way back after practice use them. */

/** How many questions a 练 N 道 link practises by default. */
export const CHUNK = 5;
const enc = encodeURIComponent;

export const bookLinks = Object.freeze({
  card: (deckId, cardId) => `studyhub://card/${enc(deckId)}/${enc(cardId)}`,
  practice: (key, n = CHUNK) => `studyhub://practice?node=${enc(key)}&n=${n}`,
  qa: key => `studyhub://qa?node=${enc(key)}`,
  source: sourceId => `studyhub://source/${enc(sourceId)}`,
});

/** A studyhub:// link as { kind: 'card', deckId, cardId } | { kind: 'practice', node, n } | { kind: 'qa', node } | { kind: 'source', sourceId }, or null. */
export function parseBookLink(href) {
  const match = /^studyhub:\/\/([a-z]+)(\/[^?#]*)?(?:\?([^#]*))?$/.exec(String(href ?? ''));
  if (!match) return null;
  const [, kind, path = '', query = ''] = match, parts = path.split('/').filter(Boolean).map(part => { try { return decodeURIComponent(part); } catch { return null; } });
  const params = new URLSearchParams(query);
  if (kind === 'card' && parts.length === 2 && parts.every(Boolean)) return { kind, deckId: parts[0], cardId: parts[1] };
  if (kind === 'source' && parts.length === 1 && parts[0]) return { kind, sourceId: parts[0] };
  if ((kind === 'practice' || kind === 'qa') && params.get('node')) {
    const n = Number(params.get('n'));
    return kind === 'qa' ? { kind, node: params.get('node') } : { kind, node: params.get('node'), n: Number.isInteger(n) && n > 0 && n <= 50 ? n : CHUNK };
  }
  return null;
}

const ID_SUFFIX = /\s*<!-- sh:id (\S+) -->\s*$/;
const MARKER_LINE = /^<!-- \/?sh:(gen|qa)\b[^>]*-->$/;
const HEADING = /^(#{1,6})\s+(.*?)\s*$/;
/** The lines the page and the export show: region markers out, a heading's id suffix out. */
const shown = lines => lines.filter(line => !MARKER_LINE.test(line.trim())).map(line => line.replace(ID_SUFFIX, ''));
const FENCE = /^\s*(```|~~~)/;
const LINK = /\[([^\]\n]+)\]\((studyhub:\/\/[^)\s]+)\)/g;
const linesOf = text => String(text ?? '').replace(/\r\n?/g, '\n').split('\n');

/** The headings of a text in order: [{ id, level, title, line }] (`line`: its index; `id` null when it has none yet). Lines inside code fences are no headings. */
function headingsOf(lines) {
  const out = [];
  let fenced = false;
  lines.forEach((line, at) => {
    if (FENCE.test(line)) { fenced = !fenced; return; }
    const heading = fenced ? null : HEADING.exec(line);
    if (!heading) return;
    const id = ID_SUFFIX.exec(heading[2])?.[1] ?? null;
    out.push({ id, level: heading[1].length, title: heading[2].replace(ID_SUFFIX, '').replace(/\s+#+$/, ''), line: at });
  });
  return out;
}

/**
 * The 目录 of a text: { tree: [{ id, level, title, links, children }], flat } where `links` are the question links ({ kind, …, text }: card, practice, qa)
 * written under that heading before the next one, and `front` the ones before the first heading. Reused by the 查找页 and the export later.
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
 * Every heading with an id: one the learner typed gets `<!-- sh:id h<n> -->` (n from `next`, never an id already in the text), and a copied id (the same id
 * twice) is given a new one on its later heading. -> { text, next }. A text whose headings all have their own id comes back as it was.
 */
export function assignHeadingIds(text, { next = 1 } = {}) {
  const lines = linesOf(text), headings = headingsOf(lines), taken = new Set(headings.map(heading => heading.id).filter(Boolean)), seen = new Set();
  let counter = Math.max(1, Number.isInteger(next) ? next : 1), changed = false;
  const fresh = () => { while (taken.has(`h${counter}`)) counter += 1; const id = `h${counter++}`; taken.add(id); return id; };
  for (const heading of headings) { if (heading.id && seen.has(heading.id)) heading.dup = true; if (heading.id) seen.add(heading.id); }
  for (const heading of headings) {
    if (heading.id && !heading.dup) continue;
    changed = true;
    lines[heading.line] = `${lines[heading.line].replace(ID_SUFFIX, '').replace(/\s+$/, '')} <!-- sh:id ${fresh()} -->`;
  }
  return { text: changed ? lines.join('\n') : String(text ?? ''), next: counter };
}

/**
 * The text cut for the page at its top headings (level 1 and 2): [{ id, title, level, text }] with every marker line taken out, the part before the first
 * one with id ''. The page renders only the sections that are open, so a big book stays light.
 */
export function bookSections(text) {
  const lines = linesOf(text), cuts = headingsOf(lines).filter(heading => heading.level <= 2), sections = [];
  const body = (from, to) => shown(lines.slice(from, to)).join('\n').trim();
  const lead = body(0, cuts[0]?.line ?? lines.length);
  if (lead) sections.push({ id: '', title: '', level: 0, text: lead });
  cuts.forEach((cut, at) => sections.push({ id: cut.id ?? `line-${cut.line}`, title: cut.title, level: cut.level, text: body(cut.line, cuts[at + 1]?.line ?? lines.length) }));
  return sections;
}

/** The text as ordinary Markdown: every marker line taken out, nothing else changed (the links stay readable links). */
export const plainBook = text => shown(linesOf(text)).join('\n');

/** Where the part of heading `id` ends in the text (before the next heading with an id, else the end) and where its heading line ends; null without it. */
export function headingPart(text, id) {
  const source = String(text ?? ''), mark = source.indexOf(` <!-- sh:id ${id} -->`);
  if (mark < 0) return null;
  const lineEnd = source.indexOf('\n', mark), rest = lineEnd < 0 ? -1 : source.slice(lineEnd).search(/\n#{1,6}\s[^\n]*<!-- sh:id \S+ -->/);
  return { lineEnd: lineEnd < 0 ? source.length : lineEnd, end: rest < 0 ? source.replace(/\n*$/, '').length : lineEnd + rest };
}
