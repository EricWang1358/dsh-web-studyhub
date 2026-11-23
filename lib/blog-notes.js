import { id, get, required } from "./util.js";
import { findCard } from "./prereq.js";
import { csdnArticle } from "./adapters/csdn-public.js";
import { validImageMarkdown } from './study-image-markdown.js';
import {
  heldFollowupIds,
  noteStudyDay,
  parseAutoQuestionNoteTitle,
  formatDailyQuestionNoteTitle,
  inferNoteCardsCourse,
  stripLeadingAutoNoteHeading,
} from './contexts/notes/question-note.js';

export const isDailyWriting = note => ['daily-recap', 'daily-recap-history'].includes(note?.kind);
const MAX_ARTICLE_CARDS = 30;
const MAX_QUESTION_NOTE_CARDS = 200;
const defaultIsRunning = generation => generation?.status === 'running';

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

const isOpenQuestionNote = note => note?.status === "draft" && !isDailyWriting(note) && note.origin !== "article";

function noteDayOf(state, note) {
  if (typeof note?.day === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(note.day)) return note.day;
  const parsed = parseAutoQuestionNoteTitle(note?.title);
  if (parsed?.day) return parsed.day;
  return note?.createdAt ? noteStudyDay(state, note.createdAt) : noteStudyDay(state);
}

/** An open question-note draft that already holds every card in `cards`. */
export const openQuestionDraftHolding = (state, cards) => (state.notes || []).find(note =>
  isOpenQuestionNote(note) && Array.isArray(cards) && cards.length > 0
  && cards.every(card => note.cards.some(ref => ref.cardId === card.cardId)));

/** The open question-note draft for a single `cardId` (whether single-card or multi-card daily course note). */
export const openQuestionDraftForCard = (state, cardId) => (state.notes || []).find(note =>
  isOpenQuestionNote(note) && note.cards.some(ref => ref.cardId === cardId));

/** Today's open question-note draft for `(day, course)` (1 day + 1 course = 1 study note). */
export function openDailyCourseDraft(state, { day, course, isRunning = defaultIsRunning }) {
  if (!day || course === null || course === undefined) return undefined;
  return (state.notes || []).find(note =>
    isOpenQuestionNote(note) && !isRunning(note.generation)
    && noteDayOf(state, note) === day
    && inferNoteCardsCourse(state, note.cards, note.title) === course);
}

/** Compatibility helper: open question draft already holding `cards`, or today's `(day, course)` draft when given. */
export const openDraftOf = (state, cards, options) => {
  const existing = openQuestionDraftHolding(state, cards);
  if (existing) return existing;
  if (options?.day) {
    const course = options.course !== undefined ? options.course : inferNoteCardsCourse(state, cards);
    return openDailyCourseDraft(state, { day: options.day, course, isRunning: options.isRunning });
  }
  return undefined;
};

function replaceLeadingAutoHeading(markdown, oldTitle, nextTitle) {
  const raw = String(markdown ?? '');
  if (!raw.trim()) return `# ${nextTitle}\n`;
  const stripped = stripLeadingAutoNoteHeading(raw, oldTitle);
  return stripped ? `# ${nextTitle}\n\n${stripped}\n` : `# ${nextTitle}\n`;
}

export function createNote(state, input) {
  const origin = input.reuse === true || input.prefill === true ? "question" : "article";
  const maxCards = origin === "question" ? MAX_QUESTION_NOTE_CARDS : MAX_ARTICLE_CARDS;
  if (!Array.isArray(input.cards) || !input.cards.length || input.cards.length > maxCards)
    throw new Error("请选择 1–30 道题成文");
  const cards = [...new Map(input.cards.map((ref) => {
    const { deck, card } = findCard(state, ref);
    return [card.id, { deckId: deck.id, cardId: card.id }];
  })).values()];
  const parsed = parseAutoQuestionNoteTitle(input.title);
  const day = input.day || parsed?.day || noteStudyDay(state);
  const course = inferNoteCardsCourse(state, cards);
  // 1) Re-clicking 写笔记 on a question already inside an open question draft reopens that draft without duplicating anything.
  if (input.reuse === true) {
    const same = openQuestionDraftHolding(state, cards);
    if (same) return { ...noteView(state, same), reused: true };
    // 2) Same day + same course appends into today's open course study note instead of spawning another 1-card row.
    const daily = course !== null ? openDailyCourseDraft(state, { day, course, isRunning: input.isRunning }) : undefined;
    if (daily && daily.cards.length + cards.length <= MAX_QUESTION_NOTE_CARDS) {
      const addedCards = cards.filter(card => !daily.cards.some(ref => ref.cardId === card.cardId));
      if (!addedCards.length) return { ...noteView(state, daily), reused: true };
      daily.cards = [...daily.cards, ...addedCards];
      daily.day ||= day;
      const autoTitle = parseAutoQuestionNoteTitle(daily.title);
      if (autoTitle && (autoTitle.legacy || (course && !autoTitle.course))) {
        const nextTitle = formatDailyQuestionNoteTitle({ day: autoTitle.day, course, language: input.language || autoTitle.language });
        daily.markdown = replaceLeadingAutoHeading(daily.markdown, daily.title, nextTitle);
        daily.title = nextTitle;
      }
      daily.updatedAt = new Date().toISOString();
      daily.revision = (daily.revision || 0) + 1;
      return { ...noteView(state, daily), appended: addedCards };
    }
  }
  let title = required(input.title, "文章标题");
  if (origin === "question" && parsed && (parsed.legacy || (course && !parsed.course))) {
    title = formatDailyQuestionNoteTitle({ day: parsed.day, course: course || parsed.course, language: input.language || parsed.language });
  }
  if (title.length > 200) throw new Error("文章标题过长");
  const now = new Date().toISOString();
  const [h1, h2, h3, h4] = input.language === "en"
    ? ["Core concepts", "Common misconceptions", "Explanation and examples", "Study log"]
    : ["核心概念", "常见误区", "解析与例子", "学习记录"];
  const note = { id: id(), title, cards, markdown: `# ${title}\n\n## ${h1}\n\n## ${h2}\n\n## ${h3}\n\n## ${h4}\n`,
    status: "draft", revision: 0, createdAt: now, updatedAt: now, origin, ...(origin === "question" ? { day } : {}) };
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
    const maxCards = note.origin === "article" ? MAX_ARTICLE_CARDS : MAX_QUESTION_NOTE_CARDS;
    if (!isDailyWriting(note) && input.cards.length > maxCards) throw new Error("请选择 1–30 道题");
    const existingIds = new Set((note.cards || []).map((ref) => ref?.cardId).filter(Boolean));
    note.cards = [...new Map(input.cards.map((ref) => {
      let resolved;
      try {
        const { deck, card } = findCard(state, ref);
        resolved = { deckId: deck.id, cardId: card.id };
      } catch (err) {
        if (ref?.cardId && existingIds.has(ref.cardId)) {
          resolved = { deckId: typeof ref.deckId === "string" ? ref.deckId : "", cardId: ref.cardId };
        } else {
          throw err;
        }
      }
      return [isDailyWriting(note) ? JSON.stringify([resolved.deckId, resolved.cardId]) : resolved.cardId, resolved];
    })).values()];
  }
  if (previous === JSON.stringify([note.title, note.markdown, note.cards])) return noteView(state, note);
  note.updatedAt = new Date().toISOString();
  note.revision = (note.revision || 0) + 1;
  if (isDailyWriting(note)) note.daily.manualEditedAt = note.updatedAt;
  if (note.generation?.status === "running") note.generation.status = "superseded";
  return noteView(state, note);
}

const BARE_TEMPLATES = new Set([
  "## 核心概念\n\n## 常见误区\n\n## 解析与例子\n\n## 学习记录",
  "## Core concepts\n\n## Common misconceptions\n\n## Explanation and examples\n\n## Study log",
]);

function collectAutoQuestionNoteBuckets(state, isRunning = defaultIsRunning) {
  const buckets = new Map();
  for (const note of state?.notes || []) {
    if (!isOpenQuestionNote(note) || isRunning(note.generation)) continue;
    const parsed = parseAutoQuestionNoteTitle(note.title);
    if (!parsed) continue;
    const course = inferNoteCardsCourse(state, note.cards, note.title);
    if (course === null) continue;
    const key = JSON.stringify([parsed.day, course]);
    let bucket = buckets.get(key);
    if (!bucket) buckets.set(key, bucket = { day: parsed.day, course, language: parsed.language, notes: [], parsed: [] });
    bucket.notes.push(note);
    bucket.parsed.push(parsed);
  }
  return buckets;
}

export function questionNotesNeedReconciliation(state, { isRunning = defaultIsRunning } = {}) {
  for (const bucket of collectAutoQuestionNoteBuckets(state, isRunning).values()) {
    if (bucket.notes.length >= 2) return true;
    const [only] = bucket.parsed;
    if (only && (only.legacy || (bucket.course && (!only.prefixDate || only.course !== bucket.course)))) return true;
  }
  return false;
}

/** Coalesce fragmented auto-titled `学习笔记 · <date>` drafts for the same `(day, course)` non-destructively in place. */
export function reconcileQuestionNotes(state, { isRunning = defaultIsRunning } = {}) {
  const buckets = collectAutoQuestionNoteBuckets(state, isRunning);
  const removed = new Set();
  let changed = false;
  for (const bucket of buckets.values()) {
    const { day, course, language, notes, parsed } = bucket;
    const nextTitle = formatDailyQuestionNoteTitle({ day, course, language });
    if (notes.length === 1) {
      const [only] = notes, [info] = parsed;
      if (info.legacy || (course && (!info.prefixDate || info.course !== course))) {
        only.markdown = replaceLeadingAutoHeading(only.markdown, only.title, nextTitle);
        only.title = nextTitle;
        only.day = day;
        only.origin ||= 'question';
        only.revision = (only.revision || 0) + 1;
        changed = true;
      }
      continue;
    }
    const primary = notes[0];
    const mergedCards = new Map();
    for (const ref of primary.cards || []) mergedCards.set(ref.cardId, ref);
    const mergedFollowups = [...new Set(primary.followupIds || [])];
    const bodies = [];
    const seenBodies = new Set();
    const pushBody = body => {
      if (!body || seenBodies.has(body)) return;
      seenBodies.add(body);
      bodies.push(body);
    };
    pushBody(stripLeadingAutoNoteHeading(primary.markdown, primary.title));
    let latestUpdated = String(primary.updatedAt || primary.createdAt || '');
    for (let index = 1; index < notes.length; index++) {
      const fragment = notes[index];
      if (mergedCards.size + (fragment.cards || []).length > MAX_QUESTION_NOTE_CARDS) continue;
      const body = stripLeadingAutoNoteHeading(fragment.markdown, fragment.title);
      const nextBodies = [...bodies];
      if (body && !seenBodies.has(body)) nextBodies.push(body);
      const nonBare = nextBodies.filter(part => !BARE_TEMPLATES.has(part));
      const chosenBodies = nonBare.length ? nonBare : nextBodies.slice(0, 1);
      const candidateMarkdown = chosenBodies.length
        ? `# ${nextTitle}\n\n${chosenBodies.join('\n\n---\n\n')}\n`
        : `# ${nextTitle}\n`;
      if (!validImageMarkdown(candidateMarkdown)) continue;
      if (body) pushBody(body);
      for (const ref of fragment.cards || []) if (!mergedCards.has(ref.cardId)) mergedCards.set(ref.cardId, ref);
      for (const fid of fragment.followupIds || []) if (!mergedFollowups.includes(fid)) mergedFollowups.push(fid);
      const stamp = String(fragment.updatedAt || fragment.createdAt || '');
      if (stamp > latestUpdated) latestUpdated = stamp;
      removed.add(fragment);
    }
    const nonBare = bodies.filter(part => !BARE_TEMPLATES.has(part));
    const finalBodies = nonBare.length ? nonBare : bodies.slice(0, 1);
    primary.title = nextTitle;
    primary.markdown = finalBodies.length ? `# ${nextTitle}\n\n${finalBodies.join('\n\n---\n\n')}\n` : `# ${nextTitle}\n`;
    primary.cards = [...mergedCards.values()];
    if (mergedFollowups.length || primary.followupIds) primary.followupIds = mergedFollowups;
    primary.day = day;
    primary.origin ||= 'question';
    if (latestUpdated) primary.updatedAt = latestUpdated;
    primary.revision = (primary.revision || 0) + 1;
    changed = true;
  }
  if (removed.size) state.notes = (state.notes || []).filter(note => !removed.has(note));
  return changed;
}

/** Pure read-only view of `state` with fragmented auto-titled question notes coalesced (zero mutation when already clean). */
export function coalescedNotesState(state, { isRunning = defaultIsRunning } = {}) {
  if (!questionNotesNeedReconciliation(state, { isRunning })) return state;
  const cloned = {
    ...state,
    notes: (state.notes || []).map(note => ({
      ...note,
      cards: (note.cards || []).map(ref => ({ ...ref })),
      ...(note.followupIds ? { followupIds: [...note.followupIds] } : {}),
    })),
  };
  reconcileQuestionNotes(cloned, { isRunning });
  return cloned;
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

/** The notes of each question, for the practice page. `qa`: the note 存进笔记 under this question writes to; `followupIds`: the Q&A it holds
    now (recorded and still in its text), so 已存进笔记 says what the server would say. */
export function noteBadges(state) {
  const badges = {};
  for (const note of state.notes || [])
    for (const ref of note.cards) {
      const target = openQuestionDraftForCard(state, ref.cardId) === note;
      const card = target ? state.decks?.find(deck => deck.id === ref.deckId)?.cards?.find(item => item.id === ref.cardId) : null;
      (badges[ref.cardId] ||= []).push({ noteId: note.id, title: note.title,
        status: note.status, url: note.publicUrl || null, qa: target, followupIds: target ? heldFollowupIds(note, card) : [] });
    }
  return badges;
}
