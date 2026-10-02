import { ui, uiFormat } from "./i18n.js";
import React, { useMemo, useState } from "react";
import { renderNoteMarkdown } from "./note-markdown.js";
import { ModelError } from "./WorkflowScope.jsx";
import { TokenEstimate, TokenUsage } from "./TokenUsage.jsx";
import { ReadingBlock, ReadingSettingsButton } from "./reading-settings/ReadingSettings.jsx";

export const TeachingArticle = React.memo(function TeachingArticle({ content, className = "" }) {
  const html = useMemo(() => renderNoteMarkdown(content), [content]);
  return <ReadingBlock prose className={`wf-prose ${className}`.trim()} dangerouslySetInnerHTML={{ __html: html }} />;
});

const HELP = [{ mode: "example", label: "换个例子" }, { mode: "steps", label: "拆开讲" }, { mode: "prerequisite", label: "补前置" }];
const IMPROVE = ["太抽象", "步骤跳跃", "例子不够", "依据不清"];

function TeachingCitations({ citations, sources }) {
  if (!citations?.length) return null;
  return <details className="wf-readings"><summary>{ui("这篇讲解的资料依据 · ")}{citations.length}{ui(" 处")}</summary>{citations.map((ref, index) => <blockquote key={index}><p>{ref.quote}</p><cite>{sources?.find(source => source.id === ref.sourceId)?.title || ui("关联资料")}</cite></blockquote>)}</details>;
}

export default function WorkflowLesson({ topic, content, record, resources, disabled, onTeach, onUndo, call, sessionId, stepId }) {
  const [request, setRequest] = useState("");
  const teaching = record.teaching;
  const running = teaching?.status === "running" && resources.teachingActive !== false;
  const interrupted = teaching?.status === "running" && resources.teachingActive === false;
  const failed = teaching?.status === "failed" || interrupted;
  const unavailable = resources.modelReady === false;
  const blocked = disabled || running || unavailable;
  const help = record.help || [];
  // The learner came back for the gaps in their retelling: that re-explanation
  // leads the lesson instead of waiting below the whole article.
  const remedyRunning = running && teaching.mode === "remedy";
  const lastRemedy = help.findLast((item) => item.kind === "remedy");
  const remedy = remedyRunning ? { request: teaching.request } : lastRemedy;
  const others = remedy === lastRemedy ? help.filter((item) => item !== lastRemedy) : help;
  const gaps = (remedy?.request || "").split("；").map((gap) => gap.trim()).filter(Boolean);
  return <section className="wf-teaching" aria-label={ui("学习讲解")}>
    {remedy && <aside className="wf-remedy" aria-label={ui("针对复述补讲")}>
      <p className="wf-eyebrow">{ui("针对你复述里漏掉的地方")}</p>
      {gaps.length > 0 && <ul className="wf-remedy-gaps">{gaps.map((gap) => <li key={gap}>{/[？?]$/.test(gap) ? uiFormat("想一想：{0}", [gap]) : gap}</li>)}</ul>}
      {remedyRunning ? <p className="wf-remedy-status" role="status"><span className="wf-pulse" aria-hidden="true" />{ui("AI 正在针对这些点补讲，下面的讲解可以先看着。")}</p>
        : <><TeachingArticle content={remedy.content} /><TeachingCitations citations={remedy.citations} sources={resources.sources} /></>}
    </aside>}
    <header className="wf-teaching-heading"><div><span className="wf-eyebrow">{ui("围绕主题，连起来学")}</span><h3>{content ? ui("本步讲解") : ui("从一篇完整讲解开始")}</h3></div>{content && <span className="wf-reading-label">{ui("阅读 · 理解 · 应用")}</span>}<ReadingSettingsButton className="wf-reading" /></header>
    {content ? <TeachingArticle content={content} /> : <div className="wf-teaching-empty">
      <p>{ui("把「")}{topic}{ui("」的概念、原理和例子连成一条线，再看看它适用于什么情境。")}</p>
      <p className="muted">{ui("结合本次材料，生成可直接阅读的讲解；有公式或推导时逐步展开。")}</p>
      {!running && <button type="button" className="primary" disabled={blocked} onClick={() => onTeach("lesson")}>{ui("生成完整讲解")}</button>}
      {!running && <TokenEstimate call={call} action="workflow.teaching.estimate" enabled={!!call && !!sessionId} request={{ id: sessionId, stepId, mode: "lesson" }} />}
    </div>}
    <TeachingCitations citations={record.citations} sources={resources.sources} />
    {running && !remedyRunning && <div className="wf-teaching-progress" role="status"><span className="wf-progress-mark" aria-hidden="true" /><div><strong>{teaching.mode === "improve" ? ui("正在改进这篇讲解") : content ? ui("正在补充讲解") : ui("正在组织概念与例子")}</strong><p>{ui("完成后会显示在这里。你可以继续阅读，也可以稍后回来。")}</p></div></div>}
    {failed && <div className="wf-notice" role="status">{!interrupted && teaching.message ? <ModelError text={teaching.message} /> : <p>{interrupted ? ui("上次生成已中断，可以重新开始。") : ui("这次讲解没有生成成功，请重试。")}</p>}<button type="button" disabled={blocked} onClick={() => onTeach(teaching.mode || "lesson", teaching.request || "")}>{ui("重新生成")}</button></div>}
    {unavailable && <p className="wf-model-hint">{ui("连接模型后即可生成讲解；也可以在下方请主对话补充材料。")}</p>}
    {content && <div className="wf-teaching-tools">
      <div className="wf-help-row"><span>{ui("帮我弄懂")}</span><div className="wf-quick-choices" role="group" aria-label={ui("帮助方式")}>{HELP.map((item) => <button type="button" key={item.mode} disabled={blocked} onClick={() => onTeach(item.mode)}>{ui(item.label)}</button>)}<button type="button" disabled={blocked} onClick={() => onTeach("improve")}>{ui("改进讲解")}</button></div></div>
      <details className="wf-improve"><summary>{ui("提升讲解质量")}</summary><p className="muted small">{ui("选一个最需要改进的地方，会重写本步讲解。")}</p><div className="wf-quick-choices" role="group" aria-label={ui("改进方向")}>{IMPROVE.map((item) => <button type="button" key={item} disabled={blocked} onClick={() => onTeach("improve", item)}>{item}</button>)}<button type="button" disabled={blocked} onClick={() => onTeach("improve")}>{ui("整体改进")}</button></div></details>
      {record.previousContent && <button type="button" className="wf-undo" disabled={disabled || running} onClick={onUndo}>{ui("撤销上次改写")}</button>}
    </div>}
    {teaching?.status === "done" && teaching.tokenUsage && <details className="wf-teaching-usage"><summary>{ui("本次讲解的用量")}</summary><TokenUsage usage={teaching.tokenUsage} /></details>}
    {others.length > 0 && <section className="wf-teaching-help" aria-label={ui("补充讲解")}><h4>{ui("再换一种方式理解")}</h4>{others.map((item, index) => <details key={item.id} open={index === others.length - 1}><summary>{item.title || HELP.find((entry) => entry.mode === item.kind)?.label || ui("补充讲解")}</summary><TeachingArticle content={item.content} /><TeachingCitations citations={item.citations} sources={resources.sources} /></details>)}</section>}
    <details className="wf-teaching-custom"><summary>{ui("补充我的具体疑问")}</summary><form onSubmit={(event) => { event.preventDefault(); if (request.trim()) onTeach(content ? "steps" : "lesson", request.trim()); }}><label>{ui("想弄懂哪一点？")}<textarea rows={2} maxLength={1000} value={request} disabled={blocked} onChange={(event) => setRequest(event.target.value)} placeholder={ui("例如：用一个日常例子解释这两个概念的区别。")} /></label><button type="submit" disabled={blocked || !request.trim()}>{ui("按我的问题讲解")}</button></form></details>
  </section>;
}
