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

test("saved progress distinguishes a draft's total from the questions requested by its top-up", () => {
  const job = { status: "running", continued: true, draftId: "d", count: 21, savedCount: 4, requestedTotal: 25, stageCode: "planning" };
  const progress = m.jobSavedProgress(job, [{ id: "d", cards: [{}, {}, {}, {}] }]);
  assert.equal(progress.saved, 4);
  assert.equal(progress.total, 25, "the denominator is the whole draft target, never this run's 21 questions");
  assert.equal(progress.label, "草稿已保存");
  assert.equal(progress.note, "本次计划补 21 题");
  assert.equal(m.jobStageLabel(job, [], [], { includeSaved: false }), "正在规划考点");
  const passage = m.jobSavedProgress({ status: "complete", type: "supplement", origin: "selection", savedCount: 2, requestedTotal: 3,
    publication: { added: 2, total: 19 } });
  assert.equal(passage.saved, 2);
  assert.equal(passage.total, 3, "a passage's denominator is this addition, never the deck's 19 questions");
  assert.equal(passage.label, "本次已补入");
  assert.equal(passage.note, "题组现有 19 题");
  assert.equal(m.jobSavedProgress({ type: "draft-repair", savedCount: 1, requestedTotal: 3 }), null, "repairs do not count as newly saved questions");
});

test("a source quotation mismatch directs the learner to verify the selected pages", () => {
  const error = "Part 1: Assessment plan is not usable: Target 3: quote is not in source";
  const failure = m.describeFailure(error);
  assert.equal(failure.kind, "grounding");
  assert.match(failure.hint, /所选页.*原文/);
  assert.match(failure.hint, /重新选页/);
  assert.doesNotMatch(failure.hint, /通常就行|已自动重试/);
  assert.match(m.describeFailure(error, { hasDraft: true }).hint, /继续补齐/);
  assert.doesNotMatch(inLanguage("en", () => m.describeFailure(error).hint), han);
});

test("identical batch errors share one cause while their full original log is retained", () => {
  const cause = "Assessment plan is not usable: Target 3: quote is not in source";
  const raw = [1, 2, 3, 4].map(part => `Part ${part}: ${cause}`).join("; ");
  assert.deepEqual(m.repeatedJobFailure(raw), { count: 4, cause, raw });
  assert.equal(m.repeatedJobFailure(`Part 1: ${cause}; Part 2: timed out`), null, "different failures must stay separate");
  assert.equal(m.repeatedJobFailure(cause), null);
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

test("generation material counts match the picker for refreshed PDFs and split text materials", () => {
  const hash = "a".repeat(64);
  const sources = [
    { id: "a1", document: { id: hash, materialId: `document-${hash}-pdf`, page: 1 } },
    { id: "a2", document: { id: hash, materialId: `document-${hash}-pdf`, page: 2 } },
    { id: "b1", document: { id: hash, materialId: "document-independent-pdf", page: 1 } },
    { id: "word1", document: { materialId: "document-word", format: "docx" } },
    { id: "word2", document: { materialId: "document-word", format: "docx" } },
  ];
  assert.equal(m.documentCount(sources.slice(0, 3)), 2, "two logical PDFs can share the same bytes");
  assert.equal(m.documentCount(sources.slice(3)), 1, "one Word material can have multiple source parts");
  assert.equal(m.documentCount(sources), 3);
});

test("model readiness follows the host contract and the legacy flag", () => {
  assert.deepEqual(m.modelReadiness({ model: { ready: false, reason: "no-credential", label: "DeepSeek" }, modelReady: true }),
    { ready: false, reason: "no-credential", label: "DeepSeek" });
  assert.equal(m.modelReadiness({ modelReady: true }).ready, true);
  assert.equal(m.modelReadiness({ modelReady: false }).ready, false);
  assert.equal(m.modelReadiness({}).ready, false);
});
