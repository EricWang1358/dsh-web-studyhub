import { ui, uiFormat } from "./i18n.js";
import React, { useEffect, useState } from "react";
import { Disclosure } from "./components/index.js";
import { legacyStageText, stepLabel } from "./generation-status.js";
import { retrievalSummary } from "./large-document-advice.js";

/** Kept for older callers: generation prose from an older backend, in Chinese. */
export const generationStage = legacyStageText;

const STEP_STATUS = () => ({ starting: ui("启动中"), running: ui("进行中"), finishing: ui("收尾中"), complete: ui("已完成"), failed: ui("失败") });
const seconds = (from, to) => Math.max(0, Math.round((to - Date.parse(from)) / 1000));

/* What a generation job did, step by step, in plain words. How it ran
   (background helpers, direct model calls, time limits, delivery receipts)
   stays behind 技术详情 for whoever wants to look (P29). */
export default function GenerationTrace({ job, openAgent }) {
  const steps = job.steps || [];
  const [now, setNow] = useState(Date.now);
  const active = ["running", "queued", "cancelling"].includes(job.status);
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [active]);
  const status = STEP_STATUS();
  return <details className="generation-trace">
    <summary>{uiFormat("查看执行过程 · {0} 步", [steps.length])}</summary>
    <p className="muted">{job.concurrency ? ui("先统一规划考点，再分批同时出题；") : ""}{ui("每批最多 5 题，先出题并自查，再由另一位助手独立审阅；没通过的题不会进入草稿。")}</p>
    {job.savedCount > 0 && active && <p className="muted">{uiFormat("已保存 {0} 题到草稿；其余批次仍在生成。", [job.savedCount])}</p>}
    {job.totalTimeoutSeconds > 0 && <p className="muted">{uiFormat("最长 {0} 分钟（不算排队）；到时会停止，已通过检查的题保留在草稿里。", [Math.round(job.totalTimeoutSeconds / 60)])}</p>}
    {job.retrieval && <p className="muted" data-retrieval={retrievalSummary(job.retrieval).error ? "error" : "used"}>{retrievalSummary(job.retrieval).text}</p>}
    {!steps.length && <p className="muted">{job.status === "queued" ? ui("正在排队，还没有开始。") : ui("还没有步骤记录。")}</p>}
    {steps.length > 0 && <ol>{steps.map((step) => <li key={step.id}>
      <strong>{stepLabel(step, job)}</strong>
      <small>{status[step.status] || step.status}
        {step.startedAt && (step.finishedAt ? uiFormat(" · {0} 秒", [seconds(step.startedAt, Date.parse(step.finishedAt))])
          : uiFormat(" · 已等待 {0} 秒", [seconds(step.startedAt, now)]))}
      </small>
      {step.childId && openAgent && <button type="button" onClick={() => openAgent(step.childId)}>{ui("查看后台助手")}</button>}
    </li>)}</ol>}
    {!!job.messages?.length && <details><summary>{uiFormat("补充要求 · {0} 条", [job.messages.length])}</summary>
      <ul>{job.messages.map((message) => <li key={message.id}>{message.text}
        <small>{message.delivery === "delivered" ? ui("正在运行的后台助手已收到，后续步骤也会照做")
          : message.delivery === "partial" ? ui("部分后台助手已收到，其余步骤会照做")
            : ui("会在后续步骤中照做")}</small>
      </li>)}</ul>
    </details>}
    <Disclosure className="tech-details" summary={ui("技术详情")}>
      <p className="muted">{ui("出题、自查和审阅各是一次模型调用；在 DSH 里由一次性的子代理执行。引用、题型和答案泄露检查在本地完成，不调用模型。")}</p>
      {job.generationTimeoutSeconds
        ? <p className="muted">{uiFormat("每个阶段最多等待 {0} 分钟。", [Math.round(job.generationTimeoutSeconds / 60)])}</p>
        : active && <p className="muted">{ui("此任务未报告新版后端时间上限，不能确认已应用更新。刷新界面不会替换正在运行的后端；重启会丢失当前未完成的内存队列。")}</p>}
      {steps.length > 0 && <ul>{steps.map((step) => <li key={step.id}>
        <code>{step.stage}</code>
        <small>
          {step.runtime === "subagent" ? ui("DSH 子代理") : step.runtime === "direct" ? ui("直接模型调用") : step.runtime || ""}
          {step.reasoningEffort ? uiFormat(" · 推理程度 {0}", [step.reasoningEffort]) : ""}
          {step.communication ? ui(" · 支持双向通信") : ""}
          {step.toolMode === "native" ? ui(" · 无代码执行") : ""}
          {step.childId ? ` · ${step.childId}` : ""}
        </small>
        {step.note && <small>{step.note}</small>}
      </li>)}</ul>}
      {job.messages?.some((message) => message.receipts?.length) && <ul>{job.messages.flatMap((message) =>
        (message.receipts || []).map((receipt, index) => <li key={`${message.id}:${index}`}>
          <small>{receipt.childId || ui("投递目标")} · {receipt.delivered ? ui("已送达") : receipt.error || ui("未送达")}</small>
        </li>))}</ul>}
    </Disclosure>
  </details>;
}
