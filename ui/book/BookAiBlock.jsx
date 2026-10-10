import React, { useState } from 'react';
import { ui } from '../i18n.js';
import { Badge, Button, TextInput } from '../components/index.js';
import Markdown from '../Markdown.jsx';

/* An AI block of the review book (弄懂 / 加一段, M4): right after the paragraph it is about (or under its heading; at the end of the point, marked 原位置已变,
   when its words are gone). It is the learner's text: 保留 marks it as theirs, 重新生成 asks the same again (it is written over), 删除 takes it out, and a
   follow-up question starts a new request whose answer goes right under it. Its links are the book's. */

/** item: { block, status } (lib/course-book-ai-text.js weaveBlocks); resolveLink; onAction(action, block) with keep | delete | again; onFollow(block, question); busy. */
export default function BookAiBlock({ item, resolveLink, onAction, onFollow, busy = false }) {
  const { block, status } = item;
  const [question, setQuestion] = useState('');
  return (
    <aside className="book-ai" data-ai-block={block.id} data-ai-state={block.state} aria-label={ui('AI 写的段落')}>
      <p className="book-ai__about">
        <Badge size="sm" tone="accent">AI</Badge> <span>{block.first}</span>
        {block.state === 'new' && <Badge size="sm" tone="info">{ui('新')}</Badge>}
        {status === 'gone' && <Badge size="sm" tone="warning">{ui('原位置已变')}</Badge>}
      </p>
      <Markdown className="book-ai__body" text={block.body} resolveLink={resolveLink} />
      <div className="book-ai__actions">
        {block.state === 'new' && <Button size="sm" variant="secondary" disabled={busy} onClick={() => onAction('keep', block)}>{ui('保留')}</Button>}
        <Button size="sm" variant="quiet" icon="refresh" disabled={busy} onClick={() => onAction('again', block)}>{ui('重新生成')}</Button>
        <Button size="sm" variant="quiet" disabled={busy} onClick={() => onAction('delete', block)}>{ui('删除')}</Button>
      </div>
      <form className="book-ai__follow" onSubmit={event => { event.preventDefault(); if (question.trim()) { onFollow(block, question.trim()); setQuestion(''); } }}>
        <TextInput className="book-ai__input" aria-label={ui('接着问')} placeholder={ui('接着问…')} value={question} maxLength={600} onChange={event => setQuestion(event.target.value)} disabled={busy} />
        <Button size="sm" type="submit" disabled={busy || !question.trim()}>{ui('问')}</Button>
      </form>
    </aside>
  );
}
