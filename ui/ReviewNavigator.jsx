import { ui } from "./i18n.js";
import React, { useEffect, useRef } from "react";
import { useStudy } from "./study-context.jsx";
import { Tooltip } from "./components/index.js";
import { tickWords } from "./review/round-words.js";

const labels = { new: "未学", weak: "薄弱", learning: "学习中", familiar: "熟悉", mastered: "掌握" };

/* The column of short lines at the left of the practice page: one line per stop of the round. Its colour is the question's mastery before the round, a longer
   line means answered, the longest is the one on screen. Each line says all of that in one sentence on hover, on keyboard focus and to a screen reader
   (「第 2 题 · 主题 · 答对了 · 掌握程度：学习中」) and jumps to its question. On a narrow window the column is gone (the card's own progress bar says where
   the learner is) so it takes no width from the card (#673). */
export default function ReviewNavigator({ run, onJump }) {
  const { busy } = useStudy();
  const rail = useRef(null);
  useEffect(() => {
    const container = rail.current;
    const current = container?.querySelector('[aria-current="step"]');
    if (!current) return;
    container.scrollTo({
      top: current.offsetTop - container.clientHeight / 2 + current.clientHeight / 2,
      behavior: "instant",
    });
  }, [run.id, run.index, run.navigation?.length]);
  if (!run.navigation?.length) return null;
  return (
    <nav className="review-navigator" aria-label={ui("题目跳转与掌握程度")} ref={rail}>
      {run.navigation.map((item) => {
        const current = item.index === run.index;
        const label = tickWords(item, ui(labels[item.level]));
        return <Tooltip key={item.index} layer placement="right-start" group="review-ticks" content={label} anchorClassName="review-tick-tip">
          <button
            className="review-tick" aria-label={label}
            data-answered={item.answered ? "true" : undefined}
            data-retry={item.retry ? "true" : undefined}
            aria-current={current ? "step" : undefined} disabled={busy}
            onClick={() => { if (!current) onJump(item.index); }}>
            <span className={"review-tick-line lv-" + item.level} />
          </button>
        </Tooltip>;
      })}
    </nav>
  );
}
