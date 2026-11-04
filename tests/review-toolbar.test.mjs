import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { build } from "esbuild";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

const compiled = await build({
  stdin: { contents: "export { default as ReviewToolbar } from './ui/ReviewToolbar.jsx'; export { StudyServicesContext } from './ui/study-context.jsx'; export { setUiLanguage } from './ui/i18n.js';", resolveDir: process.cwd() },
  bundle: true, write: false, platform: "node", format: "cjs", external: ["react"], loader: { ".css": "text" }, logLevel: "silent" });
const module = { exports: {} };
new Function("require", "module", "exports", compiled.outputFiles[0].text)(createRequire(import.meta.url), module, module.exports);
const { ReviewToolbar, StudyServicesContext, setUiLanguage } = module.exports;
const han = /[㐀-鿿]/;

const baseRun = { id: "r", index: 0, total: 2, mode: "path", card: { id: "q", kind: "quiz", topic: "T", prompt: "P?", options: [] } };
// `busy` is the app's (useStudy): the toolbar reads it from the services, so the tests give it there.
const render = (run, { busy = false, ...props } = {}) => renderToStaticMarkup(React.createElement(StudyServicesContext.Provider, { value: { busy } }, React.createElement(ReviewToolbar, {
  run: { ...baseRun, ...run }, onToggleHelp() {}, onAsk() {}, onImprove() {}, onSlay() {}, onNote() {}, onReviewAction() {}, ...props })));
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
  assert.deepEqual([...open.matchAll(/<span class="sh-menu__label">([^<]*)<\/span>/g)].map((match) => match[1]), ["显示英文", "字号与版心…", "写笔记", "修题", "斩掉此题"]);
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

const menuOf = (run, props = {}) => render(run, { moreDefaultOpen: true, ...props });
const item = (html, label) => html.match(new RegExp(`<button[^>]*role="menuitemcheckbox"[^>]*>(?:(?!</button>).)*${label}</span>(?:(?!</button>).)*</button>`))?.[0] || "";

test("自动跳下一步 is an item of 更多 with its key A, bound to what the page gives it (#671: the toolbar keeps five controls)", () => {
  setUiLanguage("zh");
  const off = menuOf({ feedback: null }, { autopilot: false, onToggleAutopilot() {} });
  assert.match(item(off, "自动跳下一步"), /aria-checked="false"/);
  assert.match(item(off, "自动跳下一步"), /aria-keyshortcuts="A"/);
  assert.match(item(off, "自动跳下一步"), /sh-menu__hint">A</);
  assert.match(item(menuOf({ feedback: null }, { autopilot: true, onToggleAutopilot() {} }), "自动跳下一步"), /aria-checked="true"/);
  assert.doesNotMatch(render({ feedback: null }, { autopilot: true, onToggleAutopilot() {} }), /自动跳下一步|自动驾驶/, "not a control of the toolbar itself");
  assert.doesNotMatch(menuOf({ feedback: null }), /自动跳下一步/, "a page without the setting draws no dead switch");
  assert.doesNotMatch(menuOf({ mode: "exam", feedback: null }, { autopilot: true, onToggleAutopilot() {} }), /自动跳下一步/, "a mock exam does not move on by itself");
});

test("the toolbar keeps at most five controls, and every folded one is an item of 更多 with its key", () => {
  setUiLanguage("zh");
  const props = { autopilot: false, onToggleAutopilot() {}, onThumb() {}, thumbVote: null, onToggleEn() {} };
  const closed = render({ feedback: null }, props);
  const buttons = [...closed.matchAll(/<button\b[^>]*>/g)].map((match) => match[0]);
  assert.ok(buttons.length <= 5, `${buttons.length} controls: ${buttons.join(" ")}`);
  const open = menuOf({ feedback: null }, props);
  for (const label of ["显示英文", "自动跳下一步", "字号与版心…", "这题不错", "这题有问题…"]) assert.match(open, new RegExp(`>${label}<`), `${label} is in 更多`);
  assert.match(item(open, "这题不错"), /aria-keyshortcuts="G"/);
  assert.match(open, /<button[^>]*aria-keyshortcuts="B"[^>]*>(?:(?!<\/button>).)*这题有问题…/);
  assert.match(item(menuOf({ feedback: null }, { ...props, thumbVote: "up" }), "这题不错"), /aria-checked="true"/, "the recorded vote shows as checked");
  assert.match(item(menuOf({ feedback: null }, { ...props, enOn: true }), "显示英文"), /aria-checked="true"/);
});

test("the autopilot item flips a setting, so a saving step does not disable it; the English words are English", () => {
  setUiLanguage("zh");
  const html = menuOf({ feedback: { correct: true } }, { autopilot: false, onToggleAutopilot() {}, busy: true });
  assert.doesNotMatch(item(html, "自动跳下一步"), /disabled/);
  setUiLanguage("en");
  try {
    const english = menuOf({ feedback: null }, { autopilot: true, onToggleAutopilot() {}, onThumb() {}, onToggleEn() {} });
    assert.match(english, />Auto-advance</);
    assert.match(english, />Good question</);
    assert.doesNotMatch(english.replace(/data-usage="[^"]*"/g, ""), han);
  } finally { setUiLanguage("zh"); }
});
