/* The question kinds and every fact the program asks about one: one entry per kind, one decision in one place. Pure data and small
   readers, no Node modules: the browser bundle imports it too. The entry order is the order kinds are offered and listed (generation,
   the kind picker, the deck-format examples, the 定制方案 kinds).
   options  the kind is answered by choosing among options: { min, max } of them (validateDeck); null for every other kind.
   answers  for an option kind: 'one' (exactly one option is correct) or 'some' (at least one, fewer than all).
   fixedOptions  the options are always these, in this order, never shuffled: { id, label (zh, ui() translates it), en (the stored text of English
                 content), mark (shown where other options show their letter) }.
   graded   the program grades the answer (choices, cloze); the other kinds are self-graded after the reveal.
   exam     a 模拟考试 paper and a 复习全书 mock take it (graded option kinds only: lib/contexts/study/operations.js review.start).
   generate the learner can ask a generation run for it (设置 › 出题偏好, 创建题组, guided prep, 为你定制).
   ingest   整理成题 (pasted notes, a recording's transcript) can turn text into it.
   cost     the relative time one practice question takes in the daily plan.
   label    the kind's name in lists and pickers; short: its name in badges and counts (zh source strings, ui() translates them). */
const KINDS = Object.freeze([
  { id: 'quiz', label: '单选测验', short: '单选', options: { min: 3, max: 6 }, answers: 'one', graded: true, exam: true, generate: true, ingest: true, cost: 3 },
  { id: 'multi', label: '多选测验', short: '多选', options: { min: 3, max: 6 }, answers: 'some', graded: true, exam: true, generate: true, ingest: true, cost: 3 },
  // 判断题: one statement judged 对 / 错 (lib/true-false.js has what only it needs).
  { id: 'truefalse', label: '判断题', short: '判断', options: { min: 2, max: 2 }, answers: 'one', graded: true, exam: true, generate: true, ingest: false, cost: 2,
    fixedOptions: [{ id: 'true', label: '对', en: 'True', mark: '✓' }, { id: 'false', label: '错', en: 'False', mark: '✕' }] },
  { id: 'flashcard', label: '闪卡', short: '闪卡', options: null, answers: null, graded: false, exam: false, generate: true, ingest: true, cost: 2 },
  { id: 'open', label: '开放问答', short: '开放', options: null, answers: null, graded: false, exam: false, generate: true, ingest: true, cost: 6 },
  { id: 'cloze', label: '填空卡', short: '填空', options: null, answers: null, graded: true, exam: false, generate: true, ingest: false, cost: 2 },
  // 动手任务 (#778): universal hands-on task across disciplines, statically checked in main chat or self-reported; no in-app code editor or test runner.
  { id: 'task', label: '动手任务', short: '动手', options: null, answers: null, graded: false, exam: false, generate: true, ingest: false, cost: 8 },
].map((kind) => Object.freeze({ ...kind, options: kind.options && Object.freeze(kind.options),
  fixedOptions: kind.fixedOptions ? Object.freeze(kind.fixedOptions.map((option) => Object.freeze(option))) : null })));
const BY_ID = new Map(KINDS.map((kind) => [kind.id, kind]));
const ids = (test) => Object.freeze(KINDS.filter(test).map((kind) => kind.id));

/** Every kind, in order. */
export const CARD_KIND_LIST = KINDS;
/** Every kind id, in order. */
export const CARD_KIND_IDS = ids(() => true);
/** The kinds a generation run can be asked for, in order. */
export const GENERATE_KIND_IDS = ids((kind) => kind.generate);
/** The kinds 整理成题 can produce. */
export const INGEST_KIND_IDS = ids((kind) => kind.ingest);
/** The kinds an exam paper takes. */
export const EXAM_KIND_IDS = ids((kind) => kind.exam);
/** Every kind id, the program-graded ones first (the per-kind rows of 学习统计). */
export const GRADED_FIRST_KIND_IDS = Object.freeze([...ids((kind) => kind.graded), ...ids((kind) => !kind.graded)]);

/** The entry of a kind id, or null for anything else. */
export const kindOf = (id) => BY_ID.get(id) ?? null;
export const isCardKind = (id) => BY_ID.has(id);
/** Is the kind answered by choosing options? */
export const hasOptions = (id) => !!kindOf(id)?.options;
/** The options every card of the kind has, in their order (判断题: 对, 错); null when the card writes its own. */
export const fixedOptionsOf = (id) => kindOf(id)?.fixedOptions ?? null;
/** Does the kind have exactly one correct option? */
export const oneAnswer = (id) => kindOf(id)?.answers === 'one';
/** Does the program grade the kind's answer (otherwise the learner grades it after the reveal)? */
export const isGraded = (id) => !!kindOf(id)?.graded;
/** Does an exam paper take the kind? */
export const isExamKind = (id) => !!kindOf(id)?.exam;
/** The relative time of one practice question (an unknown kind costs as little as a flashcard). */
export const practiceCost = (id) => kindOf(id)?.cost ?? 2;

const CJK_RE = /[㐀-鿿豈-﫿]/;

/** Strip serialized `要点：…` / `Key points: …` lines or inline clauses so public task acceptance criteria never leak answer keys (#778). */
export function stripRubricKeyPoints(rubric) {
  const raw = String(rubric ?? '');
  if (!raw.trim()) return '';
  return raw
    .split(/\r?\n/)
    .filter((line) => !/^\s*(?:[-*•]\s*)?(?:要点\s*[：:]|key\s*points?\s*:)/i.test(line))
    .map((line) => line
      .replace(/[（(]\s*(?:要点\s*[：:]|key\s*points?\s*:)[^）)]*[）)]/gi, '')
      .replace(/(?:[；;。.]\s*|\s+[—–-]\s*)(?:要点\s*[：:]|key\s*points?\s*:).*$/i, '')
      .trimEnd())
    .join('\n')
    .trim();
}

/** Public acceptance criteria summary for a `task` card: renders structured `rubricCriteria` without `keyPoints` when present, otherwise strips `keyPoints` from `card.rubric` (#778). */
export function publicTaskRubric(card, language) {
  if (Array.isArray(card?.rubricCriteria) && card.rubricCriteria.length) {
    const sample = card.rubricCriteria.map((c) => `${c?.label || ''} ${c?.descriptor || ''}`).join(' ');
    const lang = language || (sample && !CJK_RE.test(sample) ? 'en' : 'zh');
    const english = /^(en|english)/i.test(String(lang || '').trim());
    return card.rubricCriteria.map((criterion, index) => {
      const hasMarks = Number.isFinite(criterion?.marks) && criterion.marks > 0;
      const marks = hasMarks
        ? (english ? ` (${criterion.marks} ${criterion.marks === 1 ? 'mark' : 'marks'}): ` : `（${criterion.marks} 分）：`)
        : (english ? ': ' : '：');
      return `${index + 1}. ${criterion.label}${marks}${criterion.descriptor || ''}`.trimEnd();
    }).join('\n');
  }
  return stripRubricKeyPoints(card?.rubric);
}
