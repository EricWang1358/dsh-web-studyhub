import React from 'react';
import { ui, uiFormat } from '../i18n.js';
import { Button } from '../components/index.js';
import BookToChat from './BookToChat.jsx';

/* The closing row of a knowledge point (复习全书, docs/review-book.md "Reading a point"): 在这里加一段 on the left; on the right 出处 N, 本节问答 (N) (only when it
   has items: course.book.open counts them, so the row is right at first paint) and 发给主会话. 练 5 道 is the point's end button (ui/book/PointEnd.jsx) on the
   reading surface; where there is none (翻看) it stays here, for a point with questions. On a narrow page the buttons are one left-aligned row that wraps.
   Folding and hiding the AI blocks is not here: each block is one row that folds, and 我的 can fold them all (ui/book/PointLayer.jsx). */

/** node, course, handlers (ui/book/BookPage.jsx); cites: the point's 出处 chip or null (first of the actions); practice: 练 5 道 is in this row. */
export default function PointToolbar({ node, course, handlers, cites = null, practice = true }) {
  const qaOpen = handlers.qaOpen(node.hid), counted = Number.isInteger(node.qaCount);
  return (
    <div className="book-point__bar">
      {handlers.addHere && <Button variant="quiet" size="sm" icon="sparkle" className="book-point__add" onClick={event => handlers.addHere(node, event.currentTarget)}>{ui('在这里加一段')}</Button>}
      <div className="book-point__actions">
        {cites}
        {practice && node.questionTotal > 0 && <Button size="sm" variant="secondary" icon="play" className="book-point__practice" data-book-link="practice"
          onClick={event => handlers.practice(node.hid, 5, node.hid, event.currentTarget)}>{ui('练 5 道')}</Button>}
        {(!counted || node.qaCount > 0 || qaOpen) && <Button size="sm" variant="quiet" className="book-point__qa" data-book-link="qa" aria-expanded={qaOpen}
          onClick={() => handlers.toggleQa(node.hid)}>{counted && node.qaCount > 0 ? uiFormat('本节问答 ({0})', [node.qaCount]) : ui('本节问答')}</Button>}
        <BookToChat scope="point" node={node} course={course} files={handlers.files} />
      </div>
    </div>
  );
}
