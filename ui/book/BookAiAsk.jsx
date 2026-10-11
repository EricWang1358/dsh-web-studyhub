import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ui } from '../i18n.js';
import { Button, CloseButton, TextInput } from '../components/index.js';
import ModelSetupGate from '../ModelSetupGate.jsx';
import { askStaysOpen, selectionState } from './ask-visibility.js';

/* The small panel of 弄懂 / 加一段 in the review book's 预览 (M4): over selected words, 「弄懂」 and 「让 AI 写一段…」 (an instruction: 讲细点, 加个例子, 对比 X 和
   Y 做个表); on a heading, 「在这里加一段」 with the instruction only. Either starts a visible task (the 任务 console shows it; no estimate, no confirmation) whose
   answer is written as a new block of the point's own file. Without a model the shared gate says where to set one up; reading and editing go on. */

/** target: { heading, words?, top, left, jobId? } (where to show it, in the window; the task started from it, kept open until the page closes it); model: modelReadiness;
    onStart({ mode, words?, instruction? }); onSend({ words, instruction }) (optional: 「发给主会话」 over selected words, the same box, its answer a promise); onClose(). It closes itself when its selection is gone (ui/book/ask-visibility.js); × and Escape close it too. */
export default function BookAiAsk({ target, model, onStart, onSend, onClose }) {
  const [instruction, setInstruction] = useState(''), [sending, setSending] = useState(false);
  const box = useRef(null);
  const off = !model?.ready, selected = !!target.words, pending = !!target.jobId;
  const latest = useRef(null);
  latest.current = { kind: selected ? 'selected' : 'here', hasText: !!instruction.trim(), pending, onClose };
  useEffect(() => {
    const check = outside => {
      const now = latest.current, focusInside = !!box.current?.contains(document.activeElement);
      if (!askStaysOpen({ ...now, ...selectionState(window.getSelection?.()), focusInside, outside })) now.onClose();
    };
    let timer = null;
    const onKey = event => { if (event.key === 'Escape') latest.current.onClose(); };
    const onChange = () => { clearTimeout(timer); timer = setTimeout(() => check(false), 80); };
    const onDown = event => { if (!box.current?.contains(event.target)) check(true); };
    window.addEventListener('keydown', onKey);
    document.addEventListener('selectionchange', onChange);
    document.addEventListener('mousedown', onDown, true);
    return () => { clearTimeout(timer); window.removeEventListener('keydown', onKey); document.removeEventListener('selectionchange', onChange); document.removeEventListener('mousedown', onDown, true); };
  }, []);
  // Where it should be in the window; the app's frame may be the box a fixed panel is placed in, so the offset of that box is measured once and taken off.
  const want = { top: Math.max(8, Math.round(target.top)), left: Math.max(8, Math.min(Math.round(target.left), window.innerWidth - Math.min(300, window.innerWidth - 16) - 8)) };
  const [shift, setShift] = useState({ top: 0, left: 0 });
  useLayoutEffect(() => {
    const rect = box.current?.getBoundingClientRect();
    if (rect) setShift({ top: rect.top - want.top - shift.top, left: rect.left - want.left - shift.left });
  }, [want.top, want.left]); // eslint-disable-line react-hooks/exhaustive-deps
  const style = { top: want.top - shift.top, left: want.left - shift.left };
  return (
    <div className="book-ai-ask" ref={box} style={style} role="group" aria-label={selected ? ui('弄懂这段') : ui('在这里加一段')} onMouseUp={event => event.stopPropagation()}>
      <div className="book-ai-ask__bar">
        {selected && <Button size="sm" variant="primary" icon="sparkle" disabled={off || pending} data-book-ai="explain" onClick={() => onStart({ mode: 'explain', words: target.words })}>{ui('弄懂')}</Button>}
        {pending && <span className="book-ai-ask__state" role="status" data-book-ai="state">{ui('正在写…')}</span>}
        <CloseButton size="sm" label={ui('关闭')} onClick={onClose} />
      </div>
      <form className="book-ai-ask__form" onSubmit={event => { event.preventDefault(); if (instruction.trim()) onStart({ mode: selected ? 'write' : 'here', words: target.words, instruction: instruction.trim() }); }}>
        <TextInput className="book-ai__input" aria-label={ui('让 AI 写一段…')} placeholder={selected ? ui('让 AI 写一段…（讲细点、加个例子、对比做个表）') : ui('在这里加一段：写什么？')}
          value={instruction} maxLength={600} disabled={(off && !(selected && onSend)) || pending} onChange={event => setInstruction(event.target.value)} autoFocus={!selected} />
        <Button size="sm" type="submit" disabled={off || pending || !instruction.trim()} data-book-ai="write">{ui('写')}</Button>
        {selected && onSend && <Button size="sm" variant="quiet" disabled={pending || sending} data-book-ai="chat"
          onClick={async () => { setSending(true); try { await onSend({ words: target.words, instruction: instruction.trim() }); } finally { setSending(false); } }}>{ui('发给主会话')}</Button>}
      </form>
      {off && <ModelSetupGate variant="compact" feature="bookAi" model={model} />}
    </div>
  );
}
