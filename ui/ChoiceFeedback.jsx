import React from "react";

export default function ChoiceFeedback({ options, feedback, solution, multiple }) {
  if (!feedback || !solution?.options) return null;
  const picked = new Set(feedback.selected || []);
  const correct = new Set(solution.options.filter((o) => o.correct).map((o) => o.id));
  const letters = (matches) => options.flatMap((o, i) => matches(o.id) ? [String.fromCharCode(65 + i)] : []).join("");
  const yours = letters((id) => picked.has(id));
  const expected = letters((id) => correct.has(id));
  // 漏选/错选 only make sense when several options can be right.
  const missed = multiple ? letters((id) => correct.has(id) && !picked.has(id)) : "";
  const extra = multiple ? letters((id) => picked.has(id) && !correct.has(id)) : "";
  return <div className="choice-feedback" role="status">
    <span>你的答案：<strong>{yours || "未选择"}</strong></span>
    <span>正确答案：<strong>{expected}</strong></span>
    {missed && <span className="choice-mismatch">漏选：<strong>{missed}</strong></span>}
    {extra && <span className="choice-mismatch">错选：<strong>{extra}</strong></span>}
  </div>;
}
