import React, { useState } from 'react';
import { ui, uiFormat } from '../i18n.js';
import { Button } from '../components/index.js';
import { readText, writeText } from '../storage.js';

/* After the 总纲 was made again, the book's notes followed their pages to new points (lib/course-book-remap.js). Said ONCE on the book page: how many points'
   notes moved and from which old title to which new one; 「知道了」 hides it for that rebuild (kept in this browser). Each moved point also keeps a quiet
   「来自原知识点 X」 line (ui/book/PointBody.jsx). */

const keyOf = course => `study-book-moves-seen:${course}`;
const seenAt = course => readText(keyOf(course), null);

/** moves: course.book.open's `moves` ({ at, list: [{ from, to, folded }], held? }); `held` points' notes matched no new title and wait in 未归位 (#461). */
export default function BookMoves({ course, moves }) {
  const [seen, setSeen] = useState(() => seenAt(course));
  const list = moves?.list || [], held = moves?.held || 0, total = Math.max(moves?.total ?? 0, list.length);
  if ((!list.length && !held) || seen === moves.at) return null;
  // A write that fails only shows the line again next time.
  const done = () => { writeText(keyOf(course), moves.at); setSeen(moves.at); };
  return (
    <section className="book-header__moves" data-book-moves="" aria-label={ui('笔记换了位置')}>
      {list.length > 0 && <p>{uiFormat('{0} 个知识点的笔记被移到了新位置（总纲重新整理过）：', [total])}</p>}
      {list.length > 0 && <ul>{list.slice(0, 12).map(move => <li key={`${move.from}|${move.to}`}>{uiFormat(move.folded ? '「{0}」并入「{1}」' : '「{0}」→「{1}」', [move.from, move.to])}</li>)}</ul>}
      {total > 12 && <p>{uiFormat('还有 {0} 个', [total - Math.min(12, list.length)])}</p>}
      {held > 0 && <p data-book-held="">{uiFormat('{0} 个知识点的笔记对不上新标题，放在「未归位」里', [held])}</p>}
      <Button size="sm" variant="secondary" onClick={done}>{ui('知道了')}</Button>
    </section>
  );
}
