import React, { useLayoutEffect, useMemo, useRef, useState } from 'react';
import { ui, uiFormat } from '../i18n.js';
import { formatDay } from '../format.js';
import { Button, Icon, IconButton } from '../components/index.js';
import { isMeaningfulTitle, memoBody, selectTodayMemos, splitMemoDraft } from '../../lib/board-model.js';

const guessLongMemo = (text) => text.length > 140 || text.split('\n').length > 4;

function MemoText({ text }) {
  const [expanded, setExpanded] = useState(false);
  const [long, setLong] = useState(() => guessLongMemo(text));
  const boxRef = useRef(null);

  useLayoutEffect(() => {
    const el = boxRef.current;
    if (!el || expanded) return;
    setLong(el.scrollHeight > el.clientHeight + 1);
  }, [text, expanded]);

  return (
    <div className="board-memo__body-wrap">
      <p ref={boxRef} className="board-memo__text" data-collapsed={expanded ? 'false' : 'true'}>
        {text}
      </p>
      {(long || expanded) && (
        <Button
          variant="link"
          size="sm"
          className="board-memo__toggle"
          aria-expanded={expanded}
          onClick={() => setExpanded((prev) => !prev)}
        >
          {expanded ? ui('收起') : ui('展开')}
        </Button>
      )}
    </div>
  );
}

export default function TodayMemos({
  board, today, readOnly = false, onAddMemo, onEditMemo, onArchiveMemo, onDeleteMemo,
}) {
  const [composing, setComposing] = useState(false);
  const [draftText, setDraftText] = useState('');
  const [draftDate, setDraftDate] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const [editingId, setEditingId] = useState('');
  const [editText, setEditText] = useState('');
  const [editDate, setEditDate] = useState('');
  const [savingEdit, setSavingEdit] = useState(false);

  const composerAreaRef = useRef(null);

  const memos = useMemo(
    () => selectTodayMemos(board, { today }),
    [board, today],
  );

  const openComposer = () => {
    if (readOnly) return;
    setEditingId('');
    setComposing(true);
    requestAnimationFrame(() => composerAreaRef.current?.focus());
  };

  const closeComposer = () => {
    setComposing(false);
    setDraftText('');
    setDraftDate('');
  };

  const draftParts = splitMemoDraft(draftText);
  const draftValid = isMeaningfulTitle(draftParts.title);

  const submitNew = async (event) => {
    event?.preventDefault();
    if (readOnly || submitting || !draftValid || !onAddMemo) return;
    setSubmitting(true);
    try {
      const ok = await onAddMemo({
        title: draftParts.title,
        note: draftParts.note,
        plannedDate: draftDate || '',
      });
      if (ok) closeComposer();
    } finally {
      setSubmitting(false);
    }
  };

  const startEdit = (memo) => {
    setComposing(false);
    setEditingId(memo.id);
    setEditText(memoBody(memo));
    setEditDate(memo.plannedDate || '');
  };

  const editParts = splitMemoDraft(editText);
  const editValid = isMeaningfulTitle(editParts.title);

  const submitEdit = async (event, memo) => {
    event?.preventDefault();
    if (readOnly || savingEdit || !editValid || !onEditMemo) return;
    setSavingEdit(true);
    try {
      const ok = await onEditMemo(memo, {
        title: editParts.title,
        note: editParts.note,
        plannedDate: editDate || '',
      });
      if (ok) setEditingId('');
    } finally {
      setSavingEdit(false);
    }
  };

  return (
    <section className="board-memos" aria-label={ui('备忘')}>
      <header className="board-memos__head">
        <div className="board-memos__heading">
          <h3 className="board-memos__title">{ui('备忘')}</h3>
          {memos.length > 0 && <span className="board-count">{memos.length}</span>}
        </div>
        {!readOnly && (
          <Button
            variant="quiet"
            size="sm"
            icon="plus"
            aria-expanded={composing}
            onClick={() => (composing ? closeComposer() : openComposer())}
          >
            {ui('新备忘')}
          </Button>
        )}
      </header>

      {composing && !readOnly && (
        <form className="board-memos__form" onSubmit={submitNew} aria-label={ui('新备忘')}>
          <textarea
            ref={composerAreaRef}
            rows={3}
            maxLength={5000}
            className="board-input board-memos__textarea"
            placeholder={ui('写下你的想法…')}
            aria-label={ui('备忘内容')}
            value={draftText}
            onChange={(event) => setDraftText(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                event.stopPropagation();
                closeComposer();
              } else if (event.key === 'Enter' && (event.metaKey || event.ctrlKey) && !event.nativeEvent?.isComposing) {
                event.preventDefault();
                submitNew();
              }
            }}
          />
          <div className="board-memos__date-row">
            <label className="board-memos__date-label">
              <span>{ui('挂到日期')}</span>
              <input
                type="date"
                className="board-input board-memos__date-input"
                value={draftDate}
                onChange={(event) => setDraftDate(event.target.value)}
              />
            </label>
            {draftDate ? (
              <Button variant="quiet" size="sm" onClick={() => setDraftDate('')}>
                {ui('一直显示')}
              </Button>
            ) : (
              <span className="board-memos__date-hint">{ui('不选则一直显示，直到归档')}</span>
            )}
          </div>
          <div className="board-memos__form-actions">
            <Button type="submit" variant="primary" size="sm" busy={submitting} disabled={submitting || !draftValid}>
              {ui('保存备忘')}
            </Button>
            <Button variant="quiet" size="sm" onClick={closeComposer}>
              {ui('取消')}
            </Button>
          </div>
        </form>
      )}

      {memos.length === 0 && !composing && (
        readOnly ? (
          <p className="board-memos__empty-static">{ui('写下你的想法…')}</p>
        ) : (
          <Button
            variant="quiet"
            size="sm"
            className="board-memos__empty"
            onClick={openComposer}
          >
            {ui('写下你的想法…')}
          </Button>
        )
      )}

      {memos.length > 0 && (
        <ul className="board-memos__list">
          {memos.map((memo) => {
            const isEditing = editingId === memo.id;
            const createdLabel = formatDay(memo.createdAt);
            const pinnedLabel = memo.plannedDate ? formatDay(`${memo.plannedDate}T12:00:00`) : '';
            return (
              <li key={memo.id} className="board-memo" data-memo-id={memo.id}>
                {isEditing ? (
                  <form className="board-memos__form board-memo__edit" onSubmit={(event) => submitEdit(event, memo)}>
                    <textarea
                      rows={3}
                      maxLength={5000}
                      className="board-input board-memos__textarea"
                      aria-label={uiFormat('编辑备忘：{0}', [memo.title])}
                      value={editText}
                      onChange={(event) => setEditText(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === 'Escape') {
                          event.stopPropagation();
                          setEditingId('');
                        }
                      }}
                    />
                    <div className="board-memos__date-row">
                      <label className="board-memos__date-label">
                        <span>{ui('挂到日期')}</span>
                        <input
                          type="date"
                          className="board-input board-memos__date-input"
                          value={editDate}
                          onChange={(event) => setEditDate(event.target.value)}
                        />
                      </label>
                      {editDate && (
                        <Button variant="quiet" size="sm" onClick={() => setEditDate('')}>
                          {ui('一直显示')}
                        </Button>
                      )}
                    </div>
                    <div className="board-memos__form-actions">
                      <Button type="submit" variant="primary" size="sm" busy={savingEdit} disabled={savingEdit || !editValid}>
                        {ui('保存')}
                      </Button>
                      <Button variant="quiet" size="sm" onClick={() => setEditingId('')}>
                        {ui('取消')}
                      </Button>
                    </div>
                  </form>
                ) : (
                  <>
                    <div className="board-memo__meta">
                      <div className="board-memo__dates">
                        {createdLabel && <span className="board-memo__date">{createdLabel}</span>}
                        {pinnedLabel && (
                          <span className="board-chip board-memo__pin">
                            {uiFormat('挂在 {0}', [pinnedLabel])}
                          </span>
                        )}
                      </div>
                      {!readOnly && (
                        <div className="board-memo__actions">
                          <IconButton
                            icon={<Icon name="edit" size={14} />}
                            size="sm"
                            label={uiFormat('编辑备忘：{0}', [memo.title])}
                            onClick={() => startEdit(memo)}
                          />
                          <IconButton
                            icon={<Icon name="archive" size={14} />}
                            size="sm"
                            label={uiFormat('归档备忘：{0}', [memo.title])}
                            onClick={() => onArchiveMemo?.(memo)}
                          />
                          <IconButton
                            icon={<Icon name="trash" size={14} />}
                            size="sm"
                            label={uiFormat('删除备忘：{0}', [memo.title])}
                            onClick={() => onDeleteMemo?.(memo)}
                          />
                        </div>
                      )}
                    </div>
                    <MemoText text={memoBody(memo)} />
                  </>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
