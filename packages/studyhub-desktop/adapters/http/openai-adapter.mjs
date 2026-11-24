import { GENERATION_TIMEOUT_MS } from '../../../../lib/generation-limits.js';
import { usageFromTokenUsage } from '../../../../lib/token-usage.js';
import { reportUsage } from '../../../../lib/usage-scope.js';
import { clipDetail, redactSecret } from '../../domain/redact.js';
import {
  extractJsonCompletion,
  isReasoningModel,
  longStreamFetch,
  normalizeReasoningEffort,
  readOpenAiSseStream,
  resolveChatCompletionsUrl,
} from './openai-stream.mjs';

function statusHint(status) {
  if (status === 401 || status === 403) return '密钥不对或没有权限';
  if (status === 404) return '接口地址或模型名不对';
  if (status === 429) return '请求太频繁或额度用完';
  return status >= 500 ? '服务暂时出错' : '请求被拒绝';
}

function statusErrorCode(status) {
  if (status === 401 || status === 403) return 'AUTHENTICATION';
  if (status === 429) return 'RATE_LIMIT';
  if (status >= 500) return 'SERVER_ERROR';
  return undefined;
}

/**
 * Resolve `/chat/completions` URL from a base URL (preserving query parameters such as `?api-version=...`).
 */
export function chatCompletionsUrl(baseUrl) {
  return resolveChatCompletionsUrl(baseUrl);
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

function resolveEffort(config, execution) {
  const raw = execution?.reasoningEffort ?? execution?.route?.reasoningEffort ?? config?.reasoningEffort;
  return normalizeReasoningEffort(raw);
}

function buildChatBody({ model, system, prompt, messages, maxTokens, effort, stream, includeStreamOptions }) {
  const normalizedMessages =
    Array.isArray(messages) && messages.length > 0
      ? [
          { role: 'system', content: String(system ?? '') },
          ...messages
            .filter((m) => m && (m.role === 'user' || m.role === 'assistant' || m.role === 'system'))
            .map((m) => ({ role: m.role, content: String(m.content ?? '') })),
        ]
      : [
          { role: 'system', content: String(system ?? '') },
          { role: 'user', content: String(prompt ?? '') },
        ];
  const payload = {
    model,
    stream,
    messages: normalizedMessages,
  };
  if (stream && includeStreamOptions) {
    payload.stream_options = { include_usage: true };
  }
  if (Number.isSafeInteger(maxTokens) && maxTokens > 0) {
    if (isReasoningModel(model)) payload.max_completion_tokens = maxTokens;
    else payload.max_tokens = maxTokens;
  }
  if (effort) {
    payload.reasoning_effort = effort;
  }
  return JSON.stringify(payload);
}

function normalizeTransportError(error, { callerSignal, deadline, timeoutMs, apiKey }) {
  if (callerSignal?.aborted) return error;
  if (deadline?.aborted || error?.name === 'TimeoutError') {
    return Object.assign(new Error(`模型服务 ${Math.round(timeoutMs / 1000)} 秒内没有回复`), {
      name: 'TimeoutError',
      modelFailure: true,
    });
  }
  const rawDetail = error?.cause?.code || error?.message || error;
  const safeMsg = clipDetail(redactSecret(rawDetail, apiKey));
  return Object.assign(new Error(`连不上模型服务：${safeMsg}。请检查接口地址和网络`), {
    code: 'TRANSPORT',
    modelFailure: true,
  });
}

function buildHttpStatusError(status, rawText, apiKey) {
  const detail = clipDetail(redactSecret(rawText, apiKey));
  const code = statusErrorCode(status);
  return Object.assign(
    new Error(`模型服务回复 HTTP ${status}（${statusHint(status)}）：${detail || '没有返回原因'}`),
    { modelFailure: true, status, ...(code ? { code } : {}) },
  );
}

function isSseResponse(response) {
  const contentType = String(response?.headers?.get?.('content-type') || '').toLowerCase();
  return contentType.includes('text/event-stream');
}

function assertNonEmptyText(text, finishReason) {
  if (typeof text === 'string' && text.trim()) return text;
  if (finishReason === 'length') {
    throw Object.assign(
      new Error('Model returned no text: it reached its output limit before answering'),
      { code: 'MAX_TOKENS', modelFailure: true },
    );
  }
  throw Object.assign(new Error('模型没有返回文字'), { code: 'EMPTY_RESPONSE', modelFailure: true });
}

async function decodeOpenAiResponse(response, { apiKey, onOutput, onReasoning }) {
  if (!response.ok) {
    const rawErr = await response.text().catch(() => '');
    throw buildHttpStatusError(response.status, rawErr, apiKey);
  }
  if (isSseResponse(response)) {
    const streamed = await readOpenAiSseStream(response, { onOutput, onReasoning });
    return {
      text: assertNonEmptyText(streamed.text, streamed.finishReason),
      usage: streamed.usage,
      alreadyEmitted: true,
    };
  }
  const rawBody = await response.text();
  let data;
  try {
    data = JSON.parse(rawBody);
  } catch {
    const safeBody = clipDetail(redactSecret(rawBody, apiKey));
    throw Object.assign(new Error(`模型服务的回复不是 JSON：${safeBody || '空白'}`), { modelFailure: true });
  }
  const { text, finishReason, reasoning } = extractJsonCompletion(data);
  if (reasoning) onReasoning?.(reasoning.length);
  return {
    text: assertNonEmptyText(text, finishReason),
    usage: data?.usage,
    alreadyEmitted: false,
  };
}

function readEndpointConfig(config) {
  if (!config || typeof config !== 'object') return null;
  const baseUrl = String(config.baseUrl ?? '').trim();
  const model = String(config.model ?? '').trim();
  const apiKey = String(config.apiKey ?? '').trim();
  if (!baseUrl || !model || !apiKey) return null;
  const reasoningEffort = normalizeReasoningEffort(config.reasoningEffort);
  return { baseUrl, model, apiKey, reasoningEffort };
}

function resolveTimeoutMs(execution, defaultTimeoutMs) {
  const requested = execution?.timeoutMs;
  if (requested === undefined || requested === null) return defaultTimeoutMs;
  return Number.isFinite(requested) && requested >= 0 ? requested : defaultTimeoutMs;
}

function buildRequestSignal(effectiveTimeoutMs, callerSignal) {
  const deadline = effectiveTimeoutMs > 0 ? AbortSignal.timeout(effectiveTimeoutMs) : null;
  if (deadline && callerSignal) return { deadline, signal: AbortSignal.any([deadline, callerSignal]) };
  return { deadline, signal: deadline || callerSignal || undefined };
}

async function sendAndDecode({ httpFetch, endpoint, body, signal, timeoutCtx, callbacks }) {
  try {
    const response = await httpFetch(chatCompletionsUrl(endpoint.baseUrl), {
      method: 'POST',
      signal,
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${endpoint.apiKey}`,
      },
      body,
    });
    return await decodeOpenAiResponse(response, { apiKey: endpoint.apiKey, ...callbacks });
  } catch (error) {
    if (error?.modelFailure) throw error;
    throw normalizeTransportError(error, { ...timeoutCtx, apiKey: endpoint.apiKey });
  }
}

function shouldRetryWithoutStreamOptions(error, stream, includeStreamOptions) {
  return Boolean(stream && includeStreamOptions && error?.status === 400 && /stream_options/i.test(String(error?.message || '')));
}

async function executeWithStreamFallback(executeAttempt, stream) {
  try {
    return await executeAttempt(stream);
  } catch (error) {
    if (!shouldRetryWithoutStreamOptions(error, stream, true)) throw error;
    return executeAttempt(false);
  }
}

/**
 * Create a StudyHub `complete(system, prompt, execution)` over an OpenAI-compatible `/chat/completions` endpoint.
 */
export function createOpenAiCompleteAdapter(config, {
  fetch: injectedFetch,
  report = defaultReport,
  timeoutMs = GENERATION_TIMEOUT_MS,
} = {}) {
  const endpoint = readEndpointConfig(config);
  if (!endpoint) return undefined;
  const httpFetch = injectedFetch || longStreamFetch;

  return async function openaiComplete(system, prompt, execution = {}) {
    const effectiveTimeoutMs = resolveTimeoutMs(execution, timeoutMs);
    const callerSignal = execution?.signal;
    const { deadline, signal } = buildRequestSignal(effectiveTimeoutMs, callerSignal);
    const stream = execution?.stream !== false;
    const effort = resolveEffort(endpoint, execution);
    const onOutput = execution?.onOutput || execution?.onChunk;
    const timeoutCtx = { callerSignal, deadline, timeoutMs: effectiveTimeoutMs };
    const callbacks = { onOutput, onReasoning: execution?.onReasoning };

    const executeAttempt = (includeStreamOptions) => sendAndDecode({
      httpFetch,
      endpoint,
      body: buildChatBody({
        model: endpoint.model,
        system,
        prompt,
        messages: execution?.messages,
        maxTokens: execution?.maxTokens,
        effort,
        stream,
        includeStreamOptions,
      }),
      signal,
      timeoutCtx,
      callbacks,
    });

    const result = await executeWithStreamFallback(executeAttempt, stream);
    const usage = mapOpenAiUsage(result.usage);
    if (usage && report) report(usage, execution);
    if (!result.alreadyEmitted && onOutput) onOutput(result.text);
    return result.text;
  };
}
