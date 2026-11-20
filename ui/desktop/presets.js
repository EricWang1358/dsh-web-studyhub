/* Domestic-direct OpenAI-compatible presets for StudyHub Desktop (any OpenAI-compatible
   endpoint also works via custom). Pure data: Chinese source copy translated via ui() at render. */
export const MODEL_PRESETS = Object.freeze([
  Object.freeze({
    id: 'zhipu',
    name: '智谱 GLM',
    badge: '国内直连',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    model: 'glm-4-flash',
    steps: Object.freeze([
      { text: '打开智谱开放平台，用手机号注册并登录', href: 'https://open.bigmodel.cn' },
      { text: '在「API Keys」页新建一个密钥并复制', href: 'https://open.bigmodel.cn/usercenter/apikeys' },
    ]),
  }),
  Object.freeze({
    id: 'siliconflow',
    name: '硅基流动',
    badge: '国内直连',
    baseUrl: 'https://api.siliconflow.cn/v1',
    model: 'deepseek-ai/DeepSeek-V3',
    steps: Object.freeze([
      { text: '打开硅基流动，用手机号注册并登录', href: 'https://cloud.siliconflow.cn' },
      { text: '在「API 密钥」页新建一个密钥并复制', href: 'https://cloud.siliconflow.cn/account/ak' },
    ]),
  }),
  Object.freeze({
    id: 'deepseek',
    name: 'DeepSeek',
    badge: '国内直连',
    baseUrl: 'https://api.deepseek.com',
    model: 'deepseek-chat',
    steps: Object.freeze([
      { text: '在 DeepSeek 开放平台注册并登录', href: 'https://platform.deepseek.com' },
      { text: '在「API keys」页创建一个密钥并复制', href: 'https://platform.deepseek.com/api_keys' },
    ]),
  }),
]);

/** Find the preset matching a baseUrl (ignoring trailing slashes), or 'custom'. */
export function presetOf(baseUrl) {
  const normalized = String(baseUrl || '').replace(/\/+$/, '');
  return MODEL_PRESETS.find((preset) => preset.baseUrl === normalized)?.id || 'custom';
}

/** Find a preset by its id, or undefined. */
export function presetById(id) {
  return MODEL_PRESETS.find((preset) => preset.id === id);
}
