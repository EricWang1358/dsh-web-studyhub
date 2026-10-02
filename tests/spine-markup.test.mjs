import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { build } from "esbuild";
import { spineFixture } from "../scripts/qa/spine-fixture.mjs";

/* The 学习脉络 panel as markup, in both languages: a stepper strip (tablist) plus ONE detail pane for the current station,
   a folded one-line summary where the skeleton is not the subject of the step, and screen reader semantics throughout.
   Behaviour in a browser (keys, persistence, geometry) is in tests/spine-layout.test.mjs. */

const require = createRequire(import.meta.url);
const han = /[㐀-鿿]/;
const compiled = await build({
  stdin: { contents: `import React from "react"; import { renderToStaticMarkup } from "react-dom/server";
    export { default as SkeletonSpine } from "./ui/SkeletonSpine.jsx"; export { setUiLanguage } from "./ui/i18n.js"; export { React, renderToStaticMarkup };`, resolveDir: process.cwd(), loader: "js" },
  bundle: true, write: false, format: "cjs", platform: "node", jsx: "transform", external: ["react", "react-dom", "react-dom/server"],
  loader: { ".css": "text", ".json": "json" }, logLevel: "silent",
});
function load() {
  const module = { exports: {} };
  new Function("require", "module", "exports", compiled.outputFiles[0].text)(require, module, module.exports);
  return module.exports;
}
const { SkeletonSpine, setUiLanguage, React, renderToStaticMarkup } = load();
const render = (props) => renderToStaticMarkup(React.createElement(SkeletonSpine, props));
const attr = (html, tag, name) => [...html.matchAll(new RegExp(`<${tag}\\b[^>]*>`, "g"))].map((m) => (m[0].match(new RegExp(`\\b${name}="([^"]*)"`)) || [])[1]);

test("where the skeleton is the subject the spine opens as a stepper strip with one detail pane", () => {
  setUiLanguage("zh");
  const skeleton = spineFixture("zh");
  const html = render({ skeleton, stepKind: "skeleton", onPractice: () => {} });
  assert.match(html, /role="tablist"/);
  const tabs = [...html.matchAll(/<button[^>]*role="tab"[^>]*>/g)].map((m) => m[0]);
  assert.equal(tabs.length, 5, "one tab per station");
  assert.deepEqual(tabs.map((t) => /aria-selected="true"/.test(t)), [true, false, false, false, false]);
  assert.deepEqual(tabs.map((t) => /tabindex="0"/.test(t)), [true, false, false, false, false], "roving tabindex: one stop in the strip");
  for (const station of ["领域驱动的初始服务边界", "服务之间怎样通信", "服务发现与负载均衡", "微服务的数据访问与读写分离", "故障隔离与可观测性"])
    assert.ok(tabs.some((t) => t.includes(`title="${station}"`)), `the full title of ${station} is the tooltip`);
  assert.equal([...html.matchAll(/role="tabpanel"/g)].length, 1, "ONE detail pane, not one column per station");
  const panelLabel = html.match(/role="tabpanel"[^>]*aria-labelledby="([^"]+)"|aria-labelledby="([^"]+)"[^>]*role="tabpanel"/);
  const labelledBy = panelLabel && (panelLabel[1] || panelLabel[2]);
  assert.ok(labelledBy && tabs[0].includes(`id="${labelledBy}"`), "the pane is labelled by the selected tab");
  assert.ok(tabs.every((t) => /aria-controls="[^"]+"/.test(t)));
  // The detail pane carries the first station in full: description, point, point description.
  assert.match(html, /用限界上下文划分服务，让每个服务围绕一项业务能力，而不是围绕技术分层。/);
  assert.match(html, /限界上下文/);
  assert.match(html, /在同一个边界内使用同一套模型和术语，团队只需要在边界上达成一次共识。/);
  assert.doesNotMatch(html, /每个服务一个数据库/, "the other stations' points are not listed at the same time");
  assert.match(html, /5 站 · 8 个要点/);
  assert.match(html, /1 \/ 5/, "a position counter says there are more stations");
  assert.deepEqual(attr(html, "button", "aria-expanded").filter(Boolean), ["true", "false"], "the fold toggle is open, the show-all toggle is closed");
  assert.match(html, /学这一站 · 2 题/, "the practice link of the station is still offered");
});

test("the spine never clamps what it shows in the detail pane", () => {
  setUiLanguage("zh");
  const html = render({ skeleton: spineFixture("zh"), stepKind: "skeleton" });
  assert.match(html, /role="tabpanel"/);
  assert.doesNotMatch(html, /line-clamp/);
  assert.doesNotMatch(html, /…/);
});

test("in a lesson the spine is one folded line with a current-station chip", () => {
  setUiLanguage("zh");
  const skeleton = spineFixture("zh");
  const html = render({ skeleton, stepKind: "lesson", heading: "本次脉络 · 微服务边界与通信学习脊柱" });
  assert.doesNotMatch(html, /role="tablist"|role="tabpanel"/, "folded: no strip, no detail pane");
  assert.match(html, /本次脉络 · 微服务边界与通信学习脊柱/);
  assert.match(html, /5 站 · 8 个要点/);
  const toggle = html.match(/<button[^>]*class="[^"]*spine-toggle[^"]*"[^>]*>/)[0];
  assert.match(toggle, /aria-expanded="false"/);
  assert.match(toggle, /aria-controls="[^"]+"/);
  assert.match(html, /1 \/ 5/);
  assert.match(html, /领域驱动的初始服务边界/, "the chip names the current station");
  const prev = html.match(/<button[^>]*aria-label="上一站"[^>]*>/)[0], next = html.match(/<button[^>]*aria-label="下一站"[^>]*>/)[0];
  assert.match(prev, /disabled/, "no station before the first");
  assert.doesNotMatch(next, /disabled/);
  assert.doesNotMatch(html, /每个服务一个数据库|限界上下文划分服务/, "no points while folded");
});

test("a spine that is not collapsible (the 知识骨架 page) is always open", () => {
  setUiLanguage("zh");
  const html = render({ skeleton: spineFixture("zh") });
  assert.match(html, /role="tablist"/);
  assert.doesNotMatch(html, /spine-toggle/);
});

test("English: every label, tooltip and count is English", () => {
  setUiLanguage("en");
  try {
    const skeleton = spineFixture("en");
    for (const props of [{ stepKind: "skeleton", onPractice: () => {} }, { stepKind: "lesson", heading: "Session outline · x" }, {}]) {
      const html = render({ skeleton, ...props });
      assert.doesNotMatch(html, han, JSON.stringify(props));
      assert.match(html, /5 stations · 8 points/);
    }
    const open = render({ skeleton, stepKind: "skeleton" });
    assert.match(open, /aria-label="Previous station"/);
    assert.match(open, /aria-label="Next station"/);
    assert.match(open, /1 \/ 5/);
  } finally { setUiLanguage("zh"); }
});

test("a single station has no strip arrows and nothing to expand", () => {
  setUiLanguage("zh");
  const html = render({ skeleton: { id: "x", title: "T", nodes: [{ id: "a", term: "唯一的一站", meaning: "说明", cards: [] }] }, stepKind: "skeleton" });
  assert.match(html, /role="tablist"/);
  assert.doesNotMatch(html, /aria-label="下一站"|spine-all-toggle/);
  assert.match(html, /唯一的一站/);
});

test("a skeleton without nodes renders nothing", () => {
  assert.equal(render({ skeleton: { id: "x", title: "T", nodes: [] } }), "");
});
