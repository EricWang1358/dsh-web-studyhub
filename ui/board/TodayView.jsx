import React, { useMemo, useRef, useState } from 'react';
import { ui, uiFormat } from '../i18n.js';
import { joinMeta } from '../format.js';
import { Button } from '../components/index.js';
import { TODAY_LANES, cardTodaySource, isMeaningfulTitle, locateCard, selectTodayBoard, todayBudgetMinutes } from '../../lib/board-model.js';
import BoardCard from './Card.jsx';
import TodayFocusStrip from './TodayFocusStrip.jsx';
import { formatTodayHeading, todayPlanLine } from './today-header.js';

export default function TodayView({
  board, today, library, readOnly = false, hasDone = true, dailyPlan = null, dailyTaskIds,
  dailyBudgetMinutes, planAnswer, focusedMinutes = null,
  onToggleDone, onEdit, onAction, onTodayAction, onMoveToday, onQuickAdd, onScheduleToday, onOrigin, onStudyRef,
}) {
  const [quickTitle, setQuickTitle] = useState('');
  const [adding, setAdding] = useState(false);
  const [laneTitles, setLaneTitles] = useState({ am: '', pm: '' });
  const [addingLane, setAddingLane] = useState('');
  const [drag, setDrag] = useState(null);
  const [drop, setDrop] = useState(null);
  const dragRef = useRef(null);
  const dropRef = useRef(null);
  const quickInputRef = useRef(null);
  const amInputRef = useRef(null);
  const pmInputRef = useRef(null);
  const backlogRef = useRef(null);

  const { open, done, unscheduled, lanes } = useMemo(
    () => selectTodayBoard(board, { today, dailyTaskIds, budgetMinutes: dailyBudgetMinutes }),
    [board, today, dailyTaskIds, dailyBudgetMinutes],
  );
  const resolvedBudgetMinutes = useMemo(
    () => todayBudgetMinutes(board, today, dailyBudgetMinutes),
    [board, today, dailyBudgetMinutes],
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
    const ok = await onQuickAdd(trimmed, 'am');
    setAdding(false);
    if (ok) setQuickTitle('');
  };

  const submitLaneAdd = async (event, laneId) => {
    event.preventDefault();
    const trimmed = (laneTitles[laneId] || '').trim();
    if (!canAdd || addingLane || !isMeaningfulTitle(trimmed)) return;
    setAddingLane(laneId);
    const ok = await onQuickAdd(trimmed, laneId);
    setAddingLane('');
    if (ok) setLaneTitles((prev) => ({ ...prev, [laneId]: '' }));
  };

  const focusPlanEntry = () => {
    const firstPick = backlogRef.current?.querySelector('button:not(:disabled)');
    if (firstPick) {
      firstPick.scrollIntoView?.({ block: 'nearest', behavior: 'smooth' });
      firstPick.focus();
      return;
    }
    (amInputRef.current || quickInputRef.current)?.focus();
  };

  const clearDragState = () => {
    dragRef.current = null;
    dropRef.current = null;
    setDrag(null);
    setDrop(null);
  };

  const aimLane = (event, laneId, slot) => {
    if (readOnly) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
    if (!dropRef.current || dropRef.current.lane !== laneId || dropRef.current.slot !== slot) {
      const nextDrop = { lane: laneId, slot };
      dropRef.current = nextDrop;
      setDrop(nextDrop);
    }
  };

  const finishDrop = (event, laneId, laneCardsLength) => {
    event.preventDefault();
    event.stopPropagation();
    const id = event.dataTransfer.getData('application/x-study-board-card') || dragRef.current?.id || drag?.id;
    let targetSlot = dropRef.current?.lane === laneId ? dropRef.current.slot : undefined;
    if (targetSlot === undefined) {
      const cards = [...event.currentTarget.querySelectorAll('.board-today__lane-cards > .board-card')];
      targetSlot = cards.length || laneCardsLength;
      for (let at = 0; at < cards.length; at += 1) {
        const box = cards[at].getBoundingClientRect();
        if (event.clientY < box.top + box.height / 2) {
          targetSlot = at;
          break;
        }
      }
    }
    clearDragState();
    if (!id || !board.cards[id] || readOnly) return;
    if (onMoveToday) onMoveToday(id, laneId, targetSlot);
    else onScheduleToday?.(board.cards[id]);
  };

  const renderLaneCard = (card, laneId, slotIndex, laneCount) => {
    const place = locateCard(board, card.id);
    const column = board.columns.find((entry) => entry.id === place?.column) || board.columns[0];
    const extraItems = [
      { id: laneId === 'am' ? 'slot:pm' : 'slot:am', label: laneId === 'am' ? ui('移到下午') : ui('移到上午'), icon: 'move' },
      ...(card.plannedDate === today ? [{ id: 'unplan-today', label: ui('移出今天'), icon: 'close' }] : []),
    ];
    return (
      <BoardCard
        key={card.id}
        card={card}
        column={column}
        columns={columns}
        index={slotIndex}
        count={laneCount}
        today={today}
        library={library}
        readOnly={readOnly}
        hasDone={hasDone}
        dragging={drag?.id === card.id}
        todayMeta={{ source: cardTodaySource(card), minutes: card.learningTask?.minutes }}
        extraItems={extraItems}
        onToggleDone={onToggleDone}
        onEdit={onEdit}
        onAction={(action, target) => (onTodayAction ? onTodayAction(action, target, laneId) : onAction(action, target))}
        onOrigin={onOrigin}
        onStudyRef={onStudyRef}
        articleProps={{
          onDragStart: (event) => {
            event.dataTransfer.setData('application/x-study-board-card', card.id);
            event.dataTransfer.effectAllowed = 'move';
            const nextDrag = { id: card.id, lane: laneId };
            dragRef.current = nextDrag;
            setDrag(nextDrag);
          },
          onDragEnd: clearDragState,
        }}
      />
    );
  };

  const renderDoneCard = (card) => {
    const place = locateCard(board, card.id);
    const column = board.columns.find((entry) => entry.id === place?.column) || board.columns[0];
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
        todayMeta={{ source: cardTodaySource(card), minutes: card.learningTask?.minutes }}
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

      <TodayFocusStrip
        library={library}
        today={today}
        budgetMinutes={resolvedBudgetMinutes}
        planAnswer={planAnswer}
        focusedMinutes={focusedMinutes}
      />

      {dailyPlan && <div className="board-today__daily">{dailyPlan}</div>}

      <section className="board-today__list" aria-label={ui('今日')}>
        {todayEmpty && (
          <div className="board-today__empty">
            <p className="board-today__empty-text">{ui('今天还没有排事。')}</p>
            <Button variant="secondary" size="sm" icon="plus" disabled={!canAdd} onClick={focusPlanEntry}>
              {ui('排今天')}
            </Button>
          </div>
        )}

        <div className="board-today__lanes">
          {TODAY_LANES.map((laneId) => {
            const lane = lanes[laneId];
            const laneTitle = laneId === 'pm' ? ui('下午') : ui('上午');
            const countLabel = lane.count === 1 ? ui('1 项') : uiFormat('{0} 项', [lane.count]);
            const laneMeta = joinMeta([countLabel, uiFormat('约 {0} 分钟', [lane.minutes])]);
            const dropHere = drop?.lane === laneId;
            const currentIds = lane.cards.map((entry) => entry.id);
            const showLine = (slot) => dropHere && drop.slot === slot && !(
              drag && currentIds.includes(drag.id) &&
              [currentIds.indexOf(drag.id), currentIds.indexOf(drag.id) + 1].includes(slot)
            );
            return (
              <section
                key={laneId}
                className={`board-today__lane${dropHere ? ' is-over' : ''}`}
                data-lane={laneId}
                aria-label={laneTitle}
                onDragOver={(event) => aimLane(event, laneId, lane.cards.length)}
                onDragLeave={(event) => {
                  if (!event.currentTarget.contains(event.relatedTarget)) {
                    dropRef.current = null;
                    setDrop(null);
                  }
                }}
                onDrop={(event) => finishDrop(event, laneId, lane.cards.length)}
              >
                <header className="board-today__lane-head">
                  <h3 className="board-today__lane-title">{laneTitle}</h3>
                  <span className="board-today__lane-meta">{laneMeta}</span>
                </header>
                <div
                  className="board-today__lane-cards"
                  onDragOver={(event) => {
                    const cards = [...event.currentTarget.querySelectorAll(':scope > .board-card')];
                    let slot = cards.length;
                    for (let at = 0; at < cards.length; at += 1) {
                      const box = cards[at].getBoundingClientRect();
                      if (event.clientY < box.top + box.height / 2) {
                        slot = at;
                        break;
                      }
                    }
                    aimLane(event, laneId, slot);
                    event.stopPropagation();
                  }}
                >
                  {lane.cards.map((card, slotIndex) => (
                    <React.Fragment key={card.id}>
                      {showLine(slotIndex) && <div className="board-drop-line" aria-hidden="true" />}
                      {renderLaneCard(card, laneId, slotIndex, lane.cards.length)}
                    </React.Fragment>
                  ))}
                  {showLine(lane.cards.length) && <div className="board-drop-line" aria-hidden="true" />}
                  {!todayEmpty && lane.cards.length === 0 && (
                    <p className="board-today__lane-empty">{ui('这一段还没有安排，拖卡片到这里或在下面添加。')}</p>
                  )}
                </div>
                {!readOnly && (
                  <form className="board-today__lane-add" onSubmit={(event) => submitLaneAdd(event, laneId)}>
                    <input
                      ref={laneId === 'am' ? amInputRef : pmInputRef}
                      className="board-input board-today__lane-input"
                      value={laneTitles[laneId]}
                      maxLength={500}
                      disabled={!canAdd || addingLane === laneId}
                      placeholder={laneId === 'pm' ? ui('加到下午…') : ui('加到上午…')}
                      aria-label={laneId === 'pm' ? ui('加到下午') : ui('加到上午')}
                      onChange={(event) => setLaneTitles((prev) => ({ ...prev, [laneId]: event.target.value }))}
                    />
                    <Button
                      type="submit"
                      variant="quiet"
                      size="sm"
                      icon="plus"
                      busy={addingLane === laneId}
                      disabled={!canAdd || !isMeaningfulTitle(laneTitles[laneId])}
                    >
                      {ui('添加')}
                    </Button>
                  </form>
                )}
              </section>
            );
          })}
        </div>

        {done.length > 0 && (
          <div className="board-today__done" aria-label={ui('今天已完成')}>
            <p className="board-today__subhead">{uiFormat('今天已完成 · {0}', [done.length])}</p>
            <div className="board-today__cards">
              {done.map(renderDoneCard)}
            </div>
          </div>
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
                className={`board-today__pick${drag?.id === card.id ? ' is-dragging' : ''}`}
                disabled={readOnly}
                draggable={!readOnly}
                title={card.title}
                aria-label={uiFormat('排到今天：{0}', [card.title])}
                onDragStart={(event) => {
                  event.dataTransfer.setData('application/x-study-board-card', card.id);
                  event.dataTransfer.effectAllowed = 'move';
                  const nextDrag = { id: card.id, lane: null };
                  dragRef.current = nextDrag;
                  setDrag(nextDrag);
                }}
                onDragEnd={clearDragState}
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
