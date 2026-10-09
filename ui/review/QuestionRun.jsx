import { ui, uiFormat, uiLocale } from "../i18n.js";
import React from "react";
import Markdown from "../Markdown.jsx";
import Cloze from "../Cloze.jsx";
import FlipCard from "../FlipCard.jsx";
import SmoothHeight from "../SmoothHeight.jsx";
import ReviewToolbar from "../ReviewToolbar.jsx";
import CitationDisclosure from "../CitationDisclosure.jsx";
import ExplanationFollowup from "../ExplanationFollowup.jsx";
import { asksWhatTheSourceSays, SOURCE_VOICE_FIX } from "../../lib/question-voice.js";
import ChoiceFeedback from "../ChoiceFeedback.jsx";
import ThumbFeedback from "../ThumbFeedback.jsx";
import { reviewEntryKey } from "../async.js";
import ModelErrorNote from "../ModelErrorNote.jsx";
import TeachingStatus from "./TeachingStatus.jsx";
import { describeModelError, plainAssistFailure } from "../generation-status.js";
import { readableQualityIssue } from "../quality.js";
import { ReadingBlock, useReadingProps } from "../reading-settings/ReadingSettings.jsx";
import { Badge, Banner, Button, Chip, Icon, InlineMessage, Popover, ProgressBar, SegmentedControl, Spinner } from "../components/index.js";
import { useStudy } from "../study-context.jsx";
import { HELP_CHOICES, IMPROVE_SUGGESTIONS } from "../agent-prompts/card.js";
import { fixSuggestionFor } from "../card-fix.js";
import reviewCss from "./review.css";
import { useInjectCss } from "../shared.js";
import { RubricAnswer, ScenarioPanel } from "../CaseWorkspace.jsx";
import { WrongAnswerSource } from "../document-preview/practice/ReadingReturn.jsx";
import { NextDue } from "../NextDue.jsx";

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

export default function QuestionRun({ session, data, coachProps, links = {}, context = {}, feedback }) {
  useInjectCss(reviewCss, "study-review");
  const { run, entry, showBack, showEn, enBusyKey, teachingBusy, teachingError, choice, isCloze, autopilot, actions } = session;
  const { selected, hint, explain, response, teaching, teachAnswer, clozeValues } = entry;
  const { reviewAct, choose, flipCard, assistCard, slayCard, studyPrerequisites, teachingAct, cancelTeaching, retryTeaching, toggleEn } = actions;
  const { call, busy, openModal, openSettings } = useStudy();
  const { onOpenNote, onMakeNote, onMakeTask, onModelSettings } = links;
  const { label: contextReturnLabel, onReturn: onReturnContext, detour, onReturnFromDetour } = context;
  const assistTasks = data?.assist;
  const multiple = run.card?.multiple || run.card?.kind === "multi";
  const publicationIssues = (run.card?.publicationIssues || []).map((issue) =>
    readableQualityIssue(`Card 1: ${issue}`).replace(/^第 1 题：/, ""));
  // EN button: show the cached English after each Chinese stem and answer.
  const enOn = !!showEn && run.mode !== "exam" && !run.complete;
  const enStem = enOn ? run.card?.translation : null;
  const enAnswer = enOn && run.solution ? run.solution.translation : null;
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
  const saveHighlights = (next) => {
    setCaseHighlights(next);
    Promise.resolve(call?.("review.highlights", { runId: run.id, highlights: next })).catch(() => {});
  };
  const cardNotes = data?.noteBadges?.[run.card?.id] || [];
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
    <div className="review-body">
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
        <div className={"question-card" + (!choice && !isCloze && !rubricCard ? "" : " sh-paper-card sh-paper-card--roomy")} data-tour="review-question">
          <div className="question-meta">
            <span>
              {run.index + 1} / {run.total}
            </span>
            <div>
              {cardNotes.map((note) => note.status === "published" && note.url
                ? <a key={note.noteId} className="result-note-link" href={note.url} target="_blank" rel="noopener noreferrer" title={note.title}><Badge size="sm" icon="external">{ui("已发布笔记")}</Badge></a>
                : <Button key={note.noteId} variant="quiet" size="sm" className="result-note-link" disabled={!onOpenNote}
                  title={note.title} onClick={() => onOpenNote?.(note.noteId)}>{ui("笔记草稿")}</Button>)}
              {run.origin && (
                <Badge size="sm" className="origin-note" title={run.origin.prompt ? uiFormat("源自：{0}", [run.origin.prompt]) : ""}>
                  {(() => {
                    const reason = run.origin.reason === "too-hard" ? ui("前置台阶") : run.origin.reason === "followup" ? ui("追问巩固") : ui("变式");
                    return run.origin.prompt ? uiFormat("{0} · 源自「{1}」", [reason, run.origin.prompt.length > 18 ? run.origin.prompt.slice(0, 18) + "…" : run.origin.prompt]) : reason;
                  })()}
                </Badge>
              )}
              {run.card.importedFromJson && <Badge size="sm" className="origin-note">{ui("外部导入")}</Badge>}
              {run.card.sourceQa && <Badge size="sm" className="origin-note">{ui("问答")}</Badge>}
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
                    <Badge size="sm" tone="accent" className="en-mark">EN</Badge>
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
                            ? "option--selected"
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
                  <Badge size="sm" tone="accent" className="en-mark">EN</Badge>
                  <Markdown
                    links={false}
                    className="md-compact"
                    text={String(enStem.clozeText || enStem.prompt).replace(/\{\{[^{}]+\}\}/g, "＿＿")}
                  />
                </div>
              )}
              {enOn && run.feedback && enAnswer?.blanks?.length > 0 && (
                <p className="en-block en-inline-line">
                  <Badge size="sm" tone="accent" className="en-mark">EN</Badge>
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
              <RubricAnswer run={run} data={data} value={response} onChange={actions.setResponse} task={gradeTask}
                onSubmit={(text) => assistCard("grade", text)} onSetupModel={onModelSettings || (() => openSettings("settings-model"))} />
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
          autopilot={autopilot} onToggleAutopilot={actions.toggleAutopilot}
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
        {run.feedback && <NextDue feedback={run.feedback} />}
        <WrongAnswerSource run={run} sources={data.sources} onOpen={(source, quote) => openModal({ type: "source", source, quote, back: true })} />
        {run.solution && (explain || !!run.feedback) && (
          <ReadingBlock measure className="explanation">
            <h3>{ui("理解这道题")}</h3>
            <Markdown text={run.solution.explanation} />
            {enOn && enAnswer?.explanation && (
              <div className="en-block">
                <Badge size="sm" tone="accent" className="en-mark">EN</Badge>
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
            {run.mode !== "exam" && <ExplanationFollowup key={reviewEntryKey(run)} run={run} readOnly
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
  );
}
