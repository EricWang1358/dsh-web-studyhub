import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { build } from "esbuild";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

const compiled = await build({ entryPoints: ["ui/StudyMap.jsx"], bundle: true,
  write: false, platform: "node", format: "cjs", external: ["react"],
  loader: { ".css": "text" }, logLevel: "silent" });
const module = { exports: {} };
new Function("require", "module", "exports", compiled.outputFiles[0].text)(createRequire(import.meta.url), module, module.exports);
const StudyMap = module.exports.default;

const deck = { id: "d1", title: "行为型模式", folder: "CS3219", course: "CS3219", topics: ["Memento"],
  available: 5, count: 5, quizCount: 3, createdAt: "2026-09-01T00:00:00Z" };
const progress = { d1: { counts: { mastered: 1, familiar: 1, learning: 1, weak: 1, new: 1 }, total: 5,
  mastery: 60, due: 1, status: "active", topics: [] } };
function render(patch = {}) {
  const data = {
    root: "/tmp/lib", decks: [deck], progress, sources: [{ id: "s" }], drafts: [], jobs: [], runs: [],
    today: { due: 1, weak: 2, new: 0, size: 3 },
    focus: { mode: "class", course: "CS3219", courses: [{ name: "CS3219" }], fresh: [] },
    ...patch,
  };
  const noop = () => {};
  return renderToStaticMarkup(React.createElement(StudyMap, {
    data, busy: false, start: noop, resume: noop, endRun: noop, manage: noop, openDraft: noop,
    continueDraft: noop, retryGeneration: noop, addSource: noop, createManual: noop, importLibrary: noop,
    askInChat: noop, notebooks: [], onFocus: noop,
  }));
}
const primaries = (html) => (html.match(/class="primary[^"]*"/g) || []).length;
const count = (html) => html.match(/<div class="today-count"><strong>(\d+)<\/strong><span>([^<]*)<\/span>/)?.slice(1);

test("the home card offers exactly one primary action in every state", () => {
  const states = {
    path: render(),
    resume: render({ runs: [{ id: "r", mode: "path", scope: [], index: 1, total: 4, title: "今日学习" }] }),
    fresh: render({ focus: { mode: "class", course: "CS3219", courses: [{ name: "CS3219" }], fresh: Array(14).fill({}) } }),
    clear: render({ today: { due: 0, weak: 0, new: 0, size: 0 } }),
    empty: render({ decks: [], progress: {}, today: { due: 0, weak: 0, new: 0, size: 0 } }),
  };
  for (const [name, html] of Object.entries(states)) assert.equal(primaries(html), 1, name);
  assert.deepEqual(count(states.path), ["3", "题待学"]);
  assert.match(states.path, /到期 1 · 薄弱 2/);
  assert.deepEqual(count(states.resume), ["3", "题未完成"]);
  assert.match(states.resume, /继续学习/);
  assert.deepEqual(count(states.fresh), ["10", "道新题"]);
  assert.match(states.fresh, /到期复习与巩固 · 3 题/, "the other start stays reachable as a link");
  assert.match(states.clear, /今天已经清空/);
  assert.match(states.clear, /class="primary today-go" disabled/);
  assert.match(states.empty, /导入 JSON 题组/);
  assert.doesNotMatch(states.empty, /today-count/);
});

test("other open runs fold into one line under the desk", () => {
  const html = render({ runs: [
    { id: "a", mode: "path", scope: [{ deckId: "d1" }], index: 2, total: 5, title: "行为型模式" },
    { id: "b", mode: "path", scope: [{ deckId: "d2" }], index: 0, total: 3, title: "软件架构" },
  ] });
  assert.match(html, /<details class="resume-list"><summary>另有 2 组练习未完成<\/summary>/);
});
