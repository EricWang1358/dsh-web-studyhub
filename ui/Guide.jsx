import { ui, uiFormat } from "./i18n.js";
import React from "react";

const topicOf = (goal) => goal.trim() || ui("这部分内容");

/**
 * Collapsible "how do I use this" walkthrough. Steps tick off from the real
 * library state, and every step offers the in-panel action plus a chat prompt.
 */
export default function Guide({
  data,
  busy,
  goal,
  setGoal,
  open,
  setOpen,
  variant,
  addSource,
  generate,
  record,
  openDraft,
  startToday,
  askInChat,
}) {
  const t = topicOf(goal);
  const draftWithIssues = data.drafts.find((draft) => draft.cards.some((card) =>
    draft.editorial?.rejectedIssues?.[card.id]));
  const nextDraft = draftWithIssues || data.drafts[0];
  const steps = [
    {
      title: ui("准备题目"),
      done: data.sources.length > 0 || data.decks.length > 0 || data.drafts.length > 0,
      body: ui("已有 JSON 题组可以直接导入；需要补题时再添加资料。"),
      actions: [
        [ui("导入 JSON 题组"), generate],
        [ui("添加资料补题"), addSource],
        [ui("录入现成题目"), record],
      ],
    },
    {
      title: ui("导入题组"),
      done: data.decks.length > 0 || data.drafts.length > 0,
      body: ui("外部生成题目后导入 JSON。系统建议短标题和课程，你确认后保存草稿；内置 AI 可按需补题。"),
      actions: [
        [ui("导入 JSON"), generate],
      ],
    },
    {
      title: ui("发布题组"),
      done: data.decks.length > 0,
      body: data.drafts.length
        ? data.decks.length
          ? uiFormat("已有 {0} 个题组发布；还有 {1} 份草稿。{2}", [data.decks.length, data.drafts.length, draftWithIssues
            ? ui("问题题可自行修改或选择后台修题，修好后再发布。")
            : ui("打开草稿可继续检查并发布。")])
          : uiFormat("有 {0} 份草稿待发布。发布时快速检查结构，随后直接学习新题。", [data.drafts.length])
        : data.decks.length
          ? uiFormat("已有 {0} 个题组发布，可以开始学习。", [data.decks.length])
          : ui("导入结果先进入草稿，发布后直接开始 10 道新题。"),
      actions: nextDraft ? [[draftWithIssues ? ui("打开待处理草稿") : ui("打开草稿"), () => openDraft(nextDraft)]] : [],
    },
    {
      title: ui("开始学习"),
      done: data.attempts.length > 0,
      body: ui("当前课程先学最近导入的新题，每轮 10 道；到期复习在单独入口。"),
      actions: data.decks.length ? [[data.focus?.fresh?.length ? ui("学当前课程新题") : ui("到期复习"), startToday]] : [],
    },
    {
      title: ui("卡住了就问"),
      done: false,
      optional: true,
      body: ui("遇到不会的题，在对话里输入 /study-spar 加题目，会自动归类进题库（默认闪卡，说「写成 MQ」则为单选）。"),
      actions: [
        [
          ui("讲解我的薄弱点"),
          () =>
            askInChat(
              uiFormat("请用 study_workspace 的 map 看看「{0}」相关题组里我哪些主题最薄弱，按学习顺序逐个讲解，并各出一道小题检查我。", [t]),
            ),
        ],
      ],
    },
  ];
  const required = steps.filter((s) => !s.optional),
    finished = required.filter((s) => s.done).length,
    current = required.find((s) => !s.done);

  return (
    <section className={`guide guide-${variant}`}>
      <button
        className="guide-toggle"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        <span className="guide-icon" aria-hidden="true">
          ?
        </span>
        <span className="guide-heading">
          <strong>{ui("上手指引")}</strong>
          <small>
            {finished === required.length
              ? ui("都走通了，每天回来复习")
              : uiFormat("{0}/{1} · 下一步：{2}", [finished, required.length, current.title])}
          </small>
        </span>
        <span className="guide-caret" aria-hidden="true">
          {open ? "▾" : "▸"}
        </span>
      </button>
      {open && (
        <div className="guide-body">
          <label className="guide-goal">{ui("今天想学什么？")}<input
              value={goal}
              onChange={(e) => setGoal(e.target.value)}
              placeholder={ui("例如：图论笔试题")}
            />
            <small>{ui("填了之后，下面发到对话里的提示词会带上它。")}</small>
          </label>
          <ol className="guide-steps">
            {steps.map((step, i) => (
              <li
                key={step.title}
                className={
                  "guide-step" +
                  (step.done ? " done" : "") +
                  (step === current ? " current" : "")
                }
              >
                <span className="guide-marker" aria-hidden="true">
                  {step.done ? "✓" : step.optional ? "·" : i + 1}
                </span>
                <div>
                  <strong>
                    {step.title}
                    {step.done && <span className="sr-only">{ui("（已完成）")}</span>}
                  </strong>
                  <p>{step.body}</p>
                  {step.actions.length > 0 && (
                    <div className="guide-actions">
                      {step.actions.map(([label, run], j) => (
                        <button
                          key={label}
                          className={step === current && j === 0 ? "primary" : ""}
                          disabled={busy}
                          onClick={run}
                        >
                          {label}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              </li>
            ))}
          </ol>
          <p className="guide-foot">{ui("「让 AI…」类按钮只把提示词填进对话输入框，确认后再发送。")}</p>
        </div>
      )}
    </section>
  );
}
