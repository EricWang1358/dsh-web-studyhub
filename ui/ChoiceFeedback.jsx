import { ui } from "./i18n.js";
import React from "react";
import { Icon } from "./components/index.js";
import { fixedOptionLabel, optionMark } from "./option-label.js";

const ChoiceFeedback = React.forwardRef(function ChoiceFeedback({ card, options, feedback, solution, multiple, passed, live = false, tabIndex = -1 }, ref) {
  if (!feedback || !solution?.options) return null;
  const picked = new Set(feedback.selected || []);
  const correct = new Set(solution.options.filter((o) => o.correct).map((o) => o.id));
  const isPassed = typeof passed === "boolean"
    ? passed
    : typeof feedback.correct === "boolean"
      ? feedback.correct
      : correct.size > 0 && picked.size === correct.size && [...correct].every((id) => picked.has(id));
  // A 判断题 answers in words (对 / 错), every other choice in letters.
  const letters = (matches) => options.flatMap((o, i) => matches(o.id) ? [fixedOptionLabel(card, o) ?? optionMark(card, o, i)] : []).join("");
  const yours = letters((id) => picked.has(id));
  const expected = letters((id) => correct.has(id));
  // 漏选/错选 only make sense when several options can be right.
  const missed = multiple ? letters((id) => correct.has(id) && !picked.has(id)) : "";
  const extra = multiple ? letters((id) => picked.has(id) && !correct.has(id)) : "";
  return <div className="choice-feedback-wrap"><div ref={ref} className="choice-feedback" tabIndex={tabIndex} role={live ? "status" : undefined}>
    <span className={"choice-feedback__verdict " + (isPassed ? "choice-feedback__verdict--ok" : "choice-feedback__verdict--bad")} data-passed={isPassed ? "true" : "false"}>
      <Icon name={isPassed ? "check" : "close"} className="sh-icon--inline choice-feedback__mark" />
      {ui(isPassed ? "答对了" : "答错了")}
    </span>
    <span>{ui("你的答案：")}<strong>{yours || ui("未选择")}</strong></span>
    <span>{ui("正确答案：")}<strong>{expected}</strong></span>
    {missed && <span className="choice-mismatch">{ui("漏选：")}<strong>{missed}</strong></span>}
    {extra && <span className="choice-mismatch">{ui("错选：")}<strong>{extra}</strong></span>}
  </div></div>;
});

export default ChoiceFeedback;
