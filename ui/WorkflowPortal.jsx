import React, { useCallback, useEffect, useRef, useState } from "react";
import Markdown from "./Markdown.jsx";
import SkeletonCanvas from "./SkeletonCanvas.jsx";
import WorkflowPractice from "./WorkflowPractice.jsx";
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

export default function WorkflowPortal({ id, libraryKey, call, askInChat, onBack, revision }) {
  useInjectCss(css, "study-workflows");
  useInjectCss(skeletonCss, "study-skeleton");
  const [session, setSession] = useState(null), [resources, setResources] = useState({ readings: [], sources: [], cardCount: 0 });
  const [output, setOutput] = useState(""), [remote, setRemote] = useState(null);
  const [pending, setPending] = useState(""), [error, setError] = useState(""), [notice, setNotice] = useState("");
  const [practiceBusy, setPracticeBusy] = useState(false), [practiceComplete, setPracticeComplete] = useState(false);
  const [showRecallMaterial, setShowRecallMaterial] = useState(false), [wish, setWish] = useState("");
  const current = useRef(null), outputRef = useRef(""), lock = useRef(false), live = useRef(true), pollToken = useRef(0);
  const transition = useRef(null), reading = useRef(null);
  const invalidateReads = useCallback(() => { ++pollToken.current; reading.current = null; }, []);

  const adopt = useCallback((next, options = {}) => {
    const changedStep = current.current?.currentStepId !== next.currentStepId;
    const cached = options.restore ? readDraft(next, libraryKey) : null;
    const value = options.keepOutput && !changedStep ? outputRef.current : cached && typeof cached.output === "string" ? cached.output : savedOutput(next);
    current.current = next; outputRef.current = value;
    setSession(next); setOutput(value);
    if (options.resources) setResources(options.resources);
    if (changedStep) { setShowRecallMaterial(false); setPracticeComplete(false); setWish(""); }
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
    if (lock.current || practiceBusy || remote) return;
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
  const startPractice = () => act("practice", async () => {
    const saved = await persist();
    const result = await call("workflow.practice.start", { id, version: saved.version });
    adopt(result.session);
  });
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
    await askInChat(`请帮助我学习「${saved.topic}」的「${step.title}」步骤。${wish.trim() ? `我的要求：${wish.trim()}` : step.kind === "recall" ? "请检查我的复述是否漏了关键条件，用追问引导我自己补全。" : "请提供清楚、连贯的讲解和一个可以推演的例子。"}\n` +
      `先用 study_workspace 的 workflow.context，payload 为 ${JSON.stringify({ sessionId: saved.id })}，读取本次学习、当前步骤、我的笔记和可用资料。当前看到的 version 是 ${saved.version}，保存前以重新读取的最新版本为准。\n` +
      "必要时用 source.search 查证，区分已有资料与补充知识。用 workflow.session.material {id,version,stepId,content} 保存当前步骤的教学内容，不能写我的回答、代我完成步骤或评定自己掌握。\n" +
      (step.kind === "recall" ? "当前是主动复述：先以问题指出缺口，不要直接给出完整参考答案。补充内容会由我主动展开。" : "讲解请连起概念、例子和条件，避免只罗列名词。缺少依据时明确说明。"));
    setNotice("请求已准备好，请在主对话确认发送。补充材料保存后会在这里显示。");
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

  if (!session) return <section className="page workflow-page"><button type="button" onClick={onBack}>← 学习流工作台</button><h1>学习 Portal</h1>{error ? <><p className="wf-error" role="alert">{error}</p><button type="button" onClick={refresh}>重新读取</button></> : <p className="muted" role="status">正在恢复学习进度…</p>}</section>;
  const step = session.template.steps.find((item) => item.id === session.currentStepId);
  const index = session.template.steps.indexOf(step), record = session.records[step.id] || {};
  const dirty = output !== savedOutput(session), busy = !!pending || practiceBusy, active = session.status === "active", completed = session.status === "completed";
  const content = record.content || step.content;
  const priorLesson = session.template.steps.slice(0, index).findLast(item => item.kind === "lesson");
  const recallContent = content || (priorLesson && (session.records[priorLesson.id]?.content ?? priorLesson.content));
  const oralReported = output.split("\n").includes(ORAL_REPORT);
  const cannotComplete = !active || !!remote || busy || (["recall", "reflection"].includes(step.kind) && !output.trim()) || (step.kind === "practice" && !practiceComplete);
  const branchText = (edge) => {
    if (edge === "$stay") return "留在本步";
    if (edge === "$finish") return "结束本次学习";
    if (edge === "$next") return session.template.steps[index + 1]?.title || "结束本次学习";
    return session.template.steps.find((item) => item.id === edge)?.title;
  };
  return <section className="page workflow-page wf-portal">
    <div className="wf-topline"><button type="button" disabled={busy || !!remote} onClick={leave}>← 保存并返回工作台</button><span className="muted small">{completed ? "本次学习已结束" : active ? "学习中" : "已暂停"}</span></div>
    <header className="wf-heading"><div><p className="wf-eyebrow">{session.template.title}</p><h1>{session.topic}</h1><p className="muted">{completed ? "保留这次学习的记录，下一次可以换一种学习方式。" : `第 ${index + 1} / ${session.template.steps.length} 步 · ${step.title}`}</p></div>{!completed && <button type="button" disabled={busy || !!remote} onClick={() => changeStatus(active ? "paused" : "active")}>{active ? "保存并暂停" : "继续学习"}</button>}</header>
    {error && <div className="wf-error" role="alert"><p>{error} 你的输入仍保留在此设备。</p><button type="button" disabled={busy} onClick={refresh}>核对最新进度</button></div>}
    {remote && <div className="wf-notice" role="status"><p>这次学习在其他地方有了更新。你的文字已保留，请选择怎样继续。</p>
      {savedOutput(remote.session) && <details><summary>查看学习库中的最新回答</summary><Markdown text={savedOutput(remote.session)} /></details>}
      <div className="wf-actions"><button type="button" onClick={() => reconcile(true)}>{remote.session.currentStepId === session.currentStepId ? "载入更新，保留我的文字" : "进入新步骤，保留旧步草稿"}</button><button type="button" onClick={() => reconcile(false)}>使用最新记录</button></div>
    </div>}
    {notice && <p className="wf-status" role="status">{notice}</p>}
    <ol className="wf-portal-route" aria-label="学习步骤">{session.template.steps.map((item, stepIndex) => <li key={item.id} aria-current={!completed && item.id === step.id ? "step" : undefined} className={item.id === step.id && !completed ? "is-current" : ""}><span>{String(stepIndex + 1).padStart(2, "0")}</span><strong>{item.title}</strong>{session.records[item.id]?.outcome && <small>{OUTCOME[session.records[item.id].outcome]}</small>}</li>)}</ol>
    {!completed && <article className="wf-activity">
      <div className="wf-section-head"><h2>{step.title}</h2></div>
      {step.instructions && <Markdown text={step.instructions} className="wf-instructions" />}
      {!active && <p className="wf-notice">已暂停。点「继续学习」后可接着作答，当前内容可以阅读。</p>}
      {["overview", "reflection"].includes(step.kind) && <LearnerChoices kind={step.kind} output={output} disabled={!active || busy || !!remote} onChange={changeOutput} />}
      {step.kind === "recall" && <section className="wf-recall-invitation"><h3>先合上材料，用自己的话讲一遍</h3><p>试着说清核心机制、一个例子，以及什么时候不适用。</p><div className="wf-quick-choices"><button type="button" aria-pressed={oralReported} disabled={!active || busy || !!remote} onClick={() => changeOutput(oralReported ? output.split("\n").filter((line) => line !== ORAL_REPORT).join("\n").trim() : [output.trim(), ORAL_REPORT].filter(Boolean).join("\n"))}>{oralReported ? "已记录：我已口头复述" : "我已口头复述"}</button></div><small className="muted">这是你的自我记录；不会据此判分或认定掌握。也可以在下面写下复述。</small></section>}
      {step.kind === "skeleton" && (resources.skeleton ? <div className="wf-skeleton"><h3>{resources.skeleton.title}</h3>{resources.skeleton.overview && <Markdown text={resources.skeleton.overview} />}<SkeletonCanvas skeleton={resources.skeleton} /></div> : <p className="wf-empty muted">本次没有关联知识骨架。可以先记录概念之间的关系，或向主对话寻求帮助。</p>)}
      {step.kind === "lesson" && <WorkflowLesson key={step.id} topic={session.topic} content={content} record={record} resources={resources} disabled={!active || busy || !!remote} onTeach={teach} onUndo={undoTeaching} />}
      {!["lesson", "recall"].includes(step.kind) && content && <div className="wf-lesson"><TeachingArticle content={content} /></div>}
      {["lesson", "skeleton"].includes(step.kind) && <Readings resources={resources} />}
      {step.kind === "practice" && (record.runId ? <WorkflowPractice key={record.runId} runId={record.runId} libraryKey={libraryKey} call={call} disabled={!active || !!pending || !!remote} onBusy={setPracticeBusy} onComplete={setPracticeComplete} /> : <div className="wf-practice-intro"><p>{resources.cardCount ? `本次范围有 ${resources.cardCount} 道题，本步最多练 ${step.count} 道。` : "本次范围还没有可练习的题目，可以在主对话补充内容，或跳过本步。"}</p><p className="muted small">作答沿用原有判分和闪卡调度；流程活动另行记录。</p><button type="button" className="primary" disabled={!active || busy || !!remote || !resources.cardCount} onClick={startPractice}>{pending === "practice" ? "准备练习…" : "开始本步练习"}</button></div>)}
      <details key={`notes:${step.id}`} className="wf-notes" open={step.kind === "recall" && !oralReported}><summary>{step.kind === "recall" ? "写下我的复述" : step.kind === "reflection" ? "补充我的收获与下一步" : step.kind === "overview" ? "写下自己的学习目标" : "随手记：笔记与疑问"}<span>{dirty ? "有未保存的记录" : output ? "已保存" : "可选"}</span></summary>
      <label className="wf-output-label">{step.kind === "recall" ? "我的复述" : step.kind === "reflection" ? "我的总结与下一步" : step.kind === "overview" ? "我想解决的问题" : "我的笔记与疑问"}
        <textarea rows={step.kind === "recall" || step.kind === "reflection" ? 7 : 4} maxLength={20000} value={output} disabled={!active || busy} onChange={(e) => changeOutput(e.target.value)} placeholder={step.kind === "recall" ? "不用追求标准措辞。写清核心机制、一个例子，以及什么时候不适用。" : step.kind === "reflection" ? "写下收获、还卡住的地方，以及下次准备做什么。" : "写下思路、观察到的关系，或想继续追问的问题。"} />
      </label>
      <div className="wf-output-save"><button type="button" disabled={!active || busy || !!remote || !dirty} onClick={save}>{pending === "save" ? "保存中…" : "保存回答与笔记"}</button><small className="muted">{dirty ? "继续下一步时也会一起保存。" : "已保存在本次学习中。"}</small></div>
      </details>
      {step.kind === "recall" && <div className="wf-recall-reference"><button type="button" aria-expanded={showRecallMaterial} onClick={() => setShowRecallMaterial((value) => !value)}>{showRecallMaterial ? "收起参考内容" : "我已尝试，查看参考与讲解"}</button>{showRecallMaterial && <div>{recallContent && <TeachingArticle content={recallContent} />}<Readings resources={resources} /></div>}</div>}
      <details className="wf-chat"><summary>{step.kind === "recall" ? "请主对话通过追问帮我补全" : "请主对话帮我讲清楚"}</summary><label>我需要什么帮助<textarea rows={2} value={wish} maxLength={2000} onChange={(e) => setWish(e.target.value)} placeholder="例如：用一个具体例子解释这里的因果关系。" disabled={!active || busy} /></label><button type="button" disabled={!active || busy || !!remote} onClick={ask}>{pending === "chat" ? "交接中…" : "保存笔记并交给主对话"}</button><p className="muted small">补充的讲解会回到这一步，你的回答与学习判断由你自己完成。</p></details>
      <footer className="wf-advance"><div className="wf-continue-heading"><div><strong>按自己的节奏继续</strong><p className="muted small">下一站：{branchText(step.next)}</p></div><button type="button" className="primary" disabled={cannotComplete} onClick={() => advance("done")}>{pending === "done" ? "保存中…" : "完成本步，继续 →"}</button></div>{step.kind === "practice" && !practiceComplete && <p className="muted small">练完本步题目后可以继续，也可以在下方如实选择跳过。</p>}{["recall", "reflection"].includes(step.kind) && !output.trim() && <p className="muted small">{step.kind === "recall" ? "写下复述，或在实际口头复述后记录，即可继续。" : "选择符合实际的回顾，或补充自己的总结，即可继续。"}</p>}<details className="wf-other-path"><summary>还需巩固、跳过与步骤安排</summary><div className="wf-actions"><button type="button" disabled={!active || busy || !!remote} onClick={() => advance("needs_work")}>还需巩固</button><button type="button" disabled={!active || busy || !!remote} onClick={() => advance("skipped")}>跳过本步</button></div><div className="wf-branch-hint"><span>完成 / 跳过 → {branchText(step.next)}</span><span>需巩固 → {branchText(step.retry)}</span></div><p className="muted small">完成只记录本次活动；闪卡判分和复习安排照常独立保存。</p></details></footer>
    </article>}
    {completed && <div className="wf-completed"><h2>这次学习已结束</h2><p>完成活动 {session.history.filter((event) => event.outcome === "done").length} 次 · 需要巩固 {session.history.filter((event) => event.outcome === "needs_work").length} 次 · 跳过 {session.history.filter((event) => event.outcome === "skipped").length} 次</p><p className="muted">这些记录描述本次学习过程，闪卡的判分与复习安排仍按原有规则保存。</p><button type="button" onClick={onBack}>返回学习流工作台</button></div>}
    {completed && <SavedTeaching session={session} />}
    <History session={session} />
  </section>;
}
