import React from "react";
import { ui, uiFormat } from "../i18n.js";
import { Button, LoadingState } from "../components/index.js";
import { useInjectCss } from "../shared.js";
import { useStudy } from "../study-context.jsx";
import QuestionRun from "./QuestionRun.jsx";
import { MasteryMark } from "../document-preview/practice/MasteryMark.jsx";
import css from "./inline-run.css";

/* InlineRun: one open round answered beside something else, in a column: the reader's 本节题目 (#1013) and the side-by-side column of #1012. It is the
   practice page's own question body (QuestionRun: the same grading, keys, hints, explanation and background assistant) under a one-line head with the way
   back, and a short result when the round is done. Nothing here grades or schedules: every step is the embedder's session (useReviewSession({ embeddedIn }))
   and its review.* operations, so an answer here is the same record as one on the practice page.

   Props: session (with an open run, or none yet while it starts), data (the library snapshot), label (what is being practised: 本节 · 3 题), rootRef (the
   session's root: its keys work while the focus is inside), onClose() (back to what the column showed before; the round stays open), onOpenRun() (the same
   round on the practice page), links / feedback (as QuestionRun's). The column is a size container named `study`, so the question takes the narrow layout of
   the practice page whatever the window's width (ui/review/question.css). */

/** How the round went: the questions answered (a re-ask is not another question) and how many of them were right. */
export function roundTally(run) {
  const stops = (run?.navigation || []).filter((stop) => !stop.retry && stop.answered);
  return { answered: stops.length, passed: stops.filter((stop) => stop.passed).length };
}

function InlineRunDone({ session, onClose, onOpenRun, onBackOriginal, backLabel }) {
  const { busy } = useStudy();
  const run = session.run, { answered, passed } = roundTally(run);
  const mastery = run.mastery || run.liveMastery;
  const before = mastery?.before, after = mastery?.after;
  const weak = answered > passed && session.coach?.onReviewWeak;
  const canReturn = Boolean(onBackOriginal);
  return (
    <div className="inline-run__done" role="status" data-testid="inline-run-done">
      <p className="inline-run__score"><strong>{ui("这一轮做完了")}</strong><span>{uiFormat("答对 {0} / {1}", [passed, answered])}</span></p>
      {before?.total > 0 && after?.total > 0 && <p className="inline-run__mastery"><MasteryMark summary={after} size={14} />
        <span>{after.percent !== before.percent ? uiFormat("本组 {0}% → {1}%", [before.percent, after.percent]) : uiFormat("本组 {0}%", [after.percent])}</span></p>}
      <div className="inline-run__done-actions">
        {canReturn && <Button variant="primary" size="sm" icon="arrow-left" lock={busy} onClick={onBackOriginal}>{ui("回到原题")}</Button>}
        <Button variant={canReturn ? "secondary" : "primary"} size="sm" icon="arrow-left" onClick={onClose}>{backLabel}</Button>
        {weak && <Button iconEnd="arrow-right" size="sm" lock={busy} onClick={session.coach.onReviewWeak}>{ui("错的再练一遍")}</Button>}
        {onOpenRun && <Button iconEnd="arrow-right" size="sm" variant="quiet" lock={busy} onClick={onOpenRun}>{ui("在练习页看结果")}</Button>}
      </div>
    </div>
  );
}

export default function InlineRun({ session, data, label, rootRef, onClose, onOpenRun, links, feedback, backLabel = ui("回到题目列表") }) {
  useInjectCss(css, "study-inline-run");
  const { busy } = useStudy();
  const run = session.run;
  const displayLabel = run?.returnTo && run?.questions ? uiFormat("支线练习 · {0} 题", [run.questions]) : label;
  const onBackOriginal = run?.returnTo && (session.coach?.onContinue || session.continueTo)
    ? () => (session.coach?.onContinue ? session.coach.onContinue() : session.continueTo?.(null))
    : undefined;
  // The keys of the question work at once: the focus goes into the column when a round (or another round) opens, without moving any scroll.
  React.useEffect(() => { if (run?.id) rootRef?.current?.focus?.({ preventScroll: true }); }, [run?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <section ref={rootRef} className="inline-run" data-inline-run="" tabIndex={-1} aria-label={displayLabel || ui("本节题目")}>
      <header className="inline-run__head">
        <span className="inline-run__label">{displayLabel}</span>
        <span className="inline-run__actions">
          {onOpenRun && run && !run.complete && <Button iconEnd="arrow-right" size="sm" variant="quiet" lock={busy} onClick={onOpenRun}>{ui("去练习页继续")}</Button>}
          <Button size="sm" variant="secondary" icon="arrow-left" onClick={onClose}>{backLabel}</Button>
        </span>
      </header>
      {!run ? <LoadingState label={ui("正在打开这一轮…")} />
        : run.complete ? <InlineRunDone session={session} onClose={onClose} onOpenRun={onOpenRun} onBackOriginal={onBackOriginal} backLabel={backLabel} />
          : <QuestionRun inline session={session} data={data} coachProps={data ? session.coach : undefined} links={links} feedback={feedback} />}
    </section>
  );
}
