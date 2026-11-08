import { ui, uiFormat } from "./i18n.js";
import { formatDateTime, formatNumber } from "./format.js";
import { usePolling } from "./use-polling.js";
import { uiRich } from "./i18n-rich.jsx";
import React, { useCallback, useContext, useEffect, useRef, useState } from "react";
import Markdown from "./Markdown.jsx";
import SkeletonSpine from "./SkeletonSpine.jsx";
import { Banner, Button, ErrorState, LoadingState, PageHeader, ProgressBar } from "./components/index.js";
import WorkflowLesson, { TeachingArticle } from "./WorkflowLesson.jsx";
import { Readings, ScopeBar } from "./WorkflowScope.jsx";
import ModelErrorNote, { ModelSettingsContext } from "./ModelErrorNote.jsx";
import { useInjectCss } from "./shared.js";
import css from "./workflows.css";
import skeletonCss from "./skeleton.css";
import { useStudy } from "./study-context.jsx";

const OUTCOME = { done: "已完成活动", needs_work: "还需巩固", skipped: "已跳过" };
const stamp = (at) => formatDateTime(at, "stamp");
const preview = (text) => {
  const s = String(text || "").replace(/[#>*_`-]+/g, " ").replace(/\s+/g, " ").trim();
  return s.length > 90 ? `${s.slice(0, 89)}…` : s;
};

/* Earlier versions of a step's material, preserved read-only. */
function MaterialHistory({ record }) {
  const history = record?.materialHistory || [];
  if (!history.length) return null;
  return (
    <details className="wf-material-history">
      <summary>{uiFormat("之前的版本 · {0}", [history.length])}</summary>
      <ol>
        {history.map((item, index) => ({ item, index })).reverse().map(({ item, index }) => (
          <li key={`${index}:${item.at}`}>
            <div className="wf-material-history-head"><span>{item.by === "ai" ? ui("AI 讲解") : ui("主会话")} · {stamp(item.at)}</span></div>
            <details><summary>{preview(item.content)}</summary><TeachingArticle content={item.content} /></details>
          </li>
        ))}
      </ol>
    </details>
  );
}

/* Read-only summary of a historical practice step. */
function PracticeStepArchive({ resources, onOpen }) {
  const p = resources.practice;
  if (!p) return <div className="wf-practice-intro"><p className="muted">{ui("该步骤当时未关联已保存的练习记录。")}</p></div>;
  return (
    <div className="wf-practice-intro">
      <ProgressBar className="wf-practice-progress" value={p.answered} max={p.total} label={ui("本步练习进度")} size="sm" />
      {p.complete
        ? <p>{uiRich("本步练完了：答对 {0} / {1} 道。", <strong>{p.correct}</strong>, p.total)}</p>
        : <p>{uiRich("已做 {0} / {1} 道，答对 {2} 道。", <strong>{p.answered}</strong>, p.total, p.correct)}</p>}
      {p.runId && onOpen && (
        <div className="wf-actions">
          <Button className="wf-action-btn" onClick={() => onOpen(p.runId)}>{ui("查看本轮结果")}</Button>
        </div>
      )}
    </div>
  );
}

function SavedTeaching({ session }) {
  const steps = session.template.steps.filter((step) => session.records[step.id]?.content || step.content || session.records[step.id]?.help?.length);
  if (!steps.length) return null;
  return (
    <section className="wf-saved-teaching">
      <h2>{ui("回看这次的讲解")}</h2>
      {steps.map((step) => {
        const record = session.records[step.id] || {};
        return (
          <details key={step.id}>
            <summary>{step.title}</summary>
            {(record.content || step.content) && <TeachingArticle content={record.content || step.content} />}
            {record.help?.map((help) => <section key={help.id}><h3>{help.title}</h3><TeachingArticle content={help.content} /></section>)}
          </details>
        );
      })}
    </section>
  );
}

const History = React.memo(function History({ session }) {
  const title = (stepId) => session.template.steps.find((step) => step.id === stepId)?.title || ui("学习步骤");
  return (
    <details className="wf-history" open>
      <summary>{uiFormat("学习足迹 · {0} 次活动", [session.history.length])}</summary>
      {!session.history.length ? <p className="muted">{ui("这次学习没有记录步骤完成事件。")}</p> : (
        <ol>
          {session.history.map((event, index) => event.kind === "rescope" ? (
            <li key={event.requestId || index} className="wf-rescope-event">
              <div><strong>{ui("这次学习换了课程")}</strong><time>{stamp(event.at)}</time></div>
              <p>{event.output}</p>
            </li>
          ) : (
            <li key={event.requestId || index}>
              <div><strong>{title(event.stepId)}</strong><span className="wf-outcome" data-outcome={event.outcome}>{ui(OUTCOME[event.outcome])}</span><time>{stamp(event.at)}</time></div>
              {event.output && <Markdown text={event.output} />}
            </li>
          ))}
        </ol>
      )}
    </details>
  );
});

/* Read-only skeleton peek when a historical session linked a knowledge skeleton. */
export function SpinePeek({ resources, stepKind }) {
  if (!resources?.skeleton) return null;
  return (
    <SkeletonSpine className="wf-spine-peek" skeleton={resources.skeleton} stepKind={stepKind || "lesson"} heading={uiFormat("本次脉络 · {0}", [resources.skeleton.title])}>
      {resources.skeleton.overview && <Markdown text={resources.skeleton.overview} />}
    </SkeletonSpine>
  );
}

/** Read-only viewer for a historical learning-flow session (#779). */
export default function WorkflowPortal({ onOpenSettings, ...props }) {
  const fromApp = useContext(ModelSettingsContext);
  return <ModelSettingsContext.Provider value={onOpenSettings || fromApp || null}><PortalBody {...props} /></ModelSettingsContext.Provider>;
}

function PortalBody({ id, onOpenRun, onBack, revision, initialResult = null }) {
  useInjectCss(css, "study-workflows");
  useInjectCss(skeletonCss, "study-skeleton");
  const { call } = useStudy();
  const [session, setSession] = useState(() => initialResult?.session || null);
  const [resources, setResources] = useState(() => initialResult?.resources || { readings: [], sources: [], cardCount: 0 });
  const [selectedStepId, setSelectedStepId] = useState(() => initialResult?.session?.currentStepId || initialResult?.session?.template?.steps?.[0]?.id || null);
  const [error, setError] = useState("");
  const headingRef = useRef(null), live = useRef(true), pollToken = useRef(0), reading = useRef(null);
  const invalidateReads = useCallback(() => { ++pollToken.current; reading.current = null; }, []);

  const refresh = useCallback(async ({ automatic = false } = {}) => {
    if (automatic && reading.current !== null) return;
    const token = ++pollToken.current;
    reading.current = token;
    try {
      const result = await call("workflow.session.get", { id });
      if (!live.current || token !== pollToken.current) return;
      setSession(result.session);
      if (result.resources) setResources(result.resources);
      setSelectedStepId((prev) => (prev && result.session.template.steps.some((s) => s.id === prev) ? prev : result.session.currentStepId || result.session.template.steps[0]?.id || null));
      setError("");
    } catch (err) {
      if (live.current && token === pollToken.current) setError(err.message);
    } finally {
      if (reading.current === token) reading.current = null;
    }
  }, [call, id]);

  useEffect(() => { live.current = true; return () => { live.current = false; invalidateReads(); }; }, [invalidateReads]);
  useEffect(() => {
    void refresh();
    return invalidateReads;
  }, [refresh, revision, invalidateReads]);
  usePolling(() => refresh({ automatic: true }), { intervalMs: 15000, enabled: false });

  if (!session) {
    return (
      <section className="page workflow-page">
        <div className="wf-topline"><Button variant="link" size="sm" onClick={onBack}>{ui("← 返回历史记录")}</Button></div>
        <PageHeader title={ui("历史学习记录")} />
        {error ? <ErrorState error={error} onRetry={refresh} retryLabel={ui("重新读取")} /> : <LoadingState label={ui("正在读取历史学习记录…")} />}
      </section>
    );
  }

  const step = session.template.steps.find((item) => item.id === selectedStepId) || session.template.steps.find((item) => item.id === session.currentStepId) || session.template.steps[0];
  const index = session.template.steps.indexOf(step);
  const record = (step && session.records[step.id]) || {};
  const content = record.content || step?.content || "";
  const savedText = (record.output || "").trim();
  const lastFeedback = step?.kind === "recall" ? record.feedback || null : null;

  return (
    <section className="page workflow-page wf-portal">
      <div className="wf-topline">
        <Button variant="link" size="sm" onClick={onBack}>{ui("← 返回历史记录")}</Button>
        <span className="muted small">{ui("只读存档")}</span>
      </div>
      <PageHeader className="wf-heading" ref={headingRef} eyebrow={session.template.title} title={session.topic}
        description={uiFormat("历史学习记录（只读）· 第 {0} / {1} 步 · {2}", [index + 1, session.template.steps.length, step?.title || ""])}>
        <ScopeBar session={session} resources={resources} disabled />
      </PageHeader>
      <Banner tone="info" role="status" className="wf-banner" title={ui("学习流已退役，当前记录为只读视图")}>
        <p>{ui("不能新建、编辑或继续推进步骤；新的学习安排请使用每门课的「学法」与主会话「AI 带学」。点击下方任意步骤可查看当时保存的讲解、复述与活动足迹。")}</p>
      </Banner>
      {error && <div className="wf-failure"><ModelErrorNote className="wf-failure__inline" error={error} /></div>}
      <ol className="wf-portal-route" aria-label={ui("学习步骤")}>
        {session.template.steps.map((item, stepIndex) => {
          const outcome = session.records[item.id]?.outcome;
          const isCurrent = item.id === step?.id;
          const body = <><span>{formatNumber(stepIndex + 1, { minimumIntegerDigits: 2 })}</span><strong>{item.title}</strong>{outcome && <small>{ui(OUTCOME[outcome])}</small>}</>;
          return (
            <li key={item.id} aria-current={isCurrent ? "step" : undefined} className={["wf-portal-step", isCurrent ? "is-current" : "is-reachable"].filter(Boolean).join(" ")}>
              {isCurrent ? body : <button type="button" className="wf-route-link" onClick={() => setSelectedStepId(item.id)}>{body}</button>}
            </li>
          );
        })}
      </ol>
      {!session.template.steps.some((item) => item.kind === "skeleton") && <SpinePeek session={session} resources={resources} stepKind={step?.kind} />}
      {step && (
        <article className="wf-activity">
          <div className="wf-section-head"><h2>{step.title}</h2></div>
          {step.instructions && <Markdown text={step.instructions} className="wf-instructions" />}
          {step.kind === "skeleton" && (resources.skeleton
            ? <div className="wf-skeleton"><h3>{resources.skeleton.title}</h3>{resources.skeleton.overview && <Markdown text={resources.skeleton.overview} />}<SkeletonSpine skeleton={resources.skeleton} stepKind="skeleton" /></div>
            : <p className="muted">{ui("该步骤当时未关联知识骨架。")}</p>)}
          {step.kind === "lesson" && <WorkflowLesson key={step.id} topic={session.topic} content={content} record={record} resources={resources} disabled readOnly sessionId={id} stepId={step.id} />}
          {step.kind !== "lesson" && content && (
            <section className="wf-material" aria-label={ui("本步材料")}>
              <p className="wf-material-head"><span className="wf-eyebrow">{!record.content ? ui("本步材料") : record.materialBy === "ai" ? ui("AI 补充的材料") : ui("主会话补充的材料")}</span>{record.materialAt && <time>{stamp(record.materialAt)}</time>}</p>
              <div className="wf-lesson"><TeachingArticle content={content} /></div>
            </section>
          )}
          <MaterialHistory record={record} />
          {["lesson", "skeleton", "recall"].includes(step.kind) && <Readings resources={resources} />}
          {step.kind === "practice" && <PracticeStepArchive resources={resources} onOpen={onOpenRun} />}
          <section className="wf-notes" aria-label={ui("已保存的回答与笔记")}>
            <h3>{ui("已保存的回答与笔记")}</h3>
            {savedText ? <Markdown text={savedText} /> : <p className="muted">{ui("这一步没有保存回答或笔记。")}</p>}
          </section>
          {lastFeedback && (
            <section className="wf-retell" aria-label={ui("AI 对复述的反馈")}>
              <p className="wf-eyebrow">{ui("AI 看了你的复述")}</p>
              {lastFeedback.note && <p className="wf-retell-note">{lastFeedback.note}</p>}
              <div className="wf-retell-cols">
                {lastFeedback.covered.length > 0 && <div><h4>{ui("讲到了")}</h4><ul>{lastFeedback.covered.map((item) => <li key={item}>{item}</li>)}</ul></div>}
                {lastFeedback.missing.length > 0 && <div className="is-missing"><h4>{ui("还缺")}</h4><ul>{lastFeedback.missing.map((item) => <li key={item}>{item}</li>)}</ul></div>}
              </div>
              {lastFeedback.question && <p className="wf-retell-question">{uiFormat("想一想：{0}", [lastFeedback.question])}</p>}
            </section>
          )}
        </article>
      )}
      <SavedTeaching session={session} />
      <History session={session} />
    </section>
  );
}
