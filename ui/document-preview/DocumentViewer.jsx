import React, { Suspense, lazy, useCallback, useDeferredValue, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import DOMPurify from 'dompurify';
import MathText from '../MathText.jsx';
import { AudioCorrections } from '../audio/AudioCorrections.jsx';
import { ui, uiFormat, useUiLanguage } from '../i18n.js';
import { useInjectCss } from '../shared.js';
import { Button, HelpTip, IconButton, InlineMessage, LoadingState, Tooltip } from '../components/index.js';
import DocumentLearning from './DocumentLearning.jsx';
import { ReaderModelContext } from './ReaderModelGate.jsx';
import { OriginalNotice, OriginalDialog } from './OriginalFile.jsx';
import { originalBytes, pagedFileUrl } from './peek/paged-original.js';
import { issueOf } from './original-file.js';
import { peekStatus } from './peek/peek-logic.js';
import { renderPageImages } from './peek/page-image.js';
import { captureSelection, fuzzyPassageRange, groupPassageLinks, isPlaced, locateQuote, renderedPassageRange, resolveQuote } from './selection.js';
import PassageLinksPanel, { linkTitleWords } from './links/PassageLinksPanel.jsx';
import { buildLinkModel, groupTitle } from './links/link-model.js';
import { usePassageLinkLayer } from './links/usePassageLinkLayer.js';
import useBilingual from './translation/useBilingual.jsx';
import { annotationLinks, loadAnnotationMode, saveAnnotationMode } from './annotation/model.js';
import StaleAnnotations from './annotation/StaleAnnotations.jsx';
import { useReaderMarks } from './marks/useReaderMarks.jsx';
import ExplainCard from './marks/ExplainCard.jsx';
import { isOfficeFormat, isPagedFormat, isSlideFormat } from '../../lib/office/limits.js';
import { groupSourcesByDocument } from '../../lib/source-groups.js';
import { displayTitle } from '../../lib/document-title.js';
import ReadingPractice from './practice/ReadingPractice.jsx';
import { masteryText } from './practice/mastery-copy.js';
import { coverageChipText } from '../coverage/copy.js';
import DocumentTopUp, { offersDocumentTopUp } from '../coverage/DocumentTopUp.jsx';
import { modelReadiness } from '../generation-status.js';
import { useReadingLoop } from './practice/useReadingLoop.js';
import OutlinePanel from './reader/OutlinePanel.jsx';
import OutlineAssist from './reader/OutlineAssist.jsx';
import FindBar from './reader/FindBar.jsx';
import DisplayDialog from './reader/DisplayDialog.jsx';
import ReaderMore from './reader/ReaderMore.jsx';
import WrongPanel from './reader/WrongPanel.jsx';
import MindMapPanel from './reader/MindMapPanel.jsx';
import { moreItems } from './reader/more-items.js';
import { buildMindMap, headingNode } from './reader/mind-map.js';
import { readWrongBook } from './reader/wrong-rows.js';
import PdfOriginal from './reader/PdfOriginal.jsx';
import { clampPage, pageCount, pageScopeOf } from './page-scope.js';
import ReadingSections from './reader/ReadingSections.jsx';
import { renderReaderMarkdown } from './reader/markdown.js';
import { copyText, pickFormula } from './reader/formula.js';
import { useReaderSettings } from './reader/useReaderSettings.js';
import { useReadingPosition, scrollToNode } from './reader/useReadingPosition.js';
import { lastReadKey } from './reader/last-read.js';
import { useLastReadOpening, useKeepLastRead } from './reader/useLastRead.js';
import { readerVars, underlineShown } from './reader/settings.js';
import { readingSections } from './reader/text-sections.js';
import { sectionAtOffset } from '../../lib/sections.js';
import { outlineFromSections, collectHeadings, withoutLabels, structureOutline, sectionNeighbours, chapterNeighbours, outlinePath } from './reader/outline.js';
import { applyOutline, clearOutlineTags } from './reader/ai-outline.js';
import { drawnSectionText, findRanges, paintMatches, textHits } from './reader/find.js';
import { chapterFindGroups, chapterOutline, findStop, withElsewhere } from './reader/chapters.js';
import { useChapterGoal, useReaderChapters } from './reader/useReaderChapters.js';
import { chapterName, chapterRange, chapterTitle, chapterPagerLabel, elsewhereCount, nextChapterWord, previousChapterWord } from './reader/chapter-copy.js';
import { useNarrow } from '../use-narrow.js';
import { hasContext } from '../capabilities.js';

/** Under this width of the viewer the toolbar's controls fill one row (reader-slim.css, @container reader 520px): 待出题 moves into 更多. */
const COMPACT_TOOLBAR = 520;
import css from './document-preview.css';
import readerCss from './reader/reader.css';
import slimCss from './reader/reader-slim.css';
import linksCss from './links/links.css';
import marksCss from './marks/marks.css';
import translationCss from './translation/translation.css';

const useIsoLayoutEffect = typeof window === 'undefined' ? useEffect : useLayoutEffect;
// 看原页 (pdf.js and its worker) is fetched on the first peek, never with the reader.
const PagePeek = lazy(() => import('./peek/PagePeek.jsx'));
/* Within this many pixels of the first chapter's top, the learner is at the material's start: 上次读到 is forgotten, not kept. */
const START_PX = 80;

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


/** The stored text with the quote marked: as written, else by its letters (resolveQuote), found once per text and quote, not per render. */
function QuotedText({ text, quote, anchor, format }) {
  const hit = useMemo(() => resolveQuote(text, quote, anchor), [text, quote, anchor]), mark = useRef(null);
  useEffect(() => { mark.current?.scrollIntoView?.({ block: 'center' }); }, [quote, text]);
  return <pre className={sourceTextClass({ format })} data-study-text="true">{isPlaced(hit.status)
    ? <>{text.slice(0, hit.start)}<mark ref={mark} className="source-hit">{text.slice(hit.start, hit.end)}</mark>{text.slice(hit.end)}</> : text}</pre>;
}

/**
 * The source reader. Three views: 阅读 (reflowed, with an outline), 原文 (the stored text
 * exactly, for checking citations) and 原始 PDF. Props: source, quote, call, data, host,
 * onGenerateStarted(job) (一次性出题 of the 待出题 list started a run; the reader stays), onOpenCard, onPublished, onCaseFromPassage(passage), onGenerate() (shows 「出题」 as the toolbar's primary action; its arrow opens 做这几页的题), generateDisabled, initialMode
 * ('read' | 'text' | 'original'), moreItems (menu items the dialog adds to 更多: rename, today's tasks, the question sets).
 * The toolbar keeps 目录, 出题, 错题, 思维导图 and 更多; everything else is in 更多 (reader/more-items.js).
 * localContent ({ id, title, markdown }) reads saved writing in the same reader without a material identity or material actions.
 * peekPage: a page number to open the 看原页 panel at once the document can show it (a question's 看原页图 sets it).
 * onOpenModelSettings / onOpenSettings(section): where the gates of the reader's model features and the 前往设置 link lead (ReaderModelGate.jsx); without them the app's own are used.
 */
export default function DocumentViewer(props) {
  const { data, onOpenModelSettings, onOpenSettings } = props, model = modelReadiness(data);
  const services = useMemo(() => ({ model, openModelSettings: onOpenModelSettings, openSettings: onOpenSettings }), [model.ready, model.reason, model.label, onOpenModelSettings, onOpenSettings]); // eslint-disable-line react-hooks/exhaustive-deps
  return <ReaderModelContext.Provider value={services}><DocumentReader {...props} /></ReaderModelContext.Provider>;
}

function DocumentReader({ source, quote, call, data, host, onOpenCard, onOpenDeck, onPractice, onStarted, onPublished, onCaseFromPassage, onGenerate, onGenerateStarted, generateDisabled = false, initialMode = 'read',
  onPracticePages, onGeneratePages, onOpenDraftPages, resume: resumeProp, backLabel, onBack, localContent, moreItems: extraItems, peekPage, pickPages = false }) {
  const language = useUiLanguage();
  const localMode = localContent != null;
  useInjectCss(css, 'study-document-preview');
  useInjectCss(readerCss, 'study-reader');
  useInjectCss(slimCss, 'study-reader-slim');
  useInjectCss(linksCss, 'study-reader-links');
  useInjectCss(marksCss, 'study-reader-marks');
  useInjectCss(translationCss, 'study-reader-translation');
  const [loadedDocument, setDocument] = useState(null), [loadedContent, setContent] = useState(''), [fileUrl, setFileUrl] = useState('');
  const [error, setError] = useState(''), [fetching, setLoading] = useState(true), [mode, setMode] = useState(initialMode);
  // Local writing is authoritative on every render, including edits and a switch from an open material.
  const document = localMode ? null : loadedDocument, content = localMode ? String(localContent.markdown ?? '') : loadedContent;
  const loading = !localMode && fetching;
  const [capture, setCapture] = useState(null), [links, setLinks] = useState([]), [focusedKey, setFocusedKey] = useState(null);
  const [settings, updateSettings, resetSettings] = useReaderSettings();
  // 阅读 / 批注: in 批注 the answers of the learning panel are kept with their passage, and the annotated passages are marked like the linked ones.
  const [annotationMode, setAnnotationMode] = useState(loadAnnotationMode), [kept, setKept] = useState({ items: [], stale: [] }), [keptReload, setKeptReload] = useState(0);
  const [overlay, setOverlay] = useState(null);
  const [finding, setFinding] = useState(false), [query, setQuery] = useState(''), [total, setTotal] = useState(0), [match, setMatch] = useState(0);
  const [headings, setHeadings] = useState([]);
  const [aiOutline, setAiOutline] = useState(null), [aiItems, setAiItems] = useState([]), [emptyOpen, setEmptyOpen] = useState(false);
  const [pdfPage, setPdfPage] = useState(() => source.document?.page || source.selection?.page || 1), [pdfView, setPdfView] = useState({ zoom: 1, native: false });
  const [attaching, setAttaching] = useState(null), [reload, setReload] = useState(0), attachTarget = useRef(null); // 补全原文件 (OriginalFile.jsx)
  const [peek, setPeek] = useState(null); // 看原页 (peek/PagePeek.jsx): { page, figure }
  const [displayOpen, setDisplayOpen] = useState(false); // 更多 › 显示设置…
  const [pickPagesGuide, setPickPagesGuide] = useState(!!pickPages);
  useEffect(() => { setPickPagesGuide(!!pickPages); }, [pickPages, source.id]);
  const root = useRef(null), body = useRef(null), scroller = useRef(null), findInput = useRef(null), ranges = useRef([]), openedAt = useRef('');
  // Narrow panes (under NARROW px of the viewer, ui/use-narrow.js): the outline and the learning panel slide over the text instead of sitting beside it.
  const narrow = useNarrow(root), compact = useNarrow(root, COMPACT_TOOLBAR);
  const outlineId = useId(), toolsId = useId();
  useEffect(() => {
    let current = true, objectUrl = '';
    setLoading(true); setError(''); setDocument(null); setContent(''); setFileUrl(''); setCapture(null);
    setPdfView(previous => previous.slow || previous.keepSinglePage ? { zoom: previous.zoom, native: false, slow: false, keepSinglePage: false } : previous);
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
          if (bytes.status === 'paged') { setFileUrl(pagedFileUrl(call, bytes.paged)); return; } // too big to send whole: its pages are asked for as they are drawn
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
  const format = localMode ? 'md' : viewerFormat(document, source), paged = isPagedFormat(format);
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
  // The kept 批注 are read in both modes: 批注 marks them all, 阅读 only the 词解 among them (right-click › AI 词解), which show on hover.
  useEffect(() => {
    if (localMode || !document) return undefined;
    let current = true;
    call('materials.annotation.list', { documentId: document.documentId || document.id, revision: document.revision })
      .then(value => { if (current) setKept({ items: value.items || [], stale: value.stale || [] }); })
      .catch(() => { if (current) setKept({ items: [], stale: [] }); });
    return () => { current = false; };
  }, [call, document, annotationMode, keptReload, localMode]);
  const annotationMarks = useMemo(() => (localMode ? [] : annotationLinks(kept.items).filter(link => annotationMode === 'annotate' || link.explain)), [annotationMode, kept.items, localMode]);
  const groups = useMemo(() => groupPassageLinks(localMode ? [] : [...links, ...annotationMarks]), [links, annotationMarks, localMode]);
  const annotation = useMemo(() => ({ mode: annotationMode, items: kept.items, stale: kept.stale,
    onMode: next => { setAnnotationMode(next); saveAnnotationMode(next); }, onChanged: () => setKeptReload(count => count + 1) }), [annotationMode, kept]);
  const clearStaleAnnotations = async () => {
    await call('materials.annotation.delete', { documentId: document.documentId || document.id, revision: document.revision, stale: true });
    setKeptReload(count => count + 1);
  };
  const learningDocument = useMemo(() => document ? { ...document, sourceId: source.id } : { sourceId: source.id }, [document, source.id]);
  const sources = useMemo(() => localMode ? [{ id: localContent.id, title: localContent.title, text: content, format: 'md' }] : document?.sources || [source], [localMode, localContent?.id, localContent?.title, content, document, source]);
  // 原始 PDF: the learning panel asks about the page our own controls show (page-scope.js). It is a panel of its own, mounted the first time the
  // view is opened and then kept: the reading panel (its selection, its thread, a question still being answered and kept as 批注) is only hidden
  // meanwhile, so it is never shown with an old quote in 原始 PDF and is all there again on the way back to 阅读.
  const totalPages = pageCount(sources);
  // A range of pages (#488) belongs to the page it was made on: turning the page, by any way, ends it.
  const [pageRange, setPageRange] = useState(null), pageTo = pageRange?.from === pdfPage ? pageRange.to : 0;
  if (pageRange && !pageTo) setPageRange(null); // gone for good: turning back does not bring it back
  const askThrough = to => setPageRange(to ? { from: pdfPage, to } : null);
  const pageScope = useMemo(() => format === 'pdf' && fileUrl ? pageScopeOf(sources, pdfPage, pageTo) : null, [format, fileUrl, sources, pdfPage, pageTo]);
  const goToPage = page => { const next = clampPage(page, totalPages); if (next !== null) setPdfPage(next); };
  // 发给主会话 of a page: the picture of its pages, from the file this view already holds (peek/page-image.js; pdf.js is fetched on the first use).
  const pageBytes = useRef(null); pageBytes.current = fileUrl;
  const pageImages = useCallback(pages => renderPageImages({ pages, totalPages, loadBytes: async () => pageBytes.current ? originalBytes(pageBytes.current) : null }), [totalPages]);
  const [pagePanel, setPagePanel] = useState(false);
  if (view === 'original' && pageScope && !pagePanel) setPagePanel(true);
  // In 原始 PDF the reading panel shows only its 补题 job cards (it holds and polls them, once), above the page panel; the rest of it waits for 阅读.
  const learningPanels = [{ scope: 'selection', hidden: false, props: { capture, annotation, jobsOnly: view === 'original' } },
    ...(pagePanel && pageScope ? [{ scope: 'page', hidden: view !== 'original', props: { capture: null, scope: pageScope, pageTotal: totalPages, onPage: goToPage, onRange: askThrough, pageImages } }] : [])];
  const html = useMemo(() => !reading ? '' : format === 'md' ? safeDocumentHtml(renderReaderMarkdown(content), { markdownImages: localMode })
    : format === 'html' ? safeDocumentHtml(content) : '', [content, format, reading, localMode]);
  const allSections = useMemo(() => (reading && !html) || paged ? readingSections({ paged, sources, text: sources[0]?.text || content, sourceId: sources[0]?.id }) : [],
    [reading, html, paged, sources, content]);
  // One chapter at a time (reader/chapters.js): the document's own chapters, the 「查看 N 章」 list of its 资料 row (groupSourcesByDocument), else blocks of pages.
  const documentChapters = useMemo(() => {
    if (!paged || localMode) return null;
    const items = groupSourcesByDocument(sources);
    return (items.find(item => item.sourceIds.includes(source.id)) || items[0])?.chapters ?? null;
  }, [paged, localMode, sources, source.id]);
  // The material this source belongs to (its 资料 row).
  const documentItem = useMemo(() => data?.sources ? groupSourcesByDocument(data.sources).find(item => item.sourceIds.includes(source.id)) || null : null, [data?.sources, source.id]);
  // 上次读到 (reader/useLastRead.js): opened plainly from its 资料 row, a material goes back to where it was last read; the reader keeps that place while the learner reads.
  const materialKey = lastReadKey(data?.root, documentItem?.key);
  const lastReadOpening = useLastReadOpening({ key: materialKey, sourceId: source.id, firstSourceId: documentItem?.sourceIds?.[0], quote, resume: resumeProp, peekPage, localMode });
  const resume = resumeProp || lastReadOpening;
  // Where the reader opens: a stored reading position (its section, its page), else the source it was opened with (a page, a chapter's first page, a citation).
  const opening = useMemo(() => resume?.sectionId || Number.isInteger(resume?.page) ? { sectionId: resume.sectionId, page: resume.page } : { sourceId: source.id, page: source.document?.page },
    [resume, source.id, source.document?.page]);
  const chapter = useReaderChapters({ paged, sections: allSections, chapters: documentChapters, opening, openKey: `${source.id}:${resume?.nonce ?? ''}` });
  const chaptered = chapter.chapters.length > 0, sections = chapter.sections;
  // A page section's text is its source's (readingSections makes one section per source); find reads the chapters not drawn from it.
  const textBySource = useMemo(() => new Map(sources.map(item => [item.id, item.text ?? ''])), [sources]);
  const slides = isSlideFormat(format);
  const pageLabel = useCallback(page => slides ? uiFormat('第 {0} 张', [page]) : uiFormat('第 {0} 页', [page]), [slides]);
  // A recording's entry says which one it is; a part that carries on from the previous volume says so.
  const recordingLabel = item => item.kind === 'recording' ? uiFormat('录音 {0}', [item.recording]) : item.continued ? ui('接上一卷') : '';
  const labelOf = useCallback(section => section.kind === 'page' ? pageLabel(section.page) : recordingLabel(section), [pageLabel, language]); // eslint-disable-line react-hooks/exhaustive-deps
  const itemLabel = item => item.kind === 'chapter' ? chapterRange(item.chapter, slides) : item.page ? pageLabel(item.page) : recordingLabel(item);
  const textOutline = useMemo(() => outlineFromSections(allSections), [allSections]);
  const chapterEntries = useMemo(() => chaptered ? chapterOutline(chapter.chapters.map(entry => ({ ...entry, title: chapterTitle(entry) })), textOutline) : null,
    [chaptered, chapter.chapters, textOutline, language]); // eslint-disable-line react-hooks/exhaustive-deps
  const autoOutline = reading && html ? headings : chapterEntries || textOutline;
  // The labels of a bilingual Markdown transcript (### 英文原句, ### 中文对照) stay in the text; they are not sections of it.
  useEffect(() => { setHeadings(reading && html ? withoutLabels(collectHeadings(body.current)) : []); }, [reading, html]);
  // A kept AI outline (materials.outline.*) replaces the automatic one wherever its entries can be placed in what is drawn.
  useEffect(() => { setAiOutline(document?.outline ?? null); }, [document]);
  useIsoLayoutEffect(() => {
    const drawn = body.current;
    if (localMode || !aiOutline || view === 'original' || loading) { clearOutlineTags(drawn); setAiItems(items => items.length ? [] : items); return; }
    const placed = applyOutline(drawn, aiOutline.entries);
    // One chapter is drawn: the entries of the others stay listed, and a click opens their chapter (reader/chapters.js withElsewhere).
    setAiItems(chaptered ? withElsewhere(aiOutline.entries, placed, { drawn: new Set(sections.map(section => section.sourceId)), known: new Set(allSections.map(section => section.sourceId)) }) : placed);
  }, [aiOutline, view, html, sections, allSections, chaptered, content, document, loading, localMode]);
  const aiOn = !localMode && view !== 'original' && aiItems.length > 0;
  const outlineItems = aiOn ? aiItems : autoOutline;
  // The chapters of the reader fold their pages themselves (outline.js defaultExpanded); a page heading met in many chapters is no label.
  const outline = useMemo(() => structureOutline(outlineItems, { fold: !aiOn && !chapterEntries }), [outlineItems, aiOn, chapterEntries]);
  const [position, jump] = useReadingPosition(scroller, outline, `${view}:${html.length}:${sections.length}:${aiItems.length}:${chapter.current?.id ?? ''}`);
  const activeId = view === 'original' ? textOutline.find(item => item.page === pdfPage)?.id ?? null : position.activeId;
  // Previous / next walk the sections; once the learner has applied the outline as the document's chapters, they walk the chapters.
  const chapterLevel = aiOn && aiOutline?.segmentation?.level;
  const around = useMemo(() => chapterLevel ? chapterNeighbours(outline, activeId, chapterLevel) : sectionNeighbours(outline, activeId), [outline, activeId, chapterLevel]);
  const here = outline.find(item => item.id === activeId);
  const where = here ? [itemLabel(here), outlinePath(outline, here.id).join(' › ')].filter(Boolean).join(' · ') : '';
  const jumpTo = item => {
    if (view === 'original') { const page = item.kind === 'chapter' ? item.chapter.startPage : item.page; if (page) setPdfPage(page); }
    // A chapter opens at its top; an entry of a chapter that is not drawn opens its chapter and lands on it (useReaderChapters).
    else if (item.kind === 'chapter') chapter.goTo({ chapterId: item.id });
    else if (item.elsewhere) chapter.goTo({ sourceId: item.sourceId, outlineId: item.id });
    else if (chaptered && !sections.some(section => section.id === item.id) && chapter.goTo({ sectionId: item.id, page: item.page })) { /* its chapter opens and scrolls to it */ }
    else if (item.range && item.tagged === false) scrollToNode(scroller.current, item.range);
    else jump(item.id);
    if (narrow) setOverlay(null);
  };
  const assistTarget = useMemo(() => document ? { documentId: document.documentId || document.id, sourceId: source.id, revision: document.revision, legacy: !!document.legacy } : null, [document, source.id]);

  useEffect(() => { setOverlay(null); }, [narrow]);
  // The panel is also there when no headings were found, so "让 AI 帮你" can be asked for (it then opens only on request).
  const canOutline = outline.length > 0 || (!!assistTarget && view !== 'original' && !loading && !!call);
  const outlineOn = canOutline && (narrow ? overlay === 'outline' : outline.length > 0 ? settings.outline : emptyOpen);
  const toolsOn = !localMode && (narrow ? overlay === 'tools' : settings.tools);
  const toggle = panel => narrow ? setOverlay(current => current === panel ? null : panel)
    : panel === 'outline' && outline.length === 0 ? setEmptyOpen(open => !open) : updateSettings({ [panel]: !settings[panel] });

  const select = () => {
    // 原始 PDF draws the page in a frame whose selection never reaches here: the panel asks about the page (pageScope), not a selection.
    if (localMode || view === 'original') return;
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
  // 读 → 做这几页的题 → 回到阅读 → 掌握度: the questions linked to this document placed under the outline, the range chooser, and the way back to a stored position.
  // A place named by its offset into the text (在资料中查看 on a part of a question run) is the section that offset is in (lib/sections.js; ids are the outline's own); a page of a PDF opens at its page.
  const place = useMemo(() => resume && Number.isInteger(resume.at) && !paged && !html && !resume.sectionId ? sectionAtOffset([{ id: sources[0]?.id ?? source.id, text: sources[0]?.text || content }], sources[0]?.id ?? source.id, resume.at) : null,
    [resume, paged, html, sources, content, source.id]);
  // Only the sections this reader draws (a transcript's recordings and parts) can be started at; Markdown draws its own headings, text without structure has none.
  const resumeAt = useMemo(() => resume && (place?.kind === 'recording' || place?.kind === 'part') ? { ...resume, sectionId: place.sectionId } : resume, [resume, place]);
  const unit = aiOn || !paged ? 'section' : isSlideFormat(format) ? 'slide' : 'page';
  const loop = useReadingLoop({ call, document, source, version: data?.revision, view, paged, unit, sections: allSections, outline, activeId, chapterLevel, documentItem, body, scroller, loading, rendered, resume: resumeAt });
  useKeepLastRead({ key: materialKey, enabled: !localMode && view !== 'original' && !loading, root, scroller, here: loop.here, watch: chapter.current?.id,
    atStart: () => (!chaptered || chapter.index <= 0) && (scroller.current?.scrollTop ?? 0) < START_PX });
  useEffect(() => { if (loop.open && pickPagesGuide) setPickPagesGuide(false); }, [loop.open, pickPagesGuide]);
  const practise = option => { const started = loop.start(option); loop.setOpen(false); onPracticePages?.(started); };
  const generatePages = option => { loop.setOpen(false); onGeneratePages?.(loop.generateIds(option)); };
  const openDraftPages = draftIds => { loop.setOpen(false); onOpenDraftPages?.(draftIds); };
  const meters = !localMode && loop.status === 'ready' && loop.total > 0 && view !== 'original' ? loop.meters : null;
  // Which passages are underlined (resolved links), their mastery state, and which must be selected again; notes follow their cards.
  const cardMastery = useMemo(() => (!localMode && loop.cards?.length ? new Map(loop.cards.map(card => [`${card.deckId}:${card.cardId}`, card])) : null), [localMode, loop.cards]);
  const model = useMemo(() => buildLinkModel(groups, { noteBadges: data?.noteBadges, cardMastery }), [groups, data?.noteBadges, cardMastery]);
  const linkTitle = group => groupTitle(group, linkTitleWords());
  // A kept thread is opened in the learning panel: its passage becomes the selection there, and the panel brings its answers back.
  const openAnnotation = link => {
    const at = link.selection;
    if (view === 'original') setMode('read'); // a kept passage is shown where it can be selected
    setCapture(previous => previous?.sourceId === at.sourceId && previous?.start === at.start && previous?.end === at.end ? previous
      : { quote: at.quote, prefix: at.prefix || '', suffix: at.suffix || '', sourceId: at.sourceId, start: at.start, end: at.end, ...(at.page ? { page: at.page } : {}) });
    if (narrow) setOverlay('tools'); else if (!settings.tools) updateSettings({ tools: true });
  };
  const openGroup = group => {
    setFocusedKey(group.key);
    const note = group.links.find(link => link.kind === 'annotation');
    if (note) openAnnotation(note);
    else if (narrow) setOverlay('tools'); else if (!settings.tools) updateSettings({ tools: true });
  };
  // A 词解 shows its answer in a card while the pointer is on its line (marks/ExplainCard.jsx), not in hover text.
  const [explainShown, setExplainShown] = useState(null);
  const explainOf = group => { const link = group.links.find(item => item.explain); return link ? { term: link.term, answer: link.answer } : null; };
  usePassageLinkLayer({ body, groups: model.groups, rendered, underline: underlineShown(settings), onOpen: openGroup, titleOf: linkTitle, cardOf: explainOf, onCard: setExplainShown });
  const canStudyBank = hasContext(data, 'bank') && hasContext(data, 'study');
  const canBatchTranslate = hasContext(data, 'generation');
  const canAudio = hasContext(data, 'audio');
  const canQueueGenerate = hasContext(data, 'generation') && hasContext(data, 'bank') && hasContext(data, 'authoring');
  // Right-click on the text: 下划线 / 加粗 / 荧光笔, 加入待出题 and AI 词解 (marks/useReaderMarks.jsx); 待出题 N in the toolbar starts one run for the list.
  const marks = useReaderMarks({ call, document: learningDocument, data, body, rendered, enabled: !localMode && view !== 'original' && !!document, compact,
    canQueue: canQueueGenerate, onExplained: () => setKeptReload(count => count + 1), onBatchStarted: onGenerateStarted, busy: generateDisabled });
  // The bilingual reading (译): marks and blocks beside the paragraphs, the page / chapter job, the glossary (translation/useBilingual.jsx).
  const bilingual = useBilingual({ call, document, source, view, paged, narrow, body, scroller, rendered, outline, activeId, chapterLevel, enabled: !localMode, batchEnabled: canBatchTranslate });
  const quoteText = sources.find(item => item.id === source.id)?.text || content;
  const quoteState = useMemo(() => !quote ? null : view === 'text' ? resolveQuote(quoteText, quote, source.selection) : locateQuote(quoteText, quote, source.selection),
    [quote, quoteText, source.selection, view === 'text']); // eslint-disable-line react-hooks/exhaustive-deps
  // A paged document is opened at the page a citation is on (page 1 is the top).
  const showSourcePage = () => {
    if (paged && (source.document?.page || 1) > 1) scrollToNode(scroller.current, scroller.current?.querySelector(`[data-study-source="${source.id}"]`), { smooth: false });
  };
  // How the quote was placed in what the reading view draws: 'resolved' (as written), 'fuzzy' (by its letters: hyphenation, markup, width), 'ambiguous', 'missing'.
  const [placed, setPlaced] = useState(null);
  useEffect(() => {
    if (!reading || !quote || loading) { setPlaced(null); return undefined; }
    // One chapter at a time: the quote is placed while the chapter of its page is drawn. In another chapter it is neither found nor missing: no notice, no scroll.
    if (chaptered && !sections.some(section => section.sourceId === source.id)) return undefined;
    if (quoteState?.status === 'ambiguous' || quoteState?.status === 'stale') { setPlaced(null); showSourcePage(); return undefined; }
    const selection = { ...source.selection, sourceId: source.id, quote };
    let range = renderedPassageRange(body.current, selection), how = 'resolved';
    if (!range) {
      const found = fuzzyPassageRange(body.current, selection);
      range = found.range || null; how = found.status;
    }
    setPlaced(how);
    // Not found in the drawn text: the page it belongs to is shown, and the notice says the place is not exact.
    if (!range) { showSourcePage(); return undefined; }
    scrollToNode(scroller.current, range.startContainer.parentElement, { center: true, smooth: false });
    if (window.CSS?.highlights && window.Highlight) {
      window.CSS.highlights.set('study-source-quote', new window.Highlight(range));
      return () => window.CSS.highlights.delete('study-source-quote');
    }
    return undefined;
  }, [reading, loading, html, sections, quote, quoteState?.status, source.id, source.selection]); // eslint-disable-line react-hooks/exhaustive-deps

  // A new view starts at the top; a page or slide opened from a link starts at that page.
  useEffect(() => { scroller.current?.scrollTo?.({ top: 0 }); }, [view]);
  useEffect(() => {
    const key = `${source.id}:${view}`;
    // A quote owns the scroll when the reading view places it (above, which also falls back to the page) or the 原文 view marks it.
    if (!paged || (quote && (reading || isPlaced(quoteState?.status))) || loading || !sections.length || view === 'original' || openedAt.current === key) return;
    openedAt.current = key;
    showSourcePage();
  }, [paged, quote, reading, quoteState?.status, loading, sections, view, source.id, source.document?.page]); // eslint-disable-line react-hooks/exhaustive-deps
  // Another chapter, once drawn, opens at its top or at the page / entry the jump named (after the effects above, so it has the last word).
  useChapterGoal({ goal: chapter.goal, reached: chapter.reached, scroller, body, ready: !loading && view !== 'original', drawn: sections });

  // Search in the document: matches are DOM ranges painted with the Custom Highlight API.
  const deferredQuery = useDeferredValue(query);
  // The chapter drawn is searched in the page; every chapter also in the text the view draws of it (find.js textHits), so another chapter's count is the one found there.
  const [findRun, setFindRun] = useState(0), findLanding = useRef(null);
  useEffect(() => {
    ranges.current = finding && view !== 'original' && deferredQuery.trim() ? findRanges(body.current, deferredQuery) : [];
    const landing = findLanding.current;
    findLanding.current = null;
    // Arriving in another chapter from find: at its first match, or at its last when Shift+Enter went back.
    const at = landing === 'last' ? ranges.current.length - 1 : 0;
    setTotal(ranges.current.length);
    setMatch(Math.max(0, at));
    setFindRun(count => count + 1);
  }, [finding, deferredQuery, view, html, sections, content, model]);
  useEffect(() => {
    if (!total) return undefined;
    const index = Math.min(match, total - 1), clear = paintMatches(ranges.current, index);
    const rect = ranges.current[index]?.getBoundingClientRect?.(), area = scroller.current?.getBoundingClientRect();
    if (rect && area && (rect.top < area.top + 56 || rect.bottom > area.bottom - 56))
      scroller.current.scrollTo({ top: scroller.current.scrollTop + rect.top - area.top - area.height / 3, behavior: 'auto' });
    return clear;
  }, [total, match, findRun]);
  // What find reads in each chapter: the reading view's paragraphs, or each page's stored text in 原文 (folded once per chapter, kept while the text is).
  const findGroups = useMemo(() => chaptered ? chapterFindGroups(chapter.chapters, allSections, view === 'text' ? section => textBySource.get(section.sourceId) ?? '' : drawnSectionText) : [],
    [chaptered, chapter.chapters, allSections, view, textBySource]);
  const findHits = useMemo(() => finding && chaptered && view !== 'original' && deferredQuery.trim() ? textHits(findGroups, deferredQuery)
    .map(hit => ({ ...hit, at: chapter.chapters.findIndex(entry => entry.id === hit.key) })) : [], [finding, chaptered, view, deferredQuery, findGroups, chapter.chapters]);
  const findIn = (at, landing) => { findLanding.current = landing; chapter.goTo({ chapterId: chapter.chapters[at].id }); };
  const elsewhere = useMemo(() => findHits.filter(hit => hit.at !== chapter.index).map(hit => ({ key: hit.key, title: chapterTitle(chapter.chapters[hit.at]),
    detail: elsewhereCount(hit.first.page, hit.count, slides), onGo: () => findIn(hit.at, 'first') })),
  [findHits, chapter.index, chapter.chapters, slides, language]); // eslint-disable-line react-hooks/exhaustive-deps
  const openFind = () => {
    const selected = window.getSelection?.()?.toString().trim();
    if (selected && selected.length <= 80 && !selected.includes('\n')) setQuery(selected);
    setFinding(true);
    requestAnimationFrame(() => { findInput.current?.focus(); findInput.current?.select(); });
  };
  const closeFind = () => { setFinding(false); scroller.current?.focus?.({ preventScroll: true }); };
  // Enter / Shift+Enter: the next / previous match of the chapter, then on to the next chapter that has one (the one before, at its last match), round the book.
  const stepFind = delta => {
    if (!chaptered) { setMatch(current => total ? (current + delta + total) % total : 0); return; }
    const stop = findStop({ hits: findHits.map(hit => hit.at), current: chapter.index, total, match: Math.min(match, Math.max(total - 1, 0)), delta });
    if (stop?.chapter !== undefined) findIn(stop.chapter, stop.landing);
    else if (stop) setMatch(stop.match);
  };
  const onKeyDown = event => {
    if ((event.ctrlKey || event.metaKey) && !event.altKey && event.key.toLowerCase() === 'f' && view !== 'original') { event.preventDefault(); openFind(); }
    else if (event.key === 'Escape' && overlay) { event.preventDefault(); event.stopPropagation(); setOverlay(null); }
    else if (!localMode && onPracticePages && view !== 'original' && event.key.toLowerCase() === 'p' && !event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey
      && !event.target.closest?.('input,textarea,select,[contenteditable]')) { event.preventDefault(); loop.setOpen(!loop.open); }
  };

  // The 原始 PDF tab without a file is not dead: it explains and offers 补全原文件.
  const chooseView = value => {
    if (value === 'original' && !fileUrl) { if (document) setAttaching(issueOf(document.original)?.kind === 'none' ? 'attach' : 'relink'); return; }
    // Back from 原始 PDF, the text opens at the page the PDF was on, in its chapter.
    if (view === 'original' && value !== 'original' && chaptered) chapter.goTo({ page: pdfPage });
    setMode(value);
  };
  // What the original file is: nothing was kept ('none': said in 更多), or a file that went missing or changed (a fault: its notice stays).
  const originalIssue = !localMode && document && !document.originalAvailable ? issueOf(document.original) : null;
  const originalNone = originalIssue?.kind === 'none', originalFault = !!originalIssue && !originalNone;
  if (document) attachTarget.current = { documentId: document.documentId || document.id, revision: document.revision, title: document.filename || document.title || source.title, format };
  const notices = [
    loading && <LoadingState key="loading" label={ui('正在打开资料…')} />,
    !localMode && pickPagesGuide && view !== 'original' && onPracticePages && (
      <InlineMessage key="pick-pages" tone="info" onDismiss={() => setPickPagesGuide(false)}
        action={{ label: ui('做这几页的题'), disabled: generateDisabled, onClick: () => loop.setOpen(!loop.open) }}>
        {ui('先翻到正在看的那一章或那几页，再点「做这几页的题」（或「AI 出题」旁的箭头 / 快捷键 P），就只会抽已学范围的题。')}
      </InlineMessage>
    ),
    // A document that only kept its text is said in 更多 (the 原始 PDF item, or 补全原文件…); a file that went missing or changed is a fault and keeps its notice.
    !localMode && originalFault && <OriginalNotice key="original" document={document} onAction={setAttaching} />,
    !localMode && error && <InlineMessage key="error" tone="error">{error}</InlineMessage>,
    (quoteState?.status === 'ambiguous' || (reading && placed === 'ambiguous')) && <InlineMessage key="ambiguous" tone="warning">{ui('引用在资料中出现多次，请结合上下文核对位置。')}</InlineMessage>,
    quoteState?.status === 'stale' && <InlineMessage key="stale" tone="warning">{ui('引用位置与当前文字不一致，请重新核对这段原文。')}</InlineMessage>,
    quote && !loading && (view === 'text' ? quoteState?.status === 'missing' : reading && placed === 'missing')
      && <InlineMessage key="unplaced" tone="warning">{ui('没能精确定位这段引文，已显示所在资料。')}</InlineMessage>,
    source.selection && document?.currentRevision && document.currentRevision !== source.selection.revision
      && <InlineMessage key="revision" tone="warning">{ui('此引用来自较早版本，当前资料已有更新。')}</InlineMessage>,
    bilingual.notice,
    !localMode && loop.resumeNote === 'updated' && <p key="resume" className="reader-resume-note" role="status">{ui('资料已更新，已回到该章节大致的位置。')}</p>,
  ].filter(Boolean);
  const pagerTitle = item => [itemLabel(item), item.title].filter(Boolean).join(' · ');
  // The links under the text: 上一章 / 下一章 when one chapter is drawn, else 上一节 / 下一节.
  const pagerLink = (target, word) => !target ? null : chaptered ? { word, title: chapterName(target, slides), go: () => chapter.goTo({ chapterId: target.id }) }
    : { word, title: pagerTitle(target), go: () => jumpTo(target) };
  const pager = chaptered ? { label: chapterPagerLabel(), previous: pagerLink(chapter.around.previous, previousChapterWord()), next: pagerLink(chapter.around.next, nextChapterWord()) }
    : { label: ui('上一节与下一节'), previous: pagerLink(around.previous, ui('上一节')), next: pagerLink(around.next, ui('下一节')) };
  const pageText = section => textBySource.get(section.sourceId) ?? '';
  // 看原页: one page of the attached original PDF in a small panel, from the text views of a page-based document (never in the PDF tab).
  const canPeek = paged && format === 'pdf' && view !== 'original' && !loading && !!document;
  const openPeek = useCallback((page, { figure = false } = {}) => setPeek({ page, figure }), []);
  useEffect(() => { if (!canPeek) setPeek(null); }, [canPeek]);
  // Opened from a question's 看原页图: the original page is up as soon as the document can show it, once (closing it does not bring it back).
  const peekOnOpen = useRef(peekPage);
  useEffect(() => { if (canPeek && peekOnOpen.current) { openPeek(peekOnOpen.current, { figure: true }); peekOnOpen.current = 0; } }, [canPeek, openPeek]);
  const peekBytes = async () => fileUrl ? originalBytes(fileUrl) : null;

  // 思维导图: the current chapter drawn from its headings, no model (reader/mind-map.js). A page-based document is read from the heading paragraphs of the pages drawn;
  // text, and a kept AI outline, from the branch of the outline around the current entry.
  const materialName = documentItem?.title ? displayTitle(documentItem.title) : source.title || '';
  const chapterPages = chapter.current ? { from: chapter.current.startPage, to: chapter.current.endPage } : null;
  const mindMap = useMemo(() => {
    if (paged && !aiOn) {
      const ids = new Set(sections.map(section => section.id));
      return buildMindMap({ title: chapter.current ? chapterTitle(chapter.current) : materialName, sections, outline: outline.filter(item => ids.has(item.id)) });
    }
    return buildMindMap({ title: materialName, outline, activeId, branch: true });
  }, [paged, aiOn, sections, outline, activeId, chapter.current, materialName, language]); // eslint-disable-line react-hooks/exhaustive-deps
  const jumpMap = node => {
    const target = node.target || {};
    if (target.outlineId != null) { const item = outline.find(entry => entry.id === target.outlineId); if (item) jumpTo(item); return; }
    if (view === 'original') { if (target.page) setPdfPage(target.page); return; }
    scrollToNode(scroller.current, headingNode(scroller.current, target), { smooth: false });
  };
  // 错题: the rows of the 错题与待巩固 page that are questions of this material, this chapter's first (reader/wrong-rows.js).
  const drawnIds = useMemo(() => chaptered ? new Set(sections.map(section => section.id)) : null, [chaptered, sections]);
  const readWrong = useCallback(keys => readWrongBook({ call, keys }), [call]);
  const seekRow = row => { const item = outline.find(entry => entry.id === row.entryId); if (item) jumpTo(item); };
  const practiseRow = row => {
    const cards = [{ deckId: row.deckId, cardId: row.cardId }];
    if (onPracticePages) onPracticePages(loop.start({ kind: 'here', count: 1, cards }));
    else onPractice?.({ deckId: row.deckId, cardIds: [row.cardId] });
  };
  // 更多: what the toolbar does not show (reader/more-items.js). Each item opens what it always opened; 掌握度与覆盖 and AI 整理目录 open the 目录, where they live.
  const qualityText = [meters && masteryText(loop.current), !localMode && view !== 'original' && loop.coverage?.cards > 0 && coverageChipText(loop.coverage)].filter(Boolean).join(' · ');
  const openOutlineAnd = focus => {
    if (!outlineOn) toggle('outline');
    if (focus) requestAnimationFrame(() => requestAnimationFrame(() => root.current?.querySelector(focus)?.focus?.()));
  };
  const menu = moreItems({ view, format, fileUrl: !!fileUrl, localMode, translate: bilingual.supported, display: true, tools: localMode ? null : { on: toolsOn, count: groups.length },
    quality: qualityText && canOutline ? { text: qualityText } : null, assist: !!(assistTarget && call && view !== 'original'), download: originalHandling(document) === 'download',
    hostPreview: !!(document?.preview?.kind === 'file' && host?.openDocument), attach: !localMode && format !== 'pdf' && originalNone, extra: [...marks.moreItems, ...(extraItems || [])] },
  { setView: chooseView, find: openFind, translate: bilingual.openDialog, display: () => setDisplayOpen(true), tools: () => toggle('tools'), quality: () => openOutlineAnd(),
    assist: () => openOutlineAnd('.reader-outline__foot button'), download: downloadOriginal, hostPreview: () => host.openDocument(document.preview.path), attach: () => setAttaching('attach') });

  return <div className="study-document-viewer reader" ref={root} data-usage-area="reader" data-mode={view} data-tone={settings.tone} data-face={settings.face}
    data-narrow={narrow || undefined} style={readerVars(settings)} onKeyDown={onKeyDown}>
    <div className="reader-toolbar">
      <div className="reader-toolbar__group">
        {onBack && <Button size="sm" variant="secondary" icon="arrow-left" className="reader-back-to-question" onClick={onBack}>{backLabel}</Button>}
        {canOutline && <IconButton icon="list" className="reader-toolbar__icon-btn" label={ui('目录')} aria-pressed={outlineOn} aria-controls={outlineOn ? outlineId : undefined}
          onClick={() => toggle('outline')} />}
      </div>
      {/* 出题 is the one primary control; the arrow beside it opens 做这几页的题 (shortcut P). 错题 and 思维导图 are panels. */}
      <div className="reader-toolbar__actions">
        {!localMode && onGenerate && <span className="reader-split" data-tour="reader-generate">
          <Tooltip layer content={ui('从这份资料出题')}><Button variant="primary" size="sm" icon="sparkle" className="reader-split__main" disabled={generateDisabled} onClick={onGenerate}>{ui('AI 出题')}</Button></Tooltip>
          {view !== 'original' && onPracticePages && <ReadingPractice split loop={loop} unit={unit} busy={generateDisabled} onStart={practise} onGenerate={generatePages} onOpenDraft={onOpenDraftPages ? openDraftPages : undefined} />}
        </span>}
        {!localMode && !onGenerate && view !== 'original' && onPracticePages && <ReadingPractice loop={loop} unit={unit} busy={generateDisabled} onStart={practise} onGenerate={generatePages} onOpenDraft={onOpenDraftPages ? openDraftPages : undefined} />}
        {!localMode && document && call && canStudyBank && <WrongPanel read={readWrong} cards={loop.cards} entryOf={loop.entryOf} drawn={drawnIds} chapterTitle={chapter.current ? chapterTitle(chapter.current) : ''}
          disabled={loop.status !== 'ready'} onPractice={practiseRow} onSeek={seekRow} />}
        {!loading && <MindMapPanel map={mindMap} document={materialName} pages={chapterPages} onJump={jumpMap} />}
        {marks.chip}
      </div>
      <p className="reader-toolbar__where">{where ? <Tooltip layer content={where}><span tabIndex={0}>{where}</span></Tooltip> : null}</p>
      {view === 'original' && !localMode && <HelpTip label={ui('在原始 PDF 里怎么提问')} placement="bottom-end">{ui('在原始 PDF 里按页提问（「学习工具」）；要问选中的一段，请切换到「阅读」。')}</HelpTip>}
      {!localMode && loop.returnDelta > 0 && <span className="reader-toolbar__delta" role="status">{uiFormat('本轮 +{0}%', [loop.returnDelta])}</span>}
      <div className="reader-toolbar__group reader-toolbar__group--end"><ReaderMore items={menu} attention={(!!capture && !toolsOn) || marks.moreItems.length > 0} /></div>
    </div>
    <div className="reader-progress" aria-hidden="true"><span style={{ transform: `scaleX(${view === 'original' ? 0 : position.progress})` }} /></div>
    {finding && view !== 'original' && <FindBar query={query} onQuery={setQuery} total={total} index={Math.min(match, Math.max(total - 1, 0))} elsewhere={elsewhere}
      onStep={stepFind} onClose={closeFind} inputRef={findInput} />}
    <div className="study-document-notices reader-notices">{notices}</div>
    <div className="reader-aux">
      {quote && <div className="reader-aux__bar"><blockquote className="highlight-quote reader-aux__quote"><MathText text={quote} /></blockquote>
        {canPeek && !!fileUrl && Number.isInteger(source.document?.page) && <Button variant="quiet" size="sm" className="reader-peek" data-peek-page={source.document.page} title={ui('看原页')} onClick={() => openPeek(source.document.page)}>{ui('看原页')}</Button>}</div>}
      {!localMode && <AudioCorrections audio={source.audio} onReview={call && canAudio && source.audio?.corrections ? () => call('audio.corrections.review', { sourceId: source.id }) : null} />}
    </div>
    <div className="reader-layout" data-outline={outlineOn ? 'on' : 'off'} data-tools={toolsOn ? 'on' : 'off'}>
      {narrow && (outlineOn || toolsOn) && <button type="button" className="reader-scrim" aria-label={ui('关闭面板')} onClick={() => setOverlay(null)} />}
      {outlineOn && <OutlinePanel id={outlineId} data-tour="reader-outline" items={outline} activeId={activeId} labelOf={itemLabel} onJump={jumpTo} meters={meters} upgradedIds={loop.upgradedIds}
        coverage={!localMode && view !== 'original' && loop.coverage?.cards > 0 ? loop.outlineCoverage : null} coverageTotals={loop.coverage}
        coverageAction={!localMode && data && canQueueGenerate && offersDocumentTopUp({ item: documentItem, coverage: loop.coverage, jobs: data.jobs, modelReady: modelReadiness(data).ready })
          ? <DocumentTopUp item={documentItem} revision={data.revision} placement="bottom-start" block /> : null}
        footer={assistTarget && call && view !== 'original' ? <OutlineAssist call={call} target={assistTarget} current={outline} saved={aiOutline} stale={document?.outlineStale}
          missing={aiOutline ? Math.max(0, aiOutline.entries.length - aiItems.length) : 0} onSaved={setAiOutline} onCleared={() => setAiOutline(null)} onChanged={() => onPublished?.()} /> : null} />}
      <div className="reader-scroll" ref={scroller} tabIndex={0} role="region" aria-label={localMode ? localContent.title || source.title || ui('资料内容') : ui('资料内容')} data-mode={view}>
        <div className="reader-page">
          <div className="study-document-body" ref={body} onMouseUp={select} onKeyUp={select} onTouchEnd={select} onClick={pick} onCopy={copy} onContextMenu={marks.onContextMenu}>
            {view === 'original'
              ? <PdfOriginal fileUrl={fileUrl} title={source.title || ui('原始 PDF')} page={pdfPage} total={totalPages} onPage={goToPage} settings={pdfView} onSettings={change => setPdfView(current => ({ ...current, ...change }))} />
              : reading
                ? html ? <div className="reader-html source-md" data-study-text="true" dangerouslySetInnerHTML={{ __html: html }} />
                  : <ReadingSections key={chapter.current?.id} sections={sections} labelOf={labelOf} onPeek={canPeek ? openPeek : undefined} scrollRoot={scroller} />
                : paged ? sections.map(section => <section key={section.id} className="study-document-page reader-section reader-section--page"
                  data-outline-id={section.id} data-study-page={section.page} data-study-source={section.sourceId}>
                  <span className="reader-section__label" data-find-skip="true">{labelOf(section)}</span>
                  {canPeek && <Button variant="quiet" size="sm" className="reader-peek" data-find-skip="true" data-peek-page={section.page} title={ui('看原页')} onClick={() => openPeek(section.page)}>{ui('看原页')}</Button>}
                  <QuotedText format={format} text={pageText(section)} quote={section.sourceId === source.id ? quote : ''} anchor={source.selection} />
                </section>)
                  : <QuotedText format={format} text={content || sources[0]?.text || ''} quote={quote} anchor={source.selection} />}
          </div>
          {view !== 'original' && (pager.previous || pager.next) && <nav className="reader-pager" data-pager={chaptered ? 'chapter' : 'section'} aria-label={pager.label}>
            {pager.previous ? <button type="button" className="reader-pager__link" data-direction="previous" onClick={pager.previous.go}>
              <small>{pager.previous.word}</small><span>{pager.previous.title}</span></button> : <span />}
            {pager.next ? <button type="button" className="reader-pager__link" data-direction="next" onClick={pager.next.go}>
              <small>{pager.next.word}</small><span>{pager.next.title}</span></button> : <span />}
          </nav>}
        </div>
      </div>
      {!localMode && <aside className="study-document-side reader-tools" data-tour="source-tools" id={toolsId} aria-label={ui('学习工具')} hidden={!toolsOn}>
        <h3 className="reader-panel__title">{ui('学习')}</h3>
        <div className="study-document-selection">
          {view !== 'original' && <Button className="study-document-wide" icon="plus" onPointerDown={event => { event.preventDefault(); select(); }} onClick={select}>{ui('使用当前选区')}</Button>}
          {learningPanels.map(panel => <div key={panel.scope} className="reader-learning" data-scope={panel.scope} hidden={panel.hidden}>
            <DocumentLearning call={call} document={learningDocument} {...panel.props} data={data} primary={!onGenerate} usedBy={source.usedBy} onPublished={refreshLinks} onOpenCard={onOpenCard}
              onOpenDeck={onOpenDeck} onPractice={onPractice} onStarted={onStarted} />
          </div>)}
          {/* Case practice (WP12): a passage can be the seed of a case paper. */}
          {onCaseFromPassage && view !== 'original' && <Button className="study-document-wide" disabled={!capture?.quote} title={capture?.quote ? undefined : ui('先在原文中选中一段文字')}
            onClick={() => onCaseFromPassage({ sourceId: capture.sourceId || source.id, quote: capture.quote })}>{ui('围绕这段出案例题')}</Button>}
        </div>
        <PassageLinksPanel model={model} focusedKey={focusedKey} onFocus={setFocusedKey} onOpen={onOpenCard} onAnnotation={openAnnotation} />
        {annotationMode === 'annotate' && <StaleAnnotations stale={kept.stale} onClear={clearStaleAnnotations} />}
      </aside>}
    </div>
    {bilingual.layer}
    {bilingual.dialog}
    {marks.menu}
    <ExplainCard shown={explainShown} />
    {displayOpen && <DisplayDialog settings={settings} onChange={updateSettings} onReset={resetSettings} underline={!localMode} extra={bilingual.displayRow} onClose={() => setDisplayOpen(false)} />}
    {peek && canPeek && <Suspense fallback={null}><PagePeek key={document.revision} page={peek.page} figure={peek.figure} totalPages={Math.max(0, ...sources.map(item => item.document?.totalPages || 0))}
      status={peekStatus({ available: !!fileUrl, original: document.original })} loadBytes={peekBytes} onClose={() => setPeek(null)} onAttach={kind => { setPeek(null); setAttaching(kind); }}
      onShowOriginal={page => { setPeek(null); if (page) setPdfPage(page); setMode('original'); }} /></Suspense>}
    {!localMode && attaching && attachTarget.current && <OriginalDialog target={attachTarget.current}
      call={call} host={host} intent={attaching} onClose={() => setAttaching(null)} onChanged={() => setReload(count => count + 1)} />}
  </div>;
}
