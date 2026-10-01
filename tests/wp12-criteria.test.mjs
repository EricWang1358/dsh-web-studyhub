/* WP12 · case-study rubrics and the exam time model. A case question is an
   `open` card with marks and structured rubric criteria; lib/domain.js checks
   the criteria (marks sum, unique ids, non-empty descriptors) and the plain
   `rubric` text stays readable for older readers. The time model follows the
   lecturer's briefing: about three minutes per mark, a reading phase first. */
import test from "node:test";
import assert from "node:assert/strict";
import { validateDeck, draftShapeErrors, rubricCriteriaIssues } from "../lib/domain.js";
import {
  CASE_FORMAT, DEFAULT_MINUTES_PER_MARK, renderRubric, isCaseDeck, scenarioParagraphs, containsVerbatim, countWords,
  questionMinutes, lengthHint, suggestedWords, defaultReadingMinutes, paperPlan, blankQuestions, pacingReport, paceStatus,
} from "../lib/case-study.js";

const scenario = "Northwind Ferries runs island crossings with a booking system built ten years ago.\n\n" +
  "Last spring the booking site suffered repeated credential-stuffing attacks that locked customers out.";
const criteria = () => [
  { id: "c1", label: "Recommendation", marks: 4, descriptor: "Names one architecture style and justifies it against an alternative.", keyPoints: ["Event-driven booking", "Why not a full rewrite"] },
  { id: "c2", label: "Case linkage", marks: 3, descriptor: "Ties every choice to a fact from the case.", keyPoints: ["Credential-stuffing attacks → monitoring"] },
  { id: "c3", label: "Assumptions", marks: 3, descriptor: "States assumptions where the case is silent.", keyPoints: [] },
];
const card = (patch = {}) => ({
  id: "q1", kind: "open", topic: "Architecture styles", objective: "Recommend an architecture style for Northwind",
  prompt: "Which architecture style would you recommend for Northwind's booking platform? Justify.",
  answer: "An event-driven, incrementally migrated architecture.", hint: "Start from the problems the case lists.",
  explanation: "An excellent answer names a style, ties it to the attacks and the old system, and states assumptions.",
  misconception: "Recommending microservices without tying them to the case.", marks: 10, rubricCriteria: criteria(),
  rubric: "see criteria", citations: [{ sourceId: "case", quote: "suffered repeated credential-stuffing attacks" }], ...patch,
});
const sources = [{ id: "case", title: "Northwind case", text: scenario }];

test("rubric criteria: valid criteria pass and the deck validates", () => {
  assert.deepEqual(rubricCriteriaIssues(card()), []);
  assert.deepEqual(validateDeck({ title: "Northwind", cards: [card()] }, sources).errors, []);
});

test("rubric criteria: marks must add up to the question's marks", () => {
  const issues = rubricCriteriaIssues(card({ marks: 12 }));
  assert.ok(issues.some((issue) => /add up to 10, not 12/.test(issue)), issues.join("; "));
  const deck = validateDeck({ title: "Northwind", cards: [card({ marks: 12 })] }, sources);
  assert.ok(deck.errors.some((issue) => /^Card 1: rubric criteria marks add up to 10, not 12/.test(issue)), deck.errors.join("; "));
});

test("rubric criteria: ids are unique and non-empty, labels and descriptors are required", () => {
  const duplicate = criteria(); duplicate[1].id = "c1";
  assert.ok(rubricCriteriaIssues(card({ rubricCriteria: duplicate })).some((issue) => /duplicate criterion id c1/.test(issue)));
  const blankId = criteria(); blankId[0].id = " ";
  assert.ok(rubricCriteriaIssues(card({ rubricCriteria: blankId })).some((issue) => /criterion 1 needs an id/.test(issue)));
  const blankDescriptor = criteria(); blankDescriptor[2].descriptor = "  ";
  assert.ok(rubricCriteriaIssues(card({ rubricCriteria: blankDescriptor })).some((issue) => /criterion c3 needs a descriptor/.test(issue)));
  const blankLabel = criteria(); blankLabel[0].label = "";
  assert.ok(rubricCriteriaIssues(card({ rubricCriteria: blankLabel })).some((issue) => /criterion c1 needs a label/.test(issue)));
  const badMarks = criteria(); badMarks[0].marks = 0;
  assert.ok(rubricCriteriaIssues(card({ rubricCriteria: badMarks })).some((issue) => /criterion c1 needs positive marks/.test(issue)));
  const badPoints = criteria(); badPoints[0].keyPoints = ["fine", ""];
  assert.ok(rubricCriteriaIssues(card({ rubricCriteria: badPoints })).some((issue) => /criterion c1 key points must be non-empty text/.test(issue)));
  assert.ok(rubricCriteriaIssues(card({ rubricCriteria: [] })).some((issue) => /at least one criterion/.test(issue)));
  assert.ok(rubricCriteriaIssues(card({ kind: "quiz" })).some((issue) => /only open questions/.test(issue)));
  assert.ok(rubricCriteriaIssues(card({ marks: undefined })).some((issue) => /question marks/.test(issue)));
});

test("rubric criteria: cards without criteria are unaffected; drafts reject a malformed criteria shape", () => {
  const { rubricCriteria: _ignored, marks: _marks, ...plain } = card();
  assert.deepEqual(rubricCriteriaIssues(plain), []);
  assert.deepEqual(validateDeck({ title: "Plain", cards: [plain] }, sources).errors, []);
  const errors = draftShapeErrors({ title: "Draft", cards: [card({ rubricCriteria: "c1 4 marks" })] });
  assert.ok(errors.some((issue) => /rubricCriteria must be a list/.test(issue)), errors.join("; "));
  assert.ok(draftShapeErrors({ title: "Draft", cards: [card({ marks: "ten" })] }).some((issue) => /marks must be a number/.test(issue)));
  assert.deepEqual(draftShapeErrors({ title: "Draft", cards: [card()] }), []);
});

test("rubric text is rendered from the criteria for older readers, in both languages", () => {
  const zh = renderRubric(criteria(), "zh");
  assert.match(zh, /^1\. Recommendation（4 分）：Names one architecture style/m);
  assert.match(zh, /要点：Event-driven booking；Why not a full rewrite/);
  assert.match(zh, /^3\. Assumptions（3 分）：States assumptions/m);
  assert.doesNotMatch(zh.split(/\n(?=\d+\. )/)[2], /要点/, "no key point line when a criterion has none");
  const en = renderRubric(criteria(), "en");
  assert.match(en, /^1\. Recommendation \(4 marks\): Names one/m);
  assert.match(en, /Key points: Event-driven booking; Why not a full rewrite/);
  assert.match(renderRubric([{ id: "a", label: "One", marks: 1, descriptor: "d", keyPoints: [] }], "en"), /\(1 mark\)/);
});

test("case decks are recognised by their format and case metadata", () => {
  assert.equal(CASE_FORMAT, "case-study");
  assert.equal(isCaseDeck({ format: "case-study", case: { sourceId: "case" }, cards: [] }), true);
  assert.equal(isCaseDeck({ format: "case-study", cards: [] }), false);
  assert.equal(isCaseDeck({ cards: [] }), false);
});

test("scenario text splits into numbered paragraphs; verbatim checks normalise whitespace", () => {
  assert.deepEqual(scenarioParagraphs("  First paragraph.\n\n\n Second\nline.  \n\n"), ["First paragraph.", "Second\nline."]);
  assert.equal(containsVerbatim(scenario, "suffered   repeated\ncredential-stuffing attacks"), true);
  assert.equal(containsVerbatim(scenario, "suffered several attacks"), false);
  assert.equal(containsVerbatim(scenario, "a"), false, "a quote needs some substance");
  assert.equal(countWords("Event driven design, then CQRS."), 5);
  assert.equal(countWords("事件驱动架构"), 6);
  assert.equal(countWords("采用 event sourcing 方案"), 6);
});

test("time model: about three minutes per mark, a length hint from the marks, and a reading phase", () => {
  assert.equal(DEFAULT_MINUTES_PER_MARK, 3);
  assert.equal(questionMinutes(2), 6);
  assert.equal(questionMinutes(10), 30);
  assert.equal(questionMinutes(10, 2.5), 25);
  assert.equal(lengthHint(2), "paragraph");
  assert.equal(lengthHint(4), "short");
  assert.equal(lengthHint(8), "structured");
  assert.equal(lengthHint(10), "extended");
  const words = suggestedWords(2, "en");
  assert.ok(words.min >= 60 && words.max <= 140 && words.min < words.max, JSON.stringify(words));
  assert.ok(suggestedWords(10, "zh").min > suggestedWords(10, "en").min, "Chinese counts characters");
  // The final: 50 marks in ~150 minutes with 30 minutes of reading; a 1-hour test reads for 15.
  assert.equal(defaultReadingMinutes(50), 30);
  assert.equal(defaultReadingMinutes(15), 9);
  assert.equal(defaultReadingMinutes(2), 5, "never less than five minutes");
  const plan = paperPlan([{ cardId: "q1", marks: 10 }, { cardId: "q2", marks: 6 }], { minutesPerMark: 3 });
  assert.deepEqual(plan.questions.map((q) => [q.cardId, q.minutes, q.hint]), [["q1", 30, "extended"], ["q2", 18, "structured"]]);
  assert.equal(plan.writingMinutes, 48);
  assert.equal(plan.totalMarks, 16);
  assert.equal(plan.readingMinutes, defaultReadingMinutes(16));
  assert.equal(plan.totalMinutes, plan.writingMinutes + plan.readingMinutes);
  assert.equal(paperPlan([{ cardId: "q1", marks: 10 }], { readingMinutes: 0 }).readingMinutes, 0, "reading can be switched off");
});

test("pacing: blank questions are flagged and time per question is compared with its budget", () => {
  const plan = paperPlan([{ cardId: "q1", marks: 10 }, { cardId: "q2", marks: 6 }, { cardId: "q3", marks: 4 }]);
  assert.deepEqual(blankQuestions(plan.questions, { q1: "An answer", q2: "   \n" }), ["q2", "q3"]);
  const report = pacingReport(plan, { perQuestion: { q1: 45 * 60000, q2: 10 * 60000 } }, { q1: "text", q2: "text" });
  assert.deepEqual(report.rows.map((row) => [row.cardId, row.status]), [["q1", "over"], ["q2", "ok"], ["q3", "unanswered"]]);
  assert.equal(report.rows[0].budgetMs, 30 * 60000);
  assert.deepEqual(report.unanswered, ["q3"]);
  assert.deepEqual(report.overBudget, ["q1"]);
  // Live pacing: 20 minutes in with only q3 (12 minutes of budget) answered is behind.
  assert.equal(paceStatus(plan, { elapsedMs: 20 * 60000, answeredIds: ["q3"] }), "behind");
  assert.equal(paceStatus(plan, { elapsedMs: 20 * 60000, answeredIds: ["q1"] }), "ahead");
  assert.equal(paceStatus(plan, { elapsedMs: 32 * 60000, answeredIds: ["q1"] }), "on-track");
});
