import test from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { loadUi } from "./helpers/ui-module.mjs";

/* #660 (the counter and the re-ask), #672 (feedback in plain words, inside the card), #673 (every tick of the rail says what it is). */

const m = await loadUi(`
  export { roundAt, roundWords, tickWords } from './ui/review/round-words.js';
  export { NextDue, nextDueWhen } from './ui/NextDue.jsx';
  export { default as ReviewNavigator } from './ui/ReviewNavigator.jsx';
  export { StudyServicesContext } from './ui/study-context.jsx';
  export { setUiLanguage } from './ui/i18n.js';
`);
const text = (html) => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
const han = /[㐀-鿿]/;

test("#660: the counter is 2 / 4 whatever a wrong answer queues, and the re-ask has its own words", () => {
  const first = { total: 4, at: 1, retries: 0, retryAt: 0, last: false };
  assert.deepEqual(m.roundWords(first), { main: "1 / 4", note: "" });
  assert.deepEqual(m.roundWords({ total: 4, at: 2, retries: 1, retryAt: 0, last: false }), { main: "2 / 4", note: "稍后再练 1 题" }, "after a wrong answer: the same 4, and one re-ask waits");
  assert.deepEqual(m.roundWords({ total: 4, at: 2, retries: 3, retryAt: 0, last: false }), { main: "2 / 4", note: "稍后再练 3 题" }, "wrong three times: still 4");
  assert.deepEqual(m.roundWords({ total: 4, at: 4, retries: 2, retryAt: 2, last: true }), { main: "再练 2 / 2", note: "" }, "on the re-ask itself");
});

test("#660: a run without a position (a mock exam, an older host) shows its own index and total", () => {
  assert.deepEqual(m.roundAt({ index: 1, total: 5 }), { total: 5, at: 2, retries: 0, retryAt: 0, last: false });
  assert.equal(m.roundAt({ index: 4, total: 5 }).last, true);
  assert.equal(m.roundAt({ index: 0, total: 5, position: { total: 4, at: 1, retries: 1, retryAt: 0, last: false } }).total, 4, "the round's position wins");
});

test("#660: English words", () => {
  m.setUiLanguage("en");
  try {
    assert.deepEqual(m.roundWords({ total: 4, at: 2, retries: 1, retryAt: 0, last: false }), { main: "2 / 4", note: "1 to retry later" });
    assert.equal(m.roundWords({ total: 4, at: 4, retries: 1, retryAt: 1, last: true }).main, "Retry 1 / 1");
  } finally { m.setUiLanguage("zh"); }
});

const NOW = Date.parse("2026-11-05T12:00:00Z"), days = (n) => new Date(NOW + n * 86400000).toISOString();
const due = (feedback, props = {}) => text(renderToStaticMarkup(React.createElement(m.NextDue, { feedback, now: NOW, ...props })));

test("#672: the line says when the question comes back in days, in plain words, and no scheduler term is on the surface until asked", () => {
  const feedback = { correct: true, level: "learning", nextDue: days(3), beforeLevel: "new", beforeDays: 0, afterDays: 3, stability: 2.3 };
  assert.equal(m.nextDueWhen(feedback, NOW), "下次大约 3 天后再见");
  const html = renderToStaticMarkup(React.createElement(m.NextDue, { feedback, now: NOW }));
  assert.match(text(html), /^答对了 · 下次大约 3 天后再见/);
  const open = html.indexOf("<details"), shut = html.indexOf("</summary>");
  assert.ok(open > 0, "the numbers sit in a fold");
  assert.doesNotMatch(html.slice(0, open), /稳定度|首轮间隔|间隔/, "nothing technical before the fold");
  assert.doesNotMatch(html.slice(0, shut), /稳定度|首轮间隔/, "nor in its summary");
  assert.match(html.slice(open, shut), /为什么是 3 天/);
  assert.doesNotMatch(html, /<details[^>]*\sopen/, "shut by default");
  const folded = text(html.slice(shut));
  assert.match(folded, /稳定度 2\.3 天/);
  assert.match(folded, /稳定度：系统估计你能把这道题记住多久/, "each term comes with its plain meaning");
  assert.match(folded, /复习间隔：这道题隔多少天再出现/);
});

test("#672: a question due within the day, a miss and the re-ask note", () => {
  assert.match(due({ correct: true, level: "learning", nextDue: days(0.2) }), /^答对了 · 下次今天内再见/);
  assert.match(due({ correct: false, level: "weak", nextDue: days(1), retryQueued: true }), /^↻ 将继续巩固 · 下次大约 1 天后再见 · 这道题放到了本轮最后，会再出现一次/);
  assert.match(due({ correct: true, level: "mastered", nextDue: days(40) }), /^✓ 已掌握 · 下次大约 40 天后再见/);
  assert.match(due({ correct: true, level: "mastered", nextDue: days(120) }), /下次大约 4 个月后再见/);
});

test("#672: English", () => {
  m.setUiLanguage("en");
  try {
    const html = renderToStaticMarkup(React.createElement(m.NextDue, { feedback: { correct: true, level: "learning", nextDue: days(3), afterDays: 3, beforeDays: 0, stability: 3.2 }, now: NOW }));
    assert.match(text(html), /^Correct · see it again in about 3 d/);
    assert.match(html, /Why 3 d/);
    assert.doesNotMatch(html, han);
  } finally { m.setUiLanguage("zh"); }
});

const item = (extra) => ({ index: 1, cardId: "q2", deckId: "d", topic: "一致性哈希", level: "learning", answered: false, ...extra });

test("#673: each tick says its number, topic, what happened and its mastery colour in words", () => {
  assert.equal(m.tickWords(item({}), "学习中"), "第 2 题 · 一致性哈希 · 还没做 · 掌握程度：学习中");
  assert.equal(m.tickWords(item({ answered: true, passed: true }), "熟悉"), "第 2 题 · 一致性哈希 · 答对了 · 掌握程度：熟悉");
  assert.equal(m.tickWords(item({ answered: true, passed: false }), "薄弱"), "第 2 题 · 一致性哈希 · 答错了 · 掌握程度：薄弱");
  assert.equal(m.tickWords(item({ index: 4, retry: true }), "薄弱"), "再练 · 一致性哈希 · 还没做 · 掌握程度：薄弱", "a re-ask is not numbered as another question");
});

test("#673: the rail's ticks are named for the screen reader and for hover, not by a title attribute", () => {
  const run = { id: "r", index: 0, navigation: [item({ index: 0, answered: true, passed: true }), item({ index: 1, level: "weak" }), item({ index: 2, retry: true, level: "weak" })] };
  const html = renderToStaticMarkup(React.createElement(m.StudyServicesContext.Provider, { value: { busy: false } }, React.createElement(m.ReviewNavigator, { run, onJump() {} })));
  const ticks = html.match(/<button[^>]*class="review-tick"[^>]*>/g) || [];
  assert.equal(ticks.length, 3);
  assert.match(ticks[0], /aria-label="第 1 题 · 一致性哈希 · 答对了 · 掌握程度：学习中"/);
  assert.match(ticks[1], /aria-label="第 2 题 · 一致性哈希 · 还没做 · 掌握程度：薄弱"/);
  assert.match(ticks[2], /aria-label="再练 · /);
  assert.match(ticks[2], /data-retry="true"/);
  for (const tick of ticks) assert.doesNotMatch(tick, /\stitle=/, "the shared Tooltip, never title= on text");
  assert.equal((html.match(/role="tooltip"/g) || []).length, 3, "each tick has its tooltip card in the page, hidden until hover or focus");
});
