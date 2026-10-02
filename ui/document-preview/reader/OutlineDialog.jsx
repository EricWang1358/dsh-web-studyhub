import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { ui, uiFormat } from '../../i18n.js';
import { Button, Dialog } from '../../components/index.js';
import OutlineAssist from './OutlineAssist.jsx';

/* "AI 重新分段…" on a row of the 资料 page: the same flow as under the reader's outline (OutlineAssist), for the whole
   document the row stands for (all the pages or files of one document, in reading order), in a dialog. The chapters it
   makes are a view over the same text: they show on this page, in the picker and in the reader from then on. */

const displayTitle = title => /^(?:[A-Za-z]:[\\/]|\\\\|\/)/.test(String(title)) ? String(title).replace(/^.*[\\/]/, '') : title;
/** Saving, clearing and applying (or restoring) a segmentation change the library; a preview and the asking do not. */
export const changesLibrary = (action, args) => /^materials\.outline\.(save|clear)$/.test(action) || (action === 'materials.outline.segment' && args.level !== undefined && args.preview !== true);

/** The dialog's content: what will happen, the flow, and the kept outline of this document when it has one. */
export function OutlineDialogBody({ item, call }) {
  const [document, setDocument] = useState(null), [error, setError] = useState('');
  const target = useMemo(() => ({ ...(item.documentId ? { documentId: item.documentId } : {}), sourceId: item.sourceIds[0], revision: document?.revision, legacy: !!document?.legacy }), [item, document]);
  const load = useCallback(async () => {
    try { setDocument(await call('materials.document.get', item.documentId ? { documentId: item.documentId } : { sourceId: item.sourceIds[0] })); setError(''); }
    catch (failure) { setError(failure.message); }
  }, [call, item]);
  useEffect(() => { load(); }, [load]);
  const current = useMemo(() => (item.chapters || []).map(chapter => ({ title: chapter.title || ui('前言与目录'), depth: 0 })), [item]);
  return <div className="reader-assist-dialog">
    <p>{ui('让 AI 看一遍这份资料的文字，找出章节（或整理完整目录），再按它重新分段。只改变章节与目录的划分：原文、页码、引用和题目都不会改变。')}</p>
    {error && <p className="is-warning" role="alert">{uiFormat('没能读取这份资料的目录：{0}', [error])}</p>}
    <OutlineAssist variant="dialog" call={call} target={target} current={current} saved={document?.outline || null} stale={document?.outlineStale || null}
      onSaved={outline => setDocument(value => ({ ...(value || {}), outline, outlineStale: undefined }))} onCleared={() => setDocument(value => ({ ...(value || {}), outline: undefined }))} />
  </div>;
}

/** The dialog: `act` (the page's refreshing action runner) makes every change reach the 资料 page and the picker at once. */
export default function OutlineDialog({ item, call, act, onClose }) {
  const refreshing = useMemo(() => async (action, args = {}) => {
    if (!act || !changesLibrary(action, args)) return call(action, args);
    const result = await act(action, args, undefined, { rethrow: true });
    if (result === undefined) throw new Error(ui('另一个操作还在进行，请稍后重试。'));
    return result;
  }, [act, call]);
  return <Dialog title={uiFormat('AI 重新分段：{0}', [displayTitle(item.title)])} size="lg" onClose={onClose}
    footer={<Button variant="quiet" onClick={onClose}>{ui('关闭')}</Button>}>
    <OutlineDialogBody item={item} call={refreshing} />
  </Dialog>;
}
