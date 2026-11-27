import { ui, uiFormat, errorMessage } from "./i18n.js";
import React from "react";
import ReviewNavigator from "./ReviewNavigator.jsx";
import RunContext from "./review/RunContext.jsx";
import QuestionPlace, { useCardPlace } from "./review/QuestionPlace.jsx";
import QuestionRun from "./review/QuestionRun.jsx";
import usePinQuestion from "./review/usePinQuestion.js";
import CoachDebrief from "./CoachDebrief.jsx";
import ResultBreakdown from "./ResultBreakdown.jsx";
import { ReadingSettingsButton } from "./reading-settings/ReadingSettings.jsx";
import resultCss from "./review-results.css";
import DailyRecap from './DailyRecap.jsx';
import { Badge, Button, PageHeader, Tooltip } from "./components/index.js";
import { cx } from "./components/css.js";
import { uiRich } from "./i18n-rich.jsx";
import { StudyServicesContext, useStudyBusy, useStudyServices } from "./study-context.jsx";
import { AppContext, readerOpen } from "./app/app-context.js";
import { HandOff } from "./hand-off/HandOff.jsx";
import reviewCss from "./review/review.css";
import { useInjectCss } from "./shared.js";
import { MasteryChange, ReadingBackButton, ReadingResult, ReturnPrimary } from "./document-preview/practice/ReadingReturn.jsx";
import { practiceArgs } from "./learning-navigation.js";
import { isBackDestination, wayBackOf } from "./review/way-back.js";
import { freshRoundCount, resolvePracticeSettings } from "../lib/practice-settings.js";
import { countMaterials } from "../lib/source-groups.js";
import { openReaderForPages, readableMaterialItems } from "./document-preview/practice/open-reader-pages.js";
import { currentMethodStage, resolveRoundCourse, roundEndAlternative, useMethodAlternativeOpen } from "./method-alternatives.js";
import { pageAvailable } from "./capabilities.js";
import { askForLeeches } from "./wrongbook-model.js";
import { keepBook } from "./book/model.js";
import RoundLookBack from "./review/RoundLookBack.jsx";
import { gradesOutstanding } from "./review/session-logic.js";
import RoundSetup from "./review/RoundSetup.jsx";
import { resultTarget } from "./review/round-setup.js";
import { similarWinsText } from "./review/similar-words.js";
import { useSourceDock } from "./review/use-source-dock.jsx";
import InkMark from "./seal-press/InkMark.jsx";
import LazyRoundSealSection from "./seal-press/LazyRoundSealSection.jsx";
import LetterpressNumber from "./letterpress/LetterpressNumber.jsx";
import LazyReviewFocusPill from "./review/LazyReviewFocusPill.jsx";
import { computeTodayPace, formatTodayPaceLine, useDailyGoal } from "./review/today-pace.js";
import { resolveTimerPrefs } from "../lib/board-model.js";
import PaceMeta from "./pace/PaceMeta.jsx";
import { buildSliceForecast } from "./pace/format-pace.js";

/* 复习视图：quiz/multi 选项作答、cloze 填空、闪卡翻面与开放问答自评，
   附前置题条、逐步讲解面板与薄弱主题收尾。会话状态（run）与本地作答
   状态由 useReviewSession 持有（ui/review/useReviewSession.js），本组件
   只负责渲染，交互经 session.actions 转发；服务（call、act、host、导航）来自 useStudy()。
   本组件是页面：页眉、左侧题号栏与本轮结果页；作答的题目本体在 ui/review/QuestionRun.jsx，别的页面也能挂它。 */

/**
 * props: session (useReviewSession: run, entry, actions ...), data (the library snapshot), shellTitle, feedback (the app's
 * one feedback region, drawn where it belongs on this page), coachProps (the debrief and thumbs controls, absent without a
 * library), links (ways out of the page: onBackToWorkflow, onCourseFlow, openSkeleton, onOpenNote, onMakeNote, onMakeTask,
 * onRecapSettings, onModelSettings, onReturnToReading) and context (the way back to where the learner came from:
 * label, onReturn, detour, onReturnFromDetour; kind and place say which page the trail leads to and, for the review book, the point left from).
 * A round started in the 复习全书 or on the 总纲 has that way back as its main button (ui/review/way-back.js); the page's own next step is then a second button
 * only when it goes on (the next batch, the rest of the scope), never when it is just another place to go back to.
 */
/* The score's words follow how the answers were measured, as the 点评 splits them: a choice is answered right, a flashcard is graded by the learner. */
function scoreWording(run) {
  const self = run.selfAnswered || 0;
  return self === 0 ? "道题答对 / {0} 道" : self >= (run.answered || 0) ? "道题自评达标 / {0} 道" : "道题达标 / {0} 道";
}

function courseSummaryText(course) {
  const finished = Array.isArray(course?.finished) ? course.finished : [];
  const totalChapters = course?.chapters ?? (Array.isArray(course?.segments) ? course.segments.length : 0);
  const doneChapters = course?.doneChapters ?? (Array.isArray(course?.segments)
    ? course.segments.filter((status) => status === "done").length
    : finished.length);
  if (finished.length > 0) {
    const first = finished[0];
    const weak = finished.reduce((sum, item) => sum + (Number(item?.weak) || 0), 0);
    if (finished.length === 1) {
      return weak === 0
        ? uiRich("「{0}」做完一遍，都答对过 · 全课 {1} 章，已过 {2} 章", <strong>{first.title}</strong>, totalChapters, doneChapters)
        : uiRich("「{0}」做完一遍，{1} 题还不稳 · 全课 {2} 章，已过 {3} 章", <strong>{first.title}</strong>, weak, totalChapters, doneChapters);
    }
    return weak === 0
      ? uiRich("「{0}」等 {1} 章做完一遍，都答对过 · 全课 {2} 章，已过 {3} 章", <strong>{first.title}</strong>, finished.length, totalChapters, doneChapters)
      : uiRich("「{0}」等 {1} 章做完一遍，{2} 题还不稳 · 全课 {3} 章，已过 {4} 章", <strong>{first.title}</strong>, finished.length, weak, totalChapters, doneChapters);
  }
  return (
    <>
      {uiRich("课程进度 · 已学 {0} 题", <strong>{course.learned ?? 0} / {course.cards ?? 0}</strong>)}
      {" · "}
      {course.chapter
        ? uiFormat("第 {0} / {1} 章「{2}」{3}/{4}", [course.chapter.index + 1, course.chapters, course.chapter.title, course.chapter.learned, course.chapter.total])
        : ui("全部章节都学过了")}
    </>
  );
}

const SEGMENT_TO_STATUS = { correct: "right", practice: "wrong", remaining: "unanswered" };
const STATUS_TO_SEGMENT = { right: "correct", wrong: "practice", unanswered: "remaining" };

export default function Review({ session, data, shellTitle, feedback, coachProps, links = {}, context = {} }) {
  useInjectCss(reviewCss, "study-review");
  const { run, choice, actions } = session;
  const { reviewAct } = actions;
  const study = useStudyServices();
  const busy = useStudyBusy();
  const { call, act, host, navigate, openSettings, notify } = study;
  const cardPlace = useCardPlace({ call, run });
  const [lookBackSegmentState, setLookBackSegmentState] = React.useState({ runId: null, segment: null });
  const lookBackSegment = lookBackSegmentState.runId === run?.id ? lookBackSegmentState.segment : null;
  const setLookBackSegment = (segment) => setLookBackSegmentState({ runId: run?.id ?? null, segment });
  const handleSelectSegment = (key) => {
    const mapped = SEGMENT_TO_STATUS[key] || null;
    const next = mapped && lookBackSegment === mapped ? null : mapped;
    setLookBackSegment(next);
    if (next) {
      requestAnimationFrame?.(() => {
        document.querySelector(".round-look-back")?.scrollIntoView?.({ behavior: "smooth", block: "nearest" });
      });
    }
  };
  const { onBackToWorkflow, openSkeleton, onOpenOutline, onOpenNote, onRecapSettings, onModelSettings, onReturnToReading } = links;
  const { label: contextReturnLabel, onReturn: onReturnContext, detour, onReturnFromDetour } = context;
  const enterRun = session.enterRun;
  const app = React.useContext(AppContext);
  const openAlt = useMethodAlternativeOpen({ data, enterRun });
  // 在右栏打开: busy until the sidebar has the run; when it cannot, say why (never a silent click).
  const [movingToSidebar, setMovingToSidebar] = React.useState(false);
  const moveToSidebar = async () => {
    // The sidebar opens the run from the library: what was just typed has to be there first.
    if (await session.flushDraft?.() === false) return;
    setMovingToSidebar(true);
    try { await host.openInSidebar(run.id); }
    catch (failure) { notify({ text: uiFormat("没能放进右栏：{0}", [errorMessage(failure)]), tone: "warning" }); }
    finally { setMovingToSidebar(false); }
  };
  // Where 继续学习 goes (the page decided it with today's plan in view): the coach card and this page's own way back share it.
  const destination = coachProps?.destination;
  useInjectCss(resultCss, "review-results");
  const pageRef = React.useRef(null);
  // A learning-flow practice round: the page is the same, only the way back differs.
  const flow = run.workflow && onBackToWorkflow ? run.workflow : null;
  /* Only a round of its own goes back to the book (or the 总纲) first: a round nested inside another (a prerequisite round, a detour from the inbox) has its own way on,
     and a round started from the reader (run.reading) goes back to the reader, with 回到阅读 as the one main button. */
  const wayBack = flow || detour || run.returnTo || run.reading || destination?.kind === "original" ? null : wayBackOf(context);
  /* A round started from the reader (run.reading) has the reader's way back, 回到阅读, as the one filled button of the result page, whatever else the trail knows. */
  const readingBack = !!(run.reading && onReturnToReading);
  const backHere = !!wayBack || readingBack;
  const returnLabel = flow ? ui("回到学习流") : wayBack ? wayBack.label : ui("返回学习库");
  usePinQuestion(pageRef, run);
  // 对照栏 (#1012): on a wide page a source opened from the question docks beside it (ui/review/use-source-dock.jsx); its openModal is the page's.
  const rail = !run.complete && run.navigation?.length > 0;
  const dock = useSourceDock({ pageRef, rail, run, sources: data?.sources, study, readerDialogOpen: readerOpen(app?.lib?.modal), modalOpen: !!app?.lib?.modal });
  const openModal = dock.services.openModal;
  const { docked: dockDocked, focusColumn: focusSourceColumn } = dock;
  React.useEffect(() => {
    if (!dockDocked) return undefined;
    const onKeyDown = (event) => {
      if (event.defaultPrevented || !event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
      if (event.code !== "Backquote" && event.key !== "`") return;
      const root = pageRef.current;
      if (!root) return;
      if (root.ownerDocument?.querySelector(".sh-dialog__backdrop, dialog[open]")) return;
      event.preventDefault();
      if (root.ownerDocument?.activeElement?.closest?.(".source-column")) {
        const card = root.querySelector(".review-body .question-card");
        if (card) {
          if (!card.hasAttribute("tabindex")) card.setAttribute("tabindex", "-1");
          card.focus({ preventScroll: true });
        }
      } else {
        focusSourceColumn();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [dockDocked, focusSourceColumn]);
  const rubricCard = run.card?.kind === "open" && !!run.card.rubricCriteria?.length;
  const skeletonHere = run.card ? data?.skeletons?.find((k) => k.cardIds.includes(run.card.id)) : null;
  // A finished round on a case set (WP12): its weak criteria become drills, or another case like it.
  const summaryCase = run.complete ? data?.decks?.find((deck) => deck.id === run.deckId && deck.format === "case-study") : null;
  const [caseNote, setCaseNote] = React.useState("");
  const nextFreshCount = run.freshRemaining ?? [...new Set((run.scope || []).map((scope) => scope.deckId))]
    .reduce((count, deckId) => count + (data?.progress?.[deckId]?.counts?.new || 0), 0);
  // 练习点评 (设置 › 练习) and its 前往设置: the result page says once that the 点评 asks the model, and where to switch that.
  const practice = resolvePracticeSettings(data?.settings?.practice);
  const goPracticeSettings = links.onPracticeSettings || (() => openSettings("settings-practice"));
  /* The one next step of a finished round, by what the round was: a learning flow, a detour, the question a prerequisite round came from, the next
     course batch or batch of new questions, else wherever the page decided 继续学习 goes. null: nothing to offer (a mock exam, no library). */
  // 继续下一批新题: one set of arguments for its button and for the 本轮设置 popover beside it (ui/review/round-setup.js resultTarget).
  const newBatchArgs = run.complete && run.mode === "new" && nextFreshCount > 0
    ? { mode: "new", scope: run.scope ?? [{ deckId: run.deckId }], count: freshRoundCount(data?.settings?.practice), ordered: true, fresh: true } : null;
  /* `back`: the step goes back to where the learner came from (回到学习流, 回到之前的第 N 题, 回到原题, 回到学习路径), so its button leads with ← like every way
     back; the rest step on and end in →. `path`: it is only the way back to the learning path, which a round with a way back of its own leaves out. */
  const nextStep = !run.complete ? null
    : flow ? { label: ui("回到学习流"), run: () => onBackToWorkflow(flow.sessionId), back: true }
      : detour ? { label: uiFormat("回到之前的第 {0} 题", [detour.index + 1]), run: onReturnFromDetour, back: true }
        : destination?.kind === "original" ? { label: destination.label, run: destination.go, back: true }
          : run.course?.next ? { label: ui("继续课程下一批"), run: () => act("review.start", { mode: "course", course: run.course.name, fresh: true }, enterRun) }
            : newBatchArgs ? { label: ui("继续下一批新题"), run: () => act("review.start", newBatchArgs, enterRun) }
              : destination ? { label: destination.label, run: destination.go, back: isBackDestination(destination), path: isBackDestination(destination) } : null;
  // With a way back as the main button (the book's, the 总纲's or the reader's), a next step that is just another place to go back to (回到学习路径) is left out: both would go back.
  const onward = backHere && nextStep?.path ? null : nextStep;
  // 本轮设置 (#1010): beside the next-round button, only where that button starts a round of the course or of the scope (the page decided it: ui/review/round-setup.js).
  /* One way back on the result page (#1073 round 8): the main button when it goes back (the book's, 回到学习路径 / 回到学习流 / 回到原题), else the context's way
     back beside a forward step; only when neither stands under the score does the header keep its 返回学习库. The foot's 回到学习目录 went to the same place. */
  const resultBack = run.complete && (backHere || !!onward?.back || !!(onward && contextReturnLabel));
  const roundSetup = onward && !backHere && !flow && !detour && !run.course ? resultTarget(run, destination, { newBatch: newBatchArgs }) : null;
  /* What went wrong comes first (#1687): a round with wrong answers has 重练这 N 道错题 as its one filled button and the next step, whatever it is, is the plain
     button after it. A round with a way back of its own keeps that way back as the filled button: the book, the 总纲 and the reader (backHere), a learning
     flow, a detour and a prerequisite round that goes back to its question (run.returnTo); the wrong ones are in 本轮题目 below. */
  const ownWayBack = backHere || !!flow || !!detour || !!run.returnTo || destination?.kind === "original";
  const wrongRefs = run.complete && run.mode !== "exam" && !ownWayBack && Array.isArray(run.missedCards)
    ? run.missedCards.map(({ deckId, cardId }) => ({ deckId, cardId })) : [];
  const practiseWrong = wrongRefs.length > 0;
  const roundCourse = run.complete ? resolveRoundCourse(data, run) : "";
  const roundStage = roundCourse ? (currentMethodStage(data, roundCourse)?.stage?.name || "") : "";
  const missedList = run.complete && run.mode !== "exam"
    ? (Array.isArray(run.missedCards) && run.missedCards.length > 0
      ? run.missedCards
      : ((run.answered || 0) > (run.correct || 0) && run.weakTopics?.length > 0 ? run.weakTopics.map((topic) => ({ topic, prompt: topic })) : []))
    : [];
  // 顽固题 of this round that the wrong book still holds (lib/leech.js, computed with the run): one line, and it opens the wrong book on them.
  const materialCount = React.useMemo(
    () => countMaterials(data?.sources, run.sourceIds),
    [data?.sources, run.sourceIds],
  );
  const hasReadableMaterials = React.useMemo(
    () => !run.complete && !run.reading && run.mode !== "exam" && readableMaterialItems(data?.sources, run.sourceIds).length > 0,
    [run.complete, run.reading, run.mode, data?.sources, run.sourceIds],
  );
  const onNavigatorJump = React.useCallback((index) => reviewAct("review.move", { index }), [reviewAct]);
  const questionContext = React.useMemo(() => ({ ...context, inHeader: !!wayBack }), [context, wayBack]);
  const leechCount = run.complete && run.mode !== "exam" && pageAvailable(data, "wrongbook") ? (run.leechCards || []).length : 0;
  const methodAlt = run.complete && !flow && run.mode !== "exam" ? roundEndAlternative(data, roundCourse, { guidedSession: app?.lib?.guidedSession, canChat: app?.host?.capabilities?.chat !== false }) : null;
  const roundTotal = run.questions ?? run.total ?? 0;
  const allCorrect = Boolean(run.complete && roundTotal > 0 && (run.answered || 0) >= roundTotal && run.correct === roundTotal);
  const boardState = app?.board?.state || null;
  const [dailyGoal, setDailyGoal] = useDailyGoal({ root: data?.root || "" });
  const timerPrefs = React.useMemo(() => resolveTimerPrefs(boardState?.board), [boardState?.board]);
  const todayPace = React.useMemo(() => (
    run.complete && run.mode !== "exam"
      ? computeTodayPace({
          attempts: data?.attempts,
          summary: data?.todayPace,
          goal: dailyGoal,
          focusMinutes: timerPrefs.workMinutes,
          breakMinutes: timerPrefs.breakMinutes,
        })
      : null
  ), [run.complete, run.mode, data?.attempts, data?.todayPace, dailyGoal, timerPrefs.workMinutes, timerPrefs.breakMinutes]);
  const summaryPace = React.useMemo(() => {
    if (!run.complete || run.mode === "exam" || !data?.paceForecast || roundTotal <= 0) return null;
    const singleDeckId = run.deckId || (Array.isArray(run.scope) && run.scope.length === 1 ? run.scope[0]?.deckId : null);
    const deckEntry = singleDeckId ? data.paceForecast.decks?.[singleDeckId] : null;
    if (deckEntry?.status === "mastered") return { ...deckEntry, isSlice: true };
    return buildSliceForecast({
      count: roundTotal,
      passedCount: run.correct ?? 0,
      paceForecast: data.paceForecast,
      deckId: singleDeckId,
      course: roundCourse || data?.focus?.course || null,
      focusMinutes: timerPrefs.workMinutes,
    });
  }, [run.complete, run.mode, run.deckId, run.scope, run.correct, roundTotal, roundCourse, data?.paceForecast, data?.focus?.course, timerPrefs.workMinutes]);
  return (
    <StudyServicesContext.Provider value={dock.services}>
    <section
      ref={pageRef}
      className={"review-page " + (!choice && !rubricCard ? "flash-mode" : "") + (rail ? " has-rail" : "") + (dock.docked ? " has-source" : "")}
      style={dock.style}
    >
      {/* The rail is a full-height column of the page, not of the question body,
          so it is pinned from the first frame instead of sliding up to stick. */}
      {rail && <ReviewNavigator run={run} skippedIndices={session.skippedIndices} onJump={onNavigatorJump} onEnd={run.mode !== "exam" ? actions.askEnd : undefined} />}
      <PageHeader className="review-heading" compact
        eyebrow={flow ? [ui("学习流"), flow.stepIndex >= 0 && uiFormat("第 {0}/{1} 步", [flow.stepIndex + 1, flow.stepCount]), flow.stepTitle].filter(Boolean).join(" · ") : undefined}
        title={[shellTitle, run.mode === "flashcard" && ui("闪卡"), run.retry && !run.complete && ui("本轮重练")].filter(Boolean).join(" · ")}
        actions={<>
          {run.mode !== "exam" && boardState && (
            <LazyReviewFocusPill
              boardState={boardState}
              attempts={data?.attempts}
              todayPaceSummary={data?.todayPace}
              focusTitle={shellTitle}
              root={data?.root || ""}
              goal={dailyGoal}
              onGoalChange={setDailyGoal}
              onBoardChanged={() => app?.dailyPlan?.refresh?.()}
            />
          )}
          {host.openInSidebar && !run.complete && (
            <Tooltip layer content={ui("题目放到右栏，主区域回到主会话。在右栏里接着刚才做到的这一题继续。")}>
              <Button iconEnd="arrow-right" variant="quiet" busy={movingToSidebar} onClick={moveToSidebar}>{ui("在右栏打开")}</Button>
            </Tooltip>
          )}
          {!run.complete && onReturnToReading && <ReadingBackButton run={run} busy={busy} onReturn={onReturnToReading} />}
          {/* On the result page the way back below the score (the book, the 总纲, the reading, 回到学习路径 …) is the one way back; the header does not say it twice. */}
          {!resultBack && <Button icon="arrow-left" variant="quiet" className="review-return" aria-label={returnLabel} onClick={() => flow ? onBackToWorkflow(flow.sessionId) : wayBack ? wayBack.go() : navigate("library")}>
            <span className="review-return-full">{returnLabel}</span>
            <span className="review-return-short" aria-hidden="true">{wayBack ? wayBack.label : ui("返回")}</span>
          </Button>}
        </>}>
        <div className="review-heading-links">
          <Button variant="quiet" size="sm" onClick={() => openModal({ type: "sources" })}>{uiFormat("查看 {0} 份资料", [materialCount])}</Button>
          {hasReadableMaterials && (
            <Tooltip layer content={ui("打开资料阅读器，翻到已学章节或页码后点「做这几页的题」，避开还没学到的后续页。")}>
              <Button iconEnd="arrow-right" variant="quiet" size="sm" onClick={() => openReaderForPages({ sources: data?.sources, sourceIds: run.sourceIds, openModal: study.openModal, back: true })}>
                {ui("去资料选页做题")}
              </Button>
            </Tooltip>
          )}
          <RunContext data={data} deckId={run.deckId} run={run} />
          <QuestionPlace data={data} run={run} place={cardPlace} onOpenOutline={onOpenOutline} />
          {skeletonHere && openSkeleton && (
            <Button iconEnd="arrow-right" variant="quiet" size="sm" title={uiFormat("这道题在知识骨架「{0}」里", [skeletonHere.title])} onClick={() => openSkeleton(skeletonHere.id)}>{ui("知识骨架")}</Button>
          )}
        </div>
      </PageHeader>
      {run.complete ? (
        // Distinct keys: without them React reuses the question body's DOM nodes
        // for the summary, and the ✓ badge inherited .question-area's inline
        // min-height (set by the pinning effect above), stretching into an oval.
        <div key="summary" className="session-summary result-page">
          <div className="result-reading"><ReadingSettingsButton /></div>
          <div className="result-kicker">{ui("本轮学习结果")}</div>
          <h2 className="result-title">{run.closed ? ui("这一轮，已结束。") : ui("这一轮，完成了。")}</h2>
          <p className="result-subtitle">{uiFormat("{0} · {1} 道题", [shellTitle, run.questions ?? run.total])}</p>
          {/* The mastery of this round's questions before the first answer and now, in the run itself (lib/run-mastery.js), so it is drawn with the page.
              A reader round says it about its pages, in its own card with the way back. */}
          {readingBack ? <ReadingResult run={run} busy={busy} onReturn={onReturnToReading} /> : <MasteryChange kind="round" change={run.mastery} className="result-mastery" />}
          {summaryPace && (
            <PaceMeta variant="slice" forecast={summaryPace} pace={data?.paceForecast?.pace} asOf={data?.paceForecast?.asOf} />
          )}
          <div className="result-hero sh-paper-card sh-paper-card--roomy" data-all-correct={allCorrect ? "true" : undefined}>
            <div className="result-headline">
              <strong>{typeof run.correct === "number" && Number.isFinite(run.correct) ? <LetterpressNumber value={run.correct} animateOnMount mountKey={run.id} /> : run.correct}</strong>
              <span>{uiFormat(scoreWording(run), [run.questions ?? run.total])}</span>
              {allCorrect && (
                <InkMark type="underline" tone="success" padding={3} strokeWidth={1.8}>
                  <span className="result-hero__badge" data-testid="result-all-correct">
                    {(run.selfAnswered || 0) > 0 ? ui("本轮全部达标") : ui("本轮全部答对")}
                  </span>
                </InkMark>
              )}
              {run.retries > 0 && <small>{run.retries === 1 ? ui("另外重练了 1 次") : uiFormat("另外重练了 {0} 次", [run.retries])}</small>}
            </div>
            <ResultBreakdown total={run.questions ?? run.total} answered={run.answered} correct={run.correct}
              activeSegment={lookBackSegment ? STATUS_TO_SEGMENT[lookBackSegment] : null}
              onSelectSegment={run.mode !== "exam" ? handleSelectSegment : undefined} />
          </div>
          {/* The next step comes first (the page decided it with today's plan in view): one filled button, then the 点评 and the rest. */}
          {/* A round started in the book (or on the 总纲) goes back there first; the page's own next step is then the second button. */}
          {(onward || wayBack || practiseWrong) && (
            <div className={cx("result-next", wayBack && "result-next--back")}>
              {wayBack && <ReturnPrimary arrow oneLine label={wayBack.label} place={wayBack.place} disabled={busy} onReturn={wayBack.go} />}
              {practiseWrong && <Button variant="primary" iconEnd="arrow-right" lock={busy} onClick={() => act("review.start", practiceArgs(wrongRefs), enterRun)}>
                {wrongRefs.length === 1 ? ui("重练这道错题") : uiFormat("重练这 {0} 道错题", [wrongRefs.length])}</Button>}
              {onward && <Button variant={backHere || practiseWrong ? "secondary" : "primary"} align={backHere ? "start" : undefined} icon={onward.back ? "arrow-left" : undefined}
                iconEnd={onward.back ? undefined : "arrow-right"} lock={busy} onClick={onward.run}>{onward.label}</Button>}
              {roundSetup && <RoundSetup data={data} context={roundSetup} chapterRefs={run.scope} onStart={(args, options) => act("review.start", args, enterRun, options)} className="result-setup" />}

              {onward && !backHere && contextReturnLabel && <Button icon="arrow-left" lock={busy} onClick={onReturnContext}>{contextReturnLabel}</Button>}
            </div>
          )}
          {destination?.note && <p className="muted" role="status">{destination.note}</p>}
          {/* The 雷霆建议 sits right under the next step: its own suggestion (定制题 or 补薄弱) is one click, so it must not hide inside the fold. */}
          {coachProps && run.mode !== "exam" && run.answered > 0 && (
            <CoachDebrief
              key={"debrief-" + run.id}
              run={run}
              initial={coachProps.debrief}
              // Autopilot must not pull a learner out of a workflow or a detour, nor carry on a round the learner stopped (到此为止, #1008), nor leave a
              // grade still running or a correction unread behind (#1031).
              autopilot={coachProps.autopilot && !flow && !detour && !run.returnTo && !backHere && !run.closed && !gradesOutstanding(run)}
              onPractice={coachProps.onPractice}
              onContinue={coachProps.onContinue}
              destination={coachProps.destination}
              onReviewWeak={coachProps.onReviewWeak}
              ctaMode={destination?.kind === "original" ? "none" : nextStep ? "secondary-suggestion" : backHere || practiseWrong ? "secondary" : "primary"}
              suppressNextPromise={backHere && !onward}
              debriefModel={practice.debrief}
              onSettings={goPracticeSettings} onProfileSettings={() => openSettings("settings-profile")}
            />
          )}
          {run.mode !== "exam" && (
            <LazyRoundSealSection run={run} title={shellTitle} course={roundCourse} allCorrect={allCorrect} />
          )}
          {call && <DailyRecap root={data.root} runId={run.id} saved={data.settings?.dailyRecap}
            poll primary={!nextStep && !backHere && !practiseWrong} onOpenNote={onOpenNote} onSettings={onRecapSettings} onModelSettings={onModelSettings} />}
          {run.weakTopics?.length > 0 && (
            <div className="summary-topics sh-paper-card">
              <h3>{ui("接下来重点复习 · 最多 3 个主题")}</h3>
              {run.weakTopics.slice(0, 3).map((t) => run.weakScopes?.[t]?.length
                ? <Button key={t} size="sm" className="summary-topic" iconEnd="arrow-right" lock={busy} title={ui("练这个主题")} aria-label={uiFormat("练这个主题：{0}", [t])}
                  onClick={() => act("review.start", practiceArgs(run.weakScopes[t]), enterRun)}>{t}</Button>
                : <Badge className="summary-topic" key={t}>{t}</Badge>)}
            </div>
          )}
          {run.complete && run.similarWins?.length > 0 && <p className="muted" data-similar-wins="">{similarWinsText(run.similarWins)}</p>}
          {leechCount > 0 && (
            <p className="summary-leech">
              {leechCount === 1 ? ui("本轮有 1 道题你已经反复答错。") : uiFormat("本轮有 {0} 道题你已经反复答错。", [leechCount])}
              <Button iconEnd="arrow-right" variant="link" size="sm" lock={busy} onClick={() => { askForLeeches(data?.root, run.leechCards); navigate("wrongbook"); }}>{ui("在错题本里看看")}</Button>
            </p>
          )}
          {run.course && (() => {
            const course = run.course;
            const totalChapters = course.chapters ?? course.segments?.length ?? 0;
            const segments = totalChapters >= 1 && totalChapters <= 30
              && Array.isArray(course.segments) && course.segments.length === totalChapters
              ? course.segments
              : null;
            return (
              <div className="summary-course">
                <p className="summary-course__text">
                  {courseSummaryText(course)}
                  {course.next?.label ? <span>{" · "}{uiFormat("下一批：{0}", [course.next.label])}</span> : null}
                </p>
                {segments && (
                  <div className="summary-course__bar" aria-hidden="true">
                    {segments.map((status, index) => (
                      <span key={index} className={cx("summary-course__seg", `is-${status === "done" || status === "started" ? status : "upcoming"}`)} />
                    ))}
                  </div>
                )}
              </div>
            );
          })()}
          {todayPace && (todayPace.goal !== null || todayPace.todayCount > 0) && (
            <p className="review-today-pace" data-goal-met={todayPace.goalMet ? "true" : undefined}>
              {formatTodayPaceLine(todayPace)}
            </p>
          )}
          <div className="summary-actions">
            {!run.closed && run.undoable && actions.undoAnswer && (
              <Button variant="quiet" data-usage="review.undo" aria-keyshortcuts="Z" lock={busy} onClick={actions.undoAnswer}>
                {ui("撤销上一题评分 (Z)")}
              </Button>
            )}
            {summaryCase && <>
              <Button lock={busy} onClick={() => act("case.drills", { deckId: summaryCase.id }, (value) =>
                setCaseNote(uiFormat("正在把 {0} 个薄弱评分项写成 {1} 道针对练习，完成后加入「薄弱项练习」题组并排进复习。", [value.criteria, value.count])))}>
                {ui("把薄弱项变成练习")}</Button>
              <Button lock={busy} onClick={() => act("generate", { kind: "case", fromDeckId: summaryCase.id },
                () => setCaseNote(ui("已开始出一套同类案例，完成后草稿会出现在学习库。")))}>{ui("再来一个同类案例")}</Button>
            </>}
            {missedList.length > 0 && (
              <HandOff id="method.missed" shape="quiet" label="带着错题回主会话" copyLabel="复制错题讲解提示词"
                what="把这一轮没过关的题目带回主会话讲透，讲完再回 StudyHub 重测"
                copyWhat="复制这一轮错题的提示词，可粘贴到外部 AI 讲透后再回 StudyHub 重测"
                input={{ course: roundCourse, stage: roundStage, missed: missedList }}
                disabled={busy} />
            )}
          </div>
          {caseNote && <p className="muted" role="status">{caseNote}</p>}
          {methodAlt && (
            <p className="summary-method-alt">
              <span className="summary-method-alt__lead">{ui("也可以：")}</span>
              <Tooltip layer content={methodAlt.detail}>
                <Button variant="link" size="sm" lock={busy} onClick={() => openAlt(methodAlt)}>{methodAlt.title}</Button>
              </Tooltip>
            </p>
          )}
          {/* 本轮题目 (#1009): which questions went wrong or were left, each with a read-only look-back from the run itself. */}
          <RoundLookBack collapsible key={"look-back-" + run.id} run={run} sources={data?.sources}
            segment={lookBackSegment} onSegmentChange={setLookBackSegment}
            onPracticeWrong={(refs) => act("review.start", practiceArgs(refs), enterRun)}
            onAck={(row) => actions.reviewAct("review.correction.ack", { entryIndex: row.entryIndex, cardId: row.cardId })}
            onOpenBook={pageAvailable(data, "book") ? ({ course: targetCourse, hid, view } = {}) => {
              const chosen = targetCourse || data?.focus?.course || null;
              app?.learn?.rememberContext?.(app.learn.captureContext());
              keepBook(data?.root, chosen, { target: hid || null, ...(view ? { view } : {}) });
              if (targetCourse && targetCourse !== data?.focus?.course) void act("focus.set", { course: targetCourse });
              navigate("book");
            } : undefined}
            onOpenWrongBook={pageAvailable(data, "wrongbook") ? (refs) => { askForLeeches(data?.root, refs); navigate("wrongbook"); } : undefined} />
          <details key={run.id} className="result-details">
            <summary>{ui("更多结果与练习")}</summary>
            <p className="muted">{ui("每道题的下次复习时间已保存。")}</p>
            <div className="summary-actions">
            {run.mode === "path" && !run.returnTo && !flow && run.scope?.length > 0 && run.dailyCourse === undefined && (
              <Button iconEnd="arrow-right" lock={busy} onClick={() => act("review.start", { mode: "path", scope: run.scope, fresh: true }, enterRun)}>{ui("再练此范围")}</Button>
            )}
            {run.weakTopics?.length > 0 && (
              <HandOff id="review.weakTopics" lead="讲解薄弱点：" what="让主会话逐个讲清这一轮还没掌握稳的主题，并各出一道小题检查你"
                input={{ title: shellTitle, topics: run.weakTopics }} />
            )}
            </div>
          </details>
        </div>
      ) : (
        <QuestionRun key="body" session={session} data={data} coachProps={coachProps} links={links} place={cardPlace} context={questionContext} feedback={feedback} />
      )}
      {dock.column}
    </section>
    </StudyServicesContext.Provider>
  );
}
