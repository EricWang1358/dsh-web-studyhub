/* The bilingual reading in the DOM of the reader (translation/*): which elements are paragraphs, their text without the
   marks the reader adds, and the small nodes this layer adds next to them. Everything added carries data-study-marker, the
   skip rule that find, the link underlines, the outline and the selection capture already follow, so no stored character,
   data-study-* attribute or selection is changed by it. Needs a DOM; the pure rules are lib/passage-translation.js and model.js. */

const MARKER = '[data-study-marker]';
/** The blocks of rendered Markdown / HTML that are a paragraph of their own. */
export const BLOCK_SELECTOR = 'p, li, h1, h2, h3, h4, h5, h6, blockquote, dt, dd, figcaption';
const SHOW_ELEMENT_OR_TEXT = 1 | 4, ACCEPT = 1, SKIP = 3, REJECT = 2;

/** A tree walker over the text of `root` that never enters a marked subtree (a [n] mark, a 译 mark, a translation block). */
export function textWalker(root) {
  return root.ownerDocument.createTreeWalker(root, SHOW_ELEMENT_OR_TEXT, { acceptNode: node => node.nodeType === 3 ? ACCEPT : node.hasAttribute?.('data-study-marker') ? REJECT : SKIP });
}

/** The text of an element as the document wrote it: no [n] marks, no 译 marks, no translation blocks inside it. */
export function visibleText(element) {
  const walker = textWalker(element);
  let text = '', node;
  while ((node = walker.nextNode())) text += node.data;
  return text;
}

/**
 * The paragraphs of what the reader has drawn, in reading order: [{ element, sourceId, text }]. Text sources draw one
 * `.reader-p` per paragraph (layout blocks such as tables kept in monospace are not prose); Markdown and HTML draw blocks, of
 * which only the innermost are paragraphs (a list item with a paragraph inside is that paragraph) and code and tables are left out.
 */
export function scanParagraphs(body, fallbackSourceId) {
  if (!body) return [];
  const prose = [...body.querySelectorAll('.reader-prose > .reader-p:not(.reader-p--layout)')];
  const html = [...body.querySelectorAll('.reader-html')].flatMap(root => [...root.querySelectorAll(BLOCK_SELECTOR)]
    .filter(element => !element.querySelector(BLOCK_SELECTOR) && !element.closest(`pre, table, ${MARKER}`)));
  const found = [];
  for (const element of [...prose, ...html]) {
    const text = visibleText(element);
    if (!text.trim()) continue;
    found.push({ element, sourceId: element.closest('[data-study-source]')?.dataset.studySource || fallbackSourceId, text });
  }
  return found;
}

/** The nearest scanned paragraph at or above a node. */
export function paragraphAround(node, elements) {
  for (let at = node?.nodeType === 1 ? node : node?.parentElement; at; at = at.parentElement) if (elements.has(at)) return at;
  return null;
}

/** The inline 译 button at the end of a paragraph. Its glyph is drawn by CSS from data-label, so it is no text of the paragraph. */
export function createMark(doc, { label, title }) {
  const wrap = doc.createElement('span'), button = doc.createElement('button');
  wrap.className = 'tr-mark'; wrap.dataset.studyMarker = 'true';
  button.type = 'button'; button.className = 'tr-mark__btn'; button.tabIndex = -1; button.dataset.trMark = 'true'; button.dataset.label = label;
  button.setAttribute('aria-label', title); button.title = title;
  wrap.append(button);
  return wrap;
}

/** The place a paragraph's translation block is drawn into: a sibling after the paragraph, never inside it. */
export function createHost(doc, key) {
  const host = doc.createElement('div');
  host.className = 'tr-host'; host.dataset.studyMarker = 'true'; host.dataset.trKey = key;
  return host;
}
