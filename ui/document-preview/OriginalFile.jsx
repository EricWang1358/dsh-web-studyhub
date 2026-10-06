import React, { useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ui, uiFormat } from '../i18n.js';
import { useInjectCss } from '../shared.js';
import { Button, Checkbox, Dialog, FileDrop, Hint, Icon, InlineMessage, LoadingState, RadioCard, RadioCardGroup } from '../components/index.js';
import css from './original-file.css';
import { ORIGINAL_MAX_BYTES, canAttach, collapseNotice, defaultMode, explainFailure, issueOf, modeOptions, noticeCollapsed, originalLine, reportHeadline, reportLines } from './original-file.js';
import { formatBytes } from '../format.js';
import { toBase64 } from '../upload.js';
import { isAbsolutePath, unquotePath } from '../paths.js';
import { baseName } from '../file-names.js';
import { useStudy } from '../study-context.jsx';
import { useLiveEffect } from '../use-async.js';

/* 补全原文件: attach the ORIGINAL file to a document that only kept its text, by reference (the path is remembered, nothing
   is copied) or as a copy in the library. The host verifies the file against the stored text first (no model); nothing about
   the text, the revision, the citations or the card links changes. Three entry points share this one dialog: the reader's
   notice (and its disabled 原始 PDF tab), and the 资料 row menu. */

const readBase64 = async blob => { try { return await toBase64(blob); } catch { throw new Error(ui('读取文件失败，请重试。')); } };
const identityOf = target => target.documentId ? { documentId: target.documentId, ...(target.revision ? { revision: target.revision } : {}) } : { sourceId: target.sourceId };

/** The reader's explanation when a document has no (usable) original, with the buttons that fix it. onAction('attach' | 'relink' | 'copy').
    A text-only document's notice has a ×: closing it folds the notice into ONE quiet line that keeps 补全原文件… (remembered per document in this browser), so nothing is lost by closing it;
    `collapsed` / `onCollapse` let a caller (or a test) own that state. A reference that went missing or changed is a fault to fix and has no ×. */
export function OriginalNotice({ document, onAction, collapsed, onCollapse }) {
  useInjectCss(css, 'study-original-file');
  const [closedHere, setClosedHere] = useState(() => new Set());
  if (!document || document.originalAvailable) return null;
  const issue = issueOf(document.original);
  if (!issue) return null;
  const id = String(document.documentId || document.id || '');
  const closed = collapsed ?? (closedHere.has(id) || noticeCollapsed(id));
  const close = () => { collapseNotice(id); setClosedHere(previous => new Set(previous).add(id)); onCollapse?.(id); };
  if (issue.kind === 'none' && closed) return <p className="original-quiet" data-kind="none" data-collapsed="true">
    <Icon name="info" size={16} />
    <span>{ui('这份资料没有原文件。')}</span>
    <Button size="sm" variant="quiet" icon="file" onClick={() => onAction?.('attach')}>{ui('补全原文件…')}</Button>
  </p>;
  if (issue.kind === 'none') return <InlineMessage tone="info" boxed data-kind="none" onDismiss={close} dismissText={ui('收起，之后在这里仍可补全原文件')}>
    <p>{document.format === 'pdf'
      ? ui('这份资料只保存了提取出的文字，没有原文件，所以「原始 PDF」打不开。提问、补题和查看引用仍然可用。')
      : ui('这份资料只保存了提取出的文字，没有原文件。提问、补题和查看引用仍然可用。')}</p>
    <p>{ui('补上原文件有两种办法：指给它文件的位置（只记路径，不占空间），或复制一份进资料库。已保存的文字、引用和题目不会变。')}</p>
    <div className="original-notice__actions"><Button size="sm" variant="secondary" icon="file" onClick={() => onAction?.('attach')}>{ui('补全原文件…')}</Button></div>
  </InlineMessage>;
  return <InlineMessage tone="warning" boxed data-kind={issue.kind}>
    <p>{issue.message}</p>
    <div className="original-notice__actions">
      <Button size="sm" variant="secondary" onClick={() => onAction?.('relink')}>{ui('重新指定…')}</Button>
      {issue.canCopy && <Button size="sm" variant="quiet" onClick={() => onAction?.('copy')}>{ui('改为复制到资料库')}</Button>}
    </div>
  </InlineMessage>;
}

function Status({ tone, children, alert = false }) {
  return <div className="original-status" data-tone={tone} role={alert ? 'alert' : 'status'}>
    <Icon name={tone === 'success' || tone === 'warning' ? tone : 'info'} size={18} /><div>{children}</div>
  </div>;
}

/**
 * The dialog. target: { sourceId | documentId (+ revision), title, format }. intent: 'attach' | 'relink' | 'copy' (what the
 * learner clicked). initial seeds the state (tests and previews). onChanged(result) after an attach or a detach.
 * host.pickFile?.({ extensions }) -> { path, size? } is used when the host offers a native file dialog.
 */
export function OriginalDialog({ target, call, host, onClose, onChanged, intent = 'attach', initial = {} }) {
  useInjectCss(css, 'study-original-file');
  const [info, setInfo] = useState(initial.info ?? null), [picked, setPicked] = useState(initial.picked ?? null);
  const [phase, setPhase] = useState(initial.phase ?? 'idle'), [report, setReport] = useState(initial.report ?? null);
  const [mode, setMode] = useState(initial.mode ?? 'reference'), [confirmed, setConfirmed] = useState(initial.confirmed ?? false);
  const [error, setError] = useState(initial.error ?? ''), [pathText, setPathText] = useState(initial.pathText ?? '');
  const [done, setDone] = useState(initial.done ?? null), [choosing, setChoosing] = useState(initial.choosing ?? intent === 'relink');
  const bytes = useRef(null), alive = useRef(true), pathId = useId(), modeName = useId(), hintId = useId();
  const identity = identityOf(target);
  useEffect(() => () => { alive.current = false; }, []);
  useLiveEffect(live => {
    if (info || !call) return;
    Promise.resolve(call('materials.original.status', identity)).then(value => { if (live()) setInfo(value); }, failure => { if (live()) { setError(failure?.message || ''); setInfo({ mode: null, status: 'none' }); } });
  }, []);
  useEffect(() => { if (intent === 'copy' && info?.path && !picked) void checkPath(info.path, 'copy'); }, [info?.path]); // eslint-disable-line react-hooks/exhaustive-deps

  const issue = info ? issueOf(info) : null;
  const pickerOn = !!info && !done && (issue !== null || choosing);
  const busy = phase === 'verifying' || phase === 'attaching';
  const format = target.format || info?.format || 'pdf';
  const settle = (next, value) => { if (alive.current) next(value); };

  async function verify(source, size) {
    setError(''); setConfirmed(false); setReport(null); setPhase('verifying');
    try {
      const result = await call('materials.original.probe', source.args);
      if (!alive.current) return;
      setReport(result);
      setPicked({ ...source.picked, size: result.bytes ?? size });
      setMode(defaultMode({ hasPath: source.picked.kind === 'path' }));
      setPhase('verified');
    } catch (failure) { settle(setError, failure?.message || ''); settle(setPhase, 'error'); }
  }
  async function checkPath(raw, preferred) {
    const path = unquotePath(raw);
    if (!path) return;
    setPathText(path);
    if (!isAbsolutePath(path)) { setError('Document path must be absolute'); setPhase('error'); return; }
    bytes.current = null;
    setPicked({ kind: 'path', path }); setPhase('verifying');
    await verify({ args: { ...identity, path }, picked: { kind: 'path', path } });
    if (preferred && alive.current) setMode(preferred);
  }
  async function chooseFile(files) {
    const file = files?.[0];
    if (!file) return;
    setPicked({ kind: 'file', name: file.name, size: file.size }); setPhase('verifying'); setPathText('');
    try {
      bytes.current = { dataBase64: await readBase64(file), filename: file.name };
      await verify({ args: { ...identity, ...bytes.current }, picked: { kind: 'file', name: file.name, size: file.size } }, file.size);
    } catch (failure) { settle(setError, failure?.message || ''); settle(setPhase, 'error'); }
  }
  async function pickNative() {
    try {
      const chosen = await host.pickFile({ extensions: [format] });
      const path = typeof chosen === 'string' ? chosen : chosen?.path;
      if (path) await checkPath(path);
    } catch { setError(ui('无法打开文件选择器，请直接填写路径。')); setPhase('error'); }
  }
  async function attach() {
    if (!canAttach({ phase, report, picked, mode, confirmed })) return;
    setPhase('attaching'); setError('');
    try {
      const result = await call('materials.original.attach', { ...identity, mode, ...(picked.kind === 'path' ? { path: picked.path } : bytes.current), ...(!report.accepted ? { confirm: true } : {}) });
      if (!alive.current) return;
      if (result.status !== 'attached') { setPhase('verified'); return; }
      setInfo(result.original); setDone({ mode: result.mode }); setPhase('done'); setChoosing(false);
      onChanged?.(result);
    } catch (failure) { settle(setError, failure?.message || ''); settle(setPhase, 'verified'); }
  }
  async function detach() {
    setPhase('attaching'); setError('');
    try {
      await call('materials.original.detach', identity);
      if (!alive.current) return;
      setInfo({ mode: null, status: 'none' }); setPhase('idle'); setPicked(null); setChoosing(false);
      onChanged?.({ status: 'detached' });
    } catch (failure) { settle(setError, failure?.message || ''); settle(setPhase, 'idle'); }
  }

  const title = info && info.status !== 'none' ? uiFormat('原文件：{0}', [target.title]) : uiFormat('补全原文件：{0}', [target.title]);
  const options = picked ? modeOptions({ size: picked.size, hasPath: picked.kind === 'path' }) : [];
  const headline = report && reportHeadline(report), lines = report ? reportLines(report) : [];
  const footer = done ? <Button variant="primary" onClick={onClose}>{ui('完成')}</Button>
    : <><Button variant="quiet" disabled={phase === 'attaching'} onClick={onClose}>{ui('取消')}</Button>
      {picked && <Button variant="primary" busy={phase === 'attaching'} disabled={!canAttach({ phase, report, picked, mode, confirmed })} onClick={attach}>{ui('附上原文件')}</Button>}
      {!picked && pickerOn && <Button variant="primary" disabled>{ui('附上原文件')}</Button>}</>;

  return <Dialog size="md" className="original-dialog" title={title} busy={phase === 'attaching'} guardDrops onClose={onClose} footer={footer}>
    {!info && <LoadingState label={ui('正在读取原文件状态…')} />}
    {info && info.status === 'none' && !done && <p>{ui('这份资料只保存了提取出的文字，没有原文件。提问、补题和查看引用仍然可用；补上原文件后，还能对照原版排版和图表。已保存的文字、引用和题目不会变。')}</p>}
    {done && <Status tone="success"><strong>{ui('已附上原文件')}</strong>{done.mode === 'reference' ? <span title={info?.path}>{uiFormat('引用 {0}', [info?.path])}</span> : <span>{uiFormat('已复制到资料库 · {0}', [formatBytes(info?.bytes)])}</span>}</Status>}
    {!done && !report && issue?.message && <Status tone="warning" alert>{issue.message}</Status>}
    {!done && info && !issue && !choosing && <>
      <Status tone="success"><span title={info.path}>{info.mode === 'copy' ? uiFormat('原文件已经复制在资料库里（{0}），不受原文件移动影响。', [formatBytes(info.bytes)]) : uiFormat('原文件：引用 {0}', [info.path])}</span></Status>
      {info.mode === 'reference' && <div className="original-actions">
        <Button size="sm" variant="secondary" disabled={busy} onClick={() => setChoosing(true)}>{ui('重新指定…')}</Button>
        <Button size="sm" variant="secondary" disabled={busy} onClick={() => { setChoosing(true); void checkPath(info.path, 'copy'); }}>{ui('改为复制到资料库')}</Button>
        <Button size="sm" variant="quiet" disabled={busy} onClick={detach}>{ui('不再引用')}</Button>
      </div>}
    </>}
    {issue?.canCopy && !picked && !done && <div className="original-actions">
      <Button size="sm" variant="secondary" disabled={busy} onClick={() => checkPath(info.path, 'copy')}>{ui('改为复制到资料库')}</Button></div>}
    {pickerOn && <section className="original-pick" aria-label={ui('选择原文件')}>
      <p className="original-step"><strong>{ui('原文件在哪里？')}</strong> <span id={hintId} className="muted">{ui('填写完整路径，或选择文件。')}</span></p>
      <div className="original-pathrow">
        <input id={pathId} type="text" value={pathText} disabled={busy} spellCheck={false} aria-label={ui('原文件的完整路径')} aria-describedby={hintId}
          placeholder={ui('例如：D:\\资料\\讲义.pdf')} onChange={event => setPathText(event.target.value)}
          onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); void checkPath(pathText); } }} />
        <Button disabled={busy || !pathText.trim()} onClick={() => checkPath(pathText)}>{ui('核对')}</Button>
      </div>
      {host?.pickFile && <div className="original-actions"><Button icon="folder" disabled={busy} onClick={pickNative}>{ui('选择文件…')}</Button></div>}
      <FileDrop compact accept={[`.${format}`]} maxBytes={ORIGINAL_MAX_BYTES} disabled={busy}
        label={ui('或把文件拖到这里（浏览器不提供路径，只能复制）')} buttonLabel={host?.pickFile ? ui('从浏览器选择…') : ui('选择文件…')}
        onFiles={accepted => void chooseFile(accepted)} />
    </section>}
    {phase === 'verifying' && <Status tone="info">{uiFormat('正在核对文字…{0}', [picked?.size ? `（${formatBytes(picked.size)}）` : ''])} <span className="muted">{ui('大文件需要一点时间。')}</span></Status>}
    {report && phase !== 'verifying' && !done && <>
      <Status tone={headline.tone} alert={headline.tone === 'warning'}>
        <strong>{headline.text}</strong>
        {picked && <small className="original-file-name" title={picked.path}>{picked.kind === 'path' ? baseName(picked.path) : picked.name}{picked.size ? ` · ${formatBytes(picked.size)}` : ''}</small>}
        {lines.length > 0 && <ul className="original-lines">{lines.map((item, index) => <li key={index} data-tone={item.tone}>{item.text}</li>)}</ul>}
      </Status>
      <RadioCardGroup className="original-modes" legend={ui('怎样保存这个文件')} disabled={phase === 'attaching'}>
        {options.map(option => <RadioCard key={option.value} name={modeName} value={option.value} checked={mode === option.value} disabled={option.disabled}
          onSelect={setMode} title={option.label} hint={option.detail}>
          {option.note && <Hint as="span">{option.note}</Hint>}
        </RadioCard>)}
      </RadioCardGroup>
      {!report.accepted && <Checkbox checked={confirmed} onChange={setConfirmed} label={ui('我确认这是同一份资料，仍要附上')} />}
    </>}
    {error && <Status tone="warning" alert>{explainFailure(error)}</Status>}
  </Dialog>;
}

/**
 * The 资料 row's menu entry: a one-line status and one button that opens the dialog. The status is read when the menu opens.
 * item: a grouped document (sourceIds, format, title). `initial` seeds the status (tests).
 */
export function OriginalMenuEntry({ item, host, initial }) {
  const { call, busy } = useStudy();
  useInjectCss(css, 'study-original-file');
  const [info, setInfo] = useState(initial ?? null), [portal, setPortal] = useState(null), anchor = useRef(null);
  const sourceId = item?.sourceIds?.[0];
  useLiveEffect(live => {
    const details = anchor.current?.closest('details');
    if (!details || !call || !sourceId) return undefined;
    const load = () => { if (details.open) Promise.resolve(call('materials.original.status', { sourceId })).then(value => { if (live()) setInfo(value); }, () => {}); };
    details.addEventListener('toggle', load);
    return () => details.removeEventListener('toggle', load);
  }, [call, sourceId]);
  if (!call || !sourceId || item.format === 'audio') return null;
  const line = info ? originalLine(info) : null;
  const open = event => {
    event.currentTarget.closest('details')?.removeAttribute('open');
    setPortal(event.currentTarget.closest('.study-app, .study-seat') || document.body);
  };
  return <>
    {line && <small className="source-row-menu__note" data-tone={line.tone} title={line.title}>{line.text}</small>}
    <Button ref={anchor} variant="quiet" size="sm" busy={busy} onClick={open}>{info && info.status !== 'none' ? ui('管理原文件…') : ui('补全原文件…')}</Button>
    {portal && createPortal(<OriginalDialog target={{ sourceId, title: item.title, format: item.format }} call={call} host={host} intent="attach"
      onClose={() => setPortal(null)} onChanged={() => Promise.resolve(call('materials.original.status', { sourceId })).then(setInfo, () => {})} />, portal)}
  </>;
}
