import React, { useId, useState } from 'react';
import { ui, uiFormat } from '../../i18n.js';
import { Button, Dialog, InlineMessage } from '../../components/index.js';
import { TokenEstimateView } from '../../TokenUsage.jsx';

/* The document's glossary (术语表): a term and what to do with it, kept as written or always rendered one way. It is passed
   to the model with every translation of a passage that contains a term. Saving it never retranslates anything: the dialog
   says how many kept translations the new glossary would make outdated, prices retranslating them and waits to be told. */

const rowsOf = glossary => glossary.length ? glossary.map(entry => ({ term: entry.term, mode: entry.to ? 'fixed' : 'keep', to: entry.to })) : [];
const toGlossary = rows => rows.filter(row => row.term.trim()).map(row => ({ term: row.term.trim(), to: row.mode === 'fixed' ? row.to.trim() : '' }));

function Row({ row, index, onChange, onRemove, autoFocus }) {
  const id = useId();
  return <li className="tr-gloss__row">
    <input className="tr-gloss__term" aria-label={uiFormat('术语 {0}', [index + 1])} value={row.term} maxLength={80} autoFocus={autoFocus} placeholder={ui('例如 CQRS')} onChange={event => onChange({ term: event.target.value })} />
    <select className="tr-gloss__mode" aria-label={uiFormat('术语 {0} 的处理方式', [index + 1])} value={row.mode} onChange={event => onChange({ mode: event.target.value })}>
      <option value="keep">{ui('保持原文')}</option><option value="fixed">{ui('固定译法')}</option>
    </select>
    <input id={id} className="tr-gloss__to" aria-label={uiFormat('术语 {0} 的固定译法', [index + 1])} value={row.mode === 'fixed' ? row.to : ''} maxLength={160} disabled={row.mode !== 'fixed'}
      placeholder={row.mode === 'fixed' ? ui('固定译成…') : ''} onChange={event => onChange({ to: event.target.value })} />
    <button type="button" className="tr-iconbtn" aria-label={uiFormat('删除术语 {0}', [index + 1])} title={ui('删除这一行')} onClick={onRemove}>×</button>
  </li>;
}

/**
 * `glossary`: [{ term, to }] as kept. `onSave(glossary)` resolves { affected: { count, passages } }; `onPrice(passages)` resolves an estimate
 * (or null); `onRetranslate(passages)` starts the job that translates those passages again. `onClose()` unmounts the dialog.
 */
export default function GlossaryDialog({ glossary, target, onSave, onPrice, onRetranslate, onClose }) {
  const [rows, setRows] = useState(() => rowsOf(glossary).length ? rowsOf(glossary) : [{ term: '', mode: 'keep', to: '' }]);
  const [saved, setSaved] = useState(null), [busy, setBusy] = useState(false), [error, setError] = useState(''), [estimate, setEstimate] = useState(null);
  const change = (index, patch) => { setSaved(null); setRows(list => list.map((row, at) => at === index ? { ...row, ...patch } : row)); };
  const save = async () => {
    setBusy(true); setError('');
    try {
      const result = await onSave(toGlossary(rows));
      setSaved(result);
      setRows(list => list.filter(row => row.term.trim()).length ? list.filter(row => row.term.trim()) : [{ term: '', mode: 'keep', to: '' }]);
      setEstimate(result.affected.count ? await onPrice(result.affected.passages) : null);
    } catch (failure) { setError(failure?.message || ui('出现未知错误')); } finally { setBusy(false); }
  };
  const again = async () => { setBusy(true); try { await onRetranslate(saved.affected.passages); onClose(); } catch (failure) { setError(failure?.message || ui('出现未知错误')); setBusy(false); } };
  const footer = <>
    <Button variant="primary" busy={busy} onClick={save}>{ui('保存术语表')}</Button>
    <Button variant="quiet" onClick={onClose}>{saved ? ui('关闭') : ui('取消')}</Button>
  </>;
  return <Dialog title={ui('术语表')} size="md" onClose={onClose} footer={footer}
    description={target === 'en' ? ui('这份资料专用。写在表里的词，每次翻译都会交给模型：保持原文的不翻，固定译法的按你写的翻。') : ui('这份资料专用。写在表里的词，每次翻译都会交给模型：保持原文的不翻（比如 CQRS），固定译法的按你写的翻。')}>
    <div className="tr-gloss">
      <ul className="tr-gloss__list">{rows.map((row, index) => <Row key={index} row={row} index={index} autoFocus={index === rows.length - 1 && rows.length > 1}
        onChange={patch => change(index, patch)} onRemove={() => { setSaved(null); setRows(list => list.filter((_, at) => at !== index)); }} />)}</ul>
      <Button size="sm" variant="quiet" icon="plus" onClick={() => setRows(list => [...list, { term: '', mode: 'keep', to: '' }])}>{ui('添加一行')}</Button>
      {error && <InlineMessage tone="error">{error}</InlineMessage>}
      {saved && <div className="tr-gloss__result" role="status">
        <p>{ui('术语表已保存。')}</p>
        {saved.affected.count > 0 ? <>
          <p>{uiFormat('有 {0} 段已有的译文用到了这些词，可能和新术语不一致。不会自动重译，由你决定。', [saved.affected.count])}</p>
          {estimate && <TokenEstimateView state={{ status: 'ready', estimate }} />}
          <Button size="sm" variant="secondary" busy={busy} onClick={again}>{uiFormat('重新翻译这 {0} 段', [saved.affected.count])}</Button>
        </> : <p className="muted">{ui('已有的译文都不受影响。')}</p>}
      </div>}
    </div>
  </Dialog>;
}
