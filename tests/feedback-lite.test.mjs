import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { build } from "esbuild";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { nativeSelects } from "./helpers/native-selects.mjs";
import { materialMasteryIndex, pagesCardsView } from "../lib/material-mastery.js";

/* Closing the feedback loop (feedback-lite): the exam report's weak topics start practice, a chapter row offers 练这一章,
   and every "how well" number has its own name. Server-rendered markup of the real components. */

const compiled = await build({ stdin: { contents: `
  export { default as WrittenReport } from './ui/exam/WrittenReport.jsx';
  export { MasteryPanel } from './ui/charts/DashboardCharts.jsx';
  export { StatsView } from './ui/Dashboard.jsx';
  export { setUiLanguage } from './ui/i18n.js';`, resolveDir: process.cwd() },
  bundle: true, write: false, platform: "node", format: "cjs", external: ["react"], plugins: [nativeSelects], loader: { ".css": "text" }, logLevel: "silent" });
const module = { exports: {} };
new Function("require", "module", "exports", compiled.outputFiles[0].text)(createRequire(import.meta.url), module, module.exports);
const { WrittenReport, MasteryPanel, StatsView, setUiLanguage } = module.exports;
const noop = () => {};
const render = (type, props, language = "zh") => { setUiLanguage(language); try { return renderToStaticMarkup(React.createElement(type, props)); } finally { setUiLanguage("zh"); } };

const report = {
  runId: "r1", scorePct: 50, correct: 5, total: 10, answered: 9, durationMs: 600000,
  byTopic: [
    { deckId: "d1", deckTitle: "Final 05", topic: "传输层", correct: 1, total: 4 },
    { deckId: "d1", deckTitle: "Final 05", topic: "路由", correct: 3, total: 3 },
    { deckId: "d2", deckTitle: "Final 06", topic: "传输层", correct: 1, total: 3 },
  ],
  wrong: [], skipped: [], weakScope: [{ deckId: "d1", cardId: "a" }, { deckId: "d1", cardId: "b" }],
};

test("each weak topic of the exam report starts practice of that topic; the deck is named only when the topic name repeats", () => {
  const html = render(WrittenReport, { report, busy: false, pathNote: "", error: "", onQueueWeak: noop, onPracticeTopic: noop, onExit: noop, onAgain: noop });
  assert.equal((html.match(/练这个主题/g) || []).length, 2, "one button for each topic that has mistakes; 路由 was all correct");
  assert.match(html, /Final 05 · 传输层[\s\S]*?3\/4 题答错或未答[\s\S]*?练这个主题/);
  assert.match(html, /Final 06 · 传输层[\s\S]*?2\/3 题答错或未答/);
  assert.doesNotMatch(html, /路由<span class="muted">/);
  assert.match(html, /练习答错与未答的 2 道/, "the one aggregate button is still there");
  const busy = render(WrittenReport, { report, busy: true, pathNote: "", error: "", onQueueWeak: noop, onPracticeTopic: noop, onExit: noop, onAgain: noop });
  assert.match(busy, /<button[^>]*disabled=""[^>]*>练这个主题/, "no second action while one is working");
  const without = render(WrittenReport, { report, busy: false, pathNote: "", error: "", onQueueWeak: noop, onExit: noop, onAgain: noop });
  assert.doesNotMatch(without, /练这个主题/, "a host that cannot start practice offers no button");
  assert.match(render(WrittenReport, { report, busy: false, pathNote: "", error: "", onQueueWeak: noop, onPracticeTopic: noop, onExit: noop, onAgain: noop }, "en"), /Practise this topic/);
});

/* 练这一章: the questions of one chapter of a document, defined once (lib/material-mastery.js chapterIndexOf), the very set the chapter row's
   mastery counts, so what the button practises is what the number above it is about. */
const NOW = Date.parse("2026-10-01T12:00:00.000Z");
const pdfSources = (pages) => pages.map((page) => ({ id: `s${page}`, title: `Book · p.${page}`, text: `text of page ${page}`,
  document: { id: "h".repeat(64), page, format: "pdf", materialId: `document-${"h".repeat(64)}-pdf`, filename: "book.pdf" } }));
const card = (id, level, sourceId, extra = {}) => ({ id, kind: "flashcard", topic: "t", prompt: `Q ${id}`, answer: "A", citations: [{ sourceId, quote: "q" }],
  ...(level === "new" ? {} : { review: { repetitions: 2, interval_days: { weak: 1, familiar: 10, mastered: 30 }[level], due_at: new Date(NOW + 5 * 86400000).toISOString() } }), ...extra });
function book() {
  const sources = pdfSources([1, 2, 3, 4]);
  sources.forEach((source, index) => {
    source.document.origin = "converted"; source.document.converter = "mineru";
    source.document.chapter = index < 2 ? { index: 0, title: "One", level: 1 } : { index: 1, title: "Two", level: 1 };
  });
  return { sources, attempts: [], drafts: [], decks: [
    { id: "d", title: "D", cards: [card("a", "mastered", "s1"), card("b", "new", "s4"), card("c", "familiar", "s2"), card("gone", "new", "s1", { suspended: true })] },
    { id: "old", title: "Old", archived: true, cards: [card("z", "new", "s1")] }] };
}

test("a chapter's questions are the ones its row counts: the cards of that chapter, each once, suspended and archived left out", () => {
  const state = book(), mastery = Object.values(materialMasteryIndex(state, { now: NOW }))[0];
  const first = pagesCardsView(state, { sourceId: "s1", chapter: 0 }, { now: NOW });
  assert.equal(first.status, "ok");
  assert.deepEqual(first.cards.map((entry) => entry.cardId).sort(), ["a", "c"]);
  assert.equal(first.summary.total, mastery.chapters[0].total);
  assert.equal(first.summary.percent, mastery.chapters[0].percent, "the same number as the chapter row");
  assert.deepEqual(first.cards.map((entry) => entry.deckId), ["d", "d"]);
  const second = pagesCardsView(state, { sourceId: "s1", chapter: 1 }, { now: NOW });
  assert.deepEqual(second.cards.map((entry) => entry.cardId), ["b"]);
  assert.equal(second.summary.state, "unlearned");
  const none = pagesCardsView(state, { sourceId: "s1", chapter: 7 }, { now: NOW });
  assert.deepEqual(none.cards, []);
  assert.equal(none.summary.state, "none", "a chapter with no question: nothing to practise, and it says so");
  assert.equal(pagesCardsView(state, { sourceId: "s1", chapter: "1" }, { now: NOW }).cards.length, 3, "a chapter that is not a whole number is ignored: the whole document");
  assert.equal(pagesCardsView(state, { sourceId: "s1" }, { now: NOW }).cards.length, 3);
});

test("questions still in drafts are counted for the chapter but never offered for practice", () => {
  const state = book();
  state.drafts = [{ id: "draft1", title: "New", cards: [card("n", "new", "s4"), card("m", "new", "s3")] }];
  const second = pagesCardsView(state, { sourceId: "s1", chapter: 1 }, { now: NOW });
  assert.deepEqual(second.cards.map((entry) => entry.cardId), ["b"]);
  assert.equal(second.draftCards, 2);
  const nothing = pagesCardsView(state, { sourceId: "s1", chapter: 9 }, { now: NOW });
  assert.equal(nothing.cards.length, 0);
  assert.equal(nothing.draftCards, 0);
});

/* The 资料 chapter row: 练这一章 where the chapter has published questions, 从这一章出题 promoted where it has none. */
const sourcesBundle = await build({ stdin: { contents: `export { ChapterList } from './ui/Sources.jsx'; export { setUiLanguage } from './ui/i18n.js';`, resolveDir: process.cwd() },
  bundle: true, write: false, platform: "node", format: "cjs", external: ["react"], plugins: [nativeSelects], loader: { ".css": "text" }, logLevel: "silent" });
const sources = { exports: {} };
new Function("require", "module", "exports", sourcesBundle.outputFiles[0].text)(createRequire(import.meta.url), sources, sources.exports);
const { ChapterList } = sources.exports;
const sourcesRender = (props, language = "zh") => { sources.exports.setUiLanguage(language); try { return renderToStaticMarkup(React.createElement(ChapterList, props)); } finally { sources.exports.setUiLanguage("zh"); } };
const han = /[㐀-鿿]/;
const summary = (levels) => {
  const counts = { new: 0, weak: 0, learning: 0, familiar: 0, mastered: 0 };
  for (const level of levels) counts[level]++;
  return { total: levels.length, counts, due: 0, weak: counts.weak, fresh: counts.new, inactive: 0, percent: 45, state: "learning" };
};
const item = { key: "k", format: "pdf", chapterUnit: "page", chapters: [
  { index: 0, title: "One", level: 1, sourceIds: ["a", "b"], startPage: 1, endPage: 2, chars: 100 },
  { index: 1, title: "Two", level: 1, sourceIds: ["c"], startPage: 3, endPage: 3, chars: 50 },
  { index: 2, title: "Inside", level: 1, sourceIds: [], partial: true, startPage: 3, endPage: 3, chars: 10 }] };
const rows = (html) => html.split("<li ").slice(1);

test("a chapter row offers 练这一章 where the chapter has published questions; one with none promotes 从这一章出题 instead", () => {
  const mastery = { chapters: { 0: summary(["new", "weak", "learning"]), 2: { ...summary([]), total: 0, state: "none", percent: null, draftCards: 3 } } };
  const html = sourcesRender({ item, busy: false, onOpen() {}, onGenerate() {}, onPractice() {}, listId: "x", mastery });
  const [first, second, inside] = rows(html);
  assert.match(first, /练这一章/);
  assert.match(first, /sh-btn--quiet[^>]*>(?:<svg[\s\S]*?<\/svg>)?从这一章出题/, "with questions, generating more stays a quiet second choice");
  assert.doesNotMatch(second, /练这一章/, "no summary at all: the row says 还没出题, there is nothing to practise");
  assert.match(second, /sh-btn--secondary[^>]*>(?:<svg[\s\S]*?<\/svg>)?从这一章出题/, "and generating is the one action offered");
  assert.doesNotMatch(inside, /练这一章/, "drafts are not practisable");
  assert.match(inside, /还没发布 · 草稿里有 3 题/);
  assert.match(inside, /disabled=""[^>]*>(?:<svg[\s\S]*?<\/svg>)?从这一章出题/, "a chapter inside one page still cannot be generated alone");
});

test("练这一章 waits while the page works, is absent where the host cannot start practice, and speaks English", () => {
  const mastery = { chapters: { 0: summary(["new", "weak"]) } };
  assert.match(sourcesRender({ item, busy: true, onOpen() {}, onGenerate() {}, onPractice() {}, listId: "x", mastery }), /disabled=""[^>]*>(?:<svg[\s\S]*?<\/svg>)?练这一章/);
  assert.doesNotMatch(sourcesRender({ item, busy: false, onOpen() {}, onGenerate() {}, listId: "x", mastery }), /练这一章/);
  const english = sourcesRender({ item: { ...item, chapters: item.chapters.map((chapter) => ({ ...chapter, title: "T" })) }, busy: false, onOpen() {}, onGenerate() {}, onPractice() {}, listId: "x", mastery }, "en");
  assert.match(english, /Practise this chapter/);
  assert.doesNotMatch(english.replace(/\bT\b/g, ""), han);
});

/* Each "how well" number has its own name, said in one place (ui/mastery-terms.js): 掌握度 is the level-weighted state of the questions
   (Home, 资料, the reader); the Dashboard's 30-day rates are 达标率 / 客观题通过率 / 自评达标率, and thin data says 数据不足. */
const text = (markup) => markup.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
const days = (counts) => counts.map((count, i) => ({ date: `2026-10-${String(2 + i).padStart(2, "0")}`, count, cards: [] }));
const mastery = { windowDays: 30, minAnswers: 3,
  levels: [{ id: "recall", n: 10, met: 8, rate: 80, enough: true }, { id: "concept", n: 2, met: 1, rate: null, enough: false }, { id: "apply", n: 5, met: 2, rate: 40, enough: true }],
  kinds: [] };
const stats = (totals = {}) => ({ generatedAt: "2026-10-02T04:00:00Z", today: "2026-10-02",
  totals: { attempts: 25, activeDays: 4, streak: 2, due: 8, gradedRate: 33, gradedAttempts: 15, selfRate: 60, selfAttempts: 10, oralAttempts: 0, oralStrong: 0, ...totals },
  heatmap: [], trend: [], forecast: { days: days(Array(14).fill(0)), later: 0 }, mastery, weakTopics: [] });
const statsView = (totals, language = "zh") => render(StatsView, { stats: stats(totals), course: "*", data: { decks: [], focus: {} }, busy: false, onStartScope: noop, onLibrary: noop, onCreate: noop, onSources: noop }, language);

test("mastery-terms names every measure once; 掌握度 belongs to the level-weighted one alone", async () => {
  const { MEASURES, MIN_ANSWERS, TERMS } = await import("../ui/mastery-terms.js");
  assert.equal(MEASURES.mastery.label, "掌握度");
  assert.equal(MEASURES.mastery, TERMS.mastery, "the Home number keeps its words");
  const labels = Object.values(MEASURES).map((measure) => measure.label);
  assert.equal(new Set(labels).size, labels.length, "no two measures share a name");
  for (const [id, measure] of Object.entries(MEASURES)) if (id !== "mastery") assert.doesNotMatch(measure.label + (measure.hint ?? ""), /掌握度/, `${id} is not a mastery number`);
  assert.deepEqual(Object.keys(MEASURES).sort(), ["gradedRate", "mastery", "passRate", "roundGraded", "roundSelf", "selfRate"]);
  assert.equal(MIN_ANSWERS, 3, "the same threshold the server uses for 数据不足");
});

test("the dashboard no longer calls its 30-day rate 掌握度: it is 达标率, and the word is not on the page at all", () => {
  const panel = render(MasteryPanel, { mastery });
  assert.match(text(panel), /达标率/);
  assert.match(text(panel), /近 30 天作答，3 分及以上算达标/);
  assert.doesNotMatch(panel, /掌握度/);
  const empty = render(MasteryPanel, { mastery: { ...mastery, levels: mastery.levels.map((row) => ({ ...row, n: 0, rate: null, enough: false })), kinds: [] } });
  assert.doesNotMatch(empty, /掌握度/);
  assert.match(empty, /达标率/);
  const page = statsView();
  assert.doesNotMatch(page, /掌握度/);
  assert.match(text(page), /客观题通过率 · 15 次/);
  assert.match(text(page), /自评达标率 · 10 次/);
  assert.match(render(MasteryPanel, { mastery }, "en"), /Met rate/);
});

test("a rate over fewer than three answers says 数据不足 instead of a percentage that proves nothing", () => {
  const thin = text(statsView({ gradedRate: 100, gradedAttempts: 1, selfRate: 50, selfAttempts: 2 }));
  assert.equal((thin.match(/数据不足/g) || []).length, 2 + 1, "both hero rates, and the thin concept level in the panel");
  assert.doesNotMatch(thin, /100%/);
  assert.match(thin, /客观题通过率 · 1 次/, "how many answers there were is still said");
  const enough = text(statsView({ gradedRate: 100, gradedAttempts: 3, selfRate: 50, selfAttempts: 0 }));
  assert.match(enough, /100 %/, "three answers are enough");
  assert.equal((enough.match(/数据不足/g) || []).length, 1 + 1, "no answers: the dash it always was; plus the panel");
  assert.match(statsView({ gradedRate: 100, gradedAttempts: 1 }, "en"), /Insufficient data/);
});
