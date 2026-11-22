import React, { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { randomUUID } from 'node:crypto';
import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { Box, Text, useInput } from 'ink';
import type { BindingSnapshot, HostClient } from '../../types/contracts.js';
import { t, useTuiStore } from '../../state/store.js';
import { cleanPathInput, loadSampleCourse, removeSampleCourse, tryAction } from '../../host/index.js';
import { expandHomePath } from '../sources/index.js';
import { useShellActions } from '../../shell/actions.js';
import {
  Badge,
  ConfirmDialog,
  Modal,
  Panel,
  Spinner,
  TextInput,
  VirtualList,
  modalContentWidth,
  useClaimKeys,
  useTheme,
  type VirtualListRenderContext,
} from '../../components/index.js';
import { displayWidth, graphemeWidth, padDisplay, splitGraphemes, truncateDisplay } from '../../render/cjk.js';

export interface RestorePointEntry {
  id: string;
  createdAt?: string;
  reason?: string;
  tier?: string;
  sizeBytes?: number;
  extraBytes?: number;
  cards?: number;
  summary?: {
    cards?: number;
    decks?: number;
  };
}

export interface WorkspaceTabProps {
  host: HostClient;
  binding: BindingSnapshot | null;
  width: number;
  height: number;
  isActive: boolean;
  onRefreshBinding: () => Promise<void>;
}

interface RetrievalStatusShape {
  selected?: string;
  effective?: string;
  missing?: string;
  hostCanSearch?: boolean;
  companion?: {
    id?: string;
    running?: boolean;
    notStarted?: boolean;
  };
  extension?: {
    installed?: boolean;
    enabled?: boolean;
    version?: string;
    outdated?: boolean;
  };
}

interface UsageFrequencyStatusShape {
  enabled: boolean;
  paused: boolean;
  hasData: boolean;
  daysWithData: number;
  since: string;
  file?: string;
}

function describeRetrievalBadge(
  status: RetrievalStatusShape | null,
  loaded: boolean,
  lang: 'zh' | 'en',
  asciiMode: boolean,
): { label: string; tone: 'success' | 'warning' | 'accent' | 'muted' } {
  if (!status) {
    return {
      label: loaded ? t(lang, '未检测', 'Unavailable') : t(lang, '检测中', 'Checking'),
      tone: 'muted',
    };
  }
  if (status.missing && !(status.companion?.notStarted && status.missing === status.companion?.id)) {
    return { label: t(lang, '工具缺失', 'Missing'), tone: 'warning' };
  }
  if (status.companion?.notStarted || (status.extension?.installed && !status.companion?.running)) {
    return { label: t(lang, '未启动', 'Not Started'), tone: 'warning' };
  }
  if (status.effective && status.effective !== 'builtin') {
    return {
      label: asciiMode ? t(lang, '已就绪 +', 'Ready +') : t(lang, '已就绪 ✓', 'Ready ✓'),
      tone: 'success',
    };
  }
  if (status.companion?.running) {
    return { label: t(lang, '已启动(未启用)', 'Running (Off)'), tone: 'accent' };
  }
  if (status.hostCanSearch) {
    return { label: t(lang, '可用(未启用)', 'Available (Off)'), tone: 'muted' };
  }
  return { label: t(lang, '未启用', 'Disabled'), tone: 'muted' };
}

function describeUsageBadge(
  status: UsageFrequencyStatusShape | null,
  loaded: boolean,
  lang: 'zh' | 'en',
  asciiMode: boolean,
): { label: string; tone: 'success' | 'warning' | 'muted' } {
  if (!status) {
    return {
      label: loaded ? t(lang, '未读取', 'Unavailable') : t(lang, '读取中', 'Loading'),
      tone: 'muted',
    };
  }
  const days = Number(status.daysWithData) || 0;
  const daysText = t(lang, `${days}天`, `${days}d`);
  if (status.enabled && status.paused) {
    return { label: t(lang, `已暂停 (${daysText})`, `Paused (${daysText})`), tone: 'warning' };
  }
  if (status.enabled) {
    return {
      label: asciiMode
        ? t(lang, `已开启 + (${daysText})`, `Enabled + (${daysText})`)
        : t(lang, `已开启 ✓ (${daysText})`, `Enabled ✓ (${daysText})`),
      tone: 'success',
    };
  }
  return { label: t(lang, `已关闭 (${daysText})`, `Disabled (${daysText})`), tone: 'muted' };
}

function describeAutoUpdateBadge(
  autoCheck: boolean | null,
  loaded: boolean,
  lang: 'zh' | 'en',
  asciiMode: boolean,
): { label: string; tone: 'success' | 'muted' } {
  if (autoCheck === null) {
    return {
      label: loaded ? t(lang, '未读取', 'Unavailable') : t(lang, '读取中', 'Loading'),
      tone: 'muted',
    };
  }
  if (autoCheck) {
    return {
      label: asciiMode ? t(lang, '已开启 +', 'On +') : t(lang, '已开启 ✓', 'On ✓'),
      tone: 'success',
    };
  }
  return { label: t(lang, '已关闭', 'Off'), tone: 'muted' };
}

const RETRY_CODES = new Set(['EBUSY', 'EPERM', 'EACCES']);

function todayLocalYmd(): string {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

export function defaultBackupPath(libraryRoot: string): string {
  return join(libraryRoot || process.cwd(), 'backups', `studyhub-backup-${todayLocalYmd()}.json`);
}

export function resolveBackupPath(raw: string, baseDir: string): string {
  const cleaned = cleanPathInput(raw);
  if (!cleaned) return '';
  const expanded = expandHomePath(cleaned, homedir());
  const withExt = expanded.toLowerCase().endsWith('.json') ? expanded : `${expanded}.json`;
  return isAbsolute(withExt) ? withExt : resolve(baseDir, withExt);
}

async function renameWithRetry(from: string, to: string): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await rename(from, to);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException)?.code || '';
      if (!RETRY_CODES.has(code) || attempt >= 5) throw error;
      await new Promise((done) => setTimeout(done, 40 * (attempt + 1)));
    }
  }
}

export async function atomicWriteJsonFile(targetPath: string, payload: unknown): Promise<{ bytes: number }> {
  const json = `${JSON.stringify(payload, null, 2)}\n`;
  await mkdir(dirname(targetPath), { recursive: true });
  const temp = `${targetPath}.${randomUUID()}.tmp`;
  await writeFile(temp, json, 'utf8');
  try {
    await renameWithRetry(temp, targetPath);
  } catch (error) {
    await rm(temp, { force: true }).catch(() => {});
    throw error;
  }
  return { bytes: Buffer.byteLength(json, 'utf8') };
}

export function summarizeExportPayload(payload: Record<string, unknown> | null | undefined): {
  decksCount: number;
  cardsCount: number;
  referencedOriginals: number;
} {
  const decks = Array.isArray(payload?.decks) ? (payload.decks as Array<{ cards?: unknown[] }>) : [];
  const decksCount = decks.length;
  const cardsCount = decks.reduce((sum, deck) => sum + (Array.isArray(deck?.cards) ? deck.cards.length : 0), 0);
  const pm = payload?.portableMaterials as { referencedOriginals?: unknown[] } | undefined;
  const referencedOriginals = Array.isArray(pm?.referencedOriginals) ? pm.referencedOriginals.length : 0;
  return { decksCount, cardsCount, referencedOriginals };
}

function formatBytes(bytes?: number): string {
  const n = Number(bytes) || 0;
  if (n <= 0) return '0 B';
  if (n >= 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${n} B`;
}

/**
 * Truncate a file/directory path in the middle so both the start prefix (e.g. `C:\Users\`)
 * and the trailing folder name (e.g. `\studyhub-tui-xxx`) remain visible within `maxWidth`.
 */
export function truncatePathMiddle(rawPath: string, maxWidth: number, ell = '…'): string {
  const text = String(rawPath ?? '');
  if (!text || displayWidth(text) <= maxWidth) return text;
  const ellW = displayWidth(ell);
  if (maxWidth <= ellW + 2) return truncateDisplay(text, maxWidth, ell);

  const trimmed = text.length > 3 ? text.replace(/[\\/]+$/, '') : text;
  const sepIdx = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'));

  const sliceEndWidth = (str: string, budget: number): string => {
    const gs = splitGraphemes(str);
    let out = '';
    let w = 0;
    for (let i = gs.length - 1; i >= 0; i -= 1) {
      const gw = graphemeWidth(gs[i]);
      if (w + gw > budget) break;
      out = gs[i] + out;
      w += gw;
    }
    return out;
  };

  if (sepIdx <= 0 || sepIdx === trimmed.length - 1) {
    const budget = maxWidth - ellW;
    const headW = Math.max(1, Math.floor(budget / 2));
    const tailW = Math.max(1, budget - headW);
    return `${truncateDisplay(trimmed, headW, '')}${ell}${sliceEndWidth(trimmed, tailW)}`;
  }

  const tailSegment = trimmed.slice(sepIdx); // includes leading separator + trailing folder name
  const tailW = displayWidth(tailSegment);
  const headBudget = maxWidth - ellW - tailW;

  if (headBudget >= 3) {
    const headPart = truncateDisplay(trimmed.slice(0, sepIdx), headBudget, '');
    return `${headPart}${ell}${tailSegment}`;
  }

  const minHeadW = Math.min(4, Math.max(2, Math.floor((maxWidth - ellW) * 0.25)));
  const headPart = truncateDisplay(trimmed.slice(0, sepIdx), minHeadW, '');
  const tailBudget = Math.max(1, maxWidth - displayWidth(headPart) - ellW);
  if (tailW <= tailBudget) return `${headPart}${ell}${tailSegment}`;
  return `${headPart}${ell}${sliceEndWidth(tailSegment, tailBudget)}`;
}

export const WorkspaceTab: React.FC<WorkspaceTabProps> = memo(function WorkspaceTab({
  host,
  binding,
  width,
  height,
  isActive,
  onRefreshBinding,
}) {
  const theme = useTheme();
  const lang = useTuiStore((s) => s.preferences.language);
  const asciiMode = useTuiStore((s) => Boolean(s.preferences.asciiMode));
  const ell = asciiMode ? '...' : '…';
  const snapshot = useTuiStore((s) => s.snapshot);
  const desktopConfig = useTuiStore((s) => s.desktopConfig);
  const notify = useTuiStore((s) => s.notify);
  const { refresh: refreshSnapshot } = useShellActions();

  const sampleLoaded = Boolean(snapshot?.sample?.loaded);

  const [experimentalEnabled, setExperimentalEnabled] = useState<boolean>(
    () => Boolean(snapshot?.experimental),
  );
  const [retrievalStatus, setRetrievalStatus] = useState<RetrievalStatusShape | null>(null);
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

  const mountedRef = useRef(true);
  const updateBusyRef = useRef(false);
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
      const res = await tryAction<RetrievalStatusShape>(host, 'retrieval.status', {});
      if (!mountedRef.current) return;
      if (res.ok && res.value) {
        setRetrievalStatus(res.value);
      }
    } catch {
      // Fail-soft: keep fallback status when retrieval.status is unavailable
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
      const res = await tryAction<{ autoCheck?: boolean }>(host, 'update.preferences', {});
      if (!mountedRef.current) return;
      if (res.ok && res.value && typeof res.value.autoCheck === 'boolean') {
        setAutoCheckEnabled(res.value.autoCheck);
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
  }, [loadPoints, snapshot?.revision]);

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
    [host, lang, notify, onRefreshBinding, refreshSnapshot],
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
  }, [host, lang, notify, onRefreshBinding]);

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
  }, [busyAction, host, lang, notify, refreshSnapshot, sampleLoaded]);

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
  }, [host, lang, notify, refreshSnapshot]);

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
    [host, lang, loadPoints, notify, refreshSnapshot],
  );

  const handleExportBackup = useCallback(
    async (raw: string) => {
      if (busyAction) return;
      const baseDir = binding?.root || host.getLibraryRoot() || process.cwd();
      const targetPath = resolveBackupPath(raw, baseDir);
      setExportingBackup(false);
      if (!targetPath) return;
      setBusyAction(t(lang, `导出学习库备份${ell}`, `Exporting library backup${ell}`));
      try {
        const res = await tryAction<Record<string, unknown>>(host, 'export', {});
        if (!mountedRef.current) return;
        if (!res.ok || !res.value) {
          notify(res.error?.message || t(lang, '导出学习库备份失败', 'Failed to export library backup'), 'error');
          return;
        }
        const { bytes } = await atomicWriteJsonFile(targetPath, res.value);
        if (!mountedRef.current) return;
        const { decksCount, cardsCount, referencedOriginals } = summarizeExportPayload(res.value);
        const arrow = asciiMode ? '->' : '→';
        const refSuffix =
          referencedOriginals > 0
            ? t(
                lang,
                `；${referencedOriginals} 份外部原文件仅记录路径`,
                `; ${referencedOriginals} external originals referenced by path`,
              )
            : '';
        notify(
          t(
            lang,
            `已导出备份 (${formatBytes(bytes)}, ${decksCount} 牌组, ${cardsCount} 卡片) ${arrow} ${targetPath}${refSuffix}`,
            `Exported backup (${formatBytes(bytes)}, ${decksCount} decks, ${cardsCount} cards) ${arrow} ${targetPath}${refSuffix}`,
          ),
          'success',
        );
      } catch (err) {
        if (!mountedRef.current) return;
        const msg = err instanceof Error ? err.message : String(err);
        notify(t(lang, `导出备份失败：${msg}`, `Export failed: ${msg}`), 'error');
      } finally {
        if (mountedRef.current) setBusyAction(null);
      }
    },
    [asciiMode, binding?.root, busyAction, host, lang, notify],
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

  const handleToggleAutoCheck = useCallback(async () => {
    if (busyAction || updateBusyRef.current) return;
    updateBusyRef.current = true;
    const prev = autoCheckEnabled;
    const currentEffective = prev ?? true;
    const next = !currentEffective;
    setAutoCheckEnabled(next);
    try {
      const res = await tryAction<{ autoCheck?: boolean }>(host, 'update.preferences', { autoCheck: next });
      if (!mountedRef.current) return;
      if (!res.ok || !res.value || typeof res.value.autoCheck !== 'boolean') {
        setAutoCheckEnabled(prev);
        notify(
          res.error?.message || t(lang, '切换自动检查更新失败', 'Failed to toggle automatic update check'),
          'error',
        );
        return;
      }
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

  const modalOpen =
    editingRoot || exportingBackup || confirmSampleRemove || Boolean(confirmRestore) || confirmClearUsage;
  const claimed = useMemo(() => ['e', 's', 'x', 'r', 'c', 'f', 'u', 'U', 'a'], []);
  useClaimKeys(claimed, isActive && !modalOpen);

  useInput(
    (input, key) => {
      if (input === 'e') {
        setRootDraft(binding?.root || host.getLibraryRoot() || '');
        setEditingRoot(true);
        return;
      }
      if (input === 's') {
        void handleToggleSample();
        return;
      }
      if (input === 'x') {
        if (busyAction) return;
        const baseDir = binding?.root || host.getLibraryRoot() || process.cwd();
        setExportPathDraft(defaultBackupPath(baseDir));
        setExportingBackup(true);
        return;
      }
      if (input === 'c' && desktopConfig && !desktopConfig.libraryPlaceConfirmed) {
        void handleConfirmLocation();
        return;
      }
      if (input === 'f') {
        void handleToggleExperimental();
        return;
      }
      if (input === 'u') {
        void handleToggleUsage();
        return;
      }
      if (input === 'U') {
        if (!busyAction) setConfirmClearUsage(true);
        return;
      }
      if (input === 'a') {
        void handleToggleAutoCheck();
        return;
      }
      if (input === 'r') {
        void loadPoints();
        void loadRetrieval();
        void loadUsage();
        void loadUpdatePrefs();
        return;
      }
      if (key.return && restorePoints[selectedPointIdx]) {
        setConfirmRestore(restorePoints[selectedPointIdx]);
      }
    },
    { isActive: isActive && !modalOpen },
  );

  const rootPath = binding?.root || host.getLibraryRoot() || '';
  const defaultRoot = binding?.defaultRoot || '';
  const confirmed = desktopConfig?.libraryPlaceConfirmed ?? true;

  const compactLayout = width < 84;
  const infoPanelH = compactLayout ? 11 : 10;
  const listPanelH = Math.max(6, height - infoPanelH);
  const listRows = Math.max(1, listPanelH - 2);

  const renderPoint = useCallback(
    (pt: RestorePointEntry, ctx: VirtualListRenderContext) => {
      const ts = pt.createdAt ? pt.createdAt.slice(0, 19).replace('T', ' ') : pt.id;
      const bytes = pt.extraBytes ?? pt.sizeBytes;
      const cards = pt.summary?.cards ?? pt.cards;
      const tag = pt.reason || pt.tier;
      const sep = asciiMode ? ' - ' : ' · ';
      const right = `${formatBytes(bytes)}${cards !== undefined ? `${sep}${cards} cards` : ''}`;
      const rightW = displayWidth(right);
      const leftW = Math.max(8, ctx.width - rightW - 4);
      const pointer = ctx.selected ? (asciiMode ? '>' : '❯') : ' ';
      const label = truncateDisplay(`${pointer} ${ts}${tag ? `${sep}${tag}` : ''}`, leftW);
      return (
        <Box width={ctx.width} height={1}>
          <Text color={ctx.selected ? theme.selectionFg : theme.text} bold={ctx.selected}>
            {padDisplay(label, leftW + 2)}
          </Text>
          <Text color={theme.muted}>{padDisplay(right, rightW + 2, 'right')}</Text>
        </Box>
      );
    },
    [asciiMode, theme.muted, theme.selectionFg, theme.text],
  );

  const modalW = Math.min(72, Math.max(40, width - 6));
  const sampleActionLabel = `[s] ${sampleLoaded ? t(lang, '移除示例课程', 'Remove sample') : t(lang, '载入示例课程', 'Load sample')}`;
  const exportActionLabel = `[x] ${t(lang, '导出学习库备份', 'Export backup')}`;
  const confirmActionLabel = `[c] ${t(lang, '确认位置', 'Confirm place')}`;
  const experimentalBadgeLabel = experimentalEnabled
    ? asciiMode
      ? t(lang, '已开启 +', 'Enabled +')
      : t(lang, '已开启 ✓', 'Enabled ✓')
    : t(lang, '已关闭', 'Disabled');
  const experimentalActionLabel = `[f] ${t(lang, '切换', 'Toggle')}`;
  const retrievalBadge = describeRetrievalBadge(retrievalStatus, retrievalLoaded, lang, asciiMode);
  const usageBadge = describeUsageBadge(usageStatus, usageLoaded, lang, asciiMode);
  const usageToggleLabel = `[u] ${t(lang, '切换', 'Toggle')}`;
  const usageClearLabel = `[U] ${t(lang, '清空记录', 'Clear data')}`;
  const autoUpdateBadge = describeAutoUpdateBadge(autoCheckEnabled, updateLoaded, lang, asciiMode);
  const autoUpdateToggleLabel = `[a] ${t(lang, '切换', 'Toggle')}`;

  return (
    <Box flexDirection="column" width={width} height={height} overflow="hidden">
      <Panel
        title={t(lang, '学习库路径与工作区', 'Library Root & Workspace')}
        subtitle={busyAction || binding?.rootSource || undefined}
        focused={isActive && !modalOpen}
        width={width}
        height={infoPanelH}
      >
        <Box flexDirection="row" gap={1}>
          <Text color={theme.muted}>{t(lang, '当前学习库:', 'Current Root:')}</Text>
          <Text color={theme.primary} bold>
            {truncatePathMiddle(rootPath, Math.max(10, width - 22), ell)}
          </Text>
        </Box>
        <Box flexDirection="row" gap={1}>
          <Text color={theme.muted}>{t(lang, '默认路径:  ', 'Default Root:')}</Text>
          <Text color={theme.dim}>{truncatePathMiddle(defaultRoot || '-', Math.max(10, width - 22), ell)}</Text>
        </Box>
        <Box flexDirection="row" gap={2} marginTop={0}>
          <Text color={theme.muted}>
            {t(lang, '位置确认:', 'Place Status:')}{' '}
            <Badge
              label={confirmed ? t(lang, '已确认', 'Confirmed') : t(lang, '待确认 [c]', 'Unconfirmed [c]')}
              tone={confirmed ? 'success' : 'warning'}
              variant="soft"
            />
          </Text>
          <Text color={theme.muted}>
            {t(lang, '示例课程:', 'Sample:')}{' '}
            <Badge
              label={sampleLoaded ? t(lang, '已载入', 'Loaded') : t(lang, '未载入', 'Not Loaded')}
              tone={sampleLoaded ? 'accent' : 'muted'}
              variant="soft"
            />
          </Text>
        </Box>
        <Box flexDirection="row" gap={2} marginTop={0}>
          <Text color={theme.muted}>
            {t(lang, '实验性功能:', 'Experimental Features:')}{' '}
            <Badge
              label={experimentalBadgeLabel}
              tone={experimentalEnabled ? 'accent' : 'muted'}
              variant="soft"
            />
          </Text>
          <Text color={theme.accent}>{experimentalActionLabel}</Text>
          <Text color={theme.muted}>
            {t(lang, '语义检索:', 'Retrieval:')}{' '}
            <Badge label={retrievalBadge.label} tone={retrievalBadge.tone} variant="soft" />
          </Text>
        </Box>
        <Box flexDirection="row" gap={2} marginTop={0}>
          <Text color={theme.muted}>
            {t(lang, '使用频率记录:', 'Usage Frequency:')}{' '}
            <Badge label={usageBadge.label} tone={usageBadge.tone} variant="soft" />
          </Text>
          <Text color={theme.accent}>{usageToggleLabel}</Text>
          <Text color={theme.warning}>{usageClearLabel}</Text>
        </Box>
        <Box flexDirection="row" gap={2} marginTop={0}>
          <Text color={theme.muted}>
            {t(lang, '自动检查更新:', 'Auto Update:')}{' '}
            <Badge label={autoUpdateBadge.label} tone={autoUpdateBadge.tone} variant="soft" />
          </Text>
          <Text color={theme.accent}>{autoUpdateToggleLabel}</Text>
        </Box>
        {compactLayout ? (
          <>
            <Box flexDirection="row" gap={2} marginTop={0}>
              <Text color={theme.accent}>{`[e] ${t(lang, '更改文件夹路径', 'Change folder')}`}</Text>
              <Text color={theme.accent}>{sampleActionLabel}</Text>
            </Box>
            <Box flexDirection="row" gap={2}>
              <Text color={theme.accent}>{exportActionLabel}</Text>
              {!confirmed ? <Text color={theme.warning}>{confirmActionLabel}</Text> : null}
            </Box>
          </>
        ) : (
          <Box flexDirection="row" gap={2} marginTop={0}>
            <Text color={theme.accent}>{`[e] ${t(lang, '更改文件夹路径', 'Change folder')}`}</Text>
            <Text color={theme.accent}>{sampleActionLabel}</Text>
            <Text color={theme.accent}>{exportActionLabel}</Text>
            {!confirmed ? <Text color={theme.warning}>{confirmActionLabel}</Text> : null}
          </Box>
        )}
      </Panel>

      <Panel
        title={t(lang, '学习库自动备份点 (Enter 恢复)', 'Library Restore Points (Enter to Restore)')}
        badge={restorePoints.length}
        subtitle={loadingPoints ? t(lang, `加载中${ell}`, `Loading${ell}`) : t(lang, '[r] 刷新', '[r] Refresh')}
        width={width}
        height={listPanelH}
      >
        {loadingPoints && restorePoints.length === 0 ? (
          <Spinner label={t(lang, `正在读取备份列表${ell}`, `Loading restore points${ell}`)} active={isActive} />
        ) : restorePoints.length === 0 ? (
          <Text color={theme.muted}>
            {truncateDisplay(
              t(lang, '暂无备份点（学习库发生重要变更时会自动创建快照）', 'No restore points yet (created automatically on major edits).'),
              Math.max(10, width - 4),
              ell,
            )}
          </Text>
        ) : (
          <VirtualList
            items={restorePoints}
            height={listRows}
            width={Math.max(10, width - 4)}
            selectedIndex={selectedPointIdx}
            onChange={(idx) => setSelectedPointIdx(idx)}
            onSelect={(pt) => setConfirmRestore(pt)}
            renderItem={renderPoint}
            keyExtractor={(pt) => pt.id}
            isActive={isActive && !modalOpen}
          />
        )}
      </Panel>

      {editingRoot ? (
        <Modal
          title={t(lang, '更改学习库文件夹路径', 'Change Library Folder Path')}
          width={modalW}
          onClose={() => setEditingRoot(false)}
          isActive={isActive}
          hints={[
            { key: 'Enter', label: t(lang, '保存', 'Save') },
            { key: 'Esc', label: t(lang, '取消', 'Cancel') },
          ]}
        >
          <Text color={theme.muted}>
            {t(lang, '输入绝对路径（留空恢复默认位置），支持 Linux/Windows 路径：', 'Enter folder path (empty resets to default):')}
          </Text>
          <Box marginTop={1}>
            <TextInput
              value={rootDraft}
              onChange={setRootDraft}
              onSubmit={(v) => void handleSaveRoot(v)}
              onCancel={() => setEditingRoot(false)}
              width={Math.max(12, modalContentWidth(modalW) - 4)}
              isActive={isActive}
              prompt={asciiMode ? '>' : '›'}
              placeholder={defaultRoot || '/path/to/StudyHub'}
            />
          </Box>
        </Modal>
      ) : null}

      {exportingBackup ? (
        <Modal
          title={t(lang, '导出学习库备份', 'Export Library Backup')}
          width={modalW}
          onClose={() => setExportingBackup(false)}
          isActive={isActive}
          hints={[
            { key: 'Enter', label: t(lang, '导出 JSON', 'Export JSON') },
            { key: 'Esc', label: t(lang, '取消', 'Cancel') },
          ]}
        >
          <Text color={theme.muted}>
            {t(
              lang,
              '输入备份文件路径（支持 Linux/Windows 及拖拽路径，留空取消）：',
              'Enter backup file path (supports Linux/Windows & dropped paths):',
            )}
          </Text>
          <Box marginTop={1}>
            <TextInput
              value={exportPathDraft}
              onChange={setExportPathDraft}
              onSubmit={(v) => void handleExportBackup(v)}
              onCancel={() => setExportingBackup(false)}
              width={Math.max(12, modalContentWidth(modalW) - 4)}
              isActive={isActive}
              prompt={asciiMode ? '>' : '›'}
              placeholder={defaultBackupPath(rootPath)}
            />
          </Box>
        </Modal>
      ) : null}

      {confirmSampleRemove ? (
        <ConfirmDialog
          title={t(lang, '移除示例课程', 'Remove Sample Course')}
          message={t(lang, '确定要从当前学习库移除内置示例课程吗？', 'Remove the built-in sample course from this library?')}
          danger
          onConfirm={() => void handleRemoveSample()}
          onCancel={() => setConfirmSampleRemove(false)}
          isActive={isActive}
        />
      ) : null}

      {confirmRestore ? (
        <ConfirmDialog
          title={t(lang, '恢复备份点', 'Restore Backup Point')}
          message={t(
            lang,
            `确定要恢复到 ${confirmRestore.createdAt || confirmRestore.id} 吗？当前未保存的更改将被替换。`,
            `Restore library to ${confirmRestore.createdAt || confirmRestore.id}?`,
          )}
          danger
          onConfirm={() => void handleRestorePoint(confirmRestore)}
          onCancel={() => setConfirmRestore(null)}
          isActive={isActive}
        />
      ) : null}

      {confirmClearUsage ? (
        <ConfirmDialog
          title={t(lang, '删除全部使用记录', 'Clear Usage Frequency Data')}
          message={t(
            lang,
            '确定要删除所有本地记录的使用次数和日期吗？不影响学习库，也不会改变当前的开启/关闭开关。',
            'Delete all locally recorded usage counts and dates? This does not affect your study library or change the recording switch.',
          )}
          confirmLabel={t(lang, '清空记录', 'Clear Data')}
          cancelLabel={t(lang, '取消', 'Cancel')}
          danger
          width={Math.min(62, Math.max(40, width - 6))}
          onConfirm={() => void handleClearUsage()}
          onCancel={() => setConfirmClearUsage(false)}
          isActive={isActive}
        />
      ) : null}
    </Box>
  );
});
