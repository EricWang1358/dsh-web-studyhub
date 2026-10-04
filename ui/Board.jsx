import { ui, uiFormat } from "./i18n.js";
import React, { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { useInjectCss } from "./shared.js";
import { usePolling } from "./use-polling.js";
import { Button, EmptyState, Icon, IconButton, InlineMessage, LoadingState, Menu, PageHeader, useToast } from "./components/index.js";
import { doneToggleTarget, filterCards, isFiltering, labelCounts, localDate, locateCard } from "../lib/board-model.js";
import { createBoardStore } from "./board/store.js";
import BoardCard from "./board/Card.jsx";
import Composer from "./board/Composer.jsx";
import CardEditor from "./board/CardEditor.jsx";
import DeleteCardDialog from "./board/DeleteCardDialog.jsx";
import FilterBar from "./board/FilterBar.jsx";
import { boardColumnLabel, cardsText, stamp, studyRefLabel } from "./board/meta.js";
import css from "./board/board.css";

export { boardColumnLabel };

/** One subscription serves both the navigation badge and the visible board. */
export function useBoard(call, visible) {
  const latest = useRef(call);
  latest.current = call;
  const store = useMemo(() => createBoardStore((action, args) => latest.current(action, args)), []);
  const snapshot = useSyncExternalStore(store.subscribe, store.getState, store.getState);
  useEffect(() => {
    store.refresh();
    return () => store.invalidate();
  }, [store, visible]);
  usePolling(() => store.refresh(), { intervalMs: visible ? 5000 : 30000 });
  return useMemo(() => ({ ...snapshot, mutate: store.mutate, refresh: store.refresh, clearError: store.clearError }), [snapshot, store]);
}

const MOVE_KEYS = { left: -1, right: 1 };
const UNDO_TIMEOUT = 8000;
const COLLAPSE_KEY = "study-board-collapsed";
const readCollapsed = () => { try { return new Set(JSON.parse(localStorage.getItem(COLLAPSE_KEY) || "[]")); } catch { return new Set(); } };
const writeCollapsed = (set) => { try { localStorage.setItem(COLLAPSE_KEY, JSON.stringify([...set])); } catch { /* a per-viewer convenience only */ } };
const friendly = (error, conflict) => conflict ? ui("看板已在其他位置更新，已载入最新内容，请再试一次。") : error;

function Column({ column, view, board, today, library, drag, drop, setDrag, setDrop, hasDone, composer, collapsed, filtering, readOnly, labelSuggestions,
  studyRef, onClearStudyRef, onOpenComposer, onCloseComposer, onAdd, onToggleDone, onEdit, onAction, onDropTo, onRename, onFold, onRemove, onOrigin, onStudyRef }) {
  const label = boardColumnLabel(column);
  const shown = view.cardIds;
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
    { id: "remove", label: ui("删除空列"), icon: "trash", danger: true, disabled: column.cardIds.length > 0 || board.columns.length <= 1,
      hint: column.cardIds.length > 0 ? ui("只能删除空列") : undefined },
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
          <input autoFocus aria-label={ui("列名称")} value={name} maxLength={80} onChange={(event) => setName(event.target.value)}
            onKeyDown={(event) => { if (event.key === "Escape") { event.stopPropagation(); setRenaming(false); } }} onBlur={() => setRenaming(false)} />
        </form>
        : <h2 className="board-column__title">{label}</h2>}
      <span className="board-count" aria-label={cardsText(column.cardIds.length)}>{filtering && shown.length !== column.cardIds.length ? `${shown.length}/${column.cardIds.length}` : column.cardIds.length}</span>
      {!readOnly && <Menu label={uiFormat("列设置：{0}", [label])} items={items} className="board-column__menu"
        onSelect={(id) => { if (id === "rename") { setName(column.title); setRenaming(true); } else if (id === "fold") onFold(column); else onRemove(column); }} />}
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
          return <React.Fragment key={id}>
            {showLine(slot) && <div className="board-drop-line" aria-hidden="true" />}
            <BoardCard card={card} column={column} columns={columns} index={column.cardIds.indexOf(id)} count={column.cardIds.length} today={today} library={library}
              readOnly={readOnly} hasDone={hasDone} dragging={drag?.id === id} onToggleDone={onToggleDone} onEdit={onEdit} onAction={onAction}
              onOrigin={onOrigin} onStudyRef={onStudyRef}
              articleProps={{
                onDragStart: (event) => { event.dataTransfer.setData("application/x-study-board-card", id); event.dataTransfer.effectAllowed = "move"; setDrag({ id }); },
                onDragEnd: () => { setDrag(null); setDrop(null); },
              }} />
          </React.Fragment>;
        })}
        {showLine(shown.length) && <div className="board-drop-line" aria-hidden="true" />}
        {!shown.length && !composer && (filtering && column.cardIds.length
          ? <p className="board-column__none">{ui("没有符合筛选的卡片")}</p>
          : <EmptyState size="sm" title={ui("暂无卡片")} description={ui("把卡片拖到这里，或点下面添加。")} />)}
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
  if (!open) return <div className="board-column board-column--new"><Button variant="quiet" size="sm" icon="plus" onClick={() => setOpen(true)}>{ui("新建列")}</Button></div>;
  return <form className="board-column board-column--new is-editing" onSubmit={async (event) => { event.preventDefault(); if (name.trim() && await onAdd(name.trim())) { setName(""); setOpen(false); } }}>
    <input autoFocus aria-label={ui("新列名称")} placeholder={ui("新列名称")} maxLength={80} value={name} onChange={(event) => setName(event.target.value)}
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
          <span className="board-archive-list__title">{card.title}</span>
          <span className="board-archive-list__meta">{uiFormat("更新于 {0}", [stamp(card.updatedAt)])}{card.studyRef ? ` · ${studyRefLabel(card.studyRef, library).text}` : ""}</span>
        </div>
        <Button variant="secondary" size="sm" icon={<Icon name="undo" />} disabled={readOnly || !board.columns.length} onClick={() => onRestore(card)}>{ui("恢复")}</Button>
        <IconButton icon={<Icon name="trash" size={18} />} size="sm" label={uiFormat("永久删除：{0}", [card.title])} disabled={readOnly} onClick={() => onDelete(card)} />
      </li>)}
    </ul>
  </section>;
}

export default function Board({ state, library, today: todayProp, onOrigin, onStudyRef, studyRef, onClearStudyRef, dailyPlan }) {
  useInjectCss(css, "study-board");
  const { board, error, conflict, busy, mutate, refresh, clearError } = state;
  const today = todayProp || localDate();
  const [editing, setEditing] = useState(null);
  const [archive, setArchive] = useState(false);
  const [query, setQuery] = useState({});
  const [filterOpen, setFilterOpen] = useState(false);
  const [composer, setComposer] = useState(() => studyRef && board?.columns?.length ? board.columns[0].id : null);
  const [confirm, setConfirm] = useState(null);
  const [collapsed, setCollapsed] = useState(readCollapsed);
  const [drag, setDrag] = useState(null);
  const [drop, setDrop] = useState(null);
  const toast = useToast();
  const [saving, setSaving] = useState(false);
  const [announcement, setAnnouncement] = useState("");
  const [originError, setOriginError] = useState("");
  const boardRef = useRef(board), focusId = useRef(null), announced = useRef(0);
  boardRef.current = board;

  // A study link handed over from "加入待办" opens the composer with the chip attached.
  useEffect(() => { if (studyRef && boardRef.current?.columns?.length) setComposer(boardRef.current.columns[0].id); }, [studyRef]);
  // Keyboard moves keep focus on the card that moved.
  useEffect(() => {
    if (!focusId.current) return;
    const id = focusId.current;
    const frame = requestAnimationFrame(() => { document.querySelector(`[data-card-id="${CSS.escape(id)}"]`)?.focus({ preventScroll: false }); focusId.current = null; });
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
    const to = locateCard(boardRef.current, id);
    const total = boardRef.current.columns.find((entry) => entry.id === column)?.cardIds.length || 0;
    const message = column === from.column
      ? uiFormat("已移到第 {0} 位（共 {1} 张）", [(to?.index ?? 0) + 1, total])
      : uiFormat("已移到「{0}」：{1}", [columnName(column), title]);
    if (quiet) say(message);
    else offer(message, () => run("board.card.move", { id, column: from.column, index: from.index }));
    return true;
  }, [run, offer, say]);

  const archiveCard = useCallback(async (card) => {
    const from = locateCard(boardRef.current, card.id);
    if (!from || !(await run("board.card.archive", { id: card.id }))) return false;
    offer(uiFormat("已归档：{0}", [card.title]), () => run("board.card.restore", { id: card.id, column: from.column, index: from.index }));
    return true;
  }, [run, offer]);

  const deleteCard = useCallback(async (card) => {
    const now = boardRef.current, from = locateCard(now, card.id);
    const snapshot = structuredClone(now.cards[card.id] || now.archived.find((entry) => entry.id === card.id));
    if (!snapshot || !(await run("board.card.remove", { id: card.id }))) return false;
    if (from) offer(uiFormat("已删除：{0}", [card.title]), () => run("board.card.undelete", { card: snapshot, column: from.column, index: from.index }));
    else say(uiFormat("已删除：{0}", [card.title]));
    return true;
  }, [run, offer, say]);

  const toggleDone = useCallback(async (card) => {
    const target = doneToggleTarget(boardRef.current, card.id);
    if (!target) return;
    const wasDone = !!boardRef.current.columns.find((entry) => entry.cardIds.includes(card.id))?.done;
    const from = locateCard(boardRef.current, card.id);
    if (!(await run("board.card.move", { id: card.id, column: target.column, index: target.index }))) return;
    offer(wasDone ? uiFormat("已移回「{0}」：{1}", [columnName(target.column), card.title]) : uiFormat("已完成：{0}", [card.title]),
      () => run("board.card.move", { id: card.id, column: from.column, index: from.index }));
  }, [run, offer]);

  const onAction = useCallback(async (action, card) => {
    const now = boardRef.current, from = locateCard(now, card.id);
    if (!from) return;
    const position = now.columns.findIndex((entry) => entry.id === from.column);
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
  }, [moveCard, archiveCard]);

  const addCard = useCallback(async (column, fields) => {
    const args = { column: column.id, title: fields.title, labels: fields.labels, ...(fields.note ? { note: fields.note } : {}), ...(fields.due ? { due: fields.due } : {}),
      ...(studyRef ? { studyRef } : {}) };
    const ok = await run("board.card.add", args, { optimistic: false });
    if (ok) { onClearStudyRef?.(); say(uiFormat("已添加到「{0}」：{1}", [boardColumnLabel(column), fields.title])); }
    return ok;
  }, [run, studyRef, onClearStudyRef, say]);

  const openRef = (fn) => fn ? async (value) => { try { setOriginError(""); await fn(value); } catch (e) { setOriginError(e.message); } } : undefined;
  const flip = (column) => setCollapsed((current) => { const next = new Set(current); if (!next.delete(column.id)) next.add(column.id); writeCollapsed(next); return next; });

  const readOnly = !board || !!board.readOnly;
  const filtering = isFiltering(query);
  const view = useMemo(() => board ? filterCards(board, { ...query, today }) : null, [board, query, today]);
  const labels = useMemo(() => board ? labelCounts(board) : [], [board]);
  const total = board ? Object.keys(board.cards).length : 0;
  const matched = view ? view.columns.reduce((sum, column) => sum + column.cardIds.length, 0) : 0;
  const hasDone = !!board?.columns.some((column) => column.done);
  const editingCard = editing && board?.cards[editing.id];
  const message = originError || (board?.readOnly ? board.error : friendly(error, conflict));

  return <section className="page board-page">
    <PageHeader title={ui("待办看板")} eyebrow={ui("所有工作区")} description={ui("所有工作区共用。把想做的事记下来，逐步完成。")}
      actions={<>
        <IconButton icon={<Icon name="sync" size={18} />} label={ui("刷新")} size="sm" disabled={busy} onClick={() => refresh({ force: true })} />
        <Button variant="quiet" size="sm" icon={<Icon name="archive" />} aria-pressed={archive} onClick={() => setArchive(!archive)}>{ui("归档")}{board ? ` (${board.archived.length})` : ""}</Button>
        {!archive && <Button variant="primary" icon="plus" disabled={readOnly || !board?.columns.length} onClick={() => setComposer(board.columns[0].id)}>{ui("添加卡片")}</Button>}
      </>} />
    {message && <InlineMessage tone={board?.readOnly ? "error" : conflict ? "warning" : "error"} boxed onDismiss={board?.readOnly ? undefined : () => { setOriginError(""); clearError?.(); }}>{message}</InlineMessage>}
    {!archive && dailyPlan}
    {!board && <LoadingState className="board-loading" label={ui("正在读取待办…")} />}
    {board && (archive
      ? <ArchiveList board={board} readOnly={readOnly} library={library} onBack={() => setArchive(false)}
        onRestore={async (card) => { if (await run("board.card.restore", { id: card.id })) say(uiFormat("已恢复：{0}", [card.title])); }}
        onDelete={(card) => setConfirm({ kind: "purge", card })} />
      : <>
        {(total > 0 || filtering) && <FilterBar query={query} labels={labels} onChange={setQuery} open={filterOpen} onToggle={() => setFilterOpen(!filterOpen)} matched={matched} total={total} />}
        {total === 0 && !archive && <EmptyState icon="check" title={ui("还没有待办")} className="board-empty"
          description={ui("把想做的事记在这里。在复习、题目或学习流里点「加入待办」，会把当前内容一起记下来。")}
          primary={{ label: ui("添加第一张卡片"), icon: "plus", disabled: readOnly, onClick: () => setComposer(board.columns[0].id) }} />}
        {filtering && matched === 0 && total > 0 && <EmptyState size="sm" icon={<Icon name="search" size={22} />} title={ui("没有符合筛选的卡片")} className="board-empty"
          secondary={{ label: ui("清除筛选"), onClick: () => setQuery({}) }} />}
        <div className="board-columns" style={{ "--board-cols": board.columns.length }}>
          {view.columns.map((column, at) => <Column key={column.id} column={board.columns[at]} view={column} board={board} today={today} library={library} drag={drag} drop={drop}
            setDrag={setDrag} setDrop={setDrop} hasDone={hasDone} composer={composer === column.id} collapsed={collapsed.has(column.id)} filtering={filtering} readOnly={readOnly}
            labelSuggestions={labels.map((entry) => entry.label)} studyRef={studyRef} onClearStudyRef={onClearStudyRef}
            onOpenComposer={setComposer} onCloseComposer={() => setComposer(null)} onAdd={addCard} onToggleDone={toggleDone} onEdit={(card) => onAction("edit", card)} onAction={onAction}
            onDropTo={(id, target, index) => moveCard(id, target, index)}
            onRename={(entry, title) => run("board.column.rename", { id: entry.id, title })} onFold={flip}
            onRemove={(entry) => run("board.column.remove", { id: entry.id })}
            onOrigin={openRef(onOrigin)} onStudyRef={openRef(onStudyRef)} />)}
          {!readOnly && <NewColumn onAdd={(title) => run("board.column.add", { title }, { optimistic: false })} />}
        </div>
      </>)}
    {editingCard && <CardEditor key={editing.id} card={editingCard} board={board} baseRevision={editing.revision} library={library} today={today}
      labelSuggestions={labels.map((entry) => entry.label)} saving={saving} error={message} conflict={conflict} onClose={() => { setEditing(null); clearError?.(); }}
      onSave={async (fields) => { setSaving(true); const ok = await run("board.card.edit", { id: editingCard.id, revision: editing.revision, ...fields }, { optimistic: false }); setSaving(false); return ok; }}
      onArchive={async (card) => { setEditing(null); await archiveCard(card); }} onDelete={async (card) => { const ok = await deleteCard(card); if (ok) setEditing(null); return ok; }}
      onOrigin={openRef(onOrigin) && ((workspace) => { setEditing(null); return openRef(onOrigin)(workspace); })}
      onStudyRef={openRef(onStudyRef) && ((ref) => { setEditing(null); return openRef(onStudyRef)(ref); })} />}
    {confirm && <DeleteCardDialog card={confirm.card} purge={confirm.kind === "purge"} onClose={() => setConfirm(null)}
      onConfirm={async () => {
        const { card, kind } = confirm;
        if (!(await (kind === "purge" ? run("board.card.remove", { id: card.id }) : deleteCard(card)))) throw new Error(ui("没有完成，请再试一次。"));
      }} />}
    <div className="sh-visually-hidden" role="status" aria-live="polite">{announcement}</div>
  </section>;
}
