/* The reading view's Markdown: the notes' Markdown with every formula written out as the reader's one formula unit
   (formula.js), so a passage that contains one verifies against the stored text and looks as it does in a text source. */
import { createMarkdown } from '../../note-markdown.js';
import { formulaHtml } from './formula.js';

/** A formula token as the unit: its exact stored slice ($…$, $$…$$, with an equation number) is the text, its content the TeX. */
const formulaRule = (display, numbered) => (tokens, index) => {
  const { content, markup, tag, info } = tokens[index], mark = markup || tag, label = numbered ? info : '';
  return formulaHtml({ source: content, display, raw: `${mark}${content}${mark}${label ? ` (${label})` : ''}`, label });
};

const renderer = createMarkdown({ math_inline: formulaRule(false), math_inline_double: formulaRule(true), math_block: formulaRule(true), math_block_eqno: formulaRule(true, true) });

export const renderReaderMarkdown = source => renderer.render(String(source || ''));
