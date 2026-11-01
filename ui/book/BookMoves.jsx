import React, { useState } from 'react';
import { ui, uiFormat } from '../i18n.js';
import { Button, ConfirmDialog, Dialog, Tooltip } from '../components/index.js';
import { readText, writeText } from '../storage.js';
import { guidanceAllows } from '../guidance/budget.js';

/* After the 总纲 was made again, the book's notes followed their pages to new points (lib/course-book-remap.js). The book page says how many points' notes moved and how
   many wait in 未归位; 「知道了」 only folds that to one line (kept in this browser per rebuild, like the switches of 设置 › 引导): the line stays until the next rebuild, so the
   list can always be read again. 查看每一处 opens every point: old title -> new title, with the first line of the body under the new title, so a title that does not match
   its text shows (#461), and 撤销这次整理 while nothing was written since. Each moved point also keeps a quiet 「来自原知识点 X」 line (ui/book/PointBody.jsx). */

/** The key prefix of 知道了, one key per course (it holds the rebuild that was seen); 设置 › 引导 reads it (ui/guidance/registry.js, item book.moves). */
export const BOOK_MOVES_PREFIX = 'study-book-moves-seen:';
const keyOf = course => `${BOOK_MOVES_PREFIX}${course}`;
/** The rebuild (`moves.at`) whose moves the learner already read for `course`, or null. */
export const movesSeenAt = course => readText(keyOf(course), null);
/** Remember that the moves of rebuild `at` were read; true when it was stored. */
export const rememberMovesSeen = (course, at) => writeText(keyOf(course), at);

const counts = moves => { const list = moves?.list || []; return { list, total: Math.max(moves?.total ?? 0, list.length), held: moves?.held || 0, gone: moves?.gone || 0 }; };
// A record from before first lines were kept (no `revisionAfter`) has none to show: saying 还没有正文 there would read like lost text.
const FirstLine = ({ text, known }) => (text || known ? <span className="book-moves__first">{text || ui('（还没有正文）')}</span> : null);

/** Every point of `moves` that was stored: what moved, then what waits in 未归位 (held: no new point holds enough of its pages; gone: none holds any). */
export function MovesList({ moves }) {
  const { list, total, held, gone } = counts(moves), known = moves?.revisionAfter !== undefined;
  return (
    <div className="book-moves">
      {list.length > 0 && <ul className="book-moves__list">{list.map((move, at) => <li key={at} data-book-move="">
        <span className="book-moves__titles">{uiFormat(move.folded ? '「{0}」并入「{1}」' : '「{0}」→「{1}」', [move.from, move.to])}
          {move.share !== undefined && <span className="book-moves__share"> {uiFormat('占原知识点 {0}% 的页', [Math.round(move.share * 100)])}</span>}</span>
        <FirstLine text={move.first} known={known} /></li>)}</ul>}
      {total > list.length && <p className="book-moves__note">{uiFormat('这里列出 {0} 个，一共 {1} 个', [list.length, total])}</p>}
      {held > 0 && <p className="book-moves__note" data-book-held="">{uiFormat('{0} 个知识点的笔记对不上新的知识点，放在「未归位」里', [held])}</p>}
      {(moves?.heldList || []).length > 0 && <ul className="book-moves__list">{moves.heldList.map((item, at) => <li key={at}>
        <span className="book-moves__titles">{uiFormat('「{0}」最接近「{1}」', [item.from, item.closest])}
          {item.share !== undefined && <span className="book-moves__share"> {uiFormat('只有 {0}% 的页在那里', [Math.round(item.share * 100)])}</span>}</span>
        <FirstLine text={item.first} known={known} /></li>)}</ul>}
      {gone > 0 && <p className="book-moves__note">{uiFormat('{0} 个知识点在新总纲里没有了，笔记放在「未归位」里', [gone])}</p>}
      {(moves?.goneList || []).length > 0 && <ul className="book-moves__list">{moves.goneList.map((item, at) => <li key={at}>
        <span className="book-moves__titles">{uiFormat('「{0}」', [item.from])}</span><FirstLine text={item.first} known={known} /></li>)}</ul>}
    </div>
  );
}

/** The list and what can still be done about it. onUndo(outlineId): takes this rebuild back (may throw: said in the dialog); a record kept before undo existed has no `revisionAfter`. */
export function MovesReview({ moves, onUndo }) {
  const [asking, setAsking] = useState(false);
  return <>
    <MovesList moves={moves} />
    {onUndo && moves.undoable && <p className="book-moves__undo">
      <Tooltip layer content={ui('只把这次整理搬动的内容放回原位，总纲也回到上一版；书里别的内容不受影响。之后改过书就不能撤销了。')}>
        <Button variant="secondary" size="sm" onClick={() => setAsking(true)}>{ui('撤销这次整理')}</Button></Tooltip></p>}
    {!moves.undoable && moves.revisionAfter !== undefined && <p className="book-moves__note">{ui('这次整理之后书又改过了，不能再撤销；「未归位」里的内容可以手动放回。')}</p>}
    {asking && <ConfirmDialog title={ui('撤销这次整理')} confirmLabel={ui('撤销这次整理')} tone="primary" onConfirm={() => onUndo(moves.outlineId)} onClose={() => setAsking(false)}>
      <p>{ui('笔记和总纲都回到这次整理之前。想要新总纲，要再整理一次。')}</p></ConfirmDialog>}
  </>;
}

/** moves: course.book.open's `moves` ({ at, outlineId, list: [{ from, to, folded, share?, first? }], total, held, heldList?, gone?, goneList?, undoable }); onUndo as MovesReview. */
export default function BookMoves({ course, moves, onUndo }) {
  const [seen, setSeen] = useState(() => movesSeenAt(course)), [open, setOpen] = useState(false);
  const { list, total, held, gone } = counts(moves);
  if (!list.length && !held && !gone) return null;
  // A write that fails only shows the notice again next time.
  const done = () => { rememberMovesSeen(course, moves.at); setSeen(moves.at); };
  const review = open && <Dialog size="md" title={ui('这次整理动了哪些笔记')} onClose={() => setOpen(false)}><MovesReview moves={moves} onUndo={onUndo && (async outlineId => { await onUndo(outlineId); setOpen(false); })} /></Dialog>;
  // Read once (知道了), or 设置 › 引导 switched the notice off: one quiet line, never nothing.
  if (seen === moves.at || !guidanceAllows('book.moves')) return (
    <div className="book-header__moves-line" data-book-moves-line="">
      {[list.length > 0 && uiFormat('上次整理总纲：{0} 个知识点的笔记换了位置', [total]), held + gone > 0 && uiFormat('{0} 个放在「未归位」', [held + gone])].filter(Boolean).join(ui('，'))}
      <Button variant="link" size="sm" onClick={() => setOpen(true)}>{ui('查看')}</Button>{review}</div>
  );
  return (
    <section className="book-header__moves" data-book-moves="" aria-label={ui('笔记换了位置')}>
      {list.length > 0 && <p>{uiFormat('{0} 个知识点的笔记被移到了新位置（总纲重新整理过）。', [total])}</p>}
      {held > 0 && <p data-book-held="">{uiFormat('{0} 个知识点的笔记对不上新的知识点，放在「未归位」里', [held])}</p>}
      {gone > 0 && <p>{uiFormat('{0} 个知识点在新总纲里没有了，笔记放在「未归位」里', [gone])}</p>}
      <div className="book-header__moves-actions">
        <Button size="sm" variant="secondary" onClick={() => setOpen(true)}>{ui('查看每一处')}</Button>
        <Button size="sm" variant="quiet" onClick={done}>{ui('知道了')}</Button>
      </div>
      {review}
    </section>
  );
}
