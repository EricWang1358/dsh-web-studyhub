import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { build } from "esbuild";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readAppSource } from "./helpers/app-source.mjs";

// D1 / P09 / P14: 创建题组 leads with generating from the learner's materials,
// keeps JSON import as the second entry, and gates generation on a usable model
// before the learner fills in the form.
const compiled = await build({ stdin: { contents: `export { default as Generate } from './ui/Generate.jsx'; export { setUiLanguage } from './ui/i18n.js';`,
  resolveDir: process.cwd() }, bundle: true, write: false, platform: "node", format: "cjs", external: ["react"],
  loader: { ".css": "text" }, logLevel: "silent" });
const module = { exports: {} };
new Function("require", "module", "exports", compiled.outputFiles[0].text)(createRequire(import.meta.url), module, module.exports);
const { Generate, setUiLanguage } = module.exports;
const han = /[㐀-鿿]/;
const noop = () => {};
const sources = [
  { id: "a", title: "索引笔记", text: "数据库索引加快查找。", courses: ["数据库"] },
  { id: "b", title: "事务笔记.md", text: "事务保证一致性。", courses: ["数据库"], document: { id: "md", format: "markdown" } },
];
const gen = { kind: "mixed", count: 10, difficulty: "mixed", language: "中文", focus: "", role: "" };
function render(patch = {}, props = {}) {
  const data = { root: "lib", decks: [], drafts: [], jobs: [], sources, modelReady: true,
    focus: { course: "数据库", courses: [{ name: "数据库" }] }, ...patch };
  return renderToStaticMarkup(React.createElement(Generate, { data, busy: false, running: false, act: noop, call: noop,
    openDraft: noop, setPage: noop, setNotice: noop, genSource: "files", setGenSource: noop, gen, setGen: noop,
    selectedSources: ["a"], setSelectedSources: noop, setModal: noop, askInChat: noop, openModelSettings: noop, ...props }));
}
const text = (html) => html.replace(/<[^>]+>/g, " ");

test("generating from materials is the first tab, in plain words", () => {
  const html = render();
  assert.doesNotMatch(html, /IMPORT → STUDY|导入或补充题目|从资料补题/);
  assert.equal(html.match(/<h1/g)?.length, 1);
  const tabs = [...html.matchAll(/<button[^>]*role="tab"[^>]*>(.*?)<\/button>/g)].map((match) => match[0]);
  assert.ok(tabs.length >= 2, "two ways to create a deck");
  assert.match(tabs[0], /用资料出题/);
  assert.match(tabs[0], /aria-selected="true"/);
  assert.match(tabs[0], /data-tour="generate-from-sources"/);
  assert.match(tabs[1], /导入 JSON 题组/);
  assert.match(tabs[1], /已有题目/);
  assert.doesNotMatch(tabs[1], /推荐/);
});

test("the PDF importer is no longer embedded; one link opens the import dialog", () => {
  const html = render();
  assert.doesNotMatch(html, /<input[^>]*type="file"/);
  assert.doesNotMatch(html, /PDF \/ 讲义 → 新题/);
  assert.match(html, /<button[^>]*>(?:<svg.*?<\/svg>)?导入资料<\/button>/);
});

test("the submit button carries its tour anchor and stays one primary action", () => {
  const html = render();
  assert.match(html, /<button[^>]*type="submit"[^>]*data-tour="generate-submit"|<button[^>]*data-tour="generate-submit"[^>]*type="submit"/);
  assert.equal((html.match(/sh-btn--primary/g) || []).length, 1);
  assert.match(render({}, { running: true }), /加入生成队列/);
  assert.match(render({}, { running: true }), /新的会排在它后面/);
});

test("conversation recording is offered only where a chat can take it", () => {
  assert.doesNotMatch(render({}, { canChat: false }), /录入已有题目|在对话里录题/);
  assert.match(render({}, { canChat: true }), /在对话里录题/);
});

test("with no materials the tab says what to do first and opens the import dialog", () => {
  const html = render({ sources: [] }, { selectedSources: [] });
  assert.match(html, /sh-empty/);
  assert.match(html, /先添加一份资料/);
  assert.match(html, /sh-btn--primary[^>]*>(?:<svg.*?<\/svg>)?添加资料/);
  assert.doesNotMatch(html, /type="submit"/, "nothing to generate from yet");
});

test("without a usable model the submit area becomes a setup gate", () => {
  for (const patch of [{ model: { ready: false, reason: "no-credential", label: "DeepSeek V3" } }, { modelReady: false }]) {
    const html = render(patch);
    assert.match(html, /sh-setup/);
    assert.match(html, /先配置一个 AI 模型/);
    assert.match(html, /打开模型设置/);
    assert.doesNotMatch(html, /type="submit"/, "Generate cannot be clicked into a 20-second failure");
    assert.match(html, /<section[^>]*sh-setup[^>]*data-tour="generate-submit"|data-tour="generate-submit"[^>]*sh-setup/);
  }
  assert.match(render({ model: { ready: false, reason: "no-credential", label: "DeepSeek V3" } }), /DeepSeek V3/);
  assert.doesNotMatch(render({ model: { ready: true, reason: "ok" }, modelReady: false }), /sh-setup/, "the host contract wins over the legacy flag");
});

test("a freshly imported Markdown file is not called a legacy extraction (P22)", () => {
  const html = render({}, { selectedSources: ["a", "b"] });
  assert.doesNotMatch(html, /旧版提取/);
});

test("the English page has no Chinese UI text", () => {
  try {
    setUiLanguage("en");
    const english = { ...gen, language: "English" };
    for (const html of [render({}, { gen: english }), render({ modelReady: false }, { gen: english }), render({ sources: [] }, { gen: english, selectedSources: [] })]) {
      const visible = text(html).replace(/索引笔记|事务笔记\.md|数据库/g, "");
      assert.doesNotMatch(visible, han, visible.match(/.{0,30}[㐀-鿿].{0,30}/)?.[0]);
    }
  } finally { setUiLanguage("zh"); }
});

test("the app opens 创建题组 on generating from materials and keeps form defaults in one place", async () => {
  const app = await readAppSource();
  assert.match(app, /\[genSource, setGenSource\] = useState\(["']files["']\)/);
  assert.match(app, /GENERATION_DEFAULTS/);
});
