import React from "react";
import { ui, uiFormat } from "../i18n.js";
import { Badge, Button, Tooltip } from "../components/index.js";
import { useStudy } from "../study-context.jsx";
import { questionPlace } from "./source-dock.js";

/** What the page badge does, for the badge and for the O key (#1008): the reader on the question's page, or null when there is none to open
    (an exam, a question with no page, a material that is gone). */
export function questionSourceOpener(run, sources, openModal) {
  // The question's place (ui/review/source-dock.js): the same one the 对照栏 follows from question to question (#1012).
  const source = questionPlace(run, sources);
  return source ? () => openModal({ type: "source", source, pickPages: !run.reading, back: true }) : null;
}

/** Answer-safe page/slide/section badge in `.question-meta`; opens the material reader on click. */
export default function QuestionSourcePage({ run, sources }) {
  const { openModal } = useStudy();
  if (run?.mode === "exam" || !Number.isInteger(run?.cardSource?.page)) return null;
  const pageLabel = run.cardSource.unit === "slide" ? uiFormat("第 {0} 张", [run.cardSource.page])
    : run.cardSource.unit === "part" ? uiFormat("第 {0} 节", [run.cardSource.page])
    : uiFormat("第 {0} 页", [run.cardSource.page]);
  const open = questionSourceOpener(run, sources, openModal);
  if (!open) return <Badge size="sm" className="origin-note">{pageLabel}</Badge>;
  const tip = run.cardSource.title
    ? uiFormat("出自「{0}」{1} · 点此打开阅读器按页做题", [run.cardSource.title, pageLabel])
    : ui("点此打开阅读器按页做题");
  return (
    <Tooltip layer content={tip}>
      <Button variant="quiet" size="sm" className="question-meta__action question-source-page" aria-keyshortcuts="O" onClick={open}>
        {pageLabel}
      </Button>
    </Tooltip>
  );
}
