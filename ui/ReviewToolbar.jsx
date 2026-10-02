import { ui } from "./i18n.js";
import React from "react";

const NEXT_HINT_ID = "review-next-hint";

export default function ReviewToolbar({ run, busy, expanded, onToggleHelp, onAsk, onImprove, onSlay, onNote, onTask, onReviewAction, thumbs, enOn, enBusy, onToggleEn, assistMode }) {
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
  // Say why 下一题 is unavailable instead of leaving a dim button: an unanswered question waits for its answer; a pending step is still saving.
  const needsAnswer = !run.feedback && run.mode !== "exam";
  const nextBlocked = busy || !!run.card?.publicationUngrable || needsAnswer;
  return (
    <div className="question-toolbar">
      <div className="question-tools">
        {!run.feedback && <button className="tool-action" aria-expanded={!!expanded} onClick={onToggleHelp}>
          {run.revealed ? ui("讲解") : ui("提示")}
        </button>}
        {run.mode !== "exam" && (
          <button
            className={"tool-action" + (enOn ? " is-active" : "")}
            aria-pressed={!!enOn}
            disabled={!!enBusy && !enOn}
            title={enBusy ? ui("正在翻译成英文…") : ui("在中文题干和答案后显示英文")}
            onClick={onToggleEn}
          >
            {enBusy ? "EN…" : "EN"}
          </button>
        )}
        <button className="tool-action tool-help" data-tour="review-help" aria-expanded={assistMode === "ask"} onClick={onAsk}>{ui("帮我弄懂")}</button>
        {thumbs}
      </div>
      {run.mode === "exam" && <p className="muted small next-due">{ui("这是进行中的模拟考试：这里可以继续作答，交卷和成绩单在「模拟考试」页。")}</p>}
      <div className="question-navigation">
        <details className="review-more" ref={moreRef} onToggle={() => {
          if (moreRef.current?.open) requestAnimationFrame(() => {
            moreRef.current?.querySelector(".review-more-menu")?.scrollIntoView({ block: "nearest" });
          });
        }}><summary className="tool-action">{ui("更多")}</summary><div className="review-more-menu">
          <button type="button" disabled={busy} onClick={(event) => { event.currentTarget.closest("details").open = false; onNote(); }}>{ui("写笔记")}</button>
          {onTask && <button type="button" disabled={busy} onClick={(event) => { event.currentTarget.closest("details").open = false; onTask(); }}>{ui("记待办")}</button>}
          <button type="button" aria-expanded={assistMode === "improve"} onClick={(event) => { event.currentTarget.closest("details").open = false; onImprove(); }}>{ui("修题")}</button>
          <button type="button" disabled={busy} onClick={(event) => { event.currentTarget.closest("details").open = false; onSlay(); }}>{ui("斩掉此题")}</button>
        </div></details>
        <button className="pill" disabled={busy || run.index === 0} title={busy ? ui("正在保存上一步，稍等一下") : undefined}
          onClick={() => onReviewAction("review.move", { direction: -1 })}>{ui("上一题")}</button>
        <button className="primary pill" disabled={nextBlocked}
          aria-describedby={needsAnswer && !busy ? NEXT_HINT_ID : undefined}
          title={busy ? ui("正在保存上一步，稍等一下") : undefined}
          onClick={() => onReviewAction("review.move", { direction: 1 })}>
          {run.index === run.total - 1 ? ui("完成") : ui("下一题")} →
        </button>
      </div>
      {needsAnswer && !busy && !run.card?.publicationUngrable && <p className="muted small next-hint" id={NEXT_HINT_ID}>{ui("请先作答，才能进入下一题")}</p>}
    </div>
  );
}
