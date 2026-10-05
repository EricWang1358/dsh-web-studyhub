import React, { useEffect, useId, useMemo, useRef, useState } from 'react';
import { ui, uiFormat } from './i18n.js';
import { useInjectCss } from './shared.js';
import { Button, FileDrop, Icon, InlineMessage, SegmentedControl } from './components/index.js';
import CourseField, { parseCourses } from './CourseField.jsx';
import { sourceFormatLabel } from './SourcePicker.jsx';
import LargeDocumentCard from './LargeDocumentCard.jsx';
import PdfConversion from './PdfConversion.jsx';
import { looksLikeConvertedJson } from '../lib/converted-document.js';
import { LARGE_DOCUMENT_LIMITS, classifyImportFailure } from '../lib/large-documents.js';
import { MAX_OFFICE_BYTES, MAX_TEXT_DOCUMENT_BYTES, maxBytesFor, megabytes } from '../lib/office/limits.js';
import { AUDIO_EXTENSIONS, MAX_SUBTITLE_BYTES, SUBTITLE_TIMED_EXTENSIONS } from '../lib/audio-formats.js';
import { useRetrievalStatus } from './retrieval-status.js';
import { IMPORT_ERROR } from '../lib/import-errors.js';
import { SELECTION_CHARS } from '../lib/limits.js';
import { extensionOf } from './file-names.js';
import { formatNumber } from './format.js';
import { toBase64 } from './upload.js';
import css from './import-hub.css';
import { hasContext } from './capabilities.js';
import { useStudy } from './study-context.jsx';

/* The one way to add material (O-3, O-4, P19–P21, P05). The course is chosen
   first; one drop zone takes documents, JSON decks and subtitles together and
   routes each file by type; pasting text and audio are the other two tabs.
   Every file shows its own status, failures stay next to the file with a plain
   reason, and a fully successful batch hands its summary to onComplete (the
   App closes the dialog, shows the toast and highlights the new material). */

/** PDF, Markdown, HTML and TXT. Word and PowerPoint have MAX_OFFICE_BYTES (one constant per format: lib/office/limits.js). */
export const MAX_DOCUMENT_BYTES = MAX_TEXT_DOCUMENT_BYTES;
export { MAX_OFFICE_BYTES };
export const MAX_DECK_BYTES = 2_000_000;
/** PDF and text documents (the compact DocumentImport takes only these; Word and PowerPoint go through the hub). */
export const DOCUMENT_EXTENSIONS = ['.pdf', '.md', '.markdown', '.html', '.htm', '.txt'];
const OFFICE_EXTENSIONS = ['.docx', '.pptx'];
// Documents in the order the native picker shows them: .docx and .pptx right after .pdf.
const HUB_DOCUMENTS = ['.pdf', ...OFFICE_EXTENSIONS, ...DOCUMENT_EXTENSIONS.slice(1)];
/* Old Office and other word-processor formats are accepted only to explain, per file, what to do instead. */
const LEGACY_EXTENSIONS = ['.doc', '.ppt', '.wps', '.key', '.pages'];
const DECK_EXTENSIONS = ['.json'];
const SUBTITLE_EXTENSIONS = SUBTITLE_TIMED_EXTENSIONS;
// '.json' is only a document when it is a converter's output (MinerU, Docling); a question deck takes the deck route.
const FORMAT_OF = { '.pdf': 'pdf', '.docx': 'docx', '.pptx': 'pptx', '.md': 'md', '.markdown': 'md', '.html': 'html', '.htm': 'html', '.txt': 'txt', '.json': 'json' };

/** The size limit of a file, by its format. */
export const documentLimit = name => maxBytesFor(FORMAT_OF[extensionOf(name)]);

const LEGACY_MESSAGES = {
  '.doc': '暂不支持旧版 .doc，请在 Word 里另存为 .docx 或 PDF 后再导入。',
  '.ppt': '暂不支持旧版 .ppt，请在 PowerPoint 里另存为 .pptx 或 PDF 后再导入。',
  '.wps': '暂不支持 .wps 文件，请在 WPS 里另存为 .docx 或 PDF 后再导入。',
  '.key': '暂不支持 Keynote（.key），请在 Keynote 里导出为 PowerPoint 或 PDF 后再导入。',
  '.pages': '暂不支持 Pages（.pages），请在 Pages 里导出为 Word 或 PDF 后再导入。',
};

/**
 * Extensions the drop zone accepts, documents first (the native picker shows one
 * long list and cuts it off at the end). Subtitles and audio need the audio
 * component; audio stays so a dropped recording is routed to its own tab.
 */
export function importAccept({ audio = false } = {}) {
  return [...HUB_DOCUMENTS, ...DECK_EXTENSIONS, ...LEGACY_EXTENSIONS, ...(audio ? [...SUBTITLE_EXTENSIONS, ...AUDIO_EXTENSIONS] : [])];
}

/** 'document' | 'deck' | 'subtitle' | 'audio' | 'legacy' | null for a dropped file. */
export function routeImportFile(file, { audio = false } = {}) {
  const extension = extensionOf(file?.name);
  if (LEGACY_EXTENSIONS.includes(extension)) return 'legacy';
  if (HUB_DOCUMENTS.includes(extension)) return 'document';
  if (DECK_EXTENSIONS.includes(extension)) return 'deck';
  if (audio && SUBTITLE_EXTENSIONS.includes(extension)) return 'subtitle';
  if (audio && AUDIO_EXTENSIONS.includes(extension)) return 'audio';
  return null;
}

/** Bilibili-style subtitle JSON ({ body: [{ from, to, content }] }) rather than a question deck. */
export function looksLikeSubtitleJson(text) {
  try {
    const value = JSON.parse(String(text).replace(/^﻿/, ''));
    const body = Array.isArray(value) ? value : value?.body;
    return Array.isArray(body) && body.length > 0 && !Array.isArray(value?.cards) &&
      body.every(cue => cue && typeof cue === 'object' && 'content' in cue && ('from' in cue || 'to' in cue));
  } catch { return false; }
}

/* Why an import failed, in words a student can act on. The host sends a code (lib/import-errors.js; Word and PowerPoint
   failures carry OfficeFileError's own) and, for a limit, the number it enforced: the sentence is picked by the code and
   prints that number, so a limit changed in lib/ changes what is read here. `format` is the file's own format, known to
   the panel, for the two Office messages. */
const damaged = ({ format }) => format === 'pptx'
  ? ui('这个 PowerPoint 文件读不出来（可能已损坏）。请在 PowerPoint 里重新另存为 .pptx 后再试。')
  : ui('这个 Word 文件读不出来（可能已损坏）。请在 Word 里重新另存为 .docx 后再试。');
const protectedFile = () => ui('这个文件有密码保护，或是旧版格式。请去掉密码并另存为 .docx、.pptx 或 PDF 后再导入。');
const tooBigUnpacked = () => ui('这个文件展开后太大或格式特殊，无法读取。请拆分，或另存为 PDF 后再导入。');
const IMPORT_COPY = {
  [IMPORT_ERROR.PDF_INVALID]: ({ limit = MAX_TEXT_DOCUMENT_BYTES }) => uiFormat('这个 PDF 读不出来（可能已损坏或超过 {0} MB）。请重新导出 PDF 后再试。', [megabytes(limit)]),
  [IMPORT_ERROR.DOCUMENT_TOO_LARGE]: ({ limit = MAX_TEXT_DOCUMENT_BYTES }) => uiFormat('文件超过 {0} MB。请按章节拆分后再导入。', [megabytes(limit)]),
  [IMPORT_ERROR.OFFICE_TOO_LARGE]: ({ limit = MAX_OFFICE_BYTES }) => uiFormat('文件超过 {0} MB。请压缩图片或拆分后再导入。', [megabytes(limit)]),
  [IMPORT_ERROR.TOO_MANY_PAGES]: ({ limit = LARGE_DOCUMENT_LIMITS.pdfPages }) => uiFormat('PDF 超过 {0} 页。请按章节拆分后再导入。', [limit]),
  [IMPORT_ERROR.TEXT_TOO_LONG]: ({ limit = SELECTION_CHARS }) => uiFormat('提取出的文字超过 {0} 字符。请按章节拆分后再导入。', [formatNumber(limit)]),
  [IMPORT_ERROR.NOT_UTF8]: () => ui('文本文件需要是 UTF-8 编码。请在编辑器里“另存为 UTF-8”后再导入。'),
  [IMPORT_ERROR.UNSUPPORTED_FORMAT]: () => ui('不支持这种文件。可以导入 PDF、Word、PowerPoint、Markdown、HTML、TXT、JSON 题组和字幕。'),
  [IMPORT_ERROR.UPLOAD_INCOMPLETE]: () => ui('文件没能完整读取，请重试。'),
  // OfficeFileError codes (lib/office/zip.js): unreadable package, locked or old file, unpacked size.
  corrupt: damaged, invalid: damaged, xml: damaged, 'not-zip': damaged, 'unsupported-method': damaged,
  encrypted: protectedFile, ole: protectedFile,
  zip64: tooBigUnpacked, bomb: tooBigUnpacked, 'too-many-entries': tooBigUnpacked,
};
// Failures that repeat when tried again (size, encoding, format, no text); only an interrupted upload is worth a retry.
const RETRYABLE = new Set([IMPORT_ERROR.UPLOAD_INCOMPLETE]);
/* Only for a host that sends words and no code (it predates lib/import-errors.js): the wording picks the code. Delete this
   table once no such host is supported; the copy above stays. */
const OLD_HOST_WORDING = [
  [/not a valid PDF|不是有效 PDF|PDF 文件无效|PDF is invalid/i, IMPORT_ERROR.PDF_INVALID],
  [/exceeds 40 MB|at most 40 MB|超过 40 MB/i, IMPORT_ERROR.OFFICE_TOO_LARGE],
  [/not a valid DOCX/i, 'corrupt', { format: 'docx' }],
  [/not a valid PPTX/i, 'corrupt', { format: 'pptx' }],
  [/password-protected or in an old format/i, 'encrypted'],
  [/too large when unpacked|ZIP64/i, 'bomb'],
  [/exceeds 8 MB|at most 8 MB|超过 8 MB|8 MB/i, IMPORT_ERROR.DOCUMENT_TOO_LARGE],
  [/UTF-8/i, IMPORT_ERROR.NOT_UTF8],
  [/200 (?:页|pages)/i, IMPORT_ERROR.TOO_MANY_PAGES],
  [/600,000/, IMPORT_ERROR.TEXT_TOO_LONG],
  [/Supported document formats/i, IMPORT_ERROR.UNSUPPORTED_FORMAT],
  [/dataBase64/i, IMPORT_ERROR.UPLOAD_INCOMPLETE],
];
const limitOf = error => [error?.limit, error?.details?.limit].find(Number.isFinite);

/** { code, limit?, format? } when the failure is one this panel can explain, else null. */
function classifyImport(error, context = {}) {
  if (typeof error?.code === 'string' && Object.hasOwn(IMPORT_COPY, error.code)) return { code: error.code, limit: limitOf(error), format: context.format };
  const message = String(error?.message ?? error ?? '');
  const hit = OLD_HOST_WORDING.find(([pattern]) => pattern.test(message));
  return hit ? { code: hit[1], format: context.format, ...hit[2] } : null;
}
/* Failures that will repeat on retry. */
const permanentError = (message, extra) => Object.assign(new Error(message), { permanent: true, ...extra });
const limitError = (code, limit) => permanentError(IMPORT_COPY[code]({ limit }), { code, limit });
export function isPermanentImportError(error, context) {
  if (error?.permanent) return true;
  const found = classifyImport(error, context);
  return !!found && !RETRYABLE.has(found.code);
}

/** A failure in words a student can act on; unknown messages are kept as they are. */
export function plainImportError(error, context) {
  const found = classifyImport(error, context);
  if (found) return IMPORT_COPY[found.code](found);
  return String(error?.message ?? error ?? '').trim() || ui('导入失败，请重试。');
}

/* One document through the ordinary import (a PDF, Word, text, or a converter's JSON/Markdown). */
async function importDocumentFile(file, { call, courses = [] }) {
  const limit = documentLimit(file.name);
  if (file.size > limit) throw limitError(limit > MAX_DOCUMENT_BYTES ? IMPORT_ERROR.OFFICE_TOO_LARGE : IMPORT_ERROR.DOCUMENT_TOO_LARGE, limit);
  const value = await call('materials.document.import', { dataBase64: await toBase64(file), filename: file.name, courses });
  const sourceIds = value?.sourceIds || value?.document?.sourceIds || [];
  const format = value?.document?.format || FORMAT_OF[extensionOf(file.name)];
  const converted = value?.document?.sources?.find(source => source?.document?.converter)?.document.converter;
  if (!sourceIds.length) throw permanentError(format === 'pdf'
    ? ui('没有读到可用的文字，可能是扫描件或图片。请先做文字识别（OCR）再导入。')
    : format === 'pptx' ? ui('没有读到可用的文字，这份幻灯片可能全是图片。请先导出为带文字的 PDF 或补上文字再导入。') : ui('文件里没有可用的文字。'));
  return { kind: 'document', title: value?.document?.title || file.name, format, documentId: value?.documentId, sourceIds,
    pages: sourceIds.length, skippedPages: value?.skippedPages || [], ...(converted ? { converted } : {}) };
}

async function importOne(file, { call, courses = [], audio = false }) {
  const kind = routeImportFile(file, { audio });
  if (kind === 'audio') throw permanentError(ui('音频请在「音频 / 录音」里导入，那里会先转写成文字。'));
  if (kind === 'legacy') throw permanentError(ui(LEGACY_MESSAGES[extensionOf(file.name)]));
  if (!kind) throw permanentError(ui('不支持这种文件。可以导入 PDF、Word、PowerPoint、Markdown、HTML、TXT、JSON 题组和字幕。'));
  if (kind === 'document') return importDocumentFile(file, { call, courses });
  const text = await file.text();
  // A converter's JSON (WP28) is a textbook, not a question deck.
  if (kind === 'deck' && looksLikeConvertedJson(text)) return importDocumentFile(file, { call, courses });
  if (kind === 'deck' && !looksLikeSubtitleJson(text)) {
    if (file.size > MAX_DECK_BYTES) throw permanentError(ui('题组文件不能超过 2 MB。'));
    const proposal = await call('draft.import.propose', { text });
    const deck = await call('draft.import', { text, title: proposal?.title, course: courses[0] ?? proposal?.course ?? '' });
    return { kind: 'deck', title: deck.title, deck, count: deck.cards?.length || 0 };
  }
  if (!audio) throw permanentError(ui('这是字幕文件，需要启用音频组件后才能导入。'));
  if (file.size > MAX_SUBTITLE_BYTES) throw permanentError(uiFormat('字幕文件超过 {0} MB。', [megabytes(MAX_SUBTITLE_BYTES)]));
  const job = await call('audio.subtitles.import', { filename: file.name, text, courses });
  return { kind: 'subtitle', title: file.name, job };
}

/**
 * Import files one after another. onUpdate(index, { status, result?, error? })
 * reports 'working', then 'done' or 'error'. Resolves to
 * [{ file, status: 'done'|'error', result?, error?, permanent? }]; it never
 * throws. `permanent` errors repeat on retry (offer removal instead).
 */
export async function runImport(files, { call, courses = [], audio = false, onUpdate } = {}) {
  const results = [];
  for (const [index, file] of [...files].entries()) {
    onUpdate?.(index, { status: 'working' });
    try {
      const result = await importOne(file, { call, courses, audio });
      results.push({ file, status: 'done', result });
      onUpdate?.(index, { status: 'done', result });
    } catch (error) {
      const context = { format: routeImportFile(file, { audio }) === 'document' ? FORMAT_OF[extensionOf(file.name)] : undefined };
      const message = plainImportError(error, context), permanent = isPermanentImportError(error, context);
      // Too large to import as it is (WP28): the hub explains how a big book is used instead.
      const kind = classifyImportFailure(error), large = kind === 'pdf-size' || kind === 'pdf-pages' || kind === 'text-chars' ? kind : undefined;
      results.push({ file, status: 'error', error: message, permanent, ...(large ? { large } : {}) });
      onUpdate?.(index, { status: 'error', error: message, permanent, ...(large ? { large } : {}) });
    }
  }
  return results;
}

/** { done, failed, documents, decks, subtitles, sourceIds } of finished imports. */
export function importSummary(results) {
  const done = results.filter(item => item.status === 'done' && item.result);
  const of = kind => done.map(item => item.result).filter(result => result.kind === kind);
  const documents = of('document');
  return { done: done.length, failed: results.filter(item => item.status === 'error').length, documents,
    decks: of('deck').map(result => result.deck), subtitles: of('subtitle').map(result => ({ name: result.title, job: result.job })),
    sourceIds: documents.flatMap(document => document.sourceIds) };
}

/** The confirmation toast: “已导入「X」（N 页）” and what else happened. */
export function importDoneMessage({ documents = [], decks = [], subtitles = [], conversions = [] } = {}) {
  const parts = [];
  if (documents.length === 1) {
    const [document] = documents;
    parts.push(document.format !== 'pdf' && document.format !== 'pptx' ? uiFormat('已导入「{0}」', [document.title])
      : document.pages === 1 ? uiFormat('已导入「{0}」（1 页）', [document.title]) : uiFormat('已导入「{0}」（{1} 页）', [document.title, document.pages]));
  } else if (documents.length > 1) parts.push(uiFormat('已导入 {0} 份资料', [documents.length]));
  if (decks.length === 1) parts.push(uiFormat('题组「{0}」已存为草稿（{1} 题）', [decks[0].title, decks[0].cards?.length || 0]));
  else if (decks.length > 1) parts.push(uiFormat('{0} 个题组已存为草稿', [decks.length]));
  if (subtitles.length) parts.push(uiFormat('{0} 份字幕正在后台校对，完成后出现在资料页', [subtitles.length]));
  const providers = new Set(conversions.map(job => job.converter === 'marker' ? 'Marker' : 'MinerU'));
  const provider = providers.size === 1 ? [...providers][0] : '';
  if (conversions.length === 1) parts.push(uiFormat('「{0}」正在后台用 {2} 解析（{1} 页），进度在资料页', [conversions[0].name, conversions[0].pages, provider]));
  else if (conversions.length > 1) parts.push(provider
    ? uiFormat('{0} 份 PDF 正在后台用 {1} 解析，进度在资料页', [conversions.length, provider])
    : uiFormat('{0} 份 PDF 正在后台解析，进度在资料页', [conversions.length]));
  return parts.join(ui('；'));
}

/**
 * What the App does once an import is complete. From 创建题组 the new material
 * is ticked where the learner is; otherwise 资料 opens with it highlighted.
 * A single JSON deck opens its draft. Returns { page?, highlight?, select?,
 * openDraft?, notice: { text, tone, action?: 'generate' } } or null.
 */
export function importOutcome(summary, { page } = {}) {
  if (!summary?.done) return null;
  const ids = summary.sourceIds || [], decks = summary.decks || [], subtitles = summary.subtitles || [];
  const text = importDoneMessage(summary);
  if (ids.length && page === 'generate')
    return { select: ids, notice: { text: uiFormat('{0}。已勾选，可以直接生成题组。', [text]), tone: 'success' } };
  if (ids.length) return { page: 'sources', highlight: ids, select: ids, notice: { text, tone: 'success', action: 'generate' } };
  if (decks.length === 1 && !subtitles.length)
    return { openDraft: decks[0], notice: { text: uiFormat('已导入「{0}」共 {1} 题。可检查后直接发布。', [decks[0].title, decks[0].cards?.length || 0]), tone: 'success' } };
  if (decks.length) return { page: 'library', notice: { text, tone: 'success' } };
  return { page: 'sources', notice: { text, tone: 'success' } };
}

const isFileDrag = event => Array.from(event?.dataTransfer?.types || []).includes('Files');
const swallow = event => {
  event.preventDefault();
  event.stopPropagation();
  if (event.type !== 'drop' && event.dataTransfer) event.dataTransfer.dropEffect = 'none';
};

/**
 * Listener for the hub's own area, attached natively so it runs before the
 * dialog's drop guard (Dialog guardDrops refuses what lands on the header and
 * margins). Inner drop zones that took the file (they call preventDefault) keep
 * it; anything else is refused with a hint. Either way propagation stops here,
 * before the host sees it.
 */
export function hubDropHandler(onStray) {
  return event => {
    if (!isFileDrag(event)) return;
    event.stopPropagation();
    if (event.type !== 'dragover' && event.type !== 'drop') return;
    const handled = typeof event.isDefaultPrevented === 'function' ? event.isDefaultPrevented() : event.defaultPrevented;
    if (handled) return;
    swallow(event);
    onStray?.(event.type);
  };
}

const WORKING = { document: '正在保存并提取文字…', deck: '正在检查题目…', subtitle: '正在读取字幕…' };
const PENDING = { document: '讲义 / 笔记 → 资料', deck: '题组 JSON → 草稿', subtitle: '字幕 → 后台校对', audio: '音频' };

/** The line under a file in the hub: what it is, or what happened to it. */
export function itemDetail(item) {
  if (item.status === 'error') return item.error;
  if (item.status === 'working') return ui(WORKING[item.kind] || '处理中');
  if (item.status !== 'done') return PENDING[item.kind] ? ui(PENDING[item.kind]) : '';
  const result = item.result;
  if (result.kind === 'deck') return uiFormat('已存为草稿「{0}」 · {1} 题', [result.title, result.count]);
  if (result.kind === 'subtitle') return ui('已开始后台校对，完成后出现在资料页');
  const label = result.format === 'docx' ? ui('Word') : result.format === 'pptx'
    ? (result.sourceIds.length === 1 ? ui('PowerPoint · 1 页') : uiFormat('PowerPoint · {0} 页', [result.sourceIds.length]))
    : sourceFormatLabel({ format: result.format, sourceIds: result.sourceIds });
  return result.skippedPages?.length
    ? uiFormat('{0} · 第 {1} 页没有文字，已跳过', [label, result.skippedPages.join(ui('、'))])
    : uiFormat('{0} · 已保存到资料', [label]);
}

function PasteForm({ call, courses, disabled, draft, onDraft, onSaved }) {
  const [saving, setSaving] = useState(false), [error, setError] = useState('');
  const errorId = useId();
  async function submit(event) {
    event.preventDefault();
    setSaving(true); setError('');
    try {
      const source = await call('source.add', { title: draft.title, text: draft.text, courses });
      onDraft({ title: '', text: '' });
      await onSaved({ done: 1, failed: 0, documents: [{ kind: 'document', title: source?.title || draft.title, format: 'text', pages: 1, sourceIds: [source?.id].filter(Boolean) }],
        decks: [], subtitles: [], sourceIds: [source?.id].filter(Boolean) });
    } catch (failure) { setError(plainImportError(failure)); }
    finally { setSaving(false); }
  }
  return (
    <form className="import-hub__paste" onSubmit={submit}>
      <label>{ui('资料名称')}<input required value={draft.title} disabled={disabled || saving} placeholder={ui('例如：设计模式 · 第 4 章')}
        onChange={event => onDraft({ ...draft, title: event.target.value })} /></label>
      <label>{ui('原文')}<textarea required rows={10} maxLength={SELECTION_CHARS} value={draft.text} disabled={disabled || saving}
        aria-describedby={error ? errorId : undefined} placeholder={ui('粘贴讲义、笔记或材料。生成内容将引用这里的原文。')}
        onChange={event => onDraft({ ...draft, text: event.target.value })} /></label>
      {error && <InlineMessage id={errorId}>{error}</InlineMessage>}
      <div className="import-hub__paste-footer">
        <small>{uiFormat('{0} / {1} 字符', [formatNumber(draft.text.length), formatNumber(SELECTION_CHARS)])}</small>
        <Button type="submit" variant="primary" busy={saving} disabled={disabled}>{ui('保存资料')}</Button>
      </div>
    </form>
  );
}

/**
 * Props: data (for the course list), call(action, args), busy, course +
 * onCourseChange (course text, chosen first), audio (node for the audio tab;
 * omit when the audio component is off), initialTab 'files'|'paste'|'audio',
 * pasteDraft + onPasteDraftChange ({ title, text }, optional), onImported(summary)
 * after anything was saved (refresh data), onComplete(summary) when the batch
 * is finished without failures or the learner confirms a partial one, and
 * onOpenSources(sourceIds) to jump to a material the 解析历史 lists.
 */
export default function ImportHub({
  data,
  course,
  onCourseChange,
  audio,
  initialTab = 'files',
  pasteDraft,
  onPasteDraftChange,
  onImported,
  onComplete,
  onOpenSettings,
  onOpenSources,
  className,
  ...rest
}) {
  const { call, busy } = useStudy();
  useInjectCss(css, 'study-import-hub');
  const audioOn = audio !== undefined && audio !== null && audio !== false;
  const [tab, setTab] = useState(initialTab === 'audio' && !audioOn ? 'files' : initialTab);
  const [ownCourse, setOwnCourse] = useState(() => data?.focus?.course || '');
  const courseText = course ?? ownCourse, setCourseText = onCourseChange || setOwnCourse;
  const [ownDraft, setOwnDraft] = useState({ title: '', text: '' });
  const draft = pasteDraft ?? ownDraft, setDraft = onPasteDraftChange || setOwnDraft;
  const [items, setItemsState] = useState([]), itemsRef = useRef([]);
  const [running, setRunning] = useState(false), [stray, setStray] = useState(false);
  const root = useRef(null), alive = useRef(true), nextId = useRef(0), strayTimer = useRef(0), strayRef = useRef(null);
  const setItems = update => { itemsRef.current = typeof update === 'function' ? update(itemsRef.current) : update; setItemsState(itemsRef.current); };
  strayRef.current = type => {
    if (!alive.current) return;
    setStray(true);
    if (tab === 'paste' && !running) setTab('files');
    clearTimeout(strayTimer.current);
    strayTimer.current = setTimeout(() => { if (alive.current) setStray(false); }, type === 'drop' ? 4000 : 900);
  };
  const handleDrag = useMemo(() => hubDropHandler(type => strayRef.current?.(type)), []);
  // A file that is too large gets the 大教材建议 card; what DSH can search with is read once, then.
  const largeItem = items.find(item => item.status === 'error' && item.large);
  // The PDF conversion panel also handles files refused by the ordinary import size limit.
  const [converter, setConverter] = useState('mineru');
  const [conversionOpen, setConversionOpen] = useState(false), [conversionFile, setConversionFile] = useState(null), [conversionHistory, setConversionHistory] = useState(false);
  const { data: retrieval } = useRetrievalStatus({ enabled: !!largeItem });
  useEffect(() => {
    alive.current = true;
    const element = root.current, types = ['dragenter', 'dragover', 'dragleave', 'drop'];
    types.forEach(type => element?.addEventListener(type, handleDrag));
    return () => { alive.current = false; clearTimeout(strayTimer.current); types.forEach(type => element?.removeEventListener(type, handleDrag)); };
  }, [handleDrag]);

  const courses = parseCourses(courseText);
  // The conversion runs in the background as a job (progress is on the Sources page); the hub reports it and closes.
  async function conversionStarted(job) {
    const summary = { done: 1, failed: 0, documents: [], decks: [], subtitles: [], sourceIds: [], conversions: [{ name: job.filename, pages: job.pages, route: job.route, converter: job.converter, jobId: job.jobId }] };
    await onImported?.(summary);
    if (alive.current) onComplete?.(summary);
  }
  async function finish(summary, batchHasWork) {
    if (batchHasWork) await onImported?.(summary);
    if (!alive.current) return;
    const open = itemsRef.current.some(item => item.status !== 'done');
    if (!open) onComplete?.(importSummary(itemsRef.current));
  }
  async function run(batch) {
    setRunning(true);
    const results = await runImport(batch.map(item => item.file), { call, courses, audio: audioOn,
      onUpdate: (index, patch) => { if (alive.current) setItems(current => current.map(item => item.id === batch[index].id ? { ...item, ...patch } : item)); } });
    if (!alive.current) return;
    setRunning(false);
    const summary = importSummary(results);
    await finish(summary, summary.done > 0);
  }
  function add(files) {
    if (!files.length || busy || running) return;
    const names = new Set(files.map(file => file.name));
    const batch = files.map(file => ({ id: `file-${++nextId.current}`, file, name: file.name, kind: routeImportFile(file, { audio: audioOn }), status: 'pending' }));
    // A file dropped again replaces its failed attempt.
    setItems(current => [...current.filter(item => !(item.status === 'error' && names.has(item.name))), ...batch]);
    void run(batch);
  }
  function retry(id) {
    const item = itemsRef.current.find(entry => entry.id === id);
    if (!item || running) return;
    setItems(current => current.map(entry => entry.id === id ? { ...entry, status: 'pending', error: undefined } : entry));
    void run([item]);
  }
  const shown = items.map(item => ({ id: item.id, name: item.name, status: item.status, detail: itemDetail(item),
    action: item.status !== 'error' ? undefined : item.kind === 'audio' && audioOn ? { label: ui('去音频页'), onClick: () => setTab('audio') }
      : item.permanent || !item.kind ? { label: ui('移除'), onClick: () => setItems(current => current.filter(entry => entry.id !== item.id)), disabled: running }
        : { label: ui('重试'), onClick: () => retry(item.id), disabled: running } }));
  const finished = items.filter(item => item.status === 'done').length, failed = items.filter(item => item.status === 'error').length;
  const tabs = [{ value: 'files', label: ui('文件'), icon: 'upload' }, { value: 'paste', label: ui('粘贴文本'), icon: 'file' },
    ...(audioOn ? [{ value: 'audio', label: ui('音频 / 录音'), icon: 'audio' }] : [])];
  const strayText = tab === 'audio' ? ui('把音频放进虚线框里才会导入。') : ui('把文件放进虚线框里才会导入。');
  return (
    <div ref={root} className={`import-hub${className ? ` ${className}` : ''}`} data-tab={tab} {...rest}>
      <div className="import-hub__course">
        <CourseField label={ui('这些资料属于哪门课？')} value={courseText} onChange={setCourseText} courses={data?.focus?.courses || []}
          multiple disabled={busy || running} />
      </div>
      <SegmentedControl className="import-hub__tabs" label={ui('添加方式')} value={tab} options={tabs} disabled={running} onChange={setTab} />
      {stray && <p className="import-hub__stray" role="status"><Icon name="info" size={16} />{strayText}</p>}
      {tab === 'files' && <div className="import-hub__files">
        {!running && failed > 0 && <InlineMessage tone="warning" boxed className="import-hub__summary"
          title={finished ? uiFormat('{0} 个文件已导入，{1} 个没有导入', [finished, failed]) : uiFormat('{0} 个文件没有导入', [failed])}
          action={finished ? { label: ui('查看已导入的内容'), onClick: () => onComplete?.(importSummary(itemsRef.current)) } : undefined}>
          {ui('原因写在每个文件旁边。修正后可以重新拖进来。')}
        </InlineMessage>}
        {(!conversionOpen || items.length > 0 || largeItem) && <FileDrop className={stray ? 'is-attention' : undefined} accept={importAccept({ audio: audioOn })} multiple compact
          label={ui('把讲义、笔记或题组文件拖到这里，可以一次放多个')}
          hint={[audioOn ? ui('PDF · Word · PowerPoint · Markdown · HTML · TXT · JSON 题组 · SRT / VTT 字幕') : ui('PDF · Word · PowerPoint · Markdown · HTML · TXT · JSON 题组'),
            uiFormat('PDF 与文本最大 {0} MB，Word / PPT 最大 {1} MB', [megabytes(MAX_DOCUMENT_BYTES), megabytes(MAX_OFFICE_BYTES)])].join(' · ')}
          buttonLabel={ui('选择文件')} busy={running} disabled={busy && !running} items={shown}
          onFiles={accepted => add(accepted)} data-tour="import-drop" />}
        {largeItem && <LargeDocumentCard reason={largeItem.large} detail={{ name: largeItem.name, file: largeItem.file }} retrieval={retrieval} onOpenSettings={onOpenSettings}
          call={call} courses={data?.focus?.courses} defaultCourse={parseCourses(courseText)[0] || data?.focus?.course}
          conversionAvailable={hasContext(data, 'audio')} courseNames={courses} onConversionStarted={conversionStarted} />}
        {!largeItem && conversionOpen && <>
          <Button variant="link" size="sm" onClick={() => { setConversionOpen(false); setConversionHistory(false); }}>{ui('返回文件导入')}</Button>
          <PdfConversion available={hasContext(data, 'audio')} initialConverter={converter} file={conversionFile} onFile={setConversionFile} call={call} courses={courses} onStarted={conversionStarted} onOpenSettings={onOpenSettings}
          jobs={data?.jobs} historyOpen={conversionHistory} onOpenSources={onOpenSources} onOpenJob={job => void conversionStarted({ jobId: job.id, filename: job.filename, pages: job.pages, route: job.route, converter: job.converter })}
          onChanged={() => onImported?.()} />
        </>}
        {!conversionOpen && <section className="import-hub__conversion" aria-label={ui('PDF 解析方案')}>
          <p className="import-hub__routes">{ui('扫描件、公式多，或大文件？选择 PDF 解析方案。')}</p>
          {!hasContext(data, 'audio') && <InlineMessage tone="info">{ui('此安装未启用 PDF 解析组件。请在设置查看启用方式或手动转换说明。')}</InlineMessage>}
          <div className="import-hub__converters">
            <section className="import-hub__converter" aria-label="MinerU" data-tour="import-mineru">
              <h3>MinerU</h3>
              <p>{ui('在应用内解析 PDF，自动分段并导入。')}</p>
              <div className="import-hub__converter-actions">
                <Button size="sm" disabled={busy || running || !hasContext(data, 'audio')} onClick={() => { setConverter('mineru'); setConversionOpen(true); }}>{ui('用 MinerU 解析')}</Button>
                <Button variant="link" size="sm" disabled={busy || running} onClick={() => { setConversionHistory(true); setConversionOpen(true); }}>{ui('解析历史')}</Button>
              </div>
            </section>
            <section className="import-hub__converter" aria-label="Marker">
              <h3>Marker</h3><p>{ui('在应用内解析 PDF，自动分段并导入。')}</p>
              <div className="import-hub__converter-actions">
                <Button size="sm" disabled={busy || running || !hasContext(data, 'audio')} onClick={() => { setConverter('marker'); setConversionOpen(true); }}>{ui('用 Marker 解析')}</Button>
                {onOpenSettings && <Button variant="link" size="sm" disabled={busy || running} onClick={() => onOpenSettings('settings-marker')}>{ui('安装与使用设置')}</Button>}
              </div>
            </section>
          </div>
        </section>}
        {!items.length && !conversionOpen && <p className="import-hub__routes">{audioOn
          ? ui('讲义和笔记保存为资料，原文件一并保留；JSON 题组存为草稿；字幕在后台校对后成为资料。')
          : ui('讲义和笔记保存为资料，原文件一并保留；JSON 题组存为草稿。')}</p>}
      </div>}
      {tab === 'paste' && <PasteForm call={call} courses={courses} disabled={busy} draft={draft} onDraft={setDraft}
        onSaved={async summary => { await onImported?.(summary); if (alive.current) onComplete?.(summary); }} />}
      {tab === 'audio' && audioOn && <div className="import-hub__audio">{audio}</div>}
    </div>
  );
}
