/* STUB (WP-P): the real ui/card-fix.js is WP-Q's (#176) and replaces this file at integration; the coordinator keeps WP-Q's version.
   It only exists so Review.jsx can be written against the agreed contract: `fixSuggestionFor(tags)` is the prefilled text of the 修题 box
   for the rewrite-type feedback tags, `splitFeedbackTags` separates rewrite tags from difficulty tags. */
export const REWRITE_TAG_IDS = Object.freeze(['stem-vague', 'bad-options', 'wrong-answer', 'unclear-explanation', 'source-recall']);
export const DIFFICULTY_TAG_IDS = Object.freeze(['too-easy', 'too-hard']);

const WORDS = {
  'stem-vague': '题干太空，请补足必要条件，让题目只有一个合理答案。',
  'bad-options': '选项质量不好，请让干扰项更像真实的误解。',
  'wrong-answer': '答案可能有误，请对照资料核实并改正。',
  'unclear-explanation': '解析没讲清为什么对或错，请补充说明。',
  'source-recall': '这道题在问「资料怎么说」，请改成考概念或情景。',
};

/** { rewrite, difficulty } of a list of tag ids. */
export const splitFeedbackTags = (tags = []) => ({
  rewrite: tags.filter((tag) => REWRITE_TAG_IDS.includes(tag)),
  difficulty: tags.filter((tag) => DIFFICULTY_TAG_IDS.includes(tag)),
});

/** The text a 修题 box starts with for these tags, one line per tag. */
export const fixSuggestionFor = (tags = []) => splitFeedbackTags(tags).rewrite.map((tag) => WORDS[tag]).join('\n');
