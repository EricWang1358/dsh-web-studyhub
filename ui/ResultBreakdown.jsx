import { ui, uiFormat } from "./i18n.js";
import React from "react";
import css from "./review-results.css";
import { useInjectCss } from "./shared.js";

// The service supplies these counts. This component only turns them into a visual.
export default function ResultBreakdown({ total, answered, correct, correctLabel = ui("掌握") }) {
  useInjectCss(css, "review-results");
  const remaining = Math.max(0, total - answered);
  const practice = Math.max(0, answered - correct);
  const segments = [
    { key: "correct", label: correctLabel, count: correct },
    { key: "practice", label: ui("需要巩固"), count: practice },
    { key: "remaining", label: ui("未答"), count: remaining },
  ];
  return (
    <div className="result-breakdown" aria-label={uiFormat("{0} 题：{1} {2}，需要巩固 {3}，未答 {4}", [total, correctLabel, correct, practice, remaining])}>
      <div className="result-breakdown-track" role="img" aria-label={uiFormat("{0} {1} 题，需要巩固 {2} 题，未答 {3} 题", [correctLabel, correct, practice, remaining])}>
        {segments.filter((segment) => segment.count > 0).map((segment) => (
          <span key={segment.key} className={`result-segment result-segment-${segment.key}`}
            style={{ flexGrow: segment.count }} />
        ))}
      </div>
      <div className="result-breakdown-legend">
        {segments.map((segment) => (
          <div key={segment.key} className="result-legend-item">
            <span className={`result-legend-dot result-segment-${segment.key}`} aria-hidden="true" />
            <span>{segment.label}</span>
            <strong>{segment.count}</strong>
          </div>
        ))}
      </div>
    </div>
  );
}
