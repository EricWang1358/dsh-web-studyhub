import React, { useState, useEffect, useCallback, useRef } from "react";
import StudyMap from "./StudyMap.jsx";
import Markdown from "./Markdown.jsx";
import Guide from "./Guide.jsx";
import Dashboard from "./Dashboard.jsx";
import Exam from "./Exam.jsx";
import WrongBook from "./WrongBook.jsx";
import Board, { useBoard } from "./Board.jsx";
import Graph from "./Graph.jsx";
import Icon from "./Icon.jsx";
import Sources from "./Sources.jsx";
import Manage from "./Manage.jsx";
import Settings from "./Settings.jsx";
import Generate from "./Generate.jsx";
import PdfImport from "./PdfImport.jsx";
import Draft from "./Draft.jsx";
import Review from "./Review.jsx";
import { mergeReviewPoll, reviewEntryKey } from "./async.js";
import { isTransientStudyError } from "./transport.js";
import ShortcutHelp from "./ShortcutHelp.jsx";
import css from "./coach.css";
import { useInjectCss } from "./shared.js";

const AUTO_ADVANCE_MS = 1500;
const THEMES = [
  ["auto", "◐", "跟随系统"],
  ["dark", "☾", "深色"],
  ["light", "☀", "浅色"],
];

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
  useInjectCss(css, "study-coach");
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
  /* Sidebar collapse. The manual choice is persisted; a narrow workspace
     forces the icon rail regardless of the stored preference. */
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => {
    try {
      return localStorage.getItem("study-sidebar") === "collapsed";
    } catch {
      return false;
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem("study-sidebar", sidebarCollapsed ? "collapsed" : "open");
    } catch {}
  }, [sidebarCollapsed]);
  const [narrowWindow, setNarrowWindow] = useState(false),
    [coachSide, setCoachSide] = useState(false);
  /* The loading screen renders .study-app without rootRef, so attach the
     observer through a callback ref instead of a mount-time effect. */
  const narrowObserver = useRef(null);
  const attachRoot = (node) => {
    rootRef.current = node;
    narrowObserver.current?.disconnect();
    narrowObserver.current = null;
    if (node && typeof ResizeObserver !== "undefined") {
      const ro = new ResizeObserver(([entry]) => {
        setNarrowWindow(entry.contentRect.width <= 720);
        // Room for a 陪学 column beside the question; otherwise it goes inline.
        setCoachSide(entry.contentRect.width >= 1240);
      });
      ro.observe(node);
      narrowObserver.current = ro;
    }
  };
  useEffect(() => () => narrowObserver.current?.disconnect(), []);
  const sidebarNarrow = sidebarCollapsed || narrowWindow;
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
    [graphCanvas, setGraphCanvas] = useState(false),
    [clozeValues, setClozeValues] = useState({});
  const [selectedSources, setSelectedSources] = useState([]),
    [gen, setGen] = useState({
      kind: "mixed",
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
    [examRunId, setExamRunId] = useState(null),
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
  // EN 开关：开启后每张卡在其英文翻译就绪时展示「中文题干/答案 + 英文」。
  const [showEn, setShowEn] = useState(() => {
    try {
      return localStorage.getItem("study-en") === "1";
    } catch {
      return false;
    }
  });
  const [enBusyKey, setEnBusyKey] = useState("");
  useEffect(() => {
    try {
      localStorage.setItem("study-en", showEn ? "1" : "0");
    } catch {}
  }, [showEn]);
  const [genSource, setGenSource] = useState("files");
  const [showBack, setShowBack] = useState(false),
    [rawSource, setRawSource] = useState(false),
    [settings, setSettings] = useState({}),
    [flag, setFlag] = useState(""),
    [teaching, setTeaching] = useState(null),
    [teachAnswer, setTeachAnswer] = useState("");
  const [notebooks, setNotebooks] = useState(null);
  const boardState = useBoard(call, page === "board");
  const boardCount = boardState.board?.columns.reduce((n, column) => n + (column.done ? 0 : column.cardIds.length), 0);
  const dataRef = useRef(null),
    snapshotKey = useRef("");
  const refresh = useCallback(async () => {
    const sequence = ++requestSequence.current;
    const since = dataRef.current?.fingerprint;
    const next = await call("snapshot", since ? { since } : {});
    // Nothing visible changed: skip transferring, diffing and re-rendering.
    if (next.unchanged && dataRef.current) return dataRef.current;
    if (sequence === requestSequence.current && !next.unchanged) {
      // Root, model availability and due counts can change without a store write.
      // Compare the full public snapshot before skipping a render.
      const cur = dataRef.current;
      const nextKey = JSON.stringify(next);
      if (!cur || snapshotKey.current !== nextKey) {
        if (cur && cur.root !== next.root) {
          setRun(null);
          setExamRunId(null);
          setDraft(null);
          setRecovery(null);
          setManagedDeck(null);
          setGraphScope([]);
          setGraphCanvas(false);
          setSelectedSources([]);
          setTeaching(null);
          setModal(null);
          setPage("library");
          setSettings(next.settings);
          setBinding((b) => ({ ...b, root: next.root }));
        }
        dataRef.current = next;
        snapshotKey.current = nextKey;
        setData(next);
        setSettings((current) =>
          Object.keys(current).length ? current : next.settings,
        );
      }
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
  const [connecting, setConnecting] = useState("");
  useEffect(() => {
    let live = true;
    (async () => {
      // Right after a host restart the plugin route may not exist yet; keep
      // retrying for a while instead of stranding the panel on an error.
      for (let attempt = 0; live; attempt++) {
        try {
          // Both requests resolve the library on the server; firing them together
          // saves a full round trip on first open.
          const [b, snapshot] = await Promise.allSettled([call("binding.get"), refresh()]);
          if (b.status === "rejected") throw b.reason;
          if (live) setBinding(b.value);
          if (b.value.root && snapshot.status === "rejected") throw snapshot.reason;
          break;
        } catch (e) {
          if (!live) return;
          if (isTransientStudyError(e) && attempt < 20) {
            setConnecting(`正在连接学习插件…（第 ${attempt + 1} 次重试）`);
            await new Promise((r) => setTimeout(r, Math.min(1000 * (attempt + 1), 5000)));
            continue;
          }
          setError(e.message);
          break;
        }
      }
      if (live) {
        setConnecting("");
        setLoading(false);
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
        setRun((r) => mergeReviewPoll(r, next));
      } catch {}
    }, 4000);
    return () => clearInterval(t);
  }, [page, run?.id, run?.index, call]);
  const running = data?.jobs?.some(
    (j) => ["running", "queued", "cancelling"].includes(j.status),
  );
  const reviewQueueVersion = run?.queueVersion || 0;
  useEffect(() => {
    if (!reviewQueueVersion) return;
    setSelected([]);
    setHint(false);
    setExplain(false);
    setResponse("");
    setTeaching(null);
    setTeachAnswer("");
    setClozeValues({});
  }, [reviewQueueVersion]);
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
  async function act(action, args = {}, after, { refreshAfter = true } = {}) {
    if (acting.current) return;
    acting.current = true;
    setBusy(true);
    setError("");
    try {
      const result = await call(action, args);
      if (after) await after(result);
      // Practice steps return the run they changed; the library snapshot
      // (about 1MB with sources) catches up on the next poll instead of
      // blocking every answer and every 下一题.
      if (refreshAfter) await refresh();
      return result;
    } catch (e) {
      setError(e.message || String(e));
    } finally {
      acting.current = false;
      setBusy(false);
    }
  }
  function enterRun(r) {
    runRef.current = r;
    if (r.mode === "exam") {
      setExamRunId(r.id);
      setPage("exam");
      return;
    }
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
    act(action, { runId: run.id, cardId: run.card?.id, queueVersion: run.queueVersion || 0, ...args }, enterRun,
      { refreshAfter: !["review.answer", "review.move", "review.reveal"].includes(action) });
  const reviewActRef = useRef(reviewAct);
  reviewActRef.current = reviewAct;
  function resumeOrStart() {
    setError("");
    if (page === "review" && run && !run.complete) return;
    if (data?.lastRun) act("review.get", { runId: data.lastRun.id }, enterRun);
    else if (data?.decks.length) act("review.start", { mode: "path" }, enterRun);
    else {
      setGenSource("files");
      setPage("generate");
    }
  }
  /* 自动驾驶 (a local preference): after a correct answer move on by itself,
     unless the learner touches anything during the short countdown. */
  const [autopilot, setAutopilot] = useState(() => {
    try {
      return localStorage.getItem("study-autopilot") === "on";
    } catch {
      return false;
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem("study-autopilot", autopilot ? "on" : "off");
    } catch {}
  }, [autopilot]);
  const [autoAdvance, setAutoAdvance] = useState(""),
    [shortcutHelp, setShortcutHelp] = useState(false);
  const autoTimer = useRef(null),
    autoSkipped = useRef(""),
    cancelRef = useRef(null);
  function cancelAutoAdvance() {
    if (!autoTimer.current) return;
    clearTimeout(autoTimer.current);
    autoTimer.current = null;
    setAutoAdvance((key) => {
      autoSkipped.current = key;
      return "";
    });
  }
  cancelRef.current = cancelAutoAdvance;
  const passed = !!run?.feedback && (run.feedback.grade !== undefined ? run.feedback.grade >= 3 : run.feedback.correct);
  const advanceKey = run ? `${run.id}:${run.index}:${run.queueVersion || 0}` : "";
  useEffect(() => {
    clearTimeout(autoTimer.current);
    autoTimer.current = null;
    if (!autopilot || page !== "review" || !passed || run?.complete || teaching || autoSkipped.current === advanceKey) {
      setAutoAdvance("");
      return;
    }
    setAutoAdvance(advanceKey);
    autoTimer.current = setTimeout(() => {
      autoTimer.current = null;
      setAutoAdvance("");
      reviewActRef.current("review.move", { direction: 1 });
    }, AUTO_ADVANCE_MS);
    return () => clearTimeout(autoTimer.current);
  }, [autopilot, page, passed, advanceKey, run?.complete, !!teaching]); // eslint-disable-line react-hooks/exhaustive-deps
  // Coach plumbing: stable callbacks so the memoized panel does not re-render per poll.
  const onCoachThread = useCallback((thread, originKey) => setRun((r) => (r && reviewEntryKey(r) === originKey ? { ...r, coach: thread } : r)), []);
  const onCoachStatus = useCallback(() => refresh().catch(() => {}), [refresh]);
  const onCoachRefreshRun = useCallback(async () => {
    const current = runRef.current;
    if (!current) return;
    try {
      const next = await call("review.get", { runId: current.id });
      setRun((r) => (reviewEntryKey(r) === reviewEntryKey(current) ? mergeReviewPoll(r, next) : r));
    } catch {}
  }, [call]);
  const runRef = useRef(run);
  runRef.current = run;
  // One translate per card entry; a second click joins the in-flight call.
  const enFlight = useRef(new Set());
  const translateEn = useCallback(async (r) => {
    if (!r?.card || r.complete || r.mode === "exam") return;
    const key = reviewEntryKey(r);
    if (!key || enFlight.current.has(key)) return;
    enFlight.current.add(key);
    setEnBusyKey(key);
    try {
      await call("card.translate", { deckId: r.deckId, cardId: r.card.id });
      const next = await call("review.get", { runId: r.id });
      setRun((cur) => (reviewEntryKey(cur) === key ? mergeReviewPoll(cur, next) : cur));
    } catch (e) {
      if (reviewEntryKey(runRef.current) === key) setError(e.message || String(e));
    } finally {
      enFlight.current.delete(key);
      setEnBusyKey((k) => (k === key ? "" : k));
    }
  }, [call]);
  // With EN on, each newly opened card gets translated once (server caches it).
  useEffect(() => {
    if (page !== "review" || !showEn || !run?.card || run.complete || run.mode === "exam") return;
    if (run.card.translation) return;
    translateEn(run);
    // The listed run fields identify the open entry; the full object is not a dep.
  }, [page, showEn, run?.id, run?.index, run?.card?.id, run?.card?.translation, translateEn]); // eslint-disable-line react-hooks/exhaustive-deps
  function toggleEn() {
    const next = !showEn;
    setShowEn(next);
    if (next && run && !run.card?.translation) translateEn(run);
  }
  // Latest-closure refs keep the memoized 陪学 panel's props stable across renders.
  const latest = useRef({});
  latest.current = { act, enterRun, askInChat, page };
  const teachingInFlight = useRef(new Set());
  const [teachingPending, setTeachingPending] = useState({});
  async function teachingAct(action, args = {}) {
    const origin = runRef.current;
    const key = reviewEntryKey(origin);
    if (!key || teachingInFlight.current.has(key)) return;
    teachingInFlight.current.add(key);
    setTeachingPending((all) => ({ ...all, [key]: true }));
    const isCurrent = () => latest.current.page === "review" && reviewEntryKey(runRef.current) === key;
    try {
      const next = await call(action, { runId: origin.id, cardId: origin.card.id, index: origin.index, queueVersion: origin.queueVersion || 0, ...args });
      if (isCurrent()) {
        setTeaching(next);
        if (action === "teach.answer") setTeachAnswer((value) => value === args.answer ? "" : value);
      }
    } catch (e) {
      if (isCurrent()) setError(e.message || String(e));
    } finally {
      teachingInFlight.current.delete(key);
      setTeachingPending((all) => {
        const next = { ...all };
        delete next[key];
        return next;
      });
    }
  }
  const onCoachPractice = useCallback(() => latest.current.act("coach.practice", {}, latest.current.enterRun), []);
  const onCoachAsk = useCallback((text) => latest.current.askInChat(text), []);
  // The last answer of a round prefetches its debrief, so 完成 opens instantly.
  const [debriefs, setDebriefs] = useState({});
  const allAnswered = !!run && !run.complete && run.mode !== "exam" && !!run.navigation?.length && run.navigation.every((x) => x.answered);
  useEffect(() => {
    if (!allAnswered || debriefs[run.id]) return;
    const runId = run.id;
    call("coach.debrief", { runId })
      .then((d) => setDebriefs((all) => ({ ...all, [runId]: d })))
      .catch(() => {});
  }, [allAnswered, run?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const choice =
    run?.mode !== "flashcard" && ["quiz", "multi"].includes(run?.card?.kind);
  const isCloze = run?.mode !== "flashcard" && run?.card?.kind === "cloze";
  // Each card mounts on the side matching its state; flipping after that is local.
  useEffect(() => {
    setShowBack(!!run?.revealed);
  }, [run?.id, run?.card?.id, run?.index, run?.queueVersion]);
  // A new card starts with empty blanks; feedback keeps them for the verdict.
  useEffect(() => {
    setClozeValues({});
  }, [run?.id, run?.card?.id, run?.index]);
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
  // The handler reads fresh state on every render via a ref, while the window
  // subscription stays installed for the component's lifetime — rebinding on
  // each poll tick was pure churn.
  const keyRef = useRef(null),
    engagedRef = useRef(false);
  // Clicking an option or grade disables it, which drops focus to <body>.
  // Keep shortcuts alive when the learner's last interaction was in the panel.
  function shortcutTarget(e) {
    const active = document.activeElement;
    const inside = rootRef.current?.contains(active) ||
      ((!active || active === document.body) && engagedRef.current);
    return !!inside && !e.target.closest?.("input,textarea,select,[contenteditable],dialog") &&
      !e.ctrlKey && !e.metaKey && !e.altKey && !modal;
  }
  const canShortcut = (e) =>
    shortcutTarget(e) && !e.defaultPrevented && !e.repeat && !e.shiftKey && page === "review" && !!run?.card;
  useEffect(() => {
    function key(e) {
      if (!shortcutTarget(e) || e.defaultPrevented || e.repeat) return;
      cancelAutoAdvance();
      if (e.key === "?" || (e.shiftKey && e.code === "Slash")) {
        e.preventDefault();
        setShortcutHelp((v) => !v);
        return;
      }
      if (e.key === "Escape" && shortcutHelp) {
        setShortcutHelp(false);
        return;
      }
      if (e.shiftKey || (e.target.closest("button") && (e.key === "Enter" || e.code === "Space"))) return;
      const letter = e.key.length === 1 ? e.key.toLowerCase() : "";
      if (letter === "a") {
        e.preventDefault();
        setAutopilot((v) => !v);
        return;
      }
      // S from anywhere: resume the last round or start today's path.
      if (letter === "s" && !busy && (page !== "review" || !run || run.complete)) {
        e.preventDefault();
        resumeOrStart();
        return;
      }
      if (page !== "review" || !run?.card || busy) return;
      if (!choice && !isCloze && run.revealed && !run.feedback && /^[0-5]$/.test(e.key)) {
        e.preventDefault();
        reviewAct("review.answer", { grade: Number(e.key) });
        return;
      }
      if (e.key === "Enter") {
        e.preventDefault();
        if (run.feedback) reviewAct("review.move", { direction: 1 });
        else if (choice && run.card.multiple && selected.length) reviewAct("review.answer", { selected });
        else if (isCloze && Object.values(clozeValues).some((v) => String(v).trim())) reviewAct("review.answer", { answers: clozeValues });
        else if (!choice && !isCloze) flipCard();
      } else if (letter === "h") {
        e.preventDefault();
        if (run.revealed) setExplain((v) => !v);
        else setHint((v) => !v);
      } else if (e.key === "ArrowRight" && run.feedback) {
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
    keyRef.current = key;
  });
  useEffect(() => {
    const handler = (e) => keyRef.current?.(e);
    const engage = (e) => {
      engagedRef.current = !!rootRef.current?.contains(e.target);
      if (e.type === "pointerdown") cancelRef.current?.();
    };
    window.addEventListener("keydown", handler);
    document.addEventListener("pointerdown", engage, true);
    document.addEventListener("focusin", engage, true);
    return () => {
      window.removeEventListener("keydown", handler);
      document.removeEventListener("pointerdown", engage, true);
      document.removeEventListener("focusin", engage, true);
    };
  }, []);
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
        "\n\n请先用 study_workspace 的 card.get 读这道题。需要资料依据时，用 source.search 一次查所有关键词，只读命中片段附近的原文，不要逐份翻资料；题库里已有的相关题用 card.search 找。每弄清一个前置点，就用 capture（requiredBy 设为上面的题库定位）把它加为这道题的前置题；题库里已有的用 card.link 关联。\n我的问题：",
    );
  }
  function improveCard() {
    askInChat(
      "这道题的质量需要提升：\n" +
        cardBrief() +
        "\n\n请先用 study_workspace 的 card.get 读完整内容（答案、每个选项的解析），核对原文时用 source.search 查关键词、只读命中片段，按我说的问题修改，改完用 card.update 保存（reason 写清改了什么），再告诉我改动。\n问题：",
    );
  }
  // Slaying is one click next to other tools; offer an immediate undo instead
  // of sending the learner to the slay deck in 管理题组.
  async function slayCard() {
    const ref = { deckId: run.deckId, cardId: run.card.id };
    if (!(await reviewAct("card.slay", { deckId: ref.deckId }))) return;
    setNotice({
      text: "已斩这道题：移入斩题组，不再复习。",
      action: {
        label: "撤销",
        run: () =>
          act("card.restore", ref, () =>
            setNotice("已恢复到原题组，复习进度不变；本轮练习不再出现这道题。"),
          ),
      },
    });
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
    ++requestSequence.current;
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
    <>
    <PdfImport busy={busy} act={act} onImported={(ids) => setSelectedSources(ids)} />
    <form
      onSubmit={(e) => {
        e.preventDefault();
        act("source.add", { title: sourceTitle, text: sourceText }, (source) => {
          setModal(null);
          setSourceTitle("");
          setSourceText("");
          // A source added while creating a deck is almost always the one to use.
          setSelectedSources((v) => [...v, source.id]);
          setNotice(page === "generate" ? "资料已保存并勾选，可以直接生成题组" : "资料已保存，可用于生成题组");
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
    </>
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
          board: "待办看板",
          graph: "知识图谱",
        }[page];
  const coachProps = data && {
    call,
    status: data.coach,
    autopilot,
    side: coachSide,
    onAutopilot: setAutopilot,
    onThread: onCoachThread,
    onStatus: onCoachStatus,
    onRefreshRun: onCoachRefreshRun,
    onPractice: onCoachPractice,
    askInChat: onCoachAsk,
    onContinue: () => act("review.start", { mode: "path", scope: run?.returnTo ? [] : run?.scope || [], fresh: true }, enterRun),
    canShortcut,
    autoAdvance: autoAdvance && autoAdvance === advanceKey ? AUTO_ADVANCE_MS : 0,
    debrief: run ? debriefs[run.id] : null,
  };
  if (loading)
    return (
      <div className="study-app">
        <div className="loading">{connecting || "正在打开学习工作区…"}</div>
      </div>
    );
  return (
    <div
      className="study-app"
      data-theme={theme === "auto" ? undefined : theme}
      ref={attachRoot}
      tabIndex={-1}
      onPointerDown={(e) => {
        if (!e.target.closest("button,input,textarea,select,a"))
          rootRef.current?.focus();
      }}
    >
      <aside className={sidebarNarrow ? "sidebar is-narrow" : "sidebar"}>
        <div className="brand">
          <span className="brand-mark">✳</span>
          <div>
            Daily Flashcard<small>自己的资料，扎实地学</small>
          </div>
          <button
            type="button"
            className="collapse-toggle"
            aria-label={sidebarNarrow ? "展开侧边栏" : "收起侧边栏"}
            aria-expanded={!sidebarNarrow}
            title={sidebarNarrow ? "展开侧边栏" : "收起侧边栏"}
            onClick={() => setSidebarCollapsed((v) => !v)}
          >
            {sidebarNarrow ? "»" : "«"}
          </button>
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
            aria-keyshortcuts="S"
            onClick={resumeOrStart}
          >
            <Icon className="icon-sm">↩</Icon>
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
            ["library", "▦", "学习库", ""],
            ["sources", "▤", "资料", "icon-lg"],
            ["generate", "＋", "创建题组", "icon-lg"],
            ["dashboard", "◔", "统计", "icon-lg"],
            ["exam", "✎", "模拟考试", "icon-lg"],
            ["wrongbook", "✗", "错题本", "icon-sm"],
            ["board", "▥", "待办", "icon-lg"],
          ].map(([id, icon, label, iconClass]) => (
            <button
              key={id}
              className={page === id ? "nav active" : "nav"}
              title={label}
              onClick={() => {
                if (id === "exam") setExamRunId(null);
                setPage(id);
                setError("");
              }}
              disabled={!data && id !== "board"}
            >
              <Icon className={iconClass}>{icon}</Icon>
              {label}
              {id === "board" && boardCount !== undefined && (
                <span className="nav-count">{boardCount}</span>
              )}
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
          {/* Theme switch. `auto` is dark; light is explicit opt-in. The
              collapsed rail is too narrow for three segments, so it cycles. */}
          {sidebarNarrow ? (
            (() => {
              const i = Math.max(0, THEMES.findIndex(([id]) => id === theme)),
                [, glyph, label] = THEMES[i],
                [nextId, , nextLabel] = THEMES[(i + 1) % THEMES.length];
              return (
                <button
                  type="button"
                  className="nav theme-cycle"
                  title={`主题：${label}（点击切换为${nextLabel}）`}
                  aria-label={`主题：${label}，切换为${nextLabel}`}
                  onClick={() => setTheme(nextId)}
                >
                  <Icon>{glyph}</Icon>
                </button>
              );
            })()
          ) : (
            <div className="theme-switch" role="group" aria-label="主题">
              {THEMES.map(([id, glyph, label]) => (
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
          )}
          <button
            className={page === "settings" ? "nav active" : "nav"}
            title="设置"
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
            <span>{notice.text ?? notice}</span>
            {notice.action && (
              <button
                className="alert-action"
                disabled={busy}
                onClick={notice.action.run}
              >
                {notice.action.label}
              </button>
            )}
            <button aria-label="关闭提示" onClick={() => setNotice("")}>
              ×
            </button>
          </div>
        )}
        {page === "board" ? (
          <Board state={boardState} onOrigin={host.openWorkspaceNotebook} />
        ) : !data ? (
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
            {page === "library" && data.coach?.ready > 0 && (
              <div className="coach-offer" role="status">
                <div>
                  <strong>
                    {data.today?.ahead ? "今天的任务完成了。" : ""}为你定制的 {data.coach.ready} 道题已备好
                  </strong>
                  <small>从你答错、标记太简单/太难和只练了概念的地方出发，换成具体场景再练一遍。</small>
                </div>
                <button className="primary" disabled={busy} onClick={() => act("coach.practice", {}, enterRun)}>
                  开刷 →
                </button>
              </div>
            )}
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
                openAgent={host.openAgent}
                cancelJob={(jobId) => act("job.cancel", jobId ? { jobId } : { all: true })}
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
                onShowGraph={(scope, opts) => {
                  setGraphScope(scope || []);
                  setGraphCanvas(opts?.canvas !== false);
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
                initialRunId={examRunId}
                key={`${data.root}:${examRunId || "latest"}`}
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
                canvasWanted={graphCanvas}
                onCanvasHandled={() => setGraphCanvas(false)}
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
              <Manage
                call={call}
                busy={busy}
                act={act}
                openDraft={openDraft}
                setPage={setPage}
                setNotice={setNotice}
                managedDeck={managedDeck}
                setManagedDeck={setManagedDeck}
                folderDraft={folderDraft}
                setFolderDraft={setFolderDraft}
              />
            )}
            {page === "sources" && (
              <Sources
                data={data}
                busy={busy}
                act={act}
                setModal={setModal}
                sourceForm={sourceForm}
              />
            )}
            {page === "generate" && (
              <Generate
                data={data}
                busy={busy}
                running={running}
                act={act}
                setPage={setPage}
                setNotice={setNotice}
                genSource={genSource}
                setGenSource={setGenSource}
                gen={gen}
                setGen={setGen}
                selectedSources={selectedSources}
                setSelectedSources={setSelectedSources}
                setModal={setModal}
                askInChat={askInChat}
              />
            )}
            {page === "draft" && draft && (
              <Draft
                data={data}
                busy={busy}
                act={act}
                call={call}
                draft={draft}
                setDraft={setDraft}
                draftText={draftText}
                setDraftText={setDraftText}
                jsonMode={jsonMode}
                setJsonMode={setJsonMode}
                openDraft={openDraft}
                clearRecovery={clearRecovery}
                setPage={setPage}
                setNotice={setNotice}
                setError={setError}
                setModal={setModal}
                blankCard={blankCard}
                patchCard={patchCard}
                parseDraft={parseDraft}
              />
            )}
            {page === "settings" && (
              <Settings
                data={data}
                busy={busy}
                act={act}
                setNotice={setNotice}
                settings={settings}
                setSettings={setSettings}
                legacy={legacy}
                setLegacy={setLegacy}
                workspacePanel={workspacePanel}
                exportData={exportData}
              />
            )}
            {page === "review" && run && (
              <Review
                run={run}
                data={data}
                busy={busy}
                host={host}
                choice={choice}
                isCloze={isCloze}
                shellTitle={shellTitle}
                showBack={showBack}
                selected={selected}
                hint={hint}
                explain={explain}
                response={response}
                teaching={teaching}
                teachingBusy={!!teachingPending[reviewEntryKey(run)]}
                teachingAct={teachingAct}
                teachAnswer={teachAnswer}
                clozeValues={clozeValues}
                setModal={setModal}
                setPage={setPage}
                setFlag={setFlag}
                setExplain={setExplain}
                setHint={setHint}
                setResponse={setResponse}
                setTeachAnswer={setTeachAnswer}
                setClozeValues={setClozeValues}
                choose={choose}
                flipCard={flipCard}
                reviewAct={reviewAct}
                studyPrerequisites={studyPrerequisites}
                askAboutCard={askAboutCard}
                improveCard={improveCard}
                slayCard={slayCard}
                coachProps={coachProps}
                askInChat={askInChat}
                act={act}
                enterRun={enterRun}
                showEn={showEn}
                enBusyKey={enBusyKey}
                toggleEn={toggleEn}
                call={call}
              />
            )}
          </>
        )}
      </main>
      {shortcutHelp && <ShortcutHelp page={page} onClose={() => setShortcutHelp(false)} />}
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
                    {!modal.source.document && <div className="source-view-toggle">
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
                    </div>}
                    {(() => {
                      const text = modal.source.text,
                        quote = modal.quote || "",
                        at = quote ? text.indexOf(quote) : -1;
                      if (at < 0)
                        return rawSource || modal.source.document ? (
                          <pre className={modal.source.document ? "source-text pdf-extracted-text" : "source-text"}>{text}</pre>
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
                      if (rawSource || modal.source.document)
                        return (
                          <pre className={modal.source.document ? "source-text pdf-extracted-text" : "source-text"}>
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
