import { ui, uiFormat, uiLocale, getUiLanguage } from "./i18n.js";
import { clearStepDraft as clearDraft, keepStepDraft as keepDraft, readStepDraft as readDraft, savedOutput } from "./workflow-draft.js";
import { formatDateTime, formatNumber } from "./format.js";
import { usePolling } from "./use-polling.js";
import { uiRich } from "./i18n-rich.jsx";
import React, { useCallback, useEffect, useRef, useState } from "react";
import Markdown from "./Markdown.jsx";
import SkeletonSpine from "./SkeletonSpine.jsx";
import { Banner, Button, Disclosure, InlineMessage, PageHeader, ProgressBar, useToast } from "./components/index.js";
import { WORKFLOW_HANDOFF as HANDOFF, workflowStepPrompt } from "./agent-prompts/workflow.js";
import WorkflowLesson, { TeachingArticle } from "./WorkflowLesson.jsx";
import { Readings, ScopeBar } from "./WorkflowScope.jsx";
import ModelErrorNote, { ModelSettingsContext } from "./ModelErrorNote.jsx";
import { useInjectCss } from "./shared.js";
import css from "./workflows.css";
import skeletonCss from "./skeleton.css";

const OUTCOME = { done: "已完成活动", needs_work: "还需巩固", skipped: "已跳过" };
const ORAL_REPORTS = { zh: "我已口头复述（自我记录，未经过判分或掌握验证）。", en: 'I retold it aloud (self-recorded; not graded or verified for mastery).' };
const MOD_KEY = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform || "") ? "⌘" : "Ctrl";
const prefersReducedMotion = () => typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
const coarsePointer = () => typeof matchMedia === "function" && matchMedia("(pointer: coarse)").matches;

const stamp = (at) => formatDateTime(at, "stamp");
const preview = (text) => { const s = String(text || "").replace(/[#>*_`-]+/g, " ").replace(/\s+/g, " ").trim(); return s.length > 90 ? s.slice(0, 89) + "…" : s; };

/* Every earlier version of a step's material, so a save never loses anything. */
function MaterialHistory({ record, disabled, onRestore }) {
  const history = record.materialHistory || [];
  if (!history.length) return null;
  return <details className="wf-material-history"><summary>{uiFormat("之前的版本 · {0}", [history.length])}</summary><ol>
    {history.map((item, index) => ({ item, index })).reverse().map(({ item, index }) => <li key={`${index}:${item.at}`}>
      <div className="wf-material-history-head"><span>{item.by === "ai" ? ui("AI 讲解") : ui("主对话")} · {stamp(item.at)}</span><Button variant="link" size="sm" disabled={disabled} onClick={() => onRestore(index)}>{ui("恢复这一版")}</Button></div>
      <details><summary>{preview(item.content)}</summary><TeachingArticle content={item.content} /></details>
    </li>)}
  </ol><p className="muted small">{ui("恢复后，当前版本也会留在这里。")}</p></details>;
}

/* A practice step: the round itself happens in the full review page. */
function PracticeStep({ step, resources, pending, disabled, onStart, onOpen }) {
  const p = resources.practice;
  const count = Math.min(step.count || resources.cardCount, resources.cardCount);
  if (!p && !resources.cardCount) return <div className="wf-practice-intro"><p>{ui("本次范围还没有可练习的题目，可以请主对话补充内容，或跳过本步。")}</p></div>;
  if (!p) return <div className="wf-practice-intro">
    <p>{uiRich("从本次范围里练 {0} 道题。打开的是完整的刷题页：提示、讲解、AI 追问和教学都能用，练完点「回到学习流」回到这里。", <strong>{count}</strong>)}</p>
    <p className="muted small">{ui("作答照常判分，并进入闪卡复习安排。")}</p>
    <Button variant="primary" disabled={disabled} onClick={() => onStart(false)}>{pending ? ui("准备练习…") : uiFormat("开始练习 {0} 道 →", [count])}</Button>
  </div>;
  const done = p.complete || p.ended;
  return <div className="wf-practice-intro">
    <ProgressBar className="wf-practice-progress" value={p.answered} max={p.total} label={ui("本步练习进度")} size="sm" />
    {p.complete ? <p>{uiRich("本步练完了：答对 {0} / {1} 道。", <strong>{p.correct}</strong>, p.total)}</p>
      : p.ended ? <p>{uiFormat("这一轮提前结束了，做了 {0} / {1} 道。可以再练一轮，或在下方如实选择跳过。", [p.answered, p.total])}</p>
      : <p>{p.answered ? uiRich("已做 {0} / {1} 道，答对 {2} 道。", <strong>{p.answered}</strong>, p.total, p.correct) : uiRich("已做 {0} / {1} 道。", <strong>{p.answered}</strong>, p.total)}</p>}
    <div className="wf-actions">
      {!done && <Button variant="primary" disabled={disabled} onClick={() => onOpen(p.runId)}>{pending ? ui("打开中…") : p.answered ? ui("继续练习 →") : ui("开始练习 →")}</Button>}
      {done && <Button disabled={disabled} onClick={() => onOpen(p.runId)}>{ui("查看本轮结果")}</Button>}
      {done && <Button variant="link" size="sm" disabled={disabled} onClick={() => onStart(true)}>{ui("再练一轮")}</Button>}
    </div>
  </div>;
}

/* The skeleton step without a skeleton: make one for this session's scope in the background. */
function SkeletonMaker({ session, resources, disabled, onGenerate }) {
  const job = session.skeletonJob;
  const running = job?.status === "running" && resources.skeletonActive;
  const failed = job?.status === "failed" || (job?.status === "running" && !resources.skeletonActive);
  return <div className="wf-skeleton-maker">
    <h3>{ui("本次还没有知识骨架")}</h3>
    <p className="muted">{ui("骨架把本次范围里的概念串成一条主线：先学什么、谁属于谁、哪些容易混。")}</p>
    {running ? <p className="wf-spine-status" role="status"><span className="wf-pulse" aria-hidden="true" />{uiFormat("AI 正在整理本次范围的骨架（{0} 题），好了会直接显示在这里；也可以先往下学。", [job.cards])}</p>
      : resources.modelReady ? <>{failed && (job.message ? <ModelErrorNote error={job.message} /> : <InlineMessage tone="error">{ui("上次没有生成成功。")}</InlineMessage>)}
        <Button variant="primary" disabled={disabled || !resources.cardCount} onClick={onGenerate}>{failed ? ui("重新生成本次范围的骨架") : ui("一键生成本次范围的骨架")}</Button>
        {!resources.cardCount && <p className="muted small">{ui("本次范围没有题目，无法整理骨架。")}</p>}</>
      : <p className="wf-model-hint">{ui("连接模型后可以一键生成；也可以请主对话帮你设计骨架。")}</p>}
  </div>;
}

const GOALS = ["先建立整体框架", "弄懂关键机制", "通过例子学会应用", "查漏补缺"];
const REFLECTIONS = ["已理清主线", "还需要例子", "需要补前置", "下次先练习"];

function LearnerChoices({ kind, output, disabled, onChange }) {
  const choices = kind === "overview" ? GOALS : REFLECTIONS;
  const prefix = kind === "overview" ? ui("本次目标：") : ui("我的回顾：");
  const lines = output.split("\n");
  return <section className="wf-learner-choices"><h3>{kind === "overview" ? ui("这次，你最想解决什么？") : ui("回顾一下，下一步需要什么？")}</h3><p className="muted">{kind === "overview" ? ui("选择这次的学习重点，也可以在笔记里写自己的目标。") : ui("按自己的实际感受选择，可多选；也可以补充一句收获。")}</p><div className="wf-quick-choices" role="group" aria-label={kind === "overview" ? ui("学习目标") : ui("学习回顾")}>{choices.map((choice) => {
    const value = `${prefix}${ui(choice)}${uiLocale() === "en-US" ? "." : "。"}`, selected = lines.includes(value);
    return <Button key={choice} aria-pressed={selected} disabled={disabled} onClick={() => onChange(selected ? lines.filter((line) => line !== value).join("\n").trim() : [...lines.filter(Boolean), value].join("\n"))}>{ui(choice)}</Button>;
  })}</div><small className="muted">{kind === "overview" ? ui("选择会记入你的目标，由你决定何时继续。") : ui("选择会记入你的回顾，由你决定何时继续。")}</small></section>;
}

function SavedTeaching({ session }) {
  const steps = session.template.steps.filter((step) => session.records[step.id]?.content || step.content || session.records[step.id]?.help?.length);
  if (!steps.length) return null;
  return <section className="wf-saved-teaching"><h2>{ui("回看这次的讲解")}</h2>{steps.map((step) => {
    const record = session.records[step.id] || {};
    return <details key={step.id}><summary>{step.title}</summary>{(record.content || step.content) && <TeachingArticle content={record.content || step.content} />}{record.help?.map((help) => <section key={help.id}><h3>{help.title}</h3><TeachingArticle content={help.content} /></section>)}</details>;
  })}</section>;
}

const History = React.memo(function History({ session }) {
  const title = (id) => session.template.steps.find((step) => step.id === id)?.title || ui("学习步骤");
  return <details className="wf-history" open={session.status === "completed"}><summary>{uiFormat("学习足迹 · {0} 次活动", [session.history.length])}</summary>
    {!session.history.length ? <p className="muted">{ui("完成、回补或跳过一个步骤后，记录会出现在这里。")}</p> : <ol>{session.history.map((event, index) => event.kind === "rescope" ? <li key={event.requestId || index} className="wf-rescope-event">
      <div><strong>{ui("这次学习换了课程")}</strong><time>{stamp(event.at)}</time></div>
      <p>{event.output}</p>
    </li> : <li key={event.requestId || index}>
      <div><strong>{title(event.stepId)}</strong><span className={`wf-outcome ${event.outcome}`}>{ui(OUTCOME[event.outcome])}</span><time>{stamp(event.at)}</time></div>
      {event.output && <Markdown text={event.output} />}
    </li>)}</ol>}
  </details>;
});

/* The skeleton for a guided session that started without one: it can be
   drafted in the background and appears here, folded, once it is ready. */
export function SpinePeek({ session, resources, stepKind, late, disabled, onGenerate }) {
  const job = session.skeletonJob;
  if (resources.skeleton) return <SkeletonSpine className="wf-spine-peek" skeleton={resources.skeleton} stepKind={stepKind || "lesson"} heading={uiFormat("本次脉络 · {0}", [resources.skeleton.title])}>
    {resources.skeleton.overview && <Markdown text={resources.skeleton.overview} />}</SkeletonSpine>;
  if (session.status === "completed" || !resources.cardCount) return null;
  if (job?.status === "running" && resources.skeletonActive)
    return <p className="wf-spine-status" role="status"><span className="wf-pulse" aria-hidden="true" />{uiFormat("AI 正在后台整理本次的知识骨架（{0} 题），好了会出现在这里，学习不用等它。", [job.cards])}</p>;
  // At the last step a new skeleton would only serve a later session.
  if (!resources.modelReady || late) return null;
  const interrupted = job?.status === "running" || job?.status === "failed";
  return <div className="wf-spine-status muted">{interrupted ? <><span>{ui("上次后台整理骨架没有完成。")}</span>{job.message && <ModelErrorNote error={job.message} />}</> : <span>{ui("本次范围还没有知识骨架。")}</span>}
    <Button variant="link" size="sm" disabled={disabled} onClick={onGenerate}>{interrupted ? ui("重新在后台生成") : ui("在后台生成一份")}</Button></div>;
}

/** The guided flow. onOpenSettings (optional) is what a model-failure note inside it offers as 打开模型设置. */
export default function WorkflowPortal({ onOpenSettings, ...props }) {
  return <ModelSettingsContext.Provider value={onOpenSettings || null}><PortalBody {...props} /></ModelSettingsContext.Provider>;
}

function PortalBody({ id, libraryKey, call, askInChat, onOpenRun, onOpenSession, onBack, revision }) {
  useInjectCss(css, "study-workflows");
  useInjectCss(skeletonCss, "study-skeleton");
  const [session, setSession] = useState(null), [resources, setResources] = useState({ readings: [], sources: [], cardCount: 0 });
  const [output, setOutput] = useState(""), [remote, setRemote] = useState(null);
  const toast = useToast();
  const [pending, setPending] = useState(""), [error, setError] = useState("");
  const [showRecallMaterial, setShowRecallMaterial] = useState(false), [wish, setWish] = useState("");
  const current = useRef(null), outputRef = useRef(""), lock = useRef(false), live = useRef(true), pollToken = useRef(0);
  const transition = useRef(null), reading = useRef(null);
  const arrive = useRef(false), wantFocus = useRef(false), headingRef = useRef(null), outputField = useRef(null);
  const invalidateReads = useCallback(() => { ++pollToken.current; reading.current = null; }, []);

  const adopt = useCallback((next, options = {}) => {
    const changedStep = current.current?.currentStepId !== next.currentStepId;
    if (changedStep && current.current) arrive.current = true;
    const cached = options.restore ? readDraft(next, libraryKey) : null;
    const value = options.keepOutput && !changedStep ? outputRef.current : cached && typeof cached.output === "string" ? cached.output : savedOutput(next);
    current.current = next; outputRef.current = value;
    setSession(next); setOutput(value);
    if (options.resources) setResources(options.resources);
    if (changedStep) { setShowRecallMaterial(false); setWish(""); }
    if (cached && cached.base !== savedOutput(next) && cached.output !== savedOutput(next)) setRemote({ session: next, resources: options.resources });
    else setRemote(null);
  }, [libraryKey]);

  const refresh = useCallback(async ({ automatic = false } = {}) => {
    if (lock.current || (automatic && reading.current !== null)) return;
    const token = ++pollToken.current;
    reading.current = token;
    try {
      const result = await call("workflow.session.get", { id });
      if (!live.current || token !== pollToken.current || lock.current) return;
      const before = current.current;
      if (!before) { adopt(result.session, { resources: result.resources, restore: true }); return; }
      if (result.session.version < before.version) return;
      const dirty = outputRef.current !== savedOutput(before);
      if (result.session.version === before.version) {
        setResources((previous) => JSON.stringify(previous) === JSON.stringify(result.resources) ? previous : result.resources);
        return;
      }
      if (dirty && (result.session.currentStepId !== before.currentStepId || result.session.status !== before.status || savedOutput(result.session) !== savedOutput(before))) {
        setRemote(result);
        return;
      }
      adopt(result.session, { resources: result.resources, keepOutput: dirty, restore: !dirty });
    } catch (err) { if (live.current && token === pollToken.current) setError(err.message); }
    finally { if (reading.current === token) reading.current = null; }
  }, [adopt, call, id]);
  useEffect(() => { live.current = true; return () => { live.current = false; invalidateReads(); }; }, [invalidateReads]);
  useEffect(() => {
    void refresh();
    return invalidateReads;
  }, [refresh, revision, invalidateReads]);
  usePolling(() => refresh({ automatic: true }), { intervalMs: 8000 });
  const changeOutput = (value) => {
    outputRef.current = value; setOutput(value);
    keepDraft(current.current, value, libraryKey);
    transition.current = null;
  };
  async function persist() {
    const before = current.current;
    if (outputRef.current === savedOutput(before)) return before;
    const next = await call("workflow.session.record", { id, version: before.version, output: outputRef.current });
    clearDraft(before, libraryKey);
    if (live.current) adopt(next);
    return next;
  }
  async function act(name, action) {
    if (lock.current || remote) return;
    lock.current = true; ++pollToken.current; setPending(name); setError("");
    try { await action(current.current); }
    catch (err) { if (live.current) setError(err.message); }
    finally { lock.current = false; if (live.current) setPending(""); }
  }
  const save = () => act("save", async () => { await persist(); toast.success(ui("回答和笔记已保存到学习库。")); });
  const leave = () => act("leave", async (before) => { if (before.status === "active") await persist(); onBack(); });
  const changeStatus = (status) => act("status", async (before) => {
    const saved = before.status === "active" ? await persist() : before;
    const next = await call("workflow.session.status", { id, version: saved.version, status });
    adopt(next, { keepOutput: true });
    toast.success(status === "paused" ? ui("已保存并暂停，可以随时回来继续。") : ui("已继续这次学习。"));
  });
  const advance = (outcome) => act(outcome, async (before) => {
    // Preserve the operation ID across a network retry, so a committed move is
    // never applied twice when only its response was lost.
    const intent = JSON.stringify([before.currentStepId, before.version, outcome, outputRef.current]);
    if (transition.current?.intent !== intent) transition.current = { intent, requestId: crypto.randomUUID() };
    const next = await call("workflow.session.advance", { id, version: before.version, outcome, output: outputRef.current, requestId: transition.current.requestId });
    clearDraft(before, libraryKey); transition.current = null;
    adopt(next, { restore: next.currentStepId !== before.currentStepId });
    toast.success(outcome === "needs_work" ? ui("已记录需要巩固，按这条流程的回补安排继续。") : outcome === "skipped" ? ui("已如实记录跳过。") : ui("本步活动已记录。"));
  });
  // Practice runs in the ordinary review page, with every aid it has; this step
  // starts or resumes the round there and shows its progress when we come back.
  const startPractice = (fresh = false) => act("practice", async () => {
    const saved = await persist();
    const result = await call("workflow.practice.start", { id, version: saved.version, ...(fresh ? { fresh: true } : {}) });
    adopt(result.session);
    onOpenRun?.(result.run.id);
  });
  // The route is two-way: go back to any step already walked, then return to
  // where you had got to. Nothing is recorded or changed by moving around.
  const goTo = (stepId) => act("goto", async () => {
    const saved = await persist();
    const next = await call("workflow.session.goto", { id, version: saved.version, stepId });
    adopt(next, { restore: true });
    const title = next.template.steps.find((item) => item.id === stepId)?.title || ui("这一步");
    const resume = next.template.steps.find((item) => item.id === next.resumeStepId)?.title;
    toast.success(resume ? uiFormat("已回到「{0}」，之前的记录都在。看完点上方的「{1}」回到进度。", [title, resume]) : uiFormat("已回到「{0}」。", [title]));
  });
  // A session from the course route hands on to the route's next batch.
  const continueCourse = (flow) => act("course", async () => {
    if (flow) {
      const next = await call("workflow.quickstart", { course: current.current.course.name, requestId: crypto.randomUUID() });
      onOpenSession?.(next.session.id);
    } else {
      const run = await call("review.start", { mode: "course", course: current.current.course.name, fresh: true });
      onOpenRun?.(run.id);
    }
  });
  // Same goal, another course: the pick is redone there and everything written is kept.
  const rescope = (course) => act("rescope", async () => {
    const saved = await persist();
    const result = await call("workflow.rescope", { id, version: saved.version, course, requestId: crypto.randomUUID() });
    if (!live.current) return;
    adopt(result.session, { resources: result.resources, keepOutput: true });
    toast.success(uiFormat("已换到「{0}」课程，重新选了学习范围；之前写的笔记都保留着。", [course || ui("未分类课程")]));
  });
  // Practice answers are on record: this session stays as it is and a new one starts in the other course.
  const startInCourse = (course) => act("rescope", async (before) => {
    await persist();
    const next = await call("workflow.quickstart", { goal: before.goal, inCourse: course, requestId: crypto.randomUUID() });
    onOpenSession?.(next.session.id);
  });
  const openPractice = (runId) => act("practice", async () => { await persist(); onOpenRun?.(runId); });
  async function prepareTeaching() {
    const saved = await persist();
    const latest = await call("workflow.session.get", { id });
    if (!live.current) return null;
    adopt(latest.session, { resources: latest.resources });
    if (latest.session.currentStepId !== saved.currentStepId || latest.session.status !== "active") throw new Error(ui("学习进度已更新，请在当前步骤重新选择讲解方式。"));
    return latest.session;
  }
  const teach = (mode, request = "") => act("teaching", async () => {
    const latest = await prepareTeaching();
    if (!latest) return;
    const result = await call("workflow.teaching.start", { id, version: latest.version, stepId: latest.currentStepId, mode, ...(request ? { request } : {}) });
    if (live.current) { adopt(result.session, { resources: result.resources, keepOutput: true }); }
  });
  const undoTeaching = () => act("teaching", async () => {
    const latest = await prepareTeaching();
    if (!latest) return;
    const result = await call("workflow.teaching.undo", { id, version: latest.version, stepId: latest.currentStepId });
    if (live.current) { adopt(result.session, { resources: result.resources, keepOutput: true }); toast.success(ui("已恢复上一次讲解。")); }
  });
  const ask = () => act("chat", async () => {
    const saved = await persist(), step = saved.template.steps.find((item) => item.id === saved.currentStepId);
    await askInChat(workflowStepPrompt({ session: saved, step, wish: wish.trim() }));
    toast.info(ui("请求已准备好，请在主对话确认发送。补充材料保存后会在这里显示。"));
  });
  const restoreMaterial = (index) => act("restore", async () => {
    const saved = await persist();
    const next = await call("workflow.session.material.restore", { id, version: saved.version, stepId: saved.currentStepId, index });
    if (live.current) { adopt(next, { keepOutput: true }); toast.success(ui("已恢复这一版材料；换下来的版本也留在「之前的版本」里。")); }
  });
  const reconcile = (keepLocal) => {
    if (!remote) return;
    const before = current.current, local = outputRef.current;
    if (keepLocal && before.currentStepId === remote.session.currentStepId) {
      adopt(remote.session, { resources: remote.resources, keepOutput: true });
      keepDraft(remote.session, local, libraryKey);
    } else {
      if (!keepLocal) clearDraft(before, libraryKey);
      adopt(remote.session, { resources: remote.resources, restore: false });
    }
    setError(""); toast.success(keepLocal ? ui("已载入最新内容，本地草稿已保留。") : ui("已使用学习库中的最新记录。"));
  };

  const generateSkeleton = () => act("skeleton", async () => {
    await call("workflow.skeleton.generate", { id });
    const latest = await call("workflow.session.get", { id });
    if (live.current) adopt(latest.session, { resources: latest.resources, keepOutput: true });
  });
  // While a background skeleton is being drafted, check back sooner than the idle poll.
  const drafting = session?.skeletonJob?.status === "running" && resources.skeletonActive;
  usePolling(() => refresh({ automatic: true }), { intervalMs: 3000, enabled: !!drafting });
  const askFeedback = () => act("feedback", async () => {
    const saved = await persist();
    const result = await call("workflow.feedback", { id, version: saved.version, stepId: saved.currentStepId });
    if (live.current) adopt(result.session, { resources: result.resources, keepOutput: true });
  });
  // AI in the loop: arriving at a lesson prepares it, arriving at practice
  // starts it, and "revisit" after a retelling re-explains exactly the gaps.
  // Each happens once per visit to a step, so a failure never loops.
  // A new step starts at its top; arriving at a retelling puts the cursor in it.
  useEffect(() => {
    if (!arrive.current) return;
    arrive.current = false;
    headingRef.current?.scrollIntoView({ block: "start", behavior: prefersReducedMotion() ? "auto" : "smooth" });
    const here = current.current?.template.steps.find((item) => item.id === current.current.currentStepId);
    wantFocus.current = here?.kind === "recall" && !coarsePointer();
  }, [session?.currentStepId]);
  useEffect(() => {
    // The field is disabled until the move that brought us here settles.
    if (!wantFocus.current || pending || !outputField.current || outputField.current.disabled) return;
    wantFocus.current = false;
    outputField.current.focus({ preventScroll: true });
  });
  const autoRan = useRef(new Set()), remedy = useRef(null);
  useEffect(() => {
    if (!session || session.status !== "active" || pending || remote) return;
    const here = session.template.steps.find((item) => item.id === session.currentStepId);
    if (!here) return;
    const rec = session.records[here.id] || {};
    if (here.kind !== "lesson") remedy.current = null;
    const key = `${session.id}:${here.id}:${session.history.length}`;
    if (autoRan.current.has(key)) return;
    if (here.kind === "lesson" && resources.modelReady && rec.teaching?.status !== "running") {
      const hasContent = !!(rec.content || here.content);
      if (remedy.current && hasContent) {
        const { mode, request } = remedy.current;
        remedy.current = null; autoRan.current.add(key); teach(mode, request);
      } else if (!hasContent && rec.teaching?.status !== "failed") { autoRan.current.add(key); teach("lesson"); }
    }
  });

  if (!session) return <section className="page workflow-page"><div className="wf-topline"><Button variant="link" size="sm" onClick={onBack}>{ui("← 学习流工作台")}</Button></div><PageHeader title={ui("学习 Portal")} />{error ? <><p className="wf-error" role="alert">{error}</p><Button onClick={refresh}>{ui("重新读取")}</Button></> : <p className="muted" role="status">{ui("正在恢复学习进度…")}</p>}</section>;
  const step = session.template.steps.find((item) => item.id === session.currentStepId);
  const index = session.template.steps.indexOf(step), record = session.records[step.id] || {};
  const dirty = output !== savedOutput(session), busy = !!pending, active = session.status === "active", completed = session.status === "completed";
  const content = record.content || step.content;
  const priorLesson = session.template.steps.slice(0, index).findLast(item => item.kind === "lesson");
  const recallContent = content || (priorLesson && (session.records[priorLesson.id]?.content ?? priorLesson.content));
  const oralReported = output.split("\n").some(line => Object.values(ORAL_REPORTS).includes(line));
  // The last reading of the retelling stays visible while the learner revises it,
  // marked as being about the earlier version, so the gaps are still in view.
  const lastFeedback = step.kind === "recall" ? record.feedback || null : null;
  const feedback = lastFeedback && lastFeedback.forOutput === output.trim() ? lastFeedback : null;
  const stale = !!lastFeedback && !feedback;
  const askable = step.kind === "recall" && resources.modelReady && !!output.trim() && !feedback;
  const revisit = () => {
    remedy.current = { mode: "remedy", request: [...(lastFeedback?.missing || []), lastFeedback?.question].filter(Boolean).join("；").slice(0, 1000)
      || ui("请针对我复述时遗漏的条件和机制重新讲清楚") };
    advance("needs_work");
  };
  const cannotComplete = !active || !!remote || busy || (["recall", "reflection"].includes(step.kind) && !output.trim()) || (step.kind === "practice" && !resources.practice?.complete);
  const branchText = (edge) => {
    if (edge === "$stay") return ui("留在本步");
    if (edge === "$finish") return ui("结束本次学习");
    if (edge === "$next") return session.template.steps[index + 1]?.title || ui("结束本次学习");
    return session.template.steps.find((item) => item.id === edge)?.title;
  };
  return <section className="page workflow-page wf-portal">
    <div className="wf-topline"><Button variant="link" size="sm" disabled={busy || !!remote} onClick={leave}>{ui("← 保存并返回工作台")}</Button><span className="muted small">{completed ? ui("本次学习已结束") : active ? ui("学习中") : ui("已暂停")}</span></div>
    <PageHeader className="wf-heading" ref={headingRef} eyebrow={session.template.title} title={session.topic}
      description={completed ? ui("保留这次学习的记录，下一次可以换一种学习方式。") : uiFormat("第 {0} / {1} 步 · {2}", [index + 1, session.template.steps.length, step.title])}
      actions={!completed && <Button disabled={busy || !!remote} onClick={() => changeStatus(active ? "paused" : "active")}>{active ? ui("保存并暂停") : ui("继续学习")}</Button>}>
      <ScopeBar session={session} resources={resources} disabled={busy || !!remote || !active} onRescope={rescope} onStartNew={startInCourse} />
    </PageHeader>
    {error && <div className="wf-failure"><ModelErrorNote error={error} /><p>{ui("你的输入仍保留在此设备。")}</p><Button size="sm" disabled={busy} onClick={refresh}>{ui("核对最新进度")}</Button></div>}
    {remote && <Banner tone="info" role="status" title={ui("这次学习在其他地方有了更新。你的文字已保留，请选择怎样继续。")}
      action={{ label: remote.session.currentStepId === session.currentStepId ? ui("载入更新，保留我的文字") : ui("进入新步骤，保留旧步草稿"), onClick: () => reconcile(true) }}
      secondary={{ label: ui("使用最新记录"), onClick: () => reconcile(false) }}>
      {savedOutput(remote.session) && <Disclosure summary={ui("查看学习库中的最新回答")}><Markdown text={savedOutput(remote.session)} /></Disclosure>}
    </Banner>}
    <ol className="wf-portal-route" aria-label={ui("学习步骤")}>{session.template.steps.map((item, stepIndex) => {
      const outcome = session.records[item.id]?.outcome, resume = item.id === session.resumeStepId;
      const body = <><span>{formatNumber(stepIndex + 1, { minimumIntegerDigits: 2 })}</span><strong>{item.title}</strong>{resume ? <small className="wf-route-resume">{ui("当前进度 · 回到这里")}</small> : outcome && <small>{ui(OUTCOME[outcome])}</small>}</>;
      const reachable = active && !remote && item.id !== step.id && (outcome || resume);
      return <li key={item.id} aria-current={!completed && item.id === step.id ? "step" : undefined} className={[item.id === step.id && !completed ? "is-current" : "", reachable ? "is-reachable" : ""].filter(Boolean).join(" ") || undefined}>
        {reachable ? <button type="button" className="wf-route-link" disabled={busy} title={resume ? ui("回到刚才的进度") : uiFormat("回到「{0}」看看，记录都会保留", [item.title])} onClick={() => goTo(item.id)}>{body}</button> : body}
      </li>;
    })}</ol>
    {!session.template.steps.some((item) => item.kind === "skeleton") && <SpinePeek session={session} resources={resources} stepKind={step.kind} late={step.kind === "reflection"} disabled={busy || !!remote} onGenerate={generateSkeleton} />}
    {!completed && <article className="wf-activity">
      <div className="wf-section-head"><h2>{step.title}</h2></div>
      {step.instructions && <Markdown text={step.instructions} className="wf-instructions" />}
      {!active && <Banner tone="info">{ui("已暂停。点「继续学习」后可接着作答，当前内容可以阅读。")}</Banner>}
      {["overview", "reflection"].includes(step.kind) && <LearnerChoices kind={step.kind} output={output} disabled={!active || busy || !!remote} onChange={changeOutput} />}
      {step.kind === "recall" && <section className="wf-recall-invitation"><h3>{ui("先合上材料，用自己的话讲一遍")}</h3><p>{ui("试着说清核心机制、一个例子，以及什么时候不适用。")}</p><div className="wf-quick-choices"><Button aria-pressed={oralReported} disabled={!active || busy || !!remote} onClick={() => changeOutput(oralReported ? output.split("\n").filter((line) => !Object.values(ORAL_REPORTS).includes(line)).join("\n").trim() : [output.trim(), ORAL_REPORTS[getUiLanguage()]].filter(Boolean).join("\n"))}>{oralReported ? ui("已记录：我已口头复述") : ui("我已口头复述")}</Button></div><small className="muted">{ui("这是你的自我记录；不会据此判分或认定掌握。也可以在下面写下复述。")}</small></section>}
      {step.kind === "skeleton" && (resources.skeleton ? <div className="wf-skeleton"><h3>{resources.skeleton.title}</h3>{resources.skeleton.overview && <Markdown text={resources.skeleton.overview} />}<SkeletonSpine skeleton={resources.skeleton} stepKind="skeleton" /></div> : <SkeletonMaker session={session} resources={resources} disabled={!active || busy || !!remote} onGenerate={generateSkeleton} />)}
      {step.kind === "lesson" && <WorkflowLesson key={step.id} topic={session.topic} content={content} record={record} resources={resources} disabled={!active || busy || !!remote} onTeach={teach} onUndo={undoTeaching} call={call} sessionId={id} stepId={step.id} />}
      {!["lesson", "recall"].includes(step.kind) && content && <section className="wf-material" aria-label={ui("本步材料")}>
        <p className="wf-material-head"><span className="wf-eyebrow">{!record.content ? ui("本步材料") : record.materialBy === "ai" ? ui("AI 补充的材料") : ui("主对话补充的材料")}</span>{record.materialAt && <time>{stamp(record.materialAt)}</time>}</p>
        <div className="wf-lesson"><TeachingArticle content={content} /></div>
      </section>}
      <MaterialHistory record={record} disabled={!active || busy || !!remote} onRestore={restoreMaterial} />
      {["lesson", "skeleton"].includes(step.kind) && <Readings resources={resources} />}
      {step.kind === "practice" && <PracticeStep step={step} resources={resources} pending={pending === "practice"} disabled={!active || busy || !!remote} onStart={startPractice} onOpen={openPractice} />}
      <details key={`notes:${step.id}`} className="wf-notes" open={step.kind === "recall" && !oralReported}><summary>{step.kind === "recall" ? ui("写下我的复述") : step.kind === "reflection" ? ui("补充我的收获与下一步") : step.kind === "overview" ? ui("写下自己的学习目标") : ui("随手记：笔记与疑问")}<span>{dirty ? ui("有未保存的记录") : output ? ui("已保存") : ui("可选")}</span></summary>
      <label className="wf-output-label">{step.kind === "recall" ? ui("我的复述") : step.kind === "reflection" ? ui("我的总结与下一步") : step.kind === "overview" ? ui("我想解决的问题") : ui("我的笔记与疑问")}
        <textarea ref={outputField} rows={step.kind === "recall" || step.kind === "reflection" ? 7 : 4} maxLength={20000} value={output} disabled={!active || busy} onChange={(e) => changeOutput(e.target.value)}
          onKeyDown={(e) => { if (e.key !== "Enter" || !(e.ctrlKey || e.metaKey)) return; e.preventDefault(); if (askable) askFeedback(); else if (dirty && !remote) save(); }} placeholder={step.kind === "recall" ? ui("不用追求标准措辞。写清核心机制、一个例子，以及什么时候不适用。") : step.kind === "reflection" ? ui("写下收获、还卡住的地方，以及下次准备做什么。") : ui("写下思路、观察到的关系，或想继续追问的问题。")} />
      </label>
      <div className="wf-output-save"><Button disabled={!active || busy || !!remote || !dirty} onClick={save}>{pending === "save" ? ui("保存中…") : ui("保存回答与笔记")}</Button><small className="muted">{dirty ? ui("继续下一步时也会一起保存") : ui("已保存在本次学习中")}{" · "}{step.kind === "recall" && resources.modelReady ? uiFormat("{0} + Enter 请 AI 查看", [MOD_KEY]) : uiFormat("{0} + Enter 保存", [MOD_KEY])}</small></div>
      </details>
      {lastFeedback && <section className={`wf-retell${stale ? " is-stale" : ""}`} aria-label={ui("AI 对复述的反馈")}>
        <p className="wf-eyebrow">{stale ? ui("AI 对上一版复述的反馈") : ui("AI 看了你的复述")}</p>
        {lastFeedback.note && <p className="wf-retell-note">{lastFeedback.note}</p>}
        <div className="wf-retell-cols">
          {lastFeedback.covered.length > 0 && <div><h4>{ui("讲到了")}</h4><ul>{lastFeedback.covered.map((item) => <li key={item}>{item}</li>)}</ul></div>}
          {lastFeedback.missing.length > 0 && <div className="is-missing"><h4>{ui("还缺")}</h4><ul>{lastFeedback.missing.map((item) => <li key={item}>{item}</li>)}</ul></div>}
        </div>
        {lastFeedback.question && <p className="wf-retell-question">{uiFormat("想一想：{0}", [lastFeedback.question])}</p>}
        <p className="muted small">{stale ? ui("你改过复述了。按上面的缺口补好后，可以请 AI 再看一遍。") : ui("这是对这一次复述的建议，不是判分，也不代表是否已经掌握。")}</p>
      </section>}
      {step.kind === "recall" && <div className="wf-recall-reference"><Button aria-expanded={showRecallMaterial} onClick={() => setShowRecallMaterial((value) => !value)}>{showRecallMaterial ? ui("收起参考内容") : ui("我已尝试，查看参考与讲解")}</Button>{showRecallMaterial && <div>{recallContent && <TeachingArticle content={recallContent} />}<Readings resources={resources} /></div>}</div>}
      <details className="wf-chat"><summary>{ui((HANDOFF[step.kind] || HANDOFF.lesson).label)}</summary><label>{ui("我需要什么帮助")}<textarea rows={2} value={wish} maxLength={2000} onChange={(e) => setWish(e.target.value)} placeholder={ui("例如：用一个具体例子解释这里的因果关系。")} disabled={!active || busy} /></label><Button disabled={!active || busy || !!remote} onClick={ask}>{pending === "chat" ? ui("交接中…") : ui("保存笔记并交给主对话")}</Button><p className="muted small">{ui("补充的讲解会回到这一步，你的回答与学习判断由你自己完成。")}</p></details>
      <footer className="wf-advance"><div className="wf-continue-heading"><div><strong>{ui("按自己的节奏继续")}</strong><p className="muted small">{uiFormat("下一站：{0}", [branchText(step.next)])}</p></div>{askable ? <div className="wf-primary-pair"><Button variant="link" size="sm" disabled={cannotComplete} onClick={() => advance("done")}>{ui("直接继续")}</Button><Button variant="primary" disabled={!active || busy || !!remote} onClick={askFeedback}>{pending === "feedback" ? ui("AI 正在看…") : lastFeedback ? ui("请 AI 再看一遍 →") : ui("请 AI 看看我的复述 →")}</Button></div>
        : feedback ? <div className="wf-primary-pair">{feedback.suggestion === "revisit"
          ? <><Button variant="link" size="sm" disabled={cannotComplete} onClick={() => advance("done")}>{ui("先继续")}</Button><Button variant="primary" disabled={!active || busy || !!remote} onClick={revisit}>{ui("回到讲解补一补 →")}</Button></>
          : <><Button variant="link" size="sm" disabled={!active || busy || !!remote} onClick={revisit}>{ui("回到讲解补一补")}</Button><Button variant="primary" disabled={cannotComplete} onClick={() => advance("done")}>{pending === "done" ? ui("保存中…") : ui("继续 →")}</Button></>}</div>
        : <Button variant={(step.kind === "lesson" && !content) || (step.kind === "skeleton" && !resources.skeleton) ? undefined : "primary"} disabled={cannotComplete} onClick={() => advance("done")}>{pending === "done" ? ui("保存中…") : step.kind === "lesson" ? content ? ui("读完了，继续 →") : ui("先往下走 →") : step.kind === "skeleton" ? resources.skeleton ? ui("看完了，继续 →") : ui("先往下走 →") : ui("完成本步，继续 →")}</Button>}</div>{step.kind === "practice" && !resources.practice?.complete && <p className="muted small">{ui("练完本步题目后可以继续，也可以在下方如实选择跳过。")}</p>}{["recall", "reflection"].includes(step.kind) && !output.trim() && <p className="muted small">{step.kind === "recall" ? ui("写下复述，或在实际口头复述后记录，即可继续。") : ui("选择符合实际的回顾，或补充自己的总结，即可继续。")}</p>}<details className="wf-other-path"><summary>{ui("还需巩固、跳过与步骤安排")}</summary><div className="wf-actions"><Button disabled={!active || busy || !!remote} onClick={() => advance("needs_work")}>{ui("还需巩固")}</Button><Button disabled={!active || busy || !!remote} onClick={() => advance("skipped")}>{ui("跳过本步")}</Button></div><div className="wf-branch-hint"><span>{uiFormat("完成 / 跳过 → {0}", [branchText(step.next)])}</span><span>{uiFormat("需巩固 → {0}", [branchText(step.retry)])}</span></div><p className="muted small">{ui("完成只记录本次活动；闪卡判分和复习安排照常独立保存。")}</p></details></footer>
    </article>}
    {completed && <div className="wf-completed"><h2>{ui("这次学习已结束")}</h2><p>{uiFormat("完成活动 {0} 次 · 需要巩固 {1} 次 · 跳过 {2} 次", ["done", "needs_work", "skipped"].map((outcome) => session.history.filter((event) => event.outcome === outcome).length))}</p><p className="muted">{ui("这些记录描述本次学习过程，闪卡的判分与复习安排仍按原有规则保存。")}</p>{session.course && session.pickedBy === "route" ? <div className="wf-actions wf-course-next"><Button variant="primary" disabled={busy} onClick={() => continueCourse(false)}>{pending === "course" ? ui("准备中…") : ui("继续课程下一批 →")}</Button><Button disabled={busy} onClick={() => continueCourse(true)}>{ui("下一批也先讲后练")}</Button><Button variant="link" size="sm" onClick={onBack}>{ui("返回学习流工作台")}</Button></div>
      : <Button onClick={onBack}>{ui("返回学习流工作台")}</Button>}</div>}
    {completed && <SavedTeaching session={session} />}
    <History session={session} />
  </section>;
}
