/* 找功能 (#653) in static markup and pure rules: the sheet (results, groups, greyed entries, the empty state), the sidebar row in both widths, the keys, the
   shortcut sheet, the usage names, the tour's sidebar step and where 「带我去」 stands. The keyboard and the lit target in a real browser are
   tests/feature-finder-browser.test.mjs. */
import test from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { loadUi } from "./helpers/ui-module.mjs";

const m = await loadUi(`
  export { default as FinderSheet } from './ui/finder/FinderSheet.jsx';
  export { default as FinderNavItem } from './ui/finder/FinderNavItem.jsx';
  export { FINDER_ENTRIES, PREPARE_STEPS } from './ui/finder/entries.js';
  export { opensFinder, moveActive, finderShortcutLabel, isMacPlatform } from './ui/finder/keys.js';
  export { planTrip, tripNotice, pathText } from './ui/finder/trip.js';
  export { default as ShortcutHelp } from './ui/ShortcutHelp.jsx';
  export { TOUR_STEPS } from './ui/tour/steps.js';
  export { shortcutKeyFor } from './ui/usage/capture.js';
  export { USAGE_REGISTRY_BY_KEY } from './ui/usage/registry.js';
  export { setUiLanguage } from './ui/i18n.js';
`);
const han = /[㐀-鿿]/;
const noop = () => {};
const text = (html) => html.replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/&#x27;/g, "'").replace(/\s+/g, " ");
const inLanguage = (language, render) => { m.setUiLanguage(language); try { return render(); } finally { m.setUiLanguage("zh"); } };
const HOST = { features: { examBlueprint: true }, contexts: ["bank", "study", "materials", "generation", "authoring", "audio", "recording", "notes", "workflows", "skeleton", "system"] };
const sheet = (props = {}) => renderToStaticMarkup(React.createElement(m.FinderSheet, { data: HOST, onGo: noop, onClose: noop, onTour: noop, ...props }));
const rows = (html) => [...html.matchAll(/<div[^>]*role="option"[^>]*>/g)].map((match) => match[0]);

test("the sheet is a dialog with a search field and a listbox; the empty query is the index: groups of <details>, every area once, the first one open", () => {
  const html = sheet();
  assert.match(html, /<dialog[^>]*role="dialog"/);
  assert.match(html, />找功能</);
  assert.match(html, /<input[^>]*role="combobox"[^>]*aria-autocomplete="list"/, "the field drives the list");
  assert.match(html, /role="listbox"/);
  const groups = [...html.matchAll(/<details[^>]*class="finder-group"[^>]*>/g)].map((match) => match[0]);
  assert.equal(groups.length, 8, "eight areas");
  assert.equal(groups.filter((group) => /\sopen=""/.test(group)).length, 1, "only the first is open");
  for (const label of ["每天学习", "资料与阅读", "出题", "练习与复习", "考试与统计", "课程与录音", "设置", "名词"]) assert.ok(html.includes(`>${label}<`), label);
  assert.ok(rows(html).length > 5, "the open group lists its entries");
  assert.equal((html.match(/sh-btn--primary/g) || []).length, 0, "no accent: 带我去 is not the page's one primary action");
});

test("a result shows its title, its path as crumbs, one sentence and the tags of what it needs; 带我去 is there for an entry that can be reached", () => {
  const html = sheet({ initialQuery: "翻译" });
  const first = html.slice(html.indexOf('role="option"'));
  assert.match(text(first.slice(0, first.indexOf('role="option"', 10) > 0 ? first.indexOf('role="option"', 10) : undefined)), /翻译 资料 › 打开一份资料 › 工具栏 › 翻译 把这一页或这一章译成中文或英文/);
  assert.match(html, /需要 AI 模型/);
  assert.match(html, /<button[^>]*finder-row__go[^>]*>带我去</);
  assert.match(html, /aria-selected="true"/, "one row is the selected one");
  assert.equal((html.match(/aria-selected="true"/g) || []).length, 1);
  assert.doesNotMatch(html, /<details[^>]*class="finder-group"/, "a search is one ranked list, not groups");
});

test("an entry this host cannot take you to is greyed with its reason and has no 带我去; a term shows its meaning and has none", () => {
  const off = { ...HOST, features: {} };
  const html = sheet({ data: off, initialQuery: "备考补习" });
  const row = rows(html).find((tag) => /page-examprep/.test(tag));
  assert.ok(row, "the entry is still listed");
  assert.match(row, /aria-disabled="true"/);
  const body = html.slice(html.indexOf(row), html.indexOf("</div></div>", html.indexOf(row)) + 12);
  assert.match(text(body), /这个 DSH 里没有开启备考补习/);
  assert.match(text(body), /需要 DSH 开启备考补习/, "the tag says it too");
  assert.doesNotMatch(body, /带我去/);
  const term = sheet({ initialQuery: "主会话" });
  const termRow = term.slice(term.indexOf("term-mainChat"));
  assert.match(text(termRow.slice(0, 700)), /主会话 .*DSH 里和你对话的那个窗口/);
  assert.doesNotMatch(termRow.slice(0, termRow.indexOf("</div></div>") > 0 ? termRow.indexOf("</div></div>") : 700), /带我去/);
});

test("nothing found: one line that names the query, and a button that starts the tour", () => {
  const html = sheet({ initialQuery: "zzqx" });
  assert.match(text(html), /没找到『zzqx』。试试换个说法，或打开功能导览。/);
  assert.match(html, /<button[^>]*>打开功能导览</);
  assert.equal(rows(html).length, 0);
});

test("the English interface: no Chinese anywhere in the sheet, in the index or in a result, and the English words find the entry", () => {
  const index = inLanguage("en", () => sheet());
  assert.doesNotMatch(text(index), han);
  const result = inLanguage("en", () => sheet({ initialQuery: "translate" }));
  assert.doesNotMatch(text(result), han);
  assert.match(result, /needs an AI model|Needs an AI model/i);
  assert.match(text(result), /Go there|Take me there/);
  const empty = inLanguage("en", () => sheet({ initialQuery: "zzqx" }));
  assert.doesNotMatch(text(empty), han);
});

test("the sidebar row 找功能 sits in the wide sidebar with its shortcut as a quiet hint and in the narrow rail as an icon with a tooltip", () => {
  const wide = renderToStaticMarkup(React.createElement(m.FinderNavItem, { narrow: false, onOpen: noop }));
  assert.match(wide, /data-usage="nav\.finder"/);
  assert.match(wide, /data-tour="nav-finder"/);
  assert.match(wide, />找功能</);
  assert.match(wide, /Ctrl K|⌘K/);
  assert.match(wide, /<svg/, "an icon");
  const narrow = renderToStaticMarkup(React.createElement(m.FinderNavItem, { narrow: true, onOpen: noop }));
  assert.match(narrow, /data-usage="nav\.finder"/);
  assert.match(narrow, /nav-label/, "the label stays in the tree for assistive technology");
  assert.doesNotMatch(wide, /title="/, "no title attribute: the words are the Tooltip's");
});

test("the keys: Ctrl K and ⌘K open it anywhere in the app, / only outside a text field, nothing else does", () => {
  const press = (key, extra = {}, options) => m.opensFinder({ key, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, repeat: false, ...extra }, options);
  assert.equal(press("k", { ctrlKey: true }), true);
  assert.equal(press("K", { ctrlKey: true }), true);
  assert.equal(press("k", { metaKey: true }), true);
  assert.equal(press("k", { ctrlKey: true }, { typing: true }), true, "a text field does not use Ctrl K");
  assert.equal(press("/"), true);
  assert.equal(press("/", {}, { typing: true }), false, "typing a slash is typing");
  assert.equal(press("?", { shiftKey: true }), false, "? is the shortcut sheet");
  assert.equal(press("k"), false);
  assert.equal(press("k", { ctrlKey: true, shiftKey: true }), false);
  assert.equal(press("k", { ctrlKey: true, altKey: true }), false);
  assert.equal(press("k", { ctrlKey: true, repeat: true }), false, "a held key opens it once");
  assert.equal(press("k", { ctrlKey: true, isComposing: true }), false);
  assert.equal(m.finderShortcutLabel(true), "⌘K");
  assert.equal(m.finderShortcutLabel(false), "Ctrl K");
  assert.equal(m.isMacPlatform({ platform: "MacIntel" }), true);
  assert.equal(m.isMacPlatform({ platform: "Win32" }), false);
});

test("↑ and ↓ move one row and wrap; a vanished row starts at an end", () => {
  const ids = ["a", "b", "c"];
  assert.equal(m.moveActive(ids, "a", "ArrowDown"), "b");
  assert.equal(m.moveActive(ids, "c", "ArrowDown"), "a");
  assert.equal(m.moveActive(ids, "a", "ArrowUp"), "c");
  assert.equal(m.moveActive(ids, "gone", "ArrowDown"), "a");
  assert.equal(m.moveActive(ids, "gone", "ArrowUp"), "c");
  assert.equal(m.moveActive([], "a", "ArrowDown"), null);
  assert.equal(m.moveActive(ids, "gone", "x"), "a");
});

test("the shortcut sheet lists Ctrl K, ⌘K and / everywhere, on the practice page too", () => {
  for (const page of ["library", "review", "book"]) {
    const html = renderToStaticMarkup(React.createElement(m.ShortcutHelp, { page, onClose: noop }));
    assert.match(html, /<kbd>Ctrl K<\/kbd><kbd>⌘K<\/kbd><kbd>\/<\/kbd>/, page);
    assert.match(text(html), /找功能/, page);
  }
  const english = inLanguage("en", () => text(renderToStaticMarkup(React.createElement(m.ShortcutHelp, { page: "library", onClose: noop }))));
  assert.match(english, /Find a feature/);
  assert.doesNotMatch(english, han);
});

test("the usage record knows the row and the keys: nav.finder and shortcut.finder", () => {
  assert.ok(m.USAGE_REGISTRY_BY_KEY["nav.finder"], "the row");
  assert.ok(m.USAGE_REGISTRY_BY_KEY["shortcut.finder"], "the shortcut");
  const target = { tagName: "DIV", parentElement: null, getAttribute: () => null, hasAttribute: () => false };
  const event = (extra) => ({ key: "k", code: "KeyK", target, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, repeat: false, ...extra });
  assert.equal(m.shortcutKeyFor(event({ ctrlKey: true })), "shortcut.finder");
  assert.equal(m.shortcutKeyFor(event({ metaKey: true })), "shortcut.finder");
  assert.equal(m.shortcutKeyFor(event({ key: "/", code: "Slash" })), "shortcut.finder");
  assert.equal(m.shortcutKeyFor(event({ key: "k" })), null);
  assert.equal(m.shortcutKeyFor(event({ ctrlKey: true, repeat: true })), null);
  const field = { ...target, tagName: "INPUT", getAttribute: () => null };
  assert.equal(m.shortcutKeyFor(event({ key: "/", code: "Slash", target: field })), null, "typing a slash is not a shortcut");
});

test("the tour's sidebar step points at 找功能 and still names every page of the groups", () => {
  const step = m.TOUR_STEPS.find((item) => item.id === "nav");
  assert.match(step.body, /找功能/);
  assert.match(step.body, /Ctrl K/);
  assert.ok(step.body.startsWith("左侧放常用的功能；找不到某个功能时，点「找功能」或按 Ctrl K 搜一下，选中后会直接带你过去。"));
});

test("where 带我去 stands: on the page already, on the page of the entry, on the page the prepare step names; a settings anchor is a settings link", () => {
  const entry = (id) => m.FINDER_ENTRIES.find((item) => item.id === id);
  assert.deepEqual(m.planTrip(entry("budget"), { page: "generate" }), { here: true, land: null, settings: null });
  assert.deepEqual(m.planTrip(entry("budget"), { page: "library" }), { here: false, land: "generate", settings: null });
  assert.deepEqual(m.planTrip(entry("hint"), { page: "sources" }), { here: false, land: "library", settings: null }, "a round of practice cannot be opened for you: the library is where one starts");
  assert.deepEqual(m.planTrip(entry("hint"), { page: "review" }), { here: true, land: null, settings: null });
  assert.deepEqual(m.planTrip(entry("update"), { page: "library" }), { here: false, land: "settings", settings: "settings-update" });
  assert.deepEqual(m.planTrip(entry("mailbox"), { page: "dashboard" }), { here: true, land: null, settings: null }, "the top bar is on every page");
});

test("the toast says the path, then what is left to do: nothing when the control was lit where the entry says it is", () => {
  const entry = (id) => m.FINDER_ENTRIES.find((item) => item.id === id);
  assert.equal(m.tripNotice(entry("budget"), 0), null);
  assert.equal(m.tripNotice(entry("update"), 0), null);
  assert.equal(m.tripNotice(entry("update"), -1).text, "在「设置 › 关于与更新」里。");
  assert.equal(m.tripNotice(entry("budget"), -1).text, "在「创建题组 › 更多选项 › 覆盖强度 › 花费上限」里。先在「资料」里添加资料，这一项才会出现。");
  assert.equal(m.tripNotice(entry("budget"), 1).text, "在「创建题组 › 更多选项 › 覆盖强度 › 花费上限」里。先在「资料」里添加资料，这一项才会出现。", "only the first tab of the page was lit: there are no materials yet");
  assert.equal(m.tripNotice(entry("translation"), -1).text, "在「资料 › 打开一份资料 › 工具栏 › 翻译」里。先在「资料」里打开一份资料。");
  assert.match(m.tripNotice(entry("translation"), 1).text, /先在「资料」里打开一份资料。/, "only the list of materials was lit");
  assert.equal(m.tripNotice(entry("translation"), 0), null, "the control itself was lit");
  assert.match(m.tripNotice(entry("write-note"), 0).text, /点题目下方的「更多」，菜单里就有这一项。/, "a menu item behind a button that was lit");
  assert.equal(m.pathText(entry("pdf-convert")), "资料 › 添加资料 › PDF 解析");
  const english = inLanguage("en", () => m.tripNotice(entry("budget"), -1).text);
  assert.doesNotMatch(english, han);
});
