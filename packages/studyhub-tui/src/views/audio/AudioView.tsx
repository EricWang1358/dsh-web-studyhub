import React, { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { readFile, stat } from 'node:fs/promises';
import { basename, extname, isAbsolute, resolve } from 'node:path';
import { Box, Text, type Key } from 'ink';
import { KEY_LAYER_MODAL } from '../../input/dispatcher.js';
import { KeyScope, useKeyScope } from '../../input/hooks.js';
import type { HostCallResult, HostClient, KeyHint, StudySnapshot, UiLanguage, ViewProps } from '../../types/contracts.js';
import { t, useTuiStore } from '../../state/store.js';
import { Badge, EmptyState, Spinner, StatusPill, type PillStatus } from '../../components/Badge.js';
import { ConfirmDialog } from '../../components/ConfirmDialog.js';
import { Modal, modalContentWidth } from '../../components/Modal.js';
import { Panel } from '../../components/Panel.js';
import { ScrollArea } from '../../components/ScrollArea.js';
import { SplitPane } from '../../components/SplitPane.js';
import { TextInput } from '../../components/TextInput.js';
import { VirtualList } from '../../components/VirtualList.js';
import { useInputCapture } from '../../components/focus.js';
import { LAYOUT_BP, computeFilterBarLayout } from '../../components/layout-tokens.js';
import { useFooterHints } from '../../components/hooks.js';
import { useTheme } from '../../theme/tokens.js';
import { currentCourse } from '../../shell/data.js';
import { useShellActions } from '../../shell/actions.js';
import { truncateDisplay } from '../../render/cjk.js';
import { atomicWriteExportText, defaultBackupFilePath, todayLocalYmd } from '../../host/atomic-write.js';
import { cleanPathInput, tryAction } from '../../host/sample-actions.js';
import { completeFsPath, expandHomePath } from '../sources/path-complete.js';

const AudioOverlayHotkeys = memo(function AudioOverlayHotkeys({
  id,
  isActive,
  onKey,
}: {
  id: string;
  isActive: boolean;
  onKey: (input: string, key: Key) => boolean;
}) {
  useKeyScope({ id, active: isActive, layer: KEY_LAYER_MODAL, onKey });
  return null;
});

interface AudioKeyState {
  set?: boolean;
  hint?: string;
}

interface AudioSettingsInfo {
  freeKey?: AudioKeyState;
  paidKey?: AudioKeyState;
  groqKey?: AudioKeyState;
  siliconflowKey?: AudioKeyState;
  textProvider?: string;
  transcribeModel?: string;
  groqTranscribeModel?: string;
  siliconflowTranscribeModel?: string;
  [k: string]: unknown;
}

interface AudioPreflightInfo {
  providers?: {
    free?: boolean;
    paid?: boolean;
    groq?: boolean;
    siliconflow?: boolean;
    [k: string]: boolean | undefined;
  };
  transcription?: boolean;
  first?: string | null;
  reason?: string | null;
  text?: boolean;
  textProvider?: string;
  live?: boolean;
  liveProvider?: string | null;
  liveReason?: string;
  liveLocal?: { supported?: boolean; ready?: boolean };
  liveLoopback?: { supported?: boolean; ready?: boolean };
  [k: string]: unknown;
}

interface AudioUsageModel {
  model: string;
  used?: number;
  limit?: number | null;
  remaining?: number | null;
  source?: string;
}

interface AudioUsageProvider {
  tier: string;
  configured?: boolean;
  today?: {
    requests?: number;
    success?: number;
    failures?: number;
    limited?: number;
    inputTokens?: number;
    outputTokens?: number;
    cachedInputTokens?: number;
    outputUnknown?: number;
    audioSeconds?: number;
  };
  total?: { requests?: number };
  models?: AudioUsageModel[];
}

interface AudioUsageInfo {
  updatedAt?: number;
  since?: number | null;
  timeZone?: string;
  providers?: AudioUsageProvider[];
  other?: { today?: { requests?: number }; total?: { requests?: number } };
  [k: string]: unknown;
}

export interface AudioTranscriptSegment {
  start?: number;
  startSec?: number;
  end?: number;
  endSec?: number;
  timestamp?: string;
  speaker?: string;
  text?: string;
  en?: string;
  zh?: string;
}

export interface AudioResultItem {
  id: string;
  title?: string;
  text?: string;
  transcript?: string;
  course?: string;
  courses?: string[];
  fileName?: string;
  filename?: string;
  sourceId?: string;
  durationSec?: number;
  duration?: number;
  provider?: string;
  language?: string;
  createdAt?: string;
  segments?: ReadonlyArray<AudioTranscriptSegment>;
  audio?: AudioRecordLike['audio'] & {
    provider?: string;
    language?: string;
    fileName?: string;
    filename?: string;
    durationSec?: number;
  };
  corrections?: AudioCorrectionsData | ReadonlyArray<PendingCorrectionSample>;
  [k: string]: unknown;
}

interface AudioJobItem {
  id: string;
  retryJobId: string;
  title: string;
  status: string;
  phase?: string;
  error?: string;
  retryable: boolean;
}

type LeftListItem =
  | { kind: 'job'; id: string; job: AudioJobItem }
  | { kind: 'result'; id: string; result: AudioResultItem };

type AudioOverlay = 'none' | 'import' | 'subtitle' | 'settings';
type ImportField = 'path' | 'title' | 'course';
type SubtitleField = 'path' | 'course';
type ProviderKeyField = 'siliconflowKey' | 'groqKey' | 'freeKey' | 'paidKey';

const AUDIO_EXTS = ['.mp3', '.wav', '.m4a', '.ogg', '.flac', '.aac', '.webm'];
const SUBTITLE_EXTS = ['.srt', '.vtt', '.txt', '.json'];
const MAX_SUBTITLE_BYTES = 8 * 1024 * 1024;
const CLAIMED_KEYS: readonly string[] = Object.freeze(['i', 'u', 'p', 'R', 's', 't', 'g', 'c', '/', 'x']);

export function isAudioSourceRecord(src: Record<string, unknown>): boolean {
  if (src.archived === true) return false;
  if (src.audio && typeof src.audio === 'object') return true;
  if (typeof src.id === 'string' && /^(audio|subtitle|live)-/.test(src.id)) return true;
  const prov = typeof src.provenance === 'string' ? src.provenance : '';
  const fmt = typeof src.format === 'string' ? src.format : '';
  return prov === 'audio' || prov === 'audio-transcript' || fmt === 'audio' || fmt === 'srt' || fmt === 'vtt';
}

export function mapAudioSourceRecord(raw: Record<string, unknown>): AudioResultItem {
  const audio = raw.audio && typeof raw.audio === 'object' ? (raw.audio as Record<string, unknown>) : undefined;
  const courses = Array.isArray(raw.courses) ? raw.courses.filter((c): c is string => typeof c === 'string') : [];
  const course = typeof raw.course === 'string' ? raw.course : courses[0];
  const fileName =
    (typeof raw.fileName === 'string' && raw.fileName) ||
    (typeof raw.filename === 'string' && raw.filename) ||
    (typeof audio?.fileName === 'string' && audio.fileName) ||
    (typeof audio?.filename === 'string' && audio.filename) ||
    undefined;
  const durationSec =
    typeof raw.durationSec === 'number'
      ? raw.durationSec
      : typeof raw.duration === 'number'
        ? raw.duration
        : typeof audio?.durationSec === 'number'
          ? audio.durationSec
          : typeof audio?.seconds === 'number'
            ? audio.seconds
            : undefined;
  const provider =
    (typeof raw.provider === 'string' && raw.provider) ||
    (typeof audio?.provider === 'string' && audio.provider) ||
    (typeof audio?.textProvider === 'string' && audio.textProvider) ||
    undefined;
  const createdAt =
    (typeof raw.createdAt === 'string' && raw.createdAt) ||
    (typeof audio?.importedAt === 'string' && audio.importedAt) ||
    undefined;
  const text = typeof raw.text === 'string' ? raw.text : undefined;
  const transcript = typeof raw.transcript === 'string' ? raw.transcript : text;
  const id = String(raw.id ?? '');
  return {
    ...raw,
    id,
    sourceId: typeof raw.sourceId === 'string' ? raw.sourceId : id,
    ...(courses.length > 0 ? { courses } : {}),
    ...(course ? { course } : {}),
    ...(fileName ? { fileName, filename: fileName } : {}),
    ...(durationSec !== undefined ? { durationSec } : {}),
    ...(provider ? { provider } : {}),
    ...(createdAt ? { createdAt } : {}),
    ...(text !== undefined ? { text } : {}),
    ...(transcript !== undefined ? { transcript } : {}),
  } as AudioResultItem;
}

export async function fetchAudioSourceDetail(
  host: HostClient,
  sourceId: string,
): Promise<HostCallResult<AudioResultItem>> {
  const targetId = sourceId.trim();
  if (!targetId) {
    return { ok: false, error: { message: 'Audio source ID is required', code: 'INVALID_ARGS' } };
  }
  const srcRes = await tryAction<Record<string, unknown>>(host, 'source.get', {
    id: targetId,
    offset: 0,
    limit: 60000,
  });
  if (!srcRes.ok || !srcRes.value || typeof srcRes.value !== 'object') {
    return srcRes as HostCallResult<AudioResultItem>;
  }
  let fullText = typeof srcRes.value.text === 'string' ? srcRes.value.text : '';
  const totalChars = typeof srcRes.value.chars === 'number' ? srcRes.value.chars : fullText.length;
  const maxChars = Math.min(totalChars, 300_000);
  let offset = fullText.length;
  for (let chunk = 0; chunk < 4 && offset > 0 && offset < maxChars; chunk += 1) {
    const nextRes = await tryAction<Record<string, unknown>>(host, 'source.get', {
      id: targetId,
      offset,
      limit: 60000,
    });
    const part = nextRes.ok && typeof nextRes.value?.text === 'string' ? nextRes.value.text : '';
    if (!part) break;
    fullText += part;
    offset += part.length;
  }
  return {
    ok: true,
    value: mapAudioSourceRecord({ ...srcRes.value, text: fullText, transcript: fullText }),
  };
}

function formatGeneratedDate(generatedAt?: Date | string): string {
  if (typeof generatedAt === 'string' && generatedAt.trim()) {
    return generatedAt.trim();
  }
  const d = generatedAt instanceof Date && !Number.isNaN(generatedAt.getTime()) ? generatedAt : new Date();
  const ymd = todayLocalYmd(d);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${ymd} ${hh}:${mm}`;
}

function formatMmSs(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  const mins = Math.floor(total / 60);
  const secs = total % 60;
  return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
}

function resultMatchesFilter(r: AudioResultItem, query: string): boolean {
  if (!query) return true;
  const parts: string[] = [];
  if (typeof r.id === 'string') parts.push(r.id);
  if (typeof r.sourceId === 'string') parts.push(r.sourceId);
  if (typeof r.title === 'string') parts.push(r.title);
  if (typeof r.course === 'string') parts.push(r.course);
  if (Array.isArray(r.courses)) {
    for (const c of r.courses) {
      if (typeof c === 'string') parts.push(c);
    }
  }
  if (typeof r.fileName === 'string') parts.push(r.fileName);
  if (typeof r.filename === 'string') parts.push(r.filename);
  const audioMeta = r.audio && typeof r.audio === 'object' ? (r.audio as Record<string, unknown>) : undefined;
  if (typeof audioMeta?.fileName === 'string') parts.push(audioMeta.fileName);
  if (typeof audioMeta?.filename === 'string') parts.push(audioMeta.filename);
  if (typeof r.transcript === 'string') parts.push(r.transcript);
  if (typeof r.text === 'string') parts.push(r.text);
  if (Array.isArray(r.segments)) {
    for (const seg of r.segments) {
      if (seg && typeof seg === 'object') {
        const segText = typeof seg.text === 'string' ? seg.text : [seg.en, seg.zh].filter(Boolean).join(' ');
        if (segText) parts.push(segText);
      }
    }
  }
  return parts.join('\n').toLowerCase().includes(query);
}

const AUDIO_JOB_TYPES = new Set([
  'audio-import',
  'audio-batch',
  'audio-subtitles',
  'audio-review',
  'audio-live-save',
  'audio-live-correction',
]);
const RETRYABLE_JOB_STATUSES = new Set(['failed', 'cancelled', 'canceled', 'interrupted', 'error']);
const COMPLETED_JOB_STATUSES = new Set(['complete', 'completed', 'done', 'ok', 'succeeded']);

const PROVIDERS: ReadonlyArray<{ field: ProviderKeyField; tier: string; label: string }> = [
  { field: 'siliconflowKey', tier: 'siliconflow', label: '硅基流动 SenseVoice (推荐/国内直连)' },
  { field: 'groqKey', tier: 'groq', label: 'Groq Whisper' },
  { field: 'freeKey', tier: 'free', label: 'Google Gemini (免费额度)' },
  { field: 'paidKey', tier: 'paid', label: 'Google Gemini (付费密钥)' },
];

export interface PendingCorrectionSample {
  wrong?: string;
  right?: string;
  reason?: string;
  context?: string;
}

export interface PendingCorrectionsSummary {
  pending: number;
  applied: number;
  items: PendingCorrectionSample[];
}

interface CorrectionSkippedEntry {
  wrong?: unknown;
  right?: unknown;
  reason?: unknown;
  context?: unknown;
  skipped?: unknown;
  review?: unknown;
  [k: string]: unknown;
}

interface AudioCorrectionsData {
  applied?: unknown[];
  appliedCount?: number;
  skipped?: CorrectionSkippedEntry[];
  skippedCount?: number;
}

interface AudioRecordLike {
  id?: string;
  sourceId?: string;
  audio?: {
    sourceIds?: unknown[];
    batch?: { sourceIds?: unknown[] };
    corrections?: AudioCorrectionsData;
    [k: string]: unknown;
  };
  [k: string]: unknown;
}

function safeNum(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

function readCorrectionsContainer(
  item: AudioRecordLike | null | undefined,
  sources?: ReadonlyArray<AudioRecordLike> | null,
): AudioCorrectionsData | undefined {
  if (!item || typeof item !== 'object') return undefined;
  if (item.audio?.corrections && typeof item.audio.corrections === 'object') {
    return item.audio.corrections;
  }
  if (!Array.isArray(sources) || sources.length === 0) return undefined;
  const lookupId = String(item.sourceId || item.id || '');
  const matched = lookupId
    ? sources.find((s) => s && typeof s === 'object' && (s.id === lookupId || s.sourceId === lookupId))
    : undefined;
  if (matched?.audio?.corrections && typeof matched.audio.corrections === 'object') {
    return matched.audio.corrections;
  }
  const familyIdsRaw =
    matched?.audio?.sourceIds ??
    matched?.audio?.batch?.sourceIds ??
    item.audio?.sourceIds ??
    item.audio?.batch?.sourceIds;
  if (Array.isArray(familyIdsRaw)) {
    const familyIds = new Set(familyIdsRaw.map((v) => String(v || '')).filter(Boolean));
    const owner = sources.find(
      (s) =>
        s &&
        typeof s === 'object' &&
        s.id &&
        familyIds.has(s.id) &&
        s.audio?.corrections &&
        typeof s.audio.corrections === 'object',
    );
    if (owner?.audio?.corrections) return owner.audio.corrections;
  }
  return undefined;
}

/** Inspect `audio.corrections` (directly or via snapshot source lookup) and count pending low-confidence items. */
export function countPendingCorrections(
  item: AudioRecordLike | null | undefined,
  sources?: ReadonlyArray<AudioRecordLike> | null,
): PendingCorrectionsSummary {
  const corrections = readCorrectionsContainer(item, sources);
  if (!corrections) {
    return { pending: 0, applied: 0, items: [] };
  }
  const appliedArr = Array.isArray(corrections.applied) ? corrections.applied : [];
  const applied = appliedArr.length > 0 ? appliedArr.length : safeNum(corrections.appliedCount);
  const skippedArr = Array.isArray(corrections.skipped) ? corrections.skipped : [];
  const items: PendingCorrectionSample[] = [];
  for (const entry of skippedArr) {
    if (!entry || typeof entry !== 'object') continue;
    if (entry.skipped === 'low-confidence' && !entry.review) {
      items.push({
        ...(typeof entry.wrong === 'string' ? { wrong: entry.wrong } : {}),
        ...(typeof entry.right === 'string' ? { right: entry.right } : {}),
        ...(typeof entry.reason === 'string' ? { reason: entry.reason } : {}),
        ...(typeof entry.context === 'string' ? { context: entry.context } : {}),
      });
    }
  }
  return {
    pending: items.length,
    applied,
    items,
  };
}

export interface FormatAudioTranscriptMarkdownParams {
  result: AudioResultItem;
  detail?: AudioResultItem | null;
  lang: UiLanguage;
  generatedAt?: Date | string;
}

function extractPendingCorrections(
  detail: AudioResultItem | null | undefined,
  result: AudioResultItem,
): PendingCorrectionsSummary {
  const fromDetail = detail ? countPendingCorrections(detail as AudioRecordLike, [result as AudioRecordLike]) : null;
  if (fromDetail && (fromDetail.pending > 0 || fromDetail.applied > 0)) return fromDetail;

  const fromResult = countPendingCorrections(result as AudioRecordLike);
  if (fromResult.pending > 0 || fromResult.applied > 0) return fromResult;

  const rawDirect = detail?.corrections ?? result.corrections;
  if (Array.isArray(rawDirect)) {
    const items: PendingCorrectionSample[] = [];
    for (const entry of rawDirect) {
      if (!entry || typeof entry !== 'object') continue;
      const obj = entry as Record<string, unknown>;
      if (obj.review) continue;
      items.push({
        ...(typeof obj.wrong === 'string' ? { wrong: obj.wrong } : {}),
        ...(typeof obj.right === 'string' ? { right: obj.right } : {}),
        ...(typeof obj.reason === 'string' ? { reason: obj.reason } : {}),
        ...(typeof obj.context === 'string' ? { context: obj.context } : {}),
      });
    }
    return { pending: items.length, applied: 0, items };
  }
  if (rawDirect && typeof rawDirect === 'object') {
    return countPendingCorrections({ audio: { corrections: rawDirect as AudioCorrectionsData } });
  }
  return { pending: 0, applied: 0, items: [] };
}

/** Pure formatter producing a clean Markdown transcript document for an audio result (0 LLM tokens). */
export function formatAudioTranscriptMarkdown({
  result,
  detail,
  lang,
  generatedAt,
}: FormatAudioTranscriptMarkdownParams): string {
  const title = String(detail?.title || result.title || result.id || t(lang, '音频转写文稿', 'Audio Transcript')).trim();
  const exportedAt = formatGeneratedDate(generatedAt);
  const createdAt = String(detail?.createdAt || result.createdAt || '').trim();

  const coursesList =
    Array.isArray(detail?.courses) && detail.courses.length > 0
      ? detail.courses
      : Array.isArray(result.courses) && result.courses.length > 0
        ? result.courses
        : [];
  const fallbackCourse = String(detail?.course || result.course || '').trim();
  const courses = coursesList.length > 0 ? coursesList.filter(Boolean) : fallbackCourse ? [fallbackCourse] : [];

  const fileName = String(
    detail?.fileName ||
      detail?.filename ||
      detail?.audio?.fileName ||
      detail?.audio?.filename ||
      result.fileName ||
      result.filename ||
      result.audio?.fileName ||
      result.audio?.filename ||
      '',
  ).trim();

  const rawDuration =
    detail?.durationSec ??
    detail?.duration ??
    detail?.audio?.durationSec ??
    result.durationSec ??
    result.duration ??
    result.audio?.durationSec;
  const durationNum = typeof rawDuration === 'number' ? rawDuration : Number(rawDuration);

  const provider = String(
    detail?.provider || detail?.audio?.provider || result.provider || result.audio?.provider || '',
  ).trim();
  const audioLanguage = String(
    detail?.language || detail?.audio?.language || result.language || result.audio?.language || '',
  ).trim();

  const lines: string[] = [`# ${title}`, ''];
  lines.push(`- ${t(lang, '导出时间', 'Exported')}: ${exportedAt}`);
  if (createdAt) {
    lines.push(`- ${t(lang, '创建时间', 'Created')}: ${createdAt}`);
  }
  if (courses.length > 0) {
    lines.push(`- ${t(lang, '课程', 'Course')}: ${courses.join(', ')}`);
  }
  if (fileName) {
    lines.push(`- ${t(lang, '文件', 'File')}: ${fileName}`);
  }
  if (Number.isFinite(durationNum) && durationNum > 0) {
    lines.push(`- ${t(lang, '时长', 'Duration')}: ${formatMmSs(durationNum)}`);
  }
  if (provider) {
    lines.push(`- ${t(lang, '转写服务', 'Provider')}: ${provider}`);
  }
  if (audioLanguage) {
    lines.push(`- ${t(lang, '语言', 'Language')}: ${audioLanguage}`);
  }
  if (result.id) {
    lines.push(`- ID: \`${result.id}\``);
  }

  lines.push('', `## ${t(lang, '转写正文', 'Transcript')}`, '');

  const segments =
    Array.isArray(detail?.segments) && detail.segments.length > 0
      ? detail.segments
      : Array.isArray(result.segments) && result.segments.length > 0
        ? result.segments
        : [];
  const segmentLines: string[] = [];
  for (const seg of segments) {
    if (!seg || typeof seg !== 'object') continue;
    const body = String(seg.text ?? [seg.en, seg.zh].filter(Boolean).join(' / ') ?? '').trim();
    if (!body) continue;
    const rawStart = seg.start ?? seg.startSec;
    const stamp =
      typeof seg.timestamp === 'string' && seg.timestamp.trim()
        ? seg.timestamp.trim().replace(/^\[|\]$/g, '')
        : typeof rawStart === 'number' && Number.isFinite(rawStart) && rawStart >= 0
          ? formatMmSs(rawStart)
          : '00:00';
    const speaker = typeof seg.speaker === 'string' && seg.speaker.trim() ? `${seg.speaker.trim()}: ` : '';
    segmentLines.push(`[${stamp}] ${speaker}${body}`);
  }

  if (segmentLines.length > 0) {
    lines.push(...segmentLines);
  } else {
    const plainBody = String(detail?.transcript || detail?.text || result.transcript || result.text || '').trim();
    lines.push(plainBody || t(lang, '（暂无转写正文）', '(Empty transcript)'));
  }

  const corrections = extractPendingCorrections(detail, result);
  if (corrections.items.length > 0) {
    lines.push(
      '',
      `## ${t(lang, `待复核存疑处 (${corrections.items.length})`, `Pending Uncertain Corrections (${corrections.items.length})`)}`,
      '',
    );
    for (const item of corrections.items) {
      const wrong = item.wrong || '?';
      const right = item.right || '?';
      const reason = item.reason ? ` (${item.reason})` : '';
      const ctx = item.context ? ` -- "${item.context}"` : '';
      lines.push(`- **${wrong}** -> **${right}**${reason}${ctx}`);
    }
  }

  lines.push('');
  return lines.join('\n');
}

function readTextField(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    if (typeof obj.message === 'string') return obj.message;
    if (typeof obj.text === 'string') return obj.text;
    if (typeof obj.code === 'string') return obj.code;
  }
  return '';
}

function jobPillStatus(status: string): PillStatus {
  if (status === 'failed' || status === 'error' || status === 'interrupted') return 'error';
  if (status === 'cancelled' || status === 'canceled') return 'warn';
  if (status === 'running' || status === 'queued' || status === 'pausing' || status === 'cancelling') return 'busy';
  return 'idle';
}

function formatPreflightLine(pf: AudioPreflightInfo | null, lang: 'zh' | 'en', asciiMode: boolean): string {
  if (!pf) {
    return t(lang, '预检: 正在检测或待按 [p] 运行', 'Preflight: pending (press [p] to run)');
  }
  const ok = asciiMode ? 'OK' : '✓';
  const no = asciiMode ? '--' : '✕';
  const prov = pf.providers ?? {};
  const localReady = Boolean(pf.liveLocal?.ready);
  const loopReady = Boolean(pf.liveLoopback?.ready);
  if (lang === 'zh') {
    return `预检: 免费:${prov.free ? ok : no} 付费:${prov.paid ? ok : no} 硅基:${prov.siliconflow ? ok : no} Groq:${prov.groq ? ok : no} 本地:${localReady ? ok : no} 内录:${loopReady ? ok : no}`;
  }
  return `Preflight: Free:${prov.free ? ok : no} Paid:${prov.paid ? ok : no} SF:${prov.siliconflow ? ok : no} Groq:${prov.groq ? ok : no} Local:${localReady ? ok : no} Loop:${loopReady ? ok : no}`;
}

function formatPreflightToast(pf: AudioPreflightInfo, lang: 'zh' | 'en', asciiMode: boolean): string {
  const sep = asciiMode ? ' | ' : ' · ';
  const prov = pf.providers ?? {};
  const activeTiers = ['siliconflow', 'groq', 'free', 'paid'].filter((tier) => Boolean(prov[tier]));
  const tierSummary = activeTiers.length > 0 ? activeTiers.join(',') : t(lang, '无可用转写密钥', 'none');
  const localText = pf.liveLocal?.ready ? t(lang, '就绪', 'ready') : t(lang, '未就绪', 'off');
  const loopText = pf.liveLoopback?.ready ? t(lang, '就绪', 'ready') : t(lang, '未就绪', 'off');
  const textOk = pf.text ? t(lang, '可用', 'OK') : t(lang, '未就绪', 'off');
  if (lang === 'zh') {
    return `预检完成: 转写[${tierSummary}]${sep}文本[${textOk}]${sep}本地[${localText}]${sep}内录[${loopText}]`;
  }
  return `Preflight: transcribe[${tierSummary}]${sep}text[${textOk}]${sep}local[${localText}]${sep}loopback[${loopText}]`;
}

function formatUsageLine(usage: AudioUsageInfo | null, lang: 'zh' | 'en', asciiMode: boolean): string {
  const sep = asciiMode ? ' | ' : ' · ';
  if (!usage || !Array.isArray(usage.providers)) {
    return t(lang, '用量: 暂无统计数据', 'Usage: no data yet');
  }
  let req = safeNum(usage.other?.today?.requests);
  let audioSec = 0;
  let inTok = 0;
  let outTok = 0;
  let failures = 0;
  let limited = 0;
  let quotaLabel = '--';

  for (const p of usage.providers) {
    const td = p.today;
    if (td) {
      req += safeNum(td.requests);
      audioSec += safeNum(td.audioSeconds);
      inTok += safeNum(td.inputTokens);
      outTok += safeNum(td.outputTokens);
      failures += safeNum(td.failures);
      limited += safeNum(td.limited);
    }
    if (quotaLabel === '--' && p.tier !== 'paid' && p.configured && Array.isArray(p.models)) {
      const m = p.models.find((item) => typeof item.limit === 'number' && item.limit > 0);
      if (m && typeof m.limit === 'number') {
        const rem = typeof m.remaining === 'number' ? m.remaining : Math.max(0, m.limit - safeNum(m.used));
        quotaLabel = `${rem}/${m.limit}`;
      }
    }
  }

  const minStr = (audioSec / 60).toFixed(1);
  if (lang === 'zh') {
    return `今日: ${req}次${sep}${minStr}分${sep}${inTok}/${outTok} tok${sep}失败${failures}(限流${limited})${sep}余量:${quotaLabel}`;
  }
  return `Today: ${req} req${sep}${minStr}m${sep}${inTok}/${outTok} tok${sep}err:${failures}(429:${limited})${sep}quota:${quotaLabel}`;
}

export const AudioView: React.FC<ViewProps> = memo(function AudioView({
  host,
  width,
  height,
  isActive,
}) {
  const theme = useTheme();
  const lang = useTuiStore((s) => s.preferences.language);
  const asciiMode = useTuiStore((s) => Boolean(s.preferences.asciiMode));
  const snapshot = useTuiStore((s) => s.snapshot);
  const bindingRoot = useTuiStore((s) => s.binding?.root);
  const snapshotRoot = useTuiStore((s) => s.snapshot?.root);
  const navigate = useTuiStore((s) => s.navigate);
  const notify = useTuiStore((s) => s.notify);
  const { refresh } = useShellActions();

  const focusCourse = currentCourse(snapshot);

  const [audioSettings, setAudioSettings] = useState<AudioSettingsInfo | null>(null);
  const [preflight, setPreflight] = useState<AudioPreflightInfo | null>(null);
  const [usage, setUsage] = useState<AudioUsageInfo | null>(null);
  const [results, setResults] = useState<AudioResultItem[]>([]);
  const [resultsError, setResultsError] = useState<string | null>(null);
  const [filterQuery, setFilterQuery] = useState('');
  const [filterEditing, setFilterEditing] = useState(false);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [activePane, setActivePane] = useState<'left' | 'right'>('left');
  const [activeTranscript, setActiveTranscript] = useState<{ id: string; text: string; detail?: AudioResultItem | null }>({
    id: '',
    text: '',
    detail: null,
  });
  const [detailError, setDetailError] = useState<{ id: string; message: string } | null>(null);
  const [loadingDetailId, setLoadingDetailId] = useState<string | null>(null);
  const [loadingList, setLoadingList] = useState(false);

  const [overlay, setOverlay] = useState<AudioOverlay>('none');
  const [confirmReview, setConfirmReview] = useState<{ sourceId: string; title: string; pending: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const mountedRef = useRef(true);
  const busyRef = useRef(false);
  const exportBusyRef = useRef(false);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      busyRef.current = false;
    };
  }, []);

  // Import modal state
  const [importField, setImportField] = useState<ImportField>('path');
  const [audioPath, setAudioPath] = useState('');
  const [audioTitle, setAudioTitle] = useState('');
  const [audioCourse, setAudioCourse] = useState(focusCourse || '');
  const [pathMatches, setPathMatches] = useState<string[]>([]);
  const cachedCompletionRef = useRef<{ input: string; completed: string } | null>(null);

  // Subtitle modal state
  const [subtitleField, setSubtitleField] = useState<SubtitleField>('path');
  const [subtitlePath, setSubtitlePath] = useState('');
  const [subtitleCourse, setSubtitleCourse] = useState(focusCourse || '');
  const [subtitleMatches, setSubtitleMatches] = useState<string[]>([]);
  const cachedSubCompletionRef = useRef<{ input: string; completed: string } | null>(null);

  // Settings modal state
  const [providerIdx, setProviderIdx] = useState(0);
  const [apiKeyInput, setApiKeyInput] = useState('');
  const [testReport, setTestReport] = useState<Record<string, { ok?: boolean; message?: string }> | null>(null);

  const loadAudioData = useCallback(async () => {
    setLoadingList(true);
    let timeZone: string | undefined;
    try {
      timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || undefined;
    } catch {
      timeZone = undefined;
    }
    const [settingsRes, snapRes, preflightRes, usageRes] = await Promise.all([
      tryAction<AudioSettingsInfo>(host, 'audio.settings.get', {}),
      tryAction<StudySnapshot>(host, 'snapshot', {}),
      tryAction<AudioPreflightInfo>(host, 'audio.preflight', {}),
      tryAction<AudioUsageInfo>(host, 'audio.usage', timeZone ? { timeZone } : {}),
    ]);
    if (!mountedRef.current) return;
    setLoadingList(false);
    if (settingsRes.ok && settingsRes.value) setAudioSettings(settingsRes.value);
    if (snapRes.ok && snapRes.value) {
      const sources = Array.isArray(snapRes.value.sources) ? snapRes.value.sources : [];
      const mapped: AudioResultItem[] = [];
      for (const src of sources) {
        if (src && typeof src === 'object' && isAudioSourceRecord(src as Record<string, unknown>)) {
          const item = mapAudioSourceRecord(src as Record<string, unknown>);
          if (item.id) mapped.push(item);
        }
      }
      setResultsError(null);
      setResults(mapped);
    } else if (!snapRes.ok) {
      setResultsError(snapRes.error?.message || t(lang, '加载音频转写结果失败', 'Failed to load audio transcripts'));
    } else {
      setResultsError(null);
      setResults([]);
    }
    if (preflightRes.ok && preflightRes.value) setPreflight(preflightRes.value);
    if (usageRes.ok && usageRes.value) setUsage(usageRes.value);
  }, [host, lang]);

  useEffect(() => {
    if (!isActive) return;
    void loadAudioData();
  }, [isActive, loadAudioData]);

  const audioJobs = useMemo<AudioJobItem[]>(() => {
    const rawJobs = Array.isArray(snapshot?.jobs) ? snapshot.jobs : [];
    const items: AudioJobItem[] = [];
    for (const raw of rawJobs) {
      if (!raw || typeof raw !== 'object') continue;
      const contract = (raw.contract && typeof raw.contract === 'object' ? raw.contract : undefined) as
        | Record<string, unknown>
        | undefined;
      const type = String(raw.type ?? raw.kind ?? '');
      const contractKind = String(contract?.kind ?? '');
      const isAudio = AUDIO_JOB_TYPES.has(type) || contractKind === 'audio-import';
      if (!isAudio) continue;
      const status = String(contract?.status ?? raw.status ?? 'unknown').toLowerCase();
      if (COMPLETED_JOB_STATUSES.has(status)) continue;
      const id = String(raw.id ?? contract?.jobId ?? '');
      if (!id) continue;
      const retryJobId = String(contract?.attemptId ?? raw.id ?? contract?.jobId ?? id);
      const title =
        readTextField(raw.filename) ||
        readTextField(raw.title) ||
        readTextField(contract?.title) ||
        id;
      const phase = readTextField(raw.phase) || readTextField(contract?.stage) || readTextField(raw.stage);
      const error = readTextField(raw.error) || readTextField(contract?.error) || readTextField(raw.message);
      const retryable = RETRYABLE_JOB_STATUSES.has(status);
      items.push({ id, retryJobId, title, status, phase: phase || undefined, error: error || undefined, retryable });
    }
    return items;
  }, [snapshot?.jobs]);

  const normalizedFilter = filterQuery.trim().toLowerCase();
  const filteredResults = useMemo(
    () => (normalizedFilter ? results.filter((r) => resultMatchesFilter(r, normalizedFilter)) : results),
    [results, normalizedFilter],
  );

  const leftItems = useMemo<LeftListItem[]>(() => {
    const out: LeftListItem[] = audioJobs.map((job) => ({ kind: 'job', id: `job:${job.id}`, job }));
    for (const r of filteredResults) {
      out.push({ kind: 'result', id: `res:${r.id}`, result: r });
    }
    return out;
  }, [audioJobs, filteredResults]);

  useEffect(() => {
    if (selectedIndex >= leftItems.length) {
      setSelectedIndex(Math.max(0, leftItems.length - 1));
    }
  }, [leftItems.length, selectedIndex]);

  const selectedItem = leftItems[selectedIndex];
  const selectedJob = selectedItem?.kind === 'job' ? selectedItem.job : undefined;
  const selectedResult = selectedItem?.kind === 'result' ? selectedItem.result : undefined;

  const correctionsSummary = useMemo<PendingCorrectionsSummary>(() => {
    if (!selectedResult) return { pending: 0, applied: 0, items: [] };
    const lookupPool = [
      ...(Array.isArray(snapshot?.sources) ? (snapshot.sources as AudioRecordLike[]) : []),
      ...(results as AudioRecordLike[]),
    ];
    return countPendingCorrections(selectedResult as AudioRecordLike, lookupPool);
  }, [selectedResult, snapshot?.sources, results]);

  // Load selected transcript detail on demand (bounded to 1 active transcript — memory NFR)
  useEffect(() => {
    if (!isActive || !selectedResult) {
      setActiveTranscript({ id: '', text: '', detail: null });
      setDetailError(null);
      setLoadingDetailId(null);
      return;
    }
    const inlineText = selectedResult.transcript || selectedResult.text;
    if (typeof inlineText === 'string' && inlineText) {
      setDetailError(null);
      setLoadingDetailId(null);
      setActiveTranscript({ id: selectedResult.id, text: inlineText, detail: selectedResult });
      return;
    }
    if (activeTranscript.id === selectedResult.id && (!detailError || detailError.id !== selectedResult.id)) return;
    let cancelled = false;
    setLoadingDetailId(selectedResult.id);
    setDetailError(null);
    void fetchAudioSourceDetail(host, selectedResult.id).then((res) => {
      if (cancelled) return;
      setLoadingDetailId(null);
      if (res.ok && res.value) {
        setDetailError(null);
        setActiveTranscript({
          id: selectedResult.id,
          text: String(res.value.transcript || res.value.text || ''),
          detail: res.value,
        });
      } else {
        setDetailError({
          id: selectedResult.id,
          message: res.error?.message || t(lang, '加载转写正文失败', 'Failed to load transcript detail'),
        });
        setActiveTranscript({ id: '', text: '', detail: null });
      }
    });
    return () => {
      cancelled = true;
    };
  }, [host, isActive, selectedResult, activeTranscript.id, detailError, lang]);

  // Pre-fetch path completions while typing audio path
  useEffect(() => {
    if (!isActive || overlay !== 'import' || importField !== 'path') return;
    let cancelled = false;
    void completeFsPath(cleanPathInput(audioPath), { extensions: AUDIO_EXTS }).then((res) => {
      if (cancelled) return;
      cachedCompletionRef.current = { input: audioPath, completed: res.completed };
      setPathMatches(res.matches.slice(0, 6));
    });
    return () => {
      cancelled = true;
    };
  }, [isActive, overlay, importField, audioPath]);

  // Pre-fetch path completions while typing subtitle path
  useEffect(() => {
    if (!isActive || overlay !== 'subtitle' || subtitleField !== 'path') return;
    let cancelled = false;
    void completeFsPath(cleanPathInput(subtitlePath), { extensions: SUBTITLE_EXTS }).then((res) => {
      if (cancelled) return;
      cachedSubCompletionRef.current = { input: subtitlePath, completed: res.completed };
      setSubtitleMatches(res.matches.slice(0, 6));
    });
    return () => {
      cancelled = true;
    };
  }, [isActive, overlay, subtitleField, subtitlePath]);

  const handleTabComplete = useCallback((val: string) => {
    const cached = cachedCompletionRef.current;
    if (cached && cached.input === val && cached.completed && cached.completed !== val) {
      return cached.completed;
    }
    void completeFsPath(cleanPathInput(val), { extensions: AUDIO_EXTS }).then((res) => {
      cachedCompletionRef.current = { input: res.completed, completed: res.completed };
      setPathMatches(res.matches.slice(0, 6));
      if (res.completed && res.completed !== val) setAudioPath(res.completed);
    });
    return undefined;
  }, []);

  const handleSubtitleTabComplete = useCallback((val: string) => {
    const cached = cachedSubCompletionRef.current;
    if (cached && cached.input === val && cached.completed && cached.completed !== val) {
      return cached.completed;
    }
    void completeFsPath(cleanPathInput(val), { extensions: SUBTITLE_EXTS }).then((res) => {
      cachedSubCompletionRef.current = { input: res.completed, completed: res.completed };
      setSubtitleMatches(res.matches.slice(0, 6));
      if (res.completed && res.completed !== val) setSubtitlePath(res.completed);
    });
    return undefined;
  }, []);

  const handleImportSubmit = useCallback(async () => {
    if (busy) return;
    const expanded = expandHomePath(cleanPathInput(audioPath));
    if (!expanded) {
      notify(t(lang, '请输入音频文件路径', 'Please enter an audio file path'), 'warning');
      return;
    }
    const absPath = isAbsolute(expanded) ? expanded : resolve(process.cwd(), expanded);
    setBusy(true);
    const res = await tryAction<{ jobId?: string; id?: string }>(host, 'audio.import', {
      path: absPath,
      ...(audioTitle.trim() ? { title: audioTitle.trim() } : {}),
      ...(audioCourse.trim() ? { courses: [audioCourse.trim()] } : {}),
    });
    setBusy(false);
    if (!res.ok) {
      notify(res.error?.message || t(lang, '音频导入失败', 'Audio import failed'), 'error');
      return;
    }
    setOverlay('none');
    setAudioPath('');
    setAudioTitle('');
    await refresh();
    const jobId = res.value?.jobId || res.value?.id;
    notify(t(lang, '音频转写任务已启动', 'Audio transcription job started'), 'success');
    if (jobId) navigate('tasks', { jobId });
  }, [busy, audioPath, audioTitle, audioCourse, host, lang, notify, refresh, navigate]);

  const handleSubtitleSubmit = useCallback(async () => {
    if (busy) return;
    const expanded = expandHomePath(cleanPathInput(subtitlePath));
    if (!expanded) {
      notify(t(lang, '请输入字幕文件路径', 'Please enter a subtitle file path'), 'warning');
      return;
    }
    const absPath = isAbsolute(expanded) ? expanded : resolve(process.cwd(), expanded);
    const ext = extname(absPath).toLowerCase();
    if (!SUBTITLE_EXTS.includes(ext)) {
      notify(
        t(lang, '不支持的字幕格式；支持 .srt / .vtt / .txt / .json', 'Unsupported subtitle format; supported: .srt, .vtt, .txt, .json'),
        'warning',
      );
      return;
    }
    setBusy(true);
    let text = '';
    try {
      const info = await stat(absPath);
      if (info.size > MAX_SUBTITLE_BYTES) {
        setBusy(false);
        notify(t(lang, '字幕文件超过 8MB 上限', 'Subtitle file exceeds 8MB limit'), 'warning');
        return;
      }
      text = await readFile(absPath, 'utf8');
    } catch (err) {
      setBusy(false);
      notify(
        t(
          lang,
          `读取字幕文件失败: ${err instanceof Error ? err.message : String(err)}`,
          `Failed to read subtitle file: ${err instanceof Error ? err.message : String(err)}`,
        ),
        'error',
      );
      return;
    }

    const res = await tryAction<{ jobId?: string; id?: string }>(host, 'audio.subtitles.import', {
      filename: basename(absPath),
      text,
      ...(subtitleCourse.trim() ? { course: subtitleCourse.trim() } : {}),
    });
    setBusy(false);
    if (!res.ok) {
      notify(res.error?.message || t(lang, '字幕导入失败', 'Subtitle import failed'), 'error');
      return;
    }
    setOverlay('none');
    setSubtitlePath('');
    await Promise.all([refresh(), loadAudioData()]);
    const jobId = res.value?.jobId || res.value?.id;
    notify(t(lang, '字幕校对任务已启动', 'Subtitle import job started'), 'success');
    if (jobId) navigate('tasks', { jobId });
  }, [busy, subtitlePath, subtitleCourse, host, lang, notify, refresh, loadAudioData, navigate]);

  const handlePreflight = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    const res = await tryAction<AudioPreflightInfo>(host, 'audio.preflight', {});
    setBusy(false);
    if (!res.ok || !res.value) {
      notify(res.error?.message || t(lang, '音频预检失败', 'Audio preflight failed'), 'error');
      return;
    }
    setPreflight(res.value);
    const tone = res.value.transcription || res.value.live ? 'success' : 'warning';
    notify(formatPreflightToast(res.value, lang, asciiMode), tone);
  }, [busy, host, lang, asciiMode, notify]);

  const handleRetryJob = useCallback(async () => {
    if (busy) return;
    if (!selectedJob || !selectedJob.retryable) {
      notify(
        t(lang, '请先选择一条失败或已取消的音频任务', 'No failed or canceled audio job selected'),
        'warning',
      );
      return;
    }
    setBusy(true);
    const res = await tryAction<{ jobId?: string; id?: string }>(host, 'audio.retry', {
      jobId: selectedJob.retryJobId,
    });
    setBusy(false);
    if (!res.ok) {
      notify(res.error?.message || t(lang, '重试音频任务失败', 'Failed to retry audio job'), 'error');
      return;
    }
    await Promise.all([refresh(), loadAudioData()]);
    notify(t(lang, '已重新启动音频任务', 'Audio job retry started'), 'success');
  }, [busy, selectedJob, host, lang, notify, refresh, loadAudioData]);

  const handleSaveKey = useCallback(async () => {
    if (busy) return;
    const chosen = PROVIDERS[providerIdx] ?? PROVIDERS[0];
    setBusy(true);
    const res = await tryAction<AudioSettingsInfo>(host, 'audio.settings.set', {
      [chosen.field]: apiKeyInput.trim(),
    });
    setBusy(false);
    if (!res.ok) {
      notify(res.error?.message || t(lang, '保存音频设置失败', 'Failed to save audio settings'), 'error');
      return;
    }
    if (res.value) setAudioSettings(res.value);
    setApiKeyInput('');
    notify(t(lang, '已保存转写服务密钥', 'Transcription key saved'), 'success');
    void loadAudioData();
  }, [busy, providerIdx, host, apiKeyInput, notify, lang, loadAudioData]);

  const handleTestProviders = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    const res = await tryAction<Record<string, { ok?: boolean; message?: string }>>(host, 'audio.test', {});
    setBusy(false);
    if (!res.ok) {
      notify(res.error?.message || t(lang, '连通性测试失败', 'Connectivity test failed'), 'error');
      return;
    }
    setTestReport(res.value ?? {});
    notify(t(lang, '转写服务检测完成', 'Provider test complete'), 'info');
  }, [busy, host, lang, notify]);

  const handleReviewTrigger = useCallback(() => {
    if (busyRef.current || busy) return;
    if (!selectedResult) {
      notify(t(lang, '请先选择一条转写记录', 'Please select a transcript first'), 'info');
      return;
    }
    if (correctionsSummary.pending === 0) {
      notify(
        t(lang, '当前逐字稿没有待复核的存疑处', 'No pending uncertain corrections for this transcript'),
        'info',
      );
      return;
    }
    setConfirmReview({
      sourceId: String(selectedResult.sourceId || selectedResult.id),
      title: String(selectedResult.title || selectedResult.id),
      pending: correctionsSummary.pending,
    });
  }, [busy, selectedResult, correctionsSummary.pending, lang, notify]);

  const handleStartReview = useCallback(
    async (sourceId: string) => {
      if (busyRef.current || busy) return;
      busyRef.current = true;
      setBusy(true);
      try {
        const res = await tryAction<{ id?: string; jobId?: string }>(host, 'audio.corrections.review', { sourceId });
        if (!mountedRef.current) return;
        if (!res.ok) {
          notify(res.error?.message || t(lang, '启动存疑复核任务失败', 'Failed to start corrections review job'), 'error');
          return;
        }
        await Promise.all([loadAudioData(), refresh()]);
        if (!mountedRef.current) return;
        notify(t(lang, '已启动存疑复核任务', 'Started corrections review job'), 'success');
      } finally {
        busyRef.current = false;
        if (mountedRef.current) setBusy(false);
      }
    },
    [busy, host, lang, notify, loadAudioData, refresh],
  );

  const handleExportMarkdown = useCallback(async () => {
    if (exportBusyRef.current) return;
    if (!selectedResult) {
      notify(
        t(lang, '请先选择一条音频转写记录', 'Select an audio transcript first'),
        'info',
      );
      return;
    }
    exportBusyRef.current = true;
    const ell = asciiMode ? '...' : '…';
    try {
      let detail: AudioResultItem | null = null;
      if (activeTranscript.id === selectedResult.id && activeTranscript.detail) {
        detail = activeTranscript.detail;
      } else if (
        (typeof selectedResult.text === 'string' && selectedResult.text.length > 0) ||
        (typeof selectedResult.transcript === 'string' && selectedResult.transcript.length > 0) ||
        (Array.isArray(selectedResult.segments) && selectedResult.segments.length > 0)
      ) {
        detail = selectedResult;
      } else {
        const detailRes = await fetchAudioSourceDetail(host, selectedResult.id);
        if (!mountedRef.current) return;
        if (!detailRes.ok || !detailRes.value) {
          const msg = detailRes.error?.message || t(lang, '加载转写正文失败', 'Failed to load transcript detail');
          setDetailError({ id: selectedResult.id, message: msg });
          notify(t(lang, `导出转写失败: ${msg}`, `Failed to export transcript: ${msg}`), 'error');
          return;
        }
        detail = detailRes.value;
        setDetailError(null);
        setActiveTranscript({
          id: selectedResult.id,
          text: String(detailRes.value.transcript || detailRes.value.text || ''),
          detail: detailRes.value,
        });
      }

      const markdown = formatAudioTranscriptMarkdown({
        result: selectedResult,
        detail,
        lang,
        generatedAt: new Date(),
      });

      const rawRoot =
        bindingRoot?.trim() ||
        host.getLibraryRoot?.()?.trim() ||
        host.getConfig?.()?.libraryRoot?.trim() ||
        snapshotRoot?.trim() ||
        '';
      const baseDir = rawRoot ? resolve(rawRoot) : process.cwd();
      const exportSlugLabel = String(
        detail?.title ||
          selectedResult.title ||
          selectedResult.courses?.[0] ||
          selectedResult.course ||
          selectedResult.id ||
          '',
      ).trim();
      const rawTargetPath = defaultBackupFilePath(baseDir, 'studyhub-audio', 'md', exportSlugLabel || undefined);

      const { path: targetPath } = await atomicWriteExportText(rawTargetPath, markdown);
      if (!mountedRef.current) return;
      const arrow = asciiMode ? '->' : '→';
      const label = truncateDisplay(String(detail?.title || selectedResult.title || selectedResult.id), 28, ell);
      notify(
        t(
          lang,
          `已导出逐字稿「${label}」 ${arrow} ${targetPath}`,
          `Exported transcript "${label}" ${arrow} ${targetPath}`,
        ),
        'success',
      );
    } catch (err) {
      if (!mountedRef.current) return;
      const msg = err instanceof Error ? err.message : String(err);
      notify(t(lang, `导出转写失败: ${msg}`, `Failed to export transcript: ${msg}`), 'error');
    } finally {
      exportBusyRef.current = false;
    }
  }, [activeTranscript, asciiMode, bindingRoot, host, lang, notify, selectedResult, snapshotRoot]);

  const configuredProviders = useMemo(() => {
    if (!audioSettings) return [];
    const list: string[] = [];
    if (audioSettings.siliconflowKey?.set) list.push('硅基流动 SenseVoice');
    if (audioSettings.groqKey?.set) list.push('Groq Whisper');
    if (audioSettings.freeKey?.set) list.push('Gemini Free');
    if (audioSettings.paidKey?.set) list.push('Gemini Paid');
    return list;
  }, [audioSettings]);

  useInputCapture(isActive && (overlay !== 'none' || confirmReview !== null || filterEditing));

  const hints: KeyHint[] = useMemo(
    () => [
      ...(selectedItem ? [activePane === 'right'
        ? { key: 'Esc', label: t(lang, '返回列表', 'Back to list') }
        : { key: 'Enter', label: t(lang, '查看详情', 'Detail') }] : []),
      { key: 'i', label: t(lang, '导入音频', 'Import Audio') },
      { key: 'u', label: t(lang, '导入字幕', 'Subtitles') },
      { key: 'p', label: t(lang, '预检', 'Preflight') },
      { key: 'c', label: t(lang, '复核存疑', 'Review') },
      { key: 'R', label: t(lang, '重试任务', 'Retry Job') },
      { key: 's', label: t(lang, '转写设置', 'Providers') },
      { key: 't', label: t(lang, '测试连通', 'Test Keys') },
      { key: 'g', label: t(lang, '据此出题', 'Generate') },
      { key: 'Ctrl+R', label: t(lang, '刷新', 'Refresh') },
      { key: '/', label: t(lang, '筛选', 'Filter') },
      { key: 'x', label: t(lang, '导出MD', 'Export') },
      ...(activePane === 'left' && filterQuery ? [{ key: 'Esc', label: t(lang, '清筛选', 'Clear') }] : []),
    ],
    [lang, filterQuery, activePane, selectedItem],
  );
  useFooterHints(hints, isActive);

  const pageActive = useKeyScope({
    id: 'AudioView:main',
    active: isActive,
    keys: CLAIMED_KEYS,
    onKey: (input, key) => {
      if (activePane === 'right' && (key.escape || key.leftArrow || key.tab)) {
        setActivePane('left');
        return true;
      }
      if (activePane === 'left' && selectedItem && (key.rightArrow || key.tab)) {
        setActivePane('right');
        return true;
      }
      if (key.escape && filterQuery) {
        setFilterQuery('');
        setSelectedIndex(0);
        return true;
      }
      if (input === '/' && !key.ctrl && !key.meta) {
        setActivePane('left');
        setFilterEditing(true);
        return true;
      }
      if (input === 'x' && !key.ctrl && !key.meta) {
        void handleExportMarkdown();
        return true;
      }
      if (input === 'i') {
        setImportField('path');
        setOverlay('import');
        return true;
      }
      if (input === 'u') {
        setSubtitleField('path');
        setOverlay('subtitle');
        return true;
      }
      if (input === 'p') {
        void handlePreflight();
        return true;
      }
      if (input === 'c') {
        handleReviewTrigger();
        return true;
      }
      if (input === 'R') {
        void handleRetryJob();
        return true;
      }
      if (input === 's') {
        setOverlay('settings');
        return true;
      }
      if (input === 't') {
        void handleTestProviders();
        return true;
      }
      if (key.ctrl && input === 'r') {
        setDetailError(null);
        setActiveTranscript({ id: '', text: '', detail: null });
        void Promise.all([loadAudioData(), refresh()]);
        return true;
      }
      if (input === 'g' && selectedResult) {
        const targetId = selectedResult.sourceId || selectedResult.id;
        navigate('generate', {
          sourceIds: [targetId],
          ...(selectedResult.courses?.[0] ? { course: selectedResult.courses[0] } : focusCourse ? { course: focusCourse } : {}),
        });
        return true;
      }
      return false;
    },
  });

  const narrowBar = width < LAYOUT_BP.NARROW;
  const bannerH = 2;
  const diagH = 4;
  const showFilterBar = filterEditing || filterQuery.length > 0;
  const filterBarH = showFilterBar ? 1 : 0;
  const splitH = Math.max(4, height - bannerH - diagH - filterBarH);
  const ell = asciiMode ? '...' : '…';
  const diagInnerW = Math.max(10, width - 4);
  const preflightLine = truncateDisplay(formatPreflightLine(preflight, lang, asciiMode), diagInnerW, ell);
  const usageLine = truncateDisplay(formatUsageLine(usage, lang, asciiMode), diagInnerW, ell);
  const filterBadge = `[${filterEditing ? t(lang, '筛选', 'Filter') : t(lang, '已筛选', 'Filtered')} ${filteredResults.length}/${results.length}] `;
  const { rightHint: filterRightHint, inputWidth: filterInputW } = computeFilterBarLayout(width, filterBadge, lang, filterEditing);

  return (
    <Box flexDirection="column" width={width} height={height}>
      {/* Top Status Banner */}
      <Box height={bannerH} width={width} paddingX={1} flexDirection="column">
        <Box flexDirection="row" alignItems="center" width={Math.max(10, width - 2)}>
          <Box flexShrink={0}>
            <Text bold color={theme.primary} wrap={asciiMode ? undefined : 'truncate-end'}>
              {narrowBar
                ? asciiMode
                  ? t(lang, '> 音频转写', '> Audio')
                  : t(lang, '♪ 音频转写', '♪ Audio')
                : asciiMode
                  ? t(lang, '> 音频转写工作台', '> Audio Transcription')
                  : t(lang, '♪ 音频转写工作台', '♪ Audio Transcription')}
            </Text>
          </Box>
          <Text> </Text>
          <Box flexShrink={0}>
            <StatusPill
              label={
                configuredProviders.length > 0
                  ? configuredProviders.join(asciiMode ? ' | ' : ' · ')
                  : t(lang, '未配置密钥', 'No key')
              }
              status={configuredProviders.length > 0 ? 'ok' : 'warn'}
            />
          </Box>
          <Box flexGrow={1} />
          {!narrowBar ? (
            <Box flexShrink={1} overflow="hidden">
              <Text color={theme.dim} wrap={asciiMode ? undefined : 'truncate-end'}>
                {t(
                  lang,
                  '[i] 音频  [u] 字幕  [p] 预检  [c] 复核  [R] 重试  [s] 密钥',
                  '[i] Audio  [u] Sub  [p] Check  [c] Review  [R] Retry  [s] Keys',
                )}
              </Text>
            </Box>
          ) : null}
        </Box>
        <Text color={theme.dim} wrap={asciiMode ? undefined : 'truncate-end'}>
          {truncateDisplay(
            t(
              lang,
              '说明：实时麦克风录音需要桌面/浏览器音频捕获，纯终端模式已禁用；可导入本地录音或字幕文件。',
              'Note: Live mic capture is disabled in terminal mode. Import local audio or subtitle files below.',
            ),
            Math.max(10, width - 2),
            ell,
          )}
        </Text>
      </Box>

      {/* Compact Diagnostics & Quota Section */}
      <Panel
        title={t(lang, '诊断与配额', 'Diagnostics & Quota')}
        subtitle={
          preflight
            ? preflight.transcription
              ? t(lang, '[p] 就绪', '[p] Ready')
              : t(lang, '[p] 待配置', '[p] Setup')
            : t(lang, '[p] 预检', '[p] Check')
        }
        tone={preflight ? (preflight.transcription ? 'success' : 'warning') : undefined}
        width={width}
        height={diagH}
      >
        <Text color={preflight?.transcription ? theme.text : theme.warning}>{preflightLine}</Text>
        <Text color={theme.muted}>{usageLine}</Text>
      </Panel>

      {/* Inline Live Filter Bar ([/]) */}
      {showFilterBar ? (
        <KeyScope id="audio:filter" opaque active={isActive && filterEditing}>
          <Box height={1} width={width} backgroundColor={theme.surface} overflow="hidden" paddingX={1}>
            <Text color={filterEditing ? theme.primary : theme.accent} bold>
              {filterBadge}
            </Text>
            <Box flexGrow={1} overflow="hidden">
              <TextInput
                value={filterQuery}
                onChange={(val) => {
                  setFilterQuery(val);
                  setSelectedIndex(0);
                }}
                onSubmit={(val) => {
                  if (!val.trim()) setFilterQuery('');
                  setFilterEditing(false);
                }}
                onCancel={() => {
                  setFilterQuery('');
                  setFilterEditing(false);
                  setSelectedIndex(0);
                }}
                isActive={isActive && filterEditing}
                width={filterInputW}
                prompt="/"
                placeholder={t(lang, `标题/课程/文件名/正文${ell}`, `title/course/file/text${ell}`)}
                maxLength={120}
              />
            </Box>
            {filterRightHint ? (
              <Text color={theme.dim} wrap="truncate">
                {filterRightHint}
              </Text>
            ) : null}
          </Box>
        </KeyScope>
      ) : null}

      {/* Main SplitPane */}
      <Box height={splitH} width={width}>
        <SplitPane
          width={width}
          height={splitH}
          leftWidth={0.42}
          activePane={activePane}
          leftLabel={t(lang, '转写文稿', 'Transcripts')}
          rightLabel={t(lang, '正文预览', 'Transcript Text')}
          left={({ width: lw, height: lh }) => (
            <Panel
              title={
                audioJobs.length > 0
                  ? t(lang, '音频任务与转写稿', 'Audio Jobs & Transcripts')
                  : t(lang, '已完成转写稿', 'Completed Transcripts')
              }
              badge={normalizedFilter ? `${filteredResults.length}/${results.length}` : leftItems.length}
              width={lw}
              height={lh}
              focused={pageActive && activePane === 'left'}
            >
              {loadingList ? (
                <Spinner label={asciiMode ? t(lang, '加载转写记录...', 'Loading transcripts...') : t(lang, '加载转写记录…', 'Loading transcripts…')} />
              ) : leftItems.length === 0 ? (
                resultsError && !normalizedFilter ? (
                  <EmptyState
                    icon={asciiMode ? '!' : '▲'}
                    title={t(lang, '加载音频转写记录失败', 'Failed to load transcripts')}
                    hint={truncateDisplay(
                      `${resultsError} — ${t(lang, '按 [Ctrl+R] 重试', 'Press [Ctrl+R] to retry')}`,
                      Math.max(20, (lw - 4) * 2),
                      ell,
                    )}
                    actions={[{ key: 'Ctrl+R', label: t(lang, '重试', 'Retry') }]}
                    width={Math.max(12, lw - 4)}
                    height={Math.max(4, lh - 2)}
                  />
                ) : normalizedFilter ? (
                  <EmptyState
                    title={t(lang, '无匹配的音频转写记录', 'No matching transcripts')}
                    hint={t(lang, '按 [Esc] 清除筛选，或按 [/] 修改关键词', 'Press [Esc] to clear filter or [/] to edit')}
                    width={Math.max(12, lw - 4)}
                    height={Math.max(4, lh - 2)}
                  />
                ) : (
                  <EmptyState
                    title={
                      configuredProviders.length > 0 || preflight?.transcription
                        ? t(lang, '暂无音频转写记录', 'No transcripts yet')
                        : t(lang, '暂无记录（未配置转写服务）', 'No transcripts (provider unset)')
                    }
                    hint={
                      configuredProviders.length > 0 || preflight?.transcription
                        ? t(
                            lang,
                            '转写服务已就绪：按 [i] 导入音频或 [u] 导入字幕',
                            'Ready: press [i] for audio or [u] for subtitles',
                          )
                        : t(
                            lang,
                            '按 [s] 配置转写服务，或按 [u] 直接导入字幕',
                            'Press [s] to configure providers or [u] for subtitles',
                          )
                    }
                    actions={
                      configuredProviders.length > 0 || preflight?.transcription
                        ? [
                            { key: 'i', label: t(lang, '导入音频', 'Audio') },
                            { key: 'u', label: t(lang, '导入字幕', 'Subtitles') },
                          ]
                        : [
                            { key: 's', label: t(lang, '配置转写', 'Providers') },
                            { key: 'u', label: t(lang, '导入字幕', 'Subtitles') },
                          ]
                    }
                    width={Math.max(12, lw - 4)}
                    height={Math.max(4, lh - 2)}
                  />
                )
              ) : (
                <Box flexDirection="column" width={Math.max(12, lw - 4)} height={Math.max(1, lh - 2)}>
                  {resultsError ? (
                    <Text color={theme.error} wrap="truncate">
                      {truncateDisplay(
                        `${t(lang, '列表加载失败', 'Load error')}: ${resultsError} (Ctrl+R)`,
                        Math.max(12, lw - 4),
                        ell,
                      )}
                    </Text>
                  ) : null}
                  <VirtualList
                    items={leftItems}
                    height={Math.max(1, lh - 2 - (resultsError ? 1 : 0))}
                    width={Math.max(12, lw - 4)}
                  selectedIndex={selectedIndex}
                  onChange={(idx) => setSelectedIndex(idx)}
                  onSelect={() => setActivePane('right')}
                  isActive={pageActive && activePane === 'left'}
                  keyExtractor={(item) => item.id}
                  renderItem={(item, ctx) => {
                    if (item.kind === 'job') {
                      const statusTag = `[${item.job.status.toUpperCase()}] `;
                      const maxW = Math.max(8, ctx.width - statusTag.length - 4);
                      const tagColor = item.job.retryable ? theme.error : theme.accent;
                      return (
                        <Box flexDirection="row" width={ctx.width}>
                          <Text color={ctx.selected ? theme.primary : theme.muted}>{ctx.selected ? (asciiMode ? '> ' : '▸ ') : '  '}</Text>
                          <Text color={tagColor}>{statusTag}</Text>
                          <Text color={theme.text} bold={ctx.selected}>
                            {truncateDisplay(item.job.title, maxW, ell)}
                          </Text>
                        </Box>
                      );
                    }
                    const r = item.result;
                    const label = String(r.title || r.id);
                    const courseTag = r.courses?.[0] ? `[${r.courses[0]}] ` : '';
                    const maxW = Math.max(8, ctx.width - courseTag.length - 5);
                    return (
                      <Box flexDirection="row" width={ctx.width}>
                        <Text color={ctx.selected ? theme.primary : theme.muted}>{ctx.selected ? (asciiMode ? '> ' : '▸ ') : '  '}</Text>
                        {courseTag ? <Text color={theme.accent}>{courseTag}</Text> : null}
                        <Text color={theme.text} bold={ctx.selected}>
                          {truncateDisplay(label, maxW, ell)}
                        </Text>
                      </Box>
                    );
                  }}
                  />
                </Box>
              )}
            </Panel>
          )}
          right={({ width: rw, height: rh }) => {
            const innerW = Math.max(12, rw - 4);
            const innerH = Math.max(2, rh - 2);
            const hasStatus = correctionsSummary.pending > 0 || correctionsSummary.applied > 0;
            const maxSamples = innerH >= 7 ? 3 : innerH >= 5 ? 1 : 0;
            const sampleItems = correctionsSummary.pending > 0 ? correctionsSummary.items.slice(0, maxSamples) : [];
            const statusMargin = hasStatus && innerH >= 6 ? 1 : 0;
            const headerRows = (hasStatus ? 1 : 0) + sampleItems.length + statusMargin;
            const scrollH = Math.max(2, innerH - headerRows);
            return (
              <Panel
                title={
                  selectedJob
                    ? selectedJob.title
                    : selectedResult?.title || t(lang, '文稿内容', 'Transcript')
                }
                subtitle={
                  selectedJob
                    ? selectedJob.retryable
                      ? t(lang, '[R] 重试任务', '[R] Retry')
                      : selectedJob.status
                    : selectedResult
                      ? correctionsSummary.pending > 0
                        ? t(lang, '[c] 复核存疑  [g] 出题', '[c] Review  [g] Gen')
                        : t(lang, '[g] 据此出题', '[g] Generate')
                      : undefined
                }
                width={rw}
                height={rh}
                focused={pageActive && activePane === 'right'}
              >
                {selectedJob ? (
                  <Box flexDirection="column" width={innerW}>
                    <Box flexDirection="row" alignItems="center">
                      <StatusPill label={selectedJob.status} status={jobPillStatus(selectedJob.status)} />
                      <Text color={theme.dim}>{`  ID: ${selectedJob.id}`}</Text>
                    </Box>
                    {selectedJob.phase ? (
                      <Box marginTop={1}>
                        <Text color={theme.muted}>
                          {truncateDisplay(`${t(lang, '阶段: ', 'Stage: ')}${selectedJob.phase}`, innerW, ell)}
                        </Text>
                      </Box>
                    ) : null}
                    {selectedJob.error ? (
                      <Box marginTop={1}>
                        <Text color={theme.error} wrap="wrap">
                          {`${t(lang, '原因: ', 'Error: ')}${selectedJob.error}`}
                        </Text>
                      </Box>
                    ) : null}
                    <Box marginTop={1}>
                      <Text color={selectedJob.retryable ? theme.primary : theme.dim}>
                        {selectedJob.retryable
                          ? t(lang, '按 [R] 重试此失败或已取消的音频任务。', 'Press [R] to retry this failed or canceled audio job.')
                          : t(lang, '任务进行中，请前往任务页查看进度。', 'Job is active; check Tasks view for progress.')}
                      </Text>
                    </Box>
                  </Box>
                ) : !selectedResult ? (
                  <EmptyState
                    title={t(lang, '选择一条转写记录查看全文', 'Select a transcript')}
                    width={innerW}
                    height={Math.max(4, rh - 2)}
                  />
                ) : (
                  <Box flexDirection="column" width={innerW} height={innerH}>
                    {hasStatus ? (
                      <Box flexDirection="column" marginBottom={statusMargin}>
                        <Box flexDirection="row" alignItems="center" width={innerW} height={1} overflow="hidden">
                          {correctionsSummary.pending > 0 ? (
                            <StatusPill
                              label={t(
                                lang,
                                `${correctionsSummary.pending} 处存疑待复核`,
                                `${correctionsSummary.pending} uncertain`,
                              )}
                              status="warn"
                            />
                          ) : (
                            <StatusPill
                              label={t(
                                lang,
                                `已校对 ${correctionsSummary.applied} 处`,
                                `${correctionsSummary.applied} fixed`,
                              )}
                              status="ok"
                            />
                          )}
                          {correctionsSummary.pending > 0 && correctionsSummary.applied > 0 && innerW >= 34 ? (
                            <>
                              <Text> </Text>
                              <Badge
                                label={t(
                                  lang,
                                  `已校对 ${correctionsSummary.applied} 处`,
                                  `${correctionsSummary.applied} fixed`,
                                )}
                                tone="success"
                                variant="soft"
                              />
                            </>
                          ) : null}
                        </Box>
                        {sampleItems.map((sample, idx) => (
                          <Text key={idx} color={theme.muted} wrap={asciiMode ? undefined : 'truncate-end'}>
                            {truncateDisplay(
                              `${sample.wrong || '?'} -> ${sample.right || '?'}${sample.reason ? ` (${sample.reason})` : ''}`,
                              innerW,
                              ell,
                            )}
                          </Text>
                        ))}
                      </Box>
                    ) : null}
                    {detailError && detailError.id === selectedResult.id ? (
                      <EmptyState
                        icon={asciiMode ? '!' : '▲'}
                        title={t(lang, '加载转写正文失败', 'Failed to load transcript')}
                        hint={truncateDisplay(
                          `${detailError.message} — ${t(lang, '按 [Ctrl+R] 重试', 'Press [Ctrl+R] to retry')}`,
                          Math.max(20, innerW * 2),
                          ell,
                        )}
                        actions={[{ key: 'Ctrl+R', label: t(lang, '重试', 'Retry') }]}
                        width={innerW}
                        height={scrollH}
                      />
                    ) : loadingDetailId === selectedResult.id ? (
                      <Box width={innerW} height={scrollH} alignItems="center" justifyContent="center">
                        <Spinner
                          label={asciiMode ? t(lang, '加载转写正文...', 'Loading transcript...') : t(lang, '加载转写正文…', 'Loading transcript…')}
                        />
                      </Box>
                    ) : (
                      <ScrollArea
                        key={selectedResult.id}
                        prose
                        content={
                          activeTranscript.id === selectedResult.id && activeTranscript.text
                            ? activeTranscript.text
                            : t(lang, '（暂无转写正文）', '(Empty transcript)')
                        }
                        width={innerW}
                        height={scrollH}
                        isActive={pageActive && activePane === 'right'}
                        ascii={asciiMode}
                      />
                    )}
                  </Box>
                )}
              </Panel>
            );
          }}
        />
      </Box>

      {/* Import Audio Modal */}
      {overlay === 'import' ? (
        <KeyScope id="audio:import" opaque>
          <AudioOverlayHotkeys
            id="AudioView:import"
            isActive={isActive}
            onKey={(input, key) => {
              const order: ImportField[] = ['path', 'title', 'course'];
              const idx = order.indexOf(importField);
              if (key.downArrow || (key.ctrl && input === 'n')) {
                setImportField(order[(idx + 1) % order.length]);
                return true;
              }
              if (key.upArrow || (key.ctrl && input === 'p')) {
                setImportField(order[(idx - 1 + order.length) % order.length]);
                return true;
              }
              if (key.ctrl && input === 's') {
                void handleImportSubmit();
                return true;
              }
              return false;
            }}
          />
          <Modal
            title={t(lang, '导入本地音频转写', 'Import Local Audio')}
            subtitle={asciiMode ? '.mp3 / .wav / .m4a / .ogg / .flac' : '.mp3 · .wav · .m4a · .ogg · .flac'}
            icon={asciiMode ? '>' : '♪'}
            width={72}
            isActive={isActive}
            onClose={() => setOverlay('none')}
            hints={[
              { key: 'Tab', label: t(lang, '路径补全', 'Complete') },
              { key: asciiMode ? 'Up/Down' : '↑/↓', label: t(lang, '切换字段', 'Field') },
              { key: 'Ctrl+S', label: t(lang, '开始转写', 'Transcribe') },
              { key: 'Esc', label: t(lang, '取消', 'Cancel') },
            ]}
          >
            <Text color={importField === 'path' ? theme.primary : theme.muted} bold={importField === 'path'}>
              {t(lang, '音频文件路径 (支持 ~, /, \\, C:\\...):', 'Audio file path (supports ~, /, \\, C:\\...):')}
            </Text>
            <TextInput
              value={audioPath}
              onChange={setAudioPath}
              onTab={handleTabComplete}
              onSubmit={() => void handleImportSubmit()}
              onCancel={() => setOverlay('none')}
              placeholder={process.platform === 'win32' ? 'C:\\Users\\...\\lecture.mp3' : '~/Downloads/lecture.mp3'}
              width={modalContentWidth(72) - 4}
              isActive={isActive && !busy && importField === 'path'}
              prompt={asciiMode ? '>' : '›'}
            />
            {pathMatches.length > 0 && importField === 'path' ? (
              <Text color={theme.dim}>{`${t(lang, '候选:', 'Matches:')} ${pathMatches.join('  ')}`}</Text>
            ) : null}

            <Box marginTop={1}>
              <Text color={importField === 'title' ? theme.primary : theme.muted} bold={importField === 'title'}>
                {t(lang, '标题 (可选):', 'Title (optional):')}
              </Text>
            </Box>
            <TextInput
              value={audioTitle}
              onChange={setAudioTitle}
              onSubmit={() => void handleImportSubmit()}
              onCancel={() => setOverlay('none')}
              width={modalContentWidth(72) - 4}
              isActive={isActive && !busy && importField === 'title'}
              prompt={asciiMode ? '>' : '›'}
            />

            <Box marginTop={1}>
              <Text color={importField === 'course' ? theme.primary : theme.muted} bold={importField === 'course'}>
                {t(lang, '课程归属 (可选):', 'Course (optional):')}
              </Text>
            </Box>
            <TextInput
              value={audioCourse}
              onChange={setAudioCourse}
              onSubmit={() => void handleImportSubmit()}
              onCancel={() => setOverlay('none')}
              width={modalContentWidth(72) - 4}
              isActive={isActive && !busy && importField === 'course'}
              prompt={asciiMode ? '>' : '›'}
            />

            {busy ? (
              <Box marginTop={1}>
                <Spinner label={asciiMode ? t(lang, '正在提交转写任务...', 'Submitting transcription...') : t(lang, '正在提交转写任务…', 'Submitting transcription…')} />
              </Box>
            ) : null}
          </Modal>
        </KeyScope>
      ) : null}

      {/* Import Subtitle Modal */}
      {overlay === 'subtitle' ? (
        <KeyScope id="audio:subtitle" opaque>
          <AudioOverlayHotkeys
            id="AudioView:subtitle"
            isActive={isActive}
            onKey={(input, key) => {
              const order: SubtitleField[] = ['path', 'course'];
              const idx = order.indexOf(subtitleField);
              if (key.downArrow || (key.ctrl && input === 'n')) {
                setSubtitleField(order[(idx + 1) % order.length]);
                return true;
              }
              if (key.upArrow || (key.ctrl && input === 'p')) {
                setSubtitleField(order[(idx - 1 + order.length) % order.length]);
                return true;
              }
              if (key.ctrl && input === 's') {
                void handleSubtitleSubmit();
                return true;
              }
              return false;
            }}
          />
          <Modal
            title={t(lang, '导入字幕文件校对', 'Import Subtitle File')}
            subtitle={asciiMode ? '.srt / .vtt / .txt / .json' : '.srt · .vtt · .txt · .json'}
            icon={asciiMode ? '>' : '♪'}
            width={72}
            isActive={isActive}
            onClose={() => setOverlay('none')}
            hints={[
              { key: 'Tab', label: t(lang, '路径补全', 'Complete') },
              { key: asciiMode ? 'Up/Down' : '↑/↓', label: t(lang, '切换字段', 'Field') },
              { key: 'Ctrl+S', label: t(lang, '导入字幕', 'Import') },
              { key: 'Esc', label: t(lang, '取消', 'Cancel') },
            ]}
          >
            <Text color={subtitleField === 'path' ? theme.primary : theme.muted} bold={subtitleField === 'path'}>
              {t(lang, '字幕文件路径 (.srt / .vtt / .txt):', 'Subtitle file path (.srt / .vtt / .txt):')}
            </Text>
            <TextInput
              value={subtitlePath}
              onChange={setSubtitlePath}
              onTab={handleSubtitleTabComplete}
              onSubmit={() => void handleSubtitleSubmit()}
              onCancel={() => setOverlay('none')}
              placeholder={process.platform === 'win32' ? 'C:\\Users\\...\\lecture.srt' : '~/Downloads/lecture.srt'}
              width={modalContentWidth(72) - 4}
              isActive={isActive && !busy && subtitleField === 'path'}
              prompt={asciiMode ? '>' : '›'}
            />
            {subtitleMatches.length > 0 && subtitleField === 'path' ? (
              <Text color={theme.dim}>{`${t(lang, '候选:', 'Matches:')} ${subtitleMatches.join('  ')}`}</Text>
            ) : null}

            <Box marginTop={1}>
              <Text color={subtitleField === 'course' ? theme.primary : theme.muted} bold={subtitleField === 'course'}>
                {t(lang, '课程归属 (可选):', 'Course (optional):')}
              </Text>
            </Box>
            <TextInput
              value={subtitleCourse}
              onChange={setSubtitleCourse}
              onSubmit={() => void handleSubtitleSubmit()}
              onCancel={() => setOverlay('none')}
              width={modalContentWidth(72) - 4}
              isActive={isActive && !busy && subtitleField === 'course'}
              prompt={asciiMode ? '>' : '›'}
            />

            {busy ? (
              <Box marginTop={1}>
                <Spinner label={asciiMode ? t(lang, '正在导入字幕...', 'Importing subtitles...') : t(lang, '正在导入字幕…', 'Importing subtitles…')} />
              </Box>
            ) : null}
          </Modal>
        </KeyScope>
      ) : null}

      {/* Audio Provider Settings Modal */}
      {overlay === 'settings' ? (
        <KeyScope id="audio:settings" opaque>
          <AudioOverlayHotkeys
            id="AudioView:settings"
            isActive={isActive}
            onKey={(input, key) => {
              if (key.upArrow) {
                setProviderIdx((i) => (i - 1 + PROVIDERS.length) % PROVIDERS.length);
                return true;
              }
              if (key.downArrow) {
                setProviderIdx((i) => (i + 1) % PROVIDERS.length);
                return true;
              }
              if (key.ctrl && input === 't') {
                void handleTestProviders();
                return true;
              }
              return false;
            }}
          />
          <Modal
            title={t(lang, '音频转写服务配置', 'Audio Transcription Providers')}
            width={72}
            isActive={isActive}
            onClose={() => setOverlay('none')}
            hints={[
              { key: asciiMode ? 'Up/Down' : '↑/↓', label: t(lang, '选择服务商', 'Provider') },
              { key: 'Enter', label: t(lang, '保存密钥', 'Save Key') },
              { key: 'Ctrl+T', label: t(lang, '测试连通', 'Test') },
              { key: 'Esc', label: t(lang, '关闭', 'Close') },
            ]}
          >
            <Box flexDirection="column" marginBottom={1}>
              {PROVIDERS.map((p, idx) => {
                const active = idx === providerIdx;
                const info = audioSettings?.[p.field] as AudioKeyState | undefined;
                const testRes = testReport?.[p.tier];
                return (
                  <Box key={p.field} flexDirection="row" alignItems="center">
                    <Text color={active ? theme.primary : theme.muted}>{active ? (asciiMode ? '> ' : '▸ ') : '  '}</Text>
                    <Text color={theme.text} bold={active}>{p.label}</Text>
                    <Text> </Text>
                    <Badge
                      label={info?.set ? `${t(lang, '已配置', 'Set')}${info.hint ? ` ${info.hint}` : ''}` : t(lang, '未配置', 'Unset')}
                      tone={info?.set ? 'success' : 'muted'}
                      variant="soft"
                    />
                    {testRes ? (
                      <Text color={testRes.ok ? theme.success : theme.error}>
                        {`${asciiMode ? ' | ' : ' · '}${testRes.ok ? 'OK' : testRes.message || 'Failed'}`}
                      </Text>
                    ) : null}
                  </Box>
                );
              })}
            </Box>

            <Text color={theme.primary} bold>
              {`${t(lang, '设置密钥', 'Set API Key')} (${PROVIDERS[providerIdx]?.label}):`}
            </Text>
            <TextInput
              value={apiKeyInput}
              onChange={setApiKeyInput}
              onSubmit={() => void handleSaveKey()}
              onCancel={() => setOverlay('none')}
              mask
              placeholder={t(lang, '输入 API Key (留空回车可清除)', 'Enter API key (blank + Enter to clear)')}
              width={modalContentWidth(72) - 4}
              isActive={isActive && !busy}
              prompt={asciiMode ? '>' : '›'}
            />
          </Modal>
        </KeyScope>
      ) : null}

      {/* P2 Quota Guard ConfirmDialog for AI Transcript Corrections Review ([c]) */}
      {confirmReview ? (
        <KeyScope id="audio:confirm-review" opaque>
          <ConfirmDialog
            title={t(lang, 'AI 复核转写存疑处', 'AI Review Uncertain Corrections')}
            message={t(
              lang,
              `将为「${truncateDisplay(confirmReview.title, 36, ell)}」调用已配置的文本模型，在后台任务中复核 ${confirmReview.pending} 处存疑项。确认继续吗？`,
              `Will invoke the configured text model in a background job to review ${confirmReview.pending} uncertain item(s) for "${truncateDisplay(confirmReview.title, 36, ell)}". Continue?`,
            )}
            confirmLabel={t(lang, '开始复核', 'Start Review')}
            cancelLabel={t(lang, '取消', 'Cancel')}
            width={60}
            isActive={isActive && overlay === 'none'}
            onConfirm={() => {
              const target = confirmReview;
              setConfirmReview(null);
              void handleStartReview(target.sourceId);
            }}
            onCancel={() => setConfirmReview(null)}
          />
        </KeyScope>
      ) : null}
    </Box>
  );
});
