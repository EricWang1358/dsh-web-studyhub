import React from "react";
import { ui, uiFormat } from "../i18n.js";
import { Badge, Button, Tooltip } from "../components/index.js";
import { useStudy } from "../study-context.jsx";

/** Answer-safe page/slide/section badge in `.question-meta`; opens the material reader on click. */
export default function QuestionSourcePage({ run, sources }) {
  const { openModal } = useStudy();
  if (run?.mode === "exam" || !Number.isInteger(run?.cardSource?.page)) return null;
  const pageLabel = run.cardSource.unit === "slide" ? uiFormat("第 {0} 张", [run.cardSource.page])
    : run.cardSource.unit === "part" ? uiFormat("第 {0} 节", [run.cardSource.page])
    : uiFormat("第 {0} 页", [run.cardSource.page]);
  const sourceObj = sources?.find((item) => item.id === run.cardSource.sourceId)
    || sources?.find((item) => item.id === run.cardSource.documentSourceId);
  if (!sourceObj) return <Badge size="sm" className="origin-note">{pageLabel}</Badge>;
  const tip = run.cardSource.title
    ? uiFormat("出自「{0}」{1} · 点此打开阅读器按页做题", [run.cardSource.title, pageLabel])
    : ui("点此打开阅读器按页做题");
  return (
    <Tooltip layer content={tip}>
      <Button variant="quiet" size="sm" className="question-meta__action question-source-page"
        onClick={() => openModal({ type: "source", source: sourceObj, pickPages: !run.reading, back: true })}>
        {pageLabel}
      </Button>
    </Tooltip>
  );
}
