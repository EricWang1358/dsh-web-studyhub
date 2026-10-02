import React from "react";
import Icon from "./Icon.jsx";
import NavGlyph from "./NavGlyph.jsx";
import { ui, uiFormat } from "./i18n.js";

/* One row of the sidebar, whatever it is: icon, a label, and an optional trailing hint (a count, a run's
   progress, a badge). Every row has the same anatomy and the same fixed height (style.css, --nav-row), so what a row
   says never changes how tall it is and nothing below it moves when a hint appears or goes away. The full text and any
   detail (a run's title, how many questions are ready) live in the tooltip, not in a second line.

   One definition of the states: `active` (the page the learner is on) is bold, sits on the gliding highlight and carries
   aria-current; `disabled` is dimmed, does nothing and is never current. Nothing else is dimmed or bold. */
export function NavItem({ glyph, icon, label, hint, hintClass = "nav-count", hintTitle, upkeep = false, active = false, disabled = false, className = "", ...button }) {
  const classes = ["nav", className, upkeep && "nav-upkeep", active && "active"].filter(Boolean).join(" ");
  return (
    <button type="button" {...button} className={classes} disabled={disabled} aria-current={active && !disabled ? "page" : undefined}>
      <Icon>{icon || <NavGlyph name={glyph} />}</Icon>
      <span className="nav-label">{label}</span>
      {hint !== undefined && hint !== null && hint !== false && <span className={hintClass} title={hintTitle}>{hint}</span>}
    </button>
  );
}

/** 回到题目: back into the open run, or start today's study; with an open run its progress is the trailing hint. */
export function ResumeNavItem({ lastRun, hasDecks, ready = true, active = false, disabled = false, onClick }) {
  const title = !ready
    ? ""
    : lastRun
      ? uiFormat("回到「{0}」第 {1}/{2} 题", [lastRun.title, lastRun.index + 1, lastRun.total])
      : hasDecks
        ? ui("没有进行中的练习，开始今日学习")
        : ui("还没有题目，先去创建题组");
  return (
    <NavItem className="resume-nav" glyph="resume" label={ui("回到题目")} active={active} disabled={disabled} title={title} aria-keyshortcuts="S" onClick={onClick}
      hint={lastRun ? `${lastRun.index + 1}/${lastRun.total}` : undefined} hintClass="nav-count nav-progress" />
  );
}

/** 为你定制: the prepared questions are ready; the count is the trailing badge. */
export function CoachNavItem({ ready, disabled = false, onClick }) {
  return (
    <NavItem className="coach-nav" glyph="coach" label={ui("为你定制")} disabled={disabled} onClick={onClick}
      title={`${uiFormat("{0} 道题已备好", [ready])}\n${ui("开刷为你定制的题（这一轮会保留，可回来继续）")}`}
      hint={ready} hintClass="nav-badge" />
  );
}

export default NavItem;
