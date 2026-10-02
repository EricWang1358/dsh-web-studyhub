/* The course side of the guided flow: which topics a course holds, how a goal
   sentence is matched against names, which other course might fit better, and
   how a bank-imported card is shown instead of its raw JSON. Pure functions
   over the study state; lib/workflows.js and lib/workflow-guide.js use them. */
import { skeletonTopics } from "./skeleton.js";
import { libraryCourses } from "./source-courses.js";
import { decksInCourse } from "./focus.js";
import { isJsonCardSource } from "./source-provenance.js";

const usable = (deck) => !deck.archived && !deck.systemKind;
export const deckCourse = (deck) => deck.course ?? deck.folder ?? "";
const clip = (value, n) => { const text = String(value ?? "").trim(); return text.length > n ? `${text.slice(0, n - 1)}…` : text; };

/** The decks of a course scope: the course and the courses inside it (lib/course-tree.js). */
export const courseDecks = (state, course) => decksInCourse(state, course).filter(usable);

/** Topics of one course's decks, merged by name, as skeletonTopics() lists them. */
export const courseTopics = (state, course) => skeletonTopics({ ...state, decks: courseDecks(state, course) });

// Words that say how someone wants to learn, not what: they would match everything.
const FILLER = ["为什么", "弄清楚", "搞清楚", "弄懂", "搞懂", "学会", "学习", "理解", "掌握", "了解", "复习", "重点", "知识点", "我想", "想要", "想学",
  "帮我", "一下", "什么", "时候", "怎么", "如何", "哪些", "内容", "相关", "关于", "一些"];
const LATIN_STOP = new Set(["the", "and", "for", "with", "about", "what", "how", "why", "learn", "study", "understand", "know", "of", "to", "in",
  "on", "is", "are", "my", "me", "from", "this", "that", "into", "want", "need", "help", "key", "points"]);

/** Searchable pieces of a goal: latin words, and CJK runs as overlapping pairs. */
export function goalTokens(goal) {
  const text = String(goal ?? "").toLowerCase();
  const tokens = [];
  const add = (token) => { if (!tokens.includes(token)) tokens.push(token); };
  for (const word of text.match(/[a-z0-9]+/g) || []) if (word.length >= 2 && !LATIN_STOP.has(word)) add(word);
  let cjk = text.replace(/[^㐀-鿿]+/g, " ");
  for (const filler of FILLER) cjk = cjk.replaceAll(filler, " ");
  for (const run of cjk.split(/\s+/).filter((part) => part.length >= 2)) {
    if (run.length === 2) add(run);
    else for (let i = 0; i + 2 <= run.length; i++) add(run.slice(i, i + 2));
  }
  return tokens;
}

/** The best-matching other course for a goal, by course name and topic names, or null. */
export function courseHint(state, goal, current) {
  const words = goalTokens(goal);
  if (!words.length) return null;
  let best = null;
  for (const name of libraryCourses(state)) {
    if (name === current) continue;
    const topics = courseTopics(state, name);
    if (!topics.length) continue;
    const hay = [name, ...topics.map((t) => t.topic)].join(" ").toLowerCase();
    const score = words.filter((word) => hay.includes(word)).length;
    if (!score) continue;
    const cards = topics.reduce((n, t) => n + t.count, 0);
    if (!best || score > best.score || (score === best.score && cards > best.cards)) best = { course: name, cards, score };
  }
  return best ? { course: best.course, cards: best.cards } : null;
}

/** Courses a session can move to, with how much each holds. Courses without cards cannot be studied. */
export function courseChoices(state, current) {
  return libraryCourses(state).map((name) => {
    const decks = courseDecks(state, name);
    return { name, current: name === current, decks: decks.length,
      cards: decks.reduce((n, deck) => n + deck.cards.filter((card) => !card.suspended).length, 0) };
  }).filter((course) => course.cards > 0 || course.current);
}

/** Something that is a card object rather than prose: bank imports once stored the card itself as its quote. */
export const isCardJson = (text) => /^\s*\{/.test(String(text ?? ""));

/** A card, compactly: what it asks, what the answer is, and which deck it is in. */
export function cardSummary(card, deckTitle) {
  const prompt = card.kind === "cloze" && card.cloze?.text ? String(card.cloze.text).replace(/\{\{[^{}]+\}\}/g, "＿＿") : card.prompt;
  return { kind: card.kind, prompt: clip(prompt, 400), ...(card.answer ? { answer: clip(card.answer, 600) } : {}), deck: deckTitle || "" };
}

/** A reading entry for one card: real source quotes stay, self-references become a card summary. */
export function readingFor({ deckId, card }, { sources, titles }) {
  const own = new Set(sources.filter(isJsonCardSource).map((source) => source.id));
  const real = [], dropped = [];
  for (const citation of card.citations || []) (own.has(citation.sourceId) || isCardJson(citation.quote) ? dropped : real).push(citation);
  const showCard = dropped.length > 0 || (card.importedFromJson && !real.length);
  return { deckId, cardId: card.id, topic: card.topic, explanation: card.explanation, citations: real,
    ...(showCard ? { card: cardSummary(card, titles.get(deckId)) } : {}) };
}
