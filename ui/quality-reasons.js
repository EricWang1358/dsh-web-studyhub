/* Why a question did not pass, in one table for every place that says it: the draft page, the job card and a failed run's message.
   A reason is a short code; `issueCode` reads it from a review or structural line, `reasonLabel` says it in the UI language. Pure. */
import { ui } from './i18n.js';

export const DIMENSIONS = { selfContained: 'self-contained', answerLeak: 'answer-leak', optionQuality: 'options',
  learningValue: 'value', sourceSupport: 'source', explanationQuality: 'explanation' };

/** The reason an issue line stands for, or null when it is only the reviewer's prose. */
export function issueCode(issue) {
  const text = String(issue ?? '');
  if (text === 'over-count') return 'over-count';
  const dimension = /\b(selfContained|answerLeak|optionQuality|learningValue|sourceSupport|explanationQuality)\b(?: failed| in )/.exec(text);
  if (dimension) return DIMENSIONS[dimension[1]];
  if (/explanation only repeats the answer/.test(text)) return 'explanation';
  if (/depends on unavailable/.test(text)) return 'self-contained';
  if (/must use requested kind/.test(text)) return 'kind';
  if (/duplicate (?:learning objective|prompt|id)|repeats an already covered/.test(text)) return 'duplicate';
  if (/citation|quote|unknown source/i.test(text)) return 'source';
  /* The structural gate's `Card N:` lines, one precise code each; 'structure' is only what none of them says. */
  if (/formula outside math delimiters/.test(text)) return 'formula';
  if (/the stem asks what the source says/.test(text)) return 'source-voice';
  if (/hint reveals the answer/.test(text)) return 'answer-leak';
  if (/missing, unknown or duplicate targetId/.test(text)) return 'binding';
  if (/need 3.6 options|options have an invalid shape|invalid correct option count|duplicate option|each option requires/.test(text)) return 'options-shape';
  if (/\b(?:id|kind|topic|objective|prompt|answer|hint|explanation|misconception) (?:is required|must be text)/.test(text)) return 'missing-field';
  if (/^Card \d+:/.test(text)) return 'structure';
  return null;
}

export const reasonLabel = (code) => ({
  'answer-leak': ui('提示或题干泄露了答案'),
  options: ui('选项质量不合格（干扰项太弱或比较维度不一致）'),
  value: ui('学习价值不够（太琐碎或一题考了几件事）'),
  source: ui('资料不足以支撑答案，或引用对不上原文'),
  explanation: ui('解析没有讲清推理'),
  'self-contained': ui('离开资料读不懂题干'),
  kind: ui('题型和要求的不一致'),
  duplicate: ui('与已有的题重复'),
  formula: ui('公式没有放进公式格式（会显示成原始文本）'),
  'source-voice': ui('题干在问「资料怎么说」，没有考概念本身'),
  'missing-field': ui('缺少必要字段（如提示、易错点）'),
  'options-shape': ui('选项结构不完整'),
  binding: ui('题目没有对上已核实的考点'),
  structure: ui('题目格式不完整'),
  'over-count': ui('这一批已满额，多出的候选没有采用'),
  review: ui('独立审阅没有通过'),
})[code] || code;
