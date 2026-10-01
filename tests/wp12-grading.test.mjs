/* WP12 · grading a case-study answer. The model marks each criterion; the
   code decides what is trusted: scores are clamped to [0, max], evidence must
   be a verbatim quote of the learner's answer, every criterion is scored once
   (missing ones count 0 with a note), key points the grader neither credited
   nor listed are reported missing, recommendations without a case anchor and
   assumption chains are validated against the answer and the case, and a
   malformed reply is asked again once.

   The case below is synthetic (a timed-bid marketplace for used farm
   machinery); it exists only for these tests. */
import test from "node:test";
import assert from "node:assert/strict";
import { normalizeGrading, smGradeFor, bandFor, weakCriteria, keyPointId } from "../lib/case-study.js";
import { gradeCase } from "../lib/contexts/case/pipeline.js";

const scenario = [
  "FieldBid runs timed online auctions for used tractors and harvesters across four provinces.",
  "Its bidding engine is a single PHP application with one MySQL database hosted in a rented rack.",
  "Several sellers reported that winning bids were placed from accounts created minutes before the auction closed.",
  "The board wants a mobile app for farmers within a year and hopes to cut hosting costs.",
].join("\n\n");
const questions = [
  { cardId: "q1", marks: 10, criteria: [
    { id: "c1", label: "Architecture style", marks: 4, keyPoints: ["Event-driven bidding", "Why not a big-bang rewrite"] },
    { id: "c2", label: "Hidden cues", marks: 3, keyPoints: ["Late-account bids → fraud analytics on bid events"] },
    { id: "c3", label: "Assumptions", marks: 3, keyPoints: [] },
  ] },
  { cardId: "q2", marks: 6, criteria: [
    { id: "c1", label: "Persistence choice", marks: 4, keyPoints: ["Relational store for settlements"] },
    { id: "c2", label: "Justification", marks: 2, keyPoints: ["Why not a document store"] },
  ] },
];
const answer = "I recommend an event-driven architecture around the bidding engine.\nEach bid becomes an event that other services consume.\n" +
  "I would also move everything to Kubernetes.\nThe case does not say how many concurrent bidders there are, so I assume about 2,000 at peak.";
const answers = { q1: answer, q2: "" };

test("scores are clamped and halved, evidence must be verbatim (whitespace-normalised), each criterion is scored once", () => {
  const raw = { questions: [{ cardId: "q1", summary: "Clear style.", criteria: [
    { id: "c1", score: 9, evidence: ["I recommend an event-driven   architecture\naround the bidding engine.", "I recommend microservices everywhere."],
      covered: ["c1.k1", "c1.k2"], missing: [], suggestion: "Name the strangler pattern." },
    { id: "c1", score: 0, evidence: [], covered: [], missing: [], suggestion: "duplicate is ignored" },
    { id: "c3", score: -2, evidence: ["so I assume about 2,000 at peak"], covered: [], missing: ["Mention data retention"], suggestion: "" },
    { id: "zz", score: 3, evidence: [], covered: [], missing: [], suggestion: "unknown criterion" },
  ] }], summary: "Overall fine." };
  const result = normalizeGrading(raw, { questions, answers, scenario });
  const q1 = result.questions[0];
  assert.deepEqual(q1.criteria.map((criterion) => [criterion.id, criterion.score, criterion.max]), [["c1", 4, 4], ["c2", 0, 3], ["c3", 0, 3]]);
  assert.deepEqual(q1.criteria[0].evidence, ["I recommend an event-driven architecture around the bidding engine."]);
  assert.equal(q1.criteria[0].suggestion, "Name the strangler pattern.");
  assert.equal(result.dropped.evidence, 1);
  assert.equal(q1.criteria[1].note, "not-scored", "a criterion the grader skipped counts 0 with a note");
  assert.deepEqual(q1.criteria[1].missing.map((point) => point.text), ["Late-account bids → fraud analytics on bid events"]);
  assert.deepEqual(q1.criteria[2].missing, [{ text: "Mention data retention" }]);
  assert.equal(q1.total, 4);
  assert.equal(q1.max, 10);
  assert.equal(normalizeGrading({ questions: [{ cardId: "q1", criteria: [{ id: "c1", score: 2.3 }] }] }, { questions, answers, scenario }).questions[0].criteria[0].score, 2.5);
});

test("an unanswered question scores zero without asking the model; totals map to a band and an SM-2 grade", () => {
  const raw = { questions: [{ cardId: "q1", criteria: [
    { id: "c1", score: 4, evidence: [], covered: ["c1.k1", "c1.k2"] }, { id: "c2", score: 3, covered: ["c2.k1"] }, { id: "c3", score: 1 },
  ] }, { cardId: "q2", criteria: [{ id: "c1", score: 4 }, { id: "c2", score: 2 }] }] };
  const result = normalizeGrading(raw, { questions, answers, scenario });
  const q2 = result.questions[1];
  assert.equal(q2.unanswered, true);
  assert.equal(q2.total, 0, "marks for a blank answer are never taken from the grader");
  assert.deepEqual(q2.criteria.map((criterion) => criterion.note), ["unanswered", "unanswered"]);
  assert.equal(result.total, 8);
  assert.equal(result.max, 16);
  assert.equal(result.ratio, 0.5);
  assert.equal(result.band, "pass");
  assert.equal(result.grade, smGradeFor(8, 16));
  assert.deepEqual([[16, 16], [15, 16], [12, 16], [10, 16], [8, 16], [5, 16], [2, 16], [0, 0]].map(([total, max]) => smGradeFor(total, max)),
    [5, 5, 4, 3, 2, 1, 0, 0]);
  assert.deepEqual([0.9, 0.75, 0.55, 0.2].map(bandFor), ["excellent", "good", "pass", "weak"]);
});

test("a hidden cue the grader neither credits nor lists is reported under missing", () => {
  // The fake grader takes marks off the cue criterion but forgets to name the fraud cue.
  const raw = { questions: [{ cardId: "q1", criteria: [
    { id: "c1", score: 4, covered: ["c1.k1", "c1.k2"] },
    { id: "c2", score: 1, evidence: ["Each bid becomes an event that other services consume."], covered: [], missing: [] },
    { id: "c3", score: 3 },
  ] }] };
  const result = normalizeGrading(raw, { questions, answers, scenario });
  const cue = result.questions[0].criteria[1];
  assert.deepEqual(cue.missing, [{ id: keyPointId("c2", 0), text: "Late-account bids → fraud analytics on bid events" }]);
  assert.deepEqual(result.questions[0].criteria[0].missing, [], "full marks need no missing list");
});

test("recommendations without a case anchor are kept only with a verbatim quote and a real case cue", () => {
  const raw = { questions: [{ cardId: "q1", criteria: [], unanchored: [
    { quote: "I would also move everything to Kubernetes.", cue: "Several sellers reported that winning bids were placed from accounts created minutes before the auction closed." },
    { quote: "I would use serverless functions.", cue: "Several sellers reported that winning bids were placed" },
    { quote: "I would also move everything to Kubernetes.", cue: "The company suffered a ransomware attack." },
  ] }] };
  const result = normalizeGrading(raw, { questions, answers, scenario });
  assert.deepEqual(result.questions[0].unanchored, [{ quote: "I would also move everything to Kubernetes.",
    cue: "Several sellers reported that winning bids were placed from accounts created minutes before the auction closed." }]);
  assert.equal(result.dropped.unanchored, 2);
});

test("assumption items must name something the case does not say; stated ones must quote the learner", () => {
  const raw = { questions: [{ cardId: "q1", criteria: [], assumptions: [
    { gap: "the number of concurrent bidders", stated: true, quote: "so I assume about 2,000 at peak" },
    { gap: "the budget for the migration", stated: false, suggestion: "State an assumed budget, then size the first phase to it." },
    { gap: "hosted in a rented rack", stated: false, suggestion: "The case already says this." },
    { gap: "the bid volume", stated: true, quote: "I assume ten thousand bids a minute" },
  ] }] };
  const result = normalizeGrading(raw, { questions, answers, scenario });
  assert.deepEqual(result.questions[0].assumptions, [
    { gap: "the number of concurrent bidders", stated: true, quote: "so I assume about 2,000 at peak" },
    { gap: "the budget for the migration", stated: false, suggestion: "State an assumed budget, then size the first phase to it." },
  ]);
  assert.equal(result.dropped.assumptions, 2);
});

test("weak criteria are those below 60 %, weakest first", () => {
  const raw = { questions: [{ cardId: "q1", criteria: [{ id: "c1", score: 4, covered: ["c1.k1", "c1.k2"] }, { id: "c2", score: 1 }, { id: "c3", score: 1.5 }] }] };
  const weak = weakCriteria(normalizeGrading(raw, { questions, answers, scenario }));
  assert.deepEqual(weak.map((item) => [item.cardId, item.criterionId]), [["q2", "c1"], ["q2", "c2"], ["q1", "c2"], ["q1", "c3"]]);
  assert.ok(weak.every((item) => item.ratio < 0.6));
});

const paper = { title: "FieldBid", paragraphs: scenario.split("\n\n"), cues: [], questions: questions.map((question) => ({ ...question, prompt: "Recommend.", answer: "Ref." })) };
const goodReply = JSON.stringify({ questions: [{ cardId: "q1", criteria: [{ id: "c1", score: 3 }, { id: "c2", score: 2 }, { id: "c3", score: 1 }] }], summary: "ok" });

test("gradeCase asks again once when the reply is not usable JSON, then normalises", async () => {
  const calls = [];
  const complete = async (system, prompt) => { calls.push(prompt); return calls.length === 1 ? "I think the learner did well." : goodReply; };
  const result = await gradeCase(complete, { paper, answers, scenario }, { retryDelays: [] });
  assert.equal(calls.length, 2);
  assert.match(calls[1], /not usable JSON/);
  assert.equal(result.total, 6);
  assert.match(calls[0], /^Mark every answered question/);
  assert.ok(calls[0].includes("so I assume about 2,000 at peak"), "the learner's answer is part of the data");
  assert.ok(!calls[0].includes('"cardId":"q2"'), "blank questions are not sent for grading");
});

test("gradeCase fails after a second malformed reply and retries transient model failures", async () => {
  await assert.rejects(gradeCase(async () => "{\"questions\": 3}", { paper, answers, scenario }, { retryDelays: [] }), /grading reply/i);
  let attempts = 0;
  const flaky = async () => { attempts++; if (attempts === 1) throw Object.assign(new Error("Too many requests"), { status: 429 }); return goodReply; };
  const result = await gradeCase(flaky, { paper, answers, scenario }, { retryDelays: [0] });
  assert.equal(attempts, 2);
  assert.equal(result.total, 6);
});
