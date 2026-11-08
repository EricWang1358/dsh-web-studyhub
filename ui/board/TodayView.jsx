import React, { useMemo, useRef, useState } from 'react';
import { ui, uiFormat } from '../i18n.js';
import { Button } from '../components/index.js';
import { isMeaningfulTitle, locateCard, selectTodayBoard } from '../../lib/board-model.js';
import BoardCard from './Card.jsx';
import { formatTodayHeading, todayPlanLine } from './today-header.js';

export default function TodayView({
  board, today, library, readOnly = false, hasDone = true, dailyPlan = null, dailyTaskIds,
  onToggleDone, onEdit, onAction, onQuickAdd, onScheduleToday, onOrigin, onStudyRef,
}) {
  const [quickTitle, setQuickTitle] = useState('');
  const [adding, setAdding] = useState(false);
  const [overToday, setOverToday] = useState(false);
  const [draggingPick, setDraggingPick] = useState(null);
  const quickInputRef = useRef(null);
  const backlogRef = useRef(null);

  const { open, done, unscheduled } = useMemo(
    () => selectTodayBoard(board, { today, dailyTaskIds }),
    [board, today, dailyTaskIds],
  );
  const columns = useMemo(
    () => board.columns.map((entry) => ({ id: entry.id, title: entry.title, done: entry.done })),
    [board.columns],
  );
  const heading = formatTodayHeading(today);
  const planLine = todayPlanLine(library, today);
  const todayEmpty = open.length === 0 && done.length === 0;
  const canAdd = !readOnly && board.columns.length > 0;

  const submitQuick = async (event) => {
    event.preventDefault();
    const trimmed = quickTitle.trim();
    if (!canAdd || adding || !isMeaningfulTitle(trimmed)) return;
    setAdding(true);
    const ok = await onQuickAdd(trimmed);
    setAdding(false);
    if (ok) setQuickTitle('');
  };

  const focusPlanEntry = () => {
    const firstPick = backlogRef.current?.querySelector('button:not(:disabled)');
    if (firstPick) {
      firstPick.scrollIntoView?.({ block: 'nearest', behavior: 'smooth' });
      firstPick.focus();
      return;
    }
    quickInputRef.current?.focus();
  };

  const renderTodayCard = (card) => {
    const place = locateCard(board, card.id);
    const column = board.columns.find((entry) => entry.id === place?.column) || board.columns[0];
    const extraItems = !column?.done && card.plannedDate === today
      ? [{ id: 'unplan-today', label: ui('移出今天'), icon: 'close' }]
      : [];
    return (
      <BoardCard
        key={card.id}
        card={card}
        column={column}
        columns={columns}
        index={place?.index ?? 0}
        count={column?.cardIds.length ?? 1}
        today={today}
        library={library}
        readOnly={readOnly}
        hasDone={hasDone}
        extraItems={extraItems}
        onToggleDone={onToggleDone}
        onEdit={onEdit}
        onAction={onAction}
        onOrigin={onOrigin}
        onStudyRef={onStudyRef}
      />
    );
  };

  return (
    <div className="board-today" data-today-date={today}>
      <header className="board-today__head">
        <div className="board-today__titles">
          <h2 className="board-today__date">{heading}</h2>
          {planLine && <p className="board-today__plan">{planLine}</p>}
        </div>
        <form className="board-today__quick" onSubmit={submitQuick}>
          <input
            ref={quickInputRef}
            className="board-input board-today__quick-input"
            value={quickTitle}
            maxLength={500}
            disabled={!canAdd || adding}
            placeholder={ui('记一条今天要做的事…')}
            aria-label={ui('记一条')}
            onChange={(event) => setQuickTitle(event.target.value)}
          />
          <Button
            type="submit"
            variant="secondary"
            size="sm"
            icon="plus"
            busy={adding}
            disabled={!canAdd || !isMeaningfulTitle(quickTitle)}
          >
            {ui('记一条')}
          </Button>
        </form>
      </header>

      {dailyPlan}

      <section
        className={`board-today__list${overToday ? ' is-over' : ''}`}
        aria-label={ui('今日')}
        onDragOver={(event) => {
          if (readOnly) return;
          event.preventDefault();
          event.dataTransfer.dropEffect = 'move';
          if (!overToday) setOverToday(true);
        }}
        onDragLeave={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget)) setOverToday(false);
        }}
        onDrop={(event) => {
          event.preventDefault();
          setOverToday(false);
          const id = event.dataTransfer.getData('application/x-study-board-card') || draggingPick;
          setDraggingPick(null);
          const picked = id && board.cards[id];
          if (picked && !readOnly) onScheduleToday(picked);
        }}
      >
        {todayEmpty ? (
          <div className="board-today__empty">
            <p className="board-today__empty-text">{ui('今天还没有排事。')}</p>
            <Button variant="secondary" size="sm" icon="plus" disabled={!canAdd} onClick={focusPlanEntry}>
              {ui('排今天')}
            </Button>
          </div>
        ) : (
          <>
            {open.length > 0 && (
              <div className="board-today__cards">
                {open.map(renderTodayCard)}
              </div>
            )}
            {done.length > 0 && (
              <div className="board-today__done" aria-label={ui('今天已完成')}>
                <p className="board-today__subhead">{uiFormat('今天已完成 · {0}', [done.length])}</p>
                <div className="board-today__cards">
                  {done.map(renderTodayCard)}
                </div>
              </div>
            )}
          </>
        )}
      </section>

      {unscheduled.length > 0 && (
        <section ref={backlogRef} className="board-today__backlog" aria-label={ui('还没排的待办')}>
          <header className="board-today__backlog-head">
            <h3 className="board-today__section-title">{ui('还没排的待办')}</h3>
            <span className="board-count">{unscheduled.length}</span>
          </header>
          <div className="board-today__picks">
            {unscheduled.map((card) => (
              <Button
                key={card.id}
                variant="secondary"
                size="sm"
                icon="plus"
                className={`board-today__pick${draggingPick === card.id ? ' is-dragging' : ''}`}
                disabled={readOnly}
                draggable={!readOnly}
                title={card.title}
                aria-label={uiFormat('排到今天：{0}', [card.title])}
                onDragStart={(event) => {
                  event.dataTransfer.setData('application/x-study-board-card', card.id);
                  event.dataTransfer.effectAllowed = 'move';
                  setDraggingPick(card.id);
                }}
                onDragEnd={() => {
                  setDraggingPick(null);
                  setOverToday(false);
                }}
                onClick={() => onScheduleToday(card)}
              >
                <span className="board-today__pick-title">{card.title}</span>
              </Button>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
