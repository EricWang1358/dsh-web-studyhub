import { id } from "./util.js";

/* 信箱：会话或后台替某道题做完的事（提升质量、关联前置题、按反馈改题、陪学
   回复、定制变式、讲解追问）。学习者往往已经去做下一题了，这里留一条可跳回
   去的记录，而不是让他翻目录找。条目持久化在 s.inbox，只存引用和一句摘要；
   题干与题组名在视图里按当前题库解析，题被删了也不会带着旧内容。 */

export const INBOX_KINDS = {
  improve: "质量提升",
  link: "前置题",
  rewrite: "按反馈改题",
  coach: "陪学回复",
  variant: "定制题",
  followup: "讲解追问",
};
const MAX_ITEMS = 200;
const VIEW_ITEMS = 50;
const clip = (text, n) => {
  const s = String(text ?? "").replace(/\s+/g, " ").trim();
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
};

/** Record one finished background result for a card. Call inside store.update. */
export function notify(s, { kind, deckId, cardId, detail = "" }) {
  if (!Object.hasOwn(INBOX_KINDS, kind) || !cardId) return null;
  if (!Array.isArray(s.inbox)) s.inbox = [];
  const at = new Date().toISOString();
  // Several results of one kind for the same card fold into one unread letter.
  const open = s.inbox.find((m) => !m.read && m.kind === kind && m.cardId === cardId);
  if (open) {
    s.inbox.splice(s.inbox.indexOf(open), 1);
    Object.assign(open, { at, detail: clip(detail, 160) || open.detail, count: (open.count || 1) + 1 });
    s.inbox.push(open);
    return open;
  }
  const item = { id: id(), kind, deckId: deckId || null, cardId, detail: clip(detail, 160), at, read: false };
  s.inbox.push(item);
  if (s.inbox.length > MAX_ITEMS) s.inbox.splice(0, s.inbox.length - MAX_ITEMS);
  return item;
}

export function inboxView(s) {
  const items = Array.isArray(s.inbox) ? s.inbox : [];
  const cards = new Map();
  for (const deck of s.decks) for (const card of deck.cards) cards.set(card.id, { deck, card });
  return {
    unread: items.filter((m) => !m.read).length,
    items: items
      .slice(-VIEW_ITEMS)
      .reverse()
      .map((m) => {
        const found = cards.get(m.cardId);
        return {
          ...m,
          label: INBOX_KINDS[m.kind],
          deckId: found?.deck.id ?? m.deckId,
          deckTitle: found?.deck.title || "",
          prompt: found ? clip(found.card.prompt.replace(/\{\{[^{}]+\}\}/g, "＿＿"), 90) : "",
          missing: !found,
        };
      }),
  };
}

/** Mark letters read: explicit ids, every letter for some cards, or all. */
export function markRead(s, { ids, cardIds, all } = {}) {
  if (!Array.isArray(s.inbox)) s.inbox = [];
  const idSet = new Set(Array.isArray(ids) ? ids : []),
    cardSet = new Set(Array.isArray(cardIds) ? cardIds : []);
  let changed = 0;
  for (const m of s.inbox)
    if (!m.read && (all === true || idSet.has(m.id) || cardSet.has(m.cardId))) {
      m.read = true;
      changed++;
    }
  return changed;
}
