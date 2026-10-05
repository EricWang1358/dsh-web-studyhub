import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import { build } from "esbuild";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

/* Audio onboarding in the panel (P44–P49): a setup gate instead of the drop zone, per-file pre-flight with one-click
   fixes, plain errors where the learner looks, one card per provider in settings, a usage console that waits for the
   first transcription, and a live class that checks its provider before asking for the microphone. */

const compiled = await build({
  stdin: { contents: `export { default as AudioImport } from './ui/AudioImport.jsx'; export { AudioJobs, textStepsRan } from './ui/audio/AudioJobs.jsx'; export { preflightNotes } from './ui/audio/preflight.js';
    export { default as AudioSettings, AudioSetupGate, providerOrder } from './ui/AudioSettings.jsx';
    export { default as AudioDashboard, AudioDashboardPanel, dashboardVisible } from './ui/AudioDashboard.jsx';
    export { default as LiveClass } from './ui/LiveClass.jsx';
    export { describeCaptureError, captureAudio } from './ui/live-audio.js';
    export { setUiLanguage, uiMessage } from './ui/i18n.js';`, resolveDir: process.cwd() },
  bundle: true, write: false, platform: "node", format: "cjs", external: ["react"], loader: { ".json": "json", ".css": "text" },
});
const module = { exports: {} };
new Function("require", "module", "exports", compiled.outputFiles[0].text)(createRequire(import.meta.url), module, module.exports);
const { AudioImport, AudioJobs, preflightNotes, textStepsRan, AudioSettings, AudioSetupGate, providerOrder,
  AudioDashboardPanel, dashboardVisible, LiveClass, describeCaptureError, captureAudio, setUiLanguage, uiMessage } = module.exports;

const HAN = /[\u3400-\u9fff]/;
const noop = () => {};
const data = { root: "lib", decks: [], jobs: [], focus: { course: "", courses: [] } };
const NOT_READY = { transcription: false, text: true, live: false, reason: "no-provider", first: null, providers: { free: false, siliconflow: false, groq: false, paid: false } };
const READY = { transcription: true, text: true, live: false, reason: null, first: "siliconflow", providers: { free: false, siliconflow: true, groq: false, paid: false } };
const html = (Component, props) => renderToStaticMarkup(React.createElement(Component, props));
const inLanguage = (language, run) => { try { setUiLanguage(language); return run(); } finally { setUiLanguage("zh"); } };

test("with no transcription provider the audio tab shows a setup card instead of the drop zone (zh: SiliconFlow first)", () => {
  const page = html(AudioImport, { data, busy: false, act: noop, call: noop, setNotice: noop, initialReadiness: NOT_READY, onOpenSettings: noop });
  assert.match(page, /转写服务还没配置 · 约 2 分钟/);
  assert.match(page, /硅基流动/);
  assert.match(page, /免费 · 国内直连/);
  assert.match(page, /href="https:\/\/cloud\.siliconflow\.cn"/);
  assert.match(page, /打开音频设置/);
  assert.doesNotMatch(page, /把音频文件拖到这里/, "no audio drop zone before a provider is configured");
  assert.match(page, /字幕/, "subtitles need no transcription and stay available");
  assert.match(page, /accept="\.srt,\.vtt,\.json,\.txt"/);
});

test("in English the setup card recommends Groq or Gemini free, fully translated", () => inLanguage("en", () => {
  const page = html(AudioImport, { data, busy: false, act: noop, call: noop, setNotice: noop, initialReadiness: NOT_READY, onOpenSettings: noop });
  assert.match(page, /Transcription is not set up yet · about 2 minutes/);
  assert.match(page, /Groq/);
  assert.match(page, /href="https:\/\/console\.groq\.com\/keys"/);
  assert.match(page, /aistudio\.google\.com/);
  assert.match(page, /Open audio settings/);
  assert.doesNotMatch(page, HAN);
}));

test("the setup card offers the recommended key right there, and the full settings as a second way", () => {
  const gate = html(AudioSetupGate, { language: "zh", onOpenSettings: noop, call: noop });
  assert.match(gate, /type="password"/);
  assert.match(gate, /保存并验证/);
  assert.equal((gate.match(/sh-btn--primary/g) || []).length, 1, "one primary action");
});

test("once a provider is ready the drop zone is back", () => {
  const page = html(AudioImport, { data, busy: false, act: noop, call: noop, setNotice: noop, initialReadiness: READY });
  assert.match(page, /把音频文件拖到这里，或点击选择/);
  assert.doesNotMatch(page, /转写服务还没配置/);
});

const files = [{ key: "pe1", kind: "upload", uploadId: "u1", name: "PE1.m4a", size: 70e6 }, { key: "a", kind: "upload", uploadId: "u2", name: "A.mp3", size: 9e6 }, { key: "b", kind: "upload", uploadId: "u3", name: "B.mp3", size: 9e6 }];
const longSplit = { name: "PE1.m4a", format: "m4a", seconds: 4560, parts: 2, requests: 2, blocked: false, issue: { code: "long-split", minutes: 76, parts: 2, requests: 2 } };
const fine = (name) => ({ name, format: "mp3", seconds: 1800, parts: 1, requests: 1, blocked: false, issue: null });
const broken = { name: "PE1.m4a", blocked: true, issue: { code: "AUDIO_UNSPLITTABLE", message: "这份 M4A 是分片格式（fragmented MP4），不能在本地无损切分" } };

test('pre-flight notes show the configured request duration for recordings below one hour', () => {
  const check = { ...longSplit, issue: { code: 'long-split', minutes: 45, parts: 3, requests: 3, partMinutes: 20 } };
  const zh = preflightNotes(files, { pe1: check }).pe1.text;
  assert.match(zh, /20/);
  assert.doesNotMatch(zh, /1 小时/);
  inLanguage('en', () => {
    const en = preflightNotes(files, { pe1: check }).pe1.text;
    assert.match(en, /20/);
    assert.doesNotMatch(en, /one.hour|1 hour/);
  });
});

test("pre-flight notes: a long recording offers a lossless split, its siblings say what they wait for", () => {
  const notes = preflightNotes(files, { pe1: longSplit, a: fine("A.mp3"), b: fine("B.mp3") }, new Set());
  assert.equal(notes.pe1.kind, "split");
  assert.equal(notes.pe1.text, "约 76 分钟 → 无损分成 2 段转写（占用 2 次请求）");
  assert.deepEqual([notes.a.kind, notes.a.text], ["waiting", "等待「PE1.m4a」处理"]);
  const confirmed = preflightNotes(files, { pe1: longSplit, a: fine("A.mp3"), b: fine("B.mp3") }, new Set(["pe1"]));
  assert.equal(confirmed.pe1.kind, "split-confirmed");
  assert.equal(confirmed.a.kind, "ok");
  const blocked = preflightNotes(files, { pe1: broken, a: fine("A.mp3"), b: fine("B.mp3") }, new Set());
  assert.equal(blocked.pe1.kind, "blocked");
  assert.deepEqual([blocked.b.kind, blocked.b.text], ["held", "因「PE1.m4a」未通过预检尚未开始"]);
});

test("the chosen files show their pre-flight with one-click fixes, in both languages", () => {
  const props = { data, busy: false, act: noop, call: noop, setNotice: noop, initialReadiness: READY, initialFiles: files };
  const split = html(AudioImport, { ...props, initialChecks: { pe1: longSplit, a: fine("A.mp3"), b: fine("B.mp3") } });
  assert.match(split, /无损分成 2 段转写（占用 2 次请求）/);
  assert.match(split, /分段并继续/);
  assert.match(split, /等待「PE1.m4a」处理/);
  const held = html(AudioImport, { ...props, initialChecks: { pe1: broken, a: fine("A.mp3"), b: fine("B.mp3") } });
  assert.match(held, /跳过此文件继续/);
  assert.match(held, /换一个文件/);
  assert.match(held, /因「PE1.m4a」未通过预检尚未开始/);
  inLanguage("en", () => {
    const english = html(AudioImport, { ...props, initialChecks: { pe1: longSplit, a: fine("A.mp3"), b: fine("B.mp3") } }).replace(/PE1\.m4a|A\.mp3|B\.mp3/g, "");
    assert.match(english, /about 76 min → split losslessly into 2 parts \(2 requests\)/);
    assert.match(english, /Split and continue/);
    assert.doesNotMatch(english, HAN);
    const blocked = html(AudioImport, { ...props, initialChecks: { pe1: broken, a: fine("A.mp3"), b: fine("B.mp3") } }).replace(/PE1\.m4a|A\.mp3|B\.mp3/g, "");
    assert.match(blocked, /This M4A is a fragmented MP4 and cannot be split losslessly here/);
    assert.match(blocked, /Skip this file and continue/);
    assert.doesNotMatch(blocked, HAN);
  });
});

const batch = { type: "audio-import", id: "b1", status: "failed", batchId: "batch-1", filename: "Week 5", phase: "batch", retryable: true, warnings: [],
  stage: "「PE1.mp3」未通过预检，其余文件尚未开始；可以跳过它继续", blocked: { index: 1, filename: "PE1.mp3" },
  members: [{ index: 0, filename: "A.wav", status: "waiting", waitingFor: "PE1.mp3" }, { index: 1, filename: "PE1.mp3", status: "blocked", stage: "没有在文件里找到可识别的 MP3 音频帧" },
    { index: 2, filename: "B.wav", status: "waiting", waitingFor: "PE1.mp3" }] };

test("a batch held by one file says why each sibling has not started and offers to skip it or continue after fixing", () => {
  const acted = [];
  const card = html(AudioJobs, { data: { jobs: [batch] }, busy: false, act: (...args) => acted.push(args) });
  assert.match(card, /因「PE1.mp3」未通过预检尚未开始/);
  assert.match(card, /未通过预检：没有在文件里找到可识别的 MP3 音频帧/);
  assert.match(card, /跳过此文件继续/);
  assert.match(card, /修复后继续/);
  assert.doesNotMatch(card, /已取消/, "no sibling is reported as cancelled");
  inLanguage("en", () => {
    const english = html(AudioJobs, { data: { jobs: [{ ...batch, stage: "\"PE1.mp3\" did not pass the pre-flight check; the other files have not started. You can skip it and continue",
      members: batch.members.map((member) => member.status === "blocked" ? { ...member, stage: "No recognizable MP3 frames were found in the file" } : member) }] }, busy: false, act: noop })
      .replace(/PE1\.mp3|A\.wav|B\.wav|Week 5/g, "");
    assert.match(english, /Not started: waiting for/);
    assert.match(english, /Skip this file and continue/);
    assert.match(english, /Continue after fixing/);
    assert.doesNotMatch(english, HAN);
  });
});

test("the 'proofread by the DSH model' footer appears only when those steps ran; SiliconFlow has its own usage line", () => {
  const base = { type: "audio-import", id: "j", status: "failed", filename: "x.m4a", phase: "transcribe", textProvider: "host", warnings: [],
    usage: { free: { requests: 0 }, siliconflow: { requests: 2, audioSeconds: 4560 }, groq: { requests: 0 }, paid: { requests: 0 } } };
  const notRun = html(AudioJobs, { data: { jobs: [base] }, busy: false, act: noop });
  assert.doesNotMatch(notRun, /校对和翻译由 DSH 的模型完成/);
  assert.equal(textStepsRan(base), false);
  const ran = { ...base, status: "complete", phase: "done", sourceIds: ["s"], steps: { transcribe: { done: 2, total: 2 }, proofread: { done: 3, total: 3 }, translate: { done: 2, total: 2 } } };
  assert.equal(textStepsRan(ran), true);
  assert.match(html(AudioJobs, { data: { jobs: [ran] }, busy: false, act: noop }), /校对和翻译由 DSH 的模型完成/);
  assert.match(notRun, /硅基流动请求（免费，这份录音累计）：2 次/);
  assert.equal(textStepsRan({ members: [{ steps: { proofread: { done: 1, total: 4 } } }] }), true);
});

const view = {
  freeKey: { set: false, hint: "" }, paidKey: { set: true, hint: "••••PAID" }, groqKey: { set: false, hint: "" }, siliconflowKey: { set: true, hint: "••••0004" },
  settingsFile: "D:\\Users\\me\\.dsh-test\\study\\audio.json", textProvider: "auto", mode: "SMART", partMinutes: 59, textConcurrency: 3,
  proofreadReasoning: "default", translateReasoning: "low", transcribeModel: "gemini-3.5-transcribe", textModel: "gemini-3.8-flash",
  groqTranscribeModel: "whisper-large-v3", groqTextModel: "openai/gpt-oss-120b", siliconflowTranscribeModel: "FunAudioLLM/SenseVoiceSmall",
  liveModel: "live", liveTranslateModel: "lite", liveCorrectionReasoning: "low", dailyLimits: {},
};

test("audio settings: one card per provider, SiliconFlow first in Chinese, real links, the real storage path, an anchor for the tour", () => {
  const page = html(AudioSettings, { busy: false, act: noop, call: noop, setNotice: noop, initialView: view });
  assert.match(page, /data-tour="settings-audio"/);
  const at = (text) => page.indexOf(text);
  assert.ok(at("硅基流动 SenseVoice") > 0 && at("硅基流动 SenseVoice") < at("Groq Whisper") && at("Groq Whisper") < at("Google Gemini"), "zh order: SiliconFlow, Groq, Gemini");
  for (const link of ["https://cloud.siliconflow.cn", "https://console.groq.com/keys", "https://aistudio.google.com/apikey"]) assert.ok(page.includes(`href="${link}"`), link);
  assert.match(page, /已保存 ••••0004/);
  assert.ok(page.includes("D:\\Users\\me\\.dsh-test\\study\\audio.json"), "the path the keys are really stored at");
  assert.doesNotMatch(page, /~\/\.dsh\/study\/audio\.json/);
  assert.ok(at("高级") > at("Google Gemini"), "advanced comes after the provider cards");
  for (const text of ["校对与翻译的推理强度", "付费密钥", "转写模型", "校对与翻译的并行数"]) assert.ok(at(text) > at("高级"), `${text} is under 高级`);
  assert.equal((page.match(/name="audio-key"/g) || []).length, 4, "one key field per provider, the paid key under advanced");
  assert.deepEqual(providerOrder("zh"), ["siliconflow", "groq", "free"]);
  assert.deepEqual(providerOrder("en"), ["groq", "free", "siliconflow"]);
});

test("audio settings in English are complete, with Groq first", () => inLanguage("en", () => {
  const page = html(AudioSettings, { busy: false, act: noop, call: noop, setNotice: noop, initialView: view });
  const at = (text) => page.indexOf(text);
  assert.ok(at("Groq Whisper") < at("Google Gemini") && at("Google Gemini") < at("SiliconFlow SenseVoice"));
  for (const text of ["Reasoning strength of proofreading and translation", "Save and verify", "Advanced"]) assert.ok(page.includes(text), text);
  assert.doesNotMatch(page.replace(/D:\\Users\\me\\\.dsh-test\\study\\audio\.json/, ""), HAN);
}));

test("each reasoning setting has one control (no presets, no matrix beside the selects)", () => {
  const page = html(AudioSettings, { busy: false, act: noop, call: noop, setNotice: noop, initialView: view });
  assert.equal((page.match(/<select/g) || []).length >= 2, true);
  assert.equal((page.match(/校对与翻译的推理强度/g) || []).length, 1, "one reasoning section");
  assert.doesNotMatch(page, /audio-reasoning-grid|更快|更准/);
});

test("no audio text is set below 12 px", async () => {
  for (const file of ["ui/audio-dashboard.css", "ui/audio-settings.css", "ui/live-class.css"]) {
    const css = await readFile(file, "utf8");
    for (const [, size] of css.matchAll(/font-size:\s*(\d+(?:\.\d+)?)px/g)) assert.ok(Number(size) >= 12, `${file}: ${size}px`);
  }
});

test("the usage console waits for the first transcription and starts collapsed", () => {
  const usage = { since: null, providers: [], trend: [], timings: [] };
  assert.equal(dashboardVisible({ freeKey: { set: false }, siliconflowKey: { set: false }, groqKey: { set: false }, paidKey: { set: false } }, { ...usage, since: 1 }), false, "nothing configured: the setup card replaces it");
  assert.equal(dashboardVisible(view, usage), false, "configured but nothing transcribed yet");
  assert.equal(dashboardVisible(view, { ...usage, since: Date.now() - 1000 }), true);
  const providers = ["free", "groq", "paid", "siliconflow"].map((tier) => ({ tier, configured: tier === "siliconflow", today: { requests: tier === "siliconflow" ? 3 : 0, success: 0, failures: 0, limited: 0, inputTokens: 0, outputTokens: 0, outputUnknown: 0, audioSeconds: 0 }, total: {}, models: [] }));
  const panel = html(AudioDashboardPanel, { data: { since: 1, providers, trend: [], timings: [] }, settings: view, busy: false, refresh: noop, save: noop });
  assert.match(panel, /<details[^>]*class="[^"]*audio-usage-panel/);
  assert.doesNotMatch(panel.match(/<details[^>]*>/)[0], /open/, "collapsed");
  assert.match(panel, /今日 3 次请求/);
});

test("live class checks its provider before the microphone: without Gemini the form is replaced by a setup card", () => {
  const props = { data: { root: "r", focus: { course: "", courses: [] } }, call: noop, visible: true, onSettings: noop };
  const gated = html(LiveClass, { ...props, initialReadiness: { live: false } });
  assert.match(gated, /课堂实录需要 Gemini 密钥/);
  assert.match(gated, /aistudio\.google\.com\/apikey/);
  assert.doesNotMatch(gated, /开始实录/, "the start button (and so the microphone prompt) is not reachable");
  assert.match(html(LiveClass, { ...props, initialReadiness: { live: true } }), /开始实录/);
  inLanguage("en", () => {
    const english = html(LiveClass, { ...props, initialReadiness: { live: false } });
    assert.match(english, /Live class needs a Gemini key/);
    assert.doesNotMatch(english, HAN);
  });
});

test("microphone and tab-sharing failures become localized guidance", async () => {
  const named = (name, message = "Not supported") => Object.assign(new Error(message), { name });
  assert.match(describeCaptureError(named("NotAllowedError", "Permission denied"), "microphone").message, /没有允许使用麦克风/);
  assert.match(describeCaptureError(named("NotFoundError"), "microphone").message, /没有找到麦克风/);
  assert.match(describeCaptureError(named("NotSupportedError"), "tab").message, /Chrome 或 Edge/);
  assert.match(describeCaptureError(named("NotReadableError"), "microphone").message, /被其他程序占用/);
  assert.match(describeCaptureError(named("NotAllowedError"), "tab").message, /取消了共享|没有允许共享/);
  const plain = new Error("Permission denied");
  assert.equal(describeCaptureError(plain, "microphone"), plain, "unknown errors pass through unchanged");
  // The live class shows these through uiMessage(), which translates them.
  inLanguage("en", () => {
    for (const name of ["NotAllowedError", "NotFoundError", "NotSupportedError", "NotReadableError", "AbortError", "OverconstrainedError", "SecurityError", "TypeError"])
      for (const kind of ["microphone", "tab"]) assert.doesNotMatch(uiMessage(describeCaptureError(named(name), kind).message), HAN, `${name} ${kind}`);
  });
  const saved = Object.getOwnPropertyDescriptor(globalThis, "navigator"), savedContext = globalThis.AudioContext;
  try {
    Object.defineProperty(globalThis, "navigator", { configurable: true, value: { mediaDevices: { getUserMedia: async () => { throw named("NotSupportedError"); } } } });
    globalThis.AudioContext = function AudioContext() {};
    await assert.rejects(captureAudio("microphone", noop), (error) => /Chrome 或 Edge/.test(error.message) && error.message !== "Not supported");
  } finally {
    if (saved) Object.defineProperty(globalThis, "navigator", saved); else delete globalThis.navigator;
    if (savedContext) globalThis.AudioContext = savedContext; else delete globalThis.AudioContext;
  }
});
