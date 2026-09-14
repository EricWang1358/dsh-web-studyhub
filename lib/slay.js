import { id, get } from "./util.js";
import { findCard } from "./prereq.js";

export const isSlayDeck = (deck) => deck?.systemKind === "slain";

function syncDrafts(state, deck, card, remove) {
  deck.contentVersion = (deck.contentVersion || 0) + 1;
  for (const draft of state.drafts.filter((d) => d.editingDeckId === deck.id)) {
    draft.cards = draft.cards.filter((c) => c.id !== card.id);
    if (!remove) draft.cards.push(structuredClone(card));
    draft.baseVersion = deck.contentVersion;
    draft.draftVersion = (draft.draftVersion || 0) + 1;
  }
}

function relocateLinks(state, from, to, cardId) {
  for (const deck of [...state.decks, ...state.drafts]) {
    let changed = false;
    for (const card of deck.cards) for (const ref of card.requires || []) {
      if (ref.deckId === from && ref.cardId === cardId) { ref.deckId = to; changed = true; }
    }
    if (changed && deck.draftVersion) deck.draftVersion++;
  }
}

export function slayCard(state, args) {
  const run = args.runId ? get(state.runs, args.runId, "Review") : null;
  if (run && (run.closedAt || run.entries[run.index]?.card.id !== args.cardId)) throw new Error("当前题目已变化，请刷新后再斩");
  const { deck, card } = findCard(state, args);
  if (isSlayDeck(deck)) return { deckId: deck.id, cardId: card.id, alreadySlain: true };
  let target = state.decks.find(isSlayDeck);
  if (!target) {
    target = { id: id(), title: "斩题组", systemKind: "slain", archived: true, folder: "", cards: [], createdAt: new Date().toISOString() };
    state.decks.push(target);
  }
  card.slain = { deckId: deck.id, deckTitle: deck.title, suspended: !!card.suspended, at: new Date().toISOString() };
  card.suspended = true;
  deck.cards = deck.cards.filter((c) => c.id !== card.id);
  target.cards.push(card);
  syncDrafts(state, deck, card, true);
  relocateLinks(state, deck.id, target.id, card.id);
  // Keep attempt records and closed sessions unchanged; remove all queued retries too.
  for (const active of state.runs.filter((r) => !r.closedAt)) {
    const matches = (e) => (e.deckId ?? active.deckId) === deck.id && e.card.id === card.id;
    if (!active.entries.some(matches)) continue;
    active.queueVersion = (active.queueVersion || 0) + 1;
    const removedBefore = active.entries.slice(0, active.index).filter(matches).length;
    const currentRemoved = matches(active.entries[active.index] || { card: {} });
    active.entries = active.entries.filter((e) => !matches(e));
    active.index = Math.min(active.entries.length, Math.max(0, active.index - removedBefore));
    if (currentRemoved && active.entries[active.index]) active.entries[active.index].startedAt = Date.now();
  }
  return { deckId: target.id, cardId: card.id };
}

export function restoreSlainCard(state, args) {
  const { deck, card } = findCard(state, args);
  if (!isSlayDeck(deck) || !card.slain) throw new Error("这道题不在斩题组中");
  const original = get(state.decks, card.slain.deckId, "原题组");
  if (original.cards.length >= 100 || state.drafts.some((d) => d.editingDeckId === original.id && d.cards.length >= 100)) throw new Error("原题组或其草稿已达到 100 题，请先整理后恢复");
  card.suspended = card.slain.suspended;
  delete card.slain;
  deck.cards = deck.cards.filter((c) => c.id !== card.id);
  original.cards.push(card);
  syncDrafts(state, original, card, false);
  relocateLinks(state, deck.id, original.id, card.id);
  return { deckId: original.id, cardId: card.id, title: original.title };
}
