import React, { useLayoutEffect, useMemo, useRef, useState } from 'react';
import { ui, uiFormat } from '../i18n.js';
import { Badge, Button, Icon, IconButton, Menu, Spinner, TextInput, Tooltip } from '../components/index.js';
import Markdown from '../Markdown.jsx';
import { formatNumber } from '../format.js';
import { aiSize, aiSummary } from './ai-summary.js';
import { markLabels } from './ai-labels.js';
import { AI_FOLD_CHARS } from './point-parts.js';

/* An AI block of the review book (弄懂 / 写一段 / 加一段, docs/review-book.md "AI blocks"): in its point (ui/book/PointBody.jsx) right after the paragraph its
   words are in, or in 我的 when it is for the whole point (ui/book/PointLayer.jsx); its words dashed in the paragraph. It is the learner's text: 保留 marks it as
   theirs, 重新生成 asks the same again (the old text stays until the new one lands), 删除 takes it out (撤销 for a few seconds, ui/book/use-book-ai.js), 复制
   copies its text, and a follow-up question starts a new request whose answer goes right under it. Its links are the book's.
   One row folds it (a fold is the learner's, kept in the browser, never in the text), the row of ui/document-preview/translation/TranslationBlock.jsx: the
   caret, the AI tag, the first real sentence of the text (what it says, not its template), its size and a ⋯ menu with the four actions; open, the row keeps the
   tag (and the size of a long block), the words it is about go back to the dashed words, and the quiet 保留 / 重新生成 / 删除 and the follow-up box sit under the
   text. The text's leading 原文说：/ 意思就是： labels are muted (ui/book/book-ai.css). */

/** The words a block row says about its state, only when it has one: 多为重复 (it mostly restates the notes), 原位置已变 (its words are gone). */
const hintOf = (repeat, gone) => [repeat && ui('和上面的讲解大部分重复，可以放着收起。'), gone && ui('这段 AI 段落针对的文字改过了，找不到原来的位置。')].filter(Boolean).join(' ');

/** The size on the row: 「约 5,200 字」. */
const sizeText = body => uiFormat('约 {0} 字', [formatNumber(aiSize(body))]);

/** The ⋯ of a folded row: the block's four actions without opening it (保留 only while it is new). */
function BlockMenu({ block, busy, onAction }) {
  const items = [
    block.state === 'new' && { id: 'keep', icon: 'check', label: ui('保留') },
    { id: 'again', icon: 'refresh', label: ui('重新生成'), disabled: busy, hint: ui('旧的留着，新的写好再换') },
    { id: 'copy', icon: 'copy', label: ui('复制') },
    { id: 'delete', icon: 'trash', label: ui('删除'), disabled: busy, hint: ui('可以撤销') },
  ].filter(Boolean);
  return <Menu label={ui('这段 AI 段落的操作')} items={items} onSelect={id => onAction(id, block)} className="book-ai__menu"
    trigger={({ props, ref }) => <IconButton ref={ref} size="sm" icon="more" label={ui('这段 AI 段落的操作')} className="book-ai__more" {...props} />} />;
}

/** item: { block, status } (lib/course-book-ai-text.js weaveBlocks); resolveLink; onAction(action, block) with keep | delete | again | copy; onFollow(block, question);
    busy; folded, onFold(id, on): the fold; anchored, onWords(id): the block's words are marked in the paragraph and a press goes back to them; repeat: it mostly
    restates the point's notes (多为重复, ui/book/point-parts.js); rewriting: the line of its 重新生成 (ui/book/ai-lines.js) while it runs, onCancel(line).
    A folded row is always one line (its summary cut with an ellipsis), as high as the line a task leaves; data-ai-landed is a landed block's short highlight. */
export default function BookAiBlock({ item, resolveLink, onAction, onFollow, busy = false, folded = false, onFold, anchored = false, onWords, repeat = false, rewriting = null, onCancel }) {
  const { block, status } = item, gone = status === 'gone';
  const [question, setQuestion] = useState('');
  const summary = useMemo(() => (folded ? aiSummary(block.body) : ''), [folded, block.body]);
  const bodyRef = useRef(null);
  useLayoutEffect(() => (folded ? undefined : markLabels(bodyRef.current)), [folded, block.body]);
  const stuck = busy || !!rewriting;
  return (
    <aside className="book-ai" data-ai-block={block.id} data-ai-state={block.state} data-ai-folded={folded || undefined} data-ai-rewriting={rewriting ? '' : undefined} aria-label={ui('AI 段落')}>
      <div className="book-ai__head">
        <Tooltip layer content={hintOf(repeat, gone)} anchorClassName="book-ai__tip">
          <Button variant="quiet" size="sm" className="book-ai__toggle" aria-expanded={!folded} onClick={() => onFold?.(block.id, !folded)}>
            <Icon name="caret" size={16} className="book-ai__caret" />
            <Badge size="sm" className="book-ai__tag">AI</Badge>
            {gone && <Badge size="sm" tone="warning">{ui('原位置已变')}</Badge>}
            {folded && <span className="book-ai__summary">{summary}</span>}
            {(folded || aiSize(block.body) >= AI_FOLD_CHARS) && <span className="book-ai__meta">{sizeText(block.body)}</span>}
            {repeat && <span className="book-ai__meta">{ui('多为重复')}</span>}
          </Button>
        </Tooltip>
        {/* 重新生成 running: the old text stays; the row says so and can stop it. */}
        {rewriting && <span className="book-ai__again" role="status"><Spinner size="sm" />{ui('正在重新生成')}
          {rewriting.kind === 'writing' && <Button variant="link" size="sm" onClick={() => onCancel?.(rewriting)}>{ui('取消')}</Button>}</span>}
        {folded && !rewriting && <BlockMenu block={block} busy={stuck} onAction={onAction} />}
      </div>
      {!folded && <>
        {/* What it is about: the dashed words go back by a press; a whole-point block is about its heading, which is right above. */}
        {block.mode !== 'here' && block.first && (anchored
          ? <Button variant="link" size="sm" wrap className="book-ai__words" onClick={() => onWords?.(block.id)}>{block.first}</Button>
          : <span className="book-ai__quote">{block.first}</span>)}
        <Markdown key={block.body} rootRef={bodyRef} className="book-ai__body" text={block.body} resolveLink={resolveLink} />
        <div className="book-ai__actions">
          {block.state === 'new' && <Button size="sm" variant="quiet" disabled={busy} onClick={() => onAction('keep', block)}>{ui('保留')}</Button>}
          <Button size="sm" variant="quiet" disabled={stuck} onClick={() => onAction('again', block)}>{ui('重新生成')}</Button>
          <Tooltip layer content={ui('删除后几秒内可以撤销。')} anchorClassName="book-ai__act">
            <Button size="sm" variant="quiet" disabled={stuck} onClick={() => onAction('delete', block)}>{ui('删除')}</Button>
          </Tooltip>
        </div>
        <form className="book-ai__follow" onSubmit={event => { event.preventDefault(); if (question.trim()) { onFollow(block, question.trim()); setQuestion(''); } }}>
          <TextInput className="book-ai__input" aria-label={ui('接着问')} placeholder={ui('接着问…')} value={question} maxLength={600} onChange={event => setQuestion(event.target.value)} disabled={busy} />
          <Button size="sm" type="submit" disabled={busy || !question.trim()}>{ui('问')}</Button>
        </form>
      </>}
    </aside>
  );
}
