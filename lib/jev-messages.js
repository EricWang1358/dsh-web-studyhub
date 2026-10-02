import { jevProvider } from './jev-providers.js';

/* Plain-language messages of the experimental Jev layer, in both languages. One table per language with the same keys;
   `JEV_CATALOGUE` pairs each Chinese sentence with its English one, so lib/application-messages.js can localise an error that
   crossed the operation boundary in Chinese. No message ever contains the key, the learner's text or a server response body.

   The base tables are TypeSafe's (the default provider; their wording is unchanged). The OpenCode presets override the sentences
   that are about the service itself with ones that name "OpenCode Zen" (JEV_OPENCODE_MESSAGES); the rest (switches, size, courses)
   are the same for every provider. */

export const JEV_MESSAGES = Object.freeze({
  'no-key': '还没有设置 Jev 密钥：请在「设置 › 实验性 · Jev 判断服务」里填写。不要把密钥贴到对话里',
  'not-confirmed': 'Jev 判断服务还没有确认隐私说明：请先在「设置 › 实验性 · Jev 判断服务」里确认',
  off: 'Jev 判断服务已关闭（实验性功能默认关闭），没有发送任何内容',
  'feature-off': '这项 Jev 实验功能没有打开，没有发送任何内容',
  'invalid-key': 'Jev 密钥无效或已被撤销：请到「设置 › 实验性 · Jev 判断服务」重新填写一个有效的密钥。',
  'invalid-request': 'Jev 没有接受这次请求（内容不符合它的要求），已改用原来的做法。',
  'rate-limited': 'Jev 请求太频繁，已自动等待过但仍被限流，已改用原来的做法。',
  overloaded: 'Jev 服务暂时繁忙，已自动重试过但没有成功，已改用原来的做法。',
  unavailable: 'Jev 服务暂时不可用，已改用原来的做法。',
  network: '连不上 Jev：请检查网络。已改用原来的做法。',
  timeout: 'Jev 没有在时限内回应，已改用原来的做法。',
  'bad-response': 'Jev 返回的内容无法识别，已改用原来的做法。',
  'too-large': '要发送给 Jev 的内容太长，没有发送，已改用原来的做法。',
  unexpected: 'Jev 返回了意料之外的结果，已改用原来的做法。',
  'insufficient-balance': 'Jev 提示额度或余额不足（402），已改用原来的做法。',
  'no-courses': '还没有课程可选：先把几份资料归到课程里，Jev 才有可以选择的课程',
});

export const JEV_MESSAGES_EN = Object.freeze({
  'no-key': 'No Jev key is set: enter one under Settings › Experimental · Jev decision service. Do not paste the key into the conversation',
  'not-confirmed': 'The Jev privacy note has not been confirmed: confirm it under Settings › Experimental · Jev decision service first',
  off: 'The Jev decision service is off (experimental features are off by default); nothing was sent',
  'feature-off': 'This Jev experiment is not switched on; nothing was sent',
  'invalid-key': 'The Jev key is invalid or has been revoked: enter a valid key again under Settings › Experimental · Jev decision service.',
  'invalid-request': 'Jev did not accept this request (its content does not meet Jev’s requirements); the usual behaviour was used instead.',
  'rate-limited': 'Jev is rate limiting requests; StudyHub already waited and retried, so the usual behaviour was used instead.',
  overloaded: 'Jev is busy at the moment; StudyHub already retried without success, so the usual behaviour was used instead.',
  unavailable: 'Jev is temporarily unavailable; the usual behaviour was used instead.',
  network: 'Cannot reach Jev: check the network. The usual behaviour was used instead.',
  timeout: 'Jev did not answer in time; the usual behaviour was used instead.',
  'bad-response': 'Jev returned something that cannot be read; the usual behaviour was used instead.',
  'too-large': 'The content to send to Jev is too long, so nothing was sent; the usual behaviour was used instead.',
  unexpected: 'Jev returned an unexpected result; the usual behaviour was used instead.',
  'insufficient-balance': 'Jev reports that the quota or balance is used up (402); the usual behaviour was used instead.',
  'no-courses': 'There are no courses to choose from yet: file a few sources under courses first, so Jev has courses to pick from',
});

/** The sentences of the OpenCode presets that are about the service, naming it. Same codes as above; the others fall back to the base tables. */
export const JEV_OPENCODE_MESSAGES = Object.freeze({
  'no-key': 'OpenCode Zen 还没有可用的密钥：请到「设置 › 实验性 · Jev 判断服务」粘贴密钥，或用设置好环境变量的方式启动 DSH（默认读取 OPENCODE_GO_API_KEY_2）。不要把密钥贴到对话里',
  'invalid-key': 'OpenCode Zen 没有接受这个密钥（401，无效或已被撤销）：请检查「设置 › 实验性 · Jev 判断服务」里的密钥来源，或换一个有效的 OpenCode 密钥。',
  'insufficient-balance': 'OpenCode Zen 提示余额不足（402）：请到 OpenCode 账户查看余额，已改用原来的做法。',
  'invalid-request': 'OpenCode Zen 没有接受这次请求（内容或模型不符合它的要求），已改用原来的做法。',
  'rate-limited': 'OpenCode Zen 请求太频繁，已自动等待过但仍被限流，已改用原来的做法。',
  overloaded: 'OpenCode Zen 暂时繁忙，已自动重试过但没有成功，已改用原来的做法。',
  unavailable: 'OpenCode Zen 暂时不可用，已改用原来的做法。',
  network: '连不上 OpenCode Zen：请检查网络。已改用原来的做法。',
  timeout: 'OpenCode Zen 没有在时限内回应，已改用原来的做法。',
  'bad-response': 'OpenCode Zen 返回的内容无法识别，已改用原来的做法。',
  unexpected: 'OpenCode Zen 返回了意料之外的结果，已改用原来的做法。',
});

export const JEV_OPENCODE_MESSAGES_EN = Object.freeze({
  'no-key': 'No OpenCode Zen key is available: paste one under Settings › Experimental · Jev decision service, or start DSH with the environment variable set (OPENCODE_GO_API_KEY_2 unless the setting names another). Do not paste the key into the conversation',
  'invalid-key': 'OpenCode Zen did not accept this key (401, invalid or revoked): check where the key comes from under Settings › Experimental · Jev decision service, or use another valid OpenCode key.',
  'insufficient-balance': 'OpenCode Zen reports an insufficient balance (402): check the balance in your OpenCode account; the usual behaviour was used instead.',
  'invalid-request': 'OpenCode Zen did not accept this request (its content or model does not meet OpenCode Zen’s requirements); the usual behaviour was used instead.',
  'rate-limited': 'OpenCode Zen is rate limiting requests; StudyHub already waited and retried, so the usual behaviour was used instead.',
  overloaded: 'OpenCode Zen is busy at the moment; StudyHub already retried without success, so the usual behaviour was used instead.',
  unavailable: 'OpenCode Zen is temporarily unavailable; the usual behaviour was used instead.',
  network: 'Cannot reach OpenCode Zen: check the network. The usual behaviour was used instead.',
  timeout: 'OpenCode Zen did not answer in time; the usual behaviour was used instead.',
  'bad-response': 'OpenCode Zen returned something that cannot be read; the usual behaviour was used instead.',
  unexpected: 'OpenCode Zen returned an unexpected result; the usual behaviour was used instead.',
});

/** The message for an error or gate code in `language` ('en' for English, anything else Chinese), worded for `provider` (a preset id; none means TypeSafe's). */
export function jevMessage(code, language = 'zh', provider) {
  const english = language === 'en', base = english ? JEV_MESSAGES_EN : JEV_MESSAGES;
  const own = jevProvider(provider).family === 'opencode' ? (english ? JEV_OPENCODE_MESSAGES_EN : JEV_OPENCODE_MESSAGES) : null;
  return own?.[code] ?? base[code] ?? base.unexpected;
}

/** Refusals of the settings and operations, which are not codes of their own. */
const EXTRA = {
  '设置必须是对象': 'Settings must be an object',
  'Jev 密钥格式不对，请重新复制 TypeSafe 控制台里的完整密钥': 'The Jev key is not in the right format; copy the full key from the TypeSafe console again',
  'OpenCode 密钥格式不对，请重新复制 OpenCode 控制台里的完整密钥': 'The OpenCode key is not in the right format; copy the full key from the OpenCode console again',
  'Jev 服务商不认识，请从列表里选择': 'That Jev provider is not known; choose one from the list',
  '环境变量名只能包含字母、数字和下划线，且不能以数字开头': 'An environment variable name may only hold letters, digits and underscores, and cannot start with a digit',
  'confirm 必须是 true 或 false': 'confirm must be true or false',
  'enabled 必须是 true 或 false': 'enabled must be true or false',
  '功能开关必须是 true 或 false': 'A feature switch must be true or false',
  'features 必须是对象': 'features must be an object',
  '不认识的 Jev 实验功能': 'Unknown Jev experiment',
  'Jev 置信度阈值应是 0.5 到 0.99 之间的数字': 'The Jev confidence threshold must be a number from 0.5 to 0.99',
  '请选择 1–100 份资料': 'Select 1–100 sources',
  '请选择 1–200 个目录条目': 'Select 1–200 outline entries',
  '没有可以检查的题目': 'There are no questions to check',
};

/** Chinese sentence -> English sentence, for lib/application-messages-en.js. */
export const JEV_CATALOGUE = Object.freeze({ ...EXTRA, ...Object.fromEntries(Object.keys(JEV_MESSAGES).map(code => [JEV_MESSAGES[code], JEV_MESSAGES_EN[code]])),
  ...Object.fromEntries(Object.keys(JEV_OPENCODE_MESSAGES).map(code => [JEV_OPENCODE_MESSAGES[code], JEV_OPENCODE_MESSAGES_EN[code]])) });
