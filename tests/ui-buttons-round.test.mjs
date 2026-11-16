import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
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
  const hover = rule(css, ".sh-btn--primary:hover:not(:disabled)");
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
  assert.match(rule(css, ".sh-btn--quiet:hover:not(:disabled)"), /background:\s*var\(--bg-hover\)/);
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

test("#1074: the call sites of 添加资料 use the shared piece, none draws its own button", () => {
  const sites = ["ui/Sources.jsx", "ui/Generate.jsx", "ui/DailyPlan.jsx", "ui/EmptyStudyActions.jsx", "ui/exam-prep/ExamPrepCreate.jsx"];
  for (const file of sites) {
    const source = read(file);
    assert.match(source, /AddSourceButton|addSourceAction/, `${file} uses the shared 添加资料`);
    assert.doesNotMatch(source, /<Button[^>]*>\s*\{ui\(["']添加资料["']\)\}\s*<\/Button>/, `${file} draws no hand-made 添加资料 button`);
    assert.doesNotMatch(source, /label:\s*ui\(["']添加资料["']\)/, `${file} builds no hand-made 添加资料 action`);
  }
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
