/* 出题守则 (#889): a course's own short rules, which every generation for that course carries to its plan, answer, author and review stages (in the requirements
   brief, lib/generation-modules.js moduleOverridesBrief) and which the zero-call preview lists. Stored as `course.generationRules` (lib/courses.js saveCourse), an
   optional field: absent until a rule is saved. The limits are the 修题 phrases' (lib/fix-phrases.js) on purpose: a rule is one line the learner could have typed
   in the 修题 box, and 「设为本课守则」 turns exactly such a line into a rule. Pure and browser-safe. */
import { FIX_PHRASE_LIMITS } from './fix-phrases.js';
import { shortTextList } from './short-text-list.js';

export const GENERATION_RULE_LIMITS = FIX_PHRASE_LIMITS;

/** Recommended course generation rule for turning verbalized code behavior into readable 3–16 line code-reading questions (#1294). */
export const RECOMMENDED_CODE_READING_RULE = '遇到 API 行为、拷贝/内存变化、SQL 查询、事务锁竞态或前端 Hook 陷阱且口述超过两三句时，改写成 3–16 行最小可读代码块；代码注释不泄题，构造示例在解析中注明。';

const rules = shortTextList(GENERATION_RULE_LIMITS, { one: 'generation rule', many: 'generation rules' });
export const normalizeGenerationRules = rules.normalize;
export const validateGenerationRules = rules.validate;
export const canAddGenerationRule = rules.canAdd;
export const addGenerationRule = rules.add;
export const removeGenerationRule = rules.remove;

/** A case paper is written by its own prompts (lib/case-study.js), which do not take the rules: its run neither carries nor records them. */
export const takesGenerationRules = kind => kind !== 'case';

/** Two lists say the same rules, in the same order (the order is part of the prompt and of the requirements digest). */
export const sameGenerationRules = (left, right) => JSON.stringify(normalizeGenerationRules(left)) === JSON.stringify(normalizeGenerationRules(right));

/** The course whose rules a draft is held to: the course it is filed under now, else the one its run was asked for. */
export const rulesCourseOfDraft = draft => draft?.course ?? draft?.editorial?.generation?.course;

/**
 * Whether the course's rules are no longer those a reviewed draft was written with (`currentRules`: the course's rules now). Its review then no longer vouches for
 * the requirements: reviewed publication reviews it again (lib/review-integrity.js draftRequirementsMatchReview reason 'course-rules-changed') and the quick one,
 * which asks no model, publishes its questions as not reviewed (lib/contexts/authoring/operations.js draft.publish.quick).
 */
export function draftRulesChanged(draft, currentRules) {
  const gen = draft?.editorial?.generation;
  if (!gen || !takesGenerationRules(gen.kind) || typeof draft.editorial.reviewedRequirementsDigest !== 'string') return false;
  return !sameGenerationRules(gen.moduleOverrides?.courseRules, currentRules);
}
