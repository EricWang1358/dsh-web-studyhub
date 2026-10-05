/* The page footnote that a MinerU / DocVortex conversion writes into its Markdown as HTML:

     <small><span class="docvortex-page-footnote" data-block-type="page_footnote" style="color:#6b7280">① pH 是个例外，用正体。</span></small>

   One pure recognition for everything that has to treat it as a footnote: the reader draws it as a footnote line (ui/document-preview/reader),
   the model gateway and the selection evidence read it as its words only (no tag noise in a question's evidence), and quote matching ignores
   the tag. Only this family is recognised: a <small> around a <span> (or a bare <span>) whose attributes carry the class `docvortex-page-footnote`
   or `data-block-type="page_footnote"`. Any other HTML is not a footnote and stays whatever it was (the reader escapes it as text). Code spans
   and fenced code that merely mention the markup are never recognised. The inner text is returned as stored (Markdown, $…$ math, entities);
   how it is drawn is the reader's business. No DOM, no HTML parsing: the converter output is never turned into markup here. */

const NOTE_ATTRIBUTE = /docvortex-page-footnote(?![\w-])|data-block-type\s*=\s*\\?["']?page_footnote(?![\w-])/i;
/* The inner text of a footnote: no nested <span>, no blank line (a footnote is one block; anything else is malformed and stays text). */
const INNER = String.raw`((?:(?!<\/?span\b|\n[ \t]*\n)[\s\S])*)`;
const SPAN_OPEN = String.raw`(<span\b([^<>]*)>)`;
const NOTE = new RegExp(`<small\\b[^<>]*>\\s*${SPAN_OPEN}${INNER}<\\/span>\\s*<\\/small>|${SPAN_OPEN}${INNER}<\\/span>`, 'gi');
const FENCE = /^ {0,3}(`{3,}|~{3,})/;
const CODE_SPAN = /(?<!`)(`+)(?!`)((?:(?!\n[ \t]*\n)[\s\S])*?)(?<!`)\1(?!`)/g;

/** The code of a text, as [start, end) ranges, and whether a fence is still open at its end. `fenced`: the text starts inside a fence. */
function codeRanges(text, fenced = false) {
  const ranges = [];
  let open = fenced ? { char: '`', size: 3, from: 0 } : null, position = 0;
  for (const line of text.split('\n')) {
    const mark = FENCE.exec(line);
    if (open) {
      if (mark && mark[1][0] === open.char && mark[1].length >= open.size && !line.slice(mark[0].length).trim()) { ranges.push([open.from, position + line.length]); open = null; }
    } else if (mark) open = { char: mark[1][0], size: mark[1].length, from: position };
    position += line.length + 1;
  }
  if (open) ranges.push([open.from, text.length]);
  // Inline code spans, found with the fenced code blanked out (line breaks kept, so a span never crosses a blank line).
  let blanked = text;
  for (const [from, to] of ranges) blanked = blanked.slice(0, from) + blanked.slice(from, to).replace(/[^\n]/g, ' ') + blanked.slice(to);
  for (const span of blanked.matchAll(CODE_SPAN)) ranges.push([span.index, span.index + span[0].length]);
  return { ranges, fenced: !!open };
}

/** Whether a fenced code block is still open at the end of `text` (`fenced`: it started open). Lets a caller that cuts a text into blocks carry the state. */
export const fenceOpenAfter = (text, fenced = false) => codeRanges(String(text ?? '').replace(/\r\n?/g, '\n'), fenced).fenced;

/**
 * The footnotes in a text, in order: [{ start, end, raw, open, inner, close }] with raw === open + inner + close, the exact stored slices
 * (`open` the tags before the words, `close` those after them).
 */
export function findFootnotes(value, { fenced = false } = {}) {
  const text = String(value ?? '');
  if (!/page_footnote|docvortex-page-footnote/i.test(text)) return [];
  const code = codeRanges(text, fenced).ranges, found = [];
  NOTE.lastIndex = 0;
  for (let match = NOTE.exec(text); match; match = NOTE.exec(text)) {
    const wrapped = match[1] !== undefined, spanOpen = wrapped ? match[1] : match[4], attributes = wrapped ? match[2] : match[5], inner = wrapped ? match[3] : match[6];
    const end = match.index + match[0].length, inCode = code.some(([from, to]) => match.index < to && end > from);
    if (!NOTE_ATTRIBUTE.test(attributes) || inCode) { NOTE.lastIndex = match.index + 1; continue; }
    const innerAt = match[0].indexOf(spanOpen) + spanOpen.length;
    found.push({ start: match.index, end, raw: match[0], open: match[0].slice(0, innerAt), inner, close: match[0].slice(innerAt + inner.length) });
  }
  return found;
}

const OPENER = /(?:<small\b[^<>]*>\s*)?<span\b[^<>]*>/gi;
const CLOSER = /<\/span>\s*<\/small>/gi;

/**
 * The text with every footnote reduced to its words (the tags dropped), neighbouring footnotes on separate lines. Anything else is untouched, and
 * code that mentions the markup stays as written. A footnote cut in two by a quote (only its opening tags, or only its closing ones, are in the
 * text) loses those tags too: the opening ones always (they are unmistakable), the closing `</span></small>` only with `dangling`, which says the
 * text is a quote the reader captured from a selection.
 */
export function stripFootnoteHtml(value, { dangling = false } = {}) {
  const text = typeof value === 'string' ? value : value == null ? '' : String(value);
  if (!/page_footnote|docvortex-page-footnote/i.test(text)) return dangling ? text.replace(CLOSER, '') : text;
  const notes = findFootnotes(text), code = codeRanges(text).ranges;
  const changes = notes.map((note, index) => ({ start: note.start, end: note.end, text: note.inner + (notes[index + 1]?.start === note.end ? '\n' : '') }));
  for (const tag of text.matchAll(OPENER)) {
    const start = tag.index, end = start + tag[0].length;
    if (NOTE_ATTRIBUTE.test(tag[0]) && ![...changes.map(change => [change.start, change.end]), ...code].some(([from, to]) => start < to && end > from)) changes.push({ start, end, text: '' });
  }
  let out = '', at = 0;
  for (const change of changes.sort((a, b) => a.start - b.start)) { out += text.slice(at, change.start) + change.text; at = change.end; }
  out += text.slice(at);
  return dangling ? out.replace(CLOSER, '') : out;
}
