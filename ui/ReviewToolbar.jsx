import { ui } from "./i18n.js";
import React from "react";
import { Button, Menu } from "./components/index.js";
import { ReadingSettingsButton } from "./reading-settings/ReadingSettings.jsx";

const NEXT_HINT_ID = "review-next-hint";

/**
 * The tools under a question: hint / explanation, EN, ask for help, the reading settings, 更多 (a menu: note, task, fix the
 * question, derive a prerequisite, slay it) and the previous / next buttons. `moreDefaultOpen` opens the menu at first render.
 */
export default function ReviewToolbar({ run, busy, expanded, onToggleHelp, onAsk, onImprove, onDerive, onSlay, onNote, onTask, onReviewAction, thumbs, enOn, enBusy, onToggleEn, assistMode, moreDefaultOpen = false }) {
  // Say why 下一题 is unavailable instead of leaving a dim button: an unanswered question waits for its answer; a pending step is still saving.
  const needsAnswer = !run.feedback && run.mode !== "exam";
  const nextBlocked = busy || !!run.card?.publicationUngrable || needsAnswer;
  const more = [
    { id: "note", label: ui("写笔记"), disabled: busy, run: onNote },
    onTask && { id: "task", label: ui("记待办"), disabled: busy, run: onTask },
    { id: "improve", label: ui("修题"), run: onImprove },
    onDerive && { id: "derive", label: ui("出前置题…"), attrs: { "data-usage": "review.derive" }, run: onDerive },
    { id: "slay", label: ui("斩掉此题"), disabled: busy, danger: true, run: onSlay },
  ].filter(Boolean);
  return (
    <div className="question-toolbar">
      <div className="question-tools">
        {!run.feedback && <Button variant="quiet" className="tool-action" aria-expanded={!!expanded} onClick={onToggleHelp}>
          {run.revealed ? ui("讲解") : ui("提示")}
        </Button>}
        {run.mode !== "exam" && (
          <Button
            variant="quiet"
            className={"tool-action" + (enOn ? " is-active" : "")}
            aria-pressed={!!enOn}
            disabled={!!enBusy && !enOn}
            title={enBusy ? ui("正在翻译成英文…") : ui("在中文题干和答案后显示英文")}
            onClick={onToggleEn}
          >
            {enBusy ? "EN…" : "EN"}
          </Button>
        )}
        <Button variant="quiet" className="tool-action tool-help" data-tour="review-help" data-usage="review.help" aria-expanded={assistMode === "ask"} onClick={onAsk}>{ui("帮我弄懂")}</Button>
        <ReadingSettingsButton className="review-reading" />
        {thumbs}
      </div>
      {run.mode === "exam" && <p className="muted small next-due">{ui("这是进行中的模拟考试：这里可以继续作答，交卷和成绩单在「模拟考试」页。")}</p>}
      <div className="question-navigation">
        <Menu label={ui("更多")} items={more.map(({ run: _run, ...item }) => item)} defaultOpen={moreDefaultOpen}
          onSelect={(id) => more.find((item) => item.id === id)?.run?.()}
          trigger={({ props, ref }) => <Button ref={ref} variant="quiet" className="tool-action review-more-trigger" {...props}>{ui("更多")}</Button>} />
        <Button size="sm" data-usage="review.prev" disabled={busy || run.index === 0} title={busy ? ui("正在保存上一步，稍等一下") : undefined}
          onClick={() => onReviewAction("review.move", { direction: -1 })}>{ui("上一题")}</Button>
        <Button variant="primary" size="sm" data-usage="review.next" disabled={nextBlocked}
          aria-describedby={needsAnswer && !busy ? NEXT_HINT_ID : undefined}
          title={busy ? ui("正在保存上一步，稍等一下") : undefined}
          onClick={() => onReviewAction("review.move", { direction: 1 })}>
          {run.index === run.total - 1 ? ui("完成") : ui("下一题")} →
        </Button>
      </div>
      {needsAnswer && !busy && !run.card?.publicationUngrable && <p className="muted small next-hint" id={NEXT_HINT_ID}>{ui("请先作答，才能进入下一题")}</p>}
    </div>
  );
}
