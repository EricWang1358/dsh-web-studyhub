import { BASE_CSS, esc, staticPage } from '../static-page.js';
import { MARKDOWN_CSS, contentsList, renderMarkdown } from '../markdown-page.js';
import { mathPageCss } from '../study-math-render.js';
import { DEFINITION, QUOTE_PAIRS, isLabelLine } from '../../lib/footnote-syntax.js';
import { answerCardWords } from '../../lib/answer-card.js';

/* The 复习全书 as ONE self-contained HTML page (#896): the Markdown of the export (lib/course-book-export.js, the text the dialog already holds) made into a
   page that opens offline and prints cleanly, with no Pandoc. Everything general (footnotes at the end of their chapter, heading anchors, maths, links that
   stay inside the page, the print rules) is ui/markdown-page.js's, shared with the other pages saved from Markdown; this file is what is the book's:
   the cover and the contents, the book's words, and 「不含原文引文」.

   bookHtml(markdown, { language, quotes }) -> the page. `language`: the book's ('zh' | 'en'). `quotes: false`: the words quoted from the materials are left out.

   What is a quote from the materials, by the export's producers: (1) the footnote of a point: `[^h12g-1]: 「exact words」 · Source title, page`
   (lib/book-footnotes.js writes it, lib/course-book-files.js writes the same form for a book made by the notes pass); the export has already turned the
   link around the quote into its words. (2) the 概念 lines of an answer card in the 答案册 (lib/answer-card.js renderAnswerCard): `- **name**（资料：title）：「the
   material's own slice」`. Both are cut at ONE point, the Markdown, by withoutSourceQuotes: the quote becomes a note that it is left out, and what stands
   after it stays (a footnote's ` · title`, a page only when the title holds one; a concept's flag). A definition is cut in any shape the renderer reads (indented, in a
   blockquote or a list, over several lines), by the quotation marks of the writer's own table (lib/footnote-syntax.js). Not cut, on purpose: a footnote the learner typed (it does not begin with a quotation
   mark), the words of a question's stem that an answer card quotes (the question's, not the material's), and the learner's and the AI's own text. */

const WORDS = {
  zh: { lang: 'zh-CN', contents: '目录', sources: '出处', back: '回到正文', left: '（原文引文已省略）', noQuotes: '原文引文已省略，只留出处。', book: '复习全书' },
  en: { lang: 'en', contents: 'Contents', sources: 'Sources', back: 'Back to the text', left: '(source quote left out)', noQuotes: 'Quotes from the materials are left out; their sources stay.', book: 'Review book' },
};
const wordsOf = language => WORDS[Object.hasOwn(WORDS, language) ? language : 'zh'];

const PAIRS = QUOTE_PAIRS;
/** Where a definition line really starts: after the blockquote and list markers and the indent the renderer (ui/markdown-page.js) reads it through. */
const LINE_PREFIX = /^(?:[ \t]*>[ \t]?|[ \t]*(?:[-*+]|\d{1,9}[.)])[ \t]+)*[ \t]*/;
/** A line that goes on with the definition above it: blockquote markers, then four spaces or a tab. */
const CONTINUATION = /^(?:[ \t]*>)*(?: {4}|\t)\s*(\S.*)$/;
const FENCE = /^\s*(```|~~~)/;
const SOURCE_LINK = /^\[(.*)\]\(studyhub:\/\/source\/[^)\s]*\)(.*)$/;
const PLACE = /^\s*·\s*(\S[\s\S]*)$/;
const CONCEPT_LABELS = new Set(['zh', 'en'].map(language => `**${answerCardWords(language).concepts}**`));
const CONCEPT_BULLET = /^- /;

/** A footnote's text with its quote replaced by `left`: the quote runs from its opening mark to the LAST closing mark of the text (a closing mark inside the
 *  quote must not end it early, and a quote that is cut short is taken whole); the place is what follows as ` · place`. null: not a quote (the learner's note). */
function footnoteWithout(body, left) {
  const link = SOURCE_LINK.exec(body);
  const rest = link ? link[2] : (() => { const close = PAIRS[body[0]] ? body.lastIndexOf(PAIRS[body[0]]) : -2; return close === -2 ? null : close > 0 ? body.slice(close + 1) : ''; })();
  if (rest === null) return null;
  const place = PLACE.exec(rest)?.[1].trim();
  return place ? `${left} · ${place}` : left;
}

/** An answer card's concept line with the quote replaced: `- **name**（资料：title）：「quote」（未核实）` -> `- **name**（资料：title）：left（未核实）`. */
function conceptWithout(line, left) {
  for (const language of ['zh', 'en']) {
    const w = answerCardWords(language), start = line.indexOf(`${w.sep}${w.open}`), close = line.lastIndexOf(w.close);
    if (start > 0 && close > start) return `${line.slice(0, start + w.sep.length)}${left}${line.slice(close + w.close.length)}`;
  }
  return line;
}

/** The Markdown with the words quoted from the materials left out (see the top of this file). `left`: what stands in their place. */
export function withoutSourceQuotes(markdown, left) {
  const lines = String(markdown ?? '').split(/\r?\n/), out = [];
  let fenced = false, concepts = 0;
  for (let at = 0; at < lines.length; at++) {
    const line = lines[at];
    if (FENCE.test(line)) { fenced = !fenced; out.push(line); continue; }
    if (fenced) { out.push(line); continue; }
    // The 概念 lines of an answer card: after the label, one blank line, then the bullets up to the next blank line.
    if (CONCEPT_LABELS.has(line.trim())) { concepts = 1; out.push(line); continue; }
    if (concepts) {
      if (!line.trim()) { if (concepts === 2) concepts = 0; out.push(line); continue; }
      if (CONCEPT_BULLET.test(line)) { concepts = 2; out.push(conceptWithout(line, left)); continue; }
      concepts = 0;
    }
    // A definition, in any shape the renderer reads: its lines are the first line's rest and the lines indented under it.
    const prefix = LINE_PREFIX.exec(line)[0], found = DEFINITION.exec(line.slice(prefix.length));
    if (!found) { out.push(line); continue; }
    const more = [];
    for (let next = at + 1; next < lines.length && CONTINUATION.test(lines[next]); next++) more.push(CONTINUATION.exec(lines[next])[1]);
    const body = footnoteWithout([found[2].trim(), ...more].filter(Boolean).join(' '), left);
    if (body === null) { out.push(line); continue; }
    out.push(`${prefix}[^${found[1]}]: ${body}`);
    at += more.length;
  }
  return out.join('\n');
}

/** The name of the saved page: the Markdown file's, as .html. */
export const bookHtmlFilename = filename => `${String(filename || 'book').replace(/\.md$/i, '') || 'book'}.html`;

const CSS = `
${BASE_CSS}
${MARKDOWN_CSS}
main{max-width:46rem;margin:0 auto}
.cover{max-width:46rem;margin:1rem auto 0}
.cover h1{margin:0;font-size:1.9rem}
.sub{margin:.4rem 0 0;color:var(--mute);font-size:.9em}
.contents{max-width:46rem;margin:1rem auto 0}
`;

/** The Markdown of the book's export as the page (see the top of this file). */
export function bookHtml(markdown, { language = 'zh', quotes = true, mathCss = '' } = {}) {
  const words = wordsOf(language);
  const source = quotes ? String(markdown ?? '') : withoutSourceQuotes(markdown, words.left);
  const { html, headings, title } = renderMarkdown(source, { chapterLevel: 2, dropTitle: true, footnotesLabel: words.sources, backLabel: words.back, isFootnoteLabel: isLabelLine });
  const name = title || words.book;
  const body = `<header class="cover"><h1>${esc(name)}</h1>${quotes ? '' : `<p class="sub">${esc(words.noQuotes)}</p>`}</header>
${contentsList(headings, { label: words.contents })}
<main>
${html}</main>`;
  return staticPage({ lang: words.lang, title: name, css: CSS, body, mathCss });
}

/** What the export dialog saves: the page of an export's answer (course.book.export, the single form), named after its Markdown file. */
export const bookHtmlFile = async (done, { quotes = true } = {}) => ({ filename: bookHtmlFilename(done.filename),
  // The formula stylesheet with its fonts (#996), embedded only when the page draws a formula (ui/static-page.js).
  html: bookHtml(done.text, { language: done.language, quotes, mathCss: await mathPageCss() }) });
