/* WP12 · onboarding: the sample course carries one small case set with a
   pre-graded example paper (no model calls), shown in the library, the exam
   history and the rubric skills, removed with the rest of the sample; the
   tour stops at 案例分析卷. */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createPreviewServer } from "../scripts/preview-server.mjs";
import { Store } from "../lib/store.js";
import { validateDeck } from "../lib/domain.js";
import { rubricSkills } from "../lib/case-study.js";
import { TOUR_STEPS } from "../ui/tour/steps.js";
import en from "../lib/sample/en.js";
import zh from "../lib/sample/zh.js";

const repo = fileURLToPath(new URL("../", import.meta.url));
const han = /[㐀-鿿]/;
async function start(t) {
  const base = join(repo, "output", "test-wp12");
  await mkdir(base, { recursive: true });
  const libraryRoot = await mkdtemp(join(base, "lib-")), home = await mkdtemp(join(base, "home-"));
  t.after(() => Promise.all([libraryRoot, home].map((dir) => rm(dir, { recursive: true, force: true, maxRetries: 3 }))));
  let calls = 0;
  const server = await createPreviewServer({ libraryRoot, home, port: 0, model: async () => { calls++; throw new Error("no model calls while loading the sample"); } });
  t.after(() => server.close());
  const call = async (action, args = {}) => {
    const res = await fetch(server.url + "/api/call", { method: "POST", headers: { "Content-Type": "application/json", "X-Study-Token": server.token },
      body: JSON.stringify({ action, args }) });
    const body = await res.json();
    if (!body.ok) throw new Error(body.error);
    return body.value;
  };
  return { call, libraryRoot, calls: () => calls };
}

test("both sample editions carry the same case set; English has no Chinese", () => {
  for (const content of [en, zh]) {
    const study = content.caseStudy;
    assert.ok(study, content.language);
    const text = study.scenario.paragraphs.join("\n\n");
    for (const question of study.questions) {
      assert.ok(text.includes(question.quote), `${content.language} ${question.key}: citation not in the scenario`);
      assert.equal(question.criteria.reduce((sum, criterion) => sum + criterion.marks, 0), question.marks);
    }
    for (const cue of study.cues) assert.ok(text.includes(cue.quote), `${content.language} ${cue.id}`);
    for (const [key, answer] of study.attempt.answers) {
      const grading = study.attempt.grading.find((item) => item.key === key);
      for (const quote of grading.criteria.flatMap((criterion) => criterion.evidence || []))
        assert.ok(answer.replace(/\s+/g, " ").includes(quote), `${content.language} ${key}: evidence is verbatim`);
    }
  }
  const shape = (content) => content.caseStudy.questions.map((question) => [question.key, question.marks, question.criteria.map((criterion) => criterion.marks).join(",")]);
  assert.deepEqual(shape(zh), shape(en));
  assert.doesNotMatch(JSON.stringify(en.caseStudy), han);
});

test("the sample case set is published, pre-graded without a model, visible in the library and removed with the sample", async (t) => {
  const { call, libraryRoot, calls } = await start(t);
  const status = await call("sample.load", { language: "en" });
  assert.ok(status.caseDeckId, "the status names the sample case set");
  const snapshot = await call("snapshot", { uiLanguage: "en" });
  const deck = snapshot.decks.find((item) => item.id === status.caseDeckId);
  assert.equal(deck.format, "case-study");
  assert.equal(deck.caseMarks, 10);
  assert.ok(deck.caseBest && deck.caseBest.total > 0 && deck.caseBest.max === 10, "the example paper's score is its best");
  const paper = snapshot.exams.find((item) => item.examKinds === "case");
  assert.ok(paper, "the graded example paper is in the exam history");
  const report = await call("exam.report", { runId: paper.runId });
  assert.equal(report.case.pending, 0);
  assert.ok(report.case.questions.every((question) => question.status === "graded" && question.rubric.criteria.length >= 2));
  assert.ok(report.case.weakest.length >= 1);
  assert.ok(report.case.questions.some((question) => question.rubric.unanchored.length), "the example shows a recommendation without a case anchor");
  const state = await new Store(libraryRoot).read();
  const live = state.decks.find((item) => item.id === status.caseDeckId);
  assert.deepEqual(validateDeck(live, state.sources).errors, []);
  assert.ok(rubricSkills(snapshot.attempts).length >= 2, "rubric skills have data");
  assert.equal(snapshot.decks.find((item) => item.id.startsWith("sample-")).format, undefined, "the pattern deck stays the first sample deck");
  assert.equal(calls(), 0, "loading the sample never calls a model");
  await call("sample.remove", {});
  const after = await new Store(libraryRoot).read();
  assert.equal(after.decks.length, 0);
  assert.equal(after.sources.length, 0);
  assert.equal(after.runs.filter((run) => run.examKinds === "case").length, 0);
  assert.equal(after.attempts.length, 0);
  assert.equal(after.inbox.length, 0);
});

test("the tour stops at 案例分析卷 right after the exam step", async () => {
  const ids = TOUR_STEPS.map((step) => step.id);
  assert.equal(ids[ids.indexOf("exam") + 1], "case");
  const step = TOUR_STEPS.find((item) => item.id === "case");
  assert.equal(step.page, "exam");
  assert.equal(step.anchor, "exam-case");
  const source = await readFile(join(repo, "ui/ExamShell.jsx"), "utf8");
  assert.match(source, /data-tour="exam-case"/);
  const catalogue = Object.assign({}, ...await Promise.all((await readdir(join(repo, "ui/locales"))).filter((name) => /^en(\..+)?\.json$/.test(name))
    .map(async (name) => JSON.parse(await readFile(join(repo, "ui/locales", name), "utf8")))));
  for (const text of [step.title, step.body, step.modelNote].filter(Boolean)) assert.ok(Object.hasOwn(catalogue, text), text);
});
