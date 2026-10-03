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
  'no-endpoint': 'Jev 的自定义端点还没有填写完整：请到「设置 › 实验性功能」里填写接口地址和模型名。',
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
  'no-endpoint': 'The custom Jev endpoint is not filled in yet: enter the endpoint address and the model id under Settings › Experimental features.',
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

/** The same sentences for the custom endpoint: "OpenCode Zen" becomes "the custom Jev endpoint", and the two that name where a key comes from are its own. */
const forCustom = (table, name, own) => Object.freeze({ ...Object.fromEntries(Object.entries(table).map(([code, text]) => [code, text.replace(/^OpenCode Zen/, name[0]).replaceAll('OpenCode Zen', name[1])])), ...own });
export const JEV_CUSTOM_MESSAGES = forCustom(JEV_OPENCODE_MESSAGES, ['自定义 Jev 端点', '自定义 Jev 端点'], {
  'no-key': '自定义 Jev 端点还没有可用的密钥：请到「设置 › 实验性功能」粘贴密钥，或用设置好环境变量的方式启动 DSH（默认读取 JEV_CUSTOM_API_KEY）。不要把密钥贴到对话里',
  'invalid-key': '自定义 Jev 端点没有接受这个密钥（无效、已被撤销，或这个端点不用 Bearer 密钥）：请检查「设置 › 实验性功能」里的密钥来源和接口地址。',
  'insufficient-balance': '自定义 Jev 端点提示余额不足（402）：请到它的账户查看余额，已改用原来的做法。',
});
export const JEV_CUSTOM_MESSAGES_EN = forCustom(JEV_OPENCODE_MESSAGES_EN, ['The custom Jev endpoint', 'the custom Jev endpoint'], {
  'no-key': 'No key is available for the custom Jev endpoint: paste one under Settings › Experimental features, or start DSH with the environment variable set (JEV_CUSTOM_API_KEY unless the setting names another). Do not paste the key into the conversation',
  'invalid-key': 'The custom Jev endpoint did not accept this key (invalid, revoked, or the endpoint does not use a bearer key): check where the key comes from and the endpoint address under Settings › Experimental features.',
  'insufficient-balance': 'The custom Jev endpoint reports an insufficient balance (402): check the balance in its account; the usual behaviour was used instead.',
});

/** The message for an error or gate code in `language` ('en' for English, anything else Chinese), worded for `provider` (a preset id; none means TypeSafe's). */
export function jevMessage(code, language = 'zh', provider) {
  const english = language === 'en', base = english ? JEV_MESSAGES_EN : JEV_MESSAGES, family = jevProvider(provider).family;
  const own = family === 'opencode' ? (english ? JEV_OPENCODE_MESSAGES_EN : JEV_OPENCODE_MESSAGES) : family === 'custom' ? (english ? JEV_CUSTOM_MESSAGES_EN : JEV_CUSTOM_MESSAGES) : null;
  const text = own?.[code] ?? base[code] ?? base.unexpected, brand = jevProvider(provider).brand;
  // The OpenCode sentences are written for Zen; the Go preset says "OpenCode Go" instead.
  return family === 'opencode' && brand && brand !== 'OpenCode Zen' ? text.replaceAll('OpenCode Zen', brand) : text;
}

/**
 * The one sentence that says, once per run, why some items went to the usual model instead of Jev. `reason` is a Jev error code, a gate
 * code (no-key, not-confirmed), 'low-confidence' (Jev was less sure than the learner's line) or 'unsupported' (Jev cannot judge that input).
 * `provider` words the typed failures for the service that failed. Never holds a key, the learner's text or a response body.
 */
export function jevFallbackMessage(reason, { count = 0, threshold = 0.8, language = 'zh', provider } = {}) {
  const english = language === 'en', line = Math.round(threshold * 100);
  if (reason === 'low-confidence') return english
    ? `Jev was less sure than your ${line}% line about ${count} item(s), so the usual model judged them.`
    : `Jev 对其中 ${count} 项的把握低于你设的 ${line}%，这些交给了原来的模型判断。`;
  if (reason === 'unsupported') return english
    ? `Jev cannot judge ${count} item(s) (its input does not fit what Jev accepts), so the usual model judged them.`
    : `Jev 无法判断其中 ${count} 项（输入不符合它的要求），这些交给了原来的模型判断。`;
  const why = jevMessage(reason, language, provider);
  return english ? `${count} item(s) went to the usual model instead of Jev. ${why}` : `有 ${count} 项交给了原来的模型判断，没有用 Jev。${why}`;
}

/** Refusals of the settings and operations, which are not codes of their own. */
const EXTRA = {
  '设置必须是对象': 'Settings must be an object',
  'Jev 密钥格式不对，请重新复制 TypeSafe 控制台里的完整密钥': 'The Jev key is not in the right format; copy the full key from the TypeSafe console again',
  'OpenCode 密钥格式不对，请重新复制 OpenCode 控制台里的完整密钥': 'The OpenCode key is not in the right format; copy the full key from the OpenCode console again',
  'Jev 服务商不认识，请从列表里选择': 'That Jev provider is not known; choose one from the list',
  'Jev 自定义端点的地址不能用：需要 https 地址（本机可用 http），不含用户名密码、查询参数或锚点': 'That custom Jev endpoint cannot be used: it needs an https address (http only for this machine) without credentials, a query or a fragment',
  'Jev 自定义端点的模型名只能包含字母、数字和 . _ : / -': 'The model id of the custom Jev endpoint may only hold letters, digits and . _ : / -',
  'Jev 自定义端点的密钥格式不对，请重新复制完整密钥': 'The key of the custom Jev endpoint is not in the right format; copy the full key again',
  '环境变量名只能包含字母、数字和下划线，且不能以数字开头': 'An environment variable name may only hold letters, digits and underscores, and cannot start with a digit',
  'confirm 必须是 true 或 false': 'confirm must be true or false',
  'enabled 必须是 true 或 false': 'enabled must be true or false',
  '功能开关必须是 true 或 false': 'A feature switch must be true or false',
  'features 必须是对象': 'features must be an object',
  '不认识的 Jev 实验功能': 'Unknown Jev experiment',
  'replace 必须是对象': 'replace must be an object',
  '不认识的 Jev 替换项': 'Unknown Jev replacement',
  'Jev 置信度阈值应是 0.5 到 0.99 之间的数字': 'The Jev confidence threshold must be a number from 0.5 to 0.99',
  '请选择 1–100 份资料': 'Select 1–100 sources',
  '请选择 1–200 个目录条目': 'Select 1–200 outline entries',
  '没有可以检查的题目': 'There are no questions to check',
};

/** Chinese sentence -> English sentence, for lib/application-messages-en.js. */
export const JEV_CATALOGUE = Object.freeze({ ...EXTRA, ...Object.fromEntries(Object.keys(JEV_MESSAGES).map(code => [JEV_MESSAGES[code], JEV_MESSAGES_EN[code]])),
  ...Object.fromEntries(Object.keys(JEV_OPENCODE_MESSAGES).map(code => [JEV_OPENCODE_MESSAGES[code], JEV_OPENCODE_MESSAGES_EN[code]])),
  ...Object.fromEntries(Object.keys(JEV_CUSTOM_MESSAGES).map(code => [JEV_CUSTOM_MESSAGES[code], JEV_CUSTOM_MESSAGES_EN[code]])) });
