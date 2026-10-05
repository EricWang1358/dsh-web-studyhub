import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { build } from "esbuild";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

const compiled = await build({
  stdin: { contents: `export { default as AudioImport } from './ui/AudioImport.jsx'; export { AudioCorrections } from './ui/audio/AudioCorrections.jsx'; export { AudioJobs, audioProgress } from './ui/audio/AudioJobs.jsx'; export { usageLine } from './ui/tasks/task-facts.js'; export { setUiLanguage } from './ui/i18n.js';`, resolveDir: process.cwd() },
  bundle: true, write: false, platform: "node", format: "cjs", external: ["react"], loader: { ".json": "json", ".css": "text" },
});
const module = { exports: {} };
new Function("require", "module", "exports", compiled.outputFiles[0].text)(createRequire(import.meta.url), module, module.exports);
const { AudioImport, AudioCorrections, AudioJobs, audioProgress, usageLine, setUiLanguage } = module.exports;

const usage = (free, paid, usd = 0) => ({ free: { requests: free, audioSeconds: 0 }, paid: { requests: paid, audioSeconds: paid * 60 }, estimatedPaidTranscribeUsd: usd });
const job = (extra) => ({ type: "audio-import", id: extra.status, filename: "lecture.mp3", phase: "transcribe", done: 0, total: 3, minutes: 12.5, warnings: [], ...extra });
const data = { decks: [{ course: "数据库" }], jobs: [
  job({ status: "running", estimatedUsd: 0.06 }),
  job({ status: "complete", phase: "done", sourceIds: ["a"], corrected: 4, uncertain: 2, usage: usage(6, 2, 0.01) }),
  job({ status: "failed", stage: "server says no" }),
  job({ status: "cancelled" }),
] };
const render = (extra = {}) => renderToStaticMarkup(React.createElement(AudioImport, { data, busy: false, act() {}, setNotice() {}, ...extra }));
const chosen = { kind: "upload", uploadId: "u1", name: "lecture.mp3", size: 45 * 1024 * 1024 };
const audio = { corrections: { appliedCount: 1, applied: [{ wrong: "patient", right: "partition", reason: "why", context: "into a patient by date" }],
  skipped: [{ wrong: "unit", right: "init", context: "business unit of work", skipped: "low-confidence" }] } };

test('multiple audio inputs expose ordered removal, keyboard sorting, a transcript name and multi-course ownership', () => {
  try {
    setUiLanguage('en');
    const html = render({ initialFiles: [chosen, { kind: 'path', path: '/A.wav', name: 'A.wav' }], defaultCourses: ['Biology', 'Medicine'] });
    assert.match(html, /Transcript name/);
    assert.match(html, /Move A.wav up/);
    assert.match(html, /Remove lecture.mp3/);
    assert.match(html, /Biology; Medicine/);
    assert.match(html, /multiple=""/);
    assert.doesNotMatch(html.replace(/lecture\.mp3|数据库|server says no/g, ''), /[㐀-鿿]/);
  } finally { setUiLanguage('zh'); }
});

test('batch progress includes every member and offers the exact completed transcript', () => {
  const batch = job({ status: 'failed', batchId: 'batch-one', filename: 'Week 3', phase: 'batch', retryable: true,
    members: [{ filename: 'B.wav', status: 'complete' }, { filename: 'A.wav', status: 'failed', phase: 'translate' }] });
  assert.equal(audioProgress(batch).percent, 77);
  const html = renderToStaticMarkup(React.createElement(AudioJobs, { data: { jobs: [{ ...batch, status: 'complete', sourceIds: ['source-batch'] }] }, act() {}, onOpenSources() {} }));
  assert.match(html, /Week 3/);
  assert.match(html, /打开逐字稿/);
  assert.equal((html.match(/class="cjc[ "]/g) || []).length, 1, 'one card for the whole batch; its files are rows in the console');
});

test('batch audio is one compact card whatever the number of tasks behind it', () => {
  const now = Date.now(), at = n => new Date(now - n * 1000).toISOString();
  const tasks = Array.from({ length: 16 }, (_, index) => ({ id: `task-${index}`, childId: `child-${index}`,
    kind: 'proofread', part: index + 1, parts: 30, runtime: 'subagent', startedAt: at(30),
    status: index < 12 ? 'complete' : index === 12 ? 'failed' : 'running',
    ...(index < 13 ? { finishedAt: at(5) } : {}), ...(index === 12 ? { note: 'Rate limit' } : {}) }));
  const batch = job({ status: 'running', filename: 'API应用与产品策略培训.mp3 + 4', phase: 'batch',
    members: [{ filename: 'API应用与产品策略培训.mp3', status: 'running', phase: 'proofread', tasks,
      steps: { transcribe: { done: 1, total: 1 }, proofread: { done: 10, total: 30 } } },
      ...Array.from({ length: 4 }, (_, index) => ({ filename: `queued-${index}.mp3`, status: 'queued', phase: 'queued' }))] });
  const renderBatch = () => renderToStaticMarkup(React.createElement(AudioJobs, { data: { jobs: [batch] }, act() {}, openAgent() {} }));
  try {
    setUiLanguage('zh');
    const html = renderBatch();
    assert.equal((html.match(/class="cjc[ "]/g) || []).length, 1);
    assert.match(html, /正在校对 \d+\/30/, 'what runs now, from the calls in flight');
    assert.match(html, /查看详情/);
    assert.doesNotMatch(html, /查看历史任务|查看子代理|正在执行 3 个任务|<details/, 'the tasks and their sub-agents are in the console');
    setUiLanguage('en');
    const english = renderBatch().replaceAll('API应用与产品策略培训.mp3', 'lecture.mp3');
    assert.doesNotMatch(english, /[\u3400-\u9fff]/);
    assert.match(english, /View details/);
  } finally { setUiLanguage('zh'); }
});

test('a legacy failed recording remains visible with a same-file selection action', () => {
  const legacy = job({ id: 'old', status: 'failed', stage: '旧版任务没有保存原文件位置', legacy: true, relinkable: true, retryable: false });
  const html = renderToStaticMarkup(React.createElement(AudioJobs, { data: { jobs: [legacy] }, busy: false, act() {}, onLegacyRetry() {} }));
  assert.match(html, /重新选择原录音继续/);
  assert.doesNotMatch(html, /看原因并继续/);
  assert.match(render({ data: { ...data, jobs: [legacy] }, recoveryJobId: legacy.id }), /正在接续旧版失败任务/);
});

test("English audio import copy is fully translated and keeps user content as written", () => {
  try {
    setUiLanguage("en");
    const html = render().replace(/lecture\.mp3|数据库|server says no/g, "");
    assert.doesNotMatch(html, /[㐀-鿿]/);
    const reviewed = renderToStaticMarkup(React.createElement(AudioJobs, { data: { jobs: [
      job({ status: 'complete', review: { applied: 1, rejected: 2, unsure: 3 } }),
      job({ id: 'subtitle', status: 'running', subtitle: true, phase: 'proofread' }),
    ] }, busy: false, act() {} })).replace(/lecture\.mp3/g, '');
    assert.doesNotMatch(reviewed, /[㐀-鿿]/);
    assert.match(reviewed, /Review complete: 1 correction\(s\) applied/);
    for (const text of ["Audio / recording", "Saved as 1 source(s) · 4 correction(s)", "2 doubtful word(s) were left unchanged; see them in the source", "Stopped", "View details",
      "Drop an audio file here, or click to choose", "Up to 512 MB",
      "Find in the workspace", "Paste a file path (advanced)"])
      assert.ok(html.includes(text), text);
    const picked = render({ initialFile: chosen }).replace(/lecture\.mp3|数据库|server says no/g, "");
    assert.doesNotMatch(picked, /[㐀-鿿]/);
    for (const text of ["Start import", "Use the paid key only", "45 MB · Uploaded", "Change"]) assert.ok(picked.includes(text), text);
    assert.ok(!picked.includes("Drop an audio file"), "once a file is chosen the drop zone gives way to the options");
    assert.ok(!html.includes("Pick a file with @"), "no @ button when the host cannot fill the composer");
    const asking = render({ canAsk: true, askInChat() {} });
    assert.ok(asking.includes("Pick a file with @ in the conversation"));
    assert.doesNotMatch(asking.replace(/lecture\.mp3|数据库|server says no/g, ""), /[㐀-鿿]/);
    assert.ok(render({ initialFile: chosen }).includes("数据库") && render().includes("lecture.mp3"), "course and file names stay in their own language");
    assert.doesNotMatch(renderToStaticMarkup(React.createElement(AudioCorrections, { audio })), /[㐀-鿿]/);
    setUiLanguage("zh");
    assert.match(render(), /转写 \d|转写音频|查看详情/);
    assert.match(render(), /把音频文件拖到这里，或点击选择/);
    assert.match(render({ initialFile: chosen }), /45 MB · 已上传/);
    assert.match(render(), /已存为 1 份资料 · 校对修正 4 处/);
  } finally { setUiLanguage("zh"); }
});

test("only audio jobs are listed, and nothing renders when there are none", () => {
  assert.equal(renderToStaticMarkup(React.createElement(AudioJobs, { data: { jobs: [{ type: "draft-repair", id: "x", status: "running" }] }, busy: false, act() {} })), "");
  const html = renderToStaticMarkup(React.createElement(AudioJobs, { data, busy: false, act() {} }));
  assert.equal(html.match(/class="cjc[ "]/g).length, 4);
});

test('audio imports show the source-page course, including source-only courses and explicit unassigned', () => {
  const props = { data: { ...data, focus: { course: 'A', courses: [{ name: 'A' }, { name: 'B' }] } }, initialFile: chosen };
  // WP14: a value that names an existing course has no datalist (it would hide the quick picks).
  assert.match(render({ ...props, defaultCourse: 'B' }), /<input[^>]*value="B"/);
  assert.match(render({ ...props, defaultCourse: '' }), /<input[^>]*list="[^"]*"[^>]*value=""/);
});

test("the corrections list shows applied edits and, separately, the doubtful ones", () => {
  const html = renderToStaticMarkup(React.createElement(AudioCorrections, { audio }));
  assert.match(html, /patient → partition/);
  assert.match(html, /unit → init/);
  assert.equal(renderToStaticMarkup(React.createElement(AudioCorrections, { audio: { corrections: { applied: [], skipped: [] } } })), "");
});

test("a failed import says why on its card and offers the way on; what is saved is in the console", () => {
  const failed = { type: "audio-import", id: "f1", status: "failed", filename: "lecture.mp3", phase: "translate", done: 0, total: 8, minutes: 47.8,
    stage: "翻译第 1/8 部分失败：boom", retryable: true, warnings: [],
    steps: { transcribe: { done: 1, total: 1 }, proofread: { done: 5, total: 5 }, translate: { done: 0, total: 8 } } };
  const html = (job) => renderToStaticMarkup(React.createElement(AudioJobs, { data: { jobs: [job] }, busy: false, act() {} }));
  try {
    setUiLanguage("zh");
    assert.match(html(failed), /翻译第 1\/8 部分失败：boom/);
    assert.match(html(failed), /看原因并继续/);
    assert.match(usageLine({ ...failed, usage: usage(1, 0) }), /Gemini 请求：免费 1 · 付费 0/);
    setUiLanguage("en");
    const english = html(failed).replace(/lecture\.mp3|翻译第 1\/8 部分失败：boom/g, "");
    assert.doesNotMatch(english, /[\u3400-\u9fff]/);
    assert.ok(english.includes("See why and continue"));
    assert.ok(!html({ ...failed, retryable: false }).includes("See why and continue"), "no button when there is nothing to resume");
    assert.ok(!html({ ...failed, status: "complete", sourceIds: ["a"], corrected: 0 }).includes("See why and continue"), "and none on a finished import");
    assert.ok(html({ ...failed, status: "cancelled" }).includes("See why and continue"), "a cancelled import can be continued too");
  } finally { setUiLanguage("zh"); }
});

test("progress is counted from the real steps; the moving segment shows only while work is under way", () => {
  const at = (steps, phase, extra = {}) => ({ status: "running", phase, steps, ...extra });
  assert.deepEqual(audioProgress(at({ transcribe: { done: 0, total: 1 } }, "transcribe")), { percent: 0, flight: 25, eta: null }, "one long request: nothing finished, the whole quarter is moving");
  const proofreading = at({ transcribe: { done: 1, total: 1 }, proofread: { done: 1, total: 5 } }, "proofread", { pace: { proofread: { at: 1000, each: 40000 } } });
  const now = audioProgress(proofreading, 11000);
  assert.equal(now.percent, 31, "25 for the transcription plus a fifth of the proofreading's 30");
  assert.ok(Math.abs(now.flight - 6) < 1e-9, "the segment in hand is worth a fifth of 30");
  assert.equal(now.eta, 30000 + 3 * 40000, "30 s left on this segment, three more at 40 s");
  assert.equal(audioProgress(proofreading, 101000).eta, 4000 + 3 * 40000, "a segment that overruns is not counted as done");
  assert.equal(audioProgress(at(proofreading.steps, "proofread"), 11000).eta, null, "no estimate before a segment has taken real time");
  assert.deepEqual(audioProgress({ ...proofreading, status: "failed" }, 11000), { percent: 31, flight: 0, eta: null });
  assert.equal(audioProgress({ status: "complete" }).percent, 100);
  assert.equal(audioProgress(at({ translate: { done: 0, total: 8 } }, "translate")).percent, 55, "phases before the one being worked on count as done");
  assert.equal(audioProgress(at({ transcribe: { done: 1, total: 1 }, proofread: { done: 5, total: 5 }, translate: { done: 7, total: 8 } }, "translate")).percent, 94);
  assert.ok(audioProgress(at({ transcribe: { done: 1, total: 1 }, proofread: { done: 5, total: 5 }, translate: { done: 7, total: 8 } }, "translate")).flight <= 5.7);
});

test("a running import shows the percent, the bar and what runs now; the sub-agent behind it is in the console", () => {
  const minutesAgo = (n) => new Date(Date.now() - n * 60000).toISOString();
  const running = job({ status: "running", phase: "proofread", done: 1, total: 5, startedAt: minutesAgo(3),
    steps: { transcribe: { done: 1, total: 1 }, proofread: { done: 1, total: 5 } }, pace: { proofread: { at: Date.now() - 10000, each: 40000 } },
    tasks: [
      { id: "t1", kind: "transcribe", part: 1, parts: 1, stage: "转写 1/1", status: "complete", runtime: "gemini", startedAt: minutesAgo(3), finishedAt: minutesAgo(1) },
      { id: "t2", kind: "proofread", part: 2, parts: 5, stage: "校对 2/5", status: "running", runtime: "subagent", childId: "child-9", startedAt: minutesAgo(0.2) },
    ] });
  const html = (extra = {}, props = {}) => renderToStaticMarkup(React.createElement(AudioJobs, { data: { jobs: [{ ...running, ...extra }] }, busy: false, act() {}, openAgent() {}, ...props }));
  try {
    setUiLanguage("zh");
    const page = html();
    assert.match(page, /role="progressbar"[^>]*aria-valuenow="31"/);
    assert.match(page, />31%</);
    assert.match(page, /正在校对 2\/5/, "what runs now, from the call in flight");
    assert.doesNotMatch(page, /查看子代理|查看历史任务|本步骤预计还需/);
    assert.ok(html({ tasks: [] }).includes("role=\"progressbar\""), "the bar does not depend on the task list");
    assert.match(html({ status: "queued", phase: "queued", tasks: [] }), /查看详情/);
    setUiLanguage("en");
    const english = html().replace(/lecture\.mp3/g, "");
    assert.doesNotMatch(english, /[\u3400-\u9fff]/);
    for (const text of ["Now: Proofreading 2/5", "View details", "Stop"]) assert.ok(english.includes(text), text);
  } finally { setUiLanguage("zh"); }
});

test("the console counts Groq requests on their own, and does not pretend they were Gemini's", () => {
  const groqOnly = { type: "audio-import", id: "g1", status: "complete", filename: "lecture.mp3", phase: "done", sourceIds: ["a"], corrected: 0, warnings: [],
    usage: { free: { requests: 0 }, groq: { requests: 4 }, paid: { requests: 0 } }, usageRun: { free: { requests: 0 }, groq: { requests: 4 }, paid: { requests: 0 } } };
  try {
    setUiLanguage("zh");
    assert.match(usageLine(groqOnly), /Groq 4（免费额度）/);
    assert.ok(!usageLine(groqOnly).includes("Gemini 请求"), "no Gemini part when Gemini was not asked");
    assert.ok(!usageLine(groqOnly).includes("这次没有新发转写请求"), "a run that used only Groq is not reported as having done nothing");
    const mixed = { ...groqOnly, usage: { free: { requests: 1 }, groq: { requests: 3 }, paid: { requests: 0 } }, usageRun: { free: { requests: 1 }, groq: { requests: 3 }, paid: { requests: 0 } } };
    assert.match(usageLine(mixed), /Gemini 请求：免费 1 · 付费 0/);
    assert.match(usageLine(mixed), /Groq 3（免费额度）/);
    assert.ok(!usageLine({ ...groqOnly, usage: { free: { requests: 2 }, paid: { requests: 0 } } }).includes("Groq"), "an older job without a Groq tally shows no Groq part");
    setUiLanguage("en");
    const english = usageLine(mixed);
    assert.doesNotMatch(english, /[\u3400-\u9fff]/);
    assert.ok(english.includes("Groq 3 (free tier)"));
  } finally { setUiLanguage("zh"); }
});

