import React from "react";
import { ui, uiFormat } from "./i18n.js";
import { useInjectCss } from "./shared.js";
import css from "./draft-shortfall.css";
import { omissionTitle, reasonLabel, shortfall } from "./draft-shortfall.js";
import { formatClauses, META_DOT } from './format.js';

/* Why a draft came out with fewer questions than were asked for, and which ones were dropped, in the same words on the draft page and the job card.
   The one button that fills what is missing is not here: it is 为没覆盖的部分补题 (ui/coverage/CoverageTopUp.jsx), asked for the sections with no question. */

/** Why the draft has fewer questions than were asked for, in counts per reason. */
export function ShortfallReasons({ draft, compact = false }) {
  useInjectCss(css, "study-draft-shortfall");
  const found = shortfall(draft);
  if (!found.missing) return null;
  const shown = compact ? found.reasons.slice(0, 4) : found.reasons;
  return <div className="shortfall" data-shortfall>
    {draft.editorial?.fillRoundsUsed > 0 && <p className="shortfall__line" data-fill-rounds>{uiFormat("已自动补题 {0} 轮，仍差 {1} 题；原因如下。", [draft.editorial.fillRoundsUsed, found.missing])}</p>}
    {found.report && <>
      <p className="shortfall__line" data-part-report>{found.report.lead}</p>
      {found.report.reasons.length > 0 && <ul className="shortfall__reasons">{found.report.reasons.map((text) => <li key={text}>{text}</li>)}</ul>}
      {found.report.repaired && <small className="muted">{found.report.repaired}</small>}
    </>}
    {found.reasons.length > 0 && <>
      <p className="shortfall__lead">{ui("没进入草稿的题，原因：")}</p>
      <ul className="shortfall__reasons">
        {shown.map((reason) => <li key={reason.code}>{reason.label}<small>{META_DOT}{uiFormat("{0} 题", [reason.count])}</small></li>)}
      </ul>
      {compact && found.reasons.length > shown.length && <small className="muted">{uiFormat("还有 {0} 类原因，打开草稿查看。", [found.reasons.length - shown.length])}</small>}
      {!compact && <small className="muted">{ui("一道题可能同时有几个原因。逐题的说明在下面的「没进入草稿的题」里。")}</small>}
    </>}
    {found.duplicates > 0 && <p className="shortfall__line">{uiFormat("{0} 道题与已有的题考点重复，已略过。", [found.duplicates])}</p>}
    {found.partFailures.map((failure) => <p className="shortfall__line" key={failure.part}>
      {uiFormat("第 {0} 批没有完成：{1}", [failure.part, failure.sentence])}</p>)}
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
        <span className="omitted-questions__why">{formatClauses(item.codes.map((code) => reasonLabel(code)))}</span>{" "}
        {item.note && <span className="omitted-questions__note muted">{uiFormat("审阅意见：{0}", [item.note])}</span>}
      </li>)}
    </ul>
  </details>;
}
