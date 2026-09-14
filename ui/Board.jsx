import React, { useCallback, useEffect, useRef, useState } from "react";
import Markdown from "./Markdown.jsx";
import { useInjectCss } from "./shared.js";
import css from "./views.css";

// One subscription serves both the navigation badge and the visible board.
export function useBoard(call, visible) {
  const [board, setBoard] = useState(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const current = useRef(null), sequence = useRef(0), writing = useRef(false), reading = useRef(false);
  const accept = useCallback((next) => {
    if (!next.unchanged) {
      current.current = next;
      setBoard(next);
    }
  }, []);
  const refresh = useCallback(async () => {
    if (writing.current || reading.current) return;
    reading.current = true;
    const ticket = ++sequence.current;
    try {
      const next = await call("board.get", current.current && !current.current.readOnly
        ? { since: current.current.revision } : {});
      if (ticket === sequence.current) accept(next);
    } catch (e) {
      if (ticket === sequence.current) setError(e.message);
    } finally {
      reading.current = false;
    }
  }, [call, accept]);
  const invalidate = useCallback(() => { sequence.current++; }, []);
  useEffect(() => {
    refresh();
    const timer = setInterval(() => {
      if (!document.hidden) refresh();
    }, visible ? 5000 : 30000);
    return () => { clearInterval(timer); invalidate(); };
  }, [refresh, visible, invalidate]);
  const mutate = async (action, args = {}) => {
    if (writing.current || !current.current || current.current.readOnly) return false;
    writing.current = true;
    sequence.current++;
    setBusy(true);
    setError("");
    let succeeded = false;
    try {
      accept(await call(action, { revision: current.current.revision, ...args }));
      succeeded = true;
      return true;
    } catch (e) {
      setError(e.message);
      return false;
    } finally {
      writing.current = false;
      setBusy(false);
      if (!succeeded) refresh();
    }
  };
  return { board, error, busy, mutate, refresh };
}

function CardEditor({ card, revision, board, busy, error, mutate, onClose }) {
  const dialog = useRef(null);
  const [draft, setDraft] = useState(() => ({ ...card, labels: (card.labels || []).join(", ") }));
  const [base, setBase] = useState(revision);
  const stale = board.revision !== base;
  const latest = board.cards[card.id];
  useEffect(() => {
    const element = dialog.current;
    element.showModal();
    return () => element.close();
  }, []);
  const field = (key) => (e) => setDraft((d) => ({ ...d, [key]: e.target.value }));
  return <dialog ref={dialog} className="board-dialog" aria-labelledby="board-editor-title"
    onCancel={(e) => { e.preventDefault(); if (!busy) onClose(); }}>
    <form onSubmit={async (e) => {
      e.preventDefault();
      if (await mutate("board.card.edit", { id: card.id, revision: base, title: draft.title,
        note: draft.note, due: draft.due, labels: draft.labels.split(/[,，]/).map((s) => s.trim()).filter(Boolean) })) onClose();
    }}>
      <header><h2 id="board-editor-title">编辑待办</h2><button type="button" disabled={busy} onClick={onClose} aria-label="关闭编辑">×</button></header>
      {error && <p role="alert" className="wb-error">{error}</p>}
      <fieldset disabled={busy || board.readOnly}>
        <label>标题<input autoFocus required maxLength={200} value={draft.title} onChange={field("title")} /></label>
        <label>备注 · 支持 Markdown<textarea rows={6} maxLength={20000} value={draft.note || ""} onChange={field("note")} /></label>
        {draft.note && <details><summary>预览备注</summary><Markdown text={draft.note} /></details>}
        <label>截止日期<input type="date" value={draft.due || ""} onChange={field("due")} /></label>
        <label>标签 · 用逗号分隔<input value={draft.labels} onChange={field("labels")} maxLength={500} /></label>
        {stale && <div className="board-conflict" role="status">
          看板已在其他位置更新。你的输入仍保留；请先查看最新卡片再编辑。
          {latest ? <button type="button" onClick={() => {
            setDraft({ ...latest, labels: (latest.labels || []).join(", ") }); setBase(board.revision);
          }}>载入最新卡片（替换当前输入）</button> : <p>这张卡片已被移除或归档。</p>}
        </div>}
      </fieldset>
      <footer><button type="button" disabled={busy} onClick={onClose}>取消</button><button className="primary" disabled={busy || stale || board.readOnly}>保存</button></footer>
    </form>
  </dialog>;
}

function BoardColumn({ column, board, today, busy, mutate, onEdit, onOrigin }) {
  const [title, setTitle] = useState("");
  const [renaming, setRenaming] = useState(false);
  const [name, setName] = useState(column.title);
  const [over, setOver] = useState(false);
  const position = board.columns.findIndex((c) => c.id === column.id);
  const disabled = busy || board.readOnly;
  const move = (id, target, index) => mutate("board.card.move", { id, column: target, index });
  const drop = (e, index) => {
    e.preventDefault(); e.stopPropagation(); setOver(false);
    const id = e.dataTransfer.getData("application/x-study-board-card");
    if (!board.cards[id] || disabled) return;
    // Drop before a card; account for the removed source slot in this column.
    const from = column.cardIds.indexOf(id);
    move(id, column.id, from >= 0 && from < index ? index - 1 : index);
  };
  return <section className={`board-column${over ? " is-over" : ""}`} aria-label={column.title}
    onDragOver={(e) => { if (!disabled) { e.preventDefault(); setOver(true); } }}
    onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget)) setOver(false); }}
    onDrop={(e) => drop(e, column.cardIds.length)}>
    <header className="board-column-heading">
      <span className={column.done ? "board-dot is-done" : "board-dot"} />
      <h2>{column.title}</h2><span className="board-count">{column.cardIds.length}</span>
      <button disabled={disabled} aria-label={`设置列 ${column.title}`} title="重命名或删除空列" onClick={() => { setName(column.title); setRenaming(!renaming); }}>···</button>
    </header>
    {renaming && <form className="board-column-settings" onSubmit={async (e) => {
      e.preventDefault(); if (await mutate("board.column.rename", { id: column.id, title: name })) setRenaming(false);
    }}>
      <input aria-label="列名称" value={name} onChange={(e) => setName(e.target.value)} required maxLength={80} disabled={disabled} />
      <button disabled={disabled}>保存列名</button>
      <button type="button" disabled={disabled || !!column.cardIds.length || board.columns.length <= 1} onClick={() => mutate("board.column.remove", { id: column.id })}>删除空列</button>
    </form>}
    <div className="board-cards">
      {column.cardIds.map((id, index) => {
        const card = board.cards[id];
        const overdue = card.due && !column.done && card.due < today;
        return <article key={id} className="board-card" draggable={!disabled}
          onDragStart={(e) => { e.dataTransfer.setData("application/x-study-board-card", id); e.dataTransfer.effectAllowed = "move"; }}
          onDrop={(e) => drop(e, index)}>
          <button className="board-card-title" disabled={disabled} onClick={() => onEdit(card)}>{card.title}</button>
          {card.note && <p className="board-note">{card.note}</p>}
          {!!card.labels?.length && <div className="board-labels">{card.labels.map((label) => <span key={label}>{label}</span>)}</div>}
          {card.due && <small className={overdue ? "board-due is-overdue" : "board-due"}>{overdue ? "已逾期 · " : "截止 · "}{card.due}</small>}
          {card.origin?.workspace && <button className="board-origin" title={card.origin.workspace} disabled={!onOrigin} onClick={() => onOrigin?.(card.origin.workspace)}>{card.origin.workspaceTitle || card.origin.workspace} ↗</button>}
          <div className="board-card-controls" role="group" aria-label={`移动 ${card.title}`}>
            <button aria-label={`左移 ${card.title}`} disabled={disabled || position === 0} onClick={() => move(id, board.columns[position - 1].id)}>←</button>
            <button aria-label={`右移 ${card.title}`} disabled={disabled || position === board.columns.length - 1} onClick={() => move(id, board.columns[position + 1].id)}>→</button>
            <button aria-label={`上移 ${card.title}`} disabled={disabled || index === 0} onClick={() => move(id, column.id, index - 1)}>↑</button>
            <button aria-label={`下移 ${card.title}`} disabled={disabled || index === column.cardIds.length - 1} onClick={() => move(id, column.id, index + 1)}>↓</button>
            <button className="board-archive" disabled={disabled} onClick={() => mutate("board.card.archive", { id })}>归档</button>
          </div>
        </article>;
      })}
      {!column.cardIds.length && <p className="board-empty">暂无卡片<br /><small>添加待办，或将卡片拖到这里</small></p>}
    </div>
    <form className="board-add" onSubmit={async (e) => {
      e.preventDefault(); if (await mutate("board.card.add", { column: column.id, title })) setTitle("");
    }}>
      <input aria-label={`添加卡片到${column.title}`} placeholder="＋ 添加卡片" value={title} onChange={(e) => setTitle(e.target.value)} required maxLength={200} disabled={disabled} />
      {title && <button disabled={disabled || !title.trim()}>添加</button>}
    </form>
  </section>;
}

export default function Board({ state, onOrigin }) {
  useInjectCss(css, "study-views");
  const { board, error, busy, mutate, refresh } = state;
  const [editing, setEditing] = useState(null);
  const [columnTitle, setColumnTitle] = useState("");
  const [archive, setArchive] = useState(false);
  const [originError, setOriginError] = useState("");
  const today = new Date().toLocaleDateString("sv-SE");
  return <section className="page board-page">
    <div className="page-heading"><div><div className="eyebrow">ACROSS WORKSPACES</div><h1>待办看板</h1><p className="muted">所有工作区共用。把想做的事记下来，逐步完成。</p></div>
      <div className="board-actions"><button onClick={refresh} disabled={busy}>刷新</button><button onClick={() => setArchive(!archive)} aria-pressed={archive}>归档{board ? ` (${board.archived.length})` : ""}</button></div>
    </div>
    {(error || board?.error || originError) && <p role="alert" className="wb-error">{originError || board?.error || error}</p>}
    {!board && <p className="muted">正在读取待办…</p>}
    {board && <>
      {archive ? <section className="board-archive-list" aria-label="已归档卡片">
        <h2>已归档</h2><p className="muted">恢复后会回到第一列。</p>
        {!board.archived.length && <p>没有已归档的卡片。</p>}
        {board.archived.map((card) => <article key={card.id}><span>{card.title}</span><button disabled={busy || board.readOnly || !board.columns.length} onClick={() => mutate("board.card.restore", { id: card.id })}>恢复</button></article>)}
      </section> : <>
        <div className="board-columns">{board.columns.map((column) => <BoardColumn key={column.id} column={column} board={board} today={today} busy={busy} mutate={mutate}
          onEdit={(card) => setEditing({ card, revision: board.revision })}
          onOrigin={onOrigin ? async (workspace) => { try { setOriginError(""); await onOrigin(workspace); } catch (e) { setOriginError(e.message); } } : undefined} />)}</div>
        <form className="board-new-column" onSubmit={async (e) => { e.preventDefault(); if (await mutate("board.column.add", { title: columnTitle })) setColumnTitle(""); }}>
          <input aria-label="新列名称" placeholder="新列名称" maxLength={80} required value={columnTitle} disabled={busy || board.readOnly} onChange={(e) => setColumnTitle(e.target.value)} />
          <button disabled={busy || board.readOnly || !columnTitle.trim()}>＋ 添加列</button>
        </form>
      </>}
      {editing && <CardEditor {...editing} board={board} busy={busy} error={error} mutate={mutate} onClose={() => setEditing(null)} />}
    </>}
  </section>;
}
