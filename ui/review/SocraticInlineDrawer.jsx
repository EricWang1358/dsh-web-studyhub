import React from 'react';
import Markdown from '../Markdown.jsx';
import ModelErrorNote from '../ModelErrorNote.jsx';
import ModelSetupGate from '../ModelSetupGate.jsx';
import { describeModelError } from '../generation-status.js';
import { getUiLanguage, ui, uiFormat } from '../i18n.js';
import { Button, ConfirmDialog, Icon, IconButton, InlineMessage, LoadingState } from '../components/index.js';
import { useNow } from '../components/use-now.js';
import { useStudyServices } from '../study-context.jsx';
import { useInjectCss } from '../shared.js';
import css from './socratic-inline.css';
import { copySocraticText, formatSocraticTranscriptCopy, formatSocraticTurnCopy, socraticTurnTag } from './socratic-copy.js';

const isImeComposing = (event) => Boolean(event?.nativeEvent?.isComposing || event?.isComposing || event?.keyCode === 229);
/** After this long the wait is counted out loud: a local command line or a thinking model can take most of a minute. */
const COUNT_AFTER_SECONDS = 5;

function Turn({ turn, onCopy }) {
  const mine = turn.role === 'learner';
  const tag = socraticTurnTag(turn);
  return (
    <article
      className={`socratic-inline__turn socratic-inline__turn--${mine ? 'learner' : 'tutor'}`}
      aria-label={mine ? ui('我') : ui('老师')}
      data-turn-kind={turn.kind}
    >
      {tag && <span className="socratic-inline__tag">{tag}</span>}
      <div className="socratic-inline__body">
        <Markdown text={turn.text} />
      </div>
      {onCopy && (
        <IconButton icon="copy" size="sm" className="socratic-inline__copy" label={ui('复制本条')} data-testid="socratic-copy-turn" onClick={() => onCopy(turn)} />
      )}
    </article>
  );
}

/** The one sign that something is on its way, standing where the reply will stand. */
function Waiting({ seconds }) {
  return (
    <div className="socratic-inline__waiting" role="status">
      <span className="socratic-inline__busy-dots" aria-hidden="true"><i /><i /><i /></span>
      <span>{seconds >= COUNT_AFTER_SECONDS ? uiFormat('正在想，已等 {0} 秒', [seconds]) : ui('正在想…')}</span>
    </div>
  );
}

/** Whole seconds since `startedAt` (0: nothing is being waited for). */
function useSecondsSince(startedAt) {
  const now = useNow(1000, { enabled: Boolean(startedAt) });
  return startedAt ? Math.max(0, Math.floor((now - startedAt) / 1000)) : 0;
}

function Failure({ message, onRetry }) {
  if (describeModelError(message).kind !== 'unknown') return <ModelErrorNote error={message} onRetry={onRetry} className="socratic-inline__failure" />;
  return <InlineMessage tone="error" className="socratic-inline__failure" action={onRetry ? { label: ui('重试'), onClick: onRetry } : undefined}>{message}</InlineMessage>;
}

/**
 * Inline tutoring drawer sitting beside the question on wide screens and below on narrow screens (#1316), drawn as a conversation.
 * Memoized so opening or typing never re-renders QuestionRun or steals focus from the question card.
 * Opening (`socratic.get`) makes 0 model calls; each message sent, and a hint when a model is connected, is one call.
 */
const SocraticInlineDrawer = React.memo(function SocraticInlineDrawer({
  deckId,
  cardId,
  runId,
  prompt = '',
  topic = '',
  modelReady = false,
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
  const [conversation, setConversation] = React.useState(initialView);
  const [loading, setLoading] = React.useState(!initialView && typeof call === 'function');
  const [loadError, setLoadError] = React.useState('');
  const [draft, setDraft] = React.useState('');
  const [pending, setPending] = React.useState(null);
  const [failed, setFailed] = React.useState(null);
  const [confirmRestart, setConfirmRestart] = React.useState(false);
  const [copyNotice, setCopyNotice] = React.useState('');
  const historyRef = React.useRef(null);
  const nearBottomRef = React.useRef(true);
  const reqSeqRef = React.useRef(0);
  const flightRef = React.useRef(false);

  // Opening restores any saved conversation; saved help it shows again is recorded on this run's unanswered question.
  React.useEffect(() => {
    if (initialView) {
      setConversation(initialView);
      setLoading(false);
      return undefined;
    }
    if (!deckId || !cardId || typeof call !== 'function') {
      setLoading(false);
      return undefined;
    }
    const seq = ++reqSeqRef.current;
    setLoading(true);
    setLoadError('');
    Promise.resolve(call('socratic.get', { deckId, cardId, ...(runId ? { runId } : {}), language: getUiLanguage() }))
      .then((res) => { if (reqSeqRef.current === seq) setConversation(res || null); })
      .catch((err) => { if (reqSeqRef.current === seq) setLoadError(err?.message || ui('读取苏格拉底带学进度失败')); })
      .finally(() => { if (reqSeqRef.current === seq) setLoading(false); });
    return () => { reqSeqRef.current += 1; };
  }, [deckId, cardId, runId, call, initialView]);

  const record = conversation?.state || null;
  const done = record?.stage === 'summary';
  const revealed = Boolean(record?.revealed);
  const turns = Array.isArray(record?.turns) ? record.turns : [];
  const summary = record?.summary || null;
  const talked = turns.length > 1;
  const spoke = turns.some((turn) => turn.role === 'learner');
  const resolvedPrompt = conversation?.prompt || prompt;
  const resolvedTopic = conversation?.topic || topic;
  const busy = Boolean(pending);
  const thinking = Boolean(pending?.thinks);
  const seconds = useSecondsSince(thinking ? pending.startedAt : 0);

  // The newest line stays in sight, unless the learner scrolled up to read.
  React.useEffect(() => {
    const el = historyRef.current;
    if (el && nearBottomRef.current) el.scrollTop = el.scrollHeight;
  }, [turns.length, pending, failed]);

  const handleHistoryScroll = () => {
    const el = historyRef.current;
    if (el) nearBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight <= 48;
  };

  const copyPayload = async (payload, okText) => {
    let ok = true;
    if (typeof onCopyText === 'function') await onCopyText(payload);
    else ok = await copySocraticText(payload);
    const message = ok ? okText : ui('复制失败，请手动选中文本复制');
    if (onNotify) onNotify(message);
    setCopyNotice(onNotify ? '' : message);
  };
  const copyTurn = (turn) => copyPayload(formatSocraticTurnCopy(turn, { prompt: resolvedPrompt, topic: resolvedTopic }), ui('已复制本条对话'));
  const copyAll = () => copyPayload(formatSocraticTranscriptCopy({ prompt: resolvedPrompt, topic: resolvedTopic, state: record }), ui('已复制整段对话'));

  // One step at a time. The learner's words show at once; if no reply comes they go back into the box and nothing was saved.
  const step = async (payload, { fromBox = false } = {}) => {
    if (!deckId || !cardId || typeof call !== 'function' || flightRef.current) return;
    flightRef.current = true;
    nearBottomRef.current = true;
    const thinks = modelReady && (payload.action === 'answer' || payload.action === 'hint');
    setPending({ ...payload, thinks, startedAt: Date.now() });
    setFailed(null);
    if (fromBox) setDraft('');
    try {
      const next = await call('socratic.step', {
        deckId, cardId, ...(runId ? { runId } : {}), language: getUiLanguage(), ...payload, ...(modelReady ? {} : { offline: true }),
      });
      if (next) setConversation(next);
    } catch (err) {
      setFailed({ message: err?.message || ui('提交失败，请重试'), payload, fromBox });
      if (fromBox) setDraft((now) => now || payload.text);
    } finally {
      flightRef.current = false;
      setPending(null);
    }
  };

  const send = () => {
    const text = draft.trim();
    if (text && modelReady) void step({ action: 'answer', text }, { fromBox: true });
  };
  const retry = failed ? () => {
    if (failed.fromBox) setDraft((now) => (now === failed.payload.text ? '' : now));
    void step(failed.payload, { fromBox: false });
  } : undefined;
  const askHint = () => void step({ action: 'hint' });
  const askRephrase = () => void step({ action: 'answer', text: ui('没听懂，换个说法') });
  const reveal = () => void step({ action: 'reveal' });

  const closeDrawer = () => onClose?.();
  const closeToQuestion = () => (onCloseToQuestion || onClose)?.();

  const canHint = !done && !revealed && (modelReady || (Boolean(conversation?.hasHint) && !turns.some((turn) => turn.kind === 'hint')));
  const canReveal = !done && !revealed;
  const chips = record && (canHint || canReveal || (modelReady && !done)) && (
    <div className="socratic-inline__chips">
      {canHint && <Button variant="secondary" size="sm" lock={busy} onClick={askHint}>{ui('给个提示')}</Button>}
      {modelReady && !done && <Button variant="secondary" size="sm" lock={busy} onClick={askRephrase}>{ui('没听懂')}</Button>}
      {canReveal && <Button variant="quiet" size="sm" lock={busy} data-testid="socratic-reveal-btn" onClick={reveal}>{ui('看参考答案')}</Button>}
    </div>
  );

  return (
    <aside
      className="socratic-inline-drawer"
      data-testid="socratic-inline-drawer"
      data-own-keys=""
      data-stage={record?.stage || 'ask'}
      data-hint-level={record?.hintLevel || 0}
      aria-label={ui('苏格拉底带学')}
      onKeyDown={(event) => {
        if (event.key === 'Escape' && !isImeComposing(event)) {
          event.stopPropagation();
          closeDrawer();
        }
      }}
    >
      <header className="socratic-inline__head">
        <h3 className="socratic-inline__title">{ui('苏格拉底带学')}</h3>
        <div className="socratic-inline__head-actions">
          <IconButton icon="copy" size="sm" label={ui('复制整段')} data-testid="socratic-copy-all" onClick={copyAll} />
          {talked && <IconButton icon="undo" size="sm" label={ui('重新开始')} lock={busy} onClick={() => setConfirmRestart(true)} />}
          <IconButton icon="close" size="sm" label={ui('收起带学')} onClick={closeDrawer} />
        </div>
      </header>

      {copyNotice && <div className="socratic-inline__notice" role="status">{copyNotice}</div>}

      <div ref={historyRef} className="socratic-inline__history" data-testid="socratic-inline-history" onScroll={handleHistoryScroll}>
        {loading && !turns.length && <LoadingState label={ui('正在载入带学进度…')} />}
        {loadError && <InlineMessage tone="error">{loadError}</InlineMessage>}
        {turns.map((turn) => <Turn key={turn.id} turn={turn} onCopy={copyTurn} />)}
        {pending?.action === 'answer' && <Turn turn={{ role: 'learner', kind: 'answer', text: pending.text }} />}
        {thinking && <Waiting seconds={seconds} />}
        {failed && <Failure message={failed.message} onRetry={retry} />}
      </div>

      {done && summary && (
        <div className="socratic-inline__summary" data-testid="socratic-inline-summary" data-needs-review={summary.needsReview ? 'true' : undefined}>
          <strong>
            <Icon className="sh-icon--inline" name={summary.mastered ? 'check' : 'info'} />{' '}
            {summary.mastered ? ui('这道题你自己讲清楚了') : ui('讲清楚了。这次用过提示，过后不看提示再做一遍')}
          </strong>
          {cardAnswered && retryQueued && <span>{ui('本轮末尾会再考一遍这道题')}</span>}
          <div className="socratic-inline__summary-actions">
            <Button variant="primary" size="sm" icon={cardAnswered ? undefined : 'arrow-left'} onClick={closeToQuestion}>
              {cardAnswered ? ui('收起带学') : ui('回到原题作答')}
            </Button>
          </div>
        </div>
      )}

      <form className="socratic-inline__composer" onSubmit={(event) => { event.preventDefault(); send(); }}>
        {!modelReady && <ModelSetupGate variant="compact" feature="tutor" model={{ ready: false }} />}
        {chips}
        {modelReady && (
          <div className="socratic-inline__entry">
            <textarea
              className="socratic-inline__input"
              rows={2}
              value={draft}
              placeholder={done ? ui('还有疑问可以接着问') : ui('说说你的想法，或直接问我')}
              aria-label={ui('输入带学回答')}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                if (isImeComposing(event)) return;
                if (event.key === 'Enter' && !event.shiftKey) {
                  event.preventDefault();
                  send();
                }
              }}
            />
            <Button type="submit" variant="primary" size="sm" lock={busy} disabled={!draft.trim()}>{ui('发送')}</Button>
          </div>
        )}
        {modelReady && !spoke && <p className="socratic-inline__cost">{ui('回车发送，Shift+回车换行。每发一条调用一次模型。')}</p>}
      </form>

      {confirmRestart && (
        <ConfirmDialog
          title={ui('清掉这段对话，重新开始？')}
          description={ui('这道题的带学对话会清空。用过提示的记录仍然保留。')}
          confirmLabel={ui('清掉并重新开始')}
          onConfirm={async () => { await step({ action: 'reset' }); }}
          onDone={() => setConfirmRestart(false)}
          onClose={() => setConfirmRestart(false)}
        />
      )}
    </aside>
  );
});

export default SocraticInlineDrawer;
