import React, { useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { ui, uiFormat, uiMessage, errorMessage } from './i18n.js';
import { Button, ConfirmDialog, Dialog, Hint, InlineMessage, LoadingState, NumberInput, SegmentedControl, TextArea, Tooltip } from './components/index.js';
import { AppContext } from './app/app-context.js';
import { useStudy } from './study-context.jsx';
import { useInjectCss } from './shared.js';
import css from './mineru.css';

/* 导入前先让我改 (issue #54): the text of a conversion that stopped before the import. A book is thousands of blocks, so a screenful at a time, in the book's order or
   the longest first (a run of junk is usually the longest thing there). Every change is kept on disk when the learner leaves the block; 导入 is the one press that lets the text
   into the library. One dialog, opened from the card on the page and from the 任务 console. What is already in the library is not touched from here, ever. */

const SCREEN = 20, NONE = Object.freeze([]);
export const HELD_ENTRY = () => ui('修改并导入');

/** Which blocks show, in which order: pure, so a thousand-page book only ever draws a screenful. */
export function blocksInOrder(blocks, order) {
  return order === 'longest' ? [...blocks].sort((a, b) => b.text.length - a.text.length || a.index - b.index) : blocks;
}

function Block({ block, value, removed, onChange, onLeave, onRemove, onRestore }) {
  const label = uiFormat('第 {0} 页', [block.page]);
  return (
    <li className={`convert-edit__block${removed ? ' is-removed' : ''}`} data-block={block.index}>
      <div className="convert-edit__meta">
        <small>{label}</small>
        {removed
          ? <Button variant="link" size="sm" onClick={onRestore}>{ui('恢复这一块')}</Button>
          : <Button variant="link" size="sm" aria-label={uiFormat('删除这一块：{0}', [label])} onClick={onRemove}>{ui('删除这一块')}</Button>}
      </div>
      {removed ? <p className="convert-edit__gone">{block.text}</p>
        : block.editable ? <TextArea className="convert-edit__text" rows={Math.min(8, Math.max(2, Math.ceil(value.length / 70)))} aria-label={uiFormat('修改这一块：{0}', [label])} value={value} onChange={event => onChange(event.target.value)} onBlur={onLeave} />
          : <pre className="convert-edit__fixed">{block.text}</pre>}
    </li>
  );
}

/** Props: job (the conversion, waiting), onClose(), onChanged() (the job moved on, or was let go). */
export function ConvertEditDialog({ job, onClose, onChanged }) {
  useInjectCss(css, 'study-mineru');
  const { call: send, notify } = useStudy();
  const [book, setBook] = useState(null), [edits, setEdits] = useState({}), [saved, setSaved] = useState({ chars: 0, tokens: 0 });
  const [order, setOrder] = useState('book'), [at, setAt] = useState(0);
  const [problem, setProblem] = useState(job.held?.problem ? uiMessage(job.held.problem) : ''), [busy, setBusy] = useState(false), [letGo, setLetGo] = useState(false);
  // What changed since the last save: only that is sent, so another window's edits are not overwritten. `restore`: blocks put back.
  const alive = useRef(true), pending = useRef({ edits: {}, restore: [] }), queue = useRef(Promise.resolve());
  const hasPending = () => Object.keys(pending.current.edits).length > 0 || pending.current.restore.length > 0;
  const [archived, setArchived] = useState(false);

  const read = () => Promise.resolve(send('mineru.edit.read', { jobId: job.id })).then(view => {
    if (!alive.current) return;
    if (view?.archived) { setArchived(true); return; }
    setArchived(false); setBook(view); setEdits(view.edits || {}); setSaved(view.saved || { chars: 0, tokens: 0 });
  }, error => { if (alive.current) setProblem(errorMessage(error)); });
  useEffect(() => {
    alive.current = true;
    void read();
    return () => { alive.current = false; };
  }, [job.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const unarchive = async () => {
    setBusy(true); setProblem('');
    try { await send('job.unarchive', { jobId: job.id }); onChanged?.(); await read(); }
    catch (error) { if (alive.current) setProblem(errorMessage(error)); } finally { if (alive.current) setBusy(false); }
  };

  /* What changed, one write at a time. A write that fails puts its changes back in line for the next, and says so: in the dialog, or as a notice once it has closed. */
  const keep = useCallback(() => {
    const sending = pending.current;
    pending.current = { edits: {}, restore: [] };
    queue.current = queue.current.then(() => send('mineru.edit.save', { jobId: job.id, edits: sending.edits, restore: sending.restore })).then(answer => {
      if (!alive.current || !answer?.saved) return;
      setSaved(answer.saved); setProblem('');
      // What another window kept shows here too; a block being typed in stays as typed.
      setEdits(current => { const next = { ...answer.edits }; for (const index of Object.keys(pending.current.edits)) next[index] = current[index]; return next; });
    }, error => {
      pending.current = { edits: { ...sending.edits, ...pending.current.edits }, restore: [...sending.restore, ...pending.current.restore] };
      const text = errorMessage(error);
      if (alive.current) setProblem(text); else notify({ text: uiFormat('没能保存刚才的修改：{0}', [text]), tone: 'error' });
    });
    return queue.current;
  }, [job.id, send, notify]);
  // Escape closes the dialog without the block losing focus first: what was typed is kept all the same.
  useEffect(() => () => { if (hasPending()) void keep(); }, [keep]);

  const note = (index, value) => { pending.current.edits[index] = value; pending.current.restore = pending.current.restore.filter(item => item !== index); };
  const change = (index, value) => { note(index, value); setEdits(current => ({ ...current, [index]: value })); };
  const leave = () => { if (hasPending()) void keep(); };
  const remove = index => { note(index, null); setEdits(current => ({ ...current, [index]: null })); void keep(); };
  const restore = index => {
    delete pending.current.edits[index];
    pending.current.restore.push(index);
    setEdits(current => { const next = { ...current }; delete next[index]; return next; });
    void keep();
  };

  const importText = async () => {
    if (busy) return;
    setBusy(true); setProblem('');
    try {
      await queue.current;
      const last = pending.current;
      await send('mineru.edit.import', { jobId: job.id, edits: last.edits, restore: last.restore });
      pending.current = { edits: {}, restore: [] };
      onChanged?.(); onClose?.();
    } catch (error) { if (alive.current) setProblem(errorMessage(error)); } finally { if (alive.current) setBusy(false); }
  };

  const all = book?.blocks ?? NONE;
  const ordered = useMemo(() => blocksInOrder(all, order), [all, order]);
  const shown = ordered.slice(at, at + SCREEN), first = ordered.length ? at + 1 : 0, last = Math.min(at + SCREEN, ordered.length);
  const toPage = value => { const page = Number(value), found = all.findIndex(block => block.page >= page); if (order === 'book' && page > 0 && found >= 0) setAt(Math.floor(found / SCREEN) * SCREEN); };
  const pager = all.length > SCREEN && <div className="convert-edit__pager">
    <Button size="sm" variant="quiet" disabled={at === 0} onClick={() => setAt(Math.max(0, at - SCREEN))}>{ui('上一屏')}</Button>
    <small>{uiFormat('第 {0}–{1} 块，共 {2} 块', [first, last, ordered.length])}</small>
    <Button size="sm" variant="quiet" disabled={last >= ordered.length} onClick={() => setAt(at + SCREEN)}>{ui('下一屏')}</Button>
  </div>;
  const removedLine = saved.chars > 0 ? uiFormat('已去掉 {0} 字，约 {1} tokens', [saved.chars, saved.tokens]) : ui('还没有去掉文字');
  const footer = <div className="convert-edit__foot">
    <Button variant="quiet" disabled={busy || !book} onClick={() => setLetGo(true)}>{ui('放弃这份文字')}</Button>
    <Tooltip layer content={ui('把现在这份文字存为资料，之后出题和引用都按它来。已经导入的资料不会变。')}>
      <Button variant="primary" busy={busy} disabled={!book} onClick={importText}>{ui('导入')}</Button>
    </Tooltip>
  </div>;
  // The history can sit inside another dialog (添加资料), and React carries a dialog's cancel and close up its tree: Escape here closes only this one.
  const own = event => event.stopPropagation();
  return <div style={{ display: 'contents' }} onCancel={own} onClose={own}>
    <Dialog size="lg" title={uiFormat('修改「{0}」的文字', [book?.filename ?? job.filename ?? ''])} description={ui('删掉或改掉识别错的文字，它们就不会占用模型的输入。页码和结构不变。')} busy={busy} footer={footer} onClose={onClose} guardDrops>
      <div className="convert-edit" data-convert-edit>
        {problem && <InlineMessage tone="error">{problem}</InlineMessage>}
        {archived && <InlineMessage tone="info">{ui('这个任务已归档，是只读记录；取消归档后才能修改。')}
          <Button variant="link" size="sm" disabled={busy} data-held-unarchive onClick={unarchive}>{ui('取消归档')}</Button></InlineMessage>}
        {!book && !problem && !archived && <LoadingState label={ui('正在读取转换好的文字…')} />}
        {book && <>
          <div className="convert-edit__bar">
            <SegmentedControl label={ui('排列方式')} value={order} onChange={value => { setOrder(value); setAt(0); }} options={[{ value: 'book', label: ui('按页码') }, { value: 'longest', label: ui('最长的在前') }]} />
            {order === 'book' && <label className="convert-edit__jump"><small>{ui('跳到第几页')}</small><NumberInput className="convert-edit__page" min={1} max={book.pages} onChange={event => toPage(event.target.value)} /></label>}
            <small role="status" data-removed-line>{removedLine}</small>
          </div>
          {!all.length && <Hint>{ui('这份转换结果里没有文字。')}</Hint>}
          <ol className="convert-edit__list">
            {shown.map(block => {
              const edit = edits[block.index], removed = edit === null;
              return <Block key={block.index} block={block} removed={removed} value={typeof edit === 'string' ? edit : block.text}
                onChange={value => change(block.index, value)} onLeave={leave} onRemove={() => remove(block.index)} onRestore={() => restore(block.index)} />;
            })}
          </ol>
          {pager}
        </>}
      </div>
    </Dialog>
    {letGo && <ConfirmDialog title={ui('放弃这份文字？')} confirmLabel={ui('放弃')} onClose={() => setLetGo(false)} onDone={() => { onChanged?.(); onClose?.(); }}
      onConfirm={async () => { pending.current = { edits: {}, restore: [] }; await queue.current; await send('job.delete', { jobIds: [job.id] }); }}>
      {ui('转换好的文字和你改过的地方都会丢掉，什么也不会存为资料。已解析好的段落从解析完起保留 7 天，这期间再选同一份 PDF 不用重新解析；过了就要重新解析。')}
    </ConfirmDialog>}
  </div>;
}

/** The entry in the 任务 console's 转换详情: the same dialog the card opens. */
export function HeldEntry({ job, onChanged }) {
  const [open, setOpen] = useState(false), app = useContext(AppContext);
  return <div className="pdf-held" data-held-entry>
    {job.held?.problem && <InlineMessage tone="error">{uiFormat('上次没能导入：{0}', [uiMessage(job.held.problem)])}</InlineMessage>}
    <Hint as="p">{ui('还没有存为资料。改完后点「导入」；这之前它不会占用模型的输入，也不会被出题用到。')}</Hint>
    <Button variant="primary" size="sm" onClick={() => setOpen(true)}>{HELD_ENTRY()}</Button>
    {open && <ConvertEditDialog job={job} onClose={() => setOpen(false)} onChanged={onChanged || (() => { void app?.core?.refresh?.(); })} />}
  </div>;
}
