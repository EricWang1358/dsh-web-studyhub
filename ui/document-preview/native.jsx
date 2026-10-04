import React, { useEffect, useMemo, useRef, useState } from 'react';
import { ui, uiFormat, uiMessage, useUiLanguage } from '../i18n.js';
import { Button, Dialog, InlineMessage } from '../components/index.js';
import DocumentLearning, { PassageLinks } from './DocumentLearning.jsx';
import { safeDocumentHtml } from './DocumentViewer.jsx';
import { annotatePassages, captureSelection, groupPassageLinks } from './selection.js';
import css from './document-preview.css';

const elementOf = node => node?.nodeType === 1 ? node : node?.parentElement;
const sameTarget = (a, b) => a && b && ['sessionId', 'paneId', 'tabId', 'occurrence', 'navigationRevision'].every(key => a[key] === b[key]);

/** Contribute to the existing preview toolbar; all navigation belongs to the host. */
export function registerDocumentLearning(ctx, makeCall, openCard) {
  ctx.effect(() => {
    const style = window.document.createElement('style'); style.textContent = css;
    window.document.head.append(style); return () => style.remove();
  }, 'study document learning styles');
  function DocumentActions({ sessionId, absolutePath }) {
    const call = useMemo(() => makeCall(sessionId), [sessionId]);
    const [document, setDocument] = useState(null), [capture, setCapture] = useState(null), [links, setLinks] = useState([]);
    const [error, setError] = useState(''), [busy, setBusy] = useState(false), [open, setOpen] = useState(false);
    const [hasMaterials, setHasMaterials] = useState(false);
    const button = useRef(null), pending = useRef(null), target = useRef(null);
    useEffect(() => { setDocument(null); setCapture(null); setLinks([]); setOpen(false); target.current = null; }, [sessionId, absolutePath]);
    useEffect(() => {
      let current = true;
      setHasMaterials(false);
      call('runtime.capabilities').then(capabilities => {
        if (current) setHasMaterials(capabilities.some(capability => capability.api === 'materials.v1'));
      }).catch(() => { if (current) setHasMaterials(false); });
      return () => { current = false; };
    }, [call, absolutePath]);
    const current = () => !!target.current && !!ctx.get('sidebarRight')?.isTargetCurrent?.(target.current);
    function captureBeforeBlur(event) {
      const sidebar = ctx.get('sidebarRight'), selection = window.getSelection();
      const previewTarget = sidebar?.focusedTarget?.(button.current);
      const start = selection?.rangeCount ? sidebar?.focusedTarget?.(elementOf(selection.getRangeAt(0).startContainer)) : null;
      const end = selection?.rangeCount ? sidebar?.focusedTarget?.(elementOf(selection.getRangeAt(0).endContainer)) : null;
      pending.current = sameTarget(previewTarget, start) && sameTarget(start, end) ? captureSelection(null, selection) : null;
      target.current = previewTarget;
      event?.preventDefault();
    }
    async function launch(event) {
      if (event?.detail === 0 || !target.current) captureBeforeBlur();
      if (!current()) { setError(ui('预览页已切换，请重新打开选段学习。')); setOpen(true); return; }
      setCapture(pending.current); setError(''); setBusy(true); setOpen(true);
      try {
        let value;
        try { value = await call('materials.document.get', { path: absolutePath }); }
        catch { value = await call('materials.document.import', { path: absolutePath }); value = value.document || value;
          if (!value.sources) value = await call('materials.document.get', { documentId: value.documentId || value.id }); }
        if (!current()) throw new Error(ui('预览页已切换，请重新选择文字。'));
        setDocument(value);
        const result = await call('materials.links.list', { documentId: value.documentId || value.id }); setLinks(result.links || []);
      } catch (e) { setError(e.message); }
      finally { setBusy(false); }
    }
    async function published() {
      const result = await call('materials.links.list', { documentId: document.documentId || document.id }); setLinks(result.links || []);
      window.dispatchEvent(new CustomEvent('study-material-links-updated', { detail: { sessionId, path: absolutePath, documentId: document.documentId || document.id } }));
    }
    async function navigate(link) {
      try { await openCard(sessionId, link); setOpen(false); }
      catch (e) { setError(e.message); }
    }
    if (!hasMaterials) return null;
    return <span className="study-document-native">
      <Button ref={button} size="sm" onPointerDown={captureBeforeBlur} onClick={launch}>{ui('选段学习')}</Button>
      {open && <Dialog title={ui('资料选段学习')} size="md" onClose={() => setOpen(false)}>
        {busy && <p role="status">{ui('正在连接资料与原文位置…')}</p>}
        {error && <InlineMessage tone="error">{uiMessage(error)}</InlineMessage>}
        {!capture && <p>{ui(/\.html?$/i.test(absolutePath) ? '选中一段文字后点击此按钮。HTML 请切换到「学习 HTML」预览。' : '选中预览中的一段文字后，再点击「选段学习」。')}</p>}
        {document && <DocumentLearning call={call} document={document} capture={capture} onPublished={published} isCurrent={current}
          onOpenCard={navigate} />}
        <PassageLinks groups={groupPassageLinks(links)} onOpenCard={navigate} />
      </Dialog>}
    </span>;
  }
  ctx.effect(() => ctx.slots.inject('sidebar.right.tab.document.actions', () => ctx.slots.register({
    name: 'sidebar.right.tab.document.actions', id: 'study-selection-learning', order: 80,
  }, DocumentActions)), 'study document toolbar');

  function StudyHtml({ content, scrollportRef, resourceAddress, sessionId }) {
    const language = useUiLanguage();
    const ref = useRef(null), call = useMemo(() => makeCall(sessionId), [sessionId]);
    const [links, setLinks] = useState([]), [group, setGroup] = useState(null), [error, setError] = useState('');
    const html = useMemo(() => safeDocumentHtml(content.kind === 'text' ? content.text : ''), [content]);
    useEffect(() => {
      let current = true;
      const match = resourceAddress.match(/^dsh-resource:\/\/file\/session\/[^/]+\/(.*)$/);
      let reload;
      if (match) {
        const path = match[1].split('/').map(decodeURIComponent).join('/');
        const load = () => call('materials.document.get', { path }).then(value => call('materials.links.list', { documentId: value.documentId || value.id }))
          .then(value => { if (current) setLinks(value.links || []); }).catch(() => {});
        load();
        reload = event => { if (event.detail?.sessionId === sessionId && event.detail?.path?.replace(/\\/g, '/') === path.replace(/\\/g, '/')) load(); };
        window.addEventListener('study-material-links-updated', reload);
      }
      return () => { current = false; if (reload) window.removeEventListener('study-material-links-updated', reload); };
    }, [call, resourceAddress, sessionId]);
    const groups = useMemo(() => groupPassageLinks(links), [links]);
    useEffect(() => annotatePassages(ref.current, groups, setGroup, count => uiFormat('{0} 道相关题目与解析', [count])), [groups, html, language]);
    return <div className="study-html-document" ref={scrollportRef}>
      <div ref={ref} dangerouslySetInnerHTML={{ __html: html }} />
      {error && <InlineMessage tone="error">{uiMessage(error)}</InlineMessage>}
      {group && <PassageLinks groups={[group]} onOpenCard={async link => {
        try { await openCard(sessionId, link); } catch (e) { setError(e.message); }
      }} />}
    </div>;
  }
  ctx.inject(['documentPreviews'], c => {
    const metadata = c.documentPreviews.register({ id: 'study-html', extensions: ['html', 'htm'], priority: 'extension',
      title: () => ui('学习 HTML'), loading: 'text-pages', wrap: true });
    const body = c.slots.inject('sidebar.right.tab.document', () => c.slots.register({ name: 'sidebar.right.tab.document', key: 'study-html' }, StudyHtml));
    return () => { body?.(); metadata?.(); };
  });
}
