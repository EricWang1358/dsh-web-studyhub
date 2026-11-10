import { ui } from '../i18n.js';

/* A 👎 tag as a course's 出题守则 (#889): the tag says what was wrong with ONE question, the rule says what every question of the course should do instead.
   The tags are the tray's (ui/ThumbFeedback.jsx); a tag with no rule here (the bare 👎) offers none. */
const RULE_OF_TAG = Object.freeze({
  'stem-vague': '题干要自带情境和决定答案的条件，不出只有一句空问的题。',
  'bad-options': '干扰项要同类、长度相近，每个对应一个真实的误解。',
  'too-easy': '少出只考一处记忆的题，多出要应用、比较或推理的题。',
  'too-hard': '先打基础：少出多步推导的难题，多出考清一个概念的题。',
  'wrong-answer': '答案必须能在资料原文里逐字核对，拿不准的不出。',
  'unclear-explanation': '解析要点名涉及的概念，说明正确项为什么对、其他项为什么错。',
  'source-recall': '不出「资料怎么说」的背诵题，改问概念、机制或情景。',
});

/** The rules the chosen tags stand for, in the interface language, in the order the tags were chosen. */
export const ruleTextsForTags = (tags = []) => [...new Set(tags)].filter(tag => RULE_OF_TAG[tag]).map(tag => ui(RULE_OF_TAG[tag]));
