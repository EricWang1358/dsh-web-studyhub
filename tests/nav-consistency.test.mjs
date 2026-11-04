import test from "node:test";
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
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
const { NavItem, NavFold, ResumeNavItem, CoachNavItem, resumeProgress, setUiLanguage } = mod.exports;
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
  assert.match(active, /class="nav"/);
  assert.match(active, /aria-current="page"/);
  const idle = html(React.createElement(NavItem, { glyph: "library", label: "A" }));
  assert.doesNotMatch(idle, /aria-current|active/);
  const off = html(React.createElement(NavItem, { glyph: "library", label: "A", active: true, disabled: true }));
  assert.match(off, /disabled=""/);
  assert.doesNotMatch(off, /aria-current/, "a disabled row never claims to be the current page");
  const upkeep = html(React.createElement(NavItem, { glyph: "notes", label: "A", upkeep: true, active: true }));
  assert.match(upkeep, /class="nav nav-upkeep"/);
  assert.match(upkeep, /aria-current="page"/);
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

test("the resume row counts the round the practice page counts: a re-ask never reads 5/4", () => {
  setUiLanguage("zh");
  const saved = { id: "r1", title: "Patterns", index: 0, total: 4 };
  // The session's position (1-based `at` in a round of `total`) wins over the queue index, which runs past the round while a re-ask is open.
  const reask = resumeProgress(saved, { id: "r1", index: 4, total: 5, position: { total: 4, at: 4, retries: 1, retryAt: 1, last: false } });
  assert.deepEqual([reask.index, reask.total], [3, 4]);
  assert.match(html(React.createElement(ResumeNavItem, { lastRun: reask, hasDecks: true })), /<span class="nav-count nav-progress">4\/4<\/span>/);
  // Without a position (before the practice batch), the queue index and length as before.
  assert.deepEqual((({ index, total }) => [index, total])(resumeProgress(saved, { id: "r1", index: 1, total: 4 })), [1, 4]);
  assert.equal(resumeProgress(saved, { id: "other", index: 3, total: 9 }), saved, "another run on screen changes nothing");
  assert.equal(resumeProgress(null, { id: "r1", index: 1, total: 4 }), null);
});

/* #655: the 「从这里开始」 markers are gone (an empty library lit five of them, and none was something to act on now). What is left is one attention
   dot (ui/nav-alert.js): the same badge on the icon's corner, with its reason as the first line of the row's Tooltip. */
test("a row says what it is for, and the attention dot takes no room from the label", () => {
  setUiLanguage("zh");
  const purpose = "把做过的题写成笔记，也可以发布出去";
  const tail = "长按并拖动可调整顺序（键盘：Alt+↑/↓）";
  const reason = "今天有 3 道题到期复习";
  const tip = (markup) => markup.slice(markup.indexOf('role="tooltip"'));
  const marked = html(React.createElement(NavItem, { glyph: "notes", label: "学习笔记", purpose, tail, alert: reason }));
  const tooltipAt = marked.indexOf('role="tooltip"'), reasonAt = marked.indexOf(reason, tooltipAt), purposeAt = marked.indexOf(purpose, reasonAt), tailAt = marked.indexOf(tail, purposeAt);
  assert.ok(tooltipAt > 0 && reasonAt > tooltipAt && purposeAt > reasonAt && tailAt > purposeAt, "why it has a dot, what it is for, then (once) how to reorder it");
  assert.doesNotMatch(tip(marked), /学习笔记/, "beside a visible label the tooltip does not say the label again (#569)");
  assert.match(marked, /class="nav has-alert"/, "the row says it has something to act on");
  assert.match(marked, /<span class="icon nav-dot-icon" aria-hidden="true"><svg[^]*?<\/svg><span class="nav-dot" aria-hidden="true"><\/span><\/span><span class="nav-label">/,
    "the dot sits on the icon, not in the gap before the label, where it read as a bullet (#579); its words are in the tooltip");
  assert.doesNotMatch(marked, /<button[^>]*\btitle=/, "no native title: the Tooltip also shows on keyboard focus and on a long press");
  assert.doesNotMatch(html(React.createElement(NavItem, { glyph: "notes", label: "学习笔记", purpose })), /nav-dot|has-alert/, "no reason, no dot");
  assert.doesNotMatch(html(React.createElement(NavItem, { glyph: "notes", label: "学习笔记", purpose, start: true })), /nav-start|is-start/, "the 从这里开始 marker is gone");
  assert.doesNotMatch(html(React.createElement(NavItem, { glyph: "notes", label: "学习笔记" })), /role="tooltip"/, "a row with nothing to add has no tooltip");
  assert.equal(tip(html(React.createElement(NavItem, { glyph: "notes", label: "学习笔记", title: "学习笔记", purpose }))).match(/学习笔记/g), null, "a title equal to the label is not said either");
});

test("the attention dot is a badge on the icon's corner (#579, #655), and the old marker's sheet is gone", async () => {
  const css = (await readFile(new URL("../ui/side-groups.css", import.meta.url), "utf8")).replace(/\r/g, "");
  const rule = (selector) => css.match(new RegExp(`(?:^|\\n)\\s*${selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\{([^}]*)\\}`))?.[1] ?? null;
  const dot = rule(".nav-dot");
  assert.ok(dot, "the dot has its rule");
  assert.doesNotMatch(dot, /\bleft:/, "placed from the icon's top-right corner, not at an offset into the gap before the label");
  assert.match(dot, /\btop:/);
  assert.match(dot, /\bright:/);
  assert.match(dot, /background:\s*var\(--warn-solid\)/, "the attention colour marks the one thing to act on; the accent is the primary action (#658)");
  assert.match(rule(".nav-dot-icon") ?? "", /position:\s*relative/, "the icon holds the dot");
  await assert.rejects(readFile(new URL("../ui/nav-start.css", import.meta.url), "utf8"), "the 从这里开始 sheet is deleted");
});

test("the resume row and a fold carry the dot's reason first; with no rail, no row names itself in its own tooltip (#657)", () => {
  setUiLanguage("zh");
  assert.match(html(React.createElement(ResumeNavItem, { lastRun, hasDecks: true, alert: "今天有 3 道题到期复习" })), /role="tooltip"[^>]*>今天有 3 道题到期复习\n回到「Patterns」第 2\/3 题/);
  assert.doesNotMatch(html(React.createElement(ResumeNavItem, { lastRun, hasDecks: true })), /role="tooltip"[^>]*>回到题目/, "the label is on screen");
  const fold = html(React.createElement(NavFold, { id: "more", glyph: "more", label: "更多", purpose: "其余的功能", alert: "2 个任务没有完成，点开看原因", open: false, onToggle() {} }));
  assert.match(fold, /role="tooltip"[^>]*>2 个任务没有完成，点开看原因\n其余的功能/, "a closed 「更多」 carries the dot of a row folded inside it");
  assert.match(fold, /aria-expanded="false"/);
});

test("every sidebar page has one short sentence saying what it is for, with an English line", async () => {
  const { PAGES } = await import("../ui/pages.js");
  const { NAV_DEFAULTS } = await import("../ui/nav-order.js");
  const dir = new URL("../ui/locales/", import.meta.url);
  const names = (await readdir(dir)).filter((name) => /^en(?:\..+)?\.json$/.test(name));
  const catalogue = Object.assign({}, ...await Promise.all(names.map(async (name) => JSON.parse(await readFile(new URL(name, dir), "utf8")))));
  for (const ids of Object.values(NAV_DEFAULTS)) for (const id of ids) {
    const purpose = PAGES[id].purpose;
    assert.ok(typeof purpose === "string" && purpose.trim().length > 8, `${id}: says what it is for`);
    assert.ok(purpose.length <= 40, `${id}: one short sentence, not a paragraph`);
    assert.ok(catalogue[purpose], `${id}: no English line for 「${purpose}」`);
    assert.doesNotMatch(catalogue[purpose], han, `${id}: the English line has no Han`);
  }
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
  assert.match(on, /class="nav resume-nav"/);
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
  assert.match(all, /\.sidebar-bottom\s+\.nav\[aria-current="page"\]/, "Settings gets the same highlight and bar as the rows above it");
});

// #656: 快捷键 and 名词解释 sit in the footer's 「帮助」 fold (with 功能导览), so the footer has three controls: 找功能, 帮助, 设置.
test("the footer's 帮助 holds 快捷键 and 名词解释, and 快捷键 opens the one ? sheet", async () => {
  const source = (await readAppSource()).replace(/\r/g, "");
  assert.match(source, /data-usage="nav\.shortcut"/, "a visible entry, and a marked control");
  assert.match(source, /session\.actions\.openShortcutHelp\(\)/, "it opens the sheet the ? key opens");
  assert.match(source, /名词解释/, "the glossary has a visible entry too");
  assert.match(source, /purpose=\{glossaryText\(\)\}/, "the glossary is the row's Tooltip words, not a second panel");
  const footer = (await readFile(new URL("../ui/app/SidebarFooter.jsx", import.meta.url), "utf8")).replace(/\r/g, "");
  const help = footer.slice(footer.indexOf('<NavFold id="help"'), footer.indexOf("</NavFold>"));
  for (const tour of ["tour-reopen", "nav-shortcuts", "nav-glossary"]) assert.match(help, new RegExp(`data-tour="${tour}"`), `${tour} is inside 帮助`);
  const session = await readFile(new URL("../ui/review/useReviewSession.js", import.meta.url), "utf8");
  assert.match(session, /openShortcutHelp: \(\) => setShortcutHelp\(true\)/, "one sheet, two ways in");
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
