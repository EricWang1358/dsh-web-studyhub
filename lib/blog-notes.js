import { id, get, required } from "./util.js";
import { findCard } from "./prereq.js";
import { csdnArticle } from "./adapters/csdn-public.js";

export function createNote(state, input) {
  if (!Array.isArray(input.cards) || !input.cards.length || input.cards.length > 30)
    throw new Error("请选择 1–30 道题成文");
  const cards = [...new Map(input.cards.map((ref) => {
    const { deck, card } = findCard(state, ref);
    return [card.id, { deckId: deck.id, cardId: card.id }];
  })).values()];
  const title = required(input.title, "文章标题");
  if (title.length > 200) throw new Error("文章标题过长");
  const now = new Date().toISOString();
  const note = { id: id(), title, cards, markdown: `# ${title}\n\n## 核心概念\n\n## 常见误区\n\n## 解析与例子\n\n## 学习记录\n`,
    status: "draft", createdAt: now, updatedAt: now };
  state.notes.push(note);
  return note;
}

export function saveNote(state, input) {
  const note = get(state.notes, input.id, "笔记");
  if (note.status === "published") throw new Error("已发布文章不能覆盖，请新建草稿");
  if (input.title !== undefined) {
    note.title = required(input.title, "文章标题");
    if (note.title.length > 200) throw new Error("文章标题过长");
  }
  if (input.markdown !== undefined) {
    if (typeof input.markdown !== "string" || input.markdown.length > 200000)
      throw new Error("Markdown 内容过长");
    note.markdown = input.markdown;
  }
  if (Array.isArray(input.cards)) {
    if (!input.cards.length || input.cards.length > 30) throw new Error("请选择 1–30 道题");
    note.cards = [...new Map(input.cards.map((ref) => {
      const { deck, card } = findCard(state, ref);
      return [card.id, { deckId: deck.id, cardId: card.id }];
    })).values()];
  }
  note.updatedAt = new Date().toISOString();
  return note;
}

export function publishNoteLink(state, input) {
  const note = get(state.notes, input.id, "笔记");
  if (!state.csdnHome) throw new Error("请先设置 CSDN 公开博客主页");
  note.publicUrl = csdnArticle(input.url, state.csdnHome);
  note.status = "published";
  delete note.markdown;
  note.publishedAt = new Date().toISOString();
  note.updatedAt = note.publishedAt;
  return note;
}

export function noteBadges(state) {
  const badges = {};
  for (const note of state.notes || [])
    for (const ref of note.cards)
      (badges[ref.cardId] ||= []).push({ noteId: note.id, title: note.title,
        status: note.status, url: note.publicUrl || null });
  return badges;
}
