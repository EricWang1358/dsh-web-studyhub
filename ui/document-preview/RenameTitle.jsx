import React, { useEffect, useId, useMemo, useRef, useState } from 'react';
import { ui, uiFormat } from '../i18n.js';
import { useInjectCss } from '../shared.js';
import { Button } from '../components/index.js';
import { groupSourcesByDocument } from '../../lib/source-groups.js';
import { displayTitle } from '../../lib/document-title.js';
import { explainRename, fieldKeyAction, originalNote, renameDocument, startsEditing, validateTitle } from './rename.js';
import css from './rename.css';

/* 资料重命名: one editor for the 资料 row and the reader's header. Enter saves, Esc cancels, the old name is the placeholder, and
   a problem is one plain sentence under the field. 恢复原名 appears only on a document that was renamed. Only the name changes:
   the text, the pages, the citations and the questions stay as they are, and the file name is kept as the original. */

/**
 * The editor. title: the name now; original: what it was called before its first rename (shows 恢复原名). onSave(title) and
 * onRestore() return a promise and throw to show a problem; the owner closes the editor (onCancel) when they resolve.
 * `initial` and `problem` seed the state (tests, previews).
 */
export function RenameField({ title, original = '', onSave, onRestore, onCancel, initial, problem: seeded = '', label, className }) {
  useInjectCss(css, 'study-rename');
  const [value, setValue] = useState(initial ?? title), [problem, setProblem] = useState(seeded), [working, setWorking] = useState(false);
  const input = useRef(null), alive = useRef(true), hintId = useId(), errorId = useId();
  useEffect(() => { input.current?.focus(); input.current?.select(); return () => { alive.current = false; }; }, []);
  async function run(task) {
    setWorking(true); setProblem('');
    try { await task(); }
    catch (failure) { if (alive.current) { setProblem(explainRename(failure)); input.current?.focus(); } }
    finally { if (alive.current) setWorking(false); }
  }
  const save = () => {
    const check = validateTitle(value, title);
    if (!check.ok) { setProblem(check.problem); input.current?.focus(); return; }
    if (check.unchanged) { onCancel?.(); return; }
    void run(() => onSave(check.title));
  };
  return <form className={`rename-field${className ? ` ${className}` : ''}`} noValidate data-state={working ? 'saving' : problem ? 'problem' : 'idle'}
    onSubmit={event => { event.preventDefault(); if (!working) save(); }}
    onKeyDown={event => { if (fieldKeyAction(event) === 'cancel' && !working) { event.preventDefault(); event.stopPropagation(); onCancel?.(); } }}>
    <input ref={input} type="text" className="rename-field__input" value={value} placeholder={title} disabled={working} spellCheck={false} autoComplete="off"
      aria-label={label || ui('新名称')} aria-invalid={problem ? true : undefined} aria-describedby={`${hintId}${problem ? ` ${errorId}` : ''}`}
      onChange={event => { setValue(event.target.value); if (problem) setProblem(''); }} />
    <div className="rename-field__actions">
      <Button type="submit" size="sm" variant="primary" busy={working}>{ui('保存')}</Button>
      <Button size="sm" variant="quiet" disabled={working} onClick={() => onCancel?.()}>{ui('取消')}</Button>
      {original && onRestore && <Button size="sm" variant="quiet" disabled={working} title={uiFormat('原名：{0}', [original])} onClick={() => void run(onRestore)}>{ui('恢复原名')}</Button>}
    </div>
    <small id={hintId} className="rename-field__hint">{ui('Enter 保存，Esc 取消。只改名称，原文、页码、引用和题目都不变。')}</small>
    {problem && <p id={errorId} className="rename-field__error" role="alert">{problem}</p>}
  </form>;
}

/**
 * The title in the reader dialog's header, with a 重命名 button; double-click or F2 on the name also edits it. The name is read
 * from the library (data.sources) so it follows a rename made anywhere; `source` is only the page that was opened.
 * `edit` starts in the editor (tests, previews).
 */
export function ReaderHeading({ data, source, act, call, onRenamed, edit = false }) {
  useInjectCss(css, 'study-rename');
  const item = useMemo(() => groupSourcesByDocument(data?.sources || []).find(group => group.sourceIds.includes(source.id)) || null, [data?.sources, source.id]);
  const [editing, setEditing] = useState(edit), name = useRef(null), wasEditing = useRef(false);
  useEffect(() => { if (wasEditing.current && !editing) name.current?.focus(); wasEditing.current = editing; }, [editing]);
  if (!item) return <>{displayTitle(source.title)}</>;
  const part = item.format === 'audio' && item.pages.length > 1 ? item.pages.find(page => page.sourceId === source.id) : null;
  const shown = displayTitle(item.title), text = part ? `${shown} · ${uiFormat('第 {0} 部分', [part.page])}` : shown;
  const canRename = !!(act || call);
  const done = async task => { const result = await task(); setEditing(false); onRenamed?.(result); };
  if (editing && canRename) return <RenameField title={item.title} original={item.renamedFrom} label={uiFormat('重命名「{0}」', [displayTitle(item.title)])} className="rename-field--header"
    onSave={title => done(() => renameDocument({ act, call }, item, { title }))} onRestore={() => done(() => renameDocument({ act, call }, item, { restore: true }))}
    onCancel={() => setEditing(false)} />;
  return <span className="reader-heading">
    <span ref={name} className="reader-heading__text" title={[text, originalNote(item)].filter(Boolean).join('\n')} tabIndex={canRename ? 0 : undefined} aria-keyshortcuts={canRename ? 'F2' : undefined}
      onDoubleClick={canRename ? () => setEditing(true) : undefined}
      onKeyDown={canRename ? event => { if (startsEditing(event)) { event.preventDefault(); setEditing(true); } } : undefined}>{text}</span>
    {canRename && <Button size="sm" variant="quiet" className="reader-heading__rename" onClick={() => setEditing(true)}>{ui('重命名')}</Button>}
  </span>;
}
