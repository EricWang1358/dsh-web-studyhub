import React from "react";

const topicOf = (goal) => goal.trim() || "这部分内容";

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
  const steps = [
    {
      title: "准备资料",
      done: data.sources.length > 0,
      body: "笔记、八股、题目解析都行。放进工作区让 AI 读取，或直接粘贴 / 导入 .md。",
      actions: [
        [
          "让 AI 从工作区找",
          () =>
            askInChat(
              `我今天想学「${t}」。请在工作区里找相关的笔记或资料文件，读取后用 study_workspace 的 source.add 加入学习库（标题用文件路径）。找不到的话告诉我还需要准备什么。`,
            ),
        ],
        ["粘贴资料", addSource],
        ["对话里直接录题", record],
      ],
    },
    {
      title: "生成题组",
      done: data.decks.length > 0 || data.drafts.length > 0,
      body: "笔试题适合单选 / 多选；八股概念适合闪卡或开放问答。可以各生成一组。",
      actions: [
        [
          "在对话里出题",
          () =>
            askInChat(
              `请用 study_workspace 基于「${t}」相关资料生成题组草稿：笔试题出 10 道单选题（kind: quiz），八股概念出 10 张闪卡（kind: flashcard），难度 mixed，中文。生成后提醒我去「学习」面板审阅。`,
            ),
        ],
        ["自己设置", generate],
      ],
    },
    {
      title: "审阅并发布",
      done: data.decks.length > 0,
      body: data.drafts.length
        ? `有 ${data.drafts.length} 份草稿待审阅。检查答案和引用，没问题就发布进目录。`
        : "生成结果先进入草稿，确认后发布才会进入学习目录和复习计划。",
      actions: data.drafts.length ? [["审阅草稿", () => openDraft(data.drafts[0])]] : [],
    },
    {
      title: "开始学习",
      done: data.attempts.length > 0,
      body: "点「开始学习」按路径出题：先复习到期、再补薄弱、最后按目录学新题。也可以在目录里勾选某个主题单独练。",
      actions: data.decks.length ? [["开始今日学习", startToday]] : [],
    },
    {
      title: "卡住了就问",
      done: false,
      optional: true,
      body: "遇到不会的题，在对话里输入 /study-spar 加题目，会自动归类进题库（默认闪卡，说「写成 MQ」则为单选）。",
      actions: [
        [
          "讲解我的薄弱点",
          () =>
            askInChat(
              `请用 study_workspace 的 map 看看「${t}」相关题组里我哪些主题最薄弱，按学习顺序逐个讲解，并各出一道小题检查我。`,
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
          <strong>上手指引</strong>
          <small>
            {finished === required.length
              ? "都走通了，每天回来复习"
              : `${finished}/${required.length} · 下一步：${current.title}`}
          </small>
        </span>
        <span className="guide-caret" aria-hidden="true">
          {open ? "▾" : "▸"}
        </span>
      </button>
      {open && (
        <div className="guide-body">
          <label className="guide-goal">
            今天想学什么？
            <input
              value={goal}
              onChange={(e) => setGoal(e.target.value)}
              placeholder="例如：图论笔试题"
            />
            <small>填了之后，下面发到对话里的提示词会带上它。</small>
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
                    {step.done && <span className="sr-only">（已完成）</span>}
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
          <p className="guide-foot">
            「让 AI…」类按钮只把提示词填进对话输入框，确认后再发送。
          </p>
        </div>
      )}
    </section>
  );
}
