import React, { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { isAbsolute, relative, resolve } from 'node:path';
import { Box, Text } from 'ink';
import { useScopedInput as useInput } from '../../components/key-dispatcher.js';
import type { BindingSnapshot, HostClient } from '../../types/contracts.js';
import { t, useTuiStore } from '../../state/store.js';
import {
  atomicWriteExportJson,
  atomicWriteExportText,
  atomicWriteJsonFile,
  atomicWriteTextFile,
  defaultBackupFilePath,
  resolveSafeBackupExportPath,
} from '../../host/atomic-write.js';
import { cleanPathInput, loadSampleCourse, removeSampleCourse, tryAction } from '../../host/sample-actions.js';
import { useShellActions } from '../../shell/actions.js';
import { useTheme } from '../../theme/tokens.js';
import { Badge, normalizeAsciiChrome, Spinner } from '../../components/Badge.js';
import { ConfirmDialog } from '../../components/ConfirmDialog.js';
import { Modal, modalContentWidth } from '../../components/Modal.js';
import { Panel } from '../../components/Panel.js';
import { TextInput } from '../../components/TextInput.js';
import { VirtualList, type VirtualListRenderContext } from '../../components/VirtualList.js';
import { useClaimKeys } from '../../components/focus.js';
import { displayWidth, graphemeWidth, padDisplay, splitGraphemes, truncateDisplay, wrapDisplay } from '../../render/cjk.js';

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
  hfEndpoint?: string;
  hostCanSearch?: boolean;
  providers?: Array<{ id: string; label?: string; name?: string }>;
  otherTools?: Array<{ name: string }>;
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

interface RetrievalCoverageShape {
  indexed: string[];
  stale: string[];
  missing: string[];
  skipped?: string[];
  reset?: string[];
  hasIndex: boolean;
  canIndex: boolean;
  building: boolean | Record<string, unknown> | null;
}

interface RetrievalIndexPlanShape {
  course?: string;
  pages: number;
  toIndex: number;
  unchanged: number;
  skipped: number;
  toRemove: number;
  chars: number;
  firstRun: boolean;
  modelMb: number;
  canIndex: boolean;
  documents?: number;
  missing?: Array<{ title: string; pages: number }>;
  missingDocuments?: number;
}

interface RetrievalTestResultShape {
  ok: boolean;
  reason?: string;
  provider?: string;
  hits?: number;
  matched?: number;
  unresolved?: number;
  sample?: Array<{ title?: string; sourceId?: string; snippet?: string }>;
  message?: string;
}

interface RetrievalPreviewPageShape {
  sourceId?: string;
  title?: string;
  page?: number;
  score?: number;
  snippet?: string;
}

interface RetrievalPreviewResultShape {
  provider?: string;
  query?: string;
  hits?: number;
  unresolved?: number;
  truncated?: boolean;
  chars?: number;
  pages?: RetrievalPreviewPageShape[];
}

interface UsageFrequencyStatusShape {
  enabled: boolean;
  paused: boolean;
  hasData: boolean;
  daysWithData: number;
  since: string;
  file?: string;
}

type UsageReportPeriod = 7 | 30 | 'all';

interface UsageReportRowShape {
  key: string;
  name: string | null;
  count: number;
  registered?: boolean;
  tier?: string;
  group?: string | null;
  daysUsed?: number;
  share: number;
}

interface UsageReportObservationShape {
  id: string;
  key: string | null;
  optional?: boolean;
  text: string;
}

interface UsageReportShape {
  period: UsageReportPeriod;
  language: 'zh' | 'en';
  from?: string;
  to?: string;
  summary?: {
    daysWithData?: number;
    interactions?: number;
    distinctControls?: number;
  };
  ranking?: UsageReportRowShape[];
  observations?: UsageReportObservationShape[];
}

interface LibraryContextShape {
  library?: string;
  timeZone?: string;
  today?: string;
  focus?: {
    mode?: string;
    course?: string;
    role?: string;
  };
  counts?: {
    sources?: number;
    decks?: number;
    archivedDecks?: number;
    drafts?: number;
    cards?: number;
  };
  courses?: string[];
  coursesPage?: {
    total?: number;
    offset?: number;
    nextOffset?: number | null;
  };
  areas?: string[];
  learner?: Record<string, unknown>;
}

interface UpdateViewShape {
  current?: string;
  installed?: string;
  latest?: string | null;
  newer?: boolean;
  upgradeAvailable?: boolean;
  publishedAt?: string | null;
  notes?: string;
  url?: string;
  assetName?: string | null;
  checkedAt?: string | null;
  error?: string;
  retryAt?: number | null;
  source?: 'api' | 'fallback';
  autoCheck?: boolean;
  snoozed?: boolean;
  pendingRestart?: string | null;
  restartFailed?: { pending?: string; running?: string; installedAt?: string } | null;
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

function describeRetrievalCoverage(
  coverage: RetrievalCoverageShape | null,
  lang: 'zh' | 'en',
  asciiMode: boolean,
): string {
  if (!coverage) return '';
  const indexedCount = Array.isArray(coverage.indexed) ? coverage.indexed.length : 0;
  const staleCount = Array.isArray(coverage.stale) ? coverage.stale.length : 0;
  const missingCount = Array.isArray(coverage.missing) ? coverage.missing.length : 0;
  const total = indexedCount + staleCount + missingCount;
  const sep = asciiMode ? ', ' : ' · ';
  if (total === 0) {
    return coverage.building
      ? `${t(lang, '无资料', '0 pages')}${sep}${t(lang, '构建中', 'building')}`
      : t(lang, '无资料', '0 pages');
  }
  const parts = [t(lang, `索引 ${indexedCount}/${total}`, `Idx ${indexedCount}/${total}`)];
  if (staleCount > 0) {
    parts.push(t(lang, `过期 ${staleCount}`, `${staleCount} stale`));
  }
  if (coverage.building) {
    parts.push(t(lang, '构建中', 'building'));
  }
  return parts.join(sep);
}

function buildRetrievalProviderChoices(status: RetrievalStatusShape | null): string[] {
  const seen = new Set<string>(['builtin']);
  const out = ['builtin'];
  for (const p of status?.providers ?? []) {
    if (p?.id && !seen.has(p.id)) {
      seen.add(p.id);
      out.push(p.id);
    }
  }
  for (const tool of status?.otherTools ?? []) {
    if (tool?.name) {
      const id = tool.name.startsWith('mcp:') ? tool.name : `mcp:${tool.name}`;
      if (!seen.has(id)) {
        seen.add(id);
        out.push(id);
      }
    }
  }
  return out;
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

export { atomicWriteJsonFile, atomicWriteTextFile };

export function defaultBackupPath(libraryRoot: string): string {
  return defaultBackupFilePath(libraryRoot, 'studyhub-backup', 'json');
}

export function resolveBackupPath(raw: string, baseDir: string): string {
  const cleaned = cleanPathInput(raw);
  if (!cleaned) return '';
  const base = baseDir && baseDir.trim() ? resolve(baseDir) : resolve(process.cwd());
  const backupsRoot = resolve(base, 'backups');
  // If pre-filled with an absolute path already strictly inside <baseDir>/backups/, normalize to relative.
  if (isAbsolute(cleaned)) {
    const resolvedInput = resolve(cleaned);
    const rel = relative(backupsRoot, resolvedInput);
    if (rel && rel !== '.' && !rel.startsWith('..') && !isAbsolute(rel)) {
      return resolveSafeBackupExportPath(base, rel, 'studyhub-backup', '.json');
    }
  }
  return resolveSafeBackupExportPath(base, cleaned, 'studyhub-backup', '.json');
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

type RetrievalDiagSubMode = 'summary' | 'preview-input' | 'endpoint-input';

interface RetrievalDiagModalProps {
  lang: 'zh' | 'en';
  asciiMode: boolean;
  ell: string;
  width: number;
  isActive: boolean;
  loading: boolean;
  providerFallback: string;
  hfEndpoint: string;
  plan: RetrievalIndexPlanShape | null;
  testResult: RetrievalTestResultShape | null;
  error: string | null;
  onRefresh: () => void;
  onPreview: (query: string) => Promise<{ ok: boolean; value?: RetrievalPreviewResultShape; error?: string }>;
  onSaveEndpoint: (endpoint: string) => Promise<{ ok: boolean; error?: string }>;
  onClose: () => void;
}

const RetrievalDiagModal = memo(function RetrievalDiagModal({
  lang,
  asciiMode,
  ell,
  width,
  isActive,
  loading,
  providerFallback,
  hfEndpoint,
  plan,
  testResult,
  error,
  onRefresh,
  onPreview,
  onSaveEndpoint,
  onClose,
}: RetrievalDiagModalProps) {
  const theme = useTheme();
  const contentW = modalContentWidth(width);
  const sep = asciiMode ? ' | ' : ' · ';
  const activeProvider = testResult?.provider || providerFallback || 'builtin';
  const [subMode, setSubMode] = useState<RetrievalDiagSubMode>('summary');
  const [previewQuery, setPreviewQuery] = useState('');
  const [previewResult, setPreviewResult] = useState<RetrievalPreviewResultShape | null>(null);
  const [endpointDraft, setEndpointDraft] = useState('');
  const [subBusy, setSubBusy] = useState(false);
  const [subError, setSubError] = useState<string | null>(null);

  const handleSubmitPreview = useCallback(
    async (raw: string) => {
      if (subBusy) return;
      const trimmed = raw.trim();
      setSubBusy(true);
      setSubError(null);
      try {
        const res = await onPreview(trimmed);
        if (!res.ok || !res.value) {
          if (res.error) setSubError(res.error);
          return;
        }
        setPreviewResult(res.value);
        setSubMode('summary');
      } finally {
        setSubBusy(false);
      }
    },
    [onPreview, subBusy],
  );

  const handleSubmitEndpoint = useCallback(
    async (raw: string) => {
      if (subBusy) return;
      setSubBusy(true);
      setSubError(null);
      try {
        const res = await onSaveEndpoint(raw.trim());
        if (!res.ok) {
          if (res.error) setSubError(res.error);
          return;
        }
        setSubMode('summary');
      } finally {
        setSubBusy(false);
      }
    },
    [onSaveEndpoint, subBusy],
  );

  useInput(
    (input, key) => {
      if (key.escape || input === 'q') {
        onClose();
        return true;
      }
      if (subBusy) return;
      if (input === 's') {
        setSubError(null);
        setSubMode('preview-input');
        return;
      }
      if (input === 'm') {
        setSubError(null);
        setEndpointDraft(hfEndpoint);
        setSubMode('endpoint-input');
        return;
      }
      if (input === 'r') {
        onRefresh();
      }
    },
    { isActive: isActive && subMode === 'summary' },
  );

  let verdictBadge: { label: string; tone: 'info' | 'success' | 'warning' | 'muted' } | null = null;
  let verdictDetail = '';
  if (testResult) {
    if (testResult.reason === 'builtin') {
      verdictBadge = {
        label: t(lang, '内置词法检索 (builtin)', 'Built-in lexical search (builtin)'),
        tone: 'info',
      };
      verdictDetail = t(
        lang,
        '使用本地词法检索，无需外部检索服务。',
        'No external search server required; using local lexical search.',
      );
    } else if (testResult.ok) {
      verdictBadge = {
        label: t(lang, `已连通 (${activeProvider})`, `Connected (${activeProvider})`),
        tone: 'success',
      };
      verdictDetail = `hits=${testResult.hits ?? 0}${sep}matched=${testResult.matched ?? 0}${sep}unresolved=${testResult.unresolved ?? 0}`;
    } else {
      verdictBadge = {
        label: t(lang, `连接失败 (${activeProvider})`, `Failed (${activeProvider})`),
        tone: 'warning',
      };
      verdictDetail = testResult.message ? truncateDisplay(testResult.message, contentW, ell) : '';
    }
  }

  const previewPages = Array.isArray(previewResult?.pages) ? previewResult.pages.slice(0, 4) : [];
  const modalHints =
    subMode === 'preview-input'
      ? [
          { key: 'Enter', label: t(lang, '搜索', 'Search') },
          { key: 'Esc', label: t(lang, '返回', 'Back') },
        ]
      : subMode === 'endpoint-input'
        ? [
            { key: 'Enter', label: t(lang, '保存', 'Save') },
            { key: 'Esc', label: t(lang, '返回', 'Back') },
          ]
        : [
            { key: 's', label: t(lang, '试搜', 'Search') },
            { key: 'm', label: t(lang, '镜像源', 'Mirror') },
            { key: 'r', label: t(lang, '刷新', 'Refresh') },
            { key: 'Esc/q', label: t(lang, '关闭', 'Close') },
          ];

  const handleModalClose = useCallback(() => {
    if (subMode === 'summary') {
      onClose();
      return;
    }
    setSubError(null);
    setSubMode('summary');
  }, [onClose, subMode]);

  return (
    <Modal
      title={t(lang, '语义检索诊断与索引计划', 'Retrieval Diagnostics & Index Plan')}
      subtitle={activeProvider}
      width={width}
      onClose={handleModalClose}
      isActive={isActive}
      hints={modalHints}
    >
      {subMode === 'preview-input' ? (
        <Box flexDirection="column" gap={0}>
          <Text color={theme.muted}>
            {t(
              lang,
              '输入本地混合检索试搜主题（0 模型开销，支持词法+目录树）：',
              'Enter topic for local hybrid search preview (0 LLM tokens):',
            )}
          </Text>
          <Box marginTop={1}>
            <TextInput
              value={previewQuery}
              onChange={setPreviewQuery}
              onSubmit={(v) => void handleSubmitPreview(v)}
              onCancel={() => {
                setSubError(null);
                setSubMode('summary');
              }}
              width={Math.max(12, contentW - 4)}
              isActive={isActive && !subBusy}
              prompt={asciiMode ? '>' : '›'}
              placeholder={t(lang, `输入关键词${ell}`, `Enter search topic${ell}`)}
            />
          </Box>
          {subError ? (
            <Box marginTop={1}>
              <Text color={theme.error} wrap="wrap">{subError}</Text>
            </Box>
          ) : null}
          {subBusy ? (
            <Box marginTop={1}>
              <Spinner label={t(lang, `正在执行本地试搜${ell}`, `Running local search preview${ell}`)} active={isActive} />
            </Box>
          ) : null}
        </Box>
      ) : subMode === 'endpoint-input' ? (
        <Box flexDirection="column" gap={0}>
          <Text color={theme.muted}>
            {t(
              lang,
              '设置模型下载镜像地址 (HF_ENDPOINT，留空恢复默认 HuggingFace)：',
              'Set HuggingFace mirror endpoint (leave empty for default):',
            )}
          </Text>
          <Box marginTop={1}>
            <TextInput
              value={endpointDraft}
              onChange={setEndpointDraft}
              onSubmit={(v) => void handleSubmitEndpoint(v)}
              onCancel={() => {
                setSubError(null);
                setSubMode('summary');
              }}
              width={Math.max(12, contentW - 4)}
              isActive={isActive && !subBusy}
              prompt={asciiMode ? '>' : '›'}
              placeholder={t(lang, 'https://hf-mirror.com (留空恢复默认)', 'https://hf-mirror.com (empty resets to default)')}
            />
          </Box>
          {subError ? (
            <Box marginTop={1}>
              <Text color={theme.error} wrap="wrap">{subError}</Text>
            </Box>
          ) : null}
          {subBusy ? (
            <Box marginTop={1}>
              <Spinner label={t(lang, `正在保存镜像源${ell}`, `Saving HF mirror endpoint${ell}`)} active={isActive} />
            </Box>
          ) : null}
        </Box>
      ) : loading && !testResult && !plan ? (
        <Spinner label={t(lang, `正在诊断语义检索${ell}`, `Running retrieval diagnostics${ell}`)} active={isActive} />
      ) : (
        <Box flexDirection="column" gap={0}>
          <Box flexDirection="row" gap={1}>
            <Text color={theme.muted}>{t(lang, '连通状态:', 'Status:')}</Text>
            {verdictBadge ? (
              <Badge label={verdictBadge.label} tone={verdictBadge.tone} variant="soft" />
            ) : (
              <Badge label={t(lang, '未返回', 'No result')} tone="muted" variant="soft" />
            )}
          </Box>
          {verdictDetail ? (
            <Text color={testResult?.ok === false && testResult?.reason !== 'builtin' ? theme.warning : theme.dim}>
              {truncateDisplay(verdictDetail, contentW, ell)}
            </Text>
          ) : null}
          <Text color={theme.muted}>
            {truncateDisplay(
              t(lang, `模型镜像: ${hfEndpoint || '默认 (HuggingFace)'}`, `HF Endpoint: ${hfEndpoint || 'Default'}`),
              contentW,
              ell,
            )}
          </Text>

          {plan ? (
            <Box flexDirection="column" marginTop={1}>
              <Box flexDirection="row" gap={1}>
                <Text color={theme.muted}>
                  {t(lang, '索引计划:', 'Index Plan:')}
                  {plan.course ? ` (${plan.course})` : ''}
                </Text>
                <Badge
                  label={plan.canIndex ? t(lang, '可构建索引', 'Can Index') : t(lang, '不可构建', 'Cannot Index')}
                  tone={plan.canIndex ? 'success' : 'muted'}
                  variant="soft"
                />
              </Box>
              <Text color={theme.text}>
                {truncateDisplay(
                  t(
                    lang,
                    `总页数 ${plan.pages}${sep}待索引 ${plan.toIndex}${sep}未变更 ${plan.unchanged}`,
                    `Pages ${plan.pages}${sep}To Index ${plan.toIndex}${sep}Unchanged ${plan.unchanged}`,
                  ),
                  contentW,
                  ell,
                )}
              </Text>
              <Text color={theme.muted}>
                {truncateDisplay(
                  t(
                    lang,
                    `跳过 ${plan.skipped}${sep}待移除 ${plan.toRemove}${sep}字符 ${plan.chars.toLocaleString('en-US')}`,
                    `Skipped ${plan.skipped}${sep}Remove ${plan.toRemove}${sep}Chars ${plan.chars.toLocaleString('en-US')}`,
                  ),
                  contentW,
                  ell,
                )}
              </Text>
              <Text color={plan.firstRun ? theme.accent : theme.dim}>
                {truncateDisplay(
                  plan.firstRun
                    ? t(lang, `首次构建模型下载约 ${plan.modelMb} MB`, `First-run model download ~${plan.modelMb} MB`)
                    : t(lang, `模型缓存已就绪 (~${plan.modelMb} MB)`, `Model cache ready (~${plan.modelMb} MB)`),
                  contentW,
                  ell,
                )}
              </Text>
            </Box>
          ) : null}

          {previewResult ? (
            <Box flexDirection="column" marginTop={1}>
              <Text color={theme.accent}>
                {truncateDisplay(
                  t(
                    lang,
                    `试搜命中 ${previewResult.hits ?? previewPages.length}: ${previewResult.query || ''}`,
                    `Search Preview (${previewResult.hits ?? previewPages.length} hits): ${previewResult.query || ''}`,
                  ),
                  contentW,
                  ell,
                )}
              </Text>
              {previewPages.length === 0 ? (
                <Text color={theme.muted}>
                  {truncateDisplay(
                    t(lang, '未找到匹配页面，请换个关键词重试。', 'No matching pages found; try different keywords.'),
                    contentW,
                    ell,
                  )}
                </Text>
              ) : (
                previewPages.map((pg, idx) => {
                  const rawTitle = pg.title || pg.sourceId || t(lang, '未命名资料', 'Untitled');
                  const titleText = asciiMode ? normalizeAsciiChrome(rawTitle, true) : rawTitle;
                  const pageLabel = typeof pg.page === 'number' ? `p.${pg.page}` : '';
                  const headRaw = pageLabel ? `${titleText} (${pageLabel})` : titleText;
                  const rawSnippet = pg.snippet ? String(pg.snippet).replace(/\s+/g, ' ').trim() : '';
                  const snippetText = asciiMode ? normalizeAsciiChrome(rawSnippet, true) : rawSnippet;
                  const head = snippetText
                    ? truncateDisplay(headRaw, Math.max(14, Math.floor(contentW * 0.45)), ell)
                    : truncateDisplay(headRaw, contentW, ell);
                  const rowText = snippetText ? `${head}${sep}${snippetText}` : head;
                  return (
                    <Text key={`${pg.sourceId || idx}-${idx}`} color={theme.text}>
                      {truncateDisplay(rowText, contentW, ell)}
                    </Text>
                  );
                })
              )}
            </Box>
          ) : null}

          {error || subError ? (
            <Box marginTop={1}>
              <Text color={theme.error} wrap="wrap">{error || subError || ''}</Text>
            </Box>
          ) : null}

          {loading ? (
            <Box marginTop={1}>
              <Spinner label={t(lang, `正在刷新诊断${ell}`, `Refreshing diagnostics${ell}`)} active={isActive} />
            </Box>
          ) : null}
        </Box>
      )}
    </Modal>
  );
});

function describeUpdateStatusBadge(
  info: UpdateViewShape | null,
  loading: boolean,
  error: string | null,
  lang: 'zh' | 'en',
  asciiMode: boolean,
): { label: string; tone: 'success' | 'warning' | 'accent' | 'muted' } {
  if (!info) {
    if (error) return { label: t(lang, '检查失败', 'Check failed'), tone: 'warning' };
    return {
      label: loading ? t(lang, '检查中', 'Checking') : t(lang, '未检查', 'Not checked'),
      tone: 'muted',
    };
  }
  if (info.pendingRestart) {
    return { label: t(lang, '需重启生效', 'Restart pending'), tone: 'accent' };
  }
  if (info.error) {
    if (info.error === 'network') {
      return { label: t(lang, '离线 / 网络不可用', 'Offline / Network error'), tone: 'warning' };
    }
    if (info.error === 'rate-limited') {
      return { label: t(lang, '请求受限 (Rate Limit)', 'Rate limited'), tone: 'warning' };
    }
    return { label: t(lang, `检查受限 (${info.error})`, `Check warning (${info.error})`), tone: 'warning' };
  }
  if (info.newer && info.snoozed) {
    return { label: t(lang, '已推迟提醒', 'Snoozed'), tone: 'muted' };
  }
  if (info.newer) {
    return { label: t(lang, '发现新版本', 'Update available'), tone: 'success' };
  }
  return {
    label: asciiMode ? t(lang, '已是最新 +', 'Up to date +') : t(lang, '已是最新 ✓', 'Up to date ✓'),
    tone: 'success',
  };
}

interface ReleaseUpdateModalProps {
  lang: 'zh' | 'en';
  asciiMode: boolean;
  ell: string;
  width: number;
  isActive: boolean;
  loading: boolean;
  snoozeBusy: boolean;
  info: UpdateViewShape | null;
  error: string | null;
  onRefresh: () => void;
  onToggleSnooze: () => void;
  onClose: () => void;
}

const ReleaseUpdateModal = memo(function ReleaseUpdateModal({
  lang,
  asciiMode,
  ell,
  width,
  isActive,
  loading,
  snoozeBusy,
  info,
  error,
  onRefresh,
  onToggleSnooze,
  onClose,
}: ReleaseUpdateModalProps) {
  const theme = useTheme();
  const contentW = modalContentWidth(width);
  const sep = asciiMode ? ' | ' : ' · ';

  useInput(
    (input, key) => {
      if (key.escape || input === 'q') {
        onClose();
        return true;
      }
      if (input === 'r') {
        onRefresh();
        return;
      }
      if (input === 'z' && info?.latest && info?.newer && !snoozeBusy) {
        onToggleSnooze();
      }
    },
    { isActive },
  );

  const statusBadge = describeUpdateStatusBadge(info, loading, error, lang, asciiMode);
  const currentText = info?.current ? `v${info.current}` : '-';
  const latestText = info?.latest ? `v${info.latest}` : '-';
  const publishedDate = info?.publishedAt ? info.publishedAt.slice(0, 10) : '-';
  const releaseUrl = info?.url || '-';
  const rawNotes = typeof info?.notes === 'string' ? info.notes.replace(/\r\n?/g, '\n').trim() : '';
  const sanitizedNotes = rawNotes ? normalizeAsciiChrome(rawNotes, asciiMode) : '';
  const noteLines = sanitizedNotes
    ? wrapDisplay(sanitizedNotes, contentW)
        .map((line) => line.trimEnd())
        .filter((line) => line.length > 0)
        .slice(0, 4)
    : [];

  const modalHints = [
    ...(info?.latest && info?.newer
      ? [{ key: 'z', label: info.snoozed ? t(lang, '取消推迟', 'Unsnooze') : t(lang, '推迟提醒', 'Snooze') }]
      : []),
    { key: 'r', label: t(lang, '重新检查', 'Recheck') },
    { key: 'Esc/q', label: t(lang, '关闭', 'Close') },
  ];

  return (
    <Modal
      title={t(lang, '检查版本更新', 'Release Update Check')}
      subtitle={info?.current ? `v${info.current}` : undefined}
      width={width}
      onClose={onClose}
      isActive={isActive}
      hints={modalHints}
    >
      {loading && !info ? (
        <Spinner label={t(lang, `正在检查最新版本${ell}`, `Checking latest release${ell}`)} active={isActive} />
      ) : (
        <Box flexDirection="column" gap={0}>
          <Box flexDirection="row" gap={1}>
            <Text color={theme.muted}>{t(lang, '当前:', 'Current:')}</Text>
            <Text color={theme.text} bold>
              {currentText}
            </Text>
            <Text color={theme.muted}>{t(lang, '最新:', 'Latest:')}</Text>
            <Text color={info?.newer ? theme.accent : theme.text} bold>
              {latestText}
            </Text>
            <Badge label={statusBadge.label} tone={statusBadge.tone} variant="soft" />
          </Box>
          <Text color={theme.muted}>
            {truncateDisplay(
              `${t(lang, '发布日期:', 'Published:')} ${publishedDate}${sep}${t(lang, '自动检查:', 'Auto:')} ${
                info?.autoCheck === false ? t(lang, '关', 'Off') : t(lang, '开', 'On')
              }`,
              contentW,
              ell,
            )}
          </Text>
          <Text color={theme.dim}>{truncateDisplay(`${t(lang, '发布页:', 'URL:')} ${releaseUrl}`, contentW, ell)}</Text>

          {info?.pendingRestart ? (
            <Text color={theme.accent}>
              {truncateDisplay(
                t(lang, `新版本 v${info.pendingRestart} 已安装，重启后生效。`, `v${info.pendingRestart} is installed; restart to activate.`),
                contentW,
                ell,
              )}
            </Text>
          ) : null}

          {info?.error ? (
            <Text color={theme.warning}>
              {truncateDisplay(
                info.error === 'network'
                  ? t(lang, '网络不可达或处于离线状态；稍后可按 [r] 重试。', 'Offline or network unreachable; press [r] to retry later.')
                  : t(lang, `检查返回异常 (${info.error})；稍后可按 [r] 重试。`, `Check warning (${info.error}); press [r] to retry later.`),
                contentW,
                ell,
              )}
            </Text>
          ) : null}

          {error ? (
            <Text color={theme.error} wrap="wrap">{normalizeAsciiChrome(error, asciiMode)}</Text>
          ) : null}

          {noteLines.length > 0 ? (
            <Box flexDirection="column" marginTop={1}>
              <Text color={theme.muted} bold>
                {t(lang, '更新说明:', 'Release Notes:')}
              </Text>
              {noteLines.map((line, idx) => (
                <Text key={`note-${idx}`} color={theme.text}>
                  {truncateDisplay(line, contentW, ell)}
                </Text>
              ))}
            </Box>
          ) : null}

          {loading ? (
            <Box marginTop={1}>
              <Spinner label={t(lang, `正在重新检查${ell}`, `Rechecking${ell}`)} active={isActive} />
            </Box>
          ) : null}
        </Box>
      )}
    </Modal>
  );
});

function describeUsageReportState(
  status: UsageFrequencyStatusShape | null,
  lang: 'zh' | 'en',
): { label: string; tone: 'success' | 'warning' | 'muted' } {
  if (status?.enabled && status?.paused) {
    return { label: t(lang, '已暂停', 'Paused'), tone: 'warning' };
  }
  if (status?.enabled) {
    return { label: t(lang, '运行中', 'Active'), tone: 'success' };
  }
  return { label: t(lang, '已关闭', 'Disabled'), tone: 'muted' };
}

interface UsageReportModalProps {
  lang: 'zh' | 'en';
  asciiMode: boolean;
  ell: string;
  width: number;
  isActive: boolean;
  loading: boolean;
  actionBusy: boolean;
  period: UsageReportPeriod;
  usageStatus: UsageFrequencyStatusShape | null;
  report: UsageReportShape | null;
  error: string | null;
  lastExportPath: string | null;
  onSelectPeriod: (period: UsageReportPeriod) => void;
  onTogglePause: () => void;
  onExport: () => void;
  onRefresh: () => void;
  onClose: () => void;
}

const UsageReportModal = memo(function UsageReportModal({
  lang,
  asciiMode,
  ell,
  width,
  isActive,
  loading,
  actionBusy,
  period,
  usageStatus,
  report,
  error,
  lastExportPath,
  onSelectPeriod,
  onTogglePause,
  onExport,
  onRefresh,
  onClose,
}: UsageReportModalProps) {
  const theme = useTheme();
  const contentW = modalContentWidth(width);
  const sep = asciiMode ? ' | ' : ' · ';

  useInput(
    (input, key) => {
      if (key.escape || input === 'q') {
        onClose();
        return true;
      }
      if (input === '1') {
        onSelectPeriod(7);
        return;
      }
      if (input === '2') {
        onSelectPeriod(30);
        return;
      }
      if (input === '3') {
        onSelectPeriod('all');
        return;
      }
      if (input === 'r') {
        onRefresh();
        return;
      }
      if (input === 'p' && usageStatus?.enabled && !actionBusy) {
        onTogglePause();
        return;
      }
      if (input === 'e' && !actionBusy) {
        onExport();
      }
    },
    { isActive },
  );

  const stateBadge = describeUsageReportState(usageStatus, lang);
  const periodLabel =
    period === 7
      ? t(lang, '最近 7 天', 'Last 7d')
      : period === 30
        ? t(lang, '最近 30 天', 'Last 30d')
        : t(lang, '全部时间', 'All time');
  const periodOptions: ReadonlyArray<{ id: UsageReportPeriod; keyLabel: string; text: string }> = [
    { id: 7, keyLabel: '1', text: t(lang, '7天', '7d') },
    { id: 30, keyLabel: '2', text: t(lang, '30天', '30d') },
    { id: 'all', keyLabel: '3', text: t(lang, '全部', 'All') },
  ];

  const interactions = Number(report?.summary?.interactions) || 0;
  const activeDays = Number(report?.summary?.daysWithData) || 0;
  const distinctControls = Number(report?.summary?.distinctControls) || 0;
  const topRows = Array.isArray(report?.ranking) ? report.ranking.slice(0, 5) : [];
  const maxCount = Math.max(1, topRows[0]?.count || 1);
  const fillCh = asciiMode ? '#' : '█';
  const emptyCh = asciiMode ? '-' : '░';
  const barW = 10;

  const rawObs = report?.observations?.[0]?.text
    ? String(report.observations[0].text).replace(/\s+/g, ' ').trim()
    : '';
  const obsNormalized = rawObs ? normalizeAsciiChrome(rawObs, asciiMode) : '';
  const obsLines = obsNormalized
    ? wrapDisplay(obsNormalized, contentW)
        .map((line) => line.trimEnd())
        .filter((line) => line.length > 0)
        .slice(0, 2)
    : [];

  const modalHints = [
    { key: '1-3', label: t(lang, '范围', 'Period') },
    ...(usageStatus?.enabled
      ? [{ key: 'p', label: usageStatus.paused ? t(lang, '继续', 'Resume') : t(lang, '暂停', 'Pause') }]
      : []),
    { key: 'e', label: t(lang, '导出', 'Export') },
    { key: 'r', label: t(lang, '刷新', 'Refresh') },
    { key: 'Esc/q', label: t(lang, '关闭', 'Close') },
  ];

  return (
    <Modal
      title={t(lang, '本地使用频率报表', 'Usage Frequency Report')}
      subtitle={periodLabel}
      width={width}
      onClose={onClose}
      isActive={isActive}
      hints={modalHints}
    >
      {loading && !report ? (
        <Spinner label={t(lang, `正在汇总使用记录${ell}`, `Loading usage report${ell}`)} active={isActive} />
      ) : (
        <Box flexDirection="column" gap={0}>
          <Box flexDirection="row" gap={1}>
            <Text color={theme.muted}>{t(lang, '状态:', 'Status:')}</Text>
            <Badge label={stateBadge.label} tone={stateBadge.tone} variant="soft" />
            <Text color={theme.dim}>{sep.trim()}</Text>
            {periodOptions.map((opt) => (
              <Text
                key={String(opt.id)}
                color={period === opt.id ? theme.accent : theme.muted}
                bold={period === opt.id}
              >
                {`[${opt.keyLabel}] ${opt.text}`}
              </Text>
            ))}
          </Box>

          <Text color={theme.text}>
            {truncateDisplay(
              t(
                lang,
                `互动 ${interactions} 次${sep}活跃 ${activeDays} 天${sep}控件 ${distinctControls} 个`,
                `Interactions: ${interactions}${sep}Active days: ${activeDays}${sep}Controls: ${distinctControls}`,
              ),
              contentW,
              ell,
            )}
          </Text>

          <Box flexDirection="column" marginTop={1}>
            <Text color={theme.muted} bold>
              {t(lang, '最常用控件:', 'Top Controls:')}
            </Text>
            {topRows.length === 0 ? (
              <Text color={theme.dim}>
                {truncateDisplay(
                  t(lang, '（当前周期暂无使用记录）', '(No usage records in this period)'),
                  contentW,
                  ell,
                )}
              </Text>
            ) : (
              topRows.map((row) => {
                const labelText = normalizeAsciiChrome(row.name || row.key, asciiMode);
                const pct = Math.round((Number(row.share) || 0) * 100);
                const stat = `${row.count} (${pct}%)`;
                const filled = row.count > 0 ? Math.max(1, Math.round((row.count / maxCount) * barW)) : 0;
                const bar = `${fillCh.repeat(filled)}${emptyCh.repeat(Math.max(0, barW - filled))}`;
                const nameW = Math.max(10, contentW - barW - displayWidth(stat) - 3);
                const line = `${padDisplay(truncateDisplay(labelText, nameW, ell), nameW)} ${bar} ${stat}`;
                return (
                  <Text key={row.key} color={theme.text}>
                    {truncateDisplay(line, contentW, ell)}
                  </Text>
                );
              })
            )}
          </Box>

          {obsLines.length > 0 ? (
            <Box flexDirection="column" marginTop={1}>
              {obsLines.map((line, idx) => (
                <Text key={`obs-${idx}`} color={theme.dim}>
                  {truncateDisplay(line, contentW, ell)}
                </Text>
              ))}
            </Box>
          ) : null}

          {lastExportPath ? (
            <Text color={theme.success}>
              {(() => {
                const prefix = t(lang, '已导出: ', 'Exported: ');
                const maxPathW = Math.max(10, contentW - displayWidth(prefix));
                return `${prefix}${truncatePathMiddle(lastExportPath, maxPathW, ell)}`;
              })()}
            </Text>
          ) : null}

          {error ? (
            <Text color={theme.error} wrap="wrap">
              {normalizeAsciiChrome(error, asciiMode)}
            </Text>
          ) : null}

          {loading ? (
            <Box marginTop={1}>
              <Spinner label={t(lang, `正在刷新报表${ell}`, `Refreshing report${ell}`)} active={isActive} />
            </Box>
          ) : null}
        </Box>
      )}
    </Modal>
  );
});

interface LibraryContextModalProps {
  lang: 'zh' | 'en';
  asciiMode: boolean;
  ell: string;
  width: number;
  isActive: boolean;
  loading: boolean;
  actionBusy: boolean;
  contextData: LibraryContextShape | null;
  fallbackRoot: string;
  error: string | null;
  lastExportPath: string | null;
  onRefresh: () => void;
  onExport: () => void;
  onClose: () => void;
}

const LibraryContextModal = memo(function LibraryContextModal({
  lang,
  asciiMode,
  ell,
  width,
  isActive,
  loading,
  actionBusy,
  contextData,
  fallbackRoot,
  error,
  lastExportPath,
  onRefresh,
  onExport,
  onClose,
}: LibraryContextModalProps) {
  const theme = useTheme();
  const contentW = modalContentWidth(width);
  const sep = asciiMode ? ' | ' : ' · ';
  const bullet = asciiMode ? '- ' : '• ';

  useInput(
    (input, key) => {
      if (key.escape || input === 'q') {
        onClose();
        return true;
      }
      if (input === 'r') {
        onRefresh();
        return;
      }
      if (input === 'e' && !actionBusy) {
        onExport();
      }
    },
    { isActive },
  );

  const rootText = contextData?.library || fallbackRoot || '-';
  const todayText = contextData?.today || '-';
  const tzText = contextData?.timeZone || '-';
  const focusCourse = contextData?.focus?.course ? normalizeAsciiChrome(contextData.focus.course, asciiMode) : '-';
  const focusRole = contextData?.focus?.role ? normalizeAsciiChrome(contextData.focus.role, asciiMode) : '-';
  const sourcesCount = Number(contextData?.counts?.sources) || 0;
  const decksCount = Number(contextData?.counts?.decks) || 0;
  const archivedDecksCount = Number(contextData?.counts?.archivedDecks) || 0;
  const draftsCount = Number(contextData?.counts?.drafts) || 0;
  const cardsCount = Number(contextData?.counts?.cards) || 0;
  const allCourses = Array.isArray(contextData?.courses) ? contextData.courses : [];
  const totalCourses = Number(contextData?.coursesPage?.total ?? allCourses.length) || 0;
  const shownCourses = allCourses.slice(0, 4);
  const extraCourses = Math.max(0, totalCourses - shownCourses.length);
  const areasList = Array.isArray(contextData?.areas) ? contextData.areas : [];
  const areasText = areasList.length > 0 ? areasList.join(', ') : '-';

  const rootPrefix = t(lang, '学习库: ', 'Library: ');
  const rootMaxW = Math.max(10, contentW - displayWidth(rootPrefix));

  const modalHints = [
    { key: 'e', label: t(lang, '导出 JSON', 'Export JSON') },
    { key: 'r', label: t(lang, '刷新', 'Refresh') },
    { key: 'Esc/q', label: t(lang, '关闭', 'Close') },
  ];

  return (
    <Modal
      title={t(lang, '学习库上下文总览', 'Library Context Overview')}
      subtitle={contextData?.today || undefined}
      width={width}
      onClose={onClose}
      isActive={isActive}
      hints={modalHints}
    >
      {loading && !contextData ? (
        <Spinner label={t(lang, `正在读取学习库上下文${ell}`, `Loading library context${ell}`)} active={isActive} />
      ) : (
        <Box flexDirection="column" gap={0}>
          <Text color={theme.primary} bold>
            {`${rootPrefix}${truncatePathMiddle(rootText, rootMaxW, ell)}`}
          </Text>
          <Text color={theme.muted}>
            {truncateDisplay(
              t(lang, `日期: ${todayText}${sep}时区: ${tzText}`, `Date: ${todayText}${sep}TimeZone: ${tzText}`),
              contentW,
              ell,
            )}
          </Text>
          <Text color={theme.text}>
            {truncateDisplay(
              t(
                lang,
                `当前焦点: ${focusCourse}${sep}角色: ${focusRole}`,
                `Focus: ${focusCourse}${sep}Role: ${focusRole}`,
              ),
              contentW,
              ell,
            )}
          </Text>
          <Text color={theme.text}>
            {truncateDisplay(
              t(
                lang,
                `资料 ${sourcesCount}${sep}题组 ${decksCount} (+${archivedDecksCount} 归档)${sep}草稿 ${draftsCount}${sep}卡片 ${cardsCount}`,
                `Sources ${sourcesCount}${sep}Decks ${decksCount} (+${archivedDecksCount} archived)${sep}Drafts ${draftsCount}${sep}Cards ${cardsCount}`,
              ),
              contentW,
              ell,
            )}
          </Text>

          <Box flexDirection="column" marginTop={1}>
            <Text color={theme.muted} bold>
              {t(lang, `课程分布 (${totalCourses}):`, `Courses (${totalCourses}):`)}
            </Text>
            {shownCourses.length === 0 ? (
              <Text color={theme.dim}>
                {truncateDisplay(t(lang, '（暂无课程）', '(No courses)'), contentW, ell)}
              </Text>
            ) : (
              shownCourses.map((courseName, idx) => {
                const label = courseName
                  ? normalizeAsciiChrome(courseName, asciiMode)
                  : t(lang, '(未分类)', '(Uncategorized)');
                return (
                  <Text key={`${courseName}-${idx}`} color={theme.text}>
                    {truncateDisplay(`${bullet}${label}`, contentW, ell)}
                  </Text>
                );
              })
            )}
            {extraCourses > 0 ? (
              <Text color={theme.dim}>
                {truncateDisplay(t(lang, `+${extraCourses} 更多课程`, `+${extraCourses} more`), contentW, ell)}
              </Text>
            ) : null}
          </Box>

          <Box marginTop={1}>
            <Text color={theme.muted}>
              {truncateDisplay(
                t(lang, `可用上下文域: ${areasText}`, `Areas: ${areasText}`),
                contentW,
                ell,
              )}
            </Text>
          </Box>

          {lastExportPath ? (
            <Text color={theme.success}>
              {(() => {
                const prefix = t(lang, '已导出: ', 'Exported: ');
                const maxPathW = Math.max(10, contentW - displayWidth(prefix));
                return `${prefix}${truncatePathMiddle(lastExportPath, maxPathW, ell)}`;
              })()}
            </Text>
          ) : null}

          {error ? (
            <Text color={theme.error} wrap="wrap">
              {normalizeAsciiChrome(error, asciiMode)}
            </Text>
          ) : null}

          {loading ? (
            <Box marginTop={1}>
              <Spinner label={t(lang, `正在刷新上下文${ell}`, `Refreshing context${ell}`)} active={isActive} />
            </Box>
          ) : null}
        </Box>
      )}
    </Modal>
  );
});

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

  const handleExportBackup = useCallback(
    async (raw: string) => {
      if (busyAction) return;
      const baseDir = binding?.root || host.getLibraryRoot() || process.cwd();
      setExportingBackup(false);
      let targetPath = '';
      try {
        targetPath = resolveBackupPath(raw, baseDir);
      } catch (err) {
        if (!mountedRef.current) return;
        const msg = err instanceof Error ? err.message : String(err);
        notify(t(lang, `导出备份失败：${msg}`, `Export failed: ${msg}`), 'error');
        return;
      }
      if (!targetPath) return;
      setBusyAction(t(lang, `导出学习库备份${ell}`, `Exporting library backup${ell}`));
      try {
        const res = await tryAction<Record<string, unknown>>(host, 'export', {});
        if (!mountedRef.current) return;
        if (!res.ok || !res.value) {
          notify(res.error?.message || t(lang, '导出学习库备份失败', 'Failed to export library backup'), 'error');
          return;
        }
        const written = await atomicWriteExportJson(targetPath, res.value);
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
            `已导出备份 (${formatBytes(written.bytes)}, ${decksCount} 牌组, ${cardsCount} 卡片) ${arrow} ${written.path}${refSuffix}`,
            `Exported backup (${formatBytes(written.bytes)}, ${decksCount} decks, ${cardsCount} cards) ${arrow} ${written.path}${refSuffix}`,
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
    [asciiMode, binding?.root, busyAction, ell, host, lang, notify],
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

  const modalOpen =
    editingRoot ||
    exportingBackup ||
    confirmSampleRemove ||
    Boolean(confirmRestore) ||
    confirmClearUsage ||
    retrievalDiagOpen ||
    updateModalOpen ||
    usageReportOpen ||
    libraryCtxOpen;
  const claimed = useMemo(() => ['e', 's', 'x', 'c', 'f', 'u', 'U', 'a', 'A', 'v', 't', 'i', 'L'], []);
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
      if (input === 'L') {
        if (busyAction) return;
        setLibraryCtxExportPath(null);
        setLibraryCtxError(null);
        setLibraryCtxOpen(true);
        void loadLibraryContext();
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
      if (input === 'i') {
        if (busyAction) return;
        setUsageReportExportPath(null);
        setUsageReportError(null);
        setUsageReportOpen(true);
        void loadUsageReport(usageReportPeriod);
        return;
      }
      if (input === 'a') {
        void handleToggleAutoCheck();
        return;
      }
      if (input === 'A') {
        if (busyAction) return;
        setUpdateModalOpen(true);
        void runUpdateCheck();
        return;
      }
      if (input === 'v') {
        void handleCycleRetrievalProvider();
        return;
      }
      if (input === 't') {
        if (busyAction) return;
        setRetrievalDiagOpen(true);
        void runRetrievalDiag();
        return;
      }
      if (key.ctrl && input === 'r') {
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
  const retrievalCoverageLabel = describeRetrievalCoverage(retrievalCoverage, lang, asciiMode);
  const retrievalSwitchLabel = `[v] ${t(lang, '切换', 'Switch')}`;
  const retrievalDiagLabel = `[t] ${t(lang, '诊断', 'Diag')}`;
  const usageBadge = describeUsageBadge(usageStatus, usageLoaded, lang, asciiMode);
  const usageToggleLabel = `[u] ${t(lang, '切换', 'Toggle')}`;
  const usageClearLabel = `[U] ${t(lang, '清空记录', 'Clear data')}`;
  const autoUpdateBadge = describeAutoUpdateBadge(autoCheckEnabled, updateLoaded, lang, asciiMode);
  const autoUpdateToggleLabel = `[a] ${t(lang, '切换', 'Toggle')}`;
  const contextActionLabel = `[L] ${t(lang, '上下文', 'Context')}`;

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
        <Box flexDirection="row" gap={2} marginTop={0} height={1} overflow="hidden">
          <Text color={theme.muted}>
            {t(lang, '实验性功能:', 'Experimental Features:')}{' '}
            <Badge
              label={experimentalBadgeLabel}
              tone={experimentalEnabled ? 'accent' : 'muted'}
              variant="soft"
            />
          </Text>
          <Text color={theme.accent}>{experimentalActionLabel}</Text>
        </Box>
        <Box flexDirection="row" gap={compactLayout ? 1 : 2} marginTop={0} height={1} overflow="hidden">
          <Text color={theme.muted}>
            {t(lang, '语义检索:', 'Retrieval:')}{' '}
            <Badge label={retrievalBadge.label} tone={retrievalBadge.tone} variant="soft" />
          </Text>
          {retrievalCoverageLabel ? <Text color={theme.dim}>{retrievalCoverageLabel}</Text> : null}
          <Text color={theme.accent}>{retrievalSwitchLabel}</Text>
          <Text color={theme.accent}>{retrievalDiagLabel}</Text>
        </Box>
        <Box flexDirection="row" gap={compactLayout ? 1 : 2} marginTop={0} height={1} overflow="hidden">
          <Text color={theme.muted}>
            {t(lang, '使用频率记录:', 'Usage Frequency:')}{' '}
            <Badge label={usageBadge.label} tone={usageBadge.tone} variant="soft" />
          </Text>
          <Text color={theme.accent}>{usageToggleLabel}</Text>
          <Text color={theme.accent}>[i] {t(lang, '报表', 'Report')}</Text>
          <Text color={theme.warning}>{usageClearLabel}</Text>
        </Box>
        <Box flexDirection="row" gap={compactLayout ? 1 : 2} marginTop={0} height={1} overflow="hidden">
          <Text color={theme.muted}>
            {t(lang, '自动检查更新:', 'Auto Update:')}{' '}
            <Badge label={autoUpdateBadge.label} tone={autoUpdateBadge.tone} variant="soft" />
          </Text>
          <Text color={theme.accent}>{autoUpdateToggleLabel}</Text>
          <Text color={theme.accent}>[A] {t(lang, '检查更新', 'Check now')}</Text>
        </Box>
        {compactLayout ? (
          <>
            <Box flexDirection="row" gap={2} marginTop={0} height={1} overflow="hidden">
              <Text color={theme.accent}>{`[e] ${t(lang, '更改文件夹路径', 'Change folder')}`}</Text>
              <Text color={theme.accent}>{sampleActionLabel}</Text>
            </Box>
            <Box flexDirection="row" gap={2} height={1} overflow="hidden">
              <Text color={theme.accent}>{exportActionLabel}</Text>
              <Text color={theme.accent}>{contextActionLabel}</Text>
              {!confirmed ? <Text color={theme.warning}>{confirmActionLabel}</Text> : null}
            </Box>
          </>
        ) : (
          <Box flexDirection="row" gap={width < 92 ? 1 : 2} marginTop={0} height={1} overflow="hidden">
            <Text color={theme.accent}>{`[e] ${t(lang, '更改文件夹路径', 'Change folder')}`}</Text>
            <Text color={theme.accent}>{sampleActionLabel}</Text>
            <Text color={theme.accent}>{exportActionLabel}</Text>
            <Text color={theme.accent}>{contextActionLabel}</Text>
            {!confirmed ? <Text color={theme.warning}>{confirmActionLabel}</Text> : null}
          </Box>
        )}
      </Panel>

      <Panel
        title={t(lang, '学习库自动备份点 (Enter 恢复)', 'Library Restore Points (Enter to Restore)')}
        badge={restorePoints.length}
        subtitle={loadingPoints ? t(lang, `加载中${ell}`, `Loading${ell}`) : t(lang, '[Ctrl+R] 刷新', '[Ctrl+R] Refresh')}
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

      {retrievalDiagOpen ? (
        <RetrievalDiagModal
          lang={lang}
          asciiMode={asciiMode}
          ell={ell}
          width={modalW}
          isActive={isActive}
          loading={retrievalDiagLoading}
          providerFallback={retrievalStatus?.effective || retrievalStatus?.selected || 'builtin'}
          hfEndpoint={retrievalStatus?.hfEndpoint ?? ''}
          plan={retrievalPlan}
          testResult={retrievalTest}
          error={retrievalDiagError}
          onRefresh={() => void runRetrievalDiag()}
          onPreview={handleRetrievalPreview}
          onSaveEndpoint={handleSaveHfEndpoint}
          onClose={() => setRetrievalDiagOpen(false)}
        />
      ) : null}

      {updateModalOpen ? (
        <ReleaseUpdateModal
          lang={lang}
          asciiMode={asciiMode}
          ell={ell}
          width={modalW}
          isActive={isActive}
          loading={updateCheckLoading}
          snoozeBusy={updateSnoozeBusy}
          info={updateInfo}
          error={updateError}
          onRefresh={() => void runUpdateCheck()}
          onToggleSnooze={() => void handleToggleSnooze()}
          onClose={() => setUpdateModalOpen(false)}
        />
      ) : null}

      {usageReportOpen ? (
        <UsageReportModal
          lang={lang}
          asciiMode={asciiMode}
          ell={ell}
          width={modalW}
          isActive={isActive}
          loading={usageReportLoading}
          actionBusy={usageReportActionBusy}
          period={usageReportPeriod}
          usageStatus={usageStatus}
          report={usageReport}
          error={usageReportError}
          lastExportPath={usageReportExportPath}
          onSelectPeriod={handleSelectUsagePeriod}
          onTogglePause={() => void handleToggleUsagePause()}
          onExport={() => void handleExportUsageReport()}
          onRefresh={() => void loadUsageReport(usageReportPeriod)}
          onClose={() => setUsageReportOpen(false)}
        />
      ) : null}

      {libraryCtxOpen ? (
        <LibraryContextModal
          lang={lang}
          asciiMode={asciiMode}
          ell={ell}
          width={modalW}
          isActive={isActive}
          loading={libraryCtxLoading}
          actionBusy={libraryCtxActionBusy}
          contextData={libraryCtxData}
          fallbackRoot={rootPath}
          error={libraryCtxError}
          lastExportPath={libraryCtxExportPath}
          onRefresh={() => void loadLibraryContext()}
          onExport={() => void handleExportLibraryContext()}
          onClose={() => setLibraryCtxOpen(false)}
        />
      ) : null}
    </Box>
  );
});
