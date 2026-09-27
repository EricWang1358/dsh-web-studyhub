import React from "react";

export default function ReviewToolbar({ run, busy, expanded, onToggleHelp, onAsk, onImprove, onSlay, onNote, onReviewAction, thumbs, enOn, enBusy, onToggleEn, assistMode }) {
  const moreRef = React.useRef(null);
  React.useEffect(() => {
    const closeOutside = (event) => {
      if (moreRef.current && !moreRef.current.contains(event.target)) moreRef.current.open = false;
    };
    const closeOnEscape = (event) => {
      if (event.key === "Escape" && moreRef.current?.open) {
        moreRef.current.open = false;
        moreRef.current.querySelector("summary")?.focus();
      }
    };
    document.addEventListener("pointerdown", closeOutside);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOutside);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, []);
  return (
    <div className="question-toolbar">
      <div className="question-tools">
        {!run.feedback && <button className="tool-action" aria-expanded={!!expanded} onClick={onToggleHelp}>
          {run.revealed ? "讲解" : "提示"}
        </button>}
        {run.mode !== "exam" && (
          <button
            className={"tool-action" + (enOn ? " is-active" : "")}
            aria-pressed={!!enOn}
            disabled={!!enBusy && !enOn}
            title={enBusy ? "正在翻译成英文…" : "在中文题干和答案后显示英文"}
            onClick={onToggleEn}
          >
            {enBusy ? "EN…" : "EN"}
          </button>
        )}
        <button className="tool-action tool-help" aria-expanded={assistMode === "ask"} onClick={onAsk}>帮我弄懂</button>
        {thumbs}
      </div>
      {run.mode === "exam" && <p className="muted small next-due">这是进行中的模拟考试：这里可以继续作答，交卷和成绩单在「模拟考试」页。</p>}
      <div className="question-navigation">
        <details className="review-more" ref={moreRef} onToggle={() => {
          if (moreRef.current?.open) requestAnimationFrame(() => {
            moreRef.current?.querySelector(".review-more-menu")?.scrollIntoView({ block: "nearest" });
          });
        }}><summary className="tool-action">更多</summary><div className="review-more-menu">
          <button type="button" disabled={busy} onClick={(event) => { event.currentTarget.closest("details").open = false; onNote(); }}>写笔记</button>
          <button type="button" aria-expanded={assistMode === "improve"} onClick={(event) => { event.currentTarget.closest("details").open = false; onImprove(); }}>修题</button>
          <button type="button" disabled={busy} onClick={(event) => { event.currentTarget.closest("details").open = false; onSlay(); }}>斩掉此题</button>
        </div></details>
        <button className="pill" disabled={busy || run.index === 0}
          onClick={() => onReviewAction("review.move", { direction: -1 })}>上一题</button>
        <button className="primary pill" disabled={busy || !!run.card?.publicationUngrable || (!run.feedback && run.mode !== "exam")}
          onClick={() => onReviewAction("review.move", { direction: 1 })}>
          {run.index === run.total - 1 ? "完成" : "下一题"} →
        </button>
      </div>
    </div>
  );
}
