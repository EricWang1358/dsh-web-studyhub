import { ui, uiFormat, uiMessage } from "../i18n.js";
import React from "react";
import Markdown from "../Markdown.jsx";
import EnBlock from "../EnBlock.jsx";
import FlipCard from "../FlipCard.jsx";
import SmoothHeight from "../SmoothHeight.jsx";
import ReviewToolbar from "../ReviewToolbar.jsx";
import CitationDisclosure from "../CitationDisclosure.jsx";
import FigurePageLink from "../document-preview/practice/FigurePageLink.jsx";
import ExplanationFollowup from "../ExplanationFollowup.jsx";
import { asksWhatTheSourceSays, SOURCE_VOICE_FIX } from "../../lib/question-voice.js";
import ChoiceFeedback from "../ChoiceFeedback.jsx";
import { fixedOptionLabel, optionMark } from "../option-label.js";
import ThumbFeedback from "../ThumbFeedback.jsx";
import PracticeTip from "./PracticeTip.jsx";
import { usePracticeTip } from "./use-practice-tip.js";
import { voteTipMoments } from "../guidance/practice-tips.js";
import { reviewEntryKey } from "../async.js";
import ModelErrorNote from "../ModelErrorNote.jsx";
import ModelSetupGate from "../ModelSetupGate.jsx";
import LearningActions from "./LearningActions.jsx";
import SimilarTry from "./SimilarTry.jsx";
import { describeModelError, modelReadiness, plainAssistFailure } from "../generation-status.js";
import { readableQualityIssue } from "../quality.js";
import { ReadingBlock, useReadingProps } from "../reading-settings/ReadingSettings.jsx";
import { Banner, Button, Chip, Icon, InlineMessage, Popover, ProgressBar, SegmentedControl, Spinner, Tooltip } from "../components/index.js";
import { useStudy } from "../study-context.jsx";
import { HELP_CHOICES } from "../agent-prompts/card.js";
import { FixPhraseChips, FixPhraseSave, appendFixPhrase } from "./FixPhrases.jsx";
import { useFixPhrases } from "./use-fix-phrases.js";
import { useFlashHead } from "./use-flash-head.js";
import { CourseRuleAdd } from "../course-rules/CourseRuleAdd.jsx";
import { useCourseRules } from "../course-rules/use-course-rules.js";
import { fixSuggestionFor } from "../card-fix.js";
import reviewCss from "./review.css";
import coachCss from "../coach.css";
import { useInjectCss } from "../shared.js";
import { RubricAnswer, ScenarioPanel } from "../CaseWorkspace.jsx";
import TaskCardRun from "../TaskCardRun.jsx";
import { WrongAnswerSource } from "../document-preview/practice/ReadingReturn.jsx";
import { NextDue } from "../NextDue.jsx";
import { formatGap } from "../format.js";
import { roundAt, roundWords } from "./round-words.js";
import { fixedOptionsOf } from "../../lib/card-kinds.js";
import { deferUnstudiedPagesPlan, runDeferUnstudiedPages } from "../document-preview/practice/open-reader-pages.js";
import RoundPending from "./RoundPending.jsx";
import { RoundEndConfirm, useRoundSteps } from "./RoundSteps.jsx";
import { useVoiceAnswer } from "./VoiceAnswer.jsx";
import { formatAssistTaskSummary } from "./assist-summary.js";
import { ClozeQuestion, OpenResponseField, QuestionLiveMastery, QuestionMetaBadges } from "./QuestionParts.jsx";
import { useAssistWatch, useAutopilotPause, useBookQaSync, useCaseHighlights } from "./use-review-run-sync.js";

export { formatAssistTaskSummary };

/* QuestionRun: the question being answered, graded and explained, without the page around it. It is what the practice page
   (ui/Review.jsx) shows under its header and rail, and what any other page can mount to practise in place, with the same
   keyboard, grading, feedback, hints, background assistant and teaching panel, because it is the same component.

   What the embedder provides:
   - the study context (useStudy(): call, act, busy, openModal, openSettings ...), i.e. a <StudyServicesContext.Provider> above it;
   - `session`: the one useReviewSession() value (run, entry, actions ...) with an open run that is not complete. A page other than
     'review' creates it with useReviewSession({ ..., embeddedIn: '<its page name>' }), so that starting or moving a run does not
     navigate to the practice page. The round's summary (run.complete) is not part of this component: the embedder shows its own;
   - `data`: the library snapshot (decks, sources, skeletons, noteBadges, assist, settings ...);
   - optional `links` (onOpenNote, onMakeNote, onMakeTask, onModelSettings), `coachProps` (thumbs controls and the autopilot bar),
     `context` (label, onReturn, detour, onReturnFromDetour: the way back to where the learner came from) and `feedback` (the app's
     one feedback region).
   Scrolling: this component never scrolls its page. The practice page pins the question under its top bar with usePinQuestion
   (ui/review/usePinQuestion.js); an embedder that wants the same calls it with its own container and `{ scroller }`.
   Styling: the body's classes are global (ui/review/question.css); review.css is injected here too, so no page has to. */

const CALCULATION_STAGE_LABELS = {
  conditions: "已知条件与未知量", formula: "公式与适用理由", substitution: "代入与单位",
  computation: "中间计算", verification: "结果检查与舍入",
};

/* A failed background-assistant task. A model failure goes through the one model note: a key or model problem points to the settings
   (sending the same request again cannot work, so there is no 重新提交), a busy or slow service keeps 重新提交. Anything else is about the
   content: the plain line, 重新提交, and 改一改再提交 when there is a question to edit. */
function AssistFailure({ task, modelReady = false, onSettings, onResubmit, onEdit }) {
  const { busy } = useStudy();
  const text = plainAssistFailure(task.message) || ui("没有拿到具体原因");
  const info = describeModelError(text);
  const resubmit = <Button className="assist-actions__btn" variant="primary" size="sm" lock={busy} onClick={onResubmit}>{ui("重新提交")}</Button>;
  const edit = onEdit && <Button className="assist-actions__btn" size="sm" onClick={onEdit}>{ui("改一改再提交")}</Button>;
  if (info.kind !== "unknown") {
    const canRetry = info.action === "retry" || modelReady;
    return (
      <div className="assist-note assist-failed" data-kind={info.kind}>
        <ModelErrorNote error={text} context="assist" onSettings={onSettings} />
        {(canRetry || edit) && <div className="assist-actions">{canRetry && resubmit}{edit}</div>}
      </div>
    );
  }
  return (
    <div className="assist-status failed assist-failed" role="status">
      <p>{uiFormat("后台助教没能完成：{0}", [text])}</p>
      <div className="assist-actions">{resubmit}{edit}</div>
    </div>
  );
}

export default function QuestionRun({ session, data, coachProps, links = {}, context = {}, feedback }) {
  useInjectCss(reviewCss, "study-review");
  useInjectCss(coachCss, "study-coach");
  const { run, entry, showBack, showEn, enBusyKey, keyGrade, teachingBusy, choice, isCloze, autopilot, actions } = session;
  const { selected, hint, explain, response, teaching, teachAnswer, clozeValues } = entry;
  const { reviewAct, choose, flipCard, assistCard, slayCard, studyPrerequisites, teachingAct, toggleEn } = actions;
  const { call, act, busy, openModal, openSettings, notify } = useStudy();
  const toggleCardFocus = React.useCallback(() => {
    if (!run?.card?.id) return;
    const nextFocus = !run.card.focus;
    act("card.focus", { deckId: run.deckId, cardId: run.card.id, focus: nextFocus }, (res) => {
      session.patchRun?.((prev) => prev?.card ? { ...prev, card: { ...prev.card, focus: !!res?.focus, focusSource: res?.focus ? "card" : null } } : prev);
    });
  }, [act, run?.card?.focus, run?.card?.id, run?.deckId, session]);
  const canDeferPages = !run?.feedback && !!deferUnstudiedPagesPlan(run);
  const deferUnstudiedPages = React.useCallback(
    () => runDeferUnstudiedPages({ run, sources: data?.sources, openModal, reviewAct, notify }),
    [data?.sources, notify, openModal, reviewAct, run],
  );
  const { onOpenNote, onMakeNote, onMakeTask, onModelSettings, onSaveQaToNote } = links;
  // `inHeader`: the page's header already carries the way back (the review book's or the 总纲's, ui/Review.jsx), so it is not said a second time under the card.
  const { label: contextLabel, onReturn: onReturnContext, detour, onReturnFromDetour, inHeader, tourRunning } = context;
  const contextReturnLabel = inHeader ? '' : contextLabel;
  const assistTasks = data?.assist;
  // 「加入复习全书」 + autopilot hover/selection pause + assist polling + case highlights.
  const { book, bookCourse, qaToBook, setQaToBook, bookNote, allFollowups } = useBookQaSync({ run, data, call });
  const multiple = run.card?.multiple || run.card?.kind === "multi";
  const verdict = !!fixedOptionsOf(run.card?.kind);
  const publicationIssues = (run.card?.publicationIssues || []).map((issue) =>
    readableQualityIssue(`Card 1: ${issue}`).replace(/^第 1 题：/, ""));
  const enOn = !!showEn && run.mode !== "exam" && !run.complete;
  const enStem = enOn ? run.card?.translation : null;
  const enAnswer = enOn && run.solution ? run.solution.translation : null;
  const model = modelReadiness(data);
  const modelSettings = onModelSettings || (() => openSettings("settings-model"));
  const [assistMode, setAssistMode] = React.useState("");
  const thumbsRef = React.useRef(null);
  const [thumbState, setThumbState] = React.useState({ vote: null, tags: [] });
  const thumbVote = thumbState.vote;
  const [assistText, setAssistText] = React.useState("");
  const [dismissedTaskId, setDismissedTaskId] = React.useState("");
  const hasSessionExplainHidden = typeof session.explainHidden === "boolean";
  const [localExplainHidden, setLocalExplainHidden] = React.useState(false);
  const hasFeedback = !!run.feedback;
  React.useEffect(() => { setLocalExplainHidden(false); }, [run.id, run.index, run.card?.id, hasFeedback]);
  const isFeedbackHidden = hasSessionExplainHidden ? session.explainHidden : localExplainHidden;
  const showSolution = !!(run.solution && (run.feedback ? !isFeedbackHidden : explain));
  const showUnansweredFollowups = !run.revealed && !showSolution && run.mode !== "exam" && !!(explain || entry.assistance?.askedTutorBeforeAnswer) && (run.followups?.length ?? 0) > 0;
  const voteMoments = voteTipMoments(thumbVote, thumbState.tags, !!run.feedback);
  // The three first-use tips under the question (#948): which one shows, if any, is ui/guidance/practice-tips.js; it says nothing before the learner has acted.
  const practiceTip = usePracticeTip({ run, assistMode, tourRunning: !!tourRunning, modelReady: model.ready, votedDown: voteMoments.votedDown, tooHard: voteMoments.tooHard,
    answerShown: run.mode !== "exam" && ((showSolution && (run.solution?.followups?.length ?? 0) > 0) || showUnansweredFollowups) });
  const [helpChoices, setHelpChoices] = React.useState([]);
  const [clozeFocusTick, setClozeFocusTick] = React.useState(0);
  const [deriveRelation, setDeriveRelation] = React.useState("prerequisite");
  const reviewBodyRef = React.useRef(null);
  const { autoAdvanceMs, autoAdvanceActive, autoAdvancePaused, hoverPauseRef, syncAutoPause } = useAutopilotPause({ session, coachProps, reviewBodyRef });
  const fixPhrases = useFixPhrases(data);
  const ruleDeck = data?.decks?.find((deck) => deck.id === run.deckId);
  const courseRules = useCourseRules(data, ruleDeck?.course ?? ruleDeck?.folder ?? "");
  React.useEffect(() => { setAssistMode(""); setAssistText(""); setHelpChoices([]); setClozeFocusTick(0); }, [run.id, run.index, run.card?.id]);
  const cardTasks = (assistTasks || []).filter((task) => task.cardId === run.card?.id);
  const runningTask = cardTasks.find((task) => task.status === "running" && task.mode !== "grade");
  const lastTask = cardTasks.filter((task) => task.mode !== "grade").at(-1);
  useAssistWatch({ session, assistTasks, cardId: run.card?.id });
  const readingStyle = useReadingProps().style || {};
  const readingMeasure = readingStyle["--reading-measure"];
  const cardScale = Math.round((parseFloat(readingStyle["--reader-size"]) / 16 || 1) * 100) / 100;
  const rubricCard = run.card?.kind === "open" && !!run.card.rubricCriteria?.length;
  const taskCard = run.mode !== "flashcard" && run.card?.kind === "task";
  const flashHead = useFlashHead(!choice && !isCloze && !rubricCard && !taskCard);
  const gradeTask = cardTasks.filter((task) => task.mode === "grade").at(-1);
  const voice = useVoiceAnswer({ session, data, model, rubricCard, setAssistMode, setAssistText });
  const roundSteps = useRoundSteps({ session, run, sources: data?.sources, openModal, onNote: onMakeNote, toggleFocus: toggleCardFocus, voiceKeys: voice.keys,
    focusCloze: isCloze && !run.feedback && !busy ? () => setClozeFocusTick((n) => n + 1) : undefined });
  const { caseSource, caseHighlights, saveHighlights } = useCaseHighlights({ run, data, call });
  const cardNotes = data?.noteBadges?.[run.card?.id] || [];
  // The round's own size and the re-ask, said by one function (the round model puts `position` on the run, #660).
  const position = roundAt(run), words = roundWords(position);
  const prereqStrip = run.prerequisites?.length > 0 && !run.complete && (
    <details className="prereq-strip">
      <summary>
        <span>{uiFormat("前置题 {0} · 已掌握 {1}", [run.prerequisites.length, run.prerequisites.filter((p) => !["new", "weak"].includes(p.level)).length])}</span>
        {(() => {
          const unlearned = run.prerequisites.some((p) => ["new", "weak"].includes(p.level));
          return (
            <Button
              variant={unlearned ? "primary" : "secondary"} size="sm"
              lock={busy}
              title={unlearned ? ui("先学没掌握的前置题，学完回到这道题") : ui("把前置题再过一遍自查，做完回到这道题")}
              onClick={(e) => {
                e.preventDefault();
                studyPrerequisites(run.prerequisites);
              }}
            >
              {unlearned ? ui("先学前置 →") : ui("自查前置 →")}
            </Button>
          );
        })()}
      </summary>
      <ul>
        {run.prerequisites.map((p) => (
          <li key={p.deckId + p.cardId}>
            <button className="prereq-item" disabled={busy} title={ui("只练这一道，做完回到这道题")} onClick={() => studyPrerequisites([p])}>
              <span className={"map-dot lv-" + p.level} />
              <Markdown className="md-compact" links={false} text={p.prompt} />
              <span className="prereq-go" aria-hidden="true">→</span>
            </button>
          </li>
        ))}
      </ul>
    </details>
  );
  return (
    <div className="review-body" ref={reviewBodyRef}>
      <div
        className={
          "question-area " +
          (!choice && !isCloze && !rubricCard && !taskCard ? "flash-area" : "") +
          (caseSource ? " has-case" : "")
        }
        style={readingMeasure ? { "--reading-measure": readingMeasure, "--review-column": "calc(var(--reading-measure) - 4px)", "--card-scale": cardScale } : undefined}
      >
        {run.contentUpdated && <InlineMessage tone="warning" className="review-updated">{ui("这道题已更新，现在显示的是新版，可以按新版重新作答。之前的作答历史都保留着。")}</InlineMessage>}
        {caseSource && <ScenarioPanel className="case-review-scenario" title={caseSource.title} text={caseSource.text}
          highlights={caseHighlights} onChange={saveHighlights} />}
        {/* The card: header, stem and answers on paper stock. Toolbar,
            status and explanation sit below it on the desk. */}
        <div className={"question-card" + (!choice && !isCloze && !rubricCard && !taskCard ? "" : " sh-paper-card sh-paper-card--roomy")} data-tour="review-question" tabIndex={-1}
          onPointerEnter={() => { if (!autoAdvanceActive) return; hoverPauseRef.current.card = true; syncAutoPause(); }}
          onPointerLeave={() => { if (!hoverPauseRef.current.card) return; hoverPauseRef.current.card = false; syncAutoPause(); }}>
          <div className="question-card__head" ref={flashHead}>
            <div className="question-meta">
              <span>
                <span>{words.main}</span>{words.note && <small className="question-retry-note">{words.note}</small>}
                {roundSteps.onEnd && <RoundPending run={run} skippedIndices={session.skippedIndices} onJump={(index) => reviewAct("review.move", { index })} onEnd={roundSteps.onEnd} />}
                {voice.pending}
                <QuestionLiveMastery run={run} />
              </span>
              <div>
                <QuestionMetaBadges run={run} sources={data?.sources} cardNotes={cardNotes} onOpenNote={onOpenNote} />
                {!!publicationIssues.length && !run.card.publicationUngrable &&
                  <Popover label={ui("待核对")} className="publication-mark" panelClassName="publication-mark__panel"
                    trigger={({ props, ref }) => <Button ref={ref} variant="link" size="sm" className="publication-mark__trigger" {...props}>{ui("待核对")}</Button>}>
                    <p>{publicationIssues.join("；")}</p>
                    <Button size="sm" onClick={() => assistCard("improve", uiFormat('发布检查发现：{0}', [publicationIssues.join('; ')]))}>{ui("交给后台修题")}</Button>
                  </Popover>}
                <Button
                  className="question-meta__action"
                  aria-label={ui("标记题目")}
                  onClick={() => openModal({ type: "flag" })}
                >
                  ⚑
                </Button>
              </div>
            </div>
            <ProgressBar size="sm" className="card-progress" label={ui("复习进度")} value={position.at} max={Math.max(1, position.total)} />
          </div>
          {(choice || isCloze || run.card.publicationUngrable) && prereqStrip}
          {run.card.publicationUngrable ? (
            <Banner tone="warning" role="status" className="review-ungrable"
              action={{ label: ui("跳过此题，不计成绩 →"), variant: "primary", disabled: busy, onClick: () => reviewAct("review.skip") }}
              secondary={{ label: ui("交给后台修题"), disabled: busy, onClick: () => assistCard("improve", uiFormat('发布检查发现：{0}', [publicationIssues.join('; ')])) }}>
              <div className="question"><Markdown text={run.card.prompt || ui("题干尚未填写")} /></div>
              <p>{ui("这道题缺少可判分内容。你可以交给助教修改，或跳过；跳过不会记录成绩或改变复习进度。")}</p>
              {!!publicationIssues.length && <p>{publicationIssues.join("；")}</p>}
            </Banner>
          ) : choice ? (
            <>
              <div className="question" role="heading" aria-level={2} key={"stem:" + reviewEntryKey(run)}>
                <Markdown text={run.card.prompt} />
                {enOn && enStem?.prompt && <EnBlock text={enStem.prompt} />}
              </div>
              {run.card.multiple && (
                <p className="muted small">{ui("多选题 · 选出所有符合条件的选项")}</p>
              )}
              {verdict && !run.feedback && <p className="muted small">{ui("判断题 · 这句话说得对不对？按 1 选对，按 2 选错")}</p>}
              <ChoiceFeedback card={run.card} options={run.card.options} feedback={run.feedback} solution={run.solution} multiple={multiple} />
              <div className={"options" + (verdict ? " options--verdict" + (run.feedback ? " options--answered" : "") : "")} key={"options:" + reviewEntryKey(run)}>
                {run.card.options.map((o, i) => {
                  const solution = run.solution?.options?.find(
                    (x) => x.id === o.id,
                  );
                  const picked = run.feedback?.selected?.includes(
                    o.id,
                  );
                  const enOption = enStem?.options?.find((x) => x.id === o.id);
                  const enOptionExplain = enAnswer?.options?.find((x) => x.id === o.id);
                  return (
                    <button
                      key={o.id}
                      style={{ "--reveal-index": i }}
                      disabled={busy || !!run.feedback}
                      className={
                        "option " +
                        (run.feedback
                          ? solution?.correct
                            ? "correct"
                            : picked
                              ? "incorrect"
                              : "dim"
                          : selected.includes(o.id)
                            ? "option--selected"
                            : "")
                      }
                      data-usage="review.option"
                      onClick={() => choose(o.id)}
                    >
                      <span className="option-letter" aria-hidden={verdict || undefined}>
                        {verdict ? optionMark(run.card, o, i) : `${optionMark(run.card, o, i)}.`}
                      </span>
                      <div>
                        {verdict ? <span className="option-verdict">{fixedOptionLabel(run.card, o)}</span>
                          : <Markdown text={o.text} links={false} className="md-compact" />}
                        {!verdict && enOption?.text && <p className="option-en">{enOption.text}</p>}
                        {run.feedback && (
                          // Grows open from zero height, one option after another,
                          // instead of every explanation landing in the same frame.
                          <div className="option-reveal"><div>
                            <strong className="answer-state">
                              {solution?.correct
                                ? picked ? ui("✓ 已选 · 正确") : multiple ? ui("漏选 · 正确答案") : ui("正确答案")
                                : picked
                                  ? multiple ? ui("× 已选 · 错选") : ui("× 你的选择")
                                  : ""}
                            </strong>
                            <Markdown
                              text={solution?.explanation}
                              links={false}
                              className="md-compact option-explanation"
                            />
                            {enOptionExplain?.explanation && (
                              <Markdown
                                text={enOptionExplain.explanation}
                                links={false}
                                className="md-compact option-explanation en-line"
                              />
                            )}
                          </div></div>
                        )}
                      </div>
                    </button>
                  );
                })}
              </div>
              {run.card.multiple && !run.feedback && (
                <div className="submit-row">
                  {selected.length > 0 && (
                    <span className="submit-hint" role="status">
                      <span>{uiFormat("已选 {0} 项 · 按 Enter 提交", [selected.length])}</span>
                      <Button variant="link" size="sm" className="submit-clear" lock={busy}
                        onClick={() => actions.clearChoice?.()}>{ui("清空")}</Button>
                    </span>
                  )}
                  <Button
                    variant="primary" className="submit-answer"
                    data-usage="review.submit"
                    disabled={!selected.length} lock={busy}
                    onClick={() =>
                      reviewAct("review.answer", { selected })
                    }
                  >{ui("提交答案")}</Button>
                </div>
              )}
            </>
          ) : isCloze ? (
            <ClozeQuestion run={run} clozeValues={clozeValues} clozeFocusTick={clozeFocusTick} enOn={enOn} enStem={enStem} enAnswer={enAnswer} voiceAnswer={voice.answer} actions={actions} />
          ) : taskCard ? (
            <>
              <TaskCardRun run={run} data={data} value={response} onChange={actions.setResponse} onReveal={() => reviewAct("review.reveal")}
                onSelfReport={(note) => reviewAct("review.answer", { selfReport: true, ...(note ? { note } : {}) })} enOn={enOn} enStem={enStem} enAnswer={enAnswer} />
              {prereqStrip}
            </>
          ) : rubricCard ? (
            <>
              <RubricAnswer run={run} data={data} value={response} onChange={actions.setResponse} task={gradeTask}
                onSubmit={(text) => assistCard("grade", text)} onSetupModel={onModelSettings || (() => openSettings("settings-model"))} />
              {voice.answer}
              {prereqStrip}
            </>
          ) : (
            <>
              <FlipCard key={run.card.id} run={run} showBack={showBack} flipCard={flipCard} enOn={enOn} />
              <SmoothHeight className="flash-follow" key={"follow:" + run.card.id}>
              {run.card.kind === "open" && !run.revealed && (
                <OpenResponseField grading={run.grading} value={response} onChange={actions.setResponse} onFlip={flipCard} />
              )}
              {voice.answer}
              {run.revealed && !run.feedback && (
                <div className="grading">
                  <div className="grading-head">
                    <span>{run.retry ? ui("本轮重练 · 掌握程度") : ui("掌握程度")}</span>
                    <small className="grading-head__meta">
                      <span className="grading-side-cue">
                        {!showBack ? ui("正在看正面题干 · 按 Space 回背面") : ui("按 Space 可翻回正面核对题干")}
                      </span>
                      {" · "}
                      {ui("按 0–5 评分")}
                      {run.intervals && <>{" · "}<Tooltip layer content={ui("每个按钮下面是选它以后，隔多久再复习这道题。间隔按上次复习到现在实际隔了几天来算：没到期就复习，间隔涨得少；当天重复答，间隔不再变长。")}>
                      <span tabIndex={0} className="grade-gaps-tip">{ui("下面是下次复习的间隔")}</span>
                    </Tooltip></>}</small>
                  </div>
                  <div className="grade-scale" role="group" aria-label={ui("掌握程度评分")}>
                    {[
                      ui("完全忘记"),
                      ui("记得一点"),
                      ui("有印象"),
                      ui("勉强答对"),
                      ui("熟练"),
                      ui("轻松掌握"),
                    ].map((label, grade) => {
                      const gap = formatGap(run.intervals?.[grade]);
                      // The tooltip says the key (#745); a number key answers from the session, which marks the button it named (keyGrade).
                      return (
                        <Tooltip key={grade} layer content={uiFormat("快捷键 {0}：{1}", [grade, label])} anchorClassName="grade-tip">
                          <button
                            className={"grade " + (grade < 3 ? "low" : "high") + (keyGrade === grade ? " is-key-pressed" : "") + (voice.suggested === grade ? " is-suggested" : "")}
                            aria-label={gap ? uiFormat("{0} 分：{1}，{2}后再复习", [grade, label, gap]) : uiFormat("{0} 分：{1}", [grade, label])}
                            aria-keyshortcuts={String(grade)}
                            data-usage="review.grade"
                            disabled={busy}
                            onClick={() => reviewAct("review.answer", { grade })}
                          >
                            <strong>{grade}</strong>
                            <span>{label}</span>
                            {gap && <small className="grade-gap">{gap}</small>}
                          </button>
                        </Tooltip>
                      );
                    })}
                  </div>
                </div>
              )}
              </SmoothHeight>
              {/* A flashcard's header floats over the card faces, so the strip goes below the card. */}
              {prereqStrip}
            </>
          )}
          {/* What the answer did and when the question comes back: at the foot of the card, right after the explanations, where the eyes already are (#672). */}
          {voice.correction}
          {run.feedback && <NextDue feedback={run.feedback} telemetry={run.feedbackTelemetry} />}
          {autoAdvanceActive && (
            <div className={"question-card__autopilot" + (autoAdvancePaused ? " is-paused" : "")}
              key={"card-auto:" + run.index}
              style={{ "--autopilot-ms": `${autoAdvanceMs}ms` }}
              aria-hidden="true">
              <span className="question-card__autopilot-fill" />
            </div>
          )}
        </div>
        {/* Under the card, which stays in view when a question switch pins it to the top. */}
        {contextReturnLabel && <Button variant="quiet" size="sm" icon="arrow-left" className="review-detour" lock={busy} onClick={onReturnContext}>{contextReturnLabel}</Button>}
        {detour && !contextReturnLabel && <Tooltip layer content={ui("回到从信箱跳过来之前正在做的题")} anchorClassName="review-detour">
          <Button variant="quiet" size="sm" icon="arrow-left" className="review-detour__button" lock={busy} onClick={onReturnFromDetour}>{uiFormat("回到之前的第 {0} 题", [detour.index + 1])}</Button></Tooltip>}
        <ReviewToolbar
          key={reviewEntryKey(run)}
          assistMode={assistMode}
          run={run} expanded={run.revealed ? explain : hint}
          onToggleHelp={actions.toggleHelp}
          onAsk={() => setAssistMode((m) => (m === "ask" ? "" : "ask"))}
          onImprove={() => setAssistMode((m) => (m === "improve" ? "" : "improve"))}
          onDerive={() => setAssistMode((m) => (m === "derive" ? "" : "derive"))}
          onSlay={slayCard} onToggleFocus={run.mode !== "exam" ? toggleCardFocus : undefined}
          onDeferUnstudiedPages={canDeferPages ? deferUnstudiedPages : undefined}
          onReviewAction={reviewAct}
          onNote={onMakeNote}
          onTask={onMakeTask}
          enOn={enOn}
          enBusy={!!enBusyKey && enBusyKey === reviewEntryKey(run)}
          onToggleEn={toggleEn}
          autopilot={autopilot} onToggleAutopilot={actions.toggleAutopilot}
          autoAdvanceActive={autoAdvanceActive} autoAdvancePaused={autoAdvancePaused} autoAdvanceMs={autoAdvanceMs}
          onSkip={roundSteps.onSkip} onEndRound={roundSteps.onEnd}
          // 这题不错 / 这题有问题 are items of 更多; ThumbFeedback keeps the vote, the tag tray and the G / B keys (#671).
          thumbVote={thumbVote} onThumb={coachProps && run.mode !== "exam" ? (vote) => thumbsRef.current?.[vote === "up" ? "up" : "down"]() : undefined}
          thumbs={coachProps && run.mode !== "exam" && (
            <ThumbFeedback ref={thumbsRef} buttons={false} run={run} canShortcut={coachProps.canShortcut} onInteract={coachProps.cancelAutoAdvance}
              onSent={(r) => r.scheduled?.length && coachProps.onStatus()} onVote={(vote, tags = []) => setThumbState({ vote, tags })}
              onFix={(tags) => { setAssistMode("improve"); setAssistText(fixSuggestionFor(tags)); }} courseRules={courseRules} />
          )}
        />
        <RoundEndConfirm session={session} />
        {practiceTip.tip && <PracticeTip id={practiceTip.tip} onClose={practiceTip.close} onShown={practiceTip.onShown} />}
        {!assistMode && <div className="action-feedback-slot">{feedback}</div>}
        {/* A stem that asks what the source says tests memory of a document's wording, not the concept: say so and offer the fix, so the learner never has to find the words. */}
        {!assistMode && !runningTask && run.mode !== "exam" && asksWhatTheSourceSays(run.card?.prompt) && (
          <p className="assist-status voice-hint" role="status">
            {ui("这道题在问「资料怎么说」，考的是背资料的措辞，不是理解或应用。")}{" "}
            <Button variant="link" size="sm" data-usage="review.voice-fix" lock={busy} onClick={() => assistCard("improve", ui(SOURCE_VOICE_FIX))}>{ui("改成概念或情景题")}</Button>
          </p>
        )}
        <SmoothHeight className="assist-area">
          {assistMode && (!model.ready ? (
            <div className="assist-form assist-gate">
              <ModelSetupGate variant="inline" feature={assistMode === "derive" ? "generate" : "welcome"} model={model} onOpenSettings={modelSettings} />
              <div className="assist-actions">
                <Button size="sm" className="assist-actions__btn" onClick={() => setAssistMode("")}>{ui("取消")}</Button>
              </div>
            </div>
          ) : (() => {
            const canSubmitAssist = !!assistText.trim() || (assistMode === "ask" && helpChoices.length > 0);
            const submitAssist = async () => {
              const mode = assistMode;
              if (!assistText.trim() && !(mode === "ask" && helpChoices.length)) return;
              if (await assistCard(mode, assistText.trim(), mode === "ask" ? helpChoices : [], mode === "derive" ? { relation: deriveRelation } : undefined)) {
                if (mode === "ask" && helpChoices.includes("prerequisite") && run.prerequisites?.length)
                  studyPrerequisites(run.prerequisites);
                setAssistMode("");
                setAssistText("");
                setHelpChoices([]);
              }
            };
            return (
              <form
                className="assist-form"
                onSubmit={async (event) => {
                  event.preventDefault();
                  await submitAssist();
                }}
              >
                {assistMode === "ask" && <>
                  <strong>{ui("想从哪里弄懂？可多选")}</strong>
                  <div className="assist-quick-choices" role="group" aria-label={ui("帮助方式")}>
                    {HELP_CHOICES.filter((choice) => choice.id !== "mistake" || run.feedback).map((choice) =>
                      <Chip key={choice.id} selected={helpChoices.includes(choice.id)}
                        onClick={() => setHelpChoices((items) => items.includes(choice.id)
                          ? items.filter((item) => item !== choice.id) : [...items, choice.id])}>
                        {ui(choice.label)}
                      </Chip>)}
                  </div>
                </>}
                {assistMode === "derive" && <SegmentedControl size="sm" className="assist-quick-choices" label={ui("出成什么题")} value={deriveRelation} onChange={setDeriveRelation}
                  options={[{ value: "prerequisite", label: ui("这道题的前置题") }, { value: "standalone", label: ui("一道独立的新题") }]} />}
                {assistMode === "improve" && <>
                  <strong>{ui("不知道怎么说？点一个，或者让助教自己检查")}</strong>
                  <FixPhraseChips phrases={fixPhrases.phrases}
                    onPick={(picked) => setAssistText((current) => appendFixPhrase(current, picked))}
                    onRemove={fixPhrases.remove} />
                </>}
                <label className="assist-form__field">
                  {assistMode === "ask" ? ui("补充你自己的疑问（可选）") : assistMode === "derive" ? ui("根据哪个知识点出题？写下来，后台助教会出成一道题，放进同一题组") : ui("这道题哪里不好？后台助教会直接改这张卡，改完可在信箱里一步撤销")}
                  <textarea className="assist-form__input" autoFocus rows={2} value={assistText} maxLength={1000}
                    placeholder={assistMode === "ask" ? ui("例如：不懂为什么重试会放大负载") : assistMode === "derive" ? ui("例如：什么是聚合根；为什么重试要幂等") : ui("例如：选项 B 和 C 说的是一回事；解析没说清为什么 A 错")}
                    onChange={(event) => setAssistText(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.nativeEvent?.isComposing || event.keyCode === 229) return;
                      if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
                        if (!canSubmitAssist) return;
                        event.preventDefault();
                        submitAssist();
                      } else if (event.key === "Escape" && !assistText.trim()) {
                        event.preventDefault();
                        event.stopPropagation();
                        const selector = assistMode === "ask" ? '[data-tour="review-help"]'
                          : assistMode === "improve" ? '[data-tour="review-improve"]'
                          : ".question-card";
                        setAssistMode("");
                        const body = reviewBodyRef.current;
                        const target = body?.querySelector?.(selector) || body?.querySelector?.(".question-card");
                        target?.focus?.({ preventScroll: true });
                      }
                    }} />
                </label>
                {assistMode === "improve" && <FixPhraseSave phrases={fixPhrases.phrases} text={assistText} onSave={fixPhrases.add} />}
                {assistMode === "improve" && <CourseRuleAdd courseRules={courseRules} text={assistText} />}
                <div className="action-feedback-slot assist-form__feedback">{feedback}</div>
                <div className="assist-actions">
                  <Button type="submit" variant="primary" size="sm" className="assist-actions__btn"
                    disabled={!canSubmitAssist}>{ui("提交到后台")}</Button>
                  {assistText.trim() && (
                    <Button variant="quiet" size="sm" className="assist-actions__btn" onClick={() => setAssistText("")}>
                      {ui("清空")}
                    </Button>
                  )}
                  <Button size="sm" className="assist-actions__btn" onClick={() => setAssistMode("")}>{ui("取消")}</Button>
                  {assistMode === "ask" && voice.askButton}
                </div>
                {assistMode === "ask" && <p className="muted small">{ui("提交后才启动后台助教。讲解会出现在这道题下面的问答里，完成时信箱会提醒你；做题和主会话可以继续。")}</p>}
              </form>
            );
          })())}
          {runningTask && (
            <p className="assist-status" role="status">
              <span className="assist-status__spinner" aria-hidden="true"><Spinner size="sm" /></span>
              <span className="assist-status__text">
                {uiFormat(runningTask.mode === "ask" ? "后台助教正在解答：{0}" : runningTask.mode === "derive" ? "后台助教正在出新题：{0}" : "后台助教正在改题：{0}", [formatAssistTaskSummary(runningTask)])}
              </span>
            </p>
          )}
          {(() => {
            const editLastTask = lastTask && (lastTask.mode === "ask" || lastTask.mode === "improve" || (lastTask.mode === "derive" && !lastTask.followupId))
              ? () => { setAssistMode(lastTask.mode); setAssistText(lastTask.question || ""); setHelpChoices(lastTask.mode === "ask" ? lastTask.choices || [] : []); if (lastTask.mode === "derive") setDeriveRelation(lastTask.relation || "prerequisite"); setDismissedTaskId(lastTask.id); }
              : null;
            if (!runningTask && lastTask?.status === "failed") {
              return <AssistFailure task={lastTask} modelReady={model.ready} onSettings={modelSettings}
                onResubmit={() => assistCard(lastTask.mode, lastTask.question || "", lastTask.mode === "ask" ? lastTask.choices || [] : [],
                  lastTask.mode === "derive" ? { relation: lastTask.relation, followupId: lastTask.followupId } : undefined)}
                onEdit={editLastTask} />;
            }
            if (!runningTask && !assistMode && lastTask?.status === "done" && (lastTask.outcome === "no-change" || lastTask.outcome === "unlinked") && dismissedTaskId !== lastTask.id) {
              return (
                <div className="assist-status" role="status">
                  <p>{uiMessage(lastTask.message)}</p>
                  <div className="assist-actions">
                    {editLastTask && <Button className="assist-actions__btn" size="sm" onClick={editLastTask}>{ui("改一改再提交")}</Button>}
                    <Button className="assist-actions__btn" size="sm" variant="quiet" onClick={() => setDismissedTaskId(lastTask.id)}>{ui("知道了")}</Button>
                  </div>
                </div>
              );
            }
            return null;
          })()}
        </SmoothHeight>
        {autoAdvanceActive && (
          <>
            <div className={"autopilot-bar" + (autoAdvancePaused ? " is-paused" : "")} key={run.index} style={{ "--autopilot-ms": autoAdvanceMs + "ms" }} />
            <small className="autopilot-note">{ui("自动跳下一步：马上进入下一题，点任意处或按键可停下")}</small>
            {autoAdvancePaused && <small className="autopilot-note review-autopilot-note is-paused" role="status">{ui("已暂停自动跳下一步（移开指针或取消选中后继续）")}</small>}
          </>
        )}
        {hint && !run.revealed && (
          <div className="hint"><Icon name="help" className="hint__icon" /><Markdown text={run.card.hint} /></div>
        )}
        <WrongAnswerSource run={run} sources={data.sources} onOpen={(source, quote) => openModal({ type: "source", source, quote, back: true })} />
        {run.solution && run.feedback && isFeedbackHidden && (
          <div className="explanation-collapsed">
            <Button variant="quiet" size="sm" onClick={() => (hasSessionExplainHidden ? actions.toggleHelp() : setLocalExplainHidden(false))}>{ui("展开解析 (H)")}</Button>
          </div>
        )}
        {(showSolution || showUnansweredFollowups) && (
          <ReadingBlock measure className="explanation"
            onPointerEnter={() => { if (!autoAdvanceActive) return; hoverPauseRef.current.explanation = true; syncAutoPause(); }}
            onPointerLeave={() => { if (!hoverPauseRef.current.explanation) return; hoverPauseRef.current.explanation = false; syncAutoPause(); }}>
            {showSolution && <>
              <h3>{ui("理解这道题")}</h3>
              <Markdown text={run.solution.explanation} />
              {enOn && enAnswer?.explanation && <EnBlock text={enAnswer.explanation} />}
              <h4>{ui("容易混淆的地方")}</h4>
              <Markdown text={run.solution.misconception} />
              {run.solution.rubric && <>
                <h4>{run.card?.kind === "task" ? ui("验收标准") : ui("评分依据")}</h4>
                <Markdown text={run.solution.rubric} />
              </>}
              <CitationDisclosure key={"citations:" + reviewEntryKey(run)} card={run.solution} sources={data.sources}
                onOpenSource={(source, quote, peekPage) => openModal({ type: "source", source, quote, peekPage, back: true })} />
              <FigurePageLink key={"figure:" + reviewEntryKey(run)} card={run.solution} sources={data.sources}
                onOpen={(source, quote, peekPage) => openModal({ type: "source", source, quote, peekPage, back: true })} />
            </>}
            {run.mode !== "exam" && <ExplanationFollowup key={reviewEntryKey(run)} run={run} readOnly cardNotes={cardNotes}
              onDerive={(followupId, relation) => assistCard("derive", "", [], { relation, followupId })} deriving={!!runningTask}
              onAskMore={(event) => { const body = event?.currentTarget?.closest?.(".review-body"); setAssistMode("ask"); requestAnimationFrame(() => { body?.querySelector(".assist-area")?.scrollIntoView?.({ behavior: "smooth", block: "nearest" }); body?.querySelector(".assist-form__input")?.focus(); }); }}
              bookQa={{ course: bookCourse, mode: qaToBook, onMode: setQaToBook, book, note: bookNote }}
              noteQa={onSaveQaToNote ? { savedIn: (followupId) => cardNotes.find((note) => note.qa && note.followupIds?.includes(followupId))?.noteId || "", onSave: onSaveQaToNote, onOpen: onOpenNote } : null} />}
            {showSolution && (allFollowups.length > 0 || (run.solution?.explanation?.length || 0) >= 280) && (
              <div className="explanation-foot">
                <Button variant="quiet" size="sm" onClick={() => {
                  if (run.feedback) {
                    if (hasSessionExplainHidden) actions.toggleHelp();
                    else setLocalExplainHidden(true);
                  } else {
                    actions.toggleHelp();
                  }
                  requestAnimationFrame(() => reviewBodyRef.current?.querySelector?.(".question-card")?.focus?.({ preventScroll: true }));
                }}>{ui("收起解析 (H)")}</Button>
                {run.feedback && !run.complete && (
                  <Button variant="primary" size="sm" lock={busy} onClick={() => reviewAct("review.move", { direction: 1 })}>
                    {position.last ? ui("完成") : ui("下一题")} →
                  </Button>
                )}
              </div>
            )}
          </ReadingBlock>
        )}
        {/* 逐步理解 / 计算题引导练习 / 用自己的话讲一遍 / 试一道同类题 (ui/review/LearningActions.jsx). */}
        <LearningActions session={session} data={data} model={model} onModelSettings={modelSettings} openModal={openModal} />
        {teaching && <div className="teaching-panel">
          <ReadingBlock as="section" measure className="explanation">
            <div className="eyebrow">
              {uiFormat("{0} · {1} / {2}", [teaching.mode === "calculation" ? ui("计算题引导练习") : ui("逐步理解"), Math.min(teaching.index + 1, teaching.total), teaching.total])}
            </div>
            <ProgressBar className="teaching-progress" size="sm" value={teaching.index} max={teaching.total}
              label={teaching.mode === "calculation" ? ui("计算题引导练习") : ui("逐步理解")} />
            {teaching.mode === "calculation" && <p className="muted small">{ui("每次只练当前步骤。AI 反馈用于辅助学习，不能证明计算正确。")}</p>}
            {teaching.feedback && <Markdown className="teaching-feedback" text={teaching.feedback} />}
            {teaching.complete ? (
              <>
                <h3>{ui("把理解迁移到下一题")}</h3>
                <Markdown text={teaching.transfer} />
                <SimilarTry session={session} data={data} model={model} onModelSettings={modelSettings} />
              </>
            ) : (
              <>
                {teaching.mode === "calculation" && <h3>{ui(CALCULATION_STAGE_LABELS[teaching.stage] || "计算题引导练习")}</h3>}
                <Markdown text={teaching.lesson} />
                {teaching.mode === "calculation" && <>
                  <dl className="teaching-context">
                    <div><dt>{ui("本步假设")}</dt><dd><Markdown text={teaching.assumptions} /></dd></div>
                    <div><dt>{ui("本步单位")}</dt><dd><Markdown text={teaching.units} /></dd></div>
                    <div><dt>{ui("精度与舍入")}</dt><dd><Markdown text={teaching.rounding} /></dd></div>
                  </dl>
                  <CitationDisclosure card={teaching} sources={data.sources}
                    onOpenSource={(source, quote, peekPage) => openModal({ type: "source", source, quote, peekPage, back: true })} />
                </>}
                <form onSubmit={(e) => { e.preventDefault(); teachingAct("teach.answer", { id: teaching.id, stepIndex: teaching.index, answer: teachAnswer }); }}>
                  <label className="teaching-panel__field">
                    <Markdown text={teaching.check} />
                    <textarea required maxLength={10000} rows={3} aria-label={ui("当前步骤的回答")} value={teachAnswer} onChange={(e) => actions.setTeachAnswer(e.target.value)} />
                  </label>
                  <Button className="teaching-panel__submit" variant="primary" disabled={teachingBusy || !teachAnswer.trim()}
                    onPointerUp={(e) => e.currentTarget.closest(".study-app")?.focus({ preventScroll: true })} type="submit">{ui("检查理解 →")}</Button>
                </form>
              </>
            )}
          </ReadingBlock>
        </div>}
      </div>
    </div>
  );
}
