/* The transcription providers, once. Pure data: the settings page, the dashboard and the host's key handling all read
   this list, so adding or retiring a provider is one row. Display text is Chinese source copy: the panel translates it
   with ui() at render time.
   requestOrder: the order a transcription request tries the providers.
   mainlandOrder / overseasOrder: the order of the settings cards for a learner in mainland China / elsewhere
   (`null`: not a card of its own; the paid key sits under "Advanced"). */

const GEMINI_CONSOLE = 'https://aistudio.google.com';
const GEMINI_KEY = `${GEMINI_CONSOLE}/apikey`;
const GEMINI_USAGE = `${GEMINI_CONSOLE}/usage`;

const row = (value) => Object.freeze(value);

export const AUDIO_PROVIDERS = Object.freeze([
  row({ tier: 'free', keyField: 'freeKey', envVar: 'GEMINI_FREE_API_KEY', name: 'Google Gemini', shortName: 'Gemini 免费', badge: '免费额度 · 需海外网络', tone: '',
    consoleUrl: GEMINI_CONSOLE, keyUrl: GEMINI_KEY, usageUrl: GEMINI_USAGE, requestOrder: 0, mainlandOrder: 2, overseasOrder: 1 }),
  row({ tier: 'siliconflow', keyField: 'siliconflowKey', envVar: 'SILICONFLOW_API_KEY', name: '硅基流动 SenseVoice', shortName: '硅基流动', badge: '免费 · 国内直连', tone: 'good',
    consoleUrl: 'https://cloud.siliconflow.cn', keyUrl: 'https://cloud.siliconflow.cn/account/ak', usageUrl: 'https://cloud.siliconflow.cn', requestOrder: 1, mainlandOrder: 0, overseasOrder: 2 }),
  row({ tier: 'groq', keyField: 'groqKey', envVar: 'GROQ_API_KEY', name: 'Groq Whisper', shortName: 'Groq', badge: '免费额度 · 需海外网络', tone: '',
    consoleUrl: 'https://console.groq.com', keyUrl: 'https://console.groq.com/keys', usageUrl: 'https://console.groq.com/settings/limits', requestOrder: 2, mainlandOrder: 1, overseasOrder: 0 }),
  row({ tier: 'paid', keyField: 'paidKey', envVar: 'GEMINI_PAID_API_KEY', name: 'Gemini 付费密钥', shortName: 'Gemini 付费', badge: '按量计费', tone: '',
    consoleUrl: GEMINI_CONSOLE, keyUrl: GEMINI_KEY, usageUrl: GEMINI_USAGE, requestOrder: 3, mainlandOrder: null, overseasOrder: null }),
].sort((a, b) => a.requestOrder - b.requestOrder));

/** The tiers in request order: ["free", "siliconflow", "groq", "paid"]. */
export const AUDIO_TIERS = Object.freeze(AUDIO_PROVIDERS.map((provider) => provider.tier));

/** The provider of a tier, or undefined. */
export const providerOf = (tier) => AUDIO_PROVIDERS.find((provider) => provider.tier === tier);

/** The providers that have a card of their own, in the order that suits this interface language. */
export const providersFor = (language) => {
  const field = language === 'en' ? 'overseasOrder' : 'mainlandOrder';
  return AUDIO_PROVIDERS.filter((provider) => provider[field] !== null).sort((a, b) => a[field] - b[field]);
};
