import React, { useEffect, useMemo, useRef, useState } from 'react';
import DOMPurify from 'dompurify';
import { renderNoteMarkdown } from '../note-markdown.js';
import { AudioCorrections } from '../AudioImport.jsx';
import { ui, uiFormat, useUiLanguage } from '../i18n.js';
import { useInjectCss } from '../shared.js';
import { Button, SegmentedControl } from '../components/index.js';
import DocumentLearning, { PassageLinks } from './DocumentLearning.jsx';
import { annotatePassages, captureSelection, groupPassageLinks, locateQuote, renderedPassageRange } from './selection.js';
import css from './document-preview.css';

/** HTML is inert reading content: scripts, embedded browsing and external resource loads are removed. */
export function safeDocumentHtml(text) {
  return DOMPurify.sanitize(String(text || ''), { USE_PROFILES: { html: true, mathMl: true },
    FORBID_TAGS: ['script', 'style', 'iframe', 'object', 'embed', 'link', 'meta', 'base', 'form', 'input', 'button', 'textarea', 'select', 'svg', 'canvas', 'mglyph', 'img', 'picture', 'audio', 'video', 'source', 'track'],
    FORBID_ATTR: ['src', 'srcset', 'poster', 'xlink:href', 'style', 'autofocus', 'contenteditable'], ADD_ATTR: ['target'] });
}

/**
 * The text style for a source. Only PDF page text keeps its layout (monospace,
 * no wrapping, horizontal scroll); TXT, transcripts, Markdown 原文 and older
 * text-only sources are set for reading: proportional, wrapped, a comfortable measure.
 */
export const sourceTextClass = ({ format } = {}) => format === 'pdf' ? 'source-text source-text--pdf' : 'source-text source-text--reading';

function QuotedText({ text, quote, anchor, format }) {
  const hit = locateQuote(text, quote, anchor), mark = useRef(null);
  useEffect(() => { mark.current?.scrollIntoView?.({ block: 'center' }); }, [quote, text]);
  return <pre className={sourceTextClass({ format })} data-study-text="true">{hit.status === 'resolved'
    ? <>{text.slice(0, hit.start)}<mark ref={mark} className="source-hit">{text.slice(hit.start, hit.end)}</mark>{text.slice(hit.end)}</> : text}</pre>;
}

/**
 * Props: source, quote, call, data, host, onOpenCard, onPublished,
 * onCaseFromPassage(passage), onGenerate() (shows "从这份资料出题" as the toolbar's primary action), generateDisabled.
 */
export default function DocumentViewer({ source, quote, call, data, host, onOpenCard, onPublished, onCaseFromPassage, onGenerate, generateDisabled = false }) {
  const language = useUiLanguage();
  useInjectCss(css, 'study-document-preview');
  const [document, setDocument] = useState(null), [content, setContent] = useState(''), [fileUrl, setFileUrl] = useState('');
  const [error, setError] = useState(''), [loading, setLoading] = useState(true), [mode, setMode] = useState('layout');
  const [capture, setCapture] = useState(null), [links, setLinks] = useState([]), [focusedGroup, setFocusedGroup] = useState(null);
  const body = useRef(null);
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
        if (value.originalAvailable) {
          const bytes = await call('materials.document.bytes', { documentId: value.documentId || value.id, revision: value.revision });
          if (!current || !bytes.dataBase64) return;
          const data = Uint8Array.from(atob(bytes.dataBase64), char => char.charCodeAt(0));
          if (value.format === 'pdf') {
            objectUrl = URL.createObjectURL(new Blob([data], { type: bytes.mime })); setFileUrl(objectUrl);
          } else setContent(new TextDecoder().decode(data));
        } else setContent(value.sources?.find(item => item.id === source.id)?.text || source.text);
      } catch (e) {
        if (current) { setError(e.message); setContent(source.text || ''); }
      } finally { if (current) setLoading(false); }
    })();
    return () => { current = false; if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, [call, source.id, source.text, source.selection?.revision]);
  const format = document?.format || (source.document ? 'pdf' : source.audio ? 'txt' : 'md');
  const groups = useMemo(() => groupPassageLinks(links), [links]);
  const learningDocument = useMemo(() => document ? { ...document, sourceId: source.id } : { sourceId: source.id }, [document, source.id]);
  const html = useMemo(() => (format === 'md' && mode === 'layout') ? safeDocumentHtml(renderNoteMarkdown(content))
    : format === 'html' && mode === 'layout' ? safeDocumentHtml(content) : '', [content, format, mode]);
  useEffect(() => annotatePassages(body.current, groups, setFocusedGroup, count => uiFormat('{0} 道相关题目与解析', [count])), [groups, html, content, mode, document, language]);
  const select = () => { const value = captureSelection(body.current); if (value) setCapture(value); };
  const refreshLinks = async value => {
    if (document) {
      const result = await call('materials.links.list', { documentId: document.documentId || document.id });
      setLinks(result.links || []);
    }
    await onPublished?.(value);
  };
  const sources = document?.sources || [source];
  const quoteState = quote ? locateQuote(sources.find(item => item.id === source.id)?.text || content, quote, source.selection) : null;
  useEffect(() => {
    if (!html || !quote || quoteState?.status !== 'resolved') return;
    const range = renderedPassageRange(body.current, { ...source.selection, sourceId: source.id, quote });
    if (!range) return;
    range.startContainer.parentElement?.scrollIntoView?.({ block: 'center' });
    if (window.CSS?.highlights && window.Highlight) {
      window.CSS.highlights.set('study-source-quote', new window.Highlight(range));
      return () => window.CSS.highlights.delete('study-source-quote');
    }
  }, [html, quote, quoteState?.status, source.id, source.selection]);
  const modes = format === 'pdf'
    ? [{ value: 'layout', label: ui('原始 PDF'), disabled: !fileUrl }, { value: 'text', label: ui('可选中的提取文字') }]
    : [{ value: 'layout', label: ui('排版') }, { value: 'text', label: ui('原文') }];
  const notices = [
    loading && <p key="loading" role="status">{ui('正在打开资料…')}</p>,
    document && !document.originalAvailable && <p key="legacy">{ui('这份旧资料保存了提取文字，原始文件尚未保留；仍可提问、补题和查看引用。重新导入原文件可补全预览。')}</p>,
    format === 'pdf' && fileUrl && <p key="pdf">{ui('原始 PDF 可核对排版与图表。在宿主预览中可直接选中文字；这里也可切换到逐页提取文字学习。')}</p>,
    error && <p key="error" className="is-warning" role="alert">{error}</p>,
    quoteState?.status === 'ambiguous' && <p key="ambiguous" className="is-warning">{ui('引用在资料中出现多次，请结合上下文核对位置。')}</p>,
    quoteState?.status === 'stale' && <p key="stale" className="is-warning">{ui('引用位置与当前文字不一致，请重新核对这段原文。')}</p>,
    source.selection && document?.currentRevision && document.currentRevision !== source.selection.revision
      && <p key="revision" className="is-warning">{ui('此引用来自较早版本，当前资料已有更新。')}</p>,
  ].filter(Boolean);
  const reading = sourceTextClass({ format });
  return <div className="study-document-viewer">
    <div className="study-document-toolbar">
      <SegmentedControl size="sm" className="study-document-preview-mode" label={ui('显示方式')} value={mode} options={modes} onChange={setMode} />
      <div className="study-document-toolbar__actions">
        {document?.preview?.kind === 'file' && host?.openDocument && <Button size="sm" variant="quiet" icon="external"
          onClick={() => host.openDocument(document.preview.path)}>{ui('使用宿主文件预览')}</Button>}
        {onGenerate && <Button variant="primary" icon="sparkle" disabled={generateDisabled} onClick={onGenerate}>{ui('从这份资料出题')}</Button>}
      </div>
    </div>
    <div className="study-document-notices">{notices}</div>
    {quote && <blockquote className="highlight-quote">{quote}</blockquote>}
    <AudioCorrections audio={source.audio} onReview={call && source.audio?.corrections ? () => call('audio.corrections.review', { sourceId: source.id }) : null} />
    <div className="study-document-layout">
      <div className="study-document-body" ref={body} onMouseUp={select} onKeyUp={select} onTouchEnd={select}>
        {format === 'pdf' && fileUrl && mode === 'layout'
          ? <iframe src={`${fileUrl}#page=${source.document?.page || source.selection?.page || 1}`} title={source.title || ui('原始 PDF')} />
            : html ? <div className={`${reading} source-md`} data-study-text="true" dangerouslySetInnerHTML={{ __html: html }} />
            : format === 'pdf' ? sources.map(item => <section key={item.id} className="study-document-page" data-study-page={item.document?.page || 1} data-study-source={item.id}>
              <h3>{item.title || `p.${item.document?.page || 1}`}</h3><QuotedText format="pdf" text={item.text} quote={item.id === source.id ? quote : ''} anchor={source.selection} />
            </section>) : <QuotedText format={format} text={mode === 'text' ? content : sources[0]?.text || content} quote={quote} anchor={source.selection} />}
      </div>
      <aside className="study-document-side" data-tour="source-tools">
        <div className="study-document-selection">
          <Button className="study-document-wide" icon="plus" onPointerDown={event => { event.preventDefault(); select(); }} onClick={select}>{ui('使用当前选区')}</Button>
          <DocumentLearning call={call} document={learningDocument} capture={capture} data={data} onPublished={refreshLinks} onOpenCard={onOpenCard} />
          {/* Case practice (WP12): a passage can be the seed of a case paper. */}
          {onCaseFromPassage && <Button className="study-document-wide" disabled={!capture?.quote} title={capture?.quote ? undefined : ui('先在原文中选中一段文字')}
            onClick={() => onCaseFromPassage({ sourceId: capture.sourceId || source.id, quote: capture.quote })}>{ui('围绕这段出案例题')}</Button>}
        </div>
        <h3 className="study-document-links-heading">{ui('原文关联题目与解析')}</h3>
        <PassageLinks groups={focusedGroup ? [focusedGroup] : groups} onOpenCard={onOpenCard} />
        {focusedGroup && <Button size="sm" variant="quiet" onClick={() => setFocusedGroup(null)}>{ui('显示全部引用')}</Button>}
      </aside>
    </div>
  </div>;
}
