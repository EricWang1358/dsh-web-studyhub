import { useCallback, useEffect, useRef, useState } from 'react';
import type { BindingSnapshot, HostClient } from '../../types/contracts.js';
import { t, useTuiStore } from '../../state/store.js';
import {
  atomicWriteExportJson,
  atomicWriteExportText,
  defaultBackupFilePath,
} from '../../host/atomic-write.js';
import { cleanPathInput, loadSampleCourse, removeSampleCourse, tryAction } from '../../host/sample-actions.js';
import {
  buildRetrievalProviderChoices,
  type LibraryContextShape,
  type RestorePointEntry,
  type RetrievalCoverageShape,
  type RetrievalIndexPlanShape,
  type RetrievalPreviewResultShape,
  type RetrievalStatusShape,
  type RetrievalTestResultShape,
  type UpdateViewShape,
  type UsageFrequencyStatusShape,
  type UsageReportPeriod,
  type UsageReportShape,
} from './workspace-model.js';

export interface UseWorkspaceActionsOptions {
  host: HostClient;
  binding: BindingSnapshot | null;
  lang: 'zh' | 'en';
  asciiMode: boolean;
  ell: string;
  sampleLoaded: boolean;
  initialExperimental: boolean;
  snapshotRevision: number | undefined;
  onRefreshBinding: () => Promise<void>;
  refreshSnapshot: () => Promise<void>;
}

export function useWorkspaceActions({
  host,
  binding,
  lang,
  asciiMode,
  ell,
  sampleLoaded,
  initialExperimental,
  snapshotRevision,
  onRefreshBinding,
  refreshSnapshot,
}: UseWorkspaceActionsOptions) {
  const notify = useTuiStore((s) => s.notify);

  const [experimentalEnabled, setExperimentalEnabled] = useState<boolean>(() => initialExperimental);
  const [retrievalStatus, setRetrievalStatus] = useState<RetrievalStatusShape | null>(null);
  const [retrievalCoverage, setRetrievalCoverage] = useState<RetrievalCoverageShape | null>(null);
  const [retrievalLoaded, setRetrievalLoaded] = useState(false);
  const [usageStatus, setUsageStatus] = useState<UsageFrequencyStatusShape | null>(null);
  const [usageLoaded, setUsageLoaded] = useState(false);
  const [autoCheckEnabled, setAutoCheckEnabled] = useState<boolean | null>(null);
  const [updateLoaded, setUpdateLoaded] = useState(false);
  const [restorePoints, setRestorePoints] = useState<RestorePointEntry[]>([]);
  const [loadingPoints, setLoadingPoints] = useState(false);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [selectedPointIdx, setSelectedPointIdx] = useState(0);

  const [editingRoot, setEditingRoot] = useState(false);
  const [rootDraft, setRootDraft] = useState('');
  const [exportingBackup, setExportingBackup] = useState(false);
  const [exportPathDraft, setExportPathDraft] = useState('');
  const [confirmSampleRemove, setConfirmSampleRemove] = useState(false);
  const [confirmRestore, setConfirmRestore] = useState<RestorePointEntry | null>(null);
  const [confirmClearUsage, setConfirmClearUsage] = useState(false);

  const [retrievalDiagOpen, setRetrievalDiagOpen] = useState(false);
  const [retrievalDiagLoading, setRetrievalDiagLoading] = useState(false);
  const [retrievalPlan, setRetrievalPlan] = useState<RetrievalIndexPlanShape | null>(null);
  const [retrievalTest, setRetrievalTest] = useState<RetrievalTestResultShape | null>(null);
  const [retrievalDiagError, setRetrievalDiagError] = useState<string | null>(null);

  const [updateModalOpen, setUpdateModalOpen] = useState(false);
  const [updateCheckLoading, setUpdateCheckLoading] = useState(false);
  const [updateSnoozeBusy, setUpdateSnoozeBusy] = useState(false);
  const [updateInfo, setUpdateInfo] = useState<UpdateViewShape | null>(null);
  const [updateError, setUpdateError] = useState<string | null>(null);

  const [usageReportOpen, setUsageReportOpen] = useState(false);
  const [usageReportPeriod, setUsageReportPeriod] = useState<UsageReportPeriod>(30);
  const [usageReportLoading, setUsageReportLoading] = useState(false);
  const [usageReportActionBusy, setUsageReportActionBusy] = useState(false);
  const [usageReport, setUsageReport] = useState<UsageReportShape | null>(null);
  const [usageReportError, setUsageReportError] = useState<string | null>(null);
  const [usageReportExportPath, setUsageReportExportPath] = useState<string | null>(null);

  const [libraryCtxOpen, setLibraryCtxOpen] = useState(false);
  const [libraryCtxLoading, setLibraryCtxLoading] = useState(false);
  const [libraryCtxActionBusy, setLibraryCtxActionBusy] = useState(false);
  const [libraryCtxData, setLibraryCtxData] = useState<LibraryContextShape | null>(null);
  const [libraryCtxError, setLibraryCtxError] = useState<string | null>(null);
  const [libraryCtxExportPath, setLibraryCtxExportPath] = useState<string | null>(null);

  const mountedRef = useRef(true);
  const updateBusyRef = useRef(false);
  const updateCheckBusyRef = useRef(false);
  const retrievalBusyRef = useRef(false);
  const diagBusyRef = useRef(false);
  const usageReportBusyRef = useRef(false);
  const usageActionBusyRef = useRef(false);
  const libraryCtxBusyRef = useRef(false);
  const libraryCtxActionBusyRef = useRef(false);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const loadExperimental = useCallback(async () => {
    try {
      const res = await tryAction<{ enabled?: boolean }>(host, 'experimental.get', {});
      if (!mountedRef.current) return;
      if (res.ok && res.value && typeof res.value.enabled === 'boolean') {
        setExperimentalEnabled(res.value.enabled);
      }
    } catch {
      // Fail-soft: keep snapshot/default value when experimental.get is unavailable
    }
  }, [host]);

  const loadRetrieval = useCallback(async () => {
    try {
      const [statusRes, covRes] = await Promise.allSettled([
        tryAction<RetrievalStatusShape>(host, 'retrieval.status', {}),
        tryAction<RetrievalCoverageShape>(host, 'retrieval.index.coverage', {}),
      ]);
      if (!mountedRef.current) return;
      if (statusRes.status === 'fulfilled' && statusRes.value.ok && statusRes.value.value) {
        setRetrievalStatus(statusRes.value.value);
      }
      if (covRes.status === 'fulfilled' && covRes.value.ok && covRes.value.value) {
        setRetrievalCoverage(covRes.value.value);
      }
    } catch {
      // Fail-soft: keep fallback status when retrieval endpoints are unavailable
    } finally {
      if (mountedRef.current) setRetrievalLoaded(true);
    }
  }, [host]);

  const loadUsage = useCallback(async () => {
    try {
      const res = await tryAction<UsageFrequencyStatusShape>(host, 'usage.frequency.status', {});
      if (!mountedRef.current) return;
      if (res.ok && res.value && typeof res.value.enabled === 'boolean') {
        setUsageStatus(res.value);
      }
    } catch {
      // Fail-soft: keep fallback status when usage.frequency.status is unavailable
    } finally {
      if (mountedRef.current) setUsageLoaded(true);
    }
  }, [host]);

  const loadUpdatePrefs = useCallback(async () => {
    try {
      const res = await tryAction<UpdateViewShape>(host, 'update.preferences', {});
      if (!mountedRef.current) return;
      if (res.ok && res.value) {
        setUpdateInfo(res.value);
        if (typeof res.value.autoCheck === 'boolean') {
          setAutoCheckEnabled(res.value.autoCheck);
        }
      }
    } catch {
      // Fail-soft: keep fallback status when update.preferences is unavailable
    } finally {
      if (mountedRef.current) setUpdateLoaded(true);
    }
  }, [host]);

  useEffect(() => {
    void loadExperimental();
    void loadRetrieval();
    void loadUsage();
    void loadUpdatePrefs();
  }, [loadExperimental, loadRetrieval, loadUsage, loadUpdatePrefs]);

  const loadPoints = useCallback(async () => {
    setLoadingPoints(true);
    const res = await tryAction<{ points?: RestorePointEntry[] }>(host, 'library.restorePoints.list', {});
    if (!mountedRef.current) return;
    setLoadingPoints(false);
    if (res.ok && Array.isArray(res.value?.points)) {
      setRestorePoints(res.value.points);
    }
  }, [host]);

  useEffect(() => {
    void loadPoints();
  }, [loadPoints, snapshotRevision]);

  const handleSaveRoot = useCallback(
    async (raw: string) => {
      const cleaned = cleanPathInput(raw);
      setEditingRoot(false);
      if (!cleaned) return;
      setBusyAction(t(lang, `切换学习库路径${ell}`, `Switching library folder${ell}`));
      const res = await tryAction<BindingSnapshot>(host, 'binding.set', { root: cleaned });
      if (!mountedRef.current) return;
      setBusyAction(null);
      if (!res.ok) {
        notify(res.error?.message || t(lang, '切换学习库失败', 'Failed to change library folder'), 'error');
        return;
      }
      await Promise.all([onRefreshBinding(), refreshSnapshot()]);
      notify(t(lang, `学习库已切换到 ${cleaned}`, `Library switched to ${cleaned}`), 'success');
    },
    [ell, host, lang, notify, onRefreshBinding, refreshSnapshot],
  );

  const handleConfirmLocation = useCallback(async () => {
    setBusyAction(t(lang, `确认当前位置${ell}`, `Confirming location${ell}`));
    const res = await tryAction(host, 'desktop.library.confirm', {});
    if (!mountedRef.current) return;
    setBusyAction(null);
    if (!res.ok) {
      notify(res.error?.message || t(lang, '确认失败', 'Failed to confirm location'), 'error');
      return;
    }
    await onRefreshBinding();
    notify(t(lang, '已确认当前学习库位置', 'Library location confirmed'), 'success');
  }, [ell, host, lang, notify, onRefreshBinding]);

  const handleToggleSample = useCallback(async () => {
    if (busyAction) return;
    if (sampleLoaded) {
      setConfirmSampleRemove(true);
      return;
    }
    setBusyAction(t(lang, `载入示例课程${ell}`, `Loading sample course${ell}`));
    try {
      await loadSampleCourse(host, { language: lang });
      await refreshSnapshot();
      notify(t(lang, '示例课程已载入', 'Sample course loaded'), 'success');
    } catch (err) {
      notify(err instanceof Error ? err.message : String(err), 'error');
    } finally {
      if (mountedRef.current) setBusyAction(null);
    }
  }, [busyAction, ell, host, lang, notify, refreshSnapshot, sampleLoaded]);

  const handleRemoveSample = useCallback(async () => {
    setConfirmSampleRemove(false);
    setBusyAction(t(lang, `移除示例课程${ell}`, `Removing sample course${ell}`));
    try {
      await removeSampleCourse(host);
      await refreshSnapshot();
      notify(t(lang, '示例课程已移除', 'Sample course removed'), 'success');
    } catch (err) {
      notify(err instanceof Error ? err.message : String(err), 'error');
    } finally {
      if (mountedRef.current) setBusyAction(null);
    }
  }, [ell, host, lang, notify, refreshSnapshot]);

  const handleRestorePoint = useCallback(
    async (point: RestorePointEntry) => {
      setConfirmRestore(null);
      setBusyAction(t(lang, `恢复备份点${ell}`, `Restoring backup${ell}`));
      const res = await tryAction(host, 'library.restorePoints.restore', { id: point.id });
      if (!mountedRef.current) return;
      setBusyAction(null);
      if (!res.ok) {
        notify(res.error?.message || t(lang, '恢复备份失败', 'Failed to restore backup'), 'error');
        return;
      }
      await Promise.all([refreshSnapshot(), loadPoints()]);
      notify(t(lang, '已恢复到选定备份点', 'Restored selected backup'), 'success');
    },
    [ell, host, lang, loadPoints, notify, refreshSnapshot],
  );

  const handleToggleExperimental = useCallback(async () => {
    if (busyAction) return;
    const prev = experimentalEnabled;
    const next = !prev;
    setExperimentalEnabled(next);
    const res = await tryAction<{ enabled?: boolean }>(host, 'experimental.set', { enabled: next });
    if (!mountedRef.current) return;
    if (!res.ok) {
      setExperimentalEnabled(prev);
      notify(
        res.error?.message || t(lang, '切换实验性功能失败', 'Failed to toggle experimental features'),
        'error',
      );
      return;
    }
    const confirmedEnabled = typeof res.value?.enabled === 'boolean' ? res.value.enabled : next;
    setExperimentalEnabled(confirmedEnabled);
    void refreshSnapshot();
    notify(
      confirmedEnabled
        ? t(lang, '已开启实验性功能', 'Experimental features enabled')
        : t(lang, '已关闭实验性功能', 'Experimental features disabled'),
      'success',
    );
  }, [busyAction, experimentalEnabled, host, lang, notify, refreshSnapshot]);

  const handleToggleUsage = useCallback(async () => {
    if (busyAction) return;
    const prev = usageStatus;
    const nextEnabled = !(prev?.enabled);
    if (prev) {
      setUsageStatus({ ...prev, enabled: nextEnabled, ...(nextEnabled ? { paused: false } : {}) });
    }
    const res = await tryAction<UsageFrequencyStatusShape>(host, 'usage.frequency.set', { enabled: nextEnabled });
    if (!mountedRef.current) return;
    if (!res.ok || !res.value) {
      setUsageStatus(prev);
      notify(
        res.error?.message || t(lang, '切换使用频率记录失败', 'Failed to toggle usage frequency recording'),
        'error',
      );
      return;
    }
    setUsageStatus(res.value);
    setUsageLoaded(true);
    notify(
      res.value.enabled
        ? t(lang, '已开启本地使用频率记录', 'Usage frequency recording enabled')
        : t(lang, '已关闭本地使用频率记录', 'Usage frequency recording disabled'),
      'success',
    );
  }, [busyAction, host, lang, notify, usageStatus]);

  const handleClearUsage = useCallback(async () => {
    setConfirmClearUsage(false);
    if (busyAction) return;
    setBusyAction(t(lang, `正在清空使用记录${ell}`, `Clearing usage records${ell}`));
    const res = await tryAction<UsageFrequencyStatusShape>(host, 'usage.frequency.clear', {});
    if (!mountedRef.current) return;
    setBusyAction(null);
    if (!res.ok || !res.value) {
      notify(res.error?.message || t(lang, '清空使用记录失败', 'Failed to clear usage records'), 'error');
      return;
    }
    setUsageStatus(res.value);
    setUsageLoaded(true);
    notify(t(lang, '已删除全部本地使用记录', 'All usage frequency records cleared'), 'success');
  }, [busyAction, ell, host, lang, notify]);

  const loadUsageReport = useCallback(
    async (targetPeriod: UsageReportPeriod = usageReportPeriod) => {
      if (usageReportBusyRef.current) return;
      usageReportBusyRef.current = true;
      setUsageReportLoading(true);
      setUsageReportError(null);
      try {
        const res = await tryAction<UsageReportShape>(host, 'usage.frequency.report', {
          period: targetPeriod,
          language: lang,
        });
        if (!mountedRef.current) return;
        if (!res.ok || !res.value) {
          setUsageReportError(res.error?.message || t(lang, '读取使用报表失败', 'Failed to load usage report'));
          return;
        }
        setUsageReport(res.value);
      } catch (err) {
        if (!mountedRef.current) return;
        setUsageReportError(err instanceof Error ? err.message : String(err));
      } finally {
        usageReportBusyRef.current = false;
        if (mountedRef.current) setUsageReportLoading(false);
      }
    },
    [host, lang, usageReportPeriod],
  );

  const handleSelectUsagePeriod = useCallback(
    (nextPeriod: UsageReportPeriod) => {
      setUsageReportPeriod(nextPeriod);
      void loadUsageReport(nextPeriod);
    },
    [loadUsageReport],
  );

  const handleToggleUsagePause = useCallback(async () => {
    if (usageActionBusyRef.current || !usageStatus?.enabled) return;
    usageActionBusyRef.current = true;
    setUsageReportActionBusy(true);
    const nextPaused = !usageStatus.paused;
    try {
      const res = await tryAction<UsageFrequencyStatusShape>(host, 'usage.frequency.set', { paused: nextPaused });
      if (!mountedRef.current) return;
      if (!res.ok || !res.value) {
        const msg = res.error?.message || t(lang, '更新暂停状态失败', 'Failed to update pause state');
        setUsageReportError(msg);
        notify(msg, 'error');
        return;
      }
      setUsageStatus(res.value);
      setUsageLoaded(true);
      setUsageReportError(null);
      notify(
        res.value.paused
          ? t(lang, '已暂停使用频率记录', 'Usage frequency recording paused')
          : t(lang, '已恢复使用频率记录', 'Usage frequency recording resumed'),
        'success',
      );
    } finally {
      usageActionBusyRef.current = false;
      if (mountedRef.current) setUsageReportActionBusy(false);
    }
  }, [host, lang, notify, usageStatus]);

  const handleExportUsageReport = useCallback(async () => {
    if (usageActionBusyRef.current) return;
    usageActionBusyRef.current = true;
    setUsageReportActionBusy(true);
    try {
      const res = await tryAction<{ filename?: string; mime?: string; content?: string }>(
        host,
        'usage.frequency.export',
        { format: 'json', period: usageReportPeriod, language: lang },
      );
      if (!mountedRef.current) return;
      if (!res.ok || !res.value || typeof res.value.content !== 'string') {
        const msg = res.error?.message || t(lang, '导出使用报表失败', 'Failed to export usage report');
        setUsageReportError(msg);
        notify(msg, 'error');
        return;
      }
      const baseDir = binding?.root || host.getLibraryRoot() || process.cwd();
      const defaultPath = defaultBackupFilePath(baseDir, 'studyhub-usage', 'json', String(usageReportPeriod));
      const written = await atomicWriteExportText(defaultPath, res.value.content);
      if (!mountedRef.current) return;
      setUsageReportExportPath(written.path);
      setUsageReportError(null);
      const arrow = asciiMode ? '->' : '→';
      notify(
        t(lang, `已导出使用报表 ${arrow} ${written.path}`, `Exported usage report ${arrow} ${written.path}`),
        'success',
      );
    } catch (err) {
      if (!mountedRef.current) return;
      const msg = err instanceof Error ? err.message : String(err);
      setUsageReportError(msg);
      notify(t(lang, `导出使用报表失败：${msg}`, `Failed to export usage report: ${msg}`), 'error');
    } finally {
      usageActionBusyRef.current = false;
      if (mountedRef.current) setUsageReportActionBusy(false);
    }
  }, [asciiMode, binding?.root, host, lang, notify, usageReportPeriod]);

  const loadLibraryContext = useCallback(async () => {
    if (libraryCtxBusyRef.current) return;
    libraryCtxBusyRef.current = true;
    setLibraryCtxLoading(true);
    setLibraryCtxError(null);
    try {
      const res = await tryAction<LibraryContextShape>(host, 'library.context', {});
      if (!mountedRef.current) return;
      if (!res.ok || !res.value) {
        setLibraryCtxError(res.error?.message || t(lang, '读取学习库上下文失败', 'Failed to load library context'));
        return;
      }
      setLibraryCtxData(res.value);
    } catch (err) {
      if (!mountedRef.current) return;
      setLibraryCtxError(err instanceof Error ? err.message : String(err));
    } finally {
      libraryCtxBusyRef.current = false;
      if (mountedRef.current) setLibraryCtxLoading(false);
    }
  }, [host, lang]);

  const handleExportLibraryContext = useCallback(async () => {
    if (libraryCtxActionBusyRef.current) return;
    libraryCtxActionBusyRef.current = true;
    setLibraryCtxActionBusy(true);
    try {
      let payload = libraryCtxData;
      if (!payload) {
        const res = await tryAction<LibraryContextShape>(host, 'library.context', {});
        if (!mountedRef.current) return;
        if (!res.ok || !res.value) {
          const msg = res.error?.message || t(lang, '读取学习库上下文失败', 'Failed to load library context');
          setLibraryCtxError(msg);
          notify(msg, 'error');
          return;
        }
        payload = res.value;
        setLibraryCtxData(res.value);
      }
      const baseDir = binding?.root || host.getLibraryRoot() || payload.library || process.cwd();
      const defaultPath = defaultBackupFilePath(baseDir, 'studyhub-context', 'json', payload.focus?.course || undefined);
      const written = await atomicWriteExportJson(defaultPath, payload);
      if (!mountedRef.current) return;
      setLibraryCtxExportPath(written.path);
      setLibraryCtxError(null);
      const arrow = asciiMode ? '->' : '→';
      notify(
        t(lang, `已导出学习库上下文 ${arrow} ${written.path}`, `Exported library context ${arrow} ${written.path}`),
        'success',
      );
    } catch (err) {
      if (!mountedRef.current) return;
      const msg = err instanceof Error ? err.message : String(err);
      setLibraryCtxError(msg);
      notify(t(lang, `导出学习库上下文失败：${msg}`, `Failed to export library context: ${msg}`), 'error');
    } finally {
      libraryCtxActionBusyRef.current = false;
      if (mountedRef.current) setLibraryCtxActionBusy(false);
    }
  }, [asciiMode, binding?.root, host, lang, libraryCtxData, notify]);

  const handleToggleAutoCheck = useCallback(async () => {
    if (busyAction || updateBusyRef.current) return;
    updateBusyRef.current = true;
    const prev = autoCheckEnabled;
    const currentEffective = prev ?? true;
    const next = !currentEffective;
    setAutoCheckEnabled(next);
    try {
      const res = await tryAction<UpdateViewShape>(host, 'update.preferences', { autoCheck: next });
      if (!mountedRef.current) return;
      if (!res.ok || !res.value || typeof res.value.autoCheck !== 'boolean') {
        setAutoCheckEnabled(prev);
        notify(
          res.error?.message || t(lang, '切换自动检查更新失败', 'Failed to toggle automatic update check'),
          'error',
        );
        return;
      }
      setUpdateInfo(res.value);
      setAutoCheckEnabled(res.value.autoCheck);
      setUpdateLoaded(true);
      notify(
        res.value.autoCheck
          ? t(lang, '已开启自动检查更新', 'Auto update check enabled')
          : t(lang, '已关闭自动检查更新', 'Auto update check disabled'),
        'success',
      );
    } finally {
      updateBusyRef.current = false;
    }
  }, [autoCheckEnabled, busyAction, host, lang, notify]);

  const runUpdateCheck = useCallback(async () => {
    if (updateCheckBusyRef.current) return;
    updateCheckBusyRef.current = true;
    setUpdateCheckLoading(true);
    setUpdateError(null);
    try {
      const res = await tryAction<UpdateViewShape>(host, 'update.check', { force: true });
      if (!mountedRef.current) return;
      if (!res.ok || !res.value) {
        setUpdateError(res.error?.message || t(lang, '检查更新失败', 'Update check failed'));
        return;
      }
      setUpdateInfo(res.value);
      if (typeof res.value.autoCheck === 'boolean') {
        setAutoCheckEnabled(res.value.autoCheck);
        setUpdateLoaded(true);
      }
    } catch (err) {
      if (!mountedRef.current) return;
      setUpdateError(err instanceof Error ? err.message : String(err));
    } finally {
      updateCheckBusyRef.current = false;
      if (mountedRef.current) setUpdateCheckLoading(false);
    }
  }, [host, lang]);

  const handleToggleSnooze = useCallback(async () => {
    if (updateBusyRef.current || !updateInfo?.latest || !updateInfo?.newer) return;
    updateBusyRef.current = true;
    setUpdateSnoozeBusy(true);
    const targetVersion = updateInfo.latest;
    const nextSnooze = updateInfo.snoozed ? null : targetVersion;
    try {
      const res = await tryAction<UpdateViewShape>(host, 'update.preferences', { snooze: nextSnooze });
      if (!mountedRef.current) return;
      if (!res.ok || !res.value) {
        notify(
          res.error?.message || t(lang, '更新提醒设置失败', 'Failed to update snooze preference'),
          'error',
        );
        return;
      }
      setUpdateInfo(res.value);
      notify(
        res.value.snoozed
          ? t(lang, `已推迟 v${targetVersion} 更新提醒`, `Snoozed reminder for v${targetVersion}`)
          : t(lang, `已恢复 v${targetVersion} 更新提醒`, `Unsnoozed reminder for v${targetVersion}`),
        'success',
      );
    } finally {
      updateBusyRef.current = false;
      if (mountedRef.current) setUpdateSnoozeBusy(false);
    }
  }, [host, lang, notify, updateInfo]);

  const handleCycleRetrievalProvider = useCallback(async () => {
    if (busyAction || retrievalBusyRef.current) return;
    retrievalBusyRef.current = true;
    try {
      const choices = buildRetrievalProviderChoices(retrievalStatus);
      const current = retrievalStatus?.selected || 'builtin';
      const idx = choices.indexOf(current);
      const nextProvider = choices[(idx + 1) % choices.length] || 'builtin';
      const res = await tryAction<RetrievalStatusShape>(host, 'retrieval.set', { provider: nextProvider });
      if (!mountedRef.current) return;
      if (!res.ok || !res.value) {
        notify(
          res.error?.message || t(lang, '切换语义检索提供方失败', 'Failed to switch retrieval provider'),
          'error',
        );
        return;
      }
      setRetrievalStatus(res.value);
      setRetrievalLoaded(true);
      const covRes = await tryAction<RetrievalCoverageShape>(host, 'retrieval.index.coverage', {});
      if (!mountedRef.current) return;
      if (covRes.ok && covRes.value) {
        setRetrievalCoverage(covRes.value);
      }
      if (choices.length <= 1) {
        notify(
          t(lang, '当前仅检测到内置检索 (builtin)', 'Only built-in retrieval is available (builtin)'),
          'info',
        );
      } else {
        const providerLabel =
          res.value.providers?.find((p) => p.id === nextProvider)?.label ||
          res.value.providers?.find((p) => p.id === nextProvider)?.name ||
          nextProvider;
        notify(
          t(lang, `语义检索提供方已切换为 ${providerLabel}`, `Retrieval provider switched to ${providerLabel}`),
          'success',
        );
      }
    } finally {
      retrievalBusyRef.current = false;
    }
  }, [busyAction, host, lang, notify, retrievalStatus]);

  const runRetrievalDiag = useCallback(async () => {
    if (diagBusyRef.current) return;
    diagBusyRef.current = true;
    setRetrievalDiagLoading(true);
    setRetrievalDiagError(null);
    try {
      const [planRes, testRes, statusRes] = await Promise.allSettled([
        tryAction<RetrievalIndexPlanShape>(host, 'retrieval.index.plan', {}),
        tryAction<RetrievalTestResultShape>(host, 'retrieval.test', {}),
        tryAction<RetrievalStatusShape>(host, 'retrieval.status', {}),
      ]);
      if (!mountedRef.current) return;
      const errors: string[] = [];
      if (planRes.status === 'fulfilled') {
        if (planRes.value.ok && planRes.value.value) {
          setRetrievalPlan(planRes.value.value);
        } else {
          errors.push(planRes.value.error?.message || t(lang, '索引计划获取失败', 'Failed to load index plan'));
        }
      } else {
        errors.push(planRes.reason instanceof Error ? planRes.reason.message : String(planRes.reason));
      }
      if (testRes.status === 'fulfilled') {
        if (testRes.value.ok && testRes.value.value) {
          setRetrievalTest(testRes.value.value);
        } else {
          errors.push(testRes.value.error?.message || t(lang, '连通性测试失败', 'Connectivity test failed'));
        }
      } else {
        errors.push(testRes.reason instanceof Error ? testRes.reason.message : String(testRes.reason));
      }
      if (statusRes.status === 'fulfilled' && statusRes.value.ok && statusRes.value.value) {
        setRetrievalStatus(statusRes.value.value);
        setRetrievalLoaded(true);
      }
      if (errors.length > 0) {
        setRetrievalDiagError(errors.join('; '));
      }
    } finally {
      diagBusyRef.current = false;
      if (mountedRef.current) setRetrievalDiagLoading(false);
    }
  }, [host, lang]);

  const handleRetrievalPreview = useCallback(
    async (query: string): Promise<{ ok: boolean; value?: RetrievalPreviewResultShape; error?: string }> => {
      if (diagBusyRef.current) return { ok: false };
      diagBusyRef.current = true;
      try {
        const res = await tryAction<RetrievalPreviewResultShape>(host, 'retrieval.preview', {
          query,
          localHybrid: true,
          limit: 5,
        });
        if (!mountedRef.current) return { ok: false };
        if (!res.ok || !res.value) {
          return {
            ok: false,
            error: res.error?.message || t(lang, '本地混合试搜失败', 'Local hybrid search preview failed'),
          };
        }
        return { ok: true, value: res.value };
      } finally {
        diagBusyRef.current = false;
      }
    },
    [host, lang],
  );

  const handleSaveHfEndpoint = useCallback(
    async (rawEndpoint: string): Promise<{ ok: boolean; error?: string }> => {
      if (diagBusyRef.current) return { ok: false };
      diagBusyRef.current = true;
      const trimmed = rawEndpoint.trim();
      try {
        const res = await tryAction<RetrievalStatusShape>(host, 'retrieval.endpoint.set', { endpoint: trimmed });
        if (!mountedRef.current) return { ok: false };
        if (!res.ok || !res.value) {
          return {
            ok: false,
            error: res.error?.message || t(lang, '保存模型下载镜像失败', 'Failed to save HF mirror endpoint'),
          };
        }
        setRetrievalStatus(res.value);
        setRetrievalLoaded(true);
        notify(
          trimmed
            ? t(lang, `已保存模型下载镜像: ${trimmed}`, `Saved HF mirror endpoint: ${trimmed}`)
            : t(lang, '已恢复默认下载源', 'Reset HF endpoint to default'),
          'success',
        );
        return { ok: true };
      } finally {
        diagBusyRef.current = false;
      }
    },
    [host, lang, notify],
  );

  return {
    mountedRef,
    experimentalEnabled,
    retrievalStatus,
    retrievalCoverage,
    retrievalLoaded,
    usageStatus,
    usageLoaded,
    autoCheckEnabled,
    updateLoaded,
    restorePoints,
    loadingPoints,
    busyAction,
    setBusyAction,
    selectedPointIdx,
    setSelectedPointIdx,
    editingRoot,
    setEditingRoot,
    rootDraft,
    setRootDraft,
    exportingBackup,
    setExportingBackup,
    exportPathDraft,
    setExportPathDraft,
    confirmSampleRemove,
    setConfirmSampleRemove,
    confirmRestore,
    setConfirmRestore,
    confirmClearUsage,
    setConfirmClearUsage,
    retrievalDiagOpen,
    setRetrievalDiagOpen,
    retrievalDiagLoading,
    retrievalPlan,
    retrievalTest,
    retrievalDiagError,
    updateModalOpen,
    setUpdateModalOpen,
    updateCheckLoading,
    updateSnoozeBusy,
    updateInfo,
    updateError,
    usageReportOpen,
    setUsageReportOpen,
    usageReportPeriod,
    usageReportLoading,
    usageReportActionBusy,
    usageReport,
    usageReportError,
    setUsageReportError,
    usageReportExportPath,
    setUsageReportExportPath,
    libraryCtxOpen,
    setLibraryCtxOpen,
    libraryCtxLoading,
    libraryCtxActionBusy,
    libraryCtxData,
    libraryCtxError,
    setLibraryCtxError,
    libraryCtxExportPath,
    setLibraryCtxExportPath,
    loadPoints,
    loadRetrieval,
    loadUsage,
    loadUpdatePrefs,
    handleSaveRoot,
    handleConfirmLocation,
    handleToggleSample,
    handleRemoveSample,
    handleRestorePoint,
    handleToggleExperimental,
    handleToggleUsage,
    handleClearUsage,
    loadUsageReport,
    handleSelectUsagePeriod,
    handleToggleUsagePause,
    handleExportUsageReport,
    loadLibraryContext,
    handleExportLibraryContext,
    handleToggleAutoCheck,
    runUpdateCheck,
    handleToggleSnooze,
    handleCycleRetrievalProvider,
    runRetrievalDiag,
    handleRetrievalPreview,
    handleSaveHfEndpoint,
  };
}
