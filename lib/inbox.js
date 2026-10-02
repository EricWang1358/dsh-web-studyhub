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
  note: "笔记草稿",
  'audio-transcribe': "录音文件已转录成功",
  'audio-proofread': "录音文件已校对润色",
  'audio-proofread-warning': "录音校对部分未完成",
  'audio-translate': "录音文件已翻译成功",
  'audio-result': "录音处理完成",
  'audio-failed': "录音处理未完成",
  // Cloud PDF conversion (MinerU): a finished or stopped conversion job, like an audio import.
  'pdf-result': "PDF 转换完成",
  'pdf-failed': "PDF 转换未完成",
  // Rubric grading (WP12): a graded open answer; the letter opens at the card.
  grade: "批改完成",
};
const MAX_ITEMS = 200;
const VIEW_ITEMS = 50;
const clip = (text, n) => {
  const s = String(text ?? "").replace(/\s+/g, " ").trim();
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
};

/** Record one finished background result for a card. Call inside store.update. */
export function notify(s, { kind, deckId, cardId, noteId, jobId, filename, sourceIds, detail = "" }) {
  const audio = /^(?:audio|pdf)-/.test(kind ?? '');
  if (!Object.hasOwn(INBOX_KINDS, kind) || (audio ? !jobId : !cardId)) return null;
  if (!Array.isArray(s.inbox)) s.inbox = [];
  const at = new Date().toISOString();
  // Several results of one kind for the same card fold into one unread letter.
  const open = s.inbox.find((m) => !m.read && m.kind === kind &&
    (audio ? m.jobId === jobId : kind === "note" ? m.noteId === noteId : m.cardId === cardId));
  if (open) {
    s.inbox.splice(s.inbox.indexOf(open), 1);
    Object.assign(open, { at, detail: clip(detail, 160) || open.detail, count: (open.count || 1) + 1 });
    s.inbox.push(open);
    return open;
  }
  const item = { id: id(), kind, deckId: deckId || null, cardId,
    ...(audio ? { jobId, filename: clip(filename, 120), sourceIds: sourceIds || [] } : {}),
    ...(kind === "note" && noteId ? { noteId } : {}), detail: clip(detail, 160), at, read: false };
  s.inbox.push(item);
  if (s.inbox.length > MAX_ITEMS) s.inbox.splice(0, s.inbox.length - MAX_ITEMS);
  return item;
}

export function inboxView(s) {
  const items = Array.isArray(s.inbox) ? s.inbox : [];
  const unread = items.filter((m) => !m.read);
  // Never count unread letters that the view cannot expose. Keep every unread
  // result first, then fill the recent-history budget with read letters.
  const readSlots = Math.max(0, VIEW_ITEMS - unread.length);
  const recentRead = readSlots ? items.filter((m) => m.read).slice(-readSlots).reverse() : [];
  const cards = new Map();
  for (const deck of s.decks) for (const card of deck.cards) cards.set(card.id, { deck, card });
  return {
    unread: unread.length,
    items: [...unread.reverse(), ...recentRead]
      .map((m) => {
        if (/^(?:audio|pdf)-/.test(m.kind)) return { ...m, label: INBOX_KINDS[m.kind], prompt: m.filename,
          deckTitle: m.kind.startsWith('pdf-') ? "PDF 转换" : "音频转录", missing: false, canRevert: false };
        const found = cards.get(m.cardId);
        const note = m.kind === "note" ? (s.notes || []).find((n) => n.id === m.noteId) : null;
        const latestRevision = found?.card.revisions?.at(-1);
        return {
          ...m,
          label: INBOX_KINDS[m.kind],
          deckId: found?.deck.id ?? m.deckId,
          deckTitle: found?.deck.title || "",
          prompt: note ? clip(note.title, 90) : found ? clip(found.card.prompt.replace(/\{\{[^{}]+\}\}/g, "＿＿"), 90) : "",
          missing: m.kind === "note" ? !note : !found,
          canRevert: (m.kind === "rewrite" &&
            latestRevision?.reason?.startsWith("陪学按反馈修改") &&
            (s.coach || []).some((n) => n.cardId === m.cardId && n.revertable)) ||
            (m.kind === "improve" && !!latestRevision &&
              clip(latestRevision.reason, 160) === m.detail),
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
