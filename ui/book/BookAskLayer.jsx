import React, { useMemo } from 'react';
import BookAsk from './BookAsk.jsx';
import BookSelectBar from './BookSelectBar.jsx';
import { useSendToChat } from './send-to-chat.js';
import { scrollerOf } from './use-book-place.js';
import { rowOf } from './model.js';

/* What floats over the review book's text (docs/review-book.md "Ask AI"): the selection toolbar and the 问 AI panel, on the reading surface and in 翻看. Both
   are placed in the page element and follow its scroller; the panel is one at a time (a new 问 AI or 写一段… replaces it). */

/** ai: ui/book/use-book-ai.js; rows: the book's rows (the point of a heading); book: course.book.open (its files' versions for the chat); model: modelReadiness;
    pageRef: the page element. */
export default function BookAskLayer({ ai, rows, book, course, model, pageRef }) {
  const send = useSendToChat(course);
  const host = pageRef.current;
  // What the two follow: the page's scroller (its scroll moves them), and as their bounds the page's own column within the visible part of the scroller, so
  // neither ever covers the app's sidebar.
  const scrollerRef = useMemo(() => ({ get current() {
    if (!host) return null;
    const scroller = scrollerOf(host);
    return { addEventListener: (...args) => scroller?.addEventListener(...args), removeEventListener: (...args) => scroller?.removeEventListener(...args),
      getBoundingClientRect: () => {
        const page = host.getBoundingClientRect(), view = scroller && scroller !== document.scrollingElement ? scroller.getBoundingClientRect() : { top: 0, bottom: window.innerHeight };
        return { left: page.left, right: page.right, top: Math.max(0, view.top), bottom: Math.min(window.innerHeight, view.bottom) };
      } };
  } }), [host]);
  const toChat = async ({ heading, words = '', instruction = '' }) => {
    const node = rowOf(rows, heading)?.node;
    if (!node) return;
    await send({ scope: words ? 'selection' : 'point', node, files: book.files, selection: words, instruction });
    ai.closeAsk();
    window.getSelection?.()?.removeAllRanges?.();
  };
  const ask = ai.ask;
  return <>
    <BookSelectBar host={host} scrollerRef={scrollerRef} hidden={!!ask} model={model}
      onExplain={({ heading, words }) => ai.start({ heading, mode: 'explain', words })}
      onWrite={({ heading, words, range }) => ai.openAsk({ heading, words, anchor: range })}
      onSend={({ heading, words }) => toChat({ heading, words })} />
    {ask && <BookAsk key={`${ask.heading}|${ask.words ?? ''}`} target={ask} host={host} scrollerRef={scrollerRef} model={model}
      onWrite={args => ai.start({ heading: ask.heading, ...args })} onSend={({ words, instruction }) => toChat({ heading: ask.heading, words, instruction })} onClose={ai.closeAsk} />}
  </>;
}
