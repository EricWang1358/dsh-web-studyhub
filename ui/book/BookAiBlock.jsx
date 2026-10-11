import React, { useState } from 'react';
import { ui } from '../i18n.js';
import { Badge, Button, Icon, TextInput } from '../components/index.js';
import Markdown from '../Markdown.jsx';

/* An AI block of the review book (弄懂 / 加一段, M4): in the learner's layer of its point (ui/book/PointLayer.jsx), its words dashed in the text above
   (marked 原位置已变 when its words are gone). It is the learner's text: 保留 marks it as theirs, 重新生成 asks the same again (it is written over), 删除 takes it out, and a
   follow-up question starts a new request whose answer goes right under it. Its links are the book's. Its header folds it (a fold is the learner's, kept in
   the browser, never in the text): the first line of the answer stays as a quiet summary, and the 关于：「…」 goes back to the dashed words in the paragraph. */

/** The first line of an answer as plain words for the folded header. */
export const summaryOf = body => {
  const line = String(body ?? '').split('\n').map(item => item.trim()).find(Boolean) ?? '';
  return line.replace(/<!--.*?-->/g, '').replace(/\[\^\d+\]/g, '').replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/\[\[([^\]]+)\]\]/g, '$1')
    .replace(/[*_`~#>]+/g, '').replace(/\s+/g, ' ').trim();
};

/** item: { block, status } (lib/course-book-ai-text.js weaveBlocks); resolveLink; onAction(action, block) with keep | delete | again; onFollow(block, question); busy;
    folded, onFold(id, on): the fold; anchored, onWords(id): the block's words are marked in the paragraph and a press goes back to them; repeat: it mostly
    restates the point's notes (与上面的讲解重复度高). 新 shows on an open block only (its 保留 is there). */
export default function BookAiBlock({ item, resolveLink, onAction, onFollow, busy = false, folded = false, onFold, anchored = false, onWords, repeat = false }) {
  const { block, status } = item;
  const [question, setQuestion] = useState('');
  const about = <span className="book-ai__quote">{block.first}</span>;
  return (
    <aside className="book-ai" data-ai-block={block.id} data-ai-state={block.state} data-ai-folded={folded || undefined} aria-label={ui('AI 写的段落')}>
      {/* The whole row folds; the 关于 link is the one thing in it that does something else. */}
      <div className="book-ai__about" onClick={event => { if (!event.target.closest('[data-ai-skip]')) onFold?.(block.id, !folded); }}>
        <Button variant="quiet" size="sm" className="book-ai__toggle" aria-expanded={!folded} aria-label={ui('AI 写的段落')}>
          <Icon name="caret" size={14} className="book-ai__caret" />
          <Badge size="sm" tone="accent">AI</Badge>
        </Button>
        {anchored ? <Button variant="link" size="sm" wrap className="book-ai__words" data-ai-skip onClick={() => onWords?.(block.id)}>{block.first}</Button> : about}
        {block.state === 'new' && !folded && <Badge size="sm" tone="info">{ui('新')}</Badge>}
        {status === 'gone' && <Badge size="sm" tone="warning">{ui('原位置已变')}</Badge>}
        {folded && <span className="book-ai__summary">{summaryOf(block.body)}</span>}
      </div>
      {/* A whole-point block that mostly says what the notes above already say (ui/book/point-parts.js): a quiet line and one press to fold it. */}
      {repeat && <p className="book-ai__repeat" data-ai-skip>{ui('与上面的讲解重复度高')}
        {!folded && <Button variant="link" size="sm" className="book-ai__repeat-fold" onClick={() => onFold?.(block.id, true)}>{ui('收起')}</Button>}</p>}
      {!folded && <>
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
      </>}
    </aside>
  );
}
