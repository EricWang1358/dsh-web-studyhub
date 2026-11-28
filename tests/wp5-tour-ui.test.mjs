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
    export { default as Tour, TourPopover } from './ui/tour/Tour.jsx';
    export { placePopover, spotlightBox, driftedOut } from './ui/tour/geometry.js';
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

test("the card's header says the chapter, and only the full tour offers 跳到下一章, never on the last chapter", () => {
  ui.setUiLanguage("zh");
  const steps = ui.TOUR_STEPS.filter((item) => item.only !== "core");
  const render = (id, extra = {}) => html(React.createElement(ui.Tour, { steps, stepId: id, rootRef: { current: null }, sampleLoaded: true,
    onEnter: noop, onMove: noop, onClose: noop, onFinish: noop, ...extra }));
  const dashboard = render("dashboard", { onJump: noop });
  assert.match(text(dashboard), /功能导览 · 复习/);
  assert.match(dashboard, /<button[^>]*type="button"(?:(?!<\/button>).)*跳到下一章/s, "a real button: Tab reaches it and Enter presses it");
  assert.doesNotMatch(dashboard.match(/<button(?:(?!<\/button>).)*跳到下一章/s)[0], /sh-btn--primary/, "quiet: 下一步 stays the one filled button");
  assert.match(text(render("welcome", { onJump: noop })), /跳到下一章/);
  assert.doesNotMatch(text(render("welcome", { onJump: noop, sampleLoaded: false })), /跳到下一章/, "the sample is chosen first");
  assert.doesNotMatch(text(render("skeleton", { onJump: noop })), /跳到下一章/, "更多 is the last chapter");
  assert.doesNotMatch(text(render("finish", { onJump: noop })), /跳到下一章/);
  assert.doesNotMatch(text(render("dashboard")), /跳到下一章/, "the short tour has no chapter jump");
  ui.setUiLanguage("en");
  const english = text(render("dashboard", { onJump: noop }));
  assert.match(english, /Feature tour · Review/);
  assert.match(english, /Next chapter/);
  assert.doesNotMatch(english, han);
  assert.match(text(render("settings-model", { onJump: noop })), /Feature tour · Setup/);
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

/* #1712: the card keeps off what introduces the page (its title, and for a step that came from the sidebar its first block) and never lies on the lit area. */
const meet = (a, b) => Math.min(a.left + a.width, b.left + b.width) - Math.max(a.left, b.left) > 0 && Math.min(a.top + a.height, b.top + b.height) - Math.max(a.top, b.top) > 0;
const cardOf = (placed, popover) => ({ left: placed.left, top: placed.top, width: popover.width, height: popover.height });
const inside = (placed, popover, bounds) => placed.left >= 0 && placed.top >= 0 && placed.left + popover.width <= bounds.width && placed.top + popover.height <= bounds.height;

test("#1712: with the sidebar put away the card beside the menu button keeps off the page's title and first block", () => {
  const bounds = { width: 2000, height: 1088 }, popover = { width: 380, height: 256 };
  // Measured on 学习笔记 with the sidebar put away: the card used to take 76–456 × 16–272 px, on the title, the course picker and 今日学习总结.
  const menu = { left: 6, top: 6, width: 44, height: 44 };
  const title = { left: 92, top: 96, width: 120, height: 36 }, block = { left: 92, top: 220, width: 900, height: 240 };
  const placed = ui.placePopover({ target: menu, popover, bounds, prefer: "right", avoid: [title, block] });
  const card = cardOf(placed, popover);
  for (const [name, box] of [["title", title], ["first block", block], ["menu button", menu]]) assert.ok(!meet(card, box), `${name}: ${JSON.stringify(card)}`);
  assert.ok(inside(placed, popover, bounds), JSON.stringify(placed));
});

test("#1712: the card keeps off both when the in-page heading is lit, and keeps its preferred side when that side is already clear", () => {
  const bounds = { width: 1440, height: 900 }, popover = { width: 380, height: 260 };
  const header = { left: 170, top: 80, width: 1100, height: 110 }, title = { left: 170, top: 80, width: 90, height: 36 };
  const block = { left: 170, top: 214, width: 1100, height: 220 };
  const placed = ui.placePopover({ target: header, popover, bounds, prefer: "right", avoid: [title, block] });
  const card = cardOf(placed, popover);
  for (const box of [header, title, block]) assert.ok(!meet(card, box), JSON.stringify(card));
  assert.ok(inside(placed, popover, bounds));
  // The sidebar's entry, low on the left: beside it is clear of the page's top, so nothing changes.
  const entry = { left: 8, top: 640, width: 200, height: 36 };
  assert.deepEqual(ui.placePopover({ target: entry, popover, bounds, prefer: "right", avoid: [title, block] }),
    ui.placePopover({ target: entry, popover, bounds, prefer: "right" }));
});

test("#1712: when the first block fills the page the title still stays clear", () => {
  const bounds = { width: 1440, height: 900 }, popover = { width: 380, height: 280 };
  const menu = { left: 6, top: 6, width: 44, height: 44 }, title = { left: 80, top: 70, width: 120, height: 36 };
  const block = { left: 0, top: 120, width: 1440, height: 900 };
  const placed = ui.placePopover({ target: menu, popover, bounds, prefer: "right", avoid: [title, block] });
  const card = cardOf(placed, popover);
  assert.ok(!meet(card, title) && !meet(card, menu), JSON.stringify(card));
  assert.ok(inside(placed, popover, bounds));
});

test("a target too tall for any side is lit only above the card: the card never lies on the lit area", () => {
  const popover = { width: 380, height: 260 };
  const wide = ui.placePopover({ target: { left: 200, top: 90, width: 1040, height: 1400 }, popover, bounds: { width: 1440, height: 900 } });
  assert.ok(wide.spot, "the placement says what is lit");
  assert.ok(!meet(cardOf(wide, popover), wide.spot), JSON.stringify(wide));
  assert.equal(wide.spot.top, 90, "the target's top stays where it is");
  assert.ok(wide.spot.height >= 160, "enough of the target stays lit to be recognised");
  const phone = { width: 420, height: 860 }, sheet = { width: 396, height: 380 };
  const docked = ui.placePopover({ target: { left: 10, top: 96, width: 400, height: 700 }, popover: sheet, bounds: phone });
  assert.equal(docked.docked, true);
  assert.ok(!meet(cardOf(docked, sheet), docked.spot) && docked.spot.top === 96, JSON.stringify(docked));
  // A short target well above the sheet is lit whole.
  assert.deepEqual(ui.placePopover({ target: { left: 10, top: 100, width: 400, height: 80 }, popover: sheet, bounds: phone }).spot, undefined);
});

test("above a bar pinned to the bottom of a narrow panel: the sheet sits on top of it, not over it and not over the page's title", () => {
  const phone = { width: 420, height: 860 }, sheet = { width: 396, height: 380 }, bar = { left: 10, top: 780, width: 400, height: 70 };
  const placed = ui.placePopover({ target: bar, popover: sheet, bounds: phone, pinned: true });
  assert.equal(placed.docked, true);
  assert.equal(placed.side, "dock-lifted");
  assert.equal(placed.top, 780 - 8 - 380, "just above the bar, so the top of the page stays in sight");
  assert.ok(!meet(cardOf(placed, sheet), bar));
  // A target that can still be scrolled above the sheet keeps it at the bottom (the tour scrolls the page, and the sheet does not jump about).
  assert.equal(ui.placePopover({ target: bar, popover: sheet, bounds: phone }).top, 860 - 380 - 12);
});

test("a target that late content pushed out of view is scrolled to again; one the view cuts only at the bottom is left alone", () => {
  const bounds = { width: 1440, height: 900 };
  const at = (top, height) => ui.driftedOut({ left: 100, top, width: 600, height }, bounds);
  assert.equal(at(1400, 400), true, "below the view");
  assert.equal(at(-700, 400), true, "above it");
  assert.equal(at(860, 400), true, "only a sliver left at the bottom");
  assert.equal(at(-60, 300), true, "its top is cut off although it would fit");
  assert.equal(at(100, 400), false);
  assert.equal(at(300, 1600), false, "a tall target with its top in view stays where it is");
  assert.equal(at(-200, 2000), false, "a target taller than the view fills it");
  assert.equal(at(870, 24), false, "a short bar at the foot is all there");
});

/* 界面大小 150% on 1440 × 900 leaves the layer 960 × 600 of its own pixels: the measurements below are the walk's. */
test("a target with no room around it is reported as crowded, so the tour first scrolls it to the top; there it fits", () => {
  const bounds = { width: 960, height: 600 }, popover = { width: 380, height: 330 };
  const row = { left: 230, top: 185, width: 702, height: 76 };
  assert.equal(ui.placePopover({ target: row, popover, bounds }).crowded, true, "below needs 360 px, above too");
  const raised = ui.placePopover({ target: { ...row, top: 64 }, popover, bounds });
  assert.equal(raised.crowded, undefined);
  assert.ok(!meet(cardOf(raised, popover), { ...row, top: 64 }), JSON.stringify(raised));
  // A whole section at the top is lit down to the card, even where little of it fits.
  const section = { left: 230, top: 64, width: 702, height: 820 };
  const cut = ui.placePopover({ target: section, popover: { width: 380, height: 360 }, bounds });
  assert.equal(cut.crowded, undefined);
  assert.ok(cut.spot && cut.spot.height >= 96 && !meet(cardOf(cut, { width: 380, height: 360 }), cut.spot), JSON.stringify(cut));
});

test("a centred card moves under the page's title when it would lie on it", () => {
  const bounds = { width: 960, height: 600 }, popover = { width: 380, height: 330 };
  const title = { left: 300, top: 120, width: 260, height: 36 };
  const placed = ui.placePopover({ target: null, popover, bounds, avoid: [title] });
  assert.equal(placed.side, "center");
  assert.ok(!meet(cardOf(placed, popover), title) && inside(placed, popover, bounds), JSON.stringify(placed));
  assert.equal(placed.left, ui.placePopover({ target: null, popover, bounds }).left);
  // No room under it: it stays in the middle.
  assert.deepEqual(ui.placePopover({ target: null, popover: { width: 380, height: 560 }, bounds, avoid: [title] }), ui.placePopover({ target: null, popover: { width: 380, height: 560 }, bounds }));
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
