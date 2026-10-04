import React from "react";
import { ui, uiFormat, getUiLanguage } from "./i18n.js";
import { TokenEstimate } from "./TokenUsage.jsx";
import { useInjectCss } from "./shared.js";
import { gateTitle } from "./ModelSetupGate.jsx";
import css from "./draft-shortfall.css";
import { canContinueDraft, draftWork, draftWorkLabel, missingQuestions, omissionTitle, reasonLabel, shortfall } from "./draft-shortfall.js";

/* The two pieces every place that shows a short draft uses, so the same thing
   reads and acts the same way on the home card, the job card and the draft
   page: why questions are missing, and the one button that fills them. */

/**
 * The one 补题 action. It generates only what is missing, from the draft's own
 * materials, keeps the questions already approved and says up front what that
 * is expected to use. While something works on the draft the button says what
 * (a top-up, the run that is still writing it, a publication check, a repair)
 * and stays out of the way.
 */
export function DraftTopUp({ draft, jobs = [], busy = false, modelReady = true, call, onContinue, className = "" }) {
  useInjectCss(css, "study-draft-shortfall");
  const missing = missingQuestions(draft), work = draftWork(draft, jobs);
  if (!work && !canContinueDraft(draft)) return null;
  const blocked = busy || !!work || !modelReady;
  return <div className={"draft-topup " + className} data-draft-topup>
    <button type="button" disabled={blocked}
      title={work ? undefined : !modelReady ? gateTitle("block") : ui("用原资料补齐题目，保留已有草稿")}
      onClick={() => onContinue?.(draft)}>
      {work ? draftWorkLabel(work, draft) : uiFormat("继续补齐 {0} 题", [missing])}
    </button>
    {!work && modelReady && call && <TokenEstimate call={call} enabled request={{ feature: "generate", resumeDraftId: draft.id, draftVersion: draft.draftVersion }} />}
  </div>;
}

/** Why the draft has fewer questions than were asked for, in counts per reason. */
export function ShortfallReasons({ draft, compact = false }) {
  useInjectCss(css, "study-draft-shortfall");
  const found = shortfall(draft);
  if (!found.missing) return null;
  const shown = compact ? found.reasons.slice(0, 4) : found.reasons;
  return <div className="shortfall" data-shortfall>
    {found.report && <>
      <p className="shortfall__line" data-part-report>{found.report.lead}</p>
      {found.report.reasons.length > 0 && <ul className="shortfall__reasons">{found.report.reasons.map((text) => <li key={text}>{text}</li>)}</ul>}
      {found.report.repaired && <small className="muted">{found.report.repaired}</small>}
    </>}
    {found.reasons.length > 0 && <>
      <p className="shortfall__lead">{ui("没进入草稿的题，原因：")}</p>
      <ul className="shortfall__reasons">
        {shown.map((reason) => <li key={reason.code}>{reason.label}<small>{uiFormat(" · {0} 题", [reason.count])}</small></li>)}
      </ul>
      {compact && found.reasons.length > shown.length && <small className="muted">{uiFormat("还有 {0} 类原因，打开草稿查看。", [found.reasons.length - shown.length])}</small>}
      {!compact && <small className="muted">{ui("一道题可能同时有几个原因。逐题的说明在下面的「没进入草稿的题」里。")}</small>}
    </>}
    {found.duplicates > 0 && <p className="shortfall__line">{uiFormat("{0} 道题与已有的题考点重复，已略过。", [found.duplicates])}</p>}
    {found.partFailures.map((failure) => <p className="shortfall__line" key={failure.part}>
      {uiFormat("第 {0} 批没有完成：{1}", [failure.part, failure.title])}</p>)}
    {!found.report && !found.reasons.length && !found.partFailures.length && !found.duplicates &&
      <p className="shortfall__line muted">{ui("这份草稿生成时没有留下逐题原因；之后补题的记录会显示在这里。")}</p>}
  </div>;
}

/** The dropped questions one by one: what was asked and why it did not pass. */
export function OmittedQuestions({ draft }) {
  useInjectCss(css, "study-draft-shortfall");
  const { records } = shortfall(draft);
  if (!records.length) return null;
  return <details className="omitted-questions">
    <summary>{uiFormat("没进入草稿的题 · {0}", [records.length])}</summary>
    <ul>
      {records.map((item, index) => <li key={index}>
        <strong>{omissionTitle(item)}</strong>{" "}
        <span className="omitted-questions__why">{item.codes.map((code) => reasonLabel(code)).join(getUiLanguage() === "en" ? "; " : "；")}</span>{" "}
        {item.note && <span className="omitted-questions__note muted">{uiFormat("审阅意见：{0}", [item.note])}</span>}
      </li>)}
    </ul>
  </details>;
}
