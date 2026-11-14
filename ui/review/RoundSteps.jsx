import { ui, uiFormat } from "../i18n.js";
import React from "react";
import { InlineConfirm } from "../components/index.js";
import { questionSourceOpener } from "./QuestionSourcePage.jsx";
import { pendingCount, skipTarget } from "./session-logic.js";

/* The round's own steps under a question (#1008), for QuestionRun: 先跳过 and 到此为止 (never in an exam, which has its own rules), and the keys of the
   question's own actions (N 写笔记, F 标为重点, O the page it comes from), which the session's one key handler (useReviewSession) runs. The rules are in
   session-logic.js (skipTarget, pendingCount); the steps are the session's (skipQuestion, askEnd, endRound). */

/**
 * `{ onSkip, onEnd }` for the toolbar's 更多 and the 「N 题待答」 list: undefined where the step is not there. Also hands the session the actions the
 * N / F / O keys run while this question is on screen. `toggleFocus` and `onNote` are QuestionRun's own.
 */
export function useRoundSteps({ session, run, sources, openModal, onNote, toggleFocus, voiceKeys = {}, focusCloze }) {
  const steps = run.mode !== "exam";
  const openSource = questionSourceOpener(run, sources, openModal);
  const keys = session.questionKeys;
  React.useEffect(() => {
    if (!keys) return undefined;
    keys.current = {
      ...(steps ? { note: onNote, focus: toggleFocus, source: openSource || undefined, ...voiceKeys } : {}),
      ...(focusCloze ? { "focus-cloze": focusCloze } : {}),
    };
    return () => { keys.current = {}; };
  });
  return {
    onSkip: steps && skipTarget(run) !== null ? session.actions.skipQuestion : undefined,
    onEnd: steps ? session.actions.askEnd : undefined,
  };
}

/** The one question 到此为止 asks, under the toolbar, whoever asked it (更多, the column of ticks, the 「N 题待答」 list). */
export function RoundEndConfirm({ session }) {
  const { run, actions } = session;
  if (!session.endAsked || run.mode === "exam" || run.complete) return null;
  const left = pendingCount(run);
  return (
    <InlineConfirm tone="warning" className="round-end-confirm" title={ui("这一轮到此为止？")}
      confirmLabel={ui("到此为止，看结果")} cancelLabel={ui("接着做")} onConfirm={actions.endRound} onCancel={actions.cancelEnd}>
      {left > 0 ? uiFormat("还有 {0} 题没答，没答的不记录、不改复习进度；已答的照常计分。", [left]) : ui("已答的题照常计分。")}
    </InlineConfirm>
  );
}
