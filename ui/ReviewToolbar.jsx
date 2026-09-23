import React from "react";

export default function ReviewToolbar({ run, busy, expanded, onToggleHelp, onAsk, onImprove, onSlay, onReviewAction, thumbs, enOn, enBusy, onToggleEn, assistMode }) {
  return (
    <div className="question-toolbar">
      <div className="question-tools">
        <button className="pill" aria-expanded={!!expanded} onClick={onToggleHelp}>
          {run.revealed ? "讲解" : "提示"}
        </button>
        {run.mode !== "exam" && (
          <button
            className={"pill" + (enOn ? " pill-on" : "")}
            aria-pressed={!!enOn}
            disabled={!!enBusy && !enOn}
            title={enBusy ? "正在翻译成英文…" : "在中文题干和答案后显示英文"}
            onClick={onToggleEn}
          >
            {enBusy ? "EN…" : "EN"}
          </button>
        )}
        <button className="pill" aria-expanded={assistMode === "ask"} title="说说卡在哪，后台助教去查资料解答，解答会追加到这道题的问答里" onClick={onAsk}>不会？问 AI</button>
        <button className="pill" aria-expanded={assistMode === "improve"} title="说说这道题哪里不好，后台助教直接改这张卡（可撤销）" onClick={onImprove}>提升质量</button>
        <button className="pill" disabled={busy} title="过于基础或质量不佳：移入斩题组，不再复习，可撤销"
          onClick={onSlay}>斩掉此题</button>
        {thumbs}
      </div>
      {run.mode === "exam" && <p className="muted small next-due">这是进行中的模拟考试：这里可以继续作答，交卷和成绩单在「模拟考试」页。</p>}
      <div className="question-navigation">
        <button className="pill" disabled={busy || run.index === 0}
          onClick={() => onReviewAction("review.move", { direction: -1 })}>上一题</button>
        <button className="primary pill" disabled={busy || (!run.feedback && run.mode !== "exam")}
          onClick={() => onReviewAction("review.move", { direction: 1 })}>
          {run.index === run.total - 1 ? "完成" : "下一题"} →
        </button>
      </div>
    </div>
  );
}
