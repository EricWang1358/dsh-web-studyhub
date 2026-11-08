import { ui, uiFormat } from "./i18n.js";
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useInjectCss } from "./shared.js";
import { readJSON, writeJSON } from "./storage.js";
import { Button, EmptyState, Icon, IconButton, InlineMessage, LoadingState, Menu, PageHeader, TabPanel, Tabs, useToast } from "./components/index.js";
import { doneToggleTarget, filterCards, isFiltering, isMemoCard, labelCounts, localDate, locateCard, selectTodayBoard, taskCardCount } from "../lib/board-model.js";
import BoardCard from "./board/Card.jsx";
import Composer from "./board/Composer.jsx";
import CardEditor from "./board/CardEditor.jsx";
import DeleteCardDialog from "./board/DeleteCardDialog.jsx";
import FilterBar from "./board/FilterBar.jsx";
import TodayView from "./board/TodayView.jsx";
import { boardColumnLabel, cardsText, stamp, studyRefLabel } from "./board/meta.js";
import css from "./board/board.css";
import { useScrollEdges } from "./components/use-scroll-edges.js";

export { boardColumnLabel };

const MOVE_KEYS = { left: -1, right: 1 };
const UNDO_TIMEOUT = 8000;
const COLLAPSE_KEY = "study-board-collapsed";
const readCollapsed = () => { const saved = readJSON(COLLAPSE_KEY, []); return new Set(Array.isArray(saved) ? saved : []); };
const writeCollapsed = (set) => { writeJSON(COLLAPSE_KEY, [...set]); /* a per-viewer convenience only */ };
const friendly = (error, conflict) => conflict ? ui("看板已在其他位置更新，已载入最新内容，请再试一次。") : error;

function Column({ column, view, board, today, library, drag, drop, setDrag, setDrop, hasDone, composer, collapsed, filtering, readOnly, labelSuggestions, boardEmpty,
  studyRef, onClearStudyRef, onOpenComposer, onCloseComposer, onAdd, onToggleDone, onEdit, onAction, onDropTo, onRename, onFold, onRemove, onOrigin, onStudyRef }) {
  const label = boardColumnLabel(column);
  const shown = view.cardIds;
  const taskIds = column.cardIds.filter((id) => !isMemoCard(board.cards[id]));
  const [renaming, setRenaming] = useState(false);
  const [name, setName] = useState(column.title);
  const columns = board.columns.map((entry) => ({ id: entry.id, title: entry.title, done: entry.done }));
  const dropHere = drop?.column === column.id;
  // A slot among the visible cards maps back to the real position in the full column.
  const realIndex = (slot) => slot >= shown.length ? column.cardIds.length : column.cardIds.indexOf(shown[slot]);
  const aim = (event, slot) => {
    if (!drag || readOnly) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    if (!drop || drop.column !== column.id || drop.slot !== slot) setDrop({ column: column.id, slot });
  };
  const finish = (event) => {
    event.preventDefault(); event.stopPropagation();
    const id = event.dataTransfer.getData("application/x-study-board-card") || drag?.id;
    const target = drop?.column === column.id ? drop.slot : shown.length;
    setDrag(null); setDrop(null);
    if (id && board.cards[id]) onDropTo(id, column.id, realIndex(target));
  };
  const items = [
    { id: "rename", label: ui("重命名"), icon: "edit" },
    { id: "fold", label: collapsed ? ui("展开列") : ui("折叠"), icon: "chevron-down" },
    { id: "remove", label: ui("删除空列"), icon: "trash", danger: true, disabled: taskIds.length > 0 || board.columns.length <= 1,
      hint: taskIds.length > 0 ? ui("只能删除空列") : undefined },
  ];
  const showLine = (slot) => dropHere && drop.slot === slot && !(drag && column.cardIds.includes(drag.id)
    && [column.cardIds.indexOf(drag.id), column.cardIds.indexOf(drag.id) + 1].includes(realIndex(slot)));
  return <section className={`board-column${dropHere ? " is-over" : ""}${collapsed ? " is-collapsed" : ""}`} aria-label={label}
    onDragOver={(event) => aim(event, shown.length)}
    onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget)) setDrop(null); }}
    onDrop={finish}>
    <header className="board-column__head">
      <span className={column.done ? "board-dot is-done" : "board-dot"} aria-hidden="true" />
      {renaming
        ? <form className="board-column__rename" onSubmit={async (event) => { event.preventDefault(); if (name.trim() && await onRename(column, name.trim())) setRenaming(false); }}>
          <input className="board-input" autoFocus aria-label={ui("列名称")} value={name} maxLength={80} onChange={(event) => setName(event.target.value)}
            onKeyDown={(event) => { if (event.key === "Escape") { event.stopPropagation(); setRenaming(false); } }} onBlur={() => setRenaming(false)} />
        </form>
        : <h2 className="board-column__title">{label}</h2>}
      <span className="board-count" aria-label={cardsText(taskIds.length)}>{filtering && shown.length !== taskIds.length ? `${shown.length}/${taskIds.length}` : taskIds.length}</span>
      {!readOnly && <Menu label={uiFormat("列设置：{0}", [label])} items={items} className="board-column__menu"
        onSelect={(id) => { if (id === "rename") { if (collapsed) onFold(column); setName(column.title); setRenaming(true); } else if (id === "fold") onFold(column); else onRemove(column); }} />}
    </header>
    {!collapsed && <>
      <div className="board-cards" onDragOver={(event) => {
        // The slot is the first card whose middle is below the pointer; gaps never flicker.
        const cards = [...event.currentTarget.querySelectorAll(":scope > .board-card")];
        let slot = cards.length;
        for (let at = 0; at < cards.length; at++) {
          const box = cards[at].getBoundingClientRect();
          if (event.clientY < box.top + box.height / 2) { slot = at; break; }
        }
        aim(event, slot);
        event.stopPropagation();
      }}>
        {shown.map((id, slot) => {
          const card = board.cards[id];
          const extraItems = column.done ? [] : (card.plannedDate === today
            ? [{ id: "unplan-today", label: ui("移出今天"), icon: "close" }]
            : [{ id: "plan-today", label: ui("排到今天"), icon: "calendar" }]);
          return <React.Fragment key={id}>
            {showLine(slot) && <div className="board-drop-line" aria-hidden="true" />}
            <BoardCard card={card} column={column} columns={columns} index={taskIds.indexOf(id)} count={taskIds.length} today={today} library={library}
              readOnly={readOnly} hasDone={hasDone} dragging={drag?.id === id} extraItems={extraItems} onToggleDone={onToggleDone} onEdit={onEdit} onAction={onAction}
              onOrigin={onOrigin} onStudyRef={onStudyRef}
              articleProps={{
                onDragStart: (event) => { event.dataTransfer.setData("application/x-study-board-card", id); event.dataTransfer.effectAllowed = "move"; setDrag({ id }); },
                onDragEnd: () => { setDrag(null); setDrop(null); },
              }} />
          </React.Fragment>;
        })}
        {showLine(shown.length) && <div className="board-drop-line" aria-hidden="true" />}
        {/* While the whole board is empty the page says so once (#576); an empty column among filled ones still says so. */}
        {!shown.length && !composer && !boardEmpty && (filtering && taskIds.length
          ? <p className="board-column__none">{ui("没有符合筛选的卡片")}</p>
          : <EmptyState className="board-column__empty" size="sm" title={ui("这一列没有卡片")} description={ui("把卡片拖到这里，或点下面添加。")} />)}
      </div>
      {!readOnly && (composer
        ? <Composer columnTitle={label} studyRef={studyRef} library={library} labelSuggestions={labelSuggestions} onSubmit={(fields) => onAdd(column, fields)}
          onClose={onCloseComposer} onClearStudyRef={onClearStudyRef} />
        : <Button variant="quiet" size="sm" icon="plus" className="board-column__add" onClick={() => onOpenComposer(column.id)}>{ui("添加卡片")}</Button>)}
    </>}
  </section>;
}

function NewColumn({ onAdd }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  if (!open) return <div className="board-column board-column--new"><Button className="board-column__new-btn" variant="quiet" size="sm" icon="plus" onClick={() => setOpen(true)}>{ui("新建列")}</Button></div>;
  return <form className="board-column board-column--new is-editing" onSubmit={async (event) => { event.preventDefault(); if (name.trim() && await onAdd(name.trim())) { setName(""); setOpen(false); } }}>
    <input className="board-input" autoFocus aria-label={ui("新列名称")} placeholder={ui("新列名称")} maxLength={80} value={name} onChange={(event) => setName(event.target.value)}
      onKeyDown={(event) => { if (event.key === "Escape") { event.stopPropagation(); setOpen(false); setName(""); } }} />
    <div className="board-column__rename-actions">
      <Button type="submit" variant="primary" size="sm" disabled={!name.trim()}>{ui("添加")}</Button>
      <Button variant="quiet" size="sm" onClick={() => { setOpen(false); setName(""); }}>{ui("取消")}</Button>
    </div>
  </form>;
}

function ArchiveList({ board, readOnly, library, onRestore, onDelete, onBack }) {
  return <section className="board-archive-list" aria-label={ui("已归档卡片")}>
    <div className="board-archive-list__head">
      <Button variant="link" size="sm" icon="arrow-left" onClick={onBack}>{ui("返回看板")}</Button>
      <h2>{ui("已归档")}</h2><p className="muted">{ui("恢复后会回到第一列。")}</p>
    </div>
    {!board.archived.length && <EmptyState size="sm" icon="check" title={ui("没有已归档的卡片")} description={ui("在卡片的 ⋯ 菜单里选「归档」，完成的事会收到这里。")} />}
    <ul>
      {[...board.archived].reverse().map((card) => <li key={card.id}>
        <div className="board-archive-list__text">
          <span className="board-archive-list__title">{isMemoCard(card) && <span className="board-chip board-archive-list__kind">{ui("备忘")}</span>}{card.title}</span>
          <span className="board-archive-list__meta">{uiFormat("更新于 {0}", [stamp(card.updatedAt)])}{card.studyRef ? ` · ${studyRefLabel(card.studyRef, library).text}` : ""}</span>
        </div>
        <Button variant="secondary" size="sm" icon={<Icon name="undo" />} disabled={readOnly || !board.columns.length} onClick={() => onRestore(card)}>{ui("恢复")}</Button>
        <IconButton icon={<Icon name="trash" size={18} />} size="sm" label={uiFormat("永久删除：{0}", [card.title])} disabled={readOnly} onClick={() => onDelete(card)} />
      </li>)}
    </ul>
  </section>;
}

export default function Board({ state, library, today: todayProp, view: viewProp, defaultView = "all", onViewChange, onOrigin, onStudyRef, studyRef, onClearStudyRef,
  composeOnArrive = false, onComposeOpened, dailyPlan, dailyTaskIds, dailyBudgetMinutes, planAnswer, nowMs, onBoardChanged }) {
  useInjectCss(css, "study-board");
  const { board, error, conflict, busy, mutate, refresh, clearError } = state;
  const today = todayProp || localDate();
  const [ownView, setOwnView] = useState(() => (composeOnArrive && studyRef ? "all" : defaultView));
  const activeTab = viewProp ?? ownView;
  const setTab = useCallback((next) => {
    setOwnView(next);
    onViewChange?.(next);
  }, [onViewChange]);
  const [editing, setEditing] = useState(null);
  const [query, setQuery] = useState({});
  const [filterOpen, setFilterOpen] = useState(false);
  const [composer, setComposer] = useState(() => composeOnArrive && studyRef && board?.columns?.length ? board.columns[0].id : null);
  const [confirm, setConfirm] = useState(null);
  const [collapsed, setCollapsed] = useState(readCollapsed);
  const [drag, setDrag] = useState(null);
  const [drop, setDrop] = useState(null);
  const toast = useToast();
  const [saving, setSaving] = useState(false);
  const [announcement, setAnnouncement] = useState("");
  const [originError, setOriginError] = useState("");
  const boardRef = useRef(board), focusId = useRef(null), announced = useRef(0), tabsId = "board-view-tabs";
  // The columns scroll sideways on a narrow window: the side with more of them beyond it fades (ui/components/scroll-fade.css, #747). Dragging, snap and the
  // scroll position are untouched.
  const [columnsStrip, columnEdges, measureColumns] = useScrollEdges();
  boardRef.current = board;
  // Opening the composer unfolds its column: a composer inside a folded column could not be seen.
  const openComposer = (id) => {
    setCollapsed((current) => { if (!current.has(id)) return current; const next = new Set(current); next.delete(id); writeCollapsed(next); return next; });
    setComposer(id);
  };

  // Only "加入待办" asks for the composer (with its study link as a chip); entering the page any other way opens nothing (#576).
  // The request is spent once the composer is open, and waits for a board that is still loading.
  const firstColumn = board?.columns?.[0]?.id;
  useEffect(() => {
    if (!composeOnArrive || !studyRef || !firstColumn) return;
    setTab("all");
    openComposer(firstColumn);
    onComposeOpened?.();
  }, [composeOnArrive, studyRef, firstColumn, onComposeOpened, setTab]);
  useEffect(() => {
    if (!focusId.current) return;
    const id = focusId.current;
    const frame = requestAnimationFrame(() => {
      document.querySelector(`.board-panel:not([hidden]) [data-card-id="${CSS.escape(id)}"]`)?.focus({ preventScroll: false });
      focusId.current = null;
    });
    return () => cancelAnimationFrame(frame);
  }, [board]);
  const say = useCallback((message) => { announced.current += 1; setAnnouncement(announced.current % 2 ? message : `${message}​`); }, []);
  // The undo offer goes to the app's one toast region: it leaves after UNDO_TIMEOUT but is held while hovered or focused.
  const offer = useCallback((message, undo) => {
    toast.show({ tone: "success", message, undo: true, timeout: UNDO_TIMEOUT,
      action: undo ? { label: ui("撤销"), onClick: async () => { toast.dismiss(); if (await undo()) say(ui("已撤销")); } } : undefined });
    say(message);
  }, [say, toast]);
  const run = useCallback((action, args, options) => (mutate ? mutate(action, args, options) : Promise.resolve(false)), [mutate]);

  const columnName = (id) => { const column = boardRef.current.columns.find((entry) => entry.id === id); return column ? boardColumnLabel(column) : ""; };
  const moveCard = useCallback(async (id, column, index, { quiet = false } = {}) => {
    const now = boardRef.current, from = locateCard(now, id);
    if (!from) return false;
    const title = now.cards[id].title;
    const ok = await run("board.card.move", { id, column, ...(index === undefined ? {} : { index }) });
    if (!ok) return false;
    onBoardChanged?.();
    const to = locateCard(boardRef.current, id);
    const total = boardRef.current.columns.find((entry) => entry.id === column)?.cardIds.length || 0;
    const message = column === from.column
      ? uiFormat("已移到第 {0} 位（共 {1} 张）", [(to?.index ?? 0) + 1, total])
      : uiFormat("已移到「{0}」：{1}", [columnName(column), title]);
    if (quiet) say(message);
    else offer(message, async () => { const undone = await run("board.card.move", { id, column: from.column, index: from.index }); if (undone) onBoardChanged?.(); return undone; });
    return true;
  }, [run, offer, say, onBoardChanged]);

  const archiveCard = useCallback(async (card) => {
    const from = locateCard(boardRef.current, card.id);
    if (!from || !(await run("board.card.archive", { id: card.id }))) return false;
    onBoardChanged?.();
    offer(uiFormat("已归档：{0}", [card.title]), async () => { const undone = await run("board.card.restore", { id: card.id, column: from.column, index: from.index }); if (undone) onBoardChanged?.(); return undone; });
    return true;
  }, [run, offer, onBoardChanged]);

  const deleteCard = useCallback(async (card) => {
    const now = boardRef.current, from = locateCard(now, card.id);
    const snapshot = structuredClone(now.cards[card.id] || now.archived.find((entry) => entry.id === card.id));
    const savedLogs = Array.isArray(now.timeLog) ? structuredClone(now.timeLog.filter((entry) => entry.cardId === card.id)) : [];
    if (!snapshot || !(await run("board.card.remove", { id: card.id }))) return false;
    onBoardChanged?.();
    if (from) offer(uiFormat("已删除：{0}", [card.title]), async () => {
      const undone = await run("board.card.undelete", {
        card: snapshot,
        column: from.column,
        index: from.index,
        ...(savedLogs.length ? { timeLog: savedLogs } : {}),
      });
      if (undone) onBoardChanged?.();
      return undone;
    });
    else say(uiFormat("已删除：{0}", [card.title]));
    return true;
  }, [run, offer, say, onBoardChanged]);

  const startTimer = useCallback(async (card) => {
    const ok = await run("board.timer.start", { id: card.id, mode: "work" }, { optimistic: false });
    if (ok) {
      say(uiFormat("已开始专注：{0}", [card.title]));
      onBoardChanged?.();
    }
    return ok;
  }, [run, say, onBoardChanged]);

  const startBreak = useCallback(async (durationMinutes) => {
    const ok = await run("board.timer.start", {
      mode: "break",
      cardTitle: ui("休息片刻"),
      ...(Number.isInteger(durationMinutes) ? { durationMinutes } : {}),
    }, { optimistic: false });
    if (ok) say(uiFormat("已开始休息 {0} 分钟", [durationMinutes]));
    return ok;
  }, [run, say]);

  const pauseTimer = useCallback(async () => {
    const ok = await run("board.timer.pause", {});
    if (ok) say(ui("已暂停专注"));
    return ok;
  }, [run, say]);

  const resumeTimer = useCallback(async () => {
    const ok = await run("board.timer.resume", {});
    if (ok) say(ui("继续专注"));
    return ok;
  }, [run, say]);

  const cancelTimer = useCallback(async () => {
    const ok = await run("board.timer.cancel", {});
    if (ok) say(ui("已放弃本次计时"));
    return ok;
  }, [run, say]);

  const completeTimer = useCallback(async (snap) => {
    const isWork = snap?.mode === "work";
    const mins = snap?.loggedMinutes;
    const title = snap?.cardTitle || "";
    const ok = await run("board.timer.complete", {
      ...(isWork && Number.isInteger(mins) ? { minutes: mins, date: today } : {}),
    }, { optimistic: false });
    if (ok) {
      onBoardChanged?.();
      say(isWork ? uiFormat("已记录专注 {0} 分钟：{1}", [mins, title]) : ui("休息已结束"));
    }
    return ok;
  }, [run, today, say, onBoardChanged]);

  const saveTimerPrefs = useCallback(async (prefs) => {
    const ok = await run("board.timer.prefs", prefs);
    if (ok) say(ui("已保存计时设置"));
    return ok;
  }, [run, say]);

  const addTimeLog = useCallback(async (fields) => {
    const ok = await run("board.timeLog.add", {
      ...(fields.cardId ? { cardId: fields.cardId } : {}),
      cardTitle: fields.cardTitle,
      minutes: fields.minutes,
      date: fields.date || today,
    }, { optimistic: false });
    if (ok) {
      onBoardChanged?.();
      say(uiFormat("已补记专注 {0} 分钟：{1}", [fields.minutes, fields.cardTitle]));
    }
    return ok;
  }, [run, today, say, onBoardChanged]);

  const editTimeLog = useCallback(async (entry, minutes) => {
    const prevMinutes = entry.minutes;
    const ok = await run("board.timeLog.edit", { id: entry.id, minutes });
    if (ok) {
      onBoardChanged?.();
      offer(uiFormat("已改为 {0} 分钟：{1}", [minutes, entry.cardTitle]), async () => {
        const undone = await run("board.timeLog.edit", { id: entry.id, minutes: prevMinutes });
        if (undone) onBoardChanged?.();
        return undone;
      });
    }
    return ok;
  }, [run, offer, onBoardChanged]);

  const removeTimeLog = useCallback(async (entry) => {
    const snapshot = structuredClone(entry);
    const ok = await run("board.timeLog.remove", { id: entry.id });
    if (ok) {
      onBoardChanged?.();
      offer(uiFormat("已删除专注记录：{0}", [entry.cardTitle]), async () => {
        const undone = await run("board.timeLog.add", {
          ...(snapshot.cardId ? { cardId: snapshot.cardId } : {}),
          cardTitle: snapshot.cardTitle,
          date: snapshot.date,
          startedAt: snapshot.startedAt,
          minutes: snapshot.minutes,
        }, { optimistic: false });
        if (undone) onBoardChanged?.();
        return undone;
      });
    }
    return ok;
  }, [run, offer, onBoardChanged]);

  const toggleDone = useCallback(async (card) => {
    const target = doneToggleTarget(boardRef.current, card.id);
    if (!target) return;
    const wasDone = !!boardRef.current.columns.find((entry) => entry.cardIds.includes(card.id))?.done;
    const from = locateCard(boardRef.current, card.id);
    if (!(await run("board.card.move", { id: card.id, column: target.column, index: target.index }))) return;
    onBoardChanged?.();
    offer(wasDone ? uiFormat("已移回「{0}」：{1}", [columnName(target.column), card.title]) : uiFormat("已完成：{0}", [card.title]),
      async () => { const undone = await run("board.card.move", { id: card.id, column: from.column, index: from.index }); if (undone) onBoardChanged?.(); return undone; });
  }, [run, offer, onBoardChanged]);

  const scheduleToday = useCallback(async (card) => {
    const prev = card.plannedDate || "";
    if (prev === today) return true;
    if (!(await run("board.card.edit", { id: card.id, plannedDate: today }))) return false;
    onBoardChanged?.();
    offer(uiFormat("已排到今天：{0}", [card.title]), async () => {
      const undone = await run("board.card.edit", { id: card.id, plannedDate: prev });
      if (undone) onBoardChanged?.();
      return undone;
    });
    return true;
  }, [run, offer, today, onBoardChanged]);

  const unscheduleToday = useCallback(async (card) => {
    const prev = card.plannedDate || "";
    if (!prev || !(await run("board.card.edit", { id: card.id, plannedDate: "" }))) return false;
    onBoardChanged?.();
    offer(uiFormat("已移出今天：{0}", [card.title]), async () => {
      const undone = await run("board.card.edit", { id: card.id, plannedDate: prev });
      if (undone) onBoardChanged?.();
      return undone;
    });
    return true;
  }, [run, offer, onBoardChanged]);

  const quickAddToday = useCallback(async (title, slot = "am") => {
    const columns = boardRef.current?.columns || [];
    const destination = columns.find((entry) => !entry.done) || columns[0];
    if (!destination) return false;
    const lane = slot === "pm" ? "pm" : "am";
    const ok = await run("board.card.add", { column: destination.id, title, plannedDate: today, slot: lane, slotDate: today }, { optimistic: false });
    if (ok) {
      say(lane === "pm" ? uiFormat("已加到下午：{0}", [title]) : uiFormat("已加到上午：{0}", [title]));
      onBoardChanged?.();
    }
    return ok;
  }, [run, today, say, onBoardChanged]);

  const addMemo = useCallback(async (fields) => {
    const columns = boardRef.current?.columns || [];
    const destination = columns.find((entry) => !entry.done) || columns[0];
    if (!destination) return false;
    const ok = await run("board.card.add", {
      column: destination.id,
      kind: "memo",
      title: fields.title,
      ...(fields.note ? { note: fields.note } : {}),
      ...(fields.plannedDate ? { plannedDate: fields.plannedDate } : {}),
    }, { optimistic: false });
    if (ok) {
      say(uiFormat("已记下备忘：{0}", [fields.title]));
      onBoardChanged?.();
    }
    return ok;
  }, [run, say, onBoardChanged]);

  const editMemo = useCallback(async (memo, fields) => {
    const prev = {
      title: memo.title,
      note: memo.note || "",
      plannedDate: memo.plannedDate || "",
    };
    const ok = await run("board.card.edit", {
      id: memo.id,
      title: fields.title,
      note: fields.note ?? "",
      plannedDate: fields.plannedDate ?? "",
    });
    if (ok) {
      onBoardChanged?.();
      offer(uiFormat("已更新备忘：{0}", [fields.title]), async () => {
        const undone = await run("board.card.edit", { id: memo.id, ...prev });
        if (undone) onBoardChanged?.();
        return undone;
      });
    }
    return ok;
  }, [run, offer, onBoardChanged]);

  const moveTodayCard = useCallback(async (id, targetSlot, targetIndex, { quiet = false } = {}) => {
    const now = boardRef.current;
    const card = now?.cards?.[id];
    if (!card || (targetSlot !== "am" && targetSlot !== "pm")) return false;
    const { lanes } = selectTodayBoard(now, { today, dailyTaskIds });
    const prevAm = lanes.am.cards.map((entry) => entry.id);
    const prevPm = lanes.pm.cards.map((entry) => entry.id);
    const prevLane = prevAm.includes(id) ? "am" : prevPm.includes(id) ? "pm" : null;
    const prevIndex = prevLane === "am" ? prevAm.indexOf(id) : prevLane === "pm" ? prevPm.indexOf(id) : -1;
    const amIds = prevAm.filter((entry) => entry !== id);
    const pmIds = prevPm.filter((entry) => entry !== id);
    const dest = targetSlot === "pm" ? pmIds : amIds;
    const clamped = Math.max(0, Math.min(targetIndex ?? dest.length, dest.length));
    if (prevLane === targetSlot && prevIndex === clamped) return false;
    dest.splice(clamped, 0, id);
    const order = [...amIds, ...pmIds];
    const prevSlot = card.slotDate === today && card.slot ? card.slot : "";
    const prevPlannedDate = card.plannedDate || "";
    const prevOrder = now.todayOrder?.date === today && Array.isArray(now.todayOrder.ids)
      ? [...now.todayOrder.ids]
      : [];
    const ok = await run("board.today.move", {
      id,
      date: today,
      slot: targetSlot,
      order,
      ...(!prevLane ? { schedule: true } : {}),
    });
    if (!ok) return false;
    onBoardChanged?.();
    const message = prevLane === targetSlot
      ? uiFormat("已移到第 {0} 位（共 {1} 张）", [clamped + 1, dest.length])
      : targetSlot === "pm"
        ? uiFormat("已移到下午：{0}", [card.title])
        : uiFormat("已移到上午：{0}", [card.title]);
    if (quiet) say(message);
    else offer(message, async () => {
      const undone = await run("board.today.move", {
        id,
        date: today,
        slot: prevSlot,
        order: prevOrder,
        ...(!prevLane ? { plannedDate: prevPlannedDate } : {}),
      });
      if (undone) onBoardChanged?.();
      return undone;
    });
    return true;
  }, [run, today, dailyTaskIds, say, offer, onBoardChanged]);

  const onAction = useCallback(async (action, card) => {
    const now = boardRef.current, from = locateCard(now, card.id);
    if (!from) return;
    const position = now.columns.findIndex((entry) => entry.id === from.column);
    if (action === "plan-today") { await scheduleToday(card); return; }
    if (action === "unplan-today") { await unscheduleToday(card); return; }
    if (action.startsWith("to:")) { await moveCard(card.id, action.slice(3)); return; }
    if (action === "edit") { setEditing({ id: card.id, revision: now.revision }); return; }
    if (action === "archive") { await archiveCard(card); return; }
    if (action === "delete") { setConfirm({ kind: "delete", card }); return; }
    if (action === "up" || action === "down") {
      const index = from.index + (action === "up" ? -1 : 1), size = now.columns[position].cardIds.length;
      if (index < 0 || index >= size) return;
      focusId.current = card.id;
      await moveCard(card.id, from.column, index, { quiet: true });
      return;
    }
    if (action === "left" || action === "right") {
      const next = now.columns[position + MOVE_KEYS[action]];
      if (!next) return;
      focusId.current = card.id;
      await moveCard(card.id, next.id, Math.min(from.index, next.cardIds.length), { quiet: true });
    }
  }, [moveCard, archiveCard, scheduleToday, unscheduleToday]);

  const onTodayAction = useCallback(async (action, card, laneId) => {
    const now = boardRef.current;
    if (!now?.cards?.[card.id]) return;
    if (action === "slot:am" || action === "slot:pm") {
      await moveTodayCard(card.id, action.slice(5));
      return;
    }
    if (action === "up" || action === "down" || action === "left" || action === "right") {
      const { lanes } = selectTodayBoard(now, { today, dailyTaskIds });
      const own = lanes[laneId]?.cards.map((entry) => entry.id) || [];
      const currentIndex = own.indexOf(card.id);
      if (currentIndex < 0) return;
      if (action === "up" || action === "down") {
        const nextIndex = currentIndex + (action === "up" ? -1 : 1);
        if (nextIndex < 0 || nextIndex >= own.length) return;
        focusId.current = card.id;
        await moveTodayCard(card.id, laneId, nextIndex, { quiet: true });
        return;
      }
      const nextLane = action === "left" ? (laneId === "pm" ? "am" : null) : (laneId === "am" ? "pm" : null);
      if (!nextLane) return;
      const targetCount = lanes[nextLane]?.cards.length ?? 0;
      focusId.current = card.id;
      await moveTodayCard(card.id, nextLane, Math.min(currentIndex, targetCount), { quiet: true });
      return;
    }
    await onAction(action, card);
  }, [today, dailyTaskIds, moveTodayCard, onAction]);

  const addCard = useCallback(async (column, fields) => {
    const args = { column: column.id, title: fields.title, labels: fields.labels, ...(fields.note ? { note: fields.note } : {}), ...(fields.due ? { due: fields.due } : {}),
      ...(studyRef ? { studyRef } : {}) };
    const ok = await run("board.card.add", args, { optimistic: false });
    if (ok) { onClearStudyRef?.(); onBoardChanged?.(); say(uiFormat("已添加到「{0}」：{1}", [boardColumnLabel(column), fields.title])); }
    return ok;
  }, [run, studyRef, onClearStudyRef, onBoardChanged, say]);

  const openRef = (fn) => fn ? async (value) => { try { setOriginError(""); await fn(value); } catch (e) { setOriginError(e.message); } } : undefined;
  const flip = (column) => setCollapsed((current) => { const next = new Set(current); if (!next.delete(column.id)) next.add(column.id); writeCollapsed(next); return next; });

  const readOnly = !board || !!board.readOnly;
  const filtering = isFiltering(query);
  const view = useMemo(() => board ? filterCards(board, { ...query, today }) : null, [board, query, today]);
  const labels = useMemo(() => board ? labelCounts(board) : [], [board]);
  const todaySummary = useMemo(() => board ? selectTodayBoard(board, { today, dailyTaskIds }) : { open: [], done: [], unscheduled: [] }, [board, today, dailyTaskIds]);
  const total = board ? taskCardCount(board) : 0;
  // An empty board shows one empty state and one way in; its columns appear with the first card, or when the learner starts writing it.
  const empty = !!board && total === 0;
  const showColumns = !empty || composer !== null;
  // Closing the composer on a still-empty board brings back the empty state; focus returns to its button.
  const closeComposer = () => {
    setComposer(null);
    if (empty) requestAnimationFrame(() => document.querySelector(".board-empty .sh-empty__actions button")?.focus());
  };
  const matched = view ? view.columns.reduce((sum, column) => sum + column.cardIds.length, 0) : 0;
  const hasDone = !!board?.columns.some((column) => column.done);
  const editingCard = editing && board?.cards[editing.id];
  const message = originError || (board?.readOnly ? board.error : friendly(error, conflict));
  const colTracks = view && board
    ? `${view.columns.map((_, at) => (collapsed.has(board.columns[at].id) ? "2.75rem" : "minmax(16rem, 1fr)")).join(" ")}${!readOnly ? " minmax(10.5rem, 13rem)" : ""}`
    : undefined;
  const tabItems = [
    {
      value: "today",
      label: ui("今日"),
      content: <>{ui("今日")}{board && todaySummary.open.length ? <small className="board-tab__note"> ({todaySummary.open.length})</small> : null}</>,
    },
    { value: "all", label: ui("全部待办") },
    {
      value: "archive",
      label: ui("归档"),
      content: <>{ui("归档")}{board ? <small className="board-tab__note"> ({board.archived.length})</small> : null}</>,
    },
  ];

  return <section className="page board-page">
    <PageHeader className="board-page__header" title={ui("待办看板")} eyebrow={ui("所有工作区")} description={ui("所有工作区共用。把想做的事记下来，逐步完成。")}
      actions={<>
        <IconButton icon={<Icon name="sync" size={18} />} label={ui("刷新")} size="sm" lock={busy} onClick={() => refresh({ force: true })} />
        {activeTab === "all" && !empty && <Button variant="primary" icon="plus" disabled={readOnly || !board?.columns.length} onClick={() => openComposer(board.columns[0].id)}>{ui("添加卡片")}</Button>}
      </>} />
    <Tabs id={tabsId} className="board-tabs" itemClassName="board-tab" label={ui("待办视图")} value={activeTab} onChange={setTab} items={tabItems} />
    {message && <InlineMessage tone={board?.readOnly ? "error" : conflict ? "warning" : "error"} boxed onDismiss={board?.readOnly ? undefined : () => { setOriginError(""); clearError?.(); }}>{message}</InlineMessage>}
    {!board && <LoadingState className="board-loading" label={ui("正在读取待办…")} />}
    {board && <>
      <TabPanel id={tabsId} value="today" selected={activeTab} tabIndex={undefined} className="board-panel">
        <TodayView
          board={board}
          today={today}
          library={library}
          readOnly={readOnly}
          hasDone={hasDone}
          dailyPlan={dailyPlan}
          dailyTaskIds={dailyTaskIds}
          dailyBudgetMinutes={dailyBudgetMinutes}
          planAnswer={planAnswer}
          nowMs={nowMs}
          onToggleDone={toggleDone}
          onEdit={(card) => onAction("edit", card)}
          onAction={onAction}
          onTodayAction={onTodayAction}
          onMoveToday={moveTodayCard}
          onQuickAdd={quickAddToday}
          onScheduleToday={scheduleToday}
          onOrigin={openRef(onOrigin)}
          onStudyRef={openRef(onStudyRef)}
          onStartTimer={startTimer}
          onStartBreak={startBreak}
          onPauseTimer={pauseTimer}
          onResumeTimer={resumeTimer}
          onCancelTimer={cancelTimer}
          onCompleteTimer={completeTimer}
          onSaveTimerPrefs={saveTimerPrefs}
          onAddTimeLog={addTimeLog}
          onEditTimeLog={editTimeLog}
          onRemoveTimeLog={removeTimeLog}
          onAddMemo={addMemo}
          onEditMemo={editMemo}
          onArchiveMemo={archiveCard}
          onDeleteMemo={deleteCard}
        />
      </TabPanel>
      <TabPanel id={tabsId} value="all" selected={activeTab} tabIndex={undefined} className="board-panel">
        {dailyPlan}
        {(total > 0 || filtering) && <FilterBar query={query} labels={labels} onChange={setQuery} open={filterOpen} onToggle={() => setFilterOpen(!filterOpen)} matched={matched} total={total} />}
        {empty && !showColumns && <EmptyState icon="check" title={ui("还没有待办")} className="board-empty"
          description={ui("把想做的事记在这里。在复习、题目或学习流里点「加入待办」，会把当前内容一起记下来。")}
          primary={{ label: ui("添加第一张卡片"), icon: "plus", disabled: readOnly || !board.columns.length, onClick: () => openComposer(board.columns[0].id) }} />}
        {filtering && matched === 0 && total > 0 && <EmptyState size="sm" icon={<Icon name="search" size={22} />} title={ui("没有符合筛选的卡片")} className="board-empty"
          secondary={{ label: ui("清除筛选"), onClick: () => setQuery({}) }} />}
        {showColumns && <div className="board-columns sh-fade-x" ref={columnsStrip} data-fade-start={columnEdges.start || undefined}
          data-fade-end={columnEdges.end || undefined} onScroll={measureColumns} style={{ "--board-cols": board.columns.length, "--board-col-tracks": colTracks }}>
          {view.columns.map((column, at) => <Column key={column.id} column={board.columns[at]} view={column} board={board} today={today} library={library} drag={drag} drop={drop}
            setDrag={setDrag} setDrop={setDrop} hasDone={hasDone} composer={composer === column.id} collapsed={collapsed.has(column.id)} filtering={filtering} readOnly={readOnly} boardEmpty={empty}
            labelSuggestions={labels.map((entry) => entry.label)} studyRef={studyRef} onClearStudyRef={onClearStudyRef}
            onOpenComposer={openComposer} onCloseComposer={closeComposer} onAdd={addCard} onToggleDone={toggleDone} onEdit={(card) => onAction("edit", card)} onAction={onAction}
            onDropTo={(id, target, index) => moveCard(id, target, index)}
            onRename={(entry, title) => run("board.column.rename", { id: entry.id, title })} onFold={flip}
            onRemove={(entry) => run("board.column.remove", { id: entry.id })}
            onOrigin={openRef(onOrigin)} onStudyRef={openRef(onStudyRef)} />)}
          {!readOnly && <NewColumn onAdd={(title) => run("board.column.add", { title }, { optimistic: false })} />}
        </div>}
      </TabPanel>
      <TabPanel id={tabsId} value="archive" selected={activeTab} tabIndex={undefined} className="board-panel">
        <ArchiveList board={board} readOnly={readOnly} library={library} onBack={() => setTab("all")}
          onRestore={async (card) => { if (await run("board.card.restore", { id: card.id })) { onBoardChanged?.(); say(uiFormat("已恢复：{0}", [card.title])); } }}
          onDelete={(card) => setConfirm({ kind: "purge", card })} />
      </TabPanel>
    </>}
    {editingCard && <CardEditor key={editing.id} card={editingCard} board={board} baseRevision={editing.revision} library={library} today={today}
      labelSuggestions={labels.map((entry) => entry.label)} saving={saving} error={message} conflict={conflict} onClose={() => { setEditing(null); clearError?.(); }}
      onSave={async (fields) => { setSaving(true); const ok = await run("board.card.edit", { id: editingCard.id, revision: editing.revision, ...fields }, { optimistic: false }); setSaving(false); if (ok) onBoardChanged?.(); return ok; }}
      onArchive={async (card) => { setEditing(null); await archiveCard(card); }} onDelete={async (card) => { const ok = await deleteCard(card); if (ok) setEditing(null); return ok; }}
      onOrigin={openRef(onOrigin) && ((workspace) => { setEditing(null); return openRef(onOrigin)(workspace); })}
      onStudyRef={openRef(onStudyRef) && ((ref) => { setEditing(null); return openRef(onStudyRef)(ref); })} />}
    {confirm && <DeleteCardDialog card={confirm.card} purge={confirm.kind === "purge"} onClose={() => setConfirm(null)}
      onConfirm={async () => {
        const { card, kind } = confirm;
        if (!(await (kind === "purge" ? run("board.card.remove", { id: card.id }) : deleteCard(card)))) throw new Error(boardRef.current.cards[card.id] || boardRef.current.archived.some((entry) => entry.id === card.id) ? ui("没能删除这张卡片，原因见上方的提示。") : ui("这张卡片已经不在看板上了。"));
      }} />}
    <div className="sh-visually-hidden" role="status" aria-live="polite">{announcement}</div>
  </section>;
}
