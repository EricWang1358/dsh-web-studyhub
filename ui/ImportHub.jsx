import React, { useEffect, useId, useMemo, useRef, useState } from 'react';
import { ui, uiFormat } from './i18n.js';
import { useInjectCss } from './shared.js';
import { Button, FileDrop, Icon, InlineMessage, SegmentedControl } from './components/index.js';
import CourseField, { parseCourses } from './CourseField.jsx';
import { sourceFormatLabel } from './SourcePicker.jsx';
import css from './import-hub.css';

/* The one way to add material (O-3, O-4, P19–P21, P05). The course is chosen
   first; one drop zone takes documents, JSON decks and subtitles together and
   routes each file by type; pasting text and audio are the other two tabs.
   Every file shows its own status, failures stay next to the file with a plain
   reason, and a fully successful batch hands its summary to onComplete (the
   App closes the dialog, shows the toast and highlights the new material). */

const MB = 1024 * 1024;
export const MAX_DOCUMENT_BYTES = 8 * MB;
export const MAX_DECK_BYTES = 2_000_000;
export const MAX_SUBTITLE_BYTES = 8 * MB;
export const DOCUMENT_EXTENSIONS = ['.pdf', '.md', '.markdown', '.html', '.htm', '.txt'];
const DECK_EXTENSIONS = ['.json'];
const SUBTITLE_EXTENSIONS = ['.srt', '.vtt'];
const AUDIO_EXTENSIONS = ['.mp3', '.wav', '.m4a', '.aac', '.ogg', '.flac', '.opus', '.webm', '.aiff', '.aif'];
const extensionOf = name => /\.[^./\\]+$/.exec(String(name || '').toLowerCase())?.[0] || '';
const FORMAT_OF = { '.pdf': 'pdf', '.md': 'md', '.markdown': 'md', '.html': 'html', '.htm': 'html', '.txt': 'txt' };

/** Extensions the drop zone accepts. Subtitles and audio need the audio component. */
export function importAccept({ audio = false } = {}) {
  return [...DOCUMENT_EXTENSIONS, ...DECK_EXTENSIONS, ...(audio ? [...SUBTITLE_EXTENSIONS, ...AUDIO_EXTENSIONS] : [])];
}

/** 'document' | 'deck' | 'subtitle' | 'audio' | null for a dropped file. */
export function routeImportFile(file, { audio = false } = {}) {
  const extension = extensionOf(file?.name);
  if (DOCUMENT_EXTENSIONS.includes(extension)) return 'document';
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

/** Base64 of a File/Blob, without FileReader (works in the browser and in Node tests). */
export async function fileToBase64(file) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 0x8000) binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  return btoa(binary);
}

const PLAIN_ERRORS = [
  [/not a valid PDF|不是有效 PDF|PDF 文件无效|PDF is invalid/i, '这个 PDF 读不出来（可能已损坏或超过 8 MB）。请重新导出 PDF 后再试。'],
  [/exceeds 8 MB|at most 8 MB|超过 8 MB|8 MB/i, '文件超过 8 MB。请按章节拆分后再导入。'],
  [/UTF-8/i, '文本文件需要是 UTF-8 编码。请在编辑器里“另存为 UTF-8”后再导入。'],
  [/200 (?:页|pages)/i, 'PDF 超过 200 页。请按章节拆分后再导入。'],
  [/600,000/, '提取出的文字超过 60 万字。请按章节拆分后再导入。'],
  [/Supported document formats/i, '不支持这种文件。可以导入 PDF、Markdown、HTML、TXT、JSON 题组和字幕。'],
  [/dataBase64/i, '文件没能完整读取，请重试。'],
];

/** A failure in words a student can act on; unknown messages are kept as they are. */
export function plainImportError(error) {
  const message = String(error?.message ?? error ?? '').trim();
  for (const [pattern, text] of PLAIN_ERRORS) if (pattern.test(message)) return ui(text);
  return message || ui('导入失败，请重试。');
}

async function importOne(file, { call, courses = [], audio = false }) {
  const kind = routeImportFile(file, { audio });
  if (kind === 'audio') throw new Error(ui('音频请在「音频 / 录音」里导入，那里会先转写成文字。'));
  if (!kind) throw new Error(ui('不支持这种文件。可以导入 PDF、Markdown、HTML、TXT、JSON 题组和字幕。'));
  if (kind === 'document') {
    if (file.size > MAX_DOCUMENT_BYTES) throw new Error(ui('文件超过 8 MB。请按章节拆分后再导入。'));
    const value = await call('materials.document.import', { dataBase64: await fileToBase64(file), filename: file.name, courses });
    const sourceIds = value?.sourceIds || value?.document?.sourceIds || [];
    const format = value?.document?.format || FORMAT_OF[extensionOf(file.name)];
    if (!sourceIds.length) throw new Error(format === 'pdf'
      ? ui('没有读到可用的文字，可能是扫描件或图片。请先做文字识别（OCR）再导入。') : ui('文件里没有可用的文字。'));
    return { kind, title: value?.document?.title || file.name, format, documentId: value?.documentId, sourceIds,
      pages: sourceIds.length, skippedPages: value?.skippedPages || [] };
  }
  const text = await file.text();
  if (kind === 'deck' && !looksLikeSubtitleJson(text)) {
    if (file.size > MAX_DECK_BYTES) throw new Error(ui('题组文件不能超过 2 MB。'));
    const proposal = await call('draft.import.propose', { text });
    const deck = await call('draft.import', { text, title: proposal?.title, course: courses[0] ?? proposal?.course ?? '' });
    return { kind: 'deck', title: deck.title, deck, count: deck.cards?.length || 0 };
  }
  if (!audio) throw new Error(ui('这是字幕文件，需要启用音频组件后才能导入。'));
  if (file.size > MAX_SUBTITLE_BYTES) throw new Error(ui('字幕文件超过 8 MB。'));
  const job = await call('audio.subtitles.import', { filename: file.name, text, courses });
  return { kind: 'subtitle', title: file.name, job };
}

/**
 * Import files one after another. onUpdate(index, { status, result?, error? })
 * reports 'working', then 'done' or 'error'. Resolves to
 * [{ file, status: 'done'|'error', result?, error? }]; it never throws.
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
      const message = plainImportError(error);
      results.push({ file, status: 'error', error: message });
      onUpdate?.(index, { status: 'error', error: message });
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
export function importDoneMessage({ documents = [], decks = [], subtitles = [] } = {}) {
  const parts = [];
  if (documents.length === 1) {
    const [document] = documents;
    parts.push(document.format !== 'pdf' ? uiFormat('已导入「{0}」', [document.title])
      : document.pages === 1 ? uiFormat('已导入「{0}」（1 页）', [document.title]) : uiFormat('已导入「{0}」（{1} 页）', [document.title, document.pages]));
  } else if (documents.length > 1) parts.push(uiFormat('已导入 {0} 份资料', [documents.length]));
  if (decks.length === 1) parts.push(uiFormat('题组「{0}」已存为草稿（{1} 题）', [decks[0].title, decks[0].cards?.length || 0]));
  else if (decks.length > 1) parts.push(uiFormat('{0} 个题组已存为草稿', [decks.length]));
  if (subtitles.length) parts.push(uiFormat('{0} 份字幕正在后台校对，完成后出现在资料页', [subtitles.length]));
  return parts.join(ui('；'));
}

const isFileDrag = event => Array.from(event?.dataTransfer?.types || []).includes('Files');
const swallow = event => {
  event.preventDefault();
  event.stopPropagation();
  if (event.type !== 'drop' && event.dataTransfer) event.dataTransfer.dropEffect = 'none';
};

/**
 * Native listener for the dialog element: a file dragged over any part of the
 * dialog outside the hub (header, padding, backdrop) is refused there, so it
 * neither opens in the browser nor reaches the host's chat composer.
 */
export function createDialogDropGuard({ contains, onStray }) {
  return event => {
    if (!isFileDrag(event) || contains?.(event.target)) return;
    swallow(event);
    if (event.type === 'dragover' || event.type === 'drop') onStray?.(event.type);
  };
}

/**
 * React handler for the hub's own area. Inner drop zones that took the file
 * (they call preventDefault) keep it; anything else is refused with a hint.
 * Either way propagation stops at React's root, before the host sees it.
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

function itemDetail(item) {
  if (item.status === 'error') return item.error;
  if (item.status === 'working') return ui(WORKING[item.kind] || '处理中');
  if (item.status !== 'done') return PENDING[item.kind] ? ui(PENDING[item.kind]) : '';
  const result = item.result;
  if (result.kind === 'deck') return uiFormat('已存为草稿「{0}」 · {1} 题', [result.title, result.count]);
  if (result.kind === 'subtitle') return ui('已开始后台校对，完成后出现在资料页');
  const label = sourceFormatLabel({ format: result.format, sourceIds: result.sourceIds });
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
      <label>{ui('原文')}<textarea required rows={10} maxLength={600000} value={draft.text} disabled={disabled || saving}
        aria-describedby={error ? errorId : undefined} placeholder={ui('粘贴讲义、笔记或材料。生成内容将引用这里的原文。')}
        onChange={event => onDraft({ ...draft, text: event.target.value })} /></label>
      {error && <InlineMessage id={errorId}>{error}</InlineMessage>}
      <div className="import-hub__paste-footer">
        <small>{draft.text.length.toLocaleString()}{ui(' / 600,000 字符')}</small>
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
 * is finished without failures or the learner confirms a partial one.
 */
export default function ImportHub({ data, call, busy = false, course, onCourseChange, audio, initialTab = 'files', pasteDraft, onPasteDraftChange,
  onImported, onComplete, className, ...rest }) {
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
  useEffect(() => {
    alive.current = true;
    const element = root.current, dialog = element?.closest?.('dialog');
    if (!dialog) return () => { alive.current = false; clearTimeout(strayTimer.current); };
    const guard = createDialogDropGuard({ contains: target => element.contains(target), onStray: type => strayRef.current?.(type) });
    const types = ['dragenter', 'dragover', 'drop'];
    types.forEach(type => dialog.addEventListener(type, guard));
    return () => { alive.current = false; clearTimeout(strayTimer.current); types.forEach(type => dialog.removeEventListener(type, guard)); };
  }, []);

  const courses = parseCourses(courseText);
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
    if (!files.length || running) return;
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
      : item.kind ? { label: ui('重试'), onClick: () => retry(item.id), disabled: running } : undefined }));
  const finished = items.filter(item => item.status === 'done').length, failed = items.filter(item => item.status === 'error').length;
  const tabs = [{ value: 'files', label: ui('文件'), icon: 'file' }, { value: 'paste', label: ui('粘贴文本'), icon: 'plus' },
    ...(audioOn ? [{ value: 'audio', label: ui('音频 / 录音'), icon: 'audio' }] : [])];
  const strayText = tab === 'audio' ? ui('把音频放进虚线框里才会导入。') : ui('把文件放进虚线框里才会导入。');
  return (
    <div ref={root} className={`import-hub${className ? ` ${className}` : ''}`} data-tab={tab}
      onDragEnter={handleDrag} onDragOver={handleDrag} onDragLeave={handleDrag} onDrop={handleDrag} {...rest}>
      <div className="import-hub__course">
        <CourseField label={ui('这些资料属于哪门课？')} value={courseText} onChange={setCourseText} courses={data?.focus?.courses || []}
          multiple disabled={busy || running} />
      </div>
      <SegmentedControl className="import-hub__tabs" label={ui('添加方式')} value={tab} options={tabs} disabled={running} onChange={setTab} />
      {stray && <p className="import-hub__stray" role="status"><Icon name="info" size={16} />{strayText}</p>}
      {tab === 'files' && <div className="import-hub__files">
        <FileDrop className={stray ? 'is-attention' : undefined} accept={importAccept({ audio: audioOn })} multiple
          label={ui('把讲义、笔记或题组文件拖到这里，可以一次放多个')}
          hint={audioOn ? ui('PDF · Markdown · HTML · TXT · JSON 题组 · SRT / VTT 字幕 · 每个最大 8 MB') : ui('PDF · Markdown · HTML · TXT · JSON 题组 · 每个最大 8 MB')}
          buttonLabel={ui('选择文件')} busy={running} disabled={busy && !running} items={shown}
          onFiles={accepted => add(accepted)} data-tour="import-drop" />
        <p className="import-hub__routes">{audioOn
          ? ui('讲义和笔记保存为资料，原文件一并保留；JSON 题组存为草稿；字幕在后台校对后成为资料。')
          : ui('讲义和笔记保存为资料，原文件一并保留；JSON 题组存为草稿。')}</p>
        {!running && failed > 0 && <InlineMessage tone="warning" boxed className="import-hub__summary"
          title={finished ? uiFormat('{0} 个文件已导入，{1} 个没有导入', [finished, failed]) : uiFormat('{0} 个文件没有导入', [failed])}
          action={finished ? { label: ui('查看已导入的内容'), onClick: () => onComplete?.(importSummary(itemsRef.current)) } : undefined}>
          {ui('原因写在每个文件旁边。修正后可以重新拖进来。')}
        </InlineMessage>}
      </div>}
      {tab === 'paste' && <PasteForm call={call} courses={courses} disabled={busy} draft={draft} onDraft={setDraft}
        onSaved={async summary => { await onImported?.(summary); if (alive.current) onComplete?.(summary); }} />}
      {tab === 'audio' && audioOn && <div className="import-hub__audio">{audio}</div>}
    </div>
  );
}
