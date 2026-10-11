import React, { useCallback, useMemo, useRef } from 'react';
import Markdown from '../Markdown.jsx';
import { bookResolver } from './BookLinks.jsx';
import { citesOf } from './model.js';
import { withoutQaMarkers } from '../../lib/course-book-qa-text.js';
import { shortHash } from '../../lib/course-book-ai-text.js';
import { useAiAnchors } from './ai-anchors.js';
import { plainTerms, withoutNoprintMarkers } from '../../lib/course-book-lookup.js';

/* One file of the review book, or a part of one, as Markdown (ui/book/): its links drawn by the book (BookLinks), its 角标 opening the reader at the 出处
   of the same file, and the words of the AI blocks about it underlined (ui/book/ai-anchors.js). Headings carry their stable id (`book-<id>`): a typed
   one from its `<!-- sh:id … -->`, the target of the 目录 and of the way back after practice. */

/** A typed heading's id from its `<!-- sh:id … -->`: on the element (book-<id>, the 目录's and the way back's target), the marker off the text. */
const ID_SUFFIX = /\s*<!-- sh:id (\S+) -->\s*$/;
export const headingAnchor = text => {
  const match = ID_SUFFIX.exec(text);
  return match ? { text: text.slice(0, match.index), props: { id: `book-${match[1]}`, 'data-book-heading': match[1], tabIndex: -1 } } : null;
};

/** The book's links of a point (handlers: ui/book/BookPage.jsx). */
export const resolverOf = (handlers, hid) => bookResolver({ gone: handlers.gone, onCard: (ref, element) => handlers.card(ref, hid, element),
  onPractice: (heading, n, element) => handlers.practice(heading, n, hid, element), onQa: handlers.toggleQa, qaOpen: handlers.qaOpen, onSource: handlers.source });

/** `citeText`: the whole file its 角标 are numbered in; `anchors` [{ id, quote }]: the words of the blocks about this text; `onAnchored(ids)` once drawn. */
export default function BookFile({ text, citeText = text, hid, handlers, className, anchors = [], onAnchored }) {
  const cites = useMemo(() => citesOf(citeText), [citeText]);
  const resolve = useMemo(() => resolverOf(handlers, hid), [handlers, hid]);
  const onCite = useCallback(n => { const cite = cites.get(n); if (cite) handlers.source(cite.sourceId, cite.quote); }, [cites, handlers]);
  // A Q&A block's marker lines are the book's, not the reader's (the heading ids stay: headingAnchor reads them); so are the noprint markers (M6: only
  // the export leaves that text out) and the brackets of a [[term]].
  const shown = useMemo(() => plainTerms(withoutNoprintMarkers(withoutQaMarkers(text))), [text]);
  // The paragraph is drawn fresh (key) whenever its words or its anchors change, so the underline is only ever put on new text.
  const rootRef = useRef(null), signature = anchors.length ? `${shortHash(shown)}\u0002${anchors.map(item => `${item.id}\u0000${item.quote}`).join('\u0001')}` : 'plain';
  useAiAnchors(rootRef, anchors, signature, { onOpen: handlers.aiOpen, onFound: onAnchored });
  return <Markdown key={signature} rootRef={rootRef} className={className} text={shown} resolveLink={resolve} onCite={onCite} headingAnchor={headingAnchor} />;
}
