import { ui, uiFormat } from "./i18n.js";
import React from "react";
import { Button, Menu } from "./components/index.js";
import { ReadingSettingsDialog } from "./reading-settings/ReadingSettings.jsx";
import { useStudy } from "./study-context.jsx";
import { roundAt } from "./review/round-words.js";

const NEXT_HINT_ID = "review-next-hint";

/**
 * The tools under a question, kept to six controls: 提示 / 讲解, 帮我弄懂, 修题, 更多 and the previous / next buttons (#671 kept five; 修题 came out of 更多 on the
 * learner's word: fixing a question is a step of practising, and the box it opens has the learner's own phrases). Everything that is not needed on every question
 * is in 更多 (a menu), each with its key where it has one: 显示英文, 答对后自动下一题 (A), 字号与版心, 这题不错 (G) / 这题有问题 (B), then the actions on the question
 * (mark it, note, task, derive a prerequisite, slay). `moreDefaultOpen` opens the menu at first render.
 * `onThumb('up' | 'down')` and `thumbVote` are the page's 评价: its ThumbFeedback keeps the vote and the keys; `thumbs` is that component (it draws only the tag tray).
 */
export default function ReviewToolbar({ run, expanded, onToggleHelp, onAsk, onImprove, onDerive, onSlay, onToggleFocus, onDeferUnstudiedPages, onNote, onTask, onReviewAction, thumbs, onThumb, thumbVote, enOn, enBusy, onToggleEn, assistMode, autopilot, onToggleAutopilot, onSkip, onEndRound, moreDefaultOpen = false }) {
  const { busy } = useStudy();
  const [readingOpen, setReadingOpen] = React.useState(false);
  // Say why 下一题 is unavailable instead of leaving a dim button: an unanswered question waits for its answer (one whose AI grade is on its way is answered: the grade lands on it later, #1031); a pending step is still saving.
  const needsAnswer = !run.feedback && !run.grading && run.mode !== "exam";
  const nextBlocked = busy || !!run.card?.publicationUngrable || needsAnswer;
  const exam = run.mode === "exam";
  // 完成 only when 下一题 has nowhere to go: the round says so (lib/round-position.js), a question set aside with 先跳过 included.
  const last = roundAt(run).last;
  const deferLabel = onDeferUnstudiedPages && !exam && !run.reading && !run.feedback && Number.isInteger(run.cardSource?.page)
    ? (run.cardSource.unit === "slide"
        ? uiFormat("还没学到第 {0} 张（本轮移出后续页）", [run.cardSource.page])
        : run.cardSource.unit === "part"
          ? uiFormat("还没学到第 {0} 节（本轮移出后续节）", [run.cardSource.page])
          : uiFormat("还没学到第 {0} 页（本轮移出后续页）", [run.cardSource.page]))
    : "";
  const more = [
    { heading: true, label: ui("显示与节奏") },
    !exam && { id: "en", label: ui("显示英文"), checked: !!enOn, disabled: !!enBusy && !enOn, hint: enBusy ? "EN…" : undefined,
      run: onToggleEn },
    // 自动驾驶, in plain words: the setting of 设置 › 练习 (default off), switchable here and with the A key; it only flips a setting, so a saving step does not block it.
    !exam && onToggleAutopilot && { id: "autopilot", label: ui("自动跳下一步"), checked: !!autopilot, hint: "A",
      attrs: { "aria-keyshortcuts": "A" }, run: onToggleAutopilot },
    { id: "reading", label: ui("字号与版心…"), run: () => setReadingOpen(true) },
    onThumb && { heading: true, label: ui("评价这道题") },
    onThumb && { id: "thumb-up", label: ui("这题不错"), checked: thumbVote === "up", hint: "G", attrs: { "aria-keyshortcuts": "G" }, run: () => onThumb("up") },
    onThumb && { id: "thumb-down", label: ui("这题有问题…"), checked: thumbVote === "down", hint: "B", attrs: { "aria-keyshortcuts": "B" }, run: () => onThumb("down") },
    // 这一轮 (#1008): set this question aside for the end of the round, or stop the round here with a result. Not in an exam, which has its own rules.
    !exam && (onSkip || onEndRound) && { heading: true, label: ui("这一轮") },
    !exam && onSkip && { id: "skip", label: ui("先跳过"), hint: "K", attrs: { "aria-keyshortcuts": "K" }, disabled: busy,
      tip: ui("这道题先放一放，到这一轮最后再回来做。跳过不记成绩，回来时重新计时。"), run: onSkip },
    !exam && onEndRound && { id: "end-round", label: ui("到此为止…"), disabled: busy, run: onEndRound },
    { heading: true, label: ui("这道题") },
    deferLabel && { id: "defer-pages", label: deferLabel, disabled: busy, run: onDeferUnstudiedPages },
    onToggleFocus && { id: "focus", label: run.card?.focus ? ui("取消重点标记") : ui("标为重点"), hint: "F", attrs: { "aria-keyshortcuts": "F" }, disabled: busy, run: onToggleFocus },
    { id: "note", label: ui("写笔记"), hint: onNote ? "N" : undefined, attrs: onNote ? { "aria-keyshortcuts": "N" } : undefined, disabled: busy, run: onNote },
    onTask && { id: "task", label: ui("记待办"), disabled: busy, run: onTask },
    onDerive && { id: "derive", label: ui("出前置题…"), attrs: { "data-usage": "review.derive" }, run: onDerive },
    { id: "slay", label: ui("斩掉此题"), disabled: busy, danger: true, run: onSlay },
  ].filter(Boolean);
  return (
    <div className="question-toolbar">
      <div className="question-tools">
        {!run.feedback && <Button variant="quiet" className="tool-action" data-tour="review-hint" aria-expanded={!!expanded} onClick={onToggleHelp}>
          {run.revealed ? ui("讲解") : ui("提示")}
        </Button>}
        <Button variant="quiet" className="tool-action tool-help" data-tour="review-help" data-usage="review.help" aria-expanded={assistMode === "ask"} onClick={onAsk}>{ui("帮我弄懂")}</Button>
        <Button variant="quiet" className="tool-action" data-tour="review-improve" data-usage="review.improve" aria-expanded={assistMode === "improve"} onClick={onImprove}>{ui("修题")}</Button>
        {thumbs}
      </div>
      {run.mode === "exam" && <p className="muted small next-due">{ui("这是进行中的模拟考试：这里可以继续作答，交卷和成绩单在「模拟考试」页。")}</p>}
      {/* The 找功能 anchor of 更多 sits on this group, not on the trigger: every [data-tour] gets a scroll margin (tour.css), so focusing a trigger at the
          bottom of the view scrolled the page, and the menu closes on any scroll (components/Menu.jsx) — it shut right after Enter opened it. */}
      <div className="question-navigation" data-tour="review-more">
        <Menu label={ui("更多")} items={more.map(({ run: _run, ...item }) => item)} defaultOpen={moreDefaultOpen}
          onSelect={(id) => more.find((item) => item.id === id)?.run?.()}
          trigger={({ props, ref }) => <Button ref={ref} variant="quiet" className="tool-action review-more-trigger" {...props}>{ui("更多")}</Button>} />
        <Button size="sm" data-usage="review.prev" disabled={run.index === 0} lock={busy} title={busy ? ui("正在保存上一步，稍等一下") : undefined}
          onClick={() => onReviewAction("review.move", { direction: -1 })}>{ui("上一题")}</Button>
        <Button variant="primary" size="sm" data-usage="review.next" disabled={nextBlocked}
          aria-describedby={needsAnswer && !busy ? NEXT_HINT_ID : undefined}
          title={busy ? ui("正在保存上一步，稍等一下") : undefined}
          onClick={() => onReviewAction("review.move", { direction: 1 })}>
          {last ? ui("完成") : ui("下一题")} →
        </Button>
      </div>
      {needsAnswer && !busy && !run.card?.publicationUngrable && <p className="muted small next-hint" id={NEXT_HINT_ID}>
        {onSkip ? ui("请先作答，才能进入下一题；也可以在「更多」里先跳过（K）") : ui("请先作答，才能进入下一题")}</p>}
      {readingOpen && <ReadingSettingsDialog onClose={() => setReadingOpen(false)} />}
    </div>
  );
}
