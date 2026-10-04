import { ui } from './i18n.js';
import { IMPROVE_SUGGESTIONS } from './agent-prompts/card.js';

/* 👎 and 修题 are one path (#176): the tags that ask for a rewrite open the 修题 box with the problem already written in it,
   and the learner sends it to the background assistant like any other 修题 request. Difficulty tags only record, and prepare
   tailored variants. The sets mirror lib/coach.js (REWRITE_TAGS); tests/thumb-fix.test.mjs pins that they agree. */
export const REWRITE_TAG_IDS = Object.freeze(['general-quality', 'stem-vague', 'bad-options', 'wrong-answer', 'unclear-explanation', 'source-recall']);
export const DIFFICULTY_TAG_IDS = Object.freeze(['too-easy', 'too-hard']);

const BAD_OPTIONS = '选项质量不好，请让干扰项同类、长度相近、各对应一个真实误解，并逐项解释为什么错。';
const UNCLEAR_EXPLANATION = '解析没讲清楚，请点名涉及的概念，说明为什么正确选项对、其他选项错。';
// Four of the 修题 suggestions are exactly these problems; reuse their wording.
const SUGGESTION = Object.freeze({
  'source-recall': IMPROVE_SUGGESTIONS[0][1],
  'wrong-answer': IMPROVE_SUGGESTIONS[1][1],
  'stem-vague': IMPROVE_SUGGESTIONS[2][1],
  'general-quality': IMPROVE_SUGGESTIONS[4][1],
  'bad-options': BAD_OPTIONS,
  'unclear-explanation': UNCLEAR_EXPLANATION,
});

/** The tags a 修题 request takes over, and the tags that only prepare variants, in the order given. */
export function splitFeedbackTags(tags = []) {
  const list = [...new Set(tags)];
  return { fix: list.filter(tag => REWRITE_TAG_IDS.includes(tag)), difficulty: list.filter(tag => DIFFICULTY_TAG_IDS.includes(tag)) };
}

/** The 修题 text for these 👎 tags, in the interface language; '' when none of them asks for a rewrite. */
export function fixSuggestionFor(tags = []) {
  return splitFeedbackTags(tags).fix.map(tag => ui(SUGGESTION[tag])).join('\n');
}

/**
 * What a saved 👎 batch leads to: the rewrite tags the learner picked, to hand to 修题, and the short note for what only records.
 * `implicit` is the bare 👎 (no tag picked, recorded as general-quality): it only records, so 修题 stays closed.
 */
export function feedbackOutcome(args, result, { implicit = false } = {}) {
  if (implicit) return { fix: [], note: ui('已记下这个反馈') };
  const { fix, difficulty } = splitFeedbackTags(result?.tags ?? args.tags);
  if (!difficulty.length) return { fix, note: '' };
  return { fix, note: ui(result?.scheduled?.includes('prep') ? '已记下，下一轮据此准备定制题' : '已记下这个反馈') };
}
