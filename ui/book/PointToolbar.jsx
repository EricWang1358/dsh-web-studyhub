import React, { useState } from 'react';
import { ui, uiFormat } from '../i18n.js';
import { Badge, Button, Menu } from '../components/index.js';
import { useStudy } from '../study-context.jsx';
import { useLiveEffect } from '../use-async.js';

/* The one row of a knowledge point's actions (复习全书, docs/review-book.md "Reading a point"), in place of the 练 5 道 · 本节问答 line and 这一节还没有题。
   at its end: 在这里加一段 on the left; 练 5 道, 本节问答 (N) and 整理 on the right. A point without questions shows a quiet 暂无题 and 出题 instead of 练 5 道.
   整理 never deletes: 收起所有 AI 块 folds every block of the point, 只留我写的 hides the blocks the learner did not write (ui/book/ai-fold.js). */

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

/** node, course, handlers (ui/book/BookPage.jsx); tidy: { ids, allFolded, hidable, hidden, foldAll(on), mineOnly(on) } or null (no AI block, no fold). */
export default function PointToolbar({ node, course, handlers, tidy }) {
  const qaCount = useQaCount(course, node.key), qaOpen = handlers.qaOpen(node.hid);
  const items = tidy ? [
    { id: 'fold', label: tidy.allFolded ? ui('展开所有 AI 块') : ui('收起所有 AI 块'), icon: 'list' },
    tidy.hidden ? { id: 'show', label: uiFormat('全部显示（{0} 段已隐藏）', [tidy.hidable]), icon: 'undo' }
      : { id: 'mine', label: uiFormat('只留我写的（隐藏 {0} 段）', [tidy.hidable]), icon: 'filter', disabled: !tidy.hidable },
  ] : [];
  return (
    <div className="book-point__bar">
      {handlers.addHere && <Button variant="link" size="sm" icon="sparkle" className="book-point__add" onClick={event => handlers.addHere(node, event.currentTarget)}>{ui('在这里加一段')}</Button>}
      <div className="book-point__actions">
        {node.questionTotal > 0
          ? <Button size="sm" variant="secondary" icon="play" className="book-point__practice" data-book-link="practice"
            onClick={event => handlers.practice(node.hid, 5, node.hid, event.currentTarget)}>{ui('练 5 道')}</Button>
          : <>
            <Badge size="sm" className="book-point__none">{ui('暂无题')}</Badge>
            {handlers.create && <Button size="sm" variant="quiet" icon="sparkle" className="book-node__create" onClick={handlers.create}>{ui('出题')}</Button>}
          </>}
        <Button size="sm" variant="quiet" className="book-point__qa" data-book-link="qa" aria-expanded={qaOpen} onClick={() => handlers.toggleQa(node.hid)}>
          {qaCount === null ? ui('本节问答') : uiFormat('本节问答 ({0})', [qaCount])}</Button>
        {tidy && <Menu label={ui('整理')} className="book-point__tidy" items={items}
          trigger={({ props, ref }) => <Button ref={ref} size="sm" variant="quiet" icon="filter" className="book-point__tidy-button" {...props}>{ui('整理')}</Button>}
          onSelect={id => { if (id === 'fold') tidy.foldAll(!tidy.allFolded); else tidy.mineOnly(id === 'mine'); }} />}
      </div>
    </div>
  );
}
