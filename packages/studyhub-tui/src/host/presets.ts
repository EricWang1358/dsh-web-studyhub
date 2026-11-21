/**
 * DSH-TUI style OpenAI-compatible provider presets + smart environment detection.
 *
 * Policy: the local `agy` CLI is the primary model route; these presets are the secondary
 * (OpenAI-compatible HTTP) route. Preset ids `deepseek`, `siliconflow`, `zhipu` and `custom`
 * are identical to `packages/studyhub-desktop/domain/config-policy.js` OPENAI_PRESETS so a
 * `desktop.json` written by the TUI stays fully readable by StudyHub Desktop (and vice versa).
 */

export interface TuiOpenAiPreset {
  /** Stable id persisted in `desktop.json` as `openai.providerId`. */
  id: string;
  /** Display name (bilingual where it matters). */
  name: string;
  nameEn: string;
  /** OpenAI-compatible base URL (without `/chat/completions`). Empty for custom. */
  baseUrl: string;
  /** Model used when the learner has not typed one. */
  defaultModel: string;
  /** Quick-pick model ids shown in Settings. */
  models: readonly string[];
  /** Environment variables that hold a key for this provider, in priority order. */
  envKeys: readonly string[];
  /** Where the learner can create an API key. */
  keyUrl: string;
}

const preset = (value: TuiOpenAiPreset): TuiOpenAiPreset =>
  Object.freeze({ ...value, models: Object.freeze([...value.models]), envKeys: Object.freeze([...value.envKeys]) });

export const TUI_OPENAI_PRESETS: readonly TuiOpenAiPreset[] = Object.freeze([
  preset({
    id: 'deepseek',
    name: 'DeepSeek',
    nameEn: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com',
    defaultModel: 'deepseek-chat',
    models: ['deepseek-chat', 'deepseek-reasoner'],
    envKeys: ['DEEPSEEK_API_KEY'],
    keyUrl: 'https://platform.deepseek.com/api_keys',
  }),
  preset({
    id: 'openai',
    name: 'OpenAI',
    nameEn: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    defaultModel: 'gpt-4.1-mini',
    models: ['gpt-4.1-mini', 'gpt-4.1', 'gpt-4o-mini', 'o4-mini'],
    envKeys: ['OPENAI_API_KEY'],
    keyUrl: 'https://platform.openai.com/api-keys',
  }),
  preset({
    id: 'siliconflow',
    name: '硅基流动 SiliconFlow',
    nameEn: 'SiliconFlow',
    baseUrl: 'https://api.siliconflow.cn/v1',
    defaultModel: 'deepseek-ai/DeepSeek-V3',
    models: ['deepseek-ai/DeepSeek-V3', 'deepseek-ai/DeepSeek-R1', 'Qwen/Qwen2.5-72B-Instruct'],
    envKeys: ['SILICONFLOW_API_KEY'],
    keyUrl: 'https://cloud.siliconflow.cn/account/ak',
  }),
  preset({
    id: 'zhipu',
    name: '智谱 GLM',
    nameEn: 'Zhipu GLM',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    defaultModel: 'glm-4-flash',
    models: ['glm-4-flash', 'glm-4-plus', 'glm-4-air'],
    envKeys: ['ZHIPUAI_API_KEY', 'ZHIPU_API_KEY', 'GLM_API_KEY'],
    keyUrl: 'https://open.bigmodel.cn/usercenter/apikeys',
  }),
  preset({
    id: 'openrouter',
    name: 'OpenRouter',
    nameEn: 'OpenRouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    defaultModel: 'deepseek/deepseek-chat',
    models: ['deepseek/deepseek-chat', 'openai/gpt-4.1-mini', 'google/gemini-2.5-flash', 'anthropic/claude-sonnet-4'],
    envKeys: ['OPENROUTER_API_KEY'],
    keyUrl: 'https://openrouter.ai/keys',
  }),
  preset({
    id: 'groq',
    name: 'Groq',
    nameEn: 'Groq',
    baseUrl: 'https://api.groq.com/openai/v1',
    defaultModel: 'llama-3.3-70b-versatile',
    models: ['llama-3.3-70b-versatile', 'llama-3.1-8b-instant'],
    envKeys: ['GROQ_API_KEY'],
    keyUrl: 'https://console.groq.com/keys',
  }),
  preset({
    id: 'moonshot',
    name: 'Moonshot Kimi',
    nameEn: 'Moonshot Kimi',
    baseUrl: 'https://api.moonshot.cn/v1',
    defaultModel: 'moonshot-v1-8k',
    models: ['moonshot-v1-8k', 'moonshot-v1-32k', 'kimi-latest'],
    envKeys: ['MOONSHOT_API_KEY', 'KIMI_API_KEY'],
    keyUrl: 'https://platform.moonshot.cn/console/api-keys',
  }),
  preset({
    id: 'custom',
    name: '自定义 Custom',
    nameEn: 'Custom',
    baseUrl: '',
    defaultModel: '',
    models: [],
    envKeys: [],
    keyUrl: '',
  }),
]);

/** Contract-shaped preset list (`DesktopConfigSnapshot.presets`). */
export function presetsForSnapshot(): Array<{ id: string; name: string; baseUrl: string; defaultModel: string }> {
  return TUI_OPENAI_PRESETS.map(({ id, name, baseUrl, defaultModel }) => ({ id, name, baseUrl, defaultModel }));
}

export function findPreset(id: string | null | undefined): TuiOpenAiPreset | undefined {
  const key = String(id ?? '').trim().toLowerCase();
  return TUI_OPENAI_PRESETS.find((item) => item.id === key);
}

export function normalizeBaseUrlText(value: unknown): string {
  return typeof value === 'string' ? value.trim().replace(/\/+$/, '') : '';
}

function originOf(value: string): string {
  try {
    return new URL(normalizeBaseUrlText(value)).origin;
  } catch {
    return '';
  }
}

/** Same rule as desktop `isValidBaseUrl`: http(s), a host, and no embedded credentials. */
export function isUsableBaseUrl(value: unknown): boolean {
  const url = normalizeBaseUrlText(value);
  if (!url) return false;
  try {
    const parsed = new URL(url);
    return (parsed.protocol === 'https:' || parsed.protocol === 'http:') && !parsed.username && !parsed.password && Boolean(parsed.hostname);
  } catch {
    return false;
  }
}

/** Same rule as desktop `isValidApiKey`: 1..512 printable ASCII characters without whitespace. */
export function isUsableApiKey(value: unknown): boolean {
  return typeof value === 'string' && /^[\x21-\x7e]{1,512}$/.test(value.trim());
}

/** The preset whose base URL has the same origin as `baseUrl` (never `custom`). */
export function matchPresetByBaseUrl(baseUrl: string): TuiOpenAiPreset | undefined {
  const origin = originOf(baseUrl);
  if (!origin) return undefined;
  return TUI_OPENAI_PRESETS.find((item) => item.baseUrl && originOf(item.baseUrl) === origin);
}

export interface EnvProviderDetection {
  presetId: string;
  providerName: string;
  /** Name of the environment variable the key came from (never the key itself in logs/UI). */
  envKey: string;
  baseUrl: string;
  model: string;
  apiKey: string;
  keyLast4: string;
  /** Whether `OPENAI_BASE_URL` / `OPENAI_MODEL` customised the endpoint. */
  fromBaseUrlEnv: boolean;
}

type EnvLike = Record<string, string | undefined>;

const readEnv = (env: EnvLike, key: string): string => {
  const value = env[key];
  return typeof value === 'string' ? value.trim() : '';
};

/** Order in which environment keys are considered (DeepSeek first, matching DSH-TUI). */
const ENV_PRIORITY: readonly string[] = Object.freeze(['deepseek', 'openai', 'siliconflow', 'openrouter', 'zhipu', 'moonshot', 'groq']);

function detectOne(env: EnvLike, presetId: string): EnvProviderDetection | null {
  const item = findPreset(presetId);
  if (!item) return null;
  for (const envKey of item.envKeys) {
    const apiKey = readEnv(env, envKey);
    if (!isUsableApiKey(apiKey)) continue;
    let baseUrl = item.baseUrl;
    let model = item.defaultModel;
    let presetIdOut = item.id;
    let providerName = item.name;
    let fromBaseUrlEnv = false;
    if (item.id === 'openai') {
      const envBase = normalizeBaseUrlText(readEnv(env, 'OPENAI_BASE_URL') || readEnv(env, 'OPENAI_API_BASE'));
      if (envBase && isUsableBaseUrl(envBase)) {
        fromBaseUrlEnv = true;
        baseUrl = envBase;
        const matched = matchPresetByBaseUrl(envBase);
        if (matched && matched.id !== 'openai') {
          presetIdOut = matched.id;
          providerName = matched.name;
          model = matched.defaultModel;
        } else if (!matched) {
          presetIdOut = 'custom';
          providerName = new URL(envBase).hostname;
          model = '';
        }
      }
      const envModel = readEnv(env, 'OPENAI_MODEL');
      if (envModel) model = envModel;
    }
    return {
      presetId: presetIdOut,
      providerName,
      envKey,
      baseUrl,
      model,
      apiKey,
      keyLast4: apiKey.slice(-4),
      fromBaseUrlEnv,
    };
  }
  return null;
}

/** Every OpenAI-compatible provider whose key is present in `env`, in priority order. */
export function detectEnvProviders(env: EnvLike = process.env): EnvProviderDetection[] {
  const out: EnvProviderDetection[] = [];
  for (const id of ENV_PRIORITY) {
    const found = detectOne(env, id);
    if (found) out.push(found);
  }
  return out;
}

/** The single best env provider: one with a usable endpoint *and* model, else null. */
export function detectPrimaryEnvProvider(env: EnvLike = process.env): EnvProviderDetection | null {
  return detectEnvProviders(env).find((item) => isUsableBaseUrl(item.baseUrl) && Boolean(item.model)) || null;
}

/** A redacted, UI-safe view of a detection (no raw key). */
export function describeEnvDetection(detection: EnvProviderDetection | null): Omit<EnvProviderDetection, 'apiKey'> | null {
  if (!detection) return null;
  const { apiKey: _apiKey, ...rest } = detection;
  return rest;
}

/** Build a `desktop.config.save` patch selecting `presetId` (keeps the saved key unless one is given). */
export function presetConfigPatch(
  presetId: string,
  { model, apiKey, baseUrl }: { model?: string; apiKey?: string; baseUrl?: string } = {},
): { mode: 'openai'; openai: Record<string, string> } {
  const item = findPreset(presetId) || findPreset('custom')!;
  const openai: Record<string, string> = {
    providerId: item.id,
    baseUrl: normalizeBaseUrlText(baseUrl ?? item.baseUrl),
    model: String(model ?? item.defaultModel).trim(),
  };
  if (apiKey !== undefined) openai.apiKey = String(apiKey).trim();
  return { mode: 'openai', openai };
}

/** Preferred agy models (first available wins), then the first ready model the CLI lists. */
export const AGY_MODEL_PREFERENCE: readonly string[] = Object.freeze([
  'gemini-4-neon-high',
  'gemini-4-neon-medium',
  'gemini-4-carbon-high',
  'gemini-3.8-flash-high',
  'gemini-3.8-flash-medium',
]);

export function pickAgyModel(
  models: ReadonlyArray<{ id: string } | string> | null | undefined,
  preference: readonly string[] = AGY_MODEL_PREFERENCE,
): string {
  const ids = (models || [])
    .map((item) => (typeof item === 'string' ? item : item?.id))
    .filter((id): id is string => typeof id === 'string' && Boolean(id.trim()) && !/\s/.test(id));
  if (!ids.length) return '';
  for (const wanted of preference) if (ids.includes(wanted)) return wanted;
  return ids.find((id) => !/orchestrator/i.test(id)) || ids[0];
}
