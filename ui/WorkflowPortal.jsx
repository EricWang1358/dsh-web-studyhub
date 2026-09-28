import React, { useCallback, useEffect, useRef, useState } from "react";
import Markdown from "./Markdown.jsx";
import SkeletonSpine from "./SkeletonSpine.jsx";
import WorkflowLesson, { TeachingArticle } from "./WorkflowLesson.jsx";
import { useInjectCss } from "./shared.js";
import css from "./workflows.css";
import skeletonCss from "./skeleton.css";

const OUTCOME = { done: "已完成活动", needs_work: "还需巩固", skipped: "已跳过" };
const draftKey = (session, libraryKey) => `study-workflow-output:${libraryKey}:${session.id}:${session.currentStepId}`;
const savedOutput = (session) => session.records[session.currentStepId]?.output || "";
const readDraft = (session, libraryKey) => { try { return JSON.parse(localStorage.getItem(draftKey(session, libraryKey))); } catch { return null; } };
const clearDraft = (session, libraryKey) => { try { localStorage.removeItem(draftKey(session, libraryKey)); } catch {} };
const keepDraft = (session, output, libraryKey) => { try { localStorage.setItem(draftKey(session, libraryKey), JSON.stringify({ output, base: savedOutput(session), version: session.version })); } catch {} };
const ORAL_REPORT = "我已口头复述（自我记录，未经过判分或掌握验证）。";
const MOD_KEY = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform || "") ? "⌘" : "Ctrl";
const PICKED = { ai: "AI 选的范围", match: "按名称匹配的范围", course: "没找到直接相关的主题，先学当前课程", route: "课程路线的这一批", none: "学习库里还没有相关的题目" };
const prefersReducedMotion = () => typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
const coarsePointer = () => typeof matchMedia === "function" && matchMedia("(pointer: coarse)").matches;

/* What this session covers, so the learner can see what AI picked. */
function ScopeLine({ session, resources }) {
  const topics = resources.scopeTopics || [];
  if (!topics.length && !session.pickedBy) return null;
  const total = resources.scopeTopicCount || topics.length;
  const shown = topics.slice(0, 4).join("、");
  return <p className={`wf-scope-line${["course", "none"].includes(session.pickedBy) ? " is-fallback" : ""}`} title={topics.join("、")}>
    <span>{PICKED[session.pickedBy] || "本次范围"}{shown ? "：" : ""}</span>{shown && <>{shown}{total > 4 ? ` 等 ${total} 个主题` : ""}</>}{resources.cardCount > 0 && <> · {resources.cardCount} 题</>}
  </p>;
}

// What each kind of step asks the main chat for; a goal step wants goal options, not an audit.
const HANDOFF = {
  overview: { label: "请主对话帮我把目标说具体", ask: "请帮我把这次的学习目标说具体：结合本次范围，给我 2–3 个可选的目标句（学完后我能说清或做到什么），每句配一个适合当主攻的例子，由我挑选或改写。不要替我写进回答，也不要做覆盖检查或列清单。" },
  skeleton: { label: "请主对话帮我理清概念关系", ask: "请帮我理清本次范围里概念之间的关系：一条先学后学的主线、谁属于谁、因果和容易混淆的对比，写成能顺着读的结构说明。" },
  lesson: { label: "请主对话帮我讲清楚", ask: "请提供清楚、连贯的讲解和一个可以推演的例子。" },
  recall: { label: "请主对话通过追问帮我补全", ask: "请检查我的复述是否漏了关键条件，用追问引导我自己补全。" },
  practice: { label: "请主对话帮我弄懂做错的题", ask: "请帮我弄懂本步练习里做错或拿不准的题：为什么是这个答案，容易错在哪里。" },
  reflection: { label: "请主对话帮我回顾", ask: "请根据本次学习记录帮我回顾：哪些已经讲清、哪些还需要补、下次先做什么。由我决定写进回顾的内容。" },
};
const stamp = (at) => { const d = new Date(at); return Number.isFinite(d.getTime()) ? d.toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }) : ""; };
const preview = (text) => { const s = String(text || "").replace(/[#>*_`-]+/g, " ").replace(/\s+/g, " ").trim(); return s.length > 90 ? s.slice(0, 89) + "…" : s; };

/* Every earlier version of a step's material, so a save never loses anything. */
function MaterialHistory({ record, disabled, onRestore }) {
  const history = record.materialHistory || [];
  if (!history.length) return null;
  return <details className="wf-material-history"><summary>之前的版本 · {history.length}</summary><ol>
    {history.map((item, index) => ({ item, index })).reverse().map(({ item, index }) => <li key={`${index}:${item.at}`}>
      <div className="wf-material-history-head"><span>{item.by === "ai" ? "AI 讲解" : "主对话"} · {stamp(item.at)}</span><button type="button" className="link-btn" disabled={disabled} onClick={() => onRestore(index)}>恢复这一版</button></div>
      <details><summary>{preview(item.content)}</summary><TeachingArticle content={item.content} /></details>
    </li>)}
  </ol><p className="muted small">恢复后，当前版本也会留在这里。</p></details>;
}

/* A practice step: the round itself happens in the full review page. */
function PracticeStep({ step, resources, pending, disabled, onStart, onOpen }) {
  const p = resources.practice;
  const count = Math.min(step.count || resources.cardCount, resources.cardCount);
  if (!p && !resources.cardCount) return <div className="wf-practice-intro"><p>本次范围还没有可练习的题目，可以请主对话补充内容，或跳过本步。</p></div>;
  if (!p) return <div className="wf-practice-intro">
    <p>从本次范围里练 <strong>{count}</strong> 道题。打开的是完整的刷题页：提示、讲解、AI 追问和教学都能用，练完点「回到学习流」回到这里。</p>
    <p className="muted small">作答照常判分，并进入闪卡复习安排。</p>
    <button type="button" className="primary" disabled={disabled} onClick={() => onStart(false)}>{pending ? "准备练习…" : `开始练习 ${count} 道 →`}</button>
  </div>;
  const done = p.complete || p.ended;
  return <div className="wf-practice-intro">
    <div className="wf-practice-progress" role="progressbar" aria-label="本步练习进度" aria-valuemin={0} aria-valuemax={p.total} aria-valuenow={p.answered}><span style={{ width: `${p.total ? Math.round((p.answered / p.total) * 100) : 0}%` }} /></div>
    {p.complete ? <p>本步练完了：答对 <strong>{p.correct}</strong> / {p.total} 道。</p>
      : p.ended ? <p>这一轮提前结束了，做了 {p.answered} / {p.total} 道。可以再练一轮，或在下方如实选择跳过。</p>
      : <p>已做 <strong>{p.answered}</strong> / {p.total} 道{p.answered ? `，答对 ${p.correct} 道` : ""}。</p>}
    <div className="wf-actions">
      {!done && <button type="button" className="primary" disabled={disabled} onClick={() => onOpen(p.runId)}>{pending ? "打开中…" : p.answered ? "继续练习 →" : "开始练习 →"}</button>}
      {done && <button type="button" disabled={disabled} onClick={() => onOpen(p.runId)}>查看本轮结果</button>}
      {done && <button type="button" className="link-btn" disabled={disabled} onClick={() => onStart(true)}>再练一轮</button>}
    </div>
  </div>;
}

/* The skeleton step without a skeleton: make one for this session's scope in the background. */
function SkeletonMaker({ session, resources, disabled, onGenerate }) {
  const job = session.skeletonJob;
  const running = job?.status === "running" && resources.skeletonActive;
  const failed = job?.status === "failed" || (job?.status === "running" && !resources.skeletonActive);
  return <div className="wf-skeleton-maker">
    <h3>本次还没有知识骨架</h3>
    <p className="muted">骨架把本次范围里的概念串成一条主线：先学什么、谁属于谁、哪些容易混。</p>
    {running ? <p className="wf-spine-status" role="status"><span className="wf-pulse" aria-hidden="true" />AI 正在整理本次范围的骨架（{job.cards} 题），好了会直接显示在这里；也可以先往下学。</p>
      : resources.modelReady ? <>{failed && <p className="wf-error">上次没有生成成功{job.message ? `：${job.message}` : "。"}</p>}
        <button type="button" className="primary" disabled={disabled || !resources.cardCount} onClick={onGenerate}>{failed ? "重新生成本次范围的骨架" : "一键生成本次范围的骨架"}</button>
        {!resources.cardCount && <p className="muted small">本次范围没有题目，无法整理骨架。</p>}</>
      : <p className="wf-model-hint">连接模型后可以一键生成；也可以请主对话帮你设计骨架。</p>}
  </div>;
}

const GOALS = ["先建立整体框架", "弄懂关键机制", "通过例子学会应用", "查漏补缺"];
const REFLECTIONS = ["已理清主线", "还需要例子", "需要补前置", "下次先练习"];

function LearnerChoices({ kind, output, disabled, onChange }) {
  const choices = kind === "overview" ? GOALS : REFLECTIONS;
  const prefix = kind === "overview" ? "本次目标：" : "我的回顾：";
  const lines = output.split("\n");
  return <section className="wf-learner-choices"><h3>{kind === "overview" ? "这次，你最想解决什么？" : "回顾一下，下一步需要什么？"}</h3><p className="muted">{kind === "overview" ? "选择这次的学习重点，也可以在笔记里写自己的目标。" : "按自己的实际感受选择，可多选；也可以补充一句收获。"}</p><div className="wf-quick-choices" role="group" aria-label={kind === "overview" ? "学习目标" : "学习回顾"}>{choices.map((choice) => {
    const value = `${prefix}${choice}。`, selected = lines.includes(value);
    return <button type="button" key={choice} aria-pressed={selected} disabled={disabled} onClick={() => onChange(selected ? lines.filter((line) => line !== value).join("\n").trim() : [...lines.filter(Boolean), value].join("\n"))}>{choice}</button>;
  })}</div><small className="muted">选择会记入你的{kind === "overview" ? "目标" : "回顾"}，由你决定何时继续。</small></section>;
}

function SavedTeaching({ session }) {
  const steps = session.template.steps.filter((step) => session.records[step.id]?.content || step.content || session.records[step.id]?.help?.length);
  if (!steps.length) return null;
  return <section className="wf-saved-teaching"><h2>回看这次的讲解</h2>{steps.map((step) => {
    const record = session.records[step.id] || {};
    return <details key={step.id}><summary>{step.title}</summary>{(record.content || step.content) && <TeachingArticle content={record.content || step.content} />}{record.help?.map((help) => <section key={help.id}><h3>{help.title}</h3><TeachingArticle content={help.content} /></section>)}</details>;
  })}</section>;
}

const Readings = React.memo(function Readings({ resources }) {
  const titles = new Map((resources.sources || []).map((source) => [source.id, source.title]));
  if (!resources.readings?.length) return <p className="muted">本次范围还没有关联资料。可以请主对话围绕这个主题补充讲解，或把自己的资料写在笔记里。</p>;
  return <details className="wf-readings"><summary>参考已有题解与引用材料 <span className="muted">{resources.readings.length} 条</span></summary>
    <p className="muted small">这些是所选范围内的现有内容，可请主对话整理成连贯讲解。</p>
    {resources.readings.map((reading, index) => <article key={`${reading.deckId}:${reading.cardId}`}>
      <h4>{index + 1}. {reading.topic || "参考材料"}</h4><Markdown text={reading.explanation} />
      {reading.citations?.map((citation, ci) => <blockquote key={ci}><Markdown text={citation.quote} /><cite>{titles.get(citation.sourceId) || "关联资料"}{citation.locator ? ` · ${citation.locator}` : ""}</cite></blockquote>)}
    </article>)}
  </details>;
});

const History = React.memo(function History({ session }) {
  const title = (id) => session.template.steps.find((step) => step.id === id)?.title || "学习步骤";
  return <details className="wf-history" open={session.status === "completed"}><summary>学习足迹 · {session.history.length} 次活动</summary>
    {!session.history.length ? <p className="muted">完成、回补或跳过一个步骤后，记录会出现在这里。</p> : <ol>{session.history.map((event, index) => <li key={event.requestId || index}>
      <div><strong>{title(event.stepId)}</strong><span className={`wf-outcome ${event.outcome}`}>{OUTCOME[event.outcome]}</span><time>{new Date(event.at).toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" })}</time></div>
      {event.output && <Markdown text={event.output} />}
    </li>)}</ol>}
  </details>;
});

/* The skeleton for a guided session that started without one: it can be
   drafted in the background and appears here, folded, once it is ready. */
function SpinePeek({ session, resources, late, disabled, onGenerate }) {
  const job = session.skeletonJob;
  if (resources.skeleton) return <details className="wf-spine-peek"><summary>本次脉络 · {resources.skeleton.title}<span className="muted small">{job?.status === "done" ? "后台刚整理好，展开看看主线" : "展开看看主线"}</span></summary>
    {resources.skeleton.overview && <Markdown text={resources.skeleton.overview} />}<SkeletonSpine skeleton={resources.skeleton} /></details>;
  if (session.status === "completed" || !resources.cardCount) return null;
  if (job?.status === "running" && resources.skeletonActive)
    return <p className="wf-spine-status" role="status"><span className="wf-pulse" aria-hidden="true" />AI 正在后台整理本次的知识骨架（{job.cards} 题），好了会出现在这里，学习不用等它。</p>;
  // At the last step a new skeleton would only serve a later session.
  if (!resources.modelReady || late) return null;
  const interrupted = job?.status === "running" || job?.status === "failed";
  return <p className="wf-spine-status muted">{interrupted ? `上次后台整理骨架没有完成${job.message ? `：${job.message}` : "。"}` : "本次范围还没有知识骨架。"}
    <button type="button" className="link-btn" disabled={disabled} onClick={onGenerate}>{interrupted ? "重新在后台生成" : "在后台生成一份"}</button></p>;
}

export default function WorkflowPortal({ id, libraryKey, call, askInChat, onOpenRun, onOpenSession, onBack, revision }) {
  useInjectCss(css, "study-workflows");
  useInjectCss(skeletonCss, "study-skeleton");
  const [session, setSession] = useState(null), [resources, setResources] = useState({ readings: [], sources: [], cardCount: 0 });
  const [output, setOutput] = useState(""), [remote, setRemote] = useState(null);
  const [pending, setPending] = useState(""), [error, setError] = useState(""), [notice, setNotice] = useState("");
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
  useEffect(() => {
    const sync = () => { if (document.visibilityState !== "hidden") void refresh({ automatic: true }); };
    const timer = setInterval(sync, 8000);
    document.addEventListener("visibilitychange", sync);
    return () => { clearInterval(timer); document.removeEventListener("visibilitychange", sync); };
  }, [refresh]);
  const changeOutput = (value) => {
    outputRef.current = value; setOutput(value); setNotice("");
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
    lock.current = true; ++pollToken.current; setPending(name); setError(""); setNotice("");
    try { await action(current.current); }
    catch (err) { if (live.current) setError(err.message); }
    finally { lock.current = false; if (live.current) setPending(""); }
  }
  const save = () => act("save", async () => { await persist(); setNotice("回答和笔记已保存到学习库。"); });
  const leave = () => act("leave", async (before) => { if (before.status === "active") await persist(); onBack(); });
  const changeStatus = (status) => act("status", async (before) => {
    const saved = before.status === "active" ? await persist() : before;
    const next = await call("workflow.session.status", { id, version: saved.version, status });
    adopt(next, { keepOutput: true });
    setNotice(status === "paused" ? "已保存并暂停，可以随时回来继续。" : "已继续这次学习。");
  });
  const advance = (outcome) => act(outcome, async (before) => {
    // Preserve the operation ID across a network retry, so a committed move is
    // never applied twice when only its response was lost.
    const intent = JSON.stringify([before.currentStepId, before.version, outcome, outputRef.current]);
    if (transition.current?.intent !== intent) transition.current = { intent, requestId: crypto.randomUUID() };
    const next = await call("workflow.session.advance", { id, version: before.version, outcome, output: outputRef.current, requestId: transition.current.requestId });
    clearDraft(before, libraryKey); transition.current = null;
    adopt(next, { restore: next.currentStepId !== before.currentStepId });
    setNotice(outcome === "needs_work" ? "已记录需要巩固，按这条流程的回补安排继续。" : outcome === "skipped" ? "已如实记录跳过。" : "本步活动已记录。");
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
    const title = next.template.steps.find((item) => item.id === stepId)?.title || "这一步";
    const resume = next.template.steps.find((item) => item.id === next.resumeStepId)?.title;
    setNotice(resume ? `已回到「${title}」，之前的记录都在。看完点上方的「${resume}」回到进度。` : `已回到「${title}」。`);
  });
  // A session from the course route hands on to the route's next batch.
  const continueCourse = (flow) => act("course", async () => {
    if (flow) {
      const next = await call("workflow.quickstart", { course: true, requestId: crypto.randomUUID() });
      onOpenSession?.(next.session.id);
    } else {
      const run = await call("review.start", { mode: "course", course: current.current.course.name, fresh: true });
      onOpenRun?.(run.id);
    }
  });
  const openPractice = (runId) => act("practice", async () => { await persist(); onOpenRun?.(runId); });
  async function prepareTeaching() {
    const saved = await persist();
    const latest = await call("workflow.session.get", { id });
    if (!live.current) return null;
    adopt(latest.session, { resources: latest.resources });
    if (latest.session.currentStepId !== saved.currentStepId || latest.session.status !== "active") throw new Error("学习进度已更新，请在当前步骤重新选择讲解方式。");
    return latest.session;
  }
  const teach = (mode, request = "") => act("teaching", async () => {
    const latest = await prepareTeaching();
    if (!latest) return;
    const result = await call("workflow.teaching.start", { id, version: latest.version, stepId: latest.currentStepId, mode, ...(request ? { request } : {}) });
    if (live.current) { adopt(result.session, { resources: result.resources, keepOutput: true }); setNotice(""); }
  });
  const undoTeaching = () => act("teaching", async () => {
    const latest = await prepareTeaching();
    if (!latest) return;
    const result = await call("workflow.teaching.undo", { id, version: latest.version, stepId: latest.currentStepId });
    if (live.current) { adopt(result.session, { resources: result.resources, keepOutput: true }); setNotice("已恢复上一次讲解。"); }
  });
  const ask = () => act("chat", async () => {
    const saved = await persist(), step = saved.template.steps.find((item) => item.id === saved.currentStepId);
    await askInChat(`请帮助我学习「${saved.topic}」的「${step.title}」这一步。${wish.trim() ? `我的要求：${wish.trim()}` : (HANDOFF[step.kind] || HANDOFF.lesson).ask}\n` +
      `先用 study_workspace 的 workflow.context，payload 为 ${JSON.stringify({ sessionId: saved.id })}，读取本次学习、当前步骤、这一步已有的材料、我的笔记和可用资料。当前看到的 version 是 ${saved.version}，保存前以重新读取的最新版本为准。\n` +
      "必要时用 source.search 查证，区分已有资料与补充知识。用 workflow.session.material 保存到这一步：默认 mode 为 append，追加在已有材料之后，不要重复已有内容；要改已有段落用 mode \"edit\" 和 edits:[{find,replace}]（find 是原文中唯一的一段）；除非我明确要求重写，不要用 replace。旧版本都会保留。不能写我的回答、代我完成步骤或评定我是否掌握。称呼步骤用标题，不要用 step-2 这类内部 ID。\n" +
      (step.kind === "recall" ? "当前是主动复述：先以问题指出缺口，不要直接给出完整参考答案。补充内容会由我主动展开。" : "内容请连起概念、例子和条件，避免只罗列名词。缺少依据时明确说明。"));
    setNotice("请求已准备好，请在主对话确认发送。补充材料保存后会在这里显示。");
  });
  const restoreMaterial = (index) => act("restore", async () => {
    const saved = await persist();
    const next = await call("workflow.session.material.restore", { id, version: saved.version, stepId: saved.currentStepId, index });
    if (live.current) { adopt(next, { keepOutput: true }); setNotice("已恢复这一版材料；换下来的版本也留在「之前的版本」里。"); }
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
    setError(""); setNotice(keepLocal ? "已载入最新内容，本地草稿已保留。" : "已使用学习库中的最新记录。");
  };

  const generateSkeleton = () => act("skeleton", async () => {
    await call("workflow.skeleton.generate", { id });
    const latest = await call("workflow.session.get", { id });
    if (live.current) adopt(latest.session, { resources: latest.resources, keepOutput: true });
  });
  // While a background skeleton is being drafted, check back sooner than the idle poll.
  const drafting = session?.skeletonJob?.status === "running" && resources.skeletonActive;
  useEffect(() => {
    if (!drafting) return;
    const timer = setInterval(() => void refresh({ automatic: true }), 3000);
    return () => clearInterval(timer);
  }, [drafting, refresh]);
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

  if (!session) return <section className="page workflow-page"><button type="button" onClick={onBack}>← 学习流工作台</button><h1>学习 Portal</h1>{error ? <><p className="wf-error" role="alert">{error}</p><button type="button" onClick={refresh}>重新读取</button></> : <p className="muted" role="status">正在恢复学习进度…</p>}</section>;
  const step = session.template.steps.find((item) => item.id === session.currentStepId);
  const index = session.template.steps.indexOf(step), record = session.records[step.id] || {};
  const dirty = output !== savedOutput(session), busy = !!pending, active = session.status === "active", completed = session.status === "completed";
  const content = record.content || step.content;
  const priorLesson = session.template.steps.slice(0, index).findLast(item => item.kind === "lesson");
  const recallContent = content || (priorLesson && (session.records[priorLesson.id]?.content ?? priorLesson.content));
  const oralReported = output.split("\n").includes(ORAL_REPORT);
  // The last reading of the retelling stays visible while the learner revises it,
  // marked as being about the earlier version, so the gaps are still in view.
  const lastFeedback = step.kind === "recall" ? record.feedback || null : null;
  const feedback = lastFeedback && lastFeedback.forOutput === output.trim() ? lastFeedback : null;
  const stale = !!lastFeedback && !feedback;
  const askable = step.kind === "recall" && resources.modelReady && !!output.trim() && !feedback;
  const revisit = () => {
    remedy.current = { mode: "remedy", request: [...(lastFeedback?.missing || []), lastFeedback?.question].filter(Boolean).join("；").slice(0, 1000)
      || "请针对我复述时遗漏的条件和机制重新讲清楚" };
    advance("needs_work");
  };
  const cannotComplete = !active || !!remote || busy || (["recall", "reflection"].includes(step.kind) && !output.trim()) || (step.kind === "practice" && !resources.practice?.complete);
  const branchText = (edge) => {
    if (edge === "$stay") return "留在本步";
    if (edge === "$finish") return "结束本次学习";
    if (edge === "$next") return session.template.steps[index + 1]?.title || "结束本次学习";
    return session.template.steps.find((item) => item.id === edge)?.title;
  };
  return <section className="page workflow-page wf-portal">
    <div className="wf-topline"><button type="button" disabled={busy || !!remote} onClick={leave}>← 保存并返回工作台</button><span className="muted small">{completed ? "本次学习已结束" : active ? "学习中" : "已暂停"}</span></div>
    <header className="wf-heading" ref={headingRef}><div><p className="wf-eyebrow">{session.template.title}</p><h1>{session.topic}</h1><p className="muted">{completed ? "保留这次学习的记录，下一次可以换一种学习方式。" : `第 ${index + 1} / ${session.template.steps.length} 步 · ${step.title}`}</p><ScopeLine session={session} resources={resources} /></div>{!completed && <button type="button" disabled={busy || !!remote} onClick={() => changeStatus(active ? "paused" : "active")}>{active ? "保存并暂停" : "继续学习"}</button>}</header>
    {error && <div className="wf-error" role="alert"><p>{error} 你的输入仍保留在此设备。</p><button type="button" disabled={busy} onClick={refresh}>核对最新进度</button></div>}
    {remote && <div className="wf-notice" role="status"><p>这次学习在其他地方有了更新。你的文字已保留，请选择怎样继续。</p>
      {savedOutput(remote.session) && <details><summary>查看学习库中的最新回答</summary><Markdown text={savedOutput(remote.session)} /></details>}
      <div className="wf-actions"><button type="button" onClick={() => reconcile(true)}>{remote.session.currentStepId === session.currentStepId ? "载入更新，保留我的文字" : "进入新步骤，保留旧步草稿"}</button><button type="button" onClick={() => reconcile(false)}>使用最新记录</button></div>
    </div>}
    {notice && <p className="wf-status" role="status">{notice}</p>}
    <ol className="wf-portal-route" aria-label="学习步骤">{session.template.steps.map((item, stepIndex) => {
      const outcome = session.records[item.id]?.outcome, resume = item.id === session.resumeStepId;
      const body = <><span>{String(stepIndex + 1).padStart(2, "0")}</span><strong>{item.title}</strong>{resume ? <small className="wf-route-resume">当前进度 · 回到这里</small> : outcome && <small>{OUTCOME[outcome]}</small>}</>;
      const reachable = active && !remote && item.id !== step.id && (outcome || resume);
      return <li key={item.id} aria-current={!completed && item.id === step.id ? "step" : undefined} className={[item.id === step.id && !completed ? "is-current" : "", reachable ? "is-reachable" : ""].filter(Boolean).join(" ") || undefined}>
        {reachable ? <button type="button" className="wf-route-link" disabled={busy} title={resume ? "回到刚才的进度" : `回到「${item.title}」看看，记录都会保留`} onClick={() => goTo(item.id)}>{body}</button> : body}
      </li>;
    })}</ol>
    {!session.template.steps.some((item) => item.kind === "skeleton") && <SpinePeek session={session} resources={resources} late={step.kind === "reflection"} disabled={busy || !!remote} onGenerate={generateSkeleton} />}
    {!completed && <article className="wf-activity">
      <div className="wf-section-head"><h2>{step.title}</h2></div>
      {step.instructions && <Markdown text={step.instructions} className="wf-instructions" />}
      {!active && <p className="wf-notice">已暂停。点「继续学习」后可接着作答，当前内容可以阅读。</p>}
      {["overview", "reflection"].includes(step.kind) && <LearnerChoices kind={step.kind} output={output} disabled={!active || busy || !!remote} onChange={changeOutput} />}
      {step.kind === "recall" && <section className="wf-recall-invitation"><h3>先合上材料，用自己的话讲一遍</h3><p>试着说清核心机制、一个例子，以及什么时候不适用。</p><div className="wf-quick-choices"><button type="button" aria-pressed={oralReported} disabled={!active || busy || !!remote} onClick={() => changeOutput(oralReported ? output.split("\n").filter((line) => line !== ORAL_REPORT).join("\n").trim() : [output.trim(), ORAL_REPORT].filter(Boolean).join("\n"))}>{oralReported ? "已记录：我已口头复述" : "我已口头复述"}</button></div><small className="muted">这是你的自我记录；不会据此判分或认定掌握。也可以在下面写下复述。</small></section>}
      {step.kind === "skeleton" && (resources.skeleton ? <div className="wf-skeleton"><h3>{resources.skeleton.title}</h3>{resources.skeleton.overview && <Markdown text={resources.skeleton.overview} />}<SkeletonSpine skeleton={resources.skeleton} /></div> : <SkeletonMaker session={session} resources={resources} disabled={!active || busy || !!remote} onGenerate={generateSkeleton} />)}
      {step.kind === "lesson" && <WorkflowLesson key={step.id} topic={session.topic} content={content} record={record} resources={resources} disabled={!active || busy || !!remote} onTeach={teach} onUndo={undoTeaching} />}
      {!["lesson", "recall"].includes(step.kind) && content && <section className="wf-material" aria-label="本步材料">
        <p className="wf-material-head"><span className="wf-eyebrow">{!record.content ? "本步材料" : record.materialBy === "ai" ? "AI 补充的材料" : "主对话补充的材料"}</span>{record.materialAt && <time>{stamp(record.materialAt)}</time>}</p>
        <div className="wf-lesson"><TeachingArticle content={content} /></div>
      </section>}
      <MaterialHistory record={record} disabled={!active || busy || !!remote} onRestore={restoreMaterial} />
      {["lesson", "skeleton"].includes(step.kind) && <Readings resources={resources} />}
      {step.kind === "practice" && <PracticeStep step={step} resources={resources} pending={pending === "practice"} disabled={!active || busy || !!remote} onStart={startPractice} onOpen={openPractice} />}
      <details key={`notes:${step.id}`} className="wf-notes" open={step.kind === "recall" && !oralReported}><summary>{step.kind === "recall" ? "写下我的复述" : step.kind === "reflection" ? "补充我的收获与下一步" : step.kind === "overview" ? "写下自己的学习目标" : "随手记：笔记与疑问"}<span>{dirty ? "有未保存的记录" : output ? "已保存" : "可选"}</span></summary>
      <label className="wf-output-label">{step.kind === "recall" ? "我的复述" : step.kind === "reflection" ? "我的总结与下一步" : step.kind === "overview" ? "我想解决的问题" : "我的笔记与疑问"}
        <textarea ref={outputField} rows={step.kind === "recall" || step.kind === "reflection" ? 7 : 4} maxLength={20000} value={output} disabled={!active || busy} onChange={(e) => changeOutput(e.target.value)}
          onKeyDown={(e) => { if (e.key !== "Enter" || !(e.ctrlKey || e.metaKey)) return; e.preventDefault(); if (askable) askFeedback(); else if (dirty && !remote) save(); }} placeholder={step.kind === "recall" ? "不用追求标准措辞。写清核心机制、一个例子，以及什么时候不适用。" : step.kind === "reflection" ? "写下收获、还卡住的地方，以及下次准备做什么。" : "写下思路、观察到的关系，或想继续追问的问题。"} />
      </label>
      <div className="wf-output-save"><button type="button" disabled={!active || busy || !!remote || !dirty} onClick={save}>{pending === "save" ? "保存中…" : "保存回答与笔记"}</button><small className="muted">{dirty ? "继续下一步时也会一起保存" : "已保存在本次学习中"}{step.kind === "recall" && resources.modelReady ? ` · ${MOD_KEY} + Enter 请 AI 查看` : ` · ${MOD_KEY} + Enter 保存`}</small></div>
      </details>
      {lastFeedback && <section className={`wf-retell${stale ? " is-stale" : ""}`} aria-label="AI 对复述的反馈">
        <p className="wf-eyebrow">{stale ? "AI 对上一版复述的反馈" : "AI 看了你的复述"}</p>
        {lastFeedback.note && <p className="wf-retell-note">{lastFeedback.note}</p>}
        <div className="wf-retell-cols">
          {lastFeedback.covered.length > 0 && <div><h4>讲到了</h4><ul>{lastFeedback.covered.map((item) => <li key={item}>{item}</li>)}</ul></div>}
          {lastFeedback.missing.length > 0 && <div className="is-missing"><h4>还缺</h4><ul>{lastFeedback.missing.map((item) => <li key={item}>{item}</li>)}</ul></div>}
        </div>
        {lastFeedback.question && <p className="wf-retell-question">想一想：{lastFeedback.question}</p>}
        <p className="muted small">{stale ? "你改过复述了。按上面的缺口补好后，可以请 AI 再看一遍。" : "这是对这一次复述的建议，不是判分，也不代表是否已经掌握。"}</p>
      </section>}
      {step.kind === "recall" && <div className="wf-recall-reference"><button type="button" aria-expanded={showRecallMaterial} onClick={() => setShowRecallMaterial((value) => !value)}>{showRecallMaterial ? "收起参考内容" : "我已尝试，查看参考与讲解"}</button>{showRecallMaterial && <div>{recallContent && <TeachingArticle content={recallContent} />}<Readings resources={resources} /></div>}</div>}
      <details className="wf-chat"><summary>{(HANDOFF[step.kind] || HANDOFF.lesson).label}</summary><label>我需要什么帮助<textarea rows={2} value={wish} maxLength={2000} onChange={(e) => setWish(e.target.value)} placeholder="例如：用一个具体例子解释这里的因果关系。" disabled={!active || busy} /></label><button type="button" disabled={!active || busy || !!remote} onClick={ask}>{pending === "chat" ? "交接中…" : "保存笔记并交给主对话"}</button><p className="muted small">补充的讲解会回到这一步，你的回答与学习判断由你自己完成。</p></details>
      <footer className="wf-advance"><div className="wf-continue-heading"><div><strong>按自己的节奏继续</strong><p className="muted small">下一站：{branchText(step.next)}</p></div>{askable ? <div className="wf-primary-pair"><button type="button" className="link-btn" disabled={cannotComplete} onClick={() => advance("done")}>直接继续</button><button type="button" className="primary" disabled={!active || busy || !!remote} onClick={askFeedback}>{pending === "feedback" ? "AI 正在看…" : lastFeedback ? "请 AI 再看一遍 →" : "请 AI 看看我的复述 →"}</button></div>
        : feedback ? <div className="wf-primary-pair">{feedback.suggestion === "revisit"
          ? <><button type="button" className="link-btn" disabled={cannotComplete} onClick={() => advance("done")}>先继续</button><button type="button" className="primary" disabled={!active || busy || !!remote} onClick={revisit}>回到讲解补一补 →</button></>
          : <><button type="button" className="link-btn" disabled={!active || busy || !!remote} onClick={revisit}>回到讲解补一补</button><button type="button" className="primary" disabled={cannotComplete} onClick={() => advance("done")}>{pending === "done" ? "保存中…" : "继续 →"}</button></>}</div>
        : <button type="button" className={(step.kind === "lesson" && !content) || (step.kind === "skeleton" && !resources.skeleton) ? undefined : "primary"} disabled={cannotComplete} onClick={() => advance("done")}>{pending === "done" ? "保存中…" : step.kind === "lesson" ? content ? "读完了，继续 →" : "先往下走 →" : step.kind === "skeleton" ? resources.skeleton ? "看完了，继续 →" : "先往下走 →" : "完成本步，继续 →"}</button>}</div>{step.kind === "practice" && !resources.practice?.complete && <p className="muted small">练完本步题目后可以继续，也可以在下方如实选择跳过。</p>}{["recall", "reflection"].includes(step.kind) && !output.trim() && <p className="muted small">{step.kind === "recall" ? "写下复述，或在实际口头复述后记录，即可继续。" : "选择符合实际的回顾，或补充自己的总结，即可继续。"}</p>}<details className="wf-other-path"><summary>还需巩固、跳过与步骤安排</summary><div className="wf-actions"><button type="button" disabled={!active || busy || !!remote} onClick={() => advance("needs_work")}>还需巩固</button><button type="button" disabled={!active || busy || !!remote} onClick={() => advance("skipped")}>跳过本步</button></div><div className="wf-branch-hint"><span>完成 / 跳过 → {branchText(step.next)}</span><span>需巩固 → {branchText(step.retry)}</span></div><p className="muted small">完成只记录本次活动；闪卡判分和复习安排照常独立保存。</p></details></footer>
    </article>}
    {completed && <div className="wf-completed"><h2>这次学习已结束</h2><p>完成活动 {session.history.filter((event) => event.outcome === "done").length} 次 · 需要巩固 {session.history.filter((event) => event.outcome === "needs_work").length} 次 · 跳过 {session.history.filter((event) => event.outcome === "skipped").length} 次</p><p className="muted">这些记录描述本次学习过程，闪卡的判分与复习安排仍按原有规则保存。</p>{session.course ? <div className="wf-actions wf-course-next"><button type="button" className="primary" disabled={busy} onClick={() => continueCourse(false)}>{pending === "course" ? "准备中…" : "继续课程下一批 →"}</button><button type="button" disabled={busy} onClick={() => continueCourse(true)}>下一批也先讲后练</button><button type="button" className="link-btn" onClick={onBack}>返回学习流工作台</button></div>
      : <button type="button" onClick={onBack}>返回学习流工作台</button>}</div>}
    {completed && <SavedTeaching session={session} />}
    <History session={session} />
  </section>;
}
