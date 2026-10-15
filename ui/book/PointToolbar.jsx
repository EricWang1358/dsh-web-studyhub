import React, { useState } from 'react';
import { ui, uiFormat } from '../i18n.js';
import { Button } from '../components/index.js';
import { useStudy } from '../study-context.jsx';
import { useLiveEffect } from '../use-async.js';
import BookToChat from './BookToChat.jsx';

/* The one row of a knowledge point's actions (复习全书, docs/review-book.md "Reading a point"), in place of the 练 5 道 · 本节问答 line and 这一节还没有题。
   at its end: 在这里加一段 on the left; on the right 练 5 道 (a point with questions), a quiet 出题 (one without: it says nothing else about it, the 总纲 says 还没出题),
   本节问答 (N) and 发给主会话. Folding and hiding the AI blocks is not here: each block is one row that folds, and 我的 can fold them all (ui/book/PointLayer.jsx). */

/** How many items 本节问答 has (course.outline.qa, read once per point shown); null until known. */
function useQaCount(course, nodeKey) {
  const { call } = useStudy();
  const [count, setCount] = useState(null);
  useLiveEffect(isLive => {
    if (!nodeKey) return;
    call('course.outline.qa', { course, keys: [nodeKey] }).then(answer => { if (isLive()) setCount(Array.isArray(answer?.items) ? answer.items.length : null); }, () => {});
  }, [call, course, nodeKey]);
  return count;
}

/** node, course, handlers (ui/book/BookPage.jsx). */
export default function PointToolbar({ node, course, handlers }) {
  const qaCount = useQaCount(course, node.key), qaOpen = handlers.qaOpen(node.hid);
  return (
    <div className="book-point__bar">
      {handlers.addHere && <Button variant="quiet" size="sm" icon="sparkle" className="book-point__add" onClick={event => handlers.addHere(node, event.currentTarget)}>{ui('在这里加一段')}</Button>}
      <div className="book-point__actions">
        {node.questionTotal > 0
          ? <Button size="sm" variant="secondary" icon="play" className="book-point__practice" data-book-link="practice"
            onClick={event => handlers.practice(node.hid, 5, node.hid, event.currentTarget)}>{ui('练 5 道')}</Button>
          : handlers.create && <Button size="sm" variant="quiet" className="book-node__create" onClick={handlers.create}>{ui('出题')}</Button>}
        <Button size="sm" variant="quiet" className="book-point__qa" data-book-link="qa" aria-expanded={qaOpen} onClick={() => handlers.toggleQa(node.hid)}>
          {qaCount ? uiFormat('本节问答 ({0})', [qaCount]) : ui('本节问答')}</Button>
        <BookToChat scope="point" node={node} course={course} files={handlers.files} />
      </div>
    </div>
  );
}
