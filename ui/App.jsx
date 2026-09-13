import React, { useState, useEffect, useCallback, useRef } from "react";
import StudyMap from "./StudyMap.jsx";
import Markdown from "./Markdown.jsx";
import Guide from "./Guide.jsx";
import Ingest from "./Ingest.jsx";
import Dashboard from "./Dashboard.jsx";
import Exam from "./Exam.jsx";
import WrongBook from "./WrongBook.jsx";
import Graph from "./Graph.jsx";
import Cloze from "./Cloze.jsx";

const kinds = {
  quiz: "单选测验",
  multi: "多选测验",
  flashcard: "闪卡",
  open: "开放问答",
  cloze: "填空卡",
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
    if (q.cloze !== undefined) {
      if (
        !q.cloze ||
        typeof q.cloze.text !== "string" ||
        !Array.isArray(q.cloze.answers)
      )
        throw new Error("cloze 需要 text 和 answers 数组");
      if (q.cloze.answers.some((a) => !a || typeof a.id !== "string" || typeof a.value !== "string"))
        throw new Error("cloze answers 每项需要 id 和 value");
    }
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

export default function App({ call, host = {} }) {
  const rootRef = useRef(null),
    markRef = useRef(null),
    requestSequence = useRef(0),
    acting = useRef(false);
  /* 'auto' follows the OS; explicit 'dark'/'light' wins. The CSS already
     defaults to dark and reacts to prefers-color-scheme, so we only need to
     stamp an attribute when the learner overrides it. */
  const [theme, setTheme] = useState(() => {
    try {
      return localStorage.getItem("study-theme") || "auto";
    } catch {
      return "auto";
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem("study-theme", theme);
    } catch {}
  }, [theme]);
  const [managedDeck, setManagedDeck] = useState(null),
    [folderDraft, setFolderDraft] = useState("");
  const [data, setData] = useState(null),
    [binding, setBinding] = useState({ root: "", provider: "", model: "" }),
    [rootDraft, setRootDraft] = useState(null),
    [modelDraft, setModelDraft] = useState(null),
    [page, setPage] = useState("library");
  const [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [busy, setBusy] = useState(false),
    [loading, setLoading] = useState(true);
  const [modal, setModal] = useState(null),
    [sourceTitle, setSourceTitle] = useState(""),
    [sourceText, setSourceText] = useState("");
  const [graphScope, setGraphScope] = useState([]),
    [clozeValues, setClozeValues] = useState({});
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
  const [guide, setGuide] = useState(() => {
    try {
      return JSON.parse(localStorage.getItem("study-guide")) || {};
    } catch {
      return {};
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem("study-guide", JSON.stringify(guide));
    } catch {}
  }, [guide]);
  const [genSource, setGenSource] = useState("files");
  const [showBack, setShowBack] = useState(false),
    [rawSource, setRawSource] = useState(false),
    [settings, setSettings] = useState({}),
    [flag, setFlag] = useState(""),
    [teaching, setTeaching] = useState(null),
    [teachAnswer, setTeachAnswer] = useState("");
  const [notebooks, setNotebooks] = useState(null);
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
  // Cross-workspace directory: load once per library and refresh whenever the
  // learner returns to the library view, so due counts stay honest.
  const loadNotebooks = useCallback(async () => {
    try {
      setNotebooks(await call("notebook.list"));
    } catch {
      setNotebooks(null);
    }
  }, [call]);
  useEffect(() => {
    if (binding.root && page === "library") loadNotebooks();
  }, [binding.root, page, loadNotebooks]);
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
  useEffect(
    () => host.takeHandoff?.((runId) => act("review.get", { runId }, enterRun)),
    [],
  );
  // Links and fixes made in the conversation reach the open question without a reload.
  useEffect(() => {
    if (page !== "review" || !run?.card) return;
    const t = setInterval(async () => {
      if (document.hidden) return;
      try {
        const next = await call("review.get", { runId: run.id });
        setRun((r) =>
          // Merge only a response from the same answer state; a poll that started
          // before the learner answered must not wipe the revealed solution.
          r && r.id === next.id && r.index === next.index &&
          r.revealed === next.revealed && !!r.feedback === !!next.feedback &&
          JSON.stringify([r.prerequisites, r.card, r.solution, r.revision]) !==
            JSON.stringify([next.prerequisites, next.card, next.solution, next.revision])
            ? { ...r, prerequisites: next.prerequisites, card: next.card, solution: next.solution, revision: next.revision }
            : r,
        );
      } catch {}
    }, 4000);
    return () => clearInterval(t);
  }, [page, run?.id, run?.index, call]);
  const running = data?.jobs?.some(
    (j) => j.status === "running" || j.status === "queued",
  );
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
  // A citation lands on the quoted passage inside the source modal.
  useEffect(() => {
    if (modal?.type !== "source" || !modal.quote) return;
    const t = setTimeout(
      () => markRef.current?.scrollIntoView({ block: "center", behavior: "smooth" }),
      60,
    );
    return () => clearTimeout(t);
  }, [modal, rawSource]);
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
  const toggleNotebook = (publish) =>
    act(
      publish ? "notebook.publish" : "notebook.unpublish",
      {},
      (result) => setNotebooks(result),
    );
  const openNotebook = async (nb) => {
    setError("");
    try {
      await host.openWorkspaceNotebook?.(nb.workspace);
    } catch (e) {
      setError(e.message || String(e));
    }
  };
  const searchNotebooks = useCallback(
    async (query) => call("notebook.search", { query }),
    [call],
  );
  const reviewAct = (action, args = {}) =>
    act(action, { runId: run.id, cardId: run.card?.id, ...args }, enterRun);
  const choice =
    run?.mode !== "flashcard" && ["quiz", "multi"].includes(run?.card?.kind);
  const isCloze = run?.card?.kind === "cloze";
  // Each card mounts on the side matching its state; flipping after that is local.
  useEffect(() => {
    setShowBack(!!run?.revealed);
  }, [run?.id, run?.card?.id]);
  // A new card starts with empty blanks; feedback keeps them for the verdict.
  useEffect(() => {
    setClozeValues({});
  }, [run?.id, run?.card?.id]);
  async function flipCard() {
    if (!run?.card) return;
    if (run.revealed) {
      setShowBack((v) => !v);
      return;
    }
    if (busy) return;
    setShowBack(true);
    if (!(await reviewAct("review.reveal"))) setShowBack(false);
  }
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
      } else if (e.code === "Space" && !choice && !isCloze) {
        e.preventDefault();
        flipCard();
      } else if (choice && !run.feedback && /^[1-6]$/.test(e.key)) {
        const o = run.card.options[Number(e.key) - 1];
        if (o) choose(o.id);
      }
    }
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  });
  // Practise the given prerequisites (learned ones included), then offer a way back to this question.
  function studyPrerequisites(list) {
    act(
      "review.start",
      {
        mode: "path",
        scope: list.map(({ deckId, cardId }) => ({ deckId, cardId })),
        returnTo: run.id,
        fresh: true,
      },
      enterRun,
    );
  }
  // Hand the open question to the conversation; the reference tells the agent which card it is.
  function cardBrief() {
    const deck = data?.decks.find((d) => d.id === run.deckId);
    const options = run.card.options?.length
      ? "\n选项：\n" +
        run.card.options.map((o, i) => String.fromCharCode(65 + i) + ". " + o.text).join("\n")
      : "";
    return (
      "题组「" + (deck?.title || "") + "」· 主题「" + run.card.topic + "」\n" +
      "题目：" + run.card.prompt + options + "\n" +
      "题库定位：" + JSON.stringify({ deckId: run.deckId, cardId: run.card.id })
    );
  }
  function askAboutCard() {
    askInChat(
      "我在做这道题时卡住了，想先把前置知识问清楚（先别直接告诉我答案）：\n" +
        cardBrief() +
        "\n\n请先用 study_workspace 的 card.get 读这道题和它引用的资料。每弄清一个前置点，就用 capture（requiredBy 设为上面的题库定位）把它加为这道题的前置题；题库里已有的用 card.link 关联。\n我的问题：",
    );
  }
  function improveCard() {
    askInChat(
      "这道题的质量需要提升：\n" +
        cardBrief() +
        "\n\n请先用 study_workspace 的 card.get 读完整内容（答案、每个选项的解析、引用资料），按我说的问题修改，改完用 card.update 保存（reason 写清改了什么），再告诉我改动。\n问题：",
    );
  }
  async function askInChat(text) {
    if (host.askInChat?.(text)) {
      setNotice("已填入对话输入框，确认后发送。");
      return;
    }
    try {
      await navigator.clipboard.writeText(text);
      setNotice("已复制提示词，粘贴到对话中即可。");
    } catch {
      setNotice(text);
    }
  }
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
  function customBinding(patch) {
    return {
      root: binding.rootSource === "custom" ? binding.root : "",
      provider: binding.modelSource === "custom" ? binding.provider : "",
      model: binding.modelSource === "custom" ? binding.model : "",
      ...patch,
    };
  }
  async function updateBinding(patch) {
    setBusy(true);
    setError("");
    try {
      const value = await call("binding.set", customBinding(patch));
      const moved = value.root !== binding.root;
      setBinding(value);
      if (moved) {
        setSettings({});
        setRun(null);
        setDraft(null);
        setSelectedSources([]);
      }
      await refresh();
      setNotice(moved ? "已切换学习库" : "已更新生成模型");
      return true;
    } catch (e) {
      setError(e.message);
      return false;
    } finally {
      setBusy(false);
    }
  }
  async function chooseRoot() {
    if (!host.pickDirectory) {
      setRootDraft(binding.root || "");
      return;
    }
    try {
      const picked = await host.pickDirectory();
      if (picked) await updateBinding({ root: picked });
    } catch {
      setRootDraft(binding.root || "");
      setNotice("无法打开目录选择器，请直接输入路径。");
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
          maxLength={600000}
          onChange={(e) => setSourceText(e.target.value)}
          placeholder="粘贴讲义、笔记或材料。生成内容将引用这里的原文。"
        />
      </label>
      <div className="form-footer">
        <small>{sourceText.length.toLocaleString()} / 600,000 字符</small>
        <button className="primary" disabled={busy}>
          保存资料
        </button>
      </div>
    </form>
  );
  const modelGroups = host.modelGroups || [],
    followedModel =
      host.sessionModel ||
      (binding.modelSource === "session" ? binding.route : null);
  function modelName(m) {
    if (!m) return "";
    const group = modelGroups.find((g) => g.id === m.provider),
      model = group?.models.find((x) => x.id === m.model);
    return `${group?.name || m.provider} · ${model?.name || m.model}`;
  }
  const customModelKey =
    binding.modelSource === "custom"
      ? JSON.stringify([binding.provider, binding.model])
      : "";
  const customListed = modelGroups.some(
    (g) =>
      g.id === binding.provider && g.models.some((m) => m.id === binding.model),
  );
  const workspacePanel = (
    <div className="binding-panel">
      <div className="binding-row">
        <div className="binding-main">
          <span className="binding-label">学习库</span>
          <code className="binding-value" title={binding.root}>
            {binding.root || "—"}
          </code>
          <small>
            {binding.rootSource === "workspace"
              ? "当前工作区"
              : binding.rootSource === "config"
                ? "插件配置指定"
                : "自定义目录"}
            {" · "}资料、题库与复习记录保存在这里
          </small>
        </div>
        <div className="binding-actions">
          <button type="button" onClick={chooseRoot} disabled={busy}>
            更换目录…
          </button>
          {binding.rootSource === "custom" && (
            <button
              type="button"
              disabled={busy}
              onClick={() => updateBinding({ root: "" })}
            >
              改回当前工作区
            </button>
          )}
        </div>
      </div>
      {rootDraft !== null && (
        <form
          className="binding-inline"
          onSubmit={async (e) => {
            e.preventDefault();
            if (await updateBinding({ root: rootDraft })) setRootDraft(null);
          }}
        >
          <input
            autoFocus
            required
            aria-label="学习库绝对路径"
            value={rootDraft}
            onChange={(e) => setRootDraft(e.target.value)}
          />
          <button className="primary" disabled={busy}>
            使用此目录
          </button>
          <button type="button" onClick={() => setRootDraft(null)}>
            取消
          </button>
        </form>
      )}
      <div className="binding-row">
        <label className="binding-main">
          <span className="binding-label">生成模型</span>
          <select
            value={customModelKey}
            disabled={busy}
            onChange={(e) => {
              const v = e.target.value;
              if (v === "manual")
                setModelDraft({
                  provider: binding.provider,
                  model: binding.model,
                });
              else if (!v) updateBinding({ provider: "", model: "" });
              else {
                const [provider, model] = JSON.parse(v);
                updateBinding({ provider, model });
              }
            }}
          >
            <option value="">
              跟随当前会话
              {followedModel ? `（${modelName(followedModel)}）` : ""}
            </option>
            {modelGroups.map((g) => (
              <optgroup key={g.id} label={g.name || g.id}>
                {g.models.map((m) => (
                  <option key={m.id} value={JSON.stringify([g.id, m.id])}>
                    {m.name || m.id}
                  </option>
                ))}
              </optgroup>
            ))}
            {customModelKey && !customListed && (
              <option value={customModelKey}>{modelName(binding)}</option>
            )}
            <option value="manual">手动填写…</option>
          </select>
          <small>
            {binding.modelSource === "session"
              ? "与对话输入框选择的模型一致，切换后自动生效。"
              : "只用于出题与讲解，不改变对话模型。"}
            生成时所选资料会发送给该模型；复习不调用模型。
          </small>
        </label>
      </div>
      {modelDraft && (
        <form
          className="binding-inline"
          onSubmit={async (e) => {
            e.preventDefault();
            if (await updateBinding(modelDraft)) setModelDraft(null);
          }}
        >
          <input
            autoFocus
            required
            aria-label="Provider"
            placeholder="Provider"
            value={modelDraft.provider}
            onChange={(e) =>
              setModelDraft({ ...modelDraft, provider: e.target.value })
            }
          />
          <input
            required
            aria-label="模型 ID"
            placeholder="模型 ID"
            value={modelDraft.model}
            onChange={(e) =>
              setModelDraft({ ...modelDraft, model: e.target.value })
            }
          />
          <button className="primary" disabled={busy}>
            使用
          </button>
          <button type="button" onClick={() => setModelDraft(null)}>
            取消
          </button>
        </form>
      )}
    </div>
  );
  // Open by default until the core steps are done; an explicit toggle sticks.
  const guideProps = data && {
    data,
    busy,
    goal: guide.goal || "",
    setGoal: (goal) => setGuide((g) => ({ ...g, goal })),
    open: guide.open ?? !(data.decks.length && data.attempts.length),
    setOpen: (open) => setGuide((g) => ({ ...g, open })),
    addSource: () => setModal({ type: "add" }),
    generate: () => {
      setGenSource("files");
      setPage("generate");
    },
    record: () => {
      setGenSource("chat");
      setPage("generate");
    },
    openDraft,
    startToday: () => {
      const today = data.runs.find((r) => r.mode === "path" && !r.scope?.length);
      if (today) act("review.get", { runId: today.id }, enterRun);
      else act("review.start", { mode: "path" }, enterRun);
    },
    askInChat,
  };
  const shellTitle =
    page === "review"
      ? run?.title ||
        data?.decks.find((d) => d.id === run?.deckId)?.title ||
        "复习"
      : {
          library: "学习库",
          sources: "资料",
          generate: "创建题组",
          draft: "审阅草稿",
          settings: "工作区设置",
          manage: "维护题组",
          dashboard: "学习统计",
          exam: "模拟考试",
          wrongbook: "错题本",
          graph: "知识图谱",
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
      data-theme={theme === "auto" ? undefined : theme}
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
          <button
            className={
              "nav resume-nav" +
              (page === "review" ? " active" : "") +
              (data && !data.lastRun && !data.decks.length ? " muted-nav" : "")
            }
            disabled={!data || busy}
            title={
              !data
                ? ""
                : data.lastRun
                  ? `回到「${data.lastRun.title}」第 ${data.lastRun.index + 1}/${data.lastRun.total} 题`
                  : data.decks.length
                    ? "没有进行中的练习，开始今日学习"
                    : "还没有题目，先去创建题组"
            }
            onClick={() => {
              setError("");
              if (page === "review" && run && !run.complete) return;
              if (data.lastRun) act("review.get", { runId: data.lastRun.id }, enterRun);
              else if (data.decks.length) act("review.start", { mode: "path" }, enterRun);
              else {
                setGenSource("files");
                setPage("generate");
              }
            }}
          >
            <Icon>↩</Icon>
            <span className="nav-label">
              回到题目
              {data?.lastRun && (
                <small>
                  {data.lastRun.index + 1}/{data.lastRun.total} · {data.lastRun.title}
                </small>
              )}
            </span>
          </button>
          {[
            ["library", "▦", "学习库"],
            ["sources", "▤", "资料"],
            ["generate", "＋", "创建题组"],
            ["dashboard", "◔", "统计"],
            ["exam", "✎", "模拟考试"],
            ["wrongbook", "✗", "错题本"],
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
        {guideProps && <Guide {...guideProps} variant="sidebar" />}
        <div className="sidebar-bottom">
          <div className="local-status">
            <span />
            本地学习工作区
          </div>
          {/* Theme switch. `auto` is dark; light is explicit opt-in. */}
          <div className="theme-switch" role="group" aria-label="主题">
            {[
              ["auto", "◐", "跟随系统"],
              ["dark", "☾", "深色"],
              ["light", "☀", "浅色"],
            ].map(([id, glyph, label]) => (
              <button
                key={id}
                type="button"
                className={theme === id ? "seg active" : "seg"}
                aria-pressed={theme === id}
                title={label}
                onClick={() => setTheme(id)}
              >
                <span aria-hidden="true">{glyph}</span>
                <span className="sr-only">{label}</span>
              </button>
            ))}
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
          <nav className="crumbs" aria-label="位置">
            <span className="crumb">Study</span>
            <span className="breadcrumb" aria-hidden="true">
              ›
            </span>
            <span className="crumb current" aria-current="page">
              {shellTitle}
            </span>
          </nav>
          <span className="top-status">
            <i
              className={`dot ${busy || running ? "busy" : data ? "on" : ""}`}
              aria-hidden="true"
            />
            {busy
              ? "正在保存…"
              : running
                ? "正在生成…"
                : data
                  ? "已连接"
                  : "待连接"}
          </span>
        </header>
        {page === "review" && run && !run.complete && run.total > 0 && (
          <div
            className="progress-bar"
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={run.total}
            aria-valuenow={run.index + 1}
            aria-label="复习进度"
          >
            <span
              style={{
                width: `${Math.round(((run.index + 1) / run.total) * 100)}%`,
              }}
            />
          </div>
        )}
        {data?.ingest && (
          <div role="status" className="alert ingest-banner">
            <span>
              <strong>录题中</strong> · 题组「{data.ingest.deckTitle}」· 已录入 {data.ingest.added} 题
              <small>在对话里直接贴题目或截图即可</small>
            </span>
            <button
              disabled={busy}
              onClick={() =>
                act("ingest.stop", {}, (r) => setNotice(`已停止录题，本次录入 ${r.added} 题。`))
              }
            >
              停止录题
            </button>
          </div>
        )}
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
              学习库默认在当前工作区，出题模型跟随当前会话。无法打开时，可以换一个目录后重试。
            </p>
            {workspacePanel}
            <button
              className="primary"
              disabled={busy}
              onClick={() =>
                refresh().then(
                  () => setError(""),
                  (e) => setError(e.message),
                )
              }
            >
              重试
            </button>
          </section>
        ) : (
          <>
            {page === "library" && (
              <StudyMap
                data={data}
                busy={busy}
                start={(args) => act("review.start", args, enterRun)}
                resume={(runId) => act("review.get", { runId }, enterRun)}
                endRun={(runId) => act("review.end", { runId })}
                manage={(id) =>
                  act("deck.get", { id }, (deck) => {
                    setManagedDeck(deck);
                    setFolderDraft(deck.folder || "");
                    setPage("manage");
                  })
                }
                openDraft={openDraft}
                addSource={() => setModal({ type: "add" })}
                createManual={() =>
                  openDraft({
                    id: crypto.randomUUID(),
                    title: "新建闪卡题组",
                    cards: [blankCard()],
                  })
                }
                importLibrary={() => setPage("settings")}
                askInChat={askInChat}
                theme={theme}
                setTheme={setTheme}
                notebooks={notebooks}
                onNotebookPublish={() => toggleNotebook(true)}
                onNotebookUnpublish={() => toggleNotebook(false)}
                onNotebookOpen={openNotebook}
                refreshNotebooks={loadNotebooks}
                onNotebookSearch={searchNotebooks}
                onShowGraph={(scope) => {
                  setGraphScope(scope || []);
                  setPage("graph");
                }}
              >
                <Guide {...guideProps} variant="inline" />
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
              </StudyMap>
            )}
            {page === "dashboard" && (
              <Dashboard
                call={call}
                data={data}
                onStartScope={(scope) =>
                  act("review.start", { mode: "path", scope }, enterRun)
                }
              />
            )}
            {page === "exam" && (
              <Exam
                call={call}
                data={data}
                onExit={() => setPage("library")}
                onCreate={() => {
                  setGenSource("files");
                  setPage("generate");
                }}
              />
            )}
            {page === "wrongbook" && (
              <WrongBook
                call={call}
                busy={busy}
                onPractice={(scope) =>
                  act(
                    "review.start",
                    { mode: "path", scope, fresh: true },
                    enterRun,
                  )
                }
              />
            )}
            {page === "graph" && (
              <Graph
                call={call}
                busy={busy}
                scope={graphScope}
                onClose={() => setPage("library")}
                onStudyCard={({ deckId, cardId }) =>
                  act(
                    "review.start",
                    { mode: "path", scope: [{ deckId, cardId }], fresh: true },
                    enterRun,
                  )
                }
              />
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
                <form
                  className="binding-inline folder-form"
                  onSubmit={(e) => {
                    e.preventDefault();
                    act(
                      "deck.move",
                      { id: managedDeck.id, folder: folderDraft },
                      (moved) => {
                        setManagedDeck({ ...managedDeck, folder: moved.folder });
                        setFolderDraft(moved.folder);
                        setNotice(moved.folder ? `已放入目录「${moved.folder}」` : "已移到目录顶层");
                      },
                    );
                  }}
                >
                  <input
                    aria-label="所在目录"
                    value={folderDraft}
                    onChange={(e) => setFolderDraft(e.target.value)}
                    placeholder="所在目录，例如：设计模式 / 第 4 章（留空为顶层）"
                  />
                  <button disabled={busy || folderDraft === (managedDeck.folder || "")}>
                    保存目录
                  </button>
                </form>
                {managedDeck.cards.map((card) => (
                  <article className="deck" key={card.id}>
                    <small>
                      {card.topic} · {card.kind}
                      {card.suspended ? " · 已暂停" : ""}
                    </small>
                    <Markdown className="md-title" text={card.prompt} />
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
              <section className="page">
                <div className="eyebrow">SOURCE → UNDERSTANDING</div>
                <h1>创建一组值得练的题</h1>
                <div className="source-mode" role="tablist" aria-label="题目来源">
                  {[
                    ["files", "从资料生成", "选已保存的讲义、笔记"],
                    ["chat", "现场对话录题", "直接贴刷题软件、Canvas 错题或截图"],
                  ].map(([id, label, note]) => (
                    <button
                      key={id}
                      type="button"
                      role="tab"
                      aria-selected={genSource === id}
                      className={genSource === id ? "source-tab active" : "source-tab"}
                      onClick={() => setGenSource(id)}
                    >
                      <strong>{label}</strong>
                      <small>{note}</small>
                    </button>
                  ))}
                </div>
                {genSource === "chat" ? (
                  <Ingest
                    data={data}
                    busy={busy}
                    start={(config) =>
                      act("ingest.start", config, (mode) => {
                        const kindText = {
                          auto: "自动识别（有选项的保持单选/多选，没有选项的做成问答闪卡）",
                          flashcard: "一律闪卡",
                          quiz: "一律单选 MQ",
                          multi: "一律多选",
                          open: "一律开放问答",
                        }[mode.kind];
                        const mistakeText = {
                          auto: "我标明自己选错的记为错题",
                          all: "这批全部当错题",
                          none: "都不记为错题",
                        }[mode.mistakes];
                        askInChat(
                          "开始录题：接下来这段对话里我贴的题目（刷题软件、Canvas 错题记录、截图都可能），请都用 study_workspace 的 ingest 直接录入学习库，不用再问我确认。\n" +
                            "- 题组：「" + mode.deckTitle + "」" + (mode.folder ? "（目录 " + mode.folder + "）" : "") + "\n" +
                            "- 题型：" + kindText + "\n" +
                            "- 错题：" + mistakeText + "\n" +
                            "- 截图请先逐字转写题目、选项和答案再录入；一次贴很多题时可以分批。\n" +
                            "- 每批录完简短告诉我：录入几道、哪些重复、哪些没录成功及原因、哪些答案是推断的需要我核对。\n" +
                            "- 我说「停止录题」时调用 ingest.stop。\n" +
                            "第一批题目：\n",
                        );
                      })
                    }
                  />
                ) : (
                <>
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
                      (job) => {
                        setPage("library");
                        setNotice(
                          (job.status === "queued"
                            ? `已加入队列（前面还有 ${job.queuedBehind} 个）`
                            : "已开始生成") +
                            (job.parts > 1 ? `，资料较多，会分 ${job.parts} 段出题再合并` : "") +
                            "。完成后出现在待审阅列表。",
                        );
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
                      当前会话没有可用模型。请在对话输入框选择模型，或在设置中指定生成模型。
                    </p>
                  )}
                  <button
                    className="primary wide"
                    disabled={
                      busy || !selectedSources.length || !data.modelReady
                    }
                  >
                    {running ? "加入生成队列 →" : "生成并检查题组 →"}
                  </button>
                </form>
                </>
                )}
              </section>
            )}
            {page === "draft" && draft && (
              <section className="page">
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
              <section className="page">
                <h1>工作区设置</h1>
                <p className="muted">资料、题库、调度与模型，由你掌控。</p>
                <fieldset>
                  <legend>学习库与模型</legend>
                  {workspacePanel}
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
                  <div className="review-heading-actions">
                    {host.openInSidebar && !run.complete && (
                      <button
                        className="ghost-btn"
                        title="题目放到右栏，主区域回到对话"
                        onClick={() => host.openInSidebar(run.id)}
                      >
                        在右栏打开
                      </button>
                    )}
                    <button onClick={() => setPage("library")}>返回学习库</button>
                  </div>
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
                    <div className="summary-actions">
                      {run.weakTopics?.length > 0 && (
                        <button
                          onClick={() =>
                            askInChat(
                              `我刚在「${shellTitle}」里这些主题答得不好：${run.weakTopics.join("、")}。请结合学习库资料逐个讲清楚，并各出一道小题检查我。`,
                            )
                          }
                        >
                          在对话中讲解薄弱点
                        </button>
                      )}
                      <button
                        className={run.returnTo ? "" : "primary"}
                        onClick={() => setPage("library")}
                      >
                        回到学习目录
                      </button>
                      {run.returnTo && (
                        <button
                          className="primary"
                          disabled={busy}
                          onClick={() => act("review.get", { runId: run.returnTo }, enterRun)}
                        >
                          回到原题 →
                        </button>
                      )}
                    </div>
                  </div>
                ) : (
                  <>
                    <div
                      className={
                        "question-area " +
                        (!choice && !isCloze ? "flash-area" : "")
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
                      {run.prerequisites?.length > 0 && (
                        <details className="prereq-strip">
                          <summary>
                            <span>
                              前置题 {run.prerequisites.length} · 已掌握{" "}
                              {run.prerequisites.filter((p) => !["new", "weak"].includes(p.level)).length}
                            </span>
                            {(() => {
                              const unlearned = run.prerequisites.some((p) => ["new", "weak"].includes(p.level));
                              return (
                                <button
                                  className={unlearned ? "primary pill" : "pill"}
                                  disabled={busy}
                                  title={unlearned ? "先学没掌握的前置题，学完回到这道题" : "把前置题再过一遍自查，做完回到这道题"}
                                  onClick={(e) => {
                                    e.preventDefault();
                                    studyPrerequisites(run.prerequisites);
                                  }}
                                >
                                  {unlearned ? "先学前置 →" : "自查前置 →"}
                                </button>
                              );
                            })()}
                          </summary>
                          <ul>
                            {run.prerequisites.map((p) => (
                              <li key={p.deckId + p.cardId}>
                                <button
                                  className="prereq-item"
                                  disabled={busy}
                                  title="只练这一道，做完回到这道题"
                                  onClick={() => studyPrerequisites([p])}
                                >
                                  <span className={"map-dot lv-" + p.level} />
                                  <Markdown className="md-compact" links={false} text={p.prompt} />
                                  <span className="prereq-go" aria-hidden="true">→</span>
                                </button>
                              </li>
                            ))}
                          </ul>
                        </details>
                      )}
                      {choice ? (
                        <>
                          <div className="question" role="heading" aria-level={2}>
                            <Markdown text={run.card.prompt} />
                          </div>
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
                                    <Markdown text={o.text} links={false} className="md-compact" />
                                    {run.feedback && (
                                      <>
                                        <strong className="answer-state">
                                          {solution?.correct
                                            ? "✓ 正确答案"
                                            : picked
                                              ? "× 还差一点"
                                              : ""}
                                        </strong>
                                        <Markdown
                                          text={solution?.explanation}
                                          links={false}
                                          className="md-compact option-explanation"
                                        />
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
                      ) : isCloze ? (
                        <>
                          <Cloze
                            card={run.card}
                            values={clozeValues}
                            onChange={(id, value) =>
                              setClozeValues((v) => ({ ...v, [id]: value }))
                            }
                            disabled={busy || !!run.feedback}
                            details={run.feedback?.details || null}
                          />
                          {!run.feedback && (
                            <button
                              className="primary submit-answer"
                              disabled={
                                busy ||
                                !Object.values(clozeValues).some((v) =>
                                  String(v).trim(),
                                )
                              }
                              onClick={() =>
                                reviewAct("review.answer", { answers: clozeValues })
                              }
                            >
                              提交答案
                            </button>
                          )}
                          {run.feedback && (
                            <div className="cloze-verdicts">
                              {(run.feedback.details || []).map((d) => (
                                <span
                                  key={d.id}
                                  className={d.correct ? "tag" : "tag bad"}
                                  title={
                                    d.correct
                                      ? "这个空回答正确"
                                      : `应为：${d.expected ?? "—"}`
                                  }
                                >
                                  {d.correct ? "✓" : `✗ ${d.expected ?? ""}`}
                                </span>
                              ))}
                            </div>
                          )}
                        </>
                      ) : (
                        <>
                          <button
                            key={run.card.id}
                            className={"flashcard" + (showBack ? " flipped" : "")}
                            disabled={busy && !run.revealed}
                            aria-pressed={showBack}
                            aria-label={showBack ? "翻回题目" : "翻面查看答案"}
                            onClick={flipCard}
                          >
                            <div className="flip-inner">
                              <div className="flip-face flip-front" aria-hidden={showBack}>
                                <Markdown
                                  links={false}
                                  className={"flash-prompt" + (run.card.prompt.length > 90 ? " long" : "")}
                                  text={run.card.prompt}
                                />
                                <span className="flip-label">
                                  {run.revealed ? "点击看答案 · Space" : "点击翻面 · Space"}
                                </span>
                              </div>
                              <div className="flip-face flip-back" aria-hidden={!showBack}>
                                <Markdown links={false} className="flip-question" text={run.card.prompt} />
                                {run.solution ? (
                                  <Markdown
                                    links={false}
                                    className={"flash-prompt" + ((run.solution.answer || "").length > 120 ? " long" : "")}
                                    text={run.solution.answer}
                                  />
                                ) : (
                                  <div className="flash-prompt">
                                    <span className="flip-loading" aria-label="正在载入答案" />
                                  </div>
                                )}
                                <span className="flip-label">参考答案 · 再点翻回题目</span>
                              </div>
                            </div>
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
                          <button
                            className="pill"
                            title="带着这道题去对话里问，弄懂的点会成为它的前置题"
                            onClick={askAboutCard}
                          >
                            不会？问 AI
                          </button>
                          <button
                            className="pill"
                            title="带着这道题去对话里说哪里不好，AI 会直接改这张卡"
                            onClick={improveCard}
                          >
                            提升质量
                          </button>
                        </div>
                        {run.mode === "exam" && (
                          <p className="muted small next-due">
                            这是进行中的模拟考试：这里可以继续作答，交卷和成绩单在「模拟考试」页。
                          </p>
                        )}
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
                            disabled={busy || (!run.feedback && run.mode !== "exam")}
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
                          <Markdown text={run.card.hint} />
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
                          <Markdown text={run.solution.explanation} />
                          <h4>容易混淆的地方</h4>
                          <Markdown text={run.solution.misconception} />
                          {run.solution.rubric && (
                            <>
                              <h4>评分依据</h4>
                              <Markdown text={run.solution.rubric} />
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
                              <Markdown className="teaching-feedback" text={teaching.feedback} />
                            )}
                            {teaching.complete ? (
                              <>
                                <h3>把理解迁移到下一题</h3>
                                <Markdown text={teaching.transfer} />
                              </>
                            ) : (
                              <>
                                <Markdown text={teaching.lesson} />
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
                                    <Markdown text={teaching.check} />
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
                {modal.source ? (
                  <>
                    <div className="source-view-toggle">
                      <button
                        className={rawSource ? "chip" : "chip active"}
                        aria-pressed={!rawSource}
                        onClick={() => setRawSource(false)}
                      >
                        排版
                      </button>
                      <button
                        className={rawSource ? "chip active" : "chip"}
                        aria-pressed={rawSource}
                        onClick={() => setRawSource(true)}
                      >
                        原文
                      </button>
                    </div>
                    {(() => {
                      const text = modal.source.text,
                        quote = modal.quote || "",
                        at = quote ? text.indexOf(quote) : -1;
                      if (at < 0)
                        return rawSource ? (
                          <pre className="source-text">{text}</pre>
                        ) : (
                          <Markdown
                            className="source-text source-md"
                            text={text}
                          />
                        );
                      // The quote is verbatim-validated, so slicing the
                      // source at it keeps the passage exactly once on screen.
                      const hit = (
                        <mark className="source-hit" ref={markRef}>
                          {quote}
                        </mark>
                      );
                      if (rawSource)
                        return (
                          <pre className="source-text">
                            {text.slice(0, at)}
                            {hit}
                            {text.slice(at + quote.length)}
                          </pre>
                        );
                      return (
                        <div className="source-text source-md">
                          <Markdown text={text.slice(0, at)} />
                          {hit}
                          <Markdown text={text.slice(at + quote.length)} />
                        </div>
                      );
                    })()}
                  </>
                ) : (
                  <p className="muted">无法找到此资料。</p>
                )}
              </>
            )}
          </section>
        </div>
      )}
    </div>
  );
}
