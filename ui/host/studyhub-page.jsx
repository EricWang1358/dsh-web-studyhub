import React from "react";
import { ui } from "../i18n.js";

/** The StudyHub mark for DSH's own sidebar, where the study tokens are absent. */
export function StudyHubGlyph({ size = 16 }) {
  return (
    <svg viewBox="0 0 32 32" width={size} height={size} fill="none" strokeLinecap="round" strokeLinejoin="round"
      aria-hidden="true" focusable="false">
      <rect x="7" y="4" width="20" height="24" rx="2.5" stroke="currentColor" strokeWidth="2" />
      <path d="M4.5 9h4.5M4.5 16h4.5M4.5 23h4.5" stroke="currentColor" strokeWidth="2" />
      <path d="M15.5 10h7.5M15.5 14h5" stroke="currentColor" strokeWidth="1.6" opacity="0.7" />
      <path d="m15.5 20.5 2.4 2.4 4.9-5.4" style={{ stroke: "var(--accent-soft, #c93d22)" }} strokeWidth="2.2" />
    </svg>
  );
}

/** The appearance App would pick (its stored choice, `auto` following the OS). */
function studyTheme() {
  let stored = "auto";
  try { stored = localStorage.getItem("study-theme") || "auto"; } catch { /* storage blocked */ }
  if (stored === "dark" || stored === "light") return stored;
  return typeof matchMedia === "function" && matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
}

/** The page before DSH has selected any session: the library lives in a session's workspace. */
export function NoSessionNotice({ onStart }) {
  return (
    <div className="study-seat">
      <div className="study-app" data-theme={studyTheme()}>
        <div className="studyhub-page-empty">
          <StudyHubGlyph size={40} />
          <h1>{ui("先打开一个会话")}</h1>
          <p>{ui("StudyHub 的学习库存放在会话的工作区里。新建或打开一个会话后，这里会直接显示你的学习库。")}</p>
          {onStart && <button type="button" onClick={onStart}>{ui("新建会话")}</button>}
        </div>
      </div>
    </div>
  );
}
