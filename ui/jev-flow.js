import { ui, uiFormat } from './i18n.js';
import { jevMessage } from '../lib/jev-messages.js';
import { DEFAULT_JEV_PROVIDER, JEV_PROVIDER_IDS, jevProvider } from '../lib/jev-providers.js';

/* EXPERIMENTAL Jev layer: the copy and the small pure helpers the settings page and the organizer share. */

/** The model calls a learner can choose to have Jev answer instead (lib/jev-sites.js), for the walk-through and the switches. */
export const JEV_REPLACE_META = [
  { id: 'cardReview',
    label: () => ui('出题后的独立复审'),
    hint: () => ui('生成题目后，原本由模型逐题检查质量：会不会泄露答案、能不能独立看懂、答案有没有原文支持、选项和解析好不好。'),
    replaces: () => ui('替换：出题后的独立复审（一次模型调用）'),
    instead: () => ui('Jev 对每道题回答六个是/否问题。把握够高的题由 Jev 直接通过或淘汰，其余仍交给原来的模型复审；题组里会标出哪些题由 Jev 判定。') },
  { id: 'courseOrganize',
    label: () => ui('课程归属建议（请 AI 建议）'),
    hint: () => ui('在「资料 › 整理课程归属」里，原本由模型建议每份资料属于哪门课。'),
    replaces: () => ui('替换：「请 AI 建议」里的模型调用'),
    instead: () => ui('Jev 在你已有的课程里挑一门；把握够高的由 Jev 给出建议，其余（包括需要新课程名的）交给模型。建议仍要你点「确认应用建议」才会生效。') },
];

/** The providers the selector offers: id, plain label, and the name of the cloud the content goes to (for the confirmation). */
export const JEV_PROVIDER_META = {
  typesafe: { label: () => ui('TypeSafe（官方）'), confirmLabel: () => ui('我已阅读以上说明，同意把这些内容发送到 Jev（TypeSafe 云端）') },
  'opencode-zen-free': { label: () => ui('OpenCode Zen · Jev 免费'), confirmLabel: () => ui('我已阅读以上说明，同意把这些内容发送到 Jev（OpenCode Zen 云端）') },
  'opencode-zen': { label: () => ui('OpenCode Zen · Jev'), confirmLabel: () => ui('我已阅读以上说明，同意把这些内容发送到 Jev（OpenCode Zen 云端）') },
  custom: { label: () => ui('自定义端点'), confirmLabel: () => ui('我已阅读以上说明，同意把这些内容发送到我填写的自定义端点') },
};
export const providerChoices = () => JEV_PROVIDER_IDS.map(id => ({ id, label: JEV_PROVIDER_META[id].label() }));
/** The provider id of a settings view; a view from before the presets has none, which means TypeSafe. */
export const providerOf = settings => jevProvider(settings?.provider).id ?? DEFAULT_JEV_PROVIDER;

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

/** What the learner is told before anything is sent, for one provider (none means TypeSafe). Each sentence is one plain statement,
    and says only what the provider's own documentation says (or, where it is silent, that it is silent). */
export function privacyPoints(providerId, { host = '' } = {}) {
  const provider = jevProvider(providerId);
  const what = ui('只发送你打开的功能所需的内容：资料的标题和开头的一小段节选、课程名、题目文字。不会上传整个学习库，只在你使用对应功能时才发送。');
  const experiment = ui('这是实验功能，效果没有经过验证。Jev 主要针对英文优化，对中文的支持较弱；它给出的只是参考信号，不会自动改动你的资料或题目。出错或不可用时，一切照原来的做法。');
  if (provider.family === 'typesafe') return [
    what,
    ui('发送到 TypeSafe AI 的云端服务（api.typesafe.ai），不经过你的学习模型。'),
    ui('服务商在隐私政策里承诺不会用用户数据训练模型。普通账号的数据会保留多久，文档里没有说明（官方只说明企业客户可以申请零数据保留），请当作发送的内容会被保留一段时间。'),
    ui('免费额度、价格和速率限制以服务商为准；这里不显示价格，只统计用掉的 token。'),
    experiment,
  ];
  if (provider.family === 'custom') return [
    what,
    host ? uiFormat('发送到你填写的自定义端点（{0}）；StudyHub 不知道这个端点由谁运营，也不经过你的学习模型。', [host]) : ui('发送到你填写的自定义端点；StudyHub 不知道这个端点由谁运营，也不经过你的学习模型。'),
    ui('这个端点会保留多久、是否用提示词训练模型，我们不知道，请当作未知，不要用保密资料。'),
    ui('我们假设它提供同样的 Jev 接口（POST，请求体是 model、state、questions）。据报道 OpenRouter、AIML、Netlify AI Gateway 也提供 Jev，但它们的接口格式未验证。'),
    experiment,
  ];
  return [
    what,
    ui('发送到 OpenCode 的 Zen 服务（opencode.ai），再由它转给提供 Jev 的 TypeSafe AI；不经过你的学习模型。'),
    ui('OpenCode 的文档说明，它的服务商总体上遵循零数据保留（zero retention），数据也不用于训练模型。这是 OpenCode 的说法，我们没有独立核实。'),
    ...(provider.free ? [ui('但对 Jev 1.13 Free，OpenCode 的文档只写了「限时提供」，没有说明提示词是否会被保留、是否会被用于训练，请把这一点当作未知。免费模型只在限定的一段时间内提供。请不要用保密资料。')] : []),
    ui('价格、免费期限和速率限制以 OpenCode 的说明为准；这里不显示价格，只统计用掉的 token。'),
    experiment,
  ];
}

/**
 * Where the key comes from, for the key card: { state, text, note }. `state` is 'file' (a key pasted here), 'env-found' (a key from the
 * environment variable `key.envName`), 'env-missing' (no key and an OpenCode preset: that variable was not found) or 'none'. Only the
 * variable's NAME is ever shown, never any part of its value.
 */
export function keySourceText(settings) {
  const key = settings?.key || {}, name = key.envName || jevProvider(settings?.provider).defaultKeyEnv;
  if (key.set && key.source === 'file') return { state: 'file', text: uiFormat('已保存 {0}', [key.hint]),
    note: key.envFound ? uiFormat('粘贴的密钥优先于环境变量 {0}。', [name]) : '' };
  if (key.set && key.source === 'env') return { state: 'env-found', text: uiFormat('密钥来自环境变量 {0}（已找到）', [name]),
    note: ui('这个密钥只在发送请求时读取，不会被保存到任何文件，也不会显示在界面上。') };
  if (jevProvider(settings?.provider).family !== 'typesafe') return { state: 'env-missing', text: uiFormat('环境变量 {0}（未找到）', [name]),
    note: ui('DSH 可能没有把它传给插件进程：可以在下面粘贴密钥，或在设置好这个变量的环境里启动 DSH。') };
  return { state: 'none', text: ui('未配置'), note: '' };
}

/** The next step the learner has to take before the switches do anything: 'key', 'confirm' or 'ready'. */
export function setupStep(settings) {
  if (providerOf(settings) === 'custom' && !(settings?.custom?.endpoint && settings?.custom?.model)) return 'endpoint';
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

/** The plain sentence for a failure code the server remembered, in the interface language (the server's own sentences, translated);
    `provider` words it for the service that failed. */
export const failureCode = (reason, provider) => jevMessage(reason, 'zh', provider);

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
