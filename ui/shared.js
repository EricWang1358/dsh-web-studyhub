import { uiLabels } from "./i18n.js";
import { useComponentCss } from "./components/css.js";
import { CARD_KIND_LIST } from "../lib/card-kinds.js";

/* Shared UI helpers: one-off stylesheet injection and copy used by several
   views. Kept dependency-free so any view can import it cheaply. */

/* Inject a stylesheet once per document, keyed by marker (e.g. "study-views") so repeated mounts — or several views sharing one
   sheet — never duplicate it. The one injection hook is useComponentCss (ui/components/css.js: useInsertionEffect, so a view is
   styled on its first frame); this name stays for the many call sites. Cascade layers (@layer study.*) make the order in which
   views mount irrelevant. */
export const useInjectCss = useComponentCss;

export const LEVEL_LABEL = uiLabels({
  mastered: "已掌握",
  familiar: "熟悉",
  learning: "学习中",
  weak: "薄弱",
  new: "未学",
});
export const LEVELS = Object.keys(LEVEL_LABEL);

/** The name of each question kind, by id (lib/card-kinds.js). */
export const kinds = uiLabels(Object.fromEntries(CARD_KIND_LIST.map((kind) => [kind.id, kind.label])));

/* Cloze prompts store raw {{id}} markers; lists show a blank instead. */
export const plainPrompt = (p) =>
  String(p ?? "").replace(/\{\{[^{}]+\}\}/g, "＿＿");
