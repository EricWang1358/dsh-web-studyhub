import React, { useEffect, useId, useRef, useState } from 'react';
import { ui, uiFormat } from '../../i18n.js';
import { Button } from '../../components/index.js';
import Glyph from './Glyph.jsx';
import { failureKind, shortQuote, versionOf } from './model.js';

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

/** The ⋯ menu of a block: a small popover that closes on a click elsewhere, on Escape and after a choice. */
function BlockMenu({ items, label }) {
  const [open, setOpen] = useState(false), root = useRef(null), id = useId();
  useEffect(() => {
    if (!open) return undefined;
    const outside = event => { if (root.current && !root.current.contains(event.target)) setOpen(false); };
    document.addEventListener('pointerdown', outside);
    return () => document.removeEventListener('pointerdown', outside);
  }, [open]);
  const onKeyDown = event => { if (event.key === 'Escape' && open) { event.preventDefault(); event.stopPropagation(); setOpen(false); root.current?.querySelector('button')?.focus(); } };
  return <div className="tr-menu" ref={root} onKeyDown={onKeyDown}>
    <button type="button" className="tr-iconbtn" aria-haspopup="menu" aria-expanded={open} aria-controls={open ? id : undefined} aria-label={label} title={label} onClick={() => setOpen(value => !value)}><Glyph name="more" /></button>
    {open && <div className="tr-menu__list" role="menu" id={id}>
      {items.map(entry => <button key={entry.id} type="button" role="menuitem" className="tr-menu__item" data-tone={entry.tone} disabled={entry.disabled}
        onClick={() => { if (entry.keepOpen) entry.run(); else { setOpen(false); entry.run(); } }}><Glyph name={entry.glyph} /><span>{entry.label}</span></button>)}
    </div>}
  </div>;
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
    <ol>{[...item.history].reverse().map(entry => <li key={entry.version}><strong>{uiFormat('v{0}', [entry.version])}</strong>{entry.comment && <small>{uiFormat('意见：{0}', [entry.comment])}</small>}<span lang={targetLang(item.target)}>{entry.text}</span></li>)}</ol>
  </details>;
}

/** The bar every state shares: the fold handle, the 译 tag and (when it has one) the version, the passage it translates and the ⋯ menu. */
function Bar({ open, onToggle, target, item, menu, preview }) {
  const version = versionOf(item), selection = item?.kind === 'selection';
  return <div className="tr-block__bar">
    <button type="button" className="tr-fold" aria-expanded={open} aria-label={open ? ui('收起译文') : ui('展开译文')} title={open ? ui('收起译文') : ui('展开译文')} onClick={onToggle}>
      <Glyph name="down" /><span className="tr-block__tag" aria-hidden="true">{targetTag(target)}</span>
    </button>
    {selection && <span className="tr-chip tr-chip--quote" title={item.quote}>{shortQuote(item.quote, 40)}</span>}
    {version && <span className="tr-chip" title={version.comment || undefined}>{version.comment ? uiFormat('v{0} · 意见：{1}', [version.version, shortQuote(version.comment, 36)]) : uiFormat('v{0}', [version.version])}</span>}
    {item?.outdated && <span className="tr-chip tr-chip--warn" title={ui('术语表改过了，这段译文可能还没按新术语翻译；可以重新翻译。')}>{ui('术语表已改')}</span>}
    {!open && preview && <span className="tr-block__preview" lang={targetLang(target)}>{shortQuote(preview, 90)}</span>}
    {menu}
  </div>;
}

/**
 * One translation block. `state`: 'ok' | 'pending' | 'error' | 'undo'. In 'ok' the block carries the translation (`item`), in 'pending' a
 * spinner (with the old translation, dimmed, when it is a retranslation), in 'error' the reason and a retry, in 'undo' the few seconds
 * in which a deleted translation can come back.
 */
export default function TranslationBlock({ state, item, target, open, pendingKind, error, onToggle, onCopy, onDelete, onRetranslate, onGlossary, onCancel, onRetry, onUndo, onDismiss }) {
  const [asking, setAsking] = useState(false), [copied, setCopied] = useState(false), timer = useRef(0);
  useEffect(() => () => clearTimeout(timer.current), []);
  const lang = targetLang(target), tag = targetTag(target);
  if (state === 'undo') return <div className="tr-block tr-block--note" role="status" data-state="undo">
    <span>{ui('已删除这段翻译')}</span><Button size="sm" variant="quiet" onClick={onUndo}>{ui('撤销')}</Button>
  </div>;
  if (state === 'error') return <div className="tr-block" role="alert" data-state="error">
    <div className="tr-block__bar"><span className="tr-block__tag tr-block__tag--static" aria-hidden="true">{tag}</span><span className="tr-block__error">{failureText(error)}</span>
      <span className="tr-block__bar-actions">{error?.code !== 'model' && onRetry && <Button size="sm" variant="quiet" onClick={onRetry}>{ui('重试')}</Button>}<Button size="sm" variant="quiet" onClick={onDismiss}>{ui('关闭')}</Button></span></div>
  </div>;
  if (state === 'pending' && !item) return <div className="tr-block" role="status" data-state="pending">
    <div className="tr-block__bar"><span className="sh-spinner" aria-hidden="true" /><span className="tr-block__status">{ui('正在翻译…')}</span><span className="tr-block__bar-actions"><Button size="sm" variant="quiet" onClick={onCancel}>{ui('取消')}</Button></span></div>
  </div>;
  const busy = state === 'pending';
  const copy = async () => { const ok = await onCopy?.(); setCopied(ok !== false); clearTimeout(timer.current); timer.current = setTimeout(() => setCopied(false), 1600); };
  const menu = <BlockMenu label={ui('这段译文的更多操作')} items={[
    { id: 'copy', glyph: 'copy', label: copied ? ui('已复制') : ui('复制译文'), run: copy, keepOpen: true },
    { id: 'again', glyph: 'retry', label: ui('重新翻译…'), run: () => setAsking(true), disabled: busy },
    { id: 'glossary', glyph: 'book', label: ui('术语表…'), run: onGlossary },
    { id: 'delete', glyph: 'trash', label: ui('删除这段翻译'), run: onDelete, tone: 'danger', disabled: busy },
  ]} />;
  return <div className="tr-block" role="note" aria-label={ui('译文')} lang={lang} data-state={busy ? 'busy' : 'ok'} data-open={open ? 'true' : 'false'} data-kind={item.kind}>
    <Bar open={open} onToggle={onToggle} target={target} item={item} menu={menu} preview={item.text} />
    {open && <>
      <p className="tr-block__text">{item.text}</p>
      {busy && <p className="tr-block__status" role="status"><span className="sh-spinner" aria-hidden="true" />{ui('正在重新翻译…')}<Button size="sm" variant="quiet" onClick={onCancel}>{ui('取消')}</Button></p>}
      {!busy && item.warnings?.includes('numbers') && <p className="tr-block__note is-warning">{ui('译文里的数字和原文对不上，请核对。')}</p>}
      {!busy && item.parts > 1 && <p className="tr-block__note">{uiFormat('这段很长，已分成 {0} 小段翻译。', [item.parts])}</p>}
      {!busy && item.reused && <p className="tr-block__note">{ui('沿用了相同文字的旧译文，没有再调用模型。')}</p>}
      {!busy && item.outdated && <p className="tr-block__note is-warning">{ui('术语表改过了，这段译文可能不一致。')}<Button size="sm" variant="quiet" onClick={() => setAsking(true)}>{ui('重新翻译')}</Button></p>}
      <History item={item} />
    </>}
    {asking && <AskForm onCancel={() => setAsking(false)} onSubmit={comment => { setAsking(false); onRetranslate(comment); }} />}
  </div>;
}
