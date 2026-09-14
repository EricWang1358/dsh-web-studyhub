import React from "react";
import App from "./App.jsx";
import css from "./style.css";
import { createStudyCall } from "./transport.js";
export const inject = ["slots", "locale"];
// A run handed from the main view to the right sidebar (session id → run id).
const handoff = new Map(),
  handoffListeners = new Set();
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
          <h2>学习工作台渲染出错</h2>
          <p>{String(error?.message || error)}</p>
          <button
            className="ghost-btn"
            type="button"
            onClick={() => this.setState((s) => ({ error: null, nonce: s.nonce + 1 }))}
          >
            重新加载
          </button>
        </div>
      </div>
    );
  }
}

export function apply(ctx) {
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
    el.textContent = css;
    document.head.appendChild(el);
    return () => el.remove();
  }, "study styles");
  function Seat(props) {
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
          props.sessionId,
        ),
      [props.sessionId],
    );
    const models = ctx.get("modelDirectories");
    const catalog = useHostStore(models?.catalog?.store);
    const directory = React.useMemo(() => {
      try {
        return props.sessionId
          ? models?.directoryFor(props.sessionId)?.store
          : undefined;
      } catch {
        return undefined;
      }
    }, [models, props.sessionId]);
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
        // Cross-workspace jump: create a new conversation in the notebook's
        // own workspace and select it; the study tab there opens that library.
        // Throws at call time when the host lacks the sessions create face.
        openWorkspaceNotebook: async (cwd) => {
          const sessions = ctx.get("sessions");
          if (!sessions?.create || !sessions?.open)
            throw new Error("当前 DSH 版本不支持跳转到其他工作区");
          const id = await sessions.create({ cwd });
          sessions.open(id);
          return id;
        },
        // Prefill (never auto-send) this session's composer.
        askInChat: (text) => {
          try {
            const actx = ctx.get("sessions")?.scope?.(props.sessionId),
              conversation = actx?.get("conversation");
            if (!conversation) return false;
            conversation.input.for(actx).setDraft(text);
            // In the main area the study tab hides the chat; switch so the draft is visible.
            props.openView?.("chat", "");
            return true;
          } catch {
            return false;
          }
        },
        // Optional: keep the question in the right sidebar while the main area shows chat.
        openInSidebar:
          placement === "main" && ctx.get("sidebarRight")?.openTab
            ? (runId) => {
                if (runId) handoff.set(props.sessionId, runId);
                handoffListeners.forEach((fn) => fn(props.sessionId));
                ctx.get("sidebarRight").openTab("study-workspace");
                props.openView?.("chat", "");
              }
            : undefined,
        takeHandoff:
          placement === "sidebar"
            ? (listener) => {
                const take = () => {
                  const runId = handoff.get(props.sessionId);
                  handoff.delete(props.sessionId);
                  if (runId) listener(runId);
                };
                take();
                const fn = (sessionId) => sessionId === props.sessionId && setTimeout(take);
                handoffListeners.add(fn);
                return () => handoffListeners.delete(fn);
              }
            : undefined,
      }),
      [workspace, catalog, current, props.sessionId, props.openView, placement],
    );
    return (
      <div className="study-seat"><StudyBoundary>
        <App key={props.sessionId || "empty"} call={call} host={host} />
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
