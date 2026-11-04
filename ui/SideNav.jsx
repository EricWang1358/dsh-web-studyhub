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
   "what is this?" and not only "what is it called"; beside the visible label the label itself is not said again (issue 569). `title` is
   the row's own state (a run's title, the week's theme) and `hintTitle` explains the trailing count; `tail` comes last (the reorder line,
   said once in all, ui/nav-reorder-hint.js; `onTipChange` hears that row's tooltip open and close). All of it is the one Tooltip (never a
   title attribute): it opens on hover, on keyboard focus and on a long press.

   `alert` is the one attention dot of the sidebar (#655, ui/nav-alert.js): a dot on the icon's corner for something the learner should act
   on now, and its reason is the first line of the tooltip. At most one row carries it; with nothing to act on, none does. */
export function NavItem({ glyph, icon, label, hint, hintClass = "nav-count", hintTitle, purpose, tail, onTipChange, alert, upkeep = false, active = false, disabled = false, className = "", title,
  tipInteractive = false, tipPlacement = "bottom-start", ...button }) {
  const classes = ["nav", className, upkeep && "nav-upkeep", alert && "has-alert"].filter(Boolean).join(" ");
  const row = (
    <button type="button" {...button} className={classes} disabled={disabled} aria-current={active && !disabled ? "page" : undefined}>
      <IconBox className={alert ? "nav-alert-icon" : undefined}>{icon || <Icon name={`nav-${glyph}`} />}{alert && <span className="nav-alert" aria-hidden="true" />}</IconBox>
      <span className="nav-label">{label}</span>
      {hint !== undefined && hint !== null && hint !== false && <span className={hintClass}>{hint}</span>}
    </button>
  );
  // What the row says beyond its label (why it has a dot, why it is here, a run's title, what the count means, how to reorder) is a Tooltip: it shows on keyboard focus too.
  const words = [alert || "", title !== label && title, purpose, hintTitle, tail].filter(Boolean).join("\n");
  return words
    ? <Tooltip layer interactive={tipInteractive} anchorClassName="nav-tip" className="nav-tooltip" placement={tipPlacement} content={words} onOpenChange={onTipChange}>{row}</Tooltip>
    : row;
}

/* A group of rows: the main list (its heading is for screen readers only: on screen it is simply the first rows) or a section of 「更多」 named
   by what it holds (ui/pages.js NAV_SECTIONS). The heading is one fixed-height line of its own, so no state of the page changes the height of
   any row. `data-nav-group` is what a drag measures to move a row between the main list and its section (ui/nav-order.js). */
export function NavGroup({ id, label, hidden: hideLabel = false, children }) {
  const labelId = `nav-group-${id}-label`;
  return (
    <div className="nav-group" role="group" aria-labelledby={labelId} data-nav-group={id}>
      <div className={hideLabel ? "nav-group-label sh-visually-hidden" : "nav-group-label"} id={labelId}><span className="nav-group-text">{ui(label)}</span></div>
      <div className="nav-group-items">{children}</div>
    </div>
  );
}

/* A row that opens more rows below it (「更多」, 「帮助」). The row is a NavItem like every other (same anatomy and height, the same Tooltip, the
   attention dot while the row that carries it is folded away) with aria-expanded; what it opens is a native <details>, so the feature finder
   and the tour open it the way they open every other fold (ui/tour/anchor.js locateAnchor sets .open, and `onToggle` hears it). The fold's own
   <summary> is hidden: the row above is its one control, and `open` is the one state. */
export function NavFold({ id, glyph, icon, label, purpose, alert, open, onToggle, className = "", children, ...row }) {
  const itemsId = `nav-fold-${id}`;
  return (
    <div className={["nav-fold", className].filter(Boolean).join(" ")} data-nav-fold={id} data-open={open ? "true" : "false"}>
      <NavItem {...row} className="nav-fold__toggle" icon={icon || <Icon name={glyph} />} label={label} purpose={purpose} alert={alert}
        aria-expanded={open} aria-controls={itemsId} hint="" hintClass="nav-fold__chevron" onClick={() => onToggle(!open)} />
      <details className="nav-fold__items" id={itemsId} open={open}
        onToggle={(event) => { if (event.currentTarget.open !== open) onToggle(event.currentTarget.open); }}>
        <summary hidden>{label}</summary>
        {children}
      </details>
    </div>
  );
}

/** The open run as 回到题目 shows it, from the session on screen when that is the same run: where the learner is in the round, not the queue index
 *  (a re-ask inside a round of 4 would otherwise read 5/4). `run.position` ({ total, at, … }, 1-based `at`) is the round as the practice page
 *  counts it; without it, the queue index and length. */
export function resumeProgress(lastRun, run) {
  if (!lastRun || !run || run.id !== lastRun.id) return lastRun;
  return { ...lastRun, index: Math.max(0, (run.position?.at ?? run.index + 1) - 1), total: run.position?.total ?? run.total };
}

/** 回到题目: back into the open run, or start today's study; with an open run its progress is the trailing hint. */
export function ResumeNavItem({ lastRun, hasDecks, ready = true, active = false, disabled = false, alert, onClick }) {
  const title = !ready
    ? ""
    : lastRun
      ? uiFormat("回到「{0}」第 {1}/{2} 题", [lastRun.title, lastRun.index + 1, lastRun.total])
      : hasDecks
        ? ui("没有进行中的练习，开始今日学习")
        : ui("还没有题目，先去创建题组");
  return (
    <NavItem className="resume-nav" data-usage="nav.resume" glyph="resume" label={ui("回到题目")} active={active} disabled={disabled} title={title} aria-keyshortcuts="S" onClick={onClick}
      purpose={ui("每一轮练习都从这里接着做")} alert={alert}
      hint={lastRun ? `${lastRun.index + 1}/${lastRun.total}` : undefined} hintClass="nav-count nav-progress" />
  );
}

/** 为你定制: the prepared questions are ready; the count is the trailing badge. */
export function CoachNavItem({ ready, disabled = false, onClick }) {
  return (
    <NavItem className="coach-nav" data-usage="nav.coach" glyph="coach" label={ui("为你定制")} disabled={disabled} onClick={onClick}
      title={`${uiFormat("{0} 道题已备好", [ready])}\n${ui("开刷为你定制的题（这一轮会保留，可回来继续）")}`}
      hint={ready} hintClass="nav-badge" />
  );
}

export default NavItem;
