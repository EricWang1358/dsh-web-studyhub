import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ui } from '../i18n.js';
import { Button, CloseButton, TextArea, Tooltip } from '../components/index.js';
import ModelSetupGate from '../ModelSetupGate.jsx';
import useRangeAnchor from '../document-preview/translation/useRangeAnchor.js';
import { askStaysOpen } from './ask-visibility.js';

/* 「问 AI」 of the review book (docs/review-book.md "Ask AI"): ONE box, two destinations. Opened by 「✦ 问 AI」 at a point's title (about the whole point) or by
   「写一段…」 of the selection toolbar (about the selected words, shown on top). One tap on a preset fills the box. 「写进这个知识点」 writes with the app's model
   (about a minute; generation.courseBook.explain: 弄懂 when the box is empty over selected words, else the instruction) and closes the panel at once, a line
   standing where the answer will go; 「发给主会话」 fills the main chat's input box (never sends; without a chat it copies) through ui/book/send-to-chat.js.
   Without a model the shared gate stands under 写进这个知识点 only; 发给主会话 still works. Ctrl+Enter writes, Escape closes. The same form, with 发给主会话 only,
   is 更多 › 整本书 · 发给主会话… (ui/book/book-views.jsx). */

export const PRESETS = ['讲细点', '加个例子', '润色成大白话', '加过渡', '还漏了哪些小知识点、要不要补进来'];

/** 「✦ 问 AI」: a quiet button at the right of a point's title (on a narrow page only its ✦, beside the path); onAsk(element) opens the panel under it. */
export function AskButton({ onAsk }) {
  return (
    <Tooltip layer content={ui('写进这个知识点，或发给主会话')} anchorClassName="book-ask-tip">
      <Button variant="quiet" size="sm" icon="sparkle" className="book-ask-open" data-book-ask-open="" aria-haspopup="dialog" aria-label={ui('问 AI')} onClick={event => onAsk(event.currentTarget)}>
        <span className="book-ask-open__word">{ui('问 AI')}</span></Button>
    </Tooltip>
  );
}

/** A point's title with 问 AI at its right (the title itself is the caller's heading element). */
export function AskRow({ children, onAsk }) {
  return <div className="book-ask-row">{children}{onAsk && <AskButton onAsk={onAsk} />}</div>;
}

/** scope: 'point' (the title's 问 AI), 'selection' (words selected) or 'book' (the whole book, 发给主会话 only); model: modelReadiness; onWrite({ instruction })
    (absent: no 写进这个知识点); onSend({ instruction }) -> a promise. */
export function AskForm({ scope, model, onWrite, onSend, autoFocus = false }) {
  const [text, setText] = useState(''), [sending, setSending] = useState(false);
  const off = !!onWrite && !model?.ready, asked = text.trim();
  // Over selected words an empty box is 弄懂; about the whole point it needs something to write.
  const canWrite = !!onWrite && !off && (scope === 'selection' || !!asked);
  const write = () => { if (canWrite) onWrite({ instruction: asked }); };
  const send = async () => { if (sending) return; setSending(true); try { await onSend({ instruction: asked }); } finally { setSending(false); } };
  return (
    <form className="book-ask__form" data-book-ask-form={scope} onSubmit={event => { event.preventDefault(); if (onWrite) write(); else send(); }}>
      <div className="book-ask__presets" role="group" aria-label={ui('常用的问法')}>
        {PRESETS.map(preset => <Button key={preset} size="sm" variant="quiet" type="button" className="book-ask__preset" data-book-ask-preset={preset}
          onClick={() => setText(ui(preset))}>{ui(preset)}</Button>)}
      </div>
      <TextArea className="book-ask__input" rows={3} maxLength={600} autoFocus={autoFocus} value={text} onChange={event => setText(event.target.value)}
        aria-label={ui('你想让 AI 做什么')} placeholder={scope === 'selection' ? ui('想让它怎么讲？留空就是弄懂这几句') : scope === 'book' ? ui('想让主会话怎么改整本书？（可以留空）') : ui('想在这个知识点里加点什么？')}
        onKeyDown={event => { if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) { event.preventDefault(); if (onWrite) write(); else send(); } }} />
      <div className="book-ask__send">
        {onWrite && <Tooltip layer content={ui('用你设置的模型写，约 1 分钟；写好后收成一行，放在它针对的那段后面。')} anchorClassName="book-ask__tip">
          <Button size="sm" variant="secondary" type="submit" icon="sparkle" disabled={!canWrite} data-book-ask="write">{ui('写进这个知识点')}</Button>
        </Tooltip>}
        <Tooltip layer content={ui('只填进主对话的输入框，由你按发送；没有主对话时复制到剪贴板。')} anchorClassName="book-ask__tip">
          <Button size="sm" variant={onWrite ? 'quiet' : 'secondary'} type="button" busy={sending} data-book-ask="chat" onClick={send}>{ui('发给主会话')}</Button>
        </Tooltip>
      </div>
      {off && <ModelSetupGate variant="compact" feature="bookAi" model={model} />}
      {scope === 'book' && <p className="book-ask__hint">{ui('也可以直接在主对话里说你想怎么改，主会话会按 study-book 改书，每次改动都能回退')}</p>}
    </form>
  );
}

/** target: { heading, words?, anchor (the 问 AI button, or the selection's range: anything with getClientRects) }; host: the page element the panel is placed in;
    scrollerRef: what scrolls the page; model; onWrite({ mode, words?, instruction? }); onSend({ words?, instruction }) -> a promise; onClose(). */
export default function BookAsk({ target, host, scrollerRef, model, onWrite, onSend, onClose }) {
  const panel = useRef(null), anchor = useRef(target.anchor), latest = useRef(null);
  anchor.current = target.anchor;
  const selected = !!target.words;
  const rangeRef = useRef({ getClientRects: () => (anchor.current?.getClientRects ? anchor.current.getClientRects() : []) });
  // Never wider than the page's column (a narrow page has the app's rail beside it); set before it is placed.
  useLayoutEffect(() => { if (panel.current && host) panel.current.style.maxWidth = `${Math.max(240, host.clientWidth - 16)}px`; }, [host]);
  useRangeAnchor({ elementRef: panel, host, rangeRef, scrollerRef, active: true, trigger: `${target.heading}|${target.words ?? ''}`, placement: 'bottom-end', gap: 6, margin: 8 });
  latest.current = { onClose, typed: () => !!panel.current?.querySelector('textarea')?.value.trim() };
  useEffect(() => {
    // Escape closes; a press outside closes it unless words are typed in the box (nothing the learner wrote is taken from them).
    const onKey = event => { if (event.key === 'Escape' && !event.defaultPrevented) latest.current.onClose(); };
    const onDown = event => {
      // A press on its own 问 AI is the button's (a second press closes it there).
      if (panel.current?.contains(event.target) || (anchor.current?.contains && anchor.current.contains(event.target))) return;
      if (!askStaysOpen({ kind: 'here', hasText: latest.current.typed(), outside: true })) latest.current.onClose();
    };
    window.addEventListener('keydown', onKey);
    document.addEventListener('mousedown', onDown, true);
    return () => { window.removeEventListener('keydown', onKey); document.removeEventListener('mousedown', onDown, true); };
  }, []);
  // The focus goes into the box once the panel is placed (hidden until then, it could not take it), and back to the 问 AI button when it closes with the
  // focus inside or nowhere (a keyboard learner keeps their place; a selection's range has no focus to take).
  useEffect(() => {
    const box = panel.current?.querySelector('textarea');
    if (box) box.focus({ preventScroll: true });
    const back = target.anchor;
    return () => { if (typeof back?.focus === 'function' && (!document.activeElement || document.activeElement === document.body)) back.focus({ preventScroll: true }); };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const words = target.words ?? '';
  return (
    <div className="book-ask" ref={panel} role="dialog" aria-label={ui('问 AI')} data-book-ask-panel={selected ? 'selection' : 'point'}>
      <div className="book-ask__head">
        <p className="book-ask__title">{ui('问 AI')}</p>
        <CloseButton size="sm" label={ui('关闭')} onClick={onClose} />
      </div>
      {selected && <p className="book-ask__words">{`「${words.length > 80 ? `${words.slice(0, 79)}…` : words}」`}</p>}
      <AskForm scope={selected ? 'selection' : 'point'} model={model}
        onWrite={({ instruction }) => onWrite(selected ? { mode: instruction ? 'write' : 'explain', words, ...(instruction ? { instruction } : {}) } : { mode: 'here', instruction })}
        onSend={({ instruction }) => onSend({ words, instruction })} />
    </div>
  );
}
