import { GENERATION_TIMEOUT_MS } from '../../../../lib/generation-limits.js';
import { usageFromTokenUsage } from '../../../../lib/token-usage.js';
import { reportUsage } from '../../../../lib/usage-scope.js';
import { clipDetail, redactSecret } from '../../domain/redact.js';

function statusHint(status) {
  if (status === 401 || status === 403) return '密钥不对或没有权限';
  if (status === 404) return '接口地址或模型名不对';
  if (status === 429) return '请求太频繁或额度用完';
  return status >= 500 ? '服务暂时出错' : '请求被拒绝';
}

/**
 * Resolve `/chat/completions` URL from a base URL (with or without trailing `/chat/completions`).
 */
export function chatCompletionsUrl(baseUrl) {
  const clean = String(baseUrl || '').trim().replace(/\/+$/, '');
  return /\/chat\/completions$/.test(clean) ? clean : `${clean}/chat/completions`;
}

const isSafeNonNeg = (value) => Number.isSafeInteger(value) && value >= 0;

/**
 * Map OpenAI-compatible usage payload into StudyHub's `token-usage.js` input shape.
 */
export function mapOpenAiUsage(usage) {
  if (!usage || typeof usage !== 'object') return null;
  const prompt = Number(usage.prompt_tokens);
  const output = Number(usage.completion_tokens);
  if (!isSafeNonNeg(prompt) || !isSafeNonNeg(output)) return null;
  const rawCached = usage.prompt_tokens_details?.cached_tokens ?? usage.prompt_cache_hit_tokens ?? 0;
  const cached = Number(rawCached);
  const cacheRead = isSafeNonNeg(cached) && cached <= prompt ? cached : 0;
  return {
    inputTokens: prompt - cacheRead,
    outputTokens: output,
    cacheReadTokens: cacheRead,
    cacheWriteTokens: 0,
  };
}

function defaultReport(usage, execution) {
  if (!usage) return;
  try {
    const buckets = usageFromTokenUsage(usage);
    if (buckets) reportUsage(buckets, { calls: 1, task: execution?.task || 'assist' });
  } catch {
    // Token reporting must never break model completion.
  }
}

function buildChatBody({ model, system, prompt, maxTokens }) {
  const payload = {
    model,
    stream: false,
    messages: [
      { role: 'system', content: String(system ?? '') },
      { role: 'user', content: String(prompt ?? '') },
    ],
  };
  if (Number.isSafeInteger(maxTokens) && maxTokens > 0) {
    payload.max_tokens = maxTokens;
  }
  return JSON.stringify(payload);
}

async function sendOpenAiRequest({ fetch, baseUrl, apiKey, body, signal, deadline, timeoutMs, callerSignal }) {
  try {
    return await fetch(chatCompletionsUrl(baseUrl), {
      method: 'POST',
      signal,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
      body,
    });
  } catch (error) {
    if (callerSignal?.aborted) throw error;
    if (deadline.aborted) {
      throw Object.assign(new Error(`模型服务 ${Math.round(timeoutMs / 1000)} 秒内没有回复`), { modelFailure: true });
    }
    const rawDetail = error?.cause?.code || error?.message || error;
    const safeMsg = clipDetail(redactSecret(rawDetail, apiKey));
    throw Object.assign(new Error(`连不上模型服务：${safeMsg}。请检查接口地址和网络`), { modelFailure: true });
  }
}

async function parseOpenAiResponse(response, apiKey) {
  if (!response.ok) {
    const detail = clipDetail(redactSecret(await response.text().catch(() => ''), apiKey));
    throw Object.assign(
      new Error(`模型服务回复 HTTP ${response.status}（${statusHint(response.status)}）：${detail || '没有返回原因'}`),
      { modelFailure: true, status: response.status },
    );
  }
  const rawBody = await response.text();
  try {
    return JSON.parse(rawBody);
  } catch {
    const safeBody = clipDetail(redactSecret(rawBody, apiKey));
    throw Object.assign(new Error(`模型服务的回复不是 JSON：${safeBody || '空白'}`), { modelFailure: true });
  }
}

function extractCompletionText(data) {
  const choices = Array.isArray(data?.choices) ? data.choices : [];
  const text = choices[0]?.message?.content;
  if (typeof text !== 'string' || !text.trim()) {
    throw Object.assign(new Error('模型没有返回文字'), { modelFailure: true });
  }
  return text;
}

function readEndpointConfig(config) {
  if (!config || typeof config !== 'object') return null;
  const baseUrl = String(config.baseUrl ?? '').trim();
  const model = String(config.model ?? '').trim();
  const apiKey = String(config.apiKey ?? '').trim();
  return baseUrl && model && apiKey ? { baseUrl, model, apiKey } : null;
}

/**
 * Create a StudyHub `complete(system, prompt, execution)` over an OpenAI-compatible `/chat/completions` endpoint.
 */
export function createOpenAiCompleteAdapter(config, {
  fetch = globalThis.fetch,
  report = defaultReport,
  timeoutMs = GENERATION_TIMEOUT_MS,
} = {}) {
  const endpoint = readEndpointConfig(config);
  if (!endpoint) return undefined;

  return async function openaiComplete(system, prompt, execution = {}) {
    const deadline = AbortSignal.timeout(timeoutMs);
    const callerSignal = execution?.signal;
    const signal = callerSignal ? AbortSignal.any([deadline, callerSignal]) : deadline;
    const body = buildChatBody({ model: endpoint.model, system, prompt, maxTokens: execution?.maxTokens });
    const response = await sendOpenAiRequest({
      fetch, baseUrl: endpoint.baseUrl, apiKey: endpoint.apiKey, body, signal, deadline, timeoutMs, callerSignal,
    });
    const data = await parseOpenAiResponse(response, endpoint.apiKey);
    const usage = mapOpenAiUsage(data?.usage);
    if (usage && report) report(usage, execution);

    const text = extractCompletionText(data);
    const emitChunk = execution?.onOutput || execution?.onChunk;
    if (emitChunk) emitChunk(text);
    return text;
  };
}
