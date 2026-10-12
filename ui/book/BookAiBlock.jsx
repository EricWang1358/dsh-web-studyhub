import React, { useLayoutEffect, useMemo, useRef, useState } from 'react';
import { ui, uiFormat } from '../i18n.js';
import { Badge, Button, Icon, TextInput, Tooltip } from '../components/index.js';
import Markdown from '../Markdown.jsx';
import { formatNumber } from '../format.js';
import { aiSize, aiSummary } from './ai-summary.js';
import { markLabels } from './ai-labels.js';

/* An AI block of the review book (弄懂 / 加一段, M4): in its point (ui/book/PointBody.jsx) right after the paragraph its words are in, or in 我的 when it is for
   the whole point (ui/book/PointLayer.jsx); its words dashed in the paragraph. It is the learner's text: 保留 marks it as theirs, 重新生成 asks the same again (it is
   written over), 删除 takes it out, and a follow-up question starts a new request whose answer goes right under it. Its links are the book's.
   One row folds it (a fold is the learner's, kept in the browser, never in the text): the caret, the AI tag, the first real sentence of the text (what it
   says, not its template) and its size; open, the row keeps the tag and the size, the words it is about go back to the dashed words, and the quiet 保留 /
   重新生成 / 删除 and the follow-up box sit under the text. The text's leading 原文说：/ 意思就是： labels are muted (ui/book/book.css). */

/** The words a block row says about its state, only when it has one: 多为重复 (it mostly restates the notes), 原位置已变 (its words are gone). */
const hintOf = (repeat, gone) => [repeat && ui('和上面的讲解大部分重复，可以放着收起。'), gone && ui('这段 AI 段落针对的文字改过了，找不到原来的位置。')].filter(Boolean).join(' ');

/** The size on the row: 「约 5,200 字」. */
const sizeText = body => uiFormat('约 {0} 字', [formatNumber(aiSize(body))]);

/** item: { block, status } (lib/course-book-ai-text.js weaveBlocks); resolveLink; onAction(action, block) with keep | delete | again; onFollow(block, question); busy;
    folded, onFold(id, on): the fold; anchored, onWords(id): the block's words are marked in the paragraph and a press goes back to them; repeat: it mostly
    restates the point's notes (多为重复, ui/book/point-parts.js). */
export default function BookAiBlock({ item, resolveLink, onAction, onFollow, busy = false, folded = false, onFold, anchored = false, onWords, repeat = false }) {
  const { block, status } = item, gone = status === 'gone';
  const [question, setQuestion] = useState('');
  const summary = useMemo(() => (folded ? aiSummary(block.body) : ''), [folded, block.body]);
  const bodyRef = useRef(null);
  useLayoutEffect(() => (folded ? undefined : markLabels(bodyRef.current)), [folded, block.body]);
  return (
    <aside className="book-ai" data-ai-block={block.id} data-ai-state={block.state} data-ai-folded={folded || undefined} aria-label={ui('AI 段落')}>
      <Tooltip layer content={hintOf(repeat, gone)} anchorClassName="book-ai__tip">
        <Button variant="quiet" size="sm" className="book-ai__toggle" aria-expanded={!folded} onClick={() => onFold?.(block.id, !folded)}>
          <Icon name="caret" size={16} className="book-ai__caret" />
          <Badge size="sm" className="book-ai__tag">AI</Badge>
          {gone && <Badge size="sm" tone="warning">{ui('原位置已变')}</Badge>}
          {folded && <span className="book-ai__summary">{summary}</span>}
          <span className="book-ai__meta">{sizeText(block.body)}</span>
          {repeat && <span className="book-ai__meta">{ui('多为重复')}</span>}
        </Button>
      </Tooltip>
      {!folded && <>
        {/* What it is about: the dashed words go back by a press; a whole-point block is about its heading, which is right above. */}
        {block.mode !== 'here' && block.first && (anchored
          ? <Button variant="link" size="sm" wrap className="book-ai__words" onClick={() => onWords?.(block.id)}>{block.first}</Button>
          : <span className="book-ai__quote">{block.first}</span>)}
        <Markdown key={block.body} rootRef={bodyRef} className="book-ai__body" text={block.body} resolveLink={resolveLink} />
        <div className="book-ai__actions">
          {block.state === 'new' && <Button size="sm" variant="quiet" disabled={busy} onClick={() => onAction('keep', block)}>{ui('保留')}</Button>}
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
