import { ui, uiFormat } from '../i18n.js';
import React, { useId, useRef, useState } from 'react';
import Markdown from '../Markdown.jsx';
import { Button, Dialog, Icon, IconButton, InlineMessage, SegmentedControl } from '../components/index.js';
import { CHECKLIST_MAX_ITEMS, CHECKLIST_MAX_TEXT, checklistProgress, dueState, isMeaningfulTitle, labelHue } from '../../lib/board-model.js';
import BIcon from './icons.jsx';
import { dueText, stamp, studyRefLabel } from './meta.js';

const newItemId = () => `i${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
const sameList = (a, b) => JSON.stringify(a || []) === JSON.stringify(b || []);

const fromCard = (card) => ({ title: card.title, note: card.note || '', due: card.due || '', labels: [...(card.labels || [])],
  checklist: (card.checklist || []).map((item) => ({ ...item })) });

/**
 * Card detail: title, Markdown note (write / preview), due date, labels with
 * suggestions, checklist, the study link and origin, times, and the archive /
 * delete actions. `baseRevision` is the board revision the editor was opened
 * at; a newer board turns saving off until the learner loads the latest card.
 */
export default function CardEditor({ card, board, baseRevision, library, today, labelSuggestions = [], saving = false, error = '', conflict = false,
  onSave, onArchive, onDelete, onClose, onOrigin, onStudyRef }) {
  const formId = useId();
  const [draft, setDraft] = useState(() => fromCard(card));
  const [base, setBase] = useState(baseRevision ?? board.revision);
  const [tab, setTab] = useState('write');
  const [labelInput, setLabelInput] = useState('');
  const [itemInput, setItemInput] = useState('');
  const [confirming, setConfirming] = useState(false);
  const [touched, setTouched] = useState(false);
  const titleField = useRef(null);
  const stale = board.revision !== base;
  const latest = board.cards[card.id];
  const set = (patch) => setDraft((current) => ({ ...current, ...patch }));
  const problem = !isMeaningfulTitle(draft.title) ? ui('请写一个具体的待办，例如「复习第 3 章」。') : '';
  const progress = checklistProgress(draft);
  const state = dueState(draft.due, today, false);
  const link = card.studyRef ? studyRefLabel(card.studyRef, library) : null;
  const readOnly = !!board.readOnly;

  const addLabel = (raw) => {
    const wanted = String(raw).split(/[,，]/).map((label) => label.trim()).filter(Boolean);
    if (wanted.length) set({ labels: [...new Set([...draft.labels, ...wanted])].slice(0, 20) });
    setLabelInput('');
  };
  const addItem = () => {
    const text = itemInput.trim();
    if (!text || draft.checklist.length >= CHECKLIST_MAX_ITEMS) return;
    set({ checklist: [...draft.checklist, { id: newItemId(), text: text.slice(0, CHECKLIST_MAX_TEXT), done: false }] });
    setItemInput('');
  };
  const submit = async (event) => {
    event.preventDefault();
    setTouched(true);
    if (problem || stale || readOnly || saving) return;
    const fields = { title: draft.title.trim(), note: draft.note, due: draft.due, labels: draft.labels };
    const checklist = draft.checklist.filter((item) => item.text.trim()).map((item) => ({ ...item, text: item.text.trim() }));
    if (checklist.length || card.checklist) fields.checklist = checklist;
    if (await onSave(fields)) onClose();
  };
  const dirty = draft.title !== card.title || draft.note !== (card.note || '') || draft.due !== (card.due || '') || !sameList(draft.labels, card.labels) || !sameList(draft.checklist, card.checklist);

  const footer = confirming ? (
    <div className="board-editor__confirm" role="alertdialog" aria-label={ui('确认删除')}>
      <span>{ui('删除这张卡片？删除后会立刻提示，可撤销。')}</span>
      <Button variant="danger" size="sm" icon={<BIcon name="trash" />} disabled={saving || readOnly} onClick={() => onDelete(card)}>{ui('确认删除')}</Button>
      <Button variant="quiet" size="sm" onClick={() => setConfirming(false)}>{ui('保留')}</Button>
    </div>
  ) : (
    <>
      <div className="board-editor__danger">
        <Button variant="quiet" size="sm" icon={<BIcon name="archive" />} disabled={saving || readOnly} onClick={() => onArchive(card)}>{ui('归档')}</Button>
        <Button variant="quiet" size="sm" icon={<BIcon name="trash" />} disabled={saving || readOnly} onClick={() => setConfirming(true)}>{ui('删除')}</Button>
      </div>
      <div className="board-editor__main">
        <Button variant="quiet" onClick={onClose} disabled={saving}>{ui('取消')}</Button>
        <Button type="submit" form={formId} variant="primary" busy={saving} disabled={stale || readOnly || !dirty}>{ui('保存')}</Button>
      </div>
    </>
  );

  return (
    <Dialog title={ui('编辑待办')} size="md" onClose={() => { if (!saving) onClose(); }} footer={footer} initialFocus={titleField} className="board-editor">
      <form id={formId} className="board-editor__form" onSubmit={submit}>
        {error && <InlineMessage tone={conflict ? 'warning' : 'error'}>{error}</InlineMessage>}
        {stale && <InlineMessage tone="warning" boxed action={latest ? { label: ui('载入最新卡片（替换当前输入）'), onClick: () => { setDraft(fromCard(latest)); setBase(board.revision); } } : undefined}>
          {ui('看板已在其他位置更新。你的输入仍保留；请先查看最新卡片再编辑。')}{!latest && <> {ui('这张卡片已被移除或归档。')}</>}
        </InlineMessage>}
        <fieldset className="board-editor__fields" disabled={saving || readOnly}>
          <label className="board-field"><span>{ui('标题')}</span>
            <input ref={titleField} required maxLength={500} value={draft.title} aria-invalid={touched && problem ? 'true' : undefined} onChange={(event) => set({ title: event.target.value })} /></label>
          {touched && problem && <p role="alert" className="board-hint">{problem}</p>}

          <div className="board-field">
            <div className="board-field__bar">
              <span>{ui('备注 · 支持 Markdown')}</span>
              <SegmentedControl size="sm" label={ui('备注模式')} value={tab} onChange={setTab} options={[{ value: 'write', label: ui('编辑') }, { value: 'preview', label: ui('预览') }]} />
            </div>
            {tab === 'write'
              ? <textarea rows={5} maxLength={50000} value={draft.note} aria-label={ui('备注 · 支持 Markdown')} onChange={(event) => set({ note: event.target.value })} />
              : <div className="board-editor__preview">{draft.note.trim() ? <Markdown text={draft.note} /> : <p className="muted">{ui('还没有备注。')}</p>}</div>}
          </div>

          <div className="board-field">
            <span>{ui('截止日期')}</span>
            <div className="board-editor__due">
              <input type="date" aria-label={ui('截止日期')} value={draft.due} onChange={(event) => set({ due: event.target.value })} />
              {draft.due && <IconButton icon="close" size="sm" label={ui('清除截止日期')} onClick={() => set({ due: '' })} />}
              {state && <span className={`board-due is-${state.kind}`}><BIcon name="calendar" size={13} />{dueText(state)}</span>}
            </div>
          </div>

          <div className="board-field">
            <span>{ui('标签')}</span>
            <div className="board-editor__labels">
              {draft.labels.map((label) => <span key={label} className={`board-chip board-hue-${labelHue(label)}`}>{label}
                <button type="button" aria-label={uiFormat('移除标签 {0}', [label])} onClick={() => set({ labels: draft.labels.filter((entry) => entry !== label) })}>×</button></span>)}
              <input value={labelInput} maxLength={60} placeholder={ui('添加标签')} aria-label={ui('添加标签')} onChange={(event) => setLabelInput(event.target.value)}
                onKeyDown={(event) => { if ((event.key === 'Enter' || event.key === ',') && !event.nativeEvent?.isComposing) { event.preventDefault(); addLabel(labelInput); } }}
                onBlur={() => addLabel(labelInput)} />
            </div>
            {labelSuggestions.filter((label) => !draft.labels.includes(label)).length > 0 && <div className="board-editor__suggest" role="group" aria-label={ui('常用标签')}>
              {labelSuggestions.filter((label) => !draft.labels.includes(label)).slice(0, 8).map((label) => <button key={label} type="button" className={`board-chip is-choice board-hue-${labelHue(label)}`}
                onClick={() => addLabel(label)}>+ {label}</button>)}
            </div>}
          </div>

          <div className="board-field">
            <div className="board-field__bar">
              <span>{ui('清单')}</span>
              {progress.total > 0 && <span className="board-progress"><BIcon name="checklist" size={13} />{progress.done}/{progress.total}</span>}
            </div>
            <ul className="board-checklist">
              {draft.checklist.map((item, index) => <li key={item.id} className={item.done ? 'is-done' : ''}>
                <button type="button" role="checkbox" aria-checked={item.done} className="board-check" aria-label={uiFormat(item.done ? '标记为未完成：{0}' : '标记完成：{0}', [item.text])}
                  onClick={() => set({ checklist: draft.checklist.map((entry, at) => at === index ? { ...entry, done: !entry.done } : entry) })}><Icon name="check" size={14} strokeWidth={2.4} /></button>
                <input value={item.text} maxLength={CHECKLIST_MAX_TEXT} aria-label={uiFormat('子项 {0}', [index + 1])}
                  onChange={(event) => set({ checklist: draft.checklist.map((entry, at) => at === index ? { ...entry, text: event.target.value } : entry) })} />
                <IconButton icon="close" size="sm" label={uiFormat('删除子项：{0}', [item.text])} onClick={() => set({ checklist: draft.checklist.filter((_, at) => at !== index) })} />
              </li>)}
            </ul>
            <div className="board-editor__additem">
              <input value={itemInput} maxLength={CHECKLIST_MAX_TEXT} placeholder={ui('添加子项')} aria-label={ui('添加子项')} disabled={draft.checklist.length >= CHECKLIST_MAX_ITEMS}
                onChange={(event) => setItemInput(event.target.value)}
                onKeyDown={(event) => { if (event.key === 'Enter' && !event.nativeEvent?.isComposing) { event.preventDefault(); addItem(); } }} />
              <Button variant="secondary" size="sm" icon="plus" disabled={!itemInput.trim() || draft.checklist.length >= CHECKLIST_MAX_ITEMS} onClick={addItem}>{ui('添加子项')}</Button>
            </div>
          </div>
        </fieldset>

        <div className="board-editor__about">
          {(card.origin?.workspaceTitle || card.origin?.workspace) && (onOrigin && card.origin.workspace
            ? <button type="button" className="board-meta__item" title={card.origin.workspace} onClick={() => onOrigin(card.origin.workspace)}><Icon name="folder" size={13} /><span>{card.origin.workspaceTitle || card.origin.workspace}</span></button>
            : <span className="board-meta__item"><Icon name="folder" size={13} /><span>{card.origin.workspaceTitle || card.origin.workspace}</span></span>)}
          {link && (onStudyRef
            ? <button type="button" className="board-meta__item" title={card.studyRef.root} onClick={() => onStudyRef(card.studyRef)}><BIcon name="link" size={13} /><span>{link.text}</span></button>
            : <span className="board-meta__item"><BIcon name="link" size={13} /><span>{link.text}</span></span>)}
          <span className="board-meta__item"><BIcon name="clock" size={13} /><span>{uiFormat('创建于 {0}', [stamp(card.createdAt)])} · {uiFormat('更新于 {0}', [stamp(card.updatedAt)])}</span></span>
        </div>
      </form>
    </Dialog>
  );
}
