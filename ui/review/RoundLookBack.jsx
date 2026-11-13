import { ui, uiFormat } from "../i18n.js";
import React from "react";
import Markdown from "../Markdown.jsx";
import Cloze from "../Cloze.jsx";
import ExplanationFollowup from "../ExplanationFollowup.jsx";
import { Badge, Button, ChunkedRows } from "../components/index.js";
import { fixedOptionLabel, optionMark } from "../option-label.js";
import { fixedOptionsOf, hasOptions, isGraded } from "../../lib/card-kinds.js";
import { invalidate, useHostQuery } from "../host-query.js";
import CorrectionCard from "./CorrectionCard.jsx";

/* 本轮题目 on the result page (#1009): one row per question of the round, read once when the page opens with review.lookBack {runId}
   (lib/contexts/study/round-look-back.js; a read the main chat is refused, so a chat's tool results of the round stay small), and a press on a row opens a
   read-only look-back under it: the question, the answer given, the right answer, the explanation and the Q&A. Opening a row asks the host for nothing, so
   it opens at once and can change no schedule and no clock. An unanswered question shows only itself: its answer waits until it is practised. At first only the
   wrong and unanswered rows are listed (all of them when there are none), long lists draw in chunks (ChunkedRows). A mock exam has no look-back (its report).
   待看订正 (#1031) comes first when there are any: the misses whose AI grade landed after the learner had moved on, each with its correction and
   我看懂了 · 加入重练 (`onAck(row)`), which sends the round back to that question's retry. */

const STATUS = {
  right: { tone: "success", graded: "答对", self: "达标" },
  wrong: { tone: "error", graded: "答错", self: "未达标" },
  self: { tone: "neutral", graded: "自报", self: "自报" },
  grading: { tone: "neutral", graded: "批改中", self: "批改中" },
  unanswered: { tone: "neutral", graded: "未答", self: "未答" },
};
const ROW_CHUNK = 20;

const pageWords = (row) => row.page == null ? "" : row.unit === "slide" ? uiFormat("第 {0} 张", [row.page])
  : row.unit === "part" ? uiFormat("第 {0} 节", [row.page]) : uiFormat("第 {0} 页", [row.page]);
/** The prompt of a row: in its card when it was answered, alone when it was not. */
const promptOf = (row) => String(row.card?.prompt ?? row.prompt ?? "");
const plainLine = (text) => String(text || "").replace(/\{\{[^{}]+\}\}/g, "＿＿").replace(/[#*_`>$\\]/g, "").replace(/\s+/g, " ").trim();

/** How a row's answer is measured: chosen or filled in (答对 / 答错), or graded by the learner (达标 / 未达标). */
const selfGraded = (row, mode) => mode === "flashcard" || !isGraded(row.kind);

function LookBackAnswer({ row, mode }) {
  const { card, feedback, solution } = row;
  if (mode !== "flashcard" && hasOptions(card.kind) && card.options?.length) {
    const verdict = !!fixedOptionsOf(card.kind);
    return (
      <div className="options look-back__options">
        {card.options.map((option, index) => {
          const key = solution.options?.find((item) => item.id === option.id);
          const picked = feedback.selected?.includes(option.id);
          return (
            <div key={option.id} className={"option " + (key?.correct ? "correct" : picked ? "incorrect" : "dim")}>
              <span className="option-letter" aria-hidden={verdict || undefined}>{verdict ? optionMark(card, option, index) : `${optionMark(card, option, index)}.`}</span>
              <div>
                {verdict ? <span className="option-verdict">{fixedOptionLabel(card, option)}</span> : <Markdown text={option.text} links={false} className="md-compact" />}
                <strong className="answer-state">{key?.correct ? (picked ? ui("✓ 已选 · 正确") : ui("正确答案")) : picked ? ui("× 你的选择") : ""}</strong>
                {key?.explanation && <Markdown text={key.explanation} links={false} className="md-compact option-explanation" />}
              </div>
            </div>
          );
        })}
      </div>
    );
  }
  if (mode !== "flashcard" && card.kind === "cloze") return <Cloze card={card} values={feedback.answers || {}} onChange={() => {}} disabled details={feedback.details || null} solution={solution} />;
  return (
    <div className="look-back__reference">
      {Number.isInteger(feedback.grade) && !feedback.selfReported && <p className="muted small">{uiFormat("你的自评：{0} 分", [feedback.grade])}</p>}
      {feedback.note && <p className="muted small">{uiFormat("你写的：{0}", [feedback.note])}</p>}
      {solution.answer && <><h4>{ui("参考答案")}</h4><Markdown text={solution.answer} /></>}
    </div>
  );
}

/** The read-only look-back of one row. */
function LookBack({ row, mode }) {
  if (!row.solution) {
    return (
      <div className="look-back__body">
        <Markdown text={promptOf(row)} />
        <p className="muted small">{ui("这道题这一轮没有作答，答案留到下次练到时再看。")}</p>
      </div>
    );
  }
  const isChoice = mode !== "flashcard" && (hasOptions(row.card.kind) || row.card.kind === "cloze");
  return (
    <div className="look-back__body">
      {/* A cloze draws its own sentence with the blanks; anything else shows the question first. */}
      {!(mode !== "flashcard" && row.card.kind === "cloze") && <Markdown text={promptOf(row)} />}
      <LookBackAnswer row={row} mode={mode} />
      {(row.solution.explanation || row.solution.misconception) && (
        <div className="explanation look-back__explanation">
          {row.solution.explanation && <><h4>{ui("理解这道题")}</h4><Markdown text={row.solution.explanation} /></>}
          {row.solution.misconception && <><h4>{ui("容易混淆的地方")}</h4><Markdown text={row.solution.misconception} /></>}
          {!isChoice && row.solution.rubric && <><h4>{row.card.kind === "task" ? ui("验收标准") : ui("评分依据")}</h4><Markdown text={row.solution.rubric} /></>}
        </div>
      )}
      <ExplanationFollowup run={{ deckId: row.deckId, card: { id: row.cardId }, solution: row.solution }} readOnly />
    </div>
  );
}

/**
 * props: run (the finished run), onOpenWrongBook(refs) (optional: the wrong book on these questions, where its rescue is; absent when the page is not available).
 */
export default function RoundLookBack({ run, onOpenWrongBook, onAck }) {
  // One read per opening of the result page, shared by any other reader of the same round (ui/host-query.js); nothing for an exam.
  const query = useHostQuery("review.lookBack", { runId: run.id }, { enabled: run.mode !== "exam" });
  // A grade that lands while this page is open (#1031: the run's poll brings the new count) is read again, so its row and 待看订正 show at once.
  const landed = `${run.correctionsPending || 0}:${(run.navigation || []).filter((item) => item.grading).length}`;
  const seen = React.useRef(landed);
  React.useEffect(() => { if (seen.current !== landed) { seen.current = landed; invalidate("review.lookBack", { runId: run.id }); } }, [landed, run.id]);
  const rows = (run.mode !== "exam" && query.data?.rows) || [];
  const needsLook = rows.filter((row) => row.status === "wrong" || row.status === "unanswered");
  const corrections = rows.filter((row) => row.correctionPending);
  // Until the learner chooses: the corrections waiting to be read, else the wrong and unanswered ones, or all of them when there are none.
  const [chosen, setAll] = React.useState(null);
  const view = chosen ?? (corrections.length ? "pending" : needsLook.length ? "some" : "all"), all = view === "all";
  const [open, setOpen] = React.useState(() => new Set());
  if (!rows.length) return null;
  const shown = view === "pending" ? corrections : all ? rows : needsLook;
  const wrong = rows.filter((row) => row.status === "wrong").length, unanswered = rows.filter((row) => row.status === "unanswered").length;
  const toggle = (number) => setOpen((previous) => {
    const next = new Set(previous);
    if (next.has(number)) next.delete(number); else next.add(number);
    return next;
  });
  const render = (row) => {
    const words = STATUS[row.status] || STATUS.unanswered;
    const expanded = open.has(row.number), regionId = `look-back-${run.id}-${row.number}`;
    return (
      <li key={row.number} className="look-back__row" data-status={row.status}>
        <Button variant="quiet" className="look-back__line" align="start" aria-expanded={expanded} aria-controls={expanded ? regionId : undefined} onClick={() => toggle(row.number)}>
          <span className="look-back__number">{row.number}</span>
          <Badge size="sm" tone={words.tone}>{ui(selfGraded(row, run.mode) ? words.self : words.graded)}</Badge>
          {row.hinted && <Badge size="sm">{ui("用了提示")}</Badge>}
          {row.correctionPending && <Badge size="sm" tone="warning">{ui("待看订正")}</Badge>}
          <span className="look-back__prompt">{plainLine(promptOf(row)) || ui("题干尚未填写")}</span>
          {row.page != null && <span className="look-back__page muted small">{pageWords(row)}</span>}
        </Button>
        {expanded && (
          <div id={regionId} className="look-back__panel" role="region" aria-label={uiFormat("第 {0} 题回看", [row.number])}>
            <LookBack row={row} mode={run.mode} />
            {row.feedback && <CorrectionCard feedback={row.feedback} withRubric={!!row.feedback.rubric && row.card?.kind !== "task"}
              onAck={row.correctionPending && onAck ? () => Promise.resolve(onAck(row)).then(() => invalidate("review.lookBack")) : undefined} />}
            {row.status === "wrong" && onOpenWrongBook && (
              <Button variant="link" size="sm" onClick={() => onOpenWrongBook([{ deckId: row.deckId, cardId: row.cardId }])}>{ui("去错题本练这道题")}</Button>
            )}
          </div>
        )}
      </li>
    );
  };
  return (
    <section className="round-look-back sh-paper-card" aria-label={ui("本轮题目")}>
      <div className="round-look-back__head">
        <h3>{ui("本轮题目")}</h3>
        <span className="muted small">{[wrong > 0 && uiFormat("错 {0}", [wrong]), unanswered > 0 && uiFormat("未答 {0}", [unanswered])].filter(Boolean).join(" · ") || ui("全部过关")}</span>
        {corrections.length > 0 && view !== "pending" && <Button variant="link" size="sm" onClick={() => setAll("pending")}>{uiFormat("待看订正 {0}", [corrections.length])}</Button>}
        {needsLook.length > 0 && needsLook.length < rows.length && (
          <Button variant="link" size="sm" onClick={() => setAll(view === "some" ? "all" : "some")}>
            {view === "some" ? uiFormat("显示全部 {0} 题", [rows.length]) : ui("只看错题和未答")}
          </Button>
        )}
        {view === "pending" && !(needsLook.length > 0 && needsLook.length < rows.length) && <Button variant="link" size="sm" onClick={() => setAll("all")}>{uiFormat("显示全部 {0} 题", [rows.length])}</Button>}
      </div>
      <p className="muted small">{ui("点一道题回看：题目、你的答案、正确答案、讲解和问答。只是回看，不会重新计时或改成绩。")}</p>
      <ol className="look-back__rows">
        <ChunkedRows items={shown} render={render} chunk={ROW_CHUNK} resetKey={view} as="li" />
      </ol>
    </section>
  );
}
