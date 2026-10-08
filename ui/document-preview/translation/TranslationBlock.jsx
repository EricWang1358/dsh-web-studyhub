import React, { useEffect, useId, useRef, useState } from 'react';
import { ui, uiFormat } from '../../i18n.js';
import { Badge, Button, Icon, InlineMessage, Menu, Spinner } from '../../components/index.js';
import { useCopyFeedback } from '../../use-copy-feedback.js';
import MathText from '../../MathText.jsx';
import { failureKind, shortQuote, versionOf } from './model.js';
import ReaderModelGate from '../ReaderModelGate.jsx';

/* One paragraph's translation, drawn as a block right after the paragraph (逐段对照), in the right column beside it (左右分栏),
   or instead of it (仅译文). It is a note about the passage, not the passage: role="note", the language of the translation
   on it, a left rule and a tint that no link underline uses. Everything here is text, never markup: the translation, the
   learner's comment and the quoted passage are data. */

export const targetTag = target => target === 'en' ? 'EN' : ui('译');
export const targetLang = target => target === 'en' ? 'en' : 'zh-Hans';

const reasonText = code => ({
  empty: ui('回答是空的'), refusal: ui('模型拒绝或在解释，没有翻译'), length: ui('译文的长度和原文对不上'), untranslated: ui('回答还是原文的语言'),
  missing: ui('模型漏了这一段'), format: ui('回答不是约定的格式'),
})[code] || ui('回答有问题');

/** What a passage that did not get a translation says, in plain words. */
export function failureText(error) {
  const kind = failureKind(error?.code);
  if (kind === 'model') return ui('还没有连接模型，没法翻译这段。阅读不受影响；连接模型后再点 译。');
  if (kind === 'answer') return uiFormat('模型的回答没有通过检查：{0}。这段没有保存，可以再试一次。', [reasonText(error.code)]);
  if (kind === 'place') return error.code === 'ambiguous' ? ui('这段文字在资料里出现了多次，请多选一些上下文再译。') : ui('在资料里找不到这段文字，可能资料已更新；请重新选中后再译。');
  return uiFormat('这段没有译成：{0}', [error?.message || ui('出现未知错误')]);
}

/** "给点意见（可选）": the one line a retranslation asks for. Enter sends, Escape closes. */
function AskForm({ onSubmit, onCancel }) {
  const [comment, setComment] = useState(''), input = useRef(null), id = useId();
  useEffect(() => { input.current?.focus(); }, []);
  return <form className="tr-ask" onSubmit={event => { event.preventDefault(); onSubmit(comment.trim()); }} onKeyDown={event => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onCancel(); } }}>
    <label className="tr-ask__label" htmlFor={id}>{ui('给点意见（可选）')}</label>
    <div className="tr-ask__row">
      <input id={id} ref={input} className="tr-ask__input" type="text" value={comment} maxLength={300} onChange={event => setComment(event.target.value)} placeholder={ui('例如：更口语一点；术语保持英文')} />
      <Button size="sm" variant="secondary" type="submit" icon="refresh">{ui('重新翻译')}</Button>
      <Button size="sm" variant="quiet" onClick={onCancel}>{ui('取消')}</Button>
    </div>
  </form>;
}

function History({ item }) {
  if (!item.history?.length) return null;
  return <details className="tr-history">
    <summary>{uiFormat('历史版本 · {0}', [item.history.length])}</summary>
    <ol>{[...item.history].reverse().map(entry => <li key={entry.version}><strong>{uiFormat('v{0}', [entry.version])}</strong>{entry.comment && <small>{uiFormat('意见：{0}', [entry.comment])}</small>}<span lang={targetLang(item.target)}><MathText text={entry.text} /></span></li>)}</ol>
  </details>;
}

/** The bar every state shares: the fold handle, the 译 tag and (when it has one) the version, the passage it translates and the ⋯ menu. */
function Bar({ open, onToggle, target, item, menu, preview, copied }) {
  const version = versionOf(item), selection = item?.kind === 'selection';
  return <div className="tr-block__bar">
    <Button variant="quiet" size="sm" className="tr-fold" aria-expanded={open} aria-label={open ? ui('收起译文') : ui('展开译文')} title={open ? ui('收起译文') : ui('展开译文')} onClick={onToggle}
      icon={<Icon name="chevron-down" size={16} className="tr-glyph" />}>
      <span className="tr-block__tag" aria-hidden="true">{targetTag(target)}</span>
    </Button>
    {selection && <Badge size="sm" className="tr-meta" title={item.quote}>{shortQuote(item.quote, 40)}</Badge>}
    {version && <Badge size="sm" className="tr-meta" title={version.comment || undefined}>{version.comment ? uiFormat('v{0} · 意见：{1}', [version.version, shortQuote(version.comment, 36)]) : uiFormat('v{0}', [version.version])}</Badge>}
    {item?.outdated && <Badge size="sm" tone="warning" className="tr-meta" title={ui('术语表改过了，这段译文可能还没按新术语翻译；可以重新翻译。')}>{ui('术语表已改')}</Badge>}
    {!open && preview && <span className="tr-block__preview" lang={targetLang(target)}>{shortQuote(preview, 90)}</span>}
    {copied && <Badge size="sm" className="tr-meta" role="status">{ui('已复制')}</Badge>}
    {menu}
  </div>;
}

/**
 * One translation block. `state`: 'ok' | 'pending' | 'error' | 'undo'. In 'ok' the block carries the translation (`item`), in 'pending' a
 * spinner (with the old translation, dimmed, when it is a retranslation), in 'error' the reason and a retry, in 'undo' the few seconds
 * in which a deleted translation can come back.
 */
export default function TranslationBlock({ state, item, target, open, pendingKind, error, onToggle, onDelete, onRetranslate, onGlossary, onCancel, onRetry, onUndo, onDismiss }) {
  const [asking, setAsking] = useState(false);
  const { copied, copy } = useCopyFeedback(() => item?.text ?? '', { resetMs: 1600 });
  const lang = targetLang(target), tag = targetTag(target);
  if (state === 'undo') return <div className="tr-block tr-block--note" role="status" data-state="undo">
    <span>{ui('已删除这段翻译')}</span><Button size="sm" variant="quiet" onClick={onUndo}>{ui('撤销')}</Button>
  </div>;
  // No model: the gate (what to do and the button to do it), not a line of text to read.
  if (state === 'error' && error?.code === 'model') return <div className="tr-block" role="alert" data-state="error">
    <div className="tr-block__bar"><span className="tr-block__tag tr-block__tag--static" aria-hidden="true">{tag}</span><span className="tr-block__bar-actions"><Button size="sm" variant="quiet" onClick={onDismiss}>{ui('关闭')}</Button></span></div>
    <ReaderModelGate feature="translate" />
  </div>;
  if (state === 'error') return <div className="tr-block" role="alert" data-state="error">
    <div className="tr-block__bar"><span className="tr-block__tag tr-block__tag--static" aria-hidden="true">{tag}</span><span className="tr-block__error">{failureText(error)}</span>
      <span className="tr-block__bar-actions">{error?.code !== 'model' && onRetry && <Button size="sm" variant="quiet" onClick={onRetry}>{ui('重试')}</Button>}<Button size="sm" variant="quiet" onClick={onDismiss}>{ui('关闭')}</Button></span></div>
  </div>;
  if (state === 'pending' && !item) return <div className="tr-block" role="status" data-state="pending">
    <div className="tr-block__bar"><Spinner /><span className="tr-block__status">{ui('正在翻译…')}</span><span className="tr-block__bar-actions"><Button size="sm" variant="quiet" onClick={onCancel}>{ui('取消')}</Button></span></div>
  </div>;
  // Collapsed: no frame at all. The paragraph's own 译 (filled) opens it again.
  if (!open) return null;
  const busy = state === 'pending';
  const choose = { copy, again: () => setAsking(true), glossary: onGlossary, delete: onDelete };
  const menu = <Menu className="tr-menu" label={ui('这段译文的更多操作')} onSelect={id => choose[id]()} items={[
    { id: 'copy', icon: <Icon name="copy" size={16} />, label: ui('复制译文') },
    { id: 'again', icon: <Icon name="refresh" size={16} />, label: ui('重新翻译…'), disabled: busy },
    { id: 'glossary', icon: <Icon name="book" size={16} />, label: ui('术语表…') },
    { id: 'delete', icon: <Icon name="trash" size={16} />, label: ui('删除这段翻译'), danger: true, disabled: busy },
  ]} />;
  return <div className="tr-block" role="note" aria-label={ui('译文')} lang={lang} data-state={busy ? 'busy' : 'ok'} data-open={open ? 'true' : 'false'} data-kind={item.kind}>
    <Bar open={open} onToggle={onToggle} target={target} item={item} menu={menu} preview={item.text} copied={copied} />
    {open && <>
      <p className="tr-block__text"><MathText text={item.text} /></p>
      {busy && <p className="tr-block__status" role="status"><Spinner />{ui('正在重新翻译…')}<Button size="sm" variant="quiet" onClick={onCancel}>{ui('取消')}</Button></p>}
      {!busy && item.warnings?.includes('numbers') && <InlineMessage tone="warning" className="tr-block__note">{ui('译文里的数字和原文对不上，请核对。')}</InlineMessage>}
      {!busy && item.parts > 1 && <p className="tr-block__note">{uiFormat('这段很长，已分成 {0} 小段翻译。', [item.parts])}</p>}
      {!busy && item.reused && <p className="tr-block__note">{ui('沿用了相同文字的旧译文，没有再调用模型。')}</p>}
      {!busy && item.outdated && <InlineMessage tone="warning" className="tr-block__note" action={{ label: ui('重新翻译'), onClick: () => setAsking(true) }}>{ui('术语表改过了，这段译文可能不一致。')}</InlineMessage>}
      <History item={item} />
    </>}
    {asking && <AskForm onCancel={() => setAsking(false)} onSubmit={comment => { setAsking(false); onRetranslate(comment); }} />}
  </div>;
}
