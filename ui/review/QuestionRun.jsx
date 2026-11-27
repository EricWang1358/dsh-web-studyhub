import { ui, uiFormat } from "../i18n.js";
import { uiRich } from "../i18n-rich.jsx";
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
import { useTermSubmitQueue } from "./use-term-submit-queue.js";
import { useTermMarking } from "./use-term-marking.js";
import { usePracticeTip } from "./use-practice-tip.js";
import { PRACTICE_TIP, voteTipMoments } from "../guidance/practice-tips.js";
import { reviewEntryKey } from "../async.js";
import ModelErrorNote from "../ModelErrorNote.jsx";
import TeachingPanel from "./TeachingPanel.jsx";
import LazySocraticInlineDrawer, { SocraticWrongNudge, useSocraticInlineState } from "./LazySocraticInline.jsx";
import { describeModelError, modelReadiness, plainAssistFailure } from "../generation-status.js";
import { readableQualityIssue } from "../quality.js";
import { ReadingBlock, useReadingProps } from "../reading-settings/ReadingSettings.jsx";
import AnswerState from "./AnswerState.jsx";
import { Banner, Button, DisclosureToggle, Icon, InlineMessage, Popover, ProgressBar, Spinner, TextInput, Tooltip, foldLabel } from "../components/index.js";
import { useStudyBusy, useStudyServices } from "../study-context.jsx";
import { useStickyRoom } from "../use-sticky-room.js";
import { useNarrow } from "../use-narrow.js";
import { useLiveSession } from "./useReviewSession.js";
import { LazySimilarTry } from "./LazyLearningLoop.jsx";
import { useFixPhrases } from "./use-fix-phrases.js";
import { playSound } from "../sound-effects.js";
import { useFlashHead } from "./use-flash-head.js";
import { useCourseRules } from "../course-rules/use-course-rules.js";
import { AssistFormPanelView, AssistTaskStatus, InlineExplanationAskView, StubbornCue, useAssistPanelState } from "./AssistFormPanel.jsx";
import { fixSuggestionFor } from "../card-fix.js";
import reviewCss from "./review.css";
import coachCss from "../coach.css";
import { useInjectCss } from "../shared.js";
import { RubricAnswer, ScenarioPanel } from "../CaseWorkspace.jsx";
import TaskCardRun from "../TaskCardRun.jsx";
import { WrongAnswerSource } from "../document-preview/practice/ReadingReturn.jsx";
import { NextDue } from "../NextDue.jsx";
import { buildFeedbackAnnouncement, useQuestionRunA11y } from "./usePinQuestion.js";
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
import LazyFlowSealCue from "../seal-press/LazyFlowSealCue.jsx";

export { formatAssistTaskSummary, buildFeedbackAnnouncement };

/* A failed background-assistant task. A model failure goes through the one model note: a key or model problem points to the settings
   (sending the same request again cannot work, so there is no 重新提交), a busy or slow service keeps 重新提交. Anything else is about the
   content: the plain line, 重新提交, and 改一改再提交 when there is a question to edit. */
function AssistFailure({ task, modelReady = false, onSettings, onResubmit, onEdit }) {
  const busy = useStudyBusy();
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

const ASSIST_COPY = {
  askNote: () => ui("提交后才启动后台助教。讲解会出现在这道题下面的问答里，完成时信箱会提醒你；做题和主会话可以继续。"),
  improveLabel: () => ui("这道题哪里不好？后台助教会直接改这张卡，改完可在信箱里一步撤销"),
};

const renderThinkingField = (assistMode, thinkingNote, setThinkingNote, mainField) => (
  <>{mainField}{assistMode === "ask" && (
    <label className="assist-form__field assist-form__thinking">{ui("刚才卡在哪一步 / 是怎么想的？（选填）")}
      <TextInput type="text" className="assist-form__thinking-input" data-thinking-note="" value={thinkingNote} maxLength={200}
        placeholder={ui("用一句话记下刚才卡住的思路，便于后续精准提醒")} onChange={(event) => setThinkingNote(event.target.value)} /></label>)}</>
);

/** Extracted assist form owning its own typing/chip state so keystrokes never re-render QuestionRun, with async identity guards across card switches. */
const AssistFormPanel = React.memo(function AssistFormPanel(props) {
  const submitAssistAct = async (mode, trimmed, originChoices, originExtra) => {
    const originKey = props.entryKey;
    const originPrereqs = props.run.prerequisites;
    const ok = await props.assistAct(mode, trimmed, originChoices, originExtra);
    if (!ok || props.activeEntryKeyRef.current !== originKey) return false;
    if (mode === "ask" && originChoices.includes("prerequisite") && originPrereqs?.length) props.studyPrerequisites(originPrereqs);
    return true;
  };
  return <AssistFormPanelView {...props} copy={ASSIST_COPY} submitAssistAct={submitAssistAct} renderThinkingField={renderThinkingField} />;
});

/** In-place follow-up composer at the bottom of the explanation so learners never need to scroll back up to ask why. */
const InlineExplanationAsk = React.memo(function InlineExplanationAsk(props) {
  return <InlineExplanationAskView {...props} />;
});

export default function QuestionRun({ session, data, coachProps, links = {}, context = {}, feedback, place: placeProp, inline = false }) {
  useInjectCss(reviewCss, "study-review");
  useInjectCss(coachCss, "study-coach");
  useInjectCss(companionsCss, "study-companions");
  const liveSession = useLiveSession(session);
  const { run, entry, showBack, showEn, autoTerms, enBusyKey, autoTermsBusyKey, keyGrade, pendingAnswer, choice, isCloze, autopilot, actions } = liveSession;
  const { selected, hint, explain, response, clozeValues } = entry;
  const { reviewAct, choose, flipCard, assistCard: assistAct, slayCard, studyPrerequisites, toggleEn, toggleAutoTerms } = actions;
  const { call, act, openModal, openSettings, notify } = useStudyServices();
  const busy = useStudyBusy();
  const entryKey = reviewEntryKey(run);
  const activeEntryKeyRef = React.useRef(entryKey);
  activeEntryKeyRef.current = entryKey;
  const activePending = pendingAnswer && pendingAnswer.key === entryKey ? pendingAnswer : null;
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
  const { assistMode, assistSeed, assistTextSetterRef, setAssistPanel, closeAssist, setAssistMode, setAssistTextForVoice, setInlineAskState, inlineAskOpen } = useAssistPanelState(entryKey, activeEntryKeyRef);
  const thumbsRef = React.useRef(null);
  const [thumbState, setThumbState] = React.useState({ vote: null, tags: [] });
  const thumbVote = thumbState.vote;
  const [dismissedTaskId, setDismissedTaskId] = React.useState("");
  const hasSessionExplainHidden = typeof liveSession.explainHidden === "boolean";
  const [localExplainState, setLocalExplainState] = React.useState({ key: "", hidden: false });
  const hasFeedback = !!run.feedback;
  const explainResetKey = `${entryKey}:${hasFeedback ? 1 : 0}`;
  const localExplainHidden = localExplainState.key === explainResetKey && localExplainState.hidden;
  const setLocalExplainHidden = React.useCallback((hidden) => setLocalExplainState({ key: explainResetKey, hidden: !!hidden }), [explainResetKey]);
  const isFeedbackHidden = hasSessionExplainHidden ? liveSession.explainHidden : localExplainHidden;
  const showSolution = !!(run.solution && (run.feedback ? !isFeedbackHidden : explain));
  const answeredWrong = !!run.feedback && !run.feedback.selfReported && run.feedback.assessment !== "self-report"
    && (run.feedback.correct === false || (Number.isInteger(run.feedback.grade) && run.feedback.grade < 3));
  const showUnansweredFollowups = !run.revealed && !showSolution && run.mode !== "exam" && !!(explain || entry.assistance?.askedTutorBeforeAnswer) && (run.followups?.length ?? 0) > 0;
  const voteMoments = voteTipMoments(thumbVote, thumbState.tags, !!run.feedback);
  // The three first-use tips under the question (#948): which one shows, if any, is ui/guidance/practice-tips.js; it says nothing before the learner has acted.
  const practiceTip = usePracticeTip({ run, assistMode, tourRunning: !!tourRunning, modelReady: model.ready, votedDown: voteMoments.votedDown, tooHard: voteMoments.tooHard,
    answerShown: run.mode !== "exam" && ((showSolution && (run.solution?.followups?.some((item) => item?.kind !== "terms") ?? false)) || (showUnansweredFollowups && (run.followups?.some((item) => item?.kind !== "terms") ?? false))) });
  const [clozeFocusTick, setClozeFocusTick] = React.useState(0);
  const [termListOpen, setTermListOpen] = React.useState(false);
  const reviewBodyRef = React.useRef(null);
  const inlineTips = useNarrow(reviewBodyRef, 520);
  const besideFollowup = inlineTips && practiceTip.tip === PRACTICE_TIP.prereq;
  const tip = practiceTip.tip && <PracticeTip id={practiceTip.tip} inline={inlineTips} onClose={practiceTip.close} onShown={practiceTip.onShown} />;
  const socratic = useSocraticInlineState({ run, closeAssist, reviewBodyRef });
  const choiceFeedbackRef = React.useRef(null);
  const verdictFocusRef = React.useRef(null);
  const prereqListId = React.useId();
  const [prereqOpenKey, setPrereqOpenKey] = React.useState("");
  const prereqOpen = prereqOpenKey === entryKey;
  const togglePrereq = () => setPrereqOpenKey((cur) => (cur === entryKey ? "" : entryKey));
  const { autoAdvanceMs, autoAdvanceActive, autoAdvancePaused, hoverPauseRef, syncAutoPause } = useAutopilotPause({ session: liveSession, coachProps, reviewBodyRef });
  const fixPhrases = useFixPhrases(data);
  const ruleDeck = React.useMemo(() => data?.decks?.find((deck) => deck.id === run.deckId), [data?.decks, run.deckId]);
  const termCourseName = ruleDeck?.course ?? ruleDeck?.folder ?? (typeof run?.course === "string" ? run.course : run?.course?.name) ?? "";
  const courseRules = useCourseRules(data, ruleDeck?.course ?? ruleDeck?.folder ?? "");
  const termMarks = useTermMarking({ session: liveSession, reviewBodyRef, notify, call, courseName: termCourseName, assistTasks });
  const openTermListDialog = () => { termMarks.refreshCourseTerms(); setTermListOpen(true); };
  const chapterHint = useChapterHint({ run, cardPlace, allFollowups, currentTerms: termMarks.terms, tipShown: practiceTip.tip, tourRunning: !!tourRunning });
  const { cardTasks, runningTermsTasks, otherRunningTasks, lastTask, inFlightTerms, runningTask, applyMarkedTerms } = useTermSubmitQueue({
    assistTasks, cardId: run.card?.id, modelReady: model.ready, setAssistMode, noteFillTerms: chapterHint.noteFillTerms, assistAct,
  });
  React.useEffect(() => { setClozeFocusTick(0); setTermListOpen(false); }, [run.id, run.index, run.card?.id]);
  useAssistWatch({ session: liveSession, assistTasks, cardId: run.card?.id });
  const readingStyle = useReadingProps().style || {};
  const readingMeasure = readingStyle["--reading-measure"];
  const cardScale = Math.round((parseFloat(readingStyle["--reader-size"]) / 16 || 1) * 100) / 100;
  const rubricCard = run.card?.kind === "open" && !!run.card.rubricCriteria?.length;
  const taskCard = run.mode !== "flashcard" && run.card?.kind === "task";
  const flashHead = useFlashHead(!choice && !isCloze && !rubricCard && !taskCard);
  const gradeTask = cardTasks.filter((task) => task.mode === "grade").at(-1);
  // The bar is pinned to the bottom while an answer is shown or one is being graded: what takes the focus under it then stops above it (review.css).
  const barGrading = !!(rubricCard && (run.grading || gradeTask?.status === "running"));
  const barStuck = !!run.feedback || barGrading;
  const barRoom = useStickyRoom("--review-bar-room", ".question-area");
  const liveAnnouncement = useQuestionRunA11y({ entryKey, run, hasFeedback, choice, isCloze, gradeTask, autoAdvanceActive, reviewBodyRef, choiceFeedbackRef, verdictFocusRef });
  const voice = useVoiceAnswer({ session: liveSession, data, model, rubricCard, setAssistMode, setAssistText: setAssistTextForVoice });
  const roundSteps = useRoundSteps({ session: liveSession, run, sources: data?.sources, openModal, onNote: onMakeNote, toggleFocus: toggleCardFocus, toggleSocratic: socratic.toggle, voiceKeys: voice.keys,
    focusCloze: isCloze && !run.feedback && !busy ? () => setClozeFocusTick((n) => n + 1) : undefined });
  const { caseSource, caseHighlights, saveHighlights } = useCaseHighlights({ run, data, call });
  const cardNotes = data?.noteBadges?.[run.card?.id] || [];
  const companionTarget = React.useMemo(() => (run.mode !== "exam" && run.revealed
    ? resolveCompanionTarget({
      card: run.card,
      solution: run.solution,
      courses: data?.courses,
      sources: data?.sources,
      fallbackCourse: ruleDeck?.course ?? ruleDeck?.folder ?? "",
    })
    : null), [run.mode, run.revealed, run.card, run.solution, data?.courses, data?.sources, ruleDeck]);
  // The round's own size and the re-ask, said by one function (the round model puts `position` on the run, #660).
  const position = roundAt(run), words = roundWords(position);
  const prereqSummary = run.prerequisites?.length > 0
    ? uiFormat("前置题 {0} · 已掌握 {1}", [run.prerequisites.length, run.prerequisites.filter((p) => !["new", "weak"].includes(p.level)).length])
    : "";
  const prereqStrip = run.prerequisites?.length > 0 && !run.complete && (
    <div className="prereq-strip">
      <div className="prereq-strip__head">
        <DisclosureToggle
          className="prereq-strip__toggle"
          open={prereqOpen}
          onToggle={(next) => setPrereqOpenKey(next ? entryKey : "")}
          controls={prereqListId}
          label={foldLabel(prereqOpen, prereqSummary)}
        />
        <span className="prereq-strip__label" onClick={togglePrereq}>{prereqSummary}</span>
        {(() => {
          const unlearned = run.prerequisites.some((p) => ["new", "weak"].includes(p.level));
          return (
            <Button
              className="prereq-strip__action"
              variant={unlearned ? "primary" : "secondary"} size="sm" iconEnd="arrow-right"
              lock={busy}
              title={unlearned ? ui("先学没掌握的前置题，学完回到这道题") : ui("把前置题再过一遍自查，做完回到这道题")}
              onClick={() => studyPrerequisites(run.prerequisites)}
            >
              {unlearned ? ui("先学前置") : ui("自查前置")}
            </Button>
          );
        })()}
      </div>
      {prereqOpen && (
        <ul id={prereqListId}>
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
      )}
    </div>
  );
  return (
    <div className={"review-body" + (termMarks.marking ? " is-marking" : "") + (socratic.open ? " has-socratic" : "")} ref={reviewBodyRef}>
      <div className="sh-visually-hidden" role="status" aria-live="polite" aria-atomic="true" data-live-announcer="question-run">
        {liveAnnouncement}
      </div>
      <div
        className={
          "question-area " +
          (!choice && !isCloze && !rubricCard && !taskCard ? "flash-area" : "") +
          (caseSource ? " has-case" : "")
        }
        data-bar-stuck={barStuck ? "true" : undefined}
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
                <LazyFlowSealCue run={run} variant="header" />
              </span>
              <div>
                <QuestionMetaBadges run={run} sources={data?.sources} cardNotes={cardNotes} onOpenNote={onOpenNote} />
                {!!publicationIssues.length && !run.card.publicationUngrable &&
                  <Popover label={ui("待核对")} className="publication-mark" panelClassName="publication-mark__panel"
                    trigger={({ props, ref }) => <Button ref={ref} variant="link" size="sm" className="publication-mark__trigger" {...props}>{ui("待核对")}</Button>}>
                    <p>{publicationIssues.join("；")}</p>
                    <Button size="sm" onClick={() => assistAct("improve", uiFormat('发布检查发现：{0}', [publicationIssues.join('; ')]))}>{ui("交给后台修题")}</Button>
                  </Popover>}
                {run.card.flag
                  ? <Tooltip layer content={uiFormat("已标记：{0}", [run.card.flag])}><Button icon="flag" variant="quiet" size="sm" aria-label={ui("已标记题目，点击查看或修改")} aria-pressed={!!run.card.flag} className="sh-btn--icon question-meta__action is-active" onClick={() => openModal({ type: "flag" })} /></Tooltip>
                  : <Tooltip layer content={ui("标记题目")}><Button icon="flag" variant="quiet" size="sm" aria-label={ui("标记题目")} aria-pressed={!!run.card.flag} className="sh-btn--icon question-meta__action" onClick={() => openModal({ type: "flag" })} /></Tooltip>}
              </div>
            </div>
            <ProgressBar size="sm" className="card-progress" label={ui("复习进度")} value={position.at} max={Math.max(1, position.total)} />
          </div>
          {(choice || isCloze || run.card.publicationUngrable) && prereqStrip}
          {run.card.publicationUngrable ? (
            <Banner tone="warning" role="status" className="review-ungrable"
              action={{ label: ui("跳过此题，不计成绩"), variant: "primary", iconEnd: "arrow-right", disabled: busy, onClick: () => reviewAct("review.skip") }}
              secondary={{ label: ui("交给后台修题"), disabled: busy, onClick: () => assistAct("improve", uiFormat('发布检查发现：{0}', [publicationIssues.join('; ')])) }}>
              <div className="question" tabIndex={-1} data-question-heading=""><Markdown text={run.card.prompt || ui("题干尚未填写")} /></div>
              <p>{ui("这道题缺少可判分内容。你可以交给助教修改，或跳过；跳过不会记录成绩或改变复习进度。")}</p>
              {!!publicationIssues.length && <p>{publicationIssues.join("；")}</p>}
            </Banner>
          ) : choice ? (
            <>
              <div className="question" role="heading" aria-level={2} tabIndex={-1} data-question-heading="" key={"stem:" + reviewEntryKey(run)}>
                <Markdown text={run.card.prompt} />
                {enOn && enStem?.prompt && <EnBlock text={enStem.prompt} />}
              </div>
              {run.card.multiple && (
                <p className="muted small">{ui("多选题 · 选出所有符合条件的选项")}</p>
              )}
              {verdict && !run.feedback && <p className="muted small">{ui("判断题 · 这句话说得对不对？按 1 选对，按 2 选错")}</p>}
              <ChoiceFeedback ref={choiceFeedbackRef} card={run.card} options={run.card.options} feedback={run.feedback} solution={run.solution} multiple={multiple} />
              <div className={"options" + (verdict ? " options--verdict" + (run.feedback ? " options--answered" : "") : "")} key={"options:" + reviewEntryKey(run)}>
                {run.card.options.map((o, i) => {
                  const solution = run.solution?.options?.find(
                    (x) => x.id === o.id,
                  );
                  const picked = run.feedback?.selected?.includes(
                    o.id,
                  );
                  const pendingSelected = !run.feedback && activePending?.kind === "choice" && activePending.selected?.includes(o.id);
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
                          : selected.includes(o.id) || pendingSelected
                            ? "option--selected" + (pendingSelected ? " option--pending" : "")
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
            <ClozeQuestion run={run} clozeValues={clozeValues} clozeFocusTick={clozeFocusTick} enOn={enOn} enStem={enStem} enAnswer={enAnswer} voiceAnswer={voice.answer} actions={actions} pendingCloze={activePending?.kind === "cloze"} />
          ) : taskCard ? (
            <>
              <TaskCardRun key={`task:${run.id}:${run.index}:${run.card.id}`} run={run} data={data} value={response} onChange={actions.setResponse} onReveal={() => reviewAct("review.reveal")}
                onSelfReport={(note) => reviewAct("review.answer", { selfReport: true, ...(note ? { note } : {}) })} enOn={enOn} enStem={enStem} enAnswer={enAnswer} />
              {prereqStrip}
            </>
          ) : rubricCard ? (
            <>
              <RubricAnswer key={`rubric:${run.id}:${run.index}:${run.card.id}`} run={run} data={data} value={response} onChange={actions.setResponse} task={gradeTask} onRefreshRun={session.pollNow}
                onSubmit={(text) => assistAct("grade", text, [], undefined, { quiet: true })} onSetupModel={onModelSettings || (() => openSettings("settings-model"))} />
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
                    {/* Only what grading needs (#1697): the keys of flipping back (Space) and of the explanation (H) are in the ? sheet, and the card's face says which side is up. */}
                    <small className="grading-head__meta">
                      {ui("按 0–5 评分")}
                      {run.intervals && <>{" · "}<Tooltip layer content={`${ui("每个按钮下面是选它以后，隔多久再复习这道题。间隔按上次复习到现在实际隔了几天来算：没到期就复习，间隔涨得少；当天重复答，间隔不再变长。")} ${ui("0–2 分未达标会留在本题看解析，其中 0–1 分还会在本轮末尾再练一次，2 分不重排本轮。")}`}>
                      <span tabIndex={0} className="grade-gaps-tip">{ui("下面是下次复习的间隔")}</span>
                    </Tooltip></>}</small>
                  </div>
                  <div className="grade-scale" role="group" aria-label={ui("掌握程度评分")}>
                    {[
                      {
                        key: "fail",
                        label: ui("未达标 · 留在本题看解析"),
                        grades: [
                          { grade: 0, label: ui("完全忘记") },
                          { grade: 1, label: ui("记得一点") },
                          { grade: 2, label: ui("有印象") },
                        ],
                      },
                      {
                        key: "pass",
                        label: ui("达标"),
                        grades: [
                          { grade: 3, label: ui("勉强答对") },
                          { grade: 4, label: ui("熟练") },
                          { grade: 5, label: ui("轻松掌握") },
                        ],
                      },
                    ].map((group) => (
                      <div key={group.key} className={`grade-group grade-group--${group.key}`} role="group" aria-label={group.label}>
                        <span className="grade-group__label">{group.label}</span>
                        <div className="grade-group__buttons">
                          {group.grades.map(({ grade, label }) => {
                            const gap = formatGap(run.intervals?.[grade]);
                            const retryHint = !run.retry && grade <= 1
                              ? (gap ? uiFormat("本轮末尾重练 · {0}", [gap]) : ui("本轮末尾重练"))
                              : grade === 2
                                ? (gap ? uiFormat("{0} · 不重排本轮", [gap]) : ui("明日再练（不重排本轮）"))
                                : gap;
                            // The same words on the button, with the gap ("1 天") kept on one line: a number never ends one line and its unit starts the next (#1697).
                            const gapWords = gap ? <span className="grade-gap__time">{gap}</span> : null;
                            const retryWords = !gap ? retryHint
                              : !run.retry && grade <= 1 ? uiRich("本轮末尾重练 · {0}", gapWords)
                                : grade === 2 ? uiRich("{0} · 不重排本轮", gapWords) : gapWords;
                            const tip = !run.retry && grade <= 1
                              ? uiFormat("快捷键 {0}：{1}（本轮末尾重练）", [grade, label])
                              : grade === 2
                                ? uiFormat("快捷键 {0}：{1}（明日再练，不重排本轮）", [grade, label])
                                : uiFormat("快捷键 {0}：{1}", [grade, label]);
                            const pressed = keyGrade === grade || (activePending?.kind === "grade" && activePending.grade === grade);
                            const gradeAriaLabel = grade >= 3
                              ? (gap ? uiFormat("{0} 分：{1}，{2}后再复习", [grade, label, gap]) : uiFormat("{0} 分：{1}", [grade, label]))
                              : (retryHint ? uiFormat("{0} 分：{1}，{2}", [grade, label, retryHint]) : uiFormat("{0} 分：{1}", [grade, label]));
                            // The tooltip says the key (#745); a number key answers from the session, which marks the button it named (keyGrade).
                            return (
                              <Tooltip key={grade} layer content={tip} anchorClassName="grade-tip">
                                <button
                                  className={"grade " + (grade < 3 ? "low" : grade === 3 ? "high warn" : "high") + (pressed ? " is-key-pressed" : "") + (voice.suggested === grade ? " is-suggested" : "")}
                                  data-grade={grade}
                                  aria-label={gradeAriaLabel}
                                  aria-keyshortcuts={String(grade)}
                                  data-usage="review.grade"
                                  disabled={busy}
                                  onClick={() => reviewAct("review.answer", { grade })}
                                >
                                  <strong>{grade}</strong>
                                  <span>{label}</span>
                                  {retryHint && <small className="grade-gap">{retryWords}</small>}
                                </button>
                              </Tooltip>
                            );
                          })}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}
              </SmoothHeight>
              {/* A flashcard's header floats over the card faces, so the strip goes below the card. */}
              {prereqStrip}
            </>
          )}
          {/* Post-answer SRS summary & stubborn-card cue at the foot of the card; deep FSRS telemetry folds under 更多解析与巩固方式. */}
          {voice.correction}
          {run.feedback && (
            <div ref={verdictFocusRef} className="next-due-focus" tabIndex={-1}>
              <NextDue feedback={run.feedback} telemetry={run.feedbackTelemetry} hideWhy className="next-due--verdict" />
              <LazyFlowSealCue run={run} variant="verdict" />
            </div>
          )}
          {canOpenBookSection && run.feedback && !run.feedback.selfReported && !isPassed(run) && (
            <div className="question-book-link">
              <Button variant="link" size="sm" iconEnd="arrow-right" data-usage="review.book-section" data-tour="review-book-section" data-book-section-link="feedback" lock={busy}
                onClick={() => onOpenBookSection(cardPlace)}>
                {ui("读全书这一节")}
              </Button>
            </div>
          )}
          {run.feedback && run.mode !== "exam" && !run.complete && run.stubborn && (run.stubborn.isLeech || (answeredWrong && run.stubborn.missCount >= 2)) && (
            <StubbornCue stubborn={run.stubborn} onAsk={() => setAssistPanel("ask", { choices: ["plain", "mistake"] })} onImprove={() => setAssistPanel("improve")} />
          )}
          <SocraticWrongNudge show={answeredWrong && socratic.allowed && !socratic.open} entryKey={entryKey} dismissedKey={socratic.dismissedKey} onToggleSocratic={socratic.activate} onDismiss={socratic.setDismissedKey} />
          {autoAdvanceActive && (
            <div className={"question-card__autopilot" + (autoAdvancePaused ? " is-paused" : "")}
              key={"card-auto:" + (session.advanceKey || run.index)}
              style={{ "--autopilot-ms": `${autoAdvanceMs}ms` }}
              aria-hidden="true">
              <span className="question-card__autopilot-fill" />
            </div>
          )}
        </div>
        <div className="review-sticky-bar" ref={barStuck ? barRoom : undefined} data-answered={run.feedback ? "true" : undefined} data-grading={barGrading ? "true" : undefined}>
          {contextReturnLabel && <Button variant="quiet" size="sm" icon="arrow-left" className="review-detour" lock={busy} onClick={onReturnContext}>{contextReturnLabel}</Button>}
          {detour && !contextReturnLabel && <Tooltip layer content={ui("回到从信箱跳过来之前正在做的题")} anchorClassName="review-detour">
            <Button variant="quiet" size="sm" icon="arrow-left" className="review-detour__button" lock={busy} onClick={onReturnFromDetour}>{uiFormat("回到之前的第 {0} 题", [detour.index + 1])}</Button></Tooltip>}
          <ReviewToolbar
            key={`${run.id}:${run.index}:${run.card?.id}`}
            assistMode={assistMode}
            socraticOpen={socratic.open}
            onToggleSocratic={socratic.allowed ? socratic.toggle : undefined}
            markingTerms={termMarks.marking}
            onToggleMarkTerms={termMarks.toggleMarking}
            run={run} expanded={(run.revealed || showBack) ? explain : hint} revealed={!!(run.revealed || showBack)}
            onToggleHelp={actions.toggleHelp}
            onAsk={() => setAssistMode((m) => (m === "ask" ? "" : "ask"))}
            onImprove={() => setAssistMode((m) => (m === "improve" ? "" : "improve"))}
            onDerive={() => setAssistMode((m) => (m === "derive" ? "" : "derive"))}
            onTermList={run.mode !== "exam" && termMarks.courseName ? openTermListDialog : undefined}
            onSlay={slayCard} onToggleFocus={run.mode !== "exam" ? toggleCardFocus : undefined}
            onDeferUnstudiedPages={canDeferPages ? deferUnstudiedPages : undefined}
            onReviewAction={reviewAct}
            onNote={onMakeNote}
            onTask={onMakeTask}
            enOn={enOn}
            enBusy={!!enBusyKey && enBusyKey === entryKey}
            onToggleEn={toggleEn}
            autoTerms={!!autoTerms}
            autoTermsBusy={!!autoTermsBusyKey && autoTermsBusyKey === reviewEntryKey(run)}
            onToggleAutoTerms={toggleAutoTerms}
            autopilot={autopilot} onToggleAutopilot={actions.toggleAutopilot}
            selfGradeAdvance={liveSession.selfGradeAdvance} onToggleSelfGradeAdvance={actions.toggleSelfGradeAdvance}
            onUndo={actions.undoAnswer}
            autoAdvanceActive={autoAdvanceActive} autoAdvancePaused={autoAdvancePaused} autoAdvanceMs={autoAdvanceMs}
            onSkip={roundSteps.onSkip} onEndRound={roundSteps.onEnd}
            thumbVote={thumbVote} onThumb={coachProps && run.mode !== "exam" ? (vote) => thumbsRef.current?.[vote === "up" ? "up" : "down"]() : undefined}
            thumbs={coachProps && run.mode !== "exam" && (
              <ThumbFeedback ref={thumbsRef} buttons={false} run={run} canShortcut={coachProps.canShortcut} onInteract={coachProps.cancelAutoAdvance}
                onSent={(r) => r.scheduled?.length && coachProps.onStatus()} onVote={(vote, tags = []) => setThumbState({ vote, tags })}
                onFix={(tags) => setAssistPanel("improve", { text: fixSuggestionFor(tags) })} courseRules={courseRules} />
            )}
          />
          <RoundEndConfirm session={liveSession} />
          {!assistMode && <div className="action-feedback-slot">{feedback}</div>}
        </div>
        {!besideFollowup && tip}
        {/* A stem that asks what the source says tests memory of a document's wording, not the concept: say so and offer the fix, so the learner never has to find the words. */}
        {!assistMode && !runningTask && run.mode !== "exam" && asksWhatTheSourceSays(run.card?.prompt) && (
          <p className="assist-status voice-hint" role="status">
            {ui("这道题在问「资料怎么说」，考的是背资料的措辞，不是理解或应用。")}{" "}
            <Button variant="link" size="sm" data-usage="review.voice-fix" lock={busy} onClick={() => assistAct("improve", ui(SOURCE_VOICE_FIX))}>{ui("改成概念或情景题")}</Button>
          </p>
        )}
        <TermChips terms={termMarks.terms} inFlightTerms={inFlightTerms} candidates={termMarks.candidates} onRemove={termMarks.removeTerm} onMarkCandidate={termMarks.markCandidate}
          onFill={applyMarkedTerms} onTermList={run.mode !== "exam" && termMarks.courseName ? openTermListDialog : undefined}
          hasCourse={Boolean(termMarks.courseName)} running={runningTermsTasks.length > 0} />
        {termListOpen && termMarks.courseName && (
          <TermListDialog courseName={termMarks.courseName} items={termMarks.courseTerms} loading={termMarks.loadingCourseTerms}
            error={termMarks.courseTermsError} onRemove={termMarks.removeCourseTerm} onClear={termMarks.clearCourseTerms}
            onClose={() => setTermListOpen(false)} />
        )}
        {chapterHint.visible && <ChapterHint run={run} sources={data?.sources} decks={data?.decks} openModal={openModal} cardPlace={cardPlace} terms={chapterHint.terms} deeper={chapterHint.deeper} onDismiss={chapterHint.dismiss} onDismissForever={chapterHint.mute} />}
        <SmoothHeight className="assist-area">
          {assistMode && (
            <AssistFormPanel key={`assist:${entryKey}:${assistMode}`} mode={assistMode} seed={assistSeed} entryKey={entryKey}
              activeEntryKeyRef={activeEntryKeyRef} run={run} model={model} modelSettings={modelSettings} feedback={feedback}
              fixPhrases={fixPhrases} courseRules={courseRules} voiceAskButton={voice.askButton} assistAct={assistAct}
              studyPrerequisites={studyPrerequisites} reviewBodyRef={reviewBodyRef} textSetterRef={assistTextSetterRef}
              onClose={closeAssist} onOpenSocratic={socratic.allowed ? socratic.activate : undefined} />
          )}
          {inFlightTerms.length > 0 && (
            <p className="assist-status" role="status">
              <span className="assist-status__spinner" aria-hidden="true"><Spinner size="sm" /></span>
              <span className="assist-status__text">
                {uiFormat("后台助教正在补词：{0}", [formatAssistTaskSummary({ mode: "terms", terms: inFlightTerms })])}
              </span>
            </p>
          )}
          {otherRunningTasks.map((task) => (
            <p key={task.id} className="assist-status" role="status">
              <span className="assist-status__spinner" aria-hidden="true"><Spinner size="sm" /></span>
              <span className="assist-status__text">
                {uiFormat(task.mode === "ask" ? "后台助教正在解答：{0}" : task.mode === "derive" ? "后台助教正在出新题：{0}" : "后台助教正在改题：{0}", [formatAssistTaskSummary(task)])}
              </span>
            </p>
          ))}
          <AssistTaskStatus runningTask={runningTask} lastTask={lastTask} assistMode={assistMode} dismissedTaskId={dismissedTaskId}
            modelReady={model.ready} modelSettings={modelSettings} assistAct={assistAct} setAssistPanel={setAssistPanel}
            setDismissedTaskId={setDismissedTaskId} FailureView={AssistFailure} />
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
              {(!run.feedback || answeredWrong) && run.solution.misconception && <>
                <h4>{ui("容易混淆的地方")}</h4>
                <Markdown text={run.solution.misconception} />
              </>}
              {!run.feedback && run.solution.rubric && <>
                <h4>{run.card?.kind === "task" ? ui("验收标准") : ui("评分依据")}</h4>
                <Markdown text={run.solution.rubric} />
              </>}
              <CitationDisclosure key={"citations:" + entryKey} card={run.solution} sources={data.sources}
                onOpenSource={(source, quote, peekPage) => openModal({ type: "source", source, quote, peekPage, back: true })} />
              <FigurePageLink key={"figure:" + entryKey} card={run.solution} sources={data.sources}
                onOpen={(source, quote, peekPage) => openModal({ type: "source", source, quote, peekPage, back: true })} />
              {!run.feedback && (choice || isCloze || rubricCard || taskCard) && companionTarget && openModal && (
                <div className="sh-comp-card-jump">
                  <Button size="sm" variant="quiet" iconEnd="arrow-right" onClick={() => openCompanionTarget(openModal, companionTarget)}>
                    {companionSlideButtonLabel(companionTarget)}
                  </Button>
                </div>
              )}
            </>}
            {run.mode !== "exam" && <ExplanationFollowup key={entryKey} run={run} readOnly cardNotes={cardNotes} deriveTip={besideFollowup ? tip : null}
              onDerive={(followupId, relation) => assistAct("derive", "", [], { relation, followupId })} deriving={!!runningTask}
              onAskMore={(event) => { const body = event?.currentTarget?.closest?.(".review-body"); setInlineAskState({ key: entryKey, open: true }); requestAnimationFrame(() => { body?.querySelector?.(".explanation-inline-ask--open")?.scrollIntoView?.({ behavior: "smooth", block: "nearest" }); }); }}
              bookQa={{ course: bookCourse, mode: qaToBook, onMode: setQaToBook, book, note: bookNote }}
              noteQa={onSaveQaToNote ? { savedIn: (followupId) => cardNotes.find((note) => note.qa && note.followupIds?.includes(followupId))?.noteId || "", onSave: onSaveQaToNote, onOpen: onOpenNote } : null}
              onOpenBookSection={canOpenBookSection ? () => onOpenBookSection(cardPlace) : undefined} />}
            {showSolution && run.mode !== "exam" && (
              <InlineExplanationAsk key={`inline-ask:${entryKey}`} open={inlineAskOpen} hasFollowups={allFollowups.length > 0}
                hasFeedback={!!run.feedback} entryKey={entryKey} activeEntryKeyRef={activeEntryKeyRef} model={model}
                modelSettings={modelSettings} assistAct={assistAct}
                onExpand={() => setInlineAskState({ key: entryKey, open: true })} onClose={() => setInlineAskState({ key: entryKey, open: false })} />
            )}
            {showSolution && (allFollowups.length > 0 || (run.solution?.explanation?.length || 0) >= 280) && (
              <div className="explanation-foot">
                <Button variant="quiet" size="sm" onClick={() => {
                  if (run.feedback && !hasSessionExplainHidden) setLocalExplainHidden(true);
                  else actions.toggleHelp();
                  requestAnimationFrame(() => reviewBodyRef.current?.querySelector?.(".question-card")?.focus?.({ preventScroll: true }));
                }}>{ui("收起解析 (H)")}</Button>
              </div>
            )}
          </ReadingBlock>
        )}
        {((answeredWrong && !run.returnTo) || Boolean(run.similarFor)) && run.mode !== "exam" && !entry.teaching?.complete && (
          <div className="post-answer-wrong-try"><LazySimilarTry session={liveSession} data={data} model={model} onModelSettings={modelSettings} /></div>
        )}
        <PostAnswerDetails session={liveSession} data={data} model={model} onModelSettings={modelSettings} openModal={openModal} showSolution={showSolution} verdict={verdict} enOn={enOn} enAnswer={enAnswer} defaultOpen={!!inline} misconceptionShownAbove={answeredWrong} similarShownAbove={answeredWrong && !run.returnTo} nextDueNode={run.feedback ? <NextDue feedback={run.feedback} telemetry={run.feedbackTelemetry} whyOnly /> : null} />
        <TeachingPanel session={liveSession} data={data} model={model} onModelSettings={modelSettings} />
      </div>
      {socratic.open && <LazySocraticInlineDrawer key={`socratic:${run.deckId}:${run.card.id}`} deckId={run.deckId} cardId={run.card.id} runId={run.id} prompt={run.card.prompt || ""} topic={run.card.topic || ""} modelReady={model.ready} cardAnswered={socratic.cardAnswered} retryQueued={socratic.retryQueued} onClose={socratic.close} onCloseToQuestion={socratic.returnToQuestion} onNotify={notify} />}
    </div>
  );
}
