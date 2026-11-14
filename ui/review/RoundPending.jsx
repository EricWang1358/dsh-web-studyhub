import { ui, uiFormat } from "../i18n.js";
import React from "react";
import { Button, Chip, Popover, Tooltip } from "../components/index.js";
import { useStudy } from "../study-context.jsx";
import { pendingCount, retriesWaiting } from "./session-logic.js";
import { levelWord, tickWords } from "./round-words.js";

/* 「N 题待答」 beside the question number (#1008). On a narrow window the column of ticks (ui/ReviewNavigator.jsx) is gone, so this small chip does its work:
   a press opens the round's questions as a compact list of numbers (answered ones marked, the one on screen current) that jumps like a tick, and 到此为止 at
   its end. Where the column is drawn (a wide practice page) the chip is hidden by CSS (session.css), so a page says it once. Nothing in an exam. */
export default function RoundPending({ run, onJump, onEnd, skippedIndices }) {
  const { busy } = useStudy();
  const [open, setOpen] = React.useState(false);
  const [onlyUnanswered, setOnlyUnanswered] = React.useState(false);
  const listRef = React.useRef(null);
  React.useEffect(() => { setOnlyUnanswered(false); }, [run.id]);
  const skippedSet = skippedIndices instanceof Set ? skippedIndices : new Set(Array.isArray(skippedIndices) ? skippedIndices : []);
  // Questions of the round first; when only re-asks (再练) are left the chip names those, so 到此为止 stays one press away.
  const waiting = pendingCount(run), retries = retriesWaiting(run);
  if (!(waiting + retries) || !run.navigation?.length) return null;
  const close = () => setOpen(false);
  const hasAnswered = run.navigation.some((item) => item.answered);
  const hasUnanswered = run.navigation.some((item) => !item.answered);
  const showFilter = hasAnswered && hasUnanswered;
  const visibleItems = showFilter && onlyUnanswered ? run.navigation.filter((item) => !item.answered) : run.navigation;
  const handleListKeyDown = (event) => {
    const keys = ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"];
    if (!keys.includes(event.key)) return;
    const buttons = [...(listRef.current?.querySelectorAll(".round-pending__item:not(:disabled)") || [])];
    if (!buttons.length) return;
    const active = event.target?.closest?.(".round-pending__item") || document.activeElement;
    const cur = buttons.indexOf(active);
    if (cur < 0) return;
    event.preventDefault();
    event.stopPropagation();
    const firstRect = buttons[0].getBoundingClientRect?.();
    const cols = firstRect?.width > 0
      ? Math.max(1, buttons.filter((btn) => Math.abs((btn.getBoundingClientRect?.().top ?? 0) - firstRect.top) < 4).length)
      : 1;
    let next = cur;
    if (event.key === "ArrowRight") next = Math.min(buttons.length - 1, cur + 1);
    else if (event.key === "ArrowLeft") next = Math.max(0, cur - 1);
    else if (event.key === "ArrowDown") next = Math.min(buttons.length - 1, cur + cols);
    else if (event.key === "ArrowUp") next = Math.max(0, cur - cols);
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = buttons.length - 1;
    buttons[next]?.focus?.();
  };
  return (
    <Popover label={ui("本轮题目")} open={open} onOpenChange={setOpen} placement="bottom-start" className="round-pending" panelClassName="round-pending__panel"
      trigger={({ props, ref }) => <Button ref={ref} variant="quiet" size="sm" className="round-pending__trigger" {...props}>{waiting ? uiFormat("{0} 题待答", [waiting]) : uiFormat("{0} 道再练", [retries])}</Button>}>
      {showFilter && (
        <div className="round-pending__filter">
          <Chip size="sm" selected={onlyUnanswered} onClick={() => setOnlyUnanswered((value) => !value)}>{ui("只看未答")}</Chip>
        </div>
      )}
      <ol className="round-pending__list" ref={listRef} onKeyDown={handleListKeyDown}>
        {visibleItems.map((item) => {
          const current = item.index === run.index;
          const isSkipped = !item.answered && skippedSet.has(item.index);
          const baseLabel = tickWords(item, levelWord(item.level));
          const label = isSkipped ? uiFormat("{0} · 先跳过待答", [baseLabel]) : baseLabel;
          const button = (
            <Button size="sm" className="round-pending__item" aria-label={label} aria-current={current ? "step" : undefined} lock={busy}
              data-answered={item.answered ? (item.passed === false ? "wrong" : "right") : undefined} data-retry={item.retry ? "true" : undefined}
              data-skipped={isSkipped ? "true" : undefined}
              onClick={() => { close(); if (!current) onJump(item.index); }}>
              {item.retry ? ui("再练") : String(item.index + 1)}
            </Button>
          );
          return (
            <li key={item.index}>
              {isSkipped ? <Tooltip layer content={ui("先跳过待答")} anchorClassName="round-pending__tip">{button}</Tooltip> : button}
            </li>
          );
        })}
      </ol>
      {onEnd && <Button variant="link" size="sm" className="round-pending__end" lock={busy} onClick={() => { close(); onEnd(); }}>{ui("到此为止…")}</Button>}
    </Popover>
  );
}
