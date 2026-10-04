import { ui, uiFormat } from '../i18n.js';
import React, { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { Button, CloseButton, Icon } from '../components/index.js';
import { isMeaningfulTitle } from '../../lib/board-model.js';
import { studyRefLabel } from './meta.js';

export const TITLE_LIMIT = 500;

/** The first line is the title, anything after it becomes the note. */
export function splitDraft(raw) {
  const text = String(raw).replace(/\r/g, '');
  const at = text.indexOf('\n');
  return at < 0 ? { title: text.trim(), note: '' } : { title: text.slice(0, at).trim(), note: text.slice(at + 1).trim() };
}

/** The reason a draft cannot be added yet, or '' (nothing typed is not an error). */
export function draftProblem(raw) {
  const { title } = splitDraft(raw);
  if (!title && !String(raw).trim()) return '';
  if (!isMeaningfulTitle(title)) return ui('请写一个具体的待办，例如「复习第 3 章」。');
  if (title.length > TITLE_LIMIT) return uiFormat('标题请控制在 {0} 字以内，更多内容写在下一行作为备注。', [TITLE_LIMIT]);
  return '';
}

/**
 * Inline "add card": Enter adds and stays open for the next one, Shift+Enter
 * starts a new line (the note), Escape closes. Due date and labels are
 * optional; a study link shows as a removable chip.
 */
export default function Composer({ columnTitle, studyRef, library, labelSuggestions = [], onSubmit, onClose, onClearStudyRef, initialTitle = '', autoFocus = true }) {
  const [raw, setRaw] = useState(initialTitle);
  const [due, setDue] = useState('');
  const [labels, setLabels] = useState('');
  const [sending, setSending] = useState(false);
  const area = useRef(null), listId = useId(), hintId = useId();
  const problem = draftProblem(raw);
  const { title } = splitDraft(raw);
  const ready = !!title && !problem && !sending;
  // Suggestions complete the label being typed after the last comma.
  const cut = Math.max(labels.lastIndexOf(','), labels.lastIndexOf('，'));
  const prefix = cut >= 0 ? `${labels.slice(0, cut + 1)} ` : '';
  const typed = labels.split(/[,，]/).map((label) => label.trim());

  useLayoutEffect(() => {
    const element = area.current;
    if (!element) return;
    element.style.height = 'auto';
    element.style.height = `${Math.min(element.scrollHeight, 220)}px`;
  }, [raw]);
  useEffect(() => { if (autoFocus) area.current?.focus(); }, [autoFocus]);

  const submit = async () => {
    if (!ready) return;
    setSending(true);
    const parts = splitDraft(raw);
    const ok = await onSubmit({ ...parts, due, labels: labels.split(/[,，]/).map((label) => label.trim()).filter(Boolean) });
    setSending(false);
    if (ok) { setRaw(''); area.current?.focus(); }
  };
  const link = studyRef ? studyRefLabel(studyRef, library) : null;
  return (
    <form className="board-composer" aria-label={uiFormat('添加卡片到{0}', [columnTitle])} onSubmit={(event) => { event.preventDefault(); submit(); }}
      onKeyDown={(event) => { if (event.key === 'Escape') { event.stopPropagation(); onClose(); } }}>
      <textarea ref={area} rows={1} value={raw} maxLength={5000} placeholder={ui('想做什么？')} aria-label={uiFormat('{0}卡片标题', [columnTitle])}
        aria-invalid={problem ? 'true' : undefined} aria-describedby={problem ? hintId : undefined} className="board-composer__title"
        onChange={(event) => setRaw(event.target.value)}
        onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent?.isComposing) { event.preventDefault(); submit(); } }} />
      {problem && <p id={hintId} role="alert" className="board-hint">{problem}</p>}
      {link && <span className="board-study-chip">
        <Icon name="link" size={13} />
        <span className="board-study-chip__text" title={studyRef.root}>{uiFormat('关联：{0}', [link.text])}</span>
        <CloseButton className="board-study-chip__remove" label={ui('取消关联')} onClick={onClearStudyRef} />
      </span>}
      <div className="board-composer__fields">
        <label className="board-field"><span>{ui('截止日期')}</span><input type="date" value={due} onChange={(event) => setDue(event.target.value)} /></label>
        <label className="board-field"><span>{ui('标签')}</span>
          <input list={listId} value={labels} maxLength={500} placeholder={ui('用逗号分隔')} onChange={(event) => setLabels(event.target.value)} /></label>
        <datalist id={listId}>{labelSuggestions.filter((label) => !typed.includes(label)).map((label) => <option key={label} value={`${prefix}${label}`} />)}</datalist>
      </div>
      <div className="board-composer__actions">
        <Button type="submit" variant="primary" size="sm" disabled={!ready} busy={sending}>{ui('添加')}</Button>
        <CloseButton onClick={onClose} />
      </div>
    </form>
  );
}
