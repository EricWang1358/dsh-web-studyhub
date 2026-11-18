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
import { fixedOptionLabel } from "../option-label.js";
import OptionMark from "../OptionMark.jsx";
import ThumbFeedback from "../ThumbFeedback.jsx";
import PracticeTip from "./PracticeTip.jsx";
import TermChips from "./TermChips.jsx";
import TermListDialog from "./TermListDialog.jsx";
import { useTermMarking } from "./use-term-marking.js";
import { usePracticeTip } from "./use-practice-tip.js";
import { voteTipMoments } from "../guidance/practice-tips.js";
import { reviewEntryKey } from "../async.js";
import ModelErrorNote from "../ModelErrorNote.jsx";
import ModelSetupGate from "../ModelSetupGate.jsx";
import TeachingPanel from "./TeachingPanel.jsx";
import { describeModelError, modelReadiness, plainAssistFailure } from "../generation-status.js";
import { readableQualityIssue } from "../quality.js";
import { ReadingBlock, useReadingProps } from "../reading-settings/ReadingSettings.jsx";
import AnswerState from "./AnswerState.jsx";
import { Banner, Button, Chip, Icon, InlineMessage, Popover, ProgressBar, SegmentedControl, Spinner, Tooltip } from "../components/index.js";
import { useStudy } from "../study-context.jsx";
import { HELP_CHOICES } from "../agent-prompts/card.js";
import { FixPhraseChips, FixPhraseSave, appendFixPhrase } from "./FixPhrases.jsx";
import { useFixPhrases } from "./use-fix-phrases.js";
import { playSound } from "../sound-effects.js";
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
import { NextDue, nextDueIcon, nextDueWord } from "../NextDue.jsx";
import { formatGap } from "../format.js";
import { roundAt, roundWords } from "./round-words.js";
import { fixedOptionsOf } from "../../lib/card-kinds.js";
import { deferUnstudiedPagesPlan, runDeferUnstudiedPages } from "../document-preview/practice/open-reader-pages.js";
import RoundPending from "./RoundPending.jsx";
import { RoundEndConfirm, useRoundSteps } from "./RoundSteps.jsx";
import { useVoiceAnswer } from "./VoiceAnswer.jsx";
import { formatAssistTaskSummary } from "./assist-summary.js";
import { ClozeQuestion, OpenResponseField, PostAnswerDetails, QuestionLiveMastery, QuestionMetaBadges } from "./QuestionParts.jsx";
import { useAssistWatch, useAutopilotPause, useBookQaSync, useCaseHighlights } from "./use-review-run-sync.js";
import { companionSlideButtonLabel, openCompanionTarget, resolveCompanionTarget } from "../companions/companion-ref.js";
import companionsCss from "../companions/companions.css";
import { useCardPlace } from "./QuestionPlace.jsx";
import { isPassed } from "./session-logic.js";
import ChapterHint from "./ChapterHint.jsx";
import { useChapterHint } from "./use-chapter-hint.js";

export { formatAssistTaskSummary };

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

export default function QuestionRun({ session, data, coachProps, links = {}, context = {}, feedback, place: placeProp, inline = false }) {
  useInjectCss(reviewCss, "study-review");
  useInjectCss(coachCss, "study-coach");
  useInjectCss(companionsCss, "study-companions");
  const { run, entry, showBack, showEn, autoTerms, enBusyKey, autoTermsBusyKey, keyGrade, choice, isCloze, autopilot, actions } = session;
  const { selected, hint, explain, response, clozeValues } = entry;
  const { reviewAct, choose, flipCard, assistCard, slayCard, studyPrerequisites, toggleEn, toggleAutoTerms } = actions;
  const { call, act, busy, openModal, openSettings, notify } = useStudy();
  const toggleCardFocus = React.useCallback(() => {
    if (!run?.card?.id) return;
    const nextFocus = !run.card.focus;
    playSound("tap");
    act("card.focus", { deckId: run.deckId, cardId: run.card.id, focus: nextFocus }, (res) => {
      session.patchRun?.((prev) => prev?.card ? { ...prev, card: { ...prev.card, focus: !!res?.focus, focusSource: res?.focus ? "card" : null } } : prev);
    });
  }, [act, run?.card?.focus, run?.card?.id, run?.deckId, session]);
  const canDeferPages = !run?.feedback && !!deferUnstudiedPagesPlan(run);
  const deferUnstudiedPages = React.useCallback(
    () => runDeferUnstudiedPages({ run, sources: data?.sources, openModal, reviewAct, notify }),
    [data?.sources, notify, openModal, reviewAct, run],
  );
  const { onOpenNote, onMakeNote, onMakeTask, onModelSettings, onSaveQaToNote, onOpenBookSection } = links;
  const fetchedPlace = useCardPlace({ call, run, enabled: placeProp === undefined && run?.mode !== "exam" });
  const cardPlace = placeProp !== undefined ? placeProp : fetchedPlace;
  const canOpenBookSection = run?.mode !== "exam" && !run?.complete && cardPlace?.leaf?.built === true && typeof onOpenBookSection === "function";
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
    answerShown: run.mode !== "exam" && ((showSolution && (run.solution?.followups?.some((item) => item?.kind !== "terms") ?? false)) || (showUnansweredFollowups && (run.followups?.some((item) => item?.kind !== "terms") ?? false))) });
  const [helpChoices, setHelpChoices] = React.useState([]);
  const [clozeFocusTick, setClozeFocusTick] = React.useState(0);
  const [deriveRelation, setDeriveRelation] = React.useState("prerequisite");
  const [termListOpen, setTermListOpen] = React.useState(false);
  const reviewBodyRef = React.useRef(null);
  const { autoAdvanceMs, autoAdvanceActive, autoAdvancePaused, hoverPauseRef, syncAutoPause } = useAutopilotPause({ session, coachProps, reviewBodyRef });
  const fixPhrases = useFixPhrases(data);
  const ruleDeck = data?.decks?.find((deck) => deck.id === run.deckId);
  const termCourseName = ruleDeck?.course ?? ruleDeck?.folder ?? run?.course ?? "";
  const courseRules = useCourseRules(data, ruleDeck?.course ?? ruleDeck?.folder ?? "");
  const termMarks = useTermMarking({ session, reviewBodyRef, notify, call, courseName: termCourseName, assistTasks });
  const chapterHint = useChapterHint({ run, cardPlace, allFollowups, currentTerms: termMarks.terms, tipShown: practiceTip.tip, tourRunning: !!tourRunning });
  const applyMarkedTerms = (terms) => {
    if (!terms?.length) return;
    if (!model.ready) {
      setAssistMode("ask");
      return;
    }
    chapterHint.noteFillTerms();
    assistCard("terms", "", [], { terms });
  };
  React.useEffect(() => { setAssistMode(""); setAssistText(""); setHelpChoices([]); setDeriveRelation("prerequisite"); setClozeFocusTick(0); setTermListOpen(false); }, [run.id, run.index, run.card?.id]);
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
  const companionTarget = run.mode !== "exam" && run.revealed
    ? resolveCompanionTarget({
      card: run.card,
      solution: run.solution,
      courses: data?.courses,
      sources: data?.sources,
      fallbackCourse: ruleDeck?.course ?? ruleDeck?.folder ?? "",
    })
    : null;
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
              variant={unlearned ? "primary" : "secondary"} size="sm" iconEnd="arrow-right"
              lock={busy}
              title={unlearned ? ui("先学没掌握的前置题，学完回到这道题") : ui("把前置题再过一遍自查，做完回到这道题")}
              onClick={(e) => {
                e.preventDefault();
                studyPrerequisites(run.prerequisites);
              }}
            >
              {unlearned ? ui("先学前置") : ui("自查前置")}
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
              <Icon name="arrow-right" className="prereq-go sh-icon--inline" />
            </button>
          </li>
        ))}
      </ul>
    </details>
  );
  return (
    <div className={"review-body" + (termMarks.marking ? " is-marking" : "")} ref={reviewBodyRef}>
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
                <Tooltip layer content={ui("标记题目")}><Button icon="flag" variant="quiet" size="sm" aria-label={ui("标记题目")} className="sh-btn--icon question-meta__action" onClick={() => openModal({ type: "flag" })} /></Tooltip>
              </div>
            </div>
            <ProgressBar size="sm" className="card-progress" label={ui("复习进度")} value={position.at} max={Math.max(1, position.total)} />
          </div>
          {(choice || isCloze || run.card.publicationUngrable) && prereqStrip}
          {run.card.publicationUngrable ? (
            <Banner tone="warning" role="status" className="review-ungrable"
              action={{ label: ui("跳过此题，不计成绩"), variant: "primary", iconEnd: "arrow-right", disabled: busy, onClick: () => reviewAct("review.skip") }}
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
                      aria-keyshortcuts={!run.feedback ? String(i + 1) : undefined}
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
                        <OptionMark card={run.card} option={o} index={i} />
                      </span>
                      <div>
                        {verdict ? <span className="option-verdict">{fixedOptionLabel(run.card, o)}</span>
                          : <Markdown text={o.text} links={false} className="md-compact" />}
                        {!verdict && enOption?.text && <p className="option-en">{enOption.text}</p>}
                        {run.feedback && (solution?.correct || picked) && (
                          // Grows open from zero height for the picked and right answers; distractor notes fold under 更多解析与巩固方式.
                          <div className="option-reveal"><div>
                            <AnswerState correct={solution?.correct} picked={picked} multiple={multiple} />
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
              <TaskCardRun key={`task:${run.id}:${run.index}:${run.card.id}`} run={run} data={data} value={response} onChange={actions.setResponse} onReveal={() => reviewAct("review.reveal")}
                onSelfReport={(note) => reviewAct("review.answer", { selfReport: true, ...(note ? { note } : {}) })} enOn={enOn} enStem={enStem} enAnswer={enAnswer} />
              {prereqStrip}
            </>
          ) : rubricCard ? (
            <>
              <RubricAnswer key={`rubric:${run.id}:${run.index}:${run.card.id}`} run={run} data={data} value={response} onChange={actions.setResponse} task={gradeTask}
                onSubmit={(text) => assistCard("grade", text, [], undefined, { quiet: true })} onSetupModel={onModelSettings || (() => openSettings("settings-model"))} />
              {voice.answer}
              {prereqStrip}
            </>
          ) : (
            <>
              <FlipCard key={`flip:${run.id}:${run.index}:${run.card.id}`} run={run} showBack={showBack} flipCard={flipCard} enOn={enOn} />
              <SmoothHeight className="flash-follow" key={`follow:${run.id}:${run.index}:${run.card.id}`}>
              {run.card.kind === "open" && !run.revealed && !showBack && (
                <OpenResponseField grading={run.grading} value={response} onChange={actions.setResponse} onFlip={flipCard} />
              )}
              {voice.answer}
              {(run.revealed || showBack) && !run.feedback && companionTarget && openModal && (
                <div className="sh-comp-card-jump">
                  <Button size="sm" variant="quiet" iconEnd="arrow-right" onClick={() => openCompanionTarget(openModal, companionTarget)}>
                    {companionSlideButtonLabel(companionTarget)}
                  </Button>
                </div>
              )}
              {(run.revealed || showBack) && !run.feedback && (
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
          {/* Concise card verdict at the foot of the card; full schedule telemetry folds under 更多解析与巩固方式. */}
          {voice.correction}
          {run.feedback && <p className={"next-due next-due--verdict" + (run.feedback.correct || run.feedback.selfReported ? "" : " retry")}
            data-level={run.feedback.level || undefined} role="status">{nextDueIcon(run.feedback) && <Icon name={nextDueIcon(run.feedback)} className="sh-icon--inline sh-icon--lead" />}{nextDueWord(run.feedback)}</p>}
          {canOpenBookSection && run.feedback && !run.feedback.selfReported && !isPassed(run) && (
            <div className="question-book-link">
              <Button variant="link" size="sm" iconEnd="arrow-right" data-book-section-link="feedback" lock={busy}
                onClick={() => onOpenBookSection(cardPlace)}>
                {ui("读全书这一节")}
              </Button>
            </div>
          )}
          {autoAdvanceActive && (
            <div className={"question-card__autopilot" + (autoAdvancePaused ? " is-paused" : "")}
              key={"card-auto:" + (session.advanceKey || run.index)}
              style={{ "--autopilot-ms": `${autoAdvanceMs}ms` }}
              aria-hidden="true">
              <span className="question-card__autopilot-fill" />
            </div>
          )}
        </div>
        <div className="review-sticky-bar" data-answered={run.feedback ? "true" : undefined} data-grading={rubricCard && (run.grading || gradeTask?.status === "running") ? "true" : undefined}>
          {contextReturnLabel && <Button variant="quiet" size="sm" icon="arrow-left" className="review-detour" lock={busy} onClick={onReturnContext}>{contextReturnLabel}</Button>}
          {detour && !contextReturnLabel && <Tooltip layer content={ui("回到从信箱跳过来之前正在做的题")} anchorClassName="review-detour">
            <Button variant="quiet" size="sm" icon="arrow-left" className="review-detour__button" lock={busy} onClick={onReturnFromDetour}>{uiFormat("回到之前的第 {0} 题", [detour.index + 1])}</Button></Tooltip>}
          <ReviewToolbar
            key={session.advanceKey || `${run.id}:${run.index}:${run.card?.id}`}
            assistMode={assistMode}
            markingTerms={termMarks.marking}
            onToggleMarkTerms={termMarks.toggleMarking}
            run={run} expanded={(run.revealed || showBack) ? explain : hint} revealed={!!(run.revealed || showBack)}
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
            autoTerms={!!autoTerms}
            autoTermsBusy={!!autoTermsBusyKey && autoTermsBusyKey === reviewEntryKey(run)}
            onToggleAutoTerms={toggleAutoTerms}
            autopilot={autopilot} onToggleAutopilot={actions.toggleAutopilot}
            selfGradeAdvance={session.selfGradeAdvance} onToggleSelfGradeAdvance={actions.toggleSelfGradeAdvance}
            onUndo={actions.undoAnswer}
            autoAdvanceActive={autoAdvanceActive} autoAdvancePaused={autoAdvancePaused} autoAdvanceMs={autoAdvanceMs}
            onSkip={roundSteps.onSkip} onEndRound={roundSteps.onEnd}
            thumbVote={thumbVote} onThumb={coachProps && run.mode !== "exam" ? (vote) => thumbsRef.current?.[vote === "up" ? "up" : "down"]() : undefined}
            thumbs={coachProps && run.mode !== "exam" && (
              <ThumbFeedback ref={thumbsRef} buttons={false} run={run} canShortcut={coachProps.canShortcut} onInteract={coachProps.cancelAutoAdvance}
                onSent={(r) => r.scheduled?.length && coachProps.onStatus()} onVote={(vote, tags = []) => setThumbState({ vote, tags })}
                onFix={(tags) => { setAssistMode("improve"); setAssistText(fixSuggestionFor(tags)); }} courseRules={courseRules} />
            )}
          />
          <RoundEndConfirm session={session} />
          {!assistMode && <div className="action-feedback-slot">{feedback}</div>}
        </div>
        {practiceTip.tip && <PracticeTip id={practiceTip.tip} onClose={practiceTip.close} onShown={practiceTip.onShown} />}
        {/* A stem that asks what the source says tests memory of a document's wording, not the concept: say so and offer the fix, so the learner never has to find the words. */}
        {!assistMode && !runningTask && run.mode !== "exam" && asksWhatTheSourceSays(run.card?.prompt) && (
          <p className="assist-status voice-hint" role="status">
            {ui("这道题在问「资料怎么说」，考的是背资料的措辞，不是理解或应用。")}{" "}
            <Button variant="link" size="sm" data-usage="review.voice-fix" lock={busy} onClick={() => assistCard("improve", ui(SOURCE_VOICE_FIX))}>{ui("改成概念或情景题")}</Button>
          </p>
        )}
        <TermChips
          terms={termMarks.terms}
          candidates={termMarks.candidates}
          onRemove={termMarks.removeTerm}
          onMarkCandidate={termMarks.markCandidate}
          onFill={applyMarkedTerms}
          onTermList={termCourseName ? () => { termMarks.refreshCourseTerms(); setTermListOpen(true); } : undefined}
          hasCourse={Boolean(termCourseName)}
          busy={busy || !!runningTask}
          running={runningTask?.mode === "terms"}
        />
        {termListOpen && termCourseName && (
          <TermListDialog
            courseName={termCourseName}
            items={termMarks.courseTerms}
            loading={termMarks.loadingCourseTerms}
            error={termMarks.courseTermsError}
            onRemove={termMarks.removeCourseTerm}
            onClear={termMarks.clearCourseTerms}
            onClose={() => setTermListOpen(false)}
          />
        )}
        {chapterHint.visible && <ChapterHint run={run} sources={data?.sources} decks={data?.decks} openModal={openModal} cardPlace={cardPlace} terms={chapterHint.terms} deeper={chapterHint.deeper} onDismiss={chapterHint.dismiss} onDismissForever={chapterHint.mute} />}
        <SmoothHeight className="assist-area">
          {assistMode && (!model.ready ? (
            <div className="assist-form assist-gate">
              <ModelSetupGate variant="inline" feature={assistMode === "derive" ? "generate" : "welcome"} model={model} onOpenSettings={modelSettings} />
              <div className="action-feedback-slot assist-form__feedback">{feedback}</div>
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
                {uiFormat(runningTask.mode === "ask" ? "后台助教正在解答：{0}" : runningTask.mode === "derive" ? "后台助教正在出新题：{0}" : runningTask.mode === "terms" ? "后台助教正在补词：{0}" : "后台助教正在改题：{0}", [formatAssistTaskSummary(runningTask)])}
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
                  lastTask.mode === "derive" ? { relation: lastTask.relation, followupId: lastTask.followupId }
                    : lastTask.mode === "terms" ? { terms: lastTask.terms || [] } : undefined)}
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
              {!run.feedback && run.solution.misconception && <>
                <h4>{ui("容易混淆的地方")}</h4>
                <Markdown text={run.solution.misconception} />
              </>}
              {!run.feedback && run.solution.rubric && <>
                <h4>{run.card?.kind === "task" ? ui("验收标准") : ui("评分依据")}</h4>
                <Markdown text={run.solution.rubric} />
              </>}
              <CitationDisclosure key={"citations:" + reviewEntryKey(run)} card={run.solution} sources={data.sources}
                onOpenSource={(source, quote, peekPage) => openModal({ type: "source", source, quote, peekPage, back: true })} />
              <FigurePageLink key={"figure:" + reviewEntryKey(run)} card={run.solution} sources={data.sources}
                onOpen={(source, quote, peekPage) => openModal({ type: "source", source, quote, peekPage, back: true })} />
              {!run.feedback && (choice || isCloze || rubricCard || taskCard) && companionTarget && openModal && (
                <div className="sh-comp-card-jump">
                  <Button size="sm" variant="quiet" iconEnd="arrow-right" onClick={() => openCompanionTarget(openModal, companionTarget)}>
                    {companionSlideButtonLabel(companionTarget)}
                  </Button>
                </div>
              )}
            </>}
            {run.mode !== "exam" && <ExplanationFollowup key={reviewEntryKey(run)} run={run} readOnly cardNotes={cardNotes}
              onDerive={(followupId, relation) => assistCard("derive", "", [], { relation, followupId })} deriving={!!runningTask}
              onAskMore={(event) => { const body = event?.currentTarget?.closest?.(".review-body"); setAssistMode("ask"); requestAnimationFrame(() => { body?.querySelector(".assist-area")?.scrollIntoView?.({ behavior: "smooth", block: "nearest" }); body?.querySelector(".assist-form__input")?.focus(); }); }}
              bookQa={{ course: bookCourse, mode: qaToBook, onMode: setQaToBook, book, note: bookNote }}
              noteQa={onSaveQaToNote ? { savedIn: (followupId) => cardNotes.find((note) => note.qa && note.followupIds?.includes(followupId))?.noteId || "", onSave: onSaveQaToNote, onOpen: onOpenNote } : null}
              onOpenBookSection={canOpenBookSection ? () => onOpenBookSection(cardPlace) : undefined} />}
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
              </div>
            )}
          </ReadingBlock>
        )}
        <PostAnswerDetails session={session} data={data} model={model} onModelSettings={modelSettings} openModal={openModal}
          showSolution={showSolution} verdict={verdict} enOn={enOn} enAnswer={enAnswer} defaultOpen={!!inline}
          nextDueNode={run.feedback ? <NextDue feedback={run.feedback} telemetry={run.feedbackTelemetry} /> : null} />
        <TeachingPanel session={session} data={data} model={model} onModelSettings={modelSettings} />
      </div>
    </div>
  );
}
