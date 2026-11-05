import React, { useState } from 'react';
import { ui, uiFormat, errorMessage } from './i18n.js';
import { useInjectCss } from './shared.js';
import { Badge, Button, InlineConfirm, ProgressBar, Tooltip } from './components/index.js';
import { useStudy } from './study-context.jsx';
import { useLiveEffect } from './use-async.js';
import { barName, chapterShare, countsLine, fillCalls, fillParts, hasTodo, isUnbuilt, qualityLine, shareText, solidMeaning, startedNotice } from './custom-readiness-model.js';
import css from './custom-readiness.css';

/* 「章节准备度」 in the 「你的定制」 card (深度定制 S5): each chapter of the plan with a thin bar of how ready it is (course.custom.readiness), its four counts and what the review
   sent back on hover, 未生成 where the book has not written it, and 补齐: one button a chapter and one for all, which says what it would start and the rough calls
   (course.custom.fill {estimate: true}), then starts only on 开始 (the app's single-flight write; the work is an ordinary job of 任务). Nothing is shown before the course has
   an outline: the chapters have no points yet. */
export default function CustomReadiness({ course }) {
  useInjectCss(css, 'study-custom-readiness');
  const { call, act, busy, notify } = useStudy();
  const [data, setData] = useState(null), [stamp, setStamp] = useState(0), [pending, setPending] = useState(null), [working, setWorking] = useState(false);
  useLiveEffect(live => {
    Promise.resolve().then(() => call('course.custom.readiness', { course: course.name })).then(value => { if (live()) setData(value); }).catch(() => {});
  }, [call, course?.name, course?.custom?.updatedAt, stamp]);
  if (data?.status !== 'ok' || data.basis !== 'outline' || !data.chapters.length) return null;
  const { counted, chapters } = data, disabled = busy || working, todo = chapters.filter(hasTodo);
  // `ids` null is every chapter of the plan. The estimate starts nothing; the question comes back as the box below the list.
  const ask = async (ids, name) => {
    setPending({ ids, name, answer: null });
    try {
      const answer = await call('course.custom.fill', { course: course.name, ...(ids ? { chapters: ids } : {}), estimate: true });
      setPending(answer?.status === 'ok' ? { ids, name, answer } : null);
    } catch (caught) { setPending(null); notify({ text: errorMessage(caught), tone: 'error' }); }
  };
  const start = async () => {
    const { ids } = pending;
    setWorking(true);
    try {
      await act('course.custom.fill', { course: course.name, ...(ids ? { chapters: ids } : {}) }, result => notify(startedNotice(result)), { rethrow: true });
      setPending(null); setStamp(value => value + 1);
    } catch (caught) { notify({ text: errorMessage(caught), tone: 'error' }); } finally { setWorking(false); }
  };
  return <div className="custom-readiness" data-tour="custom-readiness">
    <div className="custom-readiness__head">
      <h4>{ui('章节准备度')}</h4>
      {todo.length > 1 && <Button variant="quiet" size="sm" disabled={disabled || !!pending} onClick={() => ask(null, uiFormat('全部 {0} 章', [todo.length]))}>{ui('全部补齐')}</Button>}
    </div>
    <ul className="custom-readiness__list">
      {chapters.map(chapter => {
        const tip = [countsLine(chapter, counted), qualityLine(chapter), solidMeaning()].filter(Boolean);
        return <li key={chapter.id} className="custom-readiness__row">
          <span className="custom-readiness__title">{chapter.title}</span>
          <Tooltip content={<>{tip.map((line, at) => <span key={at} className="custom-readiness__tip">{line}</span>)}</>} placement="bottom-start" anchorClassName="custom-readiness__anchor">
            <span className="custom-readiness__meter" tabIndex={0}>
              <ProgressBar size="sm" value={Math.round(chapterShare(chapter, counted) * 100)} label={barName(chapter, counted)} />
              <span className="custom-readiness__value">{shareText(chapter, counted)}</span>
            </span>
          </Tooltip>
          {isUnbuilt(chapter, counted) && <Badge size="sm" tone="neutral" className="custom-readiness__flag">{ui('未生成')}</Badge>}
          {hasTodo(chapter) && <Button variant="quiet" size="sm" className="custom-readiness__fill" disabled={disabled || !!pending} onClick={() => ask([chapter.id], uiFormat('「{0}」', [chapter.title]))}>{ui('补齐')}</Button>}
        </li>;
      })}
    </ul>
    {pending?.answer && <InlineConfirm tone="primary" title={uiFormat('补齐 {0}', [pending.name])} confirmLabel={ui('开始补齐')} busy={working} onConfirm={start} onCancel={() => setPending(null)}>
      <p className="custom-readiness__plan">{fillParts(pending.answer)}</p>
      <p className="custom-readiness__plan">{fillCalls(pending.answer)}</p>
    </InlineConfirm>}
  </div>;
}
