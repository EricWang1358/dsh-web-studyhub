import MarkdownIt from "markdown-it";
import texmath from "markdown-it-texmath";
import katex from "katex/dist/katex.js";
import "katex/dist/contrib/mhchem.js";
import { safeStudyImage } from './study-media.js';

// Parser and math renderer are bundled locally. MathML avoids a font/CDN
// dependency and uses the host browser's native math layout.
/** `mathRules` replace how the formula tokens (math_inline, math_inline_double, math_block, math_block_eqno) are written out. */
export function createMarkdown(mathRules = {}) {
  const md = new MarkdownIt({ html: false, linkify: true, breaks: true })
    .use(texmath, { engine: katex, delimiters: "dollars",
      katexOptions: { output: "mathml", throwOnError: false } });
  Object.assign(md.renderer.rules, mathRules);
  const renderImage = md.renderer.rules.image;
  md.renderer.rules.image = (tokens, index, options, env, self) => {
    const token = tokens[index], src = safeStudyImage(token.attrGet('src'));
    if (!src) return md.utils.escapeHtml(token.content);
    token.attrSet('src', src); token.attrSet('loading', 'lazy'); token.attrSet('referrerpolicy', 'no-referrer');
    const caption = env?.imageCaptions !== false && token.content ? '<span class="md-image-caption">' + md.utils.escapeHtml(token.content) + '</span>' : '';
    return '<span class="md-image md-image-static">' + renderImage(tokens, index, options, env, self) + caption + '</span>';
  };
  return md;
}

const renderer = createMarkdown();
export const renderNoteMarkdown = (source, options = {}) => renderer.render(String(source || ""), options);
