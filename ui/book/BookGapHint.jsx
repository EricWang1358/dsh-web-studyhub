import React from 'react';
import { ui } from '../i18n.js';
import { Button, Icon, InlineMessage, Spinner } from '../components/index.js';
import { HandOff } from '../hand-off/HandOff.jsx';
import { gapHintLabel } from '../evidence-hint.js';
import { rescueExperimentStatusText, rescueGate } from '../wrongbook-model.js';

/**
 * Conditional Review Book point-header gap hint (`还差：……`, §2.1 & §3.3.3).
 * Never adds controls to PointToolbar; renders only on weak/exam-near points and inline rescue progress/fallback when triggered.
 */
export default function BookGapHint({ node, course = '', handlers }) {
  if (!node || node.hid === 'unplaced') return null;
  const hint = handlers?.gapHintOf?.(node) ?? null;
  const label = gapHintLabel(hint);
  const rescueState = handlers?.rescueStateOf?.(node.hid) ?? null;
  const rescuePrompt = handlers?.rescuePromptOf?.(node.hid) ?? null;
  const running = rescueState?.status === 'starting' || rescueState?.status === 'running';
  if (!label && !running && !rescueState?.status && !rescuePrompt) return null;

  const questionRefs = Array.isArray(node.questions) ? node.questions : [];
  const cardIds = [...new Set(questionRefs.map((q) => q?.cardId).filter(Boolean))].slice(0, 4);
  const deckIds = [...new Set(questionRefs.map((q) => q?.deckId).filter(Boolean))];
  const isRescueLaunch = hint?.kind === 'rescue_experiment';

  return (
    <div className="book-point__gap-wrap">
      {label && (
        <p className="book-point__gap-hint" data-gap-hint={hint.kind}>
          <Button
            variant="link"
            size="sm"
            wrap
            icon={isRescueLaunch ? 'sparkle' : undefined}
            iconEnd="arrow-right"
            busy={isRescueLaunch && running}
            disabled={isRescueLaunch && running}
            onClick={(event) => handlers?.actGapHint?.(node, hint, event.currentTarget)}
          >
            {label}
          </Button>
        </p>
      )}
      {running && (
        <div className="book-point__rescue-status" role="status" aria-live="polite" data-book-rescue-status={rescueState.status}>
          <Spinner size="sm" />
          <span>{rescueExperimentStatusText(rescueState.stage || rescueState.status)}</span>
        </div>
      )}
      {rescueState?.status === 'ready' && (
        <div className="book-point__rescue-status is-ready" role="status" aria-live="polite" data-book-rescue-status="ready">
          <Icon name="success" className="sh-icon--inline" />
          <span>{ui('4 页交互实验已做好，做完关闭窗口就会回到这一节。')}</span>
        </div>
      )}
      {rescueState?.status === 'failed' && (
        <InlineMessage
          className="book-point__rescue-msg"
          tone="error"
          boxed
          action={hint ? { label: ui('重试'), onClick: (event) => handlers?.actGapHint?.(node, { ...hint, kind: 'rescue_experiment' }, event.currentTarget) } : undefined}
        >
          {rescueState.message || ui('这次没能生成交互实验，可以重试或先做本节的题。')}
        </InlineMessage>
      )}
      {rescuePrompt?.type === 'rescue-handoff' && (
        <div className="book-point__rescue-handoff" role="group" aria-label={ui('由主会话生成 4 页交互实验')}>
          <strong>{ui('未配置生成模型 · 可用主会话零密钥生成')}</strong>
          <p>{ui('发给主会话后，它会直接编译 3–4 页交互实验并挂回这一节；挂载好后回到这里就能直接打开，做完关闭窗口仍回到复习全书。')}</p>
          <div className="book-point__rescue-actions">
            <HandOff
              id="companion.rescue"
              shape="secondary"
              what="让主会话零密钥编译一个 3–4 页急救交互实验并挂回这一节"
              input={{
                course,
                ...(deckIds.length === 1 ? { deckId: deckIds[0] } : {}),
                ...(cardIds.length === 1 ? { cardId: cardIds[0] } : {}),
                ...(cardIds.length ? { cardIds } : {}),
                hid: node.hid,
                topic: node.title || '',
              }}
            />
            {handlers?.openModel && (
              <Button iconEnd="arrow-right" variant="link" size="sm" onClick={handlers.openModel}>{ui('打开模型设置')}</Button>
            )}
            <Button variant="quiet" size="sm" onClick={handlers?.dismissRescuePrompt}>{ui('取消')}</Button>
          </div>
        </div>
      )}
      {rescuePrompt?.type === 'no-model' && (
        <InlineMessage
          className="book-point__rescue-msg"
          tone="warning"
          boxed
          actionsBelow
          action={handlers?.openModel ? { label: ui('打开模型设置'), iconEnd: 'arrow-right', onClick: handlers.openModel } : undefined}
          onDismiss={handlers?.dismissRescuePrompt}
        >
          {rescuePrompt.text || rescueGate('experiment', { modelReady: false, canChat: false }).text}
        </InlineMessage>
      )}
    </div>
  );
}
