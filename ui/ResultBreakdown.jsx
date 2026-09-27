import React from "react";
import css from "./review-results.css";
import { useInjectCss } from "./shared.js";

// The service supplies these counts. This component only turns them into a visual.
export default function ResultBreakdown({ total, answered, correct, correctLabel = "掌握" }) {
  useInjectCss(css, "review-results");
  const remaining = Math.max(0, total - answered);
  const practice = Math.max(0, answered - correct);
  const segments = [
    { key: "correct", label: correctLabel, count: correct },
    { key: "practice", label: "需要巩固", count: practice },
    { key: "remaining", label: "未答", count: remaining },
  ];
  return (
    <div className="result-breakdown" aria-label={`${total} 题：${correctLabel} ${correct}，需要巩固 ${practice}，未答 ${remaining}`}>
      <div className="result-breakdown-track" role="img" aria-label={`${correctLabel} ${correct} 题，需要巩固 ${practice} 题，未答 ${remaining} 题`}>
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
