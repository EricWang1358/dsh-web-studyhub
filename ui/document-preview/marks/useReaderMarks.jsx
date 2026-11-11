import React, { useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { ContextMenu, useToast } from '../../components/index.js';
import { errorMessage, ui, uiFormat, uiLanguageName } from '../../i18n.js';
import { captureSelection, selectionRequest } from '../selection.js';
import { hitTest, locateGroups, overText } from '../links/link-ranges.js';
import { caretAt } from '../links/usePassageLinkLayer.js';
import { askRequest } from '../ask-request.js';
import { copyText } from '../reader/formula.js';
import { supportsHighlights } from '../reader/find.js';
import { ReaderModelContext } from '../ReaderModelGate.jsx';
import { batchRequest, batchStartedText, clipText, drawnMarks, explainQuestion, marksAt, paintMarks, queueOf, selectionMenu } from './model.js';
import QueueChip from './QueueChip.jsx';

/* The reader's right-click menu (owner request 2026-11-11): select, right-click, and mark the passage (下划线 / 加粗 / 荧光笔), put it on the
   material's 待出题 list, or ask an AI 词解 that stays on the passage, and keep reading. One hook, so DocumentViewer only places what it returns.

   - Marks are materials.marks.* (kept per document revision beside the 批注), located with the link layer's ranges and painted with the
     Custom Highlight API, so the text and every stored character stay as they were.
   - 待出题 becomes ONE ordinary `generate` run (a draft, in the 任务 console) from QueueChip; the passages it used leave the list as it starts.
   - A 词解 is materials.selection.ask, kept as a 批注 of kind explain (the reader draws it in both modes and shows it on hover).
   - Shift + right-click, and a right-click with nothing selected and no mark under the pointer, leave the browser's own menu alone. */

const READY = new Set(['saved', 'unchanged']);
const REFUSED = queueLimit => ({ stale: ui('这段文字与资料对不上了，请重新选择。'), ambiguous: ui('这段文字在资料里出现了不止一次，请多选一点上下文。'), missing: ui('这段文字不在这份资料里。'),
  full: ui('这份资料的标记已满，先去掉一些。'), 'queue-full': uiFormat('待出题最多 {0} 段，先一次性出题或移出一些。', [queueLimit]) });
/** The list's own limit (materials.marks.list `limits.queue`) until it has answered. */
const QUEUE_LIMIT = 40;
const nodeId = () => `explain-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
/** Where a menu opened from the keyboard (no pointer) goes: under the selection. */
const pointOf = (event, capture) => {
  if (event.button === 2 || event.clientX || event.clientY) return { x: event.clientX, y: event.clientY };
  const rect = capture?.range?.getBoundingClientRect?.();
  return rect ? { x: rect.left, y: rect.bottom } : { x: 0, y: 0 };
};

/**
 * `document`: the reader's document with its sourceId (learningDocument); `body`: the drawn text; `rendered`: changes whenever the text does;
 * `enabled`: a stored material in a text view (not 原始 PDF, not local writing). `compact`: the toolbar is at its narrowest (COMPACT_TOOLBAR), so 待出题 is an item of 更多 instead of a chip. `onExplained()`: a 词解 was kept (reload the 批注);
 * `onBatchStarted(job)`: 一次性出题 started a run (the host refreshes and follows it). `busy`: the host is busy, nothing starts.
 * Returns { onContextMenu, menu, chip, moreItems }.
 */
export function useReaderMarks({ call, document, data, body, rendered, enabled, compact = false, canQueue = true, onExplained, onBatchStarted, busy = false }) {
  const toast = useToast(), services = useContext(ReaderModelContext);
  const model = services?.model, ready = !!model?.ready;
  const [items, setItems] = useState([]), [reload, setReload] = useState(0), [pending, setPending] = useState([]), [menu, setMenu] = useState(null), [queueOpen, setQueueOpen] = useState(false), [queueLimit, setQueueLimit] = useState(QUEUE_LIMIT);
  const located = useRef([]);
  const documentId = document?.documentId || document?.id, revision = document?.revision;
  const live = enabled && !!documentId && !!call;
  const say = useCallback((message, tone = 'info') => toast.show({ tone, message }), [toast]);

  useEffect(() => {
    if (!live) { setItems([]); return undefined; }
    let current = true;
    call('materials.marks.list', { documentId, revision }).then(value => { if (current) { setItems(value.items || []); if (value.limits?.queue) setQueueLimit(value.limits.queue); } }).catch(() => { if (current) setItems([]); });
    return () => { current = false; };
  }, [call, live, documentId, revision, reload]);

  // Stored marks clip quote to 4000 chars while retaining full [start, end]; recover the full span so long marks paint and hit-test completely.
  const resolvedItems = useMemo(() => {
    if (!items.length || !document?.sources?.length) return items;
    const bySource = new Map(document.sources.map(source => [source.id, source.text ?? '']));
    return items.map(item => {
      const at = item.selection;
      if (!at || !Number.isInteger(at.start) || !Number.isInteger(at.end) || at.end <= at.start) return item;
      const sliced = bySource.get(at.sourceId)?.slice(at.start, at.end);
      return sliced && sliced !== at.quote ? { ...item, selection: { ...at, quote: sliced } } : item;
    });
  }, [items, document?.sources]);

  // Located once per change of the marks or the text, painted from the cached ranges (the link layer's way).
  useEffect(() => {
    const container = body.current;
    located.current = [];
    if (!live || !container) return undefined;
    located.current = locateGroups(container, drawnMarks(resolvedItems, pending));
    if (!supportsHighlights()) return undefined;
    const clear = paintMarks(located.current);
    return () => { clear(); located.current = []; };
  }, [body, resolvedItems, pending, rendered, live]);

  const onContextMenu = event => {
    if (!live || event.shiftKey || event.defaultPrevented) return;
    const container = body.current;
    let capture = captureSelection(container), here;
    if (capture) here = marksAt(resolvedItems, capture);
    else {
      // Nothing selected: a right-click on a mark offers to take it off; anywhere else the browser's own menu opens.
      const [node, offset] = caretAt(container.ownerDocument, event.clientX, event.clientY);
      const hits = hitTest(located.current, node, offset).filter(entry => entry.group.style !== 'pending' && overText(entry.range, event.clientX, event.clientY));
      if (!hits.length) return;
      const first = hits[0].group;
      capture = { ...first.selection };
      here = resolvedItems.filter(item => item.key === first.key);
    }
    event.preventDefault();
    setMenu({ point: pointOf(event, capture), capture, here, selected: !!capture.range });
  };

  const marksCall = (action, args) => call(`materials.marks.${action}`, { documentId, revision, ...args });
  const save = async (capture, style) => {
    if (capture?.crossPage) { say(ui('选区跨了多页，请在一页内选择。'), 'warning'); return; }
    const result = await marksCall('save', { selection: selectionRequest(document, capture), style });
    if (!READY.has(result.status)) { say(REFUSED(queueLimit)[result.status] || result.message || ui('暂时无法保存这个标记。'), 'warning'); return; }
    if (style === 'queue' && result.status === 'saved') say(uiFormat('已加入待出题（共 {0} 段），继续读吧。', [queueOf(resolvedItems).length + 1]), 'success');
    setReload(count => count + 1);
  };
  const remove = async ids => { if (ids.length) await marksCall('delete', { ids }); setReload(count => count + 1); };

  const explain = async capture => {
    if (capture?.crossPage) { say(ui('选区跨了多页，请在一页内选择。'), 'warning'); return; }
    if (!ready) { services?.openModelSettings?.(); return; }
    const id = nodeId(), drawn = { id: `pending:${id}`, selection: { sourceId: capture.sourceId || document.sourceId, quote: capture.quote, prefix: capture.prefix, suffix: capture.suffix } };
    setPending(list => [...list, drawn]);
    try {
      const resolved = await call('materials.selection.resolve', selectionRequest(document, capture));
      if (resolved.status !== 'resolved') throw new Error(REFUSED(queueLimit)[resolved.status] || ui('这段文字暂时无法解释。'));
      const term = clipText(capture.quote, 80), question = explainQuestion(term), language = uiLanguageName();
      const answer = await call('materials.selection.ask', askRequest({ selection: resolved.selection, question, term, language }));
      if (answer.status !== 'answered') throw new Error(REFUSED(queueLimit)[answer.status] || ui('这段文字暂时无法解释。'));
      const kept = await call('materials.annotation.save', { documentId, revision, selection: resolved.selection,
        nodes: [{ id, parentId: null, question, term, label: ui('词解'), answer: answer.answer, language, kind: 'explain' }] });
      if (kept.status !== 'saved') throw new Error(kept.message || ui('词解没能保存。'));
      await onExplained?.();
      say(uiFormat('「{0}」的词解已留在原文上，鼠标移到波浪线上就能看。', [clipText(term, 24)]), 'success');
    } catch (error) { say(uiFormat('词解没有完成：{0}', [errorMessage(error)]), 'error'); }
    finally { setPending(list => list.filter(entry => entry !== drawn)); }
  };

  const copy = capture => {
    // The browser's own copy (the reader's copy handler keeps formulas as their source); the quote itself when the selection is gone.
    if (capture.range && globalThis.document.execCommand?.('copy')) return;
    const text = capture.range ? copyText(window.getSelection()) ?? capture.quote : capture.quote;
    navigator.clipboard?.writeText(text).catch(() => say(ui('没能复制，请用 Ctrl+C。'), 'warning'));
  };

  const choose = id => {
    const { capture, here } = menu;
    if (id === 'copy') copy(capture);
    else if (id === 'explain') explain(capture);
    else if (id === 'unmark:all') remove(here.map(item => item.id));
    else if (id.startsWith('unmark:')) remove(here.filter(item => item.style === id.slice(7)).map(item => item.id));
    else if (id.startsWith('mark:')) save(capture, id.slice(5)).catch(error => say(error.message, 'error'));
  };

  const queue = queueOf(resolvedItems);
  const startBatch = async perPassage => {
    const used = queue;
    const request = batchRequest({ queue: used, perPassage, settings: data?.settings, title: document?.title || document?.filename || '' });
    const job = await call('generate', request);
    await marksCall('delete', { ids: used.map(item => item.id) });
    setReload(count => count + 1);
    say(batchStartedText(used.length, request.count), 'success');
    await onBatchStarted?.(job);
  };

  return {
    onContextMenu,
    menu: menu && <ContextMenu label={ui('选中文字的操作')} within={body.current} point={menu.point} onClose={() => setMenu(null)} onSelect={choose}
      items={selectionMenu({ here: menu.here, explain: model ? (ready ? 'ready' : 'no-model') : 'unavailable', queueFull: queue.length >= queueLimit, canQueue })} />,
    chip: canQueue && live && queue.length > 0 ? <QueueChip queue={queue} disabled={busy} modelReady={ready} onOpenModelSettings={services?.openModelSettings} compact={compact}
      open={queueOpen} onOpenChange={setQueueOpen} onRemove={item => remove([item.id])} onStart={startBatch} body={body} /> : null,
    // At the narrowest the toolbar has no room for a fifth control: the same panel opens from 更多.
    moreItems: canQueue && live && compact && queue.length > 0 ? [{ id: 'queue', icon: 'checklist', label: uiFormat('待出题 {0}…', [queue.length]), run: () => setQueueOpen(true) }] : [],
  };
}
