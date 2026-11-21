import http from 'node:http';
import https from 'node:https';
import { Readable } from 'node:stream';
import { StringDecoder } from 'node:string_decoder';

const REASONING_MODEL_RE = /^(?:o[134](?:$|[-.])|gpt-5(?:$|[-.]))/i;
const VALID_EFFORTS = new Set(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);

export function isReasoningModel(model) {
  return REASONING_MODEL_RE.test(String(model || '').trim());
}

export function normalizeReasoningEffort(value) {
  const clean = String(value ?? '').trim().toLowerCase();
  return VALID_EFFORTS.has(clean) ? clean : '';
}

/**
 * Resolve `/chat/completions` URL from a base URL, preserving query strings (e.g. Azure `?api-version=...`).
 */
export function resolveChatCompletionsUrl(baseUrl) {
  const clean = String(baseUrl || '').trim();
  if (!clean) return '/chat/completions';
  try {
    const parsed = new URL(clean);
    const trimmedPath = parsed.pathname.replace(/\/+$/, '');
    parsed.pathname = /\/chat\/completions$/.test(trimmedPath) ? trimmedPath : `${trimmedPath}/chat/completions`;
    return parsed.toString();
  } catch {
    const fallback = clean.replace(/\/+$/, '');
    return /\/chat\/completions$/.test(fallback) ? fallback : `${fallback}/chat/completions`;
  }
}

/**
 * Node http/https streaming fetch without undici's 300s headersTimeout/bodyTimeout ceiling.
 * Returns a standard-shaped `{ ok, status, headers, body, text }` response.
 */
export function longStreamFetch(input, init = {}) {
  const { method = 'POST', headers = {}, body = '', signal } = init;
  return new Promise((resolveReq, rejectReq) => {
    let url;
    try {
      url = new URL(String(input));
    } catch (error) {
      rejectReq(new TypeError('Invalid URL', { cause: error }));
      return;
    }
    if (signal?.aborted) {
      rejectReq(signal.reason || new DOMException('Aborted', 'AbortError'));
      return;
    }
    const transport = url.protocol === 'https:' ? https : http;
    const payload = Buffer.isBuffer(body) ? body : Buffer.from(String(body ?? ''), 'utf8');
    let settled = false;
    let req;

    const cleanup = () => signal?.removeEventListener?.('abort', onAbort);
    const fail = (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      rejectReq(error);
    };
    const onAbort = () => {
      const reason = signal?.reason || new DOMException('Aborted', 'AbortError');
      req?.destroy(reason);
      fail(reason);
    };
    signal?.addEventListener?.('abort', onAbort, { once: true });

    req = transport.request(url, {
      method,
      headers: { ...headers, 'content-length': String(payload.length) },
    }, (res) => {
      if (settled) return;
      settled = true;
      const webBody = Readable.toWeb(res);
      res.once('close', cleanup);
      res.once('end', cleanup);
      const headerMap = {
        get: (name) => {
          const val = res.headers[String(name).toLowerCase()];
          return Array.isArray(val) ? val.join(', ') : val ?? null;
        },
      };
      resolveReq({
        status: res.statusCode ?? 0,
        ok: (res.statusCode ?? 0) >= 200 && (res.statusCode ?? 0) < 300,
        headers: headerMap,
        body: webBody,
        async text() {
          const chunks = [];
          for await (const chunk of webBody) chunks.push(Buffer.from(chunk));
          return Buffer.concat(chunks).toString('utf8');
        },
      });
    });
    req.on('error', fail);
    req.end(payload);
  });
}

function extractTextParts(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((part) => (typeof part === 'string' ? part : typeof part?.text === 'string' ? part.text : ''))
    .join('');
}

function extractDeltaReasoning(delta) {
  const raw = delta?.reasoning_content ?? delta?.reasoning ?? '';
  return typeof raw === 'string' ? raw : '';
}

function applyDeltaContent(delta, state, callbacks) {
  const reasoning = extractDeltaReasoning(delta);
  if (reasoning) {
    state.reasoningChars += reasoning.length;
    callbacks.onReasoning?.(reasoning.length);
  }
  const piece = extractTextParts(delta.content);
  if (piece) {
    state.parts.push(piece);
    callbacks.onOutput?.(piece);
  }
}

function applySseChunk(parsed, state, callbacks) {
  if (parsed?.usage && typeof parsed.usage === 'object') {
    state.usage = parsed.usage;
  }
  const choice = Array.isArray(parsed?.choices) ? parsed.choices[0] : null;
  if (!choice) return;
  if (typeof choice.finish_reason === 'string' && choice.finish_reason) {
    state.finishReason = choice.finish_reason;
  }
  const delta = choice.delta || choice.message;
  if (delta && typeof delta === 'object') {
    applyDeltaContent(delta, state, callbacks);
  }
}

function consumeSseLine(rawLine, state, callbacks) {
  const line = rawLine.trim();
  if (!line || line.startsWith(':') || !line.startsWith('data:')) return;
  const payload = line.slice(5).trim();
  if (!payload || payload === '[DONE]') return;
  let parsed;
  try {
    parsed = JSON.parse(payload);
  } catch {
    return;
  }
  applySseChunk(parsed, state, callbacks);
}

async function drainSseReader(reader, state, callbacks) {
  const decoder = new StringDecoder('utf8');
  let buffer = '';
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.write(Buffer.from(value));
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? '';
      for (const line of lines) consumeSseLine(line, state, callbacks);
    }
    buffer += decoder.end();
    if (buffer) consumeSseLine(buffer, state, callbacks);
  } finally {
    try { reader.releaseLock?.(); } catch { /* ignore */ }
  }
}

/**
 * Consume an SSE `text/event-stream` response body incrementally with safe UTF-8 decoding.
 */
export async function readOpenAiSseStream(response, callbacks = {}) {
  const state = { parts: [], usage: null, finishReason: '', reasoningChars: 0 };
  const reader = response.body?.getReader?.();
  if (!reader) {
    const raw = await response.text();
    for (const line of raw.split(/\r?\n/)) consumeSseLine(line, state, callbacks);
  } else {
    await drainSseReader(reader, state, callbacks);
  }
  return { text: state.parts.join(''), usage: state.usage, finishReason: state.finishReason };
}

/**
 * Extract completion text & finish reason from a non-streaming JSON chat completion payload.
 */
export function extractJsonCompletion(data) {
  const choice = Array.isArray(data?.choices) ? data.choices[0] : null;
  const finishReason = typeof choice?.finish_reason === 'string' ? choice.finish_reason : '';
  const text = extractTextParts(choice?.message?.content);
  const reasoning = typeof choice?.message?.reasoning_content === 'string' ? choice.message.reasoning_content : '';
  return { text, finishReason, reasoning };
}
