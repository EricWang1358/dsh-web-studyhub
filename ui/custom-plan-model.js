import { ui, uiFormat } from './i18n.js';
import { formatList, joinMeta } from './format.js';
import { levelText } from './outline/words.js';
import { formatCompactTokens } from '../lib/token-usage.js';
import { BASIC_KINDS } from '../lib/generation-settings.js';
import { closedParts, customDefaults, lockedParts, partsWithout } from '../lib/custom-plan.js';

/* 「你的定制」 (深度定制, lib/custom-plan.js) in words and in toggles: the one-sentence summary of a course's 定制方案, the rough cost line, and the pure changes the card's
   switches make to the record. Every change is a whole, valid record again (the parts closed by lib/custom-plan.js, never a book with no part), so the card saves
   it as it is through course.save {custom}. Pure; the words go through ui() so the English catalogue (ui/locales/en.custom-plan.json) has them. */

const PURPOSE_WORDS = { preview: () => ui('课前预习'), follow: () => ui('跟课学习'), review: () => ui('期末复习'), openbook: () => ui('开卷备考') };
/** The part names, in the book's order (lib/custom-plan.js BOOK_PARTS): the chip, and in the sentence. 讲解 is said with its level there. */
const PART_WORDS = { explain: () => ui('讲解'), terms: () => ui('术语卡'), formulas: () => ui('公式页'), index: () => ui('索引'), confusables: () => ui('易混对照'),
  answerKit: () => ui('答题模板'), cheatSheet: () => ui('速查表') };
const PART_TIPS = { explain: () => ui('每个知识点的讲解；术语卡、公式页和索引都是从它写出来的。'), terms: () => ui('术语卡：每个术语一张卡，写在讲解之后。'),
  formulas: () => ui('公式页：把讲解里的公式按章节列成一页，不需要再调用模型。'), index: () => ui('索引：按字母排的术语表和按章节的卡片目录，不需要再调用模型。'),
  confusables: () => ui('易混对照：把相反或并列的术语成对比较，会多调用几次模型。'), answerKit: () => ui('答题模板：从样卷里的题归纳答题套路；没有样卷就不会生成。'),
  cheatSheet: () => ui('速查表：把卡片、模板、对照和公式排成可打印的一页，不需要再调用模型。') };
const KIND_WORDS = { quiz: () => ui('选择'), multi: () => ui('多选'), flashcard: () => ui('闪卡'), open: () => ui('开放问答'), cloze: () => ui('填空') };

export const partWord = id => PART_WORDS[id]();
export const partTip = id => PART_TIPS[id]();
export const lockedPartIds = custom => lockedParts(custom.book.parts);

/** The chapter numbers of ids named `<document key>#<n>` (n is the chapter's index, counted from 0): a single material's number list, or null. */
function chapterNumbers(ids) {
  const parsed = ids.map(id => { const at = id.lastIndexOf('#'); return at > 0 && /^\d+$/.test(id.slice(at + 1)) ? { doc: id.slice(0, at), n: Number(id.slice(at + 1)) + 1 } : null; });
  if (parsed.some(item => !item) || new Set(parsed.map(item => item.doc)).size !== 1) return null;
  return [...new Set(parsed.map(item => item.n))].sort((a, b) => a - b);
}

function scopeText(scope) {
  if (scope.kind === 'all') return ui('全部章节');
  if (scope.kind === 'exam') return ui('考试范围');
  const numbers = chapterNumbers(scope.chapters);
  if (numbers && numbers.length === 1) return uiFormat('第 {0} 章', [numbers[0]]);
  if (numbers && numbers[numbers.length - 1] - numbers[0] + 1 === numbers.length) return uiFormat('第 {0}–{1} 章', [numbers[0], numbers[numbers.length - 1]]);
  if (numbers && numbers.length <= 4) return uiFormat('第 {0} 章', [formatList(numbers)]);
  return uiFormat('{0} 章', [scope.chapters.length]);
}

function bookText(book) {
  if (!book.make || !book.parts.length) return ui('不做复习全书');
  return book.parts.map(id => (id === 'explain' ? uiFormat('讲解{0}', [levelText(book.coverage)]) : partWord(id))).join(' + ');
}

/** The kinds in a few words: 选择 for single choice (alone or with multiple choice), 多选 for multiple choice alone, the rest in the form's order; all of them are 各种题型. */
function kindsText(kinds) {
  if (BASIC_KINDS.every(kind => kinds.includes(kind))) return ui('各种题型');
  const words = BASIC_KINDS.filter(kind => kinds.includes(kind) && !(kind === 'multi' && kinds.includes('quiz'))).map(kind => KIND_WORDS[kind]());
  return words.length < 2 ? words.join('') : uiFormat('{0}和{1}', [formatList(words.slice(0, -1)), words[words.length - 1]]);
}

function planText(plan) {
  if (!plan.make) return ui('不排计划');
  return plan.by === 'weekly' ? uiFormat('每周 {0} 章排计划', [plan.chaptersPerWeek ?? 1]) : ui('按考试日期排计划');
}

/** 「期末复习 · 第 3–9 章 · 讲解标准 + 术语卡 + 速查表 · 选择和填空 · 按考试日期排计划」 */
export function customSummary(custom) {
  return joinMeta([PURPOSE_WORDS[custom.purpose](), scopeText(custom.scope), bookText(custom.book), custom.questions.make ? kindsText(custom.questions.kinds) : ui('不出题'), planText(custom.plan)]);
}

/** The cost line of course.custom.preview's estimate: calls and tokens read, roughly; never a price. */
export function estimateLine(estimate) {
  if (!estimate?.total) return '';
  if (!estimate.total.calls) return ui('不需要模型调用');
  return uiFormat('粗估：约 {0} 次模型调用，读取约 {1}', [estimate.total.calls, `${formatCompactTokens(estimate.total.readTokens)} tok`]);
}

/* ---------- the changes the switches make ---------- */

/** Tick or untick one part of the book: a part brings what it rests on, unticking takes what rested on it; no part left is no book (make: false). */
export function togglePart(custom, id) {
  const parts = custom.book.parts.includes(id) ? partsWithout(custom.book.parts, id) : closedParts([...custom.book.parts, id]);
  return { ...custom, book: { ...custom.book, make: parts.length > 0, parts } };
}

/** The questions on or off; on again with no kinds (a record that was saved off) gets the purpose's own. */
export function setQuestions(custom, make) {
  const kinds = custom.questions.kinds.length ? custom.questions.kinds : customDefaults(custom.purpose).questions.kinds;
  return { ...custom, questions: { ...custom.questions, make, kinds } };
}
export const setVariants = (custom, variants) => ({ ...custom, questions: { ...custom.questions, variants } });
export const setPlan = (custom, make) => ({ ...custom, plan: { ...custom.plan, make } });

/** What course.save takes: the course by id and the whole record. */
export const saveArgs = (course, custom) => ({ id: course.id, name: course.name, custom });
