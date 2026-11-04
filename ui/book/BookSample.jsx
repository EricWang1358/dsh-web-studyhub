import React from 'react';
import { ui, uiFormat } from '../i18n.js';
import { Button, Tooltip } from '../components/index.js';
import { TokenEstimateView } from '../TokenUsage.jsx';
import { callsText } from '../token-usage.js';
import { useInjectCss } from '../shared.js';
import { levelText } from '../outline/words.js';
import css from './book-sample.css';

/* The sample of a 复习全书 build while it waits for the learner (#710; lib/course-book-sample.js waitingSample): the 总纲's book line and the book page show it.
   Its two points (the typical one first; on the book page links to their headings), the scale of the rest as the sample measured it (points, calls, tokens
   the way DSH's usage panel writes them, time at the current text concurrency; never a price) and the tip about cheaper ways. ONE primary button: 生成其余 N 个
   (the rest in the sample's style); 重做样例 is quiet, its hover says what it does, and it leads instead when the sample no longer shows what the learner would
   get (the detail level changed since) or was not written. Props: sample, coverage (the level chosen now), off (no model, or busy), quiet (something else on
   the page is the main action: no primary here), onRest, onRedo, onOpen(point) (optional). */

const ROLES = [() => ui('典型'), () => ui('较重')];
/** How long the rest takes at the current text concurrency, from the sample's own call times. */
function timeText(minutes, lanes) {
  if (!minutes || minutes.high < 1) return uiFormat('按现在的并行 {0} 个，不到 1 分钟', [lanes]);
  const low = Math.max(1, minutes.low);
  return low === minutes.high ? uiFormat('按现在的并行 {0} 个，大约 {1} 分钟', [lanes, low]) : uiFormat('按现在的并行 {0} 个，大约 {1}–{2} 分钟', [lanes, low, minutes.high]);
}
const methodText = count => uiFormat('按样例这 {0} 个知识点实际用的调用和 token 推算：较轻的那个是下限，样例的平均是上限；缓存命中越多，实际越少。', [count]);

/** Why 重做样例 leads, or null when 生成其余 may go on. */
function blockText(sample, coverage) {
  if (!sample.written) return ui('样例没写成：模型没有给出可用的讲解。可以改设置后重做样例。');
  if (coverage && coverage !== sample.level) return uiFormat('讲解详尽程度改成了「{0}」，样例是按「{1}」写的：先重做样例，再生成其余。', [levelText(coverage), levelText(sample.level)]);
  return null;
}

function Scale({ estimate }) {
  const rest = estimate.points.rest, lead = ui('生成其余：');
  return (
    <div className="book-sample__scale" data-book-sample-scale="">
      <p className="book-sample__line">{uiFormat('整本 {0} 个知识点，样例 {1} 个，其余 {2} 个', [estimate.points.total, estimate.points.sample, rest])}</p>
      {estimate.totalTokens
        ? <TokenEstimateView state={{ status: 'ready', estimate }} lead={lead} method={methodText(estimate.points.sample)} />
        : <p className="book-sample__line">{`${lead}${callsText(estimate.calls)}`}</p>}
      <p className="book-sample__line">{timeText(estimate.minutes, estimate.concurrency)}</p>
    </div>
  );
}

export default function BookSample({ sample, coverage = null, off = false, quiet = false, onRest, onRedo, onOpen }) {
  useInjectCss(css, 'study-book-sample');
  const blocked = blockText(sample, coverage), rest = sample.estimate?.points.rest ?? null;
  const redo = <Tooltip layer content={uiFormat('改了讲解详尽程度或样卷以后，按新的设置只重写这 {0} 个知识点；其余的还没写。', [sample.points.length])}>
    <Button variant={blocked && !quiet ? 'primary' : blocked ? 'secondary' : 'quiet'} size={blocked ? undefined : 'sm'} icon="refresh" disabled={off} onClick={onRedo}>{ui('重做样例')}</Button>
  </Tooltip>;
  return (
    <section className="book-sample" aria-label={ui('样例')} data-book-sample="">
      <h3 className="book-sample__title">{uiFormat('样例：先写了 {0} 个知识点', [sample.points.length])}</h3>
      <p className="book-sample__lead">{rest === null ? ui('先读一读这两个知识点的讲解，再决定其余的怎么写。')
        : uiFormat('先读一读：满意就生成其余 {0} 个，它们照样例的写法和篇幅写；不满意就改讲解详尽程度或样卷，再重做样例。', [rest])}</p>
      <ul className="book-sample__points">
        {sample.points.map((point, at) => <li key={point.id}>
          <span className="book-sample__role">{(ROLES[at] || ROLES[0])()}</span>
          {onOpen ? <Button variant="quiet" size="sm" icon="book" onClick={() => onOpen(point)}>{point.title}</Button> : <span>{point.title}</span>}
        </li>)}
      </ul>
      {sample.estimate && <Scale estimate={sample.estimate} />}
      <p className="book-sample__tip">{ui('整本比较费：可以把资料交给网页版 AI 生成后导入，或者用 opencode / commandcode 这类套餐再生成')}</p>
      {blocked && <p className="book-sample__block" role="status">{blocked}</p>}
      <div className="book-sample__actions">
        {!blocked && <Button variant={quiet ? 'secondary' : 'primary'} icon="book" disabled={off} onClick={onRest}>{rest === null ? ui('生成其余知识点') : uiFormat('生成其余 {0} 个', [rest])}</Button>}
        {redo}
      </div>
    </section>
  );
}
