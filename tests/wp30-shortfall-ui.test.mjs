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

const han = /[㐀-鿿]/;
const inLanguage = (language, fn) => { m.setUiLanguage(language); map.setUiLanguage(language); try { return fn(); } finally { m.setUiLanguage("zh"); map.setUiLanguage("zh"); } };

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
  assert.match(inLanguage("zh", () => m.describeGenerationRecord("Part 2: Assessment plan is not usable: Target 3: quote is not in source")), /第 2 批没有完成：考点规划没有通过检查/);
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
