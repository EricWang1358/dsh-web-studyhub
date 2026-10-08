/* WP25 · 模拟考试: one page, three formats (选择题笔试 / 案例分析卷 / 口头面试), one setup
   card each with "怎么考", settings and a start footer, and one recent-exams
   list. Pure helpers plus server-rendered markup. */
import test from "node:test";
import { nativeSelects } from "./helpers/native-selects.mjs";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { build } from "esbuild";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

const compiled = await build({ stdin: { contents: `export * from './ui/exam-format.js';
  export { default as Exam } from './ui/Exam.jsx'; export { OralSetup } from './ui/OralExam.jsx';
  export { CasePaper } from './ui/CaseWorkspace.jsx'; export { RecentExams } from './ui/ExamShell.jsx';
  export { setUiLanguage } from './ui/i18n.js';`, resolveDir: process.cwd() },
  bundle: true, write: false, platform: "node", format: "cjs", external: ["react"], plugins: [nativeSelects], loader: { ".css": "text" }, logLevel: "silent" });
const module = { exports: {} };
new Function("require", "module", "exports", compiled.outputFiles[0].text)(createRequire(import.meta.url), module, module.exports);
const { defaultExamFormat, recentExams, filterRecent, shortDeckTitles, Exam, OralSetup, CasePaper, RecentExams, setUiLanguage } = module.exports;
const han = /[㐀-鿿]/;
const noop = () => {};
const render = (type, props, language = "zh") => { setUiLanguage(language); try { return renderToStaticMarkup(React.createElement(type, props)); } finally { setUiLanguage("zh"); } };

const decks = [
  { id: "q1", title: "CS5224 · Final paper 05", course: "CS5224", examCount: 36, examQuizCount: 18, examMultiCount: 18, available: 36 },
  { id: "q2", title: "CS5224 · Final paper 06", course: "CS5224", examCount: 20, examQuizCount: 10, examMultiCount: 10, available: 20 },
  { id: "c1", title: "Orchard case", format: "case-study", course: "CS5224", caseMarks: 10, count: 2, caseBest: { total: 7, max: 10 } },
];
const courses = [{ id: "course-1", name: "CS5224", exam: { format: "open-book-case", totalMarks: 60, writingMinutes: 120, readingMinutes: 15 } },
  { id: "course-2", name: "Databases", exam: { format: "closed-book" } }, { id: "course-3", name: "Networks" }];
const data = {
  root: "wp25", model: { ready: true, reason: "ok" }, decks, courses, sources: [], runs: [], drafts: [], jobs: [],
  focus: { course: "*", courses: courses.map((course) => ({ name: course.name })) },
  exams: [
    { runId: "e1", submittedAt: "2026-09-30T10:00:00.000Z", scorePct: 80, correct: 8, total: 10, examKinds: "all", decks: ["CS5224 · Final paper 05"] },
    { runId: "e2", submittedAt: "2026-09-29T10:00:00.000Z", scorePct: 70, correct: 7, total: 10, examKinds: "case", decks: ["Orchard case"] },
  ],
  oralExams: [{ runId: "o1", submittedAt: "2026-09-28T10:00:00.000Z", total: 5, assessed: 5, strong: 3, developing: 1, weak: 1 }],
};
const withStorage = (entries, work) => {
  const store = new Map(Object.entries(entries));
  globalThis.sessionStorage = { getItem: (key) => store.get(key) ?? null, setItem: (key, value) => store.set(key, value), removeItem: (key) => store.delete(key) };
  try { return work(); } finally { delete globalThis.sessionStorage; }
};
const pressed = (html, label) => new RegExp(`aria-pressed="true"[^>]*>(?:<svg[\\s\\S]*?</svg>)?${label}`).test(html);

test("the default format follows the course's exam profile: an open-book case course opens on 案例分析卷", () => {
  assert.equal(defaultExamFormat(data, "CS5224"), "case");
  assert.equal(defaultExamFormat(data, "Databases"), "written", "a closed-book course sits a written paper");
  assert.equal(defaultExamFormat(data, "Networks"), "written", "no exam profile: written");
  assert.equal(defaultExamFormat(data, "*"), "written");
  assert.equal(defaultExamFormat({}, "CS5224"), "written");
});

test("deck titles lose the prefix every deck shares and the course's own name", () => {
  assert.deepEqual(shortDeckTitles([{ id: "a", title: "CS5224 · 期末综合卷05" }, { id: "b", title: "CS5224 · 期末综合卷06" }]),
    { a: "期末综合卷05", b: "期末综合卷06" });
  assert.deepEqual(shortDeckTitles([{ id: "a", title: "A questions" }, { id: "b", title: "B questions" }]), { a: "A questions", b: "B questions" });
  assert.deepEqual(shortDeckTitles([{ id: "a", title: "CS5224 Midterm" }], "CS5224"), { a: "Midterm" });
  assert.deepEqual(shortDeckTitles([{ id: "a", title: "CS5224" }], "CS5224"), { a: "CS5224" }, "never an empty title");
  assert.deepEqual(shortDeckTitles([{ id: "a", title: "Paper" }, { id: "b", title: "Paper" }]), { a: "Paper", b: "Paper" });
});

test("recent exams of all three formats share one list: tagged, newest first, with the course when known", () => {
  const all = recentExams(data);
  assert.deepEqual(all.map((item) => [item.kind, item.runId]), [["written", "e1"], ["case", "e2"], ["oral", "o1"]]);
  assert.equal(all[0].course, "CS5224");
  assert.equal(all[2].course, "");
  assert.deepEqual(filterRecent(all, "case").map((item) => item.runId), ["e2"]);
  assert.equal(filterRecent(all, "all").length, 3);
  assert.deepEqual(recentExams({}), []);
});

test("模拟考试 is one page with one 考试形式 switch of three formats; the old corner links are gone", () => withStorage({}, () => {
  const html = render(Exam, { call: noop, data, onExit: noop });
  assert.match(html, /<h1[^>]*>模拟考试<\/h1>/);
  assert.match(html, /aria-label="考试形式"/);
  for (const label of ["选择题笔试", "案例分析卷", "口头面试"]) assert.ok(html.includes(label), label);
  assert.ok(pressed(html, "选择题笔试"), "written is the default");
  assert.equal((html.match(/课程范围/g) || []).length, 1, "the course scope is chosen in one place");
  assert.match(html, /data-tour="exam-case"/);
  assert.match(html, /data-tour="exam-start"/);
  assert.doesNotMatch(html, /案例分析卷 →|切换到口头面试 →|切换到限时笔试|exam-mode-switch/);
}));

test("选择题笔试 setup: 怎么考 steps, compact decks, 题型, 题数 presets, one start button and a summary line", () => withStorage({}, () => {
  const html = render(Exam, { call: noop, data, onExit: noop });
  assert.match(html, /怎么考/);
  assert.equal((html.match(/<li class="es-step"/g) || []).length, 5);
  assert.match(html, /<details class="sh-disclosure es-how"(?![^>]*\sopen)[^>]*>\s*<summary[^>]*>[\s\S]*?怎么考/, "怎么考 is folded: the five steps are one click away, not on the way to 开始考试");
  assert.match(html, /限时 30 分钟/);
  assert.match(html, /aria-label="限时（分钟）"/, "the limit is a field on the card, not only a sentence");
  for (const preset of ["15", "30", "45", "60"]) assert.match(html, new RegExp(`aria-pressed="(true|false)"[^>]*>${preset}<`));
  assert.match(html, /aria-pressed="true"[^>]*>30</, "the default limit is the pressed preset");
  assert.match(html, /默认 30 分钟 · 到时自动交卷/, "and the card says why, and that the paper is handed in at the limit");
  assert.match(html, /Final paper 05[\s\S]*单选 18 · 多选 18/);
  assert.doesNotMatch(html, />CS5224 · Final paper 05</, "the shared prefix is dropped from the visible deck name");
  assert.match(html, /title="CS5224 · Final paper 05"/, "the full title stays as a tooltip");
  assert.match(html, /exam-type-settings/);
  assert.match(html, /aria-label="题数"/);
  for (const preset of ["5", "10", "20"]) assert.match(html, new RegExp(`aria-pressed="(true|false)"[^>]*>${preset}<`));
  assert.match(html, />全选<\/button>/);
  assert.match(html, /disabled=""[^>]*>全选<\/button>/, "全选 is disabled when everything is picked");
  assert.match(html, /10 题 · 限时 30 分钟/);
  assert.equal((html.match(/sh-btn--primary/g) || []).length, 1, "one primary action");
  assert.match(html, /开始考试/);
}));

test("the limit follows the course's own 作答时间 and says so; a limit the learner chose is kept for this tab", () => {
  const scoped = { ...data, focus: { ...data.focus, course: "CS5224" } };
  const formatKey = `study-page-scope:v1:${JSON.stringify(["wp25", "exam-format"])}`;
  const limitKey = `study-page-scope:v1:${JSON.stringify(["wp25", "exam-limit"])}`;
  withStorage({ [formatKey]: JSON.stringify("written") }, () => {
    const html = render(Exam, { call: noop, data: scoped, onExit: noop });
    assert.match(html, /10 题 · 限时 120 分钟/);
    assert.match(html, /取自课程「CS5224」的作答时间 120 分钟 · 到时自动交卷/);
    assert.match(html, /aria-pressed="true"[^>]*>120</, "the course's own time is a one-click preset");
    assert.match(html, /点「开始考试」，限时 120 分钟/);
  });
  withStorage({ [formatKey]: JSON.stringify("written"), [limitKey]: JSON.stringify(JSON.stringify({ course: "CS5224", minutes: 45 })) }, () => {
    const html = render(Exam, { call: noop, data: scoped, onExit: noop });
    assert.match(html, /10 题 · 限时 45 分钟/);
    assert.match(html, /aria-pressed="true"[^>]*>45</);
    assert.match(html, /已改；课程设置是 120 分钟 · 到时自动交卷/);
  });
  withStorage({ [formatKey]: JSON.stringify("written"), [limitKey]: JSON.stringify(JSON.stringify({ course: "Databases", minutes: 45 })) }, () => {
    assert.match(render(Exam, { call: noop, data: scoped, onExit: noop }), /限时 120 分钟/, "a limit chosen for another course is not carried over");
  });
  withStorage({}, () => {
    const several = render(Exam, { call: noop, data, onExit: noop });
    assert.match(several, /限时 30 分钟/, "all courses: no single profile, the default");
  });
});

test("the chosen format survives a reload: a saved choice wins over the profile default", () => {
  const key = `study-page-scope:v1:${JSON.stringify(["wp25", "exam-format"])}`;
  withStorage({ [key]: JSON.stringify("oral") }, () => {
    const html = render(Exam, { call: noop, data, onExit: noop });
    assert.ok(pressed(html, "口头面试"));
    assert.match(html, /<h1[^>]*>模拟考试<\/h1>/, "the header stays while the oral exam restores");
  });
  withStorage({ [key]: JSON.stringify("case") }, () => {
    const html = render(Exam, { call: noop, data, onExit: noop });
    assert.ok(pressed(html, "案例分析卷"));
    assert.match(html, /Orchard case/);
  });
  withStorage({}, () => {
    const profileCourse = { ...data, focus: { ...data.focus, course: "CS5224" } };
    assert.ok(pressed(render(Exam, { call: noop, data: profileCourse, onExit: noop }), "案例分析卷"), "no choice yet: the course profile decides");
    assert.ok(pressed(render(Exam, { call: noop, data, onExit: noop, initialKind: "oral" }), "口头面试"), "a deep link wins");
    assert.ok(pressed(render(Exam, { call: noop, data: profileCourse, onExit: noop, initialKind: "exam", initialRunId: "e1" }), "选择题笔试"), "a written report link opens the written format");
  });
});

test("案例分析卷 setup: pick a paper, reading and writing time from the course profile, marks, rubric grading and the model gate", () => withStorage({}, () => {
  const props = { call: async () => { throw new Error("Capability unavailable"); }, data: { ...data, focus: { ...data.focus, course: "CS5224" } }, onExit: noop, onCreate: noop, course: "CS5224", onCourseChange: noop };
  const html = render(CasePaper, props);
  assert.match(html, /怎么考/);
  assert.match(html, /<details class="sh-disclosure es-how"(?![^>]*\sopen)/, "the same fold on every format's card");
  assert.match(html, /Orchard case[\s\S]*2 题 · 10 分[\s\S]*最好成绩 7\/10/);
  assert.match(html, /新出一份案例卷/);
  assert.match(html, /开卷案例/, "the course's exam format is shown");
  assert.match(html, /满分 10 分/);
  assert.match(html, /阅读 15 分钟 · 作答 20 分钟（每分约 2 分钟）· 共 35 分钟/, "the course profile sets the time model");
  assert.match(html, /每分用时（分钟）[\s\S]*value="2"/);
  assert.match(html, /阅读时间（分钟）[\s\S]*value="15"/);
  const plain = render(CasePaper, { ...props, course: "Networks" , data: { ...props.data, decks: decks.map((deck) => ({ ...deck, course: "Networks" })) } });
  assert.match(plain, /阅读 6 分钟 · 作答 30 分钟（每分约 3 分钟）/, "no exam profile: the defaults");
  assert.match(html, /纸笔练习模式/);
  assert.match(html, /按评分标准逐条给分/);
  assert.doesNotMatch(html, /sh-setup/, "no model gate while a model is ready");
  const gated = render(CasePaper, { ...props, data: { ...props.data, model: { ready: false, reason: "no-route" } }, onSetupModel: noop });
  assert.match(gated, /sh-setup/);
  assert.match(gated, /批改要调用 AI 模型/, "the one shared 批改 gate (ModelSetupGate), not a page-own card");
  assert.match(gated, /打开模型设置/);
  assert.equal((gated.match(/sh-btn--primary/g) || []).length, 2, "the start button plus the gate's own fix action");
  const empty = render(CasePaper, { ...props, data: { ...props.data, decks: [] } });
  assert.match(empty, /还没有案例分析题组/);
  assert.match(empty, /新出一份案例卷/);
  assert.match(empty, /怎么考/, "an empty library still explains the format");
}));

test("口头面试 setup explains itself plainly, with 3/5/8 presets and without promising voice input", () => {
  const html = render(OralSetup, { data, count: 5, onCount: noop, onStart: noop, scopeNote: "沿用勾选的 2 个题组", busy: false, canStart: true });
  assert.match(html, /怎么考/);
  assert.equal((html.match(/<li class="es-step"/g) || []).length, 5);
  assert.match(html, /追问一次/);
  assert.match(html, /没有语音输入/);
  assert.match(html, /整场结束后/);
  assert.match(html, /发给 AI 模型的内容/);
  for (const preset of ["3", "5", "8"]) assert.match(html, new RegExp(`aria-pressed="(true|false)"[^>]*>${preset}<`));
  assert.match(html, /aria-pressed="true"[^>]*>5</);
  assert.match(html, /5 题 · 约 10–15 分钟/);
  assert.match(html, /开始口头模拟/);
  assert.equal((html.match(/sh-btn--primary/g) || []).length, 1);
  assert.doesNotMatch(html, /sh-setup|没有连接 AI 模型/, "a ready model is not nagged about");
  const noModel = render(OralSetup, { data: { ...data, model: { ready: false, reason: "no-route" } }, count: 3, onCount: noop, onStart: noop, onSetupModel: noop, canStart: true });
  assert.match(noModel, /还没有可用的 AI 模型/, "the shared inline gate");
  assert.match(noModel, /追问会用固定问题/, "and what the oral exam does without a model");
  assert.match(noModel, /打开模型设置/);
  const none = render(OralSetup, { data, count: 3, onCount: noop, onStart: noop, canStart: false });
  assert.match(none, /disabled=""[^>]*>[^<]*开始口头模拟|disabled=""[^>]*>[\s\S]*?先出一些题/);
});

test("recent exams: format tag, score or status, date, course and 查看报告; filtered to the current format with a 全部 toggle", () => {
  const items = recentExams(data);
  const written = render(RecentExams, { items, format: "written", onOpen: noop });
  assert.match(written, /最近考试/);
  assert.match(written, /选择题/);
  assert.match(written, /80%/);
  assert.match(written, /CS5224/);
  assert.match(written, /查看报告/);
  assert.doesNotMatch(written, /Orchard case|回答扎实/, "other formats are filtered out");
  assert.match(written, /aria-pressed="true"[^>]*>选择题</);
  assert.match(written, />全部</);
  const all = render(RecentExams, { items, format: "written", filter: "all", onOpen: noop });
  assert.match(all, /案例/);
  assert.match(all, /口头/);
  assert.match(all, /3 题回答扎实|3 题答得扎实/);
  assert.equal((all.match(/查看报告/g) || []).length, 3);
  const unassessed = render(RecentExams, { items: recentExams({ ...data, oralExams: [{ ...data.oralExams[0], assessed: 0, strong: 0 }] }), format: "oral", onOpen: noop });
  assert.match(unassessed, /尚未评估/);
  const nothingHere = render(RecentExams, { items: items.filter((item) => item.kind !== "oral"), format: "oral", onOpen: noop });
  assert.match(nothingHere, /还没有口头面试记录/);
  assert.match(nothingHere, /查看全部/);
  assert.equal(render(RecentExams, { items: [], format: "written", onOpen: noop }), "", "no history, no section");
});

test("English: every format's setup and the recent list are fully translated", () => withStorage({}, () => {
  const english = { ...data, decks: decks.map((deck) => ({ ...deck })), focus: { ...data.focus, course: "CS5224" } };
  const pages = [
    render(Exam, { call: noop, data: { ...english, focus: { ...english.focus, course: "Databases" } }, onExit: noop }, "en"),
    render(CasePaper, { call: async () => { throw new Error("Capability unavailable"); }, data: english, onExit: noop, onCreate: noop, course: "CS5224", onCourseChange: noop }, "en"),
    render(CasePaper, { call: async () => { throw new Error("Capability unavailable"); }, data: { ...english, model: { ready: false } }, onExit: noop, onCreate: noop, onSetupModel: noop, course: "CS5224", onCourseChange: noop }, "en"),
    render(OralSetup, { data: { ...data, model: { ready: false } }, count: 5, onCount: noop, onStart: noop, onSetupModel: noop, canStart: true, scopeNote: "" }, "en"),
    render(RecentExams, { items: recentExams(data), format: "written", filter: "all", onOpen: noop }, "en"),
  ];
  // The written setup with the course's own time, and with a time the learner changed.
  const formatKey = `study-page-scope:v1:${JSON.stringify(["wp25", "exam-format"])}`, limitKey = `study-page-scope:v1:${JSON.stringify(["wp25", "exam-limit"])}`;
  pages.push(withStorage({ [formatKey]: JSON.stringify("written") }, () => render(Exam, { call: noop, data: english, onExit: noop }, "en")));
  pages.push(withStorage({ [formatKey]: JSON.stringify("written"), [limitKey]: JSON.stringify(JSON.stringify({ course: "CS5224", minutes: 45 })) }, () => render(Exam, { call: noop, data: english, onExit: noop }, "en")));
  pages.push(withStorage({ [formatKey]: JSON.stringify("written") }, () => render(Exam, { call: noop, data: { ...english, focus: { ...english.focus, course: "Networks" } }, onExit: noop }, "en")));
  assert.match(pages[5], /Time limit \(minutes\)/);
  assert.match(pages[5], /From the answering time of course “CS5224”: 120 minutes/);
  assert.match(pages[6], /Changed; the course setting is 120 minutes/);
  for (const html of pages) assert.doesNotMatch(html.replace(/CS5224 · Final paper 0\d|Orchard case|Final paper 0\d/g, ""), han, "no untranslated application copy");
  assert.match(pages[0], /Exam format/);
  assert.match(pages[0], /How it works/);
  assert.match(pages[3], /Type the key points/);
}));
