import React, { Suspense, lazy, useDeferredValue, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import DOMPurify from 'dompurify';
import MathText from '../MathText.jsx';
import { AudioCorrections } from '../audio/AudioCorrections.jsx';
import { ui, uiFormat, useUiLanguage } from '../i18n.js';
import { useInjectCss } from '../shared.js';
import { Button, IconButton, InlineMessage, SegmentedControl } from '../components/index.js';
import DocumentLearning from './DocumentLearning.jsx';
import { OriginalNotice, OriginalDialog } from './OriginalFile.jsx';
import { issueOf } from './original-file.js';
import { peekStatus } from './peek/peek-logic.js';
import { captureSelection, groupPassageLinks, locateQuote, renderedPassageRange } from './selection.js';
import PassageLinksPanel, { linkTitleWords } from './links/PassageLinksPanel.jsx';
import { buildLinkModel, groupTitle } from './links/link-model.js';
import { usePassageLinkLayer } from './links/usePassageLinkLayer.js';
import useBilingual from './translation/useBilingual.jsx';
import { isOfficeFormat } from '../../lib/office/limits.js';
import { groupSourcesByDocument } from '../../lib/source-groups.js';
import ReadingPractice from './practice/ReadingPractice.jsx';
import { MasteryLine } from './practice/MasteryMark.jsx';
import { useReadingLoop } from './practice/useReadingLoop.js';
import OutlinePanel from './reader/OutlinePanel.jsx';
import OutlineAssist from './reader/OutlineAssist.jsx';
import FindBar from './reader/FindBar.jsx';
import DisplaySettings from './reader/DisplaySettings.jsx';
import ReadingSections from './reader/ReadingSections.jsx';
import { renderReaderMarkdown } from './reader/markdown.js';
import { copyText, pickFormula } from './reader/formula.js';
import { useReaderSettings } from './reader/useReaderSettings.js';
import { useReadingPosition, scrollToNode } from './reader/useReadingPosition.js';
import { readerVars, underlineShown } from './reader/settings.js';
import { readingSections } from './reader/text-sections.js';
import { outlineFromSections, collectHeadings, structureOutline, sectionNeighbours, chapterNeighbours, outlinePath } from './reader/outline.js';
import { applyOutline, clearOutlineTags } from './reader/ai-outline.js';
import { findRanges, paintMatches } from './reader/find.js';
import css from './document-preview.css';
import readerCss from './reader/reader.css';
import linksCss from './links/links.css';
import translationCss from './translation/translation.css';

const useIsoLayoutEffect = typeof window === 'undefined' ? useEffect : useLayoutEffect;
// 看原页 (pdf.js and its worker) is fetched on the first peek, never with the reader.
const PagePeek = lazy(() => import('./peek/PagePeek.jsx'));

/** HTML is inert reading content. Only Markdown already filtered by renderNoteMarkdown may keep its safe images. */
export function safeDocumentHtml(text, { markdownImages = false } = {}) {
  return DOMPurify.sanitize(String(text || ''), { USE_PROFILES: { html: true, mathMl: true },
    FORBID_TAGS: ['script', 'style', 'iframe', 'object', 'embed', 'link', 'meta', 'base', 'form', 'input', 'button', 'textarea', 'select', 'svg', 'canvas', 'mglyph', ...(!markdownImages ? ['img'] : []), 'picture', 'audio', 'video', 'source', 'track'],
    FORBID_ATTR: [...(!markdownImages ? ['src'] : []), 'srcset', 'poster', 'xlink:href', 'style', 'autofocus', 'contenteditable'], ADD_ATTR: ['target'] });
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
 * localContent ({ id, title, markdown }) reads saved writing in the same reader without a material identity or material actions.
 */
export default function DocumentViewer({ source, quote, call, data, host, onOpenCard, onOpenDeck, onPractice, onStarted, onPublished, onCaseFromPassage, onGenerate, generateDisabled = false, initialMode = 'read',
  onPracticePages, onGeneratePages, resume, backLabel, onBack, localContent }) {
  const language = useUiLanguage();
  const localMode = localContent != null;
  useInjectCss(css, 'study-document-preview');
  useInjectCss(readerCss, 'study-reader');
  useInjectCss(linksCss, 'study-reader-links');
  useInjectCss(translationCss, 'study-reader-translation');
  const [loadedDocument, setDocument] = useState(null), [loadedContent, setContent] = useState(''), [fileUrl, setFileUrl] = useState('');
  const [error, setError] = useState(''), [fetching, setLoading] = useState(true), [mode, setMode] = useState(initialMode);
  // Local writing is authoritative on every render, including edits and a switch from an open material.
  const document = localMode ? null : loadedDocument, content = localMode ? String(localContent.markdown ?? '') : loadedContent;
  const loading = !localMode && fetching;
  const [capture, setCapture] = useState(null), [links, setLinks] = useState([]), [focusedKey, setFocusedKey] = useState(null);
  const [settings, updateSettings, resetSettings] = useReaderSettings();
  const [narrow, setNarrow] = useState(false), [overlay, setOverlay] = useState(null);
  const [finding, setFinding] = useState(false), [query, setQuery] = useState(''), [total, setTotal] = useState(0), [match, setMatch] = useState(0);
  const [headings, setHeadings] = useState([]);
  const [aiOutline, setAiOutline] = useState(null), [aiItems, setAiItems] = useState([]), [emptyOpen, setEmptyOpen] = useState(false);
  const [pdfPage, setPdfPage] = useState(() => source.document?.page || source.selection?.page || 1);
  const [attaching, setAttaching] = useState(null), [reload, setReload] = useState(0), attachTarget = useRef(null); // 补全原文件 (OriginalFile.jsx)
  const [peek, setPeek] = useState(null); // 看原页 (peek/PagePeek.jsx): { page, figure }
  const root = useRef(null), body = useRef(null), scroller = useRef(null), findInput = useRef(null), ranges = useRef([]), openedAt = useRef('');
  const outlineId = useId(), toolsId = useId();
  useEffect(() => {
    let current = true, objectUrl = '';
    setLoading(true); setError(''); setDocument(null); setContent(''); setFileUrl(''); setCapture(null);
    setLinks([]);
    if (localMode) { setLoading(false); return undefined; }
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
          if (!current) return;
          if (!bytes.dataBase64) {
            // The original is not there (a referenced file moved or changed): say so, and keep reading the stored text.
            setDocument({ ...value, originalAvailable: false, original: { ...value.original, status: bytes.reason === 'none' ? 'none' : bytes.reason === 'missing' || bytes.reason === 'unreadable' ? bytes.reason : 'changed', reason: bytes.reason, ...(bytes.path ? { path: bytes.path } : {}) } });
            setContent(value.sources?.find(item => item.id === source.id)?.text || source.text);
            return;
          }
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
  }, [call, source.id, source.text, source.selection?.revision, reload, localMode]);
  const format = localMode ? 'md' : viewerFormat(document, source), paged = PAGED.has(format);
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
  const groups = useMemo(() => groupPassageLinks(localMode ? [] : links), [links, localMode]);
  // Which passages are underlined (resolved links) and which must be selected again; notes follow their cards.
  const model = useMemo(() => buildLinkModel(groups, { noteBadges: data?.noteBadges }), [groups, data?.noteBadges]);
  const learningDocument = useMemo(() => document ? { ...document, sourceId: source.id } : { sourceId: source.id }, [document, source.id]);
  const sources = useMemo(() => localMode ? [{ id: localContent.id, title: localContent.title, text: content, format: 'md' }] : document?.sources || [source], [localMode, localContent?.id, localContent?.title, content, document, source]);
  const html = useMemo(() => !reading ? '' : format === 'md' ? safeDocumentHtml(renderReaderMarkdown(content), { markdownImages: localMode })
    : format === 'html' ? safeDocumentHtml(content) : '', [content, format, reading, localMode]);
  const sections = useMemo(() => (reading && !html) || paged ? readingSections({ paged, sources, text: sources[0]?.text || content }) : [],
    [reading, html, paged, sources, content]);
  const pageLabel = page => format === 'pptx' ? uiFormat('第 {0} 张', [page]) : uiFormat('第 {0} 页', [page]);
  const labelOf = section => section.kind === 'page' ? pageLabel(section.page) : '';
  const itemLabel = item => item.page ? pageLabel(item.page) : '';
  const textOutline = useMemo(() => outlineFromSections(sections), [sections]);
  const autoOutline = reading && html ? headings : textOutline;
  useEffect(() => { setHeadings(reading && html ? collectHeadings(body.current) : []); }, [reading, html]);
  // A kept AI outline (materials.outline.*) replaces the automatic one wherever its entries can be placed in what is drawn.
  useEffect(() => { setAiOutline(document?.outline ?? null); }, [document]);
  useIsoLayoutEffect(() => {
    const drawn = body.current;
    if (localMode || !aiOutline || view === 'original' || loading) { clearOutlineTags(drawn); setAiItems(items => items.length ? [] : items); return; }
    setAiItems(applyOutline(drawn, aiOutline.entries));
  }, [aiOutline, view, html, sections, content, document, loading, localMode]);
  const aiOn = !localMode && view !== 'original' && aiItems.length > 0;
  const outlineItems = aiOn ? aiItems : autoOutline;
  const outline = useMemo(() => structureOutline(outlineItems, { fold: !aiOn }), [outlineItems, aiOn]);
  const [position, jump] = useReadingPosition(scroller, outline, `${view}:${html.length}:${sections.length}:${aiItems.length}`);
  const activeId = view === 'original' ? textOutline.find(item => item.page === pdfPage)?.id ?? null : position.activeId;
  // Previous / next walk the sections; once the learner has applied the outline as the document's chapters, they walk the chapters.
  const chapterLevel = aiOn && aiOutline?.segmentation?.level;
  const around = useMemo(() => chapterLevel ? chapterNeighbours(outline, activeId, chapterLevel) : sectionNeighbours(outline, activeId), [outline, activeId, chapterLevel]);
  const here = outline.find(item => item.id === activeId);
  const where = here ? [itemLabel(here), outlinePath(outline, here.id).join(' › ')].filter(Boolean).join(' · ') : '';
  const jumpTo = item => {
    if (view === 'original') { if (item.page) setPdfPage(item.page); }
    else if (item.range && item.tagged === false) scrollToNode(scroller.current, item.range);
    else jump(item.id);
    if (narrow) setOverlay(null);
  };
  const assistTarget = useMemo(() => document ? { documentId: document.documentId || document.id, sourceId: source.id, revision: document.revision, legacy: !!document.legacy } : null, [document, source.id]);

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
  // The panel is also there when no headings were found, so "让 AI 帮你" can be asked for (it then opens only on request).
  const canOutline = outline.length > 0 || (!!assistTarget && view !== 'original' && !loading && !!call);
  const outlineOn = canOutline && (narrow ? overlay === 'outline' : outline.length > 0 ? settings.outline : emptyOpen);
  const toolsOn = !localMode && (narrow ? overlay === 'tools' : settings.tools);
  const toggle = panel => narrow ? setOverlay(current => current === panel ? null : panel)
    : panel === 'outline' && outline.length === 0 ? setEmptyOpen(open => !open) : updateSettings({ [panel]: !settings[panel] });

  const select = () => {
    if (localMode) return;
    const value = captureSelection(body.current);
    if (!value) return;
    setCapture(value);
    if (!narrow && !settings.tools) updateSettings({ tools: true });
  };
  // A click on a formula selects it whole, so one click asks about one formula (on click: the browser has collapsed any selection it was in).
  const pick = event => { if (pickFormula(window.getSelection(), event.target)) select(); };
  // A copy that touches a formula carries the stored text (the formula's source), not the glyphs it is drawn with.
  const copy = event => {
    const text = copyText(window.getSelection());
    if (text !== null) { event.clipboardData.setData('text/plain', text); event.preventDefault(); }
  };
  const refreshLinks = async value => {
    if (document) {
      const result = await call('materials.links.list', { documentId: document.documentId || document.id });
      setLinks(result.links || []);
    }
    await onPublished?.(value);
  };
  // Link layer: [n] markers, underlines (when shown) and their click. Ranges are located once per links/text change.
  const rendered = useMemo(() => ({ html, content, view, sections, document, language }), [html, content, view, sections, document, language]);
  const linkTitle = group => groupTitle(group, linkTitleWords());
  const openGroup = group => {
    setFocusedKey(group.key);
    if (narrow) setOverlay('tools'); else if (!settings.tools) updateSettings({ tools: true });
  };
  usePassageLinkLayer({ body, groups: model.groups, rendered, underline: underlineShown(settings), onOpen: openGroup, titleOf: linkTitle });
  // The bilingual reading (译): marks and blocks beside the paragraphs, the page / chapter job, the glossary (translation/useBilingual.jsx).
  const bilingual = useBilingual({ call, document, source, view, paged, narrow, body, scroller, rendered, outline, activeId, chapterLevel, enabled: !localMode });
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

  // 读 → 做这几页的题 → 回到阅读 → 掌握度: the questions linked to this document placed under the outline, the range chooser, and the way back to a stored position.
  const documentItem = useMemo(() => data?.sources ? groupSourcesByDocument(data.sources).find(item => item.sourceIds.includes(source.id)) || null : null, [data?.sources, source.id]);
  const unit = aiOn || !paged ? 'section' : format === 'pptx' ? 'slide' : 'page';
  const loop = useReadingLoop({ call, document, source, version: data?.revision, view, paged, unit, sections, outline, activeId, chapterLevel, documentItem, body, scroller, loading, rendered, resume });
  const practise = option => { const started = loop.start(option); loop.setOpen(false); onPracticePages?.(started); };
  const generatePages = option => { loop.setOpen(false); onGeneratePages?.(loop.generateIds(option)); };
  const meters = !localMode && loop.status === 'ready' && loop.total > 0 && view !== 'original' ? loop.meters : null;

  // Search in the document: matches are DOM ranges painted with the Custom Highlight API.
  const deferredQuery = useDeferredValue(query);
  useEffect(() => {
    ranges.current = finding && view !== 'original' && deferredQuery.trim() ? findRanges(body.current, deferredQuery) : [];
    setTotal(ranges.current.length);
    setMatch(0);
  }, [finding, deferredQuery, view, html, sections, content, model]);
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
    else if (!localMode && onPracticePages && view !== 'original' && event.key.toLowerCase() === 'p' && !event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey
      && !event.target.closest?.('input,textarea,select,[contenteditable]')) { event.preventDefault(); loop.setOpen(!loop.open); }
  };

  // The 原始 PDF tab without a file is not dead: it explains and offers 补全原文件.
  const chooseView = value => value === 'original' && !fileUrl ? (document && setAttaching(issueOf(document.original)?.kind === 'none' ? 'attach' : 'relink')) : setMode(value);
  if (document) attachTarget.current = { documentId: document.documentId || document.id, revision: document.revision, title: document.filename || document.title || source.title, format };
  const modes = [{ value: 'read', label: ui('阅读') }, { value: 'text', label: ui('原文') },
    ...(format === 'pdf' ? [{ value: 'original', label: ui('原始 PDF'), title: fileUrl ? undefined : ui('还没有原始 PDF，点击查看如何补全') }] : [])];
  const notices = [
    loading && <p key="loading" role="status">{ui('正在打开资料…')}</p>,
    !localMode && <OriginalNotice key="original" document={document} onAction={setAttaching} />,
    view === 'original' && <p key="pdf">{ui('原始 PDF 可核对排版与图表；要选中文字提问或补题，请切换到「阅读」。')}</p>,
    !localMode && error && <InlineMessage key="error" tone="error">{error}</InlineMessage>,
    quoteState?.status === 'ambiguous' && <InlineMessage key="ambiguous" tone="warning">{ui('引用在资料中出现多次，请结合上下文核对位置。')}</InlineMessage>,
    quoteState?.status === 'stale' && <InlineMessage key="stale" tone="warning">{ui('引用位置与当前文字不一致，请重新核对这段原文。')}</InlineMessage>,
    source.selection && document?.currentRevision && document.currentRevision !== source.selection.revision
      && <InlineMessage key="revision" tone="warning">{ui('此引用来自较早版本，当前资料已有更新。')}</InlineMessage>,
    bilingual.notice,
    !localMode && loop.resumeNote === 'updated' && <p key="resume" className="reader-resume-note" role="status">{ui('资料已更新，已回到该章节大致的位置。')}</p>,
  ].filter(Boolean);
  const pagerTitle = item => [itemLabel(item), item.title].filter(Boolean).join(' · ');
  const pageText = (section, index) => sources[index]?.text ?? '';
  // 看原页: one page of the attached original PDF in a small panel, from the text views of a page-based document (never in the PDF tab).
  const canPeek = paged && format === 'pdf' && view !== 'original' && !loading && !!document;
  const openPeek = (page, { figure = false } = {}) => setPeek({ page, figure });
  useEffect(() => { if (!canPeek) setPeek(null); }, [canPeek]);
  const peekBytes = async () => fileUrl ? new Uint8Array(await (await fetch(fileUrl)).arrayBuffer()) : null;

  return <div className="study-document-viewer reader" ref={root} data-usage-area="reader" data-mode={view} data-tone={settings.tone} data-face={settings.face}
    data-narrow={narrow || undefined} style={readerVars(settings)} onKeyDown={onKeyDown}>
    <div className="reader-toolbar">
      <div className="reader-toolbar__group">
        {onBack && <Button size="sm" variant="secondary" icon="arrow-left" className="reader-back-to-question" onClick={onBack}>{backLabel}</Button>}
        {canOutline && <IconButton icon="list" label={ui('目录')} aria-pressed={outlineOn} aria-controls={outlineOn ? outlineId : undefined}
          onClick={() => toggle('outline')} />}
        <SegmentedControl size="sm" className="study-document-preview-mode" label={ui('显示方式')} value={view} options={modes} onChange={chooseView} />
      </div>
      <p className="reader-toolbar__where" title={where || undefined}>{where}</p>
      {meters && <span className="reader-toolbar__mastery"><MasteryLine summary={loop.current} title={ui('本节掌握度')} /></span>}
      <div className="reader-toolbar__group reader-toolbar__group--end">
        {!localMode && view !== 'original' && onPracticePages && <ReadingPractice loop={loop} unit={unit} busy={generateDisabled} onStart={practise} onGenerate={generatePages} />}
        {view !== 'original' && <>
          <IconButton icon="search" label={ui('在文中查找')} aria-pressed={finding} onClick={() => finding ? closeFind() : openFind()} />
          {bilingual.toolbar}
          <DisplaySettings settings={settings} onChange={updateSettings} onReset={resetSettings} underline={!localMode} extra={bilingual.displayRow} />
        </>}
        {!localMode && <IconButton icon="panel" label={ui('学习工具')} aria-pressed={toolsOn} aria-controls={toolsId} data-tour="source-tools-toggle"
          data-attention={capture && !toolsOn ? 'true' : undefined} onClick={() => toggle('tools')}>
          {groups.length > 0 && <span className="reader-badge" aria-hidden="true">{groups.length}</span>}
        </IconButton>}
        {originalHandling(document) === 'download' && <Button size="sm" variant="quiet" icon="download" onClick={downloadOriginal}>{ui('下载原文件')}</Button>}
        {document?.preview?.kind === 'file' && host?.openDocument && <Button size="sm" variant="quiet" icon="external"
          onClick={() => host.openDocument(document.preview.path)}>{ui('使用宿主文件预览')}</Button>}
        {!localMode && onGenerate && <Button variant="primary" icon="sparkle" disabled={generateDisabled} onClick={onGenerate}>{ui('从这份资料出题')}</Button>}
      </div>
    </div>
    <div className="reader-progress" aria-hidden="true"><span style={{ transform: `scaleX(${view === 'original' ? 0 : position.progress})` }} /></div>
    {finding && view !== 'original' && <FindBar query={query} onQuery={setQuery} total={total} index={Math.min(match, Math.max(total - 1, 0))}
      onStep={stepFind} onClose={closeFind} inputRef={findInput} />}
    <div className="study-document-notices reader-notices">{notices}</div>
    <div className="reader-aux">
      {quote && <blockquote className="highlight-quote"><MathText text={quote} /></blockquote>}
      {!localMode && <AudioCorrections audio={source.audio} onReview={call && source.audio?.corrections ? () => call('audio.corrections.review', { sourceId: source.id }) : null} />}
    </div>
    <div className="reader-layout" data-outline={outlineOn ? 'on' : 'off'} data-tools={toolsOn ? 'on' : 'off'}>
      {narrow && (outlineOn || toolsOn) && <button type="button" className="reader-scrim" aria-label={ui('关闭面板')} onClick={() => setOverlay(null)} />}
      {outlineOn && <OutlinePanel id={outlineId} items={outline} activeId={activeId} labelOf={itemLabel} onJump={jumpTo} meters={meters}
        footer={assistTarget && call && view !== 'original' ? <OutlineAssist call={call} target={assistTarget} current={outline} saved={aiOutline} stale={document?.outlineStale}
          missing={aiOutline ? Math.max(0, aiOutline.entries.length - aiItems.length) : 0} onSaved={setAiOutline} onCleared={() => setAiOutline(null)} onChanged={() => onPublished?.()} /> : null} />}
      <div className="reader-scroll" ref={scroller} tabIndex={0} role="region" aria-label={localMode ? localContent.title || source.title || ui('资料内容') : ui('资料内容')} data-mode={view}>
        <div className="reader-page">
          <div className="study-document-body" ref={body} onMouseUp={select} onKeyUp={select} onTouchEnd={select} onClick={pick} onCopy={copy}>
            {view === 'original'
              ? <div className="reader-original"><iframe src={`${fileUrl}#page=${pdfPage}`} title={source.title || ui('原始 PDF')} /></div>
              : reading
                ? html ? <div className="reader-html source-md" data-study-text="true" dangerouslySetInnerHTML={{ __html: html }} />
                  : <ReadingSections sections={sections} labelOf={labelOf} onPeek={canPeek ? openPeek : undefined} />
                : paged ? sections.map((section, index) => <section key={section.id} className="study-document-page reader-section reader-section--page"
                  data-outline-id={section.id} data-study-page={section.page} data-study-source={section.sourceId}>
                  <span className="reader-section__label">{labelOf(section)}</span>
                  {canPeek && <Button variant="quiet" size="sm" className="reader-peek" data-peek-page={section.page} title={ui('看原页')} onClick={() => openPeek(section.page)}>{ui('看原页')}</Button>}
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
      {!localMode && <aside className="study-document-side reader-tools" data-tour="source-tools" id={toolsId} aria-label={ui('学习工具')} hidden={!toolsOn}>
        <h3 className="reader-panel__title">{ui('学习')}</h3>
        <div className="study-document-selection">
          <Button className="study-document-wide" icon="plus" onPointerDown={event => { event.preventDefault(); select(); }} onClick={select}>{ui('使用当前选区')}</Button>
          <DocumentLearning call={call} document={learningDocument} capture={capture} data={data} onPublished={refreshLinks} onOpenCard={onOpenCard}
            onOpenDeck={onOpenDeck} onPractice={onPractice} onStarted={onStarted} />
          {/* Case practice (WP12): a passage can be the seed of a case paper. */}
          {onCaseFromPassage && <Button className="study-document-wide" disabled={!capture?.quote} title={capture?.quote ? undefined : ui('先在原文中选中一段文字')}
            onClick={() => onCaseFromPassage({ sourceId: capture.sourceId || source.id, quote: capture.quote })}>{ui('围绕这段出案例题')}</Button>}
        </div>
        <PassageLinksPanel model={model} focusedKey={focusedKey} onFocus={setFocusedKey} onOpen={onOpenCard} />
      </aside>}
    </div>
    {bilingual.layer}
    {peek && canPeek && <Suspense fallback={null}><PagePeek key={document.revision} page={peek.page} figure={peek.figure} totalPages={Math.max(0, ...sources.map(item => item.document?.totalPages || 0))}
      status={peekStatus({ available: !!fileUrl, original: document.original })} loadBytes={peekBytes} onClose={() => setPeek(null)} onAttach={kind => { setPeek(null); setAttaching(kind); }} /></Suspense>}
    {!localMode && attaching && attachTarget.current && <OriginalDialog target={attachTarget.current}
      call={call} host={host} intent={attaching} onClose={() => setAttaching(null)} onChanged={() => setReload(count => count + 1)} />}
  </div>;
}
