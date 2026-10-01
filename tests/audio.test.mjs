import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { splitMp3, splitWav, wavInfo, mp3Frame, loadAudio } from "../lib/audio-file.js";
import { GeminiTiers, GeminiError, replyText } from "../lib/gemini.js";
import { applyCorrections, buildDocuments, buildVocabulary, joinChunks, paragraphize, windowsOf, zhNumber } from "../lib/transcript.js";
import { readAudioSettings, publicAudioSettings, saveAudioSettings } from "../lib/audio-settings.js";
import { runAudioImport, textKey, digest } from "../lib/audio-import.js";
import { StudyService } from "../lib/service.js";
import { liveUrl } from "../lib/live-protocol.js";

const FREE = "AIzaFreeKey_000000000000000000000001", PAID = "AIzaPaidKey_000000000000000000000002";

test('fast correction reasoning uses low when supported and reports actual cached input tokens', async () => {
  const configs = [];
  const tiers = new GeminiTiers({ keys: { free: FREE }, fetch: async (_url, init) => {
    configs.push(JSON.parse(init.body).generationConfig);
    return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: '{}' }] } }], usageMetadata: { promptTokenCount: 100, cachedContentTokenCount: 80 } }));
  } });
  await tiers.complete('gemini-3.5-flash-lite', 's', 'p', { thinkingLevel: 'low', maxOutputTokens: 4096 });
  assert.deepEqual(configs[0].thinkingConfig, { thinkingLevel: 'low' });
  assert.equal(configs[0].maxOutputTokens, 4096);
  assert.equal(tiers.summary().free.cachedInputTokens, 80);
  await tiers.complete('gemini-2.5-flash', 's', 'p', { thinkingLevel: 'low' });
  assert.deepEqual(configs[1].thinkingConfig, { thinkingBudget: 1024 });
  await tiers.complete('gemini-3.5-flash-lite', 's', 'p', { thinkingLevel: 'default' });
  assert.equal(configs[2].thinkingConfig, undefined);
  let calls = 0;
  const unsupported = new GeminiTiers({ keys: { free: FREE }, fetch: async (_url, init) => {
    const config = JSON.parse(init.body).generationConfig;
    if (++calls === 1) return new Response(JSON.stringify({ error: { message: 'thinking level low not supported' } }), { status: 400 });
    assert.equal(config.thinkingConfig, undefined);
    return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: '{}' }] } }] }));
  } });
  assert.equal(await unsupported.complete('gemini-3.5-flash-lite', 's', 'p', { thinkingLevel: 'low' }), '{}');
  assert.equal(calls, 2);
});

/* MPEG-1 Layer III, 128 kbps, 44.1 kHz: FF FB 90 00, 417-byte frames of 26.122 ms. */
const mp3Frames = (count) => {
  const frame = Buffer.alloc(417);
  frame.set([0xff, 0xfb, 0x90, 0x00]);
  return Buffer.concat(Array.from({ length: count }, () => frame));
};
const pcmWav = (seconds, rate = 8000) => {
  const data = Buffer.alloc(seconds * rate * 2), header = Buffer.alloc(44);
  header.write("RIFF", 0, "latin1"); header.writeUInt32LE(36 + data.length, 4); header.write("WAVEfmt ", 8, "latin1");
  header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22); header.writeUInt32LE(rate, 24);
  header.writeUInt32LE(rate * 2, 28); header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34);
  header.write("data", 36, "latin1"); header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
};
const json = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), { status, headers });
const reply = (text, extra = {}) => json({ candidates: [{ content: { parts: [{ text }] } }], usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 }, ...extra });
const quota = (scope, retry) => json({ error: { code: 429, status: "RESOURCE_EXHAUSTED", message: "quota",
  details: [{ "@type": "type.googleapis.com/google.rpc.QuotaFailure", violations: [{ quotaId: `GenerateRequests${scope}PerProjectPerModel-FreeTier` }] },
    ...(retry ? [{ "@type": "type.googleapis.com/google.rpc.RetryInfo", retryDelay: retry }] : [])] } }, 429);
const keyOf = (init) => init?.headers?.["x-goog-api-key"];

test("MP3 files are cut on frame boundaries, past an ID3 tag and junk bytes", () => {
  const id3 = Buffer.concat([Buffer.from("ID3\x03\x00\x00\x00\x00\x00\x10", "latin1"), Buffer.alloc(16)]);
  const audio = Buffer.concat([id3, mp3Frames(80), Buffer.from("junkjunk"), mp3Frames(80)]);
  const { seconds, frames, chunks } = splitMp3(audio, 1);
  assert.equal(frames, 160);
  assert.ok(Math.abs(seconds - 160 * 1152 / 44100) < 1e-6);
  assert.ok(chunks.length >= 4);
  for (const chunk of chunks) assert.ok(mp3Frame(audio, chunk.start), "every chunk starts on a frame header");
  assert.equal(chunks[0].start, id3.length);
  assert.ok(chunks.every((c, i) => i === 0 || c.start >= chunks[i - 1].end));
  assert.ok(chunks.slice(0, -1).every((c) => c.seconds >= 1 && c.seconds < 1.1));
});

test("WAV files split into standalone WAV chunks with the same audio", () => {
  const wav = pcmWav(10), info = wavInfo(wav);
  assert.equal(info.seconds, 10);
  const chunks = splitWav(wav, info, 4);
  assert.deepEqual(chunks.map((c) => c.seconds), [4, 4, 2]);
  for (const chunk of chunks) assert.equal(wavInfo(chunk.bytes).dataLength, chunk.bytes.length - 44);
  assert.equal(chunks.reduce((n, c) => n + c.bytes.length - 44, 0), info.dataLength);
});

test("loadAudio rejects relative paths and unknown formats before reading anything", async () => {
  await assert.rejects(loadAudio({ path: "lecture.mp3" }), /绝对路径/);
  await assert.rejects(loadAudio({ path: join(tmpdir(), "notes.txt") }), /不支持的音频格式/);
});

test("corrections apply only when the quoted context is verbatim and the edit is small", () => {
  const text = "We split the table into a patient by date. The patients table is unrelated. Then run it.";
  const { text: fixed, applied, skipped } = applyCorrections(text, [
    { wrong: "patient", right: "partition", context: "split the table into a patient by date", reason: "数据库语境", confidence: "high" },
    { wrong: "patient", right: "partition", context: "The patients table is unrelated", confidence: "high" },
    { wrong: "run", right: "ran", context: "we run something that is not there", confidence: "high" },
    { wrong: "Then", right: "And then", context: "Then run it", confidence: "low" },
    { wrong: "table", right: "a completely different rewritten sentence about tables and chairs", context: "split the table into", confidence: "high" },
    { wrong: "unrelated", right: "related\nother", context: "table is unrelated", confidence: "high" },
  ]);
  assert.equal(fixed, "We split the table into a partition by date. The patients table is unrelated. Then run it.");
  assert.equal(applied.length, 1);
  assert.deepEqual(skipped.map((s) => s.skipped), ["context-mismatch", "context-not-found", "low-confidence", "too-large", "multiline"]);
});

test('only high-confidence audio corrections may change the transcript', () => {
  for (const confidence of ['high', 'medium', 'low', undefined, 'unknown']) {
    const proposal = { wrong: 'Study', right: 'Istio', context: 'Study is done in Go', reason: 'Term guess', confidence };
    const result = applyCorrections('Study is done in Go', [proposal]);
    assert.equal(result.text, confidence === 'high' ? 'Istio is done in Go' : 'Study is done in Go');
    assert.equal(result.applied.length, confidence === 'high' ? 1 : 0);
    if (confidence !== 'high') {
      assert.equal(result.skipped[0].skipped, 'low-confidence');
      assert.equal(result.skipped[0].reason, 'Term guess');
    }
  }
});

test('the high-only correction policy cannot reuse legacy corrected-text checkpoints', () => {
  const settings = { textProvider: 'host', textModel: 'model' }, subject = 'Cloud', vocabulary = ['Istio'];
  const legacyKey = digest({ v: 1, provider: settings.textProvider, model: settings.textModel, subject, vocabulary });
  assert.notEqual(textKey({ settings, subject, vocabulary }), legacyKey);
});

test("paragraphs, windows and joined chunks keep sentences intact", () => {
  assert.equal(joinChunks(["We split the table into", "a partition by date.", "Next topic."]), "We split the table into a partition by date.\n\nNext topic.");
  const long = Array.from({ length: 40 }, (_, i) => `Sentence number ${i} is here.`).join(" ");
  const paragraphs = paragraphize(long, 200);
  assert.ok(paragraphs.length > 4 && paragraphs.every((p) => p.length <= 320) && paragraphs.join(" ") === long);
  assert.deepEqual(windowsOf(["aaaa", "bbbb", "cccc"], 8), [["aaaa", "bbbb"], ["cccc"]]);
  assert.deepEqual(buildVocabulary({ terms: ["SQL", "sql", " ANSI "], topics: ["Index", "x"] }), ["SQL", "ANSI", "Index"]);
});

test("the bilingual document follows the requested layout", () => {
  assert.deepEqual([1, 10, 11, 21, 99].map(zhNumber), ["一", "十", "十一", "二十一", "九十九"]);
  const [doc] = buildDocuments({
    filename: "SQL技术特性与应用讨论.mp3", titleEn: "SQL Technical Features & Application Seminar",
    parts: [
      { titleZh: "声明式语言与 ANSI 标准", titleEn: "Declarative Language & ANSI Standards", english: ["First english.", "Second english."], chinese: ["第一段。", "第二段。"] },
      { titleZh: "事务管理", titleEn: "Transaction Management", english: ["Transfer."], chinese: ["转账。"] },
    ],
  });
  const rule = "=".repeat(80), divider = "-".repeat(80);
  assert.equal(doc, [
    rule, "《SQL技术特性与应用讨论.mp3》全量中英对照逐字稿", "Full Bilingual Transcript: SQL Technical Features & Application Seminar", rule, "",
    "【第一部分：声明式语言与 ANSI 标准】", "[Part 1: Declarative Language & ANSI Standards]", "",
    "【英文原句】", "First english.", "", "Second english.", "", "【中文对照】", "第一段。", "", "第二段。", "", divider, "",
    "【第二部分：事务管理】", "[Part 2: Transaction Management]", "", "【英文原句】", "Transfer.", "", "【中文对照】", "转账。",
  ].join("\n"));
  const many = buildDocuments({ filename: "a.mp3", titleEn: "T", limit: 80, parts: Array.from({ length: 3 }, (_, i) => (
    { titleZh: `题${i}`, titleEn: `T${i}`, english: ["e".repeat(60)], chinese: ["中".repeat(30)] })) });
  assert.equal(many.length, 3);
  assert.ok(many[0].startsWith(rule) && !many[1].startsWith(rule) && many[2].includes("【第三部分"));
});

test("reply text is read from plain parts or from an audioTranscription", () => {
  assert.equal(replyText({ candidates: [{ content: { parts: [{ text: "a" }, { text: "b" }] } }] }), "ab");
  assert.equal(replyText({ candidates: [{ content: { parts: [{ audioTranscription: { words: [{ word: "hi" }, { word: "there" }] } }] } }] }), "hi there");
  assert.equal(replyText({}), "");
});

test("the free key is used first and the paid key is never touched while it works", async () => {
  const used = [];
  const tiers = new GeminiTiers({ keys: { free: FREE, paid: PAID }, fetch: async (url, init) => { used.push(keyOf(init)); return reply("ok"); } });
  assert.equal((await tiers.complete("gemini-3.8-flash", "s", "p")), "ok");
  assert.deepEqual(used, [FREE]);
  assert.equal(tiers.summary().free.requests, 1);
  assert.equal(tiers.summary().paid.requests, 0);
});

test("a spent daily free quota moves the job to the paid key and stops asking the free one", async () => {
  const used = [];
  const tiers = new GeminiTiers({ keys: { free: FREE, paid: PAID }, sleep: async () => { throw new Error("must not wait for a daily quota"); },
    fetch: async (url, init) => { used.push(keyOf(init)); return keyOf(init) === FREE ? quota("PerDay") : reply("paid"); } });
  assert.equal(await tiers.complete("m", "s", "p"), "paid");
  assert.equal(await tiers.complete("m", "s", "p"), "paid");
  assert.deepEqual(used, [FREE, PAID, PAID], "the free key is not retried once its daily quota is gone");
  assert.match(tiers.warnings[0], /免费额度今日用完/);
});

test("a per-minute limit waits for the suggested delay and stays on the free key", async () => {
  const waits = [], used = [];
  let calls = 0;
  const tiers = new GeminiTiers({ keys: { free: FREE, paid: PAID }, sleep: async (ms) => { waits.push(ms); },
    fetch: async (url, init) => { used.push(keyOf(init)); return ++calls === 1 ? quota("PerMinute", "31.2s") : reply("free"); } });
  assert.equal(await tiers.complete("m", "s", "p"), "free");
  assert.deepEqual(waits, [31200]);
  assert.deepEqual(used, [FREE, FREE]);
});

test("empty paid balance stops with a clear message; a bad free key falls back to the paid key", async () => {
  const broke = new GeminiTiers({ keys: { paid: PAID }, fetch: async () => json({ error: { message: "payment" } }, 402) });
  await assert.rejects(broke.complete("m", "s", "p"), (error) => error instanceof GeminiError && error.fatal && /余额已用完/.test(error.message));

  const invalid = json({ error: { code: 400, status: "INVALID_ARGUMENT", message: "API key not valid. Please pass a valid API key.", details: [{ reason: "API_KEY_INVALID" }] } }, 400);
  const used = [];
  const fallback = new GeminiTiers({ keys: { free: FREE, paid: PAID }, fetch: async (url, init) => { used.push(keyOf(init)); return keyOf(init) === FREE ? invalid.clone() : reply("paid"); } });
  assert.equal(await fallback.complete("m", "s", "p"), "paid");
  assert.equal(await fallback.complete("m", "s", "p"), "paid");
  assert.deepEqual(used, [FREE, PAID, PAID]);
  assert.match(fallback.warnings[0], /免费密钥无效/);

  await assert.rejects(new GeminiTiers({ keys: {} }).complete("m", "s", "p"), /还没有配置可用的密钥/);
  assert.equal(new GeminiTiers({ keys: { free: FREE, paid: PAID }, skipFree: true }).keys.free, "", "paid-only imports never send content to the free key");
});

test("transient server errors are retried; the key only travels in a header", async () => {
  const urls = [];
  let calls = 0;
  const tiers = new GeminiTiers({ keys: { paid: PAID }, sleep: async () => {},
    fetch: async (url) => { urls.push(String(url)); return ++calls < 3 ? json({ error: { message: "busy" } }, 503) : reply("fine"); } });
  assert.equal(await tiers.complete("m", "s", "p"), "fine");
  assert.equal(calls, 3);
  assert.ok(urls.every((url) => !url.includes(PAID)));
});

test("an unreachable network is retried, then explained with the proxy hint", async () => {
  let calls = 0;
  const tiers = new GeminiTiers({ keys: { paid: PAID }, sleep: async () => {}, fetch: async () => { calls++; throw new TypeError("fetch failed"); } });
  await assert.rejects(tiers.complete("m", "s", "p"), /连不上 Google 服务：fetch failed.*NODE_USE_ENV_PROXY/);
  assert.equal(calls, 3, "one attempt plus two retries");
});

test("large chunks upload through the Files API per key, then the file is deleted", async () => {
  const calls = [];
  const fetch = async (url, init = {}) => {
    url = String(url);
    calls.push(`${init.method || "GET"} ${url.replace("https://generativelanguage.googleapis.com", "")} ${keyOf(init) === FREE ? "free" : keyOf(init) === PAID ? "paid" : "-"}`);
    if (url.endsWith("/upload/v1beta/files")) return new Response("{}", { status: 200, headers: { "x-goog-upload-url": "https://generativelanguage.googleapis.com/upload/session/abc" } });
    if (url.endsWith("/upload/session/abc")) return json({ file: { name: "files/f1", uri: "https://generativelanguage.googleapis.com/v1beta/files/f1", state: "ACTIVE" } });
    if (init.method === "DELETE") return json({});
    const body = JSON.parse(init.body);
    assert.equal(body.contents[0].parts[0].fileData.mimeType, "audio/mp3");
    assert.deepEqual(body.generationConfig.audioTranscriptionConfig, { customVocabulary: ["partition"], mode: "SMART" });
    return keyOf(init) === FREE ? quota("PerDay") : reply("transcript");
  };
  const tiers = new GeminiTiers({ keys: { free: FREE, paid: PAID }, fetch });
  const { text, tier } = await tiers.transcribe({ bytes: Buffer.alloc(13 * 1024 * 1024), mimeType: "audio/mp3", seconds: 120,
    config: { mode: "SMART", vocabulary: ["partition"] } });
  assert.deepEqual([text, tier], ["transcript", "paid"]);
  assert.deepEqual(calls.filter((c) => !c.includes("generateContent")), [
    "POST /upload/v1beta/files free", "POST /upload/session/abc -", "POST /upload/v1beta/files paid", "POST /upload/session/abc -",
    "DELETE /v1beta/files/f1 free", "DELETE /v1beta/files/f1 paid",
  ]);
  assert.equal(tiers.summary().paid.audioSeconds, 120);
  assert.equal(tiers.summary().estimatedPaidTranscribeUsd, 0.01);

  const hostile = new GeminiTiers({ keys: { paid: PAID }, fetch: async (url) => String(url).endsWith("/upload/v1beta/files")
    ? new Response("{}", { headers: { "x-goog-upload-url": "https://evil.example/steal" } }) : reply("x") });
  await assert.rejects(hostile.transcribe({ bytes: Buffer.alloc(13 * 1024 * 1024), mimeType: "audio/mp3" }), /上传地址无效/);
});

test("settings keep keys out of every value a panel or model can read", async () => {
  const home = await mkdtemp(join(tmpdir(), "audio-settings-"));
  const previous = process.env.DSH_HOME;
  process.env.DSH_HOME = home;
  try {
    await assert.rejects(saveAudioSettings({ freeKey: "short" }), /密钥格式/);
    const saved = await saveAudioSettings({ freeKey: FREE, paidKey: PAID, mode: "VERBATIM", languageCodes: ["en-US"] });
    assert.equal(saved.freeKey, FREE);
    const shown = publicAudioSettings(saved);
    assert.deepEqual(shown.freeKey, { set: true, hint: "••••0001" });
    assert.ok(!JSON.stringify(shown).includes("AIza"));
    assert.equal((await saveAudioSettings({ mode: "SMART" })).freeKey, FREE, "a key left out is kept");
    assert.equal((await saveAudioSettings({ freeKey: "" })).freeKey, "", "an empty key clears it");
    await assert.rejects(saveAudioSettings({ mode: "FAST" }), /mode/);
    await assert.rejects(saveAudioSettings({ textModel: "a b" }), /模型名称/);
    process.env.GEMINI_FREE_API_KEY = FREE;
    assert.equal((await readAudioSettings()).freeKey, FREE, "the environment fills a missing key");
  } finally {
    delete process.env.GEMINI_FREE_API_KEY;
    if (previous === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = previous;
    await rm(home, { recursive: true, force: true });
  }
});

test('AI Studio auth keys with dots and more than 200 characters survive save and transport', async () => {
  const home = await mkdtemp(join(tmpdir(), 'audio-auth-settings-'));
  const previous = process.env.DSH_HOME;
  process.env.DSH_HOME = home;
  // Synthetic tokens only: both dotted tokens and long opaque tokens are valid input.
  const dotted = 'AQ.' + 'synthetic_Auth-'.repeat(3);
  const long = 'AQ.' + 'synthetic_Auth-'.repeat(30);
  try {
    const service = new StudyService(join(home, 'library'));
    const shown = await service.call('audio.settings.set', { freeKey: dotted, paidKey: long });
    const saved = await readAudioSettings();
    assert.equal(saved.freeKey, dotted);
    assert.equal(saved.paidKey, long);
    assert.ok(!JSON.stringify(shown).includes(dotted));
    assert.ok(!JSON.stringify(shown).includes(long));
    const tiers = new GeminiTiers({ keys: { paid: saved.paidKey }, fetch: async (_url, init) => {
      assert.equal(keyOf(init), long);
      return reply('accepted');
    } });
    assert.equal(await tiers.complete('m', 's', 'p'), 'accepted');
    assert.equal(new URL(liveUrl(saved.paidKey)).searchParams.get('key'), long);
    for (const invalid of [long + '\nextra', long + ' extra', '"' + long + '"', long + '\u200b', 'x'.repeat(4097)]) {
      await assert.rejects(saveAudioSettings({ paidKey: invalid }), /密钥格式/);
      assert.equal((await readAudioSettings()).paidKey, long, 'invalid input must preserve the saved key');
    }
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = previous;
    await rm(home, { recursive: true, force: true });
  }
});

/* A fake Gemini: the transcribe model returns fixed text, the text model answers by task. */
function fakeGemini({ failTranslateOnce = false } = {}) {
  const stats = { transcribe: 0, proofread: 0, translate: 0, title: 0, deleted: 0 };
  let failed = false;
  const fetch = async (url, init = {}) => {
    url = String(url);
    if (init.method === "DELETE") return json({});
    const body = JSON.parse(init.body);
    if (url.includes("gemini-3.5-transcribe:")) {
      stats.transcribe++;
      assert.deepEqual(body.generationConfig.audioTranscriptionConfig.customVocabulary?.slice(0, 2), ["Partition", "SQL"]);
      return reply("In traditional times we used programming languages. We split the table into a patient by date, which is fast");
    }
    const system = body.systemInstruction.parts[0].text, sent = body.contents[0].parts[0].text;
    // A corrective retry appends prose after the JSON prompt.
    const cut = sent.indexOf("\n\nYour previous");
    const prompt = JSON.parse(cut < 0 ? sent : sent.slice(0, cut));
    if (system.startsWith("You proofread")) {
      stats.proofread++;
      return reply(JSON.stringify({ corrections: [
        { wrong: "patient", right: "partition", context: "split the table into a patient by date", reason: "数据库语境应为 partition（分区）", confidence: "high" },
        { wrong: "fast", right: "faster", context: "not present anywhere", confidence: "high" },
        { wrong: "fast", right: "slow", context: "by date, which is fast", confidence: "medium", reason: 'Uncertain guess' },
      ] }));
    }
    if (system.startsWith("You translate")) {
      stats.translate++;
      if (failTranslateOnce && !failed) { failed = true; return reply("not json at all"); }
      return reply(JSON.stringify({ titleZh: "分区与查询", titleEn: "Partitioning & Queries",
        paragraphs: prompt.paragraphs.map((p) => ({ n: p.n, zh: `译：${p.text.slice(0, 12)}` })) }));
    }
    stats.title++;
    return reply(JSON.stringify({ titleEn: "SQL Technical Features & Application Seminar" }));
  };
  return { fetch, stats };
}

async function audioFixture() {
  const dir = await mkdtemp(join(tmpdir(), "audio-import-"));
  const home = join(dir, "home"), root = join(dir, "library"), file = join(dir, "SQL技术特性与应用讨论.mp3");
  await writeFile(file, mp3Frames(120));
  return { dir, home, root, file };
}

test("an audio file becomes a proofread bilingual source, and a re-import reuses it", async (t) => {
  const { dir, home, root, file } = await audioFixture();
  const previous = process.env.DSH_HOME;
  process.env.DSH_HOME = home;
  t.after(async () => { if (previous === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = previous; await rm(dir, { recursive: true, force: true }); });
  const { fetch, stats } = fakeGemini();
  const service = new StudyService(root, { fetch });
  await assert.rejects(service.call("audio.import", { path: file }), /还没有配置转写服务/);
  await service.call("audio.settings.set", { freeKey: FREE, paidKey: PAID });

  const started = await service.call("audio.import", { path: file, subject: "SQL 数据库课程", terms: "Partition, SQL" });
  const job = await service.call("job.wait", { jobId: started.jobId, timeoutSeconds: 30 });
  assert.equal(job.status, "complete", job.stage);
  assert.equal(job.type, "audio-import");
  assert.equal(job.corrected, 1);
  assert.equal(job.usage.free.requests, stats.transcribe + stats.proofread + stats.translate + stats.title);
  assert.equal(job.usage.paid.requests, 0);
  assert.equal(job.sourceIds.length, 1);
  const mail = (await service.call('inbox')).items.filter(item => item.jobId === started.jobId);
  assert.deepEqual(mail.map(item => item.kind).sort(), ['audio-proofread', 'audio-result', 'audio-transcribe', 'audio-translate']);
  assert.ok(mail.every(item => !item.missing && item.sourceIds[0] === job.sourceIds[0]));
  const reopened = new StudyService(root);
  assert.equal((await reopened.call('inbox')).items.filter(item => item.jobId === started.jobId).length, 4);
  assert.deepEqual(await service.call('inbox.open', { id: mail[0].id }), { kind: 'audio', jobId: started.jobId, sourceIds: job.sourceIds });

  const source = await service.call("source.get", { id: job.sourceIds[0] });
  assert.match(source.title, /中英对照逐字稿$/);
  assert.ok(source.text.startsWith("=".repeat(80) + "\n《SQL技术特性与应用讨论.mp3》全量中英对照逐字稿\nFull Bilingual Transcript: SQL Technical Features & Application Seminar\n"));
  assert.match(source.text, /【第一部分：分区与查询】\n\[Part 1: Partitioning & Queries\]\n\n【英文原句】\nIn traditional times[\s\S]+into a partition by date, which is fast\n\n【中文对照】\n译：/);
  assert.ok(!source.text.includes("into a patient"), "the recognition mistake is repaired in the stored text");

  const snapshot = await service.call("snapshot", {});
  const stored = snapshot.sources.find((s) => s.id === job.sourceIds[0]);
  assert.equal(stored.audio.corrections.applied[0].right, "partition");
  assert.equal(stored.audio.corrections.skippedCount, 2);
  assert.ok(stored.audio.corrections.skipped.some(item => item.confidence === 'medium' && item.skipped === 'low-confidence'));
  for (const value of [JSON.stringify(snapshot), JSON.stringify(await service.call("audio.settings.get", {})), JSON.stringify(job)])
    assert.ok(!value.includes("AIza"), "no API key in anything the panel or a model reads");

  const cached = await readdir(join(root, "audio-cache"));
  assert.equal(cached.length, 1);
  const again = await service.call("job.wait", { jobId: (await service.call("audio.import", { path: file, subject: "SQL 数据库课程", terms: "Partition, SQL" })).jobId, timeoutSeconds: 30 });
  assert.equal(again.reused, true);
  assert.equal(stats.transcribe, 1, "the recording is not transcribed (or paid for) twice");
});

test("a failed translation resumes from the saved transcript without transcribing again", async (t) => {
  const { dir, home, root, file } = await audioFixture();
  const previous = process.env.DSH_HOME;
  process.env.DSH_HOME = home;
  t.after(async () => { if (previous === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = previous; await rm(dir, { recursive: true, force: true }); });
  const { fetch, stats } = fakeGemini({ failTranslateOnce: true });
  const service = new StudyService(root, { fetch });
  await service.call("audio.settings.set", { paidKey: PAID });
  // The first translation reply is not JSON; the corrective retry succeeds.
  const job = await service.call("job.wait", { jobId: (await service.call("audio.import", { path: file, terms: ["Partition", "SQL"], paidOnly: true })).jobId, timeoutSeconds: 30 });
  assert.equal(job.status, "complete", job.stage);
  assert.equal(stats.translate, 2, "one corrective retry");
  assert.equal(job.usage.free.requests, 0);
  assert.ok(job.usage.paid.requests > 0);
  assert.ok(job.estimatedUsd >= 0);
});

test("cancelling keeps finished chunk transcripts, and the next run continues from them", async () => {
  const chunk = (n) => ({ bytes: Buffer.alloc(100, n), seconds: 60 });
  const audio = { filename: "lecture.mp3", mimeType: "audio/mp3", chunks: [chunk(1), chunk(2), chunk(3)] };
  const dir = await mkdtemp(join(tmpdir(), "audio-resume-"));
  try {
    let transcribed = 0;
    const tiers = {
      async transcribe({ bytes }) { transcribed++; if (transcribed === 3) throw new GeminiError("boom", { status: 500 }); return { text: `chunk ${bytes[0]} ends here.`, tier: "free" }; },
      warnings: [],
    };
    const complete = async (system, prompt) => system.startsWith("You proofread") ? '{"corrections":[]}'
      : system.startsWith("You translate") ? JSON.stringify({ titleZh: "标题", titleEn: "Title", paragraphs: JSON.parse(prompt).paragraphs.map((p) => ({ n: p.n, zh: "译" })) })
      : '{"titleEn":"Lecture"}';
    const settings = { transcribeModel: "m", mode: "SMART", languageCodes: [], textProvider: "gemini", textModel: "t" };
    await assert.rejects(runAudioImport({ audio, tiers, complete, settings, cacheDir: dir }), /boom/);
    assert.equal(transcribed, 3);
    const result = await runAudioImport({ audio, tiers, complete, settings, cacheDir: dir });
    assert.equal(transcribed, 4, "only the unfinished chunk is transcribed again");
    assert.equal(result.parts, 1);
    assert.match(result.documents[0], /chunk 1 ends here\.\n\nchunk 2 ends here\.\n\nchunk 3 ends here\./);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('a partial proofreading failure is never announced as successful proofreading', async () => {
  const events = [];
  const result = await runAudioImport({
    audio: { filename: 'lecture.mp3', mimeType: 'audio/mp3', chunks: [{ bytes: Buffer.alloc(100), seconds: 1 }] },
    tiers: { transcribe: async () => ({ text: 'A lesson about consensus.', tier: 'free' }) },
    settings: { transcribeModel: 'm', mode: 'SMART', languageCodes: [], textProvider: 'host', textModel: 't' },
    complete: async (system, prompt) => {
      if (system.startsWith('You proofread')) return 'not JSON';
      if (system.startsWith('You translate')) return JSON.stringify({ titleZh: '共识', titleEn: 'Consensus', paragraphs: JSON.parse(prompt).paragraphs.map(p => ({ n: p.n, zh: '关于共识的一课。' })) });
      return '{"titleEn":"Consensus"}';
    },
    milestone: async (phase, options) => { events.push({ phase, ...options }); },
  });
  assert.ok(result.documents.length);
  assert.deepEqual(events, [{ phase: 'transcribe' }, { phase: 'proofread', partial: true }, { phase: 'translate' }]);
});
