import React, { Suspense, lazy, memo, useEffect, useMemo, useState } from 'react';
import { Box, Text } from 'ink';
import { useStableWindowSize } from '../../components/resize.js';
import { KEY_LAYER_MODAL } from '../../input/dispatcher.js';
import { useKeyScope } from '../../input/hooks.js';
import type { HostClient, KeyHint, UiLanguage } from '../../types/contracts.js';
import { t } from '../../state/store.js';
import { Badge, EmptyState, Spinner, StatusPill } from '../../components/Badge.js';
import { Modal, modalContentWidth } from '../../components/Modal.js';
import { ScrollArea } from '../../layout/index.js';
import { useTheme } from '../../theme/tokens.js';
import { truncateDisplay } from '../../render/cjk.js';
import { tryAction } from '../../host/sample-actions.js';
import {
  extractOutputContent,
  pillStatusFor,
  type JobOutputResponse,
  type JobRecord,
} from './tasks-model.js';

const MarkdownView = lazy(() =>
  import('../../components/MarkdownView.js').then((m) => ({ default: m.MarkdownView })),
);

export interface JobOutputModalProps {
  host: HostClient;
  job: JobRecord;
  isActive: boolean;
  onClose: () => void;
  lang: UiLanguage;
  asciiMode: boolean;
}

export const JobOutputModal = memo(function JobOutputModal({
  host,
  job,
  isActive,
  onClose,
  lang,
  asciiMode,
}: JobOutputModalProps) {
  const theme = useTheme();
  const { columns, rows } = useStableWindowSize();
  const ell = asciiMode ? '...' : '…';

  const defaultCallIdx = useMemo(() => {
    if (job.calls.length === 0) return 0;
    const runningIdx = [...job.calls].reverse().findIndex((c) => c.status === 'running');
    if (runningIdx >= 0) return job.calls.length - 1 - runningIdx;
    return job.calls.length - 1;
  }, [job.calls]);

  const [callIdx, setCallIdx] = useState(defaultCallIdx);
  const [loading, setLoading] = useState(true);
  const [outputData, setOutputData] = useState<JobOutputResponse | null>(null);
  const [viewMode, setViewMode] = useState<'auto' | 'json'>('auto');
  const [reloadTick, setReloadTick] = useState(0);

  useEffect(() => {
    setCallIdx(defaultCallIdx);
  }, [job.id, defaultCallIdx]);

  const activeCall: JobRecord['calls'][number] | undefined =
    job.calls[Math.min(callIdx, Math.max(0, job.calls.length - 1))];

  useEffect(() => {
    if (!isActive) return undefined;
    let cancelled = false;
    setLoading(true);
    void (async () => {
      let targetCallId: string | undefined = activeCall?.id;
      if (!targetCallId) {
        const traceRes = await tryAction<{ calls?: Array<{ callId?: string; status?: string }> }>(host, 'job.trace', {
          jobId: job.id,
        });
        if (!cancelled && traceRes.ok && Array.isArray(traceRes.value?.calls) && traceRes.value.calls.length > 0) {
          const running = [...traceRes.value.calls].reverse().find((c) => c.status === 'running');
          targetCallId = running?.callId || traceRes.value.calls.at(-1)?.callId;
        }
      }
      const args: Record<string, unknown> = targetCallId
        ? { jobId: job.id, callId: targetCallId, cursor: 0 }
        : { jobId: job.id };
      const res = await tryAction<JobOutputResponse>(host, 'job.output', args);
      if (cancelled) return;
      setOutputData(res.ok && res.value ? res.value : null);
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [host, isActive, job.id, activeCall?.id, reloadTick]);

  useKeyScope({
    id: 'TasksView:output-modal',
    active: isActive,
    layer: KEY_LAYER_MODAL,
    onKey: (input, key) => {
      if (input === 'r') {
        setReloadTick((n) => n + 1);
        return true;
      }
      if (input === 'm') {
        setViewMode((m) => (m === 'auto' ? 'json' : 'auto'));
        return true;
      }
      if (job.calls.length > 1) {
        if (key.leftArrow || input === '[') {
          setCallIdx((i) => Math.max(0, i - 1));
          return true;
        }
        if (key.rightArrow || input === ']') {
          setCallIdx((i) => Math.min(job.calls.length - 1, i + 1));
          return true;
        }
      }
      return false;
    },
  });

  const frameW = Math.min(108, Math.max(46, columns - 4));
  const frameH = Math.min(34, Math.max(15, rows - 2));
  const innerW = modalContentWidth(frameW);
  // Modal chrome: 5 rows; internal header + divider: 2 rows.
  const innerH = Math.max(6, Math.min(frameH, rows - 2) - 5);
  const bodyH = Math.max(3, innerH - 2);

  const parsed = useMemo(() => extractOutputContent(outputData), [outputData]);
  const showJson = viewMode === 'json' || parsed.kind === 'json';

  const hints: KeyHint[] = useMemo(() => {
    const h: KeyHint[] = [{ key: asciiMode ? 'Up/Dn/Pg' : '↑↓/Pg', label: t(lang, '滚动', 'Scroll') }];
    if (job.calls.length > 1) h.push({ key: asciiMode ? '<-/->' : '←/→', label: t(lang, '调用', 'Call') });
    if (parsed.kind !== 'empty') h.push({ key: 'm', label: showJson ? 'Markdown' : 'JSON' });
    h.push({ key: 'r', label: t(lang, '刷新', 'Refresh') });
    h.push({ key: 'Esc', label: t(lang, '关闭', 'Close') });
    return h;
  }, [asciiMode, job.calls.length, lang, parsed.kind, showJson]);

  const callBadge = activeCall
    ? `${activeCall.stage || activeCall.kind || activeCall.id} (${callIdx + 1}/${job.calls.length})`
    : t(lang, '默认输出', 'Output');

  return (
    <Modal
      title={t(lang, `任务输出: ${job.title}`, `Job Output: ${job.title}`)}
      icon={asciiMode ? '>' : '▤'}
      tone="primary"
      subtitle={job.status}
      width={frameW}
      height={frameH}
      onClose={onClose}
      isActive={isActive}
      hints={hints}
    >
      <Box height={1} width={innerW} overflow="hidden" flexShrink={0}>
        <StatusPill label={job.status} status={pillStatusFor(job.status)} />
        <Text> </Text>
        <Badge
          label={truncateDisplay(callBadge, Math.max(10, Math.floor(innerW * 0.4)), ell)}
          tone="info"
          variant="soft"
        />
        {outputData?.source ? (
          <>
            <Text> </Text>
            <Badge label={String(outputData.source)} tone="muted" variant="outline" />
          </>
        ) : null}
        {typeof outputData?.reasoningChars === 'number' && outputData.reasoningChars > 0 ? (
          <Text color={theme.dim}>{` ${t(lang, '思考', 'think')}:${outputData.reasoningChars}`}</Text>
        ) : null}
        {outputData?.clipped || outputData?.partial ? (
          <>
            <Text> </Text>
            <Badge label={t(lang, '截断', 'Clipped')} tone="warning" variant="outline" />
          </>
        ) : null}
      </Box>
      <Box height={1} width={innerW} overflow="hidden" flexShrink={0}>
        <Text color={theme.border}>{(asciiMode ? '-' : '─').repeat(innerW)}</Text>
      </Box>

      <Box width={innerW} height={bodyH} overflow="hidden">
        {loading ? (
          <Box width={innerW} height={bodyH} alignItems="center" justifyContent="center">
            <Spinner label={t(lang, `正在获取任务输出${ell}`, `Loading job output${ell}`)} active={isActive} />
          </Box>
        ) : parsed.kind === 'empty' ? (
          <EmptyState
            title={t(lang, '该任务暂无输出内容', 'No output available for this job yet')}
            hint={
              job.archived
                ? t(lang, '已归档任务不保留实时流输出缓存', 'Archived jobs do not retain live stream output')
                : outputData?.supported === false
                  ? t(lang, '当前运行器不支持实时流式输出', 'Live streaming output is not supported by this runner')
                  : outputData?.sessionUnreadable
                    ? t(lang, '子代理会话暂不可读', 'Subagent session output is unreadable')
                    : t(lang, '按 [r] 刷新输出，或稍后再试', 'Press [r] to refresh or check back shortly')
            }
            width={innerW}
            height={bodyH}
          />
        ) : showJson ? (
          <ScrollArea
            content={parsed.jsonText}
            width={innerW}
            height={bodyH}
            isActive={isActive}
            ascii={asciiMode}
          />
        ) : (
          <Suspense fallback={<Spinner label={t(lang, `加载输出视图${ell}`, `Loading output view${ell}`)} />}>
            <MarkdownView
              markdown={parsed.markdownText}
              width={innerW}
              height={bodyH}
              isActive={isActive}
              ascii={asciiMode}
            />
          </Suspense>
        )}
      </Box>
    </Modal>
  );
});
