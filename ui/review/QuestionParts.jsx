import React from "react";
import { ui, uiFormat } from "../i18n.js";
import Cloze from "../Cloze.jsx";
import EnBlock from "../EnBlock.jsx";
import Markdown from "../Markdown.jsx";
import { Badge, Button, Tooltip } from "../components/index.js";
import { useStudyBusy } from "../study-context.jsx";
import { MasteryMark } from "../document-preview/practice/MasteryMark.jsx";
import { fixedOptionLabel, optionMark } from "../option-label.js";
import QuestionSourcePage from "./QuestionSourcePage.jsx";
import LearningActions from "./LearningActions.jsx";
import { clozeBlankIds } from "../../lib/cloze-text.js";
import { reviewEntryKey } from "../async.js";

export const MAX_QUESTION_META_BADGES = 2;

/** Live deck mastery readout inside the left side of the question meta bar. */
export function QuestionLiveMastery({ run }) {
  if (run.mode === "exam" || !(run.liveMastery?.before?.total > 0) || !(run.liveMastery?.after?.total > 0)) return null;
  const { before, after } = run.liveMastery;
  const delta = after.percent - before.percent;
  return (
    <>
      <span className="question-meta__break" aria-hidden="true" />
      <span className="question-live-mastery" data-testid="live-mastery" data-rose={delta > 0 ? "true" : delta < 0 ? "down" : undefined}>
        <MasteryMark summary={after} size={13} />
        <span>{delta !== 0 ? uiFormat("本组 {0}% → {1}%", [before.percent, after.percent]) : uiFormat("本组 {0}%", [after.percent])}</span>
        {delta > 0 && <strong className="question-live-mastery__delta">{`+${delta}%`}</strong>}
      </span>
    </>
  );
}

/** Origin, focus, note links, source page badge, and topic tag on the right side of the question meta bar, capped at 2 inline badges. */
export function QuestionMetaBadges({ run, sources, cardNotes = [], onOpenNote }) {
  const reason = run.origin?.reason === "too-hard" ? ui("前置台阶") : run.origin?.reason === "followup" ? ui("追问巩固") : ui("变式");
  const items = [];
  if (run.card?.focus) {
    items.push({
      key: "focus",
      summary: ui("重点"),
      node: <Badge key="focus" size="sm" tone="accent" className="origin-note">{ui("重点")}</Badge>,
    });
  }
  if (run?.mode !== "exam" && Number.isInteger(run?.cardSource?.page)) {
    const pageLabel = run.cardSource.unit === "slide" ? uiFormat("第 {0} 张", [run.cardSource.page])
      : run.cardSource.unit === "part" ? uiFormat("第 {0} 节", [run.cardSource.page])
      : uiFormat("第 {0} 页", [run.cardSource.page]);
    items.push({
      key: "page",
      summary: pageLabel,
      node: <QuestionSourcePage key="page" run={run} sources={sources} />,
    });
  }
  if (run.origin) {
    const originText = run.origin.prompt
      ? uiFormat("{0} · 源自「{1}」", [reason, run.origin.prompt.length > 18 ? run.origin.prompt.slice(0, 18) + "…" : run.origin.prompt])
      : reason;
    const originBadge = <Badge key="origin" size="sm" className="origin-note">{originText}</Badge>;
    items.push({
      key: "origin",
      summary: originText,
      node: run.origin.prompt
        ? <Tooltip key="origin" layer content={uiFormat("源自：{0}", [run.origin.prompt])}>{originBadge}</Tooltip>
        : originBadge,
    });
  }
  for (const note of cardNotes) {
    const statusLabel = note.status === "published" ? ui("已发布笔记") : ui("笔记草稿");
    const linkNode = note.status === "published" && note.url
      ? <a key={note.noteId} className="result-note-link" href={note.url} target="_blank" rel="noopener noreferrer"><Badge size="sm" icon="external">{statusLabel}</Badge></a>
      : <Button key={note.noteId} variant="quiet" size="sm" iconEnd="arrow-right" className="result-note-link question-meta__action" disabled={!onOpenNote}
          onClick={() => onOpenNote?.(note.noteId)}>{statusLabel}</Button>;
    items.push({
      key: `note:${note.noteId}`,
      summary: note.title ? `${statusLabel}：${note.title}` : statusLabel,
      node: note.title ? <Tooltip key={note.noteId} layer content={note.title}>{linkNode}</Tooltip> : linkNode,
    });
  }
  if (run.card?.sourceQa) {
    items.push({
      key: "qa",
      summary: ui("问答"),
      node: <Badge key="qa" size="sm" className="origin-note">{ui("问答")}</Badge>,
    });
  }
  if (run.card?.importedFromJson) {
    items.push({
      key: "imported",
      summary: ui("外部导入"),
      node: <Badge key="imported" size="sm" className="origin-note">{ui("外部导入")}</Badge>,
    });
  }
  const inlineItems = items.slice(0, MAX_QUESTION_META_BADGES);
  const overflowItems = items.slice(MAX_QUESTION_META_BADGES);
  const overflowTitle = overflowItems.map((item) => item.summary).filter(Boolean).join(" · ");
  const topicNode = (
    <span className="question-meta__topic" data-overflow-meta={overflowTitle || undefined}>
      {run.card?.topic}
      {overflowItems.length > 0 && <small className="question-meta__overflow">{` · +${overflowItems.length}`}</small>}
    </span>
  );
  return (
    <>
      {inlineItems.map((item) => item.node)}
      {overflowTitle ? <Tooltip layer content={overflowTitle}>{topicNode}</Tooltip> : topicNode}
    </>
  );
}

/** Secondary post-answer disclosure: schedule details, non-picked option notes, misconception/rubric, and guided learning actions. */
export function PostAnswerDetails({ session, data, model, onModelSettings, openModal, showSolution, verdict = false, enOn = false, enAnswer = null, defaultOpen = false, nextDueNode = null, misconceptionShownAbove = false }) {
  const { run, choice } = session;
  const key = reviewEntryKey(run);
  const [openState, setOpenState] = React.useState({ key, open: !!defaultOpen });
  const isOpen = openState.key === key ? openState.open : !!defaultOpen;
  if (!run?.feedback || run.mode === "exam") return null;
  const otherOptions = choice && Array.isArray(run.card?.options) && Array.isArray(run.solution?.options)
    ? run.card.options.flatMap((option, index) => {
      const sol = run.solution.options.find((item) => item.id === option.id);
      const picked = run.feedback?.selected?.includes(option.id);
      if (sol?.correct || picked || !sol?.explanation) return [];
      const enOpt = enOn ? enAnswer?.options?.find((item) => item.id === option.id) : null;
      return [{
        id: option.id,
        mark: optionMark(run.card, option, index),
        label: verdict ? fixedOptionLabel(run.card, option) : option.text,
        explanation: sol.explanation,
        enExplanation: enOpt?.explanation || "",
      }];
    })
    : [];
  const summaryLabel = otherOptions.length > 0
    ? uiFormat("更多解析与巩固方式（含 {0} 个干扰项辨析）", [otherOptions.length])
    : ui("更多解析与巩固方式");
  return (
    <details className="post-answer-more" open={isOpen || undefined} onToggle={(event) => setOpenState({ key, open: event.currentTarget.open })}>
      <summary className="post-answer-more__summary">{summaryLabel}</summary>
      <div className="post-answer-more__body">
        {isOpen && nextDueNode}
        {otherOptions.length > 0 && (
          <div className="post-answer-more__options">
            <h4>{ui("其他选项辨析")}</h4>
            <ul className="post-answer-more__option-list">
              {otherOptions.map((item) => (
                <li key={item.id} className="post-answer-more__option-item">
                  <span className="post-answer-more__option-mark">{item.mark}</span>
                  <div>
                    <Markdown text={item.explanation} links={false} className="md-compact option-explanation" />
                    {item.enExplanation && <Markdown text={item.enExplanation} links={false} className="md-compact option-explanation en-line" />}
                  </div>
                </li>
              ))}
            </ul>
          </div>
        )}
        {showSolution && !misconceptionShownAbove && run.solution?.misconception && (
          <div className="post-answer-more__section">
            <h4>{ui("容易混淆的地方")}</h4>
            <Markdown text={run.solution.misconception} />
          </div>
        )}
        {showSolution && run.solution?.rubric && (
          <div className="post-answer-more__section">
            <h4>{run.card?.kind === "task" ? ui("验收标准") : ui("评分依据")}</h4>
            <Markdown text={run.solution.rubric} />
          </div>
        )}
        <LearningActions session={session} data={data} model={model} onModelSettings={onModelSettings} openModal={openModal} />
      </div>
    </details>
  );
}

/** Cloze stem, optional bilingual blocks, voice input slot, and submit row with progress count. */
export function ClozeQuestion({ run, clozeValues, clozeFocusTick, enOn, enStem, enAnswer, voiceAnswer, actions, pendingCloze = false }) {
  const busy = useStudyBusy();
  const { reviewAct, setClozeValue } = actions;
  const clozeIds = clozeBlankIds(run.card?.cloze?.text || "");
  const filledCloze = clozeIds.filter((id) => String(clozeValues?.[id] ?? "").trim()).length;
  const canMarkEquivalent = run.mode !== "exam" && !run.retry && !run.complete && !!run.feedback && !run.feedback.correct;
  return (
    <>
      <Cloze
        key={"cloze:" + reviewEntryKey(run)}
        card={run.card}
        values={run.feedback?.answers || clozeValues}
        onChange={setClozeValue}
        onSubmit={() => { if (!busy && !run.feedback && Object.values(clozeValues).some((v) => String(v).trim())) reviewAct("review.answer", { answers: clozeValues }); }}
        focusRequest={clozeFocusTick}
        disabled={busy || !!run.feedback}
        details={run.feedback?.details || null}
        solution={run.solution}
        onMarkEquivalent={canMarkEquivalent ? () => reviewAct("review.grade.adjust", { entryIndex: run.index, clozeEquivalent: true }) : undefined}
        equivalentBusy={busy}
      />
      {enOn && (enStem?.clozeText || enStem?.prompt) && (
        <EnBlock text={String(enStem.clozeText || enStem.prompt).replace(/\{\{[^{}]+\}\}/g, "＿＿")} />
      )}
      {enOn && run.feedback && enAnswer?.blanks?.length > 0 && (
        <EnBlock inline text={enAnswer.blanks.map((b) => b.value).join(" · ")} />
      )}
      {voiceAnswer}
      {!run.feedback && (
        <div className="submit-row">
          {clozeIds.length >= 2 && (
            <span className="submit-hint" role="status">{uiFormat("已填 {0}/{1} 空", [filledCloze, clozeIds.length])}</span>
          )}
          <Button variant="primary" className="submit-answer" data-usage="review.submit" disabled={!Object.values(clozeValues).some((v) => String(v).trim())} busy={pendingCloze} lock={busy}
            onClick={() => reviewAct("review.answer", { answers: clozeValues })}>{ui("提交答案")}</Button>
        </div>
      )}
    </>
  );
}

/** Scratchpad textarea shown on open flashcards before revealing the back, with Ctrl+Enter / Esc support. */
export function OpenResponseField({ grading, value, onChange, onFlip }) {
  return (
    <label className="response-label">{ui("先组织你的回答")}<textarea rows={3} value={value} readOnly={!!grading} className={grading ? "response-sent" : undefined}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.nativeEvent?.isComposing || e.isComposing || e.keyCode === 229) return;
          if ((e.ctrlKey || e.metaKey) && e.key === "Enter" && !e.shiftKey && !e.altKey) {
            if (grading) return;
            e.preventDefault();
            onFlip();
            return;
          }
          if (e.key === "Escape" && !e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey) {
            e.preventDefault();
            const cardEl = e.currentTarget.closest?.(".question-card");
            if (cardEl?.focus) cardEl.focus({ preventScroll: true });
            else e.currentTarget.blur();
          }
        }}
        placeholder={ui("在脑中作答，或在这里写下思路（提交前会自动保存）")} />
      {value.trim().length > 0 && (
        <small className="response-hint">{uiFormat("{0} 字 · Ctrl+Enter 看答案", [[...value.trim()].length])}</small>
      )}
    </label>
  );
}
