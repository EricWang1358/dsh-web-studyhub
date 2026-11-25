import React from 'react';
import { ui, uiFormat } from '../i18n.js';
import { Banner, Button, Tooltip } from '../components/index.js';
import { useStudyBusy } from '../study-context.jsx';
import { isSamePracticeLocation, peekPracticeFrame } from '../practice-context-stack.js';

/**
 * Fixed top-bar chip (Issue #1319): visible on ANY page when the practice context stack is non-empty,
 * or shows a quiet "继续上次（第 N 题）" chip on startup when a saved position exists in browser storage.
 */
export function PracticeReturnChip({
  stack = [],
  page = '',
  run = null,
  modal = null,
  lastPractice = null,
  onRestore,
  onPracticeResume,
}) {
  const busy = useStudyBusy();
  const top = peekPracticeFrame(stack);
  const depth = Array.isArray(stack) ? stack.length : 0;
  const showReturn = Boolean(top && (page !== 'review' || modal || !isSamePracticeLocation(top, run)));

  if (showReturn) {
    const questionNum = (top.index || 0) + 1;
    const label = depth > 1
      ? uiFormat('回到第 {0} 题（{1}）', [questionNum, depth])
      : uiFormat('回到第 {0} 题', [questionNum]);
    const hint = depth > 1
      ? uiFormat('按跳转顺序逐层返回，当前共 {0} 层练习上下文', [depth])
      : ui('回到离开前的这道题并恢复未提交作答');
    return (
      <Tooltip layer content={hint} anchorClassName="practice-return-anchor">
        <Button
          variant="secondary"
          size="sm"
          icon="arrow-left"
          className="practice-return-btn"
          data-practice-return-chip=""
          data-stack-depth={String(depth)}
          data-usage="review.practice-return"
          lock={busy}
          onClick={onRestore}
        >
          {label}
        </Button>
      </Tooltip>
    );
  }

  if (depth === 0 && page !== 'review' && lastPractice?.runId && lastPractice?.cardId && !lastPractice.runComplete && typeof onPracticeResume === 'function') {
    const questionNum = (lastPractice.index || 0) + 1;
    return (
      <Button
        variant="quiet"
        size="sm"
        iconEnd="arrow-right"
        className="practice-resume-btn"
        data-practice-resume-chip=""
        data-usage="review.practice-resume"
        lock={busy}
        onClick={onPracticeResume}
      >
        {uiFormat('继续上次（第 {0} 题）', [questionNum])}
      </Button>
    );
  }

  return null;
}

/**
 * Calm inline notice shown when the original question's run has already ended,
 * offering a direct "重新练这道题" action instead of silently jumping away.
 */
export function PracticeEndedBanner({ ended = null, onPracticeAgain, onDismiss }) {
  const busy = useStudyBusy();
  if (!ended) return null;
  const questionNum = (ended.frame?.index || 0) + 1;
  const message = uiFormat('原来的第 {0} 题所在练习已结束。', [questionNum]);
  return (
    <Banner
      role="status"
      tone="info"
      className="app-banner practice-ended-banner"
      data-practice-ended-banner=""
      title={message}
      action={ended.practiceAgainScope && typeof onPracticeAgain === 'function' ? {
        label: ui('重新练这道题'),
        iconEnd: 'arrow-right',
        disabled: busy,
        'data-usage': 'review.practice-retry',
        onClick: () => onPracticeAgain(ended.practiceAgainScope),
      } : undefined}
      secondary={typeof onDismiss === 'function' ? {
        label: ui('知道了'),
        onClick: onDismiss,
      } : undefined}
    >
      {ended.frame?.prompt ? <p className="app-banner__hint">{ended.frame.prompt}</p> : null}
    </Banner>
  );
}
