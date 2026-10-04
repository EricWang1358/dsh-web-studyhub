import { ui } from "./i18n.js";
import React, { useEffect, useRef } from "react";
import { CloseButton, useDismiss, useTopDialog } from "./components/index.js";

/* 快捷键速查（按 ? 打开）。只列当前页面用得上的，避免一屏说明书。 */
const REVIEW = [
  ["1–6", "选择选项"],
  ["1–7", "👎 标签展开时：选标签"],
  ["0–5", "闪卡 / 开放题自评"],
  ["Enter", "下一题 · 提交多选/填空 · 翻卡"],
  ["Space", "翻卡"],
  ["← →", "上一题 / 下一题"],
  ["H", "提示 / 讲解"],
  ["T", "通俗详解：用比喻把这道题讲透（交给后台助教）"],
  ["G / B", "👍 这题不错 / 👎 这题有问题"],
  ["A", "自动驾驶 开/关"],
];
const EVERYWHERE = [
  ["S", "从任意页继续上一轮或开始今日学习"],
  ["P", "阅读资料时：做这几页的题（范围可选，做完回到阅读）"],
  ["?", "打开 / 关闭这张速查"],
  ["Esc", "关闭弹层"],
];

/** A non-modal sheet: focus moves into it when it opens, Escape or a press outside closes it and focus goes back to where it was. */
export default function ShortcutHelp({ page, onClose }) {
  const rows = page === "review" ? [...REVIEW, ...EVERYWHERE] : [...EVERYWHERE, ["A", ui("自动驾驶 开/关")]];
  const sheet = useRef(null), opener = useRef(null);
  useEffect(() => {
    opener.current = document.activeElement;
    sheet.current?.focus({ preventScroll: true });
    return () => {
      const back = opener.current, active = document.activeElement;
      if (back?.isConnected && (!active || active === document.body)) back.focus?.({ preventScroll: true });
    };
  }, []);
  // While a dialog is open on top of the sheet, Escape belongs to the dialog alone: one press closes one layer.
  const dialogOpen = !!useTopDialog();
  useDismiss({ open: true, onClose, refs: sheet, returnFocusRef: opener, escape: !dialogOpen });
  return (
    <div className="shortcut-sheet" role="dialog" aria-label={ui("快捷键")} tabIndex={-1} ref={sheet}>
      <h3>{ui("快捷键")}<CloseButton label={ui("关闭快捷键")} onClick={onClose} /></h3>
      <dl>
        {rows.map(([k, v]) => (
          <React.Fragment key={k}>
            <dt>
              {k.split(" / ").map((x) => (
                <kbd key={x}>{x}</kbd>
              ))}
            </dt>
            <dd>{ui(v)}</dd>
          </React.Fragment>
        ))}
      </dl>
    </div>
  );
}
