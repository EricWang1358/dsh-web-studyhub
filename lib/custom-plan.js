/* 深度定制 (4.4): the 定制方案 of a course, the record a learner agrees to in the main chat after a few option questions (what the book is for, which chapters,
   which parts of the 复习全书, whether and which questions, whether a study plan). It is the course record's optional `custom` (lib/courses.js), saved only
   through course.save {custom} and checked here, exactly as `plan` is (`null` removes it); nothing the learner did not tick is made from it. Pure, browser-safe.

     { version: 1,
       purpose: 'preview' | 'follow' | 'review' | 'openbook',   课前预习 / 跟课 / 期末复习 / 开卷考试
       scope: { kind: 'all' | 'exam' | 'chapters', chapters?: [chapter id], note?: text },
       book: { make: boolean, coverage: 'brief' | 'standard' | 'full', parts: [part id] },
       questions: { make: boolean, kinds: [question kind], strength: 'lean' | 'standard' | 'full', variants: boolean },
       plan: { make: boolean, by: 'exam' | 'weekly', chaptersPerWeek?: 1-10, minutesPerDay?: 15-960 },
       sampleFirst: boolean,                                  write a small sample and wait for the learner (lib/contexts/generation/book SAMPLE_FROM)
       updatedAt? }                                           stamped by the save, never taken from the caller

   THE IDS ARE THE REPO'S OWN. coverage: lib/book-settings.js COVERAGE_LEVELS. kinds: lib/generation-settings.js BASIC_KINDS (quiz 单选, multi 多选, flashcard 闪卡,
   open 开放问答, cloze 填空). strength: lib/coverage-strength.js LEVELS (lean 精简, standard 标准, full 完整). `variants` is 变式题: whether the wrong answers
   get variants prepared (nothing is written for it before a question is answered wrong). `plan` is the schedule of lib/plan-schedule.js, made by the program
   with no model call; what the chat drafts with the learner is the 备考计划 of `course.save {plan}`.

   CHAPTER IDS, so the questions can be asked before anything is spent: with a current course outline, the ids of its top-level nodes (what
   generation.courseBook.build {chapters} takes); without one, the ids that exist BEFORE any model call: a chapter of a material of the course
   (lib/source-groups.js chapters, from the converter's headings or the learner's own segmentation), named `<document key>#<chapter index>` (lib/course-outline-index.js
   chapterKey), a material with no chapters being one chapter named by its document key, which the chat maps to the outline's chapters by title and page range once
   it is built. `course.custom.preview` lists them and says which it is (`skeleton.basis`, lib/custom-skeleton.js). This file checks the shape only: whether an id
   still names a chapter is the preview's to say (`unknownChapters`), since materials come and go and an outline is rebuilt.

   THE PARTS OF THE BOOK, in the book's order (BOOK_PARTS):
     explain      the written explanation of each knowledge point (the book's text itself)
     terms        术语卡, the cards of the terms, written from the explanations (the card pass, #710 S1)
     formulas     the formula page, read out of the glossary the build makes from the explanations (no call)
     index        the A–Z glossary and the cards by chapter, likewise (no call)
     confusables  易混概念 comparisons of the pairs of cards the cards call opposite or parallel (#710 S3)
     answerKit    the exam answer kit, made from the sample papers' questions (#710 S4); needs papers, not the explanations
     cheatSheet   the dense printable 速查表 (#710 S5) with whatever of the above exists; made by the program (no call)
   DEPENDENCIES (PART_NEEDS and SHEET_FROM, the one place): terms, formulas and index need explain; confusables needs terms; the sheet needs something to put on
   it (terms, formulas, answerKit or confusables: ui/book/cheat-sheet-model.js shows nothing else). A part whose need was not ticked is ADDED, not refused,
   by closedParts, which checkedCustom and the card both use: the learner who ticked 易混概念 has said what they want, the one thing it can be made from is
   not a choice, and a refusal would make the chat start the whole save again for a mechanical reason. The preview shows the cost of the closed set, so the
   addition is visible, not silent. Turning a part off goes the other way (partsWithout takes what rested on it along; lockedParts lists what cannot be
   turned off while something ticked rests on it). */
import { PART_CHAPTERS_MAX } from './course-book-parts.js';
import { COVERAGE_DEFAULT, COVERAGE_LEVELS } from './book-settings.js';
import { BASIC_KINDS } from './generation-settings.js';
import { DEFAULT_LEVEL, LEVELS as STRENGTH_LEVELS } from './coverage-strength.js';

export const CUSTOM_PURPOSES = Object.freeze(['preview', 'follow', 'review', 'openbook']);
export const SCOPE_KINDS = Object.freeze(['all', 'exam', 'chapters']);
export const PLAN_BASES = Object.freeze(['exam', 'weekly']);
export const BOOK_PARTS = Object.freeze(['explain', 'terms', 'formulas', 'index', 'confusables', 'answerKit', 'cheatSheet']);
export const PART_NEEDS = Object.freeze({ terms: Object.freeze(['explain']), formulas: Object.freeze(['explain']), index: Object.freeze(['explain']), confusables: Object.freeze(['terms']) });
/** What fills the cheat sheet: a sheet with none of these shows nothing. */
export const SHEET_FROM = Object.freeze(['terms', 'formulas', 'answerKit', 'confusables']);
export const CUSTOM_LIMITS = Object.freeze({ chapters: PART_CHAPTERS_MAX, chapterId: 300, note: 500, chaptersPerWeek: Object.freeze({ min: 1, max: 10 }),
  minutesPerDay: Object.freeze({ min: 15, max: 960 }) });

const fail = message => { throw new Error(message); };
const object = value => !!value && typeof value === 'object' && !Array.isArray(value);
const unique = values => [...new Set(values)];

/* ---------- the parts and what they rest on ---------- */

/** `parts` with what they need added, once each, in the book's order. */
export function closedParts(parts) {
  const have = new Set(parts);
  if (have.has('cheatSheet') && !SHEET_FROM.some(id => have.has(id))) have.add('terms');
  for (let grew = true; grew;) {
    grew = false;
    for (const id of [...have]) for (const need of PART_NEEDS[id] || []) if (!have.has(need)) { have.add(need); grew = true; }
  }
  return BOOK_PARTS.filter(id => have.has(id));
}

/** `parts` without `id` and without what rested on it (a cheat sheet with nothing left to show goes too). */
export function partsWithout(parts, id) {
  let kept = parts.filter(part => part !== id);
  for (let again = true; again;) {
    const next = kept.filter(part => (PART_NEEDS[part] || []).every(need => kept.includes(need)) && (part !== 'cheatSheet' || SHEET_FROM.some(from => kept.includes(from))));
    again = next.length !== kept.length;
    kept = next;
  }
  return BOOK_PARTS.filter(part => kept.includes(part));
}

/** The ticked parts another ticked part is made from: they cannot be turned off while it stays. */
export const lockedParts = parts => new Set(parts.flatMap(id => PART_NEEDS[id] || []).filter(need => parts.includes(need)));

/* ---------- the table of defaults ---------- */

/** THE ONE TABLE of what each purpose starts from (the chat proposes it, the learner changes it). The parts are already closed. A purpose that asks for chapters
    starts with none: the learner names them. The reasons: 预习 is a light first look (brief, two parts, a few question kinds, a chapter a week); 跟课 follows the
    lectures chapter by chapter with every kind of question and variants; 期末复习 covers the whole course and plans back from the exam date; 开卷 is the
    cheat-sheet case, so the book is brief but has every lookup part (the explanations come with them) and the questions are the ones an open-book paper asks. */
const DEFAULTS = Object.freeze({
  preview: { scope: { kind: 'chapters', chapters: [] }, book: { make: true, coverage: 'brief', parts: ['explain', 'terms'] },
    questions: { make: true, kinds: ['quiz', 'cloze'], strength: 'lean', variants: false }, plan: { make: true, by: 'weekly', chaptersPerWeek: 1 } },
  follow: { scope: { kind: 'chapters', chapters: [] }, book: { make: true, coverage: 'standard', parts: ['explain', 'terms', 'formulas'] },
    questions: { make: true, kinds: [...BASIC_KINDS], strength: 'standard', variants: true }, plan: { make: true, by: 'weekly', chaptersPerWeek: 1 } },
  review: { scope: { kind: 'all' }, book: { make: true, coverage: 'standard', parts: ['explain', 'terms', 'formulas', 'confusables', 'answerKit'] },
    questions: { make: true, kinds: [...BASIC_KINDS], strength: 'standard', variants: true }, plan: { make: true, by: 'exam' } },
  openbook: { scope: { kind: 'all' }, book: { make: true, coverage: 'brief', parts: ['explain', 'terms', 'formulas', 'index', 'confusables', 'answerKit', 'cheatSheet'] },
    questions: { make: true, kinds: ['quiz', 'open'], strength: 'lean', variants: false }, plan: { make: true, by: 'exam' } },
});

/** The default 定制方案 of a purpose, a fresh copy without chapters or a stamp. */
export function customDefaults(purpose) {
  if (!Object.hasOwn(DEFAULTS, purpose)) fail('定制方案的用途需为 preview、follow、review 或 openbook');
  return { version: 1, purpose, ...structuredClone(DEFAULTS[purpose]), sampleFirst: true };
}

/** A partial plan completed from the defaults of its purpose (no purpose: 'review'; no version: 1), a section given merged over its default field by field. For the
    preview while the chat is still asking its questions; it is not a record, so `checkedCustom` still has the last word on what is saved. */
export function filledCustom(partial) {
  if (!object(partial)) fail('定制方案格式不对');
  const base = customDefaults(partial.purpose ?? 'review'), filled = { ...base, version: partial.version ?? 1 };
  for (const key of ['scope', 'book', 'questions', 'plan']) if (partial[key] !== undefined) filled[key] = object(partial[key]) ? { ...base[key], ...partial[key] } : partial[key];
  if (partial.sampleFirst !== undefined) filled.sampleFirst = partial.sampleFirst;
  return filled;
}

/* ---------- the record ---------- */

const flag = (value, message) => (typeof value === 'boolean' ? value : fail(message));

function checkedScope(scope) {
  if (!object(scope)) fail('范围格式不对');
  if (!SCOPE_KINDS.includes(scope.kind)) fail('范围需为 all（全部）、exam（考试范围）或 chapters（指定章节）');
  const out = { kind: scope.kind };
  if (scope.kind === 'chapters') {
    const ids = scope.chapters;
    if (!Array.isArray(ids) || !ids.length || ids.length > CUSTOM_LIMITS.chapters || ids.some(id => typeof id !== 'string' || !id || id.length > CUSTOM_LIMITS.chapterId))
      fail(`指定章节需选 1 到 ${CUSTOM_LIMITS.chapters} 章，每个章节编号是不超过 ${CUSTOM_LIMITS.chapterId} 字的文字`);
    out.chapters = unique(ids);
  }
  if (scope.note !== undefined && scope.note !== null) {
    if (typeof scope.note !== 'string' || scope.note.trim().length > CUSTOM_LIMITS.note) fail(`范围备注不超过 ${CUSTOM_LIMITS.note} 字`);
    if (scope.note.trim()) out.note = scope.note.trim();
  }
  return out;
}

function checkedBook(book) {
  if (!object(book)) fail('复习全书的设置格式不对');
  const make = flag(book.make, '复习全书的 make 需为 true 或 false');
  const coverage = book.coverage ?? COVERAGE_DEFAULT;
  if (!COVERAGE_LEVELS.includes(coverage)) fail('讲解详尽程度需为 brief、standard 或 full');
  const asked = book.parts ?? [];
  if (!Array.isArray(asked)) fail('复习全书的部分需为列表');
  if (asked.some(id => !BOOK_PARTS.includes(id))) fail(`复习全书的部分只能是 ${BOOK_PARTS.join('、')}`);
  const parts = closedParts(asked);
  if (make && !parts.length) fail('做复习全书至少要选一个部分');
  return { make, coverage, parts };
}

function checkedQuestions(questions) {
  if (!object(questions)) fail('出题的设置格式不对');
  const make = flag(questions.make, '出题的 make 需为 true 或 false');
  const asked = questions.kinds ?? [];
  if (!Array.isArray(asked)) fail('题型需为列表');
  if (asked.some(kind => !BASIC_KINDS.includes(kind))) fail(`题型只能是 ${BASIC_KINDS.join('、')}`);
  const kinds = BASIC_KINDS.filter(kind => asked.includes(kind));
  if (make && !kinds.length) fail('出题至少要选一种题型');
  const strength = questions.strength ?? DEFAULT_LEVEL;
  if (!STRENGTH_LEVELS.includes(strength)) fail('覆盖强度需为 lean、standard 或 full');
  return { make, kinds, strength, variants: questions.variants === undefined ? false : flag(questions.variants, 'variants 需为 true 或 false') };
}

function checkedSchedule(plan) {
  if (!object(plan)) fail('学习计划的设置格式不对');
  const make = flag(plan.make, '学习计划的 make 需为 true 或 false');
  const by = plan.by ?? 'exam';
  if (!PLAN_BASES.includes(by)) fail('排计划的依据需为 exam（按考试日期）或 weekly（按每周章数）');
  const out = { make, by };
  const { chaptersPerWeek: weeks, minutesPerDay: minutes } = CUSTOM_LIMITS;
  if (by === 'weekly' && plan.chaptersPerWeek !== undefined && plan.chaptersPerWeek !== null) {
    if (!Number.isInteger(plan.chaptersPerWeek) || plan.chaptersPerWeek < weeks.min || plan.chaptersPerWeek > weeks.max) fail(`每周章数需为 ${weeks.min}–${weeks.max} 的整数`);
    out.chaptersPerWeek = plan.chaptersPerWeek;
  }
  if (plan.minutesPerDay !== undefined && plan.minutesPerDay !== null) {
    if (!Number.isInteger(plan.minutesPerDay) || plan.minutesPerDay < minutes.min || plan.minutesPerDay > minutes.max) fail(`每日学习分钟数需为 ${minutes.min}–${minutes.max}`);
    out.minutesPerDay = plan.minutesPerDay;
  }
  return out;
}

/** A stored 定制方案: only what the learner agreed to, tidied and with the parts closed; `undefined` and `null` pass through (untouched, removed). */
export function checkedCustom(custom) {
  if (custom === undefined || custom === null) return custom;
  if (!object(custom)) fail('定制方案格式不对');
  if (custom.version !== 1) fail('定制方案 version 需为 1');
  if (!CUSTOM_PURPOSES.includes(custom.purpose)) fail('定制方案的用途需为 preview、follow、review 或 openbook');
  return { version: 1, purpose: custom.purpose, scope: checkedScope(custom.scope), book: checkedBook(custom.book), questions: checkedQuestions(custom.questions),
    plan: checkedSchedule(custom.plan), sampleFirst: flag(custom.sampleFirst, 'sampleFirst 需为 true 或 false') };
}
