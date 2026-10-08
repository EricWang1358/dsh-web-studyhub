import { id, get, required } from "./util.js";
import { findCard } from "./prereq.js";
import { csdnArticle } from "./adapters/csdn-public.js";
import { validImageMarkdown } from './study-image-markdown.js';

export const isDailyWriting = note => ['daily-recap', 'daily-recap-history'].includes(note?.kind);

export function checkNoteRevision(note, expectedRevision) {
  if (expectedRevision !== undefined && expectedRevision !== (note.revision || 0))
    throw new Error("笔记已有更新，请重新打开后核对；当前输入仍保留在本地草稿中");
}

export function noteView(state, note) {
  const cards = note.cards.map(ref => {
    const deck = state.decks.find(item => item.id === ref.deckId);
    const card = deck?.cards.find(item => item.id === ref.cardId);
    return { ...ref, prompt: card?.prompt || "", deckTitle: deck?.title || "",
      course: deck?.course ?? deck?.folder ?? "", missing: !card };
  });
  const { fragments: _fragments, ...daily } = note.daily || {};
  return { ...note, ...(note.daily ? { daily } : {}), revision: note.revision || 0, cards,
    courses: [...new Set([...cards.map(card => card.course), ...(isDailyWriting(note) ? [note.daily?.course] : [])].filter(Boolean))] };
}

export function createNote(state, input) {
  if (!Array.isArray(input.cards) || !input.cards.length || input.cards.length > 30)
    throw new Error("请选择 1–30 道题成文");
  const cards = [...new Map(input.cards.map((ref) => {
    const { deck, card } = findCard(state, ref);
    return [card.id, { deckId: deck.id, cardId: card.id }];
  })).values()];
  // 写笔记 under a question asks again and again: with `reuse` the open draft of exactly this question (not published, not a daily summary) is the answer, and no second note with the same title is made.
  if (input.reuse === true) {
    const same = state.notes.find(note => note.status === "draft" && !isDailyWriting(note) && note.cards.length === cards.length && cards.every(card => note.cards.some(ref => ref.cardId === card.cardId)));
    if (same) return { ...noteView(state, same), reused: true };
  }
  const title = required(input.title, "文章标题");
  if (title.length > 200) throw new Error("文章标题过长");
  const now = new Date().toISOString();
  const note = { id: id(), title, cards, markdown: `# ${title}\n\n## 核心概念\n\n## 常见误区\n\n## 解析与例子\n\n## 学习记录\n`,
    status: "draft", revision: 0, createdAt: now, updatedAt: now };
  state.notes.push(note);
  return noteView(state, note);
}

export function saveNote(state, input) {
  const note = get(state.notes, input.id, "笔记");
  if (note.status === "published" && !isDailyWriting(note)) throw new Error("已发布文章不能覆盖，请新建草稿");
  checkNoteRevision(note, input.expectedRevision);
  const previous = JSON.stringify([note.title, note.markdown, note.cards]);
  if (input.title !== undefined) {
    note.title = required(input.title, "文章标题");
    if (note.title.length > 200) throw new Error("文章标题过长");
  }
  if (input.markdown !== undefined) {
    if (!validImageMarkdown(input.markdown))
      throw new Error("Markdown 内容过长");
    note.markdown = input.markdown;
  }
  if (Array.isArray(input.cards)) {
    if (!input.cards.length || (!isDailyWriting(note) && input.cards.length > 30)) throw new Error("请选择 1–30 道题");
    note.cards = [...new Map(input.cards.map((ref) => {
      const { deck, card } = findCard(state, ref);
      return [isDailyWriting(note) ? JSON.stringify([deck.id, card.id]) : card.id, { deckId: deck.id, cardId: card.id }];
    })).values()];
  }
  if (previous === JSON.stringify([note.title, note.markdown, note.cards])) return noteView(state, note);
  note.updatedAt = new Date().toISOString();
  note.revision = (note.revision || 0) + 1;
  if (isDailyWriting(note)) note.daily.manualEditedAt = note.updatedAt;
  if (note.generation?.status === "running") note.generation.status = "superseded";
  return noteView(state, note);
}

export function publishNoteLink(state, input) {
  const note = get(state.notes, input.id, "笔记");
  checkNoteRevision(note, input.expectedRevision);
  if (!state.csdnHome) throw new Error("请先设置 CSDN 公开博客主页");
  note.publicUrl = csdnArticle(input.url, state.csdnHome);
  if (!isDailyWriting(note)) { note.status = "published"; delete note.markdown; }
  note.publishedAt = new Date().toISOString();
  note.updatedAt = note.publishedAt;
  note.revision = (note.revision || 0) + 1;
  // Linking a public copy does not change the daily writing a running job is revising.
  if (note.kind === 'daily-recap' && note.generation?.status === 'running') note.generation.revision = note.revision;
  return noteView(state, note);
}

export function noteBadges(state) {
  const badges = {};
  for (const note of state.notes || [])
    for (const ref of note.cards)
      (badges[ref.cardId] ||= []).push({ noteId: note.id, title: note.title,
        status: note.status, url: note.publicUrl || null });
  return badges;
}
