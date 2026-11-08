import { courseIndex } from "./courses.js";
import { courseAncestors, coursePath, courseScope } from "./course-tree.js";
import { courseOf } from "./focus.js";
import { knownCourseNames } from "./source-courses.js";

/* Exam & course focus highlights ("重点"): pure, browser-safe helpers shared by
   scheduling (FSRS-6 higher target recall), queue & plan prioritisation,
   4-stage question generation (section weighting + cognitive depth escalation),
   and deterministic / AI focus intake. Zero Node I/O. */

export const CARD_DIFFICULTIES = Object.freeze(["foundation", "application", "advanced"]);
export const FOCUS_TOPIC_MAX = 50;
export const FOCUS_TOPIC_CHARS = 200;
export const MAX_FOCUS_IMAGES = 10;
export const MAX_FOCUS_IMAGE_BYTES = 10 * 1024 * 1024;

const LEADING_MARKERS = /^(?:[-•·▪▸▶►✓✔☆★]+|[*]\s+|\(?\d{1,3}[.)、．]|\([一二三四五六七八九十]+\)|[一二三四五六七八九十]+[、．.]|[①-⑳])\s*/u;
const LEADING_LABELS = /^(?:期末复习重点|考试重点|复习重点|核心重点|高频考点|必考重点|重点知识点|重点内容|核心考点|考点|重点|必考|Key\s*points?|Exam\s*(?:focus|highlights?|topics?)|Focus\s*topics?)\s*\d*\s*[:：\-—]\s*/iu;
const TRAILING_PUNCT = /[\s;；,，。！!？?、：:]+$/u;
const HEADER_ONLY = /^(?:期末(?:考试)?(?:复习)?(?:重点|范围|提纲|大纲)?|考试(?:重点|范围|大纲|说明)|复习(?:重点|提纲|范围)|划重点|重点汇总|Chapter\s+\d+|Week\s+\d+|Lecture\s+\d+|Part\s+[A-Z0-9]+|第\s*[一二三四五六七八九十百\d]+\s*[章节部分讲周页]|Page\s+\d+|\d+\s*\/\s*\d+|-\s*\d+\s*-|\[看不清\]|\[illegible\])$/iu;
const SHORT_ASCII_TOKEN = /^[a-z0-9_+-]{1,3}$/i;
const CJK_CHAR = /[\u3400-\u9fff]/u;

const escapeRegex = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Clean one focus phrase into a concise, canonical topic string ('' when empty or noise). */
export function normalizeFocusTerm(raw) {
  if (typeof raw !== "string") return "";
  let text = raw.replace(/\r/g, "").replace(/\s+/g, " ").trim();
  if (!text) return "";
  // Strip Markdown headings, checkboxes, bold/code wrappers and bullet prefixes iteratively.
  text = text.replace(/^#{1,6}\s+/, "").replace(/^\[[ xX]\]\s*/, "");
  for (let pass = 0; pass < 3; pass++) {
    const before = text;
    text = text.replace(LEADING_MARKERS, "").replace(LEADING_LABELS, "").trim();
    if (text === before) break;
  }
  text = text.replace(TRAILING_PUNCT, "").trim().replace(/^\*\*(.+)\*\*$/, "$1").replace(/^`(.+)`$/, "$1").replace(TRAILING_PUNCT, "").trim();
  if (!text || HEADER_ONLY.test(text)) return "";
  if (text.length < 2 && !CJK_CHAR.test(text)) return "";
  return text.length > FOCUS_TOPIC_CHARS ? text.slice(0, FOCUS_TOPIC_CHARS).trim() : text;
}

/** Deduplicate and cap a list of focus topics while keeping first-seen order and spelling. */
export function cleanFocusTopics(items, { limit = FOCUS_TOPIC_MAX } = {}) {
  if (!Array.isArray(items)) return [];
  const out = [];
  const seen = new Set();
  for (const item of items) {
    const cleaned = normalizeFocusTerm(item);
    if (!cleaned) continue;
    const key = cleaned.normalize("NFKC").toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(cleaned);
    if (out.length >= limit) break;
  }
  return out;
}

/** Merge incoming focus topics onto an existing list without losing existing entries (up to `limit`). */
export function mergeFocusTopics(existing = [], incoming = [], { limit = FOCUS_TOPIC_MAX } = {}) {
  return cleanFocusTopics([...(Array.isArray(existing) ? existing : []), ...(Array.isArray(incoming) ? incoming : [])], { limit });
}

function splitOutsideBrackets(text, delimiters) {
  const out = [];
  let depth = 0, start = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if ("(（[【{".includes(ch)) depth++;
    else if (")）]】}".includes(ch)) depth = Math.max(0, depth - 1);
    else if (depth === 0 && delimiters.includes(ch)) {
      const piece = text.slice(start, i).trim();
      if (piece) out.push(piece);
      start = i + 1;
    }
  }
  const tail = text.slice(start).trim();
  if (tail) out.push(tail);
  return out;
}

function splitFocusLine(line) {
  const trimmed = line.replace(/\s+/g, " ").trim();
  if (!trimmed) return [];
  // Semicolon / pipe separated lists on one line (outside parentheses/brackets).
  if (/[;；｜|]/.test(trimmed)) {
    const parts = splitOutsideBrackets(trimmed, ";；｜|");
    if (parts.length >= 2) return parts;
  }
  // Short enumeration separated by Chinese enumeration comma `、` outside brackets
  // (e.g. "死锁条件、银行家算法、页面置换"):
  if (trimmed.includes("、") && !/[。！？!?]/.test(trimmed)) {
    const stripped = trimmed.replace(LEADING_MARKERS, "").replace(LEADING_LABELS, "");
    const parts = splitOutsideBrackets(stripped, "、");
    if (parts.length >= 2 && parts.every((part) => part.length >= 2 && part.length <= 32)) return parts;
  }
  return [trimmed];
}

/**
 * Deterministically parse pasted exam-scope notes, chat messages or OCR text into
 * `{ topics: string[], markdown: string }` with zero model calls (`requiresModel: false`).
 */
export function parseFocusText(raw, { limit = FOCUS_TOPIC_MAX, title = "" } = {}) {
  const source = typeof raw === "string" ? raw.replace(/\uFEFF/g, "").replace(/\r\n?/g, "\n").trim() : "";
  if (!source) return { topics: [], markdown: "" };
  const candidates = [];
  for (const rawLine of source.split("\n")) {
    const line = rawLine.trim();
    if (!line || /^```/.test(line) || /^---+$/.test(line)) continue;
    for (const segment of splitFocusLine(line)) candidates.push(segment);
  }
  const topics = cleanFocusTopics(candidates, { limit });
  const heading = typeof title === "string" && title.trim() ? `# ${title.trim()}\n\n` : "";
  const body = topics.length
    ? `${heading}## 重点知识点\n\n${topics.map((topic) => `- ${topic}`).join("\n")}\n\n## 原始记录\n\n${source}`
    : `${heading}${source}`;
  return { topics, markdown: body.slice(0, 100_000) };
}

const MATCHER_CACHE = new Map();
const MATCHER_CACHE_MAX = 512;

function compileRule(topic) {
  const needle = topic.normalize("NFKC").toLowerCase();
  if (!needle) return null;
  if (SHORT_ASCII_TOKEN.test(needle)) {
    const pattern = new RegExp(`(?<![a-z0-9])${escapeRegex(needle)}(?![a-z0-9])`, "i");
    return { topic, test: (haystack) => pattern.test(haystack) };
  }
  if (needle.length < 2) return null;
  return { topic, test: (haystack) => haystack.includes(needle) };
}

/**
 * Compile a fast, memoized matcher for a list of focus topics.
 * Safe to call inside tight loops (`planPath`, `snapshot`, `study.scene.get`).
 */
export function focusMatcher(focusTopics) {
  const topics = cleanFocusTopics(focusTopics, { limit: 200 });
  const cacheKey = topics.join("\u0001");
  const hit = MATCHER_CACHE.get(cacheKey);
  if (hit) return hit;
  const rules = topics.map(compileRule).filter(Boolean);
  const normText = (value) => (typeof value === "string" && value ? value.normalize("NFKC").toLowerCase() : "");
  const matchesText = (value) => {
    if (!rules.length) return false;
    const hay = normText(value);
    return !!hay && rules.some((rule) => rule.test(hay));
  };
  const matchingTopics = (...values) => {
    if (!rules.length) return [];
    const hay = values.map(normText).filter(Boolean).join("\n");
    if (!hay) return [];
    return rules.filter((rule) => rule.test(hay)).map((rule) => rule.topic);
  };
  const matcher = Object.freeze({ topics, empty: rules.length === 0, matchesText, matchingTopics });
  if (MATCHER_CACHE.size >= MATCHER_CACHE_MAX) MATCHER_CACHE.clear();
  MATCHER_CACHE.set(cacheKey, matcher);
  return matcher;
}

/**
 * Why a card counts as focus: `'card'` (explicit `card.focus === true`),
 * `'course'` (matches `focusTopics`), or `null`.
 */
export function cardFocusSource(card, { focusTopics, matcher } = {}) {
  if (!card || typeof card !== "object") return null;
  if (card.focus === true) return "card";
  const m = matcher || (focusTopics ? focusMatcher(focusTopics) : null);
  if (!m || m.empty) return null;
  if (m.matchesText(card.topic) || m.matchesText(card.objective) || m.matchesText(card.prompt)) return "course";
  return null;
}

/** True when `card` is marked `focus: true` or matches one of the course's `focusTopics`. */
export function isFocusCard(card, options = {}) {
  return cardFocusSource(card, options) !== null;
}

/** Focus topics matched by a document section (its title, heading path, or body excerpt). */
export function sectionMatchesFocus(section, text = "", { focusTopics, matcher } = {}) {
  const m = matcher || focusMatcher(focusTopics);
  if (m.empty) return [];
  const heading = [section?.title, ...(Array.isArray(section?.headingPath) ? section.headingPath : []), section?.path]
    .filter((item) => typeof item === "string" && item.trim())
    .join(" / ");
  return m.matchingTopics(heading, typeof text === "string" ? text.slice(0, 8000) : "");
}

/**
 * Resolve the effective `focusTopics` for a course name in `state`.
 * A chapter course (`"OS / Ch 3"`) inherits its parent course's `focusTopics`,
 * and when `includeDescendants` is true (e.g. viewing `"OS"` as a whole), chapter-level
 * focus topics inside `"OS"` are included too.
 */
export function courseFocusTopics(state, courseName, { includeDescendants = false } = {}) {
  if (!state || typeof courseName !== "string" || !courseName.trim() || courseName === "*") return [];
  const courses = Array.isArray(state.courses) ? state.courses : [];
  if (!courses.some((record) => record?.focusTopics?.length)) return [];
  const index = courseIndex(state);
  const known = [...new Set([...knownCourseNames(state), ...courses.map((record) => record?.name).filter(Boolean)])];
  const collected = [];
  const ancestors = new Set(courseAncestors(courseName, known));
  for (const ancestor of ancestors) {
    const resolved = index.resolve(ancestor);
    if (resolved?.focusTopics?.length) collected.push(...resolved.focusTopics);
  }
  for (const record of courses) {
    if (record?.focusTopics?.length && record.name && ancestors.has(coursePath(record.name, known))) {
      collected.push(...record.focusTopics);
    }
  }
  const direct = index.resolve(courseName);
  if (direct?.focusTopics?.length) collected.push(...direct.focusTopics);
  if (includeDescendants) {
    const within = courseScope(courseName, known);
    for (const record of courses) {
      if (record?.focusTopics?.length && within(record.name)) collected.push(...record.focusTopics);
    }
  }
  return cleanFocusTopics(collected, { limit: 200 });
}

/**
 * Build a fast `(deck, card) => boolean` predicate for `state` that checks both
 * `card.focus === true` and the deck's course `focusTopics` (cached per course).
 */
export function stateFocusPredicate(state) {
  const byCourse = new Map();
  const matcherFor = (courseName) => {
    const key = typeof courseName === "string" ? courseName : "";
    let matcher = byCourse.get(key);
    if (!matcher) {
      matcher = key ? focusMatcher(courseFocusTopics(state, key)) : focusMatcher([]);
      byCourse.set(key, matcher);
    }
    return matcher;
  };
  return (deck, card) => {
    if (card?.focus === true) return true;
    const course = deck ? courseOf(deck) : "";
    const matcher = matcherFor(course);
    return !matcher.empty && isFocusCard(card, { matcher });
  };
}

/**
 * Escalate question cognitive depth for highlighted ("重点") targets:
 * foundation -> application, mixed -> advanced, application -> advanced, advanced -> advanced.
 */
export function escalateFocusDifficulty(difficulty, { status } = {}) {
  if (status === "done") return CARD_DIFFICULTIES.includes(difficulty) ? difficulty : "application";
  if (difficulty === "foundation") return "application";
  return "advanced";
}
