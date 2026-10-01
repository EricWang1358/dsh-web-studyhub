/* WP5 · welcome page, tour popover, placement and per-library progress.
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
    export { default as Welcome, SampleBanner } from './ui/Welcome.jsx';
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

test("the welcome page offers the sample tour, a first import and — without a model — the model setup", () => {
  ui.setUiLanguage("zh");
  const props = { model: { ready: false, reason: "no-credential" }, sample: { loaded: false }, busy: false,
    onStartSample: noop, onImport: noop, onSetupModel: noop, onLater: noop, onStartTour: noop, onRemoveSample: noop };
  const empty = html(React.createElement(ui.Welcome, props));
  assert.match(empty, /<h1[^>]*>/);
  assert.match(empty, /载入示例并开始导览/);
  assert.match(empty, /导入我的第一份资料/);
  assert.match(empty, /以后再说/);
  assert.match(empty, /sh-setup/, "the model gate is a SetupRequired card");
  assert.match(empty, /AI 模型/);
  assert.doesNotMatch(empty, /JSON/);
  const ready = html(React.createElement(ui.Welcome, { ...props, model: { ready: true, reason: "ok", label: "DeepSeek · chat" } }));
  assert.doesNotMatch(ready, /sh-setup/, "no setup card once a model is ready");
  const loaded = html(React.createElement(ui.Welcome, { ...props, sample: { loaded: true, course: "示例课程 · 设计模式" } }));
  assert.match(loaded, /开始导览/);
  assert.match(loaded, /移除示例数据/);
  assert.match(loaded, /示例课程 · 设计模式/);
  assert.equal((empty.match(/sh-btn--primary/g) || []).length, 1, "one primary action per view");
});

test("the welcome page and sample banner speak English in the English UI", () => {
  ui.setUiLanguage("en");
  const props = { model: { ready: false }, sample: { loaded: false }, onStartSample: noop, onImport: noop, onSetupModel: noop, onLater: noop };
  assert.doesNotMatch(text(html(React.createElement(ui.Welcome, props))), han);
  assert.doesNotMatch(text(html(React.createElement(ui.Welcome, { ...props, sample: { loaded: true, course: "Sample course · Design patterns" } }))), han);
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
  assert.match(last, /导入我的第一份资料/);
  assert.match(last, /移除示例数据/);
  assert.match(last, /完成导览/);
  ui.setUiLanguage("en");
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
