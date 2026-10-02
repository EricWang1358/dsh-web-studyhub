/* StudyHub for DeepSeek Harness (DSH): the workbench page.
   Contributed by ericwang1358 (https://github.com/EricWang1358). */
import { BlogNotes, Skeleton, Workflows, Graph, AudioDashboard, DocumentViewer, LiveClass } from "./workspace-views.jsx";
import { languageSystem } from "../lib/language.js";
import { localizeRunResponse, localizedRun } from "./run-titles.js";
import { submitAssist } from "./assist-request.js";
import { hasContext, pageAvailable } from './capabilities.js';
import { uiLocale } from "./i18n.js";
import React, { useState, useEffect, useLayoutEffect, useCallback, useMemo, useRef } from "react";
import StudyMap from "./StudyMap.jsx";
import Welcome, { SampleBanner } from "./Welcome.jsx";
import Tour from "./tour/Tour.jsx";
import TourGlyph from "./tour/TourGlyph.jsx";
import { NavItem, ResumeNavItem, CoachNavItem } from "./SideNav.jsx";
import { TOUR_STEPS, availableTourSteps, tourNeighbour } from "./tour/steps.js";
import { readTourProgress, writeTourProgress, welcomeDismissed, dismissWelcome } from "./tour/progress.js";
import { OnboardingPanel, RemoveSampleDialog } from "./tour/SampleControls.jsx";
import Dashboard from "./Dashboard.jsx";
import Exam from "./Exam.jsx";
import WrongBook from "./WrongBook.jsx";
import Board, { useBoard } from "./Board.jsx";
import { dueSummary } from "../lib/board-model.js";
import NavGlyph, { BrandMark } from "./NavGlyph.jsx";
import { useNavOrder, NAV_DEFAULTS } from "./nav-order.js";
import Sources from "./Sources.jsx";
import ModalFrame from "./ModalFrame.jsx";
import Manage from "./Manage.jsx";
import Settings, { backupFileName } from "./Settings.jsx";
import UpdateCenter from "./UpdateCenter.jsx";
import Generate from "./Generate.jsx";
import { GENERATION_DEFAULTS } from "./generation-status.js";
import ImportHub, { importOutcome } from './ImportHub.jsx';
import { parseCourses } from './CourseField.jsx';
import { countDocuments, documentSourceIds } from '../lib/source-groups.js';
import { usePageScope } from './PageScope.jsx';
import AudioImport from "./AudioImport.jsx";
import Draft from "./Draft.jsx";
import Review from "./Review.jsx";
import ActionFeedback, { useNotice, reviewNoticeScope } from './ActionFeedback.jsx';
import { mergeReviewPoll, reviewEntryKey } from "./async.js";
import { createActRunner } from "./act-runner.js";
import { isTransientStudyError } from "./transport.js";
import ShortcutHelp from "./ShortcutHelp.jsx";
import CourseSettings, { CourseList } from './CourseSettings.jsx';
import LanguageSwitch from './LanguageSwitch.jsx';
import Inbox from "./Inbox.jsx";
import { QuickActionsContext, dismissJobs, markInboxRead, useQuickActionsController } from "./quick-actions.js";
import quickCss from "./quick-actions.css";
import css from "./coach.css";
import libraryChipCss from "./library-chip.css";
import ReasoningEffortField from "./ReasoningEffortField.jsx";
import LibraryUsage from "./LibraryUsage.jsx";
import { useInjectCss } from "./shared.js";
import { hasUnsavedDraft, parseDraft } from "./draft-editor.js";
import { ui, uiMessage, uiFormat, useUiLanguage, setUiLanguage, getUiLanguage } from './i18n.js';
import localeCss from './language.css';

const AUTO_ADVANCE_MS = 1500;
const THEMES = [
  ["auto", "跟随系统"],
  ["dark", "深色"],
  ["light", "浅色"],
];

export default function App({ call: transportCall, host = {} }) {
  const language = useUiLanguage();
  const call = useCallback(async (action, args = {}) => {
    const epoch = libraryEpoch.current;
    let result;
    try { result = await transportCall(action, { ...args, uiLanguage: getUiLanguage() }); }
    catch (error) { error.message = uiMessage(error.message); throw error; }
    if (epoch !== libraryEpoch.current) throw new Error(ui('学习库已切换，请在当前学习库重试'));
    return localizeRunResponse(result);
  }, [transportCall]);
  useInjectCss(localeCss, 'study-language');
  useInjectCss(css, "study-coach");
  useInjectCss(libraryChipCss, "study-library-chip");
  const rootRef = useRef(null),
    requestSequence = useRef(0),
    actRunner = useRef(null),
    actDeps = useRef(null),
    libraryEpoch = useRef(0),
    navigationRequest = useRef(0);
  /* 'auto' follows the OS (inside DSH, the host's appearance); explicit
     'dark'/'light' wins. The resolved theme is always stamped on the root,
     so every view, and the editors, switch together. */
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
  const [systemLight, setSystemLight] = useState(() =>
    typeof matchMedia === "function" && matchMedia("(prefers-color-scheme: light)").matches);
  useEffect(() => {
    if (typeof matchMedia !== "function") return;
    const query = matchMedia("(prefers-color-scheme: light)"),
      sync = (event) => setSystemLight(event.matches);
    query.addEventListener?.("change", sync);
    return () => query.removeEventListener?.("change", sync);
  }, []);
  const resolvedTheme = theme === "auto" ? (systemLight ? "light" : "dark") : theme;
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
  const [narrowWindow, setNarrowWindow] = useState(false);
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
      });
      ro.observe(node);
      narrowObserver.current = ro;
    }
  };
  useEffect(() => () => narrowObserver.current?.disconnect(), []);
  const sidebarNarrow = sidebarCollapsed || narrowWindow;
  const [managedDeck, setManagedDeck] = useState(null),
    [folderDraft, setFolderDraft] = useState("");
  const [noteInitialId, setNoteInitialId] = useState("");
  const [contextTrail, setContextTrail] = useState([]), [focusRequest, setFocusRequest] = useState(null);
  const examLocation = useRef(null);
  const [examKind, setExamKind] = useState('exam');
  const [serverData, setData] = useState(null),
    [binding, setBinding] = useState({ root: "", provider: "", model: "" }),
    [rootDraft, setRootDraft] = useState(null),
    [modelDraft, setModelDraft] = useState(null),
    [page, setPage] = useState("library");
  /* Light actions (知道了, 全部已读) patch what is on screen at once and run in the background; see ui/quick-actions.js.
     `data` is the server snapshot with those pending patches applied. */
  const { controller: quick, api: quickApi, stamp: quickStamp } = useQuickActionsController(call);
  const data = useMemo(() => quick.view(serverData), [quick, serverData, quickStamp]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { quick.reconcile(serverData); }, [quick, serverData]);
  useInjectCss(quickCss, "study-quick-actions");
  /* Sidebar page switches: the current page lifts away briefly, then the new
     one settles in (its entrance lives in CSS). The highlight moves on click. */
  const [pageTarget, setPageTarget] = useState(null),
    leaveTimer = useRef(0);
  const switchPage = useCallback((id, prepare) => {
    clearTimeout(leaveTimer.current);
    navigationRequest.current++;
    setContextTrail([]);
    const reduce = typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (id === page || reduce) {
      prepare?.();
      setPageTarget(null);
      setPage(id);
      return;
    }
    setPageTarget(id);
    leaveTimer.current = setTimeout(() => {
      prepare?.();
      setPage(id);
      setPageTarget(null);
    }, 140);
  }, [page]);
  useEffect(() => () => clearTimeout(leaveTimer.current), []);
  const navPage = pageTarget || page;
  /* One highlight glides to the active nav item instead of each item
     switching its own background, so a page change reads as movement. */
  const navRef = useRef(null),
    [navMark, setNavMark] = useState(null),
    loaded = !!data,
    lastRunId = data?.lastRun?.id,
    lastRunIndex = data?.lastRun?.index;
  const navOrder = useNavOrder(NAV_DEFAULTS, navRef);
  const navLabels = {
    library: ui("学习库"), workflows: ui("学习流"), live: language === "en" ? "Live class" : "课堂实录",
    audio: language === "en" ? "Audio transcription" : "音频转录", wrongbook: ui("错题与待巩固"), exam: ui("模拟考试"),
    dashboard: ui("统计"), sources: ui("资料"), generate: ui("创建题组"), skeleton: ui("知识骨架"), notes: ui("学习笔记"), board: ui("待办"),
  };
  useLayoutEffect(() => {
    const nav = navRef.current;
    if (!nav) return;
    const measure = () => {
      const active = nav.querySelector(".nav.active");
      setNavMark((mark) => {
        const next = active ? { top: active.offsetTop, height: active.offsetHeight } : null;
        return mark?.top === next?.top && mark?.height === next?.height ? mark : next;
      });
    };
    measure();
    const observer = typeof ResizeObserver === "function" ? new ResizeObserver(measure) : null;
    observer?.observe(nav);
    return () => observer?.disconnect();
  }, [page, pageTarget, sidebarNarrow, loaded, lastRunId, lastRunIndex, navOrder.order]);
  const [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [loading, setLoading] = useState(true),
    [syncIssue, setSyncIssue] = useState("");
  // WP13: the course settings panel (a course id), opened from the library heading or Settings.
  // The open course panel: a course id, or { id, mergeFrom } when 合并到这里 opens the merge confirmation (WP14).
  const [courseSettings, setCourseSettings] = useState(null);
  const [modal, setModal] = useState(null),
    [sourceTitle, setSourceTitle] = useState(""),
    [sourceText, setSourceText] = useState("");
  const [graphScope, setGraphScope] = useState(null),
    [graphCanvas, setGraphCanvas] = useState(false),
    [clozeValues, setClozeValues] = useState({});
  const [selectedSources, setSelectedSources] = useState([]),
    [gen, setGen] = useState({
      ...GENERATION_DEFAULTS,
      language: host.defaultContentLanguage || (language === 'en' ? 'English' : '中文'),
    });
  const [sourceCourses, setSourceCourses] = usePageScope(data?.root, 'text-import-courses', data?.focus?.course || '');
  const [draft, setDraft] = useState(null),
    [draftLoaded, setDraftLoaded] = useState(""),
    [recovery, setRecovery] = useState(null),
    [draftText, setDraftText] = useState(""),
    [jsonMode, setJsonMode] = useState(false),
    [legacy, setLegacy] = useState("");
  const [run, setRun] = useState(null),
    [examRunId, setExamRunId] = useState(null),
    [skeletonFocus, setSkeletonFocus] = useState(null),
    // A learning-flow session to reopen when coming back from its practice round.
    [workflowReturn, setWorkflowReturn] = useState(null),
    // Where the learner was when a letter took them to another question.
    [detour, setDetour] = useState(null),
    [selected, setSelected] = useState([]),
    [hint, setHint] = useState(false),
    [explain, setExplain] = useState(false),
    [response, setResponse] = useState("");
  const [notice, setNotice] = useNotice(reviewNoticeScope(binding.root, page, run));
  const onReviewState = host.onReviewState;
  useEffect(() => {
    onReviewState?.(page === "review" ? run : null);
    return () => onReviewState?.(null);
  }, [onReviewState, page, run]);
  // Onboarding (plan §5 WP5): the feature tour, the welcome page and the sample course.
  const [tourStep, setTourStep] = useState(null),
    [sampleBusy, setSampleBusy] = useState(false),
    [removingSample, setRemovingSample] = useState(false),
    [hiddenWelcome, setHiddenWelcome] = useState("");
  const tourOrigin = useRef(null),
    tourRound = useRef(null);
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
  // D1: 创建题组 opens on generating from materials; JSON import is the second tab.
  const [genSource, setGenSource] = useState("files");
  // A case paper seeded from a passage of a material (WP12).
  const [caseInitial, setCaseInitial] = useState(null);
  // A generation just started: the library home scrolls its progress card into view once (P26).
  const [revealHome, setRevealHome] = useState(0);
  const canChat = host.capabilities?.chat ?? !!host.askInChat;
  // DSH's own model settings when the host offers them, else Study Settings (plan C3).
  const openModelSettings = () => (host.openModelSettings ? host.openModelSettings() : setPage("settings"));
  const [showBack, setShowBack] = useState(false),
    [settings, setSettings] = useState({}),
    [flag, setFlag] = useState(""),
    [teaching, setTeaching] = useState(null),
    [teachAnswer, setTeachAnswer] = useState("");
  const [notebooks, setNotebooks] = useState(null),
    [notebookError, setNotebookError] = useState("");
  const boardState = useBoard(call, page === "board");
  const [boardStudyRef, setBoardStudyRef] = useState(null);
  const [legacyAudioJobId, setLegacyAudioJobId] = useState('');
  const boardCount = boardState.board?.columns.reduce((n, column) => n + (column.done ? 0 : column.cardIds.length), 0);
  // Cards due today or overdue light the badge, so a deadline shows from any page.
  const boardDue = boardState.board ? dueSummary(boardState.board) : { overdue: 0, today: 0 };
  const dataRef = useRef(null),
    snapshotKey = useRef(""),
    notebookRequest = useRef(0);
  const refresh = useCallback(async () => {
    const sequence = ++requestSequence.current;
    const epoch = libraryEpoch.current;
    const since = dataRef.current?.fingerprint;
    const next = await call("snapshot", since ? { since } : {});
    if (epoch !== libraryEpoch.current) return dataRef.current;
    // Nothing visible changed: skip transferring, diffing and re-rendering.
    if (next.unchanged && dataRef.current) return dataRef.current;
    if (sequence === requestSequence.current && !next.unchanged) {
      // Root, model availability and due counts can change without a store write.
      // Compare the full public snapshot before skipping a render.
      const cur = dataRef.current;
      const nextKey = JSON.stringify(next);
      if (!cur || snapshotKey.current !== nextKey) {
        if (cur && cur.root !== next.root) {
          libraryEpoch.current++;
          quick.reset();
          navigationRequest.current++;
          actRunner.current?.reset();
          clearTimeout(leaveTimer.current);
          setPageTarget(null);
          setBusy(false);
          setNotice("");
          setError("");
          setRun(null);
          setExamRunId(null);
          setExamKind('exam');
          examLocation.current = null;
          setContextTrail([]);
          setBoardStudyRef(null);
          setLegacyAudioJobId('');
          setFocusRequest(null);
          setDetour(null);
          setWorkflowReturn(null);
          setSkeletonFocus(null);
          setNoteInitialId('');
          setSelected([]);
          setResponse('');
          setClozeValues({});
          setTeachAnswer('');
          setHint(false);
          setExplain(false);
          setDraft(null);
          setRecovery(null);
          setManagedDeck(null);
          setGraphScope(null);
          setGraphCanvas(false);
          setSelectedSources([]);
          setGen(current => ({ ...current, course: undefined }));
          setTeaching(null);
          setModal(null);
          setPage("library");
          notebookRequest.current++;
          setNotebooks(null);
          setNotebookError("");
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
  }, [call, quick, setNotice]);
  const previousLanguage = useRef(language);
  useEffect(() => {
    if (previousLanguage.current === language) return;
    previousLanguage.current = language;
    setRun(current => localizedRun(current));
    void refresh().catch(error => setError(error.message));
  }, [language, refresh]);
  useEffect(() => {
    if (!data?.root) return;
    try {
      const key = `study-draft:${data.root}`;
      const raw = sessionStorage.getItem(key);
      const saved = raw ? JSON.parse(raw) : null;
      if (!hasUnsavedDraft(saved)) sessionStorage.removeItem(key);
      setRecovery(hasUnsavedDraft(saved) ? saved : null);
    } catch {
      setRecovery(null);
    }
  }, [data?.root]);
  useEffect(() => {
    if (!data?.root || !draft) return;
    try {
      const key = `study-draft:${data.root}`;
      const saved = { draft, draftText, jsonMode, draftLoaded };
      if (hasUnsavedDraft(saved)) {
        sessionStorage.setItem(key, JSON.stringify(saved));
        setRecovery(saved);
      } else {
        sessionStorage.removeItem(key);
        setRecovery(null);
      }
    } catch {
      setNotice({ text: ui("浏览器暂存不可用，请及时保存草稿。"), persistent: true });
    }
  }, [data?.root, draft, draftText, jsonMode, draftLoaded, setNotice]);
  // Cross-workspace directory: load once per library and refresh whenever the
  // learner returns to the library view, so due counts stay honest.
  const loadNotebooks = useCallback(async () => {
    const request = ++notebookRequest.current;
    try {
      const next = await call("notebook.list");
      if (request !== notebookRequest.current) return;
      setNotebooks(next);
      setNotebookError("");
    } catch (error) {
      if (request !== notebookRequest.current) return;
      setNotebookError(error.message || String(error));
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
            setConnecting(uiFormat("正在连接学习插件…（第 {0} 次重试）", [attempt + 1]));
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
  const handoffAction = useRef(null);
  handoffAction.current = (runId) => act("review.get", { runId }, enterRun);
  const takeHandoff = host.takeHandoff;
  useEffect(
    () => takeHandoff?.((runId) => handoffAction.current?.(runId)),
    [takeHandoff],
  );
  // Links and fixes made in the conversation reach the open question without a reload.
  useEffect(() => {
    if (page !== "review" || !run?.card?.id) return;
    const t = setInterval(async () => {
      if (document.hidden) return;
      try {
        const next = await call("review.get", { runId: run.id });
        setRun((r) => mergeReviewPoll(r, next));
      } catch {}
    }, 4000);
    return () => clearInterval(t);
  }, [page, run?.id, run?.card?.id, run?.index, call]);
  // Letters about the question already on screen are read by looking at it.
  // 定制题 letters stay: the variants themselves are not on this card.
  const onScreenCardId = page === "review" && run?.card ? run.card.id : null;
  const unreadHere = !!onScreenCardId && !!data?.inbox?.items.some(
    (m) => !m.read && m.cardId === onScreenCardId && m.kind !== "variant",
  );
  useEffect(() => {
    if (!unreadHere) return;
    const ids = data.inbox.items
      .filter((m) => !m.read && m.cardId === onScreenCardId && m.kind !== "variant")
      .map((m) => m.id);
    call("inbox.read", { ids }).then(() => refresh()).catch(() => {});
  }, [unreadHere, onScreenCardId]); // eslint-disable-line react-hooks/exhaustive-deps
  const running = data?.jobs?.some(
    (j) => ["running", "queued", "cancelling"].includes(j.status),
  );
  const publishing = data?.jobs?.some((job) => job.type === "draft-publish" &&
    ["running", "queued"].includes(job.status));
  const reviewQueueVersion = run?.queueVersion || 0;
  const priorQueue = useRef(null);
  useEffect(() => {
    const previous = priorQueue.current;
    priorQueue.current = { id: run?.id, version: reviewQueueVersion };
    if (!previous || previous.id !== run?.id || previous.version === reviewQueueVersion) return;
    setSelected([]);
    setHint(false);
    setExplain(false);
    setResponse("");
    setTeaching(null);
    setTeachAnswer("");
    setClozeValues({});
  }, [run?.id, reviewQueueVersion]);
  useEffect(() => {
    if (!binding.root) return;
    let stopped = false,
      pending = false;
    const t = setInterval(async () => {
      if (document.hidden || pending || stopped) return;
      pending = true;
      try {
        await refresh();
        if (!stopped) setSyncIssue("");
      } catch (e) {
        if (!stopped) setSyncIssue(e.message || String(e));
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
    if (!modal || modal.type === 'source') return;
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
  // One write at a time (ui/act-runner.js); the library refresh that follows never keeps busy on for long.
  actDeps.current = { call, refresh, epoch: () => libraryEpoch.current, setBusy, setError };
  actRunner.current ||= createActRunner(() => actDeps.current);
  function act(action, args = {}, after, options) {
    return actRunner.current.act(action, args, after, options);
  }
  // A letter jumps to its card: the spot in an open run when there is one,
  // otherwise a one-card run that can return to the current question.
  function openInboxItem(item) {
    const from = captureContext();
    const fromReview = page === 'review' && run && !run.complete;
    act(
      "inbox.open",
      { id: item.id, ...(fromReview ? { runId: from.runId } : {}) },
      (r) => {
        if (r.kind === "pdf") {
          rememberContext(from);
          setPage("sources");
          if (r.sourceIds?.length) openAudioSources(r.sourceIds);
          return;
        }
        if (r.kind === "audio") {
          rememberContext(from);
          setPage(r.sourceIds?.length ? "sources" : "audio");
          if (r.sourceIds?.length) openAudioSources(r.sourceIds);
          return;
        }
        if (r.kind === "note" && r.noteId) {
          rememberContext(from);
          setNoteInitialId(r.noteId);
          setPage("notes");
          return;
        }
        enterRun(r);
        // Keep the way back to where the learner was, until they use it.
        if (fromReview && (r.id !== from.runId || r.index !== from.index)) setDetour(from);
        else if (!fromReview) rememberContext(from);
        // Show what arrived: the Q&A and revised explanation live in 讲解.
        if (["followup", "improve", "rewrite"].includes(item.kind) && r.revealed) setExplain(true);
      },
    );
  }
  // 先讲后练: a guided learning flow on the course route's next batch.
  const startCourseFlow = (extra = {}) => act("workflow.quickstart", { course: true, requestId: crypto.randomUUID(), ...extra }, (result) => {
    setWorkflowReturn({ sessionId: result.session.id, nonce: Date.now() });
    setPage("workflows");
  });
  async function returnFromDetour() {
    const back = detour;
    if (!back) return;
    const epoch = libraryEpoch.current;
    if (back.root !== dataRef.current?.root) { setDetour(null); return; }
    try {
      const next = await call('review.move', { runId: back.runId, index: back.index });
      if (epoch !== libraryEpoch.current) return;
      enterRun(next, back.input); setDetour(null); setFocusRequest({ element: back.invoker });
    } catch (error) { if (epoch === libraryEpoch.current) setError(error.message); }
  }
  function enterRun(r, input) {
    if (!r) return;
    runRef.current = r;
    if (r.mode === "exam") {
      setExamKind('exam');
      setExamRunId(r.id);
      setPage("exam");
      return;
    }
    setRun(r);
    setPage("review");
    const restored = input?.key === reviewEntryKey(r) && !r.feedback ? input : null;
    setSelected(restored?.selected || r.feedback?.selected || []);
    setHint(restored?.hint || false);
    setExplain(restored?.explain || false);
    setResponse(restored?.response || '');
    setClozeValues(restored?.clozeValues || {});
    setTeaching(r.teaching || null);
    setTeachAnswer(restored?.teachAnswer || '');
  }
  function captureContext(overrides = {}) {
    return { root: dataRef.current?.root, page, runId: page === 'review' ? run?.id : undefined,
      index: run?.index, noteId: noteInitialId, skeletonId: skeletonFocus, deckId: managedDeck?.id,
      exam: examLocation.current, workflow: workflowReturn?.sessionId,
      modal: modal?.type === 'source' ? { sourceId: modal.source?.id, quote: modal.quote } : null,
      input: page === 'review' ? { key: reviewEntryKey(run), selected, response, clozeValues, hint, explain, teachAnswer } : null,
      invoker: rootRef.current?.contains(document.activeElement) ? document.activeElement : null, ...overrides };
  }
  function rememberContext(origin = captureContext()) {
    setContextTrail(previous => [...previous, origin]);
    setFocusRequest({});
  }
  function contextLabel(origin) {
    if (origin?.modal) return ui('返回资料');
    if (origin?.page === 'review') return uiFormat('回到之前的第 {0} 题', [(origin.index || 0) + 1]);
    if (origin?.page === 'exam') return origin.exam?.kind === 'oral' ? ui('返回口头模拟') : ui('返回笔试');
    return uiFormat('返回{0}', [navLabels[origin?.page] || ui('原位置')]);
  }
  // Local links keep a small trail; ordinary sidebar navigation starts afresh.
  async function openLearningTarget(target, { remember = true, throwOnError = false } = {}) {
    const origin = captureContext(), epoch = libraryEpoch.current, request = ++navigationRequest.current;
    const live = () => epoch === libraryEpoch.current && request === navigationRequest.current;
    setError('');
    try {
      let result;
      if (target.kind === 'card') {
        await call('card.get', { deckId: target.deckId, cardId: target.cardId });
        if (!live()) return;
        result = await call('review.start', { mode: 'path', scope: [{ deckId: target.deckId, cardId: target.cardId }], fresh: true });
      } else if (target.kind === 'source') result = await call('source.get', { id: target.id });
      else if (target.kind === 'note') result = await call('note.get', { id: target.id });
      else if (target.kind === 'skeleton') result = await call('skeleton.get', { id: target.id });
      else if (target.kind === 'deck') result = await call('deck.get', { id: target.id });
      else if (target.kind === 'exam') result = await call('review.get', { runId: target.runId });
      else if (target.kind === 'oral') result = await call('oral.get', { runId: target.runId });
      else if (target.kind === 'workflow') result = await call('workflow.session.get', { id: target.sessionId });
      else if (target.kind === 'course') {
        if (!dataRef.current?.focus?.courses?.some(item => item.name === target.course)) throw new Error(ui('关联课程已不存在'));
        result = await call('focus.set', { course: target.course });
        await refresh();
      }
      else return;
      if (!live()) return;
      if (remember && target.kind !== 'source') rememberContext(origin);
      setModal(null);
      if (target.kind === 'card') enterRun(result);
      else if (target.kind === 'source') setModal({ type: 'source', source: dataRef.current.sources.find(source => source.id === target.id) || result, quote: target.quote });
      else if (target.kind === 'note') { setNoteInitialId(result.id); setPage('notes'); }
      else if (target.kind === 'skeleton') { setSkeletonFocus(result.id); setPage('skeleton'); }
      else if (target.kind === 'deck') { setManagedDeck(result); setFolderDraft(result.folder || ''); setPage('manage'); }
      else if (target.kind === 'workflow') { setWorkflowReturn({ sessionId: target.sessionId, nonce: Date.now() }); setPage('workflows'); }
      else if (target.kind === 'course') setPage('library');
      else { setExamKind(target.kind); setExamRunId(target.runId); setPage('exam'); }
      if (target.kind !== 'source') setFocusRequest({});
    } catch (error) { if (live()) { if (throwOnError) throw error; setError(error.message || String(error)); } }
  }
  function currentStudyReference() {
    const root = dataRef.current?.root;
    if (!root) return null;
    if (modal?.type === 'source' && modal.source?.id) return { root, kind: 'source', id: modal.source.id };
    if (page === 'review' && run?.card?.id) return { root, kind: 'card', deckId: run.deckId || run.card.deckId, cardId: run.card.id };
    if (page === 'notes' && noteInitialId) return { root, kind: 'note', id: noteInitialId };
    if (page === 'skeleton' && skeletonFocus) return { root, kind: 'skeleton', id: skeletonFocus };
    if (page === 'manage' && managedDeck?.id) return { root, kind: 'deck', id: managedDeck.id };
    if (page === 'workflows' && workflowReturn?.sessionId) return { root, kind: 'workflow', sessionId: workflowReturn.sessionId };
    if (page === 'exam' && examLocation.current?.runId) return { root, kind: examLocation.current.kind === 'oral' ? 'oral' : 'exam', runId: examLocation.current.runId };
    if (dataRef.current?.focus?.course != null) return { root, kind: 'course', course: dataRef.current.focus.course };
    return null;
  }
  function openBoardWithContext() {
    const ref = currentStudyReference();
    if (ref) { rememberContext(); setBoardStudyRef(ref); }
    setPage('board');
  }
  async function openBoardReference(ref) {
    const sameRoot = (value) => String(value || '').replaceAll('\\', '/').toLowerCase();
    if (sameRoot(ref.root) !== sameRoot(dataRef.current?.root))
      throw new Error(ui('这条待办来自另一个学习库。请先在设置中切换到其学习库，再打开关联内容。'));
    await openLearningTarget(ref, { throwOnError: true });
  }
  async function returnFromContext() {
    const origin = contextTrail.at(-1), epoch = libraryEpoch.current, request = ++navigationRequest.current;
    const live = () => epoch === libraryEpoch.current && request === navigationRequest.current;
    if (!origin || origin.root !== dataRef.current?.root) { setContextTrail([]); return; }
    try {
      if (origin.page === 'review') {
        const next = await call('review.move', { runId: origin.runId, index: origin.index });
        if (!live()) return;
        enterRun(next, origin.input);
      } else if (origin.page === 'notes') {
        if (origin.noteId) await call('note.get', { id: origin.noteId });
        if (!live()) return;
        setNoteInitialId(origin.noteId); setPage('notes');
      } else if (origin.page === 'exam') {
        setExamKind(origin.exam?.kind || 'exam'); setExamRunId(origin.exam?.runId || null); setPage('exam');
      } else if (origin.page === 'skeleton') {
        if (origin.skeletonId) await call('skeleton.get', { id: origin.skeletonId });
        if (!live()) return;
        setSkeletonFocus(origin.skeletonId); setPage('skeleton');
      } else if (origin.page === 'manage' && origin.deckId) {
        const deck = await call('deck.get', { id: origin.deckId });
        if (!live()) return;
        setManagedDeck(deck); setPage('manage');
      } else setPage(origin.page);
      if (origin.modal) {
        const source = await call('source.get', { id: origin.modal.sourceId });
        if (!live()) return;
        setModal({ type: 'source', source: dataRef.current.sources.find(item => item.id === source.id) || source, quote: origin.modal.quote });
      } else setModal(null);
      setContextTrail(previous => previous.slice(0, -1));
      setFocusRequest({ element: origin.invoker });
    } catch (error) { if (live()) setError(error.message || String(error)); }
  }
  useEffect(() => {
    if (!focusRequest) return;
    const timer = requestAnimationFrame(() => {
      const target = focusRequest.element?.isConnected && focusRequest.element.getClientRects().length ? focusRequest.element
        : [...(rootRef.current?.querySelectorAll('dialog[open] h2, .question[role="heading"], [data-context-heading], main .page h1, main .page h2') || [])]
          .find(element => element.getClientRects().length);
      if (target) {
        if (!target.matches('button,a,input,select,textarea,[tabindex]')) target.setAttribute('tabindex', '-1');
        target.focus();
      }
    });
    return () => cancelAnimationFrame(timer);
  }, [focusRequest, page]);
  const toggleNotebook = (publish) =>
    act(
      publish ? "notebook.publish" : "notebook.unpublish",
      {},
      (result) => {
        notebookRequest.current++;
        setNotebooks(result);
        setNotebookError("");
      },
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
    act(action, { runId: run.id, cardId: run.card?.id, queueVersion: run.queueVersion || 0, ...args }, (result) => enterRun(result),
      // Practice steps return the run they changed; the snapshot catches up on the next poll.
      // Only a finished round reloads the library (its result page needs fresh counts).
      { refreshAfter: (result) => action === "review.move" ? !!result.complete : action !== "review.answer" && action !== "review.reveal" });
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
  // Coach plumbing: stable callbacks so memoized children do not re-render per poll.
  const onCoachStatus = useCallback(() => refresh().catch(() => {}), [refresh]);
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
  const choice =
    run?.mode !== "flashcard" && ["quiz", "multi"].includes(run?.card?.kind);
  const isCloze = run?.mode !== "flashcard" && run?.card?.kind === "cloze";
  // An open question with rubric criteria is answered in writing and graded, never flipped (WP12).
  const rubricCard = run?.card?.kind === "open" && !!run.card.rubricCriteria?.length;
  // Each card mounts on the side matching its state; flipping after that is local.
  useEffect(() => {
    setShowBack(!!run?.revealed);
  }, [run?.id, run?.card?.id, run?.index, run?.queueVersion, run?.revealed]);
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
        else if (!choice && !isCloze && !rubricCard) flipCard();
      } else if (letter === "h") {
        e.preventDefault();
        if (run.revealed) setExplain((v) => !v);
        else setHint((v) => !v);
      } else if (letter === "t" && run.mode !== "exam") {
        // 通俗详解 in one key: the background assistant explains with an analogy.
        e.preventDefault();
        assistCard("ask", "", ["plain"]);
      } else if (e.key === "ArrowRight" && run.feedback) {
        e.preventDefault();
        reviewAct("review.move", { direction: 1 });
      } else if (e.key === "ArrowLeft" && run.index) {
        e.preventDefault();
        reviewAct("review.move", { direction: -1 });
      } else if (e.code === "Space" && !choice && !isCloze && !rubricCard) {
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
      ? ui("\n选项：\n") +
        run.card.options.map((o, i) => String.fromCharCode(65 + i) + ". " + o.text).join("\n")
      : "";
    return (
      ui("题组「") + (deck?.title || "") + ui("」· 主题「") + run.card.topic + "」\n" +
      ui("题目：") + run.card.prompt + options + "\n" +
      ui("题库定位：") + JSON.stringify({ deckId: run.deckId, cardId: run.card.id })
    );
  }
  /* 学习帮助交给后台，完成后由信箱交付；宿主暂不支持时直接提示。 */
  async function assistCard(mode, text, helpChoices = []) {
    if (!run?.card || (!text.trim() && !(mode === "ask" && helpChoices.length))) return false;
    try {
      await submitAssist(call, { deckId: run.deckId, cardId: run.card.id, runId: run.id,
        mode, text: text.trim(), helpChoices, uiLanguage: getUiLanguage() });
      setNotice(
        mode === "ask"
          ? ui("后台助教正在解答，完成后会出现在这道题的问答里，并进信箱。")
          : mode === "grade"
            ? { text: ui("已提交批改：后台按评分标准逐项打分，结果会显示在这道题下，也会进信箱。"), tone: "success" }
            : ui("后台助教正在改这道题，改完会进信箱，可一步撤销。"),
      );
      refresh().catch(() => {});
      return true;
    } catch (e) {
      setError(e.message || ui("后台帮助暂不可用，请稍后再试。"));
      return false;
    }
  }
  function askAboutCard(extra = "") {
    askInChat(
      ui("我在做这道题时卡住了，想先把前置知识问清楚（先别直接告诉我答案）：\n") +
        cardBrief() +
        ui("\n\n请先用 study_workspace 的 card.get 读这道题。需要资料依据时，用 source.search 一次查所有关键词，只读命中片段附近的原文，不要逐份翻资料；题库里已有的相关题用 card.search 找。每弄清一个前置点，就用 capture（requiredBy 设为上面的题库定位）把它加为这道题的前置题；题库里已有的用 card.link 关联。\n我的问题：") + extra,
    );
  }
  function improveCard(extra = "") {
    askInChat(
      ui("这道题的质量需要提升：\n") +
        cardBrief() +
        ui("\n\n请先用 study_workspace 的 card.get 读完整内容（答案、每个选项的解析），核对原文时用 source.search 查关键词、只读命中片段，按我说的问题修改，改完用 card.update 保存（reason 写清改了什么），再告诉我改动。\n问题：") + extra,
    );
  }
  // Slaying is one click next to other tools; offer an immediate undo instead
  // of sending the learner to the slay deck in 管理题组.
  async function slayCard() {
    const ref = { deckId: run.deckId, cardId: run.card.id };
    const next = await reviewAct("card.slay", { deckId: ref.deckId });
    if (!next) return;
    const scope = reviewNoticeScope(binding.root, 'review', next);
    setNotice({
      text: ui("已斩这道题：移入斩题组，不再复习。"),
      scope,
      action: {
        label: ui("撤销"),
        run: () =>
          act("card.restore", ref, () =>
            setNotice({ text: ui("已恢复到原题组，复习进度不变；本轮练习不再出现这道题。"), scope }),
          ),
      },
    });
  }
  async function askInChat(text) {
    text += languageSystem("", getUiLanguage());
    if (host.askInChat?.(text)) {
      setNotice(ui("已填入对话输入框，确认后发送。"));
      return;
    }
    try {
      await navigator.clipboard.writeText(text);
      setNotice(ui("已复制提示词，粘贴到对话中即可。"));
    } catch {
      setNotice({ text, persistent: true });
    }
  }
  function openDraft(d) {
    setDraft(structuredClone(d));
    setDraftLoaded(JSON.stringify(d));
    setDraftText(JSON.stringify(d, null, 2));
    setJsonMode(false);
    setPage("draft");
  }
  /* The one 补题 action, for the home card and the draft page alike: it generates only the missing questions into the same draft. */
  function continueDraft(draft) {
    return act("generate", { resumeDraftId: draft.id, draftVersion: draft.draftVersion }, (job) =>
      setNotice(uiFormat("已开始补齐「{0}」剩余 {1} 题；通过检查后会保存到同一份草稿。", [draft.title, job.missing])));
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
      reasoningEffort: binding.reasoningEffort || "",
      ...patch,
    };
  }
  async function updateBinding(patch) {
    ++requestSequence.current;
    if (Object.prototype.hasOwnProperty.call(patch, 'root')) {
      libraryEpoch.current++;
      navigationRequest.current++;
      clearTimeout(leaveTimer.current);
      setPageTarget(null);
    }
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
      setNotice(moved ? ui("已切换学习库") : Object.hasOwn(patch, "reasoningEffort") ? ui("已更新推理程度") : ui("已更新生成模型"));
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
      setNotice(ui("无法打开目录选择器，请直接输入路径。"));
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
      a.download = backupFileName();
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      // Originals attached by path stay where the learner keeps them; say how many are not in this file.
      const referenced = s.portableMaterials?.referencedOriginals?.length;
      if (referenced) setNotice({ text: uiFormat("备份已导出。其中 {0} 份原文件只记了路径，没有放进备份；换电脑后需要重新指定。", [referenced]), tone: "success", persistent: true });
    } catch (e) {
      setError(e.message);
    }
  }
  function openAudioSources(sourceIds) {
    const available = sourceIds.map(id => data.sources.find(source => source.id === id)).filter(Boolean);
    if (!available.length) { setNotice(ui('逐字稿资料已被删除。')); return; }
    setModal(available.length === 1 ? { type: 'source', source: available[0] } : { type: 'sources', sourceIds });
  }
  const sourceFormCourse = modal?.type === 'add' && modal.course !== undefined ? modal.course : sourceCourses;
  const changeSourceFormCourse = course => modal?.type === 'add' && modal.course !== undefined
    ? setModal(current => ({ ...current, course })) : setSourceCourses(course);
  // WP3: one add-material entry (ImportHub) for the dialog and the empty Sources page.
  const [sourceHighlight, setSourceHighlight] = useState(null);
  useEffect(() => { if (page !== 'sources') setSourceHighlight(null); }, [page]);
  const generateFromSources = ids => { rememberContext(); setSelectedSources(ids); setGen(current => ({ ...current, course: undefined })); setGenSource('files'); setPage('generate'); };
  function finishImport(summary) {
    const outcome = importOutcome(summary, { page });
    setModal(null);
    if (!outcome) return;
    if (outcome.select?.length) setSelectedSources(current => [...new Set([...current, ...outcome.select])]);
    if (outcome.openDraft) openDraft(outcome.openDraft);
    else if (outcome.page && outcome.page !== page) setPage(outcome.page);
    if (outcome.highlight) setSourceHighlight({ ids: outcome.highlight, at: Date.now() });
    const ids = outcome.highlight;
    setNotice({ text: outcome.notice.text, tone: outcome.notice.tone,
      ...(outcome.notice.action === 'generate' ? { action: { label: ui('用它出题'), run: () => generateFromSources(ids) } } : {}) });
  }
  const sourceForm = !hasContext(data, 'materials') ? (
    <p role="status">{language === 'en' ? 'Enable materials in the DSH plugin manager to import sources.' : '请在 DSH 插件管理器中启用资料组件，再导入资料。'}</p>
  ) : (
    <ImportHub key={data?.root} data={data} call={call} busy={busy} course={sourceFormCourse} onCourseChange={changeSourceFormCourse}
      pasteDraft={{ title: sourceTitle, text: sourceText }} onPasteDraftChange={draft => { setSourceTitle(draft.title); setSourceText(draft.text); }}
      onImported={() => refresh().catch(() => {})} onComplete={finishImport} onOpenSettings={() => { setModal(null); setPage('settings'); }}
      audio={hasContext(data, 'audio') ? <AudioImport data={data} defaultCourses={parseCourses(sourceFormCourse)} busy={busy} act={act} call={call} setNotice={setNotice} askInChat={askInChat} canAsk={!!host.askInChat} openAgent={host.openAgent} onOpenSources={openAudioSources} onOpenSettings={() => { setModal(null); setPage('settings'); }} /> : undefined} />
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
          <span className="binding-label">{ui("学习库")}</span>
          <code className="binding-value" title={binding.root}>
            {binding.root || "—"}
          </code>
          <small>
            {binding.rootSource === "workspace"
              ? ui("当前工作区")
              : binding.rootSource === "config"
                ? ui("插件配置指定")
                : ui("自定义目录")}
            {" · "}{ui("资料、题库与复习记录保存在这里")}</small>
          <LibraryUsage root={binding.root} call={call} active={!!data} />
        </div>
        <div className="binding-actions">
          <button type="button" onClick={chooseRoot} disabled={busy}>{ui("更换目录…")}</button>
          {binding.rootSource === "custom" && (
            <button
              type="button"
              disabled={busy}
              onClick={() => updateBinding({ root: "" })}
            >{ui("改回当前工作区")}</button>
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
            aria-label={ui("学习库绝对路径")}
            value={rootDraft}
            onChange={(e) => setRootDraft(e.target.value)}
          />
          <button className="primary" disabled={busy}>{ui("使用此目录")}</button>
          <button type="button" onClick={() => setRootDraft(null)}>{ui("取消")}</button>
        </form>
      )}
      <div className="binding-row">
        <label className="binding-main">
          <span className="binding-label">{ui("生成模型")}</span>
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
            <option value="">{ui("跟随当前会话")}{followedModel ? `（${modelName(followedModel)}）` : ""}
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
            <option value="manual">{ui("手动填写…")}</option>
          </select>
          <small>
            {binding.modelSource === "session"
              ? ui("与对话输入框选择的模型一致，切换后自动生效。")
              : ui("只用于出题与讲解，不改变对话模型。")}{language === "en" ? " " : ""}{ui("生成时所选资料会发送给该模型；复习不调用模型。")}</small>
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
            aria-label={ui("模型 ID")}
            placeholder={ui("模型 ID")}
            value={modelDraft.model}
            onChange={(e) =>
              setModelDraft({ ...modelDraft, model: e.target.value })
            }
          />
          <button className="primary" disabled={busy}>{ui("使用")}</button>
          <button type="button" onClick={() => setModelDraft(null)}>{ui("取消")}</button>
        </form>
      )}
      <ReasoningEffortField binding={binding} busy={busy} refreshKey={JSON.stringify(followedModel || null)}
        onChange={(reasoningEffort) => updateBinding({ reasoningEffort })}
        onRefresh={() => call("binding.get").then(setBinding, () => {})} />
    </div>
  );
  /* ── Onboarding (plan §5 WP5) ───────────────────────────────────────────
     The welcome page of an empty library, the sample course (sample.* host
     actions, C6) and the feature tour that switches to each key page. Hosts
     without sample support send no `sample` in the snapshot; then the tour
     still runs and the steps that need sample data are left out. */
  const modelState = data ? data.model || { ready: !!data.modelReady } : null;
  const tourSteps = useMemo(() => data ? availableTourSteps(TOUR_STEPS, { sample: data.sample,
    pageAvailable: (id) => pageAvailable(data, id), hasContext: (id) => hasContext(data, id) }) : [], [data]);
  const savedTour = data?.root && !tourStep ? readTourProgress(data.root) : null;
  const resumeAt = savedTour && !savedTour.done ? tourSteps.findIndex((step) => step.id === savedTour.stepId) : -1;
  const tourResume = resumeAt > 0 ? { index: resumeAt, total: tourSteps.length } : null;
  const ownLibraryEmpty = !!data && !data.sources.some((source) => !source.sample) && !data.drafts.some((item) => !item.sample) &&
    !data.decks.some((deck) => !deck.systemKind && !deck.sample);
  const showWelcome = !!data?.sample && page === "library" && !tourStep && hiddenWelcome !== data.root &&
    !welcomeDismissed(data.root) && (ownLibraryEmpty || !!data.sample.loaded);
  function hideWelcome() {
    if (!data?.root) return;
    dismissWelcome(data.root);
    setHiddenWelcome(data.root);
  }
  const openFirstImport = () => setModal({ type: "add" });
  /** The tour switches pages at once: no leave animation, no stale context trail. */
  function showPage(id) {
    clearTimeout(leaveTimer.current);
    navigationRequest.current++;
    setPageTarget(null);
    setContextTrail([]);
    if (id === "exam") { setExamRunId(null); setExamKind("exam"); }
    setPage(id);
    // Each step starts at the top of its page; the tour then scrolls to the step's anchor.
    rootRef.current?.scrollTo?.({ top: 0 });
  }
  function startTour({ restart = false } = {}) {
    if (!data || !tourSteps.length) return;
    const saved = readTourProgress(data.root);
    const first = !restart && saved && !saved.done && tourSteps.some((step) => step.id === saved.stepId) ? saved.stepId : tourSteps[0].id;
    if (!tourStep) tourOrigin.current = { page, runId: page === "review" ? run?.id : null,
      opener: rootRef.current?.contains(document.activeElement) ? document.activeElement : null };
    hideWelcome();
    setError("");
    setTourStep(first);
    writeTourProgress(data.root, { stepId: first });
  }
  function moveTour(direction) {
    const next = tourNeighbour(tourSteps, tourStep, direction);
    if (!next) {
      if (direction > 0) finishTour();
      return;
    }
    setTourStep(next);
    if (data?.root) writeTourProgress(data.root, { stepId: next });
  }
  /** Leave the tour: close what it opened, go back to where it started, return focus. */
  function endTour({ then } = {}) {
    const origin = tourOrigin.current;
    tourOrigin.current = null;
    setTourStep(null);
    // A practice round the tour opened and nobody answered should not become "pick up where you left off".
    const round = tourRound.current;
    tourRound.current = null;
    if (round) void call("review.get", { runId: round }).then((value) => !value.complete && !value.answered && !value.feedback
      ? call("review.end", { runId: round }).then(() => refresh()) : null).catch(() => {});
    setModal((current) => (current?.tour ? null : current));
    if (origin?.page === "review" && origin.runId) void act("review.get", { runId: origin.runId }, enterRun);
    else showPage(origin?.page && origin.page !== "draft" && origin.page !== "review" ? origin.page : "library");
    then?.();
    requestAnimationFrame(() => {
      const target = origin?.opener?.isConnected ? origin.opener : rootRef.current?.querySelector('[data-tour="tour-reopen"]');
      target?.focus?.({ preventScroll: true });
    });
  }
  function closeTour(reason) {
    if (data?.root) writeTourProgress(data.root, { stepId: tourStep, done: reason === "skip" });
    endTour();
    if (reason !== "skip") setNotice({ text: ui("导览已暂停，可以从侧栏「功能导览」接着看。"), tone: "info" });
  }
  function finishTour() {
    if (data?.root) writeTourProgress(data.root, { stepId: tourStep, done: true });
    endTour();
    setNotice({ text: ui("导览完成。想再看一遍，点侧栏的「功能导览」。"), tone: "success" });
  }
  /** The tour's practice round on the sample deck: the open one if there is one, otherwise a fresh round. */
  async function openSamplePractice(sample) {
    if (!sample?.deckId) return;
    const current = runRef.current;
    if (latest.current.page === "review" && current && !current.complete && current.deckId === sample.deckId) return;
    const scope = sample.practice?.length ? sample.practice : [{ deckId: sample.deckId }];
    const sameScope = (item) => JSON.stringify(item.scope || []) === JSON.stringify(scope);
    const open = (dataRef.current?.runs || []).find((item) => item.deckIds?.length === 1 && item.deckIds[0] === sample.deckId &&
      item.index < item.total && !item.purpose && sameScope(item));
    try {
      let next = open ? await call("review.get", { runId: open.id }) : null;
      if (!next || next.complete) {
        next = await call("review.start", { mode: "path", scope, fresh: true });
        tourRound.current = next.id;
      }
      enterRun(next);
    } catch (failure) {
      showPage("library");
      setError(failure.message || String(failure));
    }
  }
  /** Each step's page, prepared with sample content where the step shows it. */
  async function enterTourStep(step) {
    const sample = dataRef.current?.sample;
    if (step.prepare !== "openSampleDocument") setModal((current) => (current?.tour ? null : current));
    if (step.prepare === "openSampleDocument") {
      const source = dataRef.current?.sources.find((item) => item.id === sample?.sourceId);
      showPage(step.page);
      if (source) setModal({ type: "source", source, tour: true });
      return;
    }
    if (step.prepare === "prepareGenerate") {
      setGenSource("files");
      if (sample?.sourceId) setSelectedSources([sample.sourceId]);
    }
    if (step.prepare === "openSampleDraft") {
      const sampleDraft = dataRef.current?.drafts.find((item) => item.id === sample?.draftId);
      if (sampleDraft) {
        openDraft(sampleDraft);
        return;
      }
    }
    if (step.prepare === "openSampleSkeleton" && sample?.skeletonId) setSkeletonFocus(sample.skeletonId);
    if (step.prepare === "startSamplePractice") {
      await openSamplePractice(sample);
      return;
    }
    if (step.page) showPage(step.page);
  }
  async function loadSample() {
    setSampleBusy(true);
    setError("");
    try {
      const status = await call("sample.load", { language: getUiLanguage() });
      await refresh();
      return status;
    } catch (failure) {
      setError(uiFormat("示例数据没能载入：{0}", [failure.message || String(failure)]));
      return null;
    } finally {
      setSampleBusy(false);
    }
  }
  async function loadSampleAndTour() {
    if (await loadSample()) startTour({ restart: true });
  }
  async function loadSampleInTour() {
    if (await loadSample()) moveTour(1);
  }
  async function loadSampleOnly() {
    if (await loadSample()) setNotice({ text: ui("示例课程已载入，在学习库里就能看到。"), tone: "success" });
  }
  async function removeSampleData() {
    setSampleBusy(true);
    setError("");
    try {
      const deckId = dataRef.current?.sample?.deckId;
      const sampleSources = new Set((dataRef.current?.sources || []).filter((source) => source.sample).map((source) => source.id));
      await call("sample.remove", {});
      if (deckId && runRef.current?.deckId === deckId) setRun(null);
      setDraft((current) => (current?.sample ? null : current));
      setModal((current) => (current?.source && sampleSources.has(current.source.id) ? null : current));
      setSelectedSources((ids) => ids.filter((id) => !sampleSources.has(id)));
      if (["review", "draft"].includes(latest.current.page)) showPage("library");
      if (data?.root) writeTourProgress(data.root, null);
      await refresh();
      setRemovingSample(false);
      setNotice({ text: ui("示例数据已移除，你自己的资料和记录都还在。"), tone: "success" });
    } catch (failure) {
      setError(uiFormat("示例数据没能移除：{0}", [failure.message || String(failure)]));
    } finally {
      setSampleBusy(false);
    }
  }
  const shellTitle =
    page === "review"
      ? run?.title ||
        data?.decks.find((d) => d.id === run?.deckId)?.title ||
        ui("复习")
      : {
          library: ui("学习库"),
          sources: ui("资料"),
          generate: ui("创建题组"),
          draft: ui("草稿与发布"),
          settings: ui("工作区设置"),
          manage: ui("维护题组"),
          dashboard: ui("学习统计"),
          exam: ui("模拟考试"),
          wrongbook: ui("错题与待巩固"),
          board: ui("待办看板"),
          graph: ui("知识图谱"),
          skeleton: ui("知识骨架"),
          workflows: ui("学习流"),
          live: language === "en" ? "Live class" : "课堂实录",
          audio: language === "en" ? "Audio transcription" : "音频转录",
          notes: ui("学习笔记"),
        }[page];
  const coachProps = data && {
    call,
    autopilot,
    onStatus: onCoachStatus,
    onPractice: onCoachPractice,
    onContinue: () => act("review.start", { mode: "path", scope: run?.returnTo ? [] : run?.scope || [], fresh: true }, enterRun),
    onReviewWeak: () => act("review.weak.start", { runId: run.id }, enterRun),
    canShortcut,
    autoAdvance: autoAdvance && autoAdvance === advanceKey ? AUTO_ADVANCE_MS : 0,
    debrief: null,
  };
  if (loading)
    return (
      <div className="study-app">
        <div className="loading">{connecting || ui("正在打开学习工作区…")}</div>
      </div>
    );
  const lastRun = data?.lastRun && page === "review" && run?.id === data.lastRun.id
    ? { ...data.lastRun, index: run.index, total: run.total }
    : data?.lastRun;
  const feedback = <ActionFeedback error={error} notice={notice} busy={busy}
    onCloseError={() => setError("")} onCloseNotice={() => setNotice("")} />;
  return (
    <QuickActionsContext.Provider value={quickApi}>
    <div
      className="study-app"
      data-theme={resolvedTheme}
      lang={language === 'en' ? 'en' : 'zh-CN'}
      ref={attachRoot}
      tabIndex={-1}
      onPointerDown={(e) => {
        if (!e.target.closest("button,input,textarea,select,a"))
          rootRef.current?.focus();
      }}
    >
      <aside className={sidebarNarrow ? "sidebar is-narrow" : "sidebar"}>
        <div className="brand">
          <span className="brand-mark" aria-hidden="true"><BrandMark /></span>
          <div>
            {ui("StudyHub")}<small>{ui("自己的资料，扎实地学")}</small>
          </div>
          <button
            type="button"
            className="collapse-toggle"
            aria-label={sidebarNarrow ? ui("展开侧边栏") : ui("收起侧边栏")}
            aria-expanded={!sidebarNarrow}
            title={sidebarNarrow ? ui("展开侧边栏") : ui("收起侧边栏")}
            onClick={() => setSidebarCollapsed((v) => !v)}
          >
            {sidebarNarrow ? "»" : "«"}
          </button>
        </div>
        <nav ref={navRef} className={"side-nav" + (navOrder.lifted ? " is-reordering" : "")} data-tour="nav">
          {navMark && (
            <span
              className="nav-mark"
              aria-hidden="true"
              style={{ transform: `translateY(${navMark.top}px)`, height: navMark.height }}
            />
          )}
          <ResumeNavItem
            lastRun={lastRun}
            hasDecks={!!data?.decks.length}
            ready={!!data}
            active={navPage === "review"}
            disabled={!data || busy || !pageAvailable(data, 'review')}
            onClick={resumeOrStart}
          />
          {data?.coach?.ready > 0 && pageAvailable(data, 'review') && (
            <CoachNavItem ready={data.coach.ready} disabled={busy} onClick={onCoachPractice} />
          )}
          {[...navOrder.order.main, ...navOrder.order.upkeep].filter(id => pageAvailable(data, id)).map((id) => {
            const label = navLabels[id], upkeep = NAV_DEFAULTS.upkeep.includes(id);
            const due = id === "board" && boardDue.overdue + boardDue.today > 0;
            return (
              <NavItem
                key={id}
                {...navOrder.bind(id)}
                data-tour={`nav-${id}`}
                className={navOrder.lifted === id ? "is-dragging" : ""}
                upkeep={upkeep}
                active={navPage === id}
                glyph={id}
                label={ui(label)}
                title={`${ui(label)}\n${ui("长按并拖动可调整顺序（键盘：Alt+↑/↓）")}`}
                onClick={() => switchPage(id, () => {
                  if (id === 'board') setBoardStudyRef(currentStudyReference());
                  if (id === "exam") { setExamRunId(null); setExamKind('exam'); }
                  if (id === "notes") setNoteInitialId("");
                  if (id === 'graph') setGraphScope(null);
                  setError("");
                })}
                disabled={!data && id !== "board"}
                hint={id === "board" ? boardCount : id === "sources" && data ? countDocuments(data.sources) : undefined}
                hintClass={due ? "nav-count is-due" : "nav-count"}
                hintTitle={due ? uiFormat("{0} 项已逾期 · {1} 项今天截止", [boardDue.overdue, boardDue.today]) : undefined}
              />
            );
          })}
          {navOrder.customized && !sidebarNarrow && (
            <button type="button" className="nav-reset" onClick={navOrder.reset}>{ui("恢复默认顺序")}</button>
          )}
          <span className="sr-only" role="status" aria-live="polite">
            {navOrder.announce && uiFormat("{0} 已移到第 {1} 位，共 {2} 项", [ui(navLabels[navOrder.announce.id]), navOrder.announce.position, navOrder.announce.count])}
          </span>
        </nav>
        <div className="sidebar-bottom">
          <LanguageSwitch language={language} narrow={sidebarNarrow} onChange={setUiLanguage} />
          {data && (
            <NavItem className="tour-nav" data-tour="tour-reopen" icon={<TourGlyph />} label={ui("功能导览")} disabled={sampleBusy} aria-disabled={!!tourStep || undefined}
              hint={tourResume ? `${tourResume.index + 1}/${tourResume.total}` : undefined}
              title={ui("功能导览：切到每个关键功能，看看怎么用") + (tourResume ? "\n" + uiFormat("继续 {0}/{1}", [tourResume.index + 1, tourResume.total]) : "")}
              onClick={() => { if (!tourStep) startTour(); }} />
          )}
          <div className="local-status">
            <span />{ui("本地学习工作区")}</div>
          {/* Theme: one cycling toggle. `auto` is dark; light is explicit opt-in. */}
          {(() => {
            const i = Math.max(0, THEMES.findIndex(([id]) => id === theme)),
              [current, label] = THEMES[i],
              [nextId, nextLabel] = THEMES[(i + 1) % THEMES.length];
            return (
              <NavItem
                className="theme-cycle"
                glyph={current}
                label={`${ui("外观 · ")}${ui(label)}`}
                title={uiFormat("主题：{0}（点击切换为{1}）", [ui(label), ui(nextLabel)])}
                aria-label={uiFormat("主题：{0}，切换为{1}", [ui(label), ui(nextLabel)])}
                onClick={() => setTheme(nextId)}
              />
            );
          })()}
          <UpdateCenter call={call} host={host} compact={sidebarNarrow} notify={setNotice} />
          <NavItem
            glyph="settings"
            label={ui("设置")}
            active={navPage === "settings"}
            title={ui("设置")}
            data-tour="nav-settings"
            onClick={() => switchPage("settings")}
          />
        </div>
      </aside>
      <main className={pageTarget ? "is-leaving" : undefined}>
        <header className="topbar">
          <nav className="crumbs" aria-label={ui("位置")}>
            <span className="crumb">{ui("StudyHub")}</span>
            <span className="breadcrumb" aria-hidden="true">
              ›
            </span>
            <span className="crumb current" aria-current="page">
              {shellTitle}
            </span>
          </nav>
          <div className="top-right">
            <LibraryChip root={binding.root} onOpen={() => switchPage("settings")} />
            <span className={"top-status" + (!busy && !running && !syncIssue && data ? " idle" : "")}
              role="status" title={syncIssue || undefined}>
              <i
                className={`dot ${busy || running ? "busy" : data && !syncIssue ? "on" : ""}`}
                aria-hidden="true"
              />
              <span className="top-status-label">{busy
                ? ui("正在保存…")
                : running
                  ? publishing ? ui("正在发布…") : ui("正在生成…")
                  : syncIssue
                    ? isTransientStudyError({ message: syncIssue }) ? ui("连接中断，正在重试…") : ui("学习库读取失败")
                  : data
                    ? ui("已连接")
                    : ui("待连接")}</span>
            </span>
            {data && (
              <Inbox
                inbox={data.inbox}
                busy={busy}
                onOpen={openInboxItem}
                onReadAll={() => markInboxRead(quick)}
                readError={quickApi.failures["inbox:read"]}
                onUndo={(m) => act(m.kind === "rewrite" ? "coach.revert" : "card.revert",
                  { deckId: m.deckId, cardId: m.cardId })}
              />
            )}
          </div>
        </header>
        {data?.ingest && (
          <div role="status" className="alert ingest-banner">
            <span>
              <strong>{ui("录题中")}</strong>{uiFormat(" · 题组「{0}」· 已录入 {1} 题", [data.ingest.deckTitle, data.ingest.added])}<small>{ui("在对话里直接贴题目或截图即可")}</small>
            </span>
            <button
              disabled={busy}
              onClick={() =>
                act("ingest.stop", {}, (r) => setNotice(uiFormat("已停止录题，本次录入 {0} 题。",[r.added])))
              }
            >{ui("停止录题")}</button>
          </div>
        )}
        {!(page === "review" && run && !run.complete) && feedback}
        {!!data?.storageIssues?.length && <div role="alert" className="alert">
          <strong>{ui("部分文件无法读取，其他内容仍可查看。修复前暂停保存，原文件保留。")}</strong>
          <ul>{data.storageIssues.map(issue => <li key={issue.file}>{issue.file}</li>)}</ul>
        </div>}
        {contextTrail.length > 0 && !['review', 'notes'].includes(page) && <div className="context-return">
          <button type="button" disabled={busy} onClick={returnFromContext}>← {contextLabel(contextTrail.at(-1))}</button>
        </div>}
        {data && pageAvailable(data, 'live') && <LiveClass key={binding.root} data={data} call={call} visible={page === "live"}
          onSettings={() => setPage("settings")} onSources={() => setPage("sources")}
          onJobs={() => { void refresh().catch((failure) => setError(failure.message)); }} />}
        {page === "board" ? (
          <Board state={boardState} library={data} onOrigin={host.openWorkspaceNotebook} studyRef={boardStudyRef}
            onClearStudyRef={() => setBoardStudyRef(null)} onStudyRef={openBoardReference} />
        ) : !data ? (
          <section className="onboarding">
            <div className="eyebrow">YOUR LEARNING SPACE</div>
            <h1>{ui("把资料变成真正会的知识。")}</h1>
            <p className="intro">{ui("学习库默认在当前工作区，出题模型跟随当前会话。无法打开时，可以换一个目录后重试。")}</p>
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
            >{ui("重试")}</button>
          </section>
        ) : !pageAvailable(data, page) ? (
          <section className="page" role="status">
            <h1>{language === 'en' ? 'This feature is disabled' : '此功能已停用'}</h1>
            <p>{language === 'en' ? 'Enable its components in the DSH plugin manager to continue. Your saved learning data is retained.' : '在 DSH 插件管理器中启用所需组件后即可继续，已保存的学习资料仍会保留。'}</p>
            <button onClick={() => switchPage('settings')}>{ui('工作区设置')}</button>
          </section>
        ) : (
          <>
            {page === "library" && showWelcome && (
              <Welcome model={modelState} sample={data.sample} busy={busy || sampleBusy}
                onStartSample={loadSampleAndTour} onStartTour={() => startTour({ restart: true })} onImport={openFirstImport}
                onSetupModel={openModelSettings} onRemoveSample={() => setRemovingSample(true)} onLater={hideWelcome} />
            )}
            {page === "library" && !showWelcome && data.sample?.loaded && (
              <SampleBanner sample={data.sample} busy={busy || sampleBusy} onTour={() => startTour({ restart: true })}
                onRemove={() => setRemovingSample(true)} />
            )}
            {page === "library" && !showWelcome && data.coach?.ready > 0 && (
              <div className="coach-offer" role="status">
                <span className="coach-offer-mark" aria-hidden="true"><NavGlyph name="coach" /></span>
                <div>
                  <span className="eyebrow">{ui("为你定制")}</span>
                  <strong>
                    {data.today?.ahead ? ui("今天的任务完成了。") : ""}{uiFormat("为你定制的 {0} 道题已备好", [data.coach.ready])}</strong>
                  <small>{ui("从你答错、标记太简单/太难和只练了概念的地方出发，换成具体场景再练一遍。")}</small>
                </div>
                <button className="primary" disabled={busy} onClick={() => act("coach.practice", {}, enterRun)}>{uiFormat("刷 {0} 道定制题 →", [data.coach.ready])}</button>
              </div>
            )}
            {page === "library" && !showWelcome && (
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
                continueDraft={continueDraft}
                call={call}
                retryGeneration={(job) => {
                  const available = new Set(data.sources.map((source) => source.id));
                  setSelectedSources((job.sourceIds || []).filter((id) => available.has(id)));
                  setGen((current) => ({ ...current, kind: job.kind || current.kind,
                    count: job.requestedTotal || job.count || current.count }));
                  setGenSource("files");
                  setPage("generate");
                  setNotice(ui("已带回可用资料、题型和题数；请核对学习目标后再生成。"));
                }}
                openAgent={host.openAgent}
                cancelJob={(jobId) => act("job.cancel", jobId ? { jobId } : { all: true })}
                dismissJob={(jobId) => dismissJobs(quick, jobId)}
                addSource={() => setModal({ type: "add" })}
                createManual={() =>
                  openDraft({
                    id: crypto.randomUUID(),
                    title: ui("新建闪卡题组"),
                    cards: [blankCard()],
                  })
                }
                importLibrary={() => { setGenSource("json"); setPage("generate"); }}
                generateFromSources={(ids) => { setSelectedSources(ids); setGen((current) => ({ ...current, course: undefined }));
                  setGenSource("files"); setPage("generate"); }}
                openModelSettings={openModelSettings}
                canChat={canChat}
                reveal={revealHome}
                onRevealed={() => setRevealHome(0)}
                askInChat={askInChat}
                theme={theme}
                setTheme={setTheme}
                notebooks={notebooks}
                notebookError={notebookError}
                onNotebookPublish={() => toggleNotebook(true)}
                onNotebookUnpublish={() => toggleNotebook(false)}
                onNotebookOpen={openNotebook}
                refreshNotebooks={loadNotebooks}
                onNotebookSearch={searchNotebooks}
                onShowGraph={(scope, opts) => {
                  setGraphScope(scope ?? null);
                  setGraphCanvas(opts?.canvas !== false);
                  setPage("graph");
                }}
                onFocus={(next) => act("focus.set", next)}
                onCourseSettings={setCourseSettings}
                startCourseFlow={startCourseFlow}
                suggestRole={(args) => call("focus.suggest", args)}
                suggestMerges={(args) => call("deck.merge.suggest", args)}
                mergeDecks={(args) => act("deck.merge", args, null, { rethrow: true })}
              >
                {recovery && (
                  <div className="alert notice">
                    <span>{ui("有本窗口暂存的编辑：")}{recovery.draft.title}{ui("（尚未发布）")}</span>
                    <button
                      onClick={() => {
                        setDraft(recovery.draft);
                        setDraftLoaded(recovery.draftLoaded || JSON.stringify(
                          data.drafts.find((item) => item.id === recovery.draft.id) || recovery.draft));
                        setDraftText(recovery.draftText);
                        setJsonMode(recovery.jsonMode);
                        setPage("draft");
                      }}
                    >{ui("继续编辑")}</button>
                    <button onClick={clearRecovery}>{ui("丢弃暂存")}</button>
                  </div>
                )}
              </StudyMap>
            )}
            {page === "workflows" && <Workflows key={workflowReturn?.nonce || "workflows"} call={call} askInChat={askInChat} data={data}
              openSession={workflowReturn?.sessionId} openRun={(runId) => act("review.get", { runId }, enterRun)} />}
            {page === "skeleton" && (
              <Skeleton
                call={call}
                data={data}
                busy={busy}
                askInChat={askInChat}
                focusId={skeletonFocus}
                onFocus={setSkeletonFocus}
                onPractice={(cards) =>
                  act(
                    "review.start",
                    {
                      mode: "path",
                      scope: [...new Map(cards.map((c) => [c.cardId, { deckId: c.deckId, cardId: c.cardId }])).values()],
                      fresh: true,
                      ...(run && !run.complete ? { returnTo: run.id } : {}),
                    },
                    enterRun,
                  )
                }
              />
            )}
            {page === "dashboard" && (
              <Dashboard
                call={call}
                data={data}
                busy={busy}
                onStartScope={(scope) =>
                  act("review.start", { mode: "path", scope }, enterRun)
                }
                onLibrary={() => setPage("library")}
                onCreate={() => { setGenSource("files"); setPage("generate"); }}
                onSources={() => setPage("sources")}
                onAudioUsage={() => setPage("audio")}
              />
            )}
            {page === "exam" && (
              <Exam
                initialRunId={examRunId}
                initialKind={examKind}
                key={`${data.root}:${examKind}:${examRunId || "latest"}`}
                call={call}
                data={data}
                onLocation={location => { examLocation.current = location; }}
                onStartRun={(next, origin) => { if (origin) rememberContext(captureContext({ page: 'exam', exam: origin })); enterRun(next); }}
                onExit={() => setPage("library")}
                onCreate={() => {
                  setGenSource("files");
                  setPage("generate");
                }}
                onCreateCase={() => { setGenSource("case"); setPage("generate"); }}
                onSetupModel={openModelSettings}
                onNotice={setNotice}
              />
            )}
            {page === "wrongbook" && (
              <WrongBook
                call={call}
                data={data}
                busy={busy}
                onPracticePrepared={(args) => act("coach.practice", args || {}, enterRun)}
                onOpenSettings={openModelSettings}
                onPractice={(scope) =>
                  act(
                    "review.start",
                    { mode: "path", scope, fresh: true },
                    enterRun,
                  )
                }
                onStart={() => act("review.start", { mode: "path" }, enterRun)}
                onLibrary={() => setPage("library")}
                onCreate={() => { setGenSource("files"); setPage("generate"); }}
                onSources={() => setPage("sources")}
              />
            )}
            {page === "graph" && (
              <Graph
                call={call}
                busy={busy}
                scope={graphScope}
                library={data}
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
                decks={data.decks}
                sources={data.sources}
                modelReady={data.modelReady}
                setManagedDeck={setManagedDeck}
                folderDraft={folderDraft}
                setFolderDraft={setFolderDraft}
              />
            )}
            {page === "sources" && (
              <Sources
                key={data.root}
                data={data}
                busy={busy}
                act={act}
                setModal={setModal}
                sourceForm={sourceForm}
                call={call}
                setNotice={setNotice}
                highlight={sourceHighlight}
                openAgent={host.openAgent}
                onOpenSources={openAudioSources}
                onLegacyRetry={job => { setLegacyAudioJobId(job.id); setPage('audio'); }}
                onOpenSettings={() => setPage('settings')}
                onGenerate={generateFromSources}
              />
            )}
            {page === "audio" && <section className="page">
              <div className="page-heading"><div><h1>{language === "en" ? "Audio transcription" : "音频转录"}</h1>
                <p className="muted">{language === "en" ? "Import a recording. Transcription, proofreading and translation run in the background; updates arrive in your inbox." : "导入录音文件，后台完成转录、校对和翻译；进度与完成通知会进入信箱。"}</p></div>
                <div className="section-heading-actions"><button onClick={() => setPage("settings")}>{language === "en" ? "Audio settings" : "音频设置"}</button>
                  <button onClick={() => setPage("sources")}>{language === "en" ? "View sources" : "查看资料"}</button></div></div>
              <AudioImport data={data} busy={busy} act={act} call={call} setNotice={setNotice} askInChat={askInChat} canAsk={!!host.askInChat} openAgent={host.openAgent} onOpenSources={openAudioSources} onOpenSettings={() => setPage('settings')}
                recoveryJobId={legacyAudioJobId} onRecoveryChange={setLegacyAudioJobId} />
              <AudioDashboard call={call} />
            </section>}
            {page === "generate" && (
              <Generate
                data={data}
                busy={busy}
                running={running}
                act={act}
                call={call}
                setPage={setPage}
                setNotice={setNotice}
                openDraft={openDraft}
                genSource={genSource}
                setGenSource={setGenSource}
                gen={gen}
                setGen={setGen}
                selectedSources={selectedSources}
                setSelectedSources={setSelectedSources}
                setModal={setModal}
                askInChat={askInChat}
                canChat={canChat}
                openModelSettings={openModelSettings}
                onStarted={() => { setRevealHome((n) => n + 1); setCaseInitial(null); setPage("library"); }}
                caseInitial={caseInitial || undefined}
                onCourseSettings={setCourseSettings}
                reasoningEffort={binding.effort?.current || ""}
                key={caseInitial?.nonce || "generate"}
              />
            )}
            {page === "draft" && draft && (
              <Draft
                data={data}
                busy={busy}
                act={act}
                call={call}
                draft={draft}
                draftLoaded={draftLoaded}
                setDraft={setDraft}
                draftText={draftText}
                setDraftText={setDraftText}
                jsonMode={jsonMode}
                setJsonMode={setJsonMode}
                openDraft={openDraft}
                continueDraft={continueDraft}
                onOpenPublished={(id) => act("deck.get", { id }, (deck) => {
                  setManagedDeck(deck);
                  setFolderDraft(deck.folder || "");
                  setPage("manage");
                })}
                onStartPublished={enterRun}
                clearRecovery={clearRecovery}
                setPage={setPage}
                setNotice={setNotice}
                setError={setError}
                setModal={setModal}
                setSelectedSources={setSelectedSources}
                setGenSource={setGenSource}
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
                call={call}
                host={host}
                setNotice={setNotice}
                settings={settings}
                setSettings={setSettings}
                legacy={legacy}
                setLegacy={setLegacy}
                workspacePanel={workspacePanel}
                coursePanel={<CourseList courses={data.courses || []} busy={busy} onOpen={setCourseSettings} currentId={data.focus?.courseId}
                  recent={Object.fromEntries((data.focus?.courses || []).map(course => [course.name, course.lastUsedAt]))}
                  onMerge={(id, mergeFrom) => setCourseSettings({ id, mergeFrom })} />}
                onboardingPanel={<OnboardingPanel sample={data.sample} progress={tourResume} busy={busy || sampleBusy}
                  onTour={() => startTour()} onRestart={() => startTour({ restart: true })}
                  onLoad={data.sample ? loadSampleOnly : undefined} onRemove={() => setRemovingSample(true)} />}
                exportData={exportData}
                onRestored={(restored) => {
                  libraryEpoch.current++;
                  navigationRequest.current++;
                  setContextTrail([]); setDetour(null); setWorkflowReturn(null); setSkeletonFocus(null); setNoteInitialId(''); setBoardStudyRef(null);
                  setFocusRequest(null); examLocation.current = null;
                  setRun(null);
                  setExamRunId(null);
                  setDraft(null);
                  setManagedDeck(null);
                  setTeaching(null);
                  setSelectedSources([]);
                  setSettings({});
                  setPage("library");
                  setNotice({ text: restored?.backupPath ? uiFormat("学习库已恢复。原数据已保存到 {0}", [restored.backupPath])
                    : ui("学习库已恢复。原数据已自动保存到当前学习库的 backups 文件夹。"), tone: "success", persistent: true });
                }}
              />
            )}
            {page === "review" && run && (
              <Review
                feedback={feedback}
                contextReturnLabel={contextTrail.length ? contextLabel(contextTrail.at(-1)) : ''}
                onReturnContext={returnFromContext}
                detour={detour && !(detour.runId === run.id && detour.index === run.index) ? detour : null}
                onReturnFromDetour={returnFromDetour}
                onCourseFlow={startCourseFlow}
                onBackToWorkflow={(sessionId) => { setWorkflowReturn({ sessionId, nonce: Date.now() }); setPage("workflows"); }}
                onOpenNote={(noteId) => openLearningTarget({ kind: 'note', id: noteId })}
                onMakeNote={() => { const origin = captureContext(); return act("note.create", {
                  title: uiFormat('学习笔记 · {0}', [new Date().toLocaleDateString(uiLocale())]),
                  cards: [{ deckId: run.deckId || run.card?.deckId, cardId: run.card?.id }],
                }, (note) => { rememberContext(origin); setNoteInitialId(note.id); setPage("notes"); }); }}
                onMakeTask={openBoardWithContext}
                openSkeleton={id => openLearningTarget({ kind: 'skeleton', id })}
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
                assistCard={assistCard}
                assistTasks={data?.assist}
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
            {page === "notes" && <BlogNotes key={data.root} data={data} call={call} act={act} theme={resolvedTheme}
              initialId={noteInitialId} onSelect={setNoteInitialId}
              onOpenCard={ref => openLearningTarget({ kind: 'card', ...ref })}
              backLabel={contextTrail.length ? contextLabel(contextTrail.at(-1)) : ''}
              onBack={contextTrail.length ? returnFromContext : () => { setNoteInitialId(""); setPage("library"); }} />}
          </>
        )}
      </main>
      {shortcutHelp && <ShortcutHelp page={page} onClose={() => setShortcutHelp(false)} />}
      {tourStep && data && (
        <Tour steps={tourSteps} stepId={tourStep} rootRef={rootRef} model={modelState} sampleLoaded={!data.sample || !!data.sample.loaded}
          busy={sampleBusy} onEnter={enterTourStep} onMove={moveTour} onClose={closeTour} onFinish={finishTour}
          onLoadSample={data.sample ? loadSampleInTour : undefined} onBrowse={() => moveTour(1)}
          onImport={() => endTour({ then: openFirstImport })}
          onRemoveSample={data.sample?.loaded ? () => endTour({ then: () => setRemovingSample(true) }) : undefined} />
      )}
      {courseSettings && <CourseSettings key={courseSettings.id ? `${courseSettings.id}:${courseSettings.mergeFrom.join(',')}` : courseSettings} data={data}
        courseId={courseSettings.id || courseSettings} mergeFrom={courseSettings.mergeFrom} act={act} busy={busy}
        setNotice={setNotice} onClose={() => setCourseSettings(null)} />}
      {removingSample && <RemoveSampleDialog busy={sampleBusy} onConfirm={removeSampleData}
        onClose={() => { if (!sampleBusy) setRemovingSample(false); }} />}
      {modal && (
        <ModalFrame fullscreen={modal.type === 'source'} onClose={() => setModal(null)}
          title={modal.type === "add"
                  ? ui("添加资料")
                  : modal.type === "sources"
                    ? ui("学习资料")
                    : modal.type === "flag"
                      ? ui("标记这道题")
                      : (modal.source?.document ? modal.source.title.replace(/\s*·\s*p\.\d+$/, "") : modal.source?.title) || ui("资料不可用")}>
            {modal.type === "add" ? (
              sourceForm
            ) : modal.type === "sources" ? (
              (modal.sourceIds || run?.sourceIds || []).map(id => data.sources.find(source => source.id === id)).filter(Boolean)
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
                        flag ? ui("题目已标记，下轮优先复习") : ui("题目标记已清除"),
                      );
                    },
                  );
                }}
              >
                <label>{ui("问题或需要回顾的地方")}<textarea
                    value={flag}
                    maxLength={1000}
                    onChange={(e) => setFlag(e.target.value)}
                    placeholder={ui("例如：干扰项似乎也成立，需要核对原文")}
                  />
                </label>
                <p className="muted">{ui("保留空白并保存可清除标记。")}</p>
                <button className="primary" disabled={busy}>{ui("保存标记")}</button>
              </form>
            ) : (
              <>
                {modal.quote && !modal.source && (
                  <blockquote className="highlight-quote">
                    {modal.quote}
                  </blockquote>
                )}
                {modal.source ? (
                  <>
                    {!!modal.source.usedBy?.length && <div className="source-connections">
                      <small className="muted">{ui('使用这份资料的题组')}</small>
                      {modal.source.usedBy.map(deck => <button key={`${deck.kind}:${deck.id}`} disabled={busy || deck.kind === 'draft'}
                        onClick={() => openLearningTarget({ kind: 'deck', id: deck.id })}>{deck.title}{deck.archived ? ` · ${ui('已归档')}` : ''}</button>)}
                    </div>}
                    <DocumentViewer source={modal.source} quote={modal.quote} call={call} data={data} host={host} generateDisabled={busy}
                      onGenerate={() => {
                        rememberContext(); setSelectedSources(documentSourceIds(data.sources, modal.source.id)); setGen(current => ({ ...current, course: undefined }));
                        setGenSource('files'); setModal(null); setPage('generate');
                      }}
                      onPublished={() => refresh()} onOpenCard={ref => { setModal(null); openLearningTarget({ kind: 'card', ...ref }); }}
                      onCaseFromPassage={(passage) => { rememberContext(); setCaseInitial({ sourceIds: documentSourceIds(data.sources, modal.source.id), focus: passage.quote, nonce: Date.now() });
                        setGenSource('case'); setModal(null); setPage('generate'); }} />
                  </>
                ) : (
                  <p className="muted">{ui("无法找到此资料。")}</p>
                )}
              </>
            )}
        </ModalFrame>
      )}
    </div>
    </QuickActionsContext.Provider>
  );
}

/** The folder a learner recognises: the default library is a hidden folder inside its workspace. */
export function libraryFolderName(root) {
  const text = String(root || "");
  const parts = text.split(/[\\/]+/).filter(Boolean);
  const last = parts.at(-1) || text;
  return last === ".dsh-study" && parts.length > 1 ? parts.at(-2) : last;
}

/** Top-bar "学习库：<folder>" (P03): where the library lives, one click from Settings. */
export function LibraryChip({ root, onOpen }) {
  if (!root) return null;
  return (
    <button type="button" className="library-chip" title={root}
      aria-label={uiFormat("学习库位置：{0}。打开设置可更改", [root])} onClick={onOpen}>
      <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.4"
        strokeLinejoin="round" aria-hidden="true" focusable="false">
        <path d="M1.75 4.25a1 1 0 0 1 1-1h3.1l1.4 1.5h6a1 1 0 0 1 1 1v6.5a1 1 0 0 1-1 1H2.75a1 1 0 0 1-1-1z" />
      </svg>
      <span>{uiFormat("学习库：{0}", [libraryFolderName(root)])}</span>
    </button>
  );
}
