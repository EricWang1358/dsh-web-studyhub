import { ui, uiFormat } from './i18n.js';
import { JEV_MESSAGES } from '../lib/jev-messages.js';

/* EXPERIMENTAL Jev layer: the copy and the small pure helpers the settings page and the organizer share. */

/** The experiments, in the order the settings list them: id, label, one sentence on where it shows up. */
export const JEV_FEATURE_META = [
  { id: 'courseSuggest', label: () => ui('课程归属建议'),
    hint: () => ui('在「资料 › 整理课程归属」里多一个「Jev 建议」按钮，给出每门课的概率；把握够高才填入，仍要你点「应用」。') },
  { id: 'preReview', label: () => ui('出题预审'),
    hint: () => ui('出题时，在独立复审之前先让 Jev 粗筛每道题（题干是否泄露答案、脱离资料能否看懂等）；明显有问题的先改写一次。它只是信号，独立复审仍是最后一关。') },
  { id: 'outlineNoise', label: () => ui('目录噪声判断'),
    hint: () => ui('判断目录条目是章节标题、小节标签、页眉页脚还是其他。接口已就绪，阅读器接入后才会生效。') },
  { id: 'levelCheck', label: () => ui('题目认知层次对照'),
    hint: () => ui('用 Jev 判断题目是记忆、概念辨析还是应用分析，与代码的判断对照；只在开发者面板里显示一致与不一致的数量。') },
];

/** What the learner is told before anything is sent. Each sentence is one plain statement. */
export const privacyPoints = () => [
  ui('只发送你打开的功能所需的内容：资料的标题和开头的一小段节选、课程名、题目文字。不会上传整个学习库，只在你使用对应功能时才发送。'),
  ui('发送到 TypeSafe AI 的云端服务（api.typesafe.ai），不经过你的学习模型。'),
  ui('服务商在隐私政策里承诺不会用用户数据训练模型。普通账号的数据会保留多久，文档里没有说明（官方只说明企业客户可以申请零数据保留），请当作发送的内容会被保留一段时间。'),
  ui('免费额度、价格和速率限制以服务商为准；这里不显示价格，只统计用掉的 token。'),
  ui('这是实验功能，效果没有经过验证。Jev 主要针对英文优化，对中文的支持较弱；它给出的只是参考信号，不会自动改动你的资料或题目。出错或不可用时，一切照原来的做法。'),
];

/** The next step the learner has to take before the switches do anything: 'key', 'confirm' or 'ready'. */
export function setupStep(settings) {
  if (!settings?.key?.set) return 'key';
  if (!settings.confirmed) return 'confirm';
  return 'ready';
}

/** A Jev usage cell as the DSH-style rows (`TokenUsage`) read it. Jev reports input and output tokens only. */
export const dshUsage = cell => ({ uncachedInputTokens: cell?.inputTokens || 0, outputTokens: cell?.outputTokens || 0, cacheReadTokens: 0, cacheWriteTokens: 0, calls: cell?.calls || 0 });

/** The thresholds the picker offers; the saved one is added when it is not among them. */
export const THRESHOLD_CHOICES = [0.6, 0.7, 0.8, 0.9, 0.95];
export const thresholdChoices = current => (THRESHOLD_CHOICES.includes(current) ? THRESHOLD_CHOICES : [...THRESHOLD_CHOICES, current].sort((a, b) => a - b));
export const percentText = value => `${Math.round(value * 100)}%`;

/** The plain sentence for a failure code the server remembered, in the interface language (the server's own sentences, translated). */
export const failureCode = reason => JEV_MESSAGES[reason] ?? JEV_MESSAGES.unexpected;

/**
 * The rows of a Jev course suggestion for the organizer: the top courses with their probabilities, "none of these", and the line.
 * `jev` is the `jev` block of a proposal of source.organize.jev.
 */
export function probabilityRows(jev) {
  const rows = (jev?.top || []).map(item => ({ id: item.course, label: item.course, value: item.p, picked: item.course === jev.choice }));
  if (jev?.none > 0) rows.push({ id: '__none__', label: ui('都不合适'), value: jev.none, picked: false, none: true });
  return rows;
}

/** The default "采用建议" for a Jev row: only a suggestion that was filled in and changes something starts checked. */
export const startsIncluded = proposal => !!proposal?.jev?.changed;

/** The one quiet line above the suggestions: why Jev could not help at all, or how many sources it could not judge. '' when all went well. */
export const noteText = result => result?.unavailable?.message
  || (result?.partial ? uiFormat('有 {0} 份资料 Jev 没能判断：{1}', [result.partial.failed, result.partial.message]) : '');

/** The defects the pre-check looks for, named as the defect (the number shown is the chance that it is present). */
export const TRIAGE_LABELS = {
  stemLeaksAnswer: () => ui('题干泄露答案'),
  needsSource: () => ui('脱离原文看不懂'),
  answerInEvidence: () => ui('答案没有被原文支持'),
  oneDefensible: () => ui('不止一个选项成立（或没有）'),
};
/** The rows of one card's signal: [{ id, label, value: chance the defect is present, failed }], in the order of TRIAGE_LABELS. */
export const triageRows = signal => Object.keys(TRIAGE_LABELS).filter(id => signal?.checks?.[id])
  .map(id => ({ id, label: TRIAGE_LABELS[id](), value: signal.checks[id].failure, failed: !!signal.checks[id].failed }));

export const lineText = jev => uiFormat('采用线 {0}', [percentText(jev?.threshold ?? 0.8)]);
