import React, { useState } from 'react';
import { ui } from '../i18n.js';
import { Button, ConfirmDialog, Tooltip } from '../components/index.js';
import { MovesList } from './BookMoves.jsx';

/* The book page after the 总纲 was organised again, when that would move or park the learner's own text (course.book.open answers `rebuild-pending`, #461): nothing has moved yet.
   What the learner did to the book's tree that the new layout does not keep waits here too (#489, moves.structure): nothing else would say so. The moves are only known once the new outline exists, so this is where they can be looked at first: old title -> new title and the first line of the body under it, what
   would wait in 未归位. 按这样放 is the one main button (撤销这次整理 can still take them back); 放弃这次整理 puts the outline before it back. */

/** moves: course.book.open's `moves`; onApply(outlineId): applies them; onDiscard(outlineId): gives the new outline up (may throw: said in the dialog); building: a build of the course runs, so it cannot be given up now. */
export default function BookRebuildPreview({ moves, onApply, onDiscard, building = false }) {
  const [asking, setAsking] = useState(false), [working, setWorking] = useState(false);
  const apply = async () => { setWorking(true); try { await onApply(moves.outlineId); } finally { setWorking(false); } };
  return (
    <section className="book-rebuild-preview" data-book-rebuild-preview="" aria-label={ui('看一下这次整理会怎么放你的笔记')}>
      <h2 className="book-rebuild-preview__title">{ui('看一下这次整理会怎么放你的笔记')}</h2>
      <p className="book-rebuild-preview__lead">{ui('总纲已经重新整理好了，你写的内容还没有动。每一行下面是新标题下的第一行正文：对不上时可以放弃这次整理。')}</p>
      <div className="book-rebuild-preview__actions">
        <Tooltip layer content={ui('笔记放到下面列的位置。放好后还能撤销这次整理，只要之后没有再改过书。')}>
          <Button variant="primary" busy={working} onClick={apply}>{ui('按这样放')}</Button></Tooltip>
        <Tooltip layer content={building ? ui('这门课正在整理总纲或更新全书，等它结束再撤销。这次没有改动。') : ui('总纲回到上一版，书一个字不动。想要新总纲，要再整理一次。')}>
          <Button variant="quiet" disabled={working || building} onClick={() => setAsking(true)}>{ui('放弃这次整理')}</Button></Tooltip>
      </div>
      {moves.structure && <p className="book-rebuild-preview__lead" data-book-rebuild-structure="">{ui('下面也列了你对书的结构做过、这次不会保留的改动。放好后「撤销这次整理」能把它们和笔记一起放回去，只要之后没有再改过书；「放弃这次整理」则什么都不动。')}</p>}
      <MovesList moves={moves} />
      {asking && <ConfirmDialog title={ui('放弃这次整理')} confirmLabel={ui('放弃这次整理')} tone="primary" onConfirm={() => onDiscard(moves.outlineId)} onClose={() => setAsking(false)}>
        <p>{ui('总纲回到上一版，书一个字不动。想要新总纲，要再整理一次。')}</p></ConfirmDialog>}
    </section>
  );
}
