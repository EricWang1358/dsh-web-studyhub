import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { build } from "esbuild";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

const compiled = await build({
  stdin: { contents: "export { default as ReviewToolbar } from './ui/ReviewToolbar.jsx'; export { setUiLanguage } from './ui/i18n.js';", resolveDir: process.cwd() },
  bundle: true, write: false, platform: "node", format: "cjs", external: ["react"], loader: { ".css": "text" }, logLevel: "silent" });
const module = { exports: {} };
new Function("require", "module", "exports", compiled.outputFiles[0].text)(createRequire(import.meta.url), module, module.exports);
const { ReviewToolbar, setUiLanguage } = module.exports;
const han = /[㐀-鿿]/;

const baseRun = { id: "r", index: 0, total: 2, mode: "path", card: { id: "q", kind: "quiz", topic: "T", prompt: "P?", options: [] } };
const render = (run, props = {}) => renderToStaticMarkup(React.createElement(ReviewToolbar, {
  run: { ...baseRun, ...run }, busy: false, onToggleHelp() {}, onAsk() {}, onImprove() {}, onSlay() {}, onNote() {}, onReviewAction() {}, ...props }));
const nextButton = (html) => html.match(/<button[^>]*data-usage="review.next"[^>]*>/)?.[0] || "";

test("an unanswered question says why 下一题 is unavailable, in words next to the button", () => {
  setUiLanguage("zh");
  const html = render({ feedback: null });
  assert.match(nextButton(html), /disabled=""/);
  assert.match(html, /请先作答，才能进入下一题/);
  assert.match(nextButton(html), /aria-describedby="review-next-hint"/);
  assert.match(html, /id="review-next-hint"/);
});

test("an answered question has an enabled 下一题 and no hint", () => {
  setUiLanguage("zh");
  const html = render({ feedback: { correct: true, nextDue: "2026-10-03T00:00:00Z" } });
  assert.doesNotMatch(nextButton(html), /disabled/);
  assert.doesNotMatch(html, /请先作答|review-next-hint/);
});

test("while a step is saving the disabled button names the reason instead of staying silent", () => {
  setUiLanguage("zh");
  const html = render({ feedback: { correct: true } }, { busy: true });
  assert.match(nextButton(html), /disabled=""/);
  assert.match(nextButton(html), /title="正在保存上一步，稍等一下"/);
  assert.doesNotMatch(html, /请先作答/, "the answer is in; only the save is pending");
});

test("a mock exam may move on without an answer and shows no hint", () => {
  setUiLanguage("zh");
  const html = render({ mode: "exam", feedback: null });
  assert.doesNotMatch(nextButton(html), /disabled/);
  assert.doesNotMatch(html, /请先作答/);
});

test("the hint and busy reason are English in the English UI", () => {
  setUiLanguage("en");
  try {
    const hint = render({ feedback: null });
    assert.match(hint, /Answer first to continue to the next question/);
    assert.doesNotMatch(hint, han);
    const busy = render({ feedback: { correct: true } }, { busy: true });
    assert.match(busy, /Saving the previous step, one moment/);
    assert.doesNotMatch(busy, han);
  } finally { setUiLanguage("zh"); }
});

test('the More chevron is drawn, not a text glyph: the "⌄" character sits below the baseline and looks like a subscript', async () => {
  const { readFileSync } = await import('node:fs');
  const css = readFileSync(new URL('../ui/review/review.css', import.meta.url), 'utf8');
  const after = /\.review-more-trigger::after\s*\{([^}]*)\}/.exec(css)?.[1] ?? '';
  assert.ok(after, 'the chevron rule exists');
  assert.doesNotMatch(after, /content:\s*"[^"]/, 'no text glyph as content');
  assert.match(after, /border-right:/); assert.match(after, /border-bottom:/);
  assert.match(after, /transform:[^;]*rotate\(45deg\)/);
  const open = /\.review-more-trigger\[aria-expanded="true"\]::after\s*\{([^}]*)\}/.exec(css)?.[1] ?? '';
  assert.match(open, /rotate\(-135deg\)/, 'it turns up while the menu is open');
});

test("更多 is a menu (#79): a button with aria-haspopup, not a details element, and its list is a role=menu", () => {
  setUiLanguage("zh");
  const closed = render({ feedback: null });
  assert.doesNotMatch(closed, /<details|<summary/);
  assert.match(closed, /<button[^>]*aria-haspopup="menu"[^>]*aria-expanded="false"[^>]*>更多<\/button>|<button[^>]*aria-expanded="false"[^>]*aria-haspopup="menu"[^>]*>更多<\/button>/);
  const open = render({ feedback: null }, { moreDefaultOpen: true });
  assert.match(open, /role="menu"/);
  assert.deepEqual([...open.matchAll(/<span class="sh-menu__label">([^<]*)<\/span>/g)].map((match) => match[1]), ["写笔记", "修题", "斩掉此题"]);
  assert.match(open, /<button[^>]*role="menuitem"[^>]*class="sh-menu__item is-danger"[^>]*>(?:(?!<\/button>).)*斩掉此题/, 'slaying is marked as the dangerous one');
  const withTask = render({ feedback: null }, { onTask() {}, moreDefaultOpen: true });
  assert.ok(withTask.indexOf("记待办") > withTask.indexOf("写笔记") && withTask.indexOf("记待办") < withTask.indexOf("修题"));
});

test("the More menu has 出前置题… next to 修题 (only when the page can start it), in both languages", () => {
  setUiLanguage("zh");
  const withIt = render({ feedback: null }, { onDerive() {}, moreDefaultOpen: true });
  assert.match(withIt, /<button[^>]*data-usage="review\.derive"[^>]*>(?:(?!<\/button>).)*出前置题…<\/span><\/button>/);
  assert.ok(withIt.indexOf("修题") < withIt.indexOf("出前置题…") && withIt.indexOf("出前置题…") < withIt.indexOf("斩掉此题"), "between 修题 and 斩掉此题");
  assert.doesNotMatch(render({ feedback: null }, { moreDefaultOpen: true }), /出前置题/, "no handler, no entry");
  setUiLanguage("en");
  try {
    const english = render({ feedback: null }, { onDerive() {}, moreDefaultOpen: true });
    assert.match(english, />Generate a prerequisite question…</);
    assert.doesNotMatch(english.replace(/data-usage="[^"]*"/g, ""), han);
  } finally { setUiLanguage("zh"); }
});
