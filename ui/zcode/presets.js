/* Model services a learner in mainland China can reach directly, as presets of the ZCode model form (any OpenAI-compatible
   endpoint works; 自定义 takes the rest). Pure data: names and steps are Chinese source copy, translated with ui() at
   render time. The model names are a start the learner can change: the provider's own model list is the authority. */
export const MODEL_PRESETS = Object.freeze([
  Object.freeze({ id: 'zhipu', name: '智谱 GLM', badge: '国内直连', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-4-flash',
    steps: Object.freeze([{ text: '打开智谱开放平台，用手机号注册并登录', href: 'https://open.bigmodel.cn' },
      { text: '在「API Keys」页新建一个密钥并复制', href: 'https://open.bigmodel.cn/usercenter/apikeys' }]) }),
  Object.freeze({ id: 'siliconflow', name: '硅基流动', badge: '国内直连', baseUrl: 'https://api.siliconflow.cn/v1', model: 'deepseek-ai/DeepSeek-V3',
    steps: Object.freeze([{ text: '打开硅基流动，用手机号注册并登录', href: 'https://cloud.siliconflow.cn' },
      { text: '在「API 密钥」页新建一个密钥并复制', href: 'https://cloud.siliconflow.cn/account/ak' }]) }),
  Object.freeze({ id: 'deepseek', name: 'DeepSeek', badge: '国内直连', baseUrl: 'https://api.deepseek.com', model: 'deepseek-chat',
    steps: Object.freeze([{ text: '在 DeepSeek 开放平台注册并登录', href: 'https://platform.deepseek.com' },
      { text: '在「API keys」页创建一个密钥并复制', href: 'https://platform.deepseek.com/api_keys' }]) }),
]);

/** The preset whose address this is ('custom' when none). */
export const presetOf = (baseUrl) => MODEL_PRESETS.find((preset) => preset.baseUrl === String(baseUrl || '').replace(/\/+$/, ''))?.id || 'custom';
