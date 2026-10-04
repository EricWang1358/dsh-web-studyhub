import { ui, uiFormat } from "./i18n.js";
import React, { useEffect, useRef } from "react";

const labels = { new: "未学", weak: "薄弱", learning: "学习中", familiar: "熟悉", mastered: "掌握" };

export default function ReviewNavigator({ run, busy, onJump }) {
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
        const label = uiFormat(item.answered ? "第 {0} 题 · {1} · {2} · 已答" : "第 {0} 题 · {1} · {2}", [item.index + 1, ui(labels[item.level]), item.topic]);
        return <button key={item.index}
          className="review-tick" aria-label={label} title={label}
          aria-current={current ? "step" : undefined} disabled={busy}
          onClick={() => { if (!current) onJump(item.index); }}>
          <span className={"review-tick-line lv-" + item.level} />
        </button>;
      })}
    </nav>
  );
}
