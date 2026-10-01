import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { build } from "esbuild";

// P15/P27/P28/P29: what a generation job card says, in plain words of the UI
// language, and what the generate form does after a job starts.
const compiled = await build({ stdin: { contents: `export * from './ui/generation-status.js'; export { setUiLanguage } from './ui/i18n.js';`,
  resolveDir: process.cwd() }, bundle: true, write: false, platform: "node", format: "cjs", external: ["react"], logLevel: "silent" });
const module = { exports: {} };
new Function("require", "module", "exports", compiled.outputFiles[0].text)(createRequire(import.meta.url), module, module.exports);
const m = module.exports;
const han = /[㐀-鿿]/;
const latinWord = /[A-Za-z]{3,}/;
const CODES = ["queued", "planning", "authoring", "reviewing", "repairing", "publishing", "cancelling", "cancelled", "done", "partial", "failed"];

function inLanguage(language, fn) {
  m.setUiLanguage(language);
  try { return fn(); } finally { m.setUiLanguage("zh"); }
}

test("every stage code has plain words in both languages", () => {
  for (const code of CODES) {
    const zh = inLanguage("zh", () => m.stageCodeLabel(code));
    const en = inLanguage("en", () => m.stageCodeLabel(code));
    assert.ok(zh && !latinWord.test(zh), `zh ${code}: ${zh}`);
    assert.ok(en && !han.test(en), `en ${code}: ${en}`);
  }
});

test("old job records without a stage code still read in the UI language", () => {
  const jobs = [
    { status: "running", stage: "Parallel generation · up to 3 batches", parts: 2, steps: [] },
    { status: "running", stage: "Writing source-grounded questions", steps: [] },
    { status: "cancelling", stage: "Stopping generation workers; keeping approved draft" },
    { status: "queued", stage: "Waiting for the previous generation" },
  ];
  for (const job of jobs) {
    const zh = inLanguage("zh", () => m.jobStageLabel(job, []));
    assert.doesNotMatch(zh, latinWord, zh);
    assert.match(zh, han);
  }
});

test("a running card names the step in progress, its batch and what is saved", () => {
  const job = { status: "running", stageCode: "authoring", parts: 2, savedCount: 3, requestedTotal: 10,
    steps: [
      { id: "1", stage: "Part 1/2 · Writing and self-checking questions", stageCode: "authoring", part: 1, status: "complete" },
      { id: "2", stage: "Part 1/2 · Reviewing ambiguity and source support", stageCode: "reviewing", part: 1, status: "running" },
    ] };
  const label = m.jobStageLabel(job, []);
  assert.match(label, /正在审阅/);
  assert.match(label, /第 1\/2 批/);
  assert.match(label, /已保存 3\/10 题/);
});

test("the copy after stopping depends on whether a draft was kept", () => {
  const drafts = [{ id: "d", title: "索引小测", cards: [{}, {}, {}] }];
  const withDraft = m.jobStageLabel({ status: "cancelled", stageCode: "cancelled", draftId: "d", savedCount: 3 }, drafts);
  assert.match(withDraft, /已停止/);
  assert.match(withDraft, /3 题保存在草稿/);
  const none = m.jobStageLabel({ status: "cancelled", stageCode: "cancelled" }, drafts);
  assert.match(none, /已停止/);
  assert.match(none, /还没有生成题目/);
  for (const label of [withDraft, none]) assert.doesNotMatch(label, /approved|retained|已验收/);
});

test("job cards name their deck", () => {
  const drafts = [{ id: "d", title: "草稿里的名字", cards: [] }];
  assert.equal(m.jobDeckName({ deckTitle: "索引小测" }, drafts), "索引小测");
  assert.equal(m.jobDeckName({ draftId: "d" }, drafts), "草稿里的名字");
  assert.equal(m.jobDeckName({ type: "supplement", targetTitle: "已有题组" }, drafts), "已有题组");
  assert.equal(m.jobDeckName({}, drafts), "新题组");
  assert.match(m.jobHeadline({ status: "running", deckTitle: "索引小测" }, drafts), /正在生成「索引小测」/);
  assert.match(m.jobHeadline({ status: "complete", deckTitle: "索引小测", savedCount: 4, requestedTotal: 4 }, drafts), /「索引小测」草稿已生成/);
  assert.match(m.jobHeadline({ status: "complete", deckTitle: "X", savedCount: 9, requestedTotal: 12 }, drafts), /草稿待补齐 · 9\/12 题/);
  assert.match(inLanguage("en", () => m.jobHeadline({ status: "failed", deckTitle: "Indexes" }, drafts)), /Indexes/);
});

test("generation failures become plain language with a fix", () => {
  const credential = m.describeFailure('Study subagent error: llm-deepseek: no API key for provider route "deepseek/deepseek-chat"');
  assert.equal(credential.kind, "credential");
  assert.equal(credential.title, "还没有可用的模型密钥");
  assert.equal(credential.action, "settings");
  assert.equal(m.describeFailure("当前 DSH 宿主未注册模型提供方「x」（NO_ADAPTER）").kind, "credential");
  assert.equal(m.describeFailure("401 Unauthorized: invalid api key").kind, "credential");
  assert.equal(m.describeFailure("Insufficient Balance (402)").kind, "quota");
  const busy = m.describeFailure("HTTP 429 Too Many Requests");
  assert.equal(busy.kind, "rate-limit");
  assert.equal(busy.action, "retry");
  const budget = m.describeFailure("Generation reached its 20-minute total budget; approved questions were retained", { hasDraft: true });
  assert.equal(budget.kind, "timeout");
  assert.equal(budget.action, "open-draft");
  assert.equal(m.describeFailure("The operation was aborted due to timeout").kind, "timeout");
  assert.equal(m.describeFailure("fetch failed: ECONNREFUSED").kind, "network");
  assert.equal(m.describeFailure("Quality gate failed: q1: unsupported").kind, "quality");
  assert.equal(m.describeFailure("出题资料在任务开始前已被删除，请重新选择资料").kind, "sources");
  const unknown = m.describeFailure("something odd");
  assert.equal(unknown.kind, "unknown");
  assert.equal(unknown.action, "retry");
  for (const failure of [credential, busy, budget, unknown]) assert.doesNotMatch(failure.title + failure.hint, /API key for|llm-|subagent/i);
  const english = inLanguage("en", () => m.describeFailure("no API key"));
  assert.doesNotMatch(english.title + english.hint, han);
});

test("a started generation confirms with the deck name and resets the form", () => {
  const gen = { kind: "quiz", count: "4", title: "  索引小测 ", focus: "写多读少", language: "English", difficulty: "advanced", role: "后端", course: "数据库" };
  const notice = m.generationStartedNotice({ status: "running", parts: 1 }, gen, 2);
  assert.equal(notice.tone, "success");
  assert.match(notice.text, /^已开始生成「索引小测」…/);
  const queued = m.generationStartedNotice({ status: "queued", queuedBehind: 1, parts: 1 }, gen, 2);
  assert.match(queued.text, /「索引小测」/);
  assert.match(queued.text, /前面还有 1 个/);
  assert.match(m.generationStartedNotice({ status: "running" }, { ...gen, title: "" }, 2).text, /已开始用 2 份资料出题/);
  assert.deepEqual(m.freshGeneration(gen), { kind: "mixed", count: 10, title: "", focus: "", language: "English",
    difficulty: "advanced", role: "后端", course: undefined });
  assert.deepEqual({ kind: m.GENERATION_DEFAULTS.kind, count: m.GENERATION_DEFAULTS.count }, { kind: "mixed", count: 10 });
});

test("materials are counted per document, not per PDF page", () => {
  assert.equal(m.documentCount([{ id: "a", document: { id: "pdf", page: 1 } }, { id: "b", document: { id: "pdf", page: 2 } }, { id: "c" }]), 2);
  assert.equal(m.documentCount([]), 0);
});

test("model readiness follows the host contract and the legacy flag", () => {
  assert.deepEqual(m.modelReadiness({ model: { ready: false, reason: "no-credential", label: "DeepSeek" }, modelReady: true }),
    { ready: false, reason: "no-credential", label: "DeepSeek" });
  assert.equal(m.modelReadiness({ modelReady: true }).ready, true);
  assert.equal(m.modelReadiness({ modelReady: false }).ready, false);
  assert.equal(m.modelReadiness({}).ready, false);
});
