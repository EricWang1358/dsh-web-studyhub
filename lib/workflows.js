import { createHash } from "node:crypto";
import { id as makeId } from "./util.js";
import { WORKFLOW_COMPONENTS, WORKFLOW_LIMIT, defaultWorkflow } from "./workflow-contract.js";
import { skeletonTopics, topicGroupsView } from "./skeleton.js";

const now = () => new Date().toISOString();
const kinds = new Set(WORKFLOW_COMPONENTS.map((c) => c.kind));
const reservedStepIds = new Set([...Object.getOwnPropertyNames(Object.prototype), "prototype"]);
const fingerprint = (payload) => createHash("sha256").update(JSON.stringify(payload)).digest("hex");
const text = (v, name, max, required = false) => {
  if (v === undefined && !required) return "";
  if (typeof v !== "string" || v.length > max || (required && !v.trim())) throw new Error(`${name}需要${required ? "非空" : ""}文本，最多 ${max} 字`);
  return v.trim();
};
const find = (items, id, name) => {
  const value = items.find((v) => v.id === id);
  if (!value) throw new Error(`${name}不存在，请刷新`);
  return value;
};
const checkVersion = (record, version) => {
  if (record.version !== version) throw new Error("内容已更新，请刷新后重试，避免覆盖另一处修改");
};
function resolveStepEdge(steps, index, edge) {
  if (edge === "$next") return steps[index + 1]?.id;
  if (edge === "$stay") return steps[index].id;
  if (edge === "$finish") return null;
  return edge;
}
export function validateWorkflow(input) {
  const title = text(input?.title, "流程名称", 60, true);
  const description = text(input.description, "流程说明", 400);
  if (!Array.isArray(input.steps) || input.steps.length < 1 || input.steps.length > 16) throw new Error("每条流程需要 1–16 个步骤");
  const ids = new Set();
  const steps = input.steps.map((s) => {
    const id = text(s?.id, "步骤 ID", 80, true);
    if (!/^[a-zA-Z0-9_-]+$/.test(id) || ids.has(id)) throw new Error("步骤 ID 需要唯一且只含字母、数字、下划线或连字符");
    if (reservedStepIds.has(id)) throw new Error("步骤 ID 不能使用对象的保留名称，请更换名称");
    ids.add(id);
    if (!kinds.has(s.kind)) throw new Error("未知学习组件");
    const count = s.count ?? 10;
    if (!Number.isInteger(count) || count < 1 || count > 50) throw new Error("练习题数应为 1–50");
    return { id, kind: s.kind, title: text(s.title, "步骤名称", 60, true),
      instructions: text(s.instructions, "步骤要求", 2000), content: text(s.content, "学习材料", 20000),
      next: s.next ?? "$next", retry: s.retry ?? "$stay", count };
  });
  for (const step of steps) for (const edge of [step.next, step.retry])
    if (!["$next", "$stay", "$finish"].includes(edge) && !ids.has(edge)) throw new Error("步骤分支指向了不存在的步骤");
  // Intentional remediation loops are allowed; disconnected steps are a typo.
  const reachable = new Set();
  const visit = (id) => {
    if (!id || reachable.has(id)) return;
    reachable.add(id);
    const at = steps.findIndex((s) => s.id === id), step = steps[at];
    for (const edge of [step.next, step.retry]) visit(resolveStepEdge(steps, at, edge));
  };
  visit(steps[0].id);
  if (reachable.size !== steps.length) throw new Error("存在无法到达的步骤，请调整分支或移除它");
  return { title, description, steps };
}
export function workflowList(s) {
  const topics = skeletonTopics(s);
  return { limit: WORKFLOW_LIMIT, components: WORKFLOW_COMPONENTS, suggested: defaultWorkflow(),
    templates: s.workflowTemplates, sessions: s.workflowSessions.map(({ id, template, topic, currentStepId, status, updatedAt, version }) =>
      ({ id, title: template.title, topic, currentStepId, stepTitle: template.steps.find((x) => x.id === currentStepId)?.title,
        stepIndex: template.steps.findIndex((x) => x.id === currentStepId), stepCount: template.steps.length,
        status, updatedAt, version })), topics, groups: topicGroupsView(s, topics),
    skeletons: (s.skeletons || []).map(({ id, title, scope }) => ({ id, title, scope })) };
}
export function saveWorkflow(s, a) {
  const requestId = a.requestId === undefined ? "" : text(a.requestId, "请求 ID", 100, true);
  const payload = validateWorkflow(a);
  if (!a.id && requestId) {
    const existing = s.workflowTemplates.find((x) => x.requestId === requestId);
    if (existing) {
      const originalFingerprint = existing.requestFingerprint || fingerprint(validateWorkflow(existing));
      if (fingerprint(payload) !== originalFingerprint)
        throw new Error("这次创建请求已保存，但内容与首次保存不同。请刷新后编辑已保存的流程，或将本地修改另存为新流程");
      existing.requestFingerprint = originalFingerprint;
      return existing;
    }
  }
  const before = a.id ? find(s.workflowTemplates, a.id, "学习流") : null;
  if (before) checkVersion(before, a.version);
  else if (s.workflowTemplates.length >= WORKFLOW_LIMIT) throw new Error("最多保存 5 条学习流，请先编辑或删除已有流程");
  // The creation fingerprint survives edits, so an ambiguous create retry cannot
  // silently replace a revised local draft with a differently saved resource.
  const savedRequestId = before?.requestId || requestId;
  const template = { ...payload, id: before?.id || makeId(), version: (before?.version || 0) + 1, updatedAt: now(),
    ...(savedRequestId ? { requestId: savedRequestId, requestFingerprint: before?.requestId
      ? before.requestFingerprint || fingerprint(validateWorkflow(before)) : fingerprint(payload) } : {}) };
  if (before) s.workflowTemplates[s.workflowTemplates.indexOf(before)] = template;
  else s.workflowTemplates.push(template);
  return template;
}
export function deleteWorkflow(s, a) {
  const template = find(s.workflowTemplates, a.id, "学习流");
  checkVersion(template, a.version);
  s.workflowTemplates = s.workflowTemplates.filter((x) => x !== template);
  return { deleted: true };
}
export const getSession = (s, id) => find(s.workflowSessions, id, "学习记录");
export const currentStep = (session) => find(session.template.steps, session.currentStepId, "当前步骤");
export function editableSession(s, a) {
  const session = getSession(s, a.id);
  checkVersion(session, a.version);
  if (session.status !== "active") throw new Error("请先继续这次学习");
  return session;
}
export function workflowContext(s, a = {}) {
  const session = a.sessionId ? getSession(s, a.sessionId) : null;
  return { contract: "流程模板与学习记录独立；不得代替学习者作答、自评或把步骤完成称为掌握。最多保存五条。修改模板只影响下次开始；正在学习的副本保持不变。",
    api: { save: "workflow.save {id?,version?,title,description,steps:[{id,kind,title,instructions,content,next,retry,count}]}，更新时必须使用最新 version。next/retry 为 $next/$stay/$finish 或步骤 ID。",
      material: "workflow.session.material {id,version,stepId,mode?,content?|edits?}：只补充当前步骤的材料，不能写学习者回答。先读 workflow.context {sessionId} 看本步已有材料。mode 默认 append（追加到已有材料之后，不要重复已有内容）；修改已有段落用 mode:\"edit\"，edits:[{find,replace}]，find 必须是原文中唯一的一段；只有学习者要求重写时才用 mode:\"replace\"。旧版本都会保留，学习者可以恢复。称呼步骤用标题，不要用内部 ID。内容依据资料，补充知识明确标注。",
      teaching: "workflow.teaching.start {id,version,stepId,mode:lesson|example|steps|prerequisite|improve,request?}：为当前 lesson 步骤后台生成或补讲。workflow.session.get 查看状态；workflow.teaching.undo {id,version,stepId} 撤销上次改写。不得代替学习者作答或推进进度。",
      read: "workflow.list / workflow.context {sessionId?} / workflow.session.get {id}" },
    ...workflowList(s), session,
    ...(session ? { resources: sessionResources(s, session) } : {}) };
}
function scopeInput(s, input = []) {
  if (!Array.isArray(input) || input.length > 200) throw new Error("学习范围最多 200 项");
  return input.map((ref) => {
    const deck = find(s.decks, ref?.deckId, "题组");
    if (deck.archived) throw new Error("请先恢复归档题组");
    if (ref.cardId) find(deck.cards, ref.cardId, "题目");
    if (ref.topic && !deck.cards.some((c) => (c.topic || "未分类") === ref.topic)) throw new Error("主题已变化，请重新选择");
    return { deckId: deck.id, ...(ref.topic ? { topic: ref.topic } : {}), ...(ref.cardId ? { cardId: ref.cardId } : {}) };
  });
}
export function startSession(s, a) {
  const requestId = text(a.requestId, "请求 ID", 100, true);
  const previous = s.workflowSessions.find((r) => r.requestId === requestId);
  if (previous) return previous;
  const template = find(s.workflowTemplates, a.templateId, "学习流");
  validateWorkflow(template);
  const skeleton = a.skeletonId ? find(s.skeletons, a.skeletonId, "知识骨架") : null;
  const session = { id: makeId(), requestId, template: structuredClone(template),
    topic: text(a.topic, "学习主题", 120, true), scope: scopeInput(s, a.scope ?? skeleton?.scope ?? []),
    skeletonId: skeleton?.id || null, currentStepId: template.steps[0].id,
    status: "active", version: 1, records: {}, history: [], createdAt: now(), updatedAt: now() };
  s.workflowSessions.push(session);
  return session;
}
export function sessionCards(s, session) {
  const byDeck = new Map();
  for (const ref of session.scope) {
    if (!byDeck.has(ref.deckId)) byDeck.set(ref.deckId, []);
    byDeck.get(ref.deckId).push(ref);
  }
  if (!byDeck.size) return [];
  return s.decks.filter((d) => !d.archived && byDeck.has(d.id)).flatMap((deck) => deck.cards.filter((card) => !card.suspended && byDeck.get(deck.id).some((r) =>
    r.cardId ? r.cardId === card.id : !r.topic || r.topic === (card.topic || "未分类")))
    .map((card) => ({ deckId: deck.id, card })));
}
/** Progress of the current practice step's round, which runs in the ordinary review page. */
function practiceSummary(s, session) {
  const step = session.template.steps.find((x) => x.id === session.currentStepId);
  const runId = step?.kind === "practice" ? session.records[step.id]?.runId : null;
  const run = runId && s.runs.find((r) => r.id === runId);
  if (!run) return null;
  const firsts = run.entries.filter((e) => !e.retry);
  return { runId: run.id, total: firsts.length, answered: firsts.filter((e) => e.feedback).length,
    correct: firsts.filter((e) => e.feedback?.grade >= 3).length,
    // The same rule advancing uses: every question, retries included, has been answered.
    complete: run.entries.length > 0 && run.entries.every((e) => e.feedback), ended: !!run.closedAt };
}
export function sessionResources(s, session) {
  const cards = sessionCards(s, session);
  const sourceIds = new Set(cards.flatMap(({ card }) => (card.citations || []).map((c) => c.sourceId)));
  // What the session covers, in words: topic names, or a deck's title when the whole deck is in scope.
  const titles = new Map(s.decks.map((d) => [d.id, d.title]));
  const scopeTopics = [...new Set(session.scope.map((ref) => ref.topic || titles.get(ref.deckId)).filter(Boolean))];
  return { skeleton: s.skeletons.find((x) => x.id === session.skeletonId) || null, cardCount: cards.length,
    scopeTopics: scopeTopics.slice(0, 24), scopeTopicCount: scopeTopics.length, practice: practiceSummary(s, session),
    // Short evidence excerpts are shared; bulk source text stays in the source context.
    readings: cards.slice(0, 16).map(({ deckId, card }) => ({ deckId, cardId: card.id, topic: card.topic,
      explanation: card.explanation, citations: card.citations })),
    sources: s.sources.filter((x) => sourceIds.has(x.id)).map(({ id, title }) => ({ id, title })) };
}
const touch = (session) => { session.version++; session.updatedAt = now(); return session; };
export function saveSessionRecord(s, a) {
  const session = editableSession(s, a), step = currentStep(session);
  session.records[step.id] = { ...session.records[step.id], output: text(a.output, "学习记录", 20000), updatedAt: now() };
  return touch(session);
}
const MATERIAL_LIMIT = 40000, MATERIAL_HISTORY = 10;
const count = (haystack, needle) => haystack.split(needle).length - 1;
/** Keep the material a step had before it changes, newest last, so no save loses it. */
export function keepMaterial(record, before, by) {
  if (!before) return;
  record.materialHistory = [...(record.materialHistory || []), { content: before, by: by || record.materialBy || "chat",
    at: record.materialAt || record.updatedAt || now() }].slice(-MATERIAL_HISTORY);
}
/* Material the main chat adds to the current step. It edits rather than
   overwrites: append (the default once a step has material) adds below,
   edit replaces unique passages, and replace rewrites only when asked. */
export function saveSessionMaterial(s, a) {
  const session = editableSession(s, a), step = currentStep(session);
  if (a.stepId !== step.id) throw new Error("步骤已变化，请重新读取学习上下文");
  const record = { ...session.records[step.id] };
  const before = record.content ?? step.content ?? "";
  const mode = a.mode ?? (before ? "append" : "replace");
  if (!["append", "edit", "replace"].includes(mode)) throw new Error("mode 只能是 append、edit 或 replace");
  let next;
  if (mode === "edit") {
    if (!Array.isArray(a.edits) || !a.edits.length || a.edits.length > 20) throw new Error("edit 需要 1–20 处 edits:[{find,replace}]");
    next = before;
    a.edits.forEach((change, i) => {
      const find = typeof change?.find === "string" ? change.find : "";
      if (!find || typeof change.replace !== "string") throw new Error(`第 ${i + 1} 处修改需要 find 与 replace 文本`);
      const hits = count(next, find);
      if (!hits) throw new Error(`第 ${i + 1} 处修改在本步材料里找不到原文，请先用 workflow.session.get 读取最新材料`);
      if (hits > 1) throw new Error(`第 ${i + 1} 处修改的原文出现了 ${hits} 次，请带上更多上下文使它唯一`);
      next = next.replace(find, () => change.replace);
    });
  } else {
    const content = text(a.content, "补充讲解", 20000, true);
    next = mode === "append" && before ? `${before.trimEnd()}

${content}` : content;
  }
  if (next.length > MATERIAL_LIMIT) throw new Error("本步材料将超过 4 万字，请用 edit 精简，或在学习者要求时用 replace 重写");
  if (next === before) return session;
  keepMaterial(record, before);
  Object.assign(record, { content: next, materialBy: "chat", materialAt: now(), updatedAt: now() });
  // History now holds every earlier version; the one-step teaching undo would skip the chat's edit.
  delete record.previousContent;
  delete record.previousCitations;
  if (mode === "replace") delete record.citations;
  session.records[step.id] = record;
  return touch(session);
}
/** Bring back an earlier version of the current step's material; the current one is kept too. */
export function restoreSessionMaterial(s, a) {
  const session = editableSession(s, a), step = currentStep(session);
  if (a.stepId !== step.id) throw new Error("步骤已变化，请刷新");
  const record = { ...session.records[step.id] };
  const history = record.materialHistory || [];
  const index = Number.isInteger(a.index) ? a.index : -1;
  if (index < 0 || index >= history.length) throw new Error("没有这一版材料");
  const chosen = history[index];
  record.materialHistory = history.filter((_, i) => i !== index);
  keepMaterial(record, record.content ?? step.content ?? "");
  Object.assign(record, { content: chosen.content, materialBy: chosen.by, materialAt: now(), updatedAt: now() });
  delete record.previousContent;
  delete record.previousCitations;
  session.records[step.id] = record;
  return touch(session);
}
/* Go back to a step already walked, or return to where the learner had got
   to. Navigation only: no activity is recorded and no record changes. */
export function goToStep(s, a) {
  const session = editableSession(s, a);
  const target = session.template.steps.find((x) => x.id === a.stepId);
  if (!target) throw new Error("没有这一步");
  if (target.id === session.currentStepId) return session;
  if (!session.records[target.id]?.outcome && target.id !== session.resumeStepId) throw new Error("只能回到已经走过的步骤");
  const here = session.currentStepId;
  // Leaving the frontier: remember it, so the learner can jump straight back.
  if (!session.records[here]?.outcome) session.resumeStepId = here;
  session.currentStepId = target.id;
  if (session.resumeStepId === target.id) delete session.resumeStepId;
  return touch(session);
}
export function advanceSession(s, a) {
  const existing = getSession(s, a.id);
  const requestId = text(a.requestId, "请求 ID", 100, true);
  if (existing.history.some((h) => h.requestId === requestId)) return existing;
  const session = editableSession(s, a), step = currentStep(session);
  if (!["done", "needs_work", "skipped"].includes(a.outcome)) throw new Error("请选择本步结果");
  if (session.history.length >= 1000) throw new Error("本次学习记录已满，请开始新的学习");
  const record = session.records[step.id] || {};
  const output = a.output === undefined ? record.output || "" : text(a.output, "学习记录", 20000);
  if (["recall", "reflection"].includes(step.kind) && a.outcome === "done" && !output.trim()) throw new Error("请先写下你的回答或总结");
  if (step.kind === "practice" && a.outcome === "done") {
    const run = s.runs.find((r) => r.id === record.runId);
    if (!run?.entries.length || run.entries.some((e) => !e.feedback)) throw new Error("请先完成本步练习，或选择稍后再学");
  }
  const event = { requestId, stepId: step.id, outcome: a.outcome, output, at: now(), evidence: "learner-reported",
    ...(record.runId ? { practiceRunId: record.runId } : {}) };
  session.history.push(event);
  session.records[step.id] = { ...record, output, outcome: a.outcome, updatedAt: event.at };
  const edge = a.outcome === "needs_work" ? step.retry : step.next;
  const index = session.template.steps.findIndex((x) => x.id === step.id);
  const next = resolveStepEdge(session.template.steps, index, edge);
  if (step.kind === "practice" && record.runId) {
    const run = s.runs.find((r) => r.id === record.runId);
    if (run) run.closedAt ||= event.at;
  }
  // A remediation loop means a new activity, not reuse of yesterday's answers.
  if (next && session.records[next]) {
    delete session.records[next].outcome;
    if (session.template.steps.find((x) => x.id === next)?.kind === "practice") delete session.records[next].runId;
  }
  session.currentStepId = next || step.id;
  if (session.resumeStepId === session.currentStepId) delete session.resumeStepId;
  if (!next) { session.status = "completed"; session.completedAt = now(); }
  return touch(session);
}
export function setSessionStatus(s, a) {
  const session = getSession(s, a.id);
  checkVersion(session, a.version);
  if (!["active", "paused"].includes(a.status) || session.status === "completed") throw new Error("已完成的学习不能暂停或继续");
  session.status = a.status;
  return touch(session);
}
export function deleteSession(s, a) {
  const session = getSession(s, a.id);
  checkVersion(session, a.version);
  // End only this portal's unfinished practice; historical attempts are retained.
  for (const run of s.runs.filter((r) => r.workflowSessionId === session.id)) run.closedAt ||= now();
  s.workflowSessions = s.workflowSessions.filter((x) => x !== session);
  return { deleted: true };
}

/* One-line start: a session built from the built-in flow, trimmed to what the
   chosen material supports. The learner's stated goal completes the goal step,
   so the first screen is already content. */
export function quickTemplate({ skeleton = false, practice = false } = {}) {
  const base = defaultWorkflow();
  const steps = base.steps.filter((step) => (step.kind !== "skeleton" || skeleton) && (step.kind !== "practice" || practice));
  const lesson = steps.find((step) => step.kind === "lesson");
  // Retelling that needs work goes back to the explanation, not round in place.
  for (const step of steps) if (step.kind === "recall" && lesson) step.retry = lesson.id;
  return { id: "builtin-guided", version: 1, title: "AI 带学", description: "说出想学什么，AI 选材料、讲解、看复述，你按节奏继续。", steps };
}
export function startQuickSession(s, a) {
  const requestId = text(a.requestId, "请求 ID", 100, true);
  const previous = s.workflowSessions.find((r) => r.requestId === requestId);
  if (previous) return previous;
  const goal = text(a.goal, "学习目标", 500, true);
  const scope = scopeInput(s, a.scope || []);
  const skeleton = a.skeletonId ? find(s.skeletons, a.skeletonId, "知识骨架") : null;
  const draft = { scope };
  const template = quickTemplate({ skeleton: !!skeleton, practice: sessionCards(s, draft).length > 0 });
  const [first, second] = template.steps;
  const at = now();
  const output = `本次目标：${goal}`;
  const pickedBy = ["ai", "match", "course", "none"].includes(a.method) ? a.method : null;
  const session = { id: makeId(), requestId, template, guided: true, goal, ...(pickedBy ? { pickedBy } : {}),
    topic: text(a.title || goal, "学习主题", 120, true).slice(0, 120), scope, skeletonId: skeleton?.id || null,
    currentStepId: second?.id || first.id, status: "active", version: 1,
    records: { [first.id]: { output, outcome: "done", updatedAt: at } },
    history: [{ requestId: `${requestId}:goal`, stepId: first.id, outcome: "done", output, at, evidence: "learner-stated" }],
    createdAt: at, updatedAt: at };
  s.workflowSessions.push(session);
  return session;
}
/** Topics that plausibly match a goal, for when no model is connected. */
export function matchTopics(topics, goal) {
  const words = String(goal).toLowerCase().split(/[\s,，、。;；/|:：()（）]+/).filter((w) => w.length >= 2);
  if (!words.length) return [];
  return topics.map((t) => {
    const hay = [t.topic, ...t.decks.flatMap((d) => [d.deckTitle, d.folder])].join(" ").toLowerCase();
    return { t, score: words.filter((w) => hay.includes(w)).length };
  }).filter((x) => x.score).sort((a, b) => b.score - a.score || b.t.count - a.t.count).map((x) => x.t);
}
