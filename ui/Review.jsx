import { ui, uiFormat, uiLocale } from "./i18n.js";
import React from "react";
import Markdown from "./Markdown.jsx";
import Cloze from "./Cloze.jsx";
import Icon from "./Icon.jsx";
import ReviewNavigator from "./ReviewNavigator.jsx";
import FlipCard from "./FlipCard.jsx";
import SmoothHeight from "./SmoothHeight.jsx";
import ReviewToolbar from "./ReviewToolbar.jsx";
import CitationDisclosure from "./CitationDisclosure.jsx";
import ExplanationFollowup from "./ExplanationFollowup.jsx";
import ChoiceFeedback from "./ChoiceFeedback.jsx";
import CoachDebrief from "./CoachDebrief.jsx";
import ThumbFeedback from "./ThumbFeedback.jsx";
import { reviewEntryKey } from "./async.js";
import { readableQualityIssue } from "./quality.js";
import ResultBreakdown from "./ResultBreakdown.jsx";
import resultCss from "./review-results.css";
import { useInjectCss } from "./shared.js";

/* 复习视图：quiz/multi 选项作答、cloze 填空、闪卡翻面与开放问答自评，
   附前置题条、逐步讲解面板与薄弱主题收尾。会话状态（run）与本地作答
   状态都由 App 持有，本组件只负责渲染与交互转发。 */
const date = (v) =>
  v
    ? new Date(v).toLocaleString(uiLocale(), {
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      })
    : ui("现在");
const HELP_CHOICES = [
  { id: "plain", label: "通俗详解" },
  { id: "angle", label: "换个角度讲" },
  { id: "example", label: "举个具体例子" },
  { id: "steps", label: "逐步推理" },
  { id: "prerequisite", label: "补前置知识" },
  { id: "mistake", label: "分析我错在哪" },
];

export default function Review({
  run,
  detour,
  onReturnFromDetour,
  onBackToWorkflow,
  onCourseFlow,
  data,
  busy,
  host,
  choice,
  isCloze,
  shellTitle,
  showBack,
  selected,
  hint,
  explain,
  response,
  teaching,
  teachingBusy,
  teachingAct,
  teachAnswer,
  clozeValues,
  setModal,
  setPage,
  setFlag,
  setExplain,
  setHint,
  setResponse,
  setTeachAnswer,
  setClozeValues,
  choose,
  flipCard,
  reviewAct,
  studyPrerequisites,
  assistCard,
  assistTasks,
  slayCard,
  coachProps,
  askInChat,
  act,
  enterRun,
  showEn,
  enBusyKey,
  toggleEn,
  call,
  openSkeleton,
  onMakeNote,
  onMakeTask,
  onOpenNote,
  feedback,
  contextReturnLabel,
  onReturnContext,
}) {
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
  React.useEffect(() => {
    setAssistMode("");
    setAssistText("");
    setHelpChoices([]);
  }, [run.id, run.index, run.card?.id]);
  const cardTasks = (assistTasks || []).filter((task) => task.cardId === run.card?.id);
  const runningTask = cardTasks.find((task) => task.status === "running");
  const lastTask = cardTasks.at(-1);
  const skeletonHere = run.card ? data?.skeletons?.find((k) => k.cardIds.includes(run.card.id)) : null;
  const cardNotes = data?.noteBadges?.[run.card?.id] || [];
  const nextFreshCount = run.freshRemaining ?? [...new Set((run.scope || []).map((scope) => scope.deckId))]
    .reduce((count, deckId) => count + (data?.progress?.[deckId]?.counts?.new || 0), 0);
  const prereqStrip = run.prerequisites?.length > 0 && !run.complete && (
    <details className="prereq-strip">
      <summary>
        <span>{ui("前置题 ")}{run.prerequisites.length}{ui(" · 已掌握")}{" "}
          {run.prerequisites.filter((p) => !["new", "weak"].includes(p.level)).length}
        </span>
        {(() => {
          const unlearned = run.prerequisites.some((p) => ["new", "weak"].includes(p.level));
          return (
            <button
              className={unlearned ? "primary pill" : "pill"}
              disabled={busy}
              title={unlearned ? ui("先学没掌握的前置题，学完回到这道题") : ui("把前置题再过一遍自查，做完回到这道题")}
              onClick={(e) => {
                e.preventDefault();
                studyPrerequisites(run.prerequisites);
              }}
            >
              {unlearned ? ui("先学前置 →") : ui("自查前置 →")}
            </button>
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
      className={"review-page " + (!choice ? "flash-mode" : "") + (rail ? " has-rail" : "")}
    >
      {/* The rail is a full-height column of the page, not of the question body,
          so it is pinned from the first frame instead of sliding up to stick. */}
      {rail && <ReviewNavigator run={run} busy={busy} onJump={(index) => reviewAct("review.move", { index })} />}
      <div className="review-heading">
        <div>
          {flow && <p className="review-flow-origin">{ui("学习流")}{flow.stepIndex >= 0 ? uiFormat(" · 第 {0}/{1} 步", [flow.stepIndex + 1, flow.stepCount]) : ""} · {flow.stepTitle}</p>}
          <h1>
            {shellTitle}
            {run.mode === "flashcard" ? ui(" · 闪卡") : ""}
            {run.retry && !run.complete ? ui(" · 本轮重练") : ""}
          </h1>
          <button
            className="pill"
            onClick={() => setModal({ type: "sources" })}
          >{ui("查看 ")}{run.sourceIds?.length || 0}{ui(" 份资料")}</button>
          {skeletonHere && openSkeleton && (
            <button className="pill" title={uiFormat("这道题在知识骨架「{0}」里", [skeletonHere.title])} onClick={() => openSkeleton(skeletonHere.id)}>{ui("◈ 知识骨架")}</button>
          )}
        </div>
        <div className="review-heading-actions">
          {host.openInSidebar && !run.complete && (
            <button
              className="ghost-btn"
              title={ui("题目放到右栏，主区域回到对话")}
              onClick={() => host.openInSidebar(run.id)}
            >{ui("在右栏打开")}</button>
          )}
          <button className="review-return" aria-label={flow ? ui("回到学习流") : ui("返回学习库")} onClick={() => flow ? onBackToWorkflow(flow.sessionId) : setPage("library")}>
            <span className="review-return-full">{flow ? ui("回到学习流") : ui("返回学习库")}</span>
            <span className="review-return-short" aria-hidden="true">{ui("返回")}</span>
          </button>
        </div>
      </div>
      {run.complete ? (
        // Distinct keys: without them React reuses the question body's DOM nodes
        // for the summary, and the ✓ badge inherited .question-area's inline
        // min-height (set by the pinning effect above), stretching into an oval.
        <div key="summary" className="session-summary result-page">
          <div className="result-kicker">{ui("本轮学习结果")}</div>
          <h1 className="result-title">{run.closed ? ui("这一轮，已结束。") : ui("这一轮，完成了。")}</h1>
          <p className="result-subtitle">{shellTitle} · {run.questions ?? run.total}{ui(" 道题")}</p>
          <div className="result-hero">
            <div className="result-headline">
              <strong>{run.correct}</strong>
              <span>{ui("道题已掌握 / ")}{run.questions ?? run.total}{ui(" 道")}</span>
              {run.retries > 0 && <small>{ui("另有 ")}{run.retries}{ui(" 次队尾重练")}</small>}
            </div>
            <ResultBreakdown total={run.questions ?? run.total} answered={run.answered} correct={run.correct} />
          </div>
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
              onReviewWeak={coachProps.onReviewWeak}
            />
          )}
          <div className="summary-topics">
            <h3>{ui("接下来重点复习 · 最多 3 个主题")}</h3>
            {(run.weakTopics || []).slice(0, 3).map((t) => (
              <span className="tag" key={t}>
                {t}
              </span>
            ))}
            {!run.weakTopics?.length && (
              <p className="muted">{ui("本轮没有低分记录，继续按间隔复习巩固。")}</p>
            )}
          </div>
          {run.course && (
            <p className="summary-course">{ui("课程进度 · 已学 ")}<strong>{run.course.learned ?? 0} / {run.course.cards ?? 0}</strong>{ui(" 题")}{run.course.chapter ? uiFormat(" · 第 {0} / {1} 章「{2}」{3}/{4}", [run.course.chapter.index + 1, run.course.chapters, run.course.chapter.title, run.course.chapter.learned, run.course.chapter.total]) : ui(" · 全部章节都学过了")}
              {run.course.next?.label ? <span>{ui(" · 下一批：")}{run.course.next.label}</span> : null}
            </p>
          )}
          <div className="summary-actions">
            {run.course?.next && <button className="primary" disabled={busy}
              onClick={() => act("review.start", { mode: "course", course: run.course.name, fresh: true }, enterRun)}>{ui("继续课程下一批 →")}</button>}
            {run.course?.next?.fresh > 0 && onCourseFlow && <button disabled={busy} onClick={() => onCourseFlow({ course: run.course.name })}>{ui("先讲后练下一批")}</button>}
            {run.mode === "new" && nextFreshCount > 0 && (
              <button className="primary" disabled={busy} onClick={() => act("review.start",
                { mode: "new", scope: run.scope ?? [{ deckId: run.deckId }], count: 10, ordered: true, fresh: true }, enterRun)}>{ui("继续下一批新题 →")}</button>
            )}
            {flow && <button className="primary" disabled={busy} onClick={() => onBackToWorkflow(flow.sessionId)}>
              {flow.current ? ui("回到学习流，继续下一步 →") : ui("回到学习流 →")}</button>}
            {contextReturnLabel && <button disabled={busy} onClick={onReturnContext}>← {contextReturnLabel}</button>}
            {detour && <button className="primary" disabled={busy} onClick={onReturnFromDetour}>{uiFormat("回到之前的第 {0} 题 →", [detour.index + 1])}</button>}
            {run.returnTo && !detour && <button className="primary" disabled={busy}
              onClick={() => act("review.get", { runId: run.returnTo }, enterRun)}>{ui("回到原题 →")}</button>}
            <button onClick={() => setPage("library")}>{ui("回到学习目录")}</button>
          </div>
          <details key={run.id} className="result-details">
            <summary>{ui("更多结果与练习")}</summary>
            <p className="muted">{ui("每道题的下次复习时间已保存。")}</p>
            <div className="summary-actions">
            {run.mode === "path" && !run.returnTo && !flow && (
              <button
                className="primary"
                disabled={busy}
                onClick={() => act("review.start", { mode: "path", scope: run.scope || [], fresh: true }, enterRun)}
              >
                {run.scope?.length ? ui("再练此范围") : ui("继续学习")}
              </button>
            )}
            {run.weakTopics?.length > 0 && (
              <button
                onClick={() =>
                  askInChat(
                    `我刚在「${shellTitle}」里这些主题还没掌握稳：${run.weakTopics.join("、")}。请结合学习库资料逐个讲清楚，并各出一道小题检查我。`,
                  )
                }
              >{ui("在对话中讲解薄弱点")}</button>
            )}
            </div>
          </details>
        </div>
      ) : (
        <div key="body" className="review-body">
          <div
            className={
              "question-area " +
              (!choice && !isCloze ? "flash-area" : "")
            }
          >
            {run.contentUpdated && <p className="warning" role="status">{ui("题目已更新，请按新版重新作答。之前的作答历史已保留。")}</p>}
            {/* The card: header, stem and answers on paper stock. Toolbar,
                status and explanation sit below it on the desk. */}
            <div className="question-card"
              style={{ "--progress": `${Math.round(((run.index + 1) / Math.max(1, run.total)) * 100)}%` }}>
              <div className="question-meta">
                <span>
                  {run.index + 1} / {run.total}
                </span>
                <div>
                  {cardNotes.map((note) => note.status === "published" && note.url
                    ? <a key={note.noteId} className="pill result-note-badge" href={note.url} target="_blank" rel="noopener noreferrer" title={note.title}>{ui("已发布笔记 ↗")}</a>
                    : <button key={note.noteId} className="pill result-note-badge" type="button" disabled={!onOpenNote}
                      title={note.title} onClick={() => onOpenNote?.(note.noteId)}>{ui("笔记草稿")}</button>)}
                  {run.origin && (
                    <span className="origin-tag" title={run.origin.prompt ? uiFormat("源自：{0}", [run.origin.prompt]) : ""}>
                      {run.origin.reason === "too-hard" ? ui("前置台阶") : run.origin.reason === "followup" ? ui("追问巩固") : ui("变式")}
                      {run.origin.prompt ? uiFormat(" · 源自「{0}」", [run.origin.prompt.length > 18 ? run.origin.prompt.slice(0, 18) + "…" : run.origin.prompt]) : ""}
                    </span>
                  )}
                  {run.card.importedFromJson && <span className="origin-tag">{ui("外部导入")}</span>}
                  <span>{run.card.topic}</span>
                  {!!publicationIssues.length && !run.card.publicationUngrable &&
                    <details className="publication-mark">
                      <summary>{ui("待核对")}</summary>
                      <div className="publication-mark-popover">
                        <p>{publicationIssues.join("；")}</p>
                        <button type="button" className="pill" onClick={() =>
                          assistCard("improve", `发布检查发现：${publicationIssues.join("；")}`)}>{ui("交给后台修题")}</button>
                      </div>
                    </details>}
                  <button
                    aria-label={ui("标记题目")}
                    onClick={() => {
                      setFlag("");
                      setModal({ type: "flag" });
                    }}
                  >
                    ⚑
                  </button>
                </div>
              </div>
              <div
                className="card-progress"
                role="progressbar"
                aria-label={ui("复习进度")}
                aria-valuemin={0}
                aria-valuemax={run.total}
                aria-valuenow={run.index + 1}
              />
              {(choice || isCloze || run.card.publicationUngrable) && prereqStrip}
              {run.card.publicationUngrable ? (
                <div className="quality-note warning" role="status">
                  <div className="question"><Markdown text={run.card.prompt || "题干尚未填写"} /></div>
                  <p>{ui("这道题缺少可判分内容。你可以交给助教修改，或跳过；跳过不会记录成绩或改变复习进度。")}</p>
                  {!!publicationIssues.length && <p>{publicationIssues.join("；")}</p>}
                  <button type="button" disabled={busy} onClick={() =>
                    assistCard("improve", `发布检查发现：${publicationIssues.join("；")}`)}>{ui("交给后台修题")}</button>
                  <button className="primary" disabled={busy} onClick={() => reviewAct("review.skip")}>{ui("跳过此题，不计成绩 →")}</button>
                </div>
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
                    <button
                      className="primary submit-answer"
                      disabled={busy || !selected.length}
                      onClick={() =>
                        reviewAct("review.answer", { selected })
                      }
                    >{ui("提交答案")}</button>
                  )}
                </>
              ) : isCloze ? (
                <>
                  <Cloze
                    key={"cloze:" + reviewEntryKey(run)}
                    card={run.card}
                    values={run.feedback?.answers || clozeValues}
                    onChange={(id, value) =>
                      setClozeValues((v) => ({ ...v, [id]: value }))
                    }
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
                    <button
                      className="primary submit-answer"
                      disabled={
                        busy ||
                        !Object.values(clozeValues).some((v) =>
                          String(v).trim(),
                        )
                      }
                      onClick={() =>
                        reviewAct("review.answer", { answers: clozeValues })
                      }
                    >{ui("提交答案")}</button>
                  )}
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
                        onChange={(e) => setResponse(e.target.value)}
                        placeholder={ui("在脑中作答，或在这里写下思路（仅本轮临时草稿）")}
                      />
                    </label>
                  )}
                  {run.revealed && !run.feedback && (
                    <div className="grading">
                      <div className="grading-head">
                        <span>{run.retry ? ui("本轮重练 · ") : ""}{ui("掌握程度")}</span>
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
              onToggleHelp={() => run.revealed ? setExplain(!explain) : setHint(!hint)}
              onAsk={() => setAssistMode((m) => (m === "ask" ? "" : "ask"))}
              onImprove={() => setAssistMode((m) => (m === "improve" ? "" : "improve"))}
              onSlay={slayCard} onReviewAction={reviewAct}
              onNote={onMakeNote}
              onTask={onMakeTask}
              enOn={enOn}
              enBusy={!!enBusyKey && enBusyKey === reviewEntryKey(run)}
              onToggleEn={toggleEn}
              thumbs={coachProps && run.mode !== "exam" && (
                <ThumbFeedback run={run} call={coachProps.call} canShortcut={coachProps.canShortcut} onSent={(r) => r.scheduled?.length && coachProps.onStatus()} />
              )}
            />
            {!assistMode && <div className="action-feedback-slot">{feedback}</div>}
            <SmoothHeight className="assist-area">
              {assistMode && (
                <form
                  className="assist-form"
                  onSubmit={async (event) => {
                    event.preventDefault();
                    const mode = assistMode;
                    if (!assistText.trim() && !(mode === "ask" && helpChoices.length)) return;
                    if (await assistCard(mode, assistText.trim(), mode === "ask" ? helpChoices : [])) {
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
                        <button type="button" key={choice.id}
                          className={"pill" + (helpChoices.includes(choice.id) ? " pill-on" : "")}
                          aria-pressed={helpChoices.includes(choice.id)}
                          onClick={() => setHelpChoices((items) => items.includes(choice.id)
                            ? items.filter((item) => item !== choice.id) : [...items, choice.id])}>
                          {ui(choice.label)}
                        </button>)}
                    </div>
                  </>}
                  <label>
                    {assistMode === "ask" ? ui("补充你自己的疑问（可选）") : ui("这道题哪里不好？后台助教会直接改这张卡，可一步撤销")}
                    <textarea
                      autoFocus
                      rows={2}
                      value={assistText}
                      maxLength={1000}
                      placeholder={assistMode === "ask" ? ui("例如：不懂为什么重试会放大负载") : ui("例如：选项 B 和 C 说的是一回事；解析没说清为什么 A 错")}
                      onChange={(event) => setAssistText(event.target.value)}
                    />
                  </label>
                  <div className="action-feedback-slot">{feedback}</div>
                  <div className="assist-actions">
                    <button type="submit" className="primary pill"
                      disabled={!assistText.trim() && !(assistMode === "ask" && helpChoices.length)}>{ui("提交到后台")}</button>
                    <button type="button" className="pill" onClick={() => setAssistMode("")}>{ui("取消")}</button>
                  </div>
                  {assistMode === "ask" && <p className="muted small">{ui("提交后才启动后台助教；完成结果进信箱，做题和主对话可继续。")}</p>}
                </form>
              )}
              {runningTask && (
                <p className="assist-status" role="status">
                  <i className="assist-spin" aria-hidden="true" />{ui("后台助教正在")}{runningTask.mode === "ask" ? ui("解答") : ui("改题")}：{runningTask.text}
                </p>
              )}
              {!runningTask && lastTask?.status === "failed" && (
                <p className="assist-status failed" role="status">{ui("后台助教没能完成：")}{lastTask.message || ui("任务失败")}{ui("。可以重新提交。")}</p>
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
                <Icon>♧</Icon>
                <Markdown text={run.card.hint} />
              </div>
            )}
            {run.feedback && (
              <p className={"next-due" + (run.feedback.correct ? "" : " retry")}>
                {run.feedback.correct ? ui("✓ 已掌握") : ui("↻ 将继续巩固")}{ui(" · 下次复习 ")}{date(run.feedback.nextDue)}
                {run.feedback.retryQueued && <span>{ui(" · 已追加到本轮队尾，稍后再练一次")}</span>}
              </p>
            )}
            {run.solution && (explain || !!run.feedback) && (
              <div className="explanation">
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
                  onOpenSource={(source, quote) => setModal({ type: "source", source, quote })} />
                {run.mode !== "exam" && <ExplanationFollowup key={reviewEntryKey(run)} run={run} call={call} readOnly />}
              </div>
            )}
            {teaching && <div className="teaching-panel">
              {teaching && (
                <section className="explanation">
                  <div className="eyebrow">
                    GUIDED UNDERSTANDING ·{" "}
                    {Math.min(teaching.index + 1, teaching.total)} /{" "}
                    {teaching.total}
                  </div>
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
                      <Markdown text={teaching.lesson} />
                      <form
                        onSubmit={(e) => {
                          e.preventDefault();
                          teachingAct(
                            "teach.answer",
                            { id: teaching.id, answer: teachAnswer },
                          );
                        }}
                      >
                        <label>
                          <Markdown text={teaching.check} />
                          <textarea
                            required
                            maxLength={10000}
                            rows={3}
                            value={teachAnswer}
                            onChange={(e) =>
                              setTeachAnswer(e.target.value)
                            }
                          />
                        </label>
                        <button
                          className="primary"
                          disabled={teachingBusy || !teachAnswer.trim()}
                          onPointerUp={(e) => e.currentTarget.closest(".study-app")?.focus({ preventScroll: true })}
                        >{ui("检查理解 →")}</button>
                      </form>
                    </>
                  )}
                </section>
              )}
            </div>}
          </div>
        </div>
      )}
    </section>
  );
}
