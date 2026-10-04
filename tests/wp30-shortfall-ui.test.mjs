import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { build } from "esbuild";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

/* The owner's report: "10/20 题少了 10 题", every step 已完成, and on the draft
   card both 已复审，待发布 and 补题中… at once, with no reason and no way to tell
   whether a top-up was really running. These tests pin what the learner is told. */

const load = async (entry, exports) => {
  const compiled = await build({ stdin: { contents: exports, resolveDir: process.cwd() }, bundle: true, write: false,
    platform: "node", format: "cjs", external: ["react"], loader: { ".css": "text" }, logLevel: "silent" });
  const module = { exports: {} };
  new Function("require", "module", "exports", compiled.outputFiles[0].text)(createRequire(import.meta.url), module, module.exports);
  return module.exports;
};
const m = await load("status", `export * from './ui/draft-shortfall.js'; export * from './ui/generation-status.js'; export { setUiLanguage } from './ui/i18n.js';`);
const map = await load("map", `export { default as StudyMap } from './ui/StudyMap.jsx'; export { default as Draft } from './ui/Draft.jsx'; export { setUiLanguage } from './ui/i18n.js';`);

const view = await load("view", `export { OmittedQuestions } from './ui/DraftShortfall.jsx'; export { setUiLanguage } from './ui/i18n.js';`);
const omittedMarkup = (draft) => renderToStaticMarkup(React.createElement(view.OmittedQuestions, { draft }));

const han = /[㐀-鿿]/;
const inLanguage = (language, fn) => { m.setUiLanguage(language); map.setUiLanguage(language); view.setUiLanguage(language); try { return fn(); } finally { m.setUiLanguage("zh"); map.setUiLanguage("zh"); view.setUiLanguage("zh"); } };

/* The shape a draft from before `omitted` existed has: what one real library holds. */
const legacyDraft = (extra = {}) => ({ id: "dr", title: "微服务边界、共享数据与 CQRS", draftVersion: 3,
  cards: Array.from({ length: 10 }, (_, i) => ({ id: `c${i}`, kind: "quiz", topic: "t", objective: `o${i}`, prompt: `p${i}?`, answer: "a", citations: [] })),
  editorial: { requested: 20, generated: 10, parts: 6, completedParts: 6, reviewedCards: {},
    failures: ["Part 1: retained 1/2 reviewed questions; omitted or missing candidates: q2: answerLeak failed or was not checked",
      "Part 2: Assessment plan is not usable: Target 3: quote is not in source"],
    audits: [
      { part: 1, targets: [], changes: [], checks: [], omittedIssues: ["q2 的提示直接给出了答案的核心区分，与正确选项几乎同义。", "q2: answerLeak failed or was not checked"] },
      { part: 3, targets: [], changes: [], checks: [], omittedIssues: ["q1：题干不足以证明事件驱动优于共享数据库轮询。", "q1: optionQuality failed or was not checked",
        "q1: sourceSupport failed or was not checked", "q1: explanationQuality failed or was not checked"] },
      { part: 5, targets: [], changes: [], checks: [], omittedIssues: ["q3: answerLeak failed or was not checked"] },
      { part: 6, targets: [], changes: [], checks: [], omittedIssues: [] },
    ],
    generation: { sourceIds: ["s"], kind: "mixed" }, ...extra } });

test("a short draft explains how many questions were dropped for which reason, even when it was made before reasons were recorded", () => {
  const result = m.shortfall(legacyDraft());
  assert.equal(result.missing, 10);
  assert.equal(result.records.length, 3, "one record per dropped question, not per issue line");
  const count = (code) => result.reasons.find((reason) => reason.code === code)?.count;
  assert.equal(count("answer-leak"), 2);
  assert.equal(count("options"), 1);
  assert.equal(count("source"), 1);
  assert.equal(count("explanation"), 1);
  assert.equal(result.reasons[0].code, "answer-leak", "most common first");
  assert.deepEqual(result.partFailures.map((item) => item.part), [2], "a batch that did not finish is named, not hidden in a log");
  assert.ok(result.reasons.every((reason) => reason.label && !/answerLeak|optionQuality/.test(reason.label)));
});

test("new drafts carry the dropped question itself", () => {
  const draft = legacyDraft({ omitted: [
    { part: 2, kind: "quiz", objective: "区分同步与异步", prompt: "何时把同步通信改成异步？", reasons: ["q4: answerLeak failed or was not checked", "q4 的提示泄露了答案类别"] },
    { part: 4, kind: "flashcard", objective: "x", prompt: "另一题？", reasons: ["over-count"] }] });
  const result = m.shortfall(draft);
  assert.deepEqual(result.records.map((item) => [item.part, item.prompt, item.codes]),
    [[2, "何时把同步通信改成异步？", ["answer-leak"]], [4, "另一题？", ["over-count"]]]);
  assert.match(result.records[0].note, /泄露了答案类别/, "the reviewer's own words stay available");
  assert.equal(result.records[1].note, "");
});

test("an unexplained shortfall says so instead of inventing a reason", () => {
  const result = m.shortfall({ id: "d", cards: [{ id: "a" }], editorial: { requested: 3, generation: { sourceIds: ["s"] } } });
  assert.equal(result.missing, 2);
  assert.deepEqual(result.records, []);
  assert.deepEqual(result.reasons, []);
});

test("backend generation records read as sentences in both languages", () => {
  const lines = ["Part 1: retained 1/2 reviewed questions; omitted or missing candidates: q2 leaks", "Part 3: duplicate learning target omitted",
    "Part 4: Quality gate failed: x", "补题时跳过了一道与已有草稿重复的题"];
  const zh = inLanguage("zh", () => lines.map(m.describeGenerationRecord));
  assert.match(zh[0], /第 1 批：计划 2 题，通过检查 1 题/);
  assert.match(zh[1], /第 3 批：有一道题与前面的题考点重复/);
  assert.match(zh[2], /第 4 批没有完成：没有题目通过检查/);
  const en = inLanguage("en", () => lines.map(m.describeGenerationRecord));
  for (const line of en) assert.doesNotMatch(line, han, line);
  assert.match(en[0], /Batch 1: 2 planned, 1 passed/);
  assert.equal(m.describeGenerationRecord("something else"), "something else");
});

test("a running top-up is called a top-up, in both languages, and a plan failure is called a plan failure", () => {
  const job = { status: "running", continued: true, deckTitle: "索引小测", draftId: "dr", savedCount: 10, requestedTotal: 20 };
  assert.match(m.jobHeadline(job, []), /正在补齐「索引小测」/);
  assert.match(m.jobHeadline({ ...job, continued: false }, []), /正在生成「索引小测」/);
  assert.equal(inLanguage("en", () => m.jobHeadline(job, [])), 'Adding questions to "索引小测"', "the deck's own title is the learner's data and stays as written");
  assert.match(inLanguage("zh", () => m.describeGenerationRecord("Part 2: Assessment plan is not usable: Return exactly 5 targets (got 3)")), /第 2 批没有完成：考点规划没有通过检查/);
  assert.match(inLanguage("zh", () => m.describeGenerationRecord("Part 2: Assessment plan is not usable: Target 3: quote is not in source")), /第 2 批没有完成：引用的原文在资料里找不到/, "a quote that is not on its page is not called a plan problem");
  assert.doesNotMatch(inLanguage("en", () => m.describeGenerationRecord("Part 2: Assessment plan is not usable: x")), han);
});

test("the draft button says what is really happening to the draft", () => {
  const draft = legacyDraft();
  const job = (extra) => ({ id: "j", draftId: "dr", status: "running", ...extra });
  const label = (extra, lang = "zh") => inLanguage(lang, () => m.draftWorkLabel(m.draftWork(draft, [job(extra)]), draft));
  assert.equal(m.draftWork(draft, []), null);
  assert.equal(m.draftWork(draft, [job({ status: "complete" })]), null, "a finished job is not work in progress");
  assert.equal(m.draftWork(draft, [job({ draftId: "other" })]), null);
  assert.equal(label({ continued: true, savedCount: 12, requestedTotal: 20 }), "补题中 · 草稿 12/20 题");
  assert.equal(label({ savedCount: 12, requestedTotal: 20 }), "生成中 · 草稿 12/20 题", "the original run is not a top-up");
  assert.equal(label({ type: "draft-publish" }), "发布检查中…", "publishing is not a top-up");
  assert.equal(label({ type: "draft-repair" }), "后台修题中…");
  assert.equal(label({ continued: true, status: "queued" }), "补题排队中", "queued is not running");
  assert.match(label({ continued: true, status: "cancelling" }), /停止/);
  for (const extra of [{ continued: true, savedCount: 12, requestedTotal: 20 }, { type: "draft-publish" }, { type: "draft-repair" }, { continued: true, status: "queued" }, {}])
    assert.doesNotMatch(label(extra, "en"), han, JSON.stringify(extra));
});

test("a finished partial job card follows the draft instead of freezing at its own count", () => {
  const draft = legacyDraft();
  const job = { id: "a", status: "complete", stageCode: "partial", draftId: "dr", savedCount: 10, requestedTotal: 20 };
  assert.match(m.jobHeadline(job, [draft]), /草稿待补齐 · 10\/20 题/);
  assert.match(m.jobStageLabel(job, [draft], [job]), /少了 10 题/);
  const grown = { ...draft, cards: [...draft.cards, ...Array.from({ length: 9 }, (_, i) => ({ id: `n${i}` }))] };
  assert.match(m.jobHeadline(job, [grown]), /草稿待补齐 · 19\/20 题/, "the topped-up draft has 19, the old card must not say 10");
  const full = { ...draft, cards: Array.from({ length: 20 }, (_, i) => ({ id: `n${i}` })) };
  assert.match(m.jobHeadline(job, [full]), /草稿已生成/);
  assert.doesNotMatch(m.jobStageLabel(job, [full], [job]), /少了/);
  const running = { id: "b", status: "running", draftId: "dr", continued: true };
  const label = m.jobStageLabel(job, [draft], [job, running]);
  assert.doesNotMatch(label, /可以打开草稿补齐/, "no advice to start what is already running");
  assert.match(label, /正在补题/);
});

const noop = () => {};
function home(data, props = {}) {
  return renderToStaticMarkup(React.createElement(map.StudyMap, { data: { root: "/tmp/lib", decks: [], progress: {}, sources: [{ id: "s" }], runs: [], jobs: [], drafts: [],
    today: { due: 0, weak: 0, new: 0, size: 0 }, focus: { mode: "class", course: "", courses: [], fresh: [] }, modelReady: true, ...data },
  busy: false, start: noop, resume: noop, endRun: noop, manage: noop, openDraft: noop, continueDraft: noop, retryGeneration: noop, addSource: noop,
  createManual: noop, importLibrary: noop, askInChat: noop, notebooks: [], onFocus: noop, cancelJob: noop, dismissJob: noop, ...props }));
}
const partialJob = { id: "a", status: "complete", stageCode: "partial", draftId: "dr", savedCount: 10, requestedTotal: 20, parts: 6, stage: "Draft ready with 10/20 questions; 2 part(s) failed" };

test("home: a short draft states how many it lacks and offers one top-up, with the reasons on the job card", () => {
  const html = home({ drafts: [legacyDraft()], jobs: [partialJob] });
  assert.match(html, /还差 10 题/, "the draft row itself says it is short");
  assert.equal((html.match(/继续补齐 10 题/g) || []).length, 1, "one top-up action");
  assert.match(html, /提示或题干泄露了答案/);
  assert.match(html, /第 2 批没有完成/);
  assert.doesNotMatch(html, /answerLeak|Assessment plan/, "no raw backend prose on the card");
});

test("home: while a top-up runs the button says so, the old card stops advising it and nothing says 补题中 for publishing", () => {
  const running = { id: "b", status: "running", draftId: "dr", continued: true, savedCount: 12, requestedTotal: 20, stageCode: "authoring", type: undefined };
  const html = home({ drafts: [legacyDraft()], jobs: [partialJob, running] });
  assert.match(html, /补题中 · 草稿 12\/20 题/);
  assert.doesNotMatch(html, /继续补齐 10 题/);
  assert.doesNotMatch(html, /可以打开草稿补齐/);
  const publishing = home({ drafts: [legacyDraft()], jobs: [{ id: "p", status: "running", draftId: "dr", type: "draft-publish", stage: "x" }] });
  assert.match(publishing, /发布检查中…/);
  assert.doesNotMatch(publishing, /补题中/);
  const first = home({ drafts: [legacyDraft()], jobs: [{ id: "g", status: "running", draftId: "dr", savedCount: 10, requestedTotal: 20, stageCode: "authoring" }] });
  assert.match(first, /生成中 · 草稿 10\/20 题/);
  assert.doesNotMatch(first, /补题中/);
});

test("home: English renders without Chinese", () => {
  const html = inLanguage("en", () => home({ drafts: [{ ...legacyDraft(), title: "CQRS" }], jobs: [{ ...partialJob, deckTitle: "CQRS" }] }));
  const visible = html.replace(/<[^>]+>/g, " ");
  assert.doesNotMatch(visible, han, (visible.match(/.{0,30}[㐀-鿿].{0,30}/) || [])[0]);
  assert.match(visible, /10 more needed/);
  assert.match(visible, /Continue generation for 10 questions/);
});

test("home: an active top-up exposes saved progress and stop while execution and usage start folded", () => {
  const job = { id: "t", status: "running", stageCode: "planning", continued: true, draftId: "dr", count: 10, savedCount: 10,
    requestedTotal: 20, generationTimeoutSeconds: 300, totalTimeoutSeconds: 1200,
    estimate: { totalTokens: { low: 139000, high: 235000 }, calls: { low: 18, high: 22 } },
    steps: [{ id: "s", stage: "Planning evidence and learning targets", stageCode: "planning", status: "running" }] };
  const html = home({ drafts: [legacyDraft()], jobs: [job] });
  assert.match(html, /class="sh-job__progress"/);
  assert.match(html, /aria-valuemax="20"[^>]*aria-valuenow="10"/);
  assert.match(html, /本次计划补 10 题/);
  assert.match(html, /当前阶段/);
  assert.match(html, /<button[^>]*>[^]*?停止<\/button>/, "the stop control is a JobRow action");
  assert.doesNotMatch(/<details[^>]*class="generation-trace"[^>]*>/.exec(html)?.[0] || "", /\bopen\b/);
  assert.match(html, /生成方式、用量与技术详情/);
  assert.doesNotMatch(html, /已保存 10 题到草稿；其余批次仍在生成/, "saved count belongs to the progress summary once");
  const en = inLanguage("en", () => home({ drafts: [{ ...legacyDraft(), title: "CQRS" }], jobs: [{ ...job, deckTitle: "CQRS" }] }));
  assert.doesNotMatch(en.replace(/<[^>]+>/g, " "), han);
});

function draftPage(draft, data = {}, props = {}) {
  return renderToStaticMarkup(React.createElement(map.Draft, { data: { sources: [{ id: "s", title: "S" }], decks: [], drafts: [draft], jobs: [], modelReady: true, runs: [], ...data },
    busy: false, act: noop, call: noop, draft, draftLoaded: JSON.stringify(draft), setDraft: noop, draftText: "", setDraftText: noop, jsonMode: false, setJsonMode: noop,
    openDraft: noop, onOpenPublished: noop, onStartPublished: noop, clearRecovery: noop, setPage: noop, setNotice: noop, setError: noop, setModal: noop,
    setSelectedSources: noop, setGenSource: noop, blankCard: noop, patchCard: noop, parseDraft: JSON.parse, continueDraft: noop, ...props }));
}

test("the draft page has the same top-up button as the home card instead of sending the learner back", () => {
  const html = draftPage(legacyDraft());
  assert.match(html, /继续补齐 10 题/);
  assert.doesNotMatch(html, /返回学习库点/);
  assert.match(html, /比计划少 10 题/);
  assert.match(html, /提示或题干泄露了答案/);
  assert.doesNotMatch(html, /Part 1: retained|Assessment plan is not usable/, "the generation record is in the learner's language");
  const busy = draftPage(legacyDraft(), { jobs: [{ id: "b", status: "running", draftId: "dr", continued: true, savedCount: 12, requestedTotal: 20 }] });
  assert.match(busy, /补题中 · 草稿 12\/20 题/);
  assert.match(busy, /<button[^>]*disabled=""[^>]*>保存并校验/, "no saving over a draft that a top-up is writing");
  const english = inLanguage("en", () => draftPage({ ...legacyDraft(), title: "CQRS", editorial: { ...legacyDraft().editorial, audits: [], failures: legacyDraft().editorial.failures, omitted: [
    { part: 1, kind: "quiz", objective: "o", prompt: "Which one?", reasons: ["q2: answerLeak failed or was not checked"] }] } }));
  assert.doesNotMatch(english.replace(/<[^>]+>/g, " "), han);
});

/* The owner's report: "题目格式不完整 x3" said nothing (every line starting "Card N:" was one catch-all), and the 3-row list under it was empty. */
const shortCodes = (lines) => m.shortfall({ id: "d", cards: [], editorial: { requested: 3, omitted: [{ part: 1, prompt: "p", reasons: lines }] } }).records[0].codes;

test("a dropped question names its real defect, not the catch-all 'incomplete format'", () => {
  const cases = [
    ["Card 2: formula outside math delimiters ([\"x^2\"]); wrap every formula in $\u2026$", "formula", /公式没有放进公式格式/],
    ["Card 2: the stem asks what the source says (recall of a document's wording); rewrite it", "source-voice", /题干在问「资料怎么说」/],
    ["Card 3: hint is required", "missing-field", /缺少必要字段/],
    ["Card 3: misconception must be text", "missing-field", /缺少必要字段/],
    ["Card 1: need 3\u20136 options", "options-shape", /选项结构不完整/],
    ["Card 1: invalid correct option count", "options-shape", /选项结构不完整/],
    ["Card 1: duplicate option id", "options-shape", /选项结构不完整/],
    ["Card 1: duplicate option text", "options-shape", /选项结构不完整/],
    ["Card 1: each option requires id, text, correct and explanation", "options-shape", /选项结构不完整/],
    ["Card 1: hint reveals the answer", "answer-leak", /泄露了答案/],
    ["q2: missing, unknown or duplicate targetId; the question has no unique verified knowledge point and answer", "binding", /没有对上已核实的考点/],
    ["Card 4: unsupported kind", "structure", /题目格式不完整/],
  ];
  for (const [line, code, label] of cases) {
    assert.deepEqual(shortCodes([line]), [code], line);
    assert.match(m.reasonLabel(code), label, code);
  }
  const english = inLanguage("en", () => ["formula", "source-voice", "missing-field", "options-shape", "binding"].map(m.reasonLabel));
  for (const line of english) assert.doesNotMatch(line, han, line);
  assert.equal(new Set(english).size, 5, "five distinct English labels");
});

const omittedHtml = (omitted) => omittedMarkup({ id: "d", cards: [], editorial: { requested: 3, omitted } });
const rows = (html) => [...html.matchAll(/<li>(.*?)<\/li>/gs)].map((match) => match[1]);

test("the dropped-question list never shows an empty row: prompt, then objective, then topic, then the batch", () => {
  const html = omittedHtml([
    { part: 2, prompt: "写了题干的题", objective: "o1", topic: "t1", reasons: ["Card 1: formula outside math delimiters (x)"] },
    { part: 2, prompt: "   ", objective: "只有考点", topic: "t2", reasons: ["Card 2: hint is required"] },
    { part: 3, prompt: "", objective: "", topic: "只有主题", reasons: ["Card 3: need 3\u20136 options"] },
    { part: 4, reasons: ["q4: missing, unknown or duplicate targetId; no unique verified knowledge point"] },
    { reasons: [] },
  ]);
  const list = rows(html);
  assert.equal(list.length, 5);
  assert.match(list[0], /<strong>写了题干的题<\/strong>/);
  assert.match(list[1], /<strong>只有考点<\/strong>/);
  assert.match(list[2], /<strong>只有主题<\/strong>/);
  assert.match(list[3], /<strong>第 4 批的一道题<\/strong>/);
  assert.match(list[3], /没有对上已核实的考点/, "the reason is shown on the row");
  assert.match(list[4], /<strong>[^<]+<\/strong>/, "even a record without part or reasons has a title");
  assert.doesNotMatch(html, /undefined|NaN|\[object/);
  for (const row of list) assert.ok(row.replace(/<[^>]+>/g, "").trim().length > 3, row);
  const english = inLanguage("en", () => omittedHtml([{ part: 4, reasons: ["Card 1: hint is required"] }, {}]));
  assert.doesNotMatch(english.replace(/<[^>]+>/g, " "), han);
  assert.match(english, /A question from batch 4/);
});

test("generation records are always real sentences: described, else the raw line clipped, never an empty row", () => {
  const lines = ["", "   ", null, { message: "Part 3: socket hang up" }, "Part 2: something odd happened in the pipeline", "Part 1: retained 1/2 reviewed questions; omitted or missing candidates: q2 leaks", "x".repeat(400)];
  const out = m.generationRecordLines(lines);
  assert.equal(out.length, 4, "empty, blank and null lines are dropped");
  assert.ok(out.every((line) => line.trim().length > 3), JSON.stringify(out));
  assert.match(out[0], /第 3 批没有完成：连不上模型服务/, "an object carrying a message is read");
  assert.match(out[1], /第 2 批没有完成/);
  assert.match(out[1], /something odd happened/, "an unrecognised reason keeps the raw text instead of saying nothing");
  assert.match(out[2], /第 1 批：计划 2 题，通过检查 1 题/);
  assert.ok(out[3].length <= 201, "a long raw line is clipped");
  assert.deepEqual(m.generationRecordLines(["", " ", undefined]), []);
  assert.deepEqual(m.generationRecordLines(undefined), []);
  const english = inLanguage("en", () => m.generationRecordLines(["Part 2: something odd happened"]));
  assert.doesNotMatch(english[0].replace(/something odd happened/, ""), han);
});

test("the draft page hides a failures section with nothing to say and never renders an empty bullet in it", () => {
  const base = legacyDraft();
  const html = draftPage({ ...base, editorial: { ...base.editorial, failures: ["", " "], previousFailures: [null, ""] } });
  assert.doesNotMatch(html, /部分题目未生成成功/);
  assert.doesNotMatch(html, /之前未完成的批次/);
  const shown = draftPage({ ...base, editorial: { ...base.editorial, failures: ["", "Part 2: something odd happened"], previousFailures: ["Part 1: socket hang up", " "] } });
  assert.match(shown, /部分题目未生成成功/);
  assert.match(shown, /之前未完成的批次/);
  assert.doesNotMatch(shown, /<li>\s*<\/li>/);
  assert.match(shown, /第 1 批没有完成：连不上模型服务/);
});

test("a dropped-question row keeps the stem, the reasons and the reviewer's note apart, in markup and in copied text", () => {
  const html = omittedHtml([{ part: 1, prompt: "写出 O(n) 的表达式。", reasons: ["Card 1: formula outside math delimiters (x)", "Card 1: hint reveals the answer", "q1 prompt gives away the answer"] }]);
  const [row] = rows(html);
  assert.doesNotMatch(row, /<\/strong><small/, "markup is not glued");
  const text = row.replace(/<\/(?:strong|span|small|div)>/g, "$&\n").replace(/<[^>]+>/g, "");
  assert.match(text, /表达式。\s+\S/, "a gap follows the stem");
  assert.doesNotMatch(text, /答案q1|答案q3|。题目|。公式/, "no reason starts right where the stem ends");
  assert.match(row, /omitted-questions__why/);
  assert.match(row, /omitted-questions__note/);
  assert.match(text, /审阅意见/, "the reviewer's note says whose words they are");
  const english = inLanguage("en", () => omittedHtml([{ part: 1, prompt: "Q?", reasons: ["Card 1: hint is required", "q1 gives it away"] }]));
  assert.match(english.replace(/<[^>]+>/g, " "), /Reviewer note/);
});
