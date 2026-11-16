import React from "react";
import { ui, uiFormat } from "../i18n.js";
import Cloze from "../Cloze.jsx";
import EnBlock from "../EnBlock.jsx";
import { Badge, Button } from "../components/index.js";
import { useStudy } from "../study-context.jsx";
import { MasteryMark } from "../document-preview/practice/MasteryMark.jsx";
import QuestionSourcePage from "./QuestionSourcePage.jsx";
import { clozeRuns } from "../../lib/cloze-text.js";
import { reviewEntryKey } from "../async.js";

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

/** Origin, focus, note links, source page badge, and topic tag on the right side of the question meta bar. */
export function QuestionMetaBadges({ run, sources, cardNotes, onOpenNote }) {
  const reason = run.origin?.reason === "too-hard" ? ui("前置台阶") : run.origin?.reason === "followup" ? ui("追问巩固") : ui("变式");
  return (
    <>
      {cardNotes.map((note) => note.status === "published" && note.url
        ? <a key={note.noteId} className="result-note-link" href={note.url} target="_blank" rel="noopener noreferrer" title={note.title}><Badge size="sm" icon="external">{ui("已发布笔记")}</Badge></a>
        : <Button key={note.noteId} variant="quiet" size="sm" className="result-note-link question-meta__action" disabled={!onOpenNote}
            title={note.title} onClick={() => onOpenNote?.(note.noteId)}>{ui("笔记草稿")}</Button>)}
      {run.origin && (
        <Badge size="sm" className="origin-note" title={run.origin.prompt ? uiFormat("源自：{0}", [run.origin.prompt]) : ""}>
          {run.origin.prompt ? uiFormat("{0} · 源自「{1}」", [reason, run.origin.prompt.length > 18 ? run.origin.prompt.slice(0, 18) + "…" : run.origin.prompt]) : reason}
        </Badge>
      )}
      {run.card.focus && <Badge size="sm" tone="accent" className="origin-note">{ui("重点")}</Badge>}
      {run.card.importedFromJson && <Badge size="sm" className="origin-note">{ui("外部导入")}</Badge>}
      {run.card.sourceQa && <Badge size="sm" className="origin-note">{ui("问答")}</Badge>}
      <QuestionSourcePage run={run} sources={sources} />
      <span>{run.card.topic}</span>
    </>
  );
}

/** Cloze stem, optional bilingual blocks, voice input slot, and submit row with progress count. */
export function ClozeQuestion({ run, clozeValues, clozeFocusTick, enOn, enStem, enAnswer, voiceAnswer, actions }) {
  const { busy } = useStudy();
  const { reviewAct, setClozeValue } = actions;
  const clozeIds = clozeRuns(run.card?.cloze?.text || "").filter((part) => part.t === "blank").map((part) => part.id);
  const filledCloze = clozeIds.filter((id) => String(clozeValues?.[id] ?? "").trim()).length;
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
          <Button variant="primary" className="submit-answer" data-usage="review.submit" disabled={!Object.values(clozeValues).some((v) => String(v).trim())} lock={busy}
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
