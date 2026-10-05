import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, mkdir, writeFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { audioDashboard, audioUsageFetch, keyId, rateHeaders, recordAudioUsage, summarizeAudioUsage, usageTokens } from '../lib/audio-dashboard.js';
import { AUDIO_DEFAULTS, publicAudioSettings, saveAudioSettings } from '../lib/audio-settings.js';
import { GeminiTiers } from '../lib/gemini.js';
import { groqChat } from '../lib/groq.js';
import { textKey } from '../lib/audio-import.js';
import { correctionEffort } from '../lib/live-correction-agent.js';
import { applyCorrections } from '../lib/transcript.js';

const settings = { ...AUDIO_DEFAULTS, freeKey: 'AIza_test_free_00000000000000', paidKey: 'AIza_test_paid_00000000000000', groqKey: 'gsk_test_00000000000000000000' };
const request = (tier, at, extra = {}) => ({ type: 'request', tier, keyId: keyId(settings[`${tier}Key`]), at, model: settings.transcribeModel, status: 200, ...extra });
const now = Date.parse('2026-09-30T12:00:00Z');

test('concurrent Gemini replies report their own reasoning after independent fallback', async () => {
  const reasoning = {}, held = [];
  const tiers = new GeminiTiers({ keys: { paid: settings.paidKey }, fetch: async (url, init) => {
    const body = JSON.parse(init.body), prompt = body.contents[0].parts[0].text;
    if (prompt === 'fallback' && body.generationConfig?.thinkingConfig)
      return new Response(JSON.stringify({ error: { message: 'unsupported thinking' } }), { status: 400 });
    await new Promise(resolve => held.push({ prompt, resolve }));
    return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: prompt }] } }] }));
  } });
  const one = tiers.complete('gemini-3-flash', 'system', 'fallback', { thinkingLevel: 'high', onReasoning: value => { reasoning.fallback = value; } });
  const two = tiers.complete('gemini-3-flash', 'system', 'accepted', { thinkingLevel: 'high', onReasoning: value => { reasoning.accepted = value; } });
  for (let i = 0; i < 100 && held.length < 2; i++) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(held.length, 2);
  held.find(item => item.prompt === 'accepted').resolve();
  held.find(item => item.prompt === 'fallback').resolve();
  assert.deepEqual(await Promise.all([one, two]), ['fallback', 'accepted']);
  assert.deepEqual(reasoning, { accepted: 'high', fallback: 'default' });
});
async function home(t) {
  const root = await mkdtemp(join(tmpdir(), 'audio-dashboard-')), previous = process.env.DSH_HOME;
  process.env.DSH_HOME = root;
  t.after(async () => { await audioDashboard(settings); if (previous === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = previous; await rm(root, { force: true, recursive: true }); });
  return root;
}
test('daily use follows Pacific midnight, separates models, ignores old keys and counts failed attempts', () => {
  const usage = summarizeAudioUsage([
    request('free', Date.parse('2026-09-30T06:59:00Z')), request('free', Date.parse('2026-09-30T07:01:00Z')),
    request('free', now, { model: settings.textModel, status: 429 }), request('paid', now, { audioSeconds: 120 }),
    request('free', now, { keyId: keyId('replaced-key') }), request('free', now + 1),
  ], { ...settings, dailyLimits: { [settings.transcribeModel]: 5 } }, now, { timeZone: 'America/Los_Angeles' });
  const free = usage.providers[0];
  assert.equal(free.today.requests, 2); assert.equal(free.today.limited, 1); assert.equal(free.total.requests, 3);
  assert.equal(free.models.find(model => model.model === settings.transcribeModel).remaining, 4);
  assert.equal(free.models.find(model => model.model === settings.textModel).remaining, null);
  assert.equal(usage.providers[2].today.audioSeconds, 120);
  assert.equal(usage.trend.at(-1).free, 2);
});
test('a rate-limited or unreachable attempt does not use up the daily quota, though it is still listed as a failure', () => {
  const at = now - 60000;
  const usage = summarizeAudioUsage([
    request('free', at), request('free', at + 1), request('free', at + 2),
    request('free', at + 3, { status: 429 }), request('free', at + 4, { status: 429 }), request('free', at + 5, { status: 429 }),
    request('free', at + 6, { status: 0 }),
  ], { ...settings, dailyLimits: { [settings.transcribeModel]: 25 } }, now);
  const free = usage.providers[0], model = free.models.find(item => item.model === settings.transcribeModel);
  assert.equal(model.used, 3, 'only the three that reached the model count against the 25');
  assert.equal(model.remaining, 22);
  assert.equal(free.today.requests, 7, 'every attempt is still shown');
  assert.equal(free.today.limited, 3); assert.equal(free.today.failures, 4);
});
test('Groq response quota is distinguished from estimates and expires instead of claiming reset data', () => {
  const headers = new Headers({ 'x-ratelimit-limit-requests': '2000', 'x-ratelimit-remaining-requests': '1977', 'x-ratelimit-reset-requests': '2m59.56s' });
  const quota = rateHeaders(headers, now);
  assert.equal(quota.expiresAt, now + 179560);
  const events = [request('groq', now, { model: settings.groqTranscribeModel, quota })];
  const fresh = summarizeAudioUsage(events, settings, now).providers[1].models[0];
  assert.equal(fresh.remaining, 1977); assert.equal(fresh.source, 'provider');
  const expired = summarizeAudioUsage(events, settings, now + 180000).providers[1].models[0];
  assert.equal(expired.remaining, null); assert.equal(expired.source, 'unknown'); assert.ok(expired.lastQuota);
  assert.equal(rateHeaders(new Headers(), now), null);
});
test('ledger records concurrent real HTTP attempts, survives reload, and contains no keys or prompts', async t => {
  const root = await home(t);
  let calls = 0;
  const fetch = audioUsageFetch(settings, async () => {
    if (++calls === 1) return new Response(JSON.stringify({ error: { message: 'quota reached' } }), { status: 429 });
    return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: '{}' }] } }], usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 10 } }));
  });
  const tiers = new GeminiTiers({ keys: { free: settings.freeKey }, fetch, sleep: async () => {} });
  await tiers.complete(settings.textModel, 'Secret system prompt', 'Secret lecture content', { thinkingLevel: 'high', stage: 'proofread' });
  await Promise.all(Array.from({ length: 12 }, () => recordAudioUsage(request('free', Date.now()))));
  const usage = await audioDashboard(settings);
  assert.equal(usage.providers[0].today.requests, 14); assert.equal(usage.providers[0].today.failures, 1);
  assert.equal(usage.providers[0].today.inputTokens, 100);
  const text = await readFile(join(root, 'study', 'audio-usage', `${new Date().toISOString().slice(0, 10)}.jsonl`), 'utf8');
  for (const secret of [settings.freeKey, settings.paidKey, settings.groqKey, 'Secret system', 'Secret lecture', 'quota reached']) assert.ok(!text.includes(secret));
  assert.ok(!JSON.stringify(usage).includes(keyId(settings.freeKey)));
  assert.equal((await audioDashboard(settings)).providers[0].today.requests, 14);
});
test('network failure is recorded once and key validation / uploads are not model quota requests', async t => {
  await home(t);
  const fetch = audioUsageFetch(settings, async () => { throw new Error('network'); });
  const init = { headers: { 'x-goog-api-key': settings.freeKey } };
  await assert.rejects(fetch('https://generativelanguage.googleapis.com/v1beta/models/x:generateContent', init), /network/);
  await assert.rejects(fetch('https://generativelanguage.googleapis.com/v1beta/models', init), /network/);
  assert.equal((await audioDashboard(settings)).providers[0].today.requests, 1);
});
test('large daily logs stream into counters, retain every call, discard oversized partial lines, and prune old days', async t => {
  const root = await home(t), directory = join(root, 'study', 'audio-usage');
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, '2000-01-01.jsonl'), '{}\n');
  const event = request('free', Date.now(), { inputTokens: 10 });
  const file = join(directory, `${new Date().toISOString().slice(0, 10)}.jsonl`);
  await writeFile(file, (JSON.stringify(event) + '\n').repeat(10000) + 'x'.repeat(50000) + '\n' + JSON.stringify(event) + '\n' + '{"incomplete":');
  const summary = await audioDashboard(settings);
  assert.equal(summary.providers[0].today.requests, 10001);
  assert.equal(summary.providers[0].today.inputTokens, 100010);
  await recordAudioUsage(request('paid', Date.now()));
  assert.ok(!(await readdir(directory)).includes('2000-01-01.jsonl'));
});
test('model reasoning and quota settings validate, persist, and invalidate only processed text checkpoints', async t => {
  await home(t);
  const saved = await saveAudioSettings({ proofreadReasoning: 'high', translateReasoning: 'low', dailyLimits: { [settings.transcribeModel]: 12 } });
  assert.equal(saved.proofreadReasoning, 'high'); assert.equal(saved.translateReasoning, 'low');
  assert.equal(publicAudioSettings(saved).dailyLimits[settings.transcribeModel], 12);
  await assert.rejects(saveAudioSettings({ proofreadReasoning: 'ultra' }), /推理强度/);
  await assert.rejects(saveAudioSettings({ dailyLimits: { [settings.transcribeModel]: -1 } }), /每日额度/);
  const context = { subject: '', vocabulary: [], settings };
  assert.notEqual(textKey(context), textKey({ ...context, settings: { ...settings, proofreadReasoning: 'high' } }));
  assert.notEqual(textKey(context), textKey({ ...context, settings: { ...settings, translateReasoning: 'medium' } }));
});
test('native reasoning respects supported medium/high and falls back when unavailable', async () => {
  const ctx = { llm: { resolveModelInfo: async () => ({ reasoning: { efforts: [{ id: 'low' }, { id: 'medium' }, { id: 'high' }] } }) } };
  const route = { provider: 'test-provider', model: 'test-model' };
  for (const level of ['low', 'medium', 'high']) assert.equal(await correctionEffort(ctx, route, level), level);
  assert.equal(await correctionEffort(ctx, route, 'default'), undefined);
  assert.equal(await correctionEffort({ llm: {} }, route, 'high'), undefined);
});
test('Groq receives high reasoning when supported and reports fallback when rejected', async () => {
  const forms = [];
  const result = await groqChat({ model: 'openai/gpt-oss-120b', key: 'test', reasoningEffort: 'high', fetch: async (_, init) => {
    forms.push(JSON.parse(init.body));
    return new Response('{}', { status: forms.length === 1 ? 400 : 200 });
  } });
  assert.equal(forms[0].reasoning_effort, 'high'); assert.equal(forms[1].reasoning_effort, undefined);
  assert.equal(result.reasoning, 'default');
});
test('unchanged Big Four output is skipped as no change, never counted as low confidence review', () => {
  const result = applyCorrections("That makes more sense if I'm Accenture, if I'm the Big Four, if I'm NCS", [{ wrong: 'the Big Four', right: 'the Big Four', confidence: 'low', reason: '无错误，保留原文' }]);
  assert.equal(result.applied.length, 0); assert.equal(result.skipped[0].skipped, 'empty');
  assert.equal(result.skipped.filter(item => item.skipped === 'low-confidence').length, 0);
});

test('transcription replies without candidatesTokenCount still count output tokens, and unreported output is not shown as zero', () => {
  assert.deepEqual(usageTokens({ usageMetadata: { promptTokenCount: 62783, totalTokenCount: 70000 } }), { inputTokens: 62783, outputTokens: 7217, cachedInputTokens: 0 });
  assert.equal(usageTokens({ usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5, thoughtsTokenCount: 3, totalTokenCount: 18 } }).outputTokens, 8);
  assert.equal(usageTokens({ usage: { prompt_tokens: 4, completion_tokens: 2 } }).outputTokens, 2);
  const events = [request('free', now, { inputTokens: 62783, outputTokens: 0 }), request('free', now, { inputTokens: 10, outputTokens: 5 }),
    request('groq', now, { model: settings.groqTranscribeModel, audioSeconds: 600 }), request('free', now, { status: 429 })];
  const [free, groq] = summarizeAudioUsage(events, settings, now).providers;
  assert.equal(free.today.outputUnknown, 1); assert.equal(groq.today.outputUnknown, 0);
  assert.equal(free.today.limited, 1); assert.equal(free.today.failures, 1);
});
