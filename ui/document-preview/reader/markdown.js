/* The reading view's Markdown: the notes' Markdown with every formula written out as the reader's one formula unit
   (formula.js), so a passage that contains one verifies against the stored text and looks as it does in a text source. */
import { createMarkdown } from '../../note-markdown.js';
import { formulaHtml } from './formula.js';
import { findFootnotes } from '../../../lib/footnote-html.js';

/** A formula token as the unit: its exact stored slice ($…$, $$…$$, with an equation number) is the text, its content the TeX. */
const formulaRule = (display, numbered) => (tokens, index) => {
  const { content, markup, tag, info } = tokens[index], mark = markup || tag, label = numbered ? info : '';
  return formulaHtml({ source: content, display, raw: `${mark}${content}${mark}${label ? ` (${label})` : ''}`, label });
};

const renderer = createMarkdown({ math_inline: formulaRule(false), math_inline_double: formulaRule(true), math_block: formulaRule(true), math_block_eqno: formulaRule(true, true) });

/* A converter's page footnote (lib/footnote-html.js: `<small><span class="docvortex-page-footnote">…</span></small>`) is a block of its own: a note
   paragraph whose words go through the same inline Markdown (emphasis, formulas, entities) as any text. Raw HTML stays off (html: false); the stored tags
   are written out as escaped text in hidden brackets, like a formula's source, so selection and citations still count the stored text. The rule starts
   only where a block starts, so code fences, indented code and code spans that mention the markup are never footnotes. Footnotes on lines of their own,
   alone or in a row, also when they follow body lines directly (the rule ends the paragraph above it). */
function footnoteBlock(state, startLine, endLine, silent) {
  if (state.sCount[startLine] - state.blkIndent >= 4) return false;
  const lineAt = line => state.src.slice(state.bMarks[line] + state.tShift[line], state.eMarks[line]);
  if (!lineAt(startLine).startsWith('<')) return false;
  const lines = [];
  for (let line = startLine; line < endLine && !state.isEmpty(line) && state.sCount[line] >= state.blkIndent; line++) lines.push(lineAt(line));
  const text = lines.join('\n'), chain = [];
  // The leading run of footnotes: the first at the very start, each next one after whitespace only.
  for (const note of findFootnotes(text)) {
    if (text.slice(chain.length ? chain.at(-1).end : 0, note.start).trim()) break;
    chain.push(note);
  }
  if (!chain.length) return false;
  // The run must end at the end of a line: a footnote followed by words on the same line stays text.
  const end = chain.at(-1).end;
  if (!/^[ \t]*(?:\n|$)/.test(text.slice(end))) return false;
  if (silent) return true;
  state.line = startLine + text.slice(0, end).split('\n').length;
  for (const note of chain) {
    const open = state.push('reader_footnote_open', 'p', 1), inline = state.push('inline', '', 0), close = state.push('reader_footnote_close', 'p', -1);
    open.block = close.block = true; open.map = inline.map = [startLine, state.line];
    open.meta = { stored: note.open }; close.meta = { stored: note.close };
    inline.content = note.inner.trim(); inline.children = [];
  }
  return true;
}
renderer.block.ruler.before('paragraph', 'reader_footnote', footnoteBlock, { alt: ['paragraph'] });
const stored = text => `<span class="reader-bracket" aria-hidden="true">${renderer.utils.escapeHtml(text)}</span>`;
renderer.renderer.rules.reader_footnote_open = (tokens, index) => `<p class="reader-footnote" role="note">${stored(tokens[index].meta.stored)}`;
renderer.renderer.rules.reader_footnote_close = (tokens, index) => `${stored(tokens[index].meta.stored)}</p>\n`;

export const renderReaderMarkdown = source => renderer.render(String(source || ''));
