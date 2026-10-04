import { ui, uiFormat, uiLocale } from "./i18n.js";
import React from "react";
import Markdown from "./Markdown.jsx";
import Cloze from "./Cloze.jsx";
import ReviewNavigator from "./ReviewNavigator.jsx";
import FlipCard from "./FlipCard.jsx";
import SmoothHeight from "./SmoothHeight.jsx";
import ReviewToolbar from "./ReviewToolbar.jsx";
import CitationDisclosure from "./CitationDisclosure.jsx";
import ExplanationFollowup from "./ExplanationFollowup.jsx";
import { asksWhatTheSourceSays, SOURCE_VOICE_FIX } from "../lib/question-voice.js";
import ChoiceFeedback from "./ChoiceFeedback.jsx";
import CoachDebrief from "./CoachDebrief.jsx";
import ThumbFeedback from "./ThumbFeedback.jsx";
import { reviewEntryKey } from "./async.js";
import ModelErrorNote from "./ModelErrorNote.jsx";
import TeachingStatus from "./review/TeachingStatus.jsx";
import { describeModelError, plainAssistFailure } from "./generation-status.js";
import { readableQualityIssue } from "./quality.js";
import ResultBreakdown from "./ResultBreakdown.jsx";
import { ReadingBlock, ReadingSettingsButton, useReadingProps } from "./reading-settings/ReadingSettings.jsx";
import resultCss from "./review-results.css";
import DailyRecap from './DailyRecap.jsx';
import { Badge, Banner, Button, Chip, Icon, InlineMessage, PageHeader, Popover, ProgressBar, SegmentedControl, Spinner } from "./components/index.js";
import { uiRich } from "./i18n-rich.jsx";
import { useStudy } from "./study-context.jsx";
import { HELP_CHOICES, IMPROVE_SUGGESTIONS } from "./agent-prompts/card.js";
import { weakTopicsPrompt } from "./agent-prompts/library.js";
import { fixSuggestionFor } from "./card-fix.js";
import reviewCss from "./review/review.css";
import { useInjectCss } from "./shared.js";
import { RubricAnswer, ScenarioPanel } from "./CaseWorkspace.jsx";
import { ReadingBackButton, ReadingResult, WrongAnswerSource } from "./document-preview/practice/ReadingReturn.jsx";

/* 复习视图：quiz/multi 选项作答、cloze 填空、闪卡翻面与开放问答自评，
   附前置题条、逐步讲解面板与薄弱主题收尾。会话状态（run）与本地作答
   状态由 useReviewSession 持有（ui/review/useReviewSession.js），本组件
   只负责渲染，交互经 session.actions 转发；服务（call、act、host、导航）来自 useStudy()。 */
const date = (v) =>
  v
    ? new Date(v).toLocaleString(uiLocale(), {
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      })
    : ui("现在");
const CALCULATION_STAGE_LABELS = {
  conditions: "已知条件与未知量", formula: "公式与适用理由", substitution: "代入与单位",
  computation: "中间计算", verification: "结果检查与舍入",
};

/**
 * props: session (useReviewSession: run, entry, actions ...), data (the library snapshot), shellTitle, feedback (the app's
 * one feedback region, drawn where it belongs on this page), coachProps (the debrief and thumbs controls, absent without a
 * library), links (ways out of the page: onBackToWorkflow, onCourseFlow, openSkeleton, onOpenNote, onMakeNote, onMakeTask,
 * onRecapSettings, onModelSettings, onReturnToReading) and context (the way back to where the learner came from:
 * label, onReturn, detour, onReturnFromDetour).
 */
/* A failed background-assistant task. A model failure goes through the one model note: a key or model problem points to the settings
   (sending the same request again cannot work, so there is no 重新提交), a busy or slow service keeps 重新提交. Anything else is about the
   content: the plain line, 重新提交, and 改一改再提交 when there is a question to edit. */
function AssistFailure({ task, busy, onSettings, onResubmit, onEdit }) {
  const text = plainAssistFailure(task.message) || ui("任务失败");
  const info = describeModelError(text);
  const resubmit = <Button variant="primary" size="sm" disabled={busy} onClick={onResubmit}>{ui("重新提交")}</Button>;
  if (info.kind !== "unknown") {
    return (
      <div className="assist-note assist-failed" data-kind={info.kind}>
        <ModelErrorNote error={text} context="assist" onSettings={onSettings} />
        {info.action === "retry" && <div className="assist-actions">{resubmit}</div>}
      </div>
    );
  }
  return (
    <div className="assist-status failed assist-failed" role="status">
      <p>{uiFormat("后台助教没能完成：{0}", [text])}</p>
      <div className="assist-actions">
        {resubmit}
        {onEdit && <Button size="sm" onClick={onEdit}>{ui("改一改再提交")}</Button>}
      </div>
    </div>
  );
}

export default function Review({ session, data, shellTitle, feedback, coachProps, links = {}, context = {} }) {
  useInjectCss(reviewCss, "study-review");
  const { run, entry, showBack, showEn, enBusyKey, teachingBusy, teachingError, choice, isCloze, actions } = session;
  const { selected, hint, explain, response, teaching, teachAnswer, clozeValues } = entry;
  const { reviewAct, choose, flipCard, assistCard, slayCard, studyPrerequisites, teachingAct, cancelTeaching, retryTeaching, toggleEn } = actions;
  const { call, act, busy, host, askInChat, navigate, openModal } = useStudy();
  const { onBackToWorkflow, onCourseFlow, openSkeleton, onOpenNote, onMakeNote, onMakeTask, onRecapSettings, onModelSettings, onReturnToReading } = links;
  const { label: contextReturnLabel, onReturn: onReturnContext, detour, onReturnFromDetour } = context;
  const enterRun = session.enterRun;
  const assistTasks = data?.assist;
  // Where 继续学习 goes (the page decided it with today's plan in view): the coach card and this page's own way back share it.
  const destination = coachProps?.destination;
  useInjectCss(resultCss, "review-results");
  const pageRef = React.useRef(null);
  // A learning-flow practice round: the page is the same, only the way back differs.
  const flow = run.workflow && onBackToWorkflow ? run.workflow : null;
  const multiple = run.card?.multiple || run.card?.kind === "multi";
  const publicationIssues = (run.card?.publicationIssues || []).map((issue) =>
    readableQualityIssue(`Card 1: ${issue}`).replace(/^第 1 题：/, ""));
  // EN button: show the cached English after each Chinese stem and answer.
  const enOn = !!showEn && run.mode !== "exam" && !run.complete;
  const enStem = enOn ? run.card?.translation : null;
  const enAnswer = enOn && run.solution ? run.solution.translation : null;
  // Switching questions pins the question header ("21 / 54 · topic") just
  // under the sticky top bar, so every question opens at the same spot instead
  // of wherever the previous one's length left the scroll offset. The first
  // question keeps the natural layout; the summary only scrolls back if its top
  // is out of view. Runs before paint, so there is no visible jump.
  const openedRef = React.useRef(false);
  React.useLayoutEffect(() => {
    const page = pageRef.current;
    let scroller = page?.parentElement;
    while (scroller && !/(auto|scroll)/.test(getComputedStyle(scroller).overflowY))
      scroller = scroller.parentElement;
    if (!page || !scroller) return;
    const bar = page.closest("main")?.querySelector(":scope > .topbar")?.offsetHeight || 0;
    // Block body on purpose: newer Chromium's scrollTo returns a Promise, and an
    // effect must never return one (React calls it as the cleanup and throws).
    const scrollBy = (delta) => {
      scroller.scrollTo({ top: Math.max(0, scroller.scrollTop + delta), behavior: "instant" });
    };
    const meta = !run.complete && page.querySelector(".question-meta");
    const first = !openedRef.current;
    openedRef.current = true;
    if (meta) {
      const gap = 16;
      // The pin is the question card's top edge, so its header rule is never
      // tucked under the bar. Leave a viewport of room below it so even a
      // short last card can scroll up to the pinned position; the room goes
      // on the body, not the card, so the card itself hugs its content.
      const card = meta.closest(".question-card") || meta.closest(".question-area"),
        area = card.closest(".review-body") || card;
      const lead = card.getBoundingClientRect().top - area.getBoundingClientRect().top;
      const minHeight = `${Math.max(0, scroller.clientHeight - bar - gap + lead)}px`;
      if (area.style.minHeight !== minHeight) area.style.minHeight = minHeight;
      if (!first) {
        scrollBy(card.getBoundingClientRect().top - scroller.getBoundingClientRect().top - bar - gap);
        return;
      }
    }
    const offset = page.getBoundingClientRect().top - scroller.getBoundingClientRect().top - bar;
    if (offset < 0) scrollBy(offset);
  }, [run.id, run.index, run.complete]);
  const rail = !run.complete && run.navigation?.length > 0;
  const [assistMode, setAssistMode] = React.useState("");
  const [assistText, setAssistText] = React.useState("");
  const [helpChoices, setHelpChoices] = React.useState([]);
  const [deriveRelation, setDeriveRelation] = React.useState("prerequisite");
  React.useEffect(() => {
    setAssistMode("");
    setAssistText("");
    setHelpChoices([]);
  }, [run.id, run.index, run.card?.id]);
  const cardTasks = (assistTasks || []).filter((task) => task.cardId === run.card?.id);
  const runningTask = cardTasks.find((task) => task.status === "running" && task.mode !== "grade");
  const lastTask = cardTasks.filter((task) => task.mode !== "grade").at(-1);
  // The question column follows the chosen reading width (the card, the toolbar and the explanation share it), not a fixed 700px: 窄 / 标准 / 宽 in the Aa popover.
  const readingStyle = useReadingProps().style || {};
  const readingMeasure = readingStyle["--reading-measure"];
  // The card's own type (stem, options, flashcard faces) scales with the chosen size too: 16px is the designed size, so 1.0.
  const cardScale = Math.round((parseFloat(readingStyle["--reader-size"]) / 16 || 1) * 100) / 100;
  // Case questions (WP12): the scenario sits above the question; its highlights belong to this run.
  const rubricCard = run.card?.kind === "open" && !!run.card.rubricCriteria?.length;
  const gradeTask = cardTasks.filter((task) => task.mode === "grade").at(-1);
  const caseDeck = run.card ? data?.decks?.find((deck) => deck.id === run.deckId && deck.format === "case-study") : null;
  const caseSource = caseDeck ? data?.sources?.find((source) => source.id === caseDeck.caseSourceId) : null;
  const [caseHighlights, setCaseHighlights] = React.useState(run.highlights || []);
  React.useEffect(() => { setCaseHighlights(run.highlights || []); }, [run.id]); // eslint-disable-line react-hooks/exhaustive-deps
  // A finished round on a case set (WP12): its weak criteria become drills, or another case like it.
  const summaryCase = run.complete ? data?.decks?.find((deck) => deck.id === run.deckId && deck.format === "case-study") : null;
  const [caseNote, setCaseNote] = React.useState("");
  const saveHighlights = (next) => {
    setCaseHighlights(next);
    Promise.resolve(call?.("review.highlights", { runId: run.id, highlights: next })).catch(() => {});
  };
  const skeletonHere = run.card ? data?.skeletons?.find((k) => k.cardIds.includes(run.card.id)) : null;
  const cardNotes = data?.noteBadges?.[run.card?.id] || [];
  const nextFreshCount = run.freshRemaining ?? [...new Set((run.scope || []).map((scope) => scope.deckId))]
    .reduce((count, deckId) => count + (data?.progress?.[deckId]?.counts?.new || 0), 0);
  const prereqStrip = run.prerequisites?.length > 0 && !run.complete && (
    <details className="prereq-strip">
      <summary>
        <span>{uiFormat("前置题 {0} · 已掌握 {1}", [run.prerequisites.length, run.prerequisites.filter((p) => !["new", "weak"].includes(p.level)).length])}</span>
        {(() => {
          const unlearned = run.prerequisites.some((p) => ["new", "weak"].includes(p.level));
          return (
            <Button
              variant={unlearned ? "primary" : "secondary"} size="sm"
              disabled={busy}
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
            <button
              className="prereq-item"
              disabled={busy}
              title={ui("只练这一道，做完回到这道题")}
              onClick={() => studyPrerequisites([p])}
            >
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
            <Button variant="quiet" title={ui("题目放到右栏，主区域回到对话")} onClick={() => host.openInSidebar(run.id)}>{ui("在右栏打开")}</Button>
          )}
          {!run.complete && onReturnToReading && <ReadingBackButton run={run} busy={busy} onReturn={onReturnToReading} />}
          <Button variant="quiet" className="review-return" aria-label={flow ? ui("回到学习流") : ui("返回学习库")} onClick={() => flow ? onBackToWorkflow(flow.sessionId) : navigate("library")}>
            <span className="review-return-full">{flow ? ui("回到学习流") : ui("返回学习库")}</span>
            <span className="review-return-short" aria-hidden="true">{ui("返回")}</span>
          </Button>
        </>}>
        <div className="review-heading-links">
          <Button variant="quiet" size="sm" onClick={() => openModal({ type: "sources" })}>{uiFormat("查看 {0} 份资料", [run.sourceIds?.length || 0])}</Button>
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
          <div className="result-hero">
            <div className="result-headline">
              <strong>{run.correct}</strong>
              <span>{uiFormat("道题已掌握 / {0} 道", [run.questions ?? run.total])}</span>
              {run.retries > 0 && <small>{uiFormat("另有 {0} 次队尾重练", [run.retries])}</small>}
            </div>
            <ResultBreakdown total={run.questions ?? run.total} answered={run.answered} correct={run.correct} />
          </div>
          {call && <DailyRecap root={data.root} runId={run.id} saved={data.settings?.dailyRecap} call={call} act={act}
            busy={busy} poll onOpenNote={onOpenNote} onSettings={onRecapSettings} onModelSettings={onModelSettings} />}
          {/* The 雷霆建议 sits right under the score: it carries the one-click
              「刷 N 道为你定制的题」, so it must not hide inside the fold. */}
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
            />
          )}
          <div className="summary-topics">
            <h3>{ui("接下来重点复习 · 最多 3 个主题")}</h3>
            {(run.weakTopics || []).slice(0, 3).map((t) => (
              <Badge className="summary-topic" key={t}>{t}</Badge>
            ))}
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
            {run.course?.next && <Button variant="primary" disabled={busy}
              onClick={() => act("review.start", { mode: "course", course: run.course.name, fresh: true }, enterRun)}>{ui("继续课程下一批 →")}</Button>}
            {run.course?.next?.fresh > 0 && onCourseFlow && <Button disabled={busy} onClick={() => onCourseFlow({ course: run.course.name })}>{ui("先讲后练下一批")}</Button>}
            {run.mode === "new" && nextFreshCount > 0 && (
              <Button variant="primary" disabled={busy} onClick={() => act("review.start",
                { mode: "new", scope: run.scope ?? [{ deckId: run.deckId }], count: 10, ordered: true, fresh: true }, enterRun)}>{ui("继续下一批新题 →")}</Button>
            )}
            {flow && <Button variant="primary" disabled={busy} onClick={() => onBackToWorkflow(flow.sessionId)}>
              {flow.current ? ui("回到学习流，继续下一步 →") : ui("回到学习流 →")}</Button>}
            {contextReturnLabel && <Button disabled={busy} onClick={onReturnContext}>← {contextReturnLabel}</Button>}
            {detour && <Button variant="primary" disabled={busy} onClick={onReturnFromDetour}>{uiFormat("回到之前的第 {0} 题 →", [detour.index + 1])}</Button>}
            {destination?.kind === "original" && !detour && <Button variant="primary" disabled={busy} onClick={destination.go}>{destination.label}</Button>}
            {summaryCase && <>
              <Button disabled={busy} onClick={() => act("case.drills", { deckId: summaryCase.id }, (value) =>
                setCaseNote(uiFormat("正在把 {0} 个薄弱评分项写成 {1} 道针对练习，完成后加入「薄弱项练习」题组并排进复习。", [value.criteria, value.count])))}>
                {ui("把薄弱项变成练习")}</Button>
              <Button disabled={busy} onClick={() => act("generate", { kind: "case", fromDeckId: summaryCase.id },
                () => setCaseNote(ui("已开始出一套同类案例，完成后草稿会出现在学习库。")))}>{ui("再来一个同类案例")}</Button>
            </>}
            <Button onClick={() => navigate("library")}>{ui("回到学习目录")}</Button>
          </div>
          {destination?.note && <p className="muted" role="status">{destination.note}</p>}
          {caseNote && <p className="muted" role="status">{caseNote}</p>}
          <details key={run.id} className="result-details">
            <summary>{ui("更多结果与练习")}</summary>
            <p className="muted">{ui("每道题的下次复习时间已保存。")}</p>
            <div className="summary-actions">
            {run.mode === "path" && !run.returnTo && !flow && (
              <Button variant="primary"
                disabled={busy}
                onClick={() => act("review.start", { mode: "path", scope: run.scope || [], fresh: true }, enterRun)}
              >
                {run.scope?.length ? ui("再练此范围") : ui("继续学习")}
              </Button>
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
        <div key="body" className="review-body">
          <div
            className={
              "question-area " +
              (!choice && !isCloze && !rubricCard ? "flash-area" : "") +
              (caseSource ? " has-case" : "")
            }
            style={readingMeasure ? { "--reading-measure": readingMeasure, "--review-column": "calc(var(--reading-measure) - 4px)", "--card-scale": cardScale } : undefined}
          >
            {run.contentUpdated && <InlineMessage tone="warning" className="review-updated">{ui("题目已更新，请按新版重新作答。之前的作答历史已保留。")}</InlineMessage>}
            {caseSource && <ScenarioPanel className="case-review-scenario" title={caseSource.title} text={caseSource.text}
              highlights={caseHighlights} onChange={saveHighlights} />}
            {/* The card: header, stem and answers on paper stock. Toolbar,
                status and explanation sit below it on the desk. */}
            <div className="question-card" data-tour="review-question">
              <div className="question-meta">
                <span>
                  {run.index + 1} / {run.total}
                </span>
                <div>
                  {cardNotes.map((note) => note.status === "published" && note.url
                    ? <a key={note.noteId} className="result-note-badge" href={note.url} target="_blank" rel="noopener noreferrer" title={note.title}><Badge size="sm" icon="external">{ui("已发布笔记")}</Badge></a>
                    : <Button key={note.noteId} variant="quiet" size="sm" className="result-note-badge" disabled={!onOpenNote}
                      title={note.title} onClick={() => onOpenNote?.(note.noteId)}>{ui("笔记草稿")}</Button>)}
                  {run.origin && (
                    <span className="origin-tag" title={run.origin.prompt ? uiFormat("源自：{0}", [run.origin.prompt]) : ""}>
                      {(() => {
                        const reason = run.origin.reason === "too-hard" ? ui("前置台阶") : run.origin.reason === "followup" ? ui("追问巩固") : ui("变式");
                        return run.origin.prompt ? uiFormat("{0} · 源自「{1}」", [reason, run.origin.prompt.length > 18 ? run.origin.prompt.slice(0, 18) + "…" : run.origin.prompt]) : reason;
                      })()}
                    </span>
                  )}
                  {run.card.importedFromJson && <span className="origin-tag">{ui("外部导入")}</span>}
                  {run.card.sourceQa && <span className="origin-tag">{ui("问答")}</span>}
                  <span>{run.card.topic}</span>
                  {!!publicationIssues.length && !run.card.publicationUngrable &&
                    <Popover label={ui("待核对")} className="publication-mark" panelClassName="publication-mark__panel"
                      trigger={({ props, ref }) => <Button ref={ref} variant="link" size="sm" className="publication-mark__trigger" {...props}>{ui("待核对")}</Button>}>
                      <p>{publicationIssues.join("；")}</p>
                      <Button size="sm" onClick={() => assistCard("improve", uiFormat('发布检查发现：{0}', [publicationIssues.join('; ')]))}>{ui("交给后台修题")}</Button>
                    </Popover>}
                  <Button
                    aria-label={ui("标记题目")}
                    onClick={() => openModal({ type: "flag" })}
                  >
                    ⚑
                  </Button>
                </div>
              </div>
              <ProgressBar size="sm" className="card-progress" label={ui("复习进度")} value={run.index + 1} max={Math.max(1, run.total)} />
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
                    {enOn && enStem?.prompt && (
                      <div className="en-block">
                        <span className="en-tag">EN</span>
                        <Markdown links={false} className="md-compact" text={enStem.prompt} />
                      </div>
                    )}
                  </div>
                  {run.card.multiple && (
                    <p className="muted small">{ui("多选题 · 选出所有符合条件的选项")}</p>
                  )}
                  <ChoiceFeedback options={run.card.options} feedback={run.feedback} solution={run.solution} multiple={multiple} />
                  <div className="options" key={"options:" + reviewEntryKey(run)}>
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
                                ? "selected"
                                : "")
                          }
                          data-usage="review.option"
                          onClick={() => choose(o.id)}
                        >
                          <span className="option-letter">
                            {String.fromCharCode(65 + i)}.
                          </span>
                          <div>
                            <Markdown text={o.text} links={false} className="md-compact" />
                            {enOption?.text && <p className="option-en">{enOption.text}</p>}
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
                    <Button
                      variant="primary" className="submit-answer"
                      data-usage="review.submit"
                      disabled={busy || !selected.length}
                      onClick={() =>
                        reviewAct("review.answer", { selected })
                      }
                    >{ui("提交答案")}</Button>
                  )}
                </>
              ) : isCloze ? (
                <>
                  <Cloze
                    key={"cloze:" + reviewEntryKey(run)}
                    card={run.card}
                    values={run.feedback?.answers || clozeValues}
                    onChange={actions.setClozeValue}
                    disabled={busy || !!run.feedback}
                    details={run.feedback?.details || null}
                    solution={run.solution}
                  />
                  {enOn && (enStem?.clozeText || enStem?.prompt) && (
                    <div className="en-block">
                      <span className="en-tag">EN</span>
                      <Markdown
                        links={false}
                        className="md-compact"
                        text={String(enStem.clozeText || enStem.prompt).replace(/\{\{[^{}]+\}\}/g, "＿＿")}
                      />
                    </div>
                  )}
                  {enOn && run.feedback && enAnswer?.blanks?.length > 0 && (
                    <p className="en-block en-inline-line">
                      <span className="en-tag">EN</span>
                      {enAnswer.blanks.map((b) => b.value).join(" · ")}
                    </p>
                  )}
                  {!run.feedback && (
                    <Button
                      variant="primary" className="submit-answer"
                      data-usage="review.submit"
                      disabled={
                        busy ||
                        !Object.values(clozeValues).some((v) =>
                          String(v).trim(),
                        )
                      }
                      onClick={() =>
                        reviewAct("review.answer", { answers: clozeValues })
                      }
                    >{ui("提交答案")}</Button>
                  )}
                </>
              ) : rubricCard ? (
                <>
                  <RubricAnswer run={run} data={data} call={call} value={response} onChange={actions.setResponse} busy={busy} task={gradeTask}
                    onSubmit={(text) => assistCard("grade", text)} onSetupModel={() => navigate("settings")} />
                  {prereqStrip}
                </>
              ) : (
                <>
                  <FlipCard
                    key={run.card.id}
                    run={run}
                    busy={busy}
                    showBack={showBack}
                    flipCard={flipCard}
                    enOn={enOn}
                  />
                  <SmoothHeight className="flash-follow" key={"follow:" + run.card.id}>
                  {run.card.kind === "open" && !run.revealed && (
                    <label className="response-label">{ui("先组织你的回答")}<textarea
                        rows={3}
                        value={response}
                        onChange={(e) => actions.setResponse(e.target.value)}
                        placeholder={ui("在脑中作答，或在这里写下思路（仅本轮临时草稿）")}
                      />
                    </label>
                  )}
                  {run.revealed && !run.feedback && (
                    <div className="grading">
                      <div className="grading-head">
                        <span>{run.retry ? ui("本轮重练 · 掌握程度") : ui("掌握程度")}</span>
                        <small>{ui("按 0–5 评分")}</small>
                      </div>
                      <div className="grade-scale" role="group" aria-label={ui("掌握程度评分")}>
                        {[
                          ui("完全忘记"),
                          ui("记得一点"),
                          ui("有印象"),
                          ui("勉强答对"),
                          ui("熟练"),
                          ui("轻松掌握"),
                        ].map((label, grade) => (
                          <button
                            className={
                              grade < 3 ? "grade low" : "grade high"
                            }
                            key={grade}
                            aria-label={uiFormat("{0} 分：{1}", [grade, label])}
                            aria-keyshortcuts={String(grade)}
                            data-usage="review.grade"
                            title={uiFormat("快捷键 {0}：{1}", [grade, label])}
                            disabled={busy}
                            onClick={() =>
                              reviewAct("review.answer", { grade })
                            }
                          >
                            <strong>{grade}</strong>
                            <span>{label}</span>
                          </button>
                        ))}
                      </div>
                    </div>
                  )}
                  </SmoothHeight>
                  {/* A flashcard's header floats over the card faces, so the strip goes below the card. */}
                  {prereqStrip}
                </>
              )}
            </div>
            {/* Under the card, which stays in view when a question switch pins it to the top. */}
            {contextReturnLabel && <button type="button" className="review-detour" disabled={busy} onClick={onReturnContext}>← {contextReturnLabel}</button>}
            {detour && !contextReturnLabel && <button type="button" className="review-detour" disabled={busy} onClick={onReturnFromDetour}
              title={ui("回到从信箱跳过来之前正在做的题")}>{uiFormat("← 回到之前的第 {0} 题", [detour.index + 1])}</button>}
            <ReviewToolbar
              key={reviewEntryKey(run)}
              assistMode={assistMode}
              run={run} busy={busy} expanded={run.revealed ? explain : hint}
              onToggleHelp={actions.toggleHelp}
              onAsk={() => setAssistMode((m) => (m === "ask" ? "" : "ask"))}
              onImprove={() => setAssistMode((m) => (m === "improve" ? "" : "improve"))}
              onDerive={() => setAssistMode((m) => (m === "derive" ? "" : "derive"))}
              onSlay={slayCard} onReviewAction={reviewAct}
              onNote={onMakeNote}
              onTask={onMakeTask}
              enOn={enOn}
              enBusy={!!enBusyKey && enBusyKey === reviewEntryKey(run)}
              onToggleEn={toggleEn}
              thumbs={coachProps && run.mode !== "exam" && (
                <ThumbFeedback run={run} call={coachProps.call} canShortcut={coachProps.canShortcut} onSent={(r) => r.scheduled?.length && coachProps.onStatus()}
                  onFix={(tags) => { setAssistMode("improve"); setAssistText(fixSuggestionFor(tags)); }} />
              )}
            />
            {!assistMode && <div className="action-feedback-slot">{feedback}</div>}
            {/* A stem that asks what the source says tests memory of a document's wording, not the concept: say so and offer the fix, so the learner never has to find the words. */}
            {!assistMode && !runningTask && run.mode !== "exam" && asksWhatTheSourceSays(run.card?.prompt) && (
              <p className="assist-status voice-hint" role="status">
                {ui("这道题在问「资料怎么说」，考的是背资料的措辞，不是理解或应用。")}{" "}
                <Button variant="link" size="sm" data-usage="review.voice-fix" disabled={busy} onClick={() => assistCard("improve", ui(SOURCE_VOICE_FIX))}>{ui("改成概念或情景题")}</Button>
              </p>
            )}
            <SmoothHeight className="assist-area">
              {assistMode && (
                <form
                  className="assist-form"
                  onSubmit={async (event) => {
                    event.preventDefault();
                    const mode = assistMode;
                    if (!assistText.trim() && !(mode === "ask" && helpChoices.length)) return;
                    if (await assistCard(mode, assistText.trim(), mode === "ask" ? helpChoices : [], mode === "derive" ? { relation: deriveRelation } : undefined)) {
                      if (mode === "ask" && helpChoices.includes("prerequisite") && run.prerequisites?.length)
                        studyPrerequisites(run.prerequisites);
                      setAssistMode("");
                      setAssistText("");
                      setHelpChoices([]);
                    }
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
                    <div className="assist-quick-choices" role="group" aria-label={ui("常见的问题")}>
                      {IMPROVE_SUGGESTIONS.map(([label, body]) =>
                        <Chip key={label} onClick={() => setAssistText(ui(body))}>{ui(label)}</Chip>)}
                    </div>
                  </>}
                  <label>
                    {assistMode === "ask" ? ui("补充你自己的疑问（可选）") : assistMode === "derive" ? ui("根据哪个知识点出题？写下来，后台助教会出成一道题，放进同一题组") : ui("这道题哪里不好？后台助教会直接改这张卡，可一步撤销")}
                    <textarea
                      autoFocus
                      rows={2}
                      value={assistText}
                      maxLength={1000}
                      placeholder={assistMode === "ask" ? ui("例如：不懂为什么重试会放大负载") : assistMode === "derive" ? ui("例如：什么是聚合根；为什么重试要幂等") : ui("例如：选项 B 和 C 说的是一回事；解析没说清为什么 A 错")}
                      onChange={(event) => setAssistText(event.target.value)}
                    />
                  </label>
                  <div className="action-feedback-slot">{feedback}</div>
                  <div className="assist-actions">
                    <Button type="submit" variant="primary" size="sm"
                      disabled={!assistText.trim() && !(assistMode === "ask" && helpChoices.length)}>{ui("提交到后台")}</Button>
                    <Button size="sm" onClick={() => setAssistMode("")}>{ui("取消")}</Button>
                  </div>
                  {assistMode === "ask" && <p className="muted small">{ui("提交后才启动后台助教；完成结果进信箱，做题和主对话可继续。")}</p>}
                </form>
              )}
              {runningTask && (
                <p className="assist-status" role="status">
                  <Spinner size="sm" />{uiFormat(runningTask.mode === "ask" ? "后台助教正在解答：{0}" : runningTask.mode === "derive" ? "后台助教正在出新题：{0}" : "后台助教正在改题：{0}", [runningTask.text])}
                </p>
              )}
              {!runningTask && lastTask?.status === "failed" && (
                <AssistFailure task={lastTask} busy={busy} onSettings={onModelSettings}
                  onResubmit={() => assistCard(lastTask.mode, lastTask.question || "", lastTask.mode === "ask" ? lastTask.choices || [] : [],
                    lastTask.mode === "derive" ? { relation: lastTask.relation, followupId: lastTask.followupId } : undefined)}
                  onEdit={(lastTask.mode === "ask" || lastTask.mode === "improve" || (lastTask.mode === "derive" && !lastTask.followupId))
                    ? () => { setAssistMode(lastTask.mode); setAssistText(lastTask.question || ""); setHelpChoices(lastTask.mode === "ask" ? lastTask.choices || [] : []); if (lastTask.mode === "derive") setDeriveRelation(lastTask.relation || "prerequisite"); }
                    : null} />
              )}
            </SmoothHeight>
            {coachProps?.autoAdvance > 0 && (
              <>
                <div className="autopilot-bar" key={run.index} style={{ "--autopilot-ms": coachProps.autoAdvance + "ms" }} />
                <small className="autopilot-note">{ui("自动驾驶：马上进入下一题，点任意处或按键可停下")}</small>
              </>
            )}
            {hint && !run.revealed && (
              <div className="hint">
                <Icon name="help" />
                <Markdown text={run.card.hint} />
              </div>
            )}
            {run.feedback && (
              <p className={"next-due" + (run.feedback.correct ? "" : " retry")}>
                {uiFormat("{0} · 下次复习 {1}", [run.feedback.correct ? ui("✓ 已掌握") : ui("↻ 将继续巩固"), date(run.feedback.nextDue)])}
                {run.feedback.retryQueued && <span>{" · "}{ui("已追加到本轮队尾，稍后再练一次")}</span>}
              </p>
            )}
            <WrongAnswerSource run={run} sources={data.sources} onOpen={(source, quote) => openModal({ type: "source", source, quote, back: true })} />
            {run.solution && (explain || !!run.feedback) && (
              <ReadingBlock measure className="explanation">
                <h3>{ui("理解这道题")}</h3>
                <Markdown text={run.solution.explanation} />
                {enOn && enAnswer?.explanation && (
                  <div className="en-block">
                    <span className="en-tag">EN</span>
                    <Markdown links={false} className="md-compact" text={enAnswer.explanation} />
                  </div>
                )}
                <h4>{ui("容易混淆的地方")}</h4>
                <Markdown text={run.solution.misconception} />
                {run.solution.rubric && (
                  <>
                    <h4>{ui("评分依据")}</h4>
                    <Markdown text={run.solution.rubric} />
                  </>
                )}
                <CitationDisclosure key={"citations:" + reviewEntryKey(run)} card={run.solution} sources={data.sources}
                  onOpenSource={(source, quote) => openModal({ type: "source", source, quote })} />
                {run.mode !== "exam" && <ExplanationFollowup key={reviewEntryKey(run)} run={run} call={call} readOnly
                  onDerive={(followupId, relation) => assistCard("derive", "", [], { relation, followupId })} deriving={!!runningTask} />}
              </ReadingBlock>
            )}
            {run.feedback && run.mode !== "exam" && (
              <div className="assist-actions" aria-label={ui("引导学习方式")}>
                <Chip selected={teaching?.mode === "understanding"}
                  onClick={() => { if (!teachingBusy) teachingAct("teach.start", { mode: "understanding", language: uiLocale().startsWith("en") ? "en" : "zh" }); }}>{ui("逐步理解")}</Chip>
                <Chip selected={teaching?.mode === "calculation"}
                  onClick={() => { if (!teachingBusy) teachingAct("teach.start", { mode: "calculation", language: uiLocale().startsWith("en") ? "en" : "zh" }); }}>{ui("计算题引导练习")}</Chip>
                <TeachingStatus busy={teachingBusy} failure={teachingError} onCancel={cancelTeaching} onRetry={retryTeaching} />
              </div>
            )}
            {teaching && <div className="teaching-panel">
              {teaching && (
                <ReadingBlock as="section" measure className="explanation">
                  <div className="eyebrow">
                    {uiFormat("{0} · {1} / {2}", [teaching.mode === "calculation" ? ui("计算题引导练习") : ui("逐步理解"), Math.min(teaching.index + 1, teaching.total), teaching.total])}
                  </div>
                  <ProgressBar className="teaching-progress" size="sm" value={teaching.index} max={teaching.total}
                    label={teaching.mode === "calculation" ? ui("计算题引导练习") : ui("逐步理解")} />
                  {teaching.mode === "calculation" && (
                    <p className="muted small">{ui("每次只练当前步骤。AI 反馈用于辅助学习，不能证明计算正确。")}</p>
                  )}
                  {teaching.feedback && (
                    <Markdown className="teaching-feedback" text={teaching.feedback} />
                  )}
                  {teaching.complete ? (
                    <>
                      <h3>{ui("把理解迁移到下一题")}</h3>
                      <Markdown text={teaching.transfer} />
                    </>
                  ) : (
                    <>
                      {teaching.mode === "calculation" && <>
                        <h3>{ui(CALCULATION_STAGE_LABELS[teaching.stage] || "计算题引导练习")}</h3>
                      </>}
                      <Markdown text={teaching.lesson} />
                      {teaching.mode === "calculation" && <>
                        <dl className="teaching-context">
                          <div><dt>{ui("本步假设")}</dt><dd><Markdown text={teaching.assumptions} /></dd></div>
                          <div><dt>{ui("本步单位")}</dt><dd><Markdown text={teaching.units} /></dd></div>
                          <div><dt>{ui("精度与舍入")}</dt><dd><Markdown text={teaching.rounding} /></dd></div>
                        </dl>
                        <CitationDisclosure card={teaching} sources={data.sources}
                          onOpenSource={(source, quote) => openModal({ type: "source", source, quote })} />
                      </>}
                      <form
                        onSubmit={(e) => {
                          e.preventDefault();
                          teachingAct(
                            "teach.answer",
                            { id: teaching.id, stepIndex: teaching.index, answer: teachAnswer },
                          );
                        }}
                      >
                        <label>
                          <Markdown text={teaching.check} />
                          <textarea
                            required
                            maxLength={10000}
                            rows={3}
                            aria-label={ui("当前步骤的回答")}
                            value={teachAnswer}
                            onChange={(e) => actions.setTeachAnswer(e.target.value)}
                          />
                        </label>
                        <Button variant="primary"
                          disabled={teachingBusy || !teachAnswer.trim()}
                          onPointerUp={(e) => e.currentTarget.closest(".study-app")?.focus({ preventScroll: true })}
                         type="submit">{ui("检查理解 →")}</Button>
                      </form>
                    </>
                  )}
                </ReadingBlock>
              )}
            </div>}
          </div>
        </div>
      )}
    </section>
  );
}
