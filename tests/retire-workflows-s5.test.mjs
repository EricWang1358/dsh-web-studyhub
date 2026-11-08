/* Issue #779 · [学法·S5] 全局面试模式迁移成课程，学习流退役。
   1. Store v4 → v5 idempotently migrates legacy global interview focus settings into a course record.
   2. Global 课堂跟学 / 笔试 / 面试 switch is removed; oral & written exams work per course.
   3. Learning flows (Workflows) are retired from navigation/home/tour/finder; historical sessions remain read-only. */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { build } from "esbuild";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Store, LATEST_VERSION, normalizeState } from "../lib/store.js";
import { StudyService } from "../lib/service.js";
import { INTERVIEW_METHOD } from "../lib/courses.js";
import { PAGES } from "../ui/pages.js";
import { NAV_DEFAULTS } from "../ui/nav-order.js";
import { TOUR_STEPS } from "../ui/tour/steps.js";
import { FINDER_ENTRIES } from "../ui/finder/entries.js";
import { searchFeatures } from "../ui/finder/search.js";
import { loadLearningTarget, openLearningTarget } from "../ui/learning-navigation.js";
import { nativeSelects } from "./helpers/native-selects.mjs";
import { mapProps } from "./helpers/study-map-props.mjs";

const require = createRequire(import.meta.url);
const compiled = await build({
  stdin: {
    contents: `
      export { default as StudyMap } from './ui/StudyMap.jsx';
      export { default as CourseSettings } from './ui/CourseSettings.jsx';
      export { default as Workflows } from './ui/Workflows.jsx';
      export { default as WorkflowPortal } from './ui/WorkflowPortal.jsx';
      export { StatsView } from './ui/Dashboard.jsx';
      export { StudyServicesContext } from './ui/study-context.jsx';
      export { ui, setUiLanguage } from './ui/i18n.js';
    `,
    resolveDir: process.cwd(),
  },
  bundle: true,
  write: false,
  platform: "node",
  format: "cjs",
  external: ["react", "react-dom"],
  plugins: [nativeSelects],
  loader: { ".css": "text" },
  logLevel: "silent",
});
const uiMod = { exports: {} };
new Function("require", "module", "exports", compiled.outputFiles[0].text)(require, uiMod, uiMod.exports);
const { StudyMap, CourseSettings, Workflows, WorkflowPortal, StatsView, StudyServicesContext, ui, setUiLanguage } = uiMod.exports;

const h = React.createElement;
const noop = () => {};
const han = /[㐀-鿿]/;

function renderWithStudy(element, studyValue = {}) {
  const ctx = {
    act: noop,
    call: async () => ({}),
    busy: false,
    data: {},
    openModal: noop,
    askInChat: noop,
    notify: noop,
    host: {},
    ...studyValue,
  };
  return renderToStaticMarkup(h(StudyServicesContext.Provider, { value: ctx }, element));
}

async function tempDir(t, prefix = "study-s5-779-") {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 3 }));
  return dir;
}

async function writeV4ShardedLibrary(root, { focus, courses = [], decks = [], sources = [], workflowTemplates = [], workflowSessions = [] }) {
  const collections = { courses, decks, sources, workflowTemplates, workflowSessions };
  const shards = {};
  for (const [field, items] of Object.entries(collections)) {
    if (!items.length) continue;
    await mkdir(join(root, "shards", field), { recursive: true });
    shards[field] = [];
    for (const [idx, item] of items.entries()) {
      const rel = `${field}/${item.id || idx}.v4.json`;
      await writeFile(join(root, "shards", rel), JSON.stringify(item));
      shards[field].push(rel);
    }
  }
  const manifest = {
    format: "study-sharded",
    version: 4,
    revision: 12,
    settings: {},
    focus,
    shards,
  };
  await writeFile(join(root, "study-workspace.json"), JSON.stringify(manifest, null, 2));
}

test("LATEST_VERSION is 5 and v4 → v5 migrates active interview focus into a course idempotently", async (t) => {
  assert.equal(LATEST_VERSION, 5);

  const v4ActiveInterview = {
    version: 4,
    courses: [{ id: "course-cs3219", name: "CS3219", focusTopics: ["Patterns"] }],
    decks: [
      {
        id: "d-sys",
        title: "Distributed Transactions",
        course: "CS3219",
        cards: [{ id: "c1", kind: "mcq", topic: "Raft", prompt: "What does a Raft leader commit?", options: ["Majority log entry", "Local disk only"], answer: 0 }],
      },
    ],
    focus: {
      mode: "interview",
      course: "CS3219",
      role: "后端研发",
      jd: "熟悉 Go、Raft 与分布式事务",
      targetTopics: ["Raft", "分布式事务"],
    },
  };

  const once = normalizeState(structuredClone(v4ActiveInterview));
  assert.equal(once.version, 5);
  assert.equal(once.focus.mode, "class", "global interview mode is reset to class");
  assert.equal(once.focus.course, "笔试 / 面试 · 后端研发", "active interview focus switches to the migrated course");
  assert.equal(once.focus.role, "");
  assert.equal(once.focus.jd, "");
  assert.deepEqual(once.focus.targetTopics, []);

  const migrated = once.courses.find((c) => c.name === "笔试 / 面试 · 后端研发");
  assert.ok(migrated, "interview course record was created");
  assert.deepEqual(migrated.interview, { role: "后端研发", jd: "熟悉 Go、Raft 与分布式事务", migratedFromFocus: true });
  assert.deepEqual(migrated.focusTopics, ["Raft", "分布式事务"]);
  assert.equal(migrated.method?.name, INTERVIEW_METHOD.name);
  assert.equal(migrated.method?.stages?.length, INTERVIEW_METHOD.stages.length);

  // Repeated normalization is strictly idempotent: never duplicates courses or loses fields.
  const twice = normalizeState(structuredClone(once));
  const thrice = normalizeState({ ...structuredClone(twice), version: 4 });
  assert.equal(twice.courses.length, once.courses.length);
  assert.equal(thrice.courses.length, once.courses.length);
  assert.deepEqual(thrice.courses.find((c) => c.id === migrated.id), migrated);

  // Sharded v4 store read/write round-trip preserves settings, writes v4 backup, and stays idempotent across reloads.
  const root = await tempDir(t);
  await writeV4ShardedLibrary(root, v4ActiveInterview);
  const service = new StudyService(root);
  t.after(() => service.dispose());

  const snap1 = await service.call("snapshot");
  assert.equal(snap1.focus.course, "笔试 / 面试 · 后端研发");
  assert.equal(snap1.focus.mode, "class");
  const snapCourse = snap1.courses.find((c) => c.name === "笔试 / 面试 · 后端研发");
  assert.deepEqual(snapCourse.interview, { role: "后端研发", jd: "熟悉 Go、Raft 与分布式事务", migratedFromFocus: true });
  assert.deepEqual(snapCourse.focusTopics, ["Raft", "分布式事务"]);

  // Trigger a write to upgrade manifest from v4 to v5 and verify backup + reload idempotency.
  await service.call("focus.set", { course: "笔试 / 面试 · 后端研发" });
  const manifest = JSON.parse(await readFile(join(root, "study-workspace.json"), "utf8"));
  assert.equal(manifest.version, 5);
  const backups = await readdir(join(root, "backups"));
  assert.ok(backups.some((name) => /^study-workspace-v4-/.test(name)), "v4 backup created before upgrading manifest to v5");

  const reloaded = await new Store(root).read();
  assert.equal(reloaded.courses.filter((c) => c.name.startsWith("笔试 / 面试")).length, 1);
  assert.deepEqual(reloaded.courses.find((c) => c.name === "笔试 / 面试 · 后端研发").interview, {
    role: "后端研发",
    jd: "熟悉 Go、Raft 与分布式事务",
    migratedFromFocus: true,
  });
});

test("v4 → v5 migration preserves active class focus when saved interview settings exist and reuses matching courses", () => {
  // Learner was in class mode on CS3219, but had saved global role/jd/targetTopics from earlier interview prep.
  const savedWhileInClass = normalizeState({
    version: 4,
    courses: [{ id: "c-os", name: "Operating Systems" }],
    focus: {
      mode: "class",
      course: "Operating Systems",
      role: "系统工程师",
      jd: "Linux 内核与虚拟内存",
      targetTopics: ["Page Table"],
    },
  });
  assert.equal(savedWhileInClass.focus.course, "Operating Systems", "active class course is preserved");
  const prep = savedWhileInClass.courses.find((c) => c.name === "笔试 / 面试 · 系统工程师");
  assert.ok(prep, "saved interview settings are still migrated into a dedicated course");
  assert.deepEqual(prep.interview, { role: "系统工程师", jd: "Linux 内核与虚拟内存", migratedFromFocus: true });
  assert.deepEqual(prep.focusTopics, ["Page Table"]);

  // Existing matching course is reused without creating a duplicate, merging topics and keeping custom method.
  const customMethod = { name: "自定义冲刺", gate: "strict", stages: [{ activity: "practice", label: "狂刷真题" }] };
  const withExisting = normalizeState({
    version: 4,
    courses: [
      {
        id: "existing-prep",
        name: "笔试 / 面试 · 系统工程师",
        focusTopics: ["Virtual Memory"],
        method: customMethod,
      },
    ],
    focus: {
      mode: "interview",
      role: "系统工程师",
      jd: "C++ / Linux",
      targetTopics: ["Virtual Memory", "EPOLL"],
    },
  });
  assert.equal(withExisting.courses.length, 1, "reuses existing course instead of duplicating");
  assert.deepEqual(withExisting.courses[0].focusTopics, ["Virtual Memory", "EPOLL"]);
  assert.deepEqual(withExisting.courses[0].interview, { role: "系统工程师", jd: "C++ / Linux", migratedFromFocus: true });
  assert.deepEqual(withExisting.courses[0].method.name, "自定义冲刺", "custom method on existing course is preserved");

  // Clean v4 library without interview mode or interview fields creates zero extra courses.
  const cleanV4 = normalizeState({
    version: 4,
    courses: [{ id: "c-db", name: "Databases" }],
    focus: { mode: "class", course: "Databases" },
  });
  assert.equal(cleanV4.courses.length, 1);
  assert.equal(cleanV4.courses[0].name, "Databases");
});

test("global interview mode is rejected by focus.set and oral/written exams run scoped to the course", async (t) => {
  const root = await tempDir(t);
  const service = new StudyService(root);
  t.after(() => service.dispose());

  await assert.rejects(
    () => service.call("focus.set", { mode: "interview" }),
    /笔试 \/ 面试.*课程|course/i,
  );

  await service.call("source.add", {
    id: "src-go",
    title: "Raft Notes",
    text: "Raft elects a single leader per term and replicates log entries to a majority quorum.",
    courses: ["笔试 / 面试 · 后端研发"],
  });
  await service.call("course.save", {
    name: "笔试 / 面试 · 后端研发",
    focusTopics: ["Raft"],
    interview: { role: "后端研发", jd: "分布式一致性与高可用服务" },
  });

  await service.store.update((state) => {
    state.decks.push(
      {
        id: "deck-interview",
        title: "分布式一致性题组",
        course: "笔试 / 面试 · 后端研发",
        cards: [
          {
            id: "card-raft",
            kind: "quiz",
            topic: "Raft",
            prompt: "Raft 如何在同一任期内保证最多只有一个 Leader？",
            options: [
              { id: "A", text: "多数派投票且每节点每任期只投一票" },
              { id: "B", text: "随机休眠后直接自封 Leader" },
            ],
            answer: "A",
          },
        ],
      },
      {
        id: "deck-other",
        title: "其他课程题组",
        course: "艺术史",
        cards: [
          {
            id: "card-art",
            kind: "quiz",
            topic: "Baroque",
            prompt: "巴洛克时期的代表画家是谁？",
            options: [
              { id: "A", text: "卡拉瓦乔" },
              { id: "B", text: "莫奈" },
            ],
            answer: "A",
          },
        ],
      },
    );
  });

  await service.call("focus.set", { course: "笔试 / 面试 · 后端研发" });
  const oral = await service.call("oral.start", { course: "笔试 / 面试 · 后端研发", count: 3 });
  assert.equal(oral.role, "后端研发", "oral exam picks up the course's interview role");
  assert.equal(oral.total, 1, "oral exam scopes strictly to the course's cards");
  assert.equal(oral.entry.topic, "Raft");

  const exam = await service.call("review.start", { mode: "exam", course: "笔试 / 面试 · 后端研发", fresh: true });
  assert.equal(exam.total, 1, "written exam scopes to the selected interview course");
});

test("Workflows runtime keeps read-only history operations and rejects all mutating workflow.* operations", async (t) => {
  const root = await tempDir(t);
  const template = {
    id: "tpl-feynman",
    title: "费曼四步（历史存档）",
    description: "短讲与复述",
    steps: [
      { id: "step-lesson", kind: "lesson", title: "短讲概念", instructions: "阅读核心直觉" },
      { id: "step-practice", kind: "practice", title: "小测巩固", count: 2 },
    ],
  };
  const session = {
    id: "ws-archive-1",
    templateId: "tpl-feynman",
    template,
    topic: "Raft 选主",
    course: "CS3219",
    status: "active",
    currentStepId: "step-lesson",
    createdAt: "2026-10-01T08:00:00.000Z",
    updatedAt: "2026-10-01T08:30:00.000Z",
    scope: [{ deckId: "d-1" }],
    records: {
      "step-lesson": {
        outcome: "done",
        content: "## 核心机制\n\n每任期每节点最多投出一张选票。",
        output: "任期号单调递增，多数派交集保证唯一 Leader。",
        updatedAt: "2026-10-01T08:25:00.000Z",
      },
    },
    history: [
      { requestId: "ev-1", stepId: "step-lesson", outcome: "done", output: "任期号单调递增", at: "2026-10-01T08:25:00.000Z" },
    ],
  };

  await writeV4ShardedLibrary(root, {
    focus: { mode: "class", course: "CS3219" },
    courses: [{ id: "course-cs3219", name: "CS3219" }],
    decks: [
      {
        id: "d-1",
        title: "Raft",
        course: "CS3219",
        cards: [{ id: "c-1", kind: "flashcard", topic: "Raft 选主", front: "选票规则？", back: "每任期一票" }],
      },
    ],
    workflowTemplates: [template],
    workflowSessions: [session],
  });

  const service = new StudyService(root);
  t.after(() => service.dispose());

  // Read-only workflow operations still work for inspecting history.
  const listed = await service.call("workflow.list");
  assert.equal(listed.retired, true);
  assert.equal(listed.sessions.length, 1);
  assert.equal(listed.sessions[0].id, "ws-archive-1");
  assert.equal(listed.sessions[0].topic, "Raft 选主");

  const detail = await service.call("workflow.session.get", { id: "ws-archive-1" });
  assert.equal(detail.retired, true);
  assert.equal(detail.session.id, "ws-archive-1");
  assert.match(detail.session.records["step-lesson"].content, /核心机制/);

  const ctx = await service.call("workflow.context", { sessionId: "ws-archive-1" });
  assert.equal(ctx.retired, true);
  assert.equal(ctx.session.id, "ws-archive-1");

  const contract = await service.call("library.context", { area: "workflows" });
  assert.match(JSON.stringify(contract.contract), /retired|退役|course\.method|study\.session/i);

  // Every mutating workflow.* action is explicitly rejected with WORKFLOW_RETIRED and clear guidance.
  const mutatingCalls = [
    ["workflow.save", { template: { title: "New", steps: [{ kind: "lesson", title: "S1" }] } }],
    ["workflow.delete", { id: "tpl-feynman" }],
    ["workflow.quickstart", { topic: "Raft" }],
    ["workflow.rescope", { id: "ws-archive-1", scope: { course: "CS3219" } }],
    ["workflow.feedback", { id: "ws-archive-1", stepId: "step-lesson", text: "test" }],
    ["workflow.session.start", { templateId: "tpl-feynman", topic: "Raft" }],
    ["workflow.session.record", { id: "ws-archive-1", stepId: "step-lesson", output: "edit" }],
    ["workflow.session.material", { id: "ws-archive-1", stepId: "step-lesson", content: "edit" }],
    ["workflow.session.material.restore", { id: "ws-archive-1", stepId: "step-lesson", index: 0 }],
    ["workflow.session.advance", { id: "ws-archive-1", outcome: "done" }],
    ["workflow.session.goto", { id: "ws-archive-1", stepId: "step-practice" }],
    ["workflow.session.status", { id: "ws-archive-1", status: "paused" }],
    ["workflow.session.delete", { id: "ws-archive-1" }],
    ["workflow.practice.start", { id: "ws-archive-1", stepId: "step-practice" }],
    ["workflow.teaching.start", { id: "ws-archive-1", stepId: "step-lesson" }],
    ["workflow.teaching.undo", { id: "ws-archive-1", stepId: "step-lesson" }],
    ["workflow.skeleton.generate", { id: "ws-archive-1" }],
  ];

  for (const [action, payload] of mutatingCalls) {
    await assert.rejects(
      () => service.call(action, payload),
      (err) => {
        assert.equal(err.code, "WORKFLOW_RETIRED", `${action} should set WORKFLOW_RETIRED`);
        assert.match(err.message, /course\.method/, `${action} should guide to course.method`);
        assert.match(err.message, /study\.session/, `${action} should guide to study.session`);
        return true;
      },
      `${action} must reject as retired`,
    );
  }

  // Board studyRef (kind: 'workflow') still loads and opens the read-only workflow archive view.
  const ref = { kind: "workflow", sessionId: "ws-archive-1" };
  const loaded = await loadLearningTarget(ref, (op, args) => service.call(op, args), {});
  assert.equal(loaded.session.id, "ws-archive-1");
  let openedSessionId = null;
  openLearningTarget(ref, loaded, { showWorkflow: (id) => { openedSessionId = id; } }, {});
  assert.equal(openedSessionId, "ws-archive-1");
});

test("UI removes global mode switch and workflow entry points while preserving read-only archive and migrated course settings", () => {
  setUiLanguage("zh");
  const migratedCourse = {
    id: "course-interview-1",
    name: "笔试 / 面试 · 后端研发",
    active: true,
    decks: 1,
    sources: 1,
    focusTopics: ["Raft", "分布式事务"],
    interview: { role: "后端研发", jd: "熟悉 Go 与共识算法" },
    method: INTERVIEW_METHOD,
  };
  const deck = {
    id: "d1",
    title: "Raft 题组",
    folder: migratedCourse.name,
    course: migratedCourse.name,
    topics: ["Raft"],
    available: 4,
    count: 4,
    quizCount: 4,
    createdAt: "2026-10-01T00:00:00Z",
  };
  const data = {
    root: "/tmp/lib",
    courses: [migratedCourse],
    decks: [deck],
    progress: {
      d1: { counts: { mastered: 1, familiar: 1, learning: 1, weak: 1, new: 0 }, total: 4, mastery: 50, due: 1, status: "active", topics: [] },
    },
    sources: [{ id: "s1", title: "Raft Paper", courses: [migratedCourse.name] }],
    drafts: [],
    jobs: [],
    runs: [],
    today: { due: 1, weak: 1, new: 0, size: 2 },
    focus: { mode: "class", course: migratedCourse.name, courseId: migratedCourse.id, courses: [migratedCourse], fresh: [] },
    workflowSessions: [
      { id: "ws-1", topic: "Raft 选主", title: "费曼四步", stepTitle: "短讲概念", status: "completed", updatedAt: "2026-10-01T08:30:00Z", course: migratedCourse.name },
    ],
  };

  // 1. Home StudyMap: no global focus-switch, no "先讲后练 · 学习流" in 其他开始方式.
  const homeHtml = renderWithStudy(
    h(StudyMap, mapProps({
      data,
      busy: false,
      start: noop,
      resume: noop,
      endRun: noop,
      manage: noop,
      openDraft: noop,
      continueDraft: noop,
      retryGeneration: noop,
      addSource: noop,
      createManual: noop,
      importLibrary: noop,
      askInChat: noop,
      notebooks: [],
      onFocus: noop,
    })),
    { data },
  );
  assert.doesNotMatch(homeHtml, /focus-switch/, "global 课堂跟学 / 笔试 / 面试 toggle is gone from home");
  assert.doesNotMatch(homeHtml, /先讲后练\s*·\s*学习流/, "home 其他开始方式 no longer offers 学习流");

  // 2. CourseSettings: clearly displays migrated role, JD, focusTopics, and 笔试 / 面试准备 method card.
  const settingsHtml = renderWithStudy(
    h(CourseSettings, { data, courseId: migratedCourse.id, onClose: noop }),
    { data },
  );
  assert.match(settingsHtml, /笔试 \/ 面试准备/, "CourseMethodCard displays the migrated interview method");
  assert.match(settingsHtml, /岗位与面试（可选）/, "CourseSettings shows the role & JD section");
  assert.match(settingsHtml, /后端研发/, "migrated role is visible in CourseSettings");
  assert.match(settingsHtml, /熟悉 Go 与共识算法/, "migrated JD is visible in CourseSettings");
  assert.match(settingsHtml, /Raft/, "migrated focusTopics are visible in CourseSettings");

  // 3. Workflows & WorkflowPortal: calm retirement banner, read-only history, zero create/edit/delete/advance buttons.
  const archiveListHtml = renderWithStudy(
    h(Workflows, {
      data,
      openRun: noop,
      onOpenSettings: noop,
      initialListing: { retired: true, templates: [], sessions: data.workflowSessions },
    }),
    { data },
  );
  assert.match(archiveListHtml, /学习流已退役，历史记录只读保留/);
  assert.match(archiveListHtml, /查看记录/);
  assert.doesNotMatch(archiveListHtml, /新建流程|编辑流程|开始学习|删除记录/);

  const portalResult = {
    retired: true,
    session: {
      id: "ws-1",
      topic: "Raft 选主",
      status: "completed",
      currentStepId: "s-1",
      scope: { course: migratedCourse.name, sourceIds: ["s1"], deckIds: ["d1"] },
      template: {
        id: "tpl-1",
        title: "费曼四步",
        steps: [
          { id: "s-1", kind: "lesson", title: "核心直觉", instructions: "先看任期号的作用" },
          { id: "s-2", kind: "practice", title: "巩固小测", count: 2 },
        ],
      },
      records: {
        "s-1": { outcome: "done", content: "每任期最多选出一个 Leader。", output: "我的笔记：多数派交集。" },
      },
      history: [{ requestId: "e1", stepId: "s-1", outcome: "done", output: "我的笔记：多数派交集。", at: "2026-10-01T08:30:00Z" }],
    },
    resources: { readings: [], sources: [{ id: "s1", title: "Raft Paper" }], cardCount: 4 },
  };
  const portalHtml = renderWithStudy(
    h(WorkflowPortal, { id: "ws-1", onBack: noop, onOpenRun: noop, initialResult: portalResult }),
    { data },
  );
  assert.match(portalHtml, /学习流已退役，当前记录为只读视图/);
  assert.match(portalHtml, /只读存档/);
  assert.match(portalHtml, /每任期最多选出一个 Leader/);
  assert.match(portalHtml, /我的笔记：多数派交集/);
  assert.doesNotMatch(portalHtml, /下一步|开始这一步|生成本步讲解|重写讲解|<textarea/i, "no step execution, AI generation buttons, or editable textareas");

  // 4. Dashboard StatsView: surfaces read-only historical workflow records link when sessions exist.
  const stats = {
    today: "2026-10-01",
    streak: 2,
    totalAttempts: 10,
    rates: { firstAttempt: 80, firstAttemptAnswers: 10, retention: 85, retentionAnswers: 8 },
    heatmap: [],
    trend: [],
    forecast: [],
    mastery: { total: 4, counts: { mastered: 1, familiar: 1, learning: 1, weak: 1, new: 0 } },
    weak: [],
    rubricSkills: [],
  };
  const dashHtml = renderWithStudy(
    h(StatsView, { stats, course: "*", data, onOpenWorkflowSession: noop }),
    { data },
  );
  assert.match(dashHtml, /历史学习流记录（只读）/);
});

test("sidebar navigation, tour, feature finder, and English UI have zero dead links or Chinese residue", () => {
  // Sidebar navigation removes workflows.
  assert.equal(PAGES.workflows.group, null);
  for (const list of Object.values(NAV_DEFAULTS)) {
    assert.ok(!list.includes("workflows"), "workflows removed from NAV_DEFAULTS");
  }

  // Guided tour has no dead workflows step or anchor.
  assert.ok(!TOUR_STEPS.some((step) => step.id === "workflows" || step.page === "workflows"));
  const tourAnchors = TOUR_STEPS.flatMap((step) => [step.anchor].flat()).filter(Boolean);
  assert.ok(!tourAnchors.includes("nav-workflows"));
  assert.ok(!tourAnchors.includes("workflows-main"));

  // Feature finder has zero entries pointing to retired workflows page or deleted global focus switch,
  // and searching 学习流 / learning flow guides learners to AI 带学 & 学法, while 岗位 / JD guides to 课程设置.
  for (const entry of FINDER_ENTRIES) {
    assert.notEqual(entry.target?.page, "workflows", `${entry.id} must not point to retired workflows page`);
    assert.notEqual(entry.target?.anchor, "nav-workflows", `${entry.id} must not target deleted nav-workflows`);
  }
  const flowHitsZh = searchFeatures(FINDER_ENTRIES, "学习流").map((e) => e.id);
  assert.ok(flowHitsZh.includes("guided-study") && flowHitsZh.includes("course-method"));
  setUiLanguage("en");
  try {
    const flowHitsEn = searchFeatures(FINDER_ENTRIES, "learning flow", { translate: ui }).map((e) => e.id);
    assert.ok(flowHitsEn.includes("guided-study") && flowHitsEn.includes("course-method"));
    const jdHitsEn = searchFeatures(FINDER_ENTRIES, "job description", { translate: ui }).map((e) => e.id);
    assert.ok(jdHitsEn.includes("course-settings"));

    // English UI rendering check: zero Chinese characters in CourseSettings, Workflows, and WorkflowPortal.
    const enCourse = {
      id: "c-en",
      name: "Backend Interview Prep",
      active: true,
      decks: 1,
      sources: 1,
      focusTopics: ["Consensus"],
      interview: { role: "Backend Engineer", jd: "Go and distributed systems" },
      method: { ...INTERVIEW_METHOD, name: "Exam & interview prep", stages: INTERVIEW_METHOD.stages.map((s) => ({ ...s, name: "Stage" })) },
    };
    const enData = {
      root: "/tmp/en",
      courses: [enCourse],
      decks: [],
      sources: [],
      focus: { mode: "class", course: enCourse.name, courseId: enCourse.id, courses: [enCourse], fresh: [] },
    };
    const enSettingsHtml = renderWithStudy(h(CourseSettings, { data: enData, courseId: "c-en", onClose: noop }), { data: enData });
    assert.doesNotMatch(enSettingsHtml, han, "CourseSettings in English has zero Chinese residue");

    const enArchiveHtml = renderWithStudy(
      h(Workflows, {
        data: enData,
        openRun: noop,
        onOpenSettings: noop,
        initialListing: {
          retired: true,
          templates: [],
          sessions: [{ id: "ws-en", topic: "Raft Leader Election", title: "Feynman Flow", stepTitle: "Concept", status: "completed", updatedAt: "2026-10-01T08:30:00Z" }],
        },
      }),
      { data: enData },
    );
    assert.doesNotMatch(enArchiveHtml, han, "Workflows archive list in English has zero Chinese residue");

    const enPortalHtml = renderWithStudy(
      h(WorkflowPortal, {
        id: "ws-en",
        onBack: noop,
        onOpenRun: noop,
        initialResult: {
          retired: true,
          session: {
            id: "ws-en",
            topic: "Raft Leader Election",
            status: "completed",
            currentStepId: "s-1",
            scope: { course: "Backend Interview Prep", sourceIds: [], deckIds: [] },
            template: { id: "t-en", title: "Feynman Flow", steps: [{ id: "s-1", kind: "lesson", title: "Core Intuition", instructions: "Read carefully." }] },
            records: { "s-1": { outcome: "done", content: "One vote per term.", output: "Quorum intersection." } },
            history: [{ requestId: "e1", stepId: "s-1", outcome: "done", output: "Quorum intersection.", at: "2026-10-01T08:30:00Z" }],
          },
          resources: { readings: [], sources: [], cardCount: 0 },
        },
      }),
      { data: enData },
    );
    assert.doesNotMatch(enPortalHtml, han, "WorkflowPortal read-only view in English has zero Chinese residue");
  } finally {
    setUiLanguage("zh");
  }
});
