import React, { useEffect, useState } from 'react';
import Markdown from '../Markdown.jsx';
import { getUiLanguage, ui, uiFormat } from '../i18n.js';
import { Button } from '../components/Button.jsx';
import { Badge } from '../components/Badge.jsx';
import { joinMeta } from '../format.js';
import { TeachingArtifactBlock } from './TeachingArtifactBlock.jsx';
import { QuestionPrepSlot } from './QuestionPrepSlot.jsx';
import { StudyProgressPanel } from './StudyProgressPanel.jsx';
import { buildAskTutorPrompt, applyAskTutorMessage } from '../agent-prompts/guided-study.js';
import { useStudy } from '../study-context.jsx';
import './guided-study.css';
import GuidedStudyStart from './GuidedStudyStart.jsx';

/* How the session's status reads to the learner (never the raw value). */
const STATUS_WORD = { active: '带学进行中', paused: '带学已暂停', ended: '带学已结束' };

export default function GuidedStudyWorkbench({
  session,
  run,
  modelReady = true,
  prepState = null,
  progress = null,
  estimate = null,
  cost = null,
  host = null,
  onPause,
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
  onAskTutor,
  onNext,
}) {
  const study = useStudy();
  const effectiveHost = host || study?.host;
  const [tutorMessage, setTutorMessage] = useState('');

  const isArtifactFocus = session?.focus?.kind === 'artifact' || session?.focus?.kind === 'source';
  const adaptiveClass = isArtifactFocus
    ? 'guided-study-adaptive-artifact'
    : 'guided-study-adaptive-card';

  const currentArtifact = session?.artifactRefs?.find((a) => a.id === session?.focus?.id) ||
    session?.artifactRefs?.at(-1) || null;

  const currentCard = run?.card || (run?.entries ? run.entries[run.index]?.card : null);
  const isRevealed = Boolean(run?.revealed ?? (run?.entries ? run.entries[run.index]?.revealed : false));
  const hasFeedback = Boolean(run?.feedback || (run?.entries ? run.entries[run.index]?.feedback : false));

  const choice = ['quiz', 'multi'].includes(currentCard?.kind) && Array.isArray(currentCard?.options) && currentCard.options.length > 0;
  const [selected, setSelected] = useState([]);
  useEffect(() => { setSelected([]); }, [currentCard?.id, run?.id]);

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
    const card = currentCard;
    const prompt = buildAskTutorPrompt({
      sessionId: session?.id,
      runId: run?.id,
      deckId: run?.deckId || card?.deckId,
      cardId: card?.id,
      stem: card?.prompt || '',
      answered: hasFeedback,
      correct: hasFeedback ? Boolean((run?.feedback || run?.entries?.[run.index]?.feedback)?.correct) : null,
      language: getUiLanguage(),
    });
    const result = await applyAskTutorMessage(effectiveHost, prompt, 'zh');
    if (result?.status === 'copied_to_clipboard') {
      let copied = false;
      if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
        try {
          await navigator.clipboard.writeText(prompt);
          copied = true;
        } catch {}
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
        } catch {}
      }
    }
    setTutorMessage(result?.message || '');
    if (onAskTutor) {
      onAskTutor(result);
    } else if (study?.notify) {
      study.notify(result?.message || '');
    }
  };

  return (
    <div className={`guided-study-workbench ${adaptiveClass}`}>
      {/* 1. 顶部紧凑目标栏 */}
      <div className="guided-study-topbar">
        <div className="guided-study-topbar-info">
          <Badge size="sm">{session?.courseId || ui('带学')}</Badge>
          <span className="guided-study-title">{session?.goal?.title || ui('还没有定学习目标')}</span>
        </div>
        <div className="guided-study-actions">
          {session?.status === 'active' && (
            <Button
              variant="secondary"
              size="sm"
              className="guided-study-btn"
              onClick={() => onPause?.(session.id)}
            >
              {ui('暂停')}
            </Button>
          )}
          <Button
            variant="secondary"
            size="sm"
            className="guided-study-btn"
            onClick={() => onEnd?.(session.id)}
          >
            {ui('结束')}
          </Button>
        </div>
      </div>

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
            <div className="guided-study-card-view">
              <div className="guided-study-card-prompt">
                <Markdown text={currentCard.prompt} />
              </div>

              {/* A choice question is answered on its options and graded by the card (#547): never a self-report of 我掌握了. */}
              {choice && (
                <fieldset className="guided-study-card-options" disabled={hasFeedback}>
                  <legend className="sh-visually-hidden">{ui('选项')}</legend>
                  {currentCard.options.map((option) => {
                    const picked = selected.includes(option.id);
                    const verdict = hasFeedback && (option.correct ? 'correct' : picked ? 'wrong' : undefined);
                    return (
                      <label key={option.id} className="guided-study-card-option" data-picked={picked || undefined} data-verdict={verdict}>
                        <input type={currentCard.kind === 'multi' ? 'checkbox' : 'radio'} name={`guided-${currentCard.id}`} checked={picked}
                          onChange={() => setSelected(currentCard.kind === 'multi'
                            ? (picked ? selected.filter((id) => id !== option.id) : [...selected, option.id])
                            : [option.id])} />
                        <Markdown text={option.text} links={false} className="md-compact" />
                      </label>
                    );
                  })}
                </fieldset>
              )}

              {(isRevealed || hasFeedback) && currentCard.explanation && (
                <div className="guided-study-card-explanation">
                  <Markdown text={currentCard.explanation} />
                </div>
              )}

              <div className="guided-study-card-actions">
                {hasFeedback ? (
                  onNext ? (
                    <Button variant="primary" size="sm" className="guided-study-btn" onClick={() => onNext?.(run?.id)}>
                      {ui('下一题')}
                    </Button>
                  ) : null
                ) : choice ? (
                  <Button variant="primary" size="sm" className="guided-study-btn" disabled={!selected.length || !onAnswer}
                    onClick={() => onAnswer?.({ selected })}>
                    {ui('提交答案')}
                  </Button>
                ) : !isRevealed ? (
                  <Button variant="primary" size="sm" className="guided-study-btn" onClick={() => onReveal?.(run?.id)}>
                    {ui('揭晓答案')}
                  </Button>
                ) : onAnswer ? (
                  <>
                    <Button variant="secondary" size="sm" className="guided-study-btn" onClick={() => onAnswer(1)}>
                      {ui('没掌握')}
                    </Button>
                    <Button variant="primary" size="sm" className="guided-study-btn" onClick={() => onAnswer(3)}>
                      {ui('我掌握了')}
                    </Button>
                  </>
                ) : null}
                <Button
                  variant="secondary"
                  size="sm"
                  className="guided-study-btn"
                  onClick={handleAskTutor}
                  title={ui('把这道题和你的作答发给主会话')}
                >
                  {ui('请教主会话')}
                </Button>
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
