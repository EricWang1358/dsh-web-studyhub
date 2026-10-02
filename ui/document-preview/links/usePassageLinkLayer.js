import { useEffect, useRef } from 'react';
import { hitTest, locateGroups, overText, paintLinkHighlights } from './link-ranges.js';
import { supportsHighlights } from '../reader/find.js';

/** Superscript [n] after each linked passage: the keyboard path to its links (Tab, Enter) and a visible anchor. They never hold stored text. */
function insertMarkers(container, entries, open, titleOf) {
  const doc = container.ownerDocument, markers = [];
  for (const { group, range } of entries) {
    const end = range.cloneRange();
    end.collapse(false);
    const marker = doc.createElement('sup'), button = doc.createElement('button'), title = titleOf(group);
    marker.className = 'study-passage-mark'; marker.dataset.studyMarker = 'true'; marker.dataset.kind = group.kind;
    button.type = 'button'; button.textContent = `[${group.number}]`; button.title = title; button.setAttribute('aria-label', title);
    button.addEventListener('click', () => open(group));
    marker.append(button); end.insertNode(marker); markers.push(marker);
  }
  return () => { markers.forEach(marker => marker.remove()); container.normalize(); };
}

const caretAt = (doc, x, y) => {
  const position = doc.caretPositionFromPoint?.(x, y);
  if (position) return [position.offsetNode, position.offset];
  const range = doc.caretRangeFromPoint?.(x, y);
  return range ? [range.startContainer, range.startOffset] : [null, 0];
};

/**
 * The link layer of the reader (owner request, 2.3.2). `groups` are the passages that can be underlined
 * (buildLinkModel(...).groups); `rendered` changes whenever the rendered text does. Ranges are located once per
 * change of either, never on render or scroll, and kept in a ref: toggling `underline` only paints or clears them.
 * Nothing here sets state; the click handler calls `onOpen(group)`.
 *
 * - [n] markers stay whatever `underline` says: they are the keyboard path to a passage's links.
 * - Underlines are Custom Highlight API ranges, so the text and every stored character stay exactly as they were.
 * - A click or tap on underlined text (not a drag that selects) opens its links; hovering shows what is linked.
 */
export function usePassageLinkLayer({ body, groups, rendered, underline, onOpen, titleOf }) {
  const located = useRef([]), latest = useRef({ onOpen, titleOf });
  useEffect(() => { latest.current = { onOpen, titleOf }; });

  // 1. Where the passages are, and their markers.
  useEffect(() => {
    const container = body.current;
    located.current = [];
    if (!container || !groups.length) return undefined;
    located.current = locateGroups(container, groups);
    const removeMarkers = insertMarkers(container, located.current, group => latest.current.onOpen(group), group => latest.current.titleOf(group));
    return () => { located.current = []; removeMarkers(); };
  }, [body, groups, rendered]);

  // 2. The underlines and the pointer, from the cached ranges; runs again after (1) whenever it did.
  useEffect(() => {
    const container = body.current;
    // Without the Custom Highlight API there is nothing to see, so nothing to hover or click: the [n] markers remain.
    if (!underline || !container || !located.current.length || !supportsHighlights()) return undefined;
    const clear = paintLinkHighlights(located.current), doc = container.ownerDocument;
    const under = event => {
      const [node, offset] = caretAt(doc, event.clientX, event.clientY);
      return hitTest(located.current, node, offset).filter(entry => overText(entry.range, event.clientX, event.clientY));
    };
    let frame = 0, shown = '';
    const hover = event => {
      if (frame) return;
      const { clientX, clientY } = event;
      frame = requestAnimationFrame(() => {
        frame = 0;
        const [first] = under({ clientX, clientY }), title = first ? latest.current.titleOf(first.group) : '';
        if (title === shown) return;
        shown = title;
        if (title) { container.title = title; container.dataset.linkHover = 'true'; } else { container.removeAttribute('title'); delete container.dataset.linkHover; }
      });
    };
    const click = event => {
      if (event.defaultPrevented || event.button !== 0 || event.shiftKey || event.metaKey || event.ctrlKey || event.altKey) return;
      if (event.target.closest?.('button, a, summary, input, textarea, select, [data-study-marker]')) return;
      if (!doc.defaultView?.getSelection?.()?.isCollapsed) return;
      const [first] = under(event);
      if (first) latest.current.onOpen(first.group);
    };
    const leave = () => { shown = ''; container.removeAttribute('title'); delete container.dataset.linkHover; };
    container.addEventListener('click', click);
    container.addEventListener('pointermove', hover);
    container.addEventListener('pointerleave', leave);
    return () => {
      clear();
      if (frame) cancelAnimationFrame(frame);
      container.removeEventListener('click', click);
      container.removeEventListener('pointermove', hover);
      container.removeEventListener('pointerleave', leave);
      leave();
    };
  }, [body, groups, rendered, underline]);
}
