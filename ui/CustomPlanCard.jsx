import React, { useState } from 'react';
import { ui, uiFormat, errorMessage } from './i18n.js';
import { useInjectCss } from './shared.js';
import { Chip, InlineMessage, Switch, Tooltip } from './components/index.js';
import { useStudy } from './study-context.jsx';
import { useLiveEffect } from './use-async.js';
import { BOOK_PARTS } from '../lib/custom-plan.js';
import CustomReadiness from './CustomReadiness.jsx';
import { customSummary, estimateLine, lockedPartIds, partTip, partWord, saveArgs, setPlan, setQuestions, setVariants, togglePart } from './custom-plan-model.js';
import css from './custom-plan-card.css';

/* 「你的定制」 on the course settings (深度定制, lib/custom-plan.js): the course's 定制方案 in one sentence, the rough cost under it (calls and tokens, never a price; read
   from course.custom.preview, again after every change), and one switch for each part of the book, for the questions, the variants and the plan. Every switch saves the
   whole record through course.save {custom} (the app's single-flight write) and shows a refusal on the card. Under them, the chapters' readiness and 补齐
   (ui/CustomReadiness.jsx). A course with no 定制方案 has no card: the main chat makes one. */
export default function CustomPlanCard({ course }) {
  useInjectCss(css, 'study-custom-card');
  const { call, act, busy } = useStudy();
  const custom = course?.custom ?? null;
  const [estimate, setEstimate] = useState(null), [error, setError] = useState(''), [working, setWorking] = useState(false);
  useLiveEffect(live => {
    if (!custom) return;
    Promise.resolve().then(() => call('course.custom.preview', { course: course.name })).then(value => { if (live()) setEstimate(value?.estimate ?? null); }).catch(() => {});
  }, [call, course?.name, custom?.updatedAt]);
  if (!custom) return null;
  const disabled = busy || working, locked = lockedPartIds(custom);
  const save = async next => {
    setWorking(true); setError('');
    try { await act('course.save', saveArgs(course, next), undefined, { rethrow: true }); } catch (caught) { setError(errorMessage(caught)); } finally { setWorking(false); }
  };
  const line = estimateLine(estimate);
  return <section className="course-settings__block custom-card" aria-labelledby="custom-card-title">
    <h3 id="custom-card-title">{ui('你的定制')}</h3>
    <p className="custom-card__summary">{customSummary(custom)}</p>
    {line && <p className="custom-card__estimate" role="status">{line}</p>}
    <ul className="custom-card__parts" aria-label={ui('复习全书的部分')}>
      {BOOK_PARTS.map(id => {
        const on = custom.book.parts.includes(id), stuck = on && locked.has(id);
        return <li key={id}>
          <Tooltip content={stuck ? uiFormat('先关掉要用到它的部分，才能关掉{0}', [partWord(id)]) : partTip(id)}>
            <Chip size="sm" selected={on} disabled={disabled || stuck} onClick={() => save(togglePart(custom, id))}>{partWord(id)}</Chip>
          </Tooltip>
        </li>;
      })}
    </ul>
    <div className="custom-card__switches">
      <Switch label={ui('出题')} checked={custom.questions.make} disabled={disabled} onChange={make => save(setQuestions(custom, make))} />
      <Tooltip content={ui('只有答错的题才会写变式题，所以现在不占调用。')}>
        <span><Switch label={ui('变式题')} checked={custom.questions.make && custom.questions.variants} disabled={disabled || !custom.questions.make}
          onChange={variants => save(setVariants(custom, variants))} /></span>
      </Tooltip>
      <Tooltip content={ui('按你的节奏排每天读哪几节，由程序排，不需要调用模型。')}>
        <span><Switch label={ui('学习计划')} checked={custom.plan.make} disabled={disabled} onChange={make => save(setPlan(custom, make))} /></span>
      </Tooltip>
    </div>
    {error && <InlineMessage tone="error">{error}</InlineMessage>}
    <CustomReadiness course={course} />
  </section>;
}
