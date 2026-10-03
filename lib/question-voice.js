/* Questions in "the source's voice": 资料说…, 文中提到…, 根据课件…, "What does the material say…". They test memory of a document's wording, not the
   concept or a situation the learner has to handle, and a learner who studied the concept (not the document) cannot answer them. Pure and dependency-free,
   so the generation check (lib/assessment-quality.js) and the review page (ui/Review.jsx) use the same rule. */

const SOURCE = '(?:资料|材料|文中|原文|本文|课件|讲义|教材|课本|笔记|逐字稿|幻灯片|PPT)';
// 资料说 / 资料用什么 / 资料给出的 / 文中提到 / 讲义把…归为 — the source as the subject of a verb
const AS_SUBJECT = new RegExp(`${SOURCE}(?:里|中|上)?(?:是怎么|是如何|怎么|如何|都|一共|主要|又)?(?:说|写|讲|提到|提出|指出|给出|认为|强调|区分|定义|描述|列出|列举|归为|把|用什么|用哪|用了)`);
// 根据资料 / 依据课件 / 按照讲义 — answer "by the document"
const ACCORDING_TO = new RegExp(`(?:根据|按照|依据|参照|按|据)${SOURCE}`);
// 这份讲义 / 这段笔记 followed by a verb: the demonstrative form
const DEMONSTRATIVE = new RegExp(`(?:这份|这段|该份|本份|上述|这篇|这本)${SOURCE}(?:里|中)?(?:说|写|讲|提到|指出|给出|认为|强调|区分|定义|描述|列出|列举|归为|把|用)`);
const ENGLISH = /\b(?:the|this|these|our)\s+(?:material|text|source|lecture(?: notes?| transcript)?|slides?|notes|reading|document|handout)\s+(?:says?|states?|describes?|uses?|mentions?|defines?|lists?|claims?|calls?)\b|\baccording to (?:the|this|these|our) (?:material|text|source|lecture|slides?|notes|reading|document|handout)\b/i;

/** Whether a question stem asks what the source says rather than testing the concept or a situation. */
export function asksWhatTheSourceSays(prompt) {
  const text = typeof prompt === 'string' ? prompt : '';
  return !!text && (AS_SUBJECT.test(text) || ACCORDING_TO.test(text) || DEMONSTRATIVE.test(text) || ENGLISH.test(text));
}

/** The feedback the learner would have had to write, ready to send to 修题: a concept or a concrete situation instead of "what the source says". */
export const SOURCE_VOICE_FIX = '这道题在问「资料怎么说」，考的是背资料的措辞。请改成考概念本身，或一个具体情景（给出必要条件，让我判断、选择或说明为什么），不要出现「资料说/文中/根据资料」这类说法；答案仍要和资料一致，题型不变。';

/** The rewrite guidance for a stem in the source's voice ("资料说…"): the learner studies concepts and situations, not the document's wording. */
export const SOURCE_RECALL_GUIDE = "题干在问「资料怎么说」（资料说/文中提到/根据资料/资料用什么…），考的是背诵措辞。改成考概念本身（定义、与相近概念的区别、为什么），或一个具体情景（给出必要条件，让学习者判断、选择、排查或预测）；改后的题干和答案里不得出现「资料/文中/原文/课件/笔记」作为被问的对象；答案仍须被 evidence 支持，题型、考点不变，不泄露答案。";
