/* The section operations of book.write (#459, docs/review-book-agent.md): the sections of ONE knowledge point's file changed as a tree, by their
   stable heading ids (`<!-- sh:id h12 -->`, lib/course-book-links.js), never by matching titles. Pure: the file's lines in (its text without the
   footnote definitions and the 练 5 道 line, which lib/book-agent-write.js takes out and settles again), the lines out.

   op insert { section: { heading, markdown }, after | before | within | position }: the new section at that place: after a heading (and all below it),
     before a heading, as the last sub-section of a heading, or at the file's start (before its first heading) or end. A heading of the same title
     (sameTitle: spaces, letter case and the full-width / half-width forms of a punctuation mark do not count; numbering does) already in the file is
     refused: the file never gets the same section twice.
   op delete { heading, children?: promote | delete | toUnplaced }: the heading and its own text go; its sub-sections move up one level (promote, the
     default), go with it (delete), or go with it to 未归位 (toUnplaced: `cut` holds them for the writer). Nothing is left in its place.
   op rename { heading, title }: the heading's title only; its id, level and text stay.
   op move { heading, after | before | within | position }: the section with everything below it to that place; its id stays and its levels follow the
     new place (a section moved inside another becomes one level deeper). A section never goes inside itself, and never so deep that a heading would
     pass level 6 (Markdown has no level 7: that would flatten the levels for good).
   delete / rename / move work on the file's RAW lines (lib/book-agent-write.js): `stay(from, to)` names the lines of a range that stay where they are
   when it moves or goes (a 出处 list a mark outside it cites, the 练 5 道 line: lib/book-footnote-binding.js), `cited(inside)` the definitions outside
   a range that its marks cite (copied along to 未归位). Every other line moves or goes byte for byte. */
import { MAX_TITLE_CHARS } from './document-title.js';

export const SECTION_OPS = Object.freeze(['insert', 'delete', 'rename', 'move']);
export const SECTION_PLACES = Object.freeze(['after', 'before', 'within', 'position']);
export const SECTION_POSITIONS = Object.freeze(['start', 'end']);
export const DELETE_CHILDREN = Object.freeze(['promote', 'delete', 'toUnplaced']);
export const HEADING = /^(#{1,6})\s+(.*?)\s*$/;
const FENCE = /^\s*(```|~~~)/, ID = /\s*<!-- sh:id (\S+) -->\s*$/;
const fail = (message, code) => { throw Object.assign(new Error(message), { code }); };
/** CJK punctuation with the ASCII mark it stands for (NFKC already maps the full-width forms of ASCII, such as ，．：（）). */
const PUNCTUATION = { '、': ',', '。': '.', '「': '"', '」': '"', '『': '"', '』': '"', '“': '"', '”': '"', '‘': "'", '’': "'", '《': '<', '》': '>', '〈': '<', '〉': '>',
  '【': '[', '】': ']', '〔': '[', '〕': ']', '～': '~', '—': '-', '–': '-', '－': '-', '·': '.', '・': '.' };
/** A title as two titles are compared: its id taken out; no whitespace at all; letter case and the full-width / half-width forms of the same punctuation
    mark ignored (、 is a comma, 。 a full stop). Words, digits and numbering stay: 十一、性能测试 and 十二、性能测试 are two titles. */
export const sameTitle = title => String(title ?? '').replace(ID, '').normalize('NFKC').replace(/[、。「」『』“”‘’《》〈〉【】〔〕～—–－·・]/g, mark => PUNCTUATION[mark])
  .replace(/\s+/g, '').toLowerCase();
/** A title as one heading line holds it: one line, spaces folded. */
export const titleLine = title => String(title ?? '').replace(/\s+/g, ' ').trim();

/** The headings of lines outside code fences: [{ at, level, title, id }]. */
export function headingsOf(lines) {
  const out = [];
  let fenced = false;
  lines.forEach((line, at) => {
    if (FENCE.test(line)) { fenced = !fenced; return; }
    const match = fenced ? null : HEADING.exec(line);
    if (match) out.push({ at, level: match[1].length, title: match[2].replace(ID, ''), id: ID.exec(match[2])?.[1] ?? null });
  });
  return out;
}

/** Every heading of `lines` (outside code fences) moved by `delta` levels, kept within min..6. */
export function shiftLevels(lines, delta, min = 1) {
  if (!delta) return lines.slice();
  const out = lines.slice();
  for (const heading of headingsOf(lines)) out[heading.at] = out[heading.at].replace(/^#{1,6}/, '#'.repeat(Math.min(6, Math.max(min, heading.level + delta))));
  return out;
}

/** A title the learner or the chat gives a heading or a node: one line, 1..MAX_TITLE_CHARS characters, no marker. -> the title, or null. */
export function cleanTitle(title) {
  const line = typeof title === 'string' ? titleLine(title) : '';
  return line && [...line].length <= MAX_TITLE_CHARS && !line.includes('<!--') ? line : null;
}

const named = (args, key) => typeof args[key] === 'string' && args[key].trim() !== '';

/** The arguments of an op, checked before anything is read (code book-write-op, or book-write-mode for a mix with markdown / edits). */
export function checkSectionOp(args) {
  if (!SECTION_OPS.includes(args.op)) fail(`op must be one of ${SECTION_OPS.join(', ')} (or no op, with markdown, section or edits); got ${JSON.stringify(args.op)}`, 'book-write-op');
  if (args.markdown !== undefined || args.edits !== undefined || (args.op !== 'insert' && args.section !== undefined))
    fail(`op ${args.op} takes ${args.op === 'insert' ? 'section {heading, markdown}' : 'heading'} and no ${args.op === 'insert' ? 'markdown or edits' : 'markdown, section or edits'}`, 'book-write-mode');
  if (args.op === 'insert' && (typeof args.section?.heading !== 'string' || !titleLine(args.section.heading) || typeof args.section.markdown !== 'string'))
    fail('op insert needs section {heading: the new title, markdown: its text}', 'book-write-op');
  if (args.op !== 'insert' && !named(args, 'heading')) fail(`op ${args.op} needs heading: the id of the heading (book.read lists each heading with its id)`, 'book-write-op');
  if (args.op === 'rename' && !cleanTitle(args.title)) fail(`op rename needs title: one line of 1-${MAX_TITLE_CHARS} characters`, 'book-write-op');
  if (args.op === 'delete' && args.children !== undefined && !DELETE_CHILDREN.includes(args.children)) fail(`children must be one of ${DELETE_CHILDREN.join(', ')}`, 'book-write-op');
  if (args.op === 'insert' || args.op === 'move') {
    const places = SECTION_PLACES.filter(key => args[key] !== undefined);
    if (places.length !== 1) fail(`op ${args.op} needs exactly one place: after, before or within (a heading id) or position (${SECTION_POSITIONS.join(' | ')})`, 'book-write-op');
    if (places[0] === 'position' ? !SECTION_POSITIONS.includes(args.position) : !named(args, places[0])) fail(`${places[0]} must be ${places[0] === 'position' ? SECTION_POSITIONS.join(' or ') : 'a heading id'}`, 'book-write-op');
  }
}

const missing = id => fail(`这一节里没有标题 id ${id}；用 book.read 看标题和 id / No heading of id ${id} in the file; book.read lists each heading with its id`, 'book-section-missing');
const find = (headings, id) => headings.find(heading => heading.id === id) ?? missing(id);
/** Where a heading's section ends: the next heading of its level or higher, else the end. */
const endOf = (headings, heading, total) => headings.find(item => item.at > heading.at && item.level <= heading.level)?.at ?? total;

/** The line and the level a place names in `lines`; `level` is the point's own heading level. `back(lines, at)` may move the end of a section up
    (before the 出处 list it ends with). */
function placeIn(lines, args, level, back = (_lines, at) => at) {
  const headings = headingsOf(lines), top = level + 1;
  if (args.position === 'start') return { at: headings[0]?.at ?? lines.length, level: top };
  if (args.position === 'end') return { at: back(lines, lines.length), level: top };
  if (args.before !== undefined) { const target = find(headings, args.before); return { at: target.at, level: target.level }; }
  if (args.after !== undefined) { const target = find(headings, args.after); return { at: back(lines, endOf(headings, target, lines.length)), level: target.level }; }
  const target = find(headings, args.within);
  return { at: back(lines, endOf(headings, target, lines.length)), level: target.level + 1 };
}
/** A place that would put a heading past level 6 is refused (it could only be flattened, and the levels would be lost for good). */
const tooDeep = deepest => { if (deepest > 6) fail('放到这里标题会超过第 6 级；换一个浅一些的位置 / There a heading would pass level 6 (Markdown has no deeper level); choose a shallower place', 'book-section-move-invalid'); };
const put = (lines, at, piece) => [...lines.slice(0, at), '', ...piece, '', ...lines.slice(at)];
const taken = (headings, title, except = null) => {
  const same = headings.find(heading => heading.id !== except && sameTitle(heading.title) === sameTitle(title));
  if (same) fail(`这个文件里已有同名标题「${titleLine(same.title)}」（id ${same.id ?? '—'}）；改它的内容用 section，改名用 op rename / The file already has a heading of this title (id ${same.id ?? '—'}): write it with section, or rename one`, 'book-section-exists');
};

/**
 * Applies one op (checked by checkSectionOp) to `lines`. `level`: the point's own heading level. `piece(level)` -> { title, lines } the section an insert
 * writes at that level, its heading line first. -> { lines, section: { id?, title } | null, cut: lines | null (what toUnplaced takes away) }.
 */
export function applySectionOp(lines, args, { level, piece, stay = () => new Set(), cited = () => [], back }) {
  const headings = headingsOf(lines);
  // The lines of [from, to) that leave (`out`) and the file without them (the staying ones keep their place).
  const take = (from, to) => {
    const kept = stay(from, to), out = [], rest = [], inside = new Set();
    lines.forEach((line, at) => { if (at >= from && at < to && !kept.has(at)) { out.push(line); inside.add(at); } else rest.push(line); });
    return { out, rest, inside };
  };
  if (args.op === 'insert') {
    const place = placeIn(lines, args, level, back);
    tooDeep(place.level);
    const made = piece(place.level);
    taken(headings, made.title);
    return { lines: put(lines, place.at, made.lines), section: { title: made.title }, cut: null };
  }
  const target = find(headings, args.heading), end = endOf(headings, target, lines.length);
  if (args.op === 'rename') {
    const title = cleanTitle(args.title);
    taken(headings, title, target.id);
    const out = lines.slice();
    out[target.at] = `${'#'.repeat(target.level)} ${title} <!-- sh:id ${target.id} -->`;
    return { lines: out, section: { id: target.id, title }, cut: null };
  }
  if (args.op === 'delete') {
    const children = args.children ?? 'promote';
    if (children !== 'promote') {
      const { out, rest, inside } = take(target.at, end);
      return { lines: rest, section: null, cut: children === 'toUnplaced' ? [...out, ...cited(inside).map(at => lines[at])] : null, removed: inside };
    }
    const own = headings.find(item => item.at > target.at)?.at ?? end, ownEnd = Math.min(own, end), kept = stay(target.at, ownEnd);
    // The sub-sections shifted as ONE slice, so a code fence in them keeps its lines (a `# comment` inside it is no heading).
    const result = [], removed = new Set(), lifted = shiftLevels(lines.slice(ownEnd, end), -1, level + 1);
    lines.forEach((line, at) => {
      if (at >= target.at && at < ownEnd) { if (kept.has(at)) result.push(line); else removed.add(at); return; }
      result.push(at >= ownEnd && at < end ? lifted[at - ownEnd] : line);
    });
    return { lines: result, section: null, cut: null, removed };
  }
  // move: the section with what is below it, out of the file and into the place named in what is left.
  const { out: block, rest } = take(target.at, end), inside = new Set(headingsOf(block).map(item => item.id));
  const anchor = SECTION_PLACES.slice(0, 3).map(key => args[key]).find(value => value !== undefined);
  if (anchor !== undefined && inside.has(anchor)) fail('一节不能移到它自己里面 / A section cannot go inside itself', 'book-section-move-invalid');
  const place = placeIn(rest, args, level, back);
  tooDeep(Math.max(...headingsOf(block).map(item => item.level)) + place.level - target.level);
  return { lines: put(rest, place.at, shiftLevels(block, place.level - target.level, level + 1)), section: { id: target.id, title: titleLine(target.title) }, cut: null };
}
