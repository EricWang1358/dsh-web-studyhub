/* WP12 · case sets are authored by the ordinary generation pipeline: the
   `generate` action with kind 'case' writes an original scenario (saved as a
   material) and open questions with marks and rubric criteria, runs the one
   independent review, and saves a normal draft that publishes through
   draft.publish. A pasted case (scenario + questions) takes the same path and,
   with the learner's answers, is published and graded at once. Exam settings,
   guidance and focus topics come from the course profile (WP13), never from
   the deck. All cases here are synthetic. */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StudyService } from "../lib/service.js";
import { validateDeck } from "../lib/domain.js";
import { resolveCourseProfile, defaultCourseProfile } from "../lib/case-study.js";
import { createFakeModel } from "../scripts/fake-model.mjs";

const materials = [
  { title: "Architectural styles", text: "Microservices split a system into independently deployable services that own their data. " +
    "Event-driven architecture lets services react to events published by others, which decouples producers from consumers. " +
    "The strangler fig pattern migrates a monolith incrementally by routing features to new services one at a time." },
  { title: "Cloud persistence", text: "Polyglot persistence chooses a different data store for each workload. " +
    "Relational databases give ACID transactions for payments and settlements. Key-value stores serve sessions and carts at low latency. " +
    "Object storage keeps large media files cheaply and durably." },
];
const guidance = { title: "Examiner briefing", text: "Tie every technology you recommend to a fact stated in the case. " +
  "When the case is silent, write down your assumption before you answer. Justify each choice and say why not the alternative." };

async function library(t, options = {}) {
  const root = await mkdtemp(join(tmpdir(), "study-wp12-gen-"));
  const service = new StudyService(root, { complete: createFakeModel(), ...options });
  t.after(async () => { service.dispose(); await rm(root, { recursive: true, force: true }); });
  const sourceIds = [];
  for (const item of materials) sourceIds.push((await service.call("source.add", { ...item, courses: ["Cloud Native"] })).id);
  const guide = await service.call("source.add", { ...guidance, courses: ["Cloud Native"] });
  return { service, sourceIds, guidanceId: guide.id };
}
const wait = (service, jobId) => service.call("job.wait", { jobId, timeoutSeconds: 30 });
async function generated(t, { options, args } = {}) {
  const lib = await library(t, options);
  const started = await lib.service.call("generate", { kind: "case", sourceIds: lib.sourceIds, guidanceSourceIds: [lib.guidanceId],
    questions: 2, totalMarks: 20, focusTopics: ["Cloud persistence"], language: "English", title: "Harbour practice case", course: "Cloud Native", ...args });
  const job = await wait(lib.service, started.jobId);
  return { ...lib, job, state: await lib.service.store.read() };
}

test("generate kind 'case' runs the generation job and saves a normal draft with the scenario as a material", async (t) => {
  const { job, state } = await generated(t);
  assert.equal(job.kind, "case");
  assert.equal(job.status, "complete", job.stage);
  assert.equal(job.stageCode, "done");
  assert.ok(job.steps.some((step) => step.stage.includes("Writing")) && job.steps.some((step) => step.stage.includes("Review")),
    "authoring and the one independent review are visible steps");
  const draft = state.drafts.find((item) => item.id === job.draftId);
  assert.ok(draft, "a draft is saved like any generation");
  assert.equal(draft.format, "case-study");
  assert.equal(draft.course, "Cloud Native");
  assert.equal(draft.case.origin, "generated");
  assert.equal(draft.case.totalMarks, 20);
  for (const key of ["guidanceSourceIds", "focusTopics", "minutesPerMark", "readingMinutes", "timeLimitMinutes"])
    assert.equal(draft.case[key], undefined, `${key} belongs to the course profile, not the deck`);
  const scenario = state.sources.find((source) => source.id === draft.case.sourceId);
  assert.ok(scenario, "the scenario is a material");
  assert.ok(scenario.text.split(/\s+/).length >= 600, "a full case of 600+ words");
  assert.deepEqual(scenario.courses, ["Cloud Native"]);
  assert.equal(draft.cards.length, 2);
  assert.ok(draft.cards.every((card) => card.kind === "open" && card.marks > 0 && card.rubricCriteria.length && card.rubric));
  assert.equal(draft.cards.reduce((sum, card) => sum + card.marks, 0), 20);
  assert.ok(draft.cards.every((card) => card.citations.length && card.citations.every((ref) => ref.sourceId === scenario.id)));
  assert.deepEqual(validateDeck(draft, state.sources).errors, []);
  assert.ok(draft.case.cues.length >= 1 && draft.case.cues.every((cue) => scenario.text.includes(cue.quote)));
  assert.equal(draft.editorial.generation.kind, "case");
  assert.deepEqual(draft.editorial.generation.sourceIds, state.sources.filter((source) => materials.some((item) => item.title === source.title)).map((source) => source.id));
  assert.equal(Object.keys(draft.editorial.reviewedCards).length, 2, "both questions passed the independent review");
  // An examiner-guidance material calibrates the rubric: its points appear in the descriptors.
  const descriptors = draft.cards.flatMap((card) => card.rubricCriteria.map((criterion) => criterion.descriptor)).join("\n");
  assert.match(descriptors, /Tie every technology you recommend to a fact stated in the case/);
});

test("a pasted past paper is a style template only: the origin is styled and nothing is copied", async (t) => {
  const styleText = "QUANTUM PARCELS LTD is a courier firm whose dispatch mainframe dates from 1998. Question 1 (12 marks) asks which architecture style suits it.";
  const { job, state } = await generated(t, { args: { styleText } });
  assert.equal(job.status, "complete", job.stage);
  const draft = state.drafts.find((item) => item.id === job.draftId);
  assert.equal(draft.case.origin, "styled");
  assert.doesNotMatch(state.sources.find((source) => source.id === draft.case.sourceId).text, /QUANTUM PARCELS/);
});

const mismatch = (paper) => {
  paper.questions[1].criteria = paper.questions[0].criteria.map((criterion) => ({ ...criterion }));
  paper.questions[1].criteria[0].marks += paper.questions[1].marks - paper.questions[0].marks;
  return paper;
};

test("the review flags a question whose criteria do not match it; the draft keeps it for the usual repair", async (t) => {
  const fake = createFakeModel();
  const complete = async (system, prompt, options) => {
    const reply = await fake(system, prompt, options);
    return system.startsWith("You write original case-study exam papers") ? JSON.stringify(mismatch(JSON.parse(reply))) : reply;
  };
  const { job, state } = await generated(t, { options: { complete } });
  assert.equal(job.status, "complete", job.stage);
  const draft = state.drafts.find((item) => item.id === job.draftId);
  const [first, second] = draft.cards;
  assert.ok(draft.editorial.reviewedCards[first.id], "the sound question is approved");
  assert.equal(draft.editorial.reviewedCards[second.id], undefined);
  assert.match(draft.editorial.rejectedIssues[second.id].join(" "), /criteria/i, "the flagged question waits for repair");
});

test("a paper whose cues are not in the scenario is re-written once and then rejected", async (t) => {
  const fake = createFakeModel();
  let authored = 0;
  const complete = async (system, prompt, options) => {
    const reply = await fake(system, prompt, options);
    if (!system.startsWith("You write original case-study exam papers")) return reply;
    authored++;
    const paper = JSON.parse(reply);
    paper.cues = [{ id: "cue1", paragraph: 2, quote: "A sentence that never appears anywhere in the scenario text.", implies: "nothing" }];
    return JSON.stringify(paper);
  };
  const { job, state } = await generated(t, { options: { complete } });
  assert.equal(job.status, "failed");
  assert.equal(authored, 2, "one structural re-write");
  assert.match(job.stage, /cue/);
  assert.equal(state.drafts.length, 0);
  assert.equal(state.sources.filter((source) => /^Case: |^案例：/.test(source.title)).length, 0, "no orphan scenario");
});

test("a case draft publishes through draft.publish into a case deck the library shows with its marks", async (t) => {
  const { service, job, state } = await generated(t);
  const draft = state.drafts.find((item) => item.id === job.draftId);
  const receipt = await service.call("draft.publish", { id: draft.id, draftVersion: draft.draftVersion });
  const after = await service.store.read();
  const deck = after.decks.find((item) => item.id === receipt.deckId);
  assert.equal(deck.format, "case-study");
  assert.equal(deck.cards.length, 2);
  const summary = (await service.call("snapshot")).decks.find((item) => item.id === deck.id);
  assert.equal(summary.format, "case-study");
  assert.equal(summary.caseMarks, 20);
  assert.equal(summary.caseSourceId, deck.case.sourceId);
  assert.equal(summary.caseBest, null);
  // 再来一个同类案例: the same materials and paper shape, a new scenario.
  const again = await service.call("generate", { kind: "case", fromDeckId: deck.id });
  const next = await wait(service, again.jobId);
  assert.equal(next.status, "complete", next.stage);
  const sibling = (await service.store.read()).drafts.find((item) => item.id === next.draftId);
  assert.equal(sibling.case.totalMarks, 20);
  assert.equal(sibling.course, "Cloud Native");
  assert.deepEqual(sibling.editorial.generation.sourceIds, draft.editorial.generation.sourceIds);
  assert.notEqual(sibling.case.sourceId, deck.case.sourceId, "a fresh scenario material");
});

const pasted = {
  title: "Orchard Cold Chain",
  scenario: ["Orchard Cold Chain stores fresh fruit for supermarkets in three refrigerated warehouses.",
    "Temperature sensors report every minute to a desktop program written in Visual Basic in 2009.",
    "In March a warehouse lost power overnight and nobody was alerted until the morning shift arrived.",
    "Management wants customers to see live temperatures on their phones next season."].join("\n\n"),
  questions: [{ prompt: "Which architecture style would you recommend for the new monitoring platform? Justify.", marks: 6 },
    { prompt: "Which data stores would you use for the sensor readings and the customer portal? Justify.", marks: 4 }],
};
const myAnswer = "I recommend an event-driven architecture because the sensors already publish readings every minute.\n" +
  "Each reading becomes an event that an alerting service consumes, so a power loss raises an alarm at once.\n" +
  "I would also use Kubernetes for everything.\nThe case does not say how many sensors there are, so I assume about 500.";

test("a pasted case with the learner's answer is published and graded at once", async (t) => {
  const lib = await library(t);
  const started = await lib.service.call("generate", { kind: "case", ...pasted, answers: [myAnswer, ""], sourceIds: lib.sourceIds,
    language: "English", course: "Cloud Native" });
  const job = await wait(lib.service, started.jobId);
  assert.equal(job.status, "complete", job.stage);
  const state = await lib.service.store.read();
  const deck = state.decks.find((item) => item.id === job.publication?.deckId);
  assert.ok(deck, "published straight into a case deck");
  assert.equal(deck.case.origin, "imported");
  assert.deepEqual(deck.cards.map((card) => card.marks), [6, 4]);
  assert.equal(state.drafts.length, 0);
  assert.deepEqual(validateDeck(deck, state.sources).errors, []);
  const rubric = state.attempts.filter((item) => item.assessment === "rubric");
  assert.equal(rubric.length, 1, "the answered question is graded");
  assert.equal(rubric[0].quiz_id, deck.cards[0].id);
  assert.ok(rubric[0].rubric.criteria.length >= 2);
  assert.ok(state.inbox.some((item) => item.kind === "grade" && item.cardId === deck.cards[0].id), "the result is in the inbox");
  assert.ok(deck.cards[0].review.due_at, "SM-2 scheduled the graded question");
  const summary = (await lib.service.call("snapshot")).decks.find((item) => item.id === deck.id);
  assert.deepEqual(summary.caseBest, { total: rubric[0].score, max: 10 });
});

test("weak criteria become drills in the course deck through the supplementation pipeline", async (t) => {
  const lib = await library(t);
  const started = await lib.service.call("generate", { kind: "case", ...pasted, answers: [myAnswer, ""], sourceIds: lib.sourceIds,
    language: "English", course: "Cloud Native" });
  const job = await wait(lib.service, started.jobId);
  const deckId = job.publication.deckId;
  const drills = await lib.service.call("case.drills", { deckId });
  assert.ok(drills.criteria >= 1);
  const done = await wait(lib.service, drills.jobId);
  assert.equal(done.type, "supplement");
  assert.equal(done.status, "complete", done.stage);
  const state = await lib.service.store.read();
  const target = state.decks.find((item) => item.id === drills.deckId);
  assert.ok(target && !target.format && target.course === "Cloud Native", "an ordinary deck of the same course");
  assert.ok(target.cards.length >= 2 && target.cards.every((card) => ["quiz", "flashcard"].includes(card.kind) && card.review));
  assert.equal(state.decks.find((item) => item.id === deckId).case.drillDeckId, target.id);
  const again = await lib.service.call("case.drills", { deckId });
  assert.equal(again.deckId, target.id, "later drills reuse the same deck");
  await wait(lib.service, again.jobId);
});

test("case requests are validated in the request language", async (t) => {
  const lib = await library(t);
  await assert.rejects(lib.service.call("generate", { kind: "case", sourceIds: lib.sourceIds, questions: 9, uiLanguage: "en" }), /1–5 questions/);
  await assert.rejects(lib.service.call("generate", { kind: "case", sourceIds: lib.sourceIds, totalMarks: 2, uiLanguage: "en" }), /total marks/);
  await assert.rejects(lib.service.call("generate", { kind: "case", scenario: "too short", questions: [], uiLanguage: "en" }), /scenario/);
  await assert.rejects(lib.service.call("generate", { kind: "case", sourceIds: lib.sourceIds, questions: 9 }), /1–5 道题/);
});

test("the course profile adapter fills defaults before and after WP13", async () => {
  assert.deepEqual(await resolveCourseProfile(async () => { throw new Error("Capability unavailable: course.profile"); }, "Cloud Native"),
    defaultCourseProfile("Cloud Native"));
  const profile = await resolveCourseProfile(async (action, args) => ({ courseId: "c1", name: args.name, exam: { minutesPerMark: 2.5, readingMinutes: 30 },
    guidanceSourceIds: ["g"], focusTopics: ["Cloud Persistence"] }), "Cloud Native");
  assert.equal(profile.exam.minutesPerMark, 2.5);
  assert.equal(profile.exam.readingMinutes, 30);
  assert.equal(profile.exam.sections.length, 0, "missing fields keep their defaults");
  assert.deepEqual(profile.guidanceSourceIds, ["g"]);
  assert.equal((await resolveCourseProfile({ courses: [{ name: "Other" }] }, "Cloud Native")).exam.minutesPerMark, 3);
});
