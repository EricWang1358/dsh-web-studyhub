/* The model port StudyHub's work expects, complete(system, prompt, execution?) -> text, over any OpenAI-compatible
   /chat/completions endpoint the learner filled in (ZCode lends a plugin no model, so StudyHub calls one itself).
   Ported from BAXUIE's StudyHub for ZCode 0.4.8 (MIT).

   - A deadline per call (the caller's signal joins it), so a gateway that hangs fails with words instead of waiting forever.
   - Honest errors in Chinese source copy; lib/application-messages.js has their English, like every application message.
   - What the provider reports it billed goes to StudyHub's token tally (lib/usage-scope.js), the same as under DSH. */

export const MODEL_TIMEOUT_MS = 180_000;
const DETAIL_LIMIT = 300;

const STATUS_HINT = (status) => (status === 401 || status === 403 ? '密钥不对或没有权限'
  : status === 404 ? '接口地址或模型名不对'
    : status === 429 ? '请求太频繁或额度用完'
      : status >= 500 ? '服务暂时出错' : '请求被拒绝');

const clip = (text) => String(text ?? '').replace(/\s+/g, ' ').trim().slice(0, DETAIL_LIMIT);

/** `text` with the key taken out: the whole key, any Bearer credential, and the key's first 12 characters (a provider
 *  that echoes a shortened key). Applied to everything a failure says, before it is clipped or shown. */
export function redactKey(text, apiKey) {
  let clean = String(text ?? '').replace(/Bearer\s+[^\s"',;]+/gi, 'Bearer ••••');
  if (apiKey) {
    clean = clean.split(apiKey).join('••••');
    if (apiKey.length >= 16) clean = clean.split(apiKey.slice(0, 12)).join('••••');
  }
  return clean;
}

/** The address of the chat endpoint for a base URL (with or without a trailing /chat/completions). */
export const chatUrl = (baseUrl) => {
  const base = String(baseUrl || '').replace(/\/+$/, '');
  return /\/chat\/completions$/.test(base) ? base : `${base}/chat/completions`;
};

/** The provider's usage report in StudyHub's buckets (lib/token-usage.js), or null. */
export function usageOf(usage) {
  if (!usage || typeof usage !== 'object') return null;
  const prompt = Number(usage.prompt_tokens), output = Number(usage.completion_tokens);
  if (!Number.isSafeInteger(prompt) || !Number.isSafeInteger(output) || prompt < 0 || output < 0) return null;
  const cached = Number(usage.prompt_tokens_details?.cached_tokens ?? usage.prompt_cache_hit_tokens ?? 0);
  const read = Number.isSafeInteger(cached) && cached > 0 && cached <= prompt ? cached : 0;
  return { inputTokens: prompt - read, outputTokens: output, cacheReadTokens: read, cacheWriteTokens: 0 };
}

/**
 * complete for `model` ({ baseUrl, id, apiKey }), or undefined when it is incomplete.
 * `report(usage, meta)` receives the billed tokens (lib/usage-scope.js reportUsage after lib/token-usage.js usageFromTokenUsage).
 */
export function openaiComplete(model, { fetch = globalThis.fetch, report, timeoutMs = MODEL_TIMEOUT_MS } = {}) {
  if (!model?.baseUrl || !model.id || !model.apiKey) return undefined;
  const { baseUrl, id, apiKey } = model;
  return async function complete(system, prompt, execution = {}) {
    const deadline = AbortSignal.timeout(timeoutMs);
    const signal = execution?.signal ? AbortSignal.any([deadline, execution.signal]) : deadline;
    let response;
    try {
      response = await fetch(chatUrl(baseUrl), {
        method: 'POST', signal,
        headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({ model: id, stream: false,
          messages: [{ role: 'system', content: String(system ?? '') }, { role: 'user', content: String(prompt ?? '') }],
          ...(Number.isSafeInteger(execution?.maxTokens) && execution.maxTokens > 0 ? { max_tokens: execution.maxTokens } : {}) }),
      });
    } catch (error) {
      if (execution?.signal?.aborted) throw error;
      if (deadline.aborted) throw Object.assign(new Error(`模型服务 ${Math.round(timeoutMs / 1000)} 秒内没有回复`), { modelFailure: true });
      // undici's own words can quote the request: only its code, or its message with the key taken out, is said.
      throw Object.assign(new Error(`连不上模型服务：${clip(redactKey(error?.cause?.code || error?.message || error, apiKey))}。请检查接口地址和网络`), { modelFailure: true });
    }
    if (!response.ok) {
      const detail = clip(redactKey(await response.text().catch(() => ''), apiKey));
      throw Object.assign(new Error(`模型服务回复 HTTP ${response.status}（${STATUS_HINT(response.status)}）：${detail || '没有返回原因'}`),
        { modelFailure: true, status: response.status });
    }
    const body = await response.text();
    let data;
    try { data = JSON.parse(body); } catch {
      // A 200 whose body is not JSON: a captive portal or a gateway's error page.
      throw Object.assign(new Error(`模型服务的回复不是 JSON：${clip(redactKey(body, apiKey)) || '空白'}`), { modelFailure: true });
    }
    try { const usage = usageOf(data?.usage); if (usage) report?.(usage, { calls: 1, task: execution?.task || 'light' }); } catch { /* a tally never breaks the call */ }
    const text = data?.choices?.[0]?.message?.content;
    if (typeof text !== 'string' || !text.trim()) throw Object.assign(new Error('模型没有返回文字'), { modelFailure: true });
    return text;
  };
}
