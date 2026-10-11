import React from 'react';
import { ui, uiFormat } from '../i18n.js';
import { Button, Icon } from '../components/index.js';
import BookFile from './BookFile.jsx';
import BookAiBlock from './BookAiBlock.jsx';
import BookSuggestion from './BookSuggestion.jsx';

/* The learner's layer of a knowledge point (复习全书, docs/review-book.md "Reading a point"), after the program's text: 我的笔记与 AI 解释 (N), the own file
   (its notes, then its AI blocks in the order they were written) and the Q&A put into the book. It starts folded (each block as its header and summary
   line) from three items or with a block over 1,500 characters; a block the learner opened or folded keeps that. The header folds or opens every block.
   A whole-point block that mostly restates the notes says so, with 收起. Blocks hidden by 只留我写的 are counted here, with 全部显示. */

/** node, view (ui/book/point-parts.js pointView), handlers, resolve (the book's links), aiFold (ui/book/ai-fold.js, or null), shown: the blocks drawn,
    hidden: how many 只留我写的 hides, onShowAll(), anchored: Set of the blocks whose words are marked, layerFolded: the default fold. */
export default function PointLayer({ node, view, handlers, resolve, aiFold, shown, hidden, onShowAll, anchored, onAnchored, layerFolded }) {
  const qa = String(node.qa ?? '').trim(), mineMeta = handlers.files?.[node.files?.mine], qaMeta = node.files?.qa ? handlers.files?.[node.files.qa] : null;
  const count = shown.length + (view.mine ? 1 : 0) + (qa ? 1 : 0);
  if (!count && !hidden && !mineMeta?.suggestions?.length) return null;
  const isFolded = id => !!aiFold?.folded(id, layerFolded), ids = shown.map(item => item.block.id), allFolded = ids.length > 0 && ids.every(isFolded);
  const title = uiFormat('我的笔记与 AI 解释 ({0})', [count]);
  return (
    <section className="book-layer" aria-label={title} data-book-layer={node.hid}>
      <div className="book-layer__head">
        {aiFold && ids.length ? <Button variant="quiet" size="sm" wrap className="book-layer__toggle" aria-expanded={!allFolded} onClick={() => aiFold.foldAll(ids, !allFolded)}>
          <Icon name="caret" size={14} className="book-layer__caret" />{title}</Button>
          : <p className="book-layer__title">{title}</p>}
        {hidden > 0 && <span className="book-layer__hidden">{uiFormat('已隐藏 {0} 段 AI 写的', [hidden])}
          <Button variant="link" size="sm" className="book-layer__show" onClick={onShowAll}>{ui('全部显示')}</Button></span>}
      </div>
      {view.mine && <BookFile text={view.mine} citeText={node.mine} hid={node.hid} handlers={handlers} className="book-file book-file--mine" anchors={view.anchors.get('mine')}
        onAnchored={ids => onAnchored('mine', ids)} />}
      {shown.map(item => <BookAiBlock key={item.block.id} item={item} resolveLink={resolve} busy={handlers.busy} onAction={(action, block) => handlers.aiAction?.(node, action, block)}
        onFollow={(block, question) => handlers.aiFollow?.(node, block, question)} folded={isFolded(item.block.id)} onFold={aiFold?.fold}
        anchored={anchored.has(item.block.id)} onWords={handlers.aiWords} repeat={view.repeats.has(item.block.id)} />)}
      {mineMeta?.suggestions?.length > 0 && <BookSuggestion meta={mineMeta} busy={handlers.busy} onChoose={(action, id) => handlers.choose(node.files.mine, action, id)} />}
      {qa && <BookFile text={node.qa} hid={node.hid} handlers={handlers} className="book-file book-file--mine" />}
      {qaMeta?.suggestions?.length > 0 && <BookSuggestion meta={qaMeta} busy={handlers.busy} onChoose={(action, id) => handlers.choose(node.files.qa, action, id)} />}
    </section>
  );
}
