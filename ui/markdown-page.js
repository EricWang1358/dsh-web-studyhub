import { createMarkdown } from './note-markdown.js';
import { renderStudyFormula } from './study-math-render.js';
import { esc, withoutNamespace } from './static-page.js';

/* Markdown as the BODY of one self-contained static page (#896): the part every page the app saves as a file from Markdown shares (the whole review book,
   ui/book/book-html.js; the pocket review page, #887). Pure, no React, no script, no address: the page it builds names none.

   The note renderer (ui/note-markdown.js createMarkdown) draws the text and, through the app's formula unit, maths as MathML. It has no footnotes and no
   heading anchors, so two small rules are written here:
     - footnotes, Pandoc's `[^label]` marks and `[^label]: text` definitions: a mark is a numbered reference with a back-link; the definitions are taken
       out of the text and stand at the END OF THEIR CHAPTER, numbered from 1 again in each chapter, in the order the chapter mentions them. A definition
       no mark points at is left out, and a mark without a definition is dropped (never shown as `[^…]`);
     - heading anchors, `## Title {#id}`: the element's id, the marker text gone. A heading without one is given an id, so the contents can link to it.
   A chapter is a heading of `chapterLevel` (2) or above it; the heading of exactly that level is marked `class="chapter"` (the print rules start a page
   there). Links: only a link to a place in the page (`#id`) stays a link; any other is its words, and an address is written out after them. Images: a
   picture that is part of the text (data:) stays, any other is its words. Raw HTML is text.

   renderMarkdown(markdown, { chapterLevel = 2, footnotesLabel = '', backLabel = '', isFootnoteLabel, dropTitle = false }) -> { html, headings, title }
     footnotesLabel: the title over each chapter's footnotes; backLabel: the words a screen reader says for a footnote's back-link.
     headings: [{ id, level, text }] in order; title: the text of the first heading of level 1 ('' when none), left out of `html` with `dropTitle`.
     isFootnoteLabel(markdown of a paragraph): a paragraph that only announces the definitions that follow it (the book's 出处 line) goes with them.
   contentsList(headings, { label, level = 2 }) -> the contents as a <nav> list of links to the headings of that level ('' when none). */

const DEFINITION = /^\[\^([\w-]{1,44})\]:[ \t]*(.*)$/;
const MARK = /^\[\^([\w-]{1,44})\]/;
const ANCHOR = /\s*\{#([^\s{}]+)\}\s*$/;
const BACK = '↩︎';

const footnotesOf = env => (env.footnotes ??= { defs: new Map(), chapters: new Map() });

/** `[^label]: text`, and the lines indented under it: taken out of the text, kept in env. A silent token marks the place (for the label paragraph before it). */
function definitionRule(state, startLine, endLine, silent) {
  if (state.sCount[startLine] - state.blkIndent >= 4) return false;
  const line = at => state.src.slice(state.bMarks[at] + state.tShift[at], state.eMarks[at]);
  const found = DEFINITION.exec(line(startLine));
  if (!found) return false;
  if (silent) return true;
  const lines = [found[2]];
  let next = startLine + 1;
  for (; next < endLine && !state.isEmpty(next) && state.sCount[next] - state.blkIndent >= 4; next++) lines.push(line(next));
  const { defs } = footnotesOf(state.env);
  if (!defs.has(found[1])) defs.set(found[1], lines.join('\n').trim());
  state.line = next;
  const token = state.push('footnote_def', '', 0);
  token.hidden = true; token.meta = { label: found[1] }; token.map = [startLine, next];
  return true;
}

function markRule(state, silent) {
  if (state.src.charCodeAt(state.pos) !== 0x5B || state.src.charCodeAt(state.pos + 1) !== 0x5E) return false;
  const found = MARK.exec(state.src.slice(state.pos));
  if (!found) return false;
  if (!silent) {
    const token = state.push('footnote_ref', '', 0);
    // A mark without a definition is consumed and shows nothing: `defined` tells the placing rule to leave it out.
    token.meta = { label: found[1], defined: footnotesOf(state.env).defs.has(found[1]) };
  }
  state.pos += found[0].length;
  return true;
}

const isHeading = (token, level) => token.type === 'heading_open' && token.level === 0 && Number(token.tag.slice(1)) <= level;

/** After the block rules: the definitions out (and the label paragraph in front of them), and a silent list token where each chapter ends. */
function gatherRule(options) {
  return state => {
    const { tokens } = state, out = [];
    for (const token of tokens) {
      if (token.type === 'footnote_def') {
        const [open, inline, close] = out.slice(-3);
        if (options.isFootnoteLabel && close?.type === 'paragraph_close' && inline?.type === 'inline' && open?.type === 'paragraph_open' && options.isFootnoteLabel(inline.content.trim())) out.length -= 3;
        continue;
      }
      if (isHeading(token, options.chapterLevel) && out.length) out.push(Object.assign(new state.Token('footnote_list', '', 0), { hidden: true }));
      out.push(token);
    }
    out.push(Object.assign(new state.Token('footnote_list', '', 0), { hidden: true }));
    state.tokens = out;
  };
}

/** After the inline rule: the marks numbered per chapter, and each chapter's footnotes put where its silent list token stands. */
function placeRule(options) {
  return state => {
    const { defs, chapters } = footnotesOf(state.env), out = [];
    let chapter = new Map();
    // A footnote marked in several chapters stands in each of them; its ids are told apart by how many chapters had it before.
    const uidOf = label => { const before = chapters.get(label) ?? 0; chapters.set(label, before + 1); return before ? `${label}-c${before + 1}` : label; };
    const listOf = () => {
      const tokens = [];
      const open = new state.Token('footnote_block_open', '', 1);
      open.meta = { label: options.footnotesLabel };
      tokens.push(open);
      for (const [label, note] of chapter) {
        const item = new state.Token('footnote_open', '', 1), inline = new state.Token('inline', '', 0), close = new state.Token('footnote_close', '', -1);
        item.meta = close.meta = { uid: note.uid, marks: note.marks };
        inline.content = defs.get(label); inline.children = [];
        state.md.inline.parse(inline.content, state.md, state.env, inline.children);
        // A mark inside a definition has no number of its own: it is dropped.
        inline.children = inline.children.filter(child => child.type !== 'footnote_ref');
        tokens.push(item, inline, close);
      }
      tokens.push(new state.Token('footnote_block_close', '', -1));
      return tokens;
    };
    for (const token of state.tokens) {
      if (token.type === 'footnote_list') {
        if (chapter.size) out.push(...listOf());
        chapter = new Map();
        continue;
      }
      if (token.type === 'inline') {
        token.children = token.children.filter(child => {
          if (child.type !== 'footnote_ref') return true;
          if (!child.meta.defined) return false;
          const { label } = child.meta, note = chapter.get(label) ?? { number: chapter.size + 1, marks: 0, uid: uidOf(label) };
          chapter.set(label, note);
          note.marks += 1;
          child.meta = { uid: note.uid, number: note.number, mark: note.marks };
          return true;
        });
      }
      out.push(token);
    }
    state.tokens = out;
  };
}

/** The plain words of an inline token's children (for the contents). */
const plainOf = children => (children || []).map(child => {
  if (child.type === 'softbreak' || child.type === 'hardbreak') return ' ';
  if (child.type === 'image') return plainOf(child.children);
  return ['text', 'code_inline', 'math_inline', 'math_inline_double'].includes(child.type) ? child.content : '';
}).join('').replace(/\s+/g, ' ').trim();

/** `{#id}` at the end of a heading is its id; every heading gets one (a made-up one when the text wrote none), each id once on the page. */
function headingRule(options) {
  return state => {
    const written = new Map(), used = new Set(), headings = [], out = [];
    state.tokens.forEach((token, at) => {
      if (token.type !== 'heading_open') return;
      const last = state.tokens[at + 1].children.at(-1), found = last?.type === 'text' ? ANCHOR.exec(last.content) : null;
      if (found) written.set(token, found[1]);
    });
    const taken = new Set(written.values());
    const assign = (wanted, n) => {
      if (wanted && !used.has(wanted)) { used.add(wanted); return wanted; }
      // A repeated id or none at all: never one the text writes somewhere else.
      const base = wanted ?? `section-${n}`;
      let id = base, k = 1;
      while (used.has(id) || taken.has(id)) id = `${base}-${++k}`;
      used.add(id);
      return id;
    };
    let n = 0, titled = false, skip = 0;
    state.tokens.forEach((token, at) => {
      if (skip > 0) { skip -= 1; return; }
      if (token.type !== 'heading_open') { out.push(token); return; }
      const inline = state.tokens[at + 1], wanted = written.get(token);
      if (wanted) { const last = inline.children.at(-1); last.content = last.content.replace(ANCHOR, ''); inline.content = inline.content.replace(ANCHOR, ''); }
      const level = Number(token.tag.slice(1)), id = assign(wanted, ++n);
      headings.push({ id, level, text: plainOf(inline.children) });
      if (level === 1 && !titled && options.dropTitle) { titled = true; skip = 2; return; }
      titled = titled || level === 1;
      token.attrSet('id', id);
      if (token.level === 0 && level === options.chapterLevel) token.attrJoin('class', 'chapter');
      out.push(token);
    });
    state.tokens = out;
    state.env.headings = headings;
  };
}

/** Links and pictures that would reach outside the page become words (see the top of this file). */
function linkRule(state) {
  for (const token of state.tokens) {
    if (token.type !== 'inline') continue;
    let open = null, label = '';
    for (const child of token.children) {
      if (child.type === 'link_open') {
        const href = child.attrGet('href') ?? '';
        if (href.startsWith('#')) continue;
        open = { href }; label = '';
        Object.assign(child, { type: 'text', tag: '', nesting: 0, attrs: null, content: '' });
      } else if (child.type === 'link_close' && open) {
        const shown = /^(?:https?:|mailto:)/i.test(open.href) && label !== open.href;
        Object.assign(child, { type: 'text', tag: '', nesting: 0, content: shown ? ` (${open.href})` : '' });
        open = null;
      } else if (open && child.type === 'text') label += child.content;
    }
  }
}

const mathRules = () => {
  // `box`: what a display formula stands in: a block formula is a block of its own, a $$…$$ inside a line a span that looks like one (a div would end the paragraph).
  const draw = (display, box = 'span', numbered = false) => (tokens, at) => {
    const source = tokens[at].content, drawn = withoutNamespace(renderStudyFormula(source, display));
    const mark = numbered ? `<span class="eqno">(${esc(tokens[at].info)})</span>` : '';
    if (!display) return drawn ? `<span class="math">${drawn}</span>` : `<code>${esc(source)}</code>`;
    return `<${box} class="math-block">${drawn || `<code>${esc(source)}</code>`}${mark}</${box}>${box === 'div' ? '\n' : ''}`;
  };
  return { math_inline: draw(false), math_inline_double: draw(true), math_block: draw(true, 'div'), math_block_eqno: draw(true, 'div', true) };
};

function markdownOf(options) {
  const md = createMarkdown(mathRules());
  md.block.ruler.before('reference', 'footnote_def', definitionRule, { alt: ['paragraph', 'reference'] });
  md.inline.ruler.before('link', 'footnote_ref', markRule);
  md.core.ruler.after('block', 'footnote_gather', gatherRule(options));
  md.core.ruler.after('inline', 'footnote_place', placeRule(options));
  md.core.ruler.after('footnote_place', 'heading_anchor', headingRule(options));
  md.core.ruler.after('linkify', 'page_links', linkRule);
  const { rules } = md.renderer, picture = rules.image;
  // Only a picture that is part of the text; the note renderer would let an address through.
  rules.image = (tokens, at, ...rest) => (/^data:/i.test(tokens[at].attrGet('src') ?? '') ? picture(tokens, at, ...rest) : esc(tokens[at].content));
  rules.footnote_ref = (tokens, at) => {
    const { uid, number, mark } = tokens[at].meta, id = mark > 1 ? `fnref-${uid}-${mark}` : `fnref-${uid}`;
    return `<sup class="fnref"><a href="#fn-${esc(uid)}" id="${esc(id)}">${number}</a></sup>`;
  };
  rules.footnote_block_open = (tokens, at) => `<section class="footnotes" role="doc-endnotes">${tokens[at].meta.label ? `<p class="fn-title">${esc(tokens[at].meta.label)}</p>` : ''}<ol>\n`;
  rules.footnote_block_close = () => '</ol></section>\n';
  rules.footnote_open = (tokens, at) => `<li id="fn-${esc(tokens[at].meta.uid)}">`;
  rules.footnote_close = (tokens, at) => {
    const { uid, marks } = tokens[at].meta, named = options.backLabel ? ` aria-label="${esc(options.backLabel)}"` : '';
    return `${Array.from({ length: marks }, (_, k) => ` <a class="fnback" href="#fnref-${esc(uid)}${k ? `-${k + 1}` : ''}"${named}>${BACK}</a>`).join('')}</li>\n`;
  };
  return md;
}

export function renderMarkdown(markdown, { chapterLevel = 2, footnotesLabel = '', backLabel = '', isFootnoteLabel = null, dropTitle = false } = {}) {
  const env = {};
  const html = markdownOf({ chapterLevel, footnotesLabel, backLabel, isFootnoteLabel, dropTitle }).render(String(markdown ?? ''), env);
  const headings = env.headings ?? [];
  return { html, headings, title: headings.find(item => item.level === 1)?.text ?? '' };
}

export function contentsList(headings, { label, level = 2 } = {}) {
  const items = headings.filter(item => item.level === level);
  return items.length ? `<nav class="contents" aria-label="${esc(label)}"><p class="contents-title">${esc(label)}</p><ol>${items.map(item => `<li><a href="#${esc(item.id)}">${esc(item.text)}</a></li>`).join('')}</ol></nav>` : '';
}

/** The style of the rendered body and of its paper: light, one column that bends to the screen, chapters on their own pages, notes kept with their title. */
export const MARKDOWN_CSS = `
h1{margin:0 0 .4rem;font-size:1.6rem;line-height:1.25}
h2{margin:1.8rem 0 .6rem;padding:.3rem .55rem;font-size:1.25rem;line-height:1.3;background:var(--soft);border-left:4px solid var(--ink);break-after:avoid}
h3{margin:1.3rem 0 .4rem;font-size:1.08rem;line-height:1.3;break-after:avoid}
h4,h5,h6{margin:1rem 0 .3rem;font-size:1rem;break-after:avoid}
p{margin:.45rem 0}
ul,ol{margin:.4rem 0;padding-left:1.4rem}
li{margin:.15rem 0}
blockquote{margin:.6rem 0;padding:.1rem .8rem;border-left:3px solid var(--line);color:var(--mute)}
code{font:.92em/1.3 ui-monospace,Consolas,monospace;overflow-wrap:anywhere}
pre{margin:.6rem 0;padding:.5rem .7rem;background:var(--soft);white-space:pre-wrap;overflow-wrap:anywhere}
table{max-width:100%;border-collapse:collapse;font-size:.92em}
th,td{border:1px solid var(--line);padding:.25rem .45rem;text-align:left;vertical-align:top;overflow-wrap:anywhere}
th{background:var(--soft)}
img{max-width:100%;height:auto}
hr{border:0;border-top:1px solid var(--line)}
.math-block{display:block;max-width:100%;margin:.5rem 0;overflow-x:auto}
.math-block math{font-size:1.1em}
.eqno{margin-left:1em;color:var(--mute)}
.fnref{font-size:.75em;line-height:0}
.fnref a{padding:0 .1em}
.footnotes{margin:1.2rem 0 0;padding-top:.5rem;border-top:1px solid var(--line);font-size:.88em;color:var(--mute)}
.fn-title{margin:0 0 .2rem;font-weight:700;color:var(--ink);break-after:avoid}
.footnotes ol{margin:0;padding-left:1.6rem}
.footnotes li{break-inside:avoid;overflow-wrap:anywhere}
.fnback{margin-left:.3em}
.contents{margin:1rem 0 0}
.contents-title{margin:0 0 .3rem;font-weight:700}
.contents ol{margin:0;padding-left:1.4rem}
@page{size:A4;margin:16mm 15mm}
@media print{
  html,body{background:#fff}
  body{padding:0;font-size:10.5pt;line-height:1.4;-webkit-print-color-adjust:exact;print-color-adjust:exact}
  a{color:inherit}
  h2.chapter{break-before:page}
  .contents{break-after:page}
  .footnotes{break-before:avoid}
  tr,figure,.math-block{break-inside:avoid}
}
`;
