import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { build } from "esbuild";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

/* The 修题 box's chips and 「存为我的常用语句」 (ui/review/FixPhrases.jsx): what the learner sees with and without phrases of their own, and what a click on a chip,
   on its ✕ and on the save link hands to the page. The markup is rendered on the server; the click handlers are caught as the elements are created, so they can
   be called the way a click would. The whole round trip in a real browser is tests/fix-phrases-browser.test.mjs. */
const compiled = await build({
  stdin: { contents: "export * from './ui/review/FixPhrases.jsx'; export { StudyServicesContext } from './ui/study-context.jsx'; export { setUiLanguage } from './ui/i18n.js'; export { IMPROVE_SUGGESTIONS } from './ui/agent-prompts/card.js';", resolveDir: process.cwd() },
  bundle: true, write: false, platform: "node", format: "cjs", external: ["react"], loader: { ".css": "text" }, logLevel: "silent" });
const realRequire = createRequire(import.meta.url);
let handlers = [];
const watchedReact = { ...React, createElement: (type, props, ...children) => {
  if (props?.onClick && typeof type === "string") handlers.push({ type, props });
  return React.createElement(type, props, ...children);
} };
const module = { exports: {} };
new Function("require", "module", "exports", compiled.outputFiles[0].text)((id) => (id === "react" ? watchedReact : realRequire(id)), module, module.exports);
const { FixPhraseChips, FixPhraseSave, StudyServicesContext, setUiLanguage, IMPROVE_SUGGESTIONS } = module.exports;
const han = /[㐀-鿿]/;

// The shared Button remembers its width on a press, so a click needs an element to read it from.
const click = (item) => item.props.onClick({ currentTarget: { offsetWidth: 0, style: { setProperty() {} } } });
const OWN = "请采用代码块格式改写题目的原有口述代码形式";
const render = (element) => { handlers = []; return renderToStaticMarkup(element); };
// `busy` is the app's (useStudy): the parts read it from the services, so the tests give it there.
const within = (busy, element) => React.createElement(StudyServicesContext.Provider, { value: { busy } }, element);
const chips = ({ busy = false, ...props } = {}) => render(within(busy, React.createElement(FixPhraseChips, { phrases: [], onPick() {}, onRemove() {}, ...props })));
const save = ({ busy = false, ...props } = {}) => render(within(busy, React.createElement(FixPhraseSave, { phrases: [], text: OWN, onSave() {}, ...props })));

test("without phrases of their own the box shows the built-in choices and nothing else, as before", () => {
  setUiLanguage("zh");
  const html = chips();
  for (const [label] of IMPROVE_SUGGESTIONS) assert.match(html, new RegExp(label.replace(/[「」]/g, ".")));
  assert.doesNotMatch(html, /我的常用语句/);
  assert.equal((html.match(/class="sh-chip__main"/g) || []).length, IMPROVE_SUGGESTIONS.length);
});

test("own phrases are chips next to the built-in ones; a click on one fills the box with the whole phrase, a click on its ✕ removes only it", () => {
  setUiLanguage("zh");
  const long = "把题目里用文字描述的代码改写成代码块，并保持原来的缩进和注释，不要改变变量名和函数名";
  const picked = [], removed = [];
  const html = chips({ phrases: [OWN, long], onPick: (text) => picked.push(text), onRemove: (text) => removed.push(text) });
  assert.match(html, /role="group"[^>]*aria-labelledby=/, "its own labelled group");
  assert.match(html, /我的常用语句/);
  assert.equal((html.match(/class="sh-chip__main"/g) || []).length, IMPROVE_SUGGESTIONS.length + 2);
  const main = handlers.filter((item) => item.type === "button" && item.props.className === "sh-chip__main");
  click(main[IMPROVE_SUGGESTIONS.length]);
  click(main[IMPROVE_SUGGESTIONS.length + 1]);
  assert.deepEqual(picked, [OWN, long], "the full text, not the clipped label");
  assert.match(html, /…/, "a long phrase is clipped on its chip");
  const remove = handlers.filter((item) => /sh-chip__remove/.test(item.props.className || ""));
  assert.equal(remove.length, 2, "each own chip has a remove button, the built-in ones have none");
  click(remove[1]);
  assert.deepEqual(removed, [long]);
  assert.match(html, /aria-label="删除常用语句「请采用代码块格式改写题目的原有口述代码形式」"/, "the remove button names its phrase");
});

test("while a write is running the own chips cannot be removed", () => {
  setUiLanguage("zh");
  handlers = [];
  const html = chips({ phrases: [OWN], busy: true });
  assert.doesNotMatch(html, /sh-chip__remove/);
});

test("typed text offers one link to keep it; blank text offers nothing; the link hands over the trimmed text", () => {
  setUiLanguage("zh");
  const saved = [];
  const html = save({ text: `  ${OWN}  `, onSave: (text) => saved.push(text) });
  assert.match(html, /data-usage="review\.fix-phrase"[^>]*>存为我的常用语句<\/button>/);
  click(handlers.find((item) => item.props["data-usage"] === "review.fix-phrase"));
  assert.deepEqual(saved, [OWN]);
  assert.equal(save({ text: "   " }), "");
});

test("a text that cannot be kept says why in words instead of offering a dead link", () => {
  setUiLanguage("zh");
  const saved = save({ phrases: [OWN] });
  assert.match(saved, /已在我的常用语句里/);
  assert.doesNotMatch(saved, /<button/);
  assert.match(save({ text: "字".repeat(201) }), /超过 200 字/);
  const full = save({ phrases: Array.from({ length: 12 }, (_, i) => `p${i}`), text: "新的" });
  assert.match(full, /最多 12 条/);
  assert.doesNotMatch(full, /<button/);
});

test("the link is locked while a write runs", () => {
  setUiLanguage("zh");
  assert.match(save({ busy: true }), /<button[^>]*disabled=""/);
});

test("everything the box says about phrases is English in the English UI", () => {
  setUiLanguage("en");
  try {
    const html = chips({ phrases: [OWN] }) + save() + save({ phrases: [OWN] }) + save({ text: "x".repeat(201) })
      + save({ phrases: Array.from({ length: 12 }, (_, i) => `p${i}`), text: "new" });
    assert.match(html, />My phrases</);
    assert.match(html, />Save as my phrase</);
    assert.match(html, /Already in my phrases/);
    assert.match(html, /over 200 characters/);
    assert.match(html, /up to 12 phrases/);
    assert.doesNotMatch(html.replaceAll(OWN, "").replace(/data-usage="[^"]*"/g, ""), han, "the learner's own words are theirs; everything else is English");
  } finally { setUiLanguage("zh"); }
});
