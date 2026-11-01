import React from "react";
import { browserStorage } from "./storage.js";
import { HostBootFallback, StudyHubBrandGlyph } from "./components/HostBootShell.jsx";

export const inject = ["slots", "locale"];

const STUDYHUB_PANEL = "studyhub";
const PAGE_SLOT = "study-workspace.page";
const WELCOME_KEY = "studyhub.welcomed.v1";

function createLazyLoader(task) {
  let state = { status: "idle", value: null, error: null };
  let inflight = null;
  const listeners = new Set();
  const notify = () => listeners.forEach((fn) => fn());

  function load() {
    if (state.status === "ready") return Promise.resolve(state.value);
    if (inflight) return inflight;
    if (state.status !== "loading") {
      state = { status: "loading", value: null, error: null };
      notify();
    }
    const run = Promise.resolve()
      .then(task)
      .then(
        (value) => {
          inflight = null;
          if (value == null) return null;
          state = { status: "ready", value, error: null };
          notify();
          return value;
        },
        (error) => {
          inflight = null;
          state = { status: "error", value: null, error };
          notify();
          throw error;
        },
      );
    inflight = run;
    return run;
  }

  function retry() {
    if (inflight) return inflight;
    state = { status: "idle", value: null, error: null };
    return load().catch(() => {});
  }

  return {
    getSnapshot: () => state,
    subscribe: (fn) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    load,
    retry,
  };
}

function useLazyResource(loader, retryKey) {
  const snapshot = React.useSyncExternalStore(loader.subscribe, loader.getSnapshot, loader.getSnapshot);
  const previousKey = React.useRef(retryKey);
  React.useEffect(() => {
    if (snapshot.status === "idle") loader.load().catch(() => {});
  }, [loader, snapshot.status]);
  React.useEffect(() => {
    if (retryKey === undefined || previousKey.current === retryKey) return;
    previousKey.current = retryKey;
    if (loader.getSnapshot().status === "error") loader.retry();
  }, [loader, retryKey]);
  return snapshot;
}

function LazyHostSlot({ loader, pick, copy, slotProps, composerOverlay = false }) {
  const { status, value, error } = useLazyResource(loader);
  if (status === "ready" && value) {
    const Component = pick(value);
    return <Component {...slotProps} />;
  }
  return (
    <HostBootFallback
      status={status === "error" ? "error" : "loading"}
      error={error}
      copy={copy()}
      onRetry={loader.retry}
      composerOverlay={composerOverlay}
    />
  );
}

// Register slots and locale synchronously so DSH web boot never waits on or
// crashes over StudyHub's UI chunk tree (#630). Heavy chunks and the English
// catalogue (#563) load only when a StudyHub or document-preview slot mounts.
export function apply(ctx) {
  try {
    let disposed = false;
    const safeEffect = (setup, label) => {
      if (disposed) return;
      try {
        ctx.effect(setup, label);
      } catch (error) {
        if (error?.code === "INACTIVE_EFFECT" || /INACTIVE_EFFECT/i.test(String(error?.message || ""))) {
          disposed = true;
          return;
        }
        throw error;
      }
    };
    safeEffect(() => () => {
      disposed = true;
    }, "study lazy host guard");

    const workspaceLoader = createLazyLoader(async () => {
      const workspace = await import("./host/workspace.jsx");
      await workspace.uiLanguageReady();
      if (disposed) return null;
      return workspace.createWorkspaceHost(ctx, { effect: safeEffect });
    });

    const openCardFromDocument = async (sessionId, link) => {
      const workspace = await workspaceLoader.load();
      if (!workspace) return;
      return workspace.openCard(sessionId, link);
    };

    const documentLoader = createLazyLoader(async () => {
      const documents = await import("./document-preview/native.jsx");
      await documents.uiLanguageReady();
      if (disposed) return null;
      return documents.createDocumentLearning(ctx, null, openCardFromDocument, { effect: safeEffect });
    });

    ctx.effect(
      () =>
        ctx.locale.register("study-workspace", {
          zh: {
            tab: "StudyHub",
            page: "StudyHub",
            guide: "用你的资料出题、练习与间隔复习",
            preview: "学习 HTML",
            loading: "正在加载 StudyHub…",
            failedTitle: "StudyHub 界面未能加载完成",
            failedHint: "网络波动或插件资源未就绪，主会话不受影响。请点击重试。",
            retry: "重试",
            details: "技术详情",
          },
          en: {
            tab: "StudyHub",
            page: "StudyHub",
            guide: "Cited flashcards, quizzes and spaced review from your materials",
            preview: "Study HTML",
            loading: "Loading StudyHub…",
            failedTitle: "StudyHub couldn't finish loading",
            failedHint: "A plugin resource failed to load while your main chat stays available. Try loading StudyHub again.",
            retry: "Retry",
            details: "Technical details",
          },
        }),
      "study copy",
    );
    const t = ctx.locale.bind("study-workspace");
    const fallbackCopy = () => ({
      loading: t("loading"),
      failedTitle: t("failedTitle"),
      failedHint: t("failedHint"),
      retry: t("retry"),
      details: t("details"),
    });

    const LazyConversationSeat = (props) => (
      <LazyHostSlot loader={workspaceLoader} pick={(ws) => ws.Seat} copy={fallbackCopy} slotProps={props} composerOverlay />
    );
    const LazySidebarSeat = (props) => (
      <LazyHostSlot loader={workspaceLoader} pick={(ws) => ws.SidebarSeat} copy={fallbackCopy} slotProps={props} />
    );
    const LazyStudyHubPage = (props) => (
      <LazyHostSlot loader={workspaceLoader} pick={(ws) => ws.StudyHubPage} copy={fallbackCopy} slotProps={props} />
    );
    const StudyHubPanel = ({ renderSlot }) => renderSlot(PAGE_SLOT, {});

    function LazyDocumentActions(props) {
      const retryKey = `${props.sessionId || ""}:${props.absolutePath || ""}`;
      const { status, value } = useLazyResource(documentLoader, retryKey);
      if (status === "ready" && value) {
        const Component = value.DocumentActions;
        return <Component {...props} />;
      }
      return null;
    }

    const LazyStudyHtml = (props) => (
      <LazyHostSlot loader={documentLoader} pick={(doc) => doc.StudyHtml} copy={fallbackCopy} slotProps={props} />
    );

    ctx.slots.inject("conversation.view", () =>
      ctx.slots.register(
        {
          name: "conversation.view",
          id: "study-workspace",
          order: 26,
          locale: "study-workspace",
          label: () => t("tab"),
        },
        LazyConversationSeat,
      ),
    );

    ctx.inject(["sidebarRightTabs"], (c) => {
      const dispose = c.sidebarRightTabs.register({
        id: "study-workspace",
        kind: "study-workspace",
        title: () => t("tab"),
        guide: [{ order: 26, title: () => t("tab"), description: () => t("guide") }],
      });
      const body = c.slots.inject("sidebar.right.pane.tab", () =>
        c.slots.register(
          {
            name: "sidebar.right.pane.tab",
            key: "study-workspace",
            locale: "study-workspace",
          },
          LazySidebarSeat,
        ),
      );
      return () => {
        body?.();
        dispose?.();
      };
    });

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
      ctx.slots.register({ name: PAGE_SLOT, locale: "study-workspace" }, LazyStudyHubPage),
    );
    ctx.slots.inject("sidebar.panellist", () =>
      ctx.slots.register(
        {
          name: "sidebar.panellist",
          id: STUDYHUB_PANEL,
          order: -10,
          locale: "study-workspace",
          label: () => t("page"),
        },
        StudyHubBrandGlyph,
      ),
    );

    ctx.effect(
      () =>
        ctx.slots.inject("sidebar.right.tab.document.actions", () =>
          ctx.slots.register(
            {
              name: "sidebar.right.tab.document.actions",
              id: "study-selection-learning",
              order: 80,
            },
            LazyDocumentActions,
          ),
        ),
      "study document toolbar",
    );

    ctx.inject(["documentPreviews"], (c) => {
      const metadata = c.documentPreviews.register({
        id: "study-html",
        extensions: ["html", "htm"],
        priority: "extension",
        title: () => t("preview"),
        loading: "text-pages",
        wrap: true,
      });
      const body = c.slots.inject("sidebar.right.tab.document", () =>
        c.slots.register({ name: "sidebar.right.tab.document", key: "study-html" }, LazyStudyHtml),
      );
      return () => {
        body?.();
        metadata?.();
      };
    });

    ctx.effect(() => {
      const storage = browserStorage(typeof window !== "undefined" ? window : globalThis);
      let seen = true;
      try {
        seen = !storage || !!storage.getItem(WELCOME_KEY);
      } catch {
        seen = true;
      }
      if (seen) return;
      let tries = 0;
      let timer;
      const land = () => {
        try {
          const layout = ctx.get("layout");
          if (!layout?.selectPanel) throw new Error("layout is not ready");
          layout.selectPanel(STUDYHUB_PANEL);
        } catch {
          if (++tries < 20) timer = setTimeout(land, 150);
          return;
        }
        try {
          storage.setItem(WELCOME_KEY, new Date().toISOString());
        } catch {
          /* shown once this load */
        }
      };
      timer = setTimeout(land, 0);
      return () => clearTimeout(timer);
    }, "studyhub first-run landing");
  } catch (error) {
    try {
      console.error("StudyHub: host activation degraded without blocking DSH boot", error);
    } catch {
      /* never fail host activation */
    }
  }
}
