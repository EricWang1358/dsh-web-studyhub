/* Pure helpers behind the 创建题组 form (WP23): count stepping and presets, a
   count suggested from the material's size, the one-line summary above the
   submit button, and the small rules for what opens by default. No React, no
   I/O: Generate.jsx and its tests share them. */
import { ui, uiFormat } from './i18n.js';
import { sourceFormat } from '../lib/source-groups.js';
import { documentCount } from './generation-status.js';
import { normalizeNotation } from '../lib/notation.js';

export const COUNT_MIN = 1;
export const COUNT_MAX = 30;
export const COUNT_DEFAULT = 10;
export const COUNT_PRESETS = Object.freeze([5, 10, 20, 30]);

/** A question count the backend accepts: an integer from 1 to 30. */
export function clampCount(value, fallback = COUNT_DEFAULT) {
  const number = typeof value === 'string' && !value.trim() ? NaN : Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(COUNT_MAX, Math.max(COUNT_MIN, Math.round(number)));
}

/** The − and + buttons: one step, never past either end. */
export const stepCount = (value, delta) => clampCount(clampCount(value) + delta);

/* ---------- what is selected ---------- */

/** { materials, pages, chars }: documents, PDF pages, and the size of everything that is not a PDF page. */
export function selectionStats(sources = [], selectedIds = []) {
  const chosen = new Set(selectedIds);
  const selected = sources.filter((source) => chosen.has(source.id));
  const pdf = selected.filter((source) => sourceFormat(source) === 'pdf');
  const chars = selected.filter((source) => sourceFormat(source) !== 'pdf')
    .reduce((sum, source) => sum + (typeof source.text === 'string' ? source.text.length : Number(source.chars) || 0), 0);
  return { materials: documentCount(selected), pages: pdf.length, chars };
}

const CHARS_PER_PAGE = 1800;
/** About one question per two to three pages of material, from 5 to 20; null when nothing is selected. */
export function suggestCount({ pages = 0, chars = 0 } = {}) {
  const weight = pages + chars / CHARS_PER_PAGE;
  if (!(weight > 0)) return null;
  return Math.min(20, Math.max(5, Math.round(weight / 2.5)));
}

/* ---------- time ---------- */

const GENERATION_JOBS_USED = 5;
/** { low, high } minutes for `count` questions from the learner's own finished generation jobs, or null. */
export function estimateMinutes(jobs = [], count = COUNT_DEFAULT) {
  const finished = (Array.isArray(jobs) ? jobs : [])
    .filter((job) => job?.status === 'complete' && !job.type && job.kind !== 'case' && Number(job.count) > 0)
    .map((job) => ({ seconds: (Date.parse(job.finishedAt) - Date.parse(job.startedAt)) / 1000, count: Number(job.count), at: Date.parse(job.startedAt) }))
    .filter((job) => Number.isFinite(job.seconds) && job.seconds > 0)
    .sort((a, b) => b.at - a.at).slice(0, GENERATION_JOBS_USED);
  if (!finished.length) return null;
  const perQuestion = finished.reduce((sum, job) => sum + job.seconds, 0) / finished.reduce((sum, job) => sum + job.count, 0);
  const minutes = perQuestion * clampCount(count) / 60;
  return { low: Math.max(1, Math.round(minutes * 0.7)), high: Math.max(1, Math.ceil(minutes * 1.3)) };
}

/* ---------- choices ---------- */

export const KINDS = Object.freeze(['mixed', 'quiz', 'multi', 'flashcard', 'open', 'cloze']);
export const DIFFICULTIES = Object.freeze([
  { value: 'mixed', get label() { return ui('混合'); } },
  { value: 'foundation', get label() { return ui('基础理解'); } },
  { value: 'application', get label() { return ui('应用迁移'); } },
  { value: 'advanced', get label() { return ui('深入辨析'); } },
]);
export const LANGUAGES = Object.freeze([
  { value: '中文', get label() { return ui('中文'); } },
  { value: 'English', get label() { return 'English'; } },
  { value: '中英双语', get label() { return ui('中英双语'); } },
]);

/** 公式写法: how generated questions write formulas. Plain text is the most stable; LaTeX suits maths and chemistry. */
export const NOTATION_CHOICES = Object.freeze([
  { value: 'auto', get label() { return ui('自动'); } },
  { value: 'text', get label() { return ui('纯文本'); } },
  { value: 'latex', get label() { return ui('公式（LaTeX）'); } },
]);
export const notationNote = () => ui('纯文本更稳定；公式适合数学、化学');

/** The generation request the form sends: the form as typed, with a count the backend can read and a known notation. */
export const generationRequest = (gen, { course, sourceIds }) => ({ ...gen, course, count: Number(gen.count), sourceIds, notation: normalizeNotation(gen.notation) });

/** One line on what the chosen difficulty means. */
export function difficultyNote(value) {
  return ({
    mixed: ui('混合：基础、应用和辨析题搭配着出。'),
    foundation: ui('基础理解：概念和定义，适合第一遍过资料。'),
    application: ui('应用迁移：把知识用到具体场景里。'),
    advanced: ui('深入辨析：区分相似概念，考取舍和边界情况。'),
  })[value] || '';
}

/** One line on what the chosen question type is. */
export function kindNote(value) {
  return ({
    mixed: ui('“测验 + 闪卡”将总题数分配为一半单选、一半闪卡（奇数多一道单选），合并为一个待审题组。'),
    quiz: ui('单选题：一个正确答案，干扰项逐项解释。'),
    multi: ui('多选题：选出所有正确的选项。'),
    flashcard: ui('闪卡：先想一想，再翻面看答案。'),
    open: ui('开放问答：用自己的话作答，对照评分要点。'),
    cloze: ui('填空卡：句子里挖掉关键词，补全它。'),
  })[value] || '';
}

const languageLabel = (value) => LANGUAGES.find((item) => item.value === value)?.label || String(value || '');

/** The sentence above the submit button: what will be made, from what, and about how long it takes. */
export function summaryLine({ materials = 0, pages = 0, count = COUNT_DEFAULT, difficulty = 'mixed', language = '中文', minutes = null } = {}) {
  if (!(materials > 0)) return '';
  const sources = materials === 1 ? ui('1 份资料') : uiFormat('{0} 份资料', [materials]);
  const questions = clampCount(count) === 1 ? ui('1 题') : uiFormat('{0} 题', [clampCount(count)]);
  const size = pages > 0 ? (pages === 1 ? ui('约 1 页') : uiFormat('约 {0} 页', [pages])) : '';
  const what = size ? uiFormat('将从 {0}（{1}）出 {2}', [sources, size, questions]) : uiFormat('将从 {0}出 {1}', [sources, questions]);
  const level = difficulty === 'mixed' ? ui('混合难度') : DIFFICULTIES.find((item) => item.value === difficulty)?.label || '';
  const time = minutes ? (minutes.low >= minutes.high ? uiFormat('约 {0} 分钟', [minutes.high]) : uiFormat('约 {0}–{1} 分钟', [minutes.low, minutes.high])) : '';
  return [what, level, languageLabel(language), time].filter(Boolean).join(' · ');
}

/* ---------- focus text and suggestions ---------- */

const SEPARATOR = '；';
const parts = (text) => String(text || '').split(/[；;\n]/).map((item) => item.trim()).filter(Boolean);
export const focusIncludes = (text, item) => parts(text).includes(String(item).trim());
/** Add one focus phrase to the box once; the learner's own words stay. */
export function appendFocus(text, item) {
  const phrase = String(item || '').trim();
  if (!phrase || focusIncludes(text, phrase)) return String(text || '');
  const current = String(text || '').trim();
  return current ? `${current.replace(/[；;]$/, '')}${SEPARATOR}${phrase}` : phrase;
}

/** The count, difficulty and kind of a suggestion applied to the form; nothing else changes. */
export function applySuggestion(gen, suggestion = {}) {
  const next = { ...gen };
  if (Number.isInteger(suggestion.count)) next.count = clampCount(suggestion.count);
  if (DIFFICULTIES.some((item) => item.value === suggestion.difficulty)) next.difficulty = suggestion.difficulty;
  if (KINDS.includes(suggestion.kind)) next.kind = suggestion.kind;
  return next;
}
export const hasSettings = (suggestion = {}) => Number.isInteger(suggestion.count)
  || DIFFICULTIES.some((item) => item.value === suggestion.difficulty) || KINDS.includes(suggestion.kind);

/* ---------- defaults ---------- */

/** The target role is for interview preparation; a role already typed stays visible. */
export const roleOpenByDefault = ({ goal, focus, role } = {}) => goal === 'interview' || focus?.mode === 'interview' || !!String(role || '').trim();

/** A stated exam with case or open questions (the course's own record). */
export const courseHasCaseExam = (course) => ['open-book-case', 'mixed'].includes(course?.exam?.format);
