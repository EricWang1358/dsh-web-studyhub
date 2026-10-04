import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { build } from "esbuild";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readAppSource } from "./helpers/app-source.mjs";

/* The sidebar's rows share one anatomy: icon, label, optional trailing hint. The resume row ("回到题目")
   used to grow a second line while a run was open, which pushed every row below it down by 24px; these tests pin the
   markup and the stylesheet contract that keep every row one height in every state (the browser measurement lives in
   tests/nav-layout.test.mjs). */
const han = /[㐀-鿿]/;
const require = createRequire(import.meta.url);
const compiled = await build({
  stdin: { contents: "export * from './ui/SideNav.jsx'; export { setUiLanguage } from './ui/i18n.js';", resolveDir: process.cwd() },
  bundle: true, write: false, platform: "node", format: "cjs", external: ["react"], loader: { ".css": "text" }, logLevel: "silent",
});
const mod = { exports: {} };
new Function("require", "module", "exports", compiled.outputFiles[0].text)(require, mod, mod.exports);
const { NavItem, ResumeNavItem, CoachNavItem, setUiLanguage } = mod.exports;
const html = (element) => renderToStaticMarkup(element);
const lastRun = { id: "r1", title: "Patterns", index: 1, total: 3 };

test("a row is icon + label + optional trailing hint, and never a subtitle line", () => {
  setUiLanguage("zh");
  const markup = html(React.createElement(NavItem, { glyph: "library", label: "学习库", hint: 3 }));
  assert.match(markup, /^<button type="button" class="nav"/);
  assert.match(markup, /<span class="nav-label">学习库<\/span>/);
  assert.match(markup, /<span class="nav-count">3<\/span>/);
  assert.doesNotMatch(markup, /<small/);
  assert.doesNotMatch(html(React.createElement(NavItem, { glyph: "library", label: "学习库" })), /nav-count|nav-hint/);
});

test("one definition of active and disabled: aria-current only on the active, enabled row", () => {
  const active = html(React.createElement(NavItem, { glyph: "library", label: "A", active: true }));
  assert.match(active, /class="nav active"/);
  assert.match(active, /aria-current="page"/);
  const idle = html(React.createElement(NavItem, { glyph: "library", label: "A" }));
  assert.doesNotMatch(idle, /aria-current|active/);
  const off = html(React.createElement(NavItem, { glyph: "library", label: "A", active: true, disabled: true }));
  assert.match(off, /disabled=""/);
  assert.doesNotMatch(off, /aria-current/, "a disabled row never claims to be the current page");
  const upkeep = html(React.createElement(NavItem, { glyph: "notes", label: "A", upkeep: true, active: true }));
  assert.match(upkeep, /class="nav nav-upkeep active"/);
  const passed = html(React.createElement(NavItem, { glyph: "board", label: "A", "data-tour": "nav-board", "data-nav-id": "board", title: "t" }));
  assert.match(passed, /data-tour="nav-board"/);
  assert.match(passed, /data-nav-id="board"/);
});

test("the resume row is the same single line with or without a run; progress is a trailing hint", () => {
  setUiLanguage("zh");
  const none = html(React.createElement(ResumeNavItem, { lastRun: null, hasDecks: true, active: false }));
  const open = html(React.createElement(ResumeNavItem, { lastRun, hasDecks: true, active: false }));
  for (const markup of [none, open]) {
    assert.match(markup, /class="nav resume-nav"/);
    assert.match(markup, /<span class="nav-label">回到题目<\/span>/);
    assert.doesNotMatch(markup, /<small/, "no second line");
    assert.match(markup, /aria-keyshortcuts="S"/);
  }
  assert.doesNotMatch(none, /nav-count/);
  assert.match(open, /<span class="nav-count nav-progress">2\/3<\/span>/);
  assert.match(open, /role="tooltip"[^>]*>回到「Patterns」第 2\/3 题/, "the run's title lives in the tooltip");
  assert.match(none, /role="tooltip"[^>]*>没有进行中的练习，开始今日学习/);
  assert.doesNotMatch(open, /<button[^>]*\btitle=/, "no native title: the Tooltip also shows on keyboard focus (#86)");
});

test("an empty library does not dim the resume row: dimmed means disabled, and this row still works", () => {
  setUiLanguage("zh");
  const empty = html(React.createElement(ResumeNavItem, { lastRun: null, hasDecks: false, active: false }));
  assert.doesNotMatch(empty, /muted-nav/);
  assert.doesNotMatch(empty, /disabled/);
  assert.match(empty, /role="tooltip"[^>]*>还没有题目，先去创建题组/);
  const busy = html(React.createElement(ResumeNavItem, { lastRun: null, hasDecks: true, active: false, disabled: true }));
  assert.match(busy, /disabled=""/);
});

test("the resume row follows the active page and keeps the hint on every page", () => {
  setUiLanguage("zh");
  const on = html(React.createElement(ResumeNavItem, { lastRun, hasDecks: true, active: true }));
  assert.match(on, /class="nav resume-nav active"/);
  assert.match(on, /aria-current="page"/);
  assert.match(on, />2\/3</);
});

test("the coach row is one line too: the ready count is its trailing badge, not a subtitle", () => {
  setUiLanguage("zh");
  const markup = html(React.createElement(CoachNavItem, { ready: 3 }));
  assert.match(markup, /class="nav coach-nav"/);
  assert.match(markup, /<span class="nav-label">为你定制<\/span>/);
  assert.match(markup, /<span class="nav-badge">3<\/span>/);
  assert.doesNotMatch(markup, /<small/);
  assert.match(markup, /3 道题已备好/, "the count is still announced in words");
});

test("English renders without Han outside user data, and the run title stays user data", () => {
  setUiLanguage("en");
  try {
    const open = html(React.createElement(ResumeNavItem, { lastRun, hasDecks: true, active: false }));
    const none = html(React.createElement(ResumeNavItem, { lastRun: null, hasDecks: false, active: false }));
    const coach = html(React.createElement(CoachNavItem, { ready: 3 }));
    for (const markup of [open, none, coach]) assert.doesNotMatch(markup, han);
    assert.match(open, /Return to question/);
    assert.match(open, />2\/3</);
    assert.match(open, /Return to “Patterns”, question 2\/3/);
    assert.match(none, /No questions yet; create a deck first/);
    assert.match(coach, /Personali[sz]ed|3 questions ready/);
    const own = html(React.createElement(ResumeNavItem, { lastRun: { ...lastRun, title: "操作系统" }, hasDecks: true, active: false }));
    assert.doesNotMatch(own.replace(/<span[^>]*role="tooltip"[^>]*>[^<]*<\/span>/, ""), han, "only the tooltip carries the learner's own title");
  } finally { setUiLanguage("zh"); }
});

test("stylesheet contract: one row height, labels clamped to the row, no second-line subtitles, one active look", async () => {
  const [style, coach, language] = await Promise.all(["shell", "coach", "language"].map((name) => readFile(new URL(`../ui/${name}.css`, import.meta.url), "utf8")));
  const all = `${style}\n${coach}\n${language}`.replace(/\r/g, "");
  const rule = (css, selector) => [...css.matchAll(new RegExp(`^[ \\t]*${selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[ \\t]*\\{([^}]*)\\}`, "gm"))].map((m) => m[1]).join("\n");
  assert.match(rule(all, ".nav"), /height:\s*var\(--nav-row\)/, "every row has the one fixed height");
  assert.match(rule(all, ".nav-upkeep"), /height:\s*var\(--nav-row-upkeep\)/);
  const label = rule(all, ".nav-label");
  assert.match(label, /overflow:\s*hidden/);
  assert.match(label, /text-overflow:\s*ellipsis/);
  assert.match(label, /-webkit-line-clamp:\s*2/, "a long label takes at most two lines inside the one row height");
  assert.doesNotMatch(all, /\.resume-nav\s+\.nav-label\s+small/, "the resume row has no subtitle line");
  assert.doesNotMatch(all, /\.coach-nav\s+\.nav-label\s+small/, "nor does the coach row");
  assert.doesNotMatch(all, /muted-nav/, "no look of its own for a row that still works");
  assert.doesNotMatch(language.replace(/\r/g, ""), /\.nav\{[^}]*white-space:\s*normal/, "English labels truncate like Chinese ones; the tooltip has the full text");
  assert.doesNotMatch(rule(all, ".coach-nav .nav-label"), /font-weight:\s*600/, "bold means the active page, nothing else");
  assert.match(all, /\.sidebar-bottom\s+\.nav\.active/, "Settings gets the same highlight and bar as the rows above it");
});

test("App uses the shared row for every sidebar entry", async () => {
  const source = (await readAppSource()).replace(/\r/g, "");
  assert.match(source, /<ResumeNavItem\b/);
  assert.match(source, /<CoachNavItem\b/);
  assert.doesNotMatch(source, /className=\{?["']nav[ "']/, "no hand-written nav button is left");
  assert.doesNotMatch(source, /"nav active"/);
  assert.doesNotMatch(source, /className="nav theme-cycle"/);
  for (const id of ["nav-settings", "tour-reopen"]) assert.match(source, new RegExp(`data-tour="${id}"`));
  assert.match(source, /data-tour=\{`nav-\$\{id\}`\}/);
});
