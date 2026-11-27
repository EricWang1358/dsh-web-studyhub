import { isAbsolute, relative, resolve } from 'node:path';
import type { BindingSnapshot, HostClient } from '../../types/contracts.js';
import { t } from '../../state/store.js';
import { defaultBackupFilePath, resolveSafeBackupExportPath } from '../../host/atomic-write.js';
import { cleanPathInput } from '../../host/sample-actions.js';
import { displayWidth, graphemeWidth, splitGraphemes, truncateDisplay } from '../../render/cjk.js';

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

export interface RetrievalStatusShape {
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

export interface RetrievalCoverageShape {
  indexed: string[];
  stale: string[];
  missing: string[];
  /** Pages whose text is unchanged but whose index key format is old (#1291): present only when there are some. */
  migrate?: string[];
  skipped?: string[];
  reset?: string[];
  hasIndex: boolean;
  canIndex: boolean;
  building: boolean | Record<string, unknown> | null;
}

export interface RetrievalIndexPlanShape {
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

export interface RetrievalTestResultShape {
  ok: boolean;
  reason?: string;
  provider?: string;
  hits?: number;
  matched?: number;
  unresolved?: number;
  sample?: Array<{ title?: string; sourceId?: string; snippet?: string }>;
  message?: string;
}

export interface RetrievalPreviewPageShape {
  sourceId?: string;
  title?: string;
  page?: number;
  score?: number;
  snippet?: string;
}

export interface RetrievalPreviewResultShape {
  provider?: string;
  query?: string;
  hits?: number;
  unresolved?: number;
  truncated?: boolean;
  chars?: number;
  pages?: RetrievalPreviewPageShape[];
}

export interface UsageFrequencyStatusShape {
  enabled: boolean;
  paused: boolean;
  hasData: boolean;
  daysWithData: number;
  since: string;
  file?: string;
}

export type UsageReportPeriod = 7 | 30 | 'all';

export interface UsageReportRowShape {
  key: string;
  name: string | null;
  count: number;
  registered?: boolean;
  tier?: string;
  group?: string | null;
  daysUsed?: number;
  share: number;
}

export interface UsageReportObservationShape {
  id: string;
  key: string | null;
  optional?: boolean;
  text: string;
}

export interface UsageReportShape {
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

export interface LibraryContextShape {
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

export interface UpdateViewShape {
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

export function describeRetrievalBadge(
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

export function describeRetrievalCoverage(
  coverage: RetrievalCoverageShape | null,
  lang: 'zh' | 'en',
  asciiMode: boolean,
): string {
  if (!coverage) return '';
  const indexedCount = Array.isArray(coverage.indexed) ? coverage.indexed.length : 0;
  const staleCount = Array.isArray(coverage.stale) ? coverage.stale.length : 0;
  const missingCount = Array.isArray(coverage.missing) ? coverage.missing.length : 0;
  // Pages awaiting the key-format upgrade left `stale` for `migrate` (#1291): they still belong to the library, so they
  // stay in the total and get their own count instead of vanishing from the row.
  const migrateCount = Array.isArray(coverage.migrate) ? coverage.migrate.length : 0;
  const total = indexedCount + staleCount + missingCount + migrateCount;
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
  if (migrateCount > 0) {
    parts.push(t(lang, `待升级 ${migrateCount}`, `${migrateCount} to upgrade`));
  }
  if (coverage.building) {
    parts.push(t(lang, '构建中', 'building'));
  }
  return parts.join(sep);
}

export function buildRetrievalProviderChoices(status: RetrievalStatusShape | null): string[] {
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

export function describeUsageBadge(
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

export function describeUsageReportState(
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

export function describeAutoUpdateBadge(
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

export function describeUpdateStatusBadge(
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

export function formatBytes(bytes?: number): string {
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
