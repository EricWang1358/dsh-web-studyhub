import React, { useEffect, useRef, useState } from 'react';
import { ui, uiFormat, errorMessage } from './i18n.js';
import { useInjectCss } from './shared.js';
import { Button, Checkbox, Chip, Disclosure, Hint, InlineMessage, Switch, Tooltip } from './components/index.js';
import { useStudy } from './study-context.jsx';
import { useLiveEffect } from './use-async.js';
import { BOOK_PARTS, isExamScopeUnconfirmed } from '../lib/custom-plan.js';
import CustomReadiness from './CustomReadiness.jsx';
import { customSummary, estimateLine, examChapterHint, examScopeChapters, examScopeSummaryText, initialExamSelection, lockedPartIds, partTip, partWord, saveArgs, setExamResolvedChapters, setPlan, setQuestions, setVariants, toggleExamChapter, togglePart, unknownChaptersText } from './custom-plan-model.js';
import { useHandOff } from './hand-off/use-hand-off.js';
import css from './custom-plan-card.css';

/* Conditional exam-scope review & confirmation block (StudyHub 5.0.0 · Evolution 2 #4): shown ONLY when scope.kind === 'exam'.
   Lists matched chapters and unmatched exam topics on the same screen so the learner can toggle chapters before confirming
   `scope.resolvedChapters`. Generation stays gated until confirmed. Zero persistent controls added for other scopes. */
function ExamScopeConfirm({ custom, preview, disabled, onConfirm }) {
  const examScope = preview?.examScope;
  const chapters = examScopeChapters(preview);
  const orderedIds = chapters.map(ch => ch.id);
  const unconfirmed = isExamScopeUnconfirmed(custom.scope);
  const seedKey = JSON.stringify([custom.updatedAt ?? '', custom.scope.resolvedChapters ?? null, (examScope?.matchedChapters || []).map(ch => ch.id)]);
  const seedInputRef = useRef({ custom, preview });
  seedInputRef.current = { custom, preview };
  const lastSeedKeyRef = useRef(seedKey);
  const [selected, setSelected] = useState(() => initialExamSelection(custom, preview));
  useEffect(() => {
    if (lastSeedKeyRef.current === seedKey) return;
    lastSeedKeyRef.current = seedKey;
    setSelected(initialExamSelection(seedInputRef.current.custom, seedInputRef.current.preview));
  }, [seedKey]);
  if (!examScope) return null;
  const unmatched = Array.isArray(examScope.unmatchedTopics) ? examScope.unmatchedTopics : [];
  const summary = examScopeSummaryText(examScope, selected.length);
  const changed = unconfirmed
    || selected.length !== (custom.scope.resolvedChapters?.length ?? 0)
    || selected.some((id, at) => id !== custom.scope.resolvedChapters?.[at]);

  const body = <div className="custom-card__exam-body">
    <p className="custom-card__exam-note">{summary}</p>
    {unmatched.length > 0 && <div className="custom-card__unmatched" role="region" aria-label={ui('未匹配的考试主题')}>
      <p className="custom-card__unmatched-title">{ui('未匹配的考试主题（请核对是否需要手动勾选对应章节）')}</p>
      <ul className="custom-card__unmatched-list">
        {unmatched.map(topic => <li key={topic} className="custom-card__unmatched-item">{topic}</li>)}
      </ul>
    </div>}
    {chapters.length > 0 && <ul className="custom-card__exam-chapters" aria-label={ui('考试范围章节')}>
      {chapters.map(chapter => {
        const checked = selected.includes(chapter.id), hint = examChapterHint(chapter);
        return <li key={chapter.id} className={chapter.matched ? 'custom-card__exam-row is-matched' : 'custom-card__exam-row'}>
          <Checkbox label={chapter.title} hint={hint || undefined} checked={checked} disabled={disabled}
            onChange={() => setSelected(current => toggleExamChapter(current, chapter.id, orderedIds))} />
        </li>;
      })}
    </ul>}
    <div className="custom-card__exam-actions">
      <Button size="sm" variant={unconfirmed ? 'primary' : 'secondary'} disabled={disabled || !selected.length || !changed}
        onClick={() => onConfirm(selected)}>
        {unconfirmed ? uiFormat('确认考试范围（{0} 章）', [selected.length]) : uiFormat('更新考试范围（{0} 章）', [selected.length])}
      </Button>
    </div>
  </div>;

  if (unconfirmed) {
    return <div className="custom-card__exam-scope is-unconfirmed" role="region" aria-label={ui('确认考试范围')}>
      <strong className="custom-card__exam-head">{ui('确认考试范围章节')}</strong>
      {body}
    </div>;
  }
  return <Disclosure className="custom-card__exam-disclosure" summary={ui('调整考试范围章节')} meta={summary}>
    {body}
  </Disclosure>;
}

/* 「你的定制」 on the course settings (深度定制, lib/custom-plan.js): the course's 定制方案 in one sentence, the rough cost under it (calls and tokens, never a price; read
   from course.custom.preview, again after every change), and one switch for each part of the book, for the questions, the variants and the plan. Every switch saves the
   whole record through course.save {custom} (the app's single-flight write) and shows a refusal on the card. Under them, the chapters' readiness and 补齐
   (ui/CustomReadiness.jsx). A course with no 定制方案 has no card: the main chat makes one. */
export default function CustomPlanCard({ course, data = null, onClose, initialPreview = null }) {
  useInjectCss(css, 'study-custom-card');
  const { call, act, busy } = useStudy();
  const handOff = useHandOff();
  const canChat = handOff.canChat;
  const custom = course?.custom ?? null;
  const focusKey = JSON.stringify(course?.focusTopics || []);
  const guidanceKey = JSON.stringify(course?.guidanceSourceIds || []);
  const [preview, setPreview] = useState(initialPreview), [error, setError] = useState(''), [working, setWorking] = useState(false);
  useLiveEffect(live => {
    if (!custom) return;
    Promise.resolve().then(() => call('course.custom.preview', { course: course.name })).then(value => { if (live()) setPreview(value ?? null); }).catch(() => {});
  }, [call, course?.name, custom?.updatedAt, focusKey, guidanceKey]);
  if (!custom) return null;
  const disabled = busy || working, locked = lockedPartIds(custom), examPending = isExamScopeUnconfirmed(custom.scope);
  const lockedNames = BOOK_PARTS.filter(id => custom.book.parts.includes(id) && locked.has(id)).map(partWord);
  const save = async next => {
    setWorking(true); setError('');
    try { await act('course.save', saveArgs(course, next), undefined, { rethrow: true }); } catch (caught) { setError(errorMessage(caught)); } finally { setWorking(false); }
  };
  const line = estimateLine(preview?.estimate), unknown = unknownChaptersText(preview);
  return <section className="course-settings__block custom-card" aria-labelledby="custom-card-title">
    <h3 id="custom-card-title">{ui('你的定制')}</h3>
    <p className="custom-card__summary">{customSummary(custom)}</p>
    {line && <p className="custom-card__estimate" role="status">{line}</p>}
    {custom.scope.kind === 'exam' && <ExamScopeConfirm custom={custom} preview={preview} disabled={disabled} onConfirm={ids => save(setExamResolvedChapters(custom, ids))} />}
    <Hint>{ui('以下各项切换后立即生效，不用点底部保存。')}</Hint>
    {/* A plan whose chapters moved: the chat is where the plan was made, so the card says it once and gives the one action that re-picks them (#758). */}
    {unknown && <InlineMessage tone="warning" secondary={handOff.action('custom.start', { course: course.name, hasCustom: true }, { what: canChat ? '让主会话重新选这几章' : '复制重新选定章节的提示词' })}>{unknown}</InlineMessage>}
    <ul className="custom-card__parts" aria-label={ui('复习全书的部分')}>
      {BOOK_PARTS.map(id => {
        const on = custom.book.parts.includes(id), stuck = on && locked.has(id);
        return <li key={id}>
          <Tooltip layer content={stuck ? uiFormat('先关掉要用到它的部分，才能关掉{0}', [partWord(id)]) : partTip(id)}>
            <Chip size="sm" selected={on} disabled={disabled || stuck} onClick={() => save(togglePart(custom, id))}>{partWord(id)}</Chip>
          </Tooltip>
        </li>;
      })}
    </ul>
    {lockedNames.length > 0 && <Hint>{uiFormat('已锁定的部分（{0}）被其他已选部分依赖，先关闭依赖它的部分才能取消。', [lockedNames.join(ui('、'))])}</Hint>}
    <div className="custom-card__switches">
      <Switch label={ui('出题')} checked={custom.questions.make} disabled={disabled} onChange={make => save(setQuestions(custom, make))} />
      <Switch label={ui('变式题')} checked={custom.questions.make && custom.questions.variants} disabled={disabled || !custom.questions.make}
        hint={custom.questions.make ? ui('只有答错的题才会写变式题，所以现在不占调用。') : ui('开启上方「出题」后才能开启变式题；只有答错的题才会写，现在不占调用。')}
        onChange={variants => save(setVariants(custom, variants))} />
      <Switch label={ui('学习计划')} checked={custom.plan.make} disabled={disabled}
        hint={ui('按你的节奏排每天读哪几节，由程序排，不需要调用模型。')}
        onChange={make => save(setPlan(custom, make))} />
    </div>
    {error && <InlineMessage tone="error">{error}</InlineMessage>}
    {!examPending && <CustomReadiness course={course} data={data} onClose={onClose} />}
  </section>;
}
