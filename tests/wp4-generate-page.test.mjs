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

test("generating from materials is the first way in, in plain words, on the app's one segmented control (#1700)", () => {
  const html = render();
  assert.doesNotMatch(html, /IMPORT → STUDY|导入或补充题目|从资料补题/);
  assert.equal(html.match(/<h1/g)?.length, 1);
  const group = /<div[^>]*role="group"[^>]*aria-label="创建方式"[^>]*>([\s\S]*?)<\/div>/.exec(html);
  assert.ok(group, "the ways in are one named group");
  assert.match(group[0], /class="sh-seg [^"]*source-mode"/, "drawn as every other segmented control, so the chosen one looks chosen");
  const ways = [...group[1].matchAll(/<button[^>]*>(.*?)<\/button>/g)].map((match) => match[0]);
  assert.ok(ways.length >= 2, "two ways to create a deck");
  assert.match(ways[0], /用资料出题/);
  assert.match(ways[0], /class="sh-seg__item is-active"[^>]*aria-pressed="true"/);
  assert.match(ways[0], /data-tour="generate-from-sources"/, "the anchor the tour and 找功能 light stays on the button");
  assert.match(ways[1], /导入 JSON 题组/);
  assert.match(ways[1], /aria-pressed="false"/);
  assert.match(ways[1], /data-tour="generate-json"/);
  assert.equal(ways.filter((way) => /aria-pressed="true"/.test(way)).length, 1, "one is on");
  assert.equal(ways.filter((way) => /tabindex="0"/.test(way)).length, 1, "one tab stop for the row; the arrow keys move along it");
  // What the chosen way does is said once, as the group's description, and no panel points at a tab that is not there.
  const described = /aria-describedby="([^"]+)"/.exec(group[0])?.[1];
  assert.ok(described, "the group is described");
  assert.match(html, new RegExp(`<p[^>]*id="${described}"[^>]*>AI 按你的资料出题，并逐题检查</p>`));
  assert.doesNotMatch(html, /role="tab(panel|list)?"/);
  assert.match(render({}, { genSource: "json" }), new RegExp(`<p[^>]*id="${described}"[^>]*>已有题目，或外部 AI 生成的题</p>`));
  assert.doesNotMatch(group[0], /推荐/);
});

test("the PDF importer is no longer embedded; one link opens the import dialog", () => {
  const html = render();
  assert.doesNotMatch(html, /<input[^>]*type="file"/);
  assert.doesNotMatch(html, /PDF \/ 讲义 → 新题/);
  assert.match(html, /<button[^>]*>(?:<svg.*?<\/svg>)?添加资料<\/button>/);
  assert.doesNotMatch(html, /导入资料/, 'one name for adding material: no second button called 导入资料');
});

test("the submit button carries its tour anchor and stays one primary action", () => {
  const html = render();
  assert.match(html, /<button[^>]*type="submit"[^>]*data-tour="generate-submit"|<button[^>]*data-tour="generate-submit"[^>]*type="submit"/);
  assert.equal((html.match(/sh-btn--primary/g) || []).length, 1);
  assert.match(render({}, { running: true }), /加入生成队列/);
  assert.match(render({}, { running: true }), /新的会排在它后面/);
});

test("conversation recording is offered only where a chat can take it", () => {
  assert.doesNotMatch(render({}, { canChat: false }), /录入已有题目|在主会话里录题|在对话里录题/);
  assert.match(render({}, { canChat: true }), /在主会话里录题/);
});

test("with no materials the tab says what to do first and opens the import dialog", () => {
  const html = render({ sources: [] }, { selectedSources: [] });
  assert.match(html, /sh-empty/);
  assert.match(html, /sh-empty__title[^>]*>还没有资料</);
  assert.match(html, /sh-btn--primary[^>]*>(?:<svg.*?<\/svg>)?添加资料/);
  assert.doesNotMatch(html, /type="submit"/, "nothing to generate from yet");
});

test("without a usable model the gate is a banner on top of the form and the submit stays, off", () => {
  for (const patch of [{ model: { ready: false, reason: "no-credential", label: "DeepSeek V3" } }, { modelReady: false }]) {
    const html = render(patch);
    assert.match(html, /sh-banner--warning/);
    assert.match(html, /还没有可用的 AI 模型/);
    assert.match(html, /前往设置/);
    assert.ok(html.indexOf("sh-banner--warning") < html.indexOf("<form"), "the banner comes before the form");
    assert.doesNotMatch(html, /sh-setup/, "no block under the form any more");
    assert.match(html.match(/<button[^>]*data-tour="generate-submit"[^>]*>/)[0], /type="submit"[^>]*disabled|disabled[^>]*type="submit"/, "Generate cannot be clicked into a 20-second failure");
  }
  assert.doesNotMatch(render({ model: { ready: true, reason: "ok" }, modelReady: false }), /sh-banner--warning/, "the host contract wins over the legacy flag");
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
      const visible = text(html).replace(/索引笔记|事务笔记(?:\.md)?|数据库/g, "");
      assert.doesNotMatch(visible, han, visible.match(/.{0,30}[㐀-鿿].{0,30}/)?.[0]);
    }
  } finally { setUiLanguage("zh"); }
});

test("the app opens 创建题组 on generating from materials and keeps form defaults in one place", async () => {
  const app = await readAppSource();
  assert.match(app, /\[genSource, setGenSource\] = useState\(["']files["']\)/);
  assert.match(app, /GENERATION_DEFAULTS/);
});
