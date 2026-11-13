import { ui, uiFormat, errorMessage } from "./i18n.js";
import React from "react";
import ReviewNavigator from "./ReviewNavigator.jsx";
import RunContext from "./review/RunContext.jsx";
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
import { StudyServicesContext, useStudy } from "./study-context.jsx";
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
import RoundLookBack from "./review/RoundLookBack.jsx";
import { gradesOutstanding } from "./review/session-logic.js";
import RoundSetup from "./review/RoundSetup.jsx";
import { resultTarget } from "./review/round-setup.js";
import { similarWinsText } from "./review/similar-words.js";
import { useSourceDock } from "./review/use-source-dock.jsx";

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

export default function Review({ session, data, shellTitle, feedback, coachProps, links = {}, context = {} }) {
  useInjectCss(reviewCss, "study-review");
  const { run, choice, actions } = session;
  const { reviewAct } = actions;
  const study = useStudy();
  const { call, act, busy, host, navigate, openSettings, notify } = study;
  const { onBackToWorkflow, openSkeleton, onOpenNote, onRecapSettings, onModelSettings, onReturnToReading } = links;
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
  const nextStep = !run.complete ? null
    : flow ? { label: ui("回到学习流 →"), run: () => onBackToWorkflow(flow.sessionId) }
      : detour ? { label: uiFormat("回到之前的第 {0} 题 →", [detour.index + 1]), run: onReturnFromDetour }
        : destination?.kind === "original" ? { label: destination.label, run: destination.go }
          : run.course?.next ? { label: ui("继续课程下一批 →"), run: () => act("review.start", { mode: "course", course: run.course.name, fresh: true }, enterRun) }
            : newBatchArgs ? { label: ui("继续下一批新题 →"), run: () => act("review.start", newBatchArgs, enterRun) }
              : destination ? { label: destination.label, run: destination.go, back: isBackDestination(destination) } : null;
  // With a way back as the main button (the book's, the 总纲's or the reader's), a next step that is just another place to go back to (回到学习路径) is left out: both would go back.
  const onward = backHere && nextStep?.back ? null : nextStep;
  // 本轮设置 (#1010): beside the next-round button, only where that button starts a round of the course or of the scope (the page decided it: ui/review/round-setup.js).
  const roundSetup = onward && !backHere && !flow && !detour && !run.course ? resultTarget(run, destination, { newBatch: newBatchArgs }) : null;
  const roundCourse = run.complete ? resolveRoundCourse(data, run) : "";
  const roundStage = roundCourse ? (currentMethodStage(data, roundCourse)?.stage?.name || "") : "";
  const missedList = run.complete && run.mode !== "exam"
    ? (Array.isArray(run.missedCards) && run.missedCards.length > 0
      ? run.missedCards
      : ((run.answered || 0) > (run.correct || 0) && run.weakTopics?.length > 0 ? run.weakTopics.map((topic) => ({ topic, prompt: topic })) : []))
    : [];
  // 顽固题 of this round that the wrong book still holds (lib/leech.js, computed with the run): one line, and it opens the wrong book on them.
  const leechCount = run.complete && run.mode !== "exam" && pageAvailable(data, "wrongbook") ? (run.leechCards || []).length : 0;
  const methodAlt = run.complete && !flow && run.mode !== "exam" ? roundEndAlternative(data, roundCourse, { guidedSession: app?.lib?.guidedSession }) : null;
  return (
    <StudyServicesContext.Provider value={dock.services}>
    <section
      ref={pageRef}
      className={"review-page " + (!choice && !rubricCard ? "flash-mode" : "") + (rail ? " has-rail" : "") + (dock.docked ? " has-source" : "")}
      style={dock.style}
    >
      {/* The rail is a full-height column of the page, not of the question body,
          so it is pinned from the first frame instead of sliding up to stick. */}
      {rail && <ReviewNavigator run={run} onJump={(index) => reviewAct("review.move", { index })} onEnd={run.mode !== "exam" ? actions.askEnd : undefined} />}
      <PageHeader className="review-heading" compact
        eyebrow={flow ? [ui("学习流"), flow.stepIndex >= 0 && uiFormat("第 {0}/{1} 步", [flow.stepIndex + 1, flow.stepCount]), flow.stepTitle].filter(Boolean).join(" · ") : undefined}
        title={[shellTitle, run.mode === "flashcard" && ui("闪卡"), run.retry && !run.complete && ui("本轮重练")].filter(Boolean).join(" · ")}
        actions={<>
          {host.openInSidebar && !run.complete && (
            <Tooltip layer content={ui("题目放到右栏，主区域回到主会话。在右栏里接着刚才做到的这一题继续。")}>
              <Button variant="quiet" busy={movingToSidebar} onClick={moveToSidebar}>{ui("在右栏打开")}</Button>
            </Tooltip>
          )}
          {!run.complete && onReturnToReading && <ReadingBackButton run={run} busy={busy} onReturn={onReturnToReading} />}
          {/* On the result page the way back (the book, the 总纲 or the reading) is the main button below; the header does not say the same twice. */}
          {!(run.complete && backHere) && <Button variant="quiet" className="review-return" aria-label={returnLabel} onClick={() => flow ? onBackToWorkflow(flow.sessionId) : wayBack ? wayBack.go() : navigate("library")}>
            <span className="review-return-full">{returnLabel}</span>
            <span className="review-return-short" aria-hidden="true">{wayBack ? wayBack.label : ui("返回")}</span>
          </Button>}
        </>}>
        <div className="review-heading-links">
          <Button variant="quiet" size="sm" onClick={() => openModal({ type: "sources" })}>{uiFormat("查看 {0} 份资料", [countMaterials(data?.sources, run.sourceIds)])}</Button>
          {!run.complete && !run.reading && run.mode !== "exam" && readableMaterialItems(data?.sources, run.sourceIds).length > 0 && (
            <Tooltip layer content={ui("打开资料阅读器，翻到已学章节或页码后点「做这几页的题」，避开还没学到的后续页。")}>
              <Button variant="quiet" size="sm" onClick={() => openReaderForPages({ sources: data?.sources, sourceIds: run.sourceIds, openModal: study.openModal, back: true })}>
                {ui("去资料选页做题")}
              </Button>
            </Tooltip>
          )}
          <RunContext data={data} deckId={run.deckId} run={run} />
          {skeletonHere && openSkeleton && (
            <Button variant="quiet" size="sm" title={uiFormat("这道题在知识骨架「{0}」里", [skeletonHere.title])} onClick={() => openSkeleton(skeletonHere.id)}>{ui("知识骨架")}</Button>
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
          <div className="result-hero sh-paper-card sh-paper-card--roomy">
            <div className="result-headline">
              <strong>{run.correct}</strong>
              <span>{uiFormat(scoreWording(run), [run.questions ?? run.total])}</span>
              {run.retries > 0 && <small>{run.retries === 1 ? ui("另外重练了 1 次") : uiFormat("另外重练了 {0} 次", [run.retries])}</small>}
            </div>
            <ResultBreakdown total={run.questions ?? run.total} answered={run.answered} correct={run.correct} />
          </div>
          {/* The next step comes first (the page decided it with today's plan in view): one filled button, then the 点评 and the rest. */}
          {/* A round started in the book (or on the 总纲) goes back there first; the page's own next step is then the second button. */}
          {(onward || wayBack) && (
            <div className={cx("result-next", wayBack && "result-next--back")}>
              {wayBack && <ReturnPrimary arrow oneLine label={wayBack.label} place={wayBack.place} disabled={busy} onReturn={wayBack.go} />}
              {onward && <Button variant={backHere ? "secondary" : "primary"} align={backHere ? "start" : undefined} iconEnd="arrow-right" lock={busy} onClick={onward.run}>{onward.label.replace(/\s*→$/, "")}</Button>}
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
              nextShown={!!nextStep} plain={backHere} onwardShown={!!onward}
              debriefModel={practice.debrief}
              onSettings={goPracticeSettings} onProfileSettings={() => openSettings("settings-profile")}
            />
          )}
          {call && <DailyRecap root={data.root} runId={run.id} saved={data.settings?.dailyRecap}
            poll primary={!nextStep && !backHere} onOpenNote={onOpenNote} onSettings={onRecapSettings} onModelSettings={onModelSettings} />}
          <div className="summary-topics sh-paper-card">
            <h3>{ui("接下来重点复习 · 最多 3 个主题")}</h3>
            {(run.weakTopics || []).slice(0, 3).map((t) => run.weakScopes?.[t]?.length
              ? <Button key={t} size="sm" className="summary-topic" iconEnd="arrow-right" lock={busy} title={ui("练这个主题")} aria-label={uiFormat("练这个主题：{0}", [t])}
                onClick={() => act("review.start", practiceArgs(run.weakScopes[t]), enterRun)}>{t}</Button>
              : <Badge className="summary-topic" key={t}>{t}</Badge>)}
            {!run.weakTopics?.length && (
              <p className="muted summary-topics__empty">{ui("本轮没有低分记录，继续按间隔复习巩固。")}</p>
            )}
          </div>
          {run.complete && run.similarWins?.length > 0 && <p className="muted" data-similar-wins="">{similarWinsText(run.similarWins)}</p>}
          {leechCount > 0 && (
            <p className="summary-leech">
              {leechCount === 1 ? ui("本轮有 1 道题你已经反复答错。") : uiFormat("本轮有 {0} 道题你已经反复答错。", [leechCount])}
              <Button variant="link" size="sm" lock={busy} onClick={() => { askForLeeches(data?.root, run.leechCards); navigate("wrongbook"); }}>{ui("在错题本里看看")}</Button>
            </p>
          )}
          {run.course && (
            <p className="summary-course">{uiRich("课程进度 · 已学 {0} 题", <strong>{run.course.learned ?? 0} / {run.course.cards ?? 0}</strong>)}{" · "}{run.course.chapter ? uiFormat("第 {0} / {1} 章「{2}」{3}/{4}", [run.course.chapter.index + 1, run.course.chapters, run.course.chapter.title, run.course.chapter.learned, run.course.chapter.total]) : ui("全部章节都学过了")}
              {run.course.next?.label ? <span>{" · "}{uiFormat("下一批：{0}", [run.course.next.label])}</span> : null}
            </p>
          )}
          <div className="summary-actions">
            {summaryCase && <>
              <Button lock={busy} onClick={() => act("case.drills", { deckId: summaryCase.id }, (value) =>
                setCaseNote(uiFormat("正在把 {0} 个薄弱评分项写成 {1} 道针对练习，完成后加入「薄弱项练习」题组并排进复习。", [value.criteria, value.count])))}>
                {ui("把薄弱项变成练习")}</Button>
              <Button lock={busy} onClick={() => act("generate", { kind: "case", fromDeckId: summaryCase.id },
                () => setCaseNote(ui("已开始出一套同类案例，完成后草稿会出现在学习库。")))}>{ui("再来一个同类案例")}</Button>
            </>}
            {missedList.length > 0 && (
              <HandOff id="method.missed" shape="quiet" label="带着错题回主会话"
                what="把这一轮没过关的题目带回主会话讲透，讲完再回 StudyHub 重测"
                input={{ course: roundCourse, stage: roundStage, missed: missedList }}
                disabled={busy} />
            )}
            <Button onClick={() => navigate("library")}>{ui("回到学习目录")}</Button>
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
          <RoundLookBack key={"look-back-" + run.id} run={run} onAck={(row) => actions.reviewAct("review.correction.ack", { entryIndex: row.entryIndex, cardId: row.cardId })}
            onOpenWrongBook={pageAvailable(data, "wrongbook") ? (refs) => { askForLeeches(data?.root, refs); navigate("wrongbook"); } : undefined} />
          <details key={run.id} className="result-details">
            <summary>{ui("更多结果与练习")}</summary>
            <p className="muted">{ui("每道题的下次复习时间已保存。")}</p>
            <div className="summary-actions">
            {run.mode === "path" && !run.returnTo && !flow && run.scope?.length > 0 && run.dailyCourse === undefined && (
              <Button lock={busy} onClick={() => act("review.start", { mode: "path", scope: run.scope, fresh: true }, enterRun)}>{ui("再练此范围")}</Button>
            )}
            {run.weakTopics?.length > 0 && (
              <HandOff id="review.weakTopics" lead="讲解薄弱点：" what="让主会话逐个讲清这一轮还没掌握稳的主题，并各出一道小题检查你"
                input={{ title: shellTitle, topics: run.weakTopics }} />
            )}
            </div>
          </details>
        </div>
      ) : (
        <QuestionRun key="body" session={session} data={data} coachProps={coachProps} links={links} context={{ ...context, inHeader: !!wayBack }} feedback={feedback} />
      )}
      {dock.column}
    </section>
    </StudyServicesContext.Provider>
  );
}
