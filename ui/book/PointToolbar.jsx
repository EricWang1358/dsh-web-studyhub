import React, { useState } from 'react';
import { ui, uiFormat } from '../i18n.js';
import { Button } from '../components/index.js';
import { useStudy } from '../study-context.jsx';
import { useLiveEffect } from '../use-async.js';

/* The one row of a knowledge point's actions (复习全书, docs/review-book.md "Reading a point"), in place of the 练 5 道 · 本节问答 line and 这一节还没有题。
   at its end: 练 5 道 (a point with questions; one without says nothing about it here, 给这个知识点出题 is in 更多) and 本节问答 (N). Asking the AI about the
   point, writing into it or sending it to the main chat is the title's 问 AI (ui/book/BookAsk.jsx). On a narrow page the buttons are one left-aligned row that
   wraps. Folding and hiding the AI blocks is not here: each block is one row that folds, and 我的 can fold them all (ui/book/PointLayer.jsx). */

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

/** node, course, handlers (ui/book/BookPage.jsx); cites: the point's 出处 chip or null (first of the actions). */
export default function PointToolbar({ node, course, handlers, cites = null }) {
  const qaCount = useQaCount(course, node.key), qaOpen = handlers.qaOpen(node.hid);
  return (
    <div className="book-point__bar">
      <div className="book-point__actions">
        {cites}
        {node.questionTotal > 0 && <Button size="sm" variant="secondary" icon="play" className="book-point__practice" data-book-link="practice"
          onClick={event => handlers.practice(node.hid, 5, node.hid, event.currentTarget)}>{ui('练 5 道')}</Button>}
        <Button size="sm" variant="quiet" className="book-point__qa" data-book-link="qa" aria-expanded={qaOpen} onClick={() => handlers.toggleQa(node.hid)}>
          {qaCount ? uiFormat('本节问答 ({0})', [qaCount]) : ui('本节问答')}</Button>
      </div>
    </div>
  );
}
