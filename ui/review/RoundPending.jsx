import { ui, uiFormat } from "../i18n.js";
import React from "react";
import { Button, Popover } from "../components/index.js";
import { useStudy } from "../study-context.jsx";
import { pendingCount } from "./session-logic.js";
import { levelWord, tickWords } from "./round-words.js";

/* 「N 题待答」 beside the question number (#1008). On a narrow window the column of ticks (ui/ReviewNavigator.jsx) is gone, so this small chip does its work:
   a press opens the round's questions as a compact list of numbers (answered ones marked, the one on screen current) that jumps like a tick, and 到此为止 at
   its end. Where the column is drawn (a wide practice page) the chip is hidden by CSS (session.css), so a page says it once. Nothing in an exam. */
export default function RoundPending({ run, onJump, onEnd }) {
  const { busy } = useStudy();
  const [open, setOpen] = React.useState(false);
  const waiting = pendingCount(run);
  if (!waiting || !run.navigation?.length) return null;
  const close = () => setOpen(false);
  return (
    <Popover label={ui("本轮题目")} open={open} onOpenChange={setOpen} placement="bottom-start" className="round-pending" panelClassName="round-pending__panel"
      trigger={({ props, ref }) => <Button ref={ref} variant="quiet" size="sm" className="round-pending__trigger" {...props}>{uiFormat("{0} 题待答", [waiting])}</Button>}>
      <ol className="round-pending__list">
        {run.navigation.map((item) => {
          const current = item.index === run.index;
          const label = tickWords(item, levelWord(item.level));
          return (
            <li key={item.index}>
              <Button size="sm" className="round-pending__item" aria-label={label} aria-current={current ? "step" : undefined} lock={busy}
                data-answered={item.answered ? (item.passed === false ? "wrong" : "right") : undefined} data-retry={item.retry ? "true" : undefined}
                onClick={() => { close(); if (!current) onJump(item.index); }}>
                {item.retry ? ui("再练") : String(item.index + 1)}
              </Button>
            </li>
          );
        })}
      </ol>
      {onEnd && <Button variant="link" size="sm" className="round-pending__end" lock={busy} onClick={() => { close(); onEnd(); }}>{ui("到此为止…")}</Button>}
    </Popover>
  );
}
