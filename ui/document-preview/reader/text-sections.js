/* How the reader sets plain text (TXT, transcripts, PDF page text, slides) for
   reading: paragraphs, which of them are headings, which keep their line
   breaks, and the sections the outline lists. The text of every paragraph is
   the stored text unchanged (only blank-line separators are dropped), so
   passage capture and citation highlighting, which match the rendered text
   without whitespace, keep working. Pure helpers, no DOM. */
import { splitStudyMath } from '../../study-media.js';

const SENTENCE_END = /[。．.!！?？；;:：,，、…)）”"』」\]]$/;
const HEADING_MAX = 60;
/* A list item: a bullet, or a number/letter followed by a mark. "3.1 标题" is not one. */
const LIST_MARK = /^\s*(?:[-*•·▪◦‣–—]\s+\S|\d{1,3}[.)]\s+\S|\d{1,3}[、．]\s*\S|[（(]\d{1,3}[)）]\s*\S|[a-zA-Z][.)]\s+\S|[一二三四五六七八九十]{1,3}[、．]\s*\S)/;
/* Layout the line breaks of which carry meaning: tabs, wide gaps, table rules, box drawing. */
const LAYOUT = /\t|\S {3,}\S|\|.*\||[│┃┆┊┌└├╭╰╔╚]/;
/* A transcript part: a line that is one 【…】 label, as the transcript importer writes them. */
const SEGMENT_MARK = /^【([^】\n]{1,80})】[ \t]*$/;

/* A Markdown heading line ("# 标题"), as pasted notes and saved Markdown text keep them. */
const MARKDOWN_HEADING = /^(#{1,6}[ \t]+)\S/;

/** The "# " of a Markdown heading line (hidden when drawn, kept in the text), or ''. */
export const headingMark = line => MARKDOWN_HEADING.exec(String(line || ''))?.[1] || '';

/** A short single line without sentence punctuation reads as a heading, unless it holds a formula (a line that is just a formula is body text). */
export function looksLikeHeading(line) {
  const text = String(line || '').trim();
  return text.length > 0 && text.length <= HEADING_MAX && !SENTENCE_END.test(text) && !LIST_MARK.test(text) && !LAYOUT.test(text)
    && splitStudyMath(text).every(piece => typeof piece === 'string');
}

/** 'layout' keeps every space and break, 'lines' keeps the breaks of a list, 'prose' reflows. */
export function classifyParagraph(lines) {
  if (lines.some(line => LAYOUT.test(line))) return 'layout';
  if (lines.length > 1 && lines.some(line => LIST_MARK.test(line))) return 'lines';
  return 'prose';
}

/** Markdown heading lines at the top of a chunk, each on its own, then the rest. */
function splitHeadingLines(chunk) {
  const at = chunk.indexOf('\n');
  return at > 0 && headingMark(chunk) ? [chunk.slice(0, at), ...splitHeadingLines(chunk.slice(at + 1))] : [chunk];
}

/** Paragraphs split at blank lines: [{ kind: 'heading' | 'prose' | 'lines' | 'layout', text, lines }]. */
export function splitParagraphs(text) {
  // A Markdown heading is its own paragraph even when the text follows on the next line.
  const chunks = String(text || '').replace(/\r\n?/g, '\n').split(/\n[ \t]*\n+/)
    .map(chunk => chunk.replace(/^\n+/, '').replace(/\s+$/, '')).filter(chunk => chunk.trim())
    .flatMap(splitHeadingLines);
  return chunks.map((chunk, index) => {
    const lines = chunk.split('\n');
    const heading = lines.length === 1 && (!!headingMark(lines[0]) || (looksLikeHeading(lines[0]) && (index < chunks.length - 1 || index === 0)));
    return { kind: heading ? 'heading' : classifyParagraph(lines), text: chunk, lines };
  });
}

/* PDF text is cut at the page's line ends. Between two CJK characters such a break must not show
   as a gap, but Chromium keeps the collapsed break as a space there. The break stays in the text
   (the backend compares whitespace-collapsed text, so a selection across it still resolves) and
   is drawn with zero width. */
const CJK = '\\u2e80-\\u30ff\\u3400-\\u4dbf\\u4e00-\\u9fff\\uf900-\\ufaff\\uff00-\\uffef';
const CJK_BREAK = new RegExp(`(?<=[${CJK}])\\n(?=[${CJK}])`, 'gu');

/** A paragraph as pieces: strings, and { join: true } for each hard line break between CJK characters. */
export function lineBreakPieces(text) {
  const value = String(text ?? ''), pieces = [];
  let last = 0;
  for (const match of value.matchAll(CJK_BREAK)) {
    if (match.index > last) pieces.push(value.slice(last, match.index));
    pieces.push({ join: true });
    last = match.index + 1;
  }
  if (last < value.length) pieces.push(value.slice(last));
  return pieces;
}

/**
 * Transcript parts: [{ title, text }] when the text has at least two titled 【…】 parts,
 * otherwise null. Text before the first label is kept as an untitled opening part.
 */
export function splitSegments(text) {
  const parts = [{ title: '', lines: [] }];
  for (const line of String(text || '').replace(/\r\n?/g, '\n').split('\n')) {
    const mark = SEGMENT_MARK.exec(line.trim());
    if (mark) parts.push({ title: mark[1].trim(), lines: [] });
    else parts.at(-1).lines.push(line);
  }
  const kept = parts.filter(part => part.title || part.lines.some(line => line.trim()));
  return kept.filter(part => part.title).length >= 2 ? kept.map(part => ({ title: part.title, text: part.lines.join('\n') })) : null;
}

/**
 * The sections the reader shows for a text source.
 * Paged formats (PDF, PowerPoint) give one section per page or slide; any other text is
 * one section, or one per transcript part. Each section: { id, kind, page?, sourceId?, title,
 * paragraphs }. `title` is the part's own title, else the page's first heading.
 */
export function readingSections({ paged = false, sources = [], text = '' } = {}) {
  if (paged) {
    return sources.map((item, index) => {
      const page = item.document?.page || index + 1, paragraphs = splitParagraphs(item.text);
      return { id: `page-${page}-${index}`, kind: 'page', page, sourceId: item.id, title: item.title || '',
        heading: paragraphs[0]?.kind === 'heading' ? paragraphs[0].text.slice(headingMark(paragraphs[0].text).length) : '', paragraphs };
    });
  }
  const segments = splitSegments(text);
  if (segments) return segments.map((part, index) => ({ id: `part-${index}`, kind: 'part', title: part.title, heading: '', paragraphs: splitParagraphs(part.text) }));
  return [{ id: 'part-0', kind: 'part', title: '', heading: '', paragraphs: splitParagraphs(text) }];
}
