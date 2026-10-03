import test from "node:test";
import assert from "node:assert/strict";
import { quoteFound, validateDeck } from "../lib/domain.js";
import { citationCheck, reattributeCitations, quotePages } from "../lib/quote-match.js";
import { planAssessment, planIssues } from "../lib/assessment-quality.js";
import { generateBatched, planGeneration, MAX_PLAN_TARGETS, CHUNK_CHARS } from "../lib/batch.js";
import { authored, qualityReview } from "./helpers/assessment.mjs";

/* A real run: 36 MinerU pages of one book, 25 questions, 4 passed and "5 parts failed because the quoted source text could not
   be found". MinerU markdown and what a model echoes back differ in ways that carry no meaning: line-end hyphenation, markup,
   entities, typographic quotes. These tests pin which differences are harmless and that an invented quote is still rejected. */

const SOURCE = [
  ["hyphenated at a line end", "An architec-\ntural style is a named collection of design decisions that recur.", "An architectural style is a named collection of design decisions that recur."],
  ["ligatures", "The ﬁrst step of the ﬂow is to identify stakeholders and their concerns.", "The first step of the flow is to identify stakeholders and their concerns."],
  ["typographic quotes", "The architect’s “big picture” view guides every decision that is made.", "The architect's \"big picture\" view guides every decision that is made."],
  ["bold markup", "Quality attributes are **non-functional requirements** that shape the architecture.", "Quality attributes are non-functional requirements that shape the architecture."],
  ["italic markup", "Use _separation of concerns_ to limit the blast radius of every change.", "Use separation of concerns to limit the blast radius of every change."],
  ["escaped markup", "Use the \\* operator and the \\_ marker in the interface definition file.", "Use the * operator and the _ marker in the interface definition file."],
  ["heading and list markers", "# 2.1 Drivers\n\n- Availability must be measured\n- Performance must be measured too", "Drivers Availability must be measured Performance must be measured too"],
  ["markdown table", "| Attribute | Meaning |\n|---|---|\n| Latency | Time to respond to a request |", "Attribute Meaning Latency Time to respond to a request"],
  ["html table", "<table><tr><td>Latency</td><td>Time to respond to a request</td></tr></table>", "Latency Time to respond to a request"],
  ["latex", "The cost is $O(n \\log n)$ in the worst case for sorting the input.", "The cost is O(n log n) in the worst case for sorting the input."],
  ["html entities", "Coupling &amp; cohesion determine how modular the system is overall.", "Coupling & cohesion determine how modular the system is overall."],
  ["dashes", "The design is stable – even under load – for all requests received.", "The design is stable - even under load - for all requests received."],
  ["soft hyphen and non-breaking space", "The infra­structure layer hosts every deployable component here.", "The infrastructure layer hosts every deployable component here."],
  ["an elided middle", "The architecture describes components, connectors, constraints, and their configuration.", "The architecture describes components ... and their configuration."],
  ["a bracketed ellipsis", "The architecture describes components, connectors, constraints, and their configuration.", "The architecture describes components [...] and their configuration."],
  ["a literal ellipsis in the page itself", "It stopped working... and then nothing happened for a while.", "It stopped working... and then nothing happened for a while."],
  ["double-escaped line breaks", "Layers keep coupling low.\\nEach layer calls only the layer below it.", "Layers keep coupling low. Each layer calls only the layer below it."],
  ["an image line in between", "![](images/abc.jpg)\nFigure 2.3 shows the layered architecture of the whole platform.", "Figure 2.3 shows the layered architecture of the whole platform."],
];

test("harmless differences between MinerU markdown and a model's echo do not make a real quote 'not found'", () => {
  for (const [why, text, quote] of SOURCE) assert.equal(quoteFound(text, quote), true, why);
});

test("an invented or altered quote is still rejected", () => {
  const text = "Quality attributes are **non-functional requirements** that shape the architecture. The p99 latency target is 200 ms.";
  for (const [why, quote] of [
    ["invented", "Quality attributes are always decided by the operations team alone."],
    ["a changed word", "Quality attributes are functional requirements that shape the architecture."],
    ["a changed number", "The p95 latency target is 200 ms for every request."],
    ["fragments in the wrong order", "The p99 latency target is 200 ms ... Quality attributes are non-functional requirements"],
    ["only punctuation and markup", "**** ---- ==== ____"],
    ["an elided passage whose parts are not in the page", "Quality attributes are ... and nothing about security at all"],
  ]) assert.equal(quoteFound(text, quote), false, why);
});

const page = (id, text) => ({ id, title: id, text });
const card = (n, citations, extra = {}) => ({ id: `q${n}`, kind: "flashcard", topic: "t", objective: `objective ${n}`, prompt: `Why does decision ${n} matter?`,
  answer: `answer ${n}`, hint: "think about it", explanation: "because of the quoted rule", misconception: "a common mistake", citations, ...extra });

test("a quote that runs over a page boundary is grounded in the page it starts on, and a quote of another page is not", () => {
  const sources = [page("p1", "…the layered style. A layer may only call the layer"), page("p2", " directly below it. This keeps coupling low across the system.")];
  const spanning = "A layer may only call the layer directly below it.";
  assert.deepEqual(validateDeck({ title: "t", cards: [card(1, [{ sourceId: "p1", quote: spanning }])] }, sources).errors, []);
  assert.deepEqual(validateDeck({ title: "t", cards: [card(1, [{ sourceId: "p2", quote: spanning }])] }, sources).errors, []);
  const check = citationCheck(quotePages(sources), { sourceId: "p1", quote: spanning });
  assert.equal(check.ok, true);
  assert.equal(check.neighbour, "p2");
  const wrong = validateDeck({ title: "t", cards: [card(1, [{ sourceId: "p1", quote: "This keeps coupling low across the system." }])] }, sources).errors;
  assert.match(wrong.join(" "), /quote must match a source passage/);
  assert.deepEqual(citationCheck(quotePages(sources), { sourceId: "p1", quote: "This keeps coupling low across the system." }).foundIn, ["p2"]);
  assert.equal(citationCheck(quotePages(sources), { sourceId: "p9", quote: spanning }).reason, "unknown-source");
});

test("every slice of a long source is one source for the check (a quote from its later slices is not 'not found')", () => {
  const sources = [page("long", "First slice talks about layers and their responsibilities."), page("long", "Second slice explains that a gateway terminates every external request.")];
  const quote = "a gateway terminates every external request";
  assert.deepEqual(validateDeck({ title: "t", cards: [card(1, [{ sourceId: "long", quote }])] }, sources).errors, []);
  const target = { objective: "o", answerBoundary: "b", comparisonAxis: "c", misconception: "m", contextNeeded: "n",
    answerability: { mode: "recall", requiredContextAvailable: true, answerOnlyInSourceList: false, criteriaWouldRevealAnswer: false }, citations: [{ sourceId: "long", quote }] };
  assert.deepEqual(planIssues({ targets: [target] }, { count: 1, sources, existing: [] }), []);
});

test("a citation naming a mangled page id is attributed to the page the quote really is on", () => {
  const sources = [page("document-aaa-json-bbb-json-conv1-p17", "Latency budgets are split across the tiers of a request."), page("document-aaa-json-bbb-json-conv1-p18", "A cache absorbs the repeated reads of a hot key.")];
  const fixed = reattributeCitations([{ sourceId: "document-aaa-json-bbb-json-conv1-p81", quote: "A cache absorbs the repeated reads of a hot key" },
    { sourceId: "document-aaa-json-bbb-json-conv1-p17", quote: "Latency budgets are split across the tiers" },
    { sourceId: "document-aaa-json-bbb-json-conv1-p17", quote: "Nothing like this is written anywhere in the pages" }], sources);
  assert.deepEqual(fixed.citations.map((ref) => ref.sourceId), ["document-aaa-json-bbb-json-conv1-p18", "document-aaa-json-bbb-json-conv1-p17", "document-aaa-json-bbb-json-conv1-p17"]);
  assert.equal(fixed.changed, 1, "only a quote that is verbatim on another page is re-attributed; an invented one stays as it is");
});

/* ---------- the plan call ---------- */

const planTarget = (quote, sourceId = "s1", n = 1) => ({ objective: `target ${n}`, answerBoundary: "b", comparisonAxis: "c", misconception: "m", contextNeeded: "n",
  answerability: { mode: "recall", requiredContextAvailable: true, answerOnlyInSourceList: false, criteriaWouldRevealAnswer: false }, citations: [{ sourceId, quote }] });
const SENTENCES = ["Caching reduces the load on the database for hot keys.", "Retries with jitter avoid synchronised thundering herds.", "A circuit breaker stops calls to a failing dependency.", "Bulkheads isolate failures to one pool of resources."];
const planSource = page("s1", SENTENCES.join(" "));

test("the corrective round of a plan names the full quote that was not found and the pages it may quote from", async () => {
  const bad = "Caching reduces the load on the application server for hot keys.";
  const replies = [{ targets: [planTarget(bad, "s1", 1), planTarget(SENTENCES[1], "s1", 2)] }, { targets: [planTarget(SENTENCES[0], "s1", 1), planTarget(SENTENCES[1], "s1", 2)] }];
  const prompts = [];
  const plan = await planAssessment(async (_system, prompt) => { prompts.push(prompt); return replies[prompts.length - 1]; }, { count: 2, sources: [planSource], existing: [] });
  assert.equal(prompts.length, 2);
  assert.ok(prompts[1].includes(bad), "the whole quote is fed back, not a clipped one");
  assert.match(prompts[1], /sourceId.*s1/s);
  assert.equal(plan.targets.length, 2);
});

test("a plan whose citations name a mangled page id is repaired locally, without another model call", async () => {
  const sources = [page("doc-p17", SENTENCES.slice(0, 2).join(" ")), page("doc-p18", SENTENCES.slice(2).join(" "))];
  let calls = 0;
  const plan = await planAssessment(async () => { calls++; return { targets: [planTarget(SENTENCES[2], "doc-p81", 1), planTarget(SENTENCES[0], "doc-p17", 2)] }; }, { count: 2, sources, existing: [] });
  assert.equal(calls, 1);
  assert.deepEqual(plan.targets.map((target) => target.citations[0].sourceId), ["doc-p18", "doc-p17"]);
});

test("a plan keeps its verified targets when others cannot be grounded after the corrective round (salvage), and says which were dropped", async () => {
  const stubborn = async () => ({ targets: [planTarget(SENTENCES[0], "s1", 1), planTarget("Nothing of this sort is ever written down here.", "s1", 2), planTarget(SENTENCES[2], "s1", 3)] });
  await assert.rejects(planAssessment(stubborn, { count: 3, sources: [planSource], existing: [] }), /Assessment plan is not usable: Target 2: quote/);
  const plan = await planAssessment(stubborn, { count: 3, sources: [planSource], existing: [] }, { salvage: true });
  assert.deepEqual(plan.targets.map((target) => target.objective), ["target 1", "target 3"]);
  assert.equal(plan.dropped.length, 1);
  assert.match(plan.dropped[0].issues[0], /Target 2: quote/);
  const hopeless = async () => ({ targets: [planTarget("Nothing of this sort is ever written down here.", "s1", 1)] });
  await assert.rejects(planAssessment(hopeless, { count: 1, sources: [planSource], existing: [] }, { salvage: true }), /Assessment plan is not usable/);
});

/* ---------- parts of a big selection ---------- */

const BOOK_PAGES = 36;
const pageText = (n) => `# Chapter ${Math.ceil(n / 12)}\n\nPage ${n} explains tactic number ${n}: ${"the tactic keeps the quality attribute within its budget under load. ".repeat(48)}`;
const book = Array.from({ length: BOOK_PAGES }, (_, i) => page(`document-h-json-h-json-conv1-p${i + 15}`, pageText(i + 15)));

test("a big selection is split by page ranges: no plan asks for many targets, no call sees more than it can quote from", () => {
  const parts = planGeneration({ sources: book, count: 25, kind: "quiz" });
  const groups = [...new Set(parts.map((part) => part.sources))];
  assert.ok(groups.length >= Math.ceil(25 / MAX_PLAN_TARGETS), `${groups.length} groups`);
  const seen = [];
  for (const group of groups) {
    const asked = parts.filter((part) => part.sources === group).reduce((sum, part) => sum + part.count, 0);
    assert.ok(asked <= MAX_PLAN_TARGETS, `a group asks for ${asked} targets`);
    assert.ok(group.reduce((sum, source) => sum + source.text.length, 0) <= CHUNK_CHARS);
    seen.push(...group.map((source) => source.id));
  }
  assert.deepEqual(seen, book.map((source) => source.id), "every page is in exactly one group, in book order");
  assert.equal(parts.reduce((sum, part) => sum + part.count, 0), 25);
  assert.ok(parts.every((part) => part.count <= 5));
});

test("one long page is never cut only because many questions were asked, and a tiny selection stays one group", () => {
  const one = planGeneration({ sources: [page("only", "A single short page about caching layers and invalidation.")], count: 20, kind: "quiz" });
  assert.equal(new Set(one.map((part) => part.sources)).size, 1);
  assert.equal(one[0].sources[0].text, "A single short page about caching layers and invalidation.");
});

/* ---------- the whole run ---------- */

/** The REQUEST DATA of a prompt (a corrective round appends prose after it). */
const requestOf = (prompt) => JSON.parse(prompt.split("REQUEST DATA:\n")[1].split("\n\nYour previous plan was rejected")[0]);
const bookRun = ({ mangle, replies } = {}) => {
  const calls = { author: [], review: [], repair: [], plan: 0 };
  const model = async (system, prompt) => {
    if (system.startsWith("Plan a source-grounded assessment")) {
      calls.plan++;
      const request = requestOf(prompt);
      return JSON.stringify({ targets: Array.from({ length: request.count }, (_, i) => ({ ...planTarget(sentence(request.sources[i % request.sources.length]), request.sources[i % request.sources.length].id, i), objective: `plan ${request.sources[0].id} ${i}` })) });
    }
    if (system.startsWith("Act as a strict assessment editor")) { calls.review.push(prompt); return JSON.stringify(qualityReview(JSON.parse(prompt).candidate)); }
    const request = requestOf(prompt);
    if (system.startsWith("Repair the source citations")) { calls.repair.push(prompt); return JSON.stringify(replies?.repair?.(request, prompt) ?? { cards: [] }); }
    calls.author.push({ prompt, request });
    const cards = request.assessmentPlan.targets.map((target, i) => card(`${request.sources[0].id}-${i}`, [{ sourceId: target.citations[0].sourceId, quote: (mangle || ((q) => q))(target.citations[0].quote, i) }],
      { objective: target.objective, prompt: `Which tactic of ${target.objective} keeps the budget?` }));
    return JSON.stringify(authored({ title: "Book", cards }));
  };
  return { model, calls };
};
const sentence = (source) => { const n = source.text.match(/Page (\d+)/)[1]; return `Page ${n} explains tactic number ${n}: the tactic keeps the quality attribute within its budget`; };

test("36 pages of MinerU markdown: quotes that differ only in markup and typography all pass", async () => {
  const markdown = book.map((source) => ({ ...source, text: source.text.replace("number", "num-\nber").replace("tactic keeps", "**tactic** keeps") }));
  const { model, calls } = bookRun();
  const result = await generateBatched(model, { count: 25, kind: "flashcard", sources: markdown });
  assert.equal(result.cards.length, 25);
  assert.deepEqual(result.editorial.failures, []);
  assert.equal(result.editorial.partReport.failed, 0);
  assert.equal(result.editorial.partReport.passed, result.editorial.partReport.total);
  assert.ok(calls.plan >= 3);
});

test("a part whose only problem is a quote that cannot be found gets one repair that is given the exact quote and the page ids", async () => {
  const wrong = "Page 20 explains tactic number 20 and also says something the book never wrote down";
  const { model, calls } = bookRun({
    mangle: (quote, i) => (quote.includes("Page 20 ") ? wrong : quote),
    replies: { repair: (request, prompt) => {
      assert.ok(prompt.includes(wrong), "the quote that was not found is in the repair prompt");
      assert.ok(request.sources.some((source) => prompt.includes(source.id)), "so are the page ids it may quote from");
      return { cards: request.cards.map((c) => ({ id: c.id, citations: [{ sourceId: c.citations[0].sourceId, quote: sentence(request.sources.find((s) => s.id === c.citations[0].sourceId) || request.sources[0]) }] })) };
    } },
  });
  const result = await generateBatched(model, { count: 25, kind: "flashcard", sources: book });
  assert.equal(result.cards.length, 25, JSON.stringify(result.editorial.failures));
  assert.equal(calls.repair.length, 1, "one repair, once");
  assert.deepEqual(result.editorial.failures, []);
});

test("a quote that stays invented after the repair is dropped, the passing questions are kept and the report says why", async () => {
  const invented = "The book contains a passage that nobody ever wrote about this tactic";
  const { model } = bookRun({ mangle: (quote) => (quote.includes("Page 20 ") ? invented : quote), replies: { repair: (request) => ({ cards: request.cards.map((c) => ({ id: c.id, citations: [{ sourceId: c.citations[0].sourceId, quote: invented }] })) }) } });
  const result = await generateBatched(model, { count: 25, kind: "flashcard", sources: book });
  assert.ok(result.cards.length >= 20 && result.cards.length < 25);
  const report = result.editorial.partReport;
  assert.equal(report.total, report.passed + report.partial + report.failed);
  assert.ok(report.partial + report.failed >= 1);
  assert.ok(report.reasons.quote >= 1, JSON.stringify(report));
  assert.ok(result.cards.every((c) => c.citations.every((ref) => quoteFound(book.find((s) => s.id === ref.sourceId).text, ref.quote))));
});

test("when the plan of a group cannot be grounded at all, only that group's parts fail; the others are kept", async () => {
  const model = async (system, prompt) => {
    if (system.startsWith("Plan a source-grounded assessment")) {
      const request = requestOf(prompt);
      const first = request.sources[0].id === book[0].id;
      return JSON.stringify({ targets: Array.from({ length: request.count }, (_, i) => ({ ...planTarget(first ? "This sentence is nowhere in the book at all." : sentence(request.sources[i % request.sources.length]),
        request.sources[i % request.sources.length].id, i), objective: `g ${request.sources[0].id} ${i}` })) });
    }
    if (system.startsWith("Act as a strict assessment editor")) return JSON.stringify(qualityReview(JSON.parse(prompt).candidate));
    const request = requestOf(prompt);
    return JSON.stringify(authored({ title: "B", cards: request.assessmentPlan.targets.map((target, i) => card(`${target.objective}`, [target.citations[0]], { objective: target.objective, prompt: `Question about ${target.objective}?` })) }));
  };
  const result = await generateBatched(model, { count: 25, kind: "flashcard", sources: book });
  const report = result.editorial.partReport;
  assert.ok(result.cards.length > 10 && result.cards.length < 25);
  assert.ok(report.failed >= 1 && report.passed >= 1);
  assert.equal(report.reasons.quote, report.failed + report.partial);
  assert.match(report.summary, /quote/i);
});
