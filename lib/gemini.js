/* Google AI Studio (Gemini API) client for audio import, and the tier logic every audio request goes through.

   One request goes through up to four tiers: the Gemini free-tier key first, then SiliconFlow (transcription only,
   when its key is configured; see siliconflow.js), then Groq (if a Groq key is configured; see groq.js), then the
   Gemini paid key. The Gemini keys must belong to different Google Cloud projects, because a
   project that has billing enabled loses its free quota entirely. Free-tier
   content may be used by Google to improve its products (paid content is not),
   so callers can skip the free key per import.

   Nothing here logs or returns a key; the API key only travels in the
   x-goog-api-key header of requests to generativelanguage.googleapis.com. */

import { longFetch } from "./http.js";
import { gatewayAudioTransport } from './audio-gateway.js';
import { audioUsageFetch, usageTokens } from './audio-dashboard.js';
import { GROQ_TEXT_MODEL, GROQ_TRANSCRIBE_MODEL, chatText, groqChat, groqCheck, groqTranscriber } from "./groq.js";
import { SILICONFLOW_TRANSCRIBE_MODEL, siliconflowCheck, siliconflowTranscriber } from "./siliconflow.js";
import { providerResourcesFor } from './jobs/resources.js';

export const GEMINI_ORIGIN = "https://generativelanguage.googleapis.com";
export const TRANSCRIBE_MODEL = "gemini-3.5-transcribe";
export const TEXT_MODEL = "gemini-3.8-flash";
/** Live translation runs many small requests in real time: the fast, cheap model. */
export const LIVE_TRANSLATE_MODEL = "gemini-3.5-flash-lite";
/** Published paid price of the transcribe model: $0.003/min audio in + $0.002/min text out. */
export const TRANSCRIBE_USD_PER_MINUTE = 0.005;

/* Inline request bodies must stay under 20 MB including the base64 expansion (x4/3). */
const INLINE_LIMIT = 12 * 1024 * 1024;
const MAX_QUOTA_WAIT_MS = 65_000;
const TEXT_TIMEOUT_MS = 4 * 60_000;
const clamp = (value, low, high) => Math.min(high, Math.max(low, value));
/** How long to wait for a transcription: a floor plus time in proportion to the audio, so a long recording is not abandoned early. */
export const transcribeTimeoutMs = (seconds, bytes = 0) => {
  const length = seconds > 0 ? seconds : bytes / 8000; // no duration known: assume a slow 64 kbps stream
  return Math.round(clamp(180_000 + length * 600, 5 * 60_000, 30 * 60_000));
};
/** How long to wait for an upload: a floor plus the bytes at a slow 100 kB/s. */
export const uploadTimeoutMs = (bytes) => Math.round(clamp(60_000 + bytes / 100, 2 * 60_000, 40 * 60_000));
/** Google calls go through the long-deadline client; a replaced global fetch (a test or preview standing in for Google) wins. */
const NATIVE_FETCH = globalThis.fetch;
export function defaultFetch(url, init) { return globalThis.fetch !== NATIVE_FETCH ? globalThis.fetch(url, init) : longFetch(url, init); }
const TRANSIENT_RETRY_DELAYS_MS = [1500, 5000];
/** Free-tier daily quotas reset at midnight Pacific; block the free key for a while instead of hammering it. */
const FREE_BLOCK_MS = 6 * 60 * 60 * 1000;

export class GeminiError extends Error {
  constructor(message, { status, tier, fatal = false, keyProblem = false, quotaScope } = {}) {
    super(message);
    this.name = "GeminiError";
    if (status) this.status = status;
    if (tier) this.tier = tier;
    if (fatal) this.fatal = true;
    if (keyProblem) this.keyProblem = true;
    if (quotaScope) this.quotaScope = quotaScope;
  }
}

const sleepFor = (ms, signal) => new Promise((resolve, reject) => {
  if (signal?.aborted) return reject(signal.reason);
  const timer = setTimeout(() => { signal?.removeEventListener("abort", onAbort); resolve(); }, ms);
  const onAbort = () => { clearTimeout(timer); reject(signal.reason); };
  signal?.addEventListener("abort", onAbort, { once: true });
});

/** The retry hint Google puts in a 429 body ("31s" or "31.5s"), in milliseconds. */
function retryDelayMs(body) {
  const details = body?.error?.details;
  if (!Array.isArray(details)) return null;
  for (const item of details) {
    const match = /^(\d+(?:\.\d+)?)s$/.exec(String(item?.retryDelay ?? ""));
    if (match) return Math.ceil(Number(match[1]) * 1000);
  }
  return null;
}
/** A daily quota will not recover within this job; a per-minute one will. */
const quotaScopeOf = (body) => /PerDay|per day|daily/i.test(JSON.stringify(body?.error ?? "")) ? "day" : "minute";

/** The free providers besides Gemini's own free key: they hand a request on instead of failing it. */
const FREE_SERVICES = new Set(["groq", "siliconflow"]);
const PROVIDER = { groq: "Groq", siliconflow: "硅基流动" };
/** A Latin provider name gets spaces around it in Chinese text ("连不上 Groq 服务"), a Chinese one does not ("连不上硅基流动服务"). */
const inline = (name) => (/^[A-Za-z]/.test(name) ? ` ${name} ` : name);
/** Learner-facing reason for a rejected request, without echoing keys or payloads. */
export function describeFailure(status, body, tier) {
  // Google and Groq send { error: { message } }; SiliconFlow sends { message } (and sometimes error as a string).
  const raw = body?.error ?? (body?.message ? { message: body.message } : {});
  const error = typeof raw === "string" ? { message: raw } : raw || {};
  const message = String(error.message || "").slice(0, 300);
  const label = tier === "free" ? "免费密钥" : tier === "paid" ? "付费密钥" : tier === "groq" ? "Groq 密钥" : tier === "siliconflow" ? "硅基流动密钥" : "密钥";
  if (FREE_SERVICES.has(tier) && status === 0)
    return /TIMEOUT/i.test(String(error.code || "")) ? `${inline(PROVIDER[tier]).trimStart()}超过 ${Math.max(1, Math.round((error.timeoutMs || 120_000) / 60_000))} 分钟没有回应` : `连不上${inline(PROVIDER[tier])}服务：${message || "网络错误"}`;
  if (status === 0 && /TIMEOUT/i.test(String(error.code || ""))) {
    const minutes = error.timeoutMs ? Math.max(1, Math.round(error.timeoutMs / 60_000)) : 5;
    return `Google 超过 ${minutes} 分钟没有回应（等待时间已按这一段的长度和大小放宽，并自动重试过一次）。可以在「设置 › 音频转写 › 高级 › 专家选项」里把「每次请求最长」调小后重试；已经转写好的段落有缓存，不会重复转写`;
  }
  if (status === 0) return `连不上 Google 服务：${message || "网络错误"}。请检查网络；需要代理时，用 NODE_USE_ENV_PROXY=1 和 HTTPS_PROXY 启动 DSH`;
  if (status === 402) return "付费余额已用完，请在 AI Studio 的 Billing 页充值后重试";
  if (/location is not supported/i.test(message)) return "当前网络所在地区不支持 Gemini API；需要换到受支持地区的网络";
  if (status === 400 && /API key not valid|API_KEY_INVALID/i.test(`${message} ${JSON.stringify(error.details || "")}`))
    return `${label}无效，请重新复制 AI Studio 里的密钥`;
  if (status === 401 || status === 403) return `${label}被拒绝（${status}）：${message || "没有权限"}`;
  if (status === 404) return `模型不存在或此密钥不可用：${message}`;
  if (status === 429) return `${label}额度被限流（${quotaScopeOf(body) === "day" ? "每日额度用完" : "每分钟额度用完"}）`;
  return `${PROVIDER[tier] || "Gemini"} 请求失败（${status}${error.status ? ` ${error.status}` : ""}）：${message || "没有返回原因"}${fieldViolations(error)}`;
}
/** The fields a 400 names (Google's BadRequest details), so "invalid argument" says which one. */
function fieldViolations(error) {
  const list = (Array.isArray(error?.details) ? error.details : []).flatMap((item) => Array.isArray(item?.fieldViolations) ? item.fieldViolations : []);
  const text = list.slice(0, 3).map((item) => `${item.field}${item.description ? `：${item.description}` : ""}`).join("；");
  return text ? `（涉及字段 ${text.slice(0, 300)}）` : "";
}

/** Text of a generateContent reply, whether it comes as plain parts or as an audioTranscription. */
export function replyText(body) {
  const parts = body?.candidates?.[0]?.content?.parts;
  if (!Array.isArray(parts)) return "";
  const plain = parts.map((part) => (typeof part?.text === "string" ? part.text : "")).join("");
  if (plain.trim()) return plain;
  return parts.map((part) => {
    const transcription = part?.audioTranscription;
    if (typeof transcription?.text === "string") return transcription.text;
    return Array.isArray(transcription?.words) ? transcription.words.map((w) => w.word).join(" ") : "";
  }).join(" ");
}

const emptyUsage = () => ({ requests: 0, inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, audioSeconds: 0 });

/**
 * Runs requests through the Gemini free key first, then SiliconFlow (transcription only), then Groq, then the Gemini paid key.
 * `keys` is `{ free, siliconflow, groq, paid }`; any may be empty. `groq` / `siliconflow` say which models to use.
 */
export class GeminiTiers {
  constructor({ keys = {}, groq = {}, siliconflow = {}, fetch: doFetch = defaultFetch, now = Date.now, sleep = sleepFor, skipFree = false, ffmpeg, resources, gateway, usageSettings, meter } = {}) {
    // Skipping the free tier means keeping the recording away from free-plan providers altogether: SiliconFlow and Groq count as such.
    const key = (value, free) => (free && skipFree ? "" : String(value || "").trim());
    this.keys = { free: key(keys.free, true), siliconflow: key(keys.siliconflow, true), groq: key(keys.groq, true), paid: key(keys.paid, false) };
    this.resources = providerResourcesFor(resources);
    for (const tier of Object.keys(this.keys)) if (this.keys[tier]) this.resources?.assertRoute(tier);
    this.groqModels = { transcribe: groq.transcribeModel || GROQ_TRANSCRIBE_MODEL, text: groq.textModel || GROQ_TEXT_MODEL };
    this.siliconflowModel = siliconflow.transcribeModel || SILICONFLOW_TRANSCRIBE_MODEL;
    this.siliconflowFileLimit = siliconflow.fileLimit;
    this.groqBlockedUntil = 0;
    this.siliconflowBlockedUntil = 0;
    // ffmpeg cuts the formats Groq cannot take whole (undefined: look for one when needed; null: none); fileLimit is for tests.
    this.ffmpeg = ffmpeg;
    this.groqFileLimit = groq.fileLimit;
    this.fetch = doFetch;
    this.gatewayTransport = gateway ? gatewayAudioTransport(gateway, doFetch, usageSettings, meter) : null;
    this.now = now;
    this.sleep = sleep;
    this.freeBlockedUntil = 0;
    this.rejected = new Set();
    this.usage = { free: emptyUsage(), siliconflow: emptyUsage(), groq: emptyUsage(), paid: emptyUsage() };
    this.warnings = [];
  }
  /** One observable HTTP request, including its response body and transport cleanup.
   * Tier is explicit trusted adapter routing, never inferred from a credential/hash. */
  transport(tier, cleanup = false) {
    const fetch = this.gatewayTransport?.(tier, cleanup) || this.fetch;
    if (!this.resources) return fetch;
    this.resources.assertRoute(tier, cleanup);
    return (url, init = {}) => this.resources.run(tier, async signal => {
      const response = await fetch(url, { ...init, signal, awaitPhysicalClose: true });
      let body, parseError;
      try { body = await response.json(); } catch (error) { parseError = error; }
      if (response.status === 429) {
        const header = response.headers?.get?.('retry-after');
        const seconds = header != null && /^\d+(?:\.\d+)?$/.test(header.trim()) ? Number(header) * 1000 : NaN;
        const date = header != null && /[a-zA-Z]/.test(header) ? Date.parse(header) : NaN;
        const delay = Number.isFinite(seconds) ? seconds : Number.isFinite(date) ? Math.max(0, date - this.now()) : retryDelayMs(body);
        this.resources.cooldown(tier, Number.isFinite(delay) && delay >= 0 ? delay : 20_000);
      }
      return { status: response.status, ok: response.ok, headers: response.headers,
        json: async () => { if (parseError) throw parseError; return body; } };
    }, init.signal, cleanup);
  }
  get configured() { return !!(this.keys.free || this.keys.siliconflow || this.keys.groq || this.keys.paid); }
  warn(text) { if (!this.warnings.includes(text)) this.warnings.push(text); }
  /** Tiers still worth trying, in priority order. */
  order() {
    const tiers = [];
    if (this.keys.free && !this.rejected.has("free") && this.now() >= this.freeBlockedUntil) tiers.push("free");
    if (this.keys.siliconflow && !this.rejected.has("siliconflow") && this.now() >= this.siliconflowBlockedUntil) tiers.push("siliconflow");
    if (this.keys.groq && !this.rejected.has("groq") && this.now() >= this.groqBlockedUntil) tiers.push("groq");
    if (this.keys.paid && !this.rejected.has("paid")) tiers.push("paid");
    return tiers;
  }
  /** For a streaming connection, which does not go through request(): the tier to open next, or null. */
  pick() { return this.order()[0] ?? null; }
  /** A connection found this tier's key unusable; stop offering it. */
  reject(tier, message) { this.rejected.add(tier); if (message) this.warn(message); }
  /** A connection hit this tier's quota; the free tier is skipped for `ms`. */
  block(tier, ms, message) {
    if (tier === "free") this.freeBlockedUntil = this.now() + ms;
    if (tier === "groq") this.groqBlockedUntil = this.now() + ms;
    if (tier === "siliconflow") this.siliconflowBlockedUntil = this.now() + ms;
    if (message) this.warn(message);
  }
  /**
   * run(key, tier) performs one whole attempt (for example upload + generate)
   * and returns `{ status, body, retryAfterMs?, requests? }`; this method decides what to do
   * about the status. Resolves to `{ body, tier }` of the first success. Tiers go in order: the Gemini free key, Groq
   * (only when the caller passes `groq(key)`, the same request made there), the Gemini paid key. A free tier that
   * cannot serve the request hands it on; the last tier's failure is the request's.
   */
  async request(run, { signal, label = "Gemini", groq, siliconflow } = {}) {
    const attempts = { groq, siliconflow };
    const tiers = this.order().filter((tier) => !FREE_SERVICES.has(tier) || attempts[tier]);
    if (!tiers.length) {
      const usable = ["free", "paid", ...[...FREE_SERVICES].filter((tier) => attempts[tier])].some((tier) => this.keys[tier]);
      throw new GeminiError(usable ? "免费额度已用完，且没有可用的付费密钥。请在设置里添加付费密钥，或明天再试。"
        : this.keys.siliconflow ? "硅基流动只用于转写：校对和翻译需要对话模型，或在「设置 › 音频转写」里另配 Gemini / Groq 密钥。"
          : "还没有配置可用的密钥，请先在「设置 › 音频转写」里填写。", { fatal: true });
    }
    const nameOf = (tier) => (FREE_SERVICES.has(tier) ? ` ${PROVIDER[tier]}` : "付费密钥");
    let lastFailure = null;
    for (const [position, tier] of tiers.entries()) {
      const key = this.keys[tier], later = tiers.slice(position + 1), attempt = attempts[tier] || run;
      let quotaWaits = 0, transient = 0, timeouts = 0;
      for (;;) {
        signal?.throwIfAborted();
        let result;
        try { result = await attempt(key, tier); }
        catch (error) {
          if (error?.name === "AbortError" || signal?.aborted || error?.resourceAdmission) throw error;
          if (error instanceof GeminiError) throw error;
          const code = error?.cause?.code || error?.code;
          result = { status: 0, body: { error: { message: String(error?.cause?.message || error?.message || error), ...(code ? { code: String(code) } : {}), ...(error?.cause?.timeoutMs ? { timeoutMs: error.cause.timeoutMs } : {}) } } };
        }
        if (result.status >= 200 && result.status < 300) {
          const used = this.usage[tier], tokens = usageTokens(result.body);
          used.requests += result.requests ?? 1;
          for (const field of ["inputTokens", "outputTokens", "cachedInputTokens"]) used[field] += tokens[field];
          return { body: result.body, tier, reasoning: result.reasoning };
        }
        const { status, body } = result;
        lastFailure = new GeminiError(describeFailure(status, body, tier), { status, tier });
        if (status === 402) throw new GeminiError(lastFailure.message, { status, tier, fatal: true });
        if (status === 429) {
          const scope = quotaScopeOf(body), wait = result.retryAfterMs ?? retryDelayMs(body);
          lastFailure.quotaScope = scope;
          if (scope === "minute" && quotaWaits < 2 && (wait ?? 20_000) <= MAX_QUOTA_WAIT_MS) {
            quotaWaits++;
            await this.sleep(wait ?? 20_000, signal);
            continue;
          }
          if (tier === "free") {
            this.freeBlockedUntil = this.now() + (scope === "day" ? FREE_BLOCK_MS : 60_000);
            if (later.length) this.warn(scope === "day" ? `免费额度今日用完，其余请求改用${nameOf(later[0])}` : `免费额度被限流，部分请求改用${nameOf(later[0])}`);
          } else if (FREE_SERVICES.has(tier)) {
            this.block(tier, clamp(wait ?? (scope === "day" ? FREE_BLOCK_MS : 60_000), 60_000, FREE_BLOCK_MS));
            if (later.length) this.warn(`${PROVIDER[tier]} 额度被限流，这一步改用${nameOf(later[0])}`);
          }
          break;
        }
        // A free service could not do this one (a file over its limit, a model it does not have, a parameter it rejects): the next tier may.
        if (FREE_SERVICES.has(tier) && status !== 401 && status !== 403 && status !== 0 && status < 500 && status !== 408) {
          if (later.length) { this.warn(`${PROVIDER[tier]} 没能完成这一步（${lastFailure.message}），改用${nameOf(later[0])}`); break; }
          throw lastFailure;
        }
        if (status === 400 || status === 401 || status === 403) {
          // A rejected key (or region) will not fix itself on retry; a rejected parameter is the caller's to handle.
          const keyProblem = status !== 400 || /API key|API_KEY|location/i.test(JSON.stringify(body?.error || ""));
          if (keyProblem) {
            this.rejected.add(tier);
            if (later.length) { this.warn(`${lastFailure.message}；改用${nameOf(later[0])}`); break; }
          }
          throw new GeminiError(lastFailure.message, { status, tier, fatal: keyProblem, keyProblem });
        }
        // A request that timed out may still have run on Google's side, so it is tried once more and no oftener: each try can spend quota.
        // A free tier costs nothing, so when Groq is next (or Groq itself gave up) the request moves on instead of stopping.
        const cheapNext = later.length && (FREE_SERVICES.has(tier) || FREE_SERVICES.has(later[0]));
        if (status === 0 && /TIMEOUT/i.test(String(body?.error?.code || ""))) {
          if (timeouts++ < 1) continue;
          if (cheapNext) { this.warn(`${lastFailure.message}；改用${nameOf(later[0])}`); break; }
          throw new GeminiError(lastFailure.message, { status, tier, fatal: true });
        }
        if (status === 0 || status >= 500 || status === 408) {
          if (transient < TRANSIENT_RETRY_DELAYS_MS.length) {
            await this.sleep(TRANSIENT_RETRY_DELAYS_MS[transient++], signal);
            continue;
          }
          if (cheapNext) { this.warn(`${lastFailure.message}；改用${nameOf(later[0])}`); break; }
          throw new GeminiError(`${label} 暂时不可用：${lastFailure.message}`, { status, tier });
        }
        throw lastFailure;
      }
    }
    throw lastFailure || new GeminiError("Gemini 请求失败");
  }
  async json(url, key, body, signal, timeoutMs = TEXT_TIMEOUT_MS, audioUsage, tier) {
    const response = await this.transport(tier)(url, {
      method: "POST", signal, timeoutMs, audioUsage,
      headers: { "content-type": "application/json", "x-goog-api-key": key },
      body: JSON.stringify(body),
    });
    return { status: response.status, body: await response.json().catch(() => ({})) };
  }
  /** generateContent with a JSON body; resolves to `{ text, tier, reasoning }`. */
  async generate(model, body, { signal, label, groq, audioUsage } = {}) {
    if (!/^[\w.-]+$/.test(model)) throw new GeminiError("模型名称只能包含字母、数字、点和连字符", { fatal: true });
    const { body: reply, tier, reasoning } = await this.request(
      (key, tier) => this.json(`${GEMINI_ORIGIN}/v1beta/models/${model}:generateContent`, key, body, signal, TEXT_TIMEOUT_MS, audioUsage, tier), { signal, label, groq });
    const actualReasoning = tier === 'groq' ? reasoning || 'default' : audioUsage?.reasoning || 'default';
    this.lastReasoning = actualReasoning;
    const text = tier === "groq" ? chatText(reply) : replyText(reply);
    if (!text.trim()) {
      const reason = reply?.candidates?.[0]?.finishReason || reply?.promptFeedback?.blockReason;
      throw new GeminiError(`${tier === "groq" ? "Groq" : "Gemini"} 没有返回文字${reason ? `（${reason}）` : ""}`, { tier });
    }
    return { text, tier, reasoning: actualReasoning };
  }
  /** One text prompt (system + user) answered as text; used for proofreading and translation. */
  async complete(model, system, prompt, { signal, label, thinkingLevel, maxOutputTokens, stage, onReasoning } = {}) {
    const deliver = result => { onReasoning?.(result.reasoning); return result.text; };
    const generationConfig = { responseMimeType: "application/json",
      ...(maxOutputTokens ? { maxOutputTokens } : {}),
      ...(['low', 'medium', 'high'].includes(thinkingLevel) && /^gemini-3[.-]/.test(model) ? { thinkingConfig: { thinkingLevel } }
        : ['low', 'medium', 'high'].includes(thinkingLevel) && /^gemini-2\.5[.-]/.test(model) ? { thinkingConfig: { thinkingBudget: ({ low: 1024, medium: 8192, high: 24576 })[thinkingLevel] } } : {}) };
    const body = {
      systemInstruction: { parts: [{ text: system }] },
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      generationConfig,
    };
    // The same request on Groq, when a Groq key is configured (see request() for when it is used).
    const groq = this.keys.groq ? (key) => groqChat({ fetch: this.transport('groq'), key, model: this.groqModels.text, system, prompt, signal, reasoningEffort: thinkingLevel, stage }) : undefined;
    const audioUsage = { stage, reasoning: generationConfig.thinkingConfig ? thinkingLevel : 'default' };
    try { return deliver(await this.generate(model, body, { signal, label, groq, audioUsage })); }
    catch (error) {
      if (error.status !== 400 || error.keyProblem) throw error;
      // Google says only "invalid argument": ask again without the optional settings, then in the plainest form.
      // The reply is parsed as JSON whether or not JSON mode was requested.
      if (generationConfig.thinkingConfig) {
        delete generationConfig.thinkingConfig;
        audioUsage.reasoning = 'default';
        this.warn('此 Gemini 模型未接受推理强度，已使用模型默认设置');
        try { return deliver(await this.generate(model, body, { signal, label, groq, audioUsage })); }
        catch (again) { if (again.status !== 400 || again.keyProblem) throw again; }
      }
      return deliver(await this.generate(model, { systemInstruction: body.systemInstruction, contents: body.contents }, { signal, label, groq, audioUsage }));
    }
  }
  /**
   * Transcribe one audio chunk. Small chunks go inline; larger ones use the
   * Files API, uploaded once per key (an uploaded file only works for the
   * project that uploaded it) and deleted afterwards.
   *
   * The transcribe model is new and strict, and Google answers a parameter it
   * dislikes with a bare 400. So a rejected request is retried in a fixed order
   * of plainer forms: the other way of sending the audio, then without the
   * vocabulary, without the transcript style, without the language, and last
   * with no transcription options at all. The form that worked is remembered
   * for the next chunk, and what had to be dropped is reported.
   */
  async transcribe({ bytes, mimeType, kind, seconds = 0, model = TRANSCRIBE_MODEL, config = {}, signal }) {
    const uploaded = new Map();
    const canInline = bytes.length <= INLINE_LIMIT;
    const wanted = { languageCodes: config.languageCodes?.length ? config.languageCodes : null,
      vocabulary: config.vocabulary?.length ? config.vocabulary : null, mode: config.mode || null };
    // The same chunk on Groq (cut into pieces there), for when the free Gemini key cannot take it.
    const groqRun = this.keys.groq && kind
      ? groqTranscriber({ fetch: this.transport('groq'), model: this.groqModels.transcribe, bytes, kind, seconds, config: { languageCodes: wanted.languageCodes, vocabulary: wanted.vocabulary || [] }, signal, limit: this.groqFileLimit, ffmpeg: this.ffmpeg })
      : undefined;
    // And on SiliconFlow (no vocabulary or style options there: it only takes the audio).
    const siliconflowRun = this.keys.siliconflow && kind
      ? siliconflowTranscriber({ fetch: this.transport('siliconflow'), model: this.siliconflowModel, bytes, kind, seconds, signal, limit: this.siliconflowFileLimit, ffmpeg: this.ffmpeg })
      : undefined;
    const levels = [];
    for (const level of [wanted, { ...wanted, vocabulary: null }, { ...wanted, vocabulary: null, mode: null },
      { languageCodes: null, vocabulary: null, mode: null }, { omit: true }])
      if (!levels.some((known) => JSON.stringify(known) === JSON.stringify(level))) levels.push(level);
    const bodyFor = (part, level) => ({ contents: [{ parts: [part] }],
      ...(level.omit ? {} : { generationConfig: { audioTranscriptionConfig: {
        ...(level.languageCodes ? { languageCodes: level.languageCodes } : {}),
        ...(level.vocabulary ? { customVocabulary: level.vocabulary } : {}),
        ...(level.mode ? { mode: level.mode } : {}),
      } } }) });
    let uploadFailed = false;
    const send = (delivery, level) => this.request(async (key, tier) => {
      let part;
      if (delivery === "inline") part = { inlineData: { mimeType, data: bytes.toString("base64") } };
      else {
        if (!uploaded.has(key)) {
          const result = await this.upload(key, bytes, mimeType, signal, tier);
          if (result.failure) { uploadFailed = true; return result.failure; }
          uploaded.set(key, { ...result.file, resourceTier: tier });
        }
        part = { fileData: { fileUri: uploaded.get(key).uri, mimeType } };
      }
      return this.json(`${GEMINI_ORIGIN}/v1beta/models/${model}:generateContent`, key, bodyFor(part, level), signal, transcribeTimeoutMs(seconds, bytes.length), { stage: 'transcribe', seconds }, tier);
    }, { signal, label: "转写", groq: groqRun, siliconflow: siliconflowRun });

    // Most likely form first (as configured), then the documented file form, then ever plainer ones.
    const order = [];
    if (canInline) order.push({ delivery: "inline", at: 0 });
    order.push({ delivery: "file", at: 0 });
    for (let at = 1; at < levels.length; at++) order.push({ delivery: "file", at });
    if (canInline) order.push({ delivery: "inline", at: levels.length - 1 });
    const known = this.transcribeForm;
    if (known) {
      const index = order.findIndex((form) => form.delivery === known.delivery && form.at === known.at);
      if (index > 0) order.unshift(...order.splice(index, 1));
    }
    const primary = canInline ? "inline" : "file";
    let reply, failures = [];
    try {
      for (const form of order) {
        if (form.delivery === "file" && uploadFailed) continue;
        try { reply = await send(form.delivery, levels[form.at]); if (!FREE_SERVICES.has(reply.tier)) this.transcribeForm = form; reply.form = form; break; }
        catch (error) {
          // Only a rejected parameter is worth another form; a bad key, no money or a dead network is not.
          if (!(error?.status === 400 && !error.keyProblem)) throw error;
          failures.push(error);
        }
      }
      if (!reply) {
        const first = failures[0].message, last = failures.at(-1).message;
        throw new GeminiError(`转写请求被 Google 拒绝，已按顺序试了 ${failures.length} 种发送方式都不行。最初的原因：${first}${last === first ? "" : `；最简请求的原因：${last}`}`,
          { status: 400, fatal: true });
      }
      if (reply.tier === "groq") {
        this.warn("这一段由 Groq 的 Whisper 转写：它没有整理风格，术语词表只作为提示，所以更依赖后面的校对");
        const groqText = String(reply.body?.text ?? "");
        if (!groqText.trim()) throw new GeminiError("这一段音频没有转写出文字（可能是静音）", { tier: "groq" });
        this.usage.groq.audioSeconds += seconds;
        return { text: groqText, tier: "groq" };
      }
      if (reply.tier === "siliconflow") {
        this.warn("这一段由硅基流动 SenseVoice 转写：它不整理口语，也不接受术语表，所以更依赖后面的校对");
        const text = String(reply.body?.text ?? "").trim();
        if (!text) throw new GeminiError("这一段音频没有转写出文字（可能是静音）", { tier: "siliconflow" });
        this.usage.siliconflow.audioSeconds += seconds;
        return { text, tier: "siliconflow" };
      }
      const level = levels[reply.form.at], dropped = [];
      if (wanted.vocabulary && !level.vocabulary) dropped.push("自定义词表");
      if (wanted.mode && !level.mode) dropped.push("转写风格设置");
      if (wanted.languageCodes && !level.languageCodes) dropped.push("语言设置");
      if (dropped.length) this.warn(`转写接口拒绝了${dropped.join("、")}，已自动去掉后转写成功；术语更依赖后面的校对`);
      if (reply.form.delivery !== primary) this.warn(reply.form.delivery === "file" ? "接口不接受直接发送音频，已改为先上传再引用" : "音频上传方式被拒绝，已改为直接发送");
      const text = replyText(reply.body);
      if (!text.trim()) throw new GeminiError("这一段音频没有转写出文字（可能是静音或格式不受支持）", { tier: reply.tier });
      this.usage[reply.tier].audioSeconds += seconds;
      return { text, tier: reply.tier };
    } finally {
      await groqRun?.cleanup?.().catch(() => {});
      await siliconflowRun?.cleanup?.().catch(() => {});
      await Promise.allSettled([...uploaded].map(([key, file]) => this.transport(file.resourceTier, true)(`${GEMINI_ORIGIN}/v1beta/${file.name}`,
        { method: "DELETE", timeoutMs: 30_000, headers: { "x-goog-api-key": key } })));
    }
  }
  /** Resumable Files API upload. Resolves to `{ file }`, or `{ failure }` holding a failed `{ status, body }`. */
  async upload(key, bytes, mimeType, signal, tier) {
    const fetch = this.transport(tier);
    const start = await fetch(`${GEMINI_ORIGIN}/upload/v1beta/files`, {
      method: "POST", signal, timeoutMs: 60_000,
      headers: {
        "x-goog-api-key": key, "content-type": "application/json",
        "x-goog-upload-protocol": "resumable", "x-goog-upload-command": "start",
        "x-goog-upload-header-content-length": String(bytes.length),
        "x-goog-upload-header-content-type": mimeType,
      },
      body: JSON.stringify({ file: { display_name: "study-audio" } }),
    });
    if (!start.ok) return { failure: { status: start.status, body: await start.json().catch(() => ({})) } };
    const target = start.headers.get("x-goog-upload-url");
    if (!target || !target.startsWith(`${GEMINI_ORIGIN}/`)) throw new GeminiError("上传地址无效，已中止（不会向其他主机发送音频）");
    const done = await fetch(target, {
      method: "POST", signal, timeoutMs: uploadTimeoutMs(bytes.length),
      headers: { "content-length": String(bytes.length), "x-goog-upload-offset": "0", "x-goog-upload-command": "upload, finalize" },
      body: bytes,
    });
    const payload = await done.json().catch(() => ({}));
    if (!done.ok) return { failure: { status: done.status, body: payload } };
    let file = payload.file;
    if (!file?.uri || !file?.name) throw new GeminiError("上传后没有拿到文件地址");
    for (let waited = 0; file.state === "PROCESSING" && waited < 60; waited++) {
      await this.sleep(1000, signal);
      const poll = await fetch(`${GEMINI_ORIGIN}/v1beta/${file.name}`, { signal, timeoutMs: 30_000, headers: { "x-goog-api-key": key } });
      file = await poll.json().catch(() => file);
    }
    if (file.state === "FAILED") throw new GeminiError("Gemini 无法处理这段音频文件");
    return { file };
  }
  /** Cheapest call that proves a key works and reaches the API. */
  async check(key, tier) {
    if (FREE_SERVICES.has(tier)) {
      const { status, body } = await (tier === "groq" ? groqCheck : siliconflowCheck)(this.transport(tier), key);
      return status >= 200 && status < 300 ? { ok: true } : { ok: false, message: describeFailure(status, body, tier) };
    }
    const response = await this.transport(tier)(`${GEMINI_ORIGIN}/v1beta/models?pageSize=1`, { timeoutMs: 30_000, headers: { "x-goog-api-key": key } });
    const body = await response.json().catch(() => ({}));
    return response.ok ? { ok: true } : { ok: false, message: describeFailure(response.status, body, tier) };
  }
  /** What this run used, for the job record and the learner. */
  summary() {
    const paidMinutes = this.usage.paid.audioSeconds / 60;
    return {
      free: { ...this.usage.free }, siliconflow: { ...this.usage.siliconflow }, groq: { ...this.usage.groq }, paid: { ...this.usage.paid },
      estimatedPaidTranscribeUsd: Math.round(paidMinutes * TRANSCRIBE_USD_PER_MINUTE * 1000) / 1000,
    };
  }
}

/** The audio pipeline's tiers from the effective settings: Gemini free key, SiliconFlow, Groq, Gemini paid key. */
export function tiersFromSettings(settings, { fetch, skipFree = false, resources, gateway } = {}) {
  const meter = gateway ? { recorded: 0, unrecorded: 0 } : audioUsageFetch(settings, fetch);
  const tiers = new GeminiTiers({
    keys: { free: settings.freeKey, siliconflow: settings.siliconflowKey, groq: settings.groqKey, paid: settings.paidKey },
    groq: { transcribeModel: settings.groqTranscribeModel, textModel: settings.groqTextModel },
    siliconflow: { transcribeModel: settings.siliconflowTranscribeModel },
    fetch: gateway ? fetch : meter, skipFree, resources, gateway, usageSettings: gateway ? settings : undefined, meter,
  });
  tiers.meter = meter; // what this run recorded in the usage ledger, for the job's self-check
  return tiers;
}
