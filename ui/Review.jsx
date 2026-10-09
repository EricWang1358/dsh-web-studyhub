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
import { uiRich } from "./i18n-rich.jsx";
import { useStudy } from "./study-context.jsx";
import { weakTopicsPrompt } from "./agent-prompts/library.js";
import reviewCss from "./review/review.css";
import { useInjectCss } from "./shared.js";
import { ReadingBackButton, ReadingResult } from "./document-preview/practice/ReadingReturn.jsx";
import { practiceArgs } from "./learning-navigation.js";
import { resolvePracticeSettings } from "../lib/practice-settings.js";

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
 * label, onReturn, detour, onReturnFromDetour).
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
  const { call, act, busy, host, askInChat, navigate, openModal, openSettings, notify } = useStudy();
  const { onBackToWorkflow, onCourseFlow, openSkeleton, onOpenNote, onRecapSettings, onModelSettings, onReturnToReading } = links;
  const { label: contextReturnLabel, onReturn: onReturnContext, detour, onReturnFromDetour } = context;
  const enterRun = session.enterRun;
  // 在右栏打开: busy until the sidebar has the run; when it cannot, say why (never a silent click).
  const [movingToSidebar, setMovingToSidebar] = React.useState(false);
  const moveToSidebar = async () => {
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
  usePinQuestion(pageRef, run);
  const rubricCard = run.card?.kind === "open" && !!run.card.rubricCriteria?.length;
  const rail = !run.complete && run.navigation?.length > 0;
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
  const nextStep = !run.complete ? null
    : flow ? { label: flow.current ? ui("回到学习流，继续下一步 →") : ui("回到学习流 →"), run: () => onBackToWorkflow(flow.sessionId) }
      : detour ? { label: uiFormat("回到之前的第 {0} 题 →", [detour.index + 1]), run: onReturnFromDetour }
        : destination?.kind === "original" ? { label: destination.label, run: destination.go }
          : run.course?.next ? { label: ui("继续课程下一批 →"), run: () => act("review.start", { mode: "course", course: run.course.name, fresh: true }, enterRun) }
            : run.mode === "new" && nextFreshCount > 0 ? { label: ui("继续下一批新题 →"),
              run: () => act("review.start", { mode: "new", scope: run.scope ?? [{ deckId: run.deckId }], count: 10, ordered: true, fresh: true }, enterRun) }
              : destination ? { label: destination.label, run: destination.go } : null;
  return (
    <section
      ref={pageRef}
      className={"review-page " + (!choice && !rubricCard ? "flash-mode" : "") + (rail ? " has-rail" : "")}
    >
      {/* The rail is a full-height column of the page, not of the question body,
          so it is pinned from the first frame instead of sliding up to stick. */}
      {rail && <ReviewNavigator run={run} busy={busy} onJump={(index) => reviewAct("review.move", { index })} />}
      <PageHeader className="review-heading" compact
        eyebrow={flow ? [ui("学习流"), flow.stepIndex >= 0 && uiFormat("第 {0}/{1} 步", [flow.stepIndex + 1, flow.stepCount]), flow.stepTitle].filter(Boolean).join(" · ") : undefined}
        title={[shellTitle, run.mode === "flashcard" && ui("闪卡"), run.retry && !run.complete && ui("本轮重练")].filter(Boolean).join(" · ")}
        actions={<>
          {host.openInSidebar && !run.complete && (
            <Tooltip layer content={ui("题目放到右栏，主区域回到对话。在右栏里接着刚才做到的这一题继续。")}>
              <Button variant="quiet" busy={movingToSidebar} onClick={moveToSidebar}>{ui("在右栏打开")}</Button>
            </Tooltip>
          )}
          {!run.complete && onReturnToReading && <ReadingBackButton run={run} busy={busy} onReturn={onReturnToReading} />}
          <Button variant="quiet" className="review-return" aria-label={flow ? ui("回到学习流") : ui("返回学习库")} onClick={() => flow ? onBackToWorkflow(flow.sessionId) : navigate("library")}>
            <span className="review-return-full">{flow ? ui("回到学习流") : ui("返回学习库")}</span>
            <span className="review-return-short" aria-hidden="true">{ui("返回")}</span>
          </Button>
        </>}>
        <div className="review-heading-links">
          <Button variant="quiet" size="sm" onClick={() => openModal({ type: "sources" })}>{uiFormat("查看 {0} 份资料", [run.sourceIds?.length || 0])}</Button>
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
          {onReturnToReading && <ReadingResult run={run} busy={busy} onReturn={onReturnToReading} />}
          <div className="result-hero sh-paper-card sh-paper-card--roomy">
            <div className="result-headline">
              <strong>{run.correct}</strong>
              <span>{uiFormat(scoreWording(run), [run.questions ?? run.total])}</span>
              {run.retries > 0 && <small>{uiFormat("另有 {0} 次队尾重练", [run.retries])}</small>}
            </div>
            <ResultBreakdown total={run.questions ?? run.total} answered={run.answered} correct={run.correct} />
          </div>
          {/* The next step comes first (the page decided it with today's plan in view): one filled button, then the 点评 and the rest. */}
          {nextStep && (
            <div className="result-next">
              <Button variant="primary" disabled={busy} onClick={nextStep.run}>{nextStep.label}</Button>
              {run.course?.next?.fresh > 0 && onCourseFlow && <Button disabled={busy} onClick={() => onCourseFlow({ course: run.course.name })}>{ui("先讲后练下一批")}</Button>}
              {contextReturnLabel && <Button disabled={busy} onClick={onReturnContext}>← {contextReturnLabel}</Button>}
            </div>
          )}
          {destination?.note && <p className="muted" role="status">{destination.note}</p>}
          {/* The 雷霆建议 sits right under the next step: its own suggestion (定制题 or 补薄弱) is one click, so it must not hide inside the fold. */}
          {coachProps && run.mode !== "exam" && run.answered > 0 && (
            <CoachDebrief
              key={"debrief-" + run.id}
              run={run}
              call={coachProps.call}
              initial={coachProps.debrief}
              // Autopilot must not pull a learner out of a workflow or a detour.
              autopilot={coachProps.autopilot && !flow && !detour && !run.returnTo}
              busy={busy}
              onPractice={coachProps.onPractice}
              onContinue={coachProps.onContinue}
              destination={coachProps.destination}
              onReviewWeak={coachProps.onReviewWeak}
              nextShown={!!nextStep}
              debriefModel={practice.debrief}
              onSettings={goPracticeSettings} onProfileSettings={() => openSettings("settings-profile")}
            />
          )}
          {call && <DailyRecap root={data.root} runId={run.id} saved={data.settings?.dailyRecap} call={call} act={act}
            busy={busy} poll primary={!nextStep} onOpenNote={onOpenNote} onSettings={onRecapSettings} onModelSettings={onModelSettings} />}
          <div className="summary-topics sh-paper-card">
            <h3>{ui("接下来重点复习 · 最多 3 个主题")}</h3>
            {(run.weakTopics || []).slice(0, 3).map((t) => run.weakScopes?.[t]?.length
              ? <Button key={t} size="sm" className="summary-topic" iconEnd="arrow-right" disabled={busy} title={ui("练这个主题")} aria-label={uiFormat("练这个主题：{0}", [t])}
                onClick={() => act("review.start", practiceArgs(run.weakScopes[t]), enterRun)}>{t}</Button>
              : <Badge className="summary-topic" key={t}>{t}</Badge>)}
            {!run.weakTopics?.length && (
              <p className="muted">{ui("本轮没有低分记录，继续按间隔复习巩固。")}</p>
            )}
          </div>
          {run.course && (
            <p className="summary-course">{uiRich("课程进度 · 已学 {0} 题", <strong>{run.course.learned ?? 0} / {run.course.cards ?? 0}</strong>)}{" · "}{run.course.chapter ? uiFormat("第 {0} / {1} 章「{2}」{3}/{4}", [run.course.chapter.index + 1, run.course.chapters, run.course.chapter.title, run.course.chapter.learned, run.course.chapter.total]) : ui("全部章节都学过了")}
              {run.course.next?.label ? <span>{" · "}{uiFormat("下一批：{0}", [run.course.next.label])}</span> : null}
            </p>
          )}
          <div className="summary-actions">
            {summaryCase && <>
              <Button disabled={busy} onClick={() => act("case.drills", { deckId: summaryCase.id }, (value) =>
                setCaseNote(uiFormat("正在把 {0} 个薄弱评分项写成 {1} 道针对练习，完成后加入「薄弱项练习」题组并排进复习。", [value.criteria, value.count])))}>
                {ui("把薄弱项变成练习")}</Button>
              <Button disabled={busy} onClick={() => act("generate", { kind: "case", fromDeckId: summaryCase.id },
                () => setCaseNote(ui("已开始出一套同类案例，完成后草稿会出现在学习库。")))}>{ui("再来一个同类案例")}</Button>
            </>}
            <Button onClick={() => navigate("library")}>{ui("回到学习目录")}</Button>
          </div>
          {caseNote && <p className="muted" role="status">{caseNote}</p>}
          <details key={run.id} className="result-details">
            <summary>{ui("更多结果与练习")}</summary>
            <p className="muted">{ui("每道题的下次复习时间已保存。")}</p>
            <div className="summary-actions">
            {run.mode === "path" && !run.returnTo && !flow && run.scope?.length > 0 && run.dailyCourse === undefined && (
              <Button disabled={busy} onClick={() => act("review.start", { mode: "path", scope: run.scope, fresh: true }, enterRun)}>{ui("再练此范围")}</Button>
            )}
            {run.weakTopics?.length > 0 && (
              <Button
                onClick={() =>
                  askInChat(weakTopicsPrompt({ title: shellTitle, topics: run.weakTopics }))
                }
              >{ui("在对话中讲解薄弱点")}</Button>
            )}
            </div>
          </details>
        </div>
      ) : (
        <QuestionRun key="body" session={session} data={data} coachProps={coachProps} links={links} context={context} feedback={feedback} />
      )}
    </section>
  );
}
