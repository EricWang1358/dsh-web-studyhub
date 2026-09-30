import test from "node:test";
import assert from "node:assert/strict";
import { GeminiTiers, GeminiError, describeFailure } from "../lib/gemini.js";
import { applyCorrections, buildDocuments, cjkShare, paragraphize } from "../lib/transcript.js";
import { checkpoints, finishTranscript, runAudioImport } from "../lib/audio-import.js";

const PAID = "AIzaFallbackKey_0000000000000001";
const json = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), { status, headers });
const reply = (text) => json({ candidates: [{ content: { parts: [{ text }] } }], usageMetadata: {} });
const invalid = (field) => json({ error: { code: 400, status: "INVALID_ARGUMENT", message: "Request contains an invalid argument.",
  ...(field ? { details: [{ "@type": "type.googleapis.com/google.rpc.BadRequest", fieldViolations: [{ field, description: "not supported" }] }] } : {}) } }, 400);

/* A stand-in for Google: uploads work, and `judge(body)` may answer a generateContent request itself. */
function google(judge) {
  const requests = [];
  const fetch = async (url, init = {}) => {
    url = String(url);
    if (init.method === "DELETE") return json({});
    if (url.endsWith("/upload/v1beta/files")) return new Response("{}", { status: 200, headers: { "x-goog-upload-url": "https://generativelanguage.googleapis.com/upload/session/s1" } });
    if (url.endsWith("/upload/session/s1")) return json({ file: { name: "files/f1", uri: "https://generativelanguage.googleapis.com/v1beta/files/f1", state: "ACTIVE" } });
    const body = JSON.parse(init.body);
    const part = body.contents[0].parts[0];
    requests.push({ delivery: part.inlineData ? "inline" : "file", config: body.generationConfig?.audioTranscriptionConfig ?? null, omitted: !body.generationConfig });
    return judge?.(body, part) ?? reply("the transcript");
  };
  return { fetch, requests };
}
const chunk = (config) => ({ bytes: Buffer.alloc(2000), mimeType: "audio/mp3", seconds: 60, config });
const wanted = { vocabulary: ["partition", "ACID"], mode: "SMART" };

test("a rejected vocabulary is dropped, and the next chunk goes straight to the form that worked", async () => {
  const { fetch, requests } = google((body) => (body.generationConfig?.audioTranscriptionConfig?.customVocabulary ? invalid("generation_config.audio_transcription_config.custom_vocabulary") : undefined));
  const tiers = new GeminiTiers({ keys: { paid: PAID }, fetch });
  assert.equal((await tiers.transcribe(chunk(wanted))).text, "the transcript");
  assert.deepEqual(requests.map((r) => [r.delivery, !!r.config?.customVocabulary, r.config?.mode]),
    [["inline", true, "SMART"], ["file", true, "SMART"], ["file", false, "SMART"]], "inline first, then the documented file form, then without the vocabulary");
  assert.match(tiers.warnings.join(" "), /自定义词表/);
  requests.length = 0;
  await tiers.transcribe(chunk(wanted));
  assert.equal(requests.length, 1, "the working form is remembered");
  assert.deepEqual([requests[0].delivery, !!requests[0].config.customVocabulary], ["file", false]);
});

test("audio the model will not take inline is sent through the Files API instead", async () => {
  const { fetch, requests } = google((body, part) => (part.inlineData ? invalid("contents[0].parts[0].inline_data") : undefined));
  const tiers = new GeminiTiers({ keys: { paid: PAID }, fetch });
  await tiers.transcribe(chunk(wanted));
  assert.deepEqual(requests.map((r) => r.delivery), ["inline", "file"]);
  assert.deepEqual(requests[1].config, { customVocabulary: ["partition", "ACID"], mode: "SMART" }, "the options are kept when only the delivery was the problem");
  assert.match(tiers.warnings.join(" "), /接口不接受直接发送音频/);
  assert.doesNotMatch(tiers.warnings.join(" "), /词表/);
});

test("a rejected transcript style is dropped too, one option at a time", async () => {
  const { fetch, requests } = google((body) => (body.generationConfig?.audioTranscriptionConfig?.mode ? invalid() : undefined));
  const tiers = new GeminiTiers({ keys: { paid: PAID }, fetch });
  await tiers.transcribe(chunk(wanted));
  assert.deepEqual(requests.map((r) => [r.delivery, !!r.config?.customVocabulary, r.config?.mode ?? null]),
    [["inline", true, "SMART"], ["file", true, "SMART"], ["file", false, "SMART"], ["file", false, null]]);
  assert.match(tiers.warnings.join(" "), /自定义词表、转写风格设置/);
});

test("when every form is refused the error names the field Google objected to", async () => {
  const { fetch, requests } = google(() => invalid("generation_config.audio_transcription_config.language_codes"));
  const tiers = new GeminiTiers({ keys: { paid: PAID }, fetch });
  await assert.rejects(tiers.transcribe(chunk({ ...wanted, languageCodes: ["zh-CN"] })), (error) => {
    assert.ok(error instanceof GeminiError && error.fatal && error.status === 400);
    assert.match(error.message, /已按顺序试了 \d+ 种发送方式都不行/);
    assert.match(error.message, /Request contains an invalid argument\.（涉及字段 generation_config\.audio_transcription_config\.language_codes：not supported）/);
    return true;
  });
  assert.ok(requests.some((r) => r.omitted), "the last resort sends no transcription options at all");
  assert.ok(requests.length >= 6 && requests.length <= 8);
});

test("a rejected key, an empty balance and a dead network are not retried as plainer requests", async () => {
  for (const [status, body] of [[400, { error: { code: 400, status: "INVALID_ARGUMENT", message: "API key not valid.", details: [{ reason: "API_KEY_INVALID" }] } }], [402, { error: { message: "payment" } }]]) {
    const { fetch, requests } = google(() => json(body, status));
    await assert.rejects(new GeminiTiers({ keys: { paid: PAID }, fetch }).transcribe(chunk(wanted)));
    assert.equal(requests.length, 1);
  }
});

test("a Files API upload Google refuses falls back to sending the audio inline", async () => {
  const requests = [];
  const fetch = async (url, init = {}) => {
    url = String(url);
    if (init.method === "DELETE") return json({});
    if (url.endsWith("/upload/v1beta/files")) return invalid();
    requests.push(JSON.parse(init.body).contents[0].parts[0].inlineData ? "inline" : "file");
    return reply("inline worked");
  };
  const tiers = new GeminiTiers({ keys: { paid: PAID }, fetch });
  assert.equal((await tiers.transcribe(chunk({}))).text, "inline worked");
  assert.deepEqual(requests, ["inline"]);
});

test("a 400 spells out its status and the fields it names", () => {
  assert.equal(describeFailure(400, { error: { status: "INVALID_ARGUMENT", message: "Request contains an invalid argument." } }, "paid"),
    "Gemini 请求失败（400 INVALID_ARGUMENT）：Request contains an invalid argument.");
  assert.match(describeFailure(400, { error: { message: "bad", details: [{ fieldViolations: [{ field: "a.b", description: "no" }, { field: "c" }] }] } }, "paid"), /（涉及字段 a\.b：no；c）/);
});

test("a failed chunk says which chunk it was", async () => {
  const audio = { filename: "谷歌地图应用案例讲解.mp3", mimeType: "audio/mp3", chunks: [{ bytes: Buffer.alloc(3 * 1048576), seconds: 1500 }] };
  const tiers = { transcribe: async () => { throw new GeminiError("Request contains an invalid argument.", { status: 400 }); }, warnings: [] };
  await assert.rejects(runAudioImport({ audio, tiers, complete: async () => "{}", settings: { transcribeModel: "m", mode: "SMART", languageCodes: [], textProvider: "gemini", textModel: "t" } }),
    /^GeminiError: 转写第 1\/1 段（约 25 分钟，3\.0 MB）失败：Request contains an invalid argument\.$/);
});

/* ---- a Chinese recording ---- */

test("Chinese sentences split without spaces and join back unchanged", () => {
  const text = Array.from({ length: 60 }, (_, i) => `第${i}句讲的是谷歌地图的一个应用场景。`).join("");
  const paragraphs = paragraphize(text, 100);
  assert.ok(paragraphs.length > 5 && paragraphs.every((p) => p.length <= 160));
  assert.equal(paragraphs.join(""), text, "no spaces are inserted between Chinese sentences");
  assert.ok(cjkShare("谷歌地图应用案例讲解，Maps") > 0.5, "a Chinese sentence with a few English names is still Chinese");
  assert.equal(cjkShare("Google Maps API 123"), 0);
});

test("corrections work on Chinese text, but only when the wrong words can be located unambiguously", () => {
  const text = "今天讲公园地图怎么规划路线，还要讲公园地图的图层。";
  const result = applyCorrections(text, [
    { wrong: "公园", right: "谷歌", context: "今天讲公园地图怎么规划路线", confidence: "high", reason: "谷歌地图" },
    { wrong: "公园", right: "谷歌", context: "还要讲公园地图的图层，公园地图", confidence: "high" },
    { wrong: "的", right: "地", context: "地图的图层", confidence: "high" },
    { wrong: "路线", right: "线路", context: "怎么规划路线", confidence: "low" },
  ]);
  assert.equal(result.text, "今天讲谷歌地图怎么规划路线，还要讲公园地图的图层。");
  assert.deepEqual(result.skipped.map((s) => s.skipped), ["ambiguous", "too-short", "low-confidence"]);
  const twice = applyCorrections("讲公园地图和公园地图", [{ wrong: "公园", right: "谷歌", context: "讲公园地图和公园地图", confidence: "high" }]);
  assert.equal(twice.skipped[0].skipped, "ambiguous");
});

test("a Chinese recording is translated into English and laid out with the Chinese first", async () => {
  const systems = [];
  const complete = async (system, prompt) => {
    systems.push(system.slice(0, 80));
    if (system.startsWith("You proofread")) return '{"corrections":[]}';
    if (system.startsWith("You translate")) return JSON.stringify({ titleZh: "地图应用", titleEn: "Map Applications", paragraphs: JSON.parse(prompt).paragraphs.map((p) => ({ n: p.n, en: `EN ${p.n}` })) });
    return '{"titleEn":"Google Maps Application Cases"}';
  };
  const result = await finishTranscript({
    paragraphs: ["今天我们讲谷歌地图的应用案例。", "第一个案例是路线规划。"], filename: "谷歌地图应用案例讲解.mp3", complete,
    settings: {}, saved: checkpoints(), keys: { raw: "r", text: "t" },
  });
  assert.ok(systems.some((s) => s.startsWith("You translate paragraphs of a Chinese lecture")), "Chinese speech is translated into English");
  const [document] = result.documents;
  assert.match(document, /《谷歌地图应用案例讲解\.mp3》全量中英对照逐字稿\nFull Bilingual Transcript: Google Maps Application Cases/);
  assert.match(document, /【第一部分：地图应用】\n\[Part 1: Map Applications\]\n\n【中文原文】\n今天我们讲谷歌地图的应用案例。\n\n第一个案例是路线规划。\n\n【英文对照】\nEN 1\n\nEN 2/);
  assert.ok(!document.includes("【英文原句】"));
  const english = buildDocuments({ filename: "a.mp3", titleEn: "T", parts: [{ titleZh: "题", titleEn: "T", english: ["Hello."], chinese: ["你好。"] }] })[0];
  assert.match(english, /【英文原句】\nHello\.\n\n【中文对照】\n你好。/);
});

/* ---- a 400 in a text step must not sink an import whose paid transcription already succeeded ---- */

test("a text request Google rejects is asked again in the plainest form", async () => {
  const bodies = [];
  const fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    bodies.push(body);
    return body.generationConfig ? invalid() : reply('{"ok":true}');
  };
  const tiers = new GeminiTiers({ keys: { paid: PAID }, fetch });
  assert.equal(await tiers.complete("gemini-3.8-flash", "system", "prompt", { thinkingLevel: "low", maxOutputTokens: 100 }), '{"ok":true}');
  assert.equal(bodies.length, 3, "full, without thinking, then plain");
  assert.equal(bodies.at(-1).generationConfig, undefined);
  assert.ok(bodies.at(-1).systemInstruction && bodies.at(-1).contents);
  const failing = new GeminiTiers({ keys: { paid: PAID }, fetch: async () => invalid() });
  await assert.rejects(failing.complete("gemini-3.8-flash", "s", "p"), (error) => error.status === 400 && !error.fatal, "a rejected parameter is not fatal to the job");
});

test("a rejected proofreading step keeps the transcript and warns; a rejected translation names its part", async () => {
  const paragraphs = ["Partitioning splits one big table into smaller physical pieces."];
  const base = { paragraphs, filename: "lecture.mp3", settings: {}, saved: checkpoints(), keys: { raw: "r", text: "t" } };
  const warnings = [];
  const answer = (rejectProofread) => async (system, prompt) => {
    if (system.startsWith("You proofread")) { if (rejectProofread) throw new GeminiError("Request contains an invalid argument.", { status: 400 }); return '{"corrections":[]}'; }
    if (system.startsWith("You translate")) return JSON.stringify({ titleZh: "分区", titleEn: "Partitioning", paragraphs: JSON.parse(prompt).paragraphs.map((p) => ({ n: p.n, zh: "分区把大表拆成小块。" })) });
    return '{"titleEn":"Lecture"}';
  };
  const done = await finishTranscript({ ...base, complete: answer(true), warn: (text) => warnings.push(text) });
  assert.match(done.documents[0], /【英文原句】\nPartitioning splits one big table/);
  assert.match(warnings[0], /第 1 段校对失败，这一段保留原转写/);

  const translate = async (system, prompt) => {
    if (system.startsWith("You translate")) throw new GeminiError("Request contains an invalid argument.", { status: 400 });
    return answer(false)(system, prompt);
  };
  await assert.rejects(finishTranscript({ ...base, complete: translate }), /翻译第 1\/1 部分失败：Request contains an invalid argument\./);
});
