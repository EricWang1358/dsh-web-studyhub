/* Pure helpers behind the 创建题组 form (WP23, phase 3 of coverage-generation): the 覆盖强度 choice (精简 / 标准 / 完整) and what it means in words, the optional custom number of
   questions, the line that says before the run what the choice means for the chosen materials, the one-line summary above the submit button, and the small rules for what opens by
   default. No React, no I/O: Generate.jsx and its tests share them. */
import { ui, uiFormat } from './i18n.js';
import { sourceFormat } from '../lib/source-groups.js';
import { documentCount } from './generation-status.js';
import { normalizeNotation } from '../lib/notation.js';
import { LEVELS, DEFAULT_LEVEL, STRENGTH, levelOf, autoCompleteOf } from '../lib/coverage-strength.js';
import { parseTokenBudget } from '../lib/coverage-run.js';
import { GOAL_QUESTIONS_MAX } from '../lib/limits.js';
import { nonEvidenceRanges } from '../lib/sections.js';
import { countOf, levelLabel } from './coverage/copy.js';
import { META_DOT } from './format.js';

export const COUNT_MIN = 1;
/** The most questions a request may ask for (lib/limits.js GOAL_QUESTIONS_MAX): what does not fit in one round of 30 becomes rounds. */
export const COUNT_MAX = GOAL_QUESTIONS_MAX;
export const COUNT_DEFAULT = 10;
/** The quick choices of the custom number of questions. */
export const COUNT_PRESETS = Object.freeze([10, 30, 60, 100]);

/** 覆盖强度: the three levels of lib/coverage-strength.js with the words the form uses. */
export const COVERAGE_LEVELS = Object.freeze(LEVELS.map(value => Object.freeze({ value, get label() { return levelLabel(value); } })));
export { DEFAULT_LEVEL, levelLabel };

/** One line on what a level means (the numbers are the table of lib/coverage-strength.js). */
export function levelNote(value) {
  const level = levelOf(value), config = STRENGTH[level];
  return ({
    lean: uiFormat('精简：只给最重要的部分出题（合计约占内容的六成，每段录音至少一处），每万字约 {0} 题，适合考前过一遍。', [config.perTenK]),
    standard: uiFormat('标准：每个不少于 {0} 字的部分都出题，更长、更重要的部分题更多，每万字约 {1} 题。', [config.minChars, config.perTenK]),
    full: uiFormat('完整：每个部分都出题，再短的也不漏，每万字约 {0} 题，适合要考得很细的资料。', [config.perTenK]),
  })[level];
}

/** A question count the backend accepts: a whole number from 1 to COUNT_MAX. */
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
  // The size that counts is the evidence: a bilingual transcript is counted in its original language only (lib/sections.js nonEvidenceRanges), like the plan the backend makes.
  const chars = selected.filter((source) => sourceFormat(source) !== 'pdf')
    .reduce((sum, source) => sum + (typeof source.text === 'string' ? source.text.length - nonEvidenceRanges(source.text).reduce((lost, [from, to]) => lost + to - from, 0) : Number(source.chars) || 0), 0);
  return { materials: documentCount(selected), pages: pdf.length, chars };
}

const CHARS_PER_PAGE = 1800;
/** What a coverage level means in questions for a selection of this size, before the sections are known: the density of the level (questions per 10 000 characters, lib/coverage-strength.js)
    over its characters, a PDF page counting as about 1 800. Never cut to a small number; null when nothing is selected. The exact plan is the backend's (the line under the choice). */
export function suggestCount({ pages = 0, chars = 0 } = {}, level = DEFAULT_LEVEL) {
  const total = pages * CHARS_PER_PAGE + chars;
  if (!(total > 0)) return null;
  return Math.min(COUNT_MAX, Math.max(1, Math.round(STRENGTH[levelOf(level)].perTenK * total / 10000)));
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

/** The custom number of questions the learner typed (`gen.customCount`): a whole number from 1 to COUNT_MAX, else null (the level decides). */
export function customCountOf(gen) {
  const text = String(gen?.customCount ?? '').trim();
  if (!/^\d+$/.test(text)) return null;
  const number = Number(text);
  return number >= COUNT_MIN && number <= COUNT_MAX ? number : null;
}

/** The generation request the form sends: the form as typed, the 覆盖强度 and, only when the learner typed one, a total number of questions. A request without a count is planned by its level. */
export function generationRequest(gen, { course, sourceIds }) {
  const { count: _saved, customCount: _typed, autoComplete: _chosen, tokenBudget: _budget, ...rest } = gen, custom = customCountOf(gen), budget = parseTokenBudget(gen.tokenBudget);
  return { ...rest, course, sourceIds, notation: normalizeNotation(gen.notation), coverageLevel: levelOf(gen.coverageLevel), autoComplete: autoOf(gen), ...(budget ? { tokenBudget: budget } : {}), ...(custom ? { count: custom } : {}) };
}

/** Whether the run goes on by itself (「自动补到完整」): what the learner chose, else what the level's row of the table says (lib/coverage-strength.js: 精简 waits for the learner, 标准 and 完整 go on). */
export const autoOf = (gen) => (typeof gen?.autoComplete === 'boolean' ? gen.autoComplete : autoCompleteOf(gen?.coverageLevel));

/** What is said under the spending limit: what it does, or that the number was not understood. */
export const budgetNote = (text) => (String(text ?? '').trim() && !parseTokenBudget(text)
  ? ui('没看懂这个数：请写成 800K、2.5M 或 1200000（至少 1000）。')
  : ui('一轮结束后，累计用量到了这个数就停下，已出的题都保留。不填就不设上限。'));

/** What a coverage estimate (`usage.estimate`'s `coverage`) says, as the first words of the line under the choice: 「标准：约 343 道题，覆盖 81/81 个部分，分 12 轮，」 (the estimate's tokens and calls follow). */
export function coverageLead(coverage) {
  if (!coverage?.goal) return '';
  const rounds = coverage.rounds > 1 ? uiFormat('分 {0} 轮', [coverage.rounds]) : ui('一轮出完');
  const parts = countOf(coverage.units, coverage.leaves);
  return coverage.custom ? uiFormat('自定义：{0} 道题，覆盖 {1}/{2}，{3}，', [coverage.goal, coverage.sections, parts, rounds])
    : uiFormat('{0}：约 {1} 道题，覆盖 {2}/{3}，{4}，', [levelLabel(coverage.level), coverage.goal, coverage.sections, parts, rounds]);
}

/** The three levels side by side for the same sources: 「精简约 172 题 · 标准约 343 题 · 完整约 500 题」. */
export function levelsLine(coverage) {
  if (!coverage?.levels) return '';
  return LEVELS.filter(level => coverage.levels[level]).map(level => uiFormat('{0}约 {1} 题', [levelLabel(level), coverage.levels[level].goal])).join(META_DOT);
}

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

/** The sentence above the submit button: what will be made, from what, and about how long it takes. `count` is the number of questions the plan makes (the estimate's goal); without it the sentence leaves the number out. */
export function summaryLine({ materials = 0, pages = 0, count = null, difficulty = 'mixed', language = '中文', minutes = null } = {}) {
  if (!(materials > 0)) return '';
  const sources = materials === 1 ? ui('1 份资料') : uiFormat('{0} 份资料', [materials]);
  const total = Number.isFinite(Number(count)) && Number(count) >= 1 ? clampCount(count) : null;
  const questions = total === null ? '' : total === 1 ? ui('1 题') : uiFormat('{0} 题', [total]);
  const size = pages > 0 ? (pages === 1 ? ui('约 1 页') : uiFormat('约 {0} 页', [pages])) : '';
  const what = total === null ? (size ? uiFormat('将从 {0}（{1}）出题', [sources, size]) : uiFormat('将从 {0}出题', [sources]))
    : size ? uiFormat('将从 {0}（{1}）出 {2}', [sources, size, questions]) : uiFormat('将从 {0}出 {1}', [sources, questions]);
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

/** The coverage level, difficulty and kind of a suggestion applied to the form; nothing else changes. */
export function applySuggestion(gen, suggestion = {}) {
  const next = { ...gen };
  if (LEVELS.includes(suggestion.coverage)) next.coverageLevel = suggestion.coverage;
  if (DIFFICULTIES.some((item) => item.value === suggestion.difficulty)) next.difficulty = suggestion.difficulty;
  if (KINDS.includes(suggestion.kind)) next.kind = suggestion.kind;
  return next;
}
export const hasSettings = (suggestion = {}) => LEVELS.includes(suggestion.coverage)
  || DIFFICULTIES.some((item) => item.value === suggestion.difficulty) || KINDS.includes(suggestion.kind);

/* ---------- defaults ---------- */

/** The target role is for interview preparation; a role already typed stays visible. */
export const roleOpenByDefault = ({ goal, focus, role } = {}) => goal === 'interview' || focus?.mode === 'interview' || !!String(role || '').trim();

/** A stated exam with case or open questions (the course's own record). */
export const courseHasCaseExam = (course) => ['open-book-case', 'mixed'].includes(course?.exam?.format);
