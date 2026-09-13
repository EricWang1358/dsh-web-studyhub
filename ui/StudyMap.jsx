import React, { useEffect, useMemo, useState } from "react";
import { LEVEL_LABEL } from "./shared.js";

const BAR_ORDER = ["mastered", "familiar", "learning", "weak", "new"];
const topicKey = (deckId, topic) => JSON.stringify([deckId, topic || ""]);
const scopeOf = (keys) =>
  [...keys].map((k) => {
    const [deckId, topic] = JSON.parse(k);
    return topic ? { deckId, topic } : { deckId };
  });
const sameScope = (a = [], b = []) =>
  a.length === b.length &&
  a.every((x) => b.some((y) => y.deckId === x.deckId && (y.topic || "") === (x.topic || "")));

function dotLevel(node) {
  if (node.status === "todo") return "new";
  if (node.status === "done") return "mastered";
  if (node.counts.weak) return "weak";
  return node.mastery >= 60 ? "familiar" : "learning";
}
function mergeProgress(list) {
  const counts = Object.fromEntries(BAR_ORDER.map((l) => [l, 0]));
  let total = 0,
    weighted = 0,
    due = 0;
  for (const p of list) {
    for (const l of BAR_ORDER) counts[l] += p.counts[l];
    total += p.total ?? BAR_ORDER.reduce((n, l) => n + p.counts[l], 0);
    weighted += p.mastery * (p.total ?? 0);
    due += p.due;
  }
  return {
    counts,
    total,
    due,
    mastery: total ? Math.round(weighted / total) : 0,
    status: !total || counts.new === total ? "todo" : "active",
  };
}
/* Donut showing mastery 0–100. Pure CSS conic-gradient driven by --p. */
function MasteryRing({ value, title }) {
  return (
    <span
      className="ring"
      style={{ "--p": Math.max(0, Math.min(100, value || 0)) }}
      title={title}
      role="img"
      aria-label={title || `掌握度 ${value || 0}%`}
    >
      <span>{value || 0}</span>
    </span>
  );
}

function MasteryBar({ node }) {
  const total = BAR_ORDER.reduce((n, l) => n + node.counts[l], 0);
  const label = BAR_ORDER.filter((l) => node.counts[l])
    .map((l) => `${LEVEL_LABEL[l]} ${node.counts[l]}`)
    .join(" · ") || "暂无题目";
  let seen = 0;
  return (
    <span className="mastery" title={label}>
      <span
        className={total > 0 ? "mastery-bar" : "mastery-bar empty"}
        aria-hidden="true"
      >
        {BAR_ORDER.map((l) => {
          if (!node.counts[l]) return null;
          /* Stagger each segment so the bar fills left-to-right on mount. */
          const delay = `${seen * 90}ms`;
          seen += 1;
          return (
            <span
              key={l}
              className={"lv-" + l}
              style={{
                flexGrow: node.counts[l],
                animationDelay: delay,
              }}
            />
          );
        })}
      </span>
      <span
        className={
          total > 0 && node.mastery > 0 ? "mastery-value" : "mastery-value zero"
        }
      >
        {total > 0 ? `${node.mastery}%` : "—"}
      </span>
    </span>
  );
}
function readExpanded(root) {
  try {
    const saved = localStorage.getItem(`study-map-open:${root}`);
    return saved ? new Set(JSON.parse(saved)) : null;
  } catch {
    return null;
  }
}

export default function StudyMap({
  data,
  busy,
  start,
  resume,
  endRun,
  manage,
  openDraft,
  addSource,
  createManual,
  importLibrary,
  askInChat,
  theme = "auto",
  setTheme,
  notebooks,
  onNotebookPublish,
  onNotebookUnpublish,
  onNotebookOpen,
  refreshNotebooks,
  onNotebookSearch,
  onShowGraph,
  children,
}) {
  const [search, setSearch] = useState(""),
    [showArchived, setShowArchived] = useState(false),
    [selected, setSelected] = useState(() => new Set()),
    [menu, setMenu] = useState(null),
    [expanded, setExpanded] = useState(
      () =>
        readExpanded(data.root) ||
        new Set([
          ...data.decks.map((d) => "folder:" + d.folder),
          ...(data.decks.length <= 3 ? data.decks.map((d) => d.id) : []),
        ]),
    );
  useEffect(() => {
    try {
      localStorage.setItem(
        `study-map-open:${data.root}`,
        JSON.stringify([...expanded]),
      );
    } catch {}
  }, [data.root, expanded]);
  useEffect(() => {
    if (!menu) return;
    const close = (e) => {
      if (!e.target.closest?.(".map-menu, .map-menu-toggle")) setMenu(null);
    };
    document.addEventListener("pointerdown", close);
    return () => document.removeEventListener("pointerdown", close);
  }, [menu]);

  const progress = data.progress || {},
    today = data.today || { due: 0, weak: 0, new: 0, size: 0 },
    runs = data.runs || [];
  /* Weighted mastery across active decks. Deck rows carry no mastery of their
     own in the snapshot; the per-deck figures live on `progress`. */
  const overall = useMemo(() => {
    const rows = data.decks
      .filter((d) => !d.archived)
      .map((d) => progress[d.id])
      .filter((p) => p && p.total);
    const total = rows.reduce((n, p) => n + p.total, 0);
    if (!total) return null;
    return Math.round(
      rows.reduce((n, p) => n + (p.mastery || 0) * p.total, 0) / total,
    );
  }, [data.decks, progress]);
  const runFor = (scope) =>
    runs.find((r) => r.mode === "path" && sameScope(r.scope, scope));
  const todayRun = runFor([]);
  const query = search.trim().toLowerCase();
  const visible = data.decks.filter((d) => {
    if (!!d.archived !== showArchived) return false;
    if (!query) return true;
    return `${d.title} ${d.folder} ${d.topics.join(" ")}`
      .toLowerCase()
      .includes(query);
  });
  const folders = useMemo(() => {
    const groups = new Map();
    for (const d of visible) {
      if (!groups.has(d.folder)) groups.set(d.folder, []);
      groups.get(d.folder).push(d);
    }
    return [...groups];
  }, [visible]);

  const toggleOpen = (id) =>
    setExpanded((v) => {
      const next = new Set(v);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  const isOpen = (id) => !!query || expanded.has(id);
  function toggleSelect(keys, on) {
    setSelected((v) => {
      const next = new Set(v);
      for (const k of keys) on ? next.add(k) : next.delete(k);
      // A whole deck supersedes its individual topics.
      for (const k of keys) {
        const [deckId, topic] = JSON.parse(k);
        if (!topic && on)
          for (const other of [...next])
            if (other !== k && JSON.parse(other)[0] === deckId)
              next.delete(other);
      }
      return next;
    });
  }
  const scope = scopeOf(selected);
  const selectedRun = scope.length ? runFor(scope) : null;

  function deckRow(d, i = 0) {
    const p = progress[d.id],
      key = topicKey(d.id),
      whole = selected.has(key),
      run = runFor([{ deckId: d.id }]),
      open = isOpen(d.id);
    return (
      <li
        key={d.id}
        className={"map-deck" + (menu === d.id ? " menu-open" : "")}
        style={{ "--i": i }}
      >
        <div className={"map-row deck-row" + (whole ? " selected" : "")}>
          <button
            className="map-caret"
            aria-expanded={open}
            aria-label={open ? "收起" : "展开"}
            onClick={() => toggleOpen(d.id)}
          >
            {open ? "▾" : "▸"}
          </button>
          <input
            type="checkbox"
            aria-label={`选择题组 ${d.title}`}
            checked={whole}
            disabled={d.archived}
            onChange={(e) => toggleSelect([key], e.target.checked)}
          />
          <span className={"map-dot lv-" + (p ? dotLevel(p) : "new")} />
          <button className="map-name" onClick={() => toggleOpen(d.id)}>
            <strong>{d.title}</strong>
            <small>
              {d.available} 题
              {p?.due ? ` · ${p.due} 待复习` : ""}
              {d.wrong ? ` · ${d.wrong} 错题` : ""}
              {d.archived ? " · 已归档" : ""}
            </small>
          </button>
          {p && <MasteryBar node={p} />}
          <button
            className="map-play"
            disabled={busy || d.archived || !d.available}
            title={run ? `继续 ${run.index + 1}/${run.total}` : "按学习路径开始"}
            aria-label={`开始学习 ${d.title}`}
            onClick={() =>
              run ? resume(run.id) : start({ mode: "path", scope: [{ deckId: d.id }] })
            }
          >
            {run ? "继续" : "▶"}
          </button>
          <span className="map-menu-wrap">
            <button
              className="map-menu-toggle"
              aria-label="更多操作"
              aria-expanded={menu === d.id}
              onClick={() => setMenu(menu === d.id ? null : d.id)}
            >
              ⋯
            </button>
            {menu === d.id && (
              <div className="map-menu" role="menu">
                {[
                  ["闪卡翻看", () => start({ deckId: d.id, mode: "flashcard" }), !d.available],
                  ["测验", () => start({ deckId: d.id, mode: "quiz" }), !d.quizCount],
                  [`错题重练 ${d.wrong || 0}`, () => start({ deckId: d.id, mode: "wrong" }), !d.wrong],
                  [
                    "在对话中分析",
                    () =>
                      askInChat(
                        `请用 study_workspace 查看题组「${d.title}」的掌握情况（map），告诉我哪些主题最薄弱，并安排接下来的学习顺序。`,
                      ),
                    false,
                  ],
                  ["管理题组", () => manage(d.id), false],
                ].map(([label, run, disabled]) => (
                  <button
                    key={label}
                    role="menuitem"
                    disabled={busy || disabled || (d.archived && label !== "管理题组")}
                    onClick={() => {
                      setMenu(null);
                      run();
                    }}
                  >
                    {label}
                  </button>
                ))}
              </div>
            )}
          </span>
        </div>
        {open && p?.topics.length > 0 && (
          <ul className="map-topics">
            {p.topics.map((t) => {
              const k = topicKey(d.id, t.name),
                level = dotLevel(t),
                topicRun = runFor([{ deckId: d.id, topic: t.name }]);
              return (
                <li
                  key={t.name}
                  className={"map-row topic-row" + (whole || selected.has(k) ? " selected" : "")}
                >
                  <input
                    type="checkbox"
                    aria-label={`选择主题 ${t.name}`}
                    checked={whole || selected.has(k)}
                    disabled={whole || d.archived}
                    onChange={(e) => toggleSelect([k], e.target.checked)}
                  />
                  <span className={"map-dot lv-" + level} title={LEVEL_LABEL[level]} />
                  <span className="map-name">
                    <span>{t.name}</span>
                    <small>
                      {t.total} 题 · {t.due ? `${t.due} 待复习` : LEVEL_LABEL[level]}
                    </small>
                  </span>
                  <MasteryBar node={t} />
                  <button
                    className="map-play"
                    disabled={busy || d.archived}
                    aria-label={`学习主题 ${t.name}`}
                    title={topicRun ? `继续 ${topicRun.index + 1}/${topicRun.total}` : "学习这个主题"}
                    onClick={() =>
                      topicRun
                        ? resume(topicRun.id)
                        : start({ mode: "path", scope: [{ deckId: d.id, topic: t.name }] })
                    }
                  >
                    {topicRun ? "继续" : "▶"}
                  </button>
                  <button
                    className="map-ask"
                    title="在对话中讲解这个主题"
                    aria-label={`在对话中讲解 ${t.name}`}
                    onClick={() =>
                      askInChat(
                        `请结合学习库里的资料，给我讲解「${t.name}」（题组「${d.title}」）。我目前掌握度 ${t.mastery}%${t.counts.weak ? `，有 ${t.counts.weak} 道题答错过` : ""}。先讲核心概念，再用一两道小问题检查我是否理解。`,
                      )
                    }
                  >
                    问
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </li>
    );
  }

  const headline = !data.decks.length
    ? "从一份资料开始"
    : today.ahead
      ? "今天的任务都完成了"
      : [
          today.due && `${today.due} 道待复习`,
          today.weak && `${today.weak} 道薄弱`,
          today.new && `${today.new} 道新题`,
        ]
          .filter(Boolean)
          .join(" · ") || "暂无可学习的题目";

  return (
    <section className="page library-page map-page">
      {children}
      <div className="today">
        <div className="today-main">
          <div className="eyebrow">今日学习</div>
          <h1>{headline}</h1>
          <p className="muted">
            {data.next
              ? `推荐下一步：${data.next.deckTitle} › ${data.next.topic}（掌握 ${data.next.mastery}%）`
              : data.decks.length
                ? "所有主题都已掌握，可以提前巩固。"
                : "添加讲义或笔记，生成题组后这里会给出学习路径。"}
          </p>
          <p className="path-hint">
            <span>
              复习到期 → 补薄弱 → 按目录学新题，不会的题用{" "}
              <code>/study-spar 问题</code> 自动归类
            </span>
          </p>
        </div>
        {overall != null && (
          <MasteryRing value={overall} title={`整体掌握度 ${overall}%`} />
        )}
        <div className="today-actions">
          {setTheme && (
            <button
              className="icon-btn"
              aria-label="切换主题"
              title={
                theme === "auto"
                  ? "主题：跟随系统"
                  : theme === "dark"
                    ? "主题：暗色"
                    : "主题：亮色"
              }
              onClick={() =>
                setTheme(
                  theme === "auto" ? "dark" : theme === "dark" ? "light" : "auto",
                )
              }
            >
              {theme === "auto" ? "◐" : theme === "dark" ? "☾" : "☀"}
            </button>
          )}
          {data.decks.length ? (
            <>
              <button
                className="primary start"
                disabled={busy || (!todayRun && !today.size)}
                onClick={() =>
                  todayRun ? resume(todayRun.id) : start({ mode: "path" })
                }
              >
                {todayRun
                  ? `▶ 继续学习 ${todayRun.index + 1}/${todayRun.total}`
                  : today.ahead
                    ? `▶ 提前巩固 · ${today.size} 题`
                    : `▶ 开始学习 · ${today.size} 题`}
              </button>
              {data.next && (
                <button
                  disabled={busy}
                  onClick={() =>
                    start({
                      mode: "path",
                      scope: [{ deckId: data.next.deckId, topic: data.next.topic }],
                    })
                  }
                >
                  只学推荐主题
                </button>
              )}            </>
          ) : (
            <>
              <button className="primary start" onClick={addSource}>
                ＋ 添加资料
              </button>
              <button
                onClick={() =>
                  askInChat(
                    "请读取工作区里的 `<文件路径>`，用 study_workspace 添加为学习资料，并生成 10 道题。",
                  )
                }
              >
                在对话中用工作区文件出题
              </button>
            </>
          )}
        </div>
      </div>

      {runs.filter((r) => r !== todayRun).length > 0 && (
        <div className="resume-list">
          {runs
            .filter((r) => r !== todayRun)
            .map((r) => (
              <div className="resume-row" key={r.id}>
                <button className="resume" disabled={busy} onClick={() => resume(r.id)}>
                  <span>
                    <span className="eyebrow">继续上次学习</span>
                    <strong>{r.title}</strong>
                  </span>
                  <span>
                    {r.index + 1} / {r.total} <b>→</b>
                  </span>
                </button>
                <button
                  className="ghost-btn"
                  disabled={busy}
                  onClick={() => endRun(r.id)}
                  title="结束此轮，保留已答记录"
                >
                  结束
                </button>
              </div>
            ))}
        </div>
      )}

      <div className="section-heading map-heading">
        <h2>
          学习目录 <span>{data.decks.filter((d) => !d.archived).length}</span>
        </h2>
        <div className="section-heading-actions">
          <button onClick={addSource}>＋ 资料</button>
          <button disabled={!data.sources.length} onClick={createManual}>
            手工建卡
          </button>
          <button onClick={importLibrary}>导入</button>
          <button
            disabled={busy}
            title="把整个学习库（或在目录中勾选的范围）生成横向分叉的知识结构图 / 学习路径图"
            onClick={() => onShowGraph?.([])}
          >
            查看图谱
          </button>
        </div>
      </div>
      {data.decks.length > 0 && (
        <div className="map-toolbar">
          <div className="map-tools">
            <input
              type="search"
              aria-label="搜索题组或主题"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="搜索题组、目录或主题"
            />
            <button
              className={showArchived ? "chip active" : "chip"}
              aria-pressed={showArchived}
              onClick={() => setShowArchived((v) => !v)}
            >
              已归档
            </button>
          </div>
          <div className="map-legend" aria-label="掌握程度图例">
            {BAR_ORDER.map((l) => (
              <span key={l}>
                <i className={"lv-" + l} />
                {LEVEL_LABEL[l]}
              </span>
            ))}
          </div>
        </div>
      )}
      {visible.length ? (
        <ul className="map-tree">
          {folders.map(([folder, decks]) =>
            folder ? (
              <li
                key={"folder:" + folder}
                className={"map-folder" + (decks.some((d) => d.id === menu) ? " menu-open" : "")}
              >
                <div className="map-row folder-row">
                  <button
                    className="map-caret"
                    aria-expanded={isOpen("folder:" + folder)}
                    onClick={() => toggleOpen("folder:" + folder)}
                  >
                    {isOpen("folder:" + folder) ? "▾" : "▸"}
                  </button>
                  <input
                    type="checkbox"
                    aria-label={`选择目录 ${folder}`}
                    checked={decks.every((d) => selected.has(topicKey(d.id)))}
                    onChange={(e) =>
                      toggleSelect(
                        decks.filter((d) => !d.archived).map((d) => topicKey(d.id)),
                        e.target.checked,
                      )
                    }
                  />
                  <span className="map-folder-icon">▤</span>
                  <button className="map-name" onClick={() => toggleOpen("folder:" + folder)}>
                    <strong>{folder}</strong>
                    <small>{decks.length} 个题组</small>
                  </button>
                  <MasteryBar
                    node={mergeProgress(decks.map((d) => progress[d.id]).filter(Boolean))}
                  />
                </div>
                {isOpen("folder:" + folder) && (
                  <ul className="map-children">{decks.map((d, i) => deckRow(d, i))}</ul>
                )}
              </li>
            ) : (
              decks.map((d, i) => deckRow(d, i))
            ),
          )}
        </ul>
      ) : data.decks.length ? (
        <p className="muted map-empty">没有符合条件的题组。</p>
      ) : (
        <div className="empty">
          <span className="empty-icon">▧</span>
          <h2>你的第一组好题，从资料开始</h2>
          <p>添加讲义或笔记，生成题组后会在这里形成带掌握度的学习目录。</p>
        </div>
      )}

      <NotebookDirectory
        notebooks={notebooks}
        busy={busy}
        onPublish={onNotebookPublish}
        onUnpublish={onNotebookUnpublish}
        onOpen={onNotebookOpen}
        refresh={refreshNotebooks}
        onSearch={onNotebookSearch}
      />

      {scope.length > 0 && (
        <div className="selection-bar" role="region" aria-label="已选内容">
          <span>
            已选 {scope.length} 项
          </span>
          <button onClick={() => setSelected(new Set())}>清除</button>
          <button
            disabled={busy}
            title="把所选范围生成横向分叉的知识结构图或学习路径图"
            onClick={() => onShowGraph?.(scopeOf(selected))}
          >
            查看图谱
          </button>
          <button
            className="primary"
            disabled={busy}
            onClick={() =>
              selectedRun ? resume(selectedRun.id) : start({ mode: "path", scope })
            }
          >
            {selectedRun
              ? `▶ 继续 ${selectedRun.index + 1}/${selectedRun.total}`
              : "▶ 学习所选内容"}
          </button>
        </div>
      )}

      {data.drafts.length > 0 && (
        <>
          <div className="section-heading">
            <h2>
              待审阅 <span>{data.drafts.length}</span>
            </h2>
            <small>确认内容后进入目录</small>
          </div>
          {data.drafts.map((d) => (
            <button key={d.id} className="draft-row" onClick={() => openDraft(d)}>
              <span>
                <strong>{d.title}</strong>
                <small>
                  {d.cards.length} 道题 · {d.quality?.warnings?.length || 0} 项质量提醒
                </small>
              </span>
              <span>审阅 →</span>
            </button>
          ))}
        </>
      )}
      {data.jobs?.length > 0 && (
        <div className="jobs">
          {data.jobs.slice(-3).map((j) => (
            <div className={"job " + j.status} key={j.id}>
              <span>
                {j.status === "running" ? "◌" : j.status === "queued" ? "…" : j.status === "failed" ? "!" : "✓"}
              </span>
              <div>
                <strong>
                  {j.status === "running"
                    ? "正在生成题组"
                    : j.status === "queued"
                      ? "排队中"
                      : j.status === "failed"
                        ? "生成未完成"
                        : "草稿已生成"}
                  {j.parts > 1 ? ` · 分 ${j.parts} 段` : ""}
                </strong>
                <small>{j.stage}</small>
              </div>
              {j.draftId && data.drafts.some((d) => d.id === j.draftId) && (
                <button onClick={() => openDraft(data.drafts.find((d) => d.id === j.draftId))}>
                  打开
                </button>
              )}
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

/* Cross-workspace notebook directory. Entries are links, not copies: each
   published notebook's study data stays in its own workspace, and clicking a
   foreign entry opens a fresh conversation there. */
function NotebookDirectory({ notebooks, busy, onPublish, onUnpublish, onOpen, refresh, onSearch }) {
  const [open, setOpen] = useState(() => {
    try {
      return localStorage.getItem("study-nb-dir-open") !== "0";
    } catch {
      return true;
    }
  });
  const [query, setQuery] = useState(""),
    [searching, setSearching] = useState(false),
    [results, setResults] = useState(null);
  const list = notebooks?.notebooks || [];
  /* Global due queue: every published notebook's due decks, due first. */
  const dueRows = useMemo(() => {
    const rows = [];
    for (const n of list)
      for (const d of n.decks || [])
        if (!d.archived && d.due > 0) rows.push({ n, d });
    return rows.sort((a, b) => b.d.due - a.d.due).slice(0, 8);
  }, [list]);
  if (!notebooks) return null;
  const current = list.find((n) => n.current),
    others = list.filter((n) => !n.current),
    published = list.filter((n) => n.publishedAt).length;
  const toggle = () =>
    setOpen((v) => {
      try {
        localStorage.setItem("study-nb-dir-open", v ? "0" : "1");
      } catch {}
      return !v;
    });
  const stats = (n) =>
    n.exists
      ? `${n.deckCount} 个题组${n.dueToday ? ` · ${n.dueToday} 道到期` : ""}`
      : "学习库目录已不可访问";
  const topics = (n) =>
    n.decks
      .filter((d) => !d.archived)
      .slice(0, 4)
      .map((d) => d.title)
      .join(" · ");
  const runSearch = async (e) => {
    e.preventDefault();
    const q = query.trim();
    if (!q || !onSearch || searching) return;
    setSearching(true);
    try {
      setResults(await onSearch(q));
    } catch {
      setResults({ items: [] });
    } finally {
      setSearching(false);
    }
  };
  return (
    <section className="nb-dir" aria-label="全局笔记本目录">
      <div className="section-heading map-heading">
        <h2>
          <button className="map-caret" aria-expanded={open} onClick={toggle}>
            {open ? "▾" : "▸"}
          </button>{" "}
          全局笔记本 <span>{published}</span>
        </h2>
        <div className="section-heading-actions">
          <button onClick={refresh} disabled={busy} title="重新读取全局目录">
            刷新
          </button>
          {current?.publishedAt ? (
            <button onClick={onUnpublish} disabled={busy}>
              取消发布
            </button>
          ) : (
            <button
              onClick={onPublish}
              disabled={busy}
              title="把本工作区的学习笔记本登记到 ~/.dsh 全局目录，其他工作区可一键跳转到这里"
            >
              发布到全局目录
            </button>
          )}
        </div>
      </div>
      {open && (
        <>
          {dueRows.length > 0 && (
            <div className="nb-due">
              <div className="eyebrow">全局到期 · 跨工作区</div>
              <ul className="nb-list">
                {dueRows.map(({ n, d }) => (
                  <li key={n.root + ":" + d.id}>
                    <button
                      className="nb-row due"
                      disabled={busy || !n.exists}
                      title={n.exists ? `在新对话中打开：${n.workspace}` : n.workspace}
                      onClick={() => onOpen?.(n)}
                    >
                      <span className="nb-main">
                        <strong>{n.title}</strong>
                        <small className="nb-path">{d.title}</small>
                      </span>
                      <span className="nb-stats">{d.due} 道到期</span>
                      <span className="nb-go" aria-hidden="true">
                        →
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}
          <form className="nb-search" onSubmit={runSearch}>
            <input
              type="search"
              aria-label="跨笔记本搜索"
              placeholder="跨笔记本搜索题组、主题或题目…"
              value={query}
              maxLength={100}
              onChange={(e) => setQuery(e.target.value)}
            />
            <button disabled={searching || !query.trim() || !onSearch}>
              {searching ? "搜索中…" : "搜索"}
            </button>
          </form>
          {results &&
            (results.items?.length ? (
              <ul className="nb-list nb-results">
                {results.items.map((r, i) => (
                  <li key={r.root + ":" + (r.cardId || r.deckId) + ":" + i}>
                    <button
                      className="nb-row"
                      disabled={busy}
                      title={r.workspace}
                      onClick={() => onOpen?.({ workspace: r.workspace })}
                    >
                      <span className="nb-main">
                        <strong>
                          {r.deckTitle}
                          {r.topic ? ` › ${r.topic}` : ""}
                        </strong>
                        <small className="nb-path">{r.prompt || r.cardId || ""}</small>
                      </span>
                      <span className="nb-stats">{r.title}</span>
                      <span className="nb-go" aria-hidden="true">
                        →
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            ) : (
              !searching && <p className="muted nb-empty">没有匹配的内容。</p>
            ))}
          {list.length ? (
            <ul className="nb-list">
              {current?.publishedAt && (
                <li className="nb-row current" title={current.workspace}>
                  <span className="nb-chip">本工作区</span>
                  <span className="nb-main">
                    <strong>{current.title}</strong>
                    <small>{topics(current) || stats(current)}</small>
                  </span>
                  <span className="nb-stats">{stats(current)}</span>
                </li>
              )}
              {others.map((n) => (
                <li key={n.root}>
                  <button
                    className={"nb-row" + (n.exists ? "" : " missing")}
                    disabled={busy || !n.exists || !onOpen}
                    title={n.exists ? `在新对话中打开：${n.workspace}` : n.workspace}
                    onClick={() => onOpen?.(n)}
                  >
                    <span className="nb-main">
                      <strong>{n.title}</strong>
                      <small className="nb-path">{n.workspace}</small>
                    </span>
                    <span className="nb-stats">{stats(n)}</span>
                    <span className="nb-go" aria-hidden="true">
                      →
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="muted nb-empty">
              还没有发布的笔记本。在某个工作区的学习库点「发布到全局目录」后，可以在这里跨工作区跳转：点击会新建该工作区的对话。
            </p>
          )}
        </>
      )}
    </section>
  );
}
