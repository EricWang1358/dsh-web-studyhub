import { id, get, required } from "./util.js";
import { scopeKey } from "./mastery.js";

const ordinary = (deck) => {
  if (deck.systemKind) throw new Error("系统题组不能排序、合并或拆分");
  if (deck.archived) throw new Error("请先恢复已归档的题组");
};
const noEditingDraft = (state, deckId) => {
  if (state.drafts.some((d) => d.editingDeckId === deckId || d.editorial?.repairOfDeckId === deckId))
    throw new Error("请先处理该题组正在编辑或修复的草稿");
};

// Card ids never change. Rewrite every stored location paired with that id,
// including attempts, runs, skeletons, coach notes and prerequisite edges.
function relocateReferences(state, moved, fromId, toId, wholeDeck = false, movedTopics = new Set()) {
  // A saved workflow keeps its selected members when either deck changes.
  // Resolve broad scopes before moving cards, including suspended members.
  const workflowScope = (scope) => scope.flatMap((ref) => {
    if (ref.deckId !== fromId && ref.deckId !== toId) return [ref];
    return get(state.decks, ref.deckId, "题组").cards
      .filter((card) => ref.cardId ? card.id === ref.cardId : !ref.topic || (card.topic || "未分类") === ref.topic)
      .map((card) => ({ deckId: ref.deckId, cardId: card.id }));
  });
  const visit = (value) => {
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) { value.forEach(visit); return; }
    const cardId = value.cardId || value.quiz_id || value.card?.id;
    if (value.deckId === fromId && (moved.has(cardId) || (wholeDeck && !cardId) || (!cardId && movedTopics.has(value.topic))))
      value.deckId = toId;
    if (value.originDeckId === fromId && moved.has(value.originCardId)) value.originDeckId = toId;
    if (wholeDeck && value.slain?.deckId === fromId) value.slain.deckId = toId;
    for (const child of Object.values(value)) visit(child);
  };
  for (const session of state.workflowSessions || []) {
    const before = JSON.stringify(session.scope);
    session.scope = workflowScope(session.scope);
    // Only the scope contains relocatable session references; the running
    // template is immutable and may contain arbitrary instructional content.
    visit(session.scope);
    if (JSON.stringify(session.scope) !== before) {
      session.version++;
      session.updatedAt = new Date().toISOString();
    }
  }
  for (const run of state.runs) if (run.workflowSessionId && run.scope)
    run.scope = workflowScope(run.scope);
  for (const field of ["decks", "drafts", "attempts", "runs", "teaching", "coach", "feedback", "prepared", "inbox", "skeletons", "topicGroups", "notes"])
    visit(state[field]);
  if (state.ingest) visit(state.ingest);
  for (const run of state.runs) {
    if (run.workflowSessionId) {
      const deckIds = new Set(run.entries.map((entry) => entry.deckId ?? run.deckId));
      run.deckId = deckIds.size === 1 ? [...deckIds][0] : null;
      continue;
    }
    if (!run.closedAt && run.entries?.some((e) => moved.has(e.card?.id))) run.closedAt = new Date().toISOString();
    if (run.scope) run.key = scopeKey(run.mode, run.scope);
  }
}

function transferMarks(from, to, cards) {
  const marks = from.editorial?.reviewedCards;
  if (!marks) return;
  to.editorial ||= {};
  to.editorial.reviewedCards ||= {};
  for (const card of cards) if (marks[card.id]) {
    to.editorial.reviewedCards[card.id] = marks[card.id];
    delete marks[card.id];
  }
}

export function reorderDecks(state, ids) {
  if (!Array.isArray(ids) || ids.length !== state.decks.length || new Set(ids).size !== ids.length ||
      ids.some((deckId) => !state.decks.some((d) => d.id === deckId)))
    throw new Error("排序须包含当前全部题组 ID，且每个恰好一次");
  const byId = new Map(state.decks.map((d) => [d.id, d]));
  state.decks = ids.map((deckId) => byId.get(deckId));
  return { ids };
}

export function mergeDecks(state, { sourceIds, targetId }) {
  if (!Array.isArray(sourceIds) || !sourceIds.length || new Set(sourceIds).size !== sourceIds.length || sourceIds.includes(targetId))
    throw new Error("请选择不同的来源题组和目标题组");
  const target = get(state.decks, targetId, "目标题组");
  ordinary(target); noEditingDraft(state, target.id);
  let movedCount = 0;
  for (const sourceId of sourceIds) {
    const source = get(state.decks, sourceId, "来源题组");
    ordinary(source); noEditingDraft(state, source.id);
    const moved = new Set(source.cards.map((c) => c.id));
    if (target.cards.some((c) => moved.has(c.id))) throw new Error("题目 ID 冲突，无法合并");
    relocateReferences(state, moved, source.id, target.id, true);
    transferMarks(source, target, source.cards);
    target.cards.push(...source.cards);
    movedCount += source.cards.length;
    state.decks.splice(state.decks.indexOf(source), 1);
  }
  target.contentVersion = (target.contentVersion || 0) + 1;
  return { targetId, sourceIds, moved: movedCount, count: target.cards.length };
}

export function splitDeck(state, { id: sourceId, title, folder, topics }) {
  const source = get(state.decks, sourceId, "题组");
  ordinary(source); noEditingDraft(state, source.id);
  if (!Array.isArray(topics) || !topics.length || new Set(topics).size !== topics.length || topics.some((t) => typeof t !== "string"))
    throw new Error("请选择要拆出的主题");
  const selected = new Set(topics);
  const cards = source.cards.filter((c) => selected.has(c.topic || "未分类"));
  if (!cards.length || cards.length === source.cards.length) throw new Error("拆分后两个题组都必须有题目");
  const name = required(title, "新题组名称");
  if (name.length > 200) throw new Error("题组名称过长");
  if (typeof folder === "string" && folder.length > 200) throw new Error("目录名称过长");
  const target = { id: id(), title: name, folder: typeof folder === "string" ? folder.trim() : source.folder || "",
    ...(source.course ? { course: source.course } : {}), cards: [], createdAt: new Date().toISOString() };
  state.decks.splice(state.decks.indexOf(source) + 1, 0, target);
  const moved = new Set(cards.map((c) => c.id));
  relocateReferences(state, moved, source.id, target.id, false, selected);
  transferMarks(source, target, cards);
  source.cards = source.cards.filter((c) => !moved.has(c.id));
  target.cards = cards;
  source.contentVersion = (source.contentVersion || 0) + 1;
  return { sourceId, targetId: target.id, moved: cards.length, remaining: source.cards.length };
}
