/* WP12 · case practice in the UI: highlights and the phases of a timed case
   paper (pure helpers), and server-rendered views — rubric results with
   per-criterion rows, the case paper report, the scenario panel, the rubric
   answer that replaces self-rating in review, and the entry points in
   创建题组 and 模拟考试. */
import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { build } from "esbuild";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  addHighlight, removeHighlight, recolorHighlight, annotateHighlight, segmentParagraph, paperPhase, phaseRemaining, canType,
  tickQuestion, livePace, readSession, writeSession,
} from "../ui/case-session.js";
import { paperPlan } from "../lib/case-study.js";
import { reviewElement } from "./helpers/review-render.mjs";

const compiled = await build({ stdin: { contents: `export { RubricResult, CaseReport, RubricSkills } from './ui/CaseResult.jsx';
  export { ScenarioPanel, RubricAnswer, CasePaper, CaseDraftHeader, CriteriaEditor } from './ui/CaseWorkspace.jsx'; export { default as Generate } from './ui/Generate.jsx';
  export { default as Exam } from './ui/Exam.jsx'; export { default as Review } from './ui/Review.jsx'; export { setUiLanguage } from './ui/i18n.js';
  export { StudyServicesContext } from './ui/study-context.jsx';
  export { default as DocumentViewer } from './ui/document-preview/DocumentViewer.jsx';`,
  resolveDir: process.cwd() }, bundle: true, write: false, platform: "node", format: "cjs", external: ["react"], loader: { ".css": "text" }, logLevel: "silent" });
const module = { exports: {} };
new Function("require", "module", "exports", compiled.outputFiles[0].text)(createRequire(import.meta.url), module, module.exports);
const { RubricResult, CaseReport, RubricSkills, ScenarioPanel, RubricAnswer, CasePaper, CaseDraftHeader, CriteriaEditor, Generate, Exam, Review, StudyServicesContext, setUiLanguage } = module.exports;
const han = /[㐀-鿿]/;
const render = (type, props) => renderToStaticMarkup(type === Review ? reviewElement(Review, StudyServicesContext, props) : React.createElement(type, props));
const noop = () => {};

test("highlights: a new mark paints over older ones, pieces cover the paragraph, notes and colours change in place", () => {
  let list = addHighlight([], { id: "a", paragraph: 2, start: 0, end: 10, color: "yellow" });
  list = addHighlight(list, { id: "b", paragraph: 2, start: 4, end: 6, color: "green" });
  assert.deepEqual(list.map((item) => [item.color, item.start, item.end]), [["yellow", 0, 4], ["green", 4, 6], ["yellow", 6, 10]]);
  list = addHighlight(list, { id: "c", paragraph: 3, start: 1, end: 2, color: "blue" });
  assert.equal(list.filter((item) => item.paragraph === 2).length, 3, "other paragraphs are untouched");
  const pieces = segmentParagraph("0123456789AB", list.filter((item) => item.paragraph === 2));
  assert.equal(pieces.map((piece) => piece.text).join(""), "0123456789AB");
  assert.deepEqual(pieces.map((piece) => piece.color || null), ["yellow", "green", "yellow", null]);
  assert.equal(recolorHighlight(list, "b", "pink").find((item) => item.id === "b").color, "pink");
  assert.equal(annotateHighlight(list, "b", " power cut ").find((item) => item.id === "b").note, "power cut");
  assert.equal(annotateHighlight(annotateHighlight(list, "b", "x"), "b", "").find((item) => item.id === "b").note, undefined);
  assert.equal(removeHighlight(list, "b").length, list.length - 1);
});

test("a timed paper: reading locks the editors, writing is timed, paper practice opens an untimed transcription", () => {
  const start = Date.parse("2026-10-01T09:00:00Z"), at = (minutes) => start + minutes * 60000;
  const session = { startedAt: new Date(start).toISOString(), readingMinutes: 10, writingMinutes: 30 };
  assert.equal(paperPhase(session, at(5)), "reading");
  assert.equal(canType("reading", false), false, "the editor is locked while reading");
  assert.equal(phaseRemaining(session, at(5)), 5 * 60000);
  assert.equal(paperPhase(session, at(12)), "writing");
  assert.equal(canType("writing", false), true);
  assert.equal(phaseRemaining(session, at(12)), 28 * 60000);
  assert.equal(paperPhase(session, at(41)), "over");
  assert.equal(paperPhase({ ...session, readingEndedAt: new Date(at(2)).toISOString() }, at(3)), "writing", "reading can end early");
  const paper = { ...session, handwriting: true };
  assert.equal(paperPhase(paper, at(20)), "writing");
  assert.equal(canType("writing", true), false, "paper practice hides the editor while timed");
  assert.equal(paperPhase(paper, at(45)), "transcribe");
  assert.equal(canType("transcribe", true), true);
  assert.equal(paperPhase({ ...paper, writingEndedAt: new Date(at(25)).toISOString() }, at(26)), "transcribe");
  assert.equal(paperPhase({ ...session, submittedAt: "x" }, at(12)), "submitted");
  assert.deepEqual(tickQuestion({ q1: 1000 }, "q1", 1000), { q1: 2000 });
  assert.deepEqual(tickQuestion({ q1: 1000 }, null, 1000), { q1: 1000 });
  assert.deepEqual(tickQuestion({}, "q1", 60000), { q1: 5000 }, "a long gap (sleep) counts at most 5 seconds");
  const plan = paperPlan([{ cardId: "q1", marks: 6 }, { cardId: "q2", marks: 4 }]);
  assert.equal(livePace(plan, session, {}, at(25)), "behind", "15 of 30 writing minutes gone, nothing written");
  assert.equal(livePace(plan, session, { q1: "done" }, at(15)), "ahead");
});

test("the browser draft of a run survives blocked storage", () => {
  const store = new Map();
  globalThis.localStorage = { getItem: (key) => store.get(key) ?? null, setItem: (key, value) => store.set(key, value), removeItem: (key) => store.delete(key) };
  try {
    assert.equal(writeSession("lib", "run", { answers: { q1: "a" } }), true);
    assert.deepEqual(readSession("lib", "run"), { answers: { q1: "a" } });
    writeSession("lib", "run", null);
    assert.equal(readSession("lib", "run"), null);
    globalThis.localStorage = { getItem() { throw new Error("blocked"); }, setItem() { throw new Error("blocked"); } };
    assert.equal(readSession("lib", "run"), null);
    assert.equal(writeSession("lib", "run", { a: 1 }), false);
  } finally { delete globalThis.localStorage; }
});

const rubric = { total: 3.5, max: 6, ratio: 0.58, band: "pass", summary: "Clear recommendation; tie more choices to the case.",
  criteria: [
    { id: "c1", label: "Recommendation", score: 2.5, max: 3, ratio: 0.83, evidence: ["I recommend an event-driven architecture."], missing: [], suggestion: "" },
    { id: "c2", label: "Case linkage", score: 0.5, max: 2, ratio: 0.25, evidence: [], missing: [{ id: "c2.k1", text: "Power loss → alerting on missing readings" }],
      suggestion: "Tie the alerting service to the night the warehouse lost power." },
    { id: "c3", label: "Assumptions", score: 0, max: 1, ratio: 0, evidence: [], missing: [{ id: "c3.k1", text: "States an assumption" }], suggestion: "", note: "not-scored" },
  ],
  unanchored: [{ quote: "I would also use Kubernetes for everything.", cue: "In March a warehouse lost power overnight and nobody was alerted." }],
  assumptions: [{ gap: "the migration budget", stated: false, suggestion: "Say: the case gives no budget, so I assume a small first phase." }] };

test("a rubric result shows a row per criterion with quotes, gaps, rewrites and the case-linkage and assumption flags", () => {
  setUiLanguage("zh");
  const html = render(RubricResult, { rubric });
  assert.equal((html.match(/class="rubric-row( is-weak)?"/g) || []).length, 3);
  assert.match(html, /<strong>3.5<\/strong><span>\/ 6 分<\/span>/);
  assert.match(html, /得分依据（引自你的回答）[\s\S]*<blockquote>I recommend an event-driven architecture.<\/blockquote>/);
  assert.match(html, /遗漏的要点[\s\S]*Power loss → alerting on missing readings/);
  assert.match(html, /可以这样改写[\s\S]*Tie the alerting service/);
  assert.match(html, /评分助手没有给这一项打分/);
  assert.match(html, /没有落到案例上的建议[\s\S]*Kubernetes[\s\S]*In March a warehouse lost power/);
  assert.match(html, /案例没有说明，应该先写出假设[\s\S]*the migration budget/);
  assert.match(html, /class="rubric-row is-weak"/, "weak criteria are marked");
  setUiLanguage("en");
  const english = render(RubricResult, { rubric });
  assert.doesNotMatch(english.replace(/→/g, ""), han);
  assert.match(english, /What earned marks/);
  setUiLanguage("zh");
});

const report = { runId: "run", case: { title: "Orchard", deckId: "orchard", handwriting: true, total: 3.5, max: 10, pending: 1,
  questions: [
    { cardId: "q1", deckId: "orchard", n: 1, prompt: "Recommend an architecture.", marks: 6, status: "graded", total: 3.5, rubric },
    { cardId: "q2", deckId: "orchard", n: 2, prompt: "Choose data stores.", marks: 4, status: "pending", total: null, rubric: null },
  ],
  weakest: [{ cardId: "q1", criterionId: "c3", n: 1, label: "Assumptions", score: 0, max: 1, ratio: 0 }],
  pacing: { rows: [{ cardId: "q1", budgetMs: 18 * 60000, spentMs: 25 * 60000, status: "over" }, { cardId: "q2", budgetMs: 12 * 60000, spentMs: 0, status: "ok" }],
    unanswered: [], overBudget: ["q1"], readingMs: 300000, writingMs: 1800000, transcribeMs: 240000, writingMinutes: 30, readingMinutes: 5 } } };

test("the case paper report lists per-question marks, the weakest criteria with practice, pacing and pending grading", () => {
  const drilled = [];
  const html = render(CaseReport, { report, onDrills: (criteria) => drilled.push(criteria), onAgain: noop });
  assert.match(html, /已批改 1\/2 题，其余正在后台批改/);
  assert.match(html, /录入 4 分钟（不计入考试时间）/);
  assert.equal((html.match(/case-report__questions/g) || []).length, 1);
  assert.match(html, /第 1 题[\s\S]*已批改[\s\S]*3.5[\s\S]*用时 25\/18 分钟/);
  assert.match(html, /第 2 题[\s\S]*批改中/);
  assert.match(html, /最需要加强的评分项[\s\S]*Assumptions[\s\S]*针对练习/);
  assert.match(html, /把薄弱项变成练习/);
  assert.match(html, /再来一个同类案例/);
  assert.match(html, /超出建议用时/);
});

test("rubric skills list the weakest criterion first with a share of marks", () => {
  const attempts = [{ assessment: "rubric", timestamp: "1", rubric: { criteria: [{ label: "Case linkage", score: 0.5, max: 2 }, { label: "Recommendation", score: 3, max: 3 }] } }];
  const html = render(RubricSkills, { attempts });
  assert.match(html, /案例分析能力/);
  assert.ok(html.indexOf("Case linkage") < html.indexOf("Recommendation"));
  assert.match(html, /25%/);
  assert.equal(render(RubricSkills, { attempts: [] }), "");
});

const scenario = "Orchard Cold Chain stores fresh fruit.\n\nIn March a warehouse lost power overnight.";
test("the scenario panel numbers its paragraphs and shows highlights in their colours", () => {
  const html = render(ScenarioPanel, { title: "Case: Orchard", text: scenario, onChange: noop,
    highlights: [{ id: "h", paragraph: 2, start: 3, end: 8, color: "pink", note: "cue" }] });
  assert.match(html, /<span class="case-para__n"[^>]*>1<\/span>[\s\S]*<span class="case-para__n"[^>]*>2<\/span>/);
  assert.match(html, /<mark class="case-hl hl-pink"[^>]*>March<\/mark>/);
  assert.match(html, /荧光笔/);
  assert.equal((html.match(/case-swatch/g) || []).length, 4, "four highlight colours");
  assert.match(html, /case-para__note[\s\S]*cue/);
  assert.doesNotMatch(render(ScenarioPanel, { title: "x", text: scenario, readOnly: true }), /荧光笔/);
});

const card = { id: "q1", kind: "open", topic: "Styles", prompt: "Which architecture style would you recommend?", marks: 6,
  rubricCriteria: [{ id: "c1", label: "Recommendation", marks: 3 }, { id: "c2", label: "Case linkage", marks: 3 }] };
const data = { root: "lib", model: { ready: true, reason: "ok" }, decks: [], sources: [], drafts: [], jobs: [], focus: {} };

test("a rubric question is answered in writing and submitted for grading; the model answer appears only after grading", () => {
  const before = render(RubricAnswer, { run: { id: "run", card }, data, onSubmit: noop });
  assert.match(before, /data-tour="case-practice"/);
  assert.match(before, /6 分/);
  assert.match(before, /建议用时约 18 分钟/);
  assert.match(before, /<textarea/);
  assert.match(before, /提交批改/);
  assert.match(before, /评分维度[\s\S]*Case linkage/);
  assert.doesNotMatch(before, /参考答案/);
  const gated = render(RubricAnswer, { run: { id: "run", card }, data: { ...data, model: { ready: false, reason: "no-route" } }, onSubmit: noop });
  assert.match(gated, /批改需要模型；答案会先保存/);
  assert.doesNotMatch(gated, />提交批改</);
  const grading = render(RubricAnswer, { run: { id: "run", card }, data, task: { status: "running" } });
  assert.match(grading, /正在按评分标准逐项批改/);
  const after = render(RubricAnswer, { run: { id: "run", card, feedback: { rubric, answer: "My answer text" }, solution: { answer: "The model answer." } }, data });
  assert.match(after, /rubric-result/);
  assert.match(after, /参考答案（批改后揭晓）[\s\S]*The model answer./);
  assert.doesNotMatch(after, /<textarea/);
});

test("review shows the scenario above a case question and the rubric answer instead of self-rating", () => {
  const run = { id: "run", deckId: "orchard", mode: "path", index: 0, total: 2, card, revealed: false, feedback: null, navigation: [], highlights: [] };
  const caseData = { ...data, decks: [{ id: "orchard", format: "case-study", caseSourceId: "case", title: "Orchard" }],
    sources: [{ id: "case", title: "Case: Orchard", text: scenario }], assist: [] };
  const html = render(Review, { run, data: caseData, busy: false, host: {}, choice: false, isCloze: false, shellTitle: "Orchard", selected: [],
    response: "", setResponse: noop, setModal: noop, setPage: noop, setFlag: noop, setExplain: noop, setHint: noop, setTeachAnswer: noop,
    setClozeValues: noop, choose: noop, flipCard: noop, reviewAct: noop, studyPrerequisites: noop, assistCard: noop, assistTasks: [],
    slayCard: noop, askInChat: noop, act: noop, enterRun: noop, call: noop, feedback: null });
  assert.match(html, /case-review-scenario/);
  assert.match(html, /In March a warehouse lost power overnight/);
  assert.match(html, /提交批改/);
  assert.doesNotMatch(html, /掌握程度评分/, "no self-rating for a rubric question");
});

test("a finished round on a case set offers its weak points as drills and another case like it", () => {
  const acted = [];
  const run = { id: "run", deckId: "orchard", mode: "path", complete: true, total: 2, questions: 2, answered: 2, correct: 1, weakTopics: [], navigation: [] };
  const caseData = { ...data, decks: [{ id: "orchard", format: "case-study", caseSourceId: "case", title: "Orchard" }], assist: [] };
  const props = { run, data: caseData, busy: false, host: {}, choice: false, isCloze: false, shellTitle: "Orchard", selected: [], response: "",
    setResponse: noop, setModal: noop, setPage: noop, setFlag: noop, setExplain: noop, setHint: noop, setTeachAnswer: noop, setClozeValues: noop,
    choose: noop, flipCard: noop, reviewAct: noop, studyPrerequisites: noop, assistCard: noop, assistTasks: [], slayCard: noop, askInChat: noop,
    act: (...args) => acted.push(args), enterRun: noop, call: noop, feedback: null };
  const html = render(Review, props);
  assert.match(html, /把薄弱项变成练习/);
  assert.match(html, /再来一个同类案例/);
  assert.doesNotMatch(render(Review, { ...props, data: { ...caseData, decks: [{ id: "orchard", title: "Orchard" }] } }), /再来一个同类案例/);
});

test("创建题组 offers 案例分析题, and its form starts with the course, materials and optional examiner guidance", () => {
  const sources = [{ id: "a", title: "Cloud persistence", text: "Polyglot persistence chooses a store per workload.", courses: ["Cloud Native"] }];
  const props = { data: { ...data, sources, focus: { course: "Cloud Native", courses: [{ name: "Cloud Native" }] } }, busy: false, running: false, act: noop, call: async () => { throw new Error("Capability unavailable"); },
    openDraft: noop, setPage: noop, setNotice: noop, setGenSource: noop, gen: { kind: "quiz", count: 5, difficulty: "mixed", language: "中文" }, setGen: noop,
    selectedSources: [], setSelectedSources: noop, setModal: noop, askInChat: noop, openModelSettings: noop };
  const tabs = render(Generate, { ...props, genSource: "files" });
  assert.match(tabs, /role="tab"[^>]*>[^]*?案例分析题/);
  const form = render(Generate, { ...props, genSource: "case" });
  assert.match(form, /data-tour="case-create"/);
  assert.match(form, /用资料出新案例[\s\S]*仿照真题出题[\s\S]*粘贴题目直接批改/);
  assert.ok(form.indexOf("课程") < form.indexOf("source-picker"), "the course comes first");
  assert.match(form, /按课程的考试设置：每分约 3 分钟，还没有评分说明/);
  assert.doesNotMatch(form, /评分说明来源（可选）/, "guidance and focus topics are edited in the course settings");
  const linked = render(Generate, { ...props, genSource: "case", onCourseSettings: noop, data: { ...props.data, courses: [{ id: "course-1", name: "Cloud Native",
    exam: { format: "open-book-case", totalMarks: 40, writingMinutes: 100 }, guidanceSourceIds: ["a"], focusTopics: ["Cloud Persistence"] }] } });
  assert.match(linked, /每分约 2.5 分钟，评分说明 1 份，重点主题：Cloud Persistence/);
  assert.match(linked, /修改课程的考试设置、评分说明和重点主题/);
  assert.match(form, /出一套案例题 →/);
  assert.match(render(Generate, { ...props, genSource: "case", data: { ...props.data, model: { ready: false, reason: "no-route" } } }), /先配置一个 AI 模型/);
});

test("case creation honours the saved output language independently of the interface language", () => {
  const props = { data: { ...data, settings: { generation: { language: "English" } } }, genSource: "case", busy: false,
    act: noop, call: async () => ({}), setNotice: noop, setPage: noop, setGenSource: noop, gen: {}, setGen: noop,
    selectedSources: [], setSelectedSources: noop, setModal: noop, openModelSettings: noop };
  try {
    for (const [interfaceLanguage, language] of [["zh", "English"], ["en", "中文"], ["zh", "中英双语"]]) {
      setUiLanguage(interfaceLanguage);
      const html = render(Generate, { ...props, data: { ...props.data, settings: { generation: { language } } } });
      assert.match(html, new RegExp(`<option[^>]*value="${language}"[^>]*selected=""`), `${interfaceLanguage} interface must retain ${language} as the selected output language`);
    }
  } finally { setUiLanguage("zh"); }
});

test("模拟考试 offers 案例分析卷; its setup lists case sets with the time model and paper practice", () => {
  const examData = { ...data, decks: [{ id: "orchard", title: "Orchard case", format: "case-study", caseMarks: 10, count: 2, caseBest: { total: 7, max: 10 }, course: "" }],
    runs: [], exams: [], focus: { courses: [] } };
  const setup = render(Exam, { call: async () => ({}), data: examData, onExit: noop });
  assert.match(setup, /aria-label="考试形式"[\s\S]*案例分析卷/); // WP25: a first-class format of the one exam switch, not a corner link
  const paper = render(CasePaper, { call: async () => { throw new Error("Capability unavailable"); }, data: examData, onExit: noop, onWritten: noop });
  assert.match(paper, /Orchard case[\s\S]*2 题 · 10 分[\s\S]*最好成绩 7\/10/);
  assert.match(paper, /每分用时（分钟）[\s\S]*value="3"/);
  assert.match(paper, /纸笔练习模式/);
  assert.match(paper, /阅读 6 分钟 · 作答 30 分钟/);
  assert.match(paper, /开始考试/);
  const empty = render(CasePaper, { call: async () => ({}), data: { ...examData, decks: [] }, onExit: noop, onCreate: noop });
  assert.match(empty, /还没有案例分析题组/);
});

test("a case draft shows its scenario, marks and hidden cues, and edits criteria with their marks", () => {
  const draft = { id: "d", title: "Orchard", format: "case-study", case: { sourceId: "case", cues: [{ id: "cue1", quote: "In March a warehouse lost power overnight.", implies: "Alerting" }] },
    cards: [{ ...card, marks: 6 }, { ...card, id: "q2", marks: 4 }] };
  const html = render(CaseDraftHeader, { draft, data: { sources: [{ id: "case", title: "Case: Orchard", text: scenario }] } });
  assert.match(html, /2 道题 · 共 10 分 · 建议作答约 30 分钟/);
  assert.match(html, /case-para__n/);
  assert.match(html, /隐藏线索 · 1 条（会剧透）/);
  const editor = render(CriteriaEditor, { criteria: [{ id: "c1", label: "Recommendation", marks: 3, descriptor: "Clear choice", keyPoints: ["a", "b"] }], onChange: noop });
  assert.match(editor, /评分标准 · 共 3 分/);
  assert.match(editor, /<textarea[^>]*>a\nb<\/textarea>/);
});

test("a passage of a material can seed a case: 围绕这段出案例题 in the viewer, the passage on the form and in the author's brief", async () => {
  const { DocumentViewer } = module.exports;
  const pending = async () => new Promise(() => {});
  // A PDF page renders without the HTML sanitiser, which needs a browser.
  const pdf = { id: "a", title: "Lecture", text: "Polyglot persistence.", document: { id: "doc", page: 1 } };
  const viewer = render(DocumentViewer, { source: pdf, call: pending,
    data: { ...data, sources: [] }, onCaseFromPassage: noop });
  assert.match(viewer, /围绕这段出案例题/);
  assert.doesNotMatch(render(DocumentViewer, { source: pdf, call: pending, data }), /围绕这段出案例题/);
  const { caseAuthorPrompt, caseGenerationArgs } = await import("../lib/case-study.js");
  assert.equal(caseGenerationArgs({ sourceIds: ["a"], focus: "Relational stores keep payments consistent." }).focus, "Relational stores keep payments consistent.");
  const { prompt } = caseAuthorPrompt({ language: "English", questions: 2, totalMarks: 20, sources: [], focus: "Relational stores keep payments consistent." });
  assert.match(prompt, /around the focus passage/);
  assert.equal(JSON.parse(prompt.split("REQUEST DATA:\n")[1]).focus, "Relational stores keep payments consistent.");
  const sources = [{ id: "a", title: "Cloud persistence", text: "Polyglot persistence chooses a store per workload." }];
  const form = render(Generate, { data: { ...data, sources, focus: { courses: [] } }, busy: false, running: false, act: noop, call: async () => { throw new Error("x"); },
    openDraft: noop, setPage: noop, setNotice: noop, setGenSource: noop, gen: { kind: "quiz", count: 5, language: "中文" }, setGen: noop, selectedSources: [],
    setSelectedSources: noop, setModal: noop, askInChat: noop, openModelSettings: noop, genSource: "case",
    caseInitial: { sourceIds: ["a"], focus: "Polyglot persistence chooses a store per workload." } });
  assert.match(form, /围绕这段资料出题[\s\S]*Polyglot persistence chooses a store per workload./);
});
