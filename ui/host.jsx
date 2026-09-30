import { ui } from "./i18n.js";
import React from "react";
import App from "./App.jsx";
import css from "./style.css";
import bridgeCss from "./panel-bridge.css";
import audioDashboardCss from './audio-dashboard.css';
import { createStudyCall } from "./transport.js";
import { registerDocumentLearning } from './document-preview/native.jsx';
import { sessionFileAddress } from './document-preview/selection.js';
export const inject = ["slots", "locale"];
// A run handed from the main view to the right sidebar (session id → run id).
const handoff = new Map(),
  handoffListeners = new Set();
const knownSessions = new Map(),
  candidates = new Map(),
  candidateListeners = new Set();
function deliverRun(sessionId, runId) {
  handoff.set(sessionId, runId);
  handoffListeners.forEach((fn) => fn(sessionId));
}
function deliverCandidates(sessionId, intent) {
  candidates.set(sessionId, intent);
  candidateListeners.forEach((fn) => fn(sessionId));
}
/** Read an optional host snapshot store; absent stores read as undefined. */
function useHostStore(store) {
  const subscribe = React.useCallback(
      (fn) => (store ? store.subscribe(fn) : () => {}),
      [store],
    ),
    read = React.useCallback(() => store?.getSnapshot(), [store]);
  return React.useSyncExternalStore(subscribe, read);
}
// One render error anywhere in App would otherwise blank the whole study tab;
// the boundary keeps the slot alive and offers a fresh remount.
class StudyBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { error: null, nonce: 0 };
  }
  static getDerivedStateFromError(error) {
    return { error };
  }
  componentDidCatch(error) {
    console.error("[study-workspace] render failed:", error);
  }
  render() {
    const { error, nonce } = this.state;
    if (!error) return <React.Fragment key={nonce}>{this.props.children}</React.Fragment>;
    return (
      <div className="study-app">
        <div className="empty">
          <span className="empty-icon">⚠️</span>
          <h2>{ui("学习工作台渲染出错")}</h2>
          <p>{String(error?.message || error)}</p>
          <button
            className="ghost-btn"
            type="button"
            onClick={() => this.setState((s) => ({ error: null, nonce: s.nonce + 1 }))}
          >{ui("重新加载")}</button>
        </div>
      </div>
    );
  }
}

export function apply(ctx) {
  const makeCall = sessionId => createStudyCall({ rpc: { call: (...args) => {
    const connection = ctx.get('connection');
    if (!connection?.rpc) throw new Error('Study connection is unavailable');
    return connection.rpc.call(...args);
  } } }, sessionId);
  registerDocumentLearning(ctx, makeCall, async (sessionId, link) => {
    const run = await makeCall(sessionId)('review.start', { mode: 'path', fresh: true,
      scope: [{ deckId: link.deckId, cardId: link.cardId }] });
    deliverRun(sessionId, run.id); ctx.get('sidebarRight')?.openTab('study-workspace');
  });
  ctx.effect(
    () =>
      ctx.locale.register("study-workspace", {
        zh: { tab: "学习", guide: "闪卡、测验与间隔复习" },
        en: { tab: "Study", guide: "Flashcards, quizzes and spaced review" },
      }),
    "study copy",
  );
  const t = ctx.locale.bind("study-workspace");
  ctx.effect(() => {
    const el = document.createElement("style");
    el.textContent = css + "\n" + bridgeCss + '\n' + audioDashboardCss;
    document.head.appendChild(el);
    return () => el.remove();
  }, "study styles");
  // A Study seat may unmount when the learner returns to chat. Remember its
  // session transport so a later conversation command can open the sidebar.
  ctx.effect(() => {
    let polling = false;
    const poll = async () => {
      if (polling || !ctx.get("sidebarRight")?.openTab) return;
      polling = true;
      try {
        for (const [sessionId, call] of knownSessions) {
          let pending;
          try { pending = await call("panel.intent.next"); } catch { continue; }
          const intent = pending?.intent;
          if (!intent) continue;
          if (intent.type === "run") deliverRun(sessionId, intent.runId);
          if (intent.type === "candidates") deliverCandidates(sessionId, intent);
          ctx.get("sidebarRight")?.openTab("study-workspace");
        }
      } finally { polling = false; }
    };
    const timer = setInterval(poll, 1800);
    return () => clearInterval(timer);
  }, "study conversation panel bridge");
  function Seat(props) {
    const { sessionId, openView } = props;
    const placement = props.placement || "main";
    const call = React.useMemo(
      () =>
        createStudyCall(
          {
            rpc: {
              call: (...args) => {
                const c = ctx.get("connection");
                if (!c?.rpc) throw new Error("Study connection is unavailable");
                return c.rpc.call(...args);
              },
            },
          },
          sessionId,
        ),
      [sessionId],
    );
    const visibleSequence = React.useRef(0);
    React.useEffect(() => {
      if (!sessionId) return;
      knownSessions.set(sessionId, call);
      if (knownSessions.size > 8) knownSessions.delete(knownSessions.keys().next().value);
    }, [sessionId, call]);
    const [candidateIntent, setCandidateIntent] = React.useState(() => candidates.get(sessionId) || null);
    const [candidateError, setCandidateError] = React.useState("");
    React.useEffect(() => {
      const update = (target) => { if (target === sessionId) setCandidateIntent(candidates.get(sessionId) || null); };
      candidateListeners.add(update);
      update(sessionId);
      return () => candidateListeners.delete(update);
    }, [sessionId]);
    const chooseCandidate = async (item) => {
      try {
        const run = await call("review.start", { mode: "path", fresh: true,
          scope: [{ deckId: item.deckId, cardId: item.cardId }],
          ...(candidateIntent.returnTo ? { returnTo: candidateIntent.returnTo } : {}) });
        setCandidateError("");
        deliverCandidates(sessionId, null);
        deliverRun(sessionId, run.id);
      } catch (error) { setCandidateError(error.message); }
    };
    const models = ctx.get("modelDirectories");
    const catalog = useHostStore(models?.catalog?.store);
    const directory = React.useMemo(() => {
      try {
        return sessionId
          ? models?.directoryFor(sessionId)?.store
          : undefined;
      } catch {
        return undefined;
      }
    }, [models, sessionId]);
    const current = useHostStore(directory);
    React.useEffect(() => {
      models?.catalog?.load?.().catch(() => {});
    }, [models]);
    const workspace = ctx.get("uiWorkspace");
    const host = React.useMemo(
      () => ({
        pickDirectory: workspace?.pickDirectory
          ? () => workspace.pickDirectory()
          : undefined,
        modelGroups: catalog?.value?.groups,
        sessionModel: current?.current || catalog?.value?.default,
        openAgent: (id) => ctx.get("sessions")?.open(id),
        openDocument: path => ctx.get('sidebarRight')?.openResource(sessionFileAddress(sessionId, path)),
        // Cross-workspace jump: create a new conversation in the notebook's
        // own workspace and select it; the study tab there opens that library.
        // Throws at call time when the host lacks the sessions create face.
        openWorkspaceNotebook: async (cwd) => {
          const sessions = ctx.get("sessions");
          if (!sessions?.create || !sessions?.open)
            throw new Error(ui("当前 DSH 版本不支持跳转到其他工作区"));
          const id = await sessions.create({ cwd });
          sessions.open(id);
          return id;
        },
        // Prefill (never auto-send) this session's composer.
        askInChat: (text) => {
          try {
            const actx = ctx.get("sessions")?.scope?.(sessionId),
              conversation = actx?.get("conversation");
            if (!conversation) return false;
            conversation.input.for(actx).setDraft(text);
            // In the main area the study tab hides the chat; switch so the draft is visible.
            openView?.("chat", "");
            return true;
          } catch {
            return false;
          }
        },
        onReviewState: (run) => call("panel.visible", { placement,
          sequence: ++visibleSequence.current,
          run: run ? { id: run.id, deckId: run.deckId, card: run.card && { id: run.card.id },
            index: run.index, total: run.total, mode: run.mode, feedback: run.feedback,
            picks: run.picks, revealed: run.revealed, complete: run.complete } : null }).catch(() => {}),
        // Optional: keep the question in the right sidebar while the main area shows chat.
        openInSidebar:
          placement === "main" && ctx.get("sidebarRight")?.openTab
            ? (runId) => {
                if (runId) deliverRun(sessionId, runId);
                ctx.get("sidebarRight").openTab("study-workspace");
                openView?.("chat", "");
              }
            : undefined,
        takeHandoff:
          placement === "sidebar"
            ? (listener) => {
                const take = () => {
                  const runId = handoff.get(sessionId);
                  handoff.delete(sessionId);
                  if (runId) listener(runId);
                };
                take();
                const fn = (targetSessionId) => targetSessionId === sessionId && setTimeout(take);
                handoffListeners.add(fn);
                return () => handoffListeners.delete(fn);
              }
            : undefined,
      }),
      [workspace, catalog, current, sessionId, openView, placement, call],
    );
    return (
      <div className="study-seat"><StudyBoundary>
        {placement === "sidebar" && candidateIntent?.candidates?.length > 0 &&
          <div className="study-panel-candidates" role="dialog" aria-label={ui("选择题目")}>
            <div className="study-panel-candidates-head">
              <strong>{ui("选择要打开的题目")}</strong>
              <button type="button" onClick={() => deliverCandidates(sessionId, null)}>{ui("取消")}</button>
            </div>
            {candidateError && <p role="alert">{candidateError}</p>}
            {candidateIntent.candidates.map((item) =>
              <button type="button" key={`${item.deckId}:${item.cardId}`} onClick={() => chooseCandidate(item)}>
                <small>{item.deckTitle} · {item.topic || ui("未分类")}</small>
                <span>{item.prompt}</span>
              </button>)}
          </div>}
        <App key={sessionId || "empty"} call={call} host={host} />
      </StudyBoundary></div>
    );
  }
  ctx.slots.inject("conversation.view", () =>
    ctx.slots.register(
      {
        name: "conversation.view",
        id: "study-workspace",
        order: 26,
        locale: "study-workspace",
        label: () => t("tab"),
      },
      Seat,
    ),
  );
  const SidebarSeat = (props) => <Seat {...props} placement="sidebar" />;
  ctx.inject(["sidebarRightTabs"], (c) => {
    const dispose = c.sidebarRightTabs.register({
      id: "study-workspace",
      kind: "study-workspace",
      title: () => t("tab"),
      guide: [
        { order: 26, title: () => t("tab"), description: () => t("guide") },
      ],
    });
    const body = c.slots.inject("sidebar.right.pane.tab", () =>
      c.slots.register(
        {
          name: "sidebar.right.pane.tab",
          key: "study-workspace",
          locale: "study-workspace",
        },
        SidebarSeat,
      ),
    );
    return () => {
      body?.();
      dispose?.();
    };
  });
}
