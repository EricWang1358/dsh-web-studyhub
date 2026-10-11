import React, { useState } from 'react';
import { ui } from '../i18n.js';
import { Button, Popover, TextArea } from '../components/index.js';
import { useSendToChat } from './send-to-chat.js';

/* 「发给主会话」 (docs/review-book-agent.md): a small popover with a box for what the learner wants changed and a send button, on a point's toolbar row (scope
   'point') and in the book's header (scope 'book'). Sending fills the main chat's input box with a message that names the study-book skill and the point; the
   chat reads the point itself. An empty box is allowed (the message then says so); the three presets fill it in one tap. */

export const PRESETS = ['润色成大白话', '补全没讲到的概念', '加例子和过渡'];

/** The box and the buttons (also drawn on their own by the tests). onSend(instruction) -> a promise; the popover closes when it ends. */
export function BookToChatForm({ scope, pending, onSend }) {
  const [text, setText] = useState('');
  const submit = event => { event?.preventDefault?.(); if (!pending) onSend(text.trim()); };
  return (
    <form className="book-chat__form" data-book-chat-form={scope} onSubmit={submit}>
      <p className="book-chat__title">{scope === 'book' ? ui('让主会话改整本书') : ui('让主会话改这一节')}</p>
      <div className="book-chat__presets" role="group" aria-label={ui('常用的改法')}>
        {PRESETS.map(preset => <Button key={preset} size="sm" variant="quiet" type="button" className="book-chat__preset" data-book-chat-preset={preset}
          onClick={() => setText(ui(preset))}>{ui(preset)}</Button>)}
      </div>
      <TextArea className="book-chat__input" rows={3} maxLength={600} aria-label={ui('你想怎么改（可以留空）')} placeholder={ui('比如：讲得再慢一点，加一个例子（可以留空）')}
        value={text} onChange={event => setText(event.target.value)}
        onKeyDown={event => { if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) submit(event); }} />
      <div className="book-chat__send">
        <Button size="sm" variant="primary" type="submit" disabled={pending} data-book-chat-send>{ui('发送')}</Button>
      </div>
      <p className="book-chat__hint">{ui('也可以直接在主对话里说你想怎么改，主会话会按 study-book 改书，每次改动都能回退')}</p>
    </form>
  );
}

/** scope: 'point' (node: the point) or 'book'; course; files: course.book.open's files (the version of the generated file). */
export default function BookToChat({ scope, node = null, course, files = null, defaultOpen = false }) {
  const send = useSendToChat(course);
  const [open, setOpen] = useState(defaultOpen), [pending, setPending] = useState(false);
  const label = scope === 'book' ? ui('整本书 · 发给主会话') : ui('发给主会话');
  const onSend = async instruction => {
    setPending(true);
    try { await send({ scope, node, files, instruction }); setOpen(false); } finally { setPending(false); }
  };
  return (
    <Popover label={label} className="book-chat" panelClassName="book-chat__panel" placement="bottom-end" open={open} onOpenChange={setOpen}
      trigger={({ props, ref }) => <Button ref={ref} size="sm" variant={scope === 'book' ? 'secondary' : 'quiet'} className="book-chat__button" data-book-chat={scope} {...props}>{label}</Button>}>
      <BookToChatForm scope={scope} pending={pending} onSend={onSend} />
    </Popover>
  );
}
