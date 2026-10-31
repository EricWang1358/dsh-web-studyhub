import React from "react";
import { Icon, IconBox } from "./components/index.js";
import Tooltip from "./components/Tooltip.jsx";
import { ui, uiFormat } from "./i18n.js";

/* One row of the sidebar, whatever it is: icon, a label, and an optional trailing hint (a count, a run's
   progress, a badge). Every row has the same anatomy and the same fixed height (style.css, --nav-row), so what a row
   says never changes how tall it is and nothing below it moves when a hint appears or goes away. The full text and any
   detail (a run's title, how many questions are ready) live in the tooltip, not in a second line.

   One definition of the states: `active` (the page the learner is on) is bold, sits on the gliding highlight and carries
   aria-current; `disabled` is dimmed, does nothing and is never current. Nothing else is dimmed or bold.

   Words: every row says what it is for (`purpose`, one short sentence from ui/pages.js), so hovering or focusing it answers
   "what is this?" and not only "what is it called". The label itself is in the tooltip only in the narrow rail (`narrow`), where
   the row is an icon and the tooltip is what names it; beside a visible label it would be said twice (issue 569). `title` is the
   row's own state (a run's title, the week's theme) and `hintTitle` explains the trailing count; `tail` comes last (the reorder
   line, said once in all, ui/nav-reorder-hint.js; `onTipChange` hears that row's tooltip open and close). All of it is the one
   Tooltip (never a title attribute): it opens on hover, on keyboard focus and on a long press. `start` draws the 「从这里开始」
   marker (ui/nav-start.js): it sits inside the one row height, it is hidden in the 62px rail, and it changes nothing else about the row. */
export function NavItem({ glyph, icon, label, hint, hintClass = "nav-count", hintTitle, purpose, tail, onTipChange, narrow = false, start = false, upkeep = false, active = false, disabled = false, className = "", title, ...button }) {
  const classes = ["nav", className, upkeep && "nav-upkeep", start && "is-start"].filter(Boolean).join(" ");
  const row = (
    <button type="button" {...button} className={classes} disabled={disabled} aria-current={active && !disabled ? "page" : undefined}>
      <IconBox>{icon || <Icon name={`nav-${glyph}`} />}</IconBox>
      {/* The 「从这里开始」 marker is a dot in the gap before the label (ui/nav-start.css): it takes no room from the label, so a long
          English label keeps its two lines. Its meaning is the first line of the tooltip and, for a screen reader, of the description. */}
      {start && <span className="nav-start" aria-hidden="true" />}
      <span className="nav-label">{label}</span>
      {hint !== undefined && hint !== null && hint !== false && <span className={hintClass}>{hint}</span>}
    </button>
  );
  // What the row says beyond its label (that it is a starting point, why it is here, a run's title, what the count means, how to reorder) is a Tooltip: it shows on keyboard focus too.
  const words = [start ? ui("从这里开始") : "", narrow ? label : "", title !== label && title, purpose, hintTitle, tail].filter(Boolean).join("\n");
  return words ? <Tooltip layer anchorClassName="nav-tip" className="nav-tooltip" placement="bottom-start" content={words} onOpenChange={onTipChange}>{row}</Tooltip> : row;
}

/* A group of rows by when they are used (每天 / 阶段性 / 课程准备与管理, ui/nav-order.js). The label is one fixed-height line
   of its own, so folding or opening a group moves only what is below it and never the height of any row. A foldable group
   is a button with aria-expanded; a folded group keeps its rows in the page (hidden), so anchors and shortcuts still
   resolve. The daily group has nothing to fold and is a plain heading. `hint` is the one line that says what the group holds,
   said by the Tooltip (a plain heading is focusable so a keyboard can read it too). */
export function NavGroup({ id, label, hint, collapsible = false, open = true, onToggle, children }) {
  const labelId = `nav-group-${id}-label`, itemsId = `nav-group-${id}-items`;
  const title = hint ? ui(hint) : undefined;
  const heading = collapsible
    ? <button type="button" className="nav-group-label" data-usage="nav.group" id={labelId} aria-expanded={open} aria-controls={itemsId} onClick={onToggle}>
      <span className="nav-group-text">{ui(label)}</span><span className="nav-group-chevron" aria-hidden="true" />
    </button>
    : <div className="nav-group-label is-static" id={labelId} tabIndex={0}><span className="nav-group-text">{ui(label)}</span></div>;
  return (
    <div className="nav-group" role="group" aria-labelledby={labelId} data-nav-group={id} data-open={open ? "true" : "false"}>
      {title ? <Tooltip layer anchorClassName="nav-group-tip" placement="bottom-start" content={title}>{heading}</Tooltip> : heading}
      <div className="nav-group-items" id={itemsId} hidden={open ? undefined : true}>{children}</div>
    </div>
  );
}

/** 回到题目: back into the open run, or start today's study; with an open run its progress is the trailing hint. */
export function ResumeNavItem({ lastRun, hasDecks, ready = true, active = false, disabled = false, start = false, narrow = false, onClick }) {
  const title = !ready
    ? ""
    : lastRun
      ? uiFormat("回到「{0}」第 {1}/{2} 题", [lastRun.title, lastRun.index + 1, lastRun.total])
      : hasDecks
        ? ui("没有进行中的练习，开始今日学习")
        : ui("还没有题目，先去创建题组");
  return (
    <NavItem className="resume-nav" data-usage="nav.resume" glyph="resume" label={ui("回到题目")} active={active} disabled={disabled} title={title} aria-keyshortcuts="S" onClick={onClick}
      purpose={ui("每一轮练习都从这里接着做")} start={start} narrow={narrow}
      hint={lastRun ? `${lastRun.index + 1}/${lastRun.total}` : undefined} hintClass="nav-count nav-progress" />
  );
}

/** 为你定制: the prepared questions are ready; the count is the trailing badge. */
export function CoachNavItem({ ready, disabled = false, narrow = false, onClick }) {
  return (
    <NavItem className="coach-nav" data-usage="nav.coach" glyph="coach" label={ui("为你定制")} disabled={disabled} narrow={narrow} onClick={onClick}
      title={`${uiFormat("{0} 道题已备好", [ready])}\n${ui("开刷为你定制的题（这一轮会保留，可回来继续）")}`}
      hint={ready} hintClass="nav-badge" />
  );
}

export default NavItem;
