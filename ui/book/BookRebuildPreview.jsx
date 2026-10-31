import React, { useState } from 'react';
import { ui } from '../i18n.js';
import { Button, ConfirmDialog, Tooltip } from '../components/index.js';
import { MovesList } from './BookMoves.jsx';

/* The book page after the 总纲 was organised again, when that would move or park the learner's own text (course.book.open `holdRebuild`, #461): nothing has moved yet.
   The moves are only known once the new outline exists, so this is where they can be looked at first: old title -> new title and the first line of the body under it, what
   would wait in 未归位. 按这样放 is the one main button (the ordinary open applies them, and 撤销这次整理 can still take them back); 放弃这次整理 puts the outline before it back. */

/** moves: course.book.open's `moves`; onApply(): applies them; onDiscard(): gives the new outline up (may throw: said in the dialog). */
export default function BookRebuildPreview({ moves, onApply, onDiscard }) {
  const [asking, setAsking] = useState(false), [working, setWorking] = useState(false);
  const apply = async () => { setWorking(true); try { await onApply(); } finally { setWorking(false); } };
  return (
    <section className="book-rebuild-preview" data-book-rebuild-preview="" aria-label={ui('看一下这次整理会怎么放你的笔记')}>
      <h2 className="book-rebuild-preview__title">{ui('看一下这次整理会怎么放你的笔记')}</h2>
      <p className="book-rebuild-preview__lead">{ui('总纲已经重新整理好了，你写的内容还没有动。每一行下面是新标题下的第一行正文：对不上时可以放弃这次整理。')}</p>
      <div className="book-rebuild-preview__actions">
        <Tooltip layer content={ui('笔记放到下面列的位置。放好后还能撤销这次整理，只要之后没有再改过书。')}>
          <Button variant="primary" busy={working} onClick={apply}>{ui('按这样放')}</Button></Tooltip>
        <Tooltip layer content={ui('总纲回到上一版，书一个字不动。想要新总纲，要再整理一次。')}>
          <Button variant="quiet" disabled={working} onClick={() => setAsking(true)}>{ui('放弃这次整理')}</Button></Tooltip>
      </div>
      <MovesList moves={moves} />
      {asking && <ConfirmDialog title={ui('放弃这次整理')} confirmLabel={ui('放弃这次整理')} tone="primary" onConfirm={() => onDiscard(moves.outlineId)} onClose={() => setAsking(false)}>
        <p>{ui('总纲回到上一版，书一个字不动。想要新总纲，要再整理一次。')}</p></ConfirmDialog>}
    </section>
  );
}
