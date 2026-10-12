import React from 'react';
import { ui } from '../i18n.js';
import { Button, Tooltip } from '../components/index.js';
import BookFile from './BookFile.jsx';
import PointText from './PointText.jsx';
import BookSuggestion from './BookSuggestion.jsx';

/* The learner's layer of a knowledge point (复习全书, docs/review-book.md "Reading a point"), after the program's text, under a quiet divider 「我的」 (a hairline
   and a small label with its explanation on hover and focus; not a toggle): the notes (open), the AI blocks for the whole point (each one row, ui/book/BookAiBlock.jsx),
   the Q&A put into the book, the suggestions, and the blocks whose words are gone (原位置已变) at the end. The AI blocks about words are not here: they sit right after
   their paragraphs. A point with two blocks or more has one quiet 全部收起 / 全部展开 on the divider's row (the divider alone when 我的 has nothing else). */

/** node, view (ui/book/point-parts.js pointView), handlers, aiFold (ui/book/ai-fold.js, or null), isFolded(item): the block's fold, renderBlock(item), onAnchored(key, ids). */
export default function PointLayer({ node, view, handlers, aiFold, isFolded, renderBlock, onAnchored }) {
  const qa = String(node.qa ?? '').trim(), mineMeta = handlers.files?.[node.files?.mine], qaMeta = node.files?.qa ? handlers.files?.[node.files.qa] : null;
  const ids = view.blocks.map(item => item.block.id), allFolded = ids.length > 0 && view.blocks.every(isFolded);
  // With nothing of its own (no notes, no whole-point block, no Q&A), 我的 is its divider alone, only when two blocks or more sit in the text above: the one link
  // that folds or opens them all.
  if (!view.mine && !view.here.length && !view.lost.length && !qa && !mineMeta?.suggestions?.length && !qaMeta?.suggestions?.length && !(aiFold && ids.length > 1)) return null;
  return (
    <section className="book-layer" aria-label={ui('我的')} data-book-layer={node.hid}>
      <div className="book-layer__divider">
        <Tooltip layer className="book-layer__hint" content={ui('你的笔记、AI 段落和加进书里的问答都在这里')} anchorClassName="book-layer__tip">
          <span className="book-layer__label" tabIndex={0}>{ui('我的')}</span>
        </Tooltip>
        {aiFold && ids.length > 1 && <Button variant="link" size="sm" className="book-layer__fold" onClick={() => aiFold.foldAll(ids, !allFolded)}>
          {allFolded ? ui('全部展开') : ui('全部收起')}</Button>}
      </div>
      {view.mine && <PointText name="mine" text={view.mine} view={view} node={node} handlers={handlers} className="book-file book-file--mine" citeText={node.mine}
        renderBlock={renderBlock} onAnchored={onAnchored} />}
      {view.here.map(renderBlock)}
      {qa && <BookFile text={node.qa} hid={node.hid} handlers={handlers} className="book-file book-file--mine" />}
      {mineMeta?.suggestions?.length > 0 && <BookSuggestion meta={mineMeta} busy={handlers.busy} onChoose={(action, id) => handlers.choose(node.files.mine, action, id)} />}
      {qaMeta?.suggestions?.length > 0 && <BookSuggestion meta={qaMeta} busy={handlers.busy} onChoose={(action, id) => handlers.choose(node.files.qa, action, id)} />}
      {view.lost.map(renderBlock)}
    </section>
  );
}
