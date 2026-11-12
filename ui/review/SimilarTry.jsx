import React, { useState } from "react";
import { ui } from "../i18n.js";
import { Button, InlineMessage, Spinner, Tooltip } from "../components/index.js";
import ModelSetupGate from "../ModelSetupGate.jsx";
import { useStudy } from "../study-context.jsx";
import { reviewEntryKey } from "../async.js";
import { useInjectCss } from "../shared.js";
import css from "./learning-loop.css";

/* 试一道同类题 (#1015): after a wrong answer, one press finds a similar question that already exists (the wrong book's finder, review.similar, no model) and
   practises it as a detour of its own (the prerequisites' way: a one-question round with returnTo, whose result page offers 回到原题 as its main button), so
   the round here is not touched: nothing is added to 待答 and 到此为止 still ends this round only. With nothing found it offers 生成一道变式: the background
   assistant's 出题 (derive, standalone) behind the model gate, one model call, the new question in the same deck; once written, one press practises it the
   same way. Shown under the explanation (ui/review/LearningActions.jsx) and on the finished 逐步理解 panel. */

/** Whether the question on screen was answered wrong (a choice, a grade under 3). */
export const answeredWrong = (run) => !!run?.feedback && (run.feedback.correct === false || run.feedback.grade < 3);

/** The derive tasks this component started, by the question they were asked for (kept while the page is open). */
const asked = new Set();

/** session: useReviewSession(); data: the snapshot (assist tasks); model: modelReadiness(data); onModelSettings: the way to the model settings. */
export default function SimilarTry({ session, data, model, onModelSettings }) {
  useInjectCss(css, "study-learning-loop");
  const { call, busy } = useStudy();
  const { run, actions } = session;
  const key = reviewEntryKey(run);
  const [state, setState] = useState({ key: "", kind: "idle", message: "" });
  const here = state.key === key ? state : { kind: "idle", message: "" };
  if (!answeredWrong(run) || run.mode === "exam" || run.returnTo) return null;
  const origin = { deckId: run.deckId, cardId: run.card.id };
  const detour = (cardId, deckId = run.deckId) => actions.studyPrerequisites([{ deckId, cardId }], { similarFor: origin });
  // The variant this question asked for: the latest standalone 出题 of this card started from here.
  const variant = asked.has(key) ? (data?.assist || []).filter((task) => task.cardId === run.card.id && task.mode === "derive" && task.relation === "standalone").at(-1) : null;

  async function find() {
    setState({ key, kind: "finding", message: "" });
    try {
      const { item } = await call("review.similar", { runId: run.id, cardId: run.card.id });
      if (item) { setState({ key, kind: "idle", message: "" }); await detour(item.cardId, item.deckId); }
      else setState({ key, kind: "none", message: "" });
    } catch (failure) {
      setState({ key, kind: "failed", message: failure?.message || ui("没能查找同类题，可以再试一次。") });
    }
  }
  async function generate() {
    if (!model?.ready) { setState({ key, kind: "gate", message: "" }); return; }
    asked.add(key);
    const sent = await actions.assistCard("derive", ui("出一道和这道题考同一知识点的变式题：换一个情境或数字，不要照抄原题。"), [], { relation: "standalone" });
    if (!sent) asked.delete(key);
    setState({ key, kind: "none", message: "" });
  }

  const tryButton = (
    <Tooltip layer content={ui("从题库里找一道考同一知识点、这一轮没出现过的题，不消耗模型。做完点「回到原题」回到这里。")}>
      <Button size="sm" variant="secondary" icon="play" className="similar-try__go" data-usage="review.similar" lock={busy} busy={here.kind === "finding"} onClick={find}>
        {ui("试一道同类题")}</Button>
    </Tooltip>
  );
  return (
    <div className="similar-try">
      {variant?.status === "done" && variant.resultCardId
        ? <Button size="sm" variant="primary" icon="play" className="similar-try__go" lock={busy} onClick={() => detour(variant.resultCardId)}>{ui("做这道变式题")}</Button>
        : tryButton}
      {variant?.status === "running" && <span className="similar-try__note" role="status"><Spinner size="sm" />{ui("正在出一道变式题，写好后这里会出现「做这道变式题」。")}</span>}
      {here.kind === "none" && !variant && (
        <span className="similar-try__note" role="status">
          {ui("题库里没有这一轮之外的同类题。")}{" "}
          <Tooltip layer content={ui("后台助教按这道题的知识点出一道新题，放进同一题组：约 1 次模型调用。")}>
            <Button variant="link" size="sm" icon="sparkle" data-usage="review.similar-variant" lock={busy} onClick={generate}>{ui("生成一道变式")}</Button>
          </Tooltip>
        </span>
      )}
      {here.kind === "gate" && !model?.ready && <ModelSetupGate variant="inline" feature="generate" model={model} onOpenSettings={onModelSettings} />}
      {here.kind === "failed" && <InlineMessage tone="error" className="similar-try__note" action={{ label: ui("再试一次"), onClick: find }}>{here.message}</InlineMessage>}
    </div>
  );
}
