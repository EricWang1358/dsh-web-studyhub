import { ui, uiFormat } from "../i18n.js";
import React from "react";
import { Button, SegmentedControl } from "../components/index.js";
import { useInjectCss } from "../shared.js";
import { useStudy } from "../study-context.jsx";
import { RubricResult } from "../CaseResult.jsx";
import css from "../voice/voice.css";

/* The correction of an AI-graded answer (#1031), in one component wherever it shows: under the question on screen, in 本轮题目's 待看订正 and in the
   practice header's list. It never changes the marks: how the learner's keywords become one explanation, the professional way to say what they said,
   the links they left out. `onAck` (a miss graded after the learner had left it): 我看懂了 · 加入重练 queues its retry. `onAdjust(grade)`: the learner
   changes an AI grade once it is in (review.grade.adjust keeps the original). `withRubric`: also draws the criteria (a plain open question or a flashcard,
   whose page has no rubric panel of its own). */
export default function CorrectionCard({ feedback, onAck, onAdjust, withRubric = false }) {
  useInjectCss(css, "study-voice");
  const { busy } = useStudy();
  if (!feedback) return null;
  const correction = feedback.correction, upgrade = correction?.phrasingUpgrade;
  if (!correction && !(withRubric && feedback.rubric) && !onAdjust) return null;
  const grades = [0, 1, 2, 3, 4, 5].map((grade) => ({ value: String(grade), label: String(grade) }));
  return (
    <section className="correction-card" aria-label={ui("订正")}>
      {withRubric && feedback.rubric && <RubricResult rubric={feedback.rubric} compact />}
      {correction?.fragmentsOnly && <p>{ui("只说出了关键词，没有讲清它们之间的机制，所以这次最多 2 分。")}</p>}
      {correction?.keywordExpansion && <><h4>{ui("把关键词连成一句解释")}</h4><p>{correction.keywordExpansion}</p></>}
      {upgrade?.professional && <div className="correction-card__upgrade">
        <h4>{ui("更专业的说法")}</h4>
        {upgrade.informal && <span className="correction-card__from">{upgrade.informal}</span>}
        <span>{upgrade.professional}</span>
      </div>}
      {correction?.missingLinks?.length > 0 && <><h4>{ui("漏掉的环节")}</h4><ul>{correction.missingLinks.map((link, index) => <li key={index}>{link}</li>)}</ul></>}
      {onAdjust && Number.isInteger(feedback.grade) && <div className="correction-card__adjust">
        <SegmentedControl size="sm" label={ui("改分")} value={String(feedback.grade)} options={grades} disabled={busy} onChange={(value) => onAdjust(Number(value))} />
        <small className="muted">{Number.isInteger(feedback.gradeOriginal) && feedback.gradeOriginal !== feedback.grade
          ? uiFormat("AI 原来给的是 {0} 分，已按你改的重新排复习", [feedback.gradeOriginal]) : ui("觉得 AI 判得不对，可以改分；复习间隔跟着改")}</small>
      </div>}
      {onAck && <Button variant="primary" size="sm" className="correction-card__ack" lock={busy} onClick={onAck}>{ui("我看懂了 · 加入重练")}</Button>}
    </section>
  );
}
