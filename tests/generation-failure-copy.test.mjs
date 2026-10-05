import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { build } from "esbuild";

/* #217: a failure whose cause is the quality review says so, lists the real reason categories and the next steps; "the sources may be too short"
   only comes from a signal that the sources really gave too little (the planning stage found no targets / no evidence). The technical detail is
   one line per question. */
const compiled = await build({ stdin: { contents: `export * from './ui/generation-status.js'; export { setUiLanguage } from './ui/i18n.js';`, resolveDir: process.cwd() },
  bundle: true, write: false, platform: "node", format: "cjs", external: ["react"], logLevel: "silent" });
const module = { exports: {} };
new Function("require", "module", "exports", compiled.outputFiles[0].text)(createRequire(import.meta.url), module, module.exports);
const m = module.exports;
const han = /[㐀-鿿]/;
const inLanguage = (language, fn) => { m.setUiLanguage(language); try { return fn(); } finally { m.setUiLanguage("zh"); } };

// The owner's failed fill: every question lost to review findings, none to the sources.
const REVIEW_FAILURE = "Part 1: Quality gate failed: q1: answerLeak failed or was not checked; q1: optionQuality failed or was not checked; "
  + "q2: sourceSupport failed or was not checked; q3: explanationQuality failed or was not checked; q3: learningValue failed or was not checked; Card 4: hint reveals the answer; "
  + "Part 2: Quality gate failed: q1: selfContained failed or was not checked";

test("a quality-review failure never blames the sources", () => {
  for (const hasDraft of [false, true]) {
    const zh = inLanguage("zh", () => m.describeFailure(REVIEW_FAILURE, { hasDraft }));
    assert.equal(zh.kind, "quality");
    assert.doesNotMatch(zh.title + zh.hint, /资料可能太短|换几份内容更完整的资料/, "no advice about the sources");
    assert.match(zh.title, /质量审阅/);
    assert.match(zh.hint, /提示或题干泄露了答案/, "the real categories, from the same labels as the draft page");
    assert.match(zh.hint, /选项质量不合格/);
    assert.match(zh.hint, hasDraft ? /为没覆盖的部分补题/ : /重新设置/, "a next step that applies");
    assert.match(zh.hint, /出题偏好/);
    const en = inLanguage("en", () => m.describeFailure(REVIEW_FAILURE, { hasDraft }));
    assert.doesNotMatch(en.title + en.hint, han);
    assert.doesNotMatch(en.title + en.hint, /too short/i);
    assert.match(en.hint, /gave the answer away|answer/i);
  }
});

test("a quality gate whose reason is unknown still does not blame the sources", () => {
  const zh = inLanguage("zh", () => m.describeFailure("Quality gate failed: q1: unsupported"));
  assert.equal(zh.kind, "quality");
  assert.doesNotMatch(zh.title + zh.hint, /资料可能太短/);
  assert.match(zh.hint, /技术详情/);
});

test("too little in the sources is its own failure, and only that suggests other sources or fewer questions", () => {
  for (const text of ["insufficient evidence: fewer supported knowledge points than requested", "Part 1: Assessment plan is not usable: insufficient evidence"]) {
    const zh = inLanguage("zh", () => m.describeFailure(text));
    assert.ok(["evidence", "plan"].includes(zh.kind), `${text} -> ${zh.kind}`);
    assert.match(zh.hint, /资料/);
    assert.match(zh.hint, /换|减少题数/);
  }
  const source = readFileSync("ui/generation-status.js", "utf8");
  const mentions = source.split("\n").filter((line) => line.includes("资料可能太短"));
  assert.equal(mentions.length, 1, "one place says it");
  assert.match(source, /case 'evidence'[\s\S]{0,400}资料可能太短/, "and it is the evidence case");
});

test("the technical detail is one entry per question with its reasons and severity", () => {
  const rows = m.failureBreakdown(REVIEW_FAILURE);
  const byQuestion = Object.fromEntries(rows.map((row) => [`${row.part ?? ""}:${row.question}`, row]));
  assert.ok(rows.length >= 5, JSON.stringify(rows.map((row) => row.question)));
  const first = byQuestion["1:q1"];
  assert.deepEqual(first.codes.sort(), ["answer-leak", "options"]);
  assert.equal(first.severity, "blocker");
  assert.equal(first.raw.length, 2, "the original lines are kept for the expander");
  assert.equal(byQuestion["1:q2"].codes[0], "source");
  assert.deepEqual(byQuestion["1:q3"].codes.sort(), ["explanation", "value"]);
  assert.deepEqual(byQuestion["1:q4"].codes, ["answer-leak"], "a structural line is attributed by its card number");
  assert.equal(byQuestion["2:q1"].codes[0], "self-contained");
  const label = inLanguage("zh", () => m.failureRowLabel(first));
  assert.match(label, /^q1 · /);
  assert.match(label, /提示或题干泄露了答案/);
  assert.match(label, /必须修/);
  assert.match(inLanguage("en", () => m.failureRowLabel(first)), /^q1 · .*must fix/i);
  assert.deepEqual(m.failureBreakdown("fetch failed"), [], "a failure that is not about questions has no per-question rows");
});
