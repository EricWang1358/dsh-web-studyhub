import React, { useEffect, useRef, useState } from 'react';
import { ui, uiFormat } from '../i18n.js';
import { useNow } from '../components/index.js';
import { useApp } from '../app/app-context.js';
import { usePolling } from '../use-polling.js';
import AgentLink from '../AgentLink.jsx';
import { formatElapsed, formatNumber, joinMeta } from '../format.js';
import { callLabel, runnerLabel, outputMode } from './call-model.js';

/* 实时输出: what the selected call is writing, as it writes it. Asked from job.output with a cursor, about four times a second, only while this panel is
   open, the call is running and the page is visible (usePolling stops on a hidden page), and only the new text comes back. The panel keeps the last few
   dozen lines. A call that cannot write on the way says so; a finished call keeps nothing. */

const POLL_MS = 250, KEEP_LINES = 60, KEEP_CHARS = 16000;
const tail = (text) => { const lines = text.split('\n'); const kept = lines.length > KEEP_LINES ? lines.slice(-KEEP_LINES).join('\n') : text; return kept.length > KEEP_CHARS ? kept.slice(-KEEP_CHARS) : kept; };

function useOutput({ jobId, call, enabled }) {
  const { core } = useApp();
  const [view, setView] = useState({ text: '', total: 0, supported: true, ended: false });
  const cursor = useRef(0), key = useRef('');
  useEffect(() => { key.current = call?.callId || ''; cursor.current = 0; setView({ text: '', total: 0, supported: true, ended: false }); }, [call?.callId]);
  usePolling(async () => {
    const asked = key.current;
    const reply = await core.call('job.output', { jobId, callId: asked, cursor: cursor.current });
    if (asked !== key.current) return;
    cursor.current = reply.nextCursor ?? cursor.current;
    // A cursor older than what the host keeps: take its tail instead of the gap, and read the snapshot again.
    if (reply.truncated) core.refresh?.();
    setView((before) => {
      const text = reply.truncated ? reply.text : before.text + (reply.text || '');
      return reply.text || reply.truncated || before.supported !== reply.supported || before.ended !== !!reply.ended || before.total !== reply.nextCursor
        ? { text: tail(text), total: reply.nextCursor ?? before.total, supported: reply.supported, ended: !!reply.ended } : before;
    });
  }, { intervalMs: POLL_MS, enabled: enabled && !!call, immediate: true });
  return view;
}

export default function OutputPanel({ jobId, call, active }) {
  const { host } = useApp();
  const mode = outputMode(call), now = useNow(1000, { enabled: mode === 'stream' });
  const view = useOutput({ jobId, call, enabled: mode === 'stream' });
  const bodyRef = useRef(null), follow = useRef(true);
  useEffect(() => { const body = bodyRef.current; if (body && follow.current) body.scrollTop = body.scrollHeight; }, [view.text]);
  if (!call) return <div className="tc-output"><div className="tc-output__head"><strong>{active ? ui('没有选中的调用') : ui('任务已经结束')}</strong></div>
    <p className="tc-empty">{ui('点「正在进行」里的一行，或时间线上的一段，在这里看它正在写什么。')}</p><div className="tc-output__foot" /></div>;
  const quiet = mode === 'none' || (mode === 'stream' && view.supported === false);
  const meta = joinMeta([runnerLabel(call), mode === 'stream' ? uiFormat('已运行 {0}', [formatElapsed(now - Date.parse(call.startedAt))]) : '',
    mode === 'stream' && view.total > 0 ? uiFormat('已输出约 {0} 字', [formatNumber(view.total)]) : '']);
  return (
    <div className="tc-output" data-mode={quiet ? 'none' : mode}>
      <div className="tc-output__head">
        <div className="tc-output__title"><strong>{callLabel(call, { file: true })}</strong><span>{meta}</span></div>
        <AgentLink childId={call.childId} parentId={call.parentId} openAgent={host?.openAgent} label={`${ui('在 DSH 中打开完整会话')} ↗`} ariaLabel={uiFormat('在 DSH 中打开完整会话：{0}', [callLabel(call)])} />
      </div>
      {quiet || mode === 'ended' ? (
        <p className="tc-empty tc-output__quiet">{mode === 'ended' ? ui('这一步已经结束；输出不保留，完整内容在 DSH 会话里。')
          : call.runner === 'gemini' ? ui('这一步由转写服务直接处理，不提供中间输出；完成后会在日志里记一条，并显示用时。') : ui('这一步不提供中间输出。')}</p>
      ) : (
        <div className="tc-output__body" role="log" aria-live="off" ref={bodyRef} onScroll={(event) => { const body = event.currentTarget; follow.current = body.scrollHeight - body.scrollTop - body.clientHeight < 24; }}>
          {view.text ? view.text : <span className="tc-output__wait">{ui('等待模型开始输出…')}</span>}
          {view.text && <span className="tc-output__caret" aria-hidden="true" />}
        </div>
      )}
      <div className="tc-output__foot">{mode === 'stream' && !quiet ? ui('只显示最后约 8 KB · 面板关闭时不再拉取 · 完整内容在 DSH 会话里') : ''}</div>
    </div>
  );
}
