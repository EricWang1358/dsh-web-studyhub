import React from "react";

/* 快捷键速查（按 ? 打开）。只列当前页面用得上的，避免一屏说明书。 */
const REVIEW = [
  ["1–6", "选择选项（👎 标签展开时：选标签）"],
  ["0–5", "闪卡 / 开放题自评"],
  ["Enter", "下一题 · 提交多选/填空 · 翻卡"],
  ["Space", "翻卡"],
  ["← →", "上一题 / 下一题"],
  ["H", "提示 / 讲解"],
  ["G / B", "👍 这题不错 / 👎 这题有问题"],
  ["A", "自动驾驶 开/关"],
];
const EVERYWHERE = [
  ["S", "从任意页继续上一轮或开始今日学习"],
  ["?", "打开 / 关闭这张速查"],
  ["Esc", "关闭弹层"],
];

export default function ShortcutHelp({ page, onClose }) {
  const rows = page === "review" ? [...REVIEW, ...EVERYWHERE] : [...EVERYWHERE, ["A", "自动驾驶 开/关"]];
  return (
    <div className="shortcut-sheet" role="dialog" aria-label="快捷键">
      <h3>
        快捷键
        <button className="coach-chip" onClick={onClose} aria-label="关闭快捷键">
          Esc
        </button>
      </h3>
      <dl>
        {rows.map(([k, v]) => (
          <React.Fragment key={k}>
            <dt>
              {k.split(" / ").map((x) => (
                <kbd key={x}>{x}</kbd>
              ))}
            </dt>
            <dd>{v}</dd>
          </React.Fragment>
        ))}
      </dl>
    </div>
  );
}
