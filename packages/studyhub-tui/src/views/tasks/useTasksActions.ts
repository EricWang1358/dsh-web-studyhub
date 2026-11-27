import { useCallback, useRef, useState } from 'react';
import type { Dispatch, MutableRefObject, SetStateAction } from 'react';
import { tmpdir } from 'node:os';
import type { HostClient, ToastItem, UiLanguage } from '../../types/contracts.js';
import { t } from '../../state/store.js';
import { tryAction } from '../../host/sample-actions.js';
import {
  ACTIVE_STATUSES,
  exportJobTraceToFile,
  isJobPaused,
  type ControlOverride,
  type JobRecord,
} from './tasks-model.js';

export interface UseTasksActionsParams {
  host: HostClient;
  lang: UiLanguage;
  snapshotRoot: string | undefined;
  selectedJob: JobRecord | undefined;
  notify: (text: string, tone?: ToastItem['tone']) => void;
  refresh: () => Promise<void>;
  mountedRef: MutableRefObject<boolean>;
  setLiveJobs: Dispatch<SetStateAction<Array<Record<string, unknown>> | null>>;
  setControlOverrides: Dispatch<SetStateAction<Record<string, ControlOverride>>>;
  setConfirmDeleteOpen: Dispatch<SetStateAction<boolean>>;
  setConfirmPurgeTraceOpen: Dispatch<SetStateAction<boolean>>;
  setTraceReloadTick: Dispatch<SetStateAction<number>>;
}

export interface TasksActions {
  busy: boolean;
  syncLiveAndRefresh: () => Promise<void>;
  handleCancel: () => Promise<void>;
  handleArchive: () => Promise<void>;
  handleDeleteConfirm: () => Promise<void>;
  handleExportTrace: () => Promise<void>;
  handlePurgeTraceConfirm: () => Promise<void>;
  handleTogglePause: () => Promise<void>;
  handleStartParallel: () => Promise<void>;
  handleAdjustConcurrency: (delta: -1 | 1) => Promise<void>;
  handleRecoverInterrupted: () => Promise<void>;
}

export function useTasksActions({
  host,
  lang,
  snapshotRoot,
  selectedJob,
  notify,
  refresh,
  mountedRef,
  setLiveJobs,
  setControlOverrides,
  setConfirmDeleteOpen,
  setConfirmPurgeTraceOpen,
  setTraceReloadTick,
}: UseTasksActionsParams): TasksActions {
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);

  const runBusy = useCallback(
    async (task: () => Promise<void>) => {
      if (busyRef.current) return;
      busyRef.current = true;
      setBusy(true);
      try {
        await task();
      } finally {
        busyRef.current = false;
        if (mountedRef.current) setBusy(false);
      }
    },
    [mountedRef],
  );

  const resolveLibraryRoot = useCallback((): string => {
    const hostWithInfo = host as HostClient & { getInfo?: () => { libraryRoot?: string } | null };
    return (
      host.getLibraryRoot?.()?.trim() ||
      hostWithInfo.getInfo?.()?.libraryRoot?.trim() ||
      host.getConfig?.()?.libraryRoot?.trim() ||
      snapshotRoot?.trim() ||
      tmpdir()
    );
  }, [host, snapshotRoot]);

  const syncLiveAndRefresh = useCallback(async () => {
    const liveRes = await tryAction<{ jobs?: Array<Record<string, unknown>> }>(host, 'job.live.list', {});
    if (!mountedRef.current) return;
    if (liveRes.ok && Array.isArray(liveRes.value?.jobs)) {
      setLiveJobs(liveRes.value.jobs);
    }
    await refresh();
  }, [host, mountedRef, refresh, setLiveJobs]);

  const handleCancel = useCallback(async () => {
    const targetJob = selectedJob;
    if (!targetJob || busy || busyRef.current) return;
    if (!ACTIVE_STATUSES.has(targetJob.status)) {
      notify(t(lang, '该任务已结束，无需取消', 'Job is already finished'), 'info');
      return;
    }
    await runBusy(async () => {
      const res = await tryAction(host, 'job.cancel', { jobId: targetJob.id });
      if (!mountedRef.current) return;
      if (!res.ok) {
        notify(res.error?.message || t(lang, '取消任务失败', 'Cancel failed'), 'error');
        return;
      }
      await refresh();
      if (mountedRef.current) {
        notify(t(lang, '已请求取消任务', 'Job cancel requested'), 'success');
      }
    });
  }, [busy, host, lang, mountedRef, notify, refresh, runBusy, selectedJob]);

  const handleArchive = useCallback(async () => {
    const targetJob = selectedJob;
    if (!targetJob || busy || busyRef.current) return;
    if (ACTIVE_STATUSES.has(targetJob.status)) {
      notify(t(lang, '运行中的任务无法归档', 'Running jobs cannot be archived'), 'info');
      return;
    }
    await runBusy(async () => {
      if (targetJob.archived) {
        const res = await tryAction<{ unarchived?: string[]; missing?: string[] }>(host, 'job.unarchive', {
          jobId: targetJob.id,
        });
        if (!mountedRef.current) return;
        if (!res.ok) {
          notify(res.error?.message || t(lang, '恢复归档任务失败', 'Unarchive failed'), 'error');
          return;
        }
        await refresh();
        if (mountedRef.current) {
          notify(t(lang, '任务已从归档恢复', 'Job restored from archive'), 'success');
        }
        return;
      }
      const res = await tryAction<{ archived?: string[]; skipped?: Array<{ id: string; reason: string }> }>(
        host,
        'job.archive',
        { jobId: targetJob.id },
      );
      if (!mountedRef.current) return;
      if (!res.ok) {
        notify(res.error?.message || t(lang, '归档任务失败', 'Archive failed'), 'error');
        return;
      }
      if (res.value?.skipped?.length) {
        notify(
          t(lang, `任务未能归档 (${res.value.skipped[0].reason})`, `Skipped (${res.value.skipped[0].reason})`),
          'warning',
        );
        return;
      }
      await refresh();
      if (mountedRef.current) {
        notify(t(lang, '任务已归档', 'Job archived'), 'success');
      }
    });
  }, [busy, host, lang, mountedRef, notify, refresh, runBusy, selectedJob]);

  const handleDeleteConfirm = useCallback(async () => {
    const targetJob = selectedJob;
    if (!targetJob || busy || busyRef.current) return;
    await runBusy(async () => {
      const dismissRes = await tryAction(host, 'job.dismiss', { jobId: targetJob.id });
      if (!mountedRef.current) return;
      if (dismissRes.ok) {
        setConfirmDeleteOpen(false);
        await refresh();
        if (mountedRef.current) {
          notify(t(lang, '任务记录已移除', 'Job removed'), 'success');
        }
        return;
      }
      const delRes = await tryAction<{
        deleted?: string[];
        skipped?: Array<{ id?: string; reason?: string }>;
        missing?: string[];
      }>(host, 'job.delete', { jobIds: [targetJob.id] });
      if (!mountedRef.current) return;
      setConfirmDeleteOpen(false);
      if (!delRes.ok) {
        notify(delRes.error?.message || t(lang, '删除任务失败', 'Delete failed'), 'error');
        return;
      }
      if (delRes.value?.skipped?.length) {
        const reason = delRes.value.skipped[0]?.reason;
        notify(
          reason === 'running'
            ? t(
                lang,
                '运行中的任务无法直接删除，请先按 [x] 取消任务',
                'Running job cannot be removed; press [x] to cancel it first',
              )
            : t(lang, `任务未能删除 (${reason || 'skipped'})`, `Job could not be removed (${reason || 'skipped'})`),
          'warning',
        );
        return;
      }
      if (delRes.value?.deleted && delRes.value.deleted.length === 0 && delRes.value.missing?.length) {
        await refresh();
        if (mountedRef.current) {
          notify(t(lang, '该任务记录已不存在，已刷新列表', 'Job record was already gone; list refreshed'), 'info');
        }
        return;
      }
      await refresh();
      if (mountedRef.current) {
        notify(t(lang, '任务记录已移除', 'Job removed'), 'success');
      }
    });
  }, [busy, host, lang, mountedRef, notify, refresh, runBusy, selectedJob, setConfirmDeleteOpen]);

  const handleExportTrace = useCallback(async () => {
    const targetJob = selectedJob;
    if (!targetJob || busy || busyRef.current) return;
    await runBusy(async () => {
      try {
        const res = await tryAction<{
          archived?: boolean;
          unavailableReason?: string;
          calls?: Array<{ callId?: string; retained?: boolean; deleted?: boolean }>;
        }>(host, 'job.trace.export', { jobId: targetJob.id });
        if (!mountedRef.current) return;
        if (!res.ok) {
          notify(res.error?.message || t(lang, '导出调用轨迹失败', 'Trace export failed'), 'error');
          return;
        }
        const payload = res.value;
        const calls = Array.isArray(payload?.calls) ? payload.calls : [];
        if (!payload || payload.archived || calls.length === 0 || calls.every((c) => c.deleted)) {
          const reason = payload?.unavailableReason;
          const msg =
            reason === 'archived'
              ? t(lang, '已归档任务不保留调用轨迹', 'Archived jobs do not retain traces')
              : reason === 'deleted-by-user'
                ? t(lang, '该任务的调用轨迹已被清空', 'Traces for this job have been purged')
                : t(lang, '该任务暂无可导出的调用轨迹', 'No trace available for this job');
          notify(msg, 'info');
          return;
        }
        const savedPath = await exportJobTraceToFile(resolveLibraryRoot(), targetJob.id, payload);
        if (!mountedRef.current) return;
        notify(t(lang, `轨迹已导出到 ${savedPath}`, `Trace exported to ${savedPath}`), 'success');
      } catch (err) {
        if (mountedRef.current) {
          const msg = err instanceof Error ? err.message : String(err);
          notify(t(lang, `导出调用轨迹失败: ${msg}`, `Trace export failed: ${msg}`), 'error');
        }
      }
    });
  }, [busy, host, lang, mountedRef, notify, resolveLibraryRoot, runBusy, selectedJob]);

  const handlePurgeTraceConfirm = useCallback(async () => {
    const targetJob = selectedJob;
    if (!targetJob || busy || busyRef.current) return;
    await runBusy(async () => {
      const res = await tryAction<{ jobId?: string; removed?: number }>(host, 'job.trace.delete', {
        jobId: targetJob.id,
      });
      if (!mountedRef.current) return;
      setConfirmPurgeTraceOpen(false);
      if (!res.ok) {
        notify(res.error?.message || t(lang, '清空调用轨迹失败', 'Failed to purge traces'), 'error');
        return;
      }
      const removed = typeof res.value?.removed === 'number' ? res.value.removed : 0;
      setTraceReloadTick((n) => n + 1);
      await refresh();
      if (!mountedRef.current) return;
      if (removed > 0) {
        notify(
          t(lang, `已清空 ${removed} 条调用轨迹（任务记录保留）`, `Purged ${removed} trace(s) (job record kept)`),
          'success',
        );
      } else {
        notify(
          t(lang, '该任务暂无可清空的缓存轨迹（任务记录保留）', 'No cached traces to purge (job record kept)'),
          'info',
        );
      }
    });
  }, [busy, host, lang, mountedRef, notify, refresh, runBusy, selectedJob, setConfirmPurgeTraceOpen, setTraceReloadTick]);

  const handleTogglePause = useCallback(async () => {
    if (busy || busyRef.current) return;
    const targetJob = selectedJob;
    if (!targetJob) {
      notify(t(lang, '请先选择一个任务', 'Select a job first'), 'info');
      return;
    }
    if (targetJob.archived) {
      notify(
        t(lang, '已归档任务为只读记录，请先按 [a] 取消归档', 'Archived job is read-only; press [a] to unarchive first'),
        'info',
      );
      return;
    }
    const pausedNow = isJobPaused(targetJob);
    if (!pausedNow && !targetJob.pauseAvailable && !ACTIVE_STATUSES.has(targetJob.status)) {
      notify(t(lang, '该任务已结束，无法暂停或继续', 'Job has ended; cannot pause or resume'), 'info');
      return;
    }

    const action = pausedNow ? 'resume' : 'pause';
    await runBusy(async () => {
      const res = await tryAction<{
        action?: string;
        paused?: boolean;
        status?: string;
        applied?: Record<string, unknown>;
        values?: Record<string, unknown>;
      }>(host, 'job.control', {
        jobId: targetJob.contractJobId,
        action,
      });
      if (!mountedRef.current) return;
      if (!res.ok) {
        notify(res.error?.message || t(lang, '队列控制操作失败', 'Job control failed'), 'warning');
        return;
      }

      const nextPaused = action === 'pause';
      const nextStatus =
        typeof res.value?.status === 'string' && res.value.status
          ? res.value.status
          : nextPaused
            ? targetJob.calls.some((c) => c.status === 'running')
              ? 'pausing'
              : 'paused'
            : 'running';

      setControlOverrides((prev) => ({
        ...prev,
        [targetJob.id]: { ...prev[targetJob.id], paused: nextPaused, status: nextStatus },
      }));
      try {
        await syncLiveAndRefresh();
      } finally {
        if (mountedRef.current) {
          setControlOverrides((prev) => {
            const next = { ...prev };
            delete next[targetJob.id];
            return next;
          });
        }
      }
      if (!mountedRef.current) return;
      notify(
        nextPaused
          ? t(lang, '已暂停任务队列（当前调用完成后停止新调度）', 'Job queue paused (no new calls will start)')
          : t(lang, '已恢复任务队列继续执行', 'Job queue resumed'),
        'success',
      );
    });
  }, [busy, host, lang, mountedRef, notify, runBusy, selectedJob, setControlOverrides, syncLiveAndRefresh]);

  const handleStartParallel = useCallback(async () => {
    if (busy || busyRef.current) return;
    const targetJob = selectedJob;
    if (!targetJob) {
      notify(t(lang, '请先选择一个排队中的任务', 'Select a queued job first'), 'info');
      return;
    }
    if (targetJob.archived) {
      notify(t(lang, '已归档任务无法并行启动', 'Archived jobs cannot be started in parallel'), 'info');
      return;
    }

    await runBusy(async () => {
      const res = await tryAction<{
        jobId?: string;
        attemptId?: string;
        status?: string;
        parallel?: boolean;
        note?: string;
      }>(host, 'job.parallel', {
        jobId: targetJob.contractJobId || targetJob.id,
      });
      if (!mountedRef.current) return;
      if (!res.ok) {
        notify(res.error?.message || t(lang, '无法并行启动该任务', 'Cannot start job in parallel'), 'warning');
        return;
      }

      await syncLiveAndRefresh();
      if (!mountedRef.current) return;
      notify(res.value?.note || t(lang, '已要求并行启动该任务', 'Job promoted to run in parallel'), 'success');
    });
  }, [busy, host, lang, mountedRef, notify, runBusy, selectedJob, syncLiveAndRefresh]);

  const handleAdjustConcurrency = useCallback(
    async (delta: -1 | 1) => {
      if (busy || busyRef.current) return;
      const targetJob = selectedJob;
      if (!targetJob) {
        notify(t(lang, '请先选择一个任务', 'Select a job first'), 'info');
        return;
      }
      if (targetJob.archived) {
        notify(
          t(lang, '已归档任务为只读记录，无法调整并发数', 'Archived job is read-only; concurrency cannot be changed'),
          'info',
        );
        return;
      }
      if (!targetJob.setAvailable || !targetJob.concurrencyKey || targetJob.concurrency === null) {
        notify(t(lang, '当前任务不支持并发数调节', 'Concurrency adjustment is unavailable for this job'), 'info');
        return;
      }

      const min = targetJob.concurrencyMin;
      const max = targetJob.concurrencyMax;
      const current = targetJob.concurrency;
      const next = Math.max(min, Math.min(max, current + delta));
      if (next === current) {
        notify(
          delta < 0
            ? t(lang, `并发数已达下限 (${min}x)`, `Concurrency already at minimum (${min}x)`)
            : t(lang, `并发数已达上限 (${max}x)`, `Concurrency already at maximum (${max}x)`),
          'info',
        );
        return;
      }

      const keyName = targetJob.concurrencyKey;
      await runBusy(async () => {
        const res = await tryAction<{
          applied?: Record<string, unknown>;
          values?: Record<string, unknown>;
        }>(host, 'job.control', {
          jobId: targetJob.contractJobId,
          action: 'set',
          patch: { [keyName]: next },
        });
        if (!mountedRef.current) return;
        if (!res.ok) {
          notify(res.error?.message || t(lang, '调整并发数失败', 'Failed to adjust concurrency'), 'warning');
          return;
        }
        const confirmedRaw = res.value?.values?.[keyName] ?? res.value?.applied?.[keyName];
        const confirmed =
          typeof confirmedRaw === 'number' && Number.isFinite(confirmedRaw) ? confirmedRaw : next;

        setControlOverrides((prev) => ({
          ...prev,
          [targetJob.id]: { ...prev[targetJob.id], concurrency: confirmed },
        }));
        try {
          await syncLiveAndRefresh();
        } finally {
          if (mountedRef.current) {
            setControlOverrides((prev) => {
              const nextMap = { ...prev };
              delete nextMap[targetJob.id];
              return nextMap;
            });
          }
        }
        if (!mountedRef.current) return;
        notify(t(lang, `并发数已调整为 ${confirmed}x`, `Concurrency updated to ${confirmed}x`), 'success');
      });
    },
    [busy, host, lang, mountedRef, notify, runBusy, selectedJob, setControlOverrides, syncLiveAndRefresh],
  );

  const handleRecoverInterrupted = useCallback(async () => {
    if (busy || busyRef.current) return;
    await runBusy(async () => {
      const res = await tryAction<{ recovered?: number }>(host, 'coverage.recover', {});
      if (!mountedRef.current) return;
      if (!res.ok) {
        notify(res.error?.message || t(lang, '恢复中断任务失败', 'Failed to recover interrupted jobs'), 'error');
        return;
      }
      const recovered = typeof res.value?.recovered === 'number' ? res.value.recovered : 0;
      await syncLiveAndRefresh();
      if (!mountedRef.current) return;
      if (recovered > 0) {
        notify(
          t(lang, `已恢复 ${recovered} 个中断任务`, `Recovered ${recovered} interrupted job(s)`),
          'success',
        );
      } else {
        notify(t(lang, '当前没有可恢复的中断任务', 'No interrupted jobs to recover'), 'info');
      }
    });
  }, [busy, host, lang, mountedRef, notify, runBusy, syncLiveAndRefresh]);

  return {
    busy,
    syncLiveAndRefresh,
    handleCancel,
    handleArchive,
    handleDeleteConfirm,
    handleExportTrace,
    handlePurgeTraceConfirm,
    handleTogglePause,
    handleStartParallel,
    handleAdjustConcurrency,
    handleRecoverInterrupted,
  };
}
