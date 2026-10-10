import React from 'react';
import { ui } from '../i18n.js';
import { Button } from '../components/index.js';
import { parseBookLink } from '../../lib/course-book-links.js';

/* The review book's links (I5 of docs/plans/review-book.md), drawn for ui/Markdown.jsx's `resolveLink`: a question (studyhub://card), 练 N 道 of a heading
   (studyhub://practice) and 本节问答 (studyhub://qa) only navigate or open the list, they never run an action; a 出处 (studyhub://source) opens the reader at
   its quote. A link to a question that is gone says 这道题已被删除. Anything else stays plain text. */

/** handlers: { gone: Set<'deckId|cardId'>, onCard(ref), onPractice(heading, n), onQa(heading), qaOpen(heading) -> boolean, onSource(sourceId, quote) }. */
export function bookResolver({ gone, onCard, onPractice, onQa, qaOpen, onSource }) {
  return (href, label, key, text) => {
    const link = parseBookLink(href);
    if (!link) return null;
    if (link.kind === 'card') {
      if (gone.has(`${link.deckId}|${link.cardId}`)) return <span key={key} className="book-link-gone">{ui('这道题已被删除')}</span>;
      return <Button key={key} variant="link" size="sm" wrap className="book-link" data-book-link="card" onClick={() => onCard({ deckId: link.deckId, cardId: link.cardId })}>{label}</Button>;
    }
    if (link.kind === 'practice') return <Button key={key} variant="link" size="sm" wrap icon="play" className="book-link" data-book-link="practice" onClick={() => onPractice(link.heading, link.n)}>{label}</Button>;
    if (link.kind === 'qa') return <Button key={key} variant="link" size="sm" wrap className="book-link" data-book-link="qa" aria-expanded={qaOpen(link.heading)} onClick={() => onQa(link.heading)}>{label}</Button>;
    return <Button key={key} variant="link" size="sm" wrap icon="external" className="book-link" data-book-link="source" onClick={() => onSource(link.sourceId, String(text ?? '').replace(/^[「“]|[」”]$/g, ''))}>{label}</Button>;
  };
}
