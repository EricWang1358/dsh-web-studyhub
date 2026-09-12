import React, { useState, useEffect, useCallback, useRef } from "react";

const kinds = {
  quiz: "单选测验",
  multi: "多选测验",
  flashcard: "闪卡",
  open: "开放问答",
};
const date = (v) =>
  v
    ? new Date(v).toLocaleString("zh-CN", {
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      })
    : "现在";
const Icon = ({ children }) => (
  <span className="icon" aria-hidden="true">
    {children}
  </span>
);
function parseDraft(raw) {
  const d = JSON.parse(raw);
  if (
    !d ||
    typeof d !== "object" ||
    typeof d.title !== "string" ||
    !Array.isArray(d.cards) ||
    !d.cards.length
  )
    throw new Error("题组需要 title 和非空 cards 数组");
  for (const q of d.cards) {
    if (!q || typeof q !== "object") throw new Error("每道题必须是一个对象");
    for (const key of [
      "id",
      "kind",
      "topic",
      "objective",
      "prompt",
      "answer",
      "hint",
      "explanation",
      "misconception",
    ])
      if (typeof q[key] !== "string")
        throw new Error("每道题需要文本字段：" + key);
    if (q.rubric !== undefined && typeof q.rubric !== "string")
      throw new Error("rubric 必须是文本");
    if (
      !Array.isArray(q.citations) ||
      q.citations.some(
        (c) =>
          !c || typeof c.quote !== "string" || typeof c.sourceId !== "string",
      )
    )
      throw new Error("citations 需要 sourceId 和 quote");
    if (
      q.options !== undefined &&
      (!Array.isArray(q.options) ||
        q.options.some(
          (o) =>
            !o ||
            typeof o.id !== "string" ||
            typeof o.text !== "string" ||
            typeof o.explanation !== "string" ||
            typeof o.correct !== "boolean",
        ))
    )
      throw new Error("选项结构不完整");
  }
  return d;
}

export default function App({ call }) {
  const rootRef = useRef(null),
    requestSequence = useRef(0),
    acting = useRef(false);
  const [managedDeck, setManagedDeck] = useState(null),
    [search, setSearch] = useState(""),
    [showArchived, setShowArchived] = useState(false);
  const [data, setData] = useState(null),
    [binding, setBinding] = useState({ root: "", provider: "", model: "" }),
    [page, setPage] = useState("library");
  const [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [busy, setBusy] = useState(false),
    [loading, setLoading] = useState(true);
  const [modal, setModal] = useState(null),
    [sourceTitle, setSourceTitle] = useState(""),
    [sourceText, setSourceText] = useState("");
  const [selectedSources, setSelectedSources] = useState([]),
    [gen, setGen] = useState({
      kind: "quiz",
      count: 10,
      language: "中文",
      difficulty: "mixed",
      focus: "",
      role: "",
    });
  const [draft, setDraft] = useState(null),
    [recovery, setRecovery] = useState(null),
    [draftText, setDraftText] = useState(""),
    [jsonMode, setJsonMode] = useState(false),
    [legacy, setLegacy] = useState("");
  const [run, setRun] = useState(null),
    [selected, setSelected] = useState([]),
    [hint, setHint] = useState(false),
    [explain, setExplain] = useState(false),
    [response, setResponse] = useState("");
  const [settings, setSettings] = useState({}),
    [flag, setFlag] = useState(""),
    [teaching, setTeaching] = useState(null),
    [teachAnswer, setTeachAnswer] = useState("");
  const refresh = useCallback(async () => {
    const sequence = ++requestSequence.current;
    const next = await call("snapshot");
    if (sequence === requestSequence.current) {
      setData(next);
      setSettings((current) =>
        Object.keys(current).length ? current : next.settings,
      );
    }
    return next;
  }, [call]);
  useEffect(() => {
    if (!data?.root) return;
    try {
      const saved = sessionStorage.getItem(`study-draft:${data.root}`);
      setRecovery(saved ? JSON.parse(saved) : null);
    } catch {
      setRecovery(null);
    }
  }, [data?.root]);
  useEffect(() => {
    if (!data?.root || !draft) return;
    try {
      const saved = { draft, draftText, jsonMode };
      sessionStorage.setItem(`study-draft:${data.root}`, JSON.stringify(saved));
      setRecovery(saved);
    } catch {
      setNotice("浏览器暂存不可用，请及时保存草稿。");
    }
  }, [data?.root, draft, draftText, jsonMode]);
  function clearRecovery() {
    if (data?.root) sessionStorage.removeItem(`study-draft:${data.root}`);
    setRecovery(null);
    setDraft(null);
  }
  useEffect(() => {
    let live = true;
    (async () => {
      try {
        const b = await call("binding.get");
        if (live) setBinding(b);
        if (b.root) await refresh();
      } catch (e) {
        if (live) setError(e.message);
      } finally {
        if (live) setLoading(false);
      }
    })();
    return () => {
      live = false;
    };
  }, [call, refresh]);
  const running = data?.jobs?.some((j) => j.status === "running");
  useEffect(() => {
    if (!binding.root) return;
    let stopped = false,
      pending = false;
    const t = setInterval(async () => {
      if (document.hidden || pending || stopped) return;
      pending = true;
      try {
        await refresh();
      } catch (e) {
        if (!stopped) setError(e.message);
      } finally {
        pending = false;
      }
    }, 2500);
    return () => {
      stopped = true;
      clearInterval(t);
    };
  }, [binding.root, refresh]);
  useEffect(() => {
    if (!modal) return;
    const previous = document.activeElement;
    const dialog = rootRef.current?.querySelector('[role="dialog"]');
    if (!dialog) return;
    const elements = () => [
      ...dialog.querySelectorAll(
        'button:not(:disabled),input:not(:disabled),textarea:not(:disabled),select:not(:disabled),[tabindex="0"]',
      ),
    ];
    elements()[0]?.focus();
    function trap(e) {
      if (e.key === "Escape") {
        e.preventDefault();
        setModal(null);
      }
      if (e.key === "Tab") {
        const items = elements(),
          first = items[0],
          last = items.at(-1);
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last?.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first?.focus();
        }
      }
    }
    document.addEventListener("keydown", trap);
    return () => {
      document.removeEventListener("keydown", trap);
      previous?.focus?.();
    };
  }, [modal]);
  async function act(action, args = {}, after) {
    if (acting.current) return;
    acting.current = true;
    setBusy(true);
    setError("");
    try {
      const result = await call(action, args);
      if (after) await after(result);
      await refresh();
      return result;
    } catch (e) {
      setError(e.message || String(e));
    } finally {
      acting.current = false;
      setBusy(false);
    }
  }
  function enterRun(r) {
    setRun(r);
    setPage("review");
    setSelected(r.feedback?.selected || []);
    setHint(false);
    setExplain(false);
    setResponse("");
    setTeaching(r.teaching || null);
    setTeachAnswer("");
  }
  const reviewAct = (action, args = {}) =>
    act(action, { runId: run.id, cardId: run.card?.id, ...args }, enterRun);
  const choice =
    run?.mode !== "flashcard" && ["quiz", "multi"].includes(run?.card?.kind);
  function choose(id) {
    if (busy || run.feedback) return;
    if (run.card.kind === "multi")
      setSelected((v) =>
        v.includes(id) ? v.filter((x) => x !== id) : [...v, id],
      );
    else reviewAct("review.answer", { selected: [id] });
  }
  useEffect(() => {
    function key(e) {
      if (!rootRef.current?.contains(document.activeElement)) return;
      if (
        e.target.closest("input,textarea,select,button,[contenteditable]") ||
        page !== "review" ||
        !run?.card ||
        busy ||
        modal
      )
        return;
      if (e.key === "ArrowRight" && run.feedback) {
        e.preventDefault();
        reviewAct("review.move", { direction: 1 });
      } else if (e.key === "ArrowLeft" && run.index) {
        e.preventDefault();
        reviewAct("review.move", { direction: -1 });
      } else if (e.code === "Space" && !choice && !run.revealed) {
        e.preventDefault();
        reviewAct("review.reveal");
      } else if (choice && !run.feedback && /^[1-6]$/.test(e.key)) {
        const o = run.card.options[Number(e.key) - 1];
        if (o) choose(o.id);
      }
    }
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  });
  function openDraft(d) {
    setDraft(structuredClone(d));
    setDraftText(JSON.stringify(d, null, 2));
    setJsonMode(false);
    setPage("draft");
  }
  function blankCard() {
    return {
      id: crypto.randomUUID(),
      kind: "flashcard",
      topic: "",
      objective: "",
      prompt: "",
      answer: "",
      hint: "",
      explanation: "",
      misconception: "",
      citations: [{ sourceId: data.sources[0]?.id || "", quote: "" }],
    };
  }
  function patchCard(index, key, value) {
    setDraft((d) => ({
      ...d,
      cards: d.cards.map((c, i) => (i === index ? { ...c, [key]: value } : c)),
    }));
  }
  async function saveBinding(e) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      await call("binding.set", binding);
      setSettings({});
      setRun(null);
      setDraft(null);
      setSelectedSources([]);
      await refresh();
      setNotice("工作区已连接");
      setPage("library");
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  async function exportData() {
    try {
      const s = await call("export");
      const url = URL.createObjectURL(
        new Blob([JSON.stringify(s, null, 2)], { type: "application/json" }),
      );
      const a = document.createElement("a");
      a.href = url;
      a.download = "study-library.json";
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (e) {
      setError(e.message);
    }
  }
  const sourceForm = (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        act("source.add", { title: sourceTitle, text: sourceText }, () => {
          setModal(null);
          setSourceTitle("");
          setSourceText("");
          setNotice("资料已保存，可用于生成题组");
        });
      }}
    >
      <label>
        资料名称
        <input
          required
          value={sourceTitle}
          onChange={(e) => setSourceTitle(e.target.value)}
          placeholder="例如：设计模式 · 第 4 章"
        />
      </label>
      <label className="file-input">
        导入 Markdown / 文本
        <input
          type="file"
          accept=".md,.txt,.markdown"
          onChange={async (e) => {
            const f = e.target.files?.[0];
            if (f) {
              if (f.size > 600000) {
                setError("文件过大，请选取相关段落");
                return;
              }
              setSourceText(await f.text());
              if (!sourceTitle) setSourceTitle(f.name.replace(/\.[^.]+$/, ""));
            }
          }}
        />
      </label>
      <label>
        原文
        <textarea
          required
          rows={12}
          value={sourceText}
          maxLength={120000}
          onChange={(e) => setSourceText(e.target.value)}
          placeholder="粘贴讲义、笔记或材料。生成内容将引用这里的原文。"
        />
      </label>
      <div className="form-footer">
        <small>{sourceText.length.toLocaleString()} / 120,000 字符</small>
        <button className="primary" disabled={busy}>
          保存资料
        </button>
      </div>
    </form>
  );
  const bindingForm = (
    <form onSubmit={saveBinding}>
      <label>
        学习库绝对路径
        <input
          required
          value={binding.root || ""}
          onChange={(e) => setBinding({ ...binding, root: e.target.value })}
          placeholder="D:\\Study\\my-library"
        />
        <small>选择你自己的学习资料目录，学习记录与题库保存在本地。</small>
      </label>
      <div className="two-col">
        <label>
          模型 Provider
          <input
            value={binding.provider || ""}
            onChange={(e) =>
              setBinding({ ...binding, provider: e.target.value })
            }
            placeholder="模型供应商 ID"
          />
        </label>
        <label>
          模型 ID
          <input
            value={binding.model || ""}
            onChange={(e) => setBinding({ ...binding, model: e.target.value })}
            placeholder="模型名称"
          />
        </label>
      </div>
      <p className="muted">
        生成时，所选资料会发送给此模型；复习与历史记录无需调用模型。
      </p>
      <button className="primary" disabled={busy}>
        连接学习工作区
      </button>
    </form>
  );
  const shellTitle =
    page === "review"
      ? data?.decks.find((d) => d.id === run?.deckId)?.title || "复习"
      : {
          library: "学习库",
          sources: "资料",
          generate: "创建题组",
          draft: "审阅草稿",
          settings: "工作区设置",
          manage: "维护题组",
        }[page];
  if (loading)
    return (
      <div className="study-app">
        <div className="loading">正在打开学习工作区…</div>
      </div>
    );
  return (
    <div
      className="study-app"
      ref={rootRef}
      tabIndex={-1}
      onPointerDown={(e) => {
        if (!e.target.closest("button,input,textarea,select,a"))
          rootRef.current?.focus();
      }}
    >
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-mark">✳</span>
          <div>
            Daily Flashcard<small>自己的资料，扎实地学</small>
          </div>
        </div>
        <nav>
          {[
            ["library", "▦", "学习库"],
            ["sources", "▤", "资料"],
            ["generate", "＋", "创建题组"],
          ].map(([id, icon, label]) => (
            <button
              key={id}
              className={page === id ? "nav active" : "nav"}
              onClick={() => {
                setPage(id);
                setError("");
              }}
              disabled={!data}
            >
              <Icon>{icon}</Icon>
              {label}
              {id === "sources" && data && (
                <span className="nav-count">{data.sources.length}</span>
              )}
            </button>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <div className="local-status">
            <span />
            本地学习工作区
          </div>
          <button
            className={page === "settings" ? "nav active" : "nav"}
            onClick={() => setPage("settings")}
          >
            <Icon>⚙</Icon>设置
          </button>
        </div>
      </aside>
      <main>
        <header className="topbar">
          <span>
            Study <span className="breadcrumb">›</span> {shellTitle}
          </span>
          <span className="top-status">
            {busy
              ? "正在保存…"
              : running
                ? "正在生成…"
                : data
                  ? "已连接"
                  : "待连接"}
          </span>
        </header>
        {error && (
          <div role="alert" className="alert error">
            <span>{error}</span>
            <button aria-label="关闭错误" onClick={() => setError("")}>
              ×
            </button>
          </div>
        )}
        {notice && (
          <div role="status" className="alert notice">
            <span>{notice}</span>
            <button aria-label="关闭提示" onClick={() => setNotice("")}>
              ×
            </button>
          </div>
        )}
        {!data ? (
          <section className="onboarding">
            <div className="eyebrow">YOUR LEARNING SPACE</div>
            <h1>把资料变成真正会的知识。</h1>
            <p className="intro">
              连接一个本地学习库，复用你的题目与复习历史。每一道新题，都能回到资料验证。
            </p>
            {bindingForm}
          </section>
        ) : (
          <>
            {page === "library" && (
              <section className="page library-page">
                {recovery && (
                  <div className="alert notice">
                    <span>
                      有本窗口暂存的编辑：{recovery.draft.title}（尚未发布）
                    </span>
                    <button
                      onClick={() => {
                        setDraft(recovery.draft);
                        setDraftText(recovery.draftText);
                        setJsonMode(recovery.jsonMode);
                        setPage("draft");
                      }}
                    >
                      继续编辑
                    </button>
                    <button onClick={clearRecovery}>丢弃暂存</button>
                  </div>
                )}
                <div className="page-heading">
                  <div>
                    <div className="eyebrow">LEARN WITH INTENTION</div>
                    <h1>今天，学得更扎实一点。</h1>
                    <p className="muted">
                      理解、回忆、迁移。让每一次复习都有依据。
                    </p>
                  </div>
                  <button
                    className="primary"
                    onClick={() => setPage("generate")}
                  >
                    ＋ 创建题组
                  </button>
                </div>
                <div className="stats">
                  <div>
                    <strong>
                      {data.decks
                        .filter((d) => !d.archived)
                        .reduce((n, d) => n + d.due, 0)}
                    </strong>
                    <span>待复习</span>
                  </div>
                  <div>
                    <strong>
                      {data.decks.reduce((n, d) => n + d.count, 0)}
                    </strong>
                    <span>学习卡片</span>
                  </div>
                  <div>
                    <strong>{data.attempts.length}</strong>
                    <span>近期作答记录</span>
                  </div>
                </div>
                {data.runs.length > 0 && (
                  <div className="resume-list">
                    {data.runs.map((r) => (
                      <div key={r.id}>
                        <button
                          className="resume"
                          key={r.id}
                          disabled={busy}
                          onClick={() =>
                            act("review.get", { runId: r.id }, enterRun)
                          }
                        >
                          <span>
                            <span className="eyebrow">继续上次学习</span>
                            <strong>
                              {data.decks.find((d) => d.id === r.deckId)
                                ?.title || "题组"}
                            </strong>
                          </span>
                          <span>
                            {r.index + 1} / {r.total} <b>→</b>
                          </span>
                        </button>
                        <button
                          disabled={busy}
                          onClick={() => act("review.end", { runId: r.id })}
                        >
                          结束此轮（保留已答记录）
                        </button>
                      </div>
                    ))}
                  </div>
                )}
                <div className="section-heading">
                  <h2>
                    我的题组 <span>{data.decks.length}</span>
                  </h2>
                  <button
                    disabled={!data.sources.length}
                    onClick={() =>
                      openDraft({
                        id: crypto.randomUUID(),
                        title: "新建闪卡题组",
                        cards: [blankCard()],
                      })
                    }
                  >
                    手工创建闪卡
                  </button>
                  <button
                    onClick={() => {
                      setPage("settings");
                    }}
                  >
                    导入已有学习库
                  </button>
                </div>
                <div className="two-col">
                  <label>
                    搜索题组或主题
                    <input
                      value={search}
                      onChange={(e) => setSearch(e.target.value)}
                      placeholder="输入关键词"
                    />
                  </label>
                  <label>
                    题组范围
                    <select
                      value={showArchived ? "archived" : "active"}
                      onChange={(e) =>
                        setShowArchived(e.target.value === "archived")
                      }
                    >
                      <option value="active">学习中的题组</option>
                      <option value="archived">已归档题组</option>
                    </select>
                  </label>
                </div>
                {data.decks.length ? (
                  <div className="deck-grid">
                    {data.decks
                      .filter(
                        (d) =>
                          !!d.archived === showArchived &&
                          `${d.title} ${d.topics.join(" ")}`
                            .toLowerCase()
                            .includes(search.toLowerCase()),
                      )
                      .map((d) => (
                        <article className="deck" key={d.id}>
                          <div className="deck-top">
                            <span className="deck-icon">▧</span>
                            <span className="tag">{d.due} 待复习</span>
                          </div>
                          <h3>{d.title}</h3>
                          <p>{d.topics.slice(0, 3).join(" · ")}</p>
                          <small>
                            {d.count} 道题
                            {d.flagged > 0 ? ` · ${d.flagged} 道已标记` : ""}
                          </small>
                          <div className="deck-actions">
                            <button
                              className="primary"
                              disabled={busy || d.archived || !d.due}
                              onClick={() =>
                                act(
                                  "review.start",
                                  { deckId: d.id, mode: "due" },
                                  enterRun,
                                )
                              }
                            >
                              复习
                            </button>
                            <button
                              disabled={busy || d.archived || !d.available}
                              onClick={() =>
                                act(
                                  "review.start",
                                  { deckId: d.id, mode: "flashcard" },
                                  enterRun,
                                )
                              }
                            >
                              闪卡
                            </button>
                            <button
                              disabled={busy || d.archived || !d.quizCount}
                              onClick={() =>
                                act(
                                  "review.start",
                                  { deckId: d.id, mode: "quiz" },
                                  enterRun,
                                )
                              }
                            >
                              测验
                            </button>
                            <button
                              disabled={busy || d.archived || !d.wrong}
                              onClick={() =>
                                act(
                                  "review.start",
                                  { deckId: d.id, mode: "wrong" },
                                  enterRun,
                                )
                              }
                            >
                              错题 {d.wrong || 0}
                            </button>
                            <button
                              disabled={busy}
                              onClick={() =>
                                act("deck.get", { id: d.id }, (deck) => {
                                  setManagedDeck(deck);
                                  setPage("manage");
                                })
                              }
                            >
                              管理
                            </button>
                          </div>
                        </article>
                      ))}
                  </div>
                ) : (
                  <div className="empty">
                    <span className="empty-icon">▧</span>
                    <h2>你的第一组好题，从资料开始</h2>
                    <p>添加讲义或笔记，再生成可审阅、可修改的闪卡与测验。</p>
                    <button
                      className="primary"
                      onClick={() => setModal({ type: "add" })}
                    >
                      添加资料
                    </button>
                  </div>
                )}
                {data.drafts.length > 0 && (
                  <>
                    <div className="section-heading">
                      <h2>
                        待审阅 <span>{data.drafts.length}</span>
                      </h2>
                      <small>确认内容后再进入复习</small>
                    </div>
                    {data.drafts.map((d) => (
                      <button
                        key={d.id}
                        className="draft-row"
                        onClick={() => openDraft(d)}
                      >
                        <span>
                          <strong>{d.title}</strong>
                          <small>
                            {d.cards.length} 道题 ·{" "}
                            {d.quality?.warnings?.length || 0} 项质量提醒
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
                          {j.status === "running"
                            ? "◌"
                            : j.status === "failed"
                              ? "!"
                              : "✓"}
                        </span>
                        <div>
                          <strong>
                            {j.status === "running"
                              ? "正在生成题组"
                              : j.status === "failed"
                                ? "生成未完成"
                                : "草稿已生成"}
                          </strong>
                          <small>{j.stage}</small>
                        </div>
                        {j.draftId &&
                          data.drafts.some((d) => d.id === j.draftId) && (
                            <button
                              onClick={() =>
                                openDraft(
                                  data.drafts.find((d) => d.id === j.draftId),
                                )
                              }
                            >
                              打开
                            </button>
                          )}
                      </div>
                    ))}
                  </div>
                )}
              </section>
            )}
            {page === "manage" && managedDeck && (
              <section className="page">
                <h1>{managedDeck.title}</h1>
                <p className="muted">
                  编辑先进入草稿；重新发布时，未改动题目保留复习进度，内容变更的题目重新开始调度。历史作答始终保留。
                </p>
                <div className="deck-actions">
                  <button
                    disabled={busy}
                    onClick={() =>
                      act("deck.edit", { id: managedDeck.id }, openDraft)
                    }
                  >
                    编辑题组
                  </button>
                  <button
                    disabled={busy}
                    onClick={() =>
                      act(
                        "deck.archive",
                        { id: managedDeck.id, archived: !managedDeck.archived },
                        async () =>
                          setManagedDeck(
                            await call("deck.get", { id: managedDeck.id }),
                          ),
                      )
                    }
                  >
                    {managedDeck.archived ? "恢复题组" : "归档题组并结束练习"}
                  </button>
                  <button onClick={() => setPage("library")}>返回学习库</button>
                </div>
                {managedDeck.cards.map((card) => (
                  <article className="deck" key={card.id}>
                    <small>
                      {card.topic} · {card.kind}
                      {card.suspended ? " · 已暂停" : ""}
                    </small>
                    <h3>{card.prompt}</h3>
                    {card.flag && <p className="muted">标记：{card.flag}</p>}
                    <div className="deck-actions">
                      <button
                        disabled={busy}
                        onClick={() =>
                          act(
                            "card.suspend",
                            {
                              deckId: managedDeck.id,
                              cardId: card.id,
                              suspended: !card.suspended,
                            },
                            async () =>
                              setManagedDeck(
                                await call("deck.get", { id: managedDeck.id }),
                              ),
                          )
                        }
                      >
                        {card.suspended ? "恢复学习" : "暂停此题"}
                      </button>
                      {card.flag && (
                        <button
                          disabled={busy}
                          onClick={() =>
                            act(
                              "card.flag",
                              {
                                deckId: managedDeck.id,
                                cardId: card.id,
                                reason: "",
                              },
                              async () =>
                                setManagedDeck(
                                  await call("deck.get", {
                                    id: managedDeck.id,
                                  }),
                                ),
                            )
                          }
                        >
                          清除标记
                        </button>
                      )}
                    </div>
                  </article>
                ))}
              </section>
            )}
            {page === "sources" && (
              <section className="page">
                <div className="page-heading">
                  <div>
                    <h1>资料</h1>
                    <p className="muted">
                      题目从这里生长。原文与引用一直保留。
                    </p>
                  </div>
                  <button
                    className="primary"
                    onClick={() => setModal({ type: "add" })}
                  >
                    ＋ 添加资料
                  </button>
                </div>
                {!data.sources.length ? (
                  <div className="empty">
                    <h2>还没有资料</h2>
                    <p>支持粘贴文本、Markdown 和 TXT 文件。</p>
                    {sourceForm}
                  </div>
                ) : (
                  data.sources.map((s) => (
                    <article className="source-row" key={s.id}>
                      <button
                        className="source-main"
                        onClick={() => setModal({ type: "source", source: s })}
                      >
                        <Icon>▤</Icon>
                        <span>
                          <strong>{s.title}</strong>
                          <small>
                            {s.text.length.toLocaleString()} 字符 ·{" "}
                            {s.text.slice(0, 80)}
                          </small>
                        </span>
                      </button>
                      <button
                        disabled={busy}
                        onClick={() => act("source.remove", { id: s.id })}
                      >
                        移除
                      </button>
                    </article>
                  ))
                )}
              </section>
            )}
            {page === "generate" && (
              <section className="page narrow">
                <div className="eyebrow">SOURCE → UNDERSTANDING</div>
                <h1>创建一组值得练的题</h1>
                <p className="muted">
                  先选资料，再设定学习目标。生成结果会先进入草稿，经过你的审阅后发布。
                </p>
                <form
                  onSubmit={(e) => {
                    e.preventDefault();
                    act(
                      "generate",
                      {
                        ...gen,
                        count: Number(gen.count),
                        sourceIds: selectedSources,
                      },
                      () => {
                        setPage("library");
                        setNotice("已开始生成，完成后会出现在待审阅列表。");
                      },
                    );
                  }}
                >
                  <fieldset>
                    <legend>01 / 选择资料</legend>
                    {data.sources.length ? (
                      data.sources.map((s) => (
                        <label className="source-choice" key={s.id}>
                          <input
                            type="checkbox"
                            checked={selectedSources.includes(s.id)}
                            onChange={(e) =>
                              setSelectedSources((v) =>
                                e.target.checked
                                  ? [...v, s.id]
                                  : v.filter((x) => x !== s.id),
                              )
                            }
                          />
                          <span>
                            {s.title}
                            <small>{s.text.length.toLocaleString()} 字符</small>
                          </span>
                        </label>
                      ))
                    ) : (
                      <p className="muted">先添加一份资料。</p>
                    )}
                    <button
                      type="button"
                      onClick={() => setModal({ type: "add" })}
                    >
                      ＋ 添加资料
                    </button>
                  </fieldset>
                  <fieldset>
                    <legend>02 / 学习方式</legend>
                    <div className="kind-grid">
                      {Object.entries(kinds).map(([id, label]) => (
                        <button
                          type="button"
                          key={id}
                          className={gen.kind === id ? "kind selected" : "kind"}
                          onClick={() => setGen({ ...gen, kind: id })}
                        >
                          {label}
                        </button>
                      ))}
                    </div>
                    <div className="three-col">
                      <label>
                        题数
                        <input
                          type="number"
                          min="1"
                          max="30"
                          required
                          value={gen.count}
                          onChange={(e) =>
                            setGen({ ...gen, count: e.target.value })
                          }
                        />
                      </label>
                      <label>
                        难度
                        <select
                          value={gen.difficulty}
                          onChange={(e) =>
                            setGen({ ...gen, difficulty: e.target.value })
                          }
                        >
                          <option value="mixed">混合</option>
                          <option value="foundation">基础理解</option>
                          <option value="application">应用迁移</option>
                          <option value="advanced">深入辨析</option>
                        </select>
                      </label>
                      <label>
                        语言
                        <select
                          value={gen.language}
                          onChange={(e) =>
                            setGen({ ...gen, language: e.target.value })
                          }
                        >
                          <option>中文</option>
                          <option>English</option>
                          <option>中英双语</option>
                        </select>
                      </label>
                    </div>
                    <label>
                      这次想练什么？
                      <textarea
                        rows={3}
                        value={gen.focus}
                        onChange={(e) =>
                          setGen({ ...gen, focus: e.target.value })
                        }
                        placeholder="例如：区分相似模式，重点练习工程场景中的取舍"
                      />
                    </label>
                    <label>
                      目标岗位 / 面试方向（可选）
                      <input
                        value={gen.role}
                        onChange={(e) =>
                          setGen({ ...gen, role: e.target.value })
                        }
                        placeholder="例如：后端工程师 · 系统设计"
                      />
                    </label>
                  </fieldset>
                  <div className="quality-note">
                    <Icon>✧</Icon>
                    <p>
                      原文引用核验 · 独立质量审阅 · 干扰项逐项解释
                      <br />
                      <small>
                        质量检查帮助发现问题；发布前仍可逐题检查与修改。
                      </small>
                    </p>
                  </div>
                  {!data.modelReady && (
                    <p className="warning">
                      尚未配置生成模型。请在设置中选择 Provider 与模型。
                    </p>
                  )}
                  <button
                    className="primary wide"
                    disabled={
                      busy ||
                      running ||
                      !selectedSources.length ||
                      !data.modelReady
                    }
                  >
                    {running ? "正在生成…" : "生成并检查题组 →"}
                  </button>
                </form>
              </section>
            )}
            {page === "draft" && draft && (
              <section className="page narrow">
                <div className="page-heading">
                  <div>
                    <div className="eyebrow">REVIEW BEFORE YOU LEARN</div>
                    <h1>审阅草稿</h1>
                  </div>
                  <button
                    onClick={() => {
                      if (!jsonMode)
                        setDraftText(JSON.stringify(draft, null, 2));
                      else {
                        try {
                          setDraft(parseDraft(draftText));
                        } catch (e) {
                          setError("JSON 格式不正确：" + e.message);
                          return;
                        }
                      }
                      setJsonMode(!jsonMode);
                    }}
                  >
                    {jsonMode ? "逐题编辑" : "JSON 编辑"}
                  </button>
                </div>
                {draft.editorial && (
                  <div className="quality-note">
                    <p>
                      {draft.editorial.summary}
                      <br />
                      <small>
                        已完成模型审阅，请核对原文。模型审阅不能保证事实完全正确。
                      </small>
                    </p>
                  </div>
                )}
                {draft.quality?.warnings?.map((w, i) => (
                  <p className="warning" key={i}>
                    {w}
                  </p>
                ))}
                {jsonMode ? (
                  <textarea
                    className="json-editor"
                    aria-label="题组 JSON"
                    value={draftText}
                    onChange={(e) => setDraftText(e.target.value)}
                  />
                ) : (
                  <>
                    <label>
                      题组标题
                      <input
                        value={draft.title}
                        onChange={(e) =>
                          setDraft({ ...draft, title: e.target.value })
                        }
                      />
                    </label>
                    {draft.cards.map((q, i) => (
                      <details className="draft-card" key={q.id} open={i === 0}>
                        <summary>
                          <span>{String(i + 1).padStart(2, "0")}</span>
                          {q.prompt}
                          <small>{kinds[q.kind]}</small>
                        </summary>
                        <label>
                          问题
                          <textarea
                            rows={3}
                            value={q.prompt}
                            onChange={(e) =>
                              patchCard(i, "prompt", e.target.value)
                            }
                          />
                        </label>
                        <div className="two-col">
                          <label>
                            主题
                            <input
                              value={q.topic}
                              onChange={(e) =>
                                patchCard(i, "topic", e.target.value)
                              }
                            />
                          </label>
                          <label>
                            学习目标
                            <input
                              value={q.objective}
                              onChange={(e) =>
                                patchCard(i, "objective", e.target.value)
                              }
                            />
                          </label>
                        </div>
                        {[
                          "answer",
                          "hint",
                          "explanation",
                          "misconception",
                          ...(q.kind === "open" ? ["rubric"] : []),
                        ].map((key) => (
                          <label key={key}>
                            {
                              {
                                answer: "答案",
                                hint: "提示",
                                explanation: "讲解",
                                misconception: "易错点",
                                rubric: "评分标准",
                              }[key]
                            }
                            <textarea
                              rows={2}
                              value={q[key] || ""}
                              onChange={(e) =>
                                patchCard(i, key, e.target.value)
                              }
                            />
                          </label>
                        ))}
                        {q.options?.map((o, oi) => (
                          <div className="edit-option" key={o.id}>
                            <label className="inline">
                              <input
                                type="checkbox"
                                checked={o.correct}
                                onChange={(e) =>
                                  patchCard(
                                    i,
                                    "options",
                                    q.options.map((x, j) =>
                                      j === oi
                                        ? { ...x, correct: e.target.checked }
                                        : x,
                                    ),
                                  )
                                }
                              />
                              正确选项
                            </label>
                            <input
                              aria-label={"选项 " + o.id}
                              value={o.text}
                              onChange={(e) =>
                                patchCard(
                                  i,
                                  "options",
                                  q.options.map((x, j) =>
                                    j === oi
                                      ? { ...x, text: e.target.value }
                                      : x,
                                  ),
                                )
                              }
                            />
                            <textarea
                              aria-label={"选项解析 " + o.id}
                              value={o.explanation}
                              onChange={(e) =>
                                patchCard(
                                  i,
                                  "options",
                                  q.options.map((x, j) =>
                                    j === oi
                                      ? { ...x, explanation: e.target.value }
                                      : x,
                                  ),
                                )
                              }
                            />
                          </div>
                        ))}
                        <button
                          disabled={draft.cards.length <= 1}
                          onClick={() =>
                            setDraft({
                              ...draft,
                              cards: draft.cards.filter(
                                (_, index) => index !== i,
                              ),
                            })
                          }
                        >
                          从草稿移除此题
                        </button>
                        <div className="citations">
                          {q.citations?.map((c, j) => (
                            <div key={j}>
                              <label>
                                引用来源
                                <select
                                  value={c.sourceId}
                                  onChange={(e) =>
                                    patchCard(
                                      i,
                                      "citations",
                                      q.citations.map((citation, index) =>
                                        index === j
                                          ? {
                                              ...citation,
                                              sourceId: e.target.value,
                                              quote: "",
                                            }
                                          : citation,
                                      ),
                                    )
                                  }
                                >
                                  {data.sources.map((source) => (
                                    <option key={source.id} value={source.id}>
                                      {source.title}
                                    </option>
                                  ))}
                                </select>
                              </label>
                              <label>
                                逐字原文引用
                                <textarea
                                  value={c.quote}
                                  onChange={(e) =>
                                    patchCard(
                                      i,
                                      "citations",
                                      q.citations.map((citation, index) =>
                                        index === j
                                          ? {
                                              ...citation,
                                              quote: e.target.value,
                                            }
                                          : citation,
                                      ),
                                    )
                                  }
                                  placeholder="从原文复制能支持答案的段落"
                                />
                              </label>
                              <button
                                onClick={() =>
                                  setModal({
                                    type: "source",
                                    source: data.sources.find(
                                      (s) => s.id === c.sourceId,
                                    ),
                                    quote: c.quote,
                                  })
                                }
                              >
                                ↗{" "}
                                {data.sources.find((s) => s.id === c.sourceId)
                                  ?.title || "原文"}
                                <blockquote>{c.quote}</blockquote>
                              </button>
                            </div>
                          ))}
                        </div>
                      </details>
                    ))}
                    <button
                      disabled={draft.cards.length >= 100}
                      onClick={() =>
                        setDraft({
                          ...draft,
                          cards: [...draft.cards, blankCard()],
                        })
                      }
                    >
                      ＋ 添加闪卡
                    </button>
                  </>
                )}
                <div className="sticky-actions">
                  <button
                    disabled={busy}
                    onClick={() => {
                      let d;
                      try {
                        d = jsonMode ? parseDraft(draftText) : draft;
                      } catch (e) {
                        setError("JSON 格式不正确：" + e.message);
                        return;
                      }
                      act("draft.save", { deck: d }, openDraft);
                    }}
                  >
                    保存并校验
                  </button>
                  <button
                    className="primary"
                    disabled={busy}
                    onClick={async () => {
                      let d;
                      try {
                        d = jsonMode ? parseDraft(draftText) : draft;
                      } catch (e) {
                        setError("JSON 格式不正确：" + e.message);
                        return;
                      }
                      await act("draft.save", { deck: d }, async (saved) => {
                        openDraft(saved);
                        await call("draft.publish", {
                          id: saved.id,
                          draftVersion: saved.draftVersion,
                        });
                        clearRecovery();
                        setPage("library");
                        setNotice("题组已发布，可以开始学习。");
                      });
                    }}
                  >
                    保存并发布 →
                  </button>
                  <button
                    className="danger-text"
                    disabled={busy}
                    onClick={() =>
                      act(
                        "draft.delete",
                        { id: draft.id, draftVersion: draft.draftVersion },
                        () => {
                          clearRecovery();
                          setPage("library");
                        },
                      )
                    }
                  >
                    删除草稿
                  </button>
                </div>
              </section>
            )}
            {page === "settings" && (
              <section className="page narrow">
                <h1>工作区设置</h1>
                <p className="muted">资料、题库、调度与模型，由你掌控。</p>
                <fieldset>
                  <legend>学习库与模型</legend>
                  {bindingForm}
                </fieldset>
                <fieldset>
                  <legend>导入 study-lib-spar</legend>
                  <p className="muted">
                    从已有本地学习库导入，保留可迁移的复习记录。
                  </p>
                  <label>
                    原学习库路径
                    <input
                      value={legacy}
                      onChange={(e) => setLegacy(e.target.value)}
                    />
                  </label>
                  <button
                    disabled={busy || !legacy}
                    onClick={() =>
                      act("legacy.import", { path: legacy }, (r) =>
                        setNotice(
                          r.reused
                            ? "该学习库已导入"
                            : `已导入 ${r.count} 道题。${(r.warnings || []).join("；")}`,
                        ),
                      )
                    }
                  >
                    导入学习库
                  </button>
                </fieldset>
                <form
                  onSubmit={(e) => {
                    e.preventDefault();
                    act("settings", settings, () =>
                      setNotice("复习调度已保存"),
                    );
                  }}
                >
                  <fieldset>
                    <legend>间隔复习 · SM-2</legend>
                    <div className="two-col">
                      {Object.entries({
                        first_interval_days: "首次复习间隔（天）",
                        second_interval_days: "第二次间隔（天）",
                        initial_ease_factor: "初始熟练系数",
                        minimum_ease_factor: "最低熟练系数",
                      }).map(([key, label]) => (
                        <label key={key}>
                          {label}
                          <input
                            type="number"
                            required
                            min={key.includes("days") ? 1 : 0.1}
                            max="365"
                            step={key.includes("days") ? 1 : 0.1}
                            value={settings[key] ?? ""}
                            onChange={(e) =>
                              setSettings({
                                ...settings,
                                [key]: Number(e.target.value),
                              })
                            }
                          />
                        </label>
                      ))}
                    </div>
                    <button disabled={busy}>保存复习设置</button>
                    <button
                      type="button"
                      onClick={() => setSettings(data.settings)}
                    >
                      撤销未保存修改
                    </button>
                  </fieldset>
                </form>
                <fieldset>
                  <legend>数据导出</legend>
                  <p className="muted">
                    下载完整 JSON 备份，包含资料、题组和学习记录。
                  </p>
                  <button onClick={exportData}>导出学习库 ↓</button>
                </fieldset>
              </section>
            )}
            {page === "review" && run && (
              <section
                className={"review-page " + (!choice ? "flash-mode" : "")}
              >
                <div className="review-heading">
                  <div>
                    <h1>
                      {shellTitle}
                      {run.mode === "flashcard" ? " · 闪卡" : ""}
                    </h1>
                    <button
                      className="pill"
                      onClick={() => setModal({ type: "sources" })}
                    >
                      查看 {run.sourceIds?.length || 0} 份资料
                    </button>
                  </div>
                  <button onClick={() => setPage("library")}>返回学习库</button>
                </div>
                {run.complete ? (
                  <div className="session-summary">
                    <div className="summary-symbol">✓</div>
                    <div className="eyebrow">SESSION COMPLETE</div>
                    <h1>
                      {run.closed ? "这一轮，已结束。" : "这一轮，完成了。"}
                    </h1>
                    <p>
                      已答 {run.answered} / {run.total} 道题 · 掌握{" "}
                      {run.correct} 道 · 需要巩固 {run.answered - run.correct}{" "}
                      道
                    </p>
                    <div className="summary-topics">
                      <h3>接下来重点复习</h3>
                      {(run.weakTopics || []).map((t) => (
                        <span className="tag" key={t}>
                          {t}
                        </span>
                      ))}
                      {!run.weakTopics?.length && (
                        <p className="muted">
                          本轮没有低分记录，继续按间隔复习巩固。
                        </p>
                      )}
                    </div>
                    <p className="muted">每道题的下次复习时间已保存。</p>
                    <button
                      className="primary"
                      onClick={() => setPage("library")}
                    >
                      回到学习库
                    </button>
                  </div>
                ) : (
                  <>
                    <div
                      className={
                        "question-area " + (!choice ? "flash-area" : "")
                      }
                    >
                      <div className="question-meta">
                        <span>
                          {run.index + 1} / {run.total}
                        </span>
                        <div>
                          <span>{run.card.topic}</span>
                          <button
                            aria-label="标记题目"
                            onClick={() => {
                              setFlag("");
                              setModal({ type: "flag" });
                            }}
                          >
                            ⚑
                          </button>
                        </div>
                      </div>
                      {choice ? (
                        <>
                          <h2 className="question">{run.card.prompt}</h2>
                          {run.card.multiple && (
                            <p className="muted small">
                              多选题 · 选出所有符合条件的选项
                            </p>
                          )}
                          <div className="options">
                            {run.card.options.map((o, i) => {
                              const solution = run.solution?.options?.find(
                                (x) => x.id === o.id,
                              );
                              const picked = run.feedback?.selected?.includes(
                                o.id,
                              );
                              return (
                                <button
                                  key={o.id}
                                  disabled={busy || !!run.feedback}
                                  className={
                                    "option " +
                                    (run.feedback
                                      ? solution?.correct
                                        ? "correct"
                                        : picked
                                          ? "incorrect"
                                          : "dim"
                                      : selected.includes(o.id)
                                        ? "selected"
                                        : "")
                                  }
                                  onClick={() => choose(o.id)}
                                >
                                  <span className="option-letter">
                                    {String.fromCharCode(65 + i)}.
                                  </span>
                                  <div>
                                    {o.text}
                                    {run.feedback && (
                                      <>
                                        <strong className="answer-state">
                                          {solution?.correct
                                            ? "✓ 正确答案"
                                            : picked
                                              ? "× 还差一点"
                                              : ""}
                                        </strong>
                                        <p>{solution?.explanation}</p>
                                      </>
                                    )}
                                  </div>
                                </button>
                              );
                            })}
                          </div>
                          {run.card.multiple && !run.feedback && (
                            <button
                              className="primary submit-answer"
                              disabled={busy || !selected.length}
                              onClick={() =>
                                reviewAct("review.answer", { selected })
                              }
                            >
                              提交答案
                            </button>
                          )}
                        </>
                      ) : (
                        <>
                          <button
                            className={
                              "flashcard " + (run.revealed ? "revealed" : "")
                            }
                            disabled={busy || run.revealed}
                            onClick={() => reviewAct("review.reveal")}
                          >
                            <span className="flash-prompt">
                              {run.revealed
                                ? run.solution?.answer
                                : run.card.prompt}
                            </span>
                            <span className="flip-label">
                              {run.revealed
                                ? "参考答案"
                                : "点击查看答案 · Space"}
                            </span>
                          </button>
                          {run.card.kind === "open" && !run.revealed && (
                            <label className="response-label">
                              先组织你的回答
                              <textarea
                                rows={3}
                                value={response}
                                onChange={(e) => setResponse(e.target.value)}
                                placeholder="在脑中作答，或在这里写下思路（仅本轮临时草稿）"
                              />
                            </label>
                          )}
                          {run.revealed && !run.feedback && (
                            <div className="grading">
                              <p>对照答案，你掌握到了哪一步？</p>
                              <div>
                                {[
                                  "完全忘记",
                                  "答错",
                                  "似曾相识",
                                  "勉强答对",
                                  "熟练",
                                  "轻松掌握",
                                ].map((label, grade) => (
                                  <button
                                    className={
                                      grade < 3 ? "grade low" : "grade high"
                                    }
                                    key={grade}
                                    disabled={busy}
                                    onClick={() =>
                                      reviewAct("review.answer", { grade })
                                    }
                                  >
                                    <strong>{grade}</strong>
                                    <span>{label}</span>
                                  </button>
                                ))}
                              </div>
                            </div>
                          )}
                        </>
                      )}
                      <div className="question-toolbar">
                        <div>
                          <button
                            className="pill"
                            onClick={() =>
                              run.revealed
                                ? setExplain(!explain)
                                : setHint(!hint)
                            }
                          >
                            {run.revealed ? "✧ 讲解" : "提示"}{" "}
                            {run.revealed
                              ? explain
                                ? "⌃"
                                : "⌄"
                              : hint
                                ? "⌃"
                                : "⌄"}
                          </button>
                        </div>
                        <div>
                          <button
                            className="pill"
                            disabled={busy || run.index === 0}
                            onClick={() =>
                              reviewAct("review.move", { direction: -1 })
                            }
                          >
                            上一题
                          </button>
                          <button
                            className="primary pill"
                            disabled={busy || !run.feedback}
                            onClick={() =>
                              reviewAct("review.move", { direction: 1 })
                            }
                          >
                            {run.index === run.total - 1 ? "完成" : "下一题"} →
                          </button>
                        </div>
                      </div>
                      {hint && !run.revealed && (
                        <div className="hint">
                          <Icon>♧</Icon>
                          <p>{run.card.hint}</p>
                        </div>
                      )}
                      {run.feedback && (
                        <p className="next-due">
                          {run.feedback.correct ? "✓ 已掌握" : "↻ 将继续巩固"} ·
                          下次复习 {date(run.feedback.nextDue)}
                        </p>
                      )}
                      {explain && run.solution && (
                        <div className="explanation">
                          <h3>理解这道题</h3>
                          <p>{run.solution.explanation}</p>
                          <h4>容易混淆的地方</h4>
                          <p>{run.solution.misconception}</p>
                          {run.solution.rubric && (
                            <>
                              <h4>评分依据</h4>
                              <p>{run.solution.rubric}</p>
                            </>
                          )}
                          <div className="citations">
                            {run.solution.citations?.map((c, i) => (
                              <button
                                key={i}
                                onClick={() =>
                                  setModal({
                                    type: "source",
                                    source: data.sources.find(
                                      (s) => s.id === c.sourceId,
                                    ),
                                    quote: c.quote,
                                  })
                                }
                              >
                                ↗{" "}
                                {data.sources.find((s) => s.id === c.sourceId)
                                  ?.title || "资料"}
                                <blockquote>{c.quote}</blockquote>
                              </button>
                            ))}
                          </div>
                        </div>
                      )}
                      <div className="teaching-panel">
                        {run.feedback && data.modelReady && !teaching && (
                          <button
                            disabled={busy}
                            onClick={() =>
                              act("teach.start", { runId: run.id }, setTeaching)
                            }
                          >
                            逐步讲解 · 检查理解
                          </button>
                        )}
                        {teaching && (
                          <section className="explanation">
                            <div className="eyebrow">
                              GUIDED UNDERSTANDING ·{" "}
                              {Math.min(teaching.index + 1, teaching.total)} /{" "}
                              {teaching.total}
                            </div>
                            {teaching.feedback && (
                              <p className="teaching-feedback">
                                {teaching.feedback}
                              </p>
                            )}
                            {teaching.complete ? (
                              <>
                                <h3>把理解迁移到下一题</h3>
                                <p>{teaching.transfer}</p>
                              </>
                            ) : (
                              <>
                                <p>{teaching.lesson}</p>
                                <form
                                  onSubmit={(e) => {
                                    e.preventDefault();
                                    act(
                                      "teach.answer",
                                      { id: teaching.id, answer: teachAnswer },
                                      (next) => {
                                        setTeaching(next);
                                        setTeachAnswer("");
                                      },
                                    );
                                  }}
                                >
                                  <label>
                                    {teaching.check}
                                    <textarea
                                      required
                                      maxLength={10000}
                                      rows={3}
                                      value={teachAnswer}
                                      onChange={(e) =>
                                        setTeachAnswer(e.target.value)
                                      }
                                    />
                                  </label>
                                  <button
                                    className="primary"
                                    disabled={busy || !teachAnswer.trim()}
                                  >
                                    检查理解 →
                                  </button>
                                </form>
                              </>
                            )}
                          </section>
                        )}
                      </div>
                      <p className="keyboard-note">
                        {choice ? "1–6 选择选项 · " : ""}← → 切换题目
                        {!choice ? " · 空格翻卡" : ""}
                      </p>
                    </div>
                  </>
                )}
              </section>
            )}
          </>
        )}
      </main>
      {modal && (
        <div
          className="modal-backdrop"
          onClick={(e) => {
            if (e.target === e.currentTarget) setModal(null);
          }}
        >
          <section
            className="modal"
            role="dialog"
            aria-modal="true"
            aria-label={modal.type === "add" ? "添加资料" : "查看详情"}
          >
            <div className="modal-heading">
              <h2>
                {modal.type === "add"
                  ? "添加资料"
                  : modal.type === "sources"
                    ? "学习资料"
                    : modal.type === "flag"
                      ? "标记这道题"
                      : modal.source?.title || "资料不可用"}
              </h2>
              <button aria-label="关闭" onClick={() => setModal(null)}>
                ×
              </button>
            </div>
            {modal.type === "add" ? (
              sourceForm
            ) : modal.type === "sources" ? (
              data.sources
                .filter((s) => run?.sourceIds?.includes(s.id))
                .map((s) => (
                  <button
                    className="source-row"
                    key={s.id}
                    onClick={() => setModal({ type: "source", source: s })}
                  >
                    {s.title} <span>→</span>
                  </button>
                ))
            ) : modal.type === "flag" ? (
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  act(
                    "card.flag",
                    { deckId: run.deckId, cardId: run.card.id, reason: flag },
                    () => {
                      setModal(null);
                      setNotice(
                        flag ? "题目已标记，下轮优先复习" : "题目标记已清除",
                      );
                    },
                  );
                }}
              >
                <label>
                  问题或需要回顾的地方
                  <textarea
                    value={flag}
                    maxLength={1000}
                    onChange={(e) => setFlag(e.target.value)}
                    placeholder="例如：干扰项似乎也成立，需要核对原文"
                  />
                </label>
                <p className="muted">保留空白并保存可清除标记。</p>
                <button className="primary" disabled={busy}>
                  保存标记
                </button>
              </form>
            ) : (
              <>
                {modal.quote && (
                  <blockquote className="highlight-quote">
                    {modal.quote}
                  </blockquote>
                )}
                <pre className="source-text">
                  {modal.source?.text || "无法找到此资料。"}
                </pre>
              </>
            )}
          </section>
        </div>
      )}
    </div>
  );
}
