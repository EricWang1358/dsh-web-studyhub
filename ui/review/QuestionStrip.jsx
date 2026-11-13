import React from "react";
import { ui } from "../i18n.js";
import Markdown from "../Markdown.jsx";
import { useInjectCss } from "../shared.js";
import { usePersistentState } from "../storage.js";
import { stripOf } from "./question-strip.js";
import css from "./source-split.css";

/* 题干条 (#1012): the question a narrow reader was opened from, kept at the top of the reader (where its quote sits), so the material is read with the stem
   and the options in view. Folded to one line of the stem with one click; open or folded is remembered for the next time (a per-viewer convenience).
   Only what the question shows before an answer (ui/review/question-strip.js stripOf): nothing here tells which option is right. */
export default function QuestionStrip({ card }) {
  useInjectCss(css, "study-source-split");
  const [open, setOpen] = usePersistentState("study-question-strip", true);
  const strip = React.useMemo(() => stripOf(card), [card]);
  if (!strip?.stem) return null;
  return (
    <details className="question-strip" data-question-strip="" open={!!open} onToggle={(event) => { if (event.currentTarget.open !== !!open) setOpen(event.currentTarget.open); }}>
      <summary className="question-strip__summary">
        <span className="question-strip__label">{ui("本题")}</span>
        <Markdown className="md-compact question-strip__stem" links={false} text={strip.stem} />
      </summary>
      {strip.options.length > 0 && (
        <ul className="question-strip__options" aria-label={ui("选项")}>
          {strip.options.map((option) => (
            <li key={option.id} className="question-strip__option">
              <span className="question-strip__mark">{option.mark}</span>
              <Markdown className="md-compact" links={false} text={option.text} />
            </li>
          ))}
        </ul>
      )}
    </details>
  );
}
