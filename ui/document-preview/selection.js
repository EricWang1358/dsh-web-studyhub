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

/** Capture before a toolbar takes focus. Only the caller's own preview can supply selection. */
export function captureSelection(container, selection = window.getSelection()) {
  if (!selection?.rangeCount || selection.isCollapsed) return null;
  const range = selection.getRangeAt(0);
  if (container && (!container.contains(range.startContainer) || !container.contains(range.endContainer))) return null;
  const quote = range.toString();
  if (!quote.trim()) return null;
  const textOwner = range.startContainer.parentElement?.closest('[data-study-text]');
  const owner = textOwner?.contains(range.endContainer) ? textOwner : container || (range.commonAncestorContainer.nodeType === 1 ? range.commonAncestorContainer : range.commonAncestorContainer.parentElement);
  if (!owner) return null;
  const before = range.cloneRange(), after = range.cloneRange();
  before.selectNodeContents(owner); before.setEnd(range.startContainer, range.startOffset);
  after.selectNodeContents(owner); after.setStart(range.endContainer, range.endOffset);
  const pageElement = range.startContainer.parentElement?.closest('[data-study-page]');
  return { quote, prefix: before.toString().slice(-80), suffix: after.toString().slice(0, 80),
    ...(pageElement ? { page: Number(pageElement.dataset.studyPage), sourceId: pageElement.dataset.studySource } : {}), range: range.cloneRange(), element: owner };
}

/** Add ephemeral passage marks to a renderer owned by this component. */
export function renderedPassageRange(container, selection) {
  if (!container) return null;
  const pages = [...container.querySelectorAll('[data-study-source]')];
  const passageContainer = pages.find(page => page.dataset.studySource === selection.sourceId) || container;
  const walker = container.ownerDocument.createTreeWalker(passageContainer, 4), nodes = [];
  let text = '', node;
  while ((node = walker.nextNode())) {
    if (node.parentElement?.closest('[data-study-marker]')) continue;
    nodes.push({ node, start: text.length }); text += node.textContent;
  }
  const hit = locateVisibleQuote(text, selection);
  if (hit.status !== 'resolved') return null;
  const first = nodes.find(({ node, start }) => start <= hit.start && start + node.textContent.length > hit.start);
  const last = nodes.find(({ node, start }) => start < hit.end && start + node.textContent.length >= hit.end);
  if (!first || !last) return null;
  const range = container.ownerDocument.createRange();
  range.setStart(first.node, hit.start - first.start); range.setEnd(last.node, hit.end - last.start);
  return range;
}

export function annotatePassages(container, groups, onOpen) {
  if (!container) return () => {};
  const markers = [];
  for (const [index, group] of groups.entries()) {
    if (!group.selection?.quote || group.links.every(link => link.status === 'stale' || link.status === 'missing')) continue;
    const range = renderedPassageRange(container, group.selection);
    if (!range) continue;
    range.collapse(false);
    const marker = container.ownerDocument.createElement('sup'), button = container.ownerDocument.createElement('button');
    marker.className = 'study-passage-mark'; marker.dataset.studyMarker = 'true';
    button.type = 'button'; button.textContent = `[${group.number || index + 1}]`; button.title = `${group.links.length} 道相关题目与解析`;
    button.addEventListener('click', () => onOpen(group)); marker.append(button); range.insertNode(marker); markers.push(marker);
  }
  return () => { markers.forEach(marker => marker.remove()); container.normalize(); };
}
