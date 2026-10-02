import React, { useDeferredValue, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import DOMPurify from 'dompurify';
import { renderNoteMarkdown } from '../note-markdown.js';
import { AudioCorrections } from '../AudioImport.jsx';
import { ui, uiFormat, useUiLanguage } from '../i18n.js';
import { useInjectCss } from '../shared.js';
import { Button, IconButton, SegmentedControl } from '../components/index.js';
import DocumentLearning, { PassageLinks } from './DocumentLearning.jsx';
import { annotatePassages, captureSelection, groupPassageLinks, locateQuote, renderedPassageRange } from './selection.js';
import { isOfficeFormat } from '../../lib/office/limits.js';
import OutlinePanel from './reader/OutlinePanel.jsx';
import FindBar from './reader/FindBar.jsx';
import DisplaySettings from './reader/DisplaySettings.jsx';
import ReadingSections from './reader/ReadingSections.jsx';
import { useReaderSettings } from './reader/useReaderSettings.js';
import { useReadingPosition, scrollToNode } from './reader/useReadingPosition.js';
import { readerVars } from './reader/settings.js';
import { readingSections } from './reader/text-sections.js';
import { outlineFromSections, collectHeadings, neighbours } from './reader/outline.js';
import { findRanges, paintMatches } from './reader/find.js';
import css from './document-preview.css';
import readerCss from './reader/reader.css';

const useIsoLayoutEffect = typeof window === 'undefined' ? useEffect : useLayoutEffect;

/** HTML is inert reading content: scripts, embedded browsing and external resource loads are removed. */
export function safeDocumentHtml(text) {
  return DOMPurify.sanitize(String(text || ''), { USE_PROFILES: { html: true, mathMl: true },
    FORBID_TAGS: ['script', 'style', 'iframe', 'object', 'embed', 'link', 'meta', 'base', 'form', 'input', 'button', 'textarea', 'select', 'svg', 'canvas', 'mglyph', 'img', 'picture', 'audio', 'video', 'source', 'track'],
    FORBID_ATTR: ['src', 'srcset', 'poster', 'xlink:href', 'style', 'autofocus', 'contenteditable'], ADD_ATTR: ['target'] });
}

/**
 * The text style for a source in the 原文 view. Only PDF page text keeps its layout
 * (monospace, no wrapping, horizontal scroll); TXT, transcripts, Markdown 原文 and older
 * text-only sources are set for reading: proportional, wrapped, a comfortable measure.
 */
export const sourceTextClass = ({ format } = {}) => format === 'pdf' ? 'source-text source-text--pdf' : 'source-text source-text--reading';

/**
 * What to do with a retained original: show a PDF, read text formats as text,
 * offer Word / PowerPoint files as a download (they are zip files, never text),
 * or nothing when only extracted text was kept.
 */
export function originalHandling(value) {
  if (!value?.originalAvailable) return 'none';
  if (value.format === 'pdf') return 'pdf';
  return isOfficeFormat(value.format) ? 'download' : 'text';
}

/** The format the viewer lays out: the loaded document's, else the source's own (a slide is a slide before loading). */
export const viewerFormat = (document, source) => document?.format
  || (source?.document ? source.document.format || 'pdf' : source?.audio ? 'txt' : 'md');

/** Formats whose sources are pages (PDF pages, PowerPoint slides), shown as page sections. */
const PAGED = new Set(['pdf', 'pptx']);

/** Below this width of the viewer, the outline and the learning panel slide over the text. Mirrors reader.css. */
const NARROW = 900;

function QuotedText({ text, quote, anchor, format }) {
  const hit = locateQuote(text, quote, anchor), mark = useRef(null);
  useEffect(() => { mark.current?.scrollIntoView?.({ block: 'center' }); }, [quote, text]);
  return <pre className={sourceTextClass({ format })} data-study-text="true">{hit.status === 'resolved'
    ? <>{text.slice(0, hit.start)}<mark ref={mark} className="source-hit">{text.slice(hit.start, hit.end)}</mark>{text.slice(hit.end)}</> : text}</pre>;
}

/**
 * The source reader. Three views: 阅读 (reflowed, with an outline), 原文 (the stored text
 * exactly, for checking citations) and 原始 PDF. Props: source, quote, call, data, host,
 * onOpenCard, onPublished, onCaseFromPassage(passage), onGenerate() (shows "从这份资料出题" as the
 * toolbar's primary action), generateDisabled, initialMode ('read' | 'text' | 'original').
 */
export default function DocumentViewer({ source, quote, call, data, host, onOpenCard, onPublished, onCaseFromPassage, onGenerate, generateDisabled = false, initialMode = 'read' }) {
  const language = useUiLanguage();
  useInjectCss(css, 'study-document-preview');
  useInjectCss(readerCss, 'study-reader');
  const [document, setDocument] = useState(null), [content, setContent] = useState(''), [fileUrl, setFileUrl] = useState('');
  const [error, setError] = useState(''), [loading, setLoading] = useState(true), [mode, setMode] = useState(initialMode);
  const [capture, setCapture] = useState(null), [links, setLinks] = useState([]), [focusedGroup, setFocusedGroup] = useState(null);
  const [settings, updateSettings, resetSettings] = useReaderSettings();
  const [narrow, setNarrow] = useState(false), [overlay, setOverlay] = useState(null);
  const [finding, setFinding] = useState(false), [query, setQuery] = useState(''), [total, setTotal] = useState(0), [match, setMatch] = useState(0);
  const [headings, setHeadings] = useState([]);
  const [pdfPage, setPdfPage] = useState(() => source.document?.page || source.selection?.page || 1);
  const root = useRef(null), body = useRef(null), scroller = useRef(null), findInput = useRef(null), ranges = useRef([]), openedAt = useRef('');
  const outlineId = useId(), toolsId = useId();
  useEffect(() => {
    let current = true, objectUrl = '';
    setLoading(true); setError(''); setDocument(null); setContent(''); setFileUrl(''); setCapture(null);
    (async () => {
      try {
        const value = await call('materials.document.get', { sourceId: source.id,
          ...(source.selection?.revision ? { revision: source.selection.revision } : {}) });
        if (!current) return;
        setDocument(value);
        const backlink = await call('materials.links.list', { documentId: value.documentId || value.id });
        if (current) setLinks(backlink.links || []);
        const original = originalHandling(value);
        if (original === 'download' || original === 'none') setContent(value.sources?.find(item => item.id === source.id)?.text || source.text);
        else {
          const bytes = await call('materials.document.bytes', { documentId: value.documentId || value.id, revision: value.revision });
          if (!current || !bytes.dataBase64) return;
          const data = Uint8Array.from(atob(bytes.dataBase64), char => char.charCodeAt(0));
          if (value.format === 'pdf') {
            objectUrl = URL.createObjectURL(new Blob([data], { type: bytes.mime })); setFileUrl(objectUrl);
          } else setContent(new TextDecoder().decode(data));
        }
      } catch (e) {
        if (current) { setError(e.message); setContent(source.text || ''); }
      } finally { if (current) setLoading(false); }
    })();
    return () => { current = false; if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, [call, source.id, source.text, source.selection?.revision]);
  const format = viewerFormat(document, source), paged = PAGED.has(format);
  const view = mode === 'original' && !(format === 'pdf' && fileUrl) ? 'read' : mode, reading = view === 'read';
  const downloadOriginal = async () => {
    try {
      const bytes = await call('materials.document.bytes', { documentId: document.documentId || document.id, revision: document.revision });
      const data = Uint8Array.from(atob(bytes.dataBase64), char => char.charCodeAt(0));
      const url = URL.createObjectURL(new Blob([data], { type: bytes.mime || 'application/octet-stream' }));
      const link = window.document.createElement('a');
      link.href = url; link.download = document.filename || source.document?.filename || `${source.title || 'document'}.${format}`;
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (e) { setError(e.message); }
  };
  const groups = useMemo(() => groupPassageLinks(links), [links]);
  const learningDocument = useMemo(() => document ? { ...document, sourceId: source.id } : { sourceId: source.id }, [document, source.id]);
  const sources = useMemo(() => document?.sources || [source], [document, source]);
  const html = useMemo(() => !reading ? '' : format === 'md' ? safeDocumentHtml(renderNoteMarkdown(content))
    : format === 'html' ? safeDocumentHtml(content) : '', [content, format, reading]);
  const sections = useMemo(() => (reading && !html) || paged ? readingSections({ paged, sources, text: sources[0]?.text || content }) : [],
    [reading, html, paged, sources, content]);
  const pageLabel = page => format === 'pptx' ? uiFormat('第 {0} 张', [page]) : uiFormat('第 {0} 页', [page]);
  const labelOf = section => section.kind === 'page' ? pageLabel(section.page) : '';
  const itemLabel = item => item.page ? pageLabel(item.page) : '';
  const textOutline = useMemo(() => outlineFromSections(sections), [sections]);
  const outline = reading && html ? headings : textOutline;
  useEffect(() => { setHeadings(reading && html ? collectHeadings(body.current) : []); }, [reading, html]);
  const [position, jump] = useReadingPosition(scroller, outline, `${view}:${html.length}:${sections.length}`);
  const activeId = view === 'original' ? textOutline.find(item => item.page === pdfPage)?.id ?? null : position.activeId;
  const around = useMemo(() => neighbours(outline, activeId), [outline, activeId]);
  const here = outline.find(item => item.id === activeId);
  const where = here ? [itemLabel(here), here.title].filter(Boolean).join(' · ') : '';
  const jumpTo = item => {
    if (view === 'original') { if (item.page) setPdfPage(item.page); } else jump(item.id);
    if (narrow) setOverlay(null);
  };

  // Narrow panes: the outline and the learning panel slide over the text instead of sitting beside it.
  useIsoLayoutEffect(() => {
    const element = root.current;
    if (!element) return undefined;
    let last = null;
    const measure = () => { const next = element.clientWidth < NARROW; if (next !== last) { last = next; setNarrow(next); } };
    measure();
    if (typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  useEffect(() => { setOverlay(null); }, [narrow]);
  const outlineOn = outline.length > 0 && (narrow ? overlay === 'outline' : settings.outline);
  const toolsOn = narrow ? overlay === 'tools' : settings.tools;
  const toggle = panel => narrow ? setOverlay(current => current === panel ? null : panel) : updateSettings({ [panel]: !settings[panel] });

  const select = () => {
    const value = captureSelection(body.current);
    if (!value) return;
    setCapture(value);
    if (!narrow && !settings.tools) updateSettings({ tools: true });
  };
  const refreshLinks = async value => {
    if (document) {
      const result = await call('materials.links.list', { documentId: document.documentId || document.id });
      setLinks(result.links || []);
    }
    await onPublished?.(value);
  };
  useEffect(() => annotatePassages(body.current, groups, setFocusedGroup, count => uiFormat('{0} 道相关题目与解析', [count])), [groups, html, content, view, sections, document, language]);
  const quoteState = quote ? locateQuote(sources.find(item => item.id === source.id)?.text || content, quote, source.selection) : null;
  useEffect(() => {
    if (!reading || !quote || quoteState?.status !== 'resolved') return undefined;
    const range = renderedPassageRange(body.current, { ...source.selection, sourceId: source.id, quote });
    if (!range) return undefined;
    scrollToNode(scroller.current, range.startContainer.parentElement, { center: true, smooth: false });
    if (window.CSS?.highlights && window.Highlight) {
      window.CSS.highlights.set('study-source-quote', new window.Highlight(range));
      return () => window.CSS.highlights.delete('study-source-quote');
    }
    return undefined;
  }, [reading, html, sections, quote, quoteState?.status, source.id, source.selection]);

  // A new view starts at the top; a page or slide opened from a link starts at that page.
  useEffect(() => { scroller.current?.scrollTo?.({ top: 0 }); }, [view]);
  useEffect(() => {
    const key = `${source.id}:${view}`;
    if (!paged || quote || loading || !sections.length || view === 'original' || openedAt.current === key) return;
    openedAt.current = key;
    if ((source.document?.page || 1) > 1) scrollToNode(scroller.current, scroller.current?.querySelector(`[data-study-source="${source.id}"]`), { smooth: false });
  }, [paged, quote, loading, sections, view, source.id, source.document?.page]);

  // Search in the document: matches are DOM ranges painted with the Custom Highlight API.
  const deferredQuery = useDeferredValue(query);
  useEffect(() => {
    ranges.current = finding && view !== 'original' && deferredQuery.trim() ? findRanges(body.current, deferredQuery) : [];
    setTotal(ranges.current.length);
    setMatch(0);
  }, [finding, deferredQuery, view, html, sections, content, groups]);
  useEffect(() => {
    if (!total) return undefined;
    const index = Math.min(match, total - 1), clear = paintMatches(ranges.current, index);
    const rect = ranges.current[index]?.getBoundingClientRect?.(), area = scroller.current?.getBoundingClientRect();
    if (rect && area && (rect.top < area.top + 56 || rect.bottom > area.bottom - 56))
      scroller.current.scrollTo({ top: scroller.current.scrollTop + rect.top - area.top - area.height / 3, behavior: 'auto' });
    return clear;
  }, [total, match]);
  const openFind = () => {
    const selected = window.getSelection?.()?.toString().trim();
    if (selected && selected.length <= 80 && !selected.includes('\n')) setQuery(selected);
    setFinding(true);
    requestAnimationFrame(() => { findInput.current?.focus(); findInput.current?.select(); });
  };
  const closeFind = () => { setFinding(false); scroller.current?.focus?.({ preventScroll: true }); };
  const stepFind = delta => setMatch(current => total ? (current + delta + total) % total : 0);
  const onKeyDown = event => {
    if ((event.ctrlKey || event.metaKey) && !event.altKey && event.key.toLowerCase() === 'f' && view !== 'original') { event.preventDefault(); openFind(); }
    else if (event.key === 'Escape' && overlay) { event.preventDefault(); event.stopPropagation(); setOverlay(null); }
  };

  const modes = [{ value: 'read', label: ui('阅读') }, { value: 'text', label: ui('原文') },
    ...(format === 'pdf' ? [{ value: 'original', label: ui('原始 PDF'), disabled: !fileUrl, title: fileUrl ? undefined : ui('没有保留原始 PDF') }] : [])];
  const notices = [
    loading && <p key="loading" role="status">{ui('正在打开资料…')}</p>,
    document && !document.originalAvailable && <p key="legacy">{ui('这份旧资料保存了提取文字，原始文件尚未保留；仍可提问、补题和查看引用。重新导入原文件可补全预览。')}</p>,
    view === 'original' && <p key="pdf">{ui('原始 PDF 可核对排版与图表；要选中文字提问或补题，请切换到「阅读」。')}</p>,
    error && <p key="error" className="is-warning" role="alert">{error}</p>,
    quoteState?.status === 'ambiguous' && <p key="ambiguous" className="is-warning">{ui('引用在资料中出现多次，请结合上下文核对位置。')}</p>,
    quoteState?.status === 'stale' && <p key="stale" className="is-warning">{ui('引用位置与当前文字不一致，请重新核对这段原文。')}</p>,
    source.selection && document?.currentRevision && document.currentRevision !== source.selection.revision
      && <p key="revision" className="is-warning">{ui('此引用来自较早版本，当前资料已有更新。')}</p>,
  ].filter(Boolean);
  const pagerTitle = item => [itemLabel(item), item.title].filter(Boolean).join(' · ');
  const pageText = (section, index) => sources[index]?.text ?? '';

  return <div className="study-document-viewer reader" ref={root} data-mode={view} data-tone={settings.tone} data-face={settings.face}
    data-narrow={narrow || undefined} style={readerVars(settings)} onKeyDown={onKeyDown}>
    <div className="reader-toolbar">
      <div className="reader-toolbar__group">
        {outline.length > 0 && <IconButton icon="list" label={ui('目录')} aria-pressed={outlineOn} aria-controls={outlineOn ? outlineId : undefined}
          onClick={() => toggle('outline')} />}
        <SegmentedControl size="sm" className="study-document-preview-mode" label={ui('显示方式')} value={view} options={modes} onChange={setMode} />
      </div>
      <p className="reader-toolbar__where" title={where || undefined}>{where}</p>
      <div className="reader-toolbar__group reader-toolbar__group--end">
        {view !== 'original' && <>
          <IconButton icon="search" label={ui('在文中查找')} aria-pressed={finding} onClick={() => finding ? closeFind() : openFind()} />
          <DisplaySettings settings={settings} onChange={updateSettings} onReset={resetSettings} />
        </>}
        <IconButton icon="panel" label={ui('学习工具')} aria-pressed={toolsOn} aria-controls={toolsId} data-tour="source-tools-toggle"
          data-attention={capture && !toolsOn ? 'true' : undefined} onClick={() => toggle('tools')}>
          {groups.length > 0 && <span className="reader-badge" aria-hidden="true">{groups.length}</span>}
        </IconButton>
        {originalHandling(document) === 'download' && <Button size="sm" variant="quiet" icon="download" onClick={downloadOriginal}>{ui('下载原文件')}</Button>}
        {document?.preview?.kind === 'file' && host?.openDocument && <Button size="sm" variant="quiet" icon="external"
          onClick={() => host.openDocument(document.preview.path)}>{ui('使用宿主文件预览')}</Button>}
        {onGenerate && <Button variant="primary" icon="sparkle" disabled={generateDisabled} onClick={onGenerate}>{ui('从这份资料出题')}</Button>}
      </div>
    </div>
    <div className="reader-progress" aria-hidden="true"><span style={{ transform: `scaleX(${view === 'original' ? 0 : position.progress})` }} /></div>
    {finding && view !== 'original' && <FindBar query={query} onQuery={setQuery} total={total} index={Math.min(match, Math.max(total - 1, 0))}
      onStep={stepFind} onClose={closeFind} inputRef={findInput} />}
    <div className="study-document-notices reader-notices">{notices}</div>
    <div className="reader-aux">
      {quote && <blockquote className="highlight-quote">{quote}</blockquote>}
      <AudioCorrections audio={source.audio} onReview={call && source.audio?.corrections ? () => call('audio.corrections.review', { sourceId: source.id }) : null} />
    </div>
    <div className="reader-layout" data-outline={outlineOn ? 'on' : 'off'} data-tools={toolsOn ? 'on' : 'off'}>
      {narrow && (outlineOn || toolsOn) && <button type="button" className="reader-scrim" aria-label={ui('关闭面板')} onClick={() => setOverlay(null)} />}
      {outlineOn && <OutlinePanel id={outlineId} items={outline} activeId={activeId} labelOf={itemLabel} onJump={jumpTo} />}
      <div className="reader-scroll" ref={scroller} tabIndex={0} role="region" aria-label={ui('资料内容')} data-mode={view}>
        <div className="reader-page">
          <div className="study-document-body" ref={body} onMouseUp={select} onKeyUp={select} onTouchEnd={select}>
            {view === 'original'
              ? <div className="reader-original"><iframe src={`${fileUrl}#page=${pdfPage}`} title={source.title || ui('原始 PDF')} /></div>
              : reading
                ? html ? <div className="reader-html source-md" data-study-text="true" dangerouslySetInnerHTML={{ __html: html }} />
                  : <ReadingSections sections={sections} labelOf={labelOf} />
                : paged ? sections.map((section, index) => <section key={section.id} className="study-document-page reader-section reader-section--page"
                  data-outline-id={section.id} data-study-page={section.page} data-study-source={section.sourceId}>
                  <span className="reader-section__label">{labelOf(section)}</span>
                  <QuotedText format={format} text={pageText(section, index)} quote={section.sourceId === source.id ? quote : ''} anchor={source.selection} />
                </section>)
                  : <QuotedText format={format} text={content || sources[0]?.text || ''} quote={quote} anchor={source.selection} />}
          </div>
          {view !== 'original' && (around.previous || around.next) && <nav className="reader-pager" aria-label={ui('上一节与下一节')}>
            {around.previous ? <button type="button" className="reader-pager__link" data-direction="previous" onClick={() => jumpTo(around.previous)}>
              <small>{ui('上一节')}</small><span>{pagerTitle(around.previous)}</span></button> : <span />}
            {around.next ? <button type="button" className="reader-pager__link" data-direction="next" onClick={() => jumpTo(around.next)}>
              <small>{ui('下一节')}</small><span>{pagerTitle(around.next)}</span></button> : <span />}
          </nav>}
        </div>
      </div>
      <aside className="study-document-side reader-tools" data-tour="source-tools" id={toolsId} aria-label={ui('学习工具')} hidden={!toolsOn}>
        <h3 className="reader-panel__title">{ui('学习')}</h3>
        <div className="study-document-selection">
          <Button className="study-document-wide" icon="plus" onPointerDown={event => { event.preventDefault(); select(); }} onClick={select}>{ui('使用当前选区')}</Button>
          <DocumentLearning call={call} document={learningDocument} capture={capture} data={data} onPublished={refreshLinks} onOpenCard={onOpenCard} />
          {/* Case practice (WP12): a passage can be the seed of a case paper. */}
          {onCaseFromPassage && <Button className="study-document-wide" disabled={!capture?.quote} title={capture?.quote ? undefined : ui('先在原文中选中一段文字')}
            onClick={() => onCaseFromPassage({ sourceId: capture.sourceId || source.id, quote: capture.quote })}>{ui('围绕这段出案例题')}</Button>}
        </div>
        {groups.length > 0 && <>
          <h3 className="study-document-links-heading">{ui('原文关联题目与解析')}</h3>
          <PassageLinks groups={focusedGroup ? [focusedGroup] : groups} onOpenCard={onOpenCard} />
          {focusedGroup && <Button size="sm" variant="quiet" onClick={() => setFocusedGroup(null)}>{ui('显示全部引用')}</Button>}
        </>}
      </aside>
    </div>
  </div>;
}
