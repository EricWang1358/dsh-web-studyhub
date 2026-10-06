import { appendFile, mkdir, readdir, rm, stat } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';
import { longFetch } from './http.js';

const ledgerDir = () => join(process.env.DSH_HOME?.trim() || join(homedir(), '.dsh'), 'study', 'audio-usage');
const RETAIN_DAYS = 31;
let cleaned = '';
export const keyId = key => key ? createHash('sha256').update(key).digest('hex').slice(0, 24) : '';
let writing = Promise.resolve();
const callIdentities = new Map(); // Retained ledger identity cache, not a second ledger.

const health = { written: 0, failed: 0, lastError: '' };
/** How many ledger lines this process wrote or failed to write: a failure never stops an import, but it is not silent either. */
export const ledgerHealth = () => ({ ...health });
/** Wait for every ledger write queued so far (the console itself never waits: it reads what is on disk). */
export const flushAudioUsage = () => writing.catch(() => {});
const validCallId = value => typeof value === 'string' && /^[\w:.-]{1,128}$/.test(value);
async function retainedIdentities(path, info) {
  let identities = callIdentities.get(path);
  if (!identities || identities.size !== info?.size || identities.mtime !== info?.mtimeMs) {
    identities = { ids: new Set(), size: info?.size, mtime: info?.mtimeMs };
    if (info) {
      const length = await scan(path, 0, line => {
        let value;
        try { value = JSON.parse(line); } catch { throw Object.assign(new Error('Invalid usage ledger row'), { code: 'ledger-invalid' }); }
        if (!value || typeof value !== 'object' || Array.isArray(value) || (Object.hasOwn(value, 'callId') && !validCallId(value.callId)))
          throw Object.assign(new Error('Invalid stable Call metadata'), { code: 'ledger-invalid' });
        if (value.callId) identities.ids.add(value.callId);
      }, true);
      if (length !== info.size) throw Object.assign(new Error('Incomplete usage ledger tail'), { code: 'ledger-tail-incomplete' });
    }
    callIdentities.set(path, identities);
  }
  return identities;
}
/** Recovery preflight shares the existing writer queue and never repairs data. */
export function validateAudioUsageLedger() {
  const directory = ledgerDir();
  const pending = writing.catch(() => {}).then(async () => {
    let names;
    try { names = await readdir(directory); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
    const cutoff = new Date(Date.now() - RETAIN_DAYS * 86400000).toISOString().slice(0, 10);
    for (const name of names) if (/^\d{4}-\d{2}-\d{2}\.jsonl$/.test(name) && name.slice(0, 10) >= cutoff) {
      const path = join(directory, name); await retainedIdentities(path, await stat(path));
    }
  });
  writing = pending; return pending;
}
export function recordAudioUsage(event) {
  if (event.callId !== undefined && !validCallId(event.callId)) return Promise.reject(Object.assign(new Error('Invalid stable Call identity'), { code: 'ledger-invalid' }));
  const directory = ledgerDir(), date = new Date(event.at).toISOString().slice(0, 10), path = join(directory, `${date}.jsonl`);
  const next = writing.catch(() => {}).then(async () => {
    try {
      await mkdir(directory, { recursive: true });
      if (cleaned !== `${directory}:${date}`) {
        const cutoff = new Date(Date.now() - RETAIN_DAYS * 86400000).toISOString().slice(0, 10);
        for (const name of await readdir(directory)) if (/^\d{4}-\d{2}-\d{2}\.jsonl$/.test(name) && name.slice(0, 10) < cutoff) await rm(join(directory, name), { force: true });
        for (const cached of callIdentities.keys()) if (cached.startsWith(directory) && cached.slice(directory.length + 1, directory.length + 11) < cutoff) callIdentities.delete(cached);
        cleaned = `${directory}:${date}`;
      }
      let identities;
      if (event.callId) {
        let info;
        try { info = await stat(path); } catch (error) { if (error.code !== 'ENOENT') throw error; }
        identities = await retainedIdentities(path, info);
        if (identities.ids.has(event.callId)) return;
      }
      await appendFile(path, JSON.stringify(event) + '\n', { mode: 0o600 });
      if (identities) {
        const info = await stat(path); identities.ids.add(event.callId); identities.size = info.size; identities.mtime = info.mtimeMs;
      }
      health.written++;
    } catch (error) {
      health.failed++; health.lastError = String(error?.message || error).slice(0, 200);
      throw error;
    }
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

/* Which provider a request belongs to. Gemini is told apart by the key (free or paid project), Groq and SiliconFlow by
   host. A request to a model endpoint the lists below do not know, or with a key that is not any configured key, is
   still recorded, as tier "other": it reached a provider and used something, so it must never vanish from the console. */
const GEMINI_MODEL_CALL = /\/models\/[^/]+:[A-Za-z]+$/; // models/<name>:generateContent, :streamGenerateContent, :predict … (uploads and key checks have no ":verb")
const GROQ_MODEL_CALL = /\/(audio\/(transcriptions|translations)|chat\/completions|responses|embeddings)$/;
const SILICONFLOW_MODEL_CALL = /\/(audio\/transcriptions|chat\/completions|embeddings)$/;
function classifyRequest(url, init, settings) {
  const host = url.hostname, path = url.pathname, marked = !!init.audioUsage;
  if (host === 'generativelanguage.googleapis.com') {
    if (!GEMINI_MODEL_CALL.test(path) && !marked) return null; // uploads, file polling, key checks: not model requests
    const key = init.headers?.['x-goog-api-key'];
    return { key, tier: key && key === settings.freeKey ? 'free' : key && key === settings.paidKey ? 'paid' : 'other', host };
  }
  if (host === 'api.groq.com' || host === 'api.siliconflow.cn') {
    if (!(host === 'api.groq.com' ? GROQ_MODEL_CALL : SILICONFLOW_MODEL_CALL).test(path) && !marked && init.method !== 'POST') return null;
    const key = String(init.headers?.authorization || '').replace(/^Bearer /, '');
    return { key, tier: key ? (host === 'api.groq.com' ? 'groq' : 'siliconflow') : 'other', host };
  }
  // A caller that marks a request as a model request (init.audioUsage) is believed, whichever host it goes to; so is any POST to a host this list does not know.
  if (marked || init.method === 'POST') return { key: String(init.headers?.authorization || '').replace(/^Bearer /, '') || init.headers?.['x-goog-api-key'], tier: 'other', host };
  return null;
}

/** Shared metadata classification, with secrets reduced by the existing ledger policy. */
export function audioRequestMetadata(input, init = {}, settings = {}) {
  const url = new URL(String(input)), kind = classifyRequest(url, init, settings);
  if (!kind) return null;
  const { key, tier, host } = kind;
  return { tier, keyId: keyId(key), model: /generativelanguage/.test(host) ? decodeURIComponent(url.pathname.match(/models\/([^:]+)/)?.[1] || '') : init.audioUsage?.model || 'unknown',
    ...(tier === 'other' ? { host } : {}), stage: init.audioUsage?.stage || (/transcriptions/.test(url.pathname) ? 'transcribe' : 'text'),
    reasoning: init.audioUsage?.reasoning || 'default' };
}

/** Observe actual model HTTP attempts, including retries. Never retain request bodies or keys.
 *  The returned function counts what it recorded (`.recorded`) and what it could not write (`.unrecorded`), so a job can check itself. */
export function audioUsageFetch(settings, fetch = longFetch) {
  const metered = async (input, init = {}) => {
    const url = new URL(String(input));
    const kind = classifyRequest(url, init, settings);
    if (!kind) return fetch(input, init);
    const { key, tier, host } = kind;
    // Audio bodies can be tens of megabytes: metadata comes from the caller, never parse/copy the body here.
    const model = /generativelanguage/.test(host) ? decodeURIComponent(url.pathname.match(/models\/([^:]+)/)?.[1] || '') : init.audioUsage?.model || 'unknown';
    const at = Date.now(), event = { type: 'request', at, tier, keyId: keyId(key), model, ...(tier === 'other' ? { host } : {}),
      stage: init.audioUsage?.stage || (/transcriptions/.test(url.pathname) ? 'transcribe' : 'text'),
      reasoning: init.audioUsage?.reasoning || 'default' };
    const record = async value => {
      try { await recordAudioUsage(value); metered.recorded++; } catch { metered.unrecorded++; }
    };
    let response;
    try { response = await fetch(input, init); }
    catch (error) {
      await record({ ...event, status: 0, elapsedMs: Date.now() - at });
      throw error;
    }
    // Read once and share the parsed body with the pipeline; failures are still recorded.
    let body = null;
    try { body = await response.json(); } catch { /* an error may contain no JSON */ }
    const { inputTokens, outputTokens } = usageTokens(body);
    await record({ ...event, status: response.status, elapsedMs: Date.now() - at, inputTokens, outputTokens,
      audioSeconds: response.status >= 200 && response.status < 300 ? Number(init.audioUsage?.seconds) || 0 : 0,
      quota: tier === 'groq' || tier === 'siliconflow' ? rateHeaders(response.headers, at) : null,
    });
    return { status: response.status, ok: response.ok, headers: response.headers, json: async () => {
      if (body === null) throw new Error('Response was not JSON');
      return body;
    } };
  };
  metered.recorded = 0;
  metered.unrecorded = 0;
  return metered;
}

/* Days. "Today" and the seven-day trend are the learner's own calendar days (their time zone); the Gemini free quota
   keeps Google's day, which turns over at midnight Pacific time, and says so next to the quota. */
export const QUOTA_TIME_ZONE = 'America/Los_Angeles';
const formatters = new Map();
const formatterFor = timeZone => {
  let formatter = formatters.get(timeZone);
  if (!formatter) formatters.set(timeZone, formatter = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }));
  return formatter;
};
/** The time zone of this process (the learner's own, as the host runs on their machine). */
export const localTimeZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
/** A time zone name Intl accepts, or undefined. */
export const validTimeZone = value => { if (typeof value !== 'string' || !value) return undefined; try { formatterFor(value); return value; } catch { return undefined; } };
/** The calendar date (YYYY-MM-DD) of an instant in a time zone. */
export const dayOf = (at, timeZone) => formatterFor(timeZone).format(at);
/** The `count` calendar dates ending at `today`, by calendar arithmetic: a day that is 23 or 25 hours long is still one day. */
export function recentDays(today, count) {
  const [year, month, date] = today.split('-').map(Number);
  return Array.from({ length: count }, (_, i) => new Date(Date.UTC(year, month - 1, date - (count - 1 - i))).toISOString().slice(0, 10));
}
/** When the quota day that contains `now` ends: the next midnight in the quota time zone, and that moment as a local HH:MM. */
export function quotaReset(now, timeZone = localTimeZone()) {
  const day = dayOf(now, QUOTA_TIME_ZONE);
  let at = now - (now % 900000) + 900000;
  while (dayOf(at, QUOTA_TIME_ZONE) === day) at += 900000;
  const time = new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', minute: '2-digit', hour12: false }).format(at);
  return { resetsAt: at, resetTime: time };
}

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
export function summarizeAudioUsage(events, settings, now = Date.now(), { timeZone = localTimeZone() } = {}) {
  const today = dayOf(now, timeZone), quotaToday = dayOf(now, QUOTA_TIME_ZONE), reset = quotaReset(now, timeZone);
  // Appended, not in request order: earlier readers index the first three. The panel sorts them for display.
  const tiers = ['free', 'groq', 'paid', 'siliconflow'];
  const keys = Object.fromEntries(tiers.map(tier => [tier, keyId(settings[`${tier}Key`])]));
  const requests = events.filter(event => event.type === 'request' && event.at <= now);
  const active = requests.filter(event => keys[event.tier] && keys[event.tier] === event.keyId);
  const others = requests.filter(event => event.tier === 'other');
  const days = recentDays(today, 7);
  const trend = days.map(date => ({ date, ...Object.fromEntries([...tiers, 'other'].map(t => [t, 0])) }));
  const byDay = new Map(trend.map(item => [item.date, item]));
  for (const event of [...active, ...others]) { const bucket = byDay.get(dayOf(event.at, timeZone)); if (bucket) bucket[event.tier] += event.requests || 1; }
  const providers = tiers.map(tier => {
    const all = active.filter(event => event.tier === tier), recent = all.filter(event => dayOf(event.at, timeZone) === today);
    // The Gemini free quota runs on Google's day; every other count is the learner's day.
    const quotaDay = tier === 'free' ? all.filter(event => dayOf(event.at, QUOTA_TIME_ZONE) === quotaToday) : recent;
    const total = empty(), current = empty();
    all.forEach(event => count(total, event)); recent.forEach(event => count(current, event));
    const configuredModels = tier === 'siliconflow' ? [settings.siliconflowTranscribeModel]
      : tier === 'groq' ? [settings.groqTranscribeModel, settings.groqTextModel] : [settings.transcribeModel, settings.textModel];
    const models = [...new Set([...configuredModels, ...recent.map(event => event.model), ...quotaDay.map(event => event.model)].filter(Boolean))].map(model => {
      const used = quotaDay.filter(event => event.model === model && usesQuota(event)).reduce((n, event) => n + (event.requests || 1), 0);
      const latest = all.filter(event => event.model === model && event.quota).reduce((latest, event) => !latest || latest.quota.at < event.quota.at ? event : latest, null);
      const quota = latest?.quota;
      const fresh = quota && quota.expiresAt > now;
      const configured = tier === 'free' ? settings.dailyLimits?.[model] : null;
      return { model, used, limit: fresh ? quota.limit : configured || null,
        remaining: fresh ? quota.remaining : configured ? Math.max(0, configured - used) : null,
        source: fresh ? 'provider' : configured ? 'local-estimate' : 'unknown',
        lastQuota: quota || null };
    });
    return { tier, configured: !!keys[tier], today: current, total, models,
      ...(tier === 'free' ? { quotaDay: { timeZone: QUOTA_TIME_ZONE, day: quotaToday, ...reset } } : {}) };
  });
  const otherTotal = empty(), otherToday = empty();
  others.forEach(event => count(otherTotal, event)); others.filter(event => dayOf(event.at, timeZone) === today).forEach(event => count(otherToday, event));
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
  const seen = [...active, ...others];
  return { updatedAt: now, since: seen.length ? seen.reduce((n, event) => Math.min(n, event.at), now) : null, timezone: timeZone, timeZone,
    quotaTimeZone: QUOTA_TIME_ZONE, quotaDay: { timeZone: QUOTA_TIME_ZONE, day: quotaToday, ...reset },
    today, providers, other: { today: otherToday, total: otherTotal }, trend, timings };
}

/* The ledger is one JSONL file per UTC day. Reading it is incremental: each file is kept as small counters (requests
   collapsed per 15 minutes, provider, key, model and status), and a call only reads what was appended since the last one.
   A day that is finished is never read again unless its size or modification time changes. */
const SLOT_MS = 900000, MAX_LINE = 4096;
const cache = new Map(); // path → { size, mtime (whole ms), offset, buckets: Map }
function addEvent(buckets, event, now) {
  if (!event || typeof event !== 'object' || !Number.isFinite(event.at) || event.at > now + 60000 || event.at < now - RETAIN_DAYS * 86400000) return;
  const slot = Math.floor(event.at / SLOT_MS);
  let key;
  if (event.type === 'request') key = `${slot}:${event.tier}:${event.keyId}:${event.model}:${event.status}`;
  else if (event.type === 'stage') key = `${slot}:${event.stage}:${event.reasoning}:${event.success}`;
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
}
/** Feed every complete line of `path` from byte `start` to `accept`; resolves to the byte offset after the last complete line. */
async function scan(path, start, accept, strict = false) {
  let position = start, consumed = start, carry = [], carried = 0, oversized = false;
  for await (const chunk of createReadStream(path, { start, highWaterMark: 65536 })) {
    let from = 0;
    for (;;) {
      const newline = chunk.indexOf(10, from);
      if (newline < 0) {
        if (!oversized) { carry.push(chunk.subarray(from)); carried += chunk.length - from; if (carried > MAX_LINE) { if (strict) throw Object.assign(new Error('Oversized usage ledger row'), { code: 'ledger-invalid' }); oversized = true; carry = []; carried = 0; } }
        break;
      }
      if (!oversized) { carry.push(chunk.subarray(from, newline)); carried += newline - from; if (strict && carried > MAX_LINE) throw Object.assign(new Error('Oversized usage ledger row'), { code: 'ledger-invalid' }); if (carried <= MAX_LINE) accept(Buffer.concat(carry).toString('utf8')); }
      carry = []; carried = 0; oversized = false;
      consumed = position + newline + 1;
      from = newline + 1;
    }
    position += chunk.length;
  }
  // An incomplete final line is left for the next read: another process may still be appending it.
  return consumed;
}
async function ledgerBuckets(now) {
  const directory = ledgerDir(), cutoff = new Date(now - RETAIN_DAYS * 86400000).toISOString().slice(0, 10);
  let names = [];
  try { names = await readdir(directory); } catch (error) { if (!['ENOENT', 'ENOTDIR'].includes(error.code)) throw error; }
  const wanted = names.filter(name => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(name) && name.slice(0, 10) >= cutoff).sort();
  const paths = new Set(wanted.map(name => join(directory, name)));
  for (const path of cache.keys()) if (path.startsWith(directory) && !paths.has(path)) cache.delete(path);
  const all = [];
  for (const name of wanted) {
    const path = join(directory, name);
    let info;
    try { info = await stat(path); } catch { cache.delete(path); continue; }
    let entry = cache.get(path);
    const stamp = Math.floor(info.mtimeMs);
    if (entry && entry.size === info.size && entry.mtime === stamp) { all.push(...entry.buckets.values()); continue; }
    // Appended since last time: read only the new part. Anything else (shorter, rewritten earlier) starts over.
    if (!entry || info.size < entry.offset || stamp < entry.mtime) entry = { size: 0, mtime: 0, offset: 0, buckets: new Map() };
    const buckets = entry.buckets;
    entry.offset = await scan(path, entry.offset, line => { try { addEvent(buckets, JSON.parse(line), now); } catch { /* a damaged line */ } });
    entry.size = info.size; entry.mtime = stamp;
    cache.set(path, entry);
    all.push(...buckets.values());
  }
  return all;
}
let reading = null;
/** The usage summary. `timeZone` is the learner's (the panel passes its own); the host's own zone otherwise. */
export async function audioDashboard(settings, { timeZone } = {}) {
  // Reads run one at a time (they extend the same per-file counters); none of them waits for the ledger writes of a running import.
  while (reading) await reading.catch(() => {});
  const now = Date.now();
  const read = ledgerBuckets(now);
  reading = read;
  try { return summarizeAudioUsage(await read, settings, now, { timeZone: validTimeZone(timeZone) }); }
  finally { if (reading === read) reading = null; }
}

export const audioReasoning = (settings, kind) => kind === 'proofread' ? settings.proofreadReasoning || 'default' : kind === 'translate' ? settings.translateReasoning || 'low' : 'low';
