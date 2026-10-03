import { ui, uiFormat } from "./i18n.js";
import React, { useEffect, useState } from "react";
import { Disclosure } from "./components/index.js";
import AgentLink from "./AgentLink.jsx";
import { legacyStageText, stepLabel } from "./generation-status.js";
import { JobUsage } from "./TokenUsage.jsx";
import { formatExactTokens, totalTokens } from "../lib/token-usage.js";
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
    {job.retrieval && <p className="muted" data-retrieval={retrievalSummary(job.retrieval).error ? "error" : "used"}>{retrievalSummary(job.retrieval).text}</p>}
    {!steps.length && <p className="muted">{job.status === "queued" ? ui("正在排队，还没有开始。") : ui("还没有步骤记录。")}</p>}
    {steps.length > 0 && <ol>{steps.map((step) => <li key={step.id}>
      <strong>{stepLabel(step, job)}</strong>
      <small>{status[step.status] || step.status}
        {step.tokenUsage ? ` · ${formatExactTokens(totalTokens(step.tokenUsage))} tok` : ""}
        {step.startedAt && (step.finishedAt ? uiFormat(" · {0} 秒", [seconds(step.startedAt, Date.parse(step.finishedAt))])
          : uiFormat(" · 已等待 {0} 秒", [seconds(step.startedAt, now)]))}
      </small>
      <AgentLink childId={step.childId} openAgent={openAgent} label={ui("查看后台助手")} />
    </li>)}</ol>}
    {!!job.messages?.length && <details><summary>{uiFormat("补充要求 · {0} 条", [job.messages.length])}</summary>
      <ul>{job.messages.map((message) => <li key={message.id}>{message.text}
        <small>{message.delivery === "delivered" ? ui("正在运行的后台助手已收到，后续步骤也会照做")
          : message.delivery === "partial" ? ui("部分后台助手已收到，其余步骤会照做")
            : ui("会在后续步骤中照做")}</small>
      </li>)}</ul>
    </details>}
    <Disclosure className="tech-details" summary={ui("生成方式、用量与技术详情")}>
      <JobUsage job={job} />
      {job.origin === "selection"
        ? <p className="muted">{ui("先提取知识点和逐字原文，再确定答案与必要情景，然后出题、自查并独立审阅；只有通过审阅的题才会保存到题组。")}</p>
        : <p className="muted">{uiFormat("先提取知识点和逐字原文，再确定答案、必要情景和选项依据；每批最多 {0} 题，出题与自查后独立审阅，通过的题保留在草稿。", [job.batchSize || 5])}</p>}
      {job.totalTimeoutSeconds > 0 && <p className="muted">{job.origin === "selection"
        ? uiFormat("最长 {0} 分钟（不算排队）；到时会停止，题组不会有变化。", [Math.round(job.totalTimeoutSeconds / 60)])
        : uiFormat("最长 {0} 分钟（不算排队）；到时会停止，已通过检查的题保留在草稿里。", [Math.round(job.totalTimeoutSeconds / 60)])}</p>}
      <p className="muted">{ui("每组资料提取一次知识点；每批分别确定答案与情景、出题与自查、独立审阅。引用核验和已验证内容的绑定在本地完成。")}</p>
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
