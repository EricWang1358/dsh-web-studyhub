import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { build } from "esbuild";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { mapProps } from './helpers/study-map-props.mjs';

// D1 / P08 / P12 / P15 / P26 / P28 / P29: the library home guides a newcomer
// from materials to a first deck, shows generation progress at the top in
// plain words, and keeps advanced blocks out of an empty library.
const compiled = await build({ stdin: { contents: `export { default as StudyMap } from './ui/StudyMap.jsx'; export { StudyServicesContext } from './ui/study-context.jsx';
  export { ModelSettingsContext } from './ui/ModelErrorNote.jsx'; export { setUiLanguage } from './ui/i18n.js';`,
  resolveDir: process.cwd() }, bundle: true, write: false, platform: "node", format: "cjs", external: ["react"],
  loader: { ".css": "text" }, logLevel: "silent" });
const module = { exports: {} };
new Function("require", "module", "exports", compiled.outputFiles[0].text)(createRequire(import.meta.url), module, module.exports);
const { StudyMap, StudyServicesContext, ModelSettingsContext, setUiLanguage } = module.exports;
const noop = () => {};
const deck = { id: "d1", title: "行为型模式", folder: "CS3219", course: "CS3219", topics: ["Memento"],
  available: 5, count: 5, quizCount: 3, createdAt: "2026-09-01T00:00:00Z" };
const progress = { d1: { counts: { mastered: 1, familiar: 1, learning: 1, weak: 1, new: 1 }, total: 5,
  mastery: 60, due: 1, status: "active", topics: [] } };
const pdfPages = [{ id: "p1", title: "讲义 第 1 页", text: "x", document: { id: "pdf", page: 1 } },
  { id: "p2", title: "讲义 第 2 页", text: "x", document: { id: "pdf", page: 2 } }];
const empty = { decks: [], progress: {}, sources: [], drafts: [], jobs: [], runs: [],
  today: { due: 0, weak: 0, new: 0, size: 0 }, focus: { mode: "class", course: "", courses: [], fresh: [] } };
/* The home reads its services from the app (chat ability, the model settings entry); the test supplies just those. */
function render(patch = {}, props = {}) {
  const data = { root: "/tmp/lib", ...empty, ...patch };
  const { canChat = false, openModelSettings = noop, ...rest } = props;
  const services = { call: async () => undefined, act: async () => undefined, busy: false, notify: noop, askInChat: noop, host: { capabilities: { chat: canChat } },
    openSettings: noop, navigate: noop, openModal: noop };
  const home = React.createElement(StudyMap, mapProps({
    data, start: noop, resume: noop, manage: noop, openDraft: noop,
    continueDraft: noop, retryGeneration: noop, addSource: noop, createManual: noop, importLibrary: noop,
    notebooks: { notebooks: [] }, generateFromSources: noop, ...rest,
  }));
  return renderToStaticMarkup(React.createElement(ModelSettingsContext.Provider, { value: openModelSettings },
    React.createElement(StudyServicesContext.Provider, { value: services }, home)));
}
const primaries = (html) => (html.match(/class="primary[^"]*"/g) || []).length;
const primaryLabel = (html) => html.match(/<button class="primary today-go"[^>]*>(.*?)<span/)?.[1];
// Technical details may keep raw provider wording; everything else must read in the UI language.
const withoutTechDetails = (html) => html.replace(/<details class="sh-disclosure tech-details"[\s\S]*?<\/details>/g, "");
const visibleText = (html) => html.replace(/<[^>]+>/g, " ");

test("an empty library asks for a first material, with JSON import as the second way in", () => {
  const html = render();
  assert.equal(primaries(html), 1);
  assert.equal(primaryLabel(html), "添加第一份资料");
  assert.match(html, /<button[^>]*class="sh-btn sh-btn--link[^"]*"[^>]*>已有题目？导入 JSON 题组<\/button>/);
  assert.doesNotMatch(html, /还没有卡片/);
  assert.doesNotMatch(html, /在对话中用工作区文件出题/, "a chat-only start is not offered without a chat");
  assert.match(render({}, { canChat: true }), /在对话中用工作区文件出题/);
});

test("an empty library hides advanced blocks", () => {
  const html = render();
  assert.doesNotMatch(html, /全局笔记本/);
  assert.doesNotMatch(html, /笔试 \/ 面试/);
  assert.doesNotMatch(html, /查看图谱/);
  const elsewhere = render({}, { notebooks: { notebooks: [{ root: "/other", title: "别的学习库", workspace: "/w", exists: true, current: false, decks: [], deckCount: 2 }] } });
  assert.match(elsewhere, /全局笔记本/, "published notebooks elsewhere stay reachable");
  const full = render({ decks: [deck], progress, sources: pdfPages, today: { due: 1, weak: 2, new: 0, size: 3 },
    focus: { mode: "class", course: "CS3219", courses: [{ name: "CS3219" }], fresh: [] } });
  assert.match(full, /全局笔记本/);
  assert.match(full, /笔试 \/ 面试/);
});

test("with materials and no decks the home offers to generate from them, counted per document", () => {
  const html = render({ sources: [...pdfPages, { id: "m", title: "笔记.md", text: "y" }] });
  assert.equal(primaries(html), 1);
  assert.equal(primaryLabel(html), "用这 2 份资料出题");
  assert.doesNotMatch(html, /还没有卡片/);
  assert.match(html, /已有题目？导入 JSON 题组/);
});

test("while the first deck is generating or waiting in drafts the home says so", () => {
  const generating = render({ sources: pdfPages, jobs: [{ id: "j", status: "running", stageCode: "authoring", deckTitle: "索引小测", steps: [] }] });
  assert.equal(primaries(generating), 1);
  assert.equal(primaryLabel(generating), "查看进度");
  const drafted = render({ sources: pdfPages, drafts: [{ id: "dr", title: "索引小测", cards: [{ id: "c" }], editorial: {} }] });
  assert.equal(primaries(drafted), 1);
  assert.equal(primaryLabel(drafted), "检查并发布草稿");
});

test("tour anchors mark the hero, today's card and the catalogue", () => {
  for (const html of [render(), render({ decks: [deck], progress, sources: pdfPages, today: { due: 1, weak: 2, new: 0, size: 3 },
    focus: { mode: "class", course: "CS3219", courses: [{ name: "CS3219" }], fresh: [] } })]) {
    for (const id of ["home-hero", "home-today", "home-catalog"]) assert.match(html, new RegExp(`data-tour="${id}"`), id);
  }
});

test("running jobs and pending drafts sit above the desk, naming the deck in plain words", () => {
  const job = { id: "j1", status: "running", stageCode: "authoring", deckTitle: "索引小测", parts: 2, savedCount: 0, requestedTotal: 4,
    stage: "Parallel generation · up to 3 batches",
    steps: [{ id: "s1", stage: "Part 1/2 · Writing and self-checking questions", part: 1, status: "running", runtime: "subagent", childId: "child-1",
      startedAt: "2026-10-01T00:00:00Z" }] };
  const html = render({ sources: pdfPages, jobs: [job], drafts: [{ id: "dr", title: "旧草稿", cards: [{ id: "c" }], editorial: {} }] });
  const jobAt = html.indexOf('class="sh-job '), draftAt = html.indexOf('class="draft-row"'), deskAt = html.indexOf('class="desk');
  assert.ok(jobAt > 0 && jobAt < deskAt, "the job card comes before the desk");
  assert.ok(draftAt > 0 && draftAt < deskAt, "pending drafts come before the desk");
  assert.match(html, /正在生成「索引小测」/);
  assert.match(html, /正在出题/);
  const plain = visibleText(withoutTechDetails(html));
  assert.doesNotMatch(plain, /Writing|Parallel|Part \d|batches/, "no English stage text in the Chinese UI");
  assert.doesNotMatch(plain, /子代理|直接模型调用|本地核验/, "engineering jargon stays in the technical details");
});

test("each active job has exactly one stop control", () => {
  const running = (id) => ({ id, status: "running", stageCode: "authoring", deckTitle: "题组 " + id, steps: [] });
  const html = render({ sources: pdfPages, jobs: [running("a"), running("b")] });
  assert.equal((html.match(/>停止<\/button>/g) || []).length, 2);
  assert.doesNotMatch(html, /停止后台任务，保留草稿/);
});

test("a finished job opens its draft, and a stopped one says what was kept", () => {
  const drafts = [{ id: "dr", title: "索引小测", cards: [{ id: "a" }, { id: "b" }, { id: "c" }], editorial: {} }];
  const done = render({ sources: pdfPages, drafts, jobs: [{ id: "j", status: "complete", stageCode: "done", draftId: "dr", deckTitle: "索引小测",
    savedCount: 3, requestedTotal: 3, steps: [] }] });
  assert.match(done, /<button[^>]*>打开草稿<\/button>/);
  const stoppedWithDraft = render({ sources: pdfPages, drafts, jobs: [{ id: "j", status: "cancelled", stageCode: "cancelled", draftId: "dr",
    deckTitle: "索引小测", savedCount: 3, stage: "Generation cancelled; approved questions were retained", steps: [] }] });
  assert.match(stoppedWithDraft, /已生成的 3 题保存在草稿里/);
  const stopped = render({ sources: pdfPages, jobs: [{ id: "j", status: "cancelled", stageCode: "cancelled", deckTitle: "索引小测",
    stage: "Generation cancelled; approved questions were retained", steps: [] }] });
  assert.match(stopped, /还没有生成题目/);
  for (const html of [stoppedWithDraft, stopped]) assert.doesNotMatch(visibleText(withoutTechDetails(html)), /approved|retained/);
});

test("a failure without a key says so in plain words with a fix, raw details behind a disclosure", () => {
  const raw = 'Study subagent error: llm-deepseek: no API key for provider route "deepseek/deepseek-chat"';
  const html = render({ sources: pdfPages, jobs: [{ id: "j", status: "failed", stageCode: "failed", deckTitle: "索引小测", stage: raw, steps: [] }] });
  assert.match(html, /还没有可用的模型密钥/);
  assert.match(html, /<button[^>]*>(?:<svg.*?<\/svg>)?去配置模型<\/button>/);
  assert.match(html, /<details class="sh-disclosure tech-details"[\s\S]*?技术详情[\s\S]*?no API key[\s\S]*?<\/details>/);
  assert.doesNotMatch(withoutTechDetails(html), /no API key|llm-deepseek/);
});

test("the English home reads in English, job cards included", () => {
  try {
    setUiLanguage("en");
    const html = render({ sources: pdfPages, jobs: [
      { id: "j1", status: "running", stageCode: "reviewing", deckTitle: "Indexes", steps: [] },
      { id: "j2", status: "failed", stageCode: "failed", deckTitle: "Joins", stage: "fetch failed", steps: [] }] });
    const visible = visibleText(withoutTechDetails(html)).replace(/讲义 第 \d 页/g, "");
    assert.doesNotMatch(visible, /[㐀-鿿]/, visible.match(/.{0,30}[㐀-鿿].{0,30}/)?.[0]);
  } finally { setUiLanguage("zh"); }
});
