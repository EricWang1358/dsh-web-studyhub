import { ui, uiFormat } from "../i18n.js";
import React from "react";
import Markdown from "../Markdown.jsx";
import Cloze from "../Cloze.jsx";
import ExplanationFollowup from "../ExplanationFollowup.jsx";
import { Badge, Button, ChunkedRows } from "../components/index.js";
import { fixedOptionLabel, optionMark } from "../option-label.js";
import { fixedOptionsOf, hasOptions, isGraded } from "../../lib/card-kinds.js";

/* 本轮题目 on the result page (#1009): one row per question of the round (the run's own `lookBack`, lib/contexts/study/round-look-back.js), and a press on a
   row opens a read-only look-back under it: the question, the answer given, the right answer, the explanation and the Q&A. It asks the host for nothing, so
   it opens at once and can change no schedule and no clock. An unanswered question shows only itself: its answer waits until it is practised. At first only the
   wrong and unanswered rows are listed (all of them when there are none), long lists draw in chunks (ChunkedRows). A mock exam has no look-back (its report). */

const STATUS = {
  right: { tone: "success", graded: "答对", self: "达标" },
  wrong: { tone: "error", graded: "答错", self: "未达标" },
  self: { tone: "neutral", graded: "自报", self: "自报" },
  unanswered: { tone: "neutral", graded: "未答", self: "未答" },
};
const ROW_CHUNK = 20;

const pageWords = (row) => row.page == null ? "" : row.unit === "slide" ? uiFormat("第 {0} 张", [row.page])
  : row.unit === "part" ? uiFormat("第 {0} 节", [row.page]) : uiFormat("第 {0} 页", [row.page]);
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
        <Markdown text={row.prompt} />
        <p className="muted small">{ui("这道题这一轮没有作答，答案留到下次练到时再看。")}</p>
      </div>
    );
  }
  const isChoice = mode !== "flashcard" && (hasOptions(row.card.kind) || row.card.kind === "cloze");
  return (
    <div className="look-back__body">
      {/* A cloze draws its own sentence with the blanks; anything else shows the question first. */}
      {!(mode !== "flashcard" && row.card.kind === "cloze") && <Markdown text={row.prompt} />}
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
 * props: run (the finished run, with `lookBack`), onOpenWrongBook(refs) (optional: the wrong book on these questions, where its rescue is; absent when the page
 * is not available).
 */
export default function RoundLookBack({ run, onOpenWrongBook }) {
  const rows = run.lookBack || [];
  const needsLook = rows.filter((row) => row.status === "wrong" || row.status === "unanswered");
  const [all, setAll] = React.useState(needsLook.length === 0);
  const [open, setOpen] = React.useState(() => new Set());
  if (!rows.length) return null;
  const shown = all ? rows : needsLook;
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
          <span className="look-back__prompt">{plainLine(row.prompt) || ui("题干尚未填写")}</span>
          {row.page != null && <span className="look-back__page muted small">{pageWords(row)}</span>}
        </Button>
        {expanded && (
          <div id={regionId} className="look-back__panel" role="region" aria-label={uiFormat("第 {0} 题回看", [row.number])}>
            <LookBack row={row} mode={run.mode} />
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
        {needsLook.length > 0 && needsLook.length < rows.length && (
          <Button variant="link" size="sm" onClick={() => setAll(!all)}>
            {all ? ui("只看错题和未答") : uiFormat("显示全部 {0} 题", [rows.length])}
          </Button>
        )}
      </div>
      <p className="muted small">{ui("点一道题回看：题目、你的答案、正确答案、讲解和问答。只是回看，不会重新计时或改成绩。")}</p>
      <ol className="look-back__rows">
        <ChunkedRows items={shown} render={render} chunk={ROW_CHUNK} resetKey={all ? "all" : "some"} as="li" />
      </ol>
    </section>
  );
}
