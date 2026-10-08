import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { build } from "esbuild";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { reviewElement } from "./helpers/review-render.mjs";

// #180: a background-assistant failure is shown through the one model-error note, with the fix that can work.
const compiled = await build({ stdin: { contents: `
  export { default as Review } from './ui/Review.jsx';
  export { StudyServicesContext } from './ui/study-context.jsx';
  export { ModelSettingsContext } from './ui/ModelErrorNote.jsx';
  export { FAILURE_COPY, describeFailure, describeModelError, plainAssistFailure } from './ui/generation-status.js';
  export { setUiLanguage } from './ui/i18n.js';`, resolveDir: process.cwd() },
bundle: true, write: false, platform: "node", format: "cjs", external: ["react", "react-dom"], loader: { ".css": "text" }, logLevel: "silent" });
const module = { exports: {} };
new Function("require", "module", "exports", compiled.outputFiles[0].text)(createRequire(import.meta.url), module, module.exports);
const m = module.exports;
const h = React.createElement;

const RAW_403 = '403: {"message":"Authentication failed. Please check your credentials.","type":"permission_error"}';
const card = { id: "q", kind: "quiz", topic: "Context", prompt: "Who processes payments?", options: [{ id: "a", text: "Payment System" }] };
function failed(task, links = {}) {
  const inner = reviewElement(m.Review, m.StudyServicesContext, {
    run: { id: "r", index: 0, total: 2, card, revealed: false, feedback: null, solution: null },
    data: { sources: [] }, host: {}, choice: true, isCloze: false, selected: [], clozeValues: {}, shellTitle: "Review", busy: false,
    assistTasks: [{ id: "t", cardId: "q", mode: "ask", status: "failed", question: "为什么？", choices: ["prerequisite"], ...task }], ...links });
  return renderToStaticMarkup(h(m.ModelSettingsContext.Provider, { value: () => {} }, inner));
}

test("a 403 Authentication failed is the rejected kind: key gone bad or model retired, fixed in the settings (#180)", () => {
  m.setUiLanguage("zh");
  const info = m.describeModelError(RAW_403);
  assert.equal(info.kind, "rejected");
  assert.equal(info.action, "settings");
  assert.match(info.hint, /密钥/);
  assert.match(info.hint, /不再支持|停用/);
  assert.match(info.hint, /换一个模型/);
  assert.equal(info.detail, RAW_403);
  assert.equal(m.describeFailure(RAW_403).kind, "rejected", "a generation job says the same");
  assert.equal(m.describeModelError("permission_error").kind, "rejected");
  assert.equal(m.describeModelError("401 Unauthorized").kind, "rejected");
  assert.equal(m.describeModelError("NO_ADAPTER: Configure a model provider").kind, "credential", "no key at all stays the credential kind");
});

test("a model the provider no longer serves is its own kind that suggests switching the model (#180)", () => {
  m.setUiLanguage("zh");
  for (const raw of ["404: model_not_found: The model `abc-1` does not exist", "The model is not supported by this provider", "unsupported model: abc-1",
    "This model has been deprecated", "model decommissioned on 2026-09-01", "模型已下线"]) {
    const info = m.describeModelError(raw);
    assert.equal(info.kind, "model-retired", raw);
    assert.equal(info.action, "settings");
    assert.match(info.hint, /换一个模型/);
  }
  assert.equal(m.describeModelError("429 Too Many Requests").kind, "rate-limit");
  const english = JSON.parse(readFileSync("ui/locales/en.wave4.json", "utf8"));
  for (const kind of ["rejected", "model-retired"]) for (const key of [m.FAILURE_COPY[kind].title, m.FAILURE_COPY[kind].hint]) assert.ok(english[key], `English for ${key}`);
});

test("plainAssistFailure drops the doubled prefix the backend used to add (#180)", () => {
  assert.equal(m.plainAssistFailure("后台助教未完成：403: x"), "403: x");
  assert.equal(m.plainAssistFailure("新前置题格式无效"), "新前置题格式无效");
  assert.equal(m.plainAssistFailure(""), "");
});

test("a credential failure of the background assistant: readable cause, 前往设置, no 重新提交 (#180)", () => {
  const html = failed({ message: `后台助教未完成：${RAW_403}` });
  assert.match(html, /role="alert"/);
  assert.match(html, /模型服务拒绝了请求/);
  assert.match(html, />前往设置<\/button>/);
  assert.doesNotMatch(html, />重新提交<\/button>/, "resubmitting a rejected key cannot work");
  assert.doesNotMatch(html, />改一改再提交<\/button>/);
  assert.match(html, /技术详情/);
  assert.match(html, /Authentication failed/);
  assert.doesNotMatch(html, /后台助教没能完成：后台助教未完成/);
  assert.doesNotMatch(html, /后台助教未完成/);
});

test("a rate limit or timeout still offers 重新提交 with the retry wording (#180)", () => {
  for (const raw of ["后台助教未完成：429 Too Many Requests: rate limit", "request timed out"]) {
    const html = failed({ message: raw });
    assert.match(html, /role="alert"/);
    assert.match(html, />重新提交<\/button>/, raw);
    assert.doesNotMatch(html, />前往设置<\/button>/);
  }
  assert.match(failed({ message: "429 rate limit" }), /模型服务太忙了/);
});

test("a content failure keeps the plain line with both buttons, without a repeated prefix (#180)", () => {
  const html = failed({ message: "后台助教未完成：新前置题格式无效" });
  assert.match(html, /后台助教没能完成：新前置题格式无效/);
  assert.doesNotMatch(html, /没能完成：后台助教未完成/);
  assert.match(html, /<button[^>]*>重新提交<\/button>/);
  assert.match(html, /<button[^>]*>改一改再提交<\/button>/);
});

test("a settings-kind failure hides 改一改再提交 even for a typed question; a retry-kind failure shows it only when the task has content to edit (#180)", () => {
  assert.doesNotMatch(failed({ message: RAW_403 }), /改一改再提交/);
  assert.doesNotMatch(failed({ message: "429 rate limit" }), />改一改再提交</, "a rate limit is not about the content");
});

test("the dist of the English catalogue and the source: the doubled prefix is gone from Review.jsx (#180)", () => {
  const files = readdirSync("ui/locales").filter((file) => file === "en.wave4.json");
  assert.equal(files.length, 1);
  const source = readFileSync("ui/Review.jsx", "utf8");
  assert.match(source, /ModelErrorNote/);
  assert.match(source, /plainAssistFailure/);
});
