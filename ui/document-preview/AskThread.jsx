import React, { useCallback, useMemo, useState } from 'react';
import Markdown from '../Markdown.jsx';
import { ui, uiFormat } from '../i18n.js';
import { Button, ConfirmDialog, DisclosureToggle, InlineMessage, Tooltip, foldLabel } from '../components/index.js';
import SaveAnswerAsCard from './links/SaveAnswerAsCard.jsx';
import { MAX_DEPTH, MAX_NODES, childrenOf, pathLabel } from './ask-thread.js';
import { stripTermMarkers } from '../term-marker.js';

/** Why a question inside an answer was not asked: a plain sentence, and for the limits the reason they exist (shown on hover and focus). */
export function refusal(reason) {
  if (reason === 'depth') return { text: uiFormat('问中问最多 {0} 层。请回到上面的提问框，把它作为新问题提出。', [MAX_DEPTH]), why: ui('每次提问都会调用一次模型，限制层数和条数是为了控制用量。') };
  if (reason === 'nodes') return { text: uiFormat('这一串问答已有 {0} 条，不能再加。请在上面的提问框里提新问题。', [MAX_NODES]), why: ui('每次提问都会调用一次模型，限制层数和条数是为了控制用量。') };
  if (reason === 'busy') return { text: ui('这条回答还没出来，等它完成后再接着问。'), why: '' };
  return { text: ui('找不到要接着问的那条回答。'), why: '' };
}

/** Follow-ups under every answer: a small question box and, under an answer to a term, two quick forms of it (they ask at once). */
function FollowUp({ node, onAsk, quick }) {
  const [text, setText] = useState('');
  const submit = event => {
    event.preventDefault();
    if (!text.trim()) return;
    onAsk({ parentId: node.id, question: text.trim() }); setText('');
  };
  const chip = (label, question) => <Tooltip layer group="ask-help" content={uiFormat('接着这条回答问：「{0}」。点击即发送。', [question])}>
    <Button size="sm" onClick={() => onAsk({ parentId: node.id, question })}>{label}</Button>
  </Tooltip>;
  return <div className="ask-node__follow">
    {quick && <div className="ask-quick" role="group" aria-label={ui('快捷追问')}>
      {chip(ui('再简单点'), ui('请再简单一点，用更口语的话说。'))}
      {chip(ui('举个例子'), ui('请依据这段原文举一个例子。'))}
    </div>}
    <form onSubmit={submit}>
      <div className="ask-node__follow-row">
        <input className="ask-node__follow-input" value={text} onChange={event => setText(event.target.value)} placeholder={ui('接着问这一条')} aria-label={ui('接着问这一条')} maxLength={500} />
        <Button type="submit" size="sm" disabled={!text.trim()}>{ui('提问')}</Button>
      </div>
    </form>
  </div>;
}

/** What the thread says about being kept: a button to keep it (阅读), that it is kept, and the way to delete it (批注). */
function KeepRow({ answered, saved, mode, busy, error, onKeep, onDelete }) {
  const [confirm, setConfirm] = useState(false);
  if (!answered.length || !onKeep) return null;
  const all = answered.every(node => saved.has(node.id));
  return <div className="ask-node__keep">
    {all ? <>
      <span className="ask-node__kept" role="status">{ui('已存为批注')}</span>
      {mode === 'annotate' && onDelete && <Button size="sm" variant="quiet" onClick={() => setConfirm(true)}>{ui('删除这组批注')}</Button>}
    </> : <Tooltip layer group="ask-help" content={<span className="ask-tip"><span>{ui('把这组问答和这段原文一起存下来。')}</span><span>{ui('之后在批注模式下再次选中这段，它们会回来，原文里也会标出这段。')}</span></span>}>
      <Button size="sm" busy={busy} busyLabel={ui('正在保存…')} onClick={() => onKeep()}>{ui('存为批注')}</Button>
    </Tooltip>}
    {error && <InlineMessage tone="error" className="ask-node__keep-error">{error}</InlineMessage>}
    {confirm && <ConfirmDialog title={ui('删除这组批注？')} description={ui('这段原文上的问答会从批注中删除，不会影响原文和题目。')} confirmLabel={ui('删除')}
      onConfirm={onDelete} onClose={() => setConfirm(false)} />}
  </div>;
}

/**
 * One answer of the thread and, under it, the answers to the questions asked inside it. The heading is the path
 * ("没听懂 › ELK"); the answer's marked terms are buttons that ask the next question here.
 */
export function AskNode({ thread, node, depth = 1, save, keep, onAsk, onRetry, onToggle }) {
  const label = pathLabel(thread, node.id), bodyId = `ask-${node.id}-body`;
  const children = childrenOf(thread, node.id);
  const askTerm = useCallback(term => onAsk({ parentId: node.id, term }), [onAsk, node.id]);
  // One string decides the list, so the answer is parsed again only when a term was added.
  const askedKey = children.map(child => child.term).filter(Boolean).join('\u0001');
  const asked = useMemo(() => askedKey ? askedKey.split('\u0001') : [], [askedKey]);
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
        {node.parentId === null && keep && <KeepRow {...keep} />}
      </>}
      {children.map(child => <AskNode key={child.id} thread={thread} node={child} depth={depth + 1} save={save} onAsk={onAsk} onRetry={onRetry} onToggle={onToggle} />)}
    </div>
  </section>;
}

const EMPTY = new Set();
/** The whole thread of the selection: the first answer, the answers inside it, and the reason the last click did nothing. */
export default function AskThread({ thread, notice = '', noticeWhy = '', mode = 'read', savedIds, keepBusy = false, keepError = '', onKeep, onDelete, ...handlers }) {
  const roots = childrenOf(thread, null);
  const saved = savedIds || EMPTY;
  const answered = useMemo(() => thread.nodes.filter(node => node.status === 'answered'), [thread]);
  if (!roots.length) return null;
  const keep = onKeep ? { answered, saved, mode, busy: keepBusy, error: keepError, onKeep, onDelete } : null;
  return <div className="ask-thread" aria-label={ui('提问与回答')}>
    {/* Several first-level questions can sit on one passage; keeping is for the whole thread, so its button is under the last one only. */}
    {roots.map((node, index) => <AskNode key={node.id} thread={thread} node={node} keep={index === roots.length - 1 ? keep : null} {...handlers} />)}
    {/* After the answers, never above them: a refusal must not move what is already shown. */}
    {notice && (noticeWhy
      ? <Tooltip layer group="ask-help" content={noticeWhy}><p className="ask-thread__notice" role="status" tabIndex={0}>{notice}</p></Tooltip>
      : <p className="ask-thread__notice" role="status">{notice}</p>)}
  </div>;
}
