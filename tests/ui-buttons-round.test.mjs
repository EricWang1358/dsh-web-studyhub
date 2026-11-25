import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { build } from "esbuild";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

// UI score round 2026-11-17, lane B (#1074 #1075 #1076 #1077): one look for 添加资料, a standard-size 下一题,
// a quiet button that does not read as a heading, a primary button with no resting accent glow.
const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const compiled = await build({
  stdin: { contents: "export * from './ui/components/index.js'; export { default as ReviewToolbar } from './ui/ReviewToolbar.jsx'; export { StudyServicesContext } from './ui/study-context.jsx'; export { setUiLanguage } from './ui/i18n.js';", resolveDir: process.cwd() },
  bundle: true, write: false, platform: "node", format: "cjs", external: ["react", "react-dom"], loader: { ".css": "text" }, logLevel: "silent" });
const module = { exports: {} };
new Function("require", "module", "exports", compiled.outputFiles[0].text)(createRequire(import.meta.url), module, module.exports);
const { AddSourceButton, addSourceAction, ReviewToolbar, StudyServicesContext, setUiLanguage } = module.exports;
const han = /[㐀-鿿]/;
const h = React.createElement;

const rule = (css, selector) => {
  const start = css.indexOf(`${selector} {`);
  assert.ok(start >= 0, `${selector} has a rule`);
  return css.slice(start, css.indexOf("}", start));
};

test("#1077: a primary button rests on its inner sheen only; hover lifts it with a neutral contact shadow, never an accent glow", () => {
  const css = read("ui/components/components.css");
  const resting = rule(css, ".sh-btn--primary");
  const hover = rule(css, '.sh-btn--primary:hover:not(:disabled):not([aria-disabled="true"])');
  assert.doesNotMatch(resting, /accent-glow/, "no resting glow");
  assert.doesNotMatch(hover, /accent-glow/, "no hover glow");
  assert.match(resting, /inset 0 1px 0 var\(--sheen\)/, "the sheen stays");
  assert.match(hover, /translateY\(-1px\)/);
  assert.match(hover, /var\(--shadow-contact\)/, "a neutral contact shadow");
  assert.match(hover, /inset 0 1px 0 var\(--sheen-strong\)/);
});

test("#1076: a quiet button is regular weight (the Han fallback fonts draw --fw-medium as bold), keeps a hover surface", () => {
  const css = read("ui/components/components.css");
  const quiet = rule(css, ".sh-btn--quiet");
  assert.match(quiet, /font-weight:\s*var\(--fw-regular\)/);
  assert.match(rule(css, '.sh-btn--quiet:hover:not(:disabled):not([aria-disabled="true"])'), /background:\s*var\(--bg-hover\)/);
  assert.doesNotMatch(read("ui/review/question.css").match(/\.question-toolbar \.tool-action[^{]*\{[^}]*\}/g)?.join("") ?? "", /font-weight/, "the toolbar does not set its own weight");
});

test("#1074: AddSourceButton is the upload icon and 添加资料, only the variant changes", () => {
  setUiLanguage("zh");
  for (const variant of ["primary", "secondary", "quiet", "link"]) {
    const out = renderToStaticMarkup(h(AddSourceButton, { variant }));
    assert.match(out, new RegExp(`sh-btn--${variant}`));
    assert.match(out, /<svg/, "an icon");
    assert.match(out, /添加资料/);
  }
  const upload = renderToStaticMarkup(h(module.exports.Icon, { name: "upload", size: 18 }));
  assert.ok(renderToStaticMarkup(h(AddSourceButton, { variant: "primary" })).includes(upload.match(/<path[^>]*d="([^"]+)"/)[1]), "the upload glyph, not a plus");
  assert.match(renderToStaticMarkup(h(AddSourceButton, { variant: "bold" })), /sh-btn--secondary/, "an unknown variant falls back to secondary");
  assert.match(renderToStaticMarkup(h(AddSourceButton, { variant: "primary", "data-tour": "sources-add" })), /data-tour="sources-add"/, "props pass through");
  assert.deepEqual(Object.keys(addSourceAction(() => {})).sort(), ["icon", "label", "onClick"]);
  assert.equal(addSourceAction(() => {}).icon, "upload");
  setUiLanguage("en");
  try { assert.doesNotMatch(renderToStaticMarkup(h(AddSourceButton, { variant: "quiet" })), han); } finally { setUiLanguage("zh"); }
});

// No place may draw 添加资料 by hand: the first-run page's MaterialBody was the last, and uses <AddSourceButton variant> since #1094 landed.
const HAND_DRAWN_ALLOWED = [];
const walk = (dir) => readdirSync(new URL(`../${dir}`, import.meta.url), { withFileTypes: true }).flatMap((entry) =>
  entry.isDirectory() ? (entry.name === "locales" ? [] : walk(`${dir}/${entry.name}`)) : /\.(jsx?|mjs)$/.test(entry.name) ? [`${dir}/${entry.name}`] : []);

test("#1074: 添加资料 is never drawn by hand anywhere in ui/ (a Button label or an action label outside AddSourceButton)", () => {
  const offenders = [];
  for (const file of walk("ui")) {
    if (file === "ui/components/AddSourceButton.jsx") continue;
    read(file).split(/\r?\n/).forEach((line, index) => {
      const asButton = /<(?:Button|IconButton)\b[^>]*>\s*\{ui\(["']添加资料["']\)\}/.test(line);
      // An action or menu item that names 添加资料 must take the icon from the same place.
      const asAction = /label:\s*ui\(["']添加资料["']\)(?!,\s*icon:\s*ADD_SOURCE_ICON)/.test(line);
      if (!asButton && !asAction) return;
      if (HAND_DRAWN_ALLOWED.some((entry) => entry.file === file && line.includes(entry.marker))) return;
      offenders.push(`${file}:${index + 1} ${line.trim().slice(0, 110)}`);
    });
  }
  assert.deepEqual(offenders, [], "use <AddSourceButton variant> or addSourceAction(onClick)");
  for (const file of ["ui/Sources.jsx", "ui/Generate.jsx", "ui/DailyPlan.jsx", "ui/EmptyStudyActions.jsx", "ui/exam-prep/ExamPrepCreate.jsx", "ui/SourcePicker.jsx", "ui/tour/Tour.jsx", "ui/first-run/FirstRunLine.jsx"])
    assert.match(read(file), /AddSourceButton|addSourceAction/, `${file} uses the shared 添加资料`);
  assert.match(read("ui/study-map/CatalogHeading.jsx"), /ADD_SOURCE_ICON/, "the catalogue menu item takes the shared icon");
});

test("#1074: 'add another material' is AddSourceButton's `more` (or addSourceAction's), never drawn by hand: no ui('再添加资料') or ui('再加一份') outside the shared 添加资料 files", () => {
  const offenders = [];
  for (const file of walk("ui")) {
    if (file === "ui/components/AddSourceButton.jsx" || file === "ui/components/add-source.js") continue;
    for (const label of ["再添加资料", "再加一份"]) if (read(file).includes(`ui("${label}")`) || read(file).includes(`ui('${label}')`)) offenders.push(`${file}: ${label}`);
  }
  assert.deepEqual(offenders, [], "use <AddSourceButton more variant> or addSourceAction(onClick, { more: true })");
  assert.match(read("ui/first-run/FirstRunLine.jsx"), /<AddSourceButton more /);
  assert.match(read("ui/study-map/DeskIntro.jsx"), /<AddSourceButton key=\{entry\.label\} more /);
});

test("#1074: the compact first-run card offers 添加资料 as the shared upload-icon action, not a full-width arrow button", () => {
  const source = read("ui/first-run/FirstRunLine.jsx");
  assert.match(source, /icon=\{action\.icon\}/, "the compact button draws the action's own icon");
  assert.match(source, /iconEnd=\{action\.icon \? undefined : ["']arrow-right["']\}/, "and the arrow only when the action has no icon of its own");
  // The same plan / step actions elsewhere: the home's today card (home-plan.js) and the setup checklist's step button.
  assert.match(read("ui/study-map/TodayCard.jsx"), /icon=\{plan\.action\.icon\} iconEnd=\{plan\.action\.icon \? undefined/);
  assert.match(read("ui/study-map/home-plan.js"), /addSourceAction\(addSource\)/);
  assert.match(read("ui/SetupChecklist.jsx"), /icon: ADD_SOURCE_ICON/);
  assert.match(read("ui/SetupChecklist.jsx"), /icon=\{action\.icon\}/);
});

test("#1075: 下一题 / 完成 is a standard-size primary with the arrow as an icon; 上一题 is standard size too", () => {
  setUiLanguage("zh");
  const render = (run) => renderToStaticMarkup(h(StudyServicesContext.Provider, { value: { busy: false } }, h(ReviewToolbar, {
    run: { id: "r", index: 1, total: 3, mode: "path", card: { id: "q", kind: "quiz", topic: "T", prompt: "P?", options: [] }, feedback: { correct: true }, ...run },
    onToggleHelp() {}, onAsk() {}, onImprove() {}, onSlay() {}, onNote() {}, onReviewAction() {} })));
  const button = (html, usage) => html.match(new RegExp(`<button[^>]*data-usage="${usage}"[^>]*>.*?</button>`))?.[0] ?? "";
  const html = render({});
  const next = button(html, "review.next"), prev = button(html, "review.prev");
  assert.match(next, /sh-btn--primary/); assert.match(next, /sh-btn--md/); assert.doesNotMatch(next, /sh-btn--sm/);
  assert.doesNotMatch(next, /→/, "the arrow is an icon, not a typed glyph");
  assert.match(next, /下一题<svg/, "the arrow icon follows the label (iconEnd)");
  assert.match(prev, /sh-btn--md/); assert.doesNotMatch(prev, /sh-btn--sm/);
  assert.match(button(render({ index: 2 }), "review.next"), /完成<svg/);
  const withBar = renderToStaticMarkup(h(StudyServicesContext.Provider, { value: { busy: false } }, h(ReviewToolbar, {
    run: { id: "r", index: 0, total: 3, mode: "path", card: { id: "q", kind: "quiz", topic: "T", prompt: "P?", options: [] }, feedback: { correct: true } },
    autoAdvanceActive: true, autoAdvanceMs: 1500, onToggleHelp() {}, onAsk() {}, onImprove() {}, onSlay() {}, onNote() {}, onReviewAction() {} })));
  assert.match(button(withBar, "review.next"), /next-question__bar/, "the autopilot bar still sits inside the next button");
});

test("#1076: 帮我弄懂, 修题 and 提示 carry an icon so they read as tools", () => {
  setUiLanguage("zh");
  const html = renderToStaticMarkup(h(StudyServicesContext.Provider, { value: { busy: false } }, h(ReviewToolbar, {
    run: { id: "r", index: 0, total: 3, mode: "path", card: { id: "q", kind: "quiz", topic: "T", prompt: "P?", options: [] }, feedback: null },
    onToggleHelp() {}, onAsk() {}, onImprove() {}, onSlay() {}, onNote() {}, onReviewAction() {} })));
  for (const usage of ["review.help", "review.improve"]) {
    const button = html.match(new RegExp(`<button[^>]*data-usage="${usage}"[^>]*>.*?</button>`))?.[0] ?? "";
    assert.match(button, /<svg/, `${usage} has an icon`);
    assert.match(button, /sh-btn--quiet/);
  }
  assert.match(html.match(/<button[^>]*data-tour="review-hint"[^>]*>.*?<\/button>/)?.[0] ?? "", /<svg/, "提示 has an icon");
});

test("#1076: the toolbar does not re-skin .sh-btn (size, border, colour come from Button)", () => {
  const css = read("ui/review/question.css");
  assert.doesNotMatch(css, /\.question-toolbar \.tool-action(,|:hover|\s*\{)/, "no rule re-skins the quiet tool buttons (only the .tool-icon thumbs are raw buttons; the open state of one is the only .tool-action rule)");
  assert.doesNotMatch(css, /min-height:\s*38px/, "no 38px control height next to the 40px buttons");
});

test("#1076: a quiet button is ink, not --text-dim: at regular weight a grey word reads as a caption, not a control", () => {
  const quiet = rule(read("ui/components/components.css"), ".sh-btn--quiet");
  assert.match(quiet, /color:\s*var\(--text\)/);
  assert.doesNotMatch(quiet, /--text-dim/);
});

test("#1075: every disabled button, secondary or primary, has the one neutral look (no border, faint ink, a flat fill)", () => {
  const css = read("ui/components/components.css");
  for (const selector of [".sh-btn:disabled", '.sh-btn[aria-disabled="true"]']) {
    const disabled = rule(css, selector);
    assert.match(disabled, /border-color:\s*transparent/);
    assert.match(disabled, /color:\s*var\(--text-faint\)/);
    assert.match(disabled, /background:\s*color-mix\(in srgb, var\(--text\) 7%/);
  }
});

test("#1075: at a narrow width the practice bar is two deliberate rows: the tools, then 更多 with 上一题 / 下一题 sharing the full row", () => {
  const css = read("ui/review/question.css");
  const at = css.indexOf("/* The practice bar at a narrow width");
  assert.ok(at >= 0, "a narrow rule for the toolbar exists");
  const narrow = css.slice(at, at + 1500);
  assert.match(narrow, /\.question-navigation\s*\{[^}]*flex-wrap:\s*nowrap[^}]*width:\s*100%/, "the navigation row is one full-width line");
  assert.match(narrow, /\[data-usage="review\.next"\]\s*\{[^}]*flex:\s*1 1 0/, "上一题 and 下一题 share what 更多 leaves");
});

test("#1077: the primary hover is the accent darkened, so its ink keeps 4.5:1 on all five presets in both themes (--accent-soft is light on dark)", () => {
  const hover = rule(read("ui/components/components.css"), '.sh-btn--primary:hover:not(:disabled):not([aria-disabled="true"])');
  assert.doesNotMatch(hover, /--accent-soft/);
  assert.match(hover, /background:\s*color-mix\(in srgb, var\(--accent\), black (\d+)%\)/);
  const dark = Number(/black (\d+)%/.exec(hover)[1]) / 100;
  const tokens = read("ui/tokens.css"), accent = read("ui/accent.css");
  const hex = (text) => [0, 2, 4].map((at) => parseInt(text.slice(1 + at, 3 + at), 16) / 255);
  const lum = (rgb) => { const [r, g, b] = rgb.map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
  const ratio = (a, b) => { const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x); return (hi + 0.05) / (lo + 0.05); };
  const first = (css, name, from = 0) => new RegExp(`${name}:\\s*(#[0-9a-f]{6})`).exec(css.slice(from))[1];
  const lightAt = tokens.indexOf('.study-app[data-theme="light"]');
  const cases = [["cinnabar dark", first(tokens, "--accent"), first(tokens, "--accent-ink")],
    ["cinnabar light", first(tokens, "--accent", lightAt), first(tokens, "--accent-ink", lightAt)]];
  for (const preset of ["jade", "ochre", "graphite", "plum"]) {
    const lines = accent.slice(accent.indexOf(`data-accent=${preset}]`)).split("\n").slice(1, 3);
    cases.push([`${preset} dark`, /--accent:\s*(#[0-9a-f]{6})/.exec(lines[0])[1], first(tokens, "--accent-ink")]);
    cases.push([`${preset} light`, /--accent:\s*(#[0-9a-f]{6})/.exec(lines[1])[1], first(tokens, "--accent-ink", lightAt)]);
  }
  assert.equal(cases.length, 10);
  for (const [name, fill, ink] of cases) {
    const hovered = hex(fill).map((v) => v * (1 - dark));
    assert.ok(ratio(hovered, hex(ink)) >= 4.5, `${name}: hover ${ratio(hovered, hex(ink)).toFixed(2)}:1`);
  }
});
