import { ui, uiFormat, getUiLanguage } from "./i18n.js";
import React, { useEffect, useState } from "react";

export function generationStage(stage = "") {
  if (getUiLanguage() === "en") return stage;
  return stage.replace(/^Part (\d+)\/(\d+) · /, "第 $1/$2 批 · ")
    .replace(/Generation reached its (\d+)-minute total budget; approved questions were retained/, "已达到 $1 分钟执行时限；已验收题目已保留")
    .replace(/Draft ready with (\d+)\/(\d+) questions; (\d+) part\(s\) failed/, "草稿已保留 $1/$2 题；$3 批未完成")
    .replace(/Group (\d+)\/(\d+)/g, "第 $1/$2 组")
    .replace("Parallel generation · up to 3 batches", "并行生成 · 最多 3 批同时进行")
    .replace("Planning evidence and learning targets", "生成前：规划考点与证据边界")
    .replace("Self-checking and improving every question", "生成后：逐题自查与改写")
    .replace("Writing source-grounded questions", "出题")
    .replace("Checking citations, coverage and distractors", "核验引用与题目结构")
    .replace("Reviewing ambiguity and source support", "独立审阅")
    .replace("Repairing flagged questions", "修复审阅发现的问题")
    .replace("Reviewing repaired questions", "复审修复后的题目")
    .replace("Reviewing retained questions", "单独验收保留的合格题目")
    .replace("Waiting for the previous generation", "等待前面的任务")
    .replace("Draft ready for review", "草稿已就绪");
}

export default function GenerationTrace({ job, openAgent }) {
  const steps = job.steps || [];
  const [now, setNow] = useState(Date.now);
  const active = ["running", "queued", "cancelling"].includes(job.status);
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [active]);
  return <details className="generation-trace">
    <summary>{ui("查看执行过程 · ")}{steps.length}{ui(" 次模型任务")}</summary>
    <p className="muted">{job.concurrency ? ui("统一规划考点后，最多 3 批并行；") : ""}{ui("每批最多 5 题，依次出题 → 自查改写 → 本地核验 → 独立验收；不合格再修复、复审。本地核验不创建子代理。")}</p>
    {job.savedCount > 0 && active && <p className="muted">{ui("已保存 ")}{job.savedCount}{ui(" 题到草稿；其余批次仍在生成。")}</p>}
    <p className="muted">{ui("子代理中的 JSON 是该步骤的中间结果；全部批次检查结束后才会形成草稿。排队任务需等待前一题组完成。")}</p>
    {job.generationTimeoutSeconds
      ? <p className="muted">{ui("此任务后端报告：每阶段最多等待 ")}{Math.round(job.generationTimeoutSeconds / 60)}{ui(" 分钟。超时会单独报告，已通过检查的题目仍会保留。")}</p>
      : active && <p className="warning">{ui("此任务未报告新版后端时间上限，不能确认已应用更新。刷新界面不会替换正在运行的后端；重启会丢失当前未完成的内存队列。")}</p>}
    {job.totalTimeoutSeconds > 0 && <p className="muted">{ui("题组执行预算 ")}{Math.round(job.totalTimeoutSeconds / 60)}{ui(" 分钟（不含排队），到时停止后续生成，保留已验收题目。")}</p>}
    {!steps.length && <p className="muted">{job.status === "queued" ? ui("正在排队，尚未启动模型任务。") : ui("尚无可用记录；可能尚未启动模型任务，或来自更新前的任务。")}</p>}
    <ol>{steps.map((step) => <li key={step.id}>
      <strong>{generationStage(step.stage)}</strong>
      <small>{({ starting: ui("启动中"), running: ui("执行中"), finishing: ui("结果已返回，正在结束子会话"), complete: ui("已完成"), failed: ui("失败") })[step.status] || step.status}
        {step.runtime === "subagent" ? ui(" · DSH 子代理") : step.runtime === "direct" ? ui(" · 直接模型调用") : ""}
        {step.communication && ui(" · 支持双向通信")}
        {step.toolMode === "native" && ui(" · 无代码执行")}
        {step.finishedAt && uiFormat(" · {0} 秒", [Math.max(0, Math.round((Date.parse(step.finishedAt) - Date.parse(step.startedAt)) / 1000))])}
        {!step.finishedAt && uiFormat(" · 已等待 {0} 秒", [Math.max(0, Math.round((now - Date.parse(step.startedAt)) / 1000))])}
      </small>
      {step.note && <small className="warning">{step.note}</small>}
      {step.childId && (openAgent
        ? <button type="button" onClick={() => openAgent(step.childId)}>{ui("查看子代理")}</button>
        : <small>{ui("子代理 ")}{step.childId}</small>)}
    </li>)}</ol>
    {!!job.messages?.length && <details><summary>{ui("补充要求 · ")}{job.messages.length}{ui(" 条")}</summary>
      <ul>{job.messages.map((message) => <li key={message.id}>{message.text}
        <small>{message.delivery === "delivered" ? ui("已送达当前可通信子代理，并保留给后续阶段") : message.delivery === "partial" ? ui("部分子代理已收到，其余要求保留给后续阶段") : ui("已保留给后续阶段，未送达当前子代理")}</small>
        {message.receipts?.map((receipt, i) => <small key={i}>{receipt.childId || ui("投递目标")} · {receipt.delivered ? ui("已送达") : receipt.error || ui("未送达")}</small>)}
      </li>)}</ul>
    </details>}
  </details>;
}
