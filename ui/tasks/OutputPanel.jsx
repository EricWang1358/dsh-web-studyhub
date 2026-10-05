import React, { useEffect, useMemo, useRef, useState } from 'react';
import { ui, uiFormat } from '../i18n.js';
import { LoadingState, Tooltip, useNow } from '../components/index.js';
import { useApp } from '../app/app-context.js';
import { usePolling } from '../use-polling.js';
import AgentLink from '../AgentLink.jsx';
import { reasoningNote } from '../EffortSelect.jsx';
import { formatExactTokens } from '../../lib/token-usage.js';
import { formatElapsed, formatNumber, joinMeta } from '../format.js';
import { callLabel, runnerLabel, outputMode } from './call-model.js';
import { waitState, waitNote } from './output-wait.js';
import { reuseWhy } from '../audio/audio-notes.js';
import { prettyParts } from './json-pretty.js';

/* 实时输出: what the selected call writes, as it writes it, and what it wrote once it has ended.
   RUNNING call: asked from job.output with a cursor, about four times a second, only while this panel is open, the call is running and the page is visible
   (usePolling stops on a hidden page); only the new text comes back. Before the first character the panel says what is known: thinking (reasoning is counted,
   never shown), or a sub-agent that has worked a while without text (output-wait.js). A call that cannot write on the way says so.
   ENDED call (2.6.1): asked ONCE (no polling) with cursor 0. The host answers with the tail it kept in memory (about 8 KB), or with the full final reply read from the
   DSH session when the tail is not all of it; the panel says which of the two it shows, and says so plainly when nothing readable is left.
   JSON the model wrote (reviews, plans, blueprints, corrections) is shown indented (json-pretty.js), also while it streams; other text as it was. */

const POLL_MS = 250, KEEP_CHARS = 48000;
// A streamed text is kept whole up to KEEP_CHARS (the indenting needs its beginning); the host only buffers the last ~8 KB, so a panel opened late starts from that tail.
const tail = (text) => (text.length > KEEP_CHARS ? text.slice(-KEEP_CHARS) : text);
const blank = (mode) => ({ phase: mode === 'ended' ? 'loading' : 'ready', text: '', total: 0, reasoning: 0, supported: true, ended: mode === 'ended', source: null, partial: false, clipped: false, sessionUnreadable: false });

function useOutput({ jobId, call, mode }) {
  const { core } = useApp();
  const [view, setView] = useState(() => blank(mode));
  const cursor = useRef(0), key = useRef(''), coreRef = useRef(core);
  coreRef.current = core;
  const callId = call?.callId, stream = mode === 'stream', ended = mode === 'ended';
  useEffect(() => { key.current = callId || ''; cursor.current = 0; setView((before) => (mode === 'ended' && before.text ? { ...before, phase: 'loading' } : blank(mode))); }, [callId, mode]);
  // an ended call: ONE read, from the start
  useEffect(() => {
    if (!ended || !callId) return undefined;
    let current = true;
    coreRef.current.call('job.output', { jobId, callId, cursor: 0 }).then((reply) => {
      if (!current) return;
      setView({ phase: 'ready', text: typeof reply?.text === 'string' ? reply.text : '', total: Number(reply?.nextCursor) || 0, reasoning: Number(reply?.reasoningChars) || 0,
        supported: reply?.supported !== false, ended: true, source: reply?.source || null, partial: reply?.partial === true, clipped: reply?.clipped === true,
        sessionUnreadable: reply?.sessionUnreadable === true });
    }, () => { if (current) setView((before) => ({ ...before, phase: 'error' })); });
    return () => { current = false; };
  }, [jobId, callId, ended]);
  usePolling(async () => {
    const asked = key.current;
    const reply = await core.call('job.output', { jobId, callId: asked, cursor: cursor.current });
    if (asked !== key.current) return;
    cursor.current = reply.nextCursor ?? cursor.current;
    // A cursor older than what the host keeps: take its tail instead of the gap, and read the snapshot again.
    if (reply.truncated) core.refresh?.();
    setView((before) => {
      const text = reply.truncated ? reply.text : before.text + (reply.text || '');
      const reasoning = Number(reply.reasoningChars) || 0;
      return reply.text || reply.truncated || before.supported !== reply.supported || before.ended !== !!reply.ended || before.total !== reply.nextCursor || before.reasoning !== reasoning
        ? { ...before, phase: 'ready', text: tail(text), total: reply.nextCursor ?? before.total, reasoning, supported: reply.supported, ended: !!reply.ended } : before;
    });
  }, { intervalMs: POLL_MS, enabled: stream && !!call, immediate: true });
  return view;
}

/** The text of a call: JSON indented and coloured by structure (React nodes, never markup), anything else as it was. `fragment`: it is only the tail of a longer text. */
export function OutputText({ text, fragment = false }) {
  const parts = useMemo(() => prettyParts(text, { fragment }), [text, fragment]);
  return parts.map((part, index) => (part.kind === 'plain' || part.kind === 'punct' ? part.text : <span key={index} className={`tc-json__${part.kind}`}>{part.text}</span>));
}

/** What is known about a call without opening its session, as one line: what the reasoning setting did, how big its prompt was, what it used, the start of its answer. */
export function callFacts(call) {
  return joinMeta([reasoningNote(call), call.inputChars > 0 ? uiFormat('输入约 {0} 字', [formatNumber(call.inputChars)]) : '',
    call.tokens > 0 ? uiFormat('用量：{0} tok', [formatExactTokens(call.tokens)]) : '', call.outputPreview ? uiFormat('最近输出：{0}', [call.outputPreview]) : '']);
}

/** What the footer says about an ended call: where the text shown comes from, and what could not be read. */
export function endedNote(view) {
  if (view.phase !== 'ready') return '';
  const unreadable = view.sessionUnreadable ? ui('DSH 会话读取不到，无法补全') : '';
  if (!view.text) return view.sessionUnreadable ? ui('DSH 会话读取不到') : '';
  if (view.source === 'session') return joinMeta([ui('已结束 · 完整回复读取自 DSH 会话'), view.clipped ? ui('回复很长，只显示前 200 KB') : '']);
  return joinMeta([view.partial ? ui('已结束 · 显示最后约 8 KB') : ui('已结束 · 显示这一步写下的全部输出'), unreadable]);
}

/** The panel's drawing, from the state of the output (a plain object, so every state can be shown without a host). */
export function OutputView({ jobId, record: call, active, view, now }) {
  const { host } = useApp();
  const mode = outputMode(call);
  const bodyRef = useRef(null), follow = useRef(true);
  useEffect(() => {
    const body = bodyRef.current;
    if (!body) return;
    if (mode === 'ended') body.scrollTop = 0; else if (follow.current) body.scrollTop = body.scrollHeight;
  }, [view?.text, mode]);
  if (!call) return <div className="tc-output"><div className="tc-output__head"><strong>{active ? ui('没有选中的调用') : ui('任务已经结束')}</strong></div>
    <p className="tc-empty">{ui('点「正在进行」里的一行，或时间线上的一段，在这里看它正在写什么。')}</p><div className="tc-output__foot" /></div>;
  const ended = mode === 'ended';
  const quiet = mode === 'none' || (mode === 'stream' && view.supported === false);
  const meta = joinMeta([runnerLabel(call), mode === 'stream' ? uiFormat('已运行 {0}', [formatElapsed(now - Date.parse(call.startedAt))]) : '',
    mode === 'stream' && view.total > 0 ? uiFormat('已输出约 {0} 字', [formatNumber(view.total)]) : '',
    mode === 'stream' && view.reasoning > 0 ? uiFormat('已思考约 {0} 字', [formatNumber(view.reasoning)]) : '']);
  const waiting = waitState({ call, text: view.text, reasoning: view.reasoning, elapsedMs: now - Date.parse(call.startedAt) });
  const readable = !quiet && (!ended || !!view.text);
  const reading = ended && view.phase === 'loading';
  const quietText = ended ? (view.phase === 'error' ? ui('没能读取这一步的输出。') : ui('已结束；这一步没有留下可读的输出'))
    : call.runner === 'saved' ? reuseWhy() + ' ' + ui('没有向转写服务发请求。')
    : call.runner === 'gemini' ? ui('这一步由转写服务直接处理，不提供中间输出；完成后会在日志里记一条，并显示用时。') : ui('这一步不提供中间输出。');
  const foot = ended ? endedNote(view) : mode === 'stream' && !quiet ? ui('缓存最后约 8 KB · 面板关闭时不再拉取 · 结束后仍可回看') : '';
  return (
    <div className="tc-output" data-mode={quiet ? 'none' : mode}>
      <div className="tc-output__head">
        <div className="tc-output__title"><strong>{callLabel(call, { file: true })}</strong><span>{meta}</span></div>
        <AgentLink childId={call.childId} parentId={call.parentId} openAgent={host?.openAgent} label={`${ui('在 DSH 中打开完整会话')} ↗`} ariaLabel={uiFormat('在 DSH 中打开完整会话：{0}', [callLabel(call)])} />
      </div>
      <p className="tc-output__facts">{callFacts(call)}</p>
      {!readable ? (
        reading ? <LoadingState className="tc-empty tc-output__quiet" label={ui('正在读取这一步的输出…')} /> : <p className="tc-empty tc-output__quiet">{quietText}</p>
      ) : (
        <div className="tc-output__body" role="log" aria-live="off" ref={bodyRef} onScroll={(event) => { const body = event.currentTarget; follow.current = body.scrollHeight - body.scrollTop - body.clientHeight < 24; }}>
          {view.text ? <OutputText text={view.text} fragment={ended ? view.partial === true : view.total > view.text.length} /> : <span className="tc-output__wait" data-state={waiting}>{waitNote(waiting, view.reasoning)}</span>}
          {view.text && !ended && <span className="tc-output__caret" aria-hidden="true" />}
        </div>
      )}
      <div className="tc-output__foot">{foot && <Tooltip layer anchorClassName="tc-output__footnote" content={foot}><span tabIndex={0}>{foot}</span></Tooltip>}</div>
    </div>
  );
}

function LiveOutputPanel({ jobId, call, active }) {
  const mode = outputMode(call), now = useNow(1000, { enabled: mode === 'stream' });
  const view = useOutput({ jobId, call, mode });
  return <OutputView jobId={jobId} record={call} active={active} view={view} now={now} />;
}

/** An archived task is a record: its job is gone from the host, so nothing is asked of it (a read would only fail). */
function ArchivedOutput() {
  return <div className="tc-output"><div className="tc-output__head"><strong>{ui('任务已经结束')}</strong></div><p className="tc-empty tc-output__quiet">{ui('已归档的任务不再保留模型输出。')}</p><div className="tc-output__foot" /></div>;
}

export default function OutputPanel({ archived = false, ...props }) {
  return archived ? <ArchivedOutput /> : <LiveOutputPanel {...props} />;
}
