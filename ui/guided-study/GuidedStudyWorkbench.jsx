import React, { useEffect, useState } from 'react';
import Markdown from '../Markdown.jsx';
import { getUiLanguage, ui, uiFormat } from '../i18n.js';
import { Button } from '../components/Button.jsx';
import { Badge } from '../components/Badge.jsx';
import { Tooltip, Icon } from '../components/index.js';
import { joinMeta } from '../format.js';
import { TeachingArtifactBlock } from './TeachingArtifactBlock.jsx';
import { QuestionPrepSlot } from './QuestionPrepSlot.jsx';
import { StudyProgressPanel } from './StudyProgressPanel.jsx';
import { buildAskTutorPrompt, applyAskTutorMessage } from '../agent-prompts/guided-study.js';
import { HandOff } from '../hand-off/HandOff.jsx';
import { useStudy } from '../study-context.jsx';
import { useInjectCss } from '../shared.js';
import css from './guided-study.css';
import GuidedStudyStart from './GuidedStudyStart.jsx';
import { hasOptions } from '../../lib/card-kinds.js';
import { fixedOptionLabel } from '../option-label.js';
import { rubricAttemptPassed } from '../../lib/course-method.js';
import { playSound } from '../sound-effects.js';

/* How the session's status reads to the learner (never the raw value). */
const STATUS_WORD = { active: '带学进行中', paused: '带学已暂停', ended: '带学已结束' };

/** Keyboard retrieval loop inside the guided-study card (digits/letters pick options, Enter/Space reveal, advance, or self-rate). */
export function handleGuidedWorkbenchKeyDown(event, {
  currentCard,
  isPreparing = false,
  busy = false,
  choice = false,
  selected = [],
  setSelected,
  isRevealed = false,
  hasFeedback = false,
  run,
  onAnswer,
  onReveal,
  onNext,
} = {}) {
  if (!currentCard || isPreparing || busy || event.repeat || event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey) return false;
  if (event.nativeEvent?.isComposing || event.isComposing || event.keyCode === 229) return false;
  const target = event.target;
  const tag = typeof target?.tagName === 'string' ? target.tagName.toUpperCase() : '';
  const inputType = typeof target?.type === 'string' ? target.type.toLowerCase() : '';
  const inTextInput = tag === 'INPUT' && inputType !== 'radio' && inputType !== 'checkbox';
  if (inTextInput || tag === 'TEXTAREA' || tag === 'SELECT' || target?.isContentEditable || target?.closest?.('textarea, select, [contenteditable="true"]')) {
    return false;
  }
  const onInteractiveControl = Boolean(
    tag === 'BUTTON' || tag === 'A' || tag === 'SUMMARY' || target?.getAttribute?.('role') === 'button'
    || target?.closest?.('button, a, summary, [role="button"]'),
  );

  if (!hasFeedback) {
    if (choice) {
      let idx = -1;
      if (/^[1-9]$/.test(event.key)) idx = Number(event.key) - 1;
      else if (/^[a-iA-I]$/.test(event.key)) idx = event.key.toLowerCase().charCodeAt(0) - 97;
      if (idx >= 0 && idx < currentCard.options.length) {
        const option = currentCard.options[idx];
        event.preventDefault();
        if (typeof setSelected === 'function') {
          const next = currentCard.kind === 'multi'
            ? (selected.includes(option.id) ? selected.filter((id) => id !== option.id) : [...selected, option.id])
            : [option.id];
          if (currentCard.kind === 'multi' || !selected.includes(option.id)) playSound('tap');
          setSelected(next);
        }
        return true;
      }
      if (event.key === 'Enter' && !onInteractiveControl && selected.length > 0 && onAnswer) {
        event.preventDefault();
        onAnswer({ selected });
        return true;
      }
      return false;
    }
    if (!isRevealed) {
      if ((event.key === ' ' || event.key === 'Enter') && !onInteractiveControl && onReveal) {
        event.preventDefault();
        onReveal(run?.id);
        return true;
      }
      return false;
    }
    if (onAnswer) {
      if (event.key === '1') {
        event.preventDefault();
        onAnswer(1);
        return true;
      }
      if (event.key === '2' || event.key === '3') {
        event.preventDefault();
        onAnswer(3);
        return true;
      }
    }
    return false;
  }

  if ((event.key === 'Enter' || event.key === ' ') && !onInteractiveControl && onNext) {
    event.preventDefault();
    onNext(run?.id);
    return true;
  }
  return false;
}

export default function GuidedStudyWorkbench({
  session,
  run,
  busy = false,
  modelReady = true,
  courses = null,
  prepState = null,
  progress = null,
  estimate = null,
  cost = null,
  host = null,
  onPause,
  onResume,
  onTogglePause = onResume,
  onEnd,
  onAnswer,
  onReveal,
  onAnchorClick,
  onCancelPrep,
  onFallbackToExisting,
  onUpdateProgressItem,
  onAddProgressItem,
  onDeleteProgressItem,
  onSelectAttempt,
  onBeforeAskTutor,
  onAskTutor,
  onNext,
}) {
  useInjectCss(css, 'study-guided-study');
  const study = useStudy();
  const effectiveBusy = busy || Boolean(study?.busy);
  const effectiveHost = host || study?.host;
  const [tutorMessage, setTutorMessage] = useState('');

  const isArtifactFocus = session?.focus?.kind === 'artifact' || session?.focus?.kind === 'source';
  const adaptiveClass = isArtifactFocus
    ? 'guided-study-adaptive-artifact'
    : 'guided-study-adaptive-card';

  const currentArtifact = session?.artifactRefs?.find((a) => a.id === session?.focus?.id) ||
    session?.artifactRefs?.at(-1) || null;

  const currentCard = run?.card || (run?.entries ? run.entries[run.index]?.card : null);
  const currentFeedback = run?.feedback || (run?.entries ? run.entries[run.index]?.feedback : null);
  const currentSolution = run?.solution || (run?.entries ? run.entries[run.index]?.solution : null);
  const isRevealed = Boolean(run?.revealed ?? (run?.entries ? run.entries[run.index]?.revealed : false));
  const hasFeedback = Boolean(currentFeedback);
  const currentMissed = Boolean(hasFeedback && (currentFeedback.rubric
    ? !rubricAttemptPassed({
      assessment: 'rubric',
      score: currentFeedback.rubric.total,
      maxScore: currentFeedback.rubric.max,
      rubric: currentFeedback.rubric,
    })
    : currentFeedback.correct === false));

  const choice = hasOptions(currentCard?.kind) && Array.isArray(currentCard?.options) && currentCard.options.length > 0;
  const revealedAnswer = !choice ? (currentSolution?.answer ?? currentCard?.answer ?? '') : '';
  const revealedExplanation = currentSolution?.explanation ?? currentCard?.explanation ?? '';
  const isGradedCard = choice || Boolean(currentFeedback?.rubric);
  const verdictText = !hasFeedback ? '' : isGradedCard
    ? (currentMissed ? ui('这道题还没过关，先看下方解析或带回主会话讲透') : ui('回答正确'))
    : (currentMissed ? ui('已记入待巩固，先看解析或带回主会话') : ui('已记录掌握，会计入检验与复习排期'));
  const [selected, setSelected] = useState([]);
  useEffect(() => { setSelected([]); setTutorMessage(''); }, [currentCard?.id, run?.id, session?.id]);
  const effectiveSelected = hasFeedback && Array.isArray(currentFeedback?.selected) ? currentFeedback.selected : selected;

  const isPreparing = (prepState && prepState.status) || session?.focus?.kind === 'preparing-card';
  const effectivePrepState = prepState || (session?.focus?.kind === 'preparing-card'
    ? { status: 'running', ...session.focus }
    : null);

  /* The progress is worked out by the library from the answers (study.session.get puts it, the range and the cost on the session). Before the
     session has been read once it claims no result: the items are listed, without a status. */
  const derivedProgress = progress || session?.progress || (session?.goal?.checkItems ? {
    displayLine: uiFormat('检验项共 {0} 项', [session.goal.checkItems.length]),
    lectureCoveredCount: session.artifactRefs?.length || 0,
    items: session.goal.checkItems.map((item) => ({ id: item.id, title: item.title })),
  } : {});

  const handleAskTutor = async () => {
    // Asking is help the answer got whether or not the chat ever answers, so it is on record first (as assistCard does).
    onBeforeAskTutor?.();
    const card = currentCard;
    const prompt = buildAskTutorPrompt({
      sessionId: session?.id,
      runId: run?.id,
      deckId: run?.deckId || card?.deckId,
      cardId: card?.id,
      stem: card?.prompt || '',
      answered: hasFeedback,
      correct: hasFeedback ? Boolean(currentFeedback?.correct) : null,
      language: getUiLanguage(),
    });
    const result = await applyAskTutorMessage(effectiveHost, prompt, getUiLanguage());
    if (result?.status === 'copied_to_clipboard') {
      let copied = false;
      if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
        try {
          await navigator.clipboard.writeText(prompt);
          copied = true;
        } catch { /* no clipboard permission: the textarea copy below is tried next */ }
      }
      if (!copied && typeof document !== 'undefined') {
        try {
          const textarea = document.createElement('textarea');
          textarea.value = prompt;
          textarea.style.position = 'fixed';
          textarea.style.opacity = '0';
          document.body.appendChild(textarea);
          textarea.select();
          document.execCommand('copy');
          document.body.removeChild(textarea);
        } catch { /* nothing could copy it: `copied` stays false */ }
      }
    }
    if (onAskTutor) {
      setTutorMessage('');
      onAskTutor(result);
    } else if (study?.notify) {
      setTutorMessage('');
      study.notify(result?.message || '');
    } else {
      setTutorMessage(result?.message || '');
    }
  };

  return (
    <div
      className={`guided-study-workbench ${adaptiveClass}`}
      onKeyDown={(event) => handleGuidedWorkbenchKeyDown(event, {
        currentCard,
        isPreparing,
        busy: effectiveBusy,
        choice,
        selected,
        setSelected,
        isRevealed,
        hasFeedback,
        run,
        onAnswer,
        onReveal,
        onNext,
      })}
    >
      {/* 1. 顶部紧凑目标栏 */}
      <div className="guided-study-topbar">
        <div className="guided-study-topbar-info">
          <Badge size="sm">{(Array.isArray(courses) && courses.find((c) => c?.id === session?.courseId || c?.name === session?.courseId)?.name) || session?.courseId || ui('带学')}</Badge>
          <span className="guided-study-title">{session?.goal?.title || ui('还没有定学习目标')}</span>
        </div>
        <div className="guided-study-actions">
          {session?.status === 'active' && (
            <Button
              variant="secondary"
              size="sm"
              className="guided-study-btn"
              lock={effectiveBusy}
              onClick={() => onPause?.(session.id)}
            >
              {ui('暂停')}
            </Button>
          )}
          {session?.status === 'paused' && (
            <Button
              variant="primary"
              size="sm"
              className="guided-study-btn"
              lock={effectiveBusy}
              onClick={() => onTogglePause?.(session.id)}
            >
              {ui('继续')}
            </Button>
          )}
          <Button
            variant="secondary"
            size="sm"
            className="guided-study-btn"
            lock={effectiveBusy}
            onClick={() => onEnd?.(session.id)}
          >
            {ui('结束')}
          </Button>
        </div>
      </div>

      {session?.status === 'paused' && (
        <div className="guided-study-model-warning" role="status">
          {ui('带学已暂停。点右上角「继续」恢复当前带学进度。')}
        </div>
      )}

      {/* UC-10 模型不可用降级提示 */}
      {!modelReady && (
        <div className="guided-study-model-warning" role="alert">
          {ui('没有可用的 AI 模型：带学的讲解和现场出题暂停了；读资料、做已有的题、复习和看问答都照常。')}
        </div>
      )}

      {/* 主工作区：根据动作自适应展开 */}
      <div className="guided-study-main">
        {/* 2. 当前教学内容区 */}
        <div className="guided-study-artifact-section">
          <TeachingArtifactBlock
            artifact={currentArtifact}
            onAnchorClick={onAnchorClick}
          />
        </div>

        {/* 3. 当前练习区 */}
        <div className="guided-study-practice-section">
          {isPreparing ? (
            <QuestionPrepSlot
              prepState={effectivePrepState}
              onCancel={onCancelPrep}
              onFallbackToExisting={onFallbackToExisting}
            />
          ) : currentCard ? (
            <div className="guided-study-card-view sh-paper-card sh-paper-card--snug" tabIndex={-1}>
              <div className="guided-study-card-prompt">
                <Markdown text={currentCard.prompt} />
              </div>

              {/* A choice question is answered on its options and graded by the card (#547): never a self-report of 我掌握了. */}
              {choice && (
                <fieldset className="guided-study-card-options" disabled={hasFeedback}>
                  <legend className="sh-visually-hidden">{ui('选项')}</legend>
                  {currentCard.options.map((option) => {
                    const picked = effectiveSelected.includes(option.id);
                    const solOpt = currentSolution?.options?.find((x) => x.id === option.id);
                    const isCorrect = Boolean(solOpt?.correct ?? option.correct);
                    const verdict = hasFeedback ? (isCorrect ? 'correct' : picked ? 'wrong' : undefined) : undefined;
                    return (
                      <label key={option.id} className="guided-study-card-option" data-picked={picked || undefined} data-verdict={verdict}>
                        <input type={currentCard.kind === 'multi' ? 'checkbox' : 'radio'} name={`guided-${currentCard.id}`} checked={picked}
                          onChange={() => {
                            if (currentCard.kind === 'multi' || !picked) playSound('tap');
                            setSelected(currentCard.kind === 'multi'
                              ? (picked ? selected.filter((id) => id !== option.id) : [...selected, option.id])
                              : [option.id]);
                          }} />
                        <div className="guided-study-card-option-body">
                          {fixedOptionLabel(currentCard, option) ?? <Markdown text={option.text} links={false} className="md-compact" />}
                          {hasFeedback && solOpt?.explanation && (
                            <div className="guided-study-card-option-note">
                              <Markdown text={solOpt.explanation} links={false} className="md-compact" />
                            </div>
                          )}
                        </div>
                      </label>
                    );
                  })}
                </fieldset>
              )}

              {hasFeedback && (
                <div
                  className="guided-study-card-verdict"
                  data-testid="guided-card-verdict"
                  data-tone={currentMissed ? 'warning' : 'success'}
                  role="status"
                >
                  <Icon className="sh-icon--inline" name={currentMissed ? 'info' : 'check'} />
                  <span>{verdictText}</span>
                </div>
              )}

              {(isRevealed || hasFeedback) && revealedAnswer && (
                <div className="guided-study-card-answer" data-testid="guided-card-answer">
                  <strong className="guided-study-card-answer-label">{ui('参考答案')}</strong>
                  <Markdown text={revealedAnswer} />
                </div>
              )}

              {(isRevealed || hasFeedback) && revealedExplanation && (
                <div className="guided-study-card-explanation">
                  <Markdown text={revealedExplanation} />
                </div>
              )}

              <div className="guided-study-card-actions">
                {hasFeedback ? (
                  onNext ? (
                    <Button variant="primary" size="sm" iconEnd="arrow-right" className="guided-study-btn" lock={effectiveBusy} onClick={() => onNext?.(run?.id)}>
                      {ui('下一题')}
                    </Button>
                  ) : null
                ) : choice ? (
                  <Button variant="primary" size="sm" className="guided-study-btn" lock={effectiveBusy} disabled={!selected.length || !onAnswer}
                    onClick={() => onAnswer?.({ selected })}>
                    {ui('提交答案')}
                  </Button>
                ) : !isRevealed ? (
                  <Button variant="primary" size="sm" className="guided-study-btn" lock={effectiveBusy} onClick={() => onReveal?.(run?.id)}>
                    {ui('揭晓答案')}
                  </Button>
                ) : onAnswer ? (
                  <>
                    <Button variant="secondary" size="sm" className="guided-study-btn" lock={effectiveBusy} onClick={() => onAnswer(1)}>
                      {ui('没掌握')}
                    </Button>
                    <Button variant="primary" size="sm" className="guided-study-btn" lock={effectiveBusy} onClick={() => onAnswer(3)}>
                      {ui('我掌握了')}
                    </Button>
                  </>
                ) : null}
                <Tooltip layer content={ui('把这道题和你的作答发给主会话')}>
                  <Button
                    variant="secondary"
                    size="sm"
                    className="guided-study-btn"
                    onClick={handleAskTutor}
                  >
                    {ui('请教主会话')}
                  </Button>
                </Tooltip>
                {currentMissed && (
                  <HandOff
                    id="method.missed"
                    shape="quiet"
                    label={ui('带着错题回主会话')}
                    copyLabel={ui('复制错题讲解提示词')}
                    what={ui('把这道没过关的题目带回主会话讲透，讲完再回 StudyHub 重测')}
                    copyWhat={ui('复制这道错题的提示词，可粘贴到外部 AI 讲透后再回 StudyHub 重测')}
                    input={{
                      course: session?.courseId || '',
                      stage: session?.goal?.title || '',
                      missed: [{
                        deckId: run?.deckId || currentCard.deckId,
                        cardId: currentCard.id,
                        topic: currentCard.topic || '',
                        prompt: String(currentCard.prompt || '').slice(0, 240),
                      }],
                    }}
                  />
                )}
              </div>

              {tutorMessage && (
                <div className="guided-study-tutor-message" role="status">
                  {tutorMessage}
                </div>
              )}
            </div>
          ) : (
            <div className="guided-study-practice-empty">
              <span>{ui('现在没有要做的题。在主会话里说一句就能开始，比如：')}</span>
              <GuidedStudyStart compact />
            </div>
          )}
        </div>
      </div>

      {/* 4. 底部状态与 QA 折叠栏 */}
      <div className="guided-study-footer">
        <StudyProgressPanel
          progress={derivedProgress}
          estimate={estimate || session?.estimate || {}}
          cost={cost || session?.cost || null}
          session={session || {}}
          onUpdateItem={onUpdateProgressItem}
          onAddItem={onAddProgressItem}
          onDeleteItem={onDeleteProgressItem}
          onSelectAttempt={onSelectAttempt}
        />
        <div className="guided-study-footer-status">
          <span>{joinMeta([ui(STATUS_WORD[session?.status] || STATUS_WORD.active),
            session?.returnPath?.length > 0 && uiFormat('支线 {0} 层，做完会回到原来那道题', [session.returnPath.length])])}</span>
        </div>
      </div>
    </div>
  );
}
