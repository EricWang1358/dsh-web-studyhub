import React from "react";
import App from "./App.jsx";
import css from "./style.css";
import { createStudyCall } from "./transport.js";
export const inject = ["slots", "locale"];
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
    return <App key={props.sessionId || "empty"} call={call} />;
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
        Seat,
      ),
    );
    return () => {
      body?.();
      dispose?.();
    };
  });
}
