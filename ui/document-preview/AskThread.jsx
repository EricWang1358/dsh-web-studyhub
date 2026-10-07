import React, { useCallback, useMemo, useState } from 'react';
import Markdown from '../Markdown.jsx';
import { ui, uiFormat } from '../i18n.js';
import { Button, DisclosureToggle, InlineMessage, foldLabel } from '../components/index.js';
import SaveAnswerAsCard from './links/SaveAnswerAsCard.jsx';
import { MAX_DEPTH, MAX_NODES, childrenOf, pathLabel } from './ask-thread.js';
import { stripTermMarkers } from '../term-marker.js';

/** Why a question inside an answer was not asked, in a plain sentence (`planAsk` gives the reason). */
export function refusalText(reason) {
  if (reason === 'depth') return uiFormat('问中问最多 {0} 层。请回到上面的提问框，把它作为新问题提出。', [MAX_DEPTH]);
  if (reason === 'nodes') return uiFormat('这一串问答已有 {0} 条，不能再加。请在上面的提问框里提新问题。', [MAX_NODES]);
  if (reason === 'busy') return ui('这条回答还没出来，等它完成后再接着问。');
  return ui('找不到要接着问的那条回答。');
}

/** Follow-ups under every answer: a small question box and two quick forms of it. */
function FollowUp({ node, onAsk, quick }) {
  const [text, setText] = useState('');
  const submit = event => {
    event.preventDefault();
    if (!text.trim()) return;
    onAsk({ parentId: node.id, question: text.trim() }); setText('');
  };
  return <div className="ask-node__follow">
    {quick && <div className="ask-quick" role="group" aria-label={ui('快捷追问')}>
      <Button size="sm" onClick={() => onAsk({ parentId: node.id, question: ui('请再简单一点，用更口语的话说。') })}>{ui('再简单点')}</Button>
      <Button size="sm" onClick={() => onAsk({ parentId: node.id, question: ui('请依据这段原文举一个例子。') })}>{ui('举个例子')}</Button>
    </div>}
    <form onSubmit={submit}>
      <div className="ask-node__follow-row">
        <input className="ask-node__follow-input" value={text} onChange={event => setText(event.target.value)} placeholder={ui('接着问这一条')} aria-label={ui('接着问这一条')} maxLength={500} />
        <Button type="submit" size="sm" disabled={!text.trim()}>{ui('提问')}</Button>
      </div>
    </form>
  </div>;
}

/**
 * One answer of the thread and, under it, the answers to the questions asked inside it. The heading is the path
 * ("没听懂 › ELK"); the answer's marked terms are buttons that ask the next question here.
 */
export function AskNode({ thread, node, depth = 1, save, onAsk, onRetry, onToggle }) {
  const label = pathLabel(thread, node.id), bodyId = `ask-${node.id}-body`;
  const children = childrenOf(thread, node.id);
  const askTerm = useCallback(term => onAsk({ parentId: node.id, term }), [onAsk, node.id]);
  // One string decides the list, so the answer is parsed again only when a term was added.
  const askedKey = children.map(child => child.term).filter(Boolean).join('');
  const asked = useMemo(() => askedKey ? askedKey.split('') : [], [askedKey]);
  const open = !node.collapsed;
  return <section className="ask-node" data-ask-node={node.id} data-depth={depth} data-status={node.status} tabIndex={-1}>
    <div className="ask-node__head">
      <DisclosureToggle open={open} controls={bodyId} onToggle={() => onToggle(node.id)} label={foldLabel(open, label)} />
      <h4 className="ask-node__title">{label}</h4>
    </div>
    <div id={bodyId} className="ask-node__body" hidden={!open}>
      {node.status === 'asking' && <p className="ask-node__pending muted" role="status">{ui('正在回答…')}</p>}
      {node.status === 'failed' && <div className="ask-node__failed">
        <InlineMessage tone="error">{node.error || ui('暂时无法回答。')}</InlineMessage>
        <Button size="sm" onClick={() => onRetry(node.id)}>{ui('重试')}</Button>
      </div>}
      {node.status === 'answered' && <>
        <div className="study-grounded-answer"><Markdown text={node.answer} onTerm={askTerm} askedTerms={asked} /></div>
        {save && <SaveAnswerAsCard key={`${node.id}:${node.answer}`} {...save} question={node.question} answer={stripTermMarkers(node.answer)} />}
        <FollowUp node={node} onAsk={onAsk} quick={node.parentId !== null} />
      </>}
      {children.map(child => <AskNode key={child.id} thread={thread} node={child} depth={depth + 1} save={save} onAsk={onAsk} onRetry={onRetry} onToggle={onToggle} />)}
    </div>
  </section>;
}

/** The whole thread of the selection: the first answer, the answers inside it, and the reason the last click did nothing. */
export default function AskThread({ thread, notice = '', ...handlers }) {
  const roots = childrenOf(thread, null);
  if (!roots.length) return null;
  return <div className="ask-thread" aria-label={ui('提问与回答')}>
    {roots.map(node => <AskNode key={node.id} thread={thread} node={node} {...handlers} />)}
    {/* After the answers, never above them: a refusal must not move what is already shown. */}
    {notice && <p className="ask-thread__notice" role="status">{notice}</p>}
  </div>;
}
