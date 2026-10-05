import React from "react";
import { ui, uiFormat } from "./i18n.js";
import { TokenEstimate } from "./TokenUsage.jsx";
import { Badge, Button, Field, NumberInput } from "./components/index.js";
import { isActiveJob } from "./job-visibility.js";
import { useInjectCss } from "./shared.js";
import { useStudy } from "./study-context.jsx";
import { gateTitle } from "./ModelSetupGate.jsx";
import css from "./draft-shortfall.css";
import { canContinueDraft, draftWork, draftWorkLabel, missingQuestions, omissionTitle, reasonLabel, shortfall } from "./draft-shortfall.js";
import { extraQuestionDefault } from "../lib/draft-continuation.js";
import { formatClauses, META_DOT } from './format.js';

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
  // While something works on the draft this is a status, not a button that cannot be pressed.
  if (work) return <div className={"draft-topup " + className} data-draft-topup>
    <Badge tone="info" dot data-draft-work>{draftWorkLabel(work, draft)}</Badge>
  </div>;
  return <div className={"draft-topup " + className} data-draft-topup>
    <Button disabled={blocked}
      title={work ? undefined : !modelReady ? gateTitle("block") : ui("用原资料补齐题目，保留已有草稿")}
      onClick={() => onContinue?.(draft)}>
      {work ? draftWorkLabel(work, draft) : uiFormat("继续补齐 {0} 题", [missing])}
    </Button>
    {!work && modelReady && call && <TokenEstimate enabled request={{ feature: "generate", resumeDraftId: draft.id, draftVersion: draft.draftVersion }} />}
  </div>;
}

/**
 * 用未覆盖的资料补题: add questions to THIS deck, from the sources it has not cited. It says which deck and how many up front, follows the
 * deck's own settings, and is off while that deck has a fill or generation running. Starting a separate new deck from those sources is the
 * other, explicit choice (`onNewDeck`).
 */
export function DraftAddFromSources({ draft, jobs = [], sourceIds, pages = false, held = false, modelReady = true, onAdd, onNewDeck }) {
  useInjectCss(css, "study-draft-shortfall");
  // The service state is read here, not handed down: `held` is only what this draft page knows (unsaved edits, a newer version in the background).
  const { busy: serviceBusy, call } = useStudy();
  const busy = serviceBusy || held;
  const [chosen, setChosen] = React.useState(null);
  const fallback = extraQuestionDefault(draft, sourceIds.length), value = chosen ?? fallback;
  const valid = Number.isInteger(value) && value >= 1 && value <= 30;
  const work = draftWork(draft, jobs) || (() => {
    // A fill that is publishing straight into the deck this draft merges into also owns it.
    const job = draft.mergeTargetId && jobs.find((item) => item.mergeTargetId === draft.mergeTargetId && isActiveJob(item));
    return job ? { kind: "topup", job } : null;
  })();
  const blocked = busy || !!work || !modelReady || !valid;
  return <div className="draft-addfrom" data-add-from-sources>
    <p className="draft-addfrom__target">{pages
      ? uiFormat("为「{0}」补题：用 {1} 页未覆盖资料，追加约 {2} 题", [draft.title, sourceIds.length, value])
      : uiFormat("为「{0}」补题：用 {1} 份未覆盖资料，追加约 {2} 题", [draft.title, sourceIds.length, value])}</p>
    <div className="draft-addfrom__row">
      <Field label={ui("追加题数")} inline width="sm">
        <NumberInput min="1" max="30" step="1" value={value} disabled={!!work} onChange={(event) => setChosen(event.target.value === "" ? NaN : Number(event.target.value))} />
      </Field>
      <Button size="sm" className="draft-addfrom__button" disabled={blocked}
        title={!modelReady ? gateTitle("block") : undefined}
        onClick={() => onAdd?.(draft, sourceIds, value)}>
        {work ? draftWorkLabel(work, draft) : uiFormat("给「{0}」补 {1} 题 →", [draft.title, value])}
      </Button>
      <Button size="sm" variant="link" disabled={busy || !!work} onClick={() => onNewDeck?.(sourceIds)}>{ui("用这些资料新建题组")}</Button>
    </div>
    {!work && modelReady && call && valid && <TokenEstimate enabled request={{ feature: "generate", resumeDraftId: draft.id, draftVersion: draft.draftVersion, extraSourceIds: sourceIds, count: value }} />}
  </div>;
}

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
        <span className="omitted-questions__why">{formatClauses(item.codes.map((code) => reasonLabel(code)))}</span>{" "}
        {item.note && <span className="omitted-questions__note muted">{uiFormat("审阅意见：{0}", [item.note])}</span>}
      </li>)}
    </ul>
  </details>;
}
