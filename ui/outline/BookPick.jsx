import React, { useState } from 'react';
import { ui, uiFormat } from '../i18n.js';
import { Button, Checkbox, Disclosure, LoadingState } from '../components/index.js';
import { useInjectCss } from '../shared.js';
import { useLiveEffect } from '../use-async.js';
import { callsText, rangeTok } from '../token-usage.js';
import css from './book-pick.css';

/* 只生成部分章节 / 生成其他章节 (#708): folded beside the 总纲's book button, which still builds the whole book in one click. The chapters of the outline
   (course.outline's book.parts) each say whether they are built; the ones ticked are built alone (generation.courseBook.build { chapters }, in outline order):
   only their points are written and only their materials read, a written point is never written or paid again. Before it starts, the pick's scale from the
   build's own plan (`estimate: true`, no call): points, calls and the material read, never a price, and the tip about cheaper ways. Props: parts, built (the
   book has notes), off (no model, or busy), onScale(chapters) -> Promise of the estimate, onBuild(chapters). */

/** A chapter as the pick lists it: 未生成 with its points, 已生成 a/b, or 已生成. A chapter of an outline built by chapters that is not built yet (深度定制 S2,
    `pending`: no point of it is known before its inventory) says 未生成 with its pages. */
export function partState(part) {
  if (part.pending) return part.pages ? uiFormat('未生成 · 第 {0}–{1} 页', part.pages) : ui('未生成');
  if (!part.written) return uiFormat('未生成 · {0} 个知识点', [part.points]);
  return part.written < part.points ? uiFormat('已生成 {0}/{1} 个知识点', [part.written, part.points]) : ui('已生成');
}

/** The book line of a book of some chapters: how many are 未生成, or null when every chapter (or none) is built. */
export function unbuiltText(parts = []) {
  const left = parts.filter(part => !part.written).length;
  return left && left < parts.length ? uiFormat('已生成 {0}/{1} 章，其余 {2} 章未生成', [parts.length - left, parts.length, left]) : null;
}

/** The picked chapter ids in the outline's order. */
export const pickedInOrder = (parts, picked) => parts.filter(part => picked.has(part.id)).map(part => part.id);

/** The scale of a pick (book/scale.js), as small lines: what it writes and calls, the material read, the sample when it starts with one, and the tip. */
export function ScaleLines({ scale }) {
  if (!scale.points) return <p className="book-pick__line" data-book-pick-scale="">{ui('选的章都已经写好，不用再生成。')}</p>;
  return (
    <div className="book-pick__scale" data-book-pick-scale="">
      <p className="book-pick__line">{uiFormat('要写 {0} 个知识点 · {1}', [scale.points, callsText(scale.calls)])}</p>
      <p className="book-pick__line">{uiFormat('读资料约 {0}（不含提示和模型写出的内容）', [rangeTok(scale.readTokens)])}</p>
      {scale.sample && <p className="book-pick__line">{ui('先写 2 个样例，按它们实际用的 token 推算其余的，你看过再继续。')}</p>}
      <p className="book-pick__line">{ui('整本比较费：可以把资料交给网页版 AI 生成后导入，或者用 opencode / commandcode 这类套餐再生成')}</p>
    </div>
  );
}

export default function BookPick({ parts, built = false, off = false, onScale, onBuild }) {
  useInjectCss(css, 'study-book-pick');
  const [picked, setPicked] = useState(() => new Set());
  const [scale, setScale] = useState(null);
  const chosen = pickedInOrder(parts, picked), key = chosen.join('\n');
  useLiveEffect(isLive => {
    if (!chosen.length) { setScale(null); return; }
    setScale('loading');
    Promise.resolve(onScale(chosen)).then(result => { if (isLive()) setScale(result?.scale ?? null); }, () => { if (isLive()) setScale(null); });
  }, [key, onScale]); // a new detail level asks again (onScale carries it)
  const flip = (id, on) => setPicked(current => { const next = new Set(current); if (on) next.add(id); else next.delete(id); return next; });
  const left = parts.filter(part => !part.written).length;
  const meta = chosen.length ? uiFormat('已选 {0} 章', [chosen.length]) : built && left ? uiFormat('{0} 章未生成', [left]) : null;
  return (
    <Disclosure className="book-pick" summary={built ? ui('生成其他章节') : ui('只生成部分章节')} meta={meta}>
      <p className="book-pick__note">{ui('勾选要生成的章：只写这些章的知识点、只读它们的资料；已经写好的不会重写，也不会再花一次。')}</p>
      <ul className="book-pick__list">
        {parts.map(part => <li key={part.id}>
          <Checkbox label={part.title} hint={partState(part)} checked={picked.has(part.id)} onChange={on => flip(part.id, on)} />
        </li>)}
      </ul>
      {scale === 'loading' && <LoadingState inline label={ui('正在估算…')} />}
      {scale && scale !== 'loading' && <ScaleLines scale={scale} />}
      <div className="book-pick__actions">
        <Button variant="secondary" icon="book" disabled={off || !chosen.length || scale?.points === 0} onClick={() => onBuild(chosen)}>
          {chosen.length ? uiFormat('生成所选 {0} 章', [chosen.length]) : ui('生成所选章节')}</Button>
      </div>
    </Disclosure>
  );
}
