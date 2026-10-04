import { appendFile, mkdir, readdir, rm } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';
import { longFetch } from './http.js';
import { AUDIO_PROVIDERS } from './audio-providers.js';

const ledgerDir = () => join(process.env.DSH_HOME?.trim() || join(homedir(), '.dsh'), 'study', 'audio-usage');
const RETAIN_DAYS = 31;
let cleaned = '';
export const keyId = key => key ? createHash('sha256').update(key).digest('hex').slice(0, 24) : '';
let writing = Promise.resolve();
export function recordAudioUsage(event) {
  const directory = ledgerDir(), date = new Date(event.at).toISOString().slice(0, 10), path = join(directory, `${date}.jsonl`);
  const next = writing.catch(() => {}).then(async () => {
    await mkdir(directory, { recursive: true });
    if (cleaned !== `${directory}:${date}`) {
      const cutoff = new Date(Date.now() - RETAIN_DAYS * 86400000).toISOString().slice(0, 10);
      for (const name of await readdir(directory)) if (/^\d{4}-\d{2}-\d{2}\.jsonl$/.test(name) && name.slice(0, 10) < cutoff) await rm(join(directory, name), { force: true });
      cleaned = `${directory}:${date}`;
    }
    await appendFile(path, JSON.stringify(event) + '\n', { mode: 0o600 });
  });
  writing = next;
  return next;
}
const number = value => value !== null && value !== undefined && value !== '' && Number.isFinite(Number(value)) && Number(value) >= 0 ? Number(value) : null;
/** Billed tokens of a Gemini or OpenAI-style reply. Transcription replies may omit
 * candidatesTokenCount, so output falls back to total minus prompt; thinking is billed as output. */
export function usageTokens(body) {
  const meta = body?.usageMetadata, chat = body?.usage;
  const inputTokens = number(meta?.promptTokenCount ?? chat?.prompt_tokens) || 0;
  let outputTokens = number(meta?.candidatesTokenCount ?? chat?.completion_tokens);
  if (outputTokens !== null) outputTokens += number(meta?.thoughtsTokenCount) || 0;
  else if (number(meta?.totalTokenCount) !== null)
    outputTokens = Math.max(0, meta.totalTokenCount - inputTokens - (number(meta.toolUsePromptTokenCount) || 0));
  return { inputTokens, outputTokens: outputTokens || 0, cachedInputTokens: number(meta?.cachedContentTokenCount) || 0 };
}
/** A successful token-billed call whose output was not reported (older ledger lines, or a reply without totals). */
const missingOutput = event => event.status >= 200 && event.status < 300 && Number(event.inputTokens) > 0 && !(Number(event.outputTokens) > 0) ? 1 : 0;
export function resetDelay(value) {
  if (!value) return null;
  let ms = 0;
  for (const match of String(value).matchAll(/(\d+(?:\.\d+)?)(ms|s|m|h)/g)) ms += Number(match[1]) * ({ ms: 1, s: 1000, m: 60000, h: 3600000 })[match[2]];
  return ms || null;
}
export function rateHeaders(headers, at) {
  const read = field => number(headers?.get?.(`x-ratelimit-${field}`));
  const limit = read('limit-requests'), remaining = read('remaining-requests');
  if (limit === null || remaining === null) return null;
  const delay = resetDelay(headers?.get?.('x-ratelimit-reset-requests'));
  return { limit, remaining, at, expiresAt: delay ? at + delay : at + 60000 };
}

/** Observe actual model HTTP attempts, including retries. Never retain request bodies or keys. */
export function audioUsageFetch(settings, fetch = longFetch) {
  return async (input, init = {}) => {
    const url = new URL(String(input));
    const gemini = url.hostname === 'generativelanguage.googleapis.com' && /:generateContent$/.test(url.pathname);
    const groq = url.hostname === 'api.groq.com' && /\/(audio\/transcriptions|chat\/completions)$/.test(url.pathname);
    const siliconflow = url.hostname === 'api.siliconflow.cn' && /\/audio\/transcriptions$/.test(url.pathname);
    if (!gemini && !groq && !siliconflow) return fetch(input, init);
    const key = gemini ? init.headers?.['x-goog-api-key'] : String(init.headers?.authorization || '').replace(/^Bearer /, '');
    const tier = groq ? 'groq' : siliconflow ? 'siliconflow' : key === settings.freeKey ? 'free' : key === settings.paidKey ? 'paid' : null;
    if (!tier || !key) return fetch(input, init);
    // Audio bodies can be tens of megabytes: metadata comes from the caller, never parse/copy the body here.
    const model = gemini ? decodeURIComponent(url.pathname.match(/models\/([^:]+)/)?.[1] || '') : init.audioUsage?.model || 'unknown';
    const at = Date.now(), event = { type: 'request', at, tier, keyId: keyId(key), model,
      stage: init.audioUsage?.stage || (/transcriptions/.test(url.pathname) ? 'transcribe' : 'text'),
      reasoning: init.audioUsage?.reasoning || 'default' };
    let response;
    try { response = await fetch(input, init); }
    catch (error) {
      await recordAudioUsage({ ...event, status: 0, elapsedMs: Date.now() - at }).catch(() => {});
      throw error;
    }
    // Read once and share the parsed body with the pipeline; failures are still recorded.
    let body = null;
    try { body = await response.json(); } catch { /* an error may contain no JSON */ }
    const { inputTokens, outputTokens } = usageTokens(body);
    await recordAudioUsage({ ...event, status: response.status, elapsedMs: Date.now() - at, inputTokens, outputTokens,
      audioSeconds: response.status >= 200 && response.status < 300 ? Number(init.audioUsage?.seconds) || 0 : 0,
      quota: groq || siliconflow ? rateHeaders(response.headers, at) : null,
    }).catch(() => {});
    return { status: response.status, ok: response.ok, headers: response.headers, json: async () => {
      if (body === null) throw new Error('Response was not JSON');
      return body;
    } };
  };
}
const day = (at, timezone) => new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(at);
const empty = () => ({ requests: 0, success: 0, failures: 0, limited: 0, inputTokens: 0, outputTokens: 0, outputUnknown: 0, audioSeconds: 0 });
/** Whether an attempt counts against the provider's daily request quota. A rate-limited reply (429) was refused, and an attempt that
 *  never reached the provider (status 0) was not served, so neither uses up a request; both are still listed as failures. */
const usesQuota = event => event.status !== 429 && event.status !== 0;
function count(target, event) {
  const requests = event.requests || 1;
  target.requests += requests;
  if (event.status >= 200 && event.status < 300) target.success += requests; else target.failures += requests;
  if (event.status === 429) target.limited += requests;
  for (const field of ['inputTokens', 'outputTokens', 'audioSeconds']) target[field] += Number(event[field]) || 0;
  target.outputUnknown += event.outputUnknown ?? missingOutput(event);
}
export function summarizeAudioUsage(events, settings, now = Date.now()) {
  const timezone = 'America/Los_Angeles', today = day(now, timezone);
  // Appended, not in request order: earlier readers index the first three. The panel sorts them for display.
  const tiers = ['free', 'groq', 'paid', 'siliconflow'];
  const keys = Object.fromEntries(tiers.map(tier => [tier, keyId(settings[`${tier}Key`])]));
  const active = events.filter(event => event.type === 'request' && keys[event.tier] && keys[event.tier] === event.keyId && event.at <= now);
  const window = active.filter(event => event.at >= now - 7 * 86400000);
  const trend = Array.from({ length: 7 }, (_, i) => ({ date: day(now - (6 - i) * 86400000, timezone), ...Object.fromEntries(tiers.map(t => [t, 0])) }));
  for (const event of window) { const bucket = trend.find(item => item.date === day(event.at, timezone)); if (bucket) bucket[event.tier] += event.requests || 1; }
  const providers = tiers.map(tier => {
    const all = active.filter(event => event.tier === tier), recent = all.filter(event => day(event.at, timezone) === today);
    const total = empty(), current = empty();
    all.forEach(event => count(total, event)); recent.forEach(event => count(current, event));
    const configuredModels = tier === 'siliconflow' ? [settings.siliconflowTranscribeModel]
      : tier === 'groq' ? [settings.groqTranscribeModel, settings.groqTextModel] : [settings.transcribeModel, settings.textModel];
    const models = [...new Set([...configuredModels, ...recent.map(event => event.model)].filter(Boolean))].map(model => {
      const used = recent.filter(event => event.model === model && usesQuota(event)).reduce((n, event) => n + (event.requests || 1), 0);
      const latest = all.filter(event => event.model === model && event.quota).reduce((latest, event) => !latest || latest.quota.at < event.quota.at ? event : latest, null);
      const quota = latest?.quota;
      const fresh = quota && quota.expiresAt > now;
      const configured = tier === 'free' ? settings.dailyLimits?.[model] : null;
      return { model, used, limit: fresh ? quota.limit : configured || null,
        remaining: fresh ? quota.remaining : configured ? Math.max(0, configured - used) : null,
        source: fresh ? 'provider' : configured ? 'local-estimate' : 'unknown',
        lastQuota: quota || null };
    });
    return { tier, configured: !!keys[tier], today: current, total, models };
  });
  const stages = events.filter(event => event.type === 'stage' && event.at >= now - 7 * 86400000 && event.at <= now);
  const timings = ['proofread', 'translate'].map(stage => {
    const values = stages.filter(event => event.stage === stage && event.success);
    const average = samples => {
      const count = samples.reduce((n, event) => n + (event.count || 1), 0);
      return { count, averageMs: count ? Math.round(samples.reduce((n, event) => n + event.elapsedMs, 0) / count) : null };
    };
    const byReasoning = Object.fromEntries(['default', 'low', 'medium', 'high'].map(level => {
      const samples = values.filter(event => event.reasoning === level);
      return [level, average(samples)];
    }));
    return { stage, ...average(values), byReasoning };
  });
  return { updatedAt: now, since: active.length ? active.reduce((n, event) => Math.min(n, event.at), now) : null, timezone, today, providers, trend, timings };
}
export async function audioDashboard(settings) {
  await writing.catch(() => {});
  const directory = ledgerDir(), now = Date.now(), cutoff = new Date(now - RETAIN_DAYS * 86400000).toISOString().slice(0, 10);
  let files = [];
  try { files = await readdir(directory); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const keys = new Set(AUDIO_PROVIDERS.map(provider => keyId(settings[provider.keyField])).filter(Boolean));
  const buckets = new Map();
  const accept = line => {
    if (line.length > 4096) return;
    let event; try { event = JSON.parse(line); } catch { return; }
    if (event.at > now || event.at < now - RETAIN_DAYS * 86400000) return;
    const date = day(event.at, 'America/Los_Angeles');
    let key;
    if (event.type === 'request' && keys.has(event.keyId)) key = `${date}:${event.tier}:${event.keyId}:${event.model}:${event.status}`;
    else if (event.type === 'stage' && event.at >= now - 7 * 86400000) key = `${date}:${event.stage}:${event.reasoning}:${event.success}`;
    else return;
    const previous = buckets.get(key);
    if (!previous) { buckets.set(key, { ...event, requests: event.type === 'request' ? 1 : undefined, count: event.type === 'stage' ? 1 : undefined,
      outputUnknown: event.type === 'request' ? missingOutput(event) : undefined }); return; }
    if (event.type === 'request') {
      previous.requests++;
      previous.outputUnknown += missingOutput(event);
      for (const field of ['inputTokens', 'outputTokens', 'audioSeconds']) previous[field] = (previous[field] || 0) + (event[field] || 0);
      if (event.quota && (!previous.quota || previous.quota.at < event.quota.at)) previous.quota = event.quota;
    } else { previous.count++; previous.elapsedMs += event.elapsedMs; }
    previous.at = Math.min(previous.at, event.at);
  };
  // Stream and collapse into daily model counters, rather than retaining every request.
  for (const name of files.filter(name => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(name) && name.slice(0, 10) >= cutoff).sort()) {
    let pending = '', oversized = false;
    for await (const chunk of createReadStream(join(directory, name), { encoding: 'utf8', highWaterMark: 16384 })) {
      for (const [index, part] of chunk.split('\n').entries()) {
        if (index > 0) { if (!oversized) accept(pending); pending = ''; oversized = false; }
        if (!oversized) { pending += part; if (pending.length > 4096) { pending = ''; oversized = true; } }
      }
    }
    // Ignore incomplete final lines: another process may still be appending them.
  }
  return summarizeAudioUsage([...buckets.values()], settings, now);
}

export const audioReasoning = (settings, kind) => kind === 'proofread' ? settings.proofreadReasoning || 'default' : kind === 'translate' ? settings.translateReasoning || 'low' : 'low';
