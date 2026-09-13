import { useEffect } from "react";

/* Shared UI helpers: one-off stylesheet injection and copy used by several
   views. Kept dependency-free so any view can import it cheaply. */

/* Inject a stylesheet once per document, keyed by marker (e.g. "study-views")
   so repeated mounts — or several views sharing one sheet — never duplicate it. */
export function useInjectCss(css, marker) {
  useEffect(() => {
    if (document.querySelector(`style[data-${marker}]`)) return;
    const el = document.createElement("style");
    el.setAttribute(`data-${marker}`, "");
    el.textContent = css;
    document.head.appendChild(el);
  }, [css, marker]);
}

export const LEVEL_LABEL = {
  mastered: "已掌握",
  familiar: "熟悉",
  learning: "学习中",
  weak: "薄弱",
  new: "未学",
};
export const LEVELS = Object.keys(LEVEL_LABEL);

/* Cloze prompts store raw {{id}} markers; lists show a blank instead. */
export const plainPrompt = (p) =>
  String(p ?? "").replace(/\{\{[^{}]+\}\}/g, "＿＿");
