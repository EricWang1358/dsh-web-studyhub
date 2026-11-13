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
  ["V / Shift+V", "语音作答 / 语音向 AI 提问（闪卡 / 简答 / 填空）"],
  ["G / B", "👍 这题不错 / 👎 这题有问题"],
  ["A", "自动跳下一步 开/关"],
  // The actions of 更多 that have a key (#1008).
  ["K", "先跳过：这道题留到这一轮最后再做"],
  ["N", "写笔记"],
  ["F", "标为重点 / 取消重点"],
  ["O", "打开这道题出自的资料页"],
];
// 复习全书: the keys of the reading surface (ui/book/reading.js useStepKeys, ui/book/BookToc.jsx).
const BOOK = [
  ["← → / Esc", "复习全书：← → 换一个知识点；Esc 关掉滑出的目录或菜单"],
];
const EVERYWHERE = [
  ["S", "从任意页继续上一轮或开始今日学习"],
  ["Ctrl K / ⌘K / /", "找功能：搜一个功能在哪，选中后直接带你过去（/ 在没有输入框聚焦时可用）"],
  // The sidebar's reorder keys (ui/nav-order.js): its tooltips say them once only (ui/nav-reorder-hint.js), so they are kept here.
  ["Alt+↑ / Alt+↓", "侧栏：把有焦点的那一项上移 / 下移（用鼠标就长按并拖动）"],
  ["P", "阅读资料时：做这几页的题（范围可选，做完回到阅读）"],
  ["[ / ]", "阅读资料时：上一章 / 下一章"],
  ["?", "打开 / 关闭这张速查"],
  ["Esc", "关闭弹层"],
];

/** A non-modal sheet: focus moves into it when it opens, Escape or a press outside closes it and focus goes back to where it was. */
export default function ShortcutHelp({ page, onClose }) {
  const rows = page === "review" ? [...REVIEW, ...EVERYWHERE] : [...(page === "book" ? BOOK : []), ...EVERYWHERE, ["A", "自动跳下一步 开/关"]];
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
      <div className="shortcut-sheet__head">
        <h3>{ui("快捷键")}</h3>
        <CloseButton label={ui("关闭快捷键")} onClick={onClose} />
      </div>
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
