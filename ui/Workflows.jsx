import React, { useCallback, useEffect, useRef, useState } from "react";
import WorkflowPortal from "./WorkflowPortal.jsx";
import { useInjectCss } from "./shared.js";
import css from "./workflows.css";

const clone = (value) => JSON.parse(JSON.stringify(value));
const when = (value) => new Date(value).toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
const STATUS = { active: "学习中", paused: "已暂停", completed: "已结束" };
const readDraft = (key) => { try { return JSON.parse(localStorage.getItem(key)); } catch { return null; } };
const writeDraft = (key, value) => { try { value ? localStorage.setItem(key, JSON.stringify(value)) : localStorage.removeItem(key); } catch {} };
const newStep = (component) => ({ id: `step-${crypto.randomUUID()}`, kind: component.kind, title: component.title,
  instructions: component.prompt, content: "", next: "$next", retry: "$stay", count: 10 });

function designPrompt(template, wish) {
  return `请帮我${template ? `调整学习流「${template.title}」` : "设计一条个性化学习流"}。${wish ? `我的要求：${wish}` : "先了解我想怎样学习，再组合合适的组件。"}\n` +
    "先用 study_workspace 的 workflow.context 读取组件规范、已有学习流和主题。最多保存五条，保持闪卡、知识骨架等独立功能可用。\n" +
    (template ? `目标流程 id: ${template.id}，我当前看到的 version: ${template.version}。先重新读取最新版本；若已有新的修改，先向我说明差异，避免覆盖。\n` : "默认模板只是参考；在明确我的需求后创建。\n") +
    "用 workflow.save 保存完整流程，更新已有流程需带最新 id/version。流程可包含目标、骨架、讲解、复述、练习、总结，设置有意义的 next/retry 分支。不要代替我作答或评定掌握。不要修改已经开始的学习副本。保存后说明调整了哪些步骤。";
}

function BranchSelect({ label, value, onChange, steps }) {
  return <label>{label}<select value={value} onChange={(event) => onChange(event.target.value)}>
    <option value="$next">按顺序进入下一步</option>
    <option value="$stay">留在当前步骤</option>
    <option value="$finish">结束本次学习</option>
    {steps.map((step, index) => <option key={step.id} value={step.id}>{index + 1}. {step.title || "未命名步骤"}</option>)}
  </select></label>;
}

function FlowEditor({ initial, components, latest, storageKey, draftName, call, askInChat, onSaved, onBack }) {
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
  const [message, setMessage] = useState("");
  const [wish, setWish] = useState("");
  const [expanded, setExpanded] = useState(() => initial.steps[0]?.id || "");
  const [confirm, setConfirm] = useState("");
  const dragId = useRef(null), lock = useRef(false);
  const dirty = JSON.stringify(draft) !== baseline;
  const conflict = draft.id && (!latest || latest.version !== draft.version);

  const change = (next) => {
    setDraft(next);
    writeDraft(keyFor(next), next);
    setMessage("");
  };
  const changeStep = (id, fields) => change({ ...draft, steps: draft.steps.map((s) => s.id === id ? { ...s, ...fields } : s) });
  const reorder = (from, to) => {
    if (from < 0 || to < 0 || to >= draft.steps.length || from === to) return;
    const steps = [...draft.steps], [moving] = steps.splice(from, 1);
    steps.splice(to, 0, moving);
    change({ ...draft, steps });
    setMessage(`已将「${moving.title}」移到第 ${to + 1} 步`);
  };
  const removeStep = (id) => {
    const steps = draft.steps.filter((s) => s.id !== id).map((s) => ({ ...s,
      next: s.next === id ? "$next" : s.next, retry: s.retry === id ? "$stay" : s.retry }));
    change({ ...draft, steps });
    setConfirm("");
    setMessage("已移除步骤；原本指向它的分支已恢复为顺序继续或留在原步。");
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
      setMessage("学习流已保存；正在进行的学习保持原来的步骤。");
      if (forChat) {
        await askInChat(designPrompt(saved, wish.trim()));
        setMessage("请求已准备好，请在主对话确认发送。保存后可载入更新的流程。");
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
    setMessage("已载入最新流程。");
  };

  return <section className="wf-editor">
    <div className="wf-topline"><button type="button" onClick={onBack} disabled={!!pending}>← 学习流工作台</button><span className="muted small">{dirty ? "修改暂存于此设备" : draft.id ? "已保存" : "新学习流"}</span></div>
    <header className="wf-heading"><div><h1>编排学习流</h1><p className="muted">把适合自己的学习方式排成步骤。拖动排序，也可使用上移、下移。</p></div></header>
    {error && <p className="wf-error" role="alert">{error} 你的输入已保留。</p>}
    {conflict && <div className="wf-notice" role="status">
      <p>{latest ? "这条学习流已在其他地方更新。本地输入已保留，保存前请先核对。" : "原学习流已被删除。你仍可把当前内容另存为新流程。"}</p>
      {latest && <details><summary>查看最新版本</summary><p>{latest.title} · {latest.description}</p><ol>{latest.steps.map((s) => <li key={s.id}>{s.title}</li>)}</ol></details>}
      <div className="wf-actions">
        {latest && <button type="button" disabled={!!pending} onClick={() => dirty ? setConfirm("reload") : reloadLatest()}>载入最新版本</button>}
        <button type="button" disabled={!!pending} onClick={() => { const { id: _id, version: _version, requestId: _requestId, ...copy } = draft; change({ ...copy, requestId: crypto.randomUUID() }); }}>将本地修改另存为新流程</button>
      </div>
      {confirm === "reload" && <div className="wf-confirm"><span>载入后将替换当前未保存的修改。</span><button type="button" onClick={reloadLatest}>确认载入</button><button type="button" onClick={() => setConfirm("")}>保留输入</button></div>}
    </div>}
    <fieldset disabled={!!pending} className="wf-fields">
      <label>学习流名称<input maxLength={60} value={draft.title} placeholder="例如：先讲懂，再练题" onChange={(e) => change({ ...draft, title: e.target.value })} /></label>
      <label>适合什么时候使用<textarea rows={2} maxLength={400} value={draft.description} placeholder="例如：学一个陌生主题，先建立结构，再独立解释和应用。" onChange={(e) => change({ ...draft, description: e.target.value })} /></label>
    </fieldset>
    <div className="wf-section-head"><h2>学习步骤</h2><span className="muted small">{draft.steps.length} / 16</span></div>
    <ol className="wf-step-list">
      {draft.steps.map((step, index) => {
        const component = components.find((c) => c.kind === step.kind), open = expanded === step.id;
        return <li key={step.id} className={"wf-step-editor" + (open ? " is-open" : "")}
          onDragOver={(e) => { if (dragId.current) { e.preventDefault(); e.dataTransfer.dropEffect = "move"; } }}
          onDrop={(e) => { e.preventDefault(); reorder(draft.steps.findIndex((s) => s.id === dragId.current), index); dragId.current = null; }}>
          <div className="wf-step-head">
            <span className="wf-drag" title="拖动这个手柄排序" draggable={!pending} onDragStart={(e) => {
              dragId.current = step.id; e.dataTransfer.effectAllowed = "move"; e.dataTransfer.setData("text/plain", step.id);
            }} onDragEnd={() => { dragId.current = null; }} aria-hidden="true">⠿</span>
            <span className="wf-step-number">{String(index + 1).padStart(2, "0")}</span>
            <button type="button" className="wf-step-toggle" aria-expanded={open} onClick={() => setExpanded(open ? "" : step.id)}><strong>{step.title || "未命名步骤"}</strong><small>{component?.title}</small></button>
            <div className="wf-step-move"><button type="button" disabled={!!pending || index === 0} aria-label={`上移第 ${index + 1} 步 ${step.title}`} onClick={() => reorder(index, index - 1)}>↑</button><button type="button" disabled={!!pending || index === draft.steps.length - 1} aria-label={`下移第 ${index + 1} 步 ${step.title}`} onClick={() => reorder(index, index + 1)}>↓</button></div>
          </div>
          {open && <div className="wf-step-body"><fieldset className="wf-fields" disabled={!!pending}>
            <p className="muted small">{component?.description}</p>
            <label>步骤名称<input value={step.title} maxLength={60} onChange={(e) => changeStep(step.id, { title: e.target.value })} /></label>
            <label>学习要求<textarea rows={3} value={step.instructions} maxLength={2000} onChange={(e) => changeStep(step.id, { instructions: e.target.value })} /></label>
            <label>{step.kind === "recall" ? "复述提示（不要放参考答案）" : "预置材料（可选）"}<textarea rows={4} maxLength={20000} value={step.content} placeholder="支持 Markdown；也可在学习时请主对话补充材料。" onChange={(e) => changeStep(step.id, { content: e.target.value })} /></label>
            {step.kind === "practice" && <label>本步练习题数<input type="number" min={1} max={50} value={step.count} onChange={(e) => changeStep(step.id, { count: Number(e.target.value) })} /></label>}
            <div className="wf-branch-fields"><BranchSelect label="完成或跳过后" value={step.next} onChange={(next) => changeStep(step.id, { next })} steps={draft.steps} /><BranchSelect label="还需巩固时" value={step.retry} onChange={(retry) => changeStep(step.id, { retry })} steps={draft.steps} /></div>
          </fieldset>
          <button type="button" className="wf-danger" disabled={!!pending || draft.steps.length <= 1} onClick={() => setConfirm(step.id)}>移除这一步</button>
          {confirm === step.id && <div className="wf-confirm"><span>移除「{step.title}」及其预置内容？</span><button type="button" onClick={() => removeStep(step.id)}>确认移除</button><button type="button" onClick={() => setConfirm("")}>取消</button></div>}
          </div>}
        </li>;
      })}
    </ol>
    <div className="wf-components"><h3>添加一个组件</h3><div className="wf-component-options">{components.map((c) => <button type="button" key={c.kind} disabled={!!pending || draft.steps.length >= 16} title={c.description} onClick={() => { const step = newStep(c); change({ ...draft, steps: [...draft.steps, step] }); setExpanded(step.id); }}><span aria-hidden="true">＋</span> {c.title}</button>)}</div></div>
    <div className="wf-savebar"><button type="button" className="primary" disabled={!!pending || !draft.title.trim() || !draft.steps.length || !!conflict} onClick={() => save()}>{pending === "save" ? "保存中…" : "保存学习流"}</button><span className="small muted" role="status">{message || "每次学习都会保留开始时的流程副本。"}</span></div>
    <details className="wf-chat"><summary>让主对话帮我调整</summary><label>想怎样学<textarea rows={3} value={wish} onChange={(e) => setWish(e.target.value)} maxLength={2000} placeholder="例如：先看例子，再讲原理；不用选择题，改成口述复盘。" /></label><button type="button" disabled={!!pending || !!conflict || !draft.title.trim()} onClick={() => save(true)}>{pending === "chat" ? "交接中…" : "保存并交给主对话"}</button></details>
  </section>;
}

function StartFlow({ template, listing, call, askInChat, onRefresh, onStarted, onBack }) {
  const [topic, setTopic] = useState("");
  const [selected, setSelected] = useState(new Set());
  const [skeletonId, setSkeletonId] = useState("");
  const [query, setQuery] = useState("");
  const [pending, setPending] = useState(false), [error, setError] = useState("");
  const [skeletonPending, setSkeletonPending] = useState(false), [skeletonNotice, setSkeletonNotice] = useState("");
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
    lock.current = true; setSkeletonPending(true); setError(""); setSkeletonNotice("");
    try {
      await askInChat(
        "请为我即将开始的学习生成一份知识骨架。\n学习主题：" + (topic.trim() || [...selected].map(key => topicMap.get(key)?.topic).filter(Boolean).join("、")) +
        "\n学习流：" + template.title + "\n已选题目范围 scope：" + JSON.stringify(scope) + "\n" +
        "使用给定 scope，先调用 study_workspace 的 skeleton.context 获取题目与引用证据，需要更多依据时用 source.search。\n" +
        "依据资料组织概念、关键特征、层级与关系；同一概念合并，线性过程与分支讲清楚，不相关的连通分量保持分开。补充知识要明确标注。\n" +
        "调用 skeleton.save 保存一份新骨架，payload 为 {skeleton:{title,scope,overview,classNote,nodes:[{id,term,meaning,attributes,parent?,cards:[{deckId,cardId}]}],relations:[{from,to,type,note?}],sequences:[]}}。type 使用 part-of/causes/contrasts/prerequisite/example-of/related；动态过程需要时补充 sequences。\n" +
        "仅生成骨架，不修改题目、学习流或已有骨架，不代替我进入学习。保存后告诉我骨架名称，我会在当前页面关联它。"
      );
      setSkeletonNotice("请求已准备好，请在主对话发送。骨架保存后会出现在列表，选中后即可开始学习。");
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
  return <section className="wf-start"><button type="button" onClick={onBack} disabled={pending || skeletonPending}>← 学习流工作台</button>
    <header className="wf-heading"><div><p className="wf-eyebrow">开始一次学习</p><h1>{template.title}</h1><p className="muted">{template.description || "选定主题，从第一步开始。"}</p></div></header>
    {error && <p className="wf-error" role="alert">{error}</p>}
    <form onSubmit={start}><fieldset disabled={pending || skeletonPending} className="wf-fields">
      <details className="wf-scope" open={listing.topics.length > 0}>
        <summary>选择已有主题与题目范围 <span className="muted">{selected.size ? `· 已选 ${selected.size} 个主题 / ${selectedCount} 题` : "· 可选"}</span></summary>
        <p className="muted small">未选题目时，使用关联骨架的题目范围；都不选则从阅读、讲解和复述开始。</p>
        {listing.topics.length ? <><input type="search" aria-label="搜索学习主题" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="搜索主题或题组" />
          {(listing.groups?.groups || []).length > 0 && <div className="wf-topic-groups" aria-label="按主题组选择">{listing.groups.groups.map((g) => <label key={g.id}><input type="checkbox" checked={g.topics.length > 0 && g.topics.every((key) => selected.has(key))} ref={(el) => { if (el) el.indeterminate = g.topics.some((key) => selected.has(key)) && !g.topics.every((key) => selected.has(key)); }} onChange={(e) => toggle(g.topics, e.target.checked, g.title)} /><span>{g.title}</span><small>{g.topics.length} 个主题</small></label>)}</div>}
          <div className="wf-topic-list">{matched.map((t) => <label key={t.key}><input type="checkbox" checked={selected.has(t.key)} onChange={(e) => toggle([t.key], e.target.checked, t.topic)} /><span>{t.topic}<small title={t.decks.map((d) => d.deckTitle).join(" · ")}>{t.decks.slice(0, 2).map((d) => d.deckTitle).join(" · ")}{t.decks.length > 2 ? ` 等 ${t.decks.length} 个题组` : ""}</small></span><small>{t.count} 题</small></label>)}{!matched.length && <p className="muted">没有匹配的主题。</p>}</div>
        </> : <p className="muted small">学习库还没有题目主题。填写上方主题即可开始。</p>}
      </details>
      <label>这次学什么<input required maxLength={120} value={topic} placeholder="写一个主题；没有题目也可以开始" onChange={(e) => { setTopic(e.target.value); requestId.current = crypto.randomUUID(); }} /></label>
      <label>关联知识骨架<select value={skeletonId} onChange={(e) => { setSkeletonId(e.target.value); requestId.current = crypto.randomUUID(); if (!topic.trim()) setTopic(listing.skeletons.find((s) => s.id === e.target.value)?.title || ""); }}><option value="">暂不关联</option>{listing.skeletons.map((s) => <option key={s.id} value={s.id}>{s.title}</option>)}</select></label>
      <div className="wf-skeleton-shortcut">
        <div className="wf-actions"><button type="button" onClick={generateSkeleton} disabled={!scope.length}>{skeletonPending ? "准备请求…" : "生成知识骨架"}</button><button type="button" onClick={() => void onRefresh()}>刷新骨架</button></div>
        <p className="muted small" role="status">{skeletonNotice || (scope.length ? "根据上方已选题目，交给主对话生成；保存后可在这里关联。" : "先选择上方题目范围，即可生成对应骨架；也可以直接关联已有骨架。")}</p>
      </div>
    </fieldset><div className="wf-route-preview" aria-label="本次学习步骤">{template.steps.map((s, index) => <span key={s.id}>{index + 1}. {s.title}</span>)}</div><button type="submit" className="primary" disabled={pending || skeletonPending || !topic.trim()}>{pending ? "进入中…" : "进入学习 Portal"}</button></form>
  </section>;
}

export default function Workflows({ call, askInChat, data }) {
  useInjectCss(css, "study-workflows");
  const [listing, setListing] = useState(null), [screen, setScreen] = useState({ kind: "list" });
  const [error, setError] = useState(""), [pending, setPending] = useState("");
  const [confirm, setConfirm] = useState(""), [wish, setWish] = useState(""), [message, setMessage] = useState("");
  const [goal, setGoal] = useState(""), quickRequest = useRef(null);
  const [autoSkeleton, setAutoSkeleton] = useState(() => { try { return localStorage.getItem("study-workflow-auto-skeleton") !== "0"; } catch { return true; } });
  const toggleSkeleton = (value) => { setAutoSkeleton(value); try { localStorage.setItem("study-workflow-auto-skeleton", value ? "1" : "0"); } catch {} };
  const lock = useRef(false), request = useRef(0), reading = useRef(null), live = useRef(true);
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
  }, [refresh, data?.revision, screen.kind, invalidateReads]);
  useEffect(() => {
    if (screen.kind === "portal") return;
    const sync = () => { if (document.visibilityState !== "hidden") void refresh({ automatic: true }); };
    const timer = setInterval(sync, 10000);
    document.addEventListener("visibilitychange", sync);
    return () => { clearInterval(timer); document.removeEventListener("visibilitychange", sync); };
  }, [refresh, screen.kind]);
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
    try { await askInChat(designPrompt(null, wish.trim())); setMessage("请求已准备好，请在主对话确认发送。保存后的学习流会出现在这里。"); }
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
  const suggestions = [data?.next?.topic && `${data.next.deckTitle} · ${data.next.topic}`, data?.focus?.course && `${data.focus.course} 的核心概念`].filter(Boolean);
  if (screen.kind === "portal") return <WorkflowPortal key={screen.id} id={screen.id} libraryKey={root} call={call} askInChat={askInChat} onBack={back} revision={data?.revision} />;
  if (!listing) return <section className="page workflow-page"><h1>学习流</h1>{error ? <><p className="wf-error" role="alert">{error}</p><button type="button" onClick={refresh}>重新读取</button></> : <p className="muted" role="status">正在读取学习流…</p>}</section>;
  if (screen.kind === "edit") return <section className="page workflow-page"><FlowEditor key={screen.key} initial={screen.template} components={listing.components} latest={listing.templates.find((t) => t.id === screen.template.id)} storageKey={`study-workflow-draft:${root}`} draftName={screen.key} call={call} askInChat={askInChat} onSaved={(template, forChat) => { setScreen((prev) => forChat ? { ...prev, template } : { kind: "list" }); setListing((prev) => ({ ...prev, templates: prev.templates.some((t) => t.id === template.id) ? prev.templates.map((t) => t.id === template.id ? template : t) : [...prev.templates, template] })); void refresh(); }} onBack={back} /></section>;
  if (screen.kind === "start") return <section className="page workflow-page"><StartFlow template={screen.template} listing={listing} call={call} askInChat={askInChat} onRefresh={refresh} onStarted={(s) => setScreen({ kind: "portal", id: s.id })} onBack={back} /></section>;
  return <section className="page workflow-page">
    <form className="wf-quick" onSubmit={quickStart}>
      <p className="wf-eyebrow">AI 带学</p>
      <h1>今天想学什么？</h1>
      <p className="muted">说一句就行。AI 从你的学习库里挑材料、排顺序、讲给你听，再看你的复述；你只管往下走。</p>
      <div className="wf-quick-row">
        <input value={goal} onChange={(e) => setGoal(e.target.value)} maxLength={500} disabled={!!pending}
          aria-label="想学什么" placeholder="例如：弄懂 Platform Engineering 里的平台团队职责" />
        <button type="submit" className="primary" disabled={!!pending || !goal.trim()}>{pending === "quick" ? "AI 正在准备…" : "开始学 →"}</button>
      </div>
      {suggestions.length > 0 && <div className="wf-quick-suggest">{suggestions.map((text) =>
        <button type="button" key={text} className="link-btn" disabled={!!pending} onClick={() => setGoal(text)}>{text}</button>)}</div>}
      <label className="wf-quick-option"><input type="checkbox" checked={autoSkeleton} disabled={!!pending} onChange={(e) => toggleSkeleton(e.target.checked)} />没有现成的知识骨架时，在后台按本次范围生成一份<span className="muted">不用等它，学习照常开始</span></label>
    </form>
    {error && <p className="wf-error" role="alert">{error}</p>}
    <div className="wf-section-head"><h2>学习记录</h2></div>
    {!listing.sessions.length ? <p className="muted wf-empty">还没有学习记录。在上面说一句想学什么，学到一半离开也会留在这里，随时接着学。</p> : <ul className="wf-session-list">{[...listing.sessions].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).map((s) => <li key={s.id}><div><strong>{s.topic}</strong><p>{s.title} · {s.status === "completed" ? "本次学习已结束" : s.stepTitle}</p><small className="muted">{STATUS[s.status]} · {when(s.updatedAt)}</small></div><div className="wf-actions"><button type="button" disabled={!!pending} onClick={() => setScreen({ kind: "portal", id: s.id })}>{s.status === "completed" ? "查看记录" : "继续学习"}</button><button type="button" disabled={!!pending} aria-label={`删除学习记录 ${s.topic}`} onClick={() => setConfirm(`session:${s.id}`)}>删除</button></div>{confirm === `session:${s.id}` && <div className="wf-confirm"><span>删除这次学习的笔记和进度？闪卡练习历史会保留。</span><button type="button" className="wf-danger" disabled={!!pending} onClick={() => remove("session", s)}>确认删除</button><button type="button" disabled={!!pending} onClick={() => setConfirm("")}>取消</button></div>}</li>)}</ul>}
    <details className="wf-advanced"><summary>高级：自定义学习步骤</summary>
      <p className="muted small">想按自己的顺序学时再用。自定义的学习流用「使用」开始，需要自己选主题与范围。</p>
    <div className="wf-section-head"><h2>我的学习流 <span className="muted">{listing.templates.length} / {listing.limit}</span></h2><button type="button" disabled={!!pending || listing.templates.length >= listing.limit} onClick={() => edit({ title: "", description: "", steps: [newStep(listing.components[0])] }, "new")}>＋ 自己拼一条</button></div>
    {listing.templates.length >= listing.limit && <p className="muted small">已保存五条。可以修改现有流程，或删除一条后再创建。</p>}
    <div className="wf-template-list">{listing.templates.map((template, index) => <article className="wf-template-row" key={template.id}>
      <span className="wf-row-number" aria-hidden="true">{String(index + 1).padStart(2, "0")}</span><div className="wf-template-copy"><h3>{template.title}</h3><p>{template.description || `${template.steps.length} 个学习步骤`}</p><div className="wf-route-preview">{template.steps.map((s) => <span key={s.id}>{s.title}</span>)}</div></div>
      <div className="wf-actions"><button type="button" onClick={() => setScreen({ kind: "start", template })} disabled={!!pending}>使用</button><button type="button" onClick={() => edit(template)} disabled={!!pending}>编辑</button><button type="button" aria-label={`删除学习流 ${template.title}`} onClick={() => setConfirm(`template:${template.id}`)} disabled={!!pending}>删除</button></div>
      {confirm === `template:${template.id}` && <div className="wf-confirm"><span>删除「{template.title}」？已开始的学习记录会保留。</span><button type="button" className="wf-danger" disabled={!!pending} onClick={() => remove("template", template)}>确认删除</button><button type="button" disabled={!!pending} onClick={() => setConfirm("")}>取消</button></div>}
    </article>)}</div>
    <article className="wf-suggested"><div><p className="wf-eyebrow">从一条建议开始</p><h3>{listing.suggested.title}</h3><p className="muted">{listing.suggested.description}</p><div className="wf-route-preview">{listing.suggested.steps.map((s) => <span key={s.id}>{s.title}</span>)}</div></div><button type="button" disabled={!!pending || listing.templates.length >= listing.limit} onClick={() => edit(listing.suggested, "suggested")}>编辑并保存这条流程</button></article>
    <details className="wf-chat"><summary>和主对话一起拼</summary><label>告诉它你的学习习惯<textarea rows={3} value={wish} onChange={(e) => setWish(e.target.value)} maxLength={2000} placeholder="例如：我只想轻松刷卡，最后记一下容易忘的点；或先讲例子，再让我口述。" /></label><button type="button" disabled={!!pending || listing.templates.length >= listing.limit} onClick={ask}>在主对话中设计</button><p className="muted small" role="status">{message || "主对话与这里编辑同一份流程；你可以随时再手动调整。"}</p></details>
    </details>
  </section>;
}
