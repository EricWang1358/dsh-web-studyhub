import React, { useLayoutEffect, useRef, useState } from 'react';
import Markdown from '../../Markdown.jsx';
import { Button } from '../../components/index.js';
import { ui, uiFormat } from '../../i18n.js';
import { answerText, clip, displayPrompt, groupTitle, linkKind } from './link-model.js';

const REASON_TEXT = {
  stale: '资料已更新，这段引用需要在当前原文中重新选择。',
  missing: '无法在已保存的资料中核实这段文字，请重新选择。',
  ambiguous: '原文中有多处相同文字，请缩小选区或加入前后文后重新选择。',
  unavailable: '原文位置不可用',
};

/** A disclosure whose body is only built once it is open, so hundreds of passages cost hundreds of summaries, not bodies. */
function LazyDetails({ summary, className, open: forced = false, children, ...rest }) {
  const [opened, setOpened] = useState(false), node = useRef(null);
  const open = forced || opened;
  // A passage opened from the text comes into view in the list (scroll only: nothing is set from here).
  useLayoutEffect(() => { if (forced) node.current?.scrollIntoView?.({ block: 'start' }); }, [forced]);
  return <details ref={node} className={className} open={open || undefined} onToggle={event => setOpened(event.currentTarget.open)} {...rest}>
    <summary>{summary}</summary>
    {open && children}
  </details>;
}

/** One question or Q&A card of a passage: its prompt, a short answer, its deck, the jump, and the extra Q&A asked about it. */
function LinkItem({ link, onOpen }) {
  const kind = linkKind(link), followups = link.followups || [], answer = answerText(link.answer);
  return <article className="reader-link-item" data-kind={kind}>
    <p className="reader-link-item__head">
      {kind === 'qa' && <span className="origin-tag">{ui('问答')}</span>}
      <strong>{displayPrompt(link) || link.cardId}</strong>
    </p>
    {link.deckTitle && <p className="reader-link-item__deck">{link.deckTitle}</p>}
    {answer && <div className="reader-link-item__answer"><Markdown text={clip(answer, 280)} /></div>}
    {onOpen && <div className="reader-link-item__actions">
      <Button size="sm" variant="quiet" onClick={() => onOpen({ deckId: link.deckId, cardId: link.cardId })}>{ui('打开这道题')}</Button>
    </div>}
    {followups.length > 0 && <LazyDetails className="reader-link-item__qa" summary={uiFormat('追问 {0}', [followups.length])}>
      {followups.map(item => <div className="reader-link-item__followup" key={item.id}>
        <strong>{item.question}</strong>
        <Markdown text={item.answer} />
      </div>)}
    </LazyDetails>}
  </article>;
}

/** The words of "题目 2 · 问答卡 1 · 笔记 1" (no plurals to get wrong), shared by the list and the hover text of an underline. */
export const linkTitleWords = () => ({ questions: count => uiFormat('题目 {0}', [count]), qa: count => uiFormat('问答卡 {0}', [count]), notes: count => uiFormat('笔记 {0}', [count]) });

function Group({ group, focused, onOpen }) {
  return <LazyDetails className="reader-link-group" data-kind={group.kind} data-focused={focused || undefined} open={focused}
    summary={<>
      <span className="reader-link-group__no">[{group.number}]</span>
      <span className="reader-link-group__quote">{group.selection.quote}</span>
      <small className="reader-link-group__count">{groupTitle(group, linkTitleWords())}</small>
    </>}>
    {group.links.map(link => <LinkItem key={`${link.deckId}:${link.cardId}`} link={link} onOpen={onOpen} />)}
    {group.notes.map(note => <p className="reader-link-note" key={note.noteId}>
      <span className="reader-link-note__label">{ui('笔记')}</span>
      <span className="reader-link-note__title">{note.title}</span>
      {onOpen && <Button size="sm" variant="quiet" onClick={() => onOpen({ kind: 'note', id: note.noteId })}>{ui('打开笔记')}</Button>}
    </p>)}
  </LazyDetails>;
}

/**
 * The learning panel's list of linked passages: the questions, Q&A cards and notes of each, their follow-up Q&A,
 * and the passages whose link no longer resolves (to be selected again). `model` is buildLinkModel's result;
 * `focusedKey` narrows the list to one passage (set by clicking its underline); `onOpen` receives
 * { deckId, cardId } or { kind: 'note', id }.
 */
export default function PassageLinksPanel({ model, focusedKey, onFocus, onOpen }) {
  const focused = model.groups.some(group => group.key === focusedKey) ? focusedKey : null;
  const shown = focused ? model.groups.filter(group => group.key === focused) : model.groups;
  if (!model.groups.length && !model.stale.length) return null;
  return <section className="reader-links" aria-label={ui('原文关联题目与解析')}>
    <h3 className="study-document-links-heading">{ui('原文关联题目与解析')}</h3>
    <div className="reader-links__list">
      {shown.map(group => <Group key={group.key} group={group} focused={group.key === focused} onOpen={onOpen} />)}
    </div>
    {focused && <Button size="sm" variant="quiet" onClick={() => onFocus(null)}>{ui('显示全部引用')}</Button>}
    {!focused && model.stale.length > 0 && <LazyDetails className="reader-links__stale" summary={uiFormat('需要重新选择 · {0}', [model.stale.length])}>
      {model.stale.map(group => <article className="reader-link-item" key={group.key}>
        <p className="reader-link-item__head"><span className="reader-link-group__no">[{group.number}]</span> <span className="reader-link-group__quote">{group.selection.quote}</span></p>
        <p className="reader-link-item__deck warning">{ui(REASON_TEXT[group.reason] || REASON_TEXT.unavailable)}</p>
        {group.links.map(link => <p className="reader-link-item__deck" key={`${link.deckId}:${link.cardId}`}>{displayPrompt(link) || link.cardId}</p>)}
      </article>)}
    </LazyDetails>}
  </section>;
}
