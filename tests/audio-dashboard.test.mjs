import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, mkdir, writeFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { audioDashboard, audioUsageFetch, keyId, rateHeaders, recordAudioUsage, summarizeAudioUsage } from '../lib/audio-dashboard.js';
import { AUDIO_DEFAULTS, publicAudioSettings, saveAudioSettings } from '../lib/audio-settings.js';
import { GeminiTiers } from '../lib/gemini.js';
import { groqChat } from '../lib/groq.js';
import { textKey } from '../lib/audio-import.js';
import { correctionEffort } from '../lib/live-correction-agent.js';
import { applyCorrections } from '../lib/transcript.js';

const settings = { ...AUDIO_DEFAULTS, freeKey: 'AIza_test_free_00000000000000', paidKey: 'AIza_test_paid_00000000000000', groqKey: 'gsk_test_00000000000000000000' };
const request = (tier, at, extra = {}) => ({ type: 'request', tier, keyId: keyId(settings[`${tier}Key`]), at, model: settings.transcribeModel, status: 200, ...extra });
const now = Date.parse('2026-09-30T12:00:00Z');
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
  ], { ...settings, dailyLimits: { [settings.transcribeModel]: 5 } }, now);
  const free = usage.providers[0];
  assert.equal(free.today.requests, 2); assert.equal(free.today.limited, 1); assert.equal(free.total.requests, 3);
  assert.equal(free.models.find(model => model.model === settings.transcribeModel).remaining, 4);
  assert.equal(free.models.find(model => model.model === settings.textModel).remaining, null);
  assert.equal(usage.providers[2].today.audioSeconds, 120);
  assert.equal(usage.trend.at(-1).free, 2);
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
  for (const level of ['low', 'medium', 'high']) assert.equal(await correctionEffort(ctx, {}, level), level);
  assert.equal(await correctionEffort(ctx, {}, 'default'), undefined);
  assert.equal(await correctionEffort({ llm: {} }, {}, 'high'), undefined);
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
