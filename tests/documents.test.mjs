import { withQualityStages } from "./helpers/assessment.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extractPdf } from "../lib/documents.js";
import { StudyService } from "../lib/service.js";
import { generateDeck, completeJson } from "../lib/generation.js";
import { generateBatched, planGeneration } from "../lib/batch.js";

// A real, cross-reference-indexed PDF with one text stream per page.
export function pdfFixture(pages) {
  const objects = ["<< /Type /Catalog /Pages 2 0 R >>", "", "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"];
  const kids = [];
  for (const text of pages) {
    const page = objects.length + 1, content = page + 1;
    kids.push(`${page} 0 R`);
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 800] /Resources << /Font << /F1 3 0 R /F2 << /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >> >> >> /Contents ${content} 0 R >>`);
    const stream = Array.isArray(text)
      ? text.map(({ text, x, y, font = "F1" }) => `BT /${font} 12 Tf ${x} ${y} Td (${text.replace(/[()\\]/g, "\\$&")}) Tj ET`).join("\n")
      : `BT /F1 12 Tf 40 700 Td (${text.replace(/[()\\]/g, "\\$&")}) Tj ET`;
    objects.push(`<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`);
  }
  objects[1] = `<< /Type /Pages /Count ${pages.length} /Kids [${kids.join(" ")}] >>`;
  let body = "%PDF-1.7\n", offsets = [0];
  objects.forEach((object, i) => { offsets.push(Buffer.byteLength(body)); body += `${i + 1} 0 obj\n${object}\nendobj\n`; });
  const xref = Buffer.byteLength(body);
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  body += offsets.slice(1).map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("");
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return Buffer.from(body);
}

test("PDF text follows visible line order instead of the order in which objects were drawn", async () => {
  const dataBase64 = pdfFixture([[
    { text: "System", x: 350, y: 200 },
    { text: "Footer copyright", x: 40, y: 20 },
    { text: "Architecture", x: 350, y: 300 },
    { text: "Solution Architect", x: 350, y: 400 },
    { text: "Lecture title", x: 40, y: 700 },
  ]]).toString("base64");
  const { sources } = await extractPdf({ dataBase64 });
  const text = sources[0].text;
  assert.ok(text.indexOf("Solution Architect") < text.indexOf("Architecture"), text);
  assert.ok(text.indexOf("Architecture") < text.indexOf("System"), text);
  assert.ok(text.indexOf("System") < text.indexOf("Footer"), text);
});

test("PDF font fragments do not insert spaces inside words or before punctuation", async () => {
  // Helvetica 12: 'Archi' width is 27.336 and 'tecture' width is 36.684.
  const { sources } = await extractPdf({ dataBase64: pdfFixture([[
    { text: "Archi", x: 40, y: 700 },
    { text: "tecture", x: 67.336, y: 700, font: "F2" },
    { text: ",", x: 104.02, y: 700 },
    { text: "not implementation", x: 112, y: 700 },
  ]]).toString("base64") });
  assert.match(sources[0].text, /Architecture, not implementation/);
});

test("PDF column continuations keep their indentation after visible-order sorting", async () => {
  const { sources } = await extractPdf({ dataBase64: pdfFixture([[
    { text: "Left heading", x: 40, y: 720 },
    { text: "Right heading", x: 300, y: 720 },
    { text: "A definition in the right cell", x: 300, y: 700 },
    { text: "Left label", x: 40, y: 680 },
    { text: "Continuation in the right cell", x: 300, y: 660 },
  ]]).toString("base64") });
  assert.match(sources[0].text, /\n {20,}A definition/);
  assert.match(sources[0].text, /\n {20,}Continuation/);
  assert.ok(sources[0].document.warnings.length);
});

test("reimport uses revised extraction without replacing sources behind existing citations", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "study-pdf-version-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const input = { dataBase64: pdfFixture(["Architecture connects business goals to technical decisions."]).toString("base64") };
  const extracted = await extractPdf(input);
  const service = new StudyService(root);
  const original = { ...extracted.sources[0], id: `pdf-${extracted.documentId}-p1`, text: "Old extraction must remain stable for existing citations." };
  delete original.document.extractionVersion;
  await service.store.update((s) => s.sources.push(original));
  const result = await service.call("source.import", input);
  assert.equal(result.legacyPages, 1);
  assert.equal(result.added, 1);
  assert.notEqual(result.sourceIds[0], original.id);
  assert.equal((await service.call("source.get", { id: original.id })).text, original.text);
  assert.equal((await service.call("source.import", input)).added, 0);
});

test("PDF import keeps exact page text, skips empty pages, and reuses duplicate sources", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "study-pdf-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const bytes = pdfFixture(["Architecture connects business goals to technical decisions.", "", "Stakeholders have different quality attribute priorities."]);
  const service = new StudyService(root);
  const path = join(root, "lecture.pdf");
  await writeFile(path, bytes);
  const first = await service.call("source.import", { path });
  assert.equal(first.added, 2);
  assert.deepEqual(first.selectedPages, [1, 2, 3]);
  assert.deepEqual(first.skippedPages, [2]);
  assert.deepEqual(first.sparsePages, [1, 3]);
  assert.equal(first.sources[0].document.sparseText, true);
  assert.equal(first.sources[1].document.page, 3);
  await service.store.update((state) => { delete state.sources[0].document.sparseText; });
  const again = await service.call("source.import", { dataBase64: bytes.toString("base64"), filename: "lecture.pdf", pages: [3, 1, 3] });
  assert.equal(again.added, 0);
  assert.deepEqual(again.selectedPages, [1, 3]);
  assert.deepEqual(again.sourceIds, first.sourceIds);
  assert.equal((await service.call("export")).sources.find((item) => item.id === first.sourceIds[0]).document.sparseText, true);
  assert.equal((await service.call("source.get", { id: first.sourceIds[0] })).text, "Architecture connects business goals to technical decisions.");
  const dense = await extractPdf({ dataBase64: pdfFixture([[
    { text: "Architecture links stakeholder goals, system context, and quality attributes to measurable design decisions.", x: 40, y: 700 },
    { text: "The design also addresses constraints, responsibilities, and trade-offs across the solution lifecycle.", x: 40, y: 680 },
  ]]).toString("base64") });
  assert.deepEqual(dense.sparsePages, []);
  await assert.rejects(service.call("source.import", { dataBase64: pdfFixture([""]).toString("base64") }), /所选 1 页.*OCR.*没有保存资料/);
  assert.equal((await service.call("export")).sources.length, 2);
  await assert.rejects(extractPdf({ path, pages: [4] }), /共 3 页/);
  await assert.rejects(extractPdf({ dataBase64: "not a pdf" }), /PDF 文件无效/);
});

const source = { id: "page1", title: "Lecture p.1", text: "Architecture connects business goals to technical decisions." };
function card(n, kind = "flashcard") {
  return { id: `q${n}`, kind, topic: `Topic ${n}`, objective: `Objective ${n}`, prompt: `Question ${n}?`, answer: `Answer ${n}`, hint: "Think about stakeholder needs", explanation: "Design choices must serve business goals", misconception: "Choosing technology first", citations: [{ sourceId: source.id, quote: source.text }],
    ...(kind === "quiz" ? { options: ["a", "b", "c"].map((id) => ({ id, text: `${id} option ${n}`, correct: id === "a", explanation: `Reason ${id}` })) } : {}) };
}

test("a fabricated citation costs its own card, and the sound ones are kept", async () => {
  const bad = card(2); bad.citations[0].quote = "A fabricated passage not present in this source.";
  let calls = 0;
  const complete = async (system) => {
    calls++;
    return JSON.stringify(system.includes("editor") ? { issues: [] } : { title: "Lecture", cards: [card(1), bad] });
  };
  const result = await generateDeck(withQualityStages(complete), { count: 2, kind: "flashcard", sources: [source], allowPartial: true });
  assert.equal(result.cards.length, 1, "the card whose quote is not in the source is dropped");
  assert.equal(result.editorial.dropped, 1);
  assert.equal(calls, 5, "author, review, repair, independent review and retained subset review");

  // Unresolved deck-level defects must survive the repairer's self approval.
  await assert.rejects(generateDeck(
    withQualityStages(async (system) => JSON.stringify(
      system.includes("editor") ? { issues: ["Unsupported answer"] } : { title: "Lecture", cards: [card(1), bad] })),
    { count: 2, kind: "flashcard", sources: [source], allowPartial: true },
  ), /Editorial review still found issues.*Unsupported answer/);
});

test("mixed generation uses small batches, one draft, requested title, and reports failed parts", async () => {
  const request = { count: 13, kind: "mixed", sources: [source], title: "SWE5001" };
  const plan = planGeneration(request);
  assert.deepEqual(plan.map((p) => [p.kind, p.count]), [["quiz", 5], ["quiz", 2], ["flashcard", 5], ["flashcard", 1]]);
  let n = 0, author = 0;
  const result = await generateBatched(withQualityStages(async (system, prompt) => {
    if (system.includes("editor")) return JSON.stringify({ issues: [] });
    const req = JSON.parse(prompt.split("REQUEST DATA:\n")[1]);
    if (++author === 2) return JSON.stringify({ error: "Insufficient support" });
    return JSON.stringify({ title: "Model title", cards: Array.from({ length: req.count }, () => card(++n, req.kind)) });
  }), request);
  assert.equal(result.title, "SWE5001");
  assert.equal(result.cards.length, 11);
  assert.equal(result.editorial.failures.length, 1);
  assert.equal(result.editorial.requested, 13);
  assert.deepEqual(planGeneration({ sources: [source], count: 1, kind: "mixed", kindCounts: { quiz: 0, flashcard: 1 } }).map((p) => p.kind), ["flashcard"]);
});

test("three batch workers overlap after shared planning and checkpoint before a slow batch finishes", { timeout: 5000 }, async () => {
  let authors = 0, active = 0, peak = 0, plans = 0, signalStarted, signalSaved;
  const releases = [];
  const started = new Promise((resolve) => signalStarted = resolve);
  const saved = new Promise((resolve) => signalSaved = resolve);
  const contexts = [], checkpoints = [];
  const fixture = withQualityStages(async (system, prompt) => {
    if (system.includes("editor")) return JSON.stringify({ issues: [] });
    const req = JSON.parse(prompt.split("REQUEST DATA:\n")[1]);
    const number = ++authors;
    active++; peak = Math.max(peak, active);
    if (number <= 3) await new Promise((resolve) => { releases.push(resolve); if (releases.length === 3) signalStarted(); });
    active--;
    return JSON.stringify({ title: "Parallel", cards: Array.from({ length: req.count }, (_, i) => card(number * 10 + i, req.kind)) });
  });
  const pending = generateBatched(async (system, prompt, context) => {
    contexts.push(context);
    if (system.startsWith("Plan ")) plans++;
    return fixture(system, prompt);
  }, { count: 20, kind: "flashcard", sources: [source] }, () => {}, async (deck) => {
    checkpoints.push(deck.cards.length); signalSaved();
  });
  try {
    await started;
    assert.equal(plans, 1);
    assert.equal(peak, 3);
    releases[0](); releases[1]();
    await saved;
    assert.ok(checkpoints[0] > 0 && checkpoints[0] < 20);
  } finally { releases.forEach((release) => release()); }
  const result = await pending;
  assert.equal(result.cards.length, 20);
  assert.equal(peak, 3);
  assert.equal(authors, 4);
  assert.ok(contexts.filter((c) => c.part).every((c) => c.stage.startsWith(`Part ${c.part}/4`)));
  assert.equal(checkpoints.at(-1), 20);
});

test("workers receive complete assigned sources without unrelated planning pages", async () => {
  let n = 0;
  const seen = [];
  const result = await generateBatched(withQualityStages(async (system, prompt) => {
    if (system.includes("editor")) {
      seen.push(JSON.parse(prompt).sources);
      return JSON.stringify({ issues: [] });
    }
    const req = JSON.parse(prompt.split("REQUEST DATA:\n")[1]);
    seen.push(req.sources);
    return JSON.stringify({ title: "Scoped sources", cards: Array.from({ length: req.count }, () => card(++n, req.kind)) });
  }), { count: 6, kind: "flashcard", sources: [source, { id: "unassigned", title: "Unrelated page", text: "A different page with no assigned learning targets." }] });
  assert.equal(result.cards.length, 6);
  assert.equal(Object.keys(result.editorial.reviewedCards).length, result.cards.length);
  assert.ok(seen.every((sources) => sources.length === 1 && sources[0].text === source.text));
  assert.equal(result.editorial.coverage.selected, 2);
  assert.equal(result.editorial.coverage.cited, 1);
  assert.deepEqual(result.editorial.coverage.sources.map(({ id, planned, accepted }) => ({ id, planned, accepted })), [
    { id: source.id, planned: 6, accepted: 6 },
    { id: "unassigned", planned: 0, accepted: 0 },
  ]);
});

test("transport failures do not trigger a misleading JSON correction retry", async () => {
  let calls = 0;
  await assert.rejects(completeJson(async () => { calls++; throw new Error("Provider unavailable"); }, "system", "prompt"), /Provider unavailable/);
  assert.equal(calls, 1);
});

test("PDF sources feed a single mixed background job without changing recording mode", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "study-pdf-job-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  let n = 0;
  const service = new StudyService(root);
  service.complete = withQualityStages(async (system, prompt) => {
    if (system.includes("editor")) return JSON.stringify({ issues: [] });
    const request = JSON.parse(prompt.split("REQUEST DATA:\n")[1]);
    return JSON.stringify({ title: "Generated", cards: Array.from({ length: request.count }, () => ({ ...card(++n, request.kind), citations: [{ sourceId: request.sources[0].id, quote: request.sources[0].text }] })) });
  });
  await service.call("ingest.start", { deckTitle: "SWE5001", kind: "auto", mistakes: "none" });
  const imported = await service.call("source.import", { filename: "lecture.pdf", dataBase64: pdfFixture([source.text]).toString("base64") });
  const started = await service.call("generate", { sourceIds: imported.sourceIds, count: 3, kind: "mixed", title: "SWE5001" });
  const done = await service.call("job.wait", { jobId: started.jobId, timeoutSeconds: 300 });
  assert.equal(done.waitLimitSeconds, 60);
  assert.equal(done.status, "complete");
  const state = await service.call("export");
  assert.equal(state.drafts.length, 1);
  assert.equal(state.drafts[0].title, "SWE5001");
  assert.deepEqual(state.drafts[0].cards.map((c) => c.kind), ["quiz", "quiz", "flashcard"]);
  assert.equal((await service.call("ingest.status")).active, true);
  assert.equal(state.drafts[0].editorial.coverage.cited, 1);
  assert.deepEqual(state.drafts[0].editorial.generation.sourceIds, imported.sourceIds);
  assert.equal(state.drafts[0].editorial.generation.kind, "mixed");
});

test("an interrupted generation can fill its original draft without replacing approved cards", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "study-resume-generation-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const service = new StudyService(root);
  await service.call("source.add", source);
  const saved = await service.call("draft.save", { deck: {
    id: "partial", title: "Architecture", cards: [card(1)],
    editorial: { requested: 2, generated: 1, parts: 2, completedParts: 1, failures: [],
      generation: { sourceIds: [source.id], kind: "flashcard", language: "中文", difficulty: "mixed" } },
  } });
  const summary = (await service.call("snapshot", { compact: true })).drafts[0];
  assert.equal(summary.missing, 1);
  assert.equal(summary.canContinue, true);
  let next = 2;
  service.complete = withQualityStages(async (system, prompt) => {
    if (system.includes("editor")) return JSON.stringify({ issues: [] });
    const request = JSON.parse(prompt.split("REQUEST DATA:\n")[1]);
    return JSON.stringify({ title: "Continuation", cards: Array.from({ length: request.count }, () => card(next++, request.kind)) });
  });
  const started = await service.call("generate", { resumeDraftId: saved.id, draftVersion: saved.draftVersion });
  assert.equal(started.draftId, saved.id);
  assert.equal(started.missing, 1);
  const done = await service.call("job.wait", { jobId: started.jobId });
  assert.equal(done.status, "complete", done.stage);
  const draft = (await new StudyService(root).call("export")).drafts;
  assert.equal(draft.length, 1);
  assert.equal(draft[0].id, saved.id);
  assert.equal(draft[0].cards.length, 2);
  assert.equal(draft[0].cards[0].id, "q1");
  assert.notEqual(draft[0].cards[1].id, "q1");
  assert.equal(draft[0].editorial.requested, 2);
  assert.equal(draft[0].editorial.completedParts, draft[0].editorial.parts);
  await assert.rejects(service.call("generate", { resumeDraftId: saved.id, draftVersion: saved.draftVersion }), /刷新|无需补题/);
});

test("continuing a mixed draft fills the missing question kind", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "study-resume-mixed-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const service = new StudyService(root);
  await service.call("source.add", source);
  const saved = await service.call("draft.save", { deck: {
    id: "mixed-partial", title: "Mixed", cards: [card(1, "quiz"), card(2, "quiz")],
    editorial: { requested: 3, generated: 2, parts: 2, completedParts: 1,
      coverage: { sources: [{ id: source.id, title: source.title, planned: 2, accepted: 2 }] },
      generation: { sourceIds: [source.id], kind: "mixed" } },
  } });
  const generatedKinds = [];
  service.complete = withQualityStages(async (system, prompt) => {
    if (system.includes("editor")) return JSON.stringify({ issues: [] });
    const request = JSON.parse(prompt.split("REQUEST DATA:\n")[1]);
    generatedKinds.push(request.kind);
    return JSON.stringify({ title: "Mixed", cards: [card(3, request.kind)] });
  });
  const started = await service.call("generate", { resumeDraftId: saved.id, draftVersion: saved.draftVersion });
  assert.equal((await service.call("job.wait", { jobId: started.jobId })).status, "complete");
  assert.deepEqual(generatedKinds, ["flashcard"]);
  assert.deepEqual((await service.call("export")).drafts[0].cards.map((c) => c.kind), ["quiz", "quiz", "flashcard"]);
  assert.deepEqual((await service.call("export")).drafts[0].editorial.coverage.sources.map(({ planned, accepted }) => [planned, accepted]), [[3, 3]]);
});

test("continuation refuses to overwrite a draft edited while the model is working", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "study-resume-conflict-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const service = new StudyService(root);
  await service.call("source.add", source);
  const saved = await service.call("draft.save", { deck: {
    id: "partial", title: "Original title", cards: [card(1)],
    editorial: { requested: 2, generated: 1, parts: 2, completedParts: 1,
      generation: { sourceIds: [source.id], kind: "flashcard" } },
  } });
  let release, entered;
  const gate = new Promise((resolve) => { release = resolve; });
  const startedModel = new Promise((resolve) => { entered = resolve; });
  const fixture = withQualityStages(async (system, prompt) => {
    if (system.includes("editor")) return JSON.stringify({ issues: [] });
    const request = JSON.parse(prompt.split("REQUEST DATA:\n")[1]);
    return JSON.stringify({ title: "Continuation", cards: [card(2, request.kind)] });
  });
  service.complete = async (...args) => {
    entered();
    await gate;
    return fixture(...args);
  };
  const started = await service.call("generate", { resumeDraftId: saved.id, draftVersion: saved.draftVersion });
  await startedModel;
  const edited = await service.call("draft.save", { deck: { ...saved, title: "Human edit" } });
  release();
  const done = await service.call("job.wait", { jobId: started.jobId });
  assert.equal(done.status, "failed");
  assert.equal((await service.call("export")).drafts[0].title, edited.title);
  assert.equal((await service.call("export")).drafts[0].cards.length, 1);
});

test("source removal waits until a generation using it has finished", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "study-active-source-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const service = new StudyService(root);
  await service.call("source.add", source);
  let release, entered;
  const gate = new Promise((resolve) => { release = resolve; });
  const startedModel = new Promise((resolve) => { entered = resolve; });
  const fixture = withQualityStages(async (system, prompt) => {
    if (system.includes("editor")) return JSON.stringify({ issues: [] });
    const request = JSON.parse(prompt.split("REQUEST DATA:\n")[1]);
    return JSON.stringify({ title: "Generated", cards: [card(1, request.kind)] });
  });
  service.complete = async (...args) => {
    entered();
    await gate;
    return fixture(...args);
  };
  const started = await service.call("generate", { sourceIds: [source.id], count: 1, kind: "flashcard" });
  await startedModel;
  await assert.rejects(service.call("source.remove", { id: source.id }), /正在用于出题/);
  release();
  assert.equal((await service.call("job.wait", { jobId: started.jobId })).status, "complete");
});

test("PDF workflow guidance does not instruct repeated waits or external extraction", async () => {
  const text = await readFile(new URL("../lib/index.js", import.meta.url), "utf8");
  assert.ok(text.includes("source.import"));
  assert.ok(text.includes("Lecture PDFs create new questions even during recording mode"));
  assert.ok(!text.includes("then call job.wait for each"));
});
