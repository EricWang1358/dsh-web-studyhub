import React from "react";

export default function ReviewToolbar({ run, busy, expanded, onToggleHelp, onAsk, onImprove, onSlay, onReviewAction, thumbs }) {
  return (
    <div className="question-toolbar">
      <div className="question-tools">
        <button className="pill" aria-expanded={!!expanded} onClick={onToggleHelp}>
          {run.revealed ? "讲解" : "提示"}
        </button>
        <button className="pill" title="带着这道题去对话里问，弄懂的点会成为它的前置题" onClick={onAsk}>不会？问 AI</button>
        <button className="pill" title="带着这道题去对话里说哪里不好，AI 会直接改这张卡" onClick={onImprove}>提升质量</button>
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
