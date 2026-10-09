import { spanFormulas } from './reader/formula.js';
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
  if (!capture?.quote?.trim()) return null;
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

/**
 * The selected text and what surrounds it inside `owner`, without the text of the marks the reader adds (data-study-marker:
 * the [n] passage marks, the 译 marks and the translation blocks), so a selection that crosses one still quotes the document.
 * null when the walk finds none of the selection (a boundary outside `owner`).
 */
function selectionTexts(owner, range) {
  const walker = owner.ownerDocument.createTreeWalker(owner, 1 | 4, { acceptNode: node => node.nodeType === 3 ? 1 : node.hasAttribute?.('data-study-marker') ? 2 : 3 });
  let before = '', quote = '', after = '', node;
  while ((node = walker.nextNode())) {
    const data = node.data, starts = node === range.startContainer, ends = node === range.endContainer;
    if (starts && ends) { before = (before + data.slice(0, range.startOffset)).slice(-80); quote += data.slice(range.startOffset, range.endOffset); after += data.slice(range.endOffset); }
    else if (starts) { before = (before + data.slice(0, range.startOffset)).slice(-80); quote += data.slice(range.startOffset); }
    else if (ends) { quote += data.slice(0, range.endOffset); after += data.slice(range.endOffset); }
    else {
      const side = range.comparePoint(node, 0);
      if (side < 0) before = (before + data).slice(-80); else if (side > 0) after += data; else quote += data;
    }
    if (after.length >= 80) break;
  }
  return quote ? { quote, prefix: before, suffix: after.slice(0, 80) } : null;
}

/** Capture before a toolbar takes focus. Only the caller's own preview can supply selection. */
export function captureSelection(container, selection = window.getSelection()) {
  if (!selection?.rangeCount || selection.isCollapsed) return null;
  const range = selection.getRangeAt(0);
  if (container && (!container.contains(range.startContainer) || !container.contains(range.endContainer))) return null;
  // A formula is quoted whole: a selection that starts or ends inside a drawn one is widened, on screen too.
  if (spanFormulas(range)) { selection.removeAllRanges(); selection.addRange(range); }
  // A translation block (data-tr-key) is not the document: text selected inside one is never a passage of it.
  if (range.startContainer.parentElement?.closest('[data-tr-key]') || range.endContainer.parentElement?.closest('[data-tr-key]')) return null;
  const quote = range.toString();
  if (!quote.trim()) return null;
  const textOwner = range.startContainer.parentElement?.closest('[data-study-text]');
  const owner = textOwner?.contains(range.endContainer) ? textOwner : container || (range.commonAncestorContainer.nodeType === 1 ? range.commonAncestorContainer : range.commonAncestorContainer.parentElement);
  if (!owner) return null;
  const texts = selectionTexts(owner, range);
  if (texts && !texts.quote.trim()) return null;
  const before = range.cloneRange(), after = range.cloneRange();
  if (!texts) { before.selectNodeContents(owner); before.setEnd(range.startContainer, range.startOffset); after.selectNodeContents(owner); after.setStart(range.endContainer, range.endOffset); }
  const pageElement = range.startContainer.parentElement?.closest('[data-study-page]');
  return { quote: texts?.quote ?? quote, prefix: texts ? texts.prefix : before.toString().slice(-80), suffix: texts ? texts.suffix : after.toString().slice(0, 80),
    ...(pageElement ? { page: Number(pageElement.dataset.studyPage), sourceId: pageElement.dataset.studySource } : {}), range: range.cloneRange(), element: owner };
}

/** The text the reader draws for one source (the page of a paged document, else all of it), without its own marks and without translation blocks, and the text nodes it came from. */
function renderedText(container, sourceId) {
  const pages = [...container.querySelectorAll('[data-study-source]')];
  const passageContainer = pages.find(page => page.dataset.studySource === sourceId) || container;
  const walker = container.ownerDocument.createTreeWalker(passageContainer, 4), nodes = [];
  let text = '', node;
  while ((node = walker.nextNode())) {
    if (node.parentElement?.closest('[data-study-marker], [data-tr-key]')) continue;
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
    button.type = 'button'; button.textContent = `[${group.number || index + 1}]`; button.title = title(group.links.length);
    button.addEventListener('click', () => onOpen(group)); marker.append(button); range.insertNode(marker); markers.push(marker);
  }
  return () => { markers.forEach(marker => marker.remove()); container.normalize(); };
}
