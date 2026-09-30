import { useEffect } from "react";
import { uiLabels } from "./i18n.js";

/* Shared UI helpers: one-off stylesheet injection and copy used by several
   views. Kept dependency-free so any view can import it cheaply. */

/* Inject a stylesheet once per document, keyed by marker (e.g. "study-views")
   so repeated mounts — or several views sharing one sheet — never duplicate it. */
export function useInjectCss(css, marker) {
  useEffect(() => {
    const existing = document.querySelector(`style[data-${marker}]`);
    if (existing) {
      if (existing.textContent !== css) existing.textContent = css;
      return;
    }
    const el = document.createElement("style");
    el.setAttribute(`data-${marker}`, "");
    el.textContent = css;
    document.head.appendChild(el);
  }, [css, marker]);
}

export const LEVEL_LABEL = uiLabels({
  mastered: "已掌握",
  familiar: "熟悉",
  learning: "学习中",
  weak: "薄弱",
  new: "未学",
});
export const LEVELS = Object.keys(LEVEL_LABEL);

export const kinds = uiLabels({
  quiz: "单选测验",
  multi: "多选测验",
  flashcard: "闪卡",
  open: "开放问答",
  cloze: "填空卡",
});

/* Cloze prompts store raw {{id}} markers; lists show a blank instead. */
export const plainPrompt = (p) =>
  String(p ?? "").replace(/\{\{[^{}]+\}\}/g, "＿＿");
