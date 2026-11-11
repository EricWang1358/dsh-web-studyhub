import { spanFormulas } from './reader/formula-range.js';
import { createLocator } from '../../lib/quote-locate.js';

/** A quote without a verified position never silently chooses its first occurrence. */
export function locateQuote(text, quote, anchor = {}) {
  if (!quote) return { status: 'missing' };
  if (Number.isInteger(anchor.start)) {
    if (text.slice(anchor.start, anchor.start + quote.length) === quote)
      return { status: 'resolved', start: anchor.start, end: anchor.start + quote.length };
    return { status: text.includes(quote) ? 'stale' : 'missing' };
  }
  const positions = [];
  for (let start = text.indexOf(quote); start >= 0; start = text.indexOf(quote, start + 1)) {
    if (anchor.prefix && !text.slice(0, start).endsWith(anchor.prefix)) continue;
    if (anchor.suffix && !text.slice(start + quote.length).startsWith(anchor.suffix)) continue;
    positions.push(start);
  }
  if (!positions.length) return { status: 'missing' };
  if (positions.length > 1) return { status: 'ambiguous' };
  return { status: 'resolved', start: positions[0], end: positions[0] + quote.length };
}

/**
 * The second chance for a quote the strict search did not find. A citation is checked by its letters and digits only (lib/quote-match.js), so one
 * that passed can differ from the text by hyphenation, markup, full / half width or an elision; the shared locator (lib/quote-locate.js) reads it
 * the same way. Resolved as { status: 'fuzzy', start, end, quote } where `quote` is the text's own words between the offsets; a quote that
 * matches in two places is 'ambiguous' (never silently the first one), one that matches nowhere 'missing'.
 */
export function locateFuzzy(text, quote) {
  const first = createLocator(text)(quote);
  if (!first) return { status: 'missing' };
  if (createLocator(text.slice(first.end))(quote)) return { status: 'ambiguous' };
  return { status: 'fuzzy', start: first.start, end: first.end, quote: text.slice(first.start, first.end) };
}

/** locateQuote, then locateFuzzy when the quote is not in the text as written. */
export function resolveQuote(text, quote, anchor = {}) {
  const strict = locateQuote(text, quote, anchor);
  return strict.status === 'missing' && quote ? locateFuzzy(text, quote) : strict;
}

/** A quote that has a place in the text (as written or by its letters), so the reader scrolls to it and not to the page it is on. */
export const isPlaced = status => status === 'resolved' || status === 'fuzzy';

/** Renderer whitespace differs from source projection separators; map only a unique contextual match. */
export function locateVisibleQuote(text, anchor) {
  const compact = value => String(value || '').replace(/\s/g, '');
  const map = [], characters = [];
  for (let index = 0; index < text.length; index++) {
    if (!/\s/.test(text[index])) { map.push(index); characters.push(text[index]); }
  }
  const hit = locateQuote(characters.join(''), compact(anchor.quote), { prefix: compact(anchor.prefix), suffix: compact(anchor.suffix) });
  return hit.status === 'resolved' ? { status: 'resolved', start: map[hit.start], end: map[hit.end - 1] + 1 } : hit;
}

export function selectionRequest(document, capture) {
  if (!capture?.quote?.trim() || capture.crossPage) return null;
  return { ...(document?.documentId || document?.id ? { documentId: document.documentId || document.id } : {}),
    ...(document?.revision ? { revision: document.revision } : {}),
    ...(capture.sourceId || document?.sourceId ? { sourceId: capture.sourceId || document.sourceId } : {}),
    quote: capture.quote, prefix: capture.prefix || '', suffix: capture.suffix || '',
    ...(Number.isInteger(capture.start) ? { start: capture.start, end: capture.end } : {}),
    ...(capture.page ? { page: capture.page } : {}) };
}

/** Mirrors DSH's public resource address format, without loading another host React bundle. */
export function sessionFileAddress(sessionId, path) {
  const segment = value => encodeURIComponent(value).replace(/%3A/gi, ':');
  return `dsh-resource://file/session/${segment(sessionId)}/${String(path).replace(/\\/g, '/').replace(/^(?:\.\/)+/, '').split('/').map(segment).join('/')}`;
}

export function groupPassageLinks(links = []) {
  const groups = new Map();
  for (const link of links) {
    const s = link.selection || {}, key = JSON.stringify([s.documentId, s.revision, s.sourceId, s.start, s.end, s.quote]);
    if (!groups.has(key)) groups.set(key, { selection: s, links: [] });
    groups.get(key).links.push(link);
  }
  return [...groups.values()].map((group, index) => ({ ...group, number: index + 1 }));
}

const elementOf = node => (node?.nodeType === 1 ? node : node?.parentElement);
const BLOCK_SELECTOR = 'p, h1, h2, h3, h4, h5, h6, li, blockquote, pre, tr, div, section, article, aside, header, footer, figure, figcaption, dt, dd, hr';
const CELL_SELECTOR = 'td, th';
const isSkippedElement = node => node.hasAttribute?.('data-study-marker') || node.hasAttribute?.('data-tr-key')
  || node.hasAttribute?.('data-find-skip') || node.classList?.contains?.('reader-section__label') || node.classList?.contains?.('md-image-caption');
const isLineBreak = node => node.nodeType === 1 && (node.nodeName === 'BR' || node.tagName === 'br');

/**
 * The selected text and what surrounds it inside `owner`, without the text of the marks or UI labels the reader adds
 * (data-study-marker, data-tr-key, data-find-skip, .reader-section__label), keeping block, cell and <br> boundaries as
 * line/tab breaks so multi-paragraph selections preserve line breaks and verify against the stored projection.
 */
function selectionTexts(owner, range) {
  const walker = owner.ownerDocument.createTreeWalker(owner, 1 | 4, {
    acceptNode: node => {
      if (node.nodeType === 3) return 1;
      if (isSkippedElement(node)) return 2;
      return isLineBreak(node) ? 1 : 3;
    },
  });
  let before = '', quote = '', after = '', quoteBlock = null, quoteCell = null, firstNode = null, lastNode = null, afterBr = false, node;
  const appendQuote = (text, current) => {
    if (!text) return;
    let piece = text;
    if (afterBr && piece.startsWith('\n')) piece = piece.slice(1);
    afterBr = false;
    if (!piece) return;
    const parent = current.parentElement;
    const block = parent?.closest?.(BLOCK_SELECTOR) ?? null, cell = parent?.closest?.(CELL_SELECTOR) ?? null;
    if (quote && !piece.startsWith('\n')) {
      if (quoteBlock && block && quoteBlock !== block) {
        if (!/\n[ \t]*$/.test(quote)) quote = `${quote.replace(/[ \t]+$/, '')}\n`;
      } else if (quoteCell && cell && quoteCell !== cell && !/\s$/.test(quote) && !/^\s/.test(piece)) {
        quote += '\t';
      }
    }
    quote += piece;
    if (piece.trim()) {
      quoteBlock = block; quoteCell = cell;
      if (!firstNode) firstNode = current;
      lastNode = current;
    }
  };
  while ((node = walker.nextNode())) {
    if (node.nodeType === 1) {
      if (!(node === range.endContainer && range.endOffset === 0) && range.comparePoint?.(node, 0) === 0) {
        if (quote && !quote.endsWith('\n')) quote += '\n';
        afterBr = true;
      }
      continue;
    }
    const data = node.data, starts = node === range.startContainer, ends = node === range.endContainer;
    if (starts && ends) { before = (before + data.slice(0, range.startOffset)).slice(-80); appendQuote(data.slice(range.startOffset, range.endOffset), node); after += data.slice(range.endOffset); }
    else if (starts) { before = (before + data.slice(0, range.startOffset)).slice(-80); appendQuote(data.slice(range.startOffset), node); }
    else if (ends) { appendQuote(data.slice(0, range.endOffset), node); after += data.slice(range.endOffset); }
    else {
      const side = range.comparePoint(node, 0);
      if (side < 0) before = (before + data).slice(-80); else if (side > 0) after += data; else appendQuote(data, node);
    }
    if (after.length >= 80) break;
  }
  return quote ? { quote, prefix: before, suffix: after.slice(0, 80), firstNode, lastNode } : null;
}

/** Capture before a toolbar takes focus. Only the caller's own preview can supply selection. */
export function captureSelection(container, selection = window.getSelection()) {
  if (!selection?.rangeCount || selection.isCollapsed) return null;
  const range = selection.getRangeAt(0);
  if (container && (!container.contains(range.startContainer) || !container.contains(range.endContainer))) return null;
  // A formula is quoted whole: a selection that starts or ends inside a drawn one is widened, on screen too.
  if (spanFormulas(range)) { selection.removeAllRanges(); selection.addRange(range); }
  const startElement = elementOf(range.startContainer), endElement = elementOf(range.endContainer);
  // A translation block (data-tr-key) is not the document: text selected inside one is never a passage of it.
  if (startElement?.closest?.('[data-tr-key]') || endElement?.closest?.('[data-tr-key]')) return null;
  const quote = range.toString();
  if (!quote.trim()) return null;
  const textOwner = startElement?.closest?.('[data-study-text]'), pageOwner = startElement?.closest?.('[data-study-page]');
  const owner = textOwner?.contains?.(range.endContainer) ? textOwner
    : pageOwner?.contains?.(range.endContainer) ? pageOwner
    : container || elementOf(range.commonAncestorContainer);
  if (!owner) return null;
  let texts = selectionTexts(owner, range);
  if (texts && !texts.quote.trim()) return null;
  if (!texts && owner.contains?.(range.startContainer) && owner.contains?.(range.endContainer)) return null;
  const startPage = elementOf(texts?.firstNode)?.closest?.('[data-study-page]') || pageOwner;
  const endPage = elementOf(texts?.lastNode)?.closest?.('[data-study-page]') || endElement?.closest?.('[data-study-page]');
  if (texts && startPage && (!endPage || startPage === endPage) && owner !== startPage && !startPage.contains?.(owner)) {
    texts = selectionTexts(startPage, range) || texts;
  }
  const crossPage = !!(startPage?.dataset?.studySource && endPage?.dataset?.studySource && startPage.dataset.studySource !== endPage.dataset.studySource);
  const before = range.cloneRange(), after = range.cloneRange();
  if (!texts) { before.selectNodeContents(owner); before.setEnd(range.startContainer, range.startOffset); after.selectNodeContents(owner); after.setStart(range.endContainer, range.endOffset); }
  return { quote: texts?.quote ?? quote, prefix: texts ? texts.prefix : before.toString().slice(-80), suffix: texts ? texts.suffix : after.toString().slice(0, 80),
    ...(startPage?.dataset ? { page: Number(startPage.dataset.studyPage), sourceId: startPage.dataset.studySource } : {}),
    ...(crossPage ? { crossPage: true } : {}), range: range.cloneRange(), element: startPage && !crossPage && !startPage.contains?.(owner) ? startPage : owner };
}

/** The text the reader draws for one source (the page of a paged document, else all of it), without its own marks and without translation blocks, and the text nodes it came from. */
function renderedText(container, sourceId) {
  const pages = [...container.querySelectorAll('[data-study-source]')];
  const passageContainer = pages.find(page => page.dataset.studySource === sourceId) || container;
  const walker = container.ownerDocument.createTreeWalker(passageContainer, 4), nodes = [];
  let text = '', node;
  while ((node = walker.nextNode())) {
    if (node.parentElement?.closest('[data-study-marker], [data-tr-key], [data-find-skip], .reader-section__label')) continue;
    nodes.push({ node, start: text.length }); text += node.textContent;
  }
  return { text, nodes };
}

/** The DOM range of [hit.start, hit.end) of a rendered text. */
function rangeOf(container, nodes, hit) {
  const first = nodes.find(({ node, start }) => start <= hit.start && start + node.textContent.length > hit.start);
  const last = nodes.find(({ node, start }) => start < hit.end && start + node.textContent.length >= hit.end);
  if (!first || !last) return null;
  const range = container.ownerDocument.createRange();
  range.setStart(first.node, hit.start - first.start); range.setEnd(last.node, hit.end - last.start);
  spanFormulas(range); // a [n] mark goes after a formula, never into its hidden source
  return range;
}

/** Add ephemeral passage marks to a renderer owned by this component. */
export function renderedPassageRange(container, selection) {
  if (!container) return null;
  const { text, nodes } = renderedText(container, selection.sourceId), hit = locateVisibleQuote(text, selection);
  return hit.status === 'resolved' ? rangeOf(container, nodes, hit) : null;
}

/**
 * The fuzzy way to the same place (locateFuzzy on what is drawn, once): { status: 'fuzzy', range, quote } with the text's own words as `quote`,
 * 'ambiguous' when the quote is in two places, 'missing' when it is in none or the drawn text is not there.
 */
export function fuzzyPassageRange(container, selection) {
  if (!container) return { status: 'missing' };
  const { text, nodes } = renderedText(container, selection.sourceId), hit = locateFuzzy(text, selection.quote);
  if (hit.status !== 'fuzzy') return { status: hit.status };
  const range = rangeOf(container, nodes, hit);
  return range ? { status: 'fuzzy', range, quote: hit.quote } : { status: 'missing' };
}

export function annotatePassages(container, groups, onOpen, title = count => `${count} 道相关题目与解析`) {
  if (!container) return () => {};
  const markers = [];
  for (const [index, group] of groups.entries()) {
    if (!group.selection?.quote || group.links.every(link => link.status === 'stale' || link.status === 'missing')) continue;
    const range = renderedPassageRange(container, group.selection);
    if (!range) continue;
    range.collapse(false);
    const marker = container.ownerDocument.createElement('sup'), button = container.ownerDocument.createElement('button');
    marker.className = 'study-passage-mark'; marker.dataset.studyMarker = 'true';
    button.type = 'button'; button.className = 'study-passage-mark__btn'; button.textContent = `[${group.number || index + 1}]`; button.title = title(group.links.length);
    button.addEventListener('click', () => onOpen(group)); marker.append(button); range.insertNode(marker); markers.push(marker);
  }
  return () => { markers.forEach(marker => marker.remove()); container.normalize(); };
}
