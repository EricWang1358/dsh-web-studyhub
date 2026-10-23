/* WP5 · the first screen (the first-run line), tour popover, placement and per-library progress.
   Server-rendered structure and ARIA, plus the pure helpers the runtime uses. */
import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { build } from "esbuild";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

const require = createRequire(import.meta.url);
const han = /[㐀-鿿]/;
const compiled = await build({
  stdin: { contents: `export * from './ui/i18n.js';
    export { SampleBanner } from './ui/Welcome.jsx';
    export { default as FirstRunLine } from './ui/first-run/FirstRunLine.jsx';
    export { firstRunLine } from './ui/first-run/line.js';
    export { TourPopover } from './ui/tour/Tour.jsx';
    export { placePopover } from './ui/tour/geometry.js';
    export { readTourProgress, writeTourProgress, welcomeDismissed, dismissWelcome } from './ui/tour/progress.js';
    export { TOUR_STEPS } from './ui/tour/steps.js';`, resolveDir: process.cwd() },
  bundle: true, write: false, platform: "node", format: "cjs", external: ["react", "react-dom"], loader: { ".css": "text" }, logLevel: "silent",
});
function load() {
  const module = { exports: {} };
  new Function("require", "module", "exports", compiled.outputFiles[0].text)(require, module, module.exports);
  return module.exports;
}
const ui = load();
const html = (element) => renderToStaticMarkup(element);
const noop = () => {};
const text = (markup) => markup.replace(/<[^>]+>/g, " ");

/* The first screen of an empty library is the first-run line (ui/first-run, 3.6 D2): the welcome page's empty branch and its loaded-sample branch are gone. */
const lineOf = (model) => ui.firstRunLine({ root: "/l", model, decks: [], sources: [], drafts: [], jobs: [] });
const firstScreen = (model, sample = { loaded: false }) => html(React.createElement(ui.FirstRunLine, { line: lineOf(model), form: "page", sample,
  on: { recheck: noop, openModelSettings: noop, importFirst: noop, startSample: noop, later: noop } }));

test("the first screen offers a first import, the sample tour as a quiet link and, without a model, the model setup in place", () => {
  ui.setUiLanguage("zh");
  const empty = firstScreen({ ready: false, reason: "no-credential" });
  assert.match(empty, /<h1[^>]*>/);
  assert.match(empty, /载入示例并开始导览/);
  assert.match(empty, /添加资料/);
  assert.match(empty, /以后再说/);
  assert.match(empty, /data-body="model"/, "no model: step 1 is open, with the gate's steps");
  assert.match(empty, /AI 模型/);
  assert.match(empty, /<button[^>]*sh-btn--link[^>]*>(?:(?!<\/button>).)*添加资料/s, "step 2 is never locked: a quiet 添加资料 on its row");
  assert.match(empty, /<button[^>]*sh-btn--link[^>]*>(?:(?!<\/button>).)*载入示例并开始导览/s, "the sample is a link, not the lead");
  assert.ok(empty.indexOf("添加资料") < empty.indexOf("载入示例并开始导览"), "the import comes first");
  assert.doesNotMatch(empty, /JSON/);
  assert.equal((empty.match(/sh-btn--primary/g) || []).length, 1, "one primary action per view");
  const ready = firstScreen({ ready: true, reason: "ok", label: "DeepSeek · chat" });
  assert.doesNotMatch(ready, /data-body="model"/, "no setup once a model is ready: a ticked row");
  const primary = ready.match(/<button[^>]*sh-btn--primary[^>]*>(?:(?!<\/button>).)*<\/button>/s)[0];
  assert.match(primary, /添加资料/, "the one primary action imports the learner's own material");
  const loaded = firstScreen({ ready: true, reason: "ok" }, { loaded: true, course: "示例课程 · 设计模式" });
  assert.doesNotMatch(loaded, /载入示例并开始导览|开始导览/, "a loaded sample is the banner's business (重新开始导览 / 移除示例数据)");
  const banner = html(React.createElement(ui.SampleBanner, { sample: { loaded: true, course: "示例课程 · 设计模式" }, onTour: noop, onRemove: noop }));
  assert.match(banner, /重新开始导览/);
  assert.match(banner, /移除示例数据/);
  assert.match(banner, /示例课程 · 设计模式/);
});

test("the first screen and sample banner speak English in the English UI", () => {
  ui.setUiLanguage("en");
  assert.doesNotMatch(text(firstScreen({ ready: false })), han);
  assert.doesNotMatch(text(firstScreen({ ready: true }, { loaded: true, course: "Sample course · Design patterns" })), han);
  const banner = html(React.createElement(ui.SampleBanner, { sample: { loaded: true, course: "Sample course · Design patterns" }, onTour: noop, onRemove: noop }));
  assert.doesNotMatch(text(banner), han);
  assert.match(banner, /Remove sample data/);
  ui.setUiLanguage("zh");
});

test("the tour popover is a labelled, non-modal dialog with progress and Back / Next / Skip", () => {
  ui.setUiLanguage("zh");
  const step = ui.TOUR_STEPS[3];
  const markup = html(React.createElement(ui.TourPopover, { step, index: 2, total: 17, onNext: noop, onBack: noop, onClose: noop, onSkip: noop }));
  assert.match(markup, /role="dialog"/);
  assert.match(markup, /aria-modal="false"/);
  assert.match(markup, /aria-labelledby="[^"]+"/);
  assert.match(markup, /aria-describedby="[^"]+"/);
  assert.match(markup, /3 \/ 17/);
  assert.match(markup, /上一步/);
  assert.match(markup, /下一步/);
  assert.match(markup, /跳过导览/);
  assert.match(markup, /role="progressbar"/);
  const first = html(React.createElement(ui.TourPopover, { step: ui.TOUR_STEPS[0], index: 0, total: 17, onNext: noop, onBack: noop, onClose: noop, onSkip: noop }));
  assert.doesNotMatch(first, /上一步/, "no Back on the first step");
  const last = html(React.createElement(ui.TourPopover, { step: ui.TOUR_STEPS.at(-1), index: 16, total: 17, onNext: noop, onBack: noop, onClose: noop,
    onSkip: noop, onImport: noop, onRemoveSample: noop }));
  assert.match(last, /添加资料/);
  assert.match(last, /移除示例数据/);
  assert.match(last, /完成导览/);
  // The short tour's last step while the first-run line is up (3.6 D5): on the line's step 2, with the same 添加资料 (which comes back to the line).
  const onLine = html(React.createElement(ui.TourPopover, { step: ui.TOUR_STEPS.find((item) => item.id === "finish-line"), index: 6, total: 7, onNext: noop, onBack: noop,
    onClose: noop, onSkip: noop, onImport: noop, onFullTour: noop, onRemoveSample: noop }));
  assert.match(onLine, /7 \/ 7/);
  assert.match(onLine, /<button[^>]*sh-btn--primary[^>]*>(?:(?!<\/button>).)*添加资料/s);
  assert.match(text(onLine), /这条线的第 2 步/);
  assert.match(text(onLine), /看完整导览/);
  ui.setUiLanguage("en");
  assert.doesNotMatch(text(html(React.createElement(ui.TourPopover, { step: ui.TOUR_STEPS.find((item) => item.id === "finish-line"), index: 6, total: 7, onNext: noop,
    onBack: noop, onClose: noop, onSkip: noop, onImport: noop }))), han);
  const en = html(React.createElement(ui.TourPopover, { step, index: 2, total: 17, onNext: noop, onBack: noop, onClose: noop, onSkip: noop }));
  assert.doesNotMatch(text(en), han);
  ui.setUiLanguage("zh");
});

test("the popover sits beside its target, centres without one and docks at the bottom when narrow", () => {
  const bounds = { width: 1440, height: 900 }, popover = { width: 360, height: 220 };
  const centred = ui.placePopover({ target: null, popover, bounds });
  assert.equal(centred.side, "center");
  assert.equal(Math.round(centred.left), (1440 - 360) / 2);
  const below = ui.placePopover({ target: { left: 600, top: 100, width: 300, height: 80 }, popover, bounds });
  assert.equal(below.side, "bottom");
  assert.ok(below.top >= 180);
  const above = ui.placePopover({ target: { left: 600, top: 700, width: 300, height: 120 }, popover, bounds });
  assert.equal(above.side, "top");
  assert.ok(above.top + 220 <= 700);
  const tall = ui.placePopover({ target: { left: 0, top: 80, width: 220, height: 760 }, popover, bounds });
  assert.equal(tall.side, "right", "a tall sidebar target gets the popover beside it");
  assert.ok(tall.left >= 220);
  for (const placed of [centred, below, above, tall]) {
    assert.ok(placed.left >= 0 && placed.left + 360 <= 1440);
    assert.ok(placed.top >= 0 && placed.top + 220 <= 900);
  }
  const narrow = ui.placePopover({ target: { left: 10, top: 300, width: 380, height: 100 }, popover: { width: 396, height: 260 }, bounds: { width: 420, height: 860 } });
  assert.equal(narrow.side, "dock");
  assert.equal(narrow.docked, true);
});

test("tour progress and the welcome choice are remembered per library, and blocked storage is harmless", () => {
  const store = new Map();
  globalThis.localStorage = { getItem: (key) => store.get(key) ?? null, setItem: (key, value) => store.set(key, String(value)), removeItem: (key) => store.delete(key) };
  try {
    assert.deepEqual(ui.readTourProgress("/a"), null);
    ui.writeTourProgress("/a", { stepId: "exam", done: false });
    assert.deepEqual(ui.readTourProgress("/a"), { stepId: "exam", done: false });
    assert.equal(ui.readTourProgress("/b"), null, "another library has its own progress");
    assert.equal(ui.welcomeDismissed("/a"), false);
    ui.dismissWelcome("/a");
    assert.equal(ui.welcomeDismissed("/a"), true);
    assert.equal(ui.welcomeDismissed("/b"), false);
    globalThis.localStorage = { getItem() { throw new Error("blocked"); }, setItem() { throw new Error("blocked"); }, removeItem() { throw new Error("blocked"); } };
    assert.equal(ui.readTourProgress("/a"), null);
    assert.doesNotThrow(() => ui.writeTourProgress("/a", { stepId: "nav" }));
    assert.equal(ui.welcomeDismissed("/a"), false);
    assert.doesNotThrow(() => ui.dismissWelcome("/a"));
  } finally {
    delete globalThis.localStorage;
  }
});
