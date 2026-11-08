import React, { useEffect, useState } from 'react';
import { ui, uiFormat } from '../i18n.js';
import { Button, InlineMessage, LoadingState } from '../components/index.js';
import { useApp } from '../app/app-context.js';
import { useInjectCss } from '../shared.js';
import { joinMeta } from '../format.js';
import traceCss from './request-trace.css';

function wrapperNote(wrapperBoundary) {
  if (wrapperBoundary?.mode === 'subagent') {
    return ui('子代理模式：StudyHub 将经过阶段前缀排序的 system 与 prompt 合并发给独立子代理；宿主外层工具与会话协议不在插件内存轨迹内。');
  }
  return ui('直连模型调用：StudyHub 直接发送本条经过阶段前缀排序的 system 与 prompt；宿主底层传输头不在插件内存轨迹内。');
}

export default function RequestTracePanel({ jobId, selectedCallId = null, callCount = 0, archived = false }) {
  useInjectCss(traceCss, 'study-request-trace');
  const { core } = useApp();
  const [state, setState] = useState({ phase: 'loading', trace: null, error: '' });
  const [pickedId, setPickedId] = useState(selectedCallId);
  const [revealedByCall, setRevealedByCall] = useState({});
  const [notice, setNotice] = useState('');

  useEffect(() => {
    if (selectedCallId) setPickedId(selectedCallId);
  }, [selectedCallId]);

  useEffect(() => {
    if (archived || !jobId) return undefined;
    let alive = true;
    setState((prev) => (prev.trace ? prev : { phase: 'loading', trace: null, error: '' }));
    core.call('job.trace', { jobId, revealSolutions: false }).then(
      (reply) => {
        if (!alive) return;
        setState({ phase: 'ready', trace: reply, error: '' });
      },
      (error) => {
        if (!alive) return;
        setState({ phase: 'error', trace: null, error: String(error?.message || error) });
      },
    );
    return () => { alive = false; };
  }, [core, jobId, callCount, archived]);

  if (archived) {
    return (
      <div className="tc-trace" data-request-trace>
        <p className="tc-empty">{ui('已归档的任务不再保留实际请求轨迹。')}</p>
      </div>
    );
  }

  if (state.phase === 'loading') {
    return (
      <div className="tc-trace" data-request-trace>
        <LoadingState className="tc-empty" label={ui('正在读取实际请求轨迹…')} />
      </div>
    );
  }

  if (state.phase === 'error') {
    return (
      <div className="tc-trace" data-request-trace>
        <p className="tc-empty">{state.error}</p>
      </div>
    );
  }

  const calls = state.trace?.calls || [];
  const activeId = calls.some((c) => c.callId === pickedId) ? pickedId : calls[0]?.callId || null;
  const baseEntry = calls.find((c) => c.callId === activeId) || null;
  const revealedEntry = activeId ? revealedByCall[activeId] : null;
  const entry = revealedEntry || baseEntry;

  const handleReveal = async (callId, action = 'reveal') => {
    const res = await core.call('job.trace', { jobId, callId, revealSolutions: true, action });
    const full = (res?.calls || []).find((c) => c.callId === callId);
    if (full) setRevealedByCall((prev) => ({ ...prev, [callId]: full }));
    if (res?.exposureReceipt) {
      setNotice(ui('已记录解法暴露：本批关联题目后续作答不再计入「未见独立通过」。'));
      core.refresh?.();
    }
    return full;
  };

  const handleCopy = async () => {
    if (!entry) return;
    let current = entry;
    if (entry.containsSolution && entry.redacted) {
      current = await handleReveal(entry.callId, 'copy');
    }
    if (!current || current.redacted || !current.retained) return;
    const text = `[SYSTEM]\n${current.system || ''}\n\n[PROMPT]\n${current.prompt || ''}`;
    try {
      await navigator.clipboard?.writeText(text);
      setNotice(ui('已复制当前阶段的实际请求文本。'));
    } catch {
      setNotice(ui('浏览器未允许剪贴板写入，请在下方直接选中文本复制。'));
    }
  };

  const handleExport = async (includeSolutions) => {
    const exported = await core.call('job.trace.export', { jobId, includeSolutions });
    if (exported?.exposureReceipt) {
      setNotice(ui('已导出完整轨迹并记录解法暴露。'));
      core.refresh?.();
    } else {
      setNotice(ui('已导出脱敏请求轨迹（未暴露答案蓝图）。'));
    }
    if (typeof Blob !== 'undefined' && typeof URL !== 'undefined' && typeof document !== 'undefined') {
      const blob = new Blob([JSON.stringify(exported, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `studyhub-trace-${jobId}${includeSolutions ? '-full' : '-redacted'}.json`;
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    }
  };

  const handleDelete = async () => {
    await core.call('job.trace.delete', { jobId });
    setRevealedByCall({});
    const refreshed = await core.call('job.trace', { jobId, revealSolutions: false });
    setState({ phase: 'ready', trace: refreshed, error: '' });
    setNotice(ui('已清理内存中的请求全文（已产生的解法暴露记录保留不变）。'));
  };

  return (
    <div className="tc-trace" data-request-trace>
      <div className="tc-trace__bar">
        <span>{joinMeta([
          state.trace?.requirementsVersion ? uiFormat('规格 {0}', [state.trace.requirementsVersion]) : '',
          ui('仅保留在当前进程内存，可随时清理'),
        ])}</span>
        <div>
          <Button variant="link" size="sm" data-export-trace-safe onClick={() => handleExport(false)}>{ui('导出脱敏 JSON')}</Button>
          <Button variant="link" size="sm" data-export-trace-full onClick={() => handleExport(true)}>{ui('导出完整 JSON（记录暴露）')}</Button>
          <Button variant="link" size="sm" data-delete-trace onClick={handleDelete}>{ui('清理请求轨迹')}</Button>
        </div>
      </div>

      {notice && <InlineMessage tone="info">{notice}</InlineMessage>}

      {!calls.length ? (
        <p className="tc-empty">
          {state.trace?.unavailableReason === 'deleted-by-user'
            ? ui('该任务的实际请求文本已手动清理。')
            : ui('暂无已记录的阶段请求（任务尚未发起模型调用，或早于内存保留窗口）。')}
        </p>
      ) : (
        <>
          <div className="tc-trace__calls" role="group" aria-label={ui('模型调用步骤')}>
            {calls.map((c, idx) => (
              <Button
                key={c.callId}
                variant="secondary"
                size="sm"
                className="tc-trace__call"
                data-trace-call={c.callId}
                aria-pressed={c.callId === activeId}
                onClick={() => setPickedId(c.callId)}
              >
                {`${idx + 1}. ${c.stage || c.purpose || c.callId}${c.containsSolution ? ` · ${ui('含解法')}` : ''}`}
              </Button>
            ))}
          </div>

          {entry && (
            <div className="tc-scroll">
              <p className="tc-trace__meta">
                {joinMeta([
                  wrapperNote(entry.wrapperBoundary),
                  entry.reordered ? ui('已按证据前缀重排（缓存友好）') : '',
                  entry.truncated ? ui('超长请求已头尾截断保留') : '',
                  entry.supplementaryNotes?.length ? uiFormat('附带运行中补充要求 {0} 条', [entry.supplementaryNotes.length]) : '',
                ])}
              </p>

              {!entry.retained ? (
                <p className="tc-empty">
                  {entry.unavailableReason === 'deleted-by-user'
                    ? ui('该步骤的实际请求文本已手动清理（已产生的解法暴露记录仍保留）。')
                    : ui('该步骤未保留在当前进程内存中（无法恢复历史原文）。')}
                </p>
              ) : entry.redacted ? (
                <div className="tc-trace__guard" data-solution-guard>
                  <strong>{ui('已默认折叠含答案蓝图 / 选项真值 / 评分要点的阶段请求')}</strong>
                  <p className="generate-note">
                    {ui('展开、复制或导出此阶段内容后，StudyHub 会记录一次不可撤销的解法暴露，本批关联题目后续作答将标为辅助/暴露，不再计入「未见独立通过」。')}
                  </p>
                  <div>
                    <Button variant="secondary" size="sm" data-reveal-solution-trace onClick={() => handleReveal(entry.callId, 'reveal')}>
                      {ui('我已知晓，记录暴露并展开全文')}
                    </Button>
                  </div>
                </div>
              ) : (
                <>
                  <div className="tc-trace__block">
                    <div className="tc-trace__bar">
                      <span className="tc-trace__label">{uiFormat('System 指令（{0} 字符）', [entry.systemChars || 0])}</span>
                      <Button variant="link" size="sm" data-copy-trace onClick={handleCopy}>{ui('复制当前请求')}</Button>
                    </div>
                    <pre className="tc-trace__code" data-trace-system>{entry.system}</pre>
                  </div>
                  <div className="tc-trace__block">
                    <p className="tc-trace__label">{uiFormat('Prompt 正文（{0} 字符）', [entry.promptChars || 0])}</p>
                    <pre className="tc-trace__code" data-trace-prompt>{entry.prompt}</pre>
                  </div>
                </>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}
