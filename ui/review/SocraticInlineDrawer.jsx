import React from 'react';
import Markdown from '../Markdown.jsx';
import { getUiLanguage, ui, uiFormat } from '../i18n.js';
import { Badge, Button, Icon, LoadingState } from '../components/index.js';
import { useStudyServices } from '../study-context.jsx';
import { useInjectCss } from '../shared.js';
import css from './socratic-inline.css';
import {
  SOCRATIC_STAGE_ORDER,
  copySocraticText,
  formatSocraticTranscriptCopy,
  formatSocraticTurnCopy,
  socraticHintLabel,
  socraticHintTag,
  socraticStageLabel,
} from './socratic-copy.js';

const isImeComposing = (event) => Boolean(event?.nativeEvent?.isComposing || event?.isComposing || event?.keyCode === 229);

/**
 * Inline Socratic tutoring drawer sitting beside the question on wide screens and below on narrow screens (#1316).
 * Memoized so opening or typing never re-renders QuestionRun or steals focus from the question card.
 * Opening (`socratic.get`) makes 0 model calls; model-backed steps respect P2 confirmation.
 */
const SocraticInlineDrawer = React.memo(function SocraticInlineDrawer({
  deckId,
  cardId,
  runId,
  prompt = '',
  topic = '',
  modelReady = false,
  modelConfirmed: externalModelConfirmed,
  onSaveModelConfirm,
  cardAnswered = false,
  retryQueued = false,
  initialView = null,
  onClose,
  onCloseToQuestion,
  onCopyText,
  onNotify,
}) {
  useInjectCss(css, 'study-socratic-inline');
  const services = useStudyServices();
  const call = services?.call;
  const [socraticData, setSocraticData] = React.useState(initialView);
  const [loading, setLoading] = React.useState(!initialView && typeof call === 'function');
  const [submitting, setSubmitting] = React.useState(false);
  const [draft, setDraft] = React.useState('');
  const [error, setError] = React.useState('');
  const [copyNotice, setCopyNotice] = React.useState('');
  const [localModelConfirmed, setLocalModelConfirmed] = React.useState(false);
  const modelConfirmed = typeof onSaveModelConfirm === 'function' ? Boolean(externalModelConfirmed) : localModelConfirmed;
  const [pendingAction, setPendingAction] = React.useState(null);
  const historyRef = React.useRef(null);
  const nearBottomRef = React.useRef(true);
  const reqSeqRef = React.useRef(0);

  // Opening the drawer makes 0 model calls and restores any persisted card.socratic stage; saved help it shows again is recorded on this run's unanswered question.
  React.useEffect(() => {
    if (initialView) {
      setSocraticData(initialView);
      setLoading(false);
      return undefined;
    }
    if (!deckId || !cardId || typeof call !== 'function') {
      setLoading(false);
      return undefined;
    }
    const seq = ++reqSeqRef.current;
    setLoading(true);
    setError('');
    setDraft('');
    setPendingAction(null);
    Promise.resolve(call('socratic.get', { deckId, cardId, ...(runId ? { runId } : {}), language: getUiLanguage() }))
      .then((res) => {
        if (reqSeqRef.current !== seq) return;
        setSocraticData(res || null);
      })
      .catch((err) => {
        if (reqSeqRef.current !== seq) return;
        setError(err?.message || ui('读取苏格拉底带学进度失败'));
      })
      .finally(() => {
        if (reqSeqRef.current === seq) setLoading(false);
      });
    return () => { reqSeqRef.current += 1; };
  }, [deckId, cardId, runId, call, initialView]);

  const record = socraticData?.state || null;
  const stage = record?.stage || 'ask';
  const hintLevel = Number.isInteger(record?.hintLevel) ? record.hintLevel : 0;
  const turns = Array.isArray(record?.turns) ? record.turns : [];
  const summary = record?.summary || null;
  const stageIdx = Math.max(0, SOCRATIC_STAGE_ORDER.indexOf(stage));
  const resolvedPrompt = socraticData?.prompt || prompt;
  const resolvedTopic = socraticData?.topic || topic;

  React.useEffect(() => {
    const el = historyRef.current;
    if (!el || !nearBottomRef.current) return;
    el.scrollTop = el.scrollHeight;
  }, [turns.length]);

  const handleHistoryScroll = () => {
    const el = historyRef.current;
    if (!el) return;
    nearBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight <= 48;
  };

  const announceCopy = (ok, okText) => {
    const msg = ok ? okText : ui('复制失败，请手动选中文本复制');
    if (onNotify) {
      onNotify(msg);
      setCopyNotice('');
    } else {
      setCopyNotice(msg);
    }
  };

  const copyPayload = async (payload, okText) => {
    if (typeof onCopyText === 'function') {
      await onCopyText(payload);
      announceCopy(true, okText);
      return;
    }
    const ok = await copySocraticText(payload);
    announceCopy(ok, okText);
  };

  const copyTurn = (turn) => copyPayload(
    formatSocraticTurnCopy(turn, { prompt: resolvedPrompt, topic: resolvedTopic, state: record }),
    ui('已复制本条对话'),
  );

  const copyAll = () => copyPayload(
    formatSocraticTranscriptCopy({ prompt: resolvedPrompt, topic: resolvedTopic, state: record }),
    ui('已复制整段苏格拉底记录'),
  );

  const executeStep = async (payload, { clearDraft = false } = {}) => {
    if (!deckId || !cardId || typeof call !== 'function' || submitting) return;
    setSubmitting(true);
    setError('');
    try {
      const next = await call('socratic.step', {
        deckId,
        cardId,
        ...(runId ? { runId } : {}),
        language: getUiLanguage(),
        ...payload,
      });
      if (next) setSocraticData(next);
      if (clearDraft) setDraft('');
      setPendingAction(null);
    } catch (err) {
      setError(err?.message || ui('提交失败，请重试'));
    } finally {
      setSubmitting(false);
    }
  };

  const submitText = () => {
    const text = draft.trim();
    if (!text || submitting) return;
    const action = stage === 'retell' ? 'retell' : 'answer';
    // P2 confirmation before the first model-backed turn in this drawer session.
    if (modelReady && !modelConfirmed) {
      setPendingAction({ action, text });
      return;
    }
    void executeStep({ action, text, offline: !modelReady }, { clearDraft: true });
  };

  const saveModelStep = () => {
    if (!pendingAction) return;
    if (typeof onSaveModelConfirm === 'function') onSaveModelConfirm();
    else setLocalModelConfirmed(true);
    void executeStep({ ...pendingAction, offline: false }, { clearDraft: true });
  };

  const saveOfflineStep = () => {
    if (!pendingAction) return;
    void executeStep({ ...pendingAction, offline: true }, { clearDraft: true });
  };

  const cancelPending = () => setPendingAction(null);

  const saveHint = () => {
    void executeStep({ action: 'hint', offline: true });
  };

  const saveReveal = () => {
    void executeStep({ action: 'reveal', offline: true });
  };

  const clearSocratic = () => {
    setPendingAction(null);
    void executeStep({ action: 'reset', offline: true }, { clearDraft: true });
  };

  const closeDrawer = () => onClose?.();
  const closeToQuestion = () => {
    if (onCloseToQuestion) onCloseToQuestion();
    else onClose?.();
  };

  return (
    <aside
      className="socratic-inline-drawer"
      data-testid="socratic-inline-drawer"
      data-own-keys=""
      data-stage={stage}
      data-hint-level={hintLevel}
      aria-label={ui('苏格拉底带学')}
      onKeyDown={(event) => {
        if (event.key === 'Escape' && !isImeComposing(event)) {
          event.stopPropagation();
          closeDrawer();
        }
      }}
    >
      <header className="socratic-inline__head">
        <div className="socratic-inline__title-row">
          <h3 className="socratic-inline__title">{ui('苏格拉底带学')}</h3>
          <Badge
            size="sm"
            tone={hintLevel === 0 ? 'neutral' : hintLevel === 1 ? 'info' : 'warning'}
            data-testid="socratic-inline-hint-badge"
          >
            {socraticHintLabel(hintLevel)}
          </Badge>
        </div>
        <div className="socratic-inline__head-actions">
          <Button
            variant="quiet"
            size="sm"
            icon="copy"
            data-testid="socratic-copy-all"
            onClick={copyAll}
          >
            {ui('复制整段')}
          </Button>
          <Button
            variant="quiet"
            size="sm"
            onClick={closeDrawer}
          >
            {ui('收起')}
          </Button>
        </div>
      </header>

      <ol className="socratic-inline__stages" aria-label={ui('苏格拉底阶段进度')}>
        {SOCRATIC_STAGE_ORDER.map((key, idx) => (
          <li
            key={key}
            className="socratic-inline__stage"
            data-stage-key={key}
            data-active={stage === key ? 'true' : undefined}
            data-done={idx < stageIdx ? 'true' : undefined}
            aria-current={stage === key ? 'step' : undefined}
          >
            {socraticStageLabel(key)}
          </li>
        ))}
      </ol>

      {copyNotice && <div className="socratic-inline__notice" role="status">{copyNotice}</div>}

      {!modelReady && (
        <div className="socratic-inline__notice" role="status">
          {ui('当前未配置 AI 模型：使用内置规则继续引导（0 模型调用）。')}
        </div>
      )}

      <div
        ref={historyRef}
        className="socratic-inline__history"
        data-testid="socratic-inline-history"
        onScroll={handleHistoryScroll}
      >
        {loading && !turns.length ? (
          <LoadingState label={ui('正在载入带学进度…')} />
        ) : turns.map((turn) => (
          <article
            key={turn.id}
            className={`socratic-inline__turn socratic-inline__turn--${turn.role === 'learner' ? 'learner' : 'tutor'}`}
            data-turn-kind={turn.kind}
            data-turn-stage={turn.stage}
            data-hint-level={turn.hintLevel ?? 0}
          >
            <div className="socratic-inline__turn-head">
              <div className="socratic-inline__turn-meta">
                <span className="socratic-inline__role">
                  {turn.role === 'learner'
                    ? (turn.kind === 'retell' ? ui('我的复述') : ui('我的作答'))
                    : (turn.kind === 'hint' ? ui('AI 提示') : turn.kind === 'summary' ? ui('AI 小结') : ui('AI 追问'))}
                </span>
                <Badge size="sm">{socraticStageLabel(turn.stage)}</Badge>
                <Badge size="sm" tone={(turn.hintLevel ?? 0) >= 2 ? 'warning' : (turn.hintLevel ?? 0) === 1 ? 'info' : 'neutral'}>
                  {socraticHintTag(turn.hintLevel ?? 0)}
                </Badge>
              </div>
              <Button
                variant="quiet"
                size="sm"
                data-testid="socratic-copy-turn"
                onClick={() => copyTurn(turn)}
              >
                {ui('复制本条')}
              </Button>
            </div>
            <div className="socratic-inline__body">
              <Markdown text={turn.text} />
            </div>
          </article>
        ))}

        {stage === 'summary' && summary && (
          <div
            className="socratic-inline__summary"
            data-testid="socratic-inline-summary"
            data-needs-review={summary.needsReview ? 'true' : undefined}
          >
            <strong>
              <Icon className="sh-icon--inline" name={summary.mastered ? 'check' : 'info'} />{' '}
              {summary.mastered
                ? ui('本卡已通过复述（无提示）')
                : uiFormat('本卡已通过复述（用过 {0} 级提示，建议重做巩固）', [socraticHintTag(summary.maxHintLevelUsed ?? summary.hintLevel ?? 0)])}
            </strong>
            {summary.nextStep && <span>{summary.nextStep}</span>}
            {cardAnswered && retryQueued && <span>{ui('本轮末尾会再考一遍这道题')}</span>}
            <div className="socratic-inline__summary-actions">
              <Button variant="primary" size="sm" icon={cardAnswered ? undefined : 'arrow-left'} onClick={closeToQuestion}>
                {cardAnswered ? ui('收起带学') : ui('回到原题作答')}
              </Button>
              <Button variant="quiet" size="sm" lock={submitting} onClick={clearSocratic}>
                {ui('再练一遍')}
              </Button>
            </div>
          </div>
        )}
      </div>

      {pendingAction && (
        <div className="socratic-inline__confirm" data-testid="socratic-p2-confirm" role="group" aria-label={ui('确认调用 AI 模型')}>
          <span>{ui('本次提交将调用 AI 模型进行苏格拉底式判定与追问（本轮后续不再重复询问）。')}</span>
          <div className="socratic-inline__confirm-actions">
            <Button variant="primary" size="sm" lock={submitting} onClick={saveModelStep}>{ui('确认并发送')}</Button>
            <Button variant="secondary" size="sm" lock={submitting} onClick={saveOfflineStep}>{ui('仅用本地规则')}</Button>
            <Button variant="quiet" size="sm" onClick={cancelPending}>{ui('取消')}</Button>
          </div>
        </div>
      )}

      <form
        className="socratic-inline__composer"
        onSubmit={(event) => {
          event.preventDefault();
          submitText();
        }}
      >
        {error && <p className="socratic-inline__error" role="alert">{error}</p>}
        <textarea
          className="socratic-inline__input"
          rows={2}
          value={draft}
          disabled={submitting || stage === 'summary'}
          placeholder={
            stage === 'retell'
              ? ui('用自己的话讲一遍解法与原因（Enter 提交）')
              : stage === 'summary'
                ? (cardAnswered ? ui('已完成本卡带学，可复制记录或收起面板') : ui('已完成本卡带学，可复制记录或回到原题作答'))
                : ui('先写下你的思路，不抢原题焦点（Enter 提交）')
          }
          aria-label={stage === 'retell' ? ui('输入复述') : ui('输入带学回答')}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (isImeComposing(event)) return;
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault();
              submitText();
            }
          }}
        />
        <div className="socratic-inline__composer-actions">
          {(stage === 'ask' || stage === 'answer' || stage === 'judge') && hintLevel < 2 ? (
            <Button variant="secondary" size="sm" lock={submitting} onClick={saveHint}>
              {hintLevel === 0 ? ui('要 L1 提示') : ui('要 L2 线索')}
            </Button>
          ) : (stage === 'ask' || stage === 'answer' || stage === 'judge') && hintLevel >= 2 ? (
            <Button variant="secondary" size="sm" lock={submitting} data-testid="socratic-reveal-btn" onClick={saveReveal}>
              {ui('查看参考答案')}
            </Button>
          ) : <span />}
          <Button
            type="submit"
            variant="primary"
            size="sm"
            lock={submitting}
            disabled={stage === 'summary' || !draft.trim()}
          >
            {stage === 'retell' ? ui('提交复述') : ui('提交作答')}
          </Button>
        </div>
      </form>
    </aside>
  );
});

export default SocraticInlineDrawer;
