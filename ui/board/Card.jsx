import { ui, uiFormat } from '../i18n.js';
import React, { useLayoutEffect, useRef, useState } from 'react';
import Markdown from '../Markdown.jsx';
import { Button, Icon } from '../components/index.js';
import { checklistProgress, dueState, labelHue } from '../../lib/board-model.js';
import BIcon from './icons.jsx';
import Menu from './Menu.jsx';
import { boardColumnLabel, dueText, dueTitle, studyRefLabel } from './meta.js';

/* A note is clamped to three lines; the expand button only exists when there
   is something more to show. Before the first measurement a lines/length
   guess decides, so server rendering and the first paint agree. */
const guessLong = (note) => note.length > 140 || note.split('\n').filter(Boolean).length > 3;

function Note({ note }) {
  const [open, setOpen] = useState(false);
  const [long, setLong] = useState(() => guessLong(note));
  const box = useRef(null);
  useLayoutEffect(() => {
    const element = box.current;
    if (!element || open) return;
    setLong(element.scrollHeight > element.clientHeight + 1);
  }, [note, open]);
  return (
    <div className="board-card__notewrap">
      <div ref={box} className="board-card__note" data-collapsed={open ? 'false' : 'true'}><Markdown text={note} /></div>
      {(long || open) && <Button variant="link" size="sm" className="board-card__toggle" aria-expanded={open} onClick={() => setOpen(!open)}>{open ? ui('收起') : ui('展开')}</Button>}
    </div>
  );
}

/** The ⋯ menu entries for a card; ids are `to:<columnId>` or an action name. */
export function cardMenuItems({ column, columns, index, count }) {
  const others = columns.filter((entry) => entry.id !== column.id);
  return [
    ...(others.length ? [{ heading: true, label: ui('移到') }, ...others.map((entry) => ({ id: `to:${entry.id}`, label: boardColumnLabel(entry), icon: 'move' }))] : []),
    { heading: true, label: ui('排序') },
    { id: 'up', label: ui('上移'), icon: 'up', disabled: index <= 0 },
    { id: 'down', label: ui('下移'), icon: 'down', disabled: index >= count - 1 },
    { heading: true, label: ui('卡片') },
    { id: 'edit', label: ui('编辑'), icon: 'edit' },
    { id: 'archive', label: ui('归档'), icon: 'archive' },
    { id: 'delete', label: ui('删除'), icon: 'trash', danger: true },
  ];
}

/**
 * One calm card. The done circle, title, ⋯ menu and (optionally) the origin and
 * study link are the only controls; moving is in the menu, by drag, or from the
 * keyboard (Alt+arrows). `articleProps` carries the drag handlers.
 */
export default function BoardCard({ card, column, columns, index, count, today, library, readOnly = false, hasDone = true, dragging = false,
  menuOpen = false, onToggleDone, onEdit, onAction, onOrigin, onStudyRef, articleProps = {} }) {
  const done = !!column.done;
  const state = dueState(card.due, today, done);
  const progress = checklistProgress(card);
  const link = card.studyRef ? studyRefLabel(card.studyRef, library) : null;
  const origin = card.origin?.workspaceTitle || card.origin?.workspace || '';
  const key = (event) => {
    if (readOnly) return;
    if (event.target === event.currentTarget && event.key === 'Enter') { event.preventDefault(); onEdit(card); return; }
    if (!event.altKey) return;
    const action = { ArrowLeft: 'left', ArrowRight: 'right', ArrowUp: 'up', ArrowDown: 'down' }[event.key];
    if (action) { event.preventDefault(); onAction(action, card); }
  };
  return (
    <article className={`board-card${done ? ' is-done' : ''}${dragging ? ' is-dragging' : ''}`} tabIndex={0} data-card-id={card.id}
      draggable={!readOnly} onKeyDown={key} aria-label={card.title} {...articleProps}>
      <div className="board-card__head">
        {hasDone && <button type="button" role="checkbox" aria-checked={done} className="board-check" disabled={readOnly}
          aria-label={uiFormat(done ? '标记为未完成：{0}' : '标记完成：{0}', [card.title])} onClick={() => onToggleDone(card)}>
          <Icon name="check" size={14} strokeWidth={2.4} />
        </button>}
        <button type="button" className="board-card__title" disabled={readOnly} onClick={() => onEdit(card)} title={card.title}>{card.title}</button>
        {!readOnly && <Menu label={uiFormat('更多操作：{0}', [card.title])} items={cardMenuItems({ column, columns, index, count })} defaultOpen={menuOpen}
          className="board-card__menu" onSelect={(id) => onAction(id, card)} />}
      </div>
      {card.note && <Note note={card.note} />}
      {(!!card.labels?.length || state || progress.total > 0) && <div className="board-card__chips">
        {(card.labels || []).map((label) => <span key={label} className={`board-chip board-hue-${labelHue(label)}`}>{label}</span>)}
        {state && <span className={`board-due is-${state.kind}`} title={dueTitle(card.due, state.kind === 'done' ? null : state)}>
          <BIcon name="calendar" size={13} />{state.kind === 'done' ? card.due : dueText(state)}</span>}
        {progress.total > 0 && <span className={`board-progress${progress.done === progress.total ? ' is-complete' : ''}`}
          title={uiFormat('清单 {0}/{1}', [progress.done, progress.total])}><BIcon name="checklist" size={13} />{progress.done}/{progress.total}</span>}
      </div>}
      {(origin || link) && <div className="board-meta">
        {origin && (onOrigin && card.origin?.workspace
          ? <button type="button" className="board-meta__item" title={card.origin.workspace} onClick={() => onOrigin(card.origin.workspace)}><Icon name="folder" size={13} /><span>{origin}</span></button>
          : <span className="board-meta__item" title={card.origin?.workspace}><Icon name="folder" size={13} /><span>{origin}</span></span>)}
        {link && (onStudyRef
          ? <button type="button" className="board-meta__item" title={card.studyRef.root} onClick={() => onStudyRef(card.studyRef)}><BIcon name="link" size={13} /><span>{link.text}</span></button>
          : <span className="board-meta__item" title={card.studyRef.root}><BIcon name="link" size={13} /><span>{link.text}</span></span>)}
      </div>}
    </article>
  );
}
