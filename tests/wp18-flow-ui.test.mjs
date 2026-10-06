/* WP18 · the flow's course line, switcher, hint, readable references and the
   shared friendly model-error mapper. */
import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { build } from "esbuild";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { nativeSelects } from './helpers/native-selects.mjs';

const compiled = await build({ stdin: { contents: `
  export * from './ui/generation-status.js';
  export { ScopeBar, Readings } from './ui/WorkflowScope.jsx';
  export { default as ModelErrorNote } from './ui/ModelErrorNote.jsx';
  export { setUiLanguage } from './ui/i18n.js';`, resolveDir: process.cwd() },
bundle: true, write: false, platform: "node", format: "cjs", external: ["react", "react-dom"], plugins: [nativeSelects], loader: { ".css": "text" }, logLevel: "silent" });
const module = { exports: {} };
new Function("require", "module", "exports", compiled.outputFiles[0].text)(createRequire(import.meta.url), module, module.exports);
const m = module.exports;
const han = /[㐀-鿿]/;
const PE = "Platform Engineering", CN = "Cloud Native Solution Design";
const RATE = "Your requests to gpt-6-luna for gpt-6-luna in centralus have exceeded token rate limit.";
const render = (language, element) => { m.setUiLanguage(language); try { return renderToStaticMarkup(element); } finally { m.setUiLanguage("zh"); } };

const resources = (extra = {}) => ({ scopeTopics: ["平台工程基础", "GitOps 发布", "可观测性", "内部开发者平台", "容器编排"], scopeTopicCount: 5, cardCount: 451,
  scopeDecks: [`${PE}｜期末综合卷05｜90题`], courses: [{ name: PE, current: true, cards: 451, decks: 5 }, { name: CN, current: false, cards: 40, decks: 6 }],
  rescope: { allowed: true }, hint: null, ...extra });
const session = (extra = {}) => ({ pickedBy: "ai", course: { name: PE, label: "" }, goal: "弄懂cloud computing重点", ...extra });
const bar = (language, s, r, props = {}) => render(language, React.createElement(m.ScopeBar, { session: s, resources: r, onRescope() {}, ...props }));

test("the scope line names the course the topics were picked from", () => {
  const zh = bar("zh", session(), resources());
  assert.match(zh, /在「Platform Engineering」课程里为你选了/);
  assert.match(zh, /5 个主题/);
  assert.match(zh, /451/);
  const en = bar("en", session(), resources());
  assert.match(en, /Picked 5 topics from the “Platform Engineering” course|Picked from “Platform Engineering”/);
  assert.doesNotMatch(en.replace(/Platform Engineering｜期末综合卷05｜90题|Platform Engineering|Cloud Native Solution Design|平台工程基础|GitOps 发布|可观测性|内部开发者平台|容器编排|弄懂cloud computing重点|期末综合卷05/g, ""), han);
});

test("the fallback says nothing matched in this course and studies the course instead", () => {
  const zh = bar("zh", session({ pickedBy: "course" }), resources());
  assert.match(zh, /「Platform Engineering」里没找到与「弄懂cloud computing重点」直接相关的主题，先学这门课的内容/);
  assert.match(zh, /is-fallback/);
  const en = bar("en", session({ pickedBy: "course" }), resources());
  assert.match(en, /Nothing in “Platform Engineering” matches “弄懂cloud computing重点” directly/);
});

test("the course switcher lists the other courses and marks the current one", () => {
  const zh = bar("zh", session(), resources());
  assert.match(zh, /aria-label="换课程"/);
  assert.match(zh, new RegExp(`<option[^>]*value="${CN}"[^>]*>${CN}`));
  assert.match(zh, new RegExp(`<option[^>]*value="${PE}"[^>]*selected[^>]*>${PE}`), "the current course is the chosen one");
  const en = bar("en", session(), resources());
  assert.match(en, /aria-label="Switch course"/);
  assert.match(en, /data-combobox="field"/, "a searchable picker, not a plain select");
});

test("a cross-course hint offers one click to switch and is absent without a match", () => {
  const zh = bar("zh", session({ pickedBy: "course" }), resources({ hint: { course: CN, cards: 40 } }));
  assert.match(zh, /「Cloud Native Solution Design」可能更相关/);
  assert.match(zh, /切换到这门课/);
  assert.doesNotMatch(bar("zh", session(), resources()), /可能更相关/);
  assert.match(bar("en", session({ pickedBy: "course" }), resources({ hint: { course: CN, cards: 40 } })), /“Cloud Native Solution Design” may fit better/);
});

test("a model that failed to pick is said so in one muted line", () => {
  const zh = bar("zh", session({ pickedBy: "match", aiFailed: true }), resources());
  assert.match(zh, /模型暂时不可用，已按名称匹配主题/);
  assert.match(bar("en", session({ pickedBy: "match", aiFailed: true }), resources()), /The model is unavailable right now/);
  assert.doesNotMatch(bar("zh", session(), resources()), /模型暂时不可用/);
});

test("the scope line copes with no course and with the route's batch", () => {
  const route = bar("zh", session({ pickedBy: "route", course: { name: PE, label: "第 2 批" } }), resources());
  assert.match(route, /课程路线的这一批/);
  const none = bar("zh", { pickedBy: "match" }, resources({ courses: [] }));
  assert.doesNotMatch(none, /换课程/, "nothing to switch to without courses");
  const unassigned = bar("zh", session({ course: { name: "", label: "" } }), resources());
  assert.match(unassigned, /未分类课程/);
});

test("the switcher is not shown while the session is paused or finished", () => {
  assert.doesNotMatch(bar("zh", session(), resources(), { disabled: true }), /<select/);
});

test("readings show a compact card for bank imports and keep real quotes as quotes", () => {
  const readings = [
    { deckId: "d1", cardId: "a", topic: "GitOps 发布", explanation: "讲解 A", citations: [],
      card: { kind: "flashcard", prompt: "GitOps 的核心思想？", answer: "以 Git 为唯一事实来源", deck: `${PE}｜期末综合卷05｜90题` } },
    { deckId: "d2", cardId: "b", topic: "云计算", explanation: "讲解 B", citations: [{ sourceId: "notes", quote: "云计算是按需获取计算资源的模式。", locator: "p.3" }] },
  ];
  const html = render("zh", React.createElement(m.Readings, { resources: { readings, sources: [{ id: "notes", title: "云原生课堂讲义" }] } }));
  assert.match(html, /GitOps 的核心思想？/);
  assert.match(html, /看答案/);
  assert.match(html, /以 Git 为唯一事实来源/);
  assert.match(html, /期末综合卷05/);
  assert.doesNotMatch(html, /&quot;kind&quot;|"kind"|\{&quot;/);
  assert.match(html, /<blockquote>/);
  assert.match(html, /云计算是按需获取计算资源的模式/);
  assert.match(html, /云原生课堂讲义 · p\.3/);
  const en = render("en", React.createElement(m.Readings, { resources: { readings, sources: [] } }));
  assert.match(en, /Show answer/);
});

test("the model-error mapper turns rate limits, connection errors and timeouts into plain advice", () => {
  const cases = [
    [RATE, "rate-limit", /限流.*一两分钟/, /rate-limited.*minute/i],
    ["Connection error.", "network", /连不上模型服务.*网络/, /reach the model service.*network/i],
    ["fetch failed", "network", /连不上模型服务/, /reach the model/i],
    ["read ECONNRESET", "network", /连不上模型服务/, /reach the model/i],
    ["Request timed out after 180000 ms", "timeout", /没有回应|太久/, /did not respond|too long|timed out/i],
    ["HTTP 429 Too Many Requests", "rate-limit", /限流/, /rate-limited/i],
  ];
  for (const [raw, kind, zhText, enText] of cases) {
    const zh = m.describeModelError(raw);
    assert.equal(zh.kind, kind, raw);
    assert.equal(zh.detail, raw, "the raw text stays available");
    assert.match(`${zh.title}${zh.hint}`, zhText, raw);
    const en = (() => { m.setUiLanguage("en"); try { return m.describeModelError(raw); } finally { m.setUiLanguage("zh"); } })();
    assert.match(`${en.title} ${en.hint}`, enText, raw);
    assert.doesNotMatch(`${en.title}${en.hint}`, han);
  }
});

test("an unknown error passes through unchanged", () => {
  const unknown = m.describeModelError("讲解过于简略或过长，需要补齐概念、推演和例子");
  assert.equal(unknown.kind, "unknown");
  assert.equal(unknown.title, "讲解过于简略或过长，需要补齐概念、推演和例子");
  assert.equal(unknown.detail, "");
  assert.equal(m.describeModelError("").kind, "unknown");
});

test("the model-error note shows plain words first and the raw text behind 技术详情", () => {
  const html = render("zh", React.createElement(m.ModelErrorNote, { error: RATE }));
  assert.match(html, /模型服务太忙了/);
  assert.match(html, /<details/);
  assert.match(html, /技术详情/);
  assert.ok(html.indexOf("模型服务太忙了") < html.indexOf("exceeded token rate limit"));
  const plain = render("zh", React.createElement(m.ModelErrorNote, { error: "上次没有生成成功" }));
  assert.doesNotMatch(plain, /<details/, "an unknown message has no toggle");
  assert.match(plain, /上次没有生成成功/);
  assert.match(render("en", React.createElement(m.ModelErrorNote, { error: "Connection error." })), /Technical details/);
});
