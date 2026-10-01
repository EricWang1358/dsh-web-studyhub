import StudyBoundary from "./StudyBoundary.jsx";
import { getUiLanguage, ui } from "../i18n.js";
import React from "react";
import App from "../App.jsx";
import css from "../style.css";
import bridgeCss from "../panel-bridge.css";
import audioDashboardCss from '../audio-dashboard.css';
import hostCss from './studyhub.css';
import { createStudyCall } from "../transport.js";
import { sessionFileAddress } from '../document-preview/selection.js';
import { NoSessionNotice, StudyHubGlyph } from './studyhub-page.jsx';
// The top-level DSH page (root `main` panel) and its sidebar entry share one key.
export const STUDYHUB_PANEL = "studyhub";
const PAGE_SLOT = "study-workspace.page";
const WELCOME_KEY = "studyhub.welcomed.v1";
const STUDYHUB_PACKAGE = "@ericwang1358/dsh-daily-flashcard";
/* Plan contract C3: what this host can do, read by the shared UI instead of
   probing for host callbacks. The DSH plugin can hand a prompt to the session's
   composer; background agent tasks and a landing shell are not wired yet. */
const PLUGIN_CAPABILITIES = Object.freeze({ edition: "plugin", chat: true, agentTasks: false, landing: false });
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
  return React.useSyncExternalStore(subscribe, read, read);
}
/** Durable browser storage, or null where it is absent or blocked. */
function durableStorage() {
  try { return window.localStorage || null; } catch { return null; }
}

export function apply(ctx, registerDocumentLearning) {
  const makeCall = sessionId => {
    const call = createStudyCall({ rpc: { call: (...args) => {
      const connection = ctx.get('connection');
      if (!connection?.rpc) throw new Error('Study connection is unavailable');
      return connection.rpc.call(...args);
    } } }, sessionId);
    return (action, args = {}) => call(action, { ...args, uiLanguage: getUiLanguage() });
  };
  registerDocumentLearning(ctx, makeCall, async (sessionId, link) => {
    const run = await makeCall(sessionId)('review.start', { mode: 'path', fresh: true,
      scope: [{ deckId: link.deckId, cardId: link.cardId }] });
    deliverRun(sessionId, run.id); ctx.get('sidebarRight')?.openTab('study-workspace');
  });
  ctx.effect(
    () =>
      ctx.locale.register("study-workspace", {
        zh: { tab: "StudyHub", page: "StudyHub", guide: "用你的资料出题、练习与间隔复习" },
        en: { tab: "StudyHub", page: "StudyHub", guide: "Cited flashcards, quizzes and spaced review from your materials" },
      }),
    "study copy",
  );
  const t = ctx.locale.bind("study-workspace");
  ctx.effect(() => {
    const el = document.createElement("style");
    el.textContent = css + "\n" + bridgeCss + '\n' + audioDashboardCss + '\n' + hostCss;
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
  /** One shared App per placement: the conversation tab ("main"), the right sidebar, or the top-level page. */
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
      () => {
        // The conversation tab switches views; the top-level page reveals the Conversation panel.
        const showChat = placement === "page"
          ? () => ctx.get("layout")?.selectPanel(null)
          : () => openView?.("chat", "");
        return {
        capabilities: PLUGIN_CAPABILITIES,
        pickDirectory: workspace?.pickDirectory
          ? () => workspace.pickDirectory()
          : undefined,
        modelGroups: catalog?.value?.groups,
        sessionModel: current?.current || catalog?.value?.default,
        openAgent: (id) => ctx.get("sessions")?.open(id),
        // WP15: DSH's plugin manager page, scrolled to StudyHub when the host offers that.
        openPluginManager: ctx.get("layout")?.selectPanel
          ? () => {
              const navigation = ctx.get("pluginNavigation");
              if (navigation?.openBundle) navigation.openBundle(STUDYHUB_PACKAGE);
              else ctx.get("layout").selectPanel("plugins");
            }
          : undefined,
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
            // StudyHub covers the chat; switch so the draft is visible.
            showChat();
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
          placement !== "sidebar" && ctx.get("sidebarRight")?.openTab
            ? (runId) => {
                if (runId) deliverRun(sessionId, runId);
                ctx.get("sidebarRight").openTab("study-workspace");
                showChat();
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
        };
      },
      [workspace, catalog, current, sessionId, openView, placement, call],
    );
    const seat = (
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
    // DSH floats its composer over the conversation view; reserve its height there.
    return placement === "main"
      ? <div className="study-seat-frame" data-conversation-composer-overlay="">{seat}</div>
      : seat;
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
  /* Top-level StudyHub page (P01): a root `main` panel with a labelled entry in
     DSH's left sidebar, reachable without sending a message. Its child slot is
     `session-maybe` scoped, so like the Conversation it follows the session DSH
     has selected (DSH creates a blank one in the default workspace at boot). */
  const startSession = () => ctx.get("uiWorkspace")?.startSession?.();
  function StudyHubPage({ sessionId }) {
    if (!sessionId) return <NoSessionNotice onStart={ctx.get("uiWorkspace")?.startSession ? startSession : undefined} />;
    return <div className="studyhub-page"><Seat sessionId={sessionId} placement="page" /></div>;
  }
  const StudyHubPanel = ({ renderSlot }) => renderSlot(PAGE_SLOT, {});
  ctx.slots.inject("main", () =>
    ctx.slots.register(
      {
        name: "main",
        key: STUDYHUB_PANEL,
        locale: "study-workspace",
        children: { [PAGE_SLOT]: { kind: "single", scope: "session-maybe" } },
      },
      StudyHubPanel,
    ),
  );
  ctx.slots.inject(PAGE_SLOT, () =>
    ctx.slots.register({ name: PAGE_SLOT, locale: "study-workspace" }, StudyHubPage),
  );
  ctx.slots.inject("sidebar.panellist", () =>
    ctx.slots.register(
      {
        name: "sidebar.panellist",
        id: STUDYHUB_PANEL,
        // Plugins sits at 0: StudyHub is listed first.
        order: -10,
        locale: "study-workspace",
        label: () => t("page"),
      },
      StudyHubGlyph,
    ),
  );
  /* First enable lands on StudyHub once. The flag is per browser profile;
     without durable storage it would steal the main view on every load, so
     it does nothing there. selectPanel throws until the panel is registered. */
  ctx.effect(() => {
    const storage = durableStorage();
    let seen = true;
    try { seen = !storage || !!storage.getItem(WELCOME_KEY); } catch { seen = true; }
    if (seen) return;
    let tries = 0, timer;
    const land = () => {
      try {
        const layout = ctx.get("layout");
        if (!layout?.selectPanel) throw new Error("layout is not ready");
        layout.selectPanel(STUDYHUB_PANEL);
      } catch {
        if (++tries < 20) timer = setTimeout(land, 150);
        return;
      }
      try { storage.setItem(WELCOME_KEY, new Date().toISOString()); } catch { /* shown once this load */ }
    };
    timer = setTimeout(land, 0);
    return () => clearTimeout(timer);
  }, "studyhub first-run landing");
}
