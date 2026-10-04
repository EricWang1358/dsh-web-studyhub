import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { build } from "esbuild";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { mapProps } from './helpers/study-map-props.mjs';

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
  return renderToStaticMarkup(React.createElement(StudyMap, mapProps({
    data, busy: false, start: noop, resume: noop, endRun: noop, manage: noop, openDraft: noop,
    continueDraft: noop, retryGeneration: noop, addSource: noop, createManual: noop, importLibrary: noop,
    askInChat: noop, notebooks: [], onFocus: noop,
  })));
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
  assert.match(states.path, /1 题到期 · 2 题薄弱/);
  assert.deepEqual(count(states.resume), ["3", "题未完成"]);
  assert.match(states.resume, /继续学习/);
  assert.deepEqual(count(states.fresh), ["10", "道新题"]);
  assert.match(states.fresh, /到期复习与巩固 · 3 题/, "the other start stays reachable as a link");
  assert.match(states.clear, /今天已经清空/);
  assert.match(states.clear, /class="primary today-go" disabled/);
  assert.match(states.empty, /导入 JSON 题组/);
  assert.doesNotMatch(states.empty, /today-count/);
});

test("the run the learner was last inside takes the card, and a new start stays one click away", () => {
  const runs = [
    { id: "deck-run", mode: "quiz", scope: [{ deckId: "d1" }], index: 4, total: 10, title: "行为型模式" },
    { id: "other", mode: "path", scope: [{ deckId: "d2" }], index: 0, total: 3, title: "软件架构" },
  ];
  const html = render({ runs, lastRun: { id: "deck-run", index: 4, total: 10, title: "行为型模式" } });
  assert.equal(primaries(html), 1);
  assert.deepEqual(count(html), ["6", "题未完成"]);
  assert.match(html, /行为型模式 · 已做到第 5 \/ 10 题/);
  assert.match(html, /接着做<span aria-hidden="true">→<\/span>/);
  assert.match(html, /到期复习与巩固 · 3 题/, "what the card would have started becomes a link");
  assert.match(html, /<summary>另有 1 组练习未完成<\/summary>/, "the card's run is not listed again in the fold");
});

test("a half-done run from another course still takes the card, and says which course", () => {
  const redis = { ...deck, id: "d2", title: "Redis 与缓存", folder: "", course: "后端面试八股" };
  const runs = [
    { id: "redis-run", mode: "quiz", deckIds: ["d2"], scope: [{ deckId: "d2" }], index: 2, total: 10, title: "Redis 与缓存" },
    { id: "here", mode: "quiz", deckIds: ["d1"], scope: [{ deckId: "d1" }], index: 0, total: 5, title: "行为型模式" },
  ];
  const html = render({ decks: [deck, redis], progress: { ...progress, d2: progress.d1 }, runs,
    lastRun: { id: "redis-run", index: 2, total: 10, title: "Redis 与缓存" } });
  assert.match(html, /后端面试八股 › Redis 与缓存 · 已做到第 3 \/ 10 题/);
  assert.match(html, /<span class="eyebrow">继续上次学习<\/span><strong>行为型模式<\/strong>/,
    "a run inside the heading's course needs no label");
});

test("other open runs fold into one line under the desk", () => {
  const html = render({ runs: [
    { id: "a", mode: "path", scope: [{ deckId: "d1" }], index: 2, total: 5, title: "行为型模式" },
    { id: "b", mode: "path", scope: [{ deckId: "d2" }], index: 0, total: 3, title: "软件架构" },
  ] });
  assert.match(html, /<details class="resume-list"><summary>另有 2 组练习未完成<\/summary>/);
});

test("show-all lives inside an open course, and a lone course can never be stuck closed", () => {
  const five = Array.from({ length: 5 }, (_, i) => ({ ...deck, id: "d" + i, title: "题组 " + i,
    createdAt: `2026-09-0${i + 1}T00:00:00Z` }));
  const patch = { decks: five, progress: Object.fromEntries(five.map((d) => [d.id, progress.d1])) };
  const open = render(patch);
  assert.equal((open.match(/class="map-deck/g) || []).length, 3, "the current course shows its three newest decks");
  assert.match(open, /<ul class="map-children">(?:(?!<\/ul>).)*<li class="map-more"><button class="show-other-courses" aria-expanded="false">查看全部题组 · 5/s);
  // A saved "collapsed" state used to hide the decks behind a header that is not shown.
  globalThis.localStorage = { getItem: () => "[]", setItem() {} };
  try {
    const closed = render(patch);
    assert.equal((closed.match(/class="map-deck/g) || []).length, 3);
    assert.match(closed, /class="map-tree single-course"/);
    assert.equal((closed.match(/查看全部题组/g) || []).length, 1);
  } finally {
    delete globalThis.localStorage;
  }
});

test("finished job cards can be acknowledged and removed, running ones cannot", () => {
  const noop = () => {};
  const job = (id, status) => ({ id, status, type: "generate", stage: "", parts: 1, trace: [] });
  const html = (jobs) => renderToStaticMarkup(React.createElement(StudyMap, mapProps({
    data: { root: "/tmp/lib", decks: [deck], progress, sources: [{ id: "s" }], drafts: [], jobs, runs: [],
      today: { due: 0, weak: 0, new: 0, size: 0 }, focus: { mode: "class", course: "CS3219", courses: [{ name: "CS3219" }], fresh: [] } },
    busy: false, start: noop, resume: noop, endRun: noop, manage: noop, openDraft: noop, continueDraft: noop,
    retryGeneration: noop, addSource: noop, createManual: noop, importLibrary: noop, askInChat: noop,
    notebooks: [], onFocus: noop, cancelJob: noop, dismissJob: noop,
  })));
  const mixed = html([job("a", "failed"), job("b", "running")]);
  assert.equal((mixed.match(/class="[^"]*sh-job__dismiss[^"]*"/g) || []).length, 1, "only the finished job offers 知道了");
  assert.doesNotMatch(mixed, /全部知道了/, "one finished card needs no bulk action");
  const done = html([job("a", "failed"), job("b", "partial"), job("c", "complete")]);
  assert.equal((done.match(/class="[^"]*sh-job__dismiss[^"]*"/g) || []).length, 3);
  assert.match(done, /全部知道了/);
});

test("a finished generation with missing questions remains visibly incomplete", () => {
  const html = render({ jobs: [{ id: 'partial', status: 'complete',
    savedCount: 9, requestedTotal: 12, parts: 4,
    stage: 'Draft ready with 9/12 questions; 2 part(s) failed' }] });
  assert.match(html, /草稿待补齐 · 9\/12 题/);
  assert.doesNotMatch(html, /草稿已生成|Draft ready with/);
  assert.match(html, /sh-job--partial/);
});
