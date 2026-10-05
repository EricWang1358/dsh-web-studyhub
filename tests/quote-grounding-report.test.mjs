import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "esbuild";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { StudyService } from "../lib/service.js";
import { createJobNotifier } from "../lib/runtime/job-notice.js";
import { describePartReport, failureReason, summarizePartOutcomes } from "../lib/generation-report.js";
import { authored, qualityPlan, qualityBlueprint, qualityReview } from "./helpers/assessment.mjs";
import { mapProps } from './helpers/study-map-props.mjs';
import { draftView, seedView } from './helpers/coverage-view.mjs';

/* The owner's report: a 36-page generation said "5 parts failed because the quoted source text could not be found", and the agent
   advised retrying by hand with fewer pages. The job and the draft now say how many parts passed or failed and why, in the learner's
   language, and the draft that kept the passing questions offers the top-up. */

test("the reasons of a part are read from what the pipeline left, and counted per part", () => {
  assert.equal(failureReason('Assessment plan is not usable: Target 3: quote "x" is not in source s1; copy a passage character by character'), "quote");
  assert.equal(failureReason("Card 2: quote must match a source passage (at least 12 characters)"), "quote");
  assert.equal(failureReason("Card 2: unknown source"), "quote");
  assert.equal(failureReason("Assessment plan is not usable: Target 1: infeasible self-contained task"), "plan");
  assert.equal(failureReason("q2: answerLeak failed or was not checked"), "quality");
  assert.equal(failureReason("fetch failed"), "other");
  const planned = [{ count: 5 }, { count: 5 }, { count: 5 }, { count: 5 }, { count: 5 }, { count: 5 }];
  const deck = (kept, reasons = []) => ({ cards: Array.from({ length: kept }, (_, i) => ({ id: `c${i}` })), editorial: { omitted: reasons.map((reason) => ({ reasons: [reason] })) } });
  const report = summarizePartOutcomes({ planned, outcomes: [{ deck: deck(5) }, { error: 'Assessment plan is not usable: Target 1: quote "a" is not in source s' },
    { error: 'Assessment plan is not usable: Target 1: quote "a" is not in source s' }, { deck: deck(3, ["Card 1: quote must match a source passage (at least 12 characters)", "q2: answerLeak failed or was not checked"]) },
    { error: "fetch failed" }, undefined] });
  assert.deepEqual([report.total, report.passed, report.partial, report.failed, report.pending], [5, 1, 1, 3, 1]);
  assert.deepEqual(report.reasons, { quote: 3, quality: 1, other: 1 });
  assert.match(describePartReport(report, "zh"), /共 5 个批次：1 个全部通过，1 个只保留了部分题，3 个没有出题。原因：3 个批次的引用在资料里找不到；1 个批次的题没有通过质量审阅；1 个批次因其他原因没有完成。/);
  assert.match(describePartReport(report, "en"), /5 batches: 1 passed fully, 1 kept only some questions, 3 produced none\. Why: 3 batch\(es\) quoted text that could not be found in the pages/);
  assert.doesNotMatch(describePartReport(report, "en"), /[㐀-鿿]/);
});

const pages = Array.from({ length: 4 }, (_, i) => ({ id: `page-${i + 1}`, title: `Page ${i + 1}`, text: `Page ${i + 1} explains that tactic ${i + 1} keeps the quality attribute within its budget under load.` }));
const flashcard = (n, citations) => ({ id: `q${n}`, kind: "flashcard", topic: "t", objective: `objective ${n}`, prompt: `Which tactic keeps budget ${n} under load?`, answer: `tactic ${n}`,
  hint: "think about the budget", explanation: "the quoted passage ties the tactic to its budget", misconception: "all tactics are interchangeable", citations });

async function runJob(t, { invent }) {
  const root = await mkdtemp(join(tmpdir(), "study-grounding-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const service = new StudyService(root);
  for (const page of pages) await service.call("source.add", page);
  service.complete = async (system, prompt) => {
    if (system.startsWith('Act as a strict')) return JSON.stringify(qualityReview(JSON.parse(prompt).candidate));
    const request = JSON.parse(prompt.split('REQUEST DATA:\n')[1].split('\n\nYour previous plan was rejected')[0]);
    if (system.startsWith('Plan a source-grounded')) {
      const plan = qualityPlan(request);
      // Two of the planned targets cannot be grounded: the batch plans one reserve target, so one of the two questions is still lost.
      if (invent) for (const target of plan.targets.slice(0, 2)) target.citations[0].quote = 'A passage about caching that this page never contained at all';
      return JSON.stringify(plan);
    }
    const deck = { title: 'T', cards: request.assessmentPlan.targets.map((target, i) => ({ ...flashcard(i + 1, target.citations), targetId: target.targetId })) };
    if (system.startsWith('Prepare supported answers')) return JSON.stringify(qualityBlueprint(request, request.assessmentPlan, deck));
    return JSON.stringify(authored(deck, [], request.assessmentPlan));
  };
  const started = await service.call("generate", { sourceIds: pages.map((page) => page.id), count: 3, kind: "flashcard" });
  const done = await service.call("job.wait", { jobId: started.jobId });
  return { service, done };
}

test("a job that lost questions to quotes says how many parts failed and why, and points the agent to the top-up, not to a hand-made retry", async (t) => {
  const { done } = await runJob(t, { invent: true });
  assert.equal(done.status, "complete");
  assert.ok(done.partReport, "the job carries the report");
  assert.ok(done.partReport.reasons.quote >= 1, JSON.stringify(done.partReport));
  assert.match(done.partReport.summary, /引用在资料里找不到/, "the job speaks the learner's language");
  assert.equal(done.draft.cards, 2, "the passing questions are kept");
  assert.equal(done.draft.missing, 1);
  assert.match(done.next, /generate \{resumeDraftId: "/);
  assert.match(done.next, /keeps the questions that passed/);
});

test("a job in which every quote is real has no failed parts and no top-up advice", async (t) => {
  const { done } = await runJob(t, { invent: false });
  assert.equal(done.partReport.failed + done.partReport.partial, 0);
  assert.equal(done.draft.cards, 3);
  assert.equal(done.next, undefined);
});

/* ---------- what the learner reads ---------- */

const load = async (contents) => {
  const compiled = await build({ stdin: { contents, resolveDir: process.cwd() }, bundle: true, write: false, platform: "node", format: "cjs", external: ["react"], loader: { ".css": "text" }, logLevel: "silent" });
  const module = { exports: {} };
  new Function("require", "module", "exports", compiled.outputFiles[0].text)(createRequire(import.meta.url), module, module.exports);
  return module.exports;
};
const m = await load(`export * from './ui/draft-shortfall.js'; export * from './ui/generation-status.js'; export { setUiLanguage } from './ui/i18n.js';`);
const map = await load(`export { default as StudyMap } from './ui/StudyMap.jsx'; export { seedCoverage, forgetCoverage } from './ui/coverage/use-coverage.js'; export { setUiLanguage } from './ui/i18n.js';`);
const han = /[㐀-鿿]/;
const inLanguage = (language, fn) => { m.setUiLanguage(language); map.setUiLanguage(language); try { return fn(); } finally { m.setUiLanguage("zh"); map.setUiLanguage("zh"); } };

const partReport = { total: 6, passed: 1, partial: 0, failed: 5, pending: 0, reasons: { quote: 5 }, parts: [], citationsRepaired: 2, summary: "x" };
const shortDraft = () => ({ id: "dr", title: "Architecting", draftVersion: 2,
  cards: Array.from({ length: 4 }, (_, i) => ({ id: `c${i}`, kind: "quiz", topic: "t", objective: `o${i}`, prompt: `p${i}?`, answer: "a", citations: [] })),
  editorial: { requested: 25, generated: 4, parts: 6, completedParts: 6, reviewedCards: {}, failures: [], partReport, generation: { sourceIds: ["s"], kind: "quiz" } } });

test("a quote failure is told in plain words, with the way forward, not as a failed plan", () => {
  const raw = 'Part 1: Assessment plan is not usable: Target 3: quote "x" is not in source s1; copy a passage character by character';
  const none = m.describeFailure(raw);
  assert.equal(none.kind, "grounding");
  assert.equal(none.title, "引用的原文在资料里找不到");
  assert.doesNotMatch(none.hint, /内容可能不够/);
  assert.equal(m.describeFailure(raw, { hasDraft: true }).action, "open-draft");
  assert.equal(m.describeFailure("Assessment plan is not usable: Return exactly 5 targets (got 3)").kind, "plan", "other plan problems stay plan problems");
  const english = inLanguage("en", () => m.describeFailure(raw));
  assert.doesNotMatch(`${english.title} ${english.hint}`, han);
});

test("the draft reads how many batches passed or failed and why: '5 个批次的引用在资料里找不到'", () => {
  const found = m.shortfall(shortDraft());
  assert.match(found.report.lead, /共 6 个批次：1 个全部通过，0 个只保留了部分题，5 个没有出题。/);
  assert.deepEqual(found.report.reasons, ["5 个批次的引用在资料里找不到"]);
  assert.match(found.report.repaired, /2 道题/);
  assert.equal(m.shortfall({ ...shortDraft(), editorial: { ...shortDraft().editorial, partReport: undefined } }).report, null, "an older draft has no report and shows none");
  assert.equal(m.shortfall({ ...shortDraft(), editorial: { ...shortDraft().editorial, partReport: { ...partReport, passed: 6, failed: 0, reasons: {} } } }).report, null);
});

const noop = () => {};
const home = (data) => renderToStaticMarkup(React.createElement(map.StudyMap, mapProps({ data: { root: "/tmp/lib", decks: [], progress: {}, sources: [{ id: "s" }], runs: [], jobs: [], drafts: [],
  today: { due: 0, weak: 0, new: 0, size: 0 }, focus: { mode: "class", course: "", courses: [], fresh: [] }, modelReady: true, ...data },
busy: false, start: noop, resume: noop, endRun: noop, manage: noop, openDraft: noop, topUpDraft: noop, retryGeneration: noop, addSource: noop,
createManual: noop, importLibrary: noop, askInChat: noop, notebooks: [], onFocus: noop, cancelJob: noop, dismissJob: noop })));
const job = { id: "a", status: "complete", stageCode: "partial", draftId: "dr", savedCount: 4, requestedTotal: 25, parts: 6, stage: "Draft ready with 4/25 questions; 5 part(s) failed" };

test("the job card of a partly failed generation says why in the learner's language and offers the one top-up", () => {
  map.forgetCoverage();
  seedView(map, draftView({ draftId: "dr", draftVersion: 2, covered: ["r1.p1"], failed: ["r1.p2"] }));
  const html = home({ drafts: [shortDraft()], jobs: [job] });
  assert.match(html, /5 个批次的引用在资料里找不到/);
  assert.equal((html.match(/为没覆盖的部分补题/g) || []).length, 1, "the retry of what is missing is offered once, as the one top-up");
  assert.doesNotMatch(html, /继续补齐/);
  const english = inLanguage("en", () => home({ drafts: [{ ...shortDraft(), title: "Architecting" }], jobs: [{ ...job, deckTitle: "Architecting" }] })).replace(/<[^>]+>/g, " ");
  assert.doesNotMatch(english, han, (english.match(/.{0,30}[㐀-鿿].{0,30}/) || [])[0]);
  assert.match(english, /5 batch\(es\) quoted text that could not be found in the sources/);
  assert.match(english, /Add questions for the uncovered parts/);
  assert.doesNotMatch(english, /Continue generation for/);
});

test("the notice the chat agent receives says why parts failed and offers the top-up instead of a hand-made retry", () => {
  const sent = [];
  const notify = createJobNotifier((message) => sent.push(message));
  const job = { id: "j1", status: "complete", deckTitle: "Architecting", draftId: "dr", savedCount: 4, requestedTotal: 25, stage: "Draft ready with 4/25 questions; 5 part(s) failed", language: "zh",
    partReport: { total: 6, passed: 1, partial: 0, failed: 5, reasons: { quote: 5 } } };
  notify({ ...job, partReport: { ...job.partReport, summary: describePartReport(job.partReport, "zh") } });
  notify({ ...job, language: "en", partReport: { ...job.partReport, summary: describePartReport(job.partReport, "en") } });
  assert.match(sent[0].text, /5 个批次的引用在资料里找不到/);
  assert.match(sent[0].text, /为没覆盖的部分补题.*resumeDraftId dr/);
  assert.match(sent[1].text, /5 batch\(es\) quoted text that could not be found/);
  assert.match(sent[1].text, /generate with resumeDraftId dr/);
  assert.match(sent[1].text, /instead of asking them to select fewer pages/);
  notify({ ...job, savedCount: 25 });
  assert.doesNotMatch(sent[2].text, /resumeDraftId/, "a complete draft is not offered a top-up");
});
