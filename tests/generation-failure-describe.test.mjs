import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { build } from "esbuild";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { classifyFailure, reasonCode, isPermanentFailure, FAILURE_CODES, reviewProtocolError } from "../lib/generation-failure.js";
import { describePartReport as describeForAgent, failureReason } from "../lib/generation-report.js";
import { modelFailureMessage } from "../lib/model-retry.js";

/* ONE description of a failure. The same failure used to read three ways: the part report said "other reason", the 查看记录 list "生成没有完成（Review JSON protocol
   failed: ...）", the banner only the title. Now lib/generation-failure.js names the cause (a code) and ui/generation-status.js `describeFailure` says it in plain words
   ({ code, title, cause, retried, hint }); the banner's per-part lines, the record list and the console's failed call all print the same sentence. */

const load = async (contents) => {
  const compiled = await build({ stdin: { contents, resolveDir: process.cwd() }, bundle: true, write: false, platform: "node", format: "cjs", external: ["react"],
    loader: { ".css": "text" }, logLevel: "silent" });
  const module = { exports: {} };
  new Function("require", "module", "exports", compiled.outputFiles[0].text)(createRequire(import.meta.url), module, module.exports);
  return module.exports;
};
const m = await load(`export * from './ui/draft-shortfall.js'; export * from './ui/generation-status.js'; export { logLines, callLabel } from './ui/tasks/call-model.js'; export { setUiLanguage } from './ui/i18n.js';`);
const view = await load(`export { ShortfallReasons } from './ui/DraftShortfall.jsx'; export { setUiLanguage } from './ui/i18n.js';`);
const han = /[㐀-鿿]/;
const inLanguage = (language, fn) => { m.setUiLanguage(language); view.setUiLanguage(language); try { return fn(); } finally { m.setUiLanguage("zh"); view.setUiLanguage("zh"); } };
const text = (html) => html.replace(/<[^>]+>/g, "\n").replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#x27;/g, "'").split("\n").map((line) => line.trim()).filter(Boolean);

const OWNER_5 = "Review protocol failed after 3 attempts: missing complete per-card checks (2 cards)";
const OWNER_8 = "Review JSON protocol failed after 3 attempts: Unexpected end of JSON input";

test("the classifier names the cause of an error or of the text the pipeline left", () => {
  const table = [
    [OWNER_5, "review-protocol"], [OWNER_8, "review-protocol"], ["Review protocol failed: missing complete per-card checks", "review-protocol"],
    ["Part 3: citation text is not in source", "quote"], ["Assessment plan is not usable: x", "plan"], ["Quality gate failed: q1: answerLeak", "quality"],
    ["Model returned no text", "no-reply"], ["模型这次没有返回内容，已自动重试 2 次", "no-reply"], ["Model timed out after 120s", "timeout"],
    ["模型长时间没有响应（请求超时），可以稍后重试", "timeout"], ["429 Too Many Requests", "rate-limit"], ["模型请求太频繁，被限流了", "rate-limit"],
    ["Invalid API key (401 unauthorized)", "credential"], ["402 insufficient balance", "quota"], ["Generation reached its 20-minute total budget", "budget"],
    ["This operation was aborted", "cancelled"], ["503 Service Unavailable", "unavailable"], ["something nobody has seen", "unknown"], ["", "unknown"],
  ];
  for (const [input, code] of table) assert.equal(classifyFailure(input).code, code, input);
  assert.equal(classifyFailure(reviewProtocolError({ attempts: 3 })).code, "review-protocol");
  assert.equal(classifyFailure(Object.assign(new Error("x"), { name: "TimeoutError" })).code, "timeout");
  assert.equal(classifyFailure(Object.assign(new Error("x"), { name: "AbortError" })).code, "cancelled");
  assert.equal(classifyFailure(OWNER_5).attempts, 3);
  assert.equal(classifyFailure(OWNER_5).retries, 2);
  assert.equal(classifyFailure("模型这次没有返回内容，已自动重试 2 次").retries, 2);
  assert.equal(reasonCode("something nobody has seen"), "other", "older records and reports call an unknown cause 'other'");
  assert.equal(failureReason(OWNER_5), "review-protocol");
  assert.equal(isPermanentFailure("Invalid API key (401)"), true);
  assert.equal(isPermanentFailure(OWNER_5), false);
});

test("describeFailure gives { code, title, cause, retried, hint } in plain words, zh and en; the raw English exception is never the cause", () => {
  const zh = inLanguage("zh", () => m.describeFailure(OWNER_5));
  assert.equal(zh.code, "review-protocol");
  assert.match(zh.title, /审阅回复的格式不对/);
  assert.match(zh.cause, /审阅回复的格式不对/);
  assert.match(zh.retried, /已自动重新审阅 2 次仍然格式不对/);
  assert.match(zh.hint, /继续补齐/);
  assert.doesNotMatch([zh.title, zh.cause, zh.retried, zh.hint].join(" "), /protocol|checks|attempts/i, "no raw English");
  const en = inLanguage("en", () => m.describeFailure(OWNER_8));
  assert.equal(en.code, "review-protocol");
  const words = (found) => [found.title, found.cause, found.retried, found.hint].join(" ");
  assert.doesNotMatch(words(en), han);
  assert.doesNotMatch(words(en), /Unexpected end|protocol failed/i);
  assert.match(en.retried, /Reviewed again 2 time/);
  const unknown = inLanguage("zh", () => m.describeFailure("Boom: " + "x".repeat(400)));
  assert.equal(unknown.code, "unknown");
  assert.match(unknown.cause, /^生成没有完成（Boom: x+…）$/, "an unknown cause keeps the plain headline and the first 160 characters of the raw text");
  assert.ok(unknown.cause.length <= 200);
  const known = inLanguage("zh", () => m.describeFailure("Part 4: Quality gate failed: x"));
  assert.equal(known.cause, "没有题目通过检查", "the cause every older test and screen expects is unchanged");
  assert.equal(known.retried, "");
  for (const code of ["timeout", "rate-limit", "no-reply", "quota", "credential", "unavailable"]) {
    const sample = { timeout: "Model timed out after 120s", "rate-limit": "429 Too Many Requests", "no-reply": "Model returned no text", quota: "402 insufficient balance",
      credential: "Invalid API key (401)", unavailable: "503 Service Unavailable" }[code];
    for (const language of ["zh", "en"]) {
      const found = inLanguage(language, () => m.describeFailure(sample));
      assert.ok(found.title && found.cause && found.hint !== undefined, `${code} ${language}`);
      if (language === "en") assert.doesNotMatch([found.title, found.cause, found.retried, found.hint].join(" "), han, `${code} in English`);
    }
  }
});

test("a failure of several parts that all have the review cause is described as that; a mixed one is left to the generic table", () => {
  const same = inLanguage("zh", () => m.describeFailure(`Part 5: ${OWNER_5}; Part 8: ${OWNER_8}`));
  assert.equal(same.code, "review-protocol");
  const mixed = inLanguage("zh", () => m.describeFailure(`Part 1: Quality gate failed: q1: answerLeak failed or was not checked; Part 2: ${OWNER_8}`));
  assert.equal(mixed.code, "quality", "the generic table reads it as it always did");
});

const draftWith = (failures) => ({ id: "d", title: "T", draftVersion: 1, cards: Array.from({ length: 10 }, (_, i) => ({ id: `c${i}`, kind: "quiz", citations: [] })),
  editorial: { requested: 15, generated: 10, parts: 3, completedParts: 1, failures, generation: { sourceIds: ["s"] } } });
const banner = (draft) => text(renderToStaticMarkup(React.createElement(view.ShortfallReasons, { draft })));

test("the banner's per-part lines and the 查看记录 list print the same sentence for the same failure, in both languages", () => {
  const failures = [`Part 5: ${OWNER_5}`, `Part 8: ${OWNER_8}`, "Part 2: Boom happened in the pipeline"];
  for (const language of ["zh", "en"]) {
    inLanguage(language, () => {
      const lines = m.generationRecordLines(failures), shown = banner(draftWith(failures));
      assert.equal(lines.length, 3);
      for (const line of lines) assert.ok(shown.includes(line), `${language}: the banner has the record's sentence: ${line}\n--- banner:\n${shown.join("\n")}`);
      assert.doesNotMatch(shown.join(" "), /Review (?:JSON )?protocol failed|Unexpected end of JSON/, "no raw exception in the banner");
      assert.doesNotMatch(lines[0] + lines[1], /protocol|JSON input/i);
      if (language === "en") assert.doesNotMatch(shown.join(" ") + lines.join(" "), han);
    });
  }
  const zh = inLanguage("zh", () => m.generationRecordLines([`Part 5: ${OWNER_5}`])[0]);
  assert.equal(zh, "第 5 批没有完成：审阅回复的格式不对；已自动重新审阅 2 次仍然格式不对");
  assert.match(inLanguage("zh", () => m.generationRecordLines(["Part 2: Boom happened"])[0]), /^第 2 批没有完成：生成没有完成（Boom happened）$/);
});

test("the part report says what happened for every code, to the learner and to the agent, and the parts strip knows them too", () => {
  const strip = readFileSync("ui/tasks/GenerationParts.jsx", "utf8");
  for (const code of FAILURE_CODES.filter((code) => code !== "unknown")) {
    const report = { total: 3, passed: 1, partial: 0, failed: 2, reasons: { [code]: 2 } };
    const zh = inLanguage("zh", () => m.describePartReport(report)), en = inLanguage("en", () => m.describePartReport(report));
    assert.equal(zh.reasons.length, 1, code);
    assert.doesNotMatch(zh.reasons[0], /其他原因/, `${code} is not "another reason" in the banner`);
    assert.doesNotMatch(en.reasons[0], han, `${code} in English`);
    assert.doesNotMatch(describeForAgent(report, "en"), /another reason/, `${code} for the agent`);
    assert.doesNotMatch(describeForAgent(report, "zh"), /其他原因/, `${code} for the agent in Chinese`);
    assert.match(strip, new RegExp(`['"]?${code.replace("-", "[-]")}['"]?:\\s*'`), `the 资料部分 strip names ${code}`);
  }
});

test("a failed call in the console says its cause in plain words, with what was already tried, in the UI language", () => {
  const call = (error) => ({ callId: "c1", kind: "review", status: "failed", startedAt: "2026-10-05T10:00:00Z", endedAt: "2026-10-05T10:00:05Z", error, part: 2, parts: 4 });
  const line = (error, language = "zh") => inLanguage(language, () => m.logLines({ calls: [call(error)], events: [] })[0].text);
  const chinese = modelFailureMessage(Object.assign(new Error("Model returned no text"), { attempts: 3 }));
  assert.match(line(chinese), /原因：模型这次没有返回内容，已自动重试 2 次/, "a Chinese UI keeps the plain sentence the job recorded");
  assert.match(line(chinese, "en"), /The model returned nothing; Retried 2 time\(s\) automatically/, "an English UI says the same in English");
  assert.doesNotMatch(line(chinese, "en"), han);
  assert.match(line("Model returned no text"), /原因：模型没有返回内容/, "an English exception is said in plain words");
  assert.match(line("Model returned no text", "en"), /The model returned nothing/);
  assert.match(line("模型长时间没有响应（请求超时），可以稍后重试"), /原因：模型长时间没有响应/);
  assert.match(line("a failure nobody knows"), /原因：a failure nobody knows/, "an unknown text is shown as it is");
});

test("a review asked again is called a retry in the console", () => {
  const review = { kind: "review", part: 2, parts: 4, status: "ok" };
  assert.equal(inLanguage("zh", () => m.callLabel(review)), "独立审阅 2/4");
  assert.equal(inLanguage("zh", () => m.callLabel({ ...review, retry: 1 })), "独立审阅 2/4 · 第 1 次重新审阅");
  assert.equal(inLanguage("en", () => m.callLabel({ ...review, retry: 2 })), "Independent review 2/4 · re-review 2");
  assert.equal(inLanguage("zh", () => m.callLabel({ kind: "author", part: 1, parts: 4, retry: 1 })), "出题与自查 1/4", "only a review is labelled as one");
});
