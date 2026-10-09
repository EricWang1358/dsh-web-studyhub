import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { build } from "esbuild";
import { renderToStaticMarkup } from "react-dom/server";
import { reviewElement } from "./helpers/review-render.mjs";

/* The line under a practice page's title (查看 N 份资料 …) also names the course of the question on screen and how its chapter (the deck) and the
   whole course stand: the numbers are the snapshot's per-deck progress, worded as the 资料 page's mastery line. */
const compiled = await build({ stdin: { contents: "export { default } from './ui/Review.jsx'; export { StudyServicesContext } from './ui/study-context.jsx'; export { setUiLanguage } from './ui/i18n.js'; export { runContextOf } from './ui/review/run-context.js';", resolveDir: process.cwd() }, bundle: true,
  write: false, platform: "node", format: "cjs", external: ["react"], loader: { ".css": "text" }, logLevel: "silent" });
const module = { exports: {} };
new Function("require", "module", "exports", compiled.outputFiles[0].text)(createRequire(import.meta.url), module, module.exports);
const { default: Review, StudyServicesContext, setUiLanguage, runContextOf } = module.exports;

const row = (total, mastery, newCards = 0) => ({ total, mastery, counts: { mastered: 0, familiar: 0, learning: total - newCards, weak: 0, new: newCards }, due: 0, status: newCards === total ? "todo" : "active" });
const deck = (id, course, extra = {}) => ({ id, title: id, course, ...extra });
const data = (decks, progress, focusCourses = []) => ({ sources: [], decks, progress, focus: { courses: focusCourses } });
const card = { id: "q", kind: "quiz", topic: "Context", prompt: "Who?", options: [] };
// `decks` = the decks the run's questions come from (run.navigation lists one entry per question, as lib/study-state.js projects it).
const render = (info, deckId = "a", decks = undefined) => renderToStaticMarkup(reviewElement(Review, StudyServicesContext, {
  run: { id: "r", index: 0, total: 2, mode: "path", deckId, sourceIds: ["s1"], card, ...(decks ? { navigation: decks.map((id, index) => ({ index, deckId: id, cardId: "q" + index })) } : {}) }, data: info, host: {}, choice: true, selected: [], clozeValues: {}, shellTitle: "API", busy: false }));
// The line is the span after the button, up to the end of its row; the Tooltip keeps its words in the DOM, hidden, so they are cut out of the visible text.
const context = (html) => { const from = html.indexOf('<span class="review-context"'); return from < 0 ? "" : html.slice(from, html.indexOf("</div>", from)); };
const text = (html) => context(html).replace(/<[^>]*role="tooltip"[^>]*>.*?<\/(?:span|div)>/gs, "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();

// The words of the hovers inside the line: the Tooltip keeps them in the DOM, hidden.
const tips = (html) => [...context(html).matchAll(/role="tooltip"[^>]*>(.*?)<\/(?:span|div)>/gs)].map((hit) => hit[1].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim());

const library = data(
  [deck("a", "Design"), deck("b", "Design"), deck("c", "Other"), deck("tailor", "", { systemKind: "coach" })],
  { a: row(10, 62), b: row(30, 30), c: row(5, 90), tailor: row(3, 10) });

test("the course name, this chapter and the whole course sit on the line of 查看 N 份资料", () => {
  setUiLanguage("zh");
  const html = render(library);
  assert.ok(html.indexOf("review-heading-links") < html.indexOf("查看 1 份资料") && html.indexOf("查看 1 份资料") < html.indexOf("data-review-context"), "same row, after the button");
  // Design holds a (10 q, 62%) and b (30 q, 30%): 40 q at round((620 + 900) / 40) = 38%
  assert.equal(text(html), "Design 本章 掌握 62% · 10 题 整课程 掌握 38% · 40 题");
  assert.doesNotMatch(html, /review-context[^>]*title=/, "no title attribute: the hover is the Tooltip");
});

test("the numbers are the very ones of the lists: roll-up weighted by questions, 未学 for untouched decks, nothing for another course's decks", () => {
  setUiLanguage("zh");
  const fresh = data([deck("a", "Design"), deck("b", "Design")], { a: row(4, 0, 4), b: row(6, 0, 6) });
  assert.equal(text(render(fresh)), "Design 本章 未学 · 4 题 整课程 未学 · 10 题");
  assert.equal(text(render(library, "c")), "Other 本章 掌握 90% · 5 题", "the only deck of its course: the course figure would repeat the chapter, so it is left out");
  assert.deepEqual(runContextOf(library, "a").whole, { total: 40, percent: 38, state: "learning" });
});

test("it follows the question on screen, and an uncategorised course says so", () => {
  setUiLanguage("zh");
  const mixed = data([deck("a", "Design"), deck("c", "")], { a: row(10, 62), c: row(5, 90) });
  assert.match(text(render(mixed, "c")), /^未分类课程 本章 掌握 90% · 5 题$/);
  assert.match(text(render(mixed, "a")), /^Design 本章/);
});

test("a sub-course counts in its parent's whole-course figure only when the parent is the course", () => {
  setUiLanguage("zh");
  const tree = data([deck("a", "Design"), deck("b", "Design / Kubernetes")], { a: row(10, 50), b: row(10, 70) }, ["Design", "Design / Kubernetes"]);
  assert.equal(text(render(tree, "a")), "Design 本章 掌握 50% · 10 题 整课程 掌握 60% · 20 题");
  assert.equal(text(render(tree, "b")), "Design / Kubernetes 本章 掌握 70% · 10 题", "the sub-course alone has one deck");
});

test("nothing is drawn without a course deck, without progress, or for a system deck", () => {
  setUiLanguage("zh");
  assert.equal(context(render(library, "tailor")), "", "为你定制 belongs to no course");
  assert.equal(context(render(library, "missing")), "");
  assert.equal(context(render({ sources: [] })), "", "a snapshot without decks");
  assert.equal(context(render(data([deck("a", "Design")], {}))), "", "a deck without progress yet");
  assert.equal(context(render(data([deck("a", "Design")], { a: row(0, 0) }))), "", "a deck without questions");
  assert.match(render(library, "tailor"), /查看 1 份资料/, "the button stays");
});

/* A mixed run (the 一起学 all-courses round, a scope over decks of several courses): the question on screen keeps the line, +N says how many other
   courses the run still carries and the hover names them. */
const mixedLibrary = data(
  [deck("a", "Design"), deck("b", "Design"), deck("c", "Other"), deck("d", "Third"), deck("u", ""), deck("tailor", "", { systemKind: "coach" })],
  { a: row(10, 62), b: row(30, 30), c: row(5, 90), d: row(4, 50), u: row(2, 20), tailor: row(3, 10) });

test("a run over one course says nothing more; a run over several adds +N and names the others on hover", () => {
  setUiLanguage("zh");
  assert.equal(text(render(mixedLibrary, "a", ["a", "b", "a"])), "Design 本章 掌握 62% · 10 题 整课程 掌握 38% · 40 题", "two decks, one course: no +N");
  assert.equal(text(render(mixedLibrary, "a")), "Design 本章 掌握 62% · 10 题 整课程 掌握 38% · 40 题", "a run without the list of questions (an exam) behaves as before");
  const two = render(mixedLibrary, "a", ["a", "b", "c", "c"]);
  assert.equal(text(two), "Design +1 本章 掌握 62% · 10 题 整课程 掌握 38% · 40 题", "+N right after the course, the figures stay the current course's");
  assert.deepEqual(tips(two)[0], "这一轮还有：Other");
  const three = render(mixedLibrary, "c", ["a", "c", "d", "b"]);
  assert.equal(text(three), "Other +2 本章 掌握 90% · 5 题", "the other course's own figures; the other courses are counted, not the decks");
  assert.deepEqual(tips(three)[0], "这一轮还有：Design、Third", "in the order the run meets them");
  assert.doesNotMatch(context(three), /title=/, "the hover is the Tooltip, never a title attribute");
});

test("an uncategorised deck counts once as 未分类课程, and a coach deck is no course", () => {
  setUiLanguage("zh");
  const html = render(mixedLibrary, "a", ["a", "u", "u", "tailor", "c"]);
  assert.match(text(html), /^Design \+2 本章/);
  assert.deepEqual(tips(html)[0], "这一轮还有：未分类课程、Other");
  assert.match(text(render(mixedLibrary, "u", ["a", "u"])), /^未分类课程 \+1 本章 掌握 20% · 2 题$/);
  assert.doesNotMatch(text(render(mixedLibrary, "a", ["a", "tailor", "tailor"])), /\+\d/, "the coach deck belongs to no course");
  assert.equal(context(render(mixedLibrary, "tailor", ["a", "tailor"])), "", "a coach question on screen: still no line");
  assert.deepEqual(runContextOf(mixedLibrary, "a", ["a", "missing", "u"]).also, [""], "an unknown deck is ignored");
});

test("English: the same facts in the English words", () => {
  setUiLanguage("en");
  try {
    assert.equal(text(render(library)), "Design This chapter Mastery 62% · 10 questions Whole course Mastery 38% · 40 questions");
    assert.equal(text(render(data([deck("a", "")], { a: row(4, 0, 4) }))), "Uncategorised course This chapter New · 4 questions");
    assert.match(render(library), /View 1 sources/);
    const mixed = render(mixedLibrary, "a", ["a", "c", "u"]);
    assert.equal(text(mixed), "Design +2 This chapter Mastery 62% · 10 questions Whole course Mastery 38% · 40 questions");
    assert.deepEqual(tips(mixed)[0], "Also in this round: Other, Uncategorised course");
  } finally { setUiLanguage("zh"); }
});
