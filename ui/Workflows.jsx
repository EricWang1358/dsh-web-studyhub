import { ui, uiFormat, uiLocale, useUiLanguage } from "./i18n.js";
import React, { useCallback, useEffect, useRef, useState } from "react";
import WorkflowPortal from "./WorkflowPortal.jsx";
import { Button, Icon, IconButton, InlineConfirm, PageHeader, useToast } from "./components/index.js";
import { workflowDesignPrompt, workflowSkeletonPrompt } from "./agent-prompts/workflow.js";
import { useInjectCss } from "./shared.js";
import { usePolling } from "./use-polling.js";
import { QUESTION_COUNT } from "../lib/limits.js";
import css from "./workflows.css";
import { useStudy } from "./study-context.jsx";

/* The move buttons' arrows: the caret-chevron turned a quarter either way (the icon set has no up and down arrows). */
const turned = (degrees) => <span className="wf-turn" style={{ display: "inline-flex", transform: `rotate(${degrees}deg)` }}><Icon name="chevron" size={16} /></span>;
const TURN_UP = turned(-90), TURN_DOWN = turned(90);
const clone = (value) => JSON.parse(JSON.stringify(value));
const when = (value) => new Date(value).toLocaleString(uiLocale(), { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
const STATUS = { active: "学习中", paused: "已暂停", completed: "已结束" };
const readDraft = (key) => { try { return JSON.parse(localStorage.getItem(key)); } catch { return null; } };
const writeDraft = (key, value) => { try { value ? localStorage.setItem(key, JSON.stringify(value)) : localStorage.removeItem(key); } catch {} };
const newStep = (component) => ({ id: `step-${crypto.randomUUID()}`, kind: component.kind, title: component.title,
  instructions: component.prompt, content: "", next: "$next", retry: "$stay", count: 10 });

function BranchSelect({ label, value, onChange, steps }) {
  return <label>{label}<select value={value} onChange={(event) => onChange(event.target.value)}>
    <option value="$next">{ui("按顺序进入下一步")}</option>
    <option value="$stay">{ui("留在当前步骤")}</option>
    <option value="$finish">{ui("结束本次学习")}</option>
    {steps.map((step, index) => <option key={step.id} value={step.id}>{index + 1}. {step.title || ui("未命名步骤")}</option>)}
  </select></label>;
}

export function FlowEditor({ initial, components, latest, storageKey, draftName, call, askInChat, onSaved, onBack }) {
  const keyFor = (value) => `${storageKey}:${value.id || draftName}`;
  const [draft, setDraft] = useState(() => {
    const restored = readDraft(keyFor(initial));
    const next = restored && Array.isArray(restored.steps) ? restored : clone(initial);
    if (!next.id && !next.requestId) next.requestId = crypto.randomUUID();
    return next;
  });
  const [baseline, setBaseline] = useState(JSON.stringify(initial));
  const [pending, setPending] = useState("");
  const [error, setError] = useState("");
  const toast = useToast();
  const [wish, setWish] = useState("");
  const [expanded, setExpanded] = useState(() => initial.steps[0]?.id || "");
  const [confirm, setConfirm] = useState("");
  const dragId = useRef(null), lock = useRef(false), confirmTrigger = useRef(null);
  const askConfirm = (value) => (event) => { confirmTrigger.current = event.currentTarget; setConfirm(value); };
  const dirty = JSON.stringify(draft) !== baseline;
  const conflict = draft.id && (!latest || latest.version !== draft.version);

  const change = (next) => {
    setDraft(next);
    writeDraft(keyFor(next), next);
  };
  const changeStep = (id, fields) => change({ ...draft, steps: draft.steps.map((s) => s.id === id ? { ...s, ...fields } : s) });
  const reorder = (from, to) => {
    if (from < 0 || to < 0 || to >= draft.steps.length || from === to) return;
    const steps = [...draft.steps], [moving] = steps.splice(from, 1);
    steps.splice(to, 0, moving);
    change({ ...draft, steps });
    toast.success(uiFormat("已将「{0}」移到第 {1} 步", [moving.title, to + 1]));
  };
  const removeStep = (id) => {
    const steps = draft.steps.filter((s) => s.id !== id).map((s) => ({ ...s,
      next: s.next === id ? "$next" : s.next, retry: s.retry === id ? "$stay" : s.retry }));
    change({ ...draft, steps });
    setConfirm("");
    toast.success(ui("已移除步骤；原本指向它的分支已恢复为顺序继续或留在原步。"));
  };
  async function save(forChat = false) {
    if (lock.current) return;
    lock.current = true;
    setPending(forChat ? "chat" : "save");
    setError("");
    writeDraft(keyFor(draft), draft);
    try {
      const saved = !draft.id || dirty ? await call("workflow.save", draft) : draft;
      setDraft(saved);
      setBaseline(JSON.stringify(saved));
      writeDraft(keyFor(draft), null);
      writeDraft(keyFor(saved), null);
      onSaved(saved, forChat);
      toast.success(ui("学习流已保存；正在进行的学习保持原来的步骤。"));
      if (forChat) {
        await askInChat(workflowDesignPrompt({ template: saved, wish: wish.trim() }));
        toast.info(ui("请求已准备好，请在主对话确认发送。保存后可载入更新的流程。"));
      }
    } catch (err) { setError(err.message); }
    finally { lock.current = false; setPending(""); }
  }
  const reloadLatest = () => {
    if (!latest) return;
    setDraft(clone(latest));
    setBaseline(JSON.stringify(latest));
    writeDraft(keyFor(draft), null);
    setConfirm("");
    toast.success(ui("已载入最新流程。"));
  };

  return <section className="wf-editor">
    <div className="wf-topline"><Button variant="link" size="sm" onClick={onBack} disabled={!!pending}>{ui("← 学习流工作台")}</Button><span className="muted small">{dirty ? ui("修改暂存于此设备") : draft.id ? ui("已保存") : ui("新学习流")}</span></div>
    <PageHeader className="wf-heading" title={ui("编排学习流")} description={ui("把适合自己的学习方式排成步骤。拖动排序，也可使用上移、下移。")} />
    {error && <p className="wf-error" role="alert">{error}{" "}{ui("你的输入已保留。")}</p>}
    {conflict && <div className="wf-notice" role="status">
      <p>{latest ? ui("这条学习流已在其他地方更新。本地输入已保留，保存前请先核对。") : ui("原学习流已被删除。你仍可把当前内容另存为新流程。")}</p>
      {latest && <details><summary>{ui("查看最新版本")}</summary><p>{latest.title} · {latest.description}</p><ol>{latest.steps.map((s) => <li key={s.id}>{s.title}</li>)}</ol></details>}
      <div className="wf-actions">
        {latest && <Button disabled={!!pending} onClick={(event) => dirty ? askConfirm("reload")(event) : reloadLatest()}>{ui("载入最新版本")}</Button>}
        <Button disabled={!!pending} onClick={() => { const { id: _id, version: _version, requestId: _requestId, ...copy } = draft; change({ ...copy, requestId: crypto.randomUUID() }); }}>{ui("将本地修改另存为新流程")}</Button>
      </div>
      {confirm === "reload" && <InlineConfirm tone="warning" title={ui("载入后将替换当前未保存的修改。")} confirmLabel={ui("确认载入")} cancelLabel={ui("保留输入")}
        returnFocusRef={confirmTrigger} onConfirm={reloadLatest} onCancel={() => setConfirm("")} />}
    </div>}
    <fieldset disabled={!!pending} className="wf-fields">
      <label>{ui("学习流名称")}<input maxLength={60} value={draft.title} placeholder={ui("例如：先讲懂，再练题")} onChange={(e) => change({ ...draft, title: e.target.value })} /></label>
      <label>{ui("适合什么时候使用")}<textarea rows={2} maxLength={400} value={draft.description} placeholder={ui("例如：学一个陌生主题，先建立结构，再独立解释和应用。")} onChange={(e) => change({ ...draft, description: e.target.value })} /></label>
    </fieldset>
    <div className="wf-section-head"><h2>{ui("学习步骤")}</h2><span className="muted small">{draft.steps.length} / 16</span></div>
    <ol className="wf-step-list">
      {draft.steps.map((step, index) => {
        const component = components.find((c) => c.kind === step.kind), open = expanded === step.id;
        return <li key={step.id} className={"wf-step-editor" + (open ? " is-open" : "")}
          onDragOver={(e) => { if (dragId.current) { e.preventDefault(); e.dataTransfer.dropEffect = "move"; } }}
          onDrop={(e) => { e.preventDefault(); reorder(draft.steps.findIndex((s) => s.id === dragId.current), index); dragId.current = null; }}>
          <div className="wf-step-head">
            <span className="wf-drag" title={ui("拖动这个手柄排序")} draggable={!pending} onDragStart={(e) => {
              dragId.current = step.id; e.dataTransfer.effectAllowed = "move"; e.dataTransfer.setData("text/plain", step.id);
            }} onDragEnd={() => { dragId.current = null; }} aria-hidden="true"><Icon name="list" size={16} /></span>
            <span className="wf-step-number">{String(index + 1).padStart(2, "0")}</span>
            <button type="button" className="wf-step-toggle" aria-expanded={open} onClick={() => setExpanded(open ? "" : step.id)}><strong>{step.title || ui("未命名步骤")}</strong><small>{component?.title}</small></button>
            <div className="wf-step-move"><IconButton icon={TURN_UP} size="sm" disabled={!!pending || index === 0} label={uiFormat("上移第 {0} 步 {1}", [index + 1, step.title])} onClick={() => reorder(index, index - 1)} /><IconButton icon={TURN_DOWN} size="sm" disabled={!!pending || index === draft.steps.length - 1} label={uiFormat("下移第 {0} 步 {1}", [index + 1, step.title])} onClick={() => reorder(index, index + 1)} /></div>
          </div>
          {open && <div className="wf-step-body"><fieldset className="wf-fields" disabled={!!pending}>
            <p className="muted small">{component?.description}</p>
            <label>{ui("步骤名称")}<input value={step.title} maxLength={60} onChange={(e) => changeStep(step.id, { title: e.target.value })} /></label>
            <label>{ui("学习要求")}<textarea rows={3} value={step.instructions} maxLength={2000} onChange={(e) => changeStep(step.id, { instructions: e.target.value })} /></label>
            <label>{step.kind === "recall" ? ui("复述提示（不要放参考答案）") : ui("预置材料（可选）")}<textarea rows={4} maxLength={20000} value={step.content} placeholder={ui("支持 Markdown；也可在学习时请主对话补充材料。")} onChange={(e) => changeStep(step.id, { content: e.target.value })} /></label>
            {step.kind === "practice" && <label>{ui("本步练习题数")}<input type="number" min={QUESTION_COUNT.min} max={QUESTION_COUNT.max} value={step.count} onChange={(e) => changeStep(step.id, { count: Number(e.target.value) })} /></label>}
            <div className="wf-branch-fields"><BranchSelect label={ui("完成或跳过后")} value={step.next} onChange={(next) => changeStep(step.id, { next })} steps={draft.steps} /><BranchSelect label={ui("还需巩固时")} value={step.retry} onChange={(retry) => changeStep(step.id, { retry })} steps={draft.steps} /></div>
          </fieldset>
          <Button variant="danger" disabled={!!pending || draft.steps.length <= 1} onClick={askConfirm(step.id)}>{ui("移除这一步")}</Button>
          {confirm === step.id && <InlineConfirm title={uiFormat("移除「{0}」及其预置内容？", [step.title])} confirmLabel={ui("确认移除")}
            returnFocusRef={confirmTrigger} onConfirm={() => removeStep(step.id)} onCancel={() => setConfirm("")} />}
          </div>}
        </li>;
      })}
    </ol>
    <div className="wf-components"><h3>{ui("添加一个组件")}</h3><div className="wf-component-options">{components.map((c) => <Button key={c.kind} icon="plus" size="sm" disabled={!!pending || draft.steps.length >= 16} title={c.description} onClick={() => { const step = newStep(c); change({ ...draft, steps: [...draft.steps, step] }); setExpanded(step.id); }}>{c.title}</Button>)}</div></div>
    <div className="wf-savebar"><Button variant="primary" disabled={!!pending || !draft.title.trim() || !draft.steps.length || !!conflict} onClick={() => save()}>{pending === "save" ? ui("保存中…") : ui("保存学习流")}</Button><span className="small muted" role="status">{ui("每次学习都会保留开始时的流程副本。")}</span></div>
    <details className="wf-chat"><summary>{ui("让主对话帮我调整")}</summary><label>{ui("想怎样学")}<textarea rows={3} value={wish} onChange={(e) => setWish(e.target.value)} maxLength={2000} placeholder={ui("例如：先看例子，再讲原理；不用选择题，改成口述复盘。")} /></label><Button disabled={!!pending || !!conflict || !draft.title.trim()} onClick={() => save(true)}>{pending === "chat" ? ui("交接中…") : ui("保存并交给主对话")}</Button></details>
  </section>;
}

export function StartFlow({ template, listing, call, askInChat, onRefresh, onStarted, onBack }) {
  const [topic, setTopic] = useState("");
  const [selected, setSelected] = useState(new Set());
  const [skeletonId, setSkeletonId] = useState("");
  const [query, setQuery] = useState("");
  const [pending, setPending] = useState(false), [error, setError] = useState("");
  const toast = useToast();
  const [skeletonPending, setSkeletonPending] = useState(false);
  const requestId = useRef(crypto.randomUUID()), lock = useRef(false);
  const topicMap = new Map(listing.topics.map((item) => [item.key, item]));
  const scope = [...selected].flatMap((key) => topicMap.get(key)?.decks.map((deck) => ({ deckId: deck.deckId, topic: deck.topic })) || []);
  const skeleton = listing.skeletons.find((item) => item.id === skeletonId);
  const selectedCount = [...selected].reduce((total, key) => total + (topicMap.get(key)?.count || 0), 0);
  const toggle = (keys, on, title) => {
    const next = new Set(selected);
    keys.forEach((key) => on ? next.add(key) : next.delete(key));
    setSelected(next);
    if (!topic.trim() && title && on) setTopic(title);
    requestId.current = crypto.randomUUID();
  };
  const matched = listing.topics.filter((t) => !query.trim() || `${t.topic} ${t.decks.map((d) => d.deckTitle).join(" ")}`.toLowerCase().includes(query.toLowerCase()));
  async function generateSkeleton() {
    if (lock.current || !scope.length) return;
    lock.current = true; setSkeletonPending(true); setError("");
    try {
      await askInChat(workflowSkeletonPrompt({ topic, topicNames: [...selected].map((key) => topicMap.get(key)?.topic).filter(Boolean),
        workflowTitle: template.title, scope }));
      toast.info(ui("请求已准备好，请在主对话发送。骨架保存后会出现在列表，选中后即可开始学习。"));
    } catch (err) { setError(err.message); }
    finally { lock.current = false; setSkeletonPending(false); }
  }
  async function start(event) {
    event.preventDefault();
    if (lock.current) return;
    lock.current = true; setPending(true); setError("");
    try {
      const session = await call("workflow.session.start", { templateId: template.id, topic: topic.trim(),
        ...(scope.length || !skeleton ? { scope } : {}), ...(skeletonId ? { skeletonId } : {}), requestId: requestId.current });
      onStarted(session);
    } catch (err) { setError(err.message); }
    finally { lock.current = false; setPending(false); }
  }
  return <section className="wf-start"><div className="wf-topline"><Button variant="link" size="sm" onClick={onBack} disabled={pending || skeletonPending}>{ui("← 学习流工作台")}</Button></div>
    <PageHeader className="wf-heading" eyebrow={ui("开始一次学习")} title={template.title} description={template.description || ui("选定主题，从第一步开始。")} />
    {error && <p className="wf-error" role="alert">{error}</p>}
    <form onSubmit={start}><fieldset disabled={pending || skeletonPending} className="wf-fields">
      <details className="wf-scope" open={listing.topics.length > 0}>
        <summary>{ui("选择已有主题与题目范围")}{" "}<span className="muted">{selected.size ? uiFormat("· 已选 {0} 个主题 / {1} 题", [selected.size, selectedCount]) : ui("· 可选")}</span></summary>
        <p className="muted small">{ui("未选题目时，使用关联骨架的题目范围；都不选则从阅读、讲解和复述开始。")}</p>
        {listing.topics.length ? <><input type="search" aria-label={ui("搜索学习主题")} value={query} onChange={(e) => setQuery(e.target.value)} placeholder={ui("搜索主题或题组")} />
          {(listing.groups?.groups || []).length > 0 && <div className="wf-topic-groups" aria-label={ui("按主题组选择")}>{listing.groups.groups.map((g) => <label key={g.id}><input type="checkbox" checked={g.topics.length > 0 && g.topics.every((key) => selected.has(key))} ref={(el) => { if (el) el.indeterminate = g.topics.some((key) => selected.has(key)) && !g.topics.every((key) => selected.has(key)); }} onChange={(e) => toggle(g.topics, e.target.checked, g.title)} /><span>{g.title}</span><small>{uiFormat("{0} 个主题", [g.topics.length])}</small></label>)}</div>}
          <div className="wf-topic-list">{matched.map((t) => <label key={t.key}><input type="checkbox" checked={selected.has(t.key)} onChange={(e) => toggle([t.key], e.target.checked, t.topic)} /><span>{t.topic}<small title={t.decks.map((d) => d.deckTitle).join(" · ")}>{t.decks.slice(0, 2).map((d) => d.deckTitle).join(" · ")}{t.decks.length > 2 ? uiFormat(" 等 {0} 个题组", [t.decks.length]) : ""}</small></span><small>{uiFormat("{0} 题", [t.count])}</small></label>)}{!matched.length && <p className="muted">{ui("没有匹配的主题。")}</p>}</div>
        </> : <p className="muted small">{ui("学习库还没有题目主题。填写上方主题即可开始。")}</p>}
      </details>
      <label>{ui("这次学什么")}<input required maxLength={120} value={topic} placeholder={ui("写一个主题；没有题目也可以开始")} onChange={(e) => { setTopic(e.target.value); requestId.current = crypto.randomUUID(); }} /></label>
      <label>{ui("关联知识骨架")}<select value={skeletonId} onChange={(e) => { setSkeletonId(e.target.value); requestId.current = crypto.randomUUID(); if (!topic.trim()) setTopic(listing.skeletons.find((s) => s.id === e.target.value)?.title || ""); }}><option value="">{ui("暂不关联")}</option>{listing.skeletons.map((s) => <option key={s.id} value={s.id}>{s.title}</option>)}</select></label>
      <div className="wf-skeleton-shortcut">
        <div className="wf-actions"><Button onClick={generateSkeleton} disabled={!scope.length}>{skeletonPending ? ui("准备请求…") : ui("生成知识骨架")}</Button><Button onClick={() => void onRefresh()}>{ui("刷新骨架")}</Button></div>
        <p className="muted small" role="status">{scope.length ? ui("根据上方已选题目，交给主对话生成；保存后可在这里关联。") : ui("先选择上方题目范围，即可生成对应骨架；也可以直接关联已有骨架。")}</p>
      </div>
    </fieldset><div className="wf-route-preview" aria-label={ui("本次学习步骤")}>{template.steps.map((s, index) => <span key={s.id}>{index + 1}. {s.title}</span>)}</div><Button type="submit" variant="primary" disabled={pending || skeletonPending || !topic.trim()}>{pending ? ui("进入中…") : ui("进入学习 Portal")}</Button></form>
  </section>;
}

export default function Workflows({ data, openSession, openRun, initialListing = null, renderRelated }) {
  const { call, askInChat } = useStudy();
  const language = useUiLanguage();
  useInjectCss(css, "study-workflows");
  const [listing, setListing] = useState(initialListing), [screen, setScreen] = useState(() => openSession ? { kind: "portal", id: openSession } : { kind: "list" });
  const [error, setError] = useState(""), [pending, setPending] = useState("");
  const toast = useToast();
  const [confirm, setConfirm] = useState(""), [wish, setWish] = useState("");
  const [goal, setGoal] = useState(""), quickRequest = useRef(null);
  const [autoSkeleton, setAutoSkeleton] = useState(() => { try { return localStorage.getItem("study-workflow-auto-skeleton") !== "0"; } catch { return true; } });
  const toggleSkeleton = (value) => { setAutoSkeleton(value); try { localStorage.setItem("study-workflow-auto-skeleton", value ? "1" : "0"); } catch {} };
  const lock = useRef(false), request = useRef(0), reading = useRef(null), live = useRef(true), confirmTrigger = useRef(null);
  const askConfirm = (value) => (event) => { confirmTrigger.current = event.currentTarget; setConfirm(value); };
  const root = data?.root || "local";
  const invalidateReads = useCallback(() => { ++request.current; reading.current = null; }, []);
  const refresh = useCallback(async ({ automatic = false } = {}) => {
    if (automatic && (reading.current !== null || lock.current)) return;
    const token = ++request.current;
    reading.current = token;
    try { const result = await call("workflow.list"); if (live.current && token === request.current) { setListing(result); setError(""); } }
    catch (err) { if (live.current && token === request.current) setError(err.message); }
    finally { if (reading.current === token) reading.current = null; }
  }, [call]);
  useEffect(() => { live.current = true; return () => { live.current = false; invalidateReads(); }; }, [invalidateReads]);
  useEffect(() => {
    if (screen.kind !== "portal") void refresh();
    return invalidateReads;
  }, [refresh, data?.revision, screen.kind, invalidateReads, language]);
  usePolling(() => refresh({ automatic: true }), { intervalMs: 10000, enabled: screen.kind !== "portal" });
  const back = () => { setScreen({ kind: "list" }); setConfirm(""); void refresh(); };
  async function remove(type, item) {
    if (lock.current) return;
    lock.current = true; ++request.current; setPending(item.id); setError("");
    try { await call(type === "template" ? "workflow.delete" : "workflow.session.delete", { id: item.id, version: item.version }); setConfirm(""); await refresh(); }
    catch (err) { setError(err.message); }
    finally { lock.current = false; setPending(""); }
  }
  async function ask() {
    if (lock.current) return;
    lock.current = true; setPending("chat"); setError("");
    try { await askInChat(workflowDesignPrompt({ wish: wish.trim() })); toast.info(ui("请求已准备好，请在主对话确认发送。保存后的学习流会出现在这里。")); }
    catch (err) { setError(err.message); }
    finally { lock.current = false; setPending(""); }
  }
  const edit = (template, key = template.id) => setScreen({ kind: "edit", template: clone(template), key });
  // One sentence in, a running session out: AI picks the material and order.
  async function quickStart(event) {
    event.preventDefault();
    const text = goal.trim();
    if (!text || lock.current) return;
    lock.current = true; setPending("quick"); setError("");
    if (quickRequest.current?.goal !== text) quickRequest.current = { goal: text, id: crypto.randomUUID() };
    try {
      const result = await call("workflow.quickstart", { goal: text, requestId: quickRequest.current.id, skeleton: autoSkeleton });
      quickRequest.current = null; setGoal("");
      setScreen({ kind: "portal", id: result.session.id });
    } catch (err) { setError(err.message); }
    finally { lock.current = false; setPending(""); }
  }
  const modelReady = data?.modelReady !== false;
  // The most recent unfinished session, so coming back is one click.
  const unfinished = listing?.sessions.filter((s) => s.status !== "completed").sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
  const suggestions = [data?.next?.topic && `${data.next.deckTitle} · ${data.next.topic}`, data?.focus?.course && uiFormat("{0} 的核心概念", [data.focus.course])].filter(Boolean);
  if (screen.kind === "portal") return <>{renderRelated?.(screen.id)}<WorkflowPortal key={screen.id} id={screen.id} libraryKey={root} onOpenRun={openRun} onOpenSession={(sessionId) => setScreen({ kind: "portal", id: sessionId })} onBack={back} revision={data?.revision} /></>;
  if (!listing) return <section className="page workflow-page"><PageHeader title={ui("学习流")} />{error ? <><p className="wf-error" role="alert">{error}</p><Button onClick={refresh}>{ui("重新读取")}</Button></> : <p className="muted" role="status">{ui("正在读取学习流…")}</p>}</section>;
  if (screen.kind === "edit") return <section className="page workflow-page"><FlowEditor key={screen.key} initial={screen.template} components={listing.components} latest={listing.templates.find((t) => t.id === screen.template.id)} storageKey={`study-workflow-draft:${root}`} draftName={screen.key} call={call} askInChat={askInChat} onSaved={(template, forChat) => { setScreen((prev) => forChat ? { ...prev, template } : { kind: "list" }); setListing((prev) => ({ ...prev, templates: prev.templates.some((t) => t.id === template.id) ? prev.templates.map((t) => t.id === template.id ? template : t) : [...prev.templates, template] })); void refresh(); }} onBack={back} /></section>;
  if (screen.kind === "start") return <section className="page workflow-page"><StartFlow template={screen.template} listing={listing} call={call} askInChat={askInChat} onRefresh={refresh} onStarted={(s) => setScreen({ kind: "portal", id: s.id })} onBack={back} /></section>;
  return <section className="page workflow-page">
    <PageHeader title={ui("今天想学什么？")} description={ui("说一句就行。AI 从你的学习库里挑材料、排顺序、讲给你听，再看你的复述；你只管往下走。")} />
    <form className="wf-quick" onSubmit={quickStart} data-tour="workflows-main">
      {data?.focus?.course != null && (data.focus.courses || []).length > 0 && <p className="wf-quick-course muted small">{uiFormat("会在当前课程「{0}」的资料里选；想换课程，开始后在下一页点「换课程」。", [data.focus.course || ui("未分类课程")])}</p>}
      {!modelReady && <p className="wf-quick-hint">{ui("还没有连接模型：会按主题和题组名匹配材料；讲解、复述反馈和后台骨架要连接模型后才会出现。")}</p>}
      {unfinished && <p className="wf-quick-resume"><span className="muted">{ui("上次学到一半")}</span><Button variant="link" size="sm" iconEnd="arrow-right" disabled={!!pending} onClick={() => setScreen({ kind: "portal", id: unfinished.id })}>{[unfinished.topic, unfinished.stepIndex >= 0 && uiFormat("第 {0}/{1} 步 {2}", [unfinished.stepIndex + 1, unfinished.stepCount, unfinished.stepTitle]), ui("接着学")].filter(Boolean).join(" · ")}</Button></p>}
      <div className="wf-quick-row">
        <input value={goal} onChange={(e) => setGoal(e.target.value)} maxLength={500} disabled={!!pending}
          aria-label={ui("想学什么")} placeholder={ui("例如：弄懂 Platform Engineering 里的平台团队职责")} />
        <Button type="submit" variant="primary" className="wf-quick-go" disabled={!!pending || !goal.trim()}>{pending === "quick" ? ui("AI 正在准备…") : ui("开始学 →")}</Button>
      </div>
      {suggestions.length > 0 && <div className="wf-quick-suggest">{suggestions.map((text) =>
        <Button variant="link" size="sm" key={text} disabled={!!pending} onClick={() => setGoal(text)}>{text}</Button>)}</div>}
      {pending === "quick" && <p className="wf-quick-status" role="status"><span className="wf-pulse" aria-hidden="true" />{modelReady ? ui("AI 正在从你的学习库里挑选相关主题、排好顺序…") : ui("正在按名称匹配学习库里的主题…")}</p>}
      {modelReady && <label className="wf-quick-option"><input type="checkbox" checked={autoSkeleton} disabled={!!pending} onChange={(e) => toggleSkeleton(e.target.checked)} />{ui("没有现成的知识骨架时，在后台按本次范围生成一份")}<span className="muted">{ui("不用等它，学习照常开始")}</span></label>}
    </form>
    {error && <p className="wf-error" role="alert">{error}</p>}
    <div className="wf-section-head"><h2>{ui("学习记录")}</h2></div>
    {!listing.sessions.length ? <p className="muted wf-empty">{ui("还没有学习记录。在上面说一句想学什么，学到一半离开也会留在这里，随时接着学。")}</p> : <ul className="wf-session-list">{[...listing.sessions].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).map((s) => <li key={s.id}><div><strong>{s.topic}</strong><p>{s.title} · {s.status === "completed" ? ui("本次学习已结束") : s.stepTitle}</p><small className="muted">{s.status === "completed" ? "" : `${ui(STATUS[s.status])} · `}{when(s.updatedAt)}</small></div><div className="wf-actions"><Button disabled={!!pending} onClick={() => setScreen({ kind: "portal", id: s.id })}>{s.status === "completed" ? ui("查看记录") : ui("继续学习")}</Button><Button disabled={!!pending} aria-label={uiFormat("删除学习记录 {0}", [s.topic])} onClick={askConfirm(`session:${s.id}`)}>{ui("删除")}</Button></div>{confirm === `session:${s.id}` && <InlineConfirm title={ui("删除这次学习的笔记和进度？闪卡练习历史会保留。")} confirmLabel={ui("确认删除")}
        busy={!!pending} returnFocusRef={confirmTrigger} onConfirm={() => remove("session", s)} onCancel={() => setConfirm("")} />}</li>)}</ul>}
    <details className="wf-advanced"><summary>{ui("高级：自定义学习步骤")}</summary>
      <p className="muted small">{ui("想按自己的顺序学时再用。自定义的学习流用「使用」开始，需要自己选主题与范围。")}</p>
    <div className="wf-section-head"><h2>{ui("我的学习流")}{" "}<span className="muted">{listing.templates.length} / {listing.limit}</span></h2><Button icon="plus" size="sm" disabled={!!pending || listing.templates.length >= listing.limit} onClick={() => edit({ title: "", description: "", steps: [newStep(listing.components[0])] }, "new")}>{ui("自己拼一条")}</Button></div>
    {listing.templates.length >= listing.limit && <p className="muted small">{ui("已保存五条。可以修改现有流程，或删除一条后再创建。")}</p>}
    <div className="wf-template-list">{listing.templates.map((template, index) => <article className="wf-template-row" key={template.id}>
      <span className="wf-row-number" aria-hidden="true">{String(index + 1).padStart(2, "0")}</span><div className="wf-template-copy"><h3>{template.title}</h3><p>{template.description || uiFormat("{0} 个学习步骤", [template.steps.length])}</p><div className="wf-route-preview">{template.steps.map((s) => <span key={s.id}>{s.title}</span>)}</div></div>
      <div className="wf-actions"><Button onClick={() => setScreen({ kind: "start", template })} disabled={!!pending}>{ui("使用")}</Button><Button onClick={() => edit(template)} disabled={!!pending}>{ui("编辑")}</Button><Button aria-label={uiFormat("删除学习流 {0}", [template.title])} onClick={askConfirm(`template:${template.id}`)} disabled={!!pending}>{ui("删除")}</Button></div>
      {confirm === `template:${template.id}` && <InlineConfirm title={uiFormat("删除「{0}」？已开始的学习记录会保留。", [template.title])} confirmLabel={ui("确认删除")}
        busy={!!pending} returnFocusRef={confirmTrigger} onConfirm={() => remove("template", template)} onCancel={() => setConfirm("")} />}
    </article>)}</div>
    <article className="wf-suggested"><div><p className="wf-eyebrow">{ui("从一条建议开始")}</p><h3>{listing.suggested.title}</h3><p className="muted">{listing.suggested.description}</p><div className="wf-route-preview">{listing.suggested.steps.map((s) => <span key={s.id}>{s.title}</span>)}</div></div><Button disabled={!!pending || listing.templates.length >= listing.limit} onClick={() => edit(listing.suggested, "suggested")}>{ui("编辑并保存这条流程")}</Button></article>
    <details className="wf-chat"><summary>{ui("和主对话一起拼")}</summary><label>{ui("告诉它你的学习习惯")}<textarea rows={3} value={wish} onChange={(e) => setWish(e.target.value)} maxLength={2000} placeholder={ui("例如：我只想轻松刷卡，最后记一下容易忘的点；或先讲例子，再让我口述。")} /></label><Button disabled={!!pending || listing.templates.length >= listing.limit} onClick={ask}>{ui("在主对话中设计")}</Button><p className="muted small" role="status">{ui("主对话与这里编辑同一份流程；你可以随时再手动调整。")}</p></details>
    </details>
  </section>;
}
