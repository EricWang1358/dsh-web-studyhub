/* WP23 · the 创建题组 form: "02 / 学习方式" as label-left rows (SegmentedControl
   kind/difficulty/language, a count stepper with presets), a collapsed 更多选项,
   a small focus box with an AI assist (帮我想想) and a live summary above the
   one primary button. Pure helpers are tested directly; the layout by SSR. */
import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { build } from "esbuild";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

const compiled = await build({ stdin: { contents: `
  export { default as Generate } from './ui/Generate.jsx';
  export { default as GenerateAssist } from './ui/GenerateAssist.jsx';
  export * as form from './ui/generate-form.js';
  export { setUiLanguage } from './ui/i18n.js';`, resolveDir: process.cwd() },
bundle: true, write: false, platform: "node", format: "cjs", external: ["react"], loader: { ".css": "text" }, logLevel: "silent" });
const module = { exports: {} };
new Function("require", "module", "exports", compiled.outputFiles[0].text)(createRequire(import.meta.url), module, module.exports);
const { Generate, GenerateAssist, form, setUiLanguage } = module.exports;
const han = /[㐀-鿿]/;
const noop = () => {};
const text = (html) => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");

/* ---------- pure helpers ---------- */

test("count helpers clamp to 1-30 and step by one", () => {
  assert.deepEqual([form.COUNT_MIN, form.COUNT_MAX], [1, 30]);
  assert.deepEqual(form.COUNT_PRESETS, [5, 10, 20, 30]);
  assert.equal(form.clampCount(0), 1);
  assert.equal(form.clampCount(99), 30);
  assert.equal(form.clampCount("12"), 12);
  assert.equal(form.clampCount(7.6), 8);
  assert.equal(form.clampCount("abc"), 10, "unreadable input falls back to the default");
  assert.equal(form.clampCount(""), 10);
  assert.equal(form.stepCount(10, 1), 11);
  assert.equal(form.stepCount("10", -1), 9);
  assert.equal(form.stepCount(1, -1), 1, "the minus stops at the minimum");
  assert.equal(form.stepCount(30, 1), 30, "the plus stops at the maximum");
  assert.equal(form.stepCount("", 1), 11, "an emptied field steps from the default");
});

test("suggestCount is roughly one question per two to three PDF pages, clamped to 5-20", () => {
  assert.equal(form.suggestCount({ pages: 0, chars: 0 }), null, "nothing selected, nothing to suggest");
  assert.equal(form.suggestCount({ pages: 2, chars: 0 }), 5, "never below 5");
  assert.equal(form.suggestCount({ pages: 30, chars: 0 }), 12);
  assert.equal(form.suggestCount({ pages: 100, chars: 0 }), 20, "never above 20");
  assert.equal(form.suggestCount({ pages: 0, chars: 3600 }), 5, "short notes");
  assert.equal(form.suggestCount({ pages: 0, chars: 90000 }), 20, "long notes");
  const mixed = form.suggestCount({ pages: 15, chars: 18000 });
  assert.ok(mixed > form.suggestCount({ pages: 15, chars: 0 }), "plain text adds to the PDF pages");
});

test("selectionStats counts documents, PDF pages and plain-text size", () => {
  const sources = [
    ...[1, 2, 3].map((page) => ({ id: `p${page}`, title: `a.pdf · p.${page}`, text: "x".repeat(500), document: { id: "h".repeat(64), format: "pdf", page } })),
    { id: "n", title: "notes", text: "y".repeat(4000) },
    { id: "z", title: "unselected", text: "z".repeat(9000) },
  ];
  assert.deepEqual(form.selectionStats(sources, ["p1", "p2", "n"]), { materials: 2, pages: 2, chars: 4000 });
  assert.deepEqual(form.selectionStats(sources, []), { materials: 0, pages: 0, chars: 0 });
});

test("estimateMinutes reads finished generation jobs and says nothing without data", () => {
  const job = (seconds, count = 10, extra = {}) => ({ status: "complete", count, startedAt: "2026-10-01T10:00:00.000Z",
    finishedAt: new Date(Date.parse("2026-10-01T10:00:00.000Z") + seconds * 1000).toISOString(), ...extra });
  assert.equal(form.estimateMinutes([], 10), null);
  assert.equal(form.estimateMinutes([job(60, 10, { status: "failed" }), { status: "running", count: 10, startedAt: "2026-10-01T10:00:00Z" }], 10), null);
  const range = form.estimateMinutes([job(90), job(90)], 10);
  assert.deepEqual(range, { low: 1, high: 2 });
  assert.deepEqual(form.estimateMinutes([job(90)], 20), { low: 2, high: 4 }, "scales with the question count");
  assert.equal(form.estimateMinutes([job(90, 10, { type: "draft-publish" })], 10), null, "only generation jobs count");
  assert.equal(form.estimateMinutes([job(90, 10, { kind: "case" })], 10), null, "case papers take longer and are excluded");
  const slow = form.estimateMinutes([job(3000)], 10);
  assert.ok(slow.high >= slow.low && slow.low >= 1);
});

test("summaryLine reads as one plain sentence in both languages", () => {
  const base = { materials: 3, pages: 12, count: 10, difficulty: "mixed", language: "中文", minutes: { low: 1, high: 2 } };
  assert.equal(form.summaryLine(base), "将从 3 份资料（约 12 页）出 10 题 · 混合难度 · 中文 · 约 1–2 分钟");
  assert.equal(form.summaryLine({ ...base, pages: 0, minutes: null, difficulty: "advanced", language: "English" }), "将从 3 份资料出 10 题 · 深入辨析 · English");
  assert.equal(form.summaryLine({ ...base, minutes: { low: 2, high: 2 } }).endsWith("约 2 分钟"), true);
  assert.equal(form.summaryLine({ ...base, materials: 0 }), "", "no sources, no summary");
  try {
    setUiLanguage("en");
    const english = form.summaryLine(base);
    assert.doesNotMatch(english, han);
    assert.match(english, /3 materials/);
    assert.match(english, /10 questions/);
  } finally { setUiLanguage("zh"); }
});

test("difficulty and language choices keep their stored values and explain themselves", () => {
  assert.deepEqual(form.DIFFICULTIES.map((item) => item.value), ["mixed", "foundation", "application", "advanced"]);
  assert.deepEqual(form.LANGUAGES.map((item) => item.value), ["中文", "English", "中英双语"]);
  for (const item of form.DIFFICULTIES) assert.ok(form.difficultyNote(item.value).length > 8, item.value);
  assert.equal(form.difficultyNote("nope"), "");
});

test("focus chips append once and the form applies a suggestion without touching other fields", () => {
  assert.equal(form.appendFocus("", "Raft vs Paxos"), "Raft vs Paxos");
  assert.equal(form.appendFocus("Replication", "Raft vs Paxos"), "Replication；Raft vs Paxos");
  assert.equal(form.appendFocus("Replication；Raft vs Paxos", "Raft vs Paxos"), "Replication；Raft vs Paxos", "no duplicates");
  assert.equal(form.focusIncludes("a；b", "b"), true);
  assert.equal(form.focusIncludes("a；b", "c"), false);
  const gen = { kind: "mixed", count: 10, difficulty: "mixed", language: "English", focus: "x", role: "r", title: "T" };
  const next = form.applySuggestion(gen, { count: 8, difficulty: "application", kind: "quiz", focus: ["A"] });
  assert.deepEqual(next, { ...gen, count: 8, difficulty: "application", kind: "quiz" });
  assert.deepEqual(form.applySuggestion(gen, { focus: ["A"] }), gen, "nothing to apply");
  assert.equal(form.hasSettings({ focus: ["A"] }), false);
  assert.equal(form.hasSettings({ count: 8 }), true);
});

test("the target role shows by default only for interview preparation", () => {
  assert.equal(form.roleOpenByDefault({ goal: "interview" }), true);
  assert.equal(form.roleOpenByDefault({ focus: { mode: "interview" } }), true);
  assert.equal(form.roleOpenByDefault({ goal: "exam", focus: { mode: "class" } }), false);
  assert.equal(form.roleOpenByDefault({}), false);
  assert.equal(form.roleOpenByDefault({ role: "后端工程师" }), true, "an already-typed role stays visible");
});

test("courseHasCaseExam reads the stored exam profile only", () => {
  assert.equal(form.courseHasCaseExam({ name: "A", exam: { format: "open-book-case" } }), true);
  assert.equal(form.courseHasCaseExam({ name: "A", exam: { format: "mixed" } }), true);
  assert.equal(form.courseHasCaseExam({ name: "A", exam: { format: "closed-book" } }), false);
  assert.equal(form.courseHasCaseExam({ name: "A" }), false);
  assert.equal(form.courseHasCaseExam(null), false);
});

/* ---------- the form itself ---------- */

const sources = [
  { id: "a", title: "索引笔记", text: "数据库索引加快查找。".repeat(40), courses: ["数据库"] },
  { id: "b", title: "事务笔记.md", text: "事务保证一致性。".repeat(40), courses: ["数据库"], document: { id: "md", format: "markdown" } },
];
const gen = { kind: "mixed", count: 10, difficulty: "mixed", language: "中文", focus: "", role: "" };
function render(patch = {}, props = {}) {
  const data = { root: "lib", decks: [], drafts: [], jobs: [], sources, modelReady: true,
    focus: { course: "数据库", courses: [{ name: "数据库" }] }, ...patch };
  return renderToStaticMarkup(React.createElement(Generate, { data, busy: false, running: false, act: noop, call: noop,
    openDraft: noop, setPage: noop, setNotice: noop, genSource: "files", setGenSource: noop, gen, setGen: noop,
    selectedSources: ["a"], setSelectedSources: noop, setModal: noop, askInChat: noop, openModelSettings: noop, ...props }));
}
const formOf = (html) => html.slice(html.indexOf('class="generate-form'));

test("02 / 学习方式 uses segmented controls, a stepper and presets instead of plain inputs", () => {
  const html = render();
  const section = formOf(html);
  assert.ok(section.length > 100, "the new form wrapper exists");
  assert.doesNotMatch(section, /kind-grid|three-col|<select/, "no equal columns, no dropdowns");
  const groups = [...section.matchAll(/<div role="group" aria-label="([^"]+)" class="sh-seg[^"]*"/g)].map((match) => match[1]);
  for (const label of ["题型", "难度", "语言"]) assert.ok(groups.includes(label), `${label} is a segmented control (${groups})`);
  assert.match(section, /<div role="group" aria-label="语言" class="sh-seg sh-seg--sm/, "language is the small size");
  for (const word of ["测验 \\+ 闪卡", "单选测验", "开放问答", "混合", "基础理解", "应用迁移", "深入辨析", "中英双语"])
    assert.match(section, new RegExp(`sh-seg__item[^>]*>(?:<svg.*?</svg>)?${word}</button>`), word);
  assert.match(section, /aria-label="减少题数"/);
  assert.match(section, /aria-label="增加题数"/);
  assert.match(section, /<input[^>]*type="number"[^>]*min="1"[^>]*max="30"|<input[^>]*max="30"[^>]*type="number"/);
  const presets = [...section.matchAll(/<button[^>]*class="generate-chip generate-preset"[^>]*>(\d+)<\/button>/g)].map((match) => match[1]);
  assert.deepEqual(presets, ["5", "10", "20", "30"]);
  assert.match(section, /generate-preset[^>]*aria-pressed="true"[^>]*>10</, "the current count is pressed");
  assert.match(section, /aria-pressed="true"[^>]*>混合</, "the current difficulty is on");
});

test("the selected difficulty and kind explain themselves in one muted line", () => {
  assert.match(render(), /generate-note[^>]*>[^<]*混合/);
  const advanced = render({}, { gen: { ...gen, difficulty: "advanced" } });
  assert.match(advanced, /generate-note[^>]*>[^<]*相似/);
  assert.match(render({}, { gen: { ...gen, kind: "mixed" } }), /一半单选、一半闪卡/);
});

test("the title and role sit under a collapsed 更多选项; the role opens for interview preparation", () => {
  const closed = formOf(render());
  assert.match(closed, /<details class="sh-disclosure[^"]*"(?![^>]*\sopen)[^>]*>/);
  assert.match(closed, /更多选项/);
  const details = closed.slice(closed.indexOf("更多选项"));
  assert.match(details, /题组名称/);
  assert.match(details, /目标岗位/);
  assert.doesNotMatch(closed.slice(0, closed.indexOf("更多选项")), /目标岗位|题组名称/, "both live inside the disclosure");
  const interview = formOf(render({ focus: { course: "数据库", courses: [{ name: "数据库" }], mode: "interview" } }));
  assert.match(interview, /<details class="sh-disclosure[^"]*"[^>]*\sopen/);
  const typed = formOf(render({}, { gen: { ...gen, role: "后端工程师" } }));
  assert.match(typed, /<details class="sh-disclosure[^"]*"[^>]*\sopen/);
});

test("the focus box is two rows with its assist, chips and the what-is-sent line", () => {
  const section = formOf(render());
  assert.match(section, /<textarea[^>]*rows="2"/);
  assert.match(section, /帮我想想/);
  assert.match(section, /只发送资料标题与目录，不发送全文/);
  assert.match(section, /<button[^>]*data-generate-assist[^>]*>/);
});

test("without a usable model the assist offers local suggestions and never claims AI", () => {
  const section = formOf(render({ modelReady: false }));
  assert.doesNotMatch(section, /帮我想想/);
  assert.match(section, /看看建议/);
  assert.match(section, /不调用模型/);
  assert.doesNotMatch(section, /只发送资料标题与目录/);
});

test("a count hint appears when the materials suggest a different number, and never overwrites the field", () => {
  const section = formOf(render());
  assert.match(section, /generate-hint[^>]*>[^<]*建议 5 题/);
  assert.match(section, /<input[^>]*value="10"/, "the learner's value stays");
  const same = formOf(render({}, { gen: { ...gen, count: 5 } }));
  assert.doesNotMatch(same, /建议 5 题/, "no hint when it already matches");
  const pdf = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((page) => ({ id: `p${page}`, title: `slides.pdf · p.${page}`, text: "x".repeat(900),
    courses: ["数据库"], document: { id: "h".repeat(64), format: "pdf", page, filename: "slides.pdf" } }));
  const big = formOf(render({ sources: pdf }, { selectedSources: pdf.map((page) => page.id) }));
  assert.match(big, /建议 5 题|建议 6 题|建议 \d+ 题/);
});

test("a course with a case exam points to 案例分析题", () => {
  const withExam = render({ courses: [{ name: "数据库", exam: { format: "open-book-case" } }] });
  assert.match(withExam, /这门课考案例题/);
  assert.match(withExam, /<button[^>]*>[^<]*案例分析题/);
  assert.doesNotMatch(render({ courses: [{ name: "数据库", exam: { format: "closed-book" } }] }), /这门课考案例题/);
  assert.doesNotMatch(render(), /这门课考案例题/);
});

test("a live summary sits above the one primary button", () => {
  const html = render();
  const summary = html.match(/<p[^>]*class="generate-summary"[^>]*role="status"[^>]*>(.*?)<\/p>|<p[^>]*role="status"[^>]*class="generate-summary"[^>]*>(.*?)<\/p>/);
  assert.ok(summary, "summary paragraph");
  assert.match(text(summary[0]), /将从 1 份资料出 10 题 · 混合难度 · 中文/);
  assert.ok(html.indexOf("generate-summary") < html.indexOf('data-tour="generate-submit"'), "summary comes first");
  assert.equal((html.match(/sh-btn--primary/g) || []).length, 1, "the submit button stays the only primary action");
  const estimated = render({ jobs: [{ status: "complete", count: 10, startedAt: "2026-10-01T10:00:00.000Z", finishedAt: "2026-10-01T10:01:30.000Z" }] });
  assert.match(text(estimated), /约 1–2 分钟/);
  assert.doesNotMatch(text(html), /约 \d+/, "no estimate without timing data");
  assert.doesNotMatch(render({}, { selectedSources: [] }), /将从/, "nothing to summarise before a source is picked");
});

test("the PDF page warning, tour anchors and the gate keep working", () => {
  const pdf = [1, 2, 3, 4].map((page) => ({ id: `p${page}`, title: `s.pdf · p.${page}`, text: "x".repeat(500), courses: ["数据库"], document: { id: "h".repeat(64), format: "pdf", page } }));
  const html = render({ sources: pdf }, { selectedSources: pdf.map((page) => page.id), gen: { ...gen, count: 2 } });
  assert.match(html, /role="status"[^>]*>已选 4 页 PDF，计划生成 2 题。题数少于页数/);
  assert.match(html, /data-tour="generate-submit"/);
  const gated = render({ modelReady: false });
  assert.match(gated, /sh-setup/);
  assert.doesNotMatch(gated, /type="submit"/);
});

test("the English form has no Chinese UI text", () => {
  try {
    setUiLanguage("en");
    const english = { ...gen, language: "English" };
    for (const html of [render({}, { gen: english }), render({ modelReady: false }, { gen: english }),
      render({ courses: [{ name: "数据库", exam: { format: "open-book-case" } }], focus: { course: "数据库", courses: [], mode: "interview" } }, { gen: english })]) {
      const visible = text(html).replace(/索引笔记|事务笔记\.md|数据库/g, "");
      assert.doesNotMatch(visible, han, visible.match(/.{0,30}[㐀-鿿].{0,30}/)?.[0]);
    }
  } finally { setUiLanguage("zh"); }
});

/* ---------- the assist component ---------- */

const assist = (props = {}) => renderToStaticMarkup(React.createElement(GenerateAssist, { ready: true, phase: "idle", result: null, focus: "", onAsk: noop, onPick: noop, onApply: noop, ...props }));

test("model suggestions show as chips with an apply button and the reason", () => {
  const html = assist({ phase: "done", focus: "Replication", result: { source: "model", focus: ["Replication", "Raft vs Paxos"], count: 8, difficulty: "application", kind: "quiz", why: "Weak on Raft elections." } });
  const chips = [...html.matchAll(/<button[^>]*class="generate-chip generate-suggestion"[^>]*>(.*?)<\/button>/g)];
  assert.equal(chips.length, 2);
  assert.match(chips[0][0], /aria-pressed="true"/, "a chip already in the box is marked");
  assert.match(chips[1][0], /aria-pressed="false"/);
  assert.match(html, /按建议设置/);
  assert.match(html, /8 题/);
  assert.match(html, /应用迁移/);
  assert.match(html, /Weak on Raft elections\./);
  assert.doesNotMatch(html, /来自你的错题与资料目录/);
});

test("local suggestions are labelled as coming from the learner's own data, without an error banner", () => {
  const html = assist({ ready: false, phase: "done", result: { source: "local", focus: ["Raft elections", "Sharding"], unavailable: { reason: "no-model" } } });
  assert.match(html, /来自你的错题与资料目录/);
  assert.doesNotMatch(html, /role="alert"|sh-inline--error/);
  assert.doesNotMatch(html, /按建议设置/, "no settings come from local data");
  assert.equal([...html.matchAll(/generate-suggestion/g)].length, 2);
});

test("a model failure says why in plain words next to the local fallback, with a retry", () => {
  const html = assist({ phase: "done", result: { source: "local", focus: ["Sharding"], unavailable: { reason: "failed", message: "429 Too Many Requests: rate limit" } } });
  assert.match(html, /AI 调用没有成功/);
  assert.match(html, /模型当前限流/);
  assert.match(html, /先给你来自本地数据的建议/);
  assert.match(html, /来自你的错题与资料目录/, "the suggestions that remain are labelled as local");
  assert.match(html, />再试一次<\/button>/);
  assert.doesNotMatch(html, /role="alert"/);
  assert.doesNotMatch(html, /生成没有完成/, "the generic generation-failure line is gone");
});

test("an unknown error shows its short text instead of a generic line", () => {
  const html = assist({ phase: "done", result: { source: "local", focus: ["Sharding"], unavailable: { reason: "failed", message: "model_not_found: deepseek-x" } } });
  assert.match(text(html), /AI 调用没有成功：model_not_found: deepseek-x/);
  assert.doesNotMatch(html, /生成没有完成/);
});

test("an answer in the wrong format says so and offers to show the answer", () => {
  const html = assist({ phase: "done", result: { source: "local", focus: ["Sharding"], unavailable: { reason: "nothing-usable", sample: '{"note":"here you go"}' } } });
  assert.match(html, /AI 的回答不是约定的格式/);
  assert.match(html, /<details[^>]*>.*看 AI 的回答.*<pre>[^<]*here you go/s);
  assert.match(html, />再试一次<\/button>/);
});

test("with no model the line offers the model settings, and the retry button asks again", () => {
  const html = assist({ ready: true, phase: "done", onSettings: noop, result: { source: "local", focus: ["Sharding"], unavailable: { reason: "no-model" } } });
  assert.match(text(html), /还没有可用的 AI 模型/);
  assert.match(html, /打开模型设置/);
  assert.doesNotMatch(html, />再试一次<\/button>/, "retrying cannot help before a model exists");
  const quiet = assist({ ready: false, phase: "done", result: { source: "local", focus: ["Sharding"], unavailable: { reason: "no-model" } } });
  assert.doesNotMatch(quiet, /还没有可用的 AI 模型/, "a learner who knowingly has no model is not nagged: the button already says it is local");
});

test("the failure line has the retry as an sh- button and no Han in English", () => {
  const asks = [];
  const element = React.createElement(GenerateAssist, { ready: true, phase: "done", result: { source: "local", focus: ["Sharding"], unavailable: { reason: "failed", message: "boom" } }, focus: "", onAsk: () => asks.push(1), onPick: noop, onApply: noop });
  const html = renderToStaticMarkup(element);
  assert.match(html, /<button[^>]*class="[^"]*sh-btn[^"]*"[^>]*>再试一次<\/button>/);
  setUiLanguage("en");
  try {
    for (const unavailable of [{ reason: "failed", message: "boom" }, { reason: "failed", message: "429 rate limit" }, { reason: "nothing-usable", sample: "{}" }, { reason: "no-model" }]) {
      const english = renderToStaticMarkup(React.createElement(GenerateAssist, { ready: true, phase: "done", onSettings: noop, result: { source: "local", focus: ["Sharding"], unavailable }, focus: "", onAsk: noop, onPick: noop, onApply: noop }));
      assert.doesNotMatch(english, han, `English line for ${unavailable.reason}`);
    }
    assert.match(text(renderToStaticMarkup(element)), /The AI call did not succeed: boom\. Showing suggestions from your own data instead; you can try again\./);
    assert.match(renderToStaticMarkup(element), />Try again</);
  } finally { setUiLanguage("zh"); }
});

test("nothing to suggest says so quietly, and the button shows its busy state", () => {
  assert.match(assist({ phase: "done", result: { source: "local", focus: [] } }), /还没有可以推荐的内容/);
  assert.match(assist({ phase: "loading" }), /sh-btn--busy|aria-busy="true"/);
});
