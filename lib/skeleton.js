import { id } from "./util.js";
import { checkScope } from "./prereq.js";
import { cognitiveLevel, evidenceWindows } from "./coach.js";
import { isSlayDeck } from "./slay.js";

/* 知识骨架：把散在多个题组里的同一主题的名词串成结构（上位概念、因果、
   组成、对比、前置），每个名词一句话讲清含义，并挂回对应的题。
   这里只做确定性的部分：跨题组的主题清单、零 token 质量检测、交给主会话
   的精简上下文，以及骨架的校验与存取。骨架本身由主会话的 agent 设计后
   通过 skeleton.save 保存，难度高，不走后台轻量请求。 */

export const LINT_CODES = Object.freeze({
  "echo-explanation": "选项解析只重复了选项文字",
  "membership-stem": "题干考课件页码或列表归属",
  "thin-explanation": "讲解太短或只重复答案",
  "isolated-recall": "孤立记忆题：没有关联任何题",
});
export const RELATION_TYPES = Object.freeze({
  "part-of": "属于",
  causes: "导致",
  contrasts: "对比",
  prerequisite: "前置",
  "example-of": "例子",
  related: "相关",
});
const MAX_SCOPE_CARDS = 200;
const MAX_NODES = 80;
const MAX_RELATIONS = 160;
const MAX_SKELETONS = 60;
const MAX_ATTRIBUTES = 5;
const MAX_SEQUENCES = 4;
const MAX_PARTICIPANTS = 8;
const MAX_STEPS = 24;
export const STEP_KINDS = Object.freeze({ call: "调用/触发", return: "返回/结果", async: "异步/事件" });

const norm = (text) => String(text ?? "").toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, "");
const clip = (text, n) => {
  const s = String(text ?? "").replace(/\s+/g, " ").trim();
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
};
const topicOf = (card) => card.topic || "未分类";
const usableDecks = (s) => s.decks.filter((d) => !d.archived && !isSlayDeck(d));

/** Topics across decks, merged by normalized name so one topic split over decks is one row. */
export function skeletonTopics(s, { samples = 0 } = {}) {
  const rows = new Map();
  for (const deck of usableDecks(s))
    for (const card of deck.cards) {
      if (card.suspended) continue;
      const name = topicOf(card),
        key = norm(name) || name;
      if (!rows.has(key)) rows.set(key, { key, topic: name, count: 0, decks: new Map() });
      const row = rows.get(key);
      row.count++;
      const entry = row.decks.get(deck.id) || { deckId: deck.id, deckTitle: deck.title, folder: deck.folder || "", topic: name, count: 0 };
      entry.count++;
      row.decks.set(deck.id, entry);
      if (samples && (row.samples ||= []).length < samples)
        row.samples.push(clip(String(card.cloze?.text || card.prompt).replace(/\{\{[^{}]+\}\}/g, "＿＿"), 80));
    }
  return [...rows.values()]
    .map((r) => ({ ...r, decks: [...r.decks.values()] }))
    .sort((a, b) => b.decks.length - a.decks.length || b.count - a.count || a.topic.localeCompare(b.topic, "zh-CN"));
}

/** Cards a scope of {deckId, topic?} | {deckId, cardId} refers to, deduplicated, in deck order. */
export function scopeCards(s, scope) {
  const refs = checkScope(s, scope);
  if (!refs.length) throw new Error("先选择至少一个主题");
  const out = [],
    seen = new Set();
  for (const deck of usableDecks(s))
    for (const card of deck.cards) {
      if (card.suspended || seen.has(card.id)) continue;
      const hit = refs.some((x) => x.deckId === deck.id && (x.cardId ? x.cardId === card.id : !x.topic || x.topic === topicOf(card)));
      if (!hit) continue;
      seen.add(card.id);
      out.push({ deck, card });
    }
  if (out.length > MAX_SCOPE_CARDS) throw new Error(`一次最多 ${MAX_SCOPE_CARDS} 道题，当前选中 ${out.length} 道，请缩小范围`);
  return out;
}

/** Zero-token checks for the "loose vocabulary" pattern. */
export function lintCard(card, { linked = false } = {}) {
  const issues = [];
  const options = Array.isArray(card.options) ? card.options : [];
  if (options.length) {
    const echoes = options.filter((o) => {
      const text = norm(o.text),
        why = norm(o.explanation);
      return !why || why === text || (why.includes(text) && why.length <= text.length + 6);
    });
    if (echoes.length && echoes.length >= Math.ceil(options.length / 2)) issues.push("echo-explanation");
  }
  const stem = `${card.prompt || ""} ${card.cloze?.text || ""}`;
  if (/(课件|幻灯片|讲义|slide|ppt)\s*(第\s*)?\d+|第\s*\d+\s*(页|张)|listed on (the )?slide|(属于|列在|出现在).{0,16}(页|slide|课件|幻灯片)/i.test(stem))
    issues.push("membership-stem");
  const explanation = norm(card.explanation);
  if (!explanation || explanation.length < 16 || explanation === norm(card.answer)) issues.push("thin-explanation");
  if (!linked && cognitiveLevel(card) === "recall") issues.push("isolated-recall");
  return issues;
}

function linkedIds(s) {
  const ids = new Set();
  for (const deck of s.decks)
    for (const card of deck.cards)
      for (const r of card.requires || []) {
        ids.add(card.id);
        ids.add(r.cardId);
      }
  return ids;
}

export function lintScope(s, scope) {
  const linked = linkedIds(s);
  const cards = scopeCards(s, scope).map(({ deck, card }) => ({
    deckId: deck.id,
    deckTitle: deck.title,
    cardId: card.id,
    topic: topicOf(card),
    kind: card.kind,
    prompt: clip(String(card.prompt).replace(/\{\{[^{}]+\}\}/g, "＿＿"), 140),
    issues: lintCard(card, { linked: linked.has(card.id) }),
  }));
  const counts = Object.fromEntries(Object.keys(LINT_CODES).map((code) => [code, cards.filter((c) => c.issues.includes(code)).length]));
  return {
    total: cards.length,
    decks: new Set(cards.map((c) => c.deckId)).size,
    flagged: cards.filter((c) => c.issues.length).length,
    counts,
    labels: LINT_CODES,
    cards,
  };
}

/** Compact material for the main session: cards with their checks, plus cited evidence. */
export function skeletonContext(s, scope) {
  const found = scopeCards(s, scope),
    linked = linkedIds(s);
  return {
    instructions:
      "Design one knowledge skeleton for these cards, then save it with skeleton.save. It is drawn as a UML class diagram (nodes are classes: term, 2–5 short attributes = defining traits, parent = generalization; relations: part-of = composition, causes/prerequisite = dependency, example-of = realization, contrasts/related = association) plus up to 4 UML sequence diagrams for the dynamic chains (e.g. a failure cascade or request flow: participants are actors or node ids, steps are call/return/async messages in time order), each with a written explanation. Merge synonyms and the same term across decks into one node; every node needs a one-sentence meaning grounded in the evidence (mark supplementary knowledge as such) and the {deckId,cardId} refs of the cards it covers. Afterwards fix flagged cards with card.update and connect causal/prerequisite pairs with card.link.",
    relationTypes: RELATION_TYPES,
    lintLabels: LINT_CODES,
    cards: found.map(({ deck, card }) => ({
      deckId: deck.id,
      deckTitle: deck.title,
      cardId: card.id,
      topic: topicOf(card),
      kind: card.kind,
      prompt: clip(card.cloze?.text || card.prompt, 400),
      answer: clip(card.answer, 300),
      explanation: clip(card.explanation, 300),
      ...(Array.isArray(card.options)
        ? { options: card.options.map((o) => ({ id: o.id, text: clip(o.text, 160), correct: !!o.correct, explanation: clip(o.explanation, 200) })) }
        : {}),
      requires: (card.requires || []).map((r) => r.cardId),
      issues: lintCard(card, { linked: linked.has(card.id) }),
    })),
    evidence: evidenceWindows(s.sources, found.map((x) => x.card), { radius: 300, budget: 16000 }),
  };
}

const text = (value, name, max, required = true) => {
  const v = typeof value === "string" ? value.trim() : "";
  if (required && !v) throw new Error(`skeleton ${name} is required`);
  if (v.length > max) throw new Error(`skeleton ${name} must be at most ${max} characters`);
  return v;
};

/** Validate an agent-authored skeleton against the library; card refs must exist. */
export function normalizeSkeleton(s, input, previous) {
  if (!input || typeof input !== "object") throw new Error("skeleton must be an object");
  const scope = checkScope(s, input.scope ?? previous?.scope ?? []);
  if (!scope.length) throw new Error("skeleton scope is required");
  const nodes = Array.isArray(input.nodes) ? input.nodes : [];
  if (!nodes.length || nodes.length > MAX_NODES) throw new Error(`skeleton needs 1–${MAX_NODES} nodes`);
  const cardIndex = new Map();
  for (const deck of s.decks) for (const card of deck.cards) cardIndex.set(card.id, deck.id);
  const ids = new Set();
  const outNodes = nodes.map((n, i) => {
    const nodeId = text(n?.id ?? `n${i + 1}`, `nodes[${i}].id`, 40);
    if (ids.has(nodeId)) throw new Error(`skeleton node id ${nodeId} is duplicated`);
    ids.add(nodeId);
    const cards = (Array.isArray(n.cards) ? n.cards : []).map((ref) => {
      const cardId = typeof ref === "string" ? ref : ref?.cardId;
      if (!cardIndex.has(cardId)) throw new Error(`skeleton node ${nodeId} links unknown card ${cardId}`);
      return { deckId: cardIndex.get(cardId), cardId };
    });
    const attributes = (Array.isArray(n.attributes) ? n.attributes : [])
      .slice(0, MAX_ATTRIBUTES)
      .map((a, j) => text(a, `nodes[${i}].attributes[${j}]`, 40))
      .filter(Boolean);
    return {
      id: nodeId,
      term: text(n.term, `nodes[${i}].term`, 80),
      meaning: text(n.meaning, `nodes[${i}].meaning`, 300),
      ...(attributes.length ? { attributes } : {}),
      ...(n.parent ? { parent: text(n.parent, `nodes[${i}].parent`, 40) } : {}),
      cards: [...new Map(cards.map((c) => [c.cardId, c])).values()],
    };
  });
  for (const n of outNodes)
    if (n.parent && !ids.has(n.parent)) throw new Error(`skeleton node ${n.id} has unknown parent ${n.parent}`);
  const relations = Array.isArray(input.relations) ? input.relations : [];
  if (relations.length > MAX_RELATIONS) throw new Error(`skeleton allows at most ${MAX_RELATIONS} relations`);
  const outRelations = relations.map((r, i) => {
    if (!ids.has(r?.from) || !ids.has(r?.to)) throw new Error(`skeleton relations[${i}] must connect existing node ids`);
    if (!Object.hasOwn(RELATION_TYPES, r.type)) throw new Error(`skeleton relations[${i}].type must be one of ${Object.keys(RELATION_TYPES).join(", ")}`);
    return { from: r.from, to: r.to, type: r.type, ...(r.note ? { note: text(r.note, `relations[${i}].note`, 160) } : {}) };
  });
  const sequences = Array.isArray(input.sequences) ? input.sequences : [];
  if (sequences.length > MAX_SEQUENCES) throw new Error(`skeleton allows at most ${MAX_SEQUENCES} sequences`);
  const outSequences = sequences.map((q, i) => {
    const where = `sequences[${i}]`;
    const participants = Array.isArray(q?.participants) ? q.participants : [];
    if (participants.length < 2 || participants.length > MAX_PARTICIPANTS)
      throw new Error(`${where} needs 2–${MAX_PARTICIPANTS} participants`);
    const pids = new Set();
    const outParticipants = participants.map((p, j) => {
      const pid = text(p?.id, `${where}.participants[${j}].id`, 40);
      if (pids.has(pid)) throw new Error(`${where} participant id ${pid} is duplicated`);
      pids.add(pid);
      if (p.node && !ids.has(p.node)) throw new Error(`${where}.participants[${j}].node must be an existing node id`);
      const label = text(p.label ?? outNodes.find((n) => n.id === p.node)?.term, `${where}.participants[${j}].label`, 40);
      return { id: pid, label, ...(p.node ? { node: p.node } : {}) };
    });
    const steps = Array.isArray(q.steps) ? q.steps : [];
    if (!steps.length || steps.length > MAX_STEPS) throw new Error(`${where} needs 1–${MAX_STEPS} steps`);
    return {
      title: text(q.title, `${where}.title`, 60),
      ...(q.explanation ? { explanation: text(q.explanation, `${where}.explanation`, 800) } : {}),
      participants: outParticipants,
      steps: steps.map((st, j) => {
        if (!pids.has(st?.from) || !pids.has(st?.to)) throw new Error(`${where}.steps[${j}] must go between participant ids`);
        const kind = st.kind ?? "call";
        if (!Object.hasOwn(STEP_KINDS, kind)) throw new Error(`${where}.steps[${j}].kind must be call, return or async`);
        return {
          from: st.from,
          to: st.to,
          message: text(st.message, `${where}.steps[${j}].message`, 60),
          kind,
          ...(st.note ? { note: text(st.note, `${where}.steps[${j}].note`, 80) } : {}),
        };
      }),
    };
  });
  const now = new Date().toISOString();
  return {
    id: previous?.id || id(),
    title: text(input.title ?? previous?.title, "title", 80),
    scope,
    overview: text(input.overview ?? "", "overview", 6000, false),
    nodes: outNodes,
    relations: outRelations,
    ...(input.classNote ? { classNote: text(input.classNote, "classNote", 1200) } : {}),
    sequences: outSequences,
    createdAt: previous?.createdAt || now,
    updatedAt: now,
  };
}

export function saveSkeleton(s, input) {
  if (!Array.isArray(s.skeletons)) s.skeletons = [];
  const previous = input?.id ? s.skeletons.find((k) => k.id === input.id) : null;
  if (input?.id && !previous) throw new Error("Skeleton not found");
  const skeleton = normalizeSkeleton(s, input, previous);
  skeleton.lastChange = describeChange(previous, skeleton, previous ? "对话更新了骨架" : "对话生成了骨架");
  if (previous) s.skeletons[s.skeletons.indexOf(previous)] = skeleton;
  else {
    s.skeletons.push(skeleton);
    if (s.skeletons.length > MAX_SKELETONS) s.skeletons.splice(0, s.skeletons.length - MAX_SKELETONS);
  }
  return skeleton;
}

export const skeletonSummary = (k) => ({
  id: k.id,
  title: k.title,
  nodes: k.nodes.length,
  relations: k.relations.length,
  sequences: (k.sequences || []).length,
  cardIds: [...new Set(k.nodes.flatMap((n) => n.cards.map((c) => c.cardId)))],
  decks: [...new Set(k.scope.map((x) => x.deckId))].length,
  updatedAt: k.updatedAt,
  ...(k.lastChange ? { lastChange: { at: k.lastChange.at, summary: k.lastChange.summary } } : {}),
});

/* 主题组：生成时的主题往往过细（大量 1–2 题的主题），同一知识域被拆得很碎。
   主会话的 agent 按知识域把主题归并成主题组，存成题目之上的一层映射：
   不改题目的 topic，不影响复习调度。组里记的是跨题组合并后的主题 key，
   以后新题组里出现同名主题会自动落进同一组。 */
const MAX_GROUPS = 60;
const MAX_GROUP_TOPICS = 400;

export function topicGroupsView(s, topics = skeletonTopics(s)) {
  const known = new Map(topics.map((t) => [t.key, t]));
  const groups = (Array.isArray(s.topicGroups) ? s.topicGroups : []).map((g) => {
    const members = g.topics.filter((key) => known.has(key));
    return {
      id: g.id,
      title: g.title,
      description: g.description || "",
      topics: members,
      count: members.reduce((n, key) => n + known.get(key).count, 0),
      decks: new Set(members.flatMap((key) => known.get(key).decks.map((d) => d.deckId))).size,
      updatedAt: g.updatedAt,
    };
  });
  const grouped = new Set(groups.flatMap((g) => g.topics));
  const ungrouped = topics.filter((t) => !grouped.has(t.key)).map((t) => t.key);
  const updatedAt = groups.reduce((latest, g) => (g.updatedAt > latest ? g.updatedAt : latest), "");
  return { groups, ungrouped, updatedAt };
}

/**
 * Save topic groups. mode "replace" (default) swaps the whole grouping; mode
 * "merge" adds topics to groups matched by id or title and appends new groups,
 * for grouping topics that appeared later. A topic belongs to one group; unknown
 * topic keys are rejected so a typo cannot silently drop a topic.
 */
export function saveTopicGroups(s, { groups, mode = "replace" } = {}) {
  if (!["replace", "merge"].includes(mode)) throw new Error('mode must be "replace" or "merge"');
  if (!Array.isArray(groups) || !groups.length) throw new Error("groups must be a non-empty array");
  const topics = skeletonTopics(s),
    known = new Set(topics.map((t) => t.key)),
    byName = new Map(topics.map((t) => [norm(t.topic), t.key]));
  const resolve = (value, where) => {
    const raw = typeof value === "string" ? value : value?.key ?? value?.topic;
    const key = known.has(raw) ? raw : byName.get(norm(raw));
    if (!key) throw new Error(`${where}: unknown topic ${JSON.stringify(raw)}; use keys from skeleton.topics`);
    return key;
  };
  const now = new Date().toISOString();
  const existing = mode === "merge" && Array.isArray(s.topicGroups) ? structuredClone(s.topicGroups) : [];
  const claimed = new Map();
  if (mode === "merge") for (const g of existing) for (const key of g.topics) claimed.set(key, g.id);
  for (const [i, input] of groups.entries()) {
    const where = `groups[${i}]`;
    const title = text(input?.title, `${where}.title`, 40);
    const members = (Array.isArray(input.topics) ? input.topics : []).map((v, j) => resolve(v, `${where}.topics[${j}]`));
    if (!members.length) throw new Error(`${where} needs at least one topic`);
    let group = existing.find((g) => (input.id && g.id === input.id) || g.title === title);
    if (!group) {
      group = { id: id(), title, description: "", topics: [], updatedAt: now };
      existing.push(group);
    }
    if (input.description !== undefined) group.description = text(input.description, `${where}.description`, 200, false);
    for (const key of members) {
      const owner = claimed.get(key);
      if (owner && owner !== group.id) {
        if (mode === "replace") throw new Error(`${where}: topic ${key} is already in another group; each topic belongs to one group`);
        continue; // merge keeps a topic where it already lives
      }
      if (!group.topics.includes(key)) group.topics.push(key);
      claimed.set(key, group.id);
    }
    group.updatedAt = now;
  }
  const out = existing.filter((g) => g.topics.length);
  if (out.length > MAX_GROUPS) throw new Error(`at most ${MAX_GROUPS} topic groups`);
  if (out.some((g) => g.topics.length > MAX_GROUP_TOPICS)) throw new Error(`a group holds at most ${MAX_GROUP_TOPICS} topics`);
  s.topicGroups = out;
  return topicGroupsView(s, topics);
}

/* 增量修改：对话在已有骨架上加概念、加关系、挂新题时不必整份重写。
   每个 op 改的是一份草稿，全部应用后再走 normalizeSkeleton 统一校验，
   任何一步不合法都整体拒绝，骨架保持原样。挂上的题如果不在原范围内，
   范围自动扩展到这些题，骨架始终能覆盖它引用的题。 */
const MAX_OPS = 60;
const relationKey = (r) => `${r.from}>${r.to}>${r.type}`;

/** What changed between two versions, so the panel can say it and light it up. */
export function describeChange(previous, next, verb = "对话更新了骨架") {
  const before = new Map((previous?.nodes || []).map((n) => [n.id, JSON.stringify(n)]));
  const addedNodes = next.nodes.filter((n) => !before.has(n.id)).map((n) => n.id);
  const changedNodes = next.nodes.filter((n) => before.has(n.id) && before.get(n.id) !== JSON.stringify(n)).map((n) => n.id);
  const oldRelations = new Set((previous?.relations || []).map(relationKey));
  const addedRelations = next.relations.filter((r) => !oldRelations.has(relationKey(r))).map(relationKey);
  const removedNodes = previous ? previous.nodes.filter((n) => !next.nodes.some((m) => m.id === n.id)).length : 0;
  const cardCount = (k) => new Set((k?.nodes || []).flatMap((n) => n.cards.map((c) => c.cardId))).size;
  const addedCards = Math.max(0, cardCount(next) - cardCount(previous));
  const sequences = (next.sequences || []).length - (previous?.sequences || []).length;
  const parts = [
    addedNodes.length && `+${addedNodes.length} 个概念`,
    changedNodes.length && `改了 ${changedNodes.length} 个概念`,
    removedNodes && `删了 ${removedNodes} 个概念`,
    addedRelations.length && `+${addedRelations.length} 条关系`,
    addedCards && `挂上 ${addedCards} 道题`,
    sequences > 0 && `+${sequences} 条时序`,
  ].filter(Boolean);
  return {
    at: next.updatedAt,
    summary: previous ? `${verb}：${parts.join("，") || "内容微调"}` : verb,
    nodes: [...addedNodes, ...changedNodes],
    addedNodes,
    relations: addedRelations,
  };
}

function coveredByScope(s, scope, ref) {
  const deck = s.decks.find((d) => d.id === ref.deckId);
  const card = deck?.cards.find((c) => c.id === ref.cardId);
  if (!card) return true;
  return scope.some((x) => x.deckId === deck.id && (x.cardId ? x.cardId === card.id : !x.topic || x.topic === topicOf(card)));
}

export function patchSkeleton(s, { id: skeletonId, ops, note } = {}) {
  const previous = (Array.isArray(s.skeletons) ? s.skeletons : []).find((k) => k.id === skeletonId);
  if (!previous) throw new Error("Skeleton not found");
  if (!Array.isArray(ops) || !ops.length || ops.length > MAX_OPS) throw new Error(`ops must be a list of 1–${MAX_OPS} operations`);
  const draft = structuredClone(previous);
  draft.sequences ||= [];
  const nodeOf = (nodeId, where) => {
    const node = draft.nodes.find((n) => n.id === nodeId);
    if (!node) throw new Error(`${where}: unknown node ${nodeId}`);
    return node;
  };
  const cardRef = (ref, where) => {
    const cardId = typeof ref === "string" ? ref : ref?.cardId;
    for (const deck of s.decks) if (deck.cards.some((c) => c.id === cardId)) return { deckId: deck.id, cardId };
    throw new Error(`${where}: unknown card ${cardId}`);
  };
  const sequenceIndex = (op, where) => {
    const i = Number.isInteger(op.index) ? op.index : draft.sequences.findIndex((q) => q.title === op.title);
    if (!draft.sequences[i]) throw new Error(`${where}: unknown sequence`);
    return i;
  };
  ops.forEach((op, i) => {
    const where = `ops[${i}] ${op?.op}`;
    switch (op?.op) {
      case "set":
        for (const key of ["title", "overview", "classNote"]) if (op[key] !== undefined) draft[key] = op[key];
        break;
      case "node.add": {
        const node = op.node || {};
        if (draft.nodes.some((n) => n.id === node.id)) throw new Error(`${where}: node id ${node.id} already exists; use node.update`);
        draft.nodes.push({ ...node, cards: (node.cards || []).map((c) => cardRef(c, where)) });
        break;
      }
      case "node.update": {
        const node = nodeOf(op.id, where);
        for (const [key, value] of Object.entries(op.set || {})) {
          if (!["term", "meaning", "attributes", "parent"].includes(key)) throw new Error(`${where}: cannot set ${key}`);
          if (value === null) delete node[key];
          else node[key] = value;
        }
        break;
      }
      case "node.remove": {
        nodeOf(op.id, where);
        draft.nodes = draft.nodes.filter((n) => n.id !== op.id);
        for (const n of draft.nodes) if (n.parent === op.id) delete n.parent;
        draft.relations = draft.relations.filter((r) => r.from !== op.id && r.to !== op.id);
        for (const q of draft.sequences) for (const p of q.participants) if (p.node === op.id) delete p.node;
        break;
      }
      case "node.cards": {
        const node = nodeOf(op.id, where);
        const remove = new Set((op.remove || []).map((c) => (typeof c === "string" ? c : c?.cardId)));
        node.cards = node.cards.filter((c) => !remove.has(c.cardId));
        for (const ref of op.add || []) {
          const resolved = cardRef(ref, where);
          if (!node.cards.some((c) => c.cardId === resolved.cardId)) node.cards.push(resolved);
        }
        break;
      }
      case "relation.add": {
        const existing = draft.relations.find((r) => relationKey(r) === relationKey(op));
        if (existing) {
          if (op.note !== undefined) existing.note = op.note;
        } else draft.relations.push({ from: op.from, to: op.to, type: op.type, ...(op.note ? { note: op.note } : {}) });
        break;
      }
      case "relation.remove": {
        const before = draft.relations.length;
        draft.relations = draft.relations.filter((r) => !(r.from === op.from && r.to === op.to && (!op.type || r.type === op.type)));
        if (draft.relations.length === before) throw new Error(`${where}: no such relation`);
        break;
      }
      case "sequence.add":
        draft.sequences.push(op.sequence);
        break;
      case "sequence.update":
        draft.sequences[sequenceIndex(op, where)] = op.sequence;
        break;
      case "sequence.remove":
        draft.sequences.splice(sequenceIndex(op, where), 1);
        break;
      default:
        throw new Error(`${where}: unknown op; use set, node.add, node.update, node.remove, node.cards, relation.add, relation.remove, sequence.add, sequence.update, sequence.remove`);
    }
  });
  // New cards outside the original scope widen it card by card.
  for (const n of draft.nodes)
    for (const ref of n.cards)
      if (!coveredByScope(s, draft.scope, ref)) draft.scope.push({ deckId: ref.deckId, cardId: ref.cardId });
  const skeleton = normalizeSkeleton(s, draft, previous);
  skeleton.lastChange = describeChange(previous, skeleton);
  if (typeof note === "string" && note.trim()) skeleton.lastChange.summary = `${skeleton.lastChange.summary} · ${text(note, "note", 80)}`;
  s.skeletons[s.skeletons.indexOf(previous)] = skeleton;
  return { skeleton, change: skeleton.lastChange };
}
