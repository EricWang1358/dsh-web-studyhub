/* Text that leaves its place in the 复习全书 and waits elsewhere (未归位, or another point's file): ONE implementation for course.book.delete
   (lib/course-book-structure.js), the outline rebuild's fold and park (lib/course-book-files.js) and book.write's section delete to 未归位
   (lib/book-agent-write.js). It keeps the learner's text as written: only footnote labels are renamed (so lists never collide where the text lands) and
   only the gone point's own 练 N 道 / 本节问答 links are taken out. Pure. */
import { parseBookLink } from './course-book-links.js';

const FENCE = /^\s*(```|~~~)/;
const FOOTNOTE = /\[\^([^\]\s]{1,40})\]/g;
const LINK = /\[([^\]\n]+)\]\((studyhub:\/\/[^)\s]+)\)/g;
const linesOf = text => String(text ?? '').replace(/\r\n?/g, '\n').split('\n');
const CODE = /(`+[^`]*`+)/;

/** Each line outside code fences through `change(line)`, inline code spans left as they are. */
function outsideCode(text, change) {
  let fenced = false;
  return linesOf(text).map(line => {
    if (FENCE.test(line)) { fenced = !fenced; return line; }
    return fenced ? line : line.split(CODE).map((piece, at) => (at % 2 ? piece : change(piece))).join('');
  }).join('\n');
}

/** Every footnote mark and definition (any label, CJK too) renamed by `name(label)`, outside code fences and inline code; nothing else changes. */
export const relabelFootnotes = (text, name) => outsideCode(text, piece => piece.replace(FOOTNOTE, (mark, label) => `[^${name(label)}]`));

/** A 练 / 问答 link of exactly that heading (h2's, not h20's). */
const ownLink = (href, hid) => { const link = parseBookLink(href); return (link?.kind === 'practice' || link?.kind === 'qa') && link.heading === hid; };

/** The links to `hid`'s 练 N 道 / 本节问答 taken out (that heading is gone): a line of nothing but such links goes; on a line with the learner's words only
    the link goes and its words stay. Any other link (another point's, a question's, a source's) and code are left as they are. */
export function cutOwnLinks(text, hid) {
  let fenced = false;
  const out = [];
  for (const line of linesOf(text)) {
    if (FENCE.test(line)) { fenced = !fenced; out.push(line); continue; }
    if (fenced || !line.includes('studyhub://')) { out.push(line); continue; }
    const pieces = line.split(CODE), cut = pieces.map((piece, at) => (at % 2 ? piece : piece.replace(LINK, (whole, words, href) => (ownLink(href, hid) ? `\u0000${words}\u0000` : whole))));
    const joined = cut.join('');
    if (!joined.includes('\u0000')) { out.push(line); continue; }
    // Nothing but the gone point's links (and the · between them): the generated line, left out.
    if (!joined.replace(/\u0000[^\u0000]*\u0000/g, '').replace(/[\s·]/g, '')) continue;
    out.push(joined.replace(/\u0000([^\u0000]*)\u0000/g, '$1'));
  }
  return out.join('\n');
}
