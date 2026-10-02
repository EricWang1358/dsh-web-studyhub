import { ui, uiFormat, uiLocale, getUiLanguage } from "./i18n.js";
import React, { useEffect, useMemo, useRef, useState } from "react";
import { LEVEL_LABEL } from "./shared.js";
import GenerationTrace from "./GenerationTrace.jsx";
import { reviewedCardStatus } from "../lib/review-integrity.js";
import { isActiveJob, visibleGenerationJobs } from "./job-visibility.js";
import { useQuickActions } from "./quick-actions.js";
import { Button, Disclosure, Icon, InlineMessage, SegmentedControl } from "./components/index.js";
import { describeFailure, documentCount, jobCode, jobHeadline, jobStageLabel, modelReadiness } from "./generation-status.js";
import focusCss from "./focus.css";
import homeCss from "./generate-home.css";
import { useInjectCss } from "./shared.js";
import { groupPrompt } from "./topic-group-prompt.js";
import CourseRoute from "./CourseRoute.jsx";
import caseCss from "./case-study.css";
import { ExamCountdown } from "./CourseSettings.jsx";
import { ParkedChip, isParked } from "./CourseActive.jsx";
import { groupCourseNames, rankCourses } from "./course-names.js";
import { courseMatcher, courseNamesOf } from "./PageScope.jsx";
import { courseOrder, courseRelative } from "../lib/course-tree.js";
import { DraftTopUp, ShortfallReasons } from "./DraftShortfall.jsx";
import SetupChecklist from "./SetupChecklist.jsx";
import { TERMS, LEVEL_HINT } from "./mastery-terms.js";
import tiersCss from "./home-tiers.css";
import { missingQuestions } from "./draft-shortfall.js";

/* After an import the new topics sit outside the topic groups until someone
   remembers to fold them in. Say so in the library until it is done; "稍后"
   holds until the next import changes what is ungrouped. */
function TopicGroupReminder({ grouping, root, askInChat }) {
  const key = `study-topic-group-later:${root || "local"}`;
  const [later, setLater] = useState(() => { try { return localStorage.getItem(key) || ""; } catch { return ""; } });
  if (!grouping?.ungrouped || !askInChat) return null;
  // A handful of topics needs no grouping; once groups exist, new topics should join them.
  if (!grouping.groups && grouping.topics < 12) return null;
  const signature = `${grouping.groups}:${grouping.ungrouped}`;
  if (later === signature) return null;
  const first = !grouping.groups;
  const hold = () => { setLater(signature); try { localStorage.setItem(key, signature); } catch { /* per-device only */ } };
  return <div className="group-reminder" role="status">
    <span>{first ? uiFormat("学习库有 {0} 个主题，还没按知识域归并成主题组", [grouping.topics]) : uiFormat("有 {0} 个主题还没归入主题组（通常来自新导入的题组）", [grouping.ungrouped])}</span>
    <span className="group-reminder-actions">
      <button type="button" className="link-btn" onClick={() => askInChat(groupPrompt(first ? { mode: "replace", topicCount: grouping.topics } : { mode: "merge", ungrouped: grouping.ungrouped }, getUiLanguage()))}>{first ? ui("让对话归并主题") : ui("让对话归入主题组")} →</button>
      <button type="button" className="ghost-btn" onClick={hold}>{ui("稍后")}</button>
    </span>
  </div>;
}

const BAR_ORDER = ["mastered", "familiar", "learning", "weak", "new"];
const EMPTY_PROGRESS = {};
const EMPTY_NOTEBOOKS = [];
const topicKey = (deckId, topic) => JSON.stringify([deckId, topic || ""]);
const scopeOf = (keys) =>
  [...keys].map((k) => {
    const [deckId, topic] = JSON.parse(k);
    return topic ? { deckId, topic } : { deckId };
  });
const sameScope = (a = [], b = []) =>
  a.length === b.length &&
  a.every((x) => b.some((y) => y.deckId === x.deckId && (y.topic || "") === (x.topic || "")));

function dotLevel(node) {
  if (node.status === "todo") return "new";
  if (node.status === "done") return "mastered";
  if (node.counts.weak) return "weak";
  return node.mastery >= 60 ? "familiar" : "learning";
}
function mergeProgress(list) {
  const counts = Object.fromEntries(BAR_ORDER.map((l) => [l, 0]));
  let total = 0,
    weighted = 0,
    due = 0;
  for (const p of list) {
    for (const l of BAR_ORDER) counts[l] += p.counts[l];
    total += p.total ?? BAR_ORDER.reduce((n, l) => n + p.counts[l], 0);
    weighted += p.mastery * (p.total ?? 0);
    due += p.due;
  }
  return {
    counts,
    total,
    due,
    mastery: total ? Math.round(weighted / total) : 0,
    status: !total || counts.new === total ? "todo" : "active",
  };
}
function MasteryBar({ node }) {
  const total = BAR_ORDER.reduce((n, l) => n + node.counts[l], 0);
  const label = BAR_ORDER.filter((l) => node.counts[l])
    .map((l) => `${LEVEL_LABEL[l]} ${node.counts[l]}`)
    .join(" · ") || ui("暂无题目");
  let seen = 0;
  return (
    <span className="mastery" title={label}>
      <span
        className={total > 0 ? "mastery-bar" : "mastery-bar empty"}
        aria-hidden="true"
      >
        {BAR_ORDER.map((l) => {
          if (!node.counts[l]) return null;
          /* Stagger each segment so the bar fills left-to-right on mount. */
          const delay = `${seen * 90}ms`;
          seen += 1;
          return (
            <span
              key={l}
              className={"lv-" + l}
              style={{
                flexGrow: node.counts[l],
                animationDelay: delay,
              }}
            />
          );
        })}
      </span>
      <span
        className={
          total > 0 && node.mastery > 0 ? "mastery-value" : "mastery-value zero"
        }
      >
        {total > 0 ? `${node.mastery}%` : "—"}
      </span>
    </span>
  );
}
function readExpanded(root) {
  try {
    const saved = localStorage.getItem(`study-map-open:${root}`);
    return saved ? new Set(JSON.parse(saved)) : null;
  } catch {
    return null;
  }
}

export default function StudyMap({
  data,
  busy,
  start,
  resume,
  endRun,
  manage,
  openDraft,
  continueDraft,
  call,
  retryGeneration,
  openAgent,
  cancelJob,
  dismissJob,
  addSource,
  createManual,
  importLibrary,
  askInChat,
  notebooks,
  notebookError,
  onNotebookPublish,
  onNotebookUnpublish,
  onNotebookOpen,
  refreshNotebooks,
  onNotebookSearch,
  onShowGraph,
  onFocus,
  onCourseSettings,
  suggestRole,
  suggestMerges,
  mergeDecks,
  startCourseFlow,
  generateFromSources,
  setupHandlers,
  onCoachPractice,
  onWeakPoints,
  openModelSettings,
  canChat = false,
  reveal,
  onRevealed,
  children,
}) {
  useInjectCss(focusCss, "study-focus");
  useInjectCss(homeCss, "study-generate-home");
  useInjectCss(caseCss, "study-case-workspace");
  useInjectCss(tiersCss, "study-home-tiers");
  const pageRef = useRef(null), activityRef = useRef(null);
  // After a generation starts, land with its progress card in view (P26).
  useEffect(() => {
    if (!reveal) return;
    pageRef.current?.scrollIntoView?.({ block: "start" });
    onRevealed?.();
  }, [reveal]); // eslint-disable-line react-hooks/exhaustive-deps
  const [search, setSearch] = useState(""),
    [showOtherCourses, setShowOtherCourses] = useState(false),
    [showParked, setShowParked] = useState(false),
    [showAllCurrent, setShowAllCurrent] = useState(false),
    [roleDraft, setRoleDraft] = useState(data.focus?.role || ""),
    [jdDraft, setJdDraft] = useState(data.focus?.jd || ""),
    [roleProposal, setRoleProposal] = useState(null),
    [suggestBusy, setSuggestBusy] = useState(false),
    [suggestError, setSuggestError] = useState(""),
    [mergeSuggestions, setMergeSuggestions] = useState(null),
    [mergeBusy, setMergeBusy] = useState(false),
    [mergeError, setMergeError] = useState(""),
    [showArchived, setShowArchived] = useState(false),
    [selected, setSelected] = useState(() => new Set()),
    [menu, setMenu] = useState(null),
    [expanded, setExpanded] = useState(
      () =>
        readExpanded(data.root) ||
        new Set([
          ...data.decks.map((d) => "folder:" + d.folder),
          ...(data.decks.length <= 3 ? data.decks.map((d) => d.id) : []),
        ]),
    );
  useEffect(() => { setRoleDraft(data.focus?.role || ""); }, [data.focus?.role]);
  useEffect(() => { setJdDraft(data.focus?.jd || ""); }, [data.focus?.jd]);
  useEffect(() => {
    try {
      localStorage.setItem(
        `study-map-open:${data.root}`,
        JSON.stringify([...expanded]),
      );
    } catch {}
  }, [data.root, expanded]);
  useEffect(() => {
    if (!menu) return;
    const close = (e) => {
      if (!e.target.closest?.(".map-menu, .map-menu-toggle")) setMenu(null);
    };
    document.addEventListener("pointerdown", close);
    return () => document.removeEventListener("pointerdown", close);
  }, [menu]);

  const currentEntry = (data.focus?.courses || []).find((course) => course.name === data.focus?.course);
  const parkedChoices = (data.focus?.courses || []).filter(isParked);
  const progress = data.progress || EMPTY_PROGRESS,
    today = data.today || { due: 0, weak: 0, new: 0, size: 0 },
    runs = data.runs || [];
  // Audio imports and PDF conversions report progress in the Sources page, not among question generations.
  const jobs = (data.jobs || []).filter((job) => job.type !== "audio-import" && job.type !== "pdf-convert" && job.type !== "translation");
  const activeJobs = jobs.filter((job) => isActiveJob(job) && job.type !== "draft-publish");
  // Top of the home: what is still running first, then the newest finished cards.
  const visibleJobs = (() => {
    const shown = visibleGenerationJobs(jobs);
    return [...shown.filter(isActiveJob), ...shown.filter((job) => !isActiveJob(job)).reverse()];
  })();
  const modelReady = modelReadiness(data).ready;
  /* Mastery weighted by card count. Deck rows carry no mastery of their own in
     the snapshot; the per-deck figures live on `progress`. The current course
     leads; the whole library follows as context when it holds other courses. */
  const mastery = useMemo(() => {
    const measure = (decks) => {
      const rows = decks.map((d) => progress[d.id]).filter((p) => p && p.total);
      const total = rows.reduce((n, p) => n + p.total, 0);
      return total ? { value: Math.round(rows.reduce((n, p) => n + (p.mastery || 0) * p.total, 0) / total),
        cards: total, node: mergeProgress(rows) } : null;
    };
    const live = data.decks.filter((d) => !d.archived);
    const name = data.focus?.mode === "interview" ? null : data.focus?.course;
    // A parent course measures the courses inside it too.
    const within = name != null ? courseMatcher(data, name) : null;
    const inCourse = within ? live.filter((d) => !d.systemKind && within(d.course ?? d.folder ?? '')) : [];
    const course = inCourse.length ? measure(inCourse) : null;
    const whole = measure(live);
    const others = course && live.some((d) => !inCourse.includes(d) && progress[d.id]?.total);
    return { course, whole, name, others };
  }, [data.decks, data.focus?.course, data.focus?.courses, data.focus?.mode, progress]); // eslint-disable-line react-hooks/exhaustive-deps
  const primary = mastery.course || mastery.whole;
  const runFor = (scope) =>
    runs.find((r) => r.mode === "path" && sameScope(r.scope, scope));
  const todayRun = runFor([]);
  const query = search.trim().toLowerCase();
  const visible = data.decks.filter((d) => {
    if (!!d.archived !== showArchived) return false;
    if (!query) return true;
    return `${d.title} ${d.folder} ${d.topics.join(" ")}`
      .toLowerCase()
      .includes(query);
  });
  // The current course is a scope: a parent includes the courses inside it, shown parent first and chapters in natural order.
  const inFocus = useMemo(() => data.focus?.course == null ? () => false : courseMatcher(data, data.focus.course),
    [data.focus?.course, data.focus?.courses]); // eslint-disable-line react-hooks/exhaustive-deps
  const folders = useMemo(() => {
    const groups = new Map();
    for (const d of visible) {
      const course = d.course ?? d.folder ?? '';
      if (!groups.has(course)) groups.set(course, []);
      groups.get(course).push(d);
    }
    for (const [course, list] of groups) if (inFocus(course)) list.sort((a, b) => Date.parse(b.publishedAt || b.createdAt || 0) -
      Date.parse(a.publishedAt || a.createdAt || 0));
    const order = courseOrder(courseNamesOf(data));
    return [...groups].sort(([left], [right]) =>
      (Number(inFocus(right)) - Number(inFocus(left))) || (inFocus(left) && inFocus(right) ? order(left, right) : 0));
  }, [visible, inFocus]); // eslint-disable-line react-hooks/exhaustive-deps
  // 未激活 (lib/course-active.js): parked courses are listed apart, collapsed, dimmed and still reachable; the current course stays where it is.
  const parkedByName = useMemo(() => new Map((data.focus?.courses || []).filter(isParked).map((course) => [course.name, course])), [data.focus?.courses]);
  const parkedFolders = folders.filter(([course]) => parkedByName.has(course) && !inFocus(course));
  const liveFolders = folders.filter((entry) => !parkedFolders.includes(entry));
  const shownLive = query || showArchived || showOtherCourses
    ? liveFolders : liveFolders.filter(([course]) => inFocus(course));
  const shownParked = query || showParked ? parkedFolders : [];
  const shownFolders = [...shownLive, ...shownParked];
  const otherCourseCount = liveFolders.length - shownLive.length;
  const singleCourse = shownFolders.length === 1 && inFocus(shownFolders[0][0]);

  const toggleOpen = (id) =>
    setExpanded((v) => {
      const next = new Set(v);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  const isOpen = (id) => !!query || expanded.has(id);
  function toggleSelect(keys, on) {
    setSelected((v) => {
      const next = new Set(v);
      for (const k of keys) on ? next.add(k) : next.delete(k);
      // A whole deck supersedes its individual topics.
      for (const k of keys) {
        const [deckId, topic] = JSON.parse(k);
        if (!topic && on)
          for (const other of [...next])
            if (other !== k && JSON.parse(other)[0] === deckId)
              next.delete(other);
      }
      return next;
    });
  }
  const scope = scopeOf(selected);
  const selectedRun = scope.length ? runFor(scope) : null;

  function deckRow(d) {
    const p = progress[d.id],
      key = topicKey(d.id),
      whole = selected.has(key),
      run = runFor([{ deckId: d.id }]),
      open = isOpen(d.id);
    return (
      <li
        key={d.id}
        className={"map-deck" + (menu === d.id ? " menu-open" : "")}
      >
        <div className={"map-row deck-row" + (whole ? " selected" : "")}>
          <button
            className="map-caret"
            aria-expanded={open}
            aria-label={open ? ui("收起") : ui("展开")}
            onClick={() => toggleOpen(d.id)}
          >
            {open ? "▾" : "▸"}
          </button>
          <input
            type="checkbox"
            aria-label={uiFormat("选择题组 {0}", [d.title])}
            checked={whole}
            disabled={d.archived}
            onChange={(e) => toggleSelect([key], e.target.checked)}
          />
          <span className={"map-dot lv-" + (p ? dotLevel(p) : "new")} />
          <button className="map-name" onClick={() => toggleOpen(d.id)}>
            <strong>{d.title}{d.format === "case-study" && <span className="case-badge" title={ui("案例分析题组：长案例 + 开放题，按评分标准批改")}>
              {d.caseBest ? uiFormat("案例 · 最好 {0}/{1}", [d.caseBest.total, d.caseBest.max]) : uiFormat("案例 · {0} 分", [d.caseMarks])}</span>}</strong>
            <small>
              {d.available}{ui(" 题")}{p?.due ? uiFormat(" · {0} 题到期", [p.due]) : ""}
              {d.wrong ? uiFormat(" · {0} 题待巩固", [d.wrong]) : ""}
              {d.uncheckedAtPublish ? uiFormat(" · {0} 题未自动审阅", [d.uncheckedAtPublish]) : ""}
              {d.selfCited ? uiFormat(" · {0} 题仅有导入题目引用", [d.selfCited]) : ""}
              {d.archived ? ui(" · 已归档") : ""}
            </small>
          </button>
          {p && <MasteryBar node={p} />}
          <button
            className={"map-play" + (run ? " is-run" : "")}
            disabled={busy || d.archived || !d.available}
            title={run ? uiFormat("继续 {0}/{1}", [run.index + 1, run.total]) : uiFormat("学习全部 {0} 题", [d.available])}
            aria-label={uiFormat("开始学习 {0}", [d.title])}
            onClick={() =>
              run ? resume(run.id) : start({ mode: "path", scope: [{ deckId: d.id }] })
            }
          >
            {run ? ui("继续") : "▶"}
          </button>
          <span className="map-menu-wrap">
            <button
              className="map-menu-toggle"
              aria-label={ui("更多操作")}
              aria-expanded={menu === d.id}
              onClick={() => setMenu(menu === d.id ? null : d.id)}
            >
              ⋯
            </button>
            {menu === d.id && (
              <div className="map-menu" role="menu">
                {[
                  [ui("从新题开始"), () => start({ deckId: d.id, mode: "new", fresh: true }), !p?.counts?.new],
                  [ui("闪卡翻看"), () => start({ deckId: d.id, mode: "flashcard" }), !d.available],
                  [ui("测验"), () => start({ deckId: d.id, mode: "quiz" }), !d.quizCount],
                  [uiFormat("待巩固重练 {0}", [d.wrong || 0]), () => start({ deckId: d.id, mode: "wrong" }), !d.wrong],
                  [
                    ui("在对话中分析"),
                    () =>
                      askInChat(
                        uiFormat("请用 study_workspace 查看题组「{0}」的掌握情况（map），告诉我哪些主题最薄弱，并安排接下来的学习顺序。", [d.title]),
                      ),
                    false,
                  ],
                  [ui("管理题组"), () => manage(d.id), false],
                ].map(([label, run, disabled]) => (
                  <button
                    key={label}
                    role="menuitem"
                    disabled={busy || disabled || (d.archived && label !== ui("管理题组"))}
                    onClick={() => {
                      setMenu(null);
                      run();
                    }}
                  >
                    {label}
                  </button>
                ))}
              </div>
            )}
          </span>
        </div>
        {open && p?.topics.length > 0 && (
          <ul className="map-topics">
            {p.topics.map((t) => {
              const k = topicKey(d.id, t.name),
                level = dotLevel(t),
                topicRun = runFor([{ deckId: d.id, topic: t.name }]);
              return (
                <li
                  key={t.name}
                  className={"map-row topic-row" + (whole || selected.has(k) ? " selected" : "")}
                >
                  <input
                    type="checkbox"
                    aria-label={uiFormat("选择主题 {0}", [t.name])}
                    checked={whole || selected.has(k)}
                    disabled={whole || d.archived}
                    onChange={(e) => toggleSelect([k], e.target.checked)}
                  />
                  <span className={"map-dot lv-" + level} title={LEVEL_LABEL[level]} />
                  <span className="map-name">
                    <span>{t.name}</span>
                    <small>
                      {t.total}{ui(" 题 · ")}{t.due ? uiFormat("{0} 题到期", [t.due]) : LEVEL_LABEL[level]}
                    </small>
                  </span>
                  <MasteryBar node={t} />
                  <button
                    className={"map-play" + (topicRun ? " is-run" : "")}
                    disabled={busy || d.archived}
                    aria-label={uiFormat("学习主题 {0}", [t.name])}
                    title={topicRun ? uiFormat("继续 {0}/{1}", [topicRun.index + 1, topicRun.total]) : ui("学习这个主题")}
                    onClick={() =>
                      topicRun
                        ? resume(topicRun.id)
                        : start({ mode: "path", scope: [{ deckId: d.id, topic: t.name }] })
                    }
                  >
                    {topicRun ? ui("继续") : "▶"}
                  </button>
                  <button
                    className="map-ask"
                    title={ui("在对话中讲解这个主题")}
                    aria-label={uiFormat("在对话中讲解 {0}", [t.name])}
                    onClick={() =>
                      askInChat(
                        uiFormat('请结合学习库里的资料，给我讲解「{0}」（题组「{1}」）。我目前掌握度 {2}%{3}。先讲核心概念，再用一两道小问题检查我是否理解。', [t.name, d.title, t.mastery, t.counts.weak ? uiFormat('，有 {0} 道题当前薄弱', [t.counts.weak]) : '']),
                      )
                    }
                  >{ui("问")}</button>
                </li>
              );
            })}
          </ul>
        )}
      </li>
    );
  }

  /* No decks yet: the card walks a newcomer from materials to a first deck
     (D1): add a material → generate from it → check and publish the draft.
     JSON import stays one link away for people who already have questions. */
  const materials = documentCount(data.sources || []),
    newestDraft = data.drafts?.at(-1),
    generating = activeJobs.some((job) => job.type !== "draft-repair"),
    jsonLink = [ui("已有题目？导入 JSON 题组"), importLibrary],
    revealActivity = () => (activityRef.current || pageRef.current)?.scrollIntoView?.({ block: "start", behavior: "smooth" });
  const starter = data.decks.length ? null
    : newestDraft ? { kind: "empty", step: 2, eyebrow: ui("下一步"), headline: ui("检查草稿，就能开始练习"),
        title: ui("草稿已生成"), next: ui("草稿里的每道题都能修改；发布时还会再检查一遍。"),
        action: { label: ui("检查并发布草稿"), run: () => openDraft(newestDraft) }, also: [jsonLink] }
    : generating ? { kind: "empty", step: 1, eyebrow: ui("正在出题"), headline: ui("第一组题正在生成"),
        title: ui("正在出第一组题"), next: ui("出题在后台进行，离开这一页也不会中断；完成后草稿会出现在上方。"),
        action: { label: ui("查看进度"), run: revealActivity }, also: [] }
    : materials ? { kind: "empty", step: 1, eyebrow: ui("下一步"), headline: ui("用资料出第一组题"),
        title: uiFormat("{0} 份资料已就绪", [materials]), next: ui("选好资料、题型和题数，AI 出题后会逐题检查，再交给你确认。"),
        action: { label: uiFormat("用这 {0} 份资料出题", [materials]), run: () => generateFromSources?.(data.sources.map((source) => source.id)) },
        also: [[ui("＋ 再添加资料"), addSource], jsonLink] }
    : { kind: "empty", step: 0, eyebrow: ui("开始"), headline: ui("从一份资料开始"),
        title: ui("还没有资料"), next: ui("添加讲义、笔记或 PDF，AI 会据此出题；发布后这里会给出学习路径。"),
        action: { label: ui("添加第一份资料"), run: addSource },
        also: [jsonLink, ...(canChat ? [[ui("在对话中用工作区文件出题"), () => askInChat(
          ui("请读取工作区里的 `<文件路径>`，用 study_workspace 添加为学习资料，并生成 10 道题。"))]] : [])] };
  const headline = starter
    ? starter.headline
    : today.ahead
      ? ui("今天的任务都完成了")
      : [
          today.due && uiFormat("{0} 题到期", [today.due]),
          today.weak && uiFormat("{0} 题薄弱", [today.weak]),
          today.new && uiFormat("{0} 题未学", [today.new]),
        ]
          .filter(Boolean)
          .join(" · ") || ui("暂无可学习的题目");

  const slain = data.decks.find((d) => d.systemKind === "slain");
  const interview = data.focus?.mode === "interview",
    freshAll = data.focus?.fresh?.length || 0,
    freshCount = Math.min(10, freshAll),
    todayLabel = new Intl.DateTimeFormat(uiLocale(), { month: "long", day: "numeric", weekday: "short" })
      .format(new Date()),
    breakdown = [
      today.due && uiFormat("{0} 题到期", [today.due]),
      today.weak && uiFormat("{0} 题薄弱", [today.weak]),
      today.new && uiFormat("{0} 题未学", [today.new]),
    ].filter(Boolean).join(" · "),
    startFresh = () => start({ mode: "new", currentCourse: true, count: 10, fresh: true }),
    startPath = () => (todayRun ? resume(todayRun.id) : start({ mode: "path" })),
    // 课程路线 (class mode): an unfinished batch first, else the next batch in chapter order.
    route = !interview ? data.focus?.route : null,
    courseRun = route && runs.find((r) => r.purpose === "course" && r.course === route.course),
    startCourse = () => (courseRun ? resume(courseRun.id) : start({ mode: "course" })),
    flowLink = startCourseFlow && route?.next?.fresh ? [[ui("先讲后练 · 学习流"), () => startCourseFlow()]] : [];
  /* The card offers exactly one action. An open run wins, then the current
     course's new questions (class mode), then today's review path. Every
     other start stays reachable as a quiet link beside it. */
  const base = starter
    ? starter
    : courseRun
      ? { kind: "resume", eyebrow: ui("继续课程"), count: courseRun.total - courseRun.index, unit: ui("题未完成"),
          detail: uiFormat("这一批已做到第 {0} / {1} 题", [courseRun.index + 1, courseRun.total]),
          action: { label: ui("接着学"), run: startCourse }, also: today.size ? [[uiFormat("到期复习与巩固 · {0} 题", [today.size]), startPath]] : [] }
    : todayRun
      ? { kind: "resume", eyebrow: ui("继续今日"), count: todayRun.total - todayRun.index, unit: ui("题未完成"),
          detail: uiFormat("已做到第 {0} / {1} 题", [todayRun.index + 1, todayRun.total]),
          action: { label: ui("继续学习"), run: startPath },
          also: !interview && freshCount ? [[uiFormat("学当前课程新题 · {0} 题", [freshCount]), startFresh]] : [] }
      : route?.next
        ? { kind: "course", eyebrow: route.current === null ? ui("课程巩固") : uiFormat("第 {0} / {1} 章", [route.current + 1, route.chapters.length]),
            count: route.next.fresh + route.next.reviews, unit: ui("题 · 这一批"),
            detail: `${route.next.label}${route.next.reviews ? uiFormat(" · 先巩固 {0} 道", [route.next.reviews]) : ""}`,
            action: { label: ui("继续课程"), run: startCourse },
            also: [...flowLink, ...(today.size ? [[uiFormat("到期复习与巩固 · {0} 题", [today.size]), startPath]] : [])] }
      : !interview && freshCount
        ? { kind: "fresh", eyebrow: ui("当前课程"), count: freshCount, unit: ui("道新题"),
            detail: freshAll > freshCount
              ? uiFormat("本轮先学 {0} 道，课程还有 {1} 道未学", [freshCount, freshAll - freshCount]) : ui("当前课程的全部新题"),
            action: { label: ui("开始学新题"), run: startFresh },
            also: today.size ? [[uiFormat("到期复习与巩固 · {0} 题", [today.size]), startPath]] : [] }
        : { kind: today.size ? "path" : "clear", eyebrow: today.ahead ? ui("提前巩固") : ui("今日学习"),
            count: today.size, unit: today.size ? ui("题待学") : ui("题待学"),
            detail: today.ahead ? ui("今天的任务都完成了") : today.size ? breakdown : ui("今天已经清空"),
            action: { label: today.ahead ? ui("提前巩固") : ui("开始今日学习"), run: startPath, disabled: !today.size },
            also: [] };
  /* The run the learner was last inside (the rail's 回到题目) outranks a new
     batch: a deck, topic or 为你定制 run left half done must not sink into
     the fold below while the big button quietly starts something else. */
  const lastRunFound = data.decks.length ? runs.find((r) => r.id === data.lastRun?.id) : null;
  // A half-done practice in a parked course is not pushed as 接着做; it stays in the list below with its state.
  const lastOpen = lastRunFound && !lastRunFound.inactive ? lastRunFound : null;
  /* A semester holds several courses and any of them may be the one left half
     done, so a run from outside the course in the heading names its course
     instead of being held back. System decks (为你定制) belong to no course. */
  const otherCourse = (r) => {
      const courses = new Set((r.deckIds || [r.deckId]).map((id) => data.decks.find((d) => d.id === id))
        .filter((d) => d && !d.systemKind).map((d) => d.course));
      const [course] = courses;
      return courses.size === 1 && (interview || !inFocus(course ?? "")) ? course : "";
    };
  const baseLink = base.kind === "course" ? uiFormat("课程下一批 · {0} 题", [base.count])
    : base.kind === "fresh" ? uiFormat("学当前课程新题 · {0} 题", [base.count])
      : base.kind === "path" ? uiFormat("到期复习与巩固 · {0} 题", [base.count]) : "";
  const plan = lastOpen && lastOpen !== courseRun && lastOpen !== todayRun
    ? { kind: "resume", eyebrow: ui("接着上次"), count: lastOpen.total - lastOpen.index, unit: ui("题未完成"),
        detail: uiFormat("{0} · 已做到第 {1} / {2} 题", [
          [otherCourse(lastOpen), lastOpen.title].filter(Boolean).join(" › "), lastOpen.index + 1, lastOpen.total]),
        action: { label: ui("接着做"), run: () => resume(lastOpen.id) },
        also: [...(baseLink ? [[baseLink, base.action.run]] : []),
          ...base.also.filter(([label]) => label !== baseLink)] }
    : base;
  const shownRun = plan === base ? courseRun || todayRun : lastOpen,
    otherRuns = runs.filter((r) => r !== shownRun);
  /* The other ways to start (new questions, due review, the flow, personalised questions, weak points) sit under one folded
     line: the card is the one thing to continue, the recommendation the one next step. */
  const alternatives = [
    ...plan.also.map(([label, run]) => [label, run]),
    ...(data.coach?.ready > 0 && onCoachPractice ? [[uiFormat("刷 {0} 道为你定制的题", [data.coach.ready]), onCoachPractice,
      ui("从你答错、标记太简单/太难和只练了概念的地方出发，换成具体场景再练一遍。")]] : []),
    ...(today.weak > 0 && onWeakPoints ? [[uiFormat("{0} 题薄弱 · 看错题与待巩固", [today.weak]), onWeakPoints, ui(TERMS.weak.hint)]] : []),
  ];
  // Cards visible behind the top one: the stack is as thick as the day.
  plan.depth = plan.kind === "empty" ? 0 : Math.min(2, Math.max(0, (plan.count || 0) - 1));
  const showNotebooks = data.decks.length > 0 || (notebooks?.notebooks || []).some((n) => !n.current);
  const drafts = data.drafts || [];
  const quick = useQuickActions();
  const finishedCount = visibleJobs.filter((j) => !isActiveJob(j) && !j.leaving).length;
  /* Generation progress and drafts waiting for review sit at the top of the
     home (P26): a job started from 创建题组 is in view when the learner lands
     here, and a failure shows up where they are looking (P15). */
  const activity = (visibleJobs.length > 0 || drafts.length > 0) && (
    <section className="home-activity" ref={activityRef} aria-label={ui("出题进度与待发布草稿")}>
      {visibleJobs.length > 0 && <div className="jobs generation-jobs">
        {visibleJobs.map((j) => <JobCard key={j.id} job={j} jobs={visibleJobs} drafts={drafts} busy={busy} openDraft={openDraft}
          openAgent={openAgent} cancelJob={cancelJob} dismissJob={dismissJob} retryGeneration={retryGeneration}
          openModelSettings={openModelSettings} openDeck={manage}
          practiceCards={(deckId, cardIds) => start({ mode: "path", scope: cardIds.map((cardId) => ({ deckId, cardId })), fresh: true })} />)}
        {dismissJob && finishedCount > 1 && <div className="jobs-actions">
          {quick?.failures["jobs:all"] && <span className="job-error" role="alert">{uiFormat("没能全部移除：{0}", [quick.failures["jobs:all"]])}</span>}
          {/* Not part of the single-flight act: it must stay clickable whatever else is running. */}
          <button type="button" className="link-btn jobs-dismiss-all" onClick={() => dismissJob()}>{ui("全部知道了")}</button>
        </div>}
      </div>}
      {drafts.length > 0 && <div className="home-drafts">
        <div className="section-heading">
          <h2>{ui("待发布 ")}<span>{drafts.length}</span>
          </h2>
          <small>{ui("发布时逐题检查；问题题留在草稿")}</small>
        </div>
        {[...drafts].reverse().map((d) => {
          const missing = missingQuestions(d);
          const qualityCount = (d.quality?.warnings?.length || 0) + (d.quality?.errors?.length || 0);
          const rejectedCount = d.cards.filter((card) => d.editorial?.rejectedIssues?.[card.id]).length;
          const reviewed = reviewedCardStatus(d);
          return <div key={d.id} className="draft-row">
            <button type="button" className="draft-open" onClick={() => openDraft(d)}>
              <span>
                <strong>{d.title}</strong>
                <small>
                  {d.cards.length}{ui(" 道题")}{qualityCount ? uiFormat(" · {0} 项质量提醒", [qualityCount]) : ""}
                  {rejectedCount ? uiFormat(" · {0} 题待处理", [rejectedCount])
                    : ` · ${reviewed?.unchanged === d.cards.length ? ui("已复审，待发布") : ui("待发布检查")}`}
                  {missing > 0 ? uiFormat(" · 还差 {0} 题", [missing]) : ""}
                  {Number.isInteger(d.editorial?.completedParts) && d.editorial.completedParts < d.editorial.parts
                    ? uiFormat(" · 生成未完成 {0}/{1} 批", [d.editorial.completedParts, d.editorial.parts]) : ""}
                </small>
              </span>
              <span>{ui("打开 →")}</span>
            </button>
            <DraftTopUp draft={d} jobs={data.jobs} busy={busy} modelReady={modelReady} call={call} onContinue={continueDraft} />
          </div>;
        })}
      </div>}
    </section>
  );

  return (
    <section className="page library-page map-page" ref={pageRef}>
      {children}
      {activity}
      {/* 课程准备: what is done once per course, above the day's work while it is open and one quiet line after. */}
      <SetupChecklist key={`${data.root}:${data.focus?.course ?? ""}`} data={data} call={call} busy={busy} on={setupHandlers} />
      <div className={"desk" + (plan.kind === "empty" ? " is-empty" : "")} data-tour="home-hero">
        <div className="desk-intro">
          {/* The study-mode switch matters once there is something to study (P12). */}
          {(data.decks.length > 0 || interview) && <SegmentedControl className="focus-switch" label={ui("学习模式")} value={interview ? "interview" : "class"}
            onChange={(mode) => onFocus?.({ mode })}
            options={[{ value: "class", label: ui("课堂跟学") }, { value: "interview", label: ui("笔试 / 面试") }]} />}
          {interview ? (
            <input className="course-heading-input" aria-label={ui("岗位方向")} placeholder={ui("输入岗位方向")}
              value={roleDraft} onChange={(event) => setRoleDraft(event.target.value)} onBlur={() => {
                const role = roleDraft.trim();
                if (role !== (data.focus?.role || "")) onFocus?.({ role });
              }} />
          ) : (data.focus?.courses || []).length ? (
            <h1 className="course-heading" data-tour="home-course">
              <span>{data.focus?.course === '' ? ui('未分类课程') : data.focus?.course || headline}</span>
              <span className="course-caret" aria-hidden="true">▾</span>
              <ExamCountdown course={(data.courses || []).find((course) => course.id === data.focus?.courseId)} />
              {/* The heading is the course switcher: a transparent native select
                  keeps keyboard and screen-reader behaviour intact. Its last
                  entry opens the current course's settings (WP13). */}
              <select aria-label={ui("切换当前课程")} value={data.focus?.course || ""}
                onChange={(event) => event.target.value === "@course-settings"
                  ? onCourseSettings?.(data.focus?.courseId) : onFocus?.({ course: event.target.value })}>
                {/* Ranked like every course picker (current, recently used, busiest) with "Course / Chapter" names grouped (WP14). */}
                {groupCourseNames(rankCourses({ courses: (data.focus?.courses || []).filter((course) => !isParked(course)), current: data.focus?.course })).map((entry) => entry.type === "group"
                  ? <optgroup key={`group:${entry.key}`} label={entry.name}>
                    <option value={entry.parent.name}>{entry.parent.name} · {ui("含子课程")}</option>
                    {entry.chapters.map(({ course, chapter, depth }) => <option key={course.name} value={course.name}>{"\u00a0\u00a0".repeat(Math.max(0, depth - 1))}{chapter}</option>)}
                  </optgroup>
                  : <option key={entry.course.name} value={entry.course.name}>{entry.course.name || ui('未分类课程')}</option>)}
                {/* Parked courses stay reachable, grouped apart; the heading's value may be one of them. */}
                {parkedChoices.length > 0 && <optgroup label={uiFormat("未激活的课程 ({0})", [parkedChoices.length])}>
                  {parkedChoices.map((course) => <option key={course.name} value={course.name}>{course.name}</option>)}
                </optgroup>}
                {onCourseSettings && data.focus?.courseId && <option value="@course-settings">{ui("课程设置…")}</option>}
              </select>
            </h1>
          ) : (
            <h1 className="course-heading">{headline}</h1>
          )}
          {!interview && isParked(currentEntry) && <p className="course-parked-line"><ParkedChip course={currentEntry} />
            <small>{ui("未激活的课程不进入到期复习和推荐；随时可以再激活")}</small></p>}
          {interview && <div className="role-prep">
            <details><summary>{ui("用岗位描述细化练习范围")}</summary>
              <textarea rows={4} value={jdDraft} placeholder={ui("需要时粘贴 JD；不贴也可按岗位方向匹配")}
                onChange={(event) => setJdDraft(event.target.value)} />
              <button disabled={suggestBusy || !roleDraft.trim()} onClick={async () => {
                setSuggestBusy(true);
                setSuggestError("");
                try { setRoleProposal(await suggestRole?.({ role: roleDraft.trim(), jd: jdDraft })); }
                catch (error) { setSuggestError(error.message); }
                finally { setSuggestBusy(false); }
              }}>{suggestBusy ? ui("匹配中…") : ui("AI 匹配知识点")}</button>
              {suggestError && <p role="alert">{suggestError}</p>}
              {roleProposal && <div className="role-proposal">
                <p>{ui("建议练习：")}{roleProposal.targetTopics.length
                  ? roleProposal.targetTopics.join("、") : ui("暂无匹配的现有知识点，可先用全库薄弱题练习")}</p>
                <button className="primary" onClick={() => {
                  onFocus?.({ mode: "interview", role: roleProposal.role, jd: roleProposal.jd,
                    targetTopics: roleProposal.targetTopics });
                  setRoleProposal(null);
                }}>{ui("确认岗位范围")}</button>
              </div>}
            </details>
            {!!data.focus?.roleWeak?.length && <div className="role-weak">
              <strong>{ui("优先练这些薄弱点")}</strong>
              {data.focus.roleWeak.slice(0, 3).map((item) => <button key={`${item.deckId}:${item.topic}`}
                onClick={() => start({ mode: "path", scope: [{ deckId: item.deckId, topic: item.topic }] })}>
                {item.topic} · {item.weak}{ui(" 道薄弱题 →")}</button>)}
            </div>}
          </div>}
          {route && <CourseRoute route={route} busy={busy} onStartChapter={(deckId) => start({ mode: "course", deckId, fresh: true })} />}
          {primary && (
            <div className="desk-mastery" title={`${mastery.course ? uiFormat("「{0}」的掌握度 {1}%（{2} 题）", [mastery.name || ui('未分类课程'), mastery.course.value, mastery.course.cards]) : uiFormat("所有课程的掌握度 {0}%", [primary.value])}\n${ui(TERMS.mastery.hint)}\n${ui(TERMS.mastered.hint)}`}>
              <span className="desk-mastery-value">{primary.value}<small>%</small></span>
              <span className="desk-mastery-label">{ui(TERMS.mastery.label)}</span>
              <MasteryBar node={primary.node} />
              {mastery.others && mastery.whole && (
                <span className="desk-mastery-all" title={uiFormat("全部课程合计 {0} 题", [mastery.whole.cards])}>{ui("所有课程 ")}<strong>{mastery.whole.value}%</strong>
                </span>
              )}
            </div>
          )}
          <p className="desk-next">
            {data.next ? (
              <>
                <span className="desk-next-label">{ui("推荐下一步")}</span>
                <span className="desk-next-topic">{data.next.deckTitle} › <strong>{data.next.topic}</strong>
                  <small title={ui("按课程里题组和主题的顺序，这是第一个还没掌握的主题。")}>{uiFormat(" · 课程里下一个没掌握的主题 · 掌握 {0}%", [data.next.mastery])}</small></span>
                <button className="link-btn" disabled={busy} onClick={() =>
                  start({ mode: "path", scope: [{ deckId: data.next.deckId, topic: data.next.topic }] })}>{ui("只学这个主题 →")}</button>
              </>
            ) : starter
              ? starter.next
              : ui("所有主题都已掌握，可以提前巩固。")}
          </p>
          {plan.kind === "empty" && plan.also.length > 0 && (
            <p className="desk-also">
              {plan.also.map(([label, run]) => <button key={label} className="link-btn" disabled={busy} onClick={run}>{label}</button>)}
            </p>
          )}
          {plan.kind !== "empty" && alternatives.length > 0 && (
            <details className="desk-more">
              <summary>{ui("其他开始方式")}</summary>
              <p className="desk-also">
                {alternatives.map(([label, run, hint]) => (
                  <button key={label} className="link-btn" disabled={busy} title={hint} onClick={run}>{label}</button>
                ))}
              </p>
            </details>
          )}
          {otherRuns.length > 0 && (
            <details className="resume-list">
              <summary>{ui("另有 ")}{otherRuns.length}{ui(" 组练习未完成")}</summary>
              {otherRuns
                .map((r) => (
                  <div className="resume-row" key={r.id}>
                    <button className="resume" disabled={busy} onClick={() => resume(r.id)}>
                      <span>
                        <span className="eyebrow">{[otherCourse(r) || ui("继续上次学习"), r.inactive ? ui("未激活") : ""].filter(Boolean).join(" · ")}</span>
                        <strong>{r.title}</strong>
                      </span>
                      <span>
                        {r.index + 1} / {r.total} <b>→</b>
                      </span>
                    </button>
                    <button
                      className="ghost-btn"
                      disabled={busy}
                      onClick={() => endRun(r.id)}
                      title={ui("结束此轮，保留已答记录")}
                    >{ui("结束")}</button>
                  </div>
                ))}
            </details>
          )}
        </div>
        <div className="today-stack" data-depth={plan.depth} data-tour="home-today">
          <div className="today-card">
            <div className="today-card-head">
              <span>{plan.eyebrow}</span>
              <time>{todayLabel}</time>
            </div>
            {plan.kind === "empty" ? (
              <>
                <p className="today-card-empty">{plan.title}</p>
                <ol className="starter-steps" aria-label={ui("第一组题的三步")}>
                  {[ui("添加资料"), ui("用资料出题"), ui("检查并发布")].map((label, index) => (
                    <li key={label} className={index < plan.step ? "is-done" : index === plan.step ? "is-current" : undefined}
                      aria-current={index === plan.step ? "step" : undefined}>
                      <span className="starter-mark" aria-hidden="true">{index < plan.step ? "✓" : index + 1}</span>{label}
                    </li>
                  ))}
                </ol>
              </>
            ) : (
              <div className="today-count">
                <strong>{plan.count}</strong>
                <span>{plan.unit}</span>
              </div>
            )}
            {plan.detail && <p className="today-detail" title={plan.kind === "path" ? ui(TERMS.due.hint) : undefined}>{plan.detail}</p>}
            {plan.action && (
              <button className="primary today-go" disabled={busy || plan.action.disabled} data-usage="home.start"
                onClick={plan.action.run}>
                {plan.action.label}<span aria-hidden="true">→</span>
              </button>
            )}
          </div>
        </div>
      </div>

      <div className="section-heading map-heading" data-tour="home-catalog">
        <h2>{ui("学习目录 ")}<span>{data.decks.filter((d) => !d.archived).length}</span>
        </h2>
        <div className="section-heading-actions">
          {data.decks.length > 0 && <button
            disabled={busy}
            title={ui("用整块画布打开知识结构图 / 学习路径图（可缩放、拖拽）")}
            onClick={() => onShowGraph?.(null, { canvas: true })}
          >{ui("查看图谱")}</button>}
          {/* Housekeeping lives behind one menu so the heading stays quiet. */}
          <span className="map-menu-wrap">
            <button
              className="map-menu-toggle catalog-menu-toggle"
              aria-haspopup="menu"
              aria-expanded={menu === "catalog"}
              onClick={() => setMenu(menu === "catalog" ? null : "catalog")}
            >
              {mergeBusy ? ui("整理中…") : ui("整理与添加")}
            </button>
            {menu === "catalog" && (
              <div className="map-menu" role="menu">
                {[
                  data.focus?.course != null && [ui("整理题组"), async () => {
                    setMergeBusy(true);
                    setMergeError("");
                    try { setMergeSuggestions(await suggestMerges?.({ course: data.focus.course })); }
                    catch (error) { setMergeError(error.message); }
                    finally { setMergeBusy(false); }
                  }, busy || mergeBusy],
                  [ui("＋ 添加资料"), addSource, false],
                  [ui("手工建卡"), createManual, !data.sources.length],
                  [ui("导入 JSON 题组"), importLibrary, false],
                  slain && [uiFormat("斩题组（{0}）", [slain.count]), () => manage(slain.id), busy],
                ].filter(Boolean).map(([label, run, disabled]) => (
                  <button
                    key={label}
                    role="menuitem"
                    disabled={disabled}
                    onClick={() => {
                      setMenu(null);
                      run();
                    }}
                  >
                    {label}
                  </button>
                ))}
              </div>
            )}
          </span>
        </div>
      </div>
      <TopicGroupReminder grouping={data.topicGrouping} root={data.root} askInChat={askInChat} />
      {mergeError && <p role="alert">{mergeError}</p>}
      {mergeSuggestions && <div className="merge-suggestions">
        <div className="merge-suggestions-head">
          <strong>{mergeSuggestions.course}{ui(" · 合并建议")}</strong>
          <button onClick={() => setMergeSuggestions(null)}>{ui("关闭")}</button>
        </div>
        {!mergeSuggestions.proposals.length && <p className="muted">
          {mergeSuggestions.method === "unavailable" ? ui("当前没有可用模型；可以在题组管理中手动合并。") : ui("没有发现值得合并的题组。")}
        </p>}
        {mergeSuggestions.proposals.map((item) => <div className="merge-suggestion" key={item.targetId}>
          <div><strong>{item.sourceTitles.join("、")} → {item.targetTitle}</strong>
            <p>{item.reason}{ui(" · 合并后共 ")}{item.count}{ui(" 题，全部题目保留。")}</p></div>
          <button disabled={busy || mergeBusy} onClick={async () => {
            setMergeBusy(true);
            setMergeError("");
            try {
              await mergeDecks?.({ targetId: item.targetId, sourceIds: item.sourceIds });
              setMergeSuggestions((current) => ({ ...current,
                proposals: current.proposals.filter((proposal) => proposal.targetId !== item.targetId) }));
            } catch (error) { setMergeError(error.message); }
            finally { setMergeBusy(false); }
          }}>{ui("确认合并")}</button>
        </div>)}
      </div>}
      {data.decks.length > 0 && (
        <div className="map-toolbar">
          <div className="map-tools">
            <input
              type="search"
              aria-label={ui("搜索题组或主题")}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={ui("搜索题组、目录或主题")}
            />
            <button
              className={showArchived ? "chip active" : "chip"}
              aria-pressed={showArchived}
              onClick={() => setShowArchived((v) => !v)}
            >{ui("已归档")}</button>
          </div>
          <div className="map-legend" aria-label={ui("掌握程度图例")}>
            {BAR_ORDER.map((l) => (
              <span key={l} title={ui(LEVEL_HINT[l])}>
                <i className={"lv-" + l} />
                {LEVEL_LABEL[l]}
              </span>
            ))}
          </div>
        </div>
      )}
      {visible.length ? (
        <ul className={"map-tree" + (singleCourse ? " single-course" : "")}>
          {shownFolders.map(([folder, decks]) => {
            if (!folder) return decks.map((d) => deckRow(d));
            // The arrow alone opens and closes a course. When the course is the
            // only one on screen its header is hidden, so it is always open.
            const open = singleCourse || isOpen("folder:" + folder),
              truncated = inFocus(folder) && !query && decks.length > 3,
              shown = truncated && !showAllCurrent ? decks.slice(0, 3) : decks,
              parked = parkedByName.get(folder);
            return (
              <li
                key={"folder:" + folder}
                className={"map-folder" + (decks.some((d) => d.id === menu) ? " menu-open" : "") + (parked ? " is-parked-row" : "")}
              >
                <div className="map-row folder-row">
                  <button
                    className="map-caret"
                    aria-expanded={open}
                    onClick={() => toggleOpen("folder:" + folder)}
                  >
                    {open ? "▾" : "▸"}
                  </button>
                  <input
                    type="checkbox"
                    aria-label={uiFormat("选择目录 {0}", [folder])}
                    checked={decks.every((d) => selected.has(topicKey(d.id)))}
                    onChange={(e) =>
                      toggleSelect(
                        decks.filter((d) => !d.archived).map((d) => topicKey(d.id)),
                        e.target.checked,
                      )
                    }
                  />
                  <span className="map-folder-icon">▤</span>
                  <button className="map-name" onClick={() => toggleOpen("folder:" + folder)}>
                    <strong title={folder}>{courseRelative(folder, data.focus?.course, courseNamesOf(data)) ?? folder}</strong>
                    <small>{decks.length}{ui(" 个题组")}</small>
                  </button>
                  {parked && <ParkedChip course={parked} />}
                  <MasteryBar
                    node={mergeProgress(decks.map((d) => progress[d.id]).filter(Boolean))}
                  />
                </div>
                {open && (
                  <ul className="map-children">
                    {shown.map((d) => deckRow(d))}
                    {truncated && (
                      <li className="map-more">
                        <button className="show-other-courses" aria-expanded={showAllCurrent}
                          onClick={() => setShowAllCurrent((value) => !value)}>
                          {showAllCurrent ? ui("收起，只看最近 3 个题组") : uiFormat("查看全部题组 · {0}", [decks.length])}
                        </button>
                      </li>
                    )}
                  </ul>
                )}
              </li>
            );
          })}
        </ul>
      ) : data.decks.length ? (
        <p className="muted map-empty">{ui("没有符合条件的题组。")}</p>
      ) : (
        // The desk above already says what to do first; the catalogue only explains itself.
        <p className="muted map-empty">{ui("发布第一组题后，这里会按课程列出题组和掌握度。")}</p>
      )}
      {otherCourseCount > 0 && <button className="show-other-courses"
        onClick={() => setShowOtherCourses(true)}>{ui("查看其他课程 · ")}{otherCourseCount}</button>}
      {parkedFolders.length > 0 && !query && <button className="show-other-courses parked-toggle" aria-expanded={showParked}
        onClick={() => setShowParked((value) => !value)}>{showParked ? "▾ " : "▸ "}{uiFormat("未激活的课程 ({0})", [parkedFolders.length])}</button>}

      {/* Cross-workspace notebooks are for people with decks, or with notebooks elsewhere (P12). */}
      {showNotebooks && <NotebookDirectory
        notebooks={notebooks}
        error={notebookError}
        busy={busy}
        onPublish={onNotebookPublish}
        onUnpublish={onNotebookUnpublish}
        onOpen={onNotebookOpen}
        refresh={refreshNotebooks}
        onSearch={onNotebookSearch}
      />}

      {scope.length > 0 && (
        <div className="selection-bar" role="region" aria-label={ui("已选内容")}>
          <span>{ui("已选 ")}{scope.length}{ui(" 项")}</span>
          <button onClick={() => setSelected(new Set())}>{ui("清除")}</button>
          <button
            disabled={busy}
            title={ui("用整块画布打开所选范围的知识结构图或学习路径图（可缩放、拖拽）")}
            onClick={() => onShowGraph?.(scopeOf(selected), { canvas: true })}
          >{ui("查看图谱")}</button>
          <button
            className="primary"
            disabled={busy}
            onClick={() =>
              selectedRun ? resume(selectedRun.id) : start({ mode: "path", scope })
            }
          >
            {selectedRun
              ? uiFormat("▶ 继续 {0}/{1}", [selectedRun.index + 1, selectedRun.total])
              : ui("▶ 学习所选内容")}
          </button>
        </div>
      )}

    </section>
  );
}

const JOB_MARKS = { queued: "info", done: "success", partial: "warning", failed: "error", cancelled: "close" };

/* One background job, compact: which deck, where it is in plain words, one
   stop control while it runs, and the draft once there is one (P26–P29).
   A failure says what is wrong and how to fix it; the raw message stays in
   技术详情 (P15). */
function JobCard({ job: j, jobs = [], drafts, busy, openDraft, openAgent, cancelJob, dismissJob, retryGeneration, openModelSettings, openDeck, practiceCards }) {
  const code = jobCode(j), active = isActiveJob(j);
  const dismissFailure = useQuickActions()?.failures[j.id];
  const draft = j.draftId ? drafts.find((d) => d.id === j.draftId) : null;
  const generation = !["draft-publish", "draft-repair"].includes(j.type);
  const failure = code === "failed" && generation ? describeFailure(j.stage, { hasDraft: !!draft }) : null;
  const tone = code === "failed" || code === "partial" || code === "cancelled" ? code : active ? "running" : "complete";
  const mark = JOB_MARKS[code] || (active ? null : "success");
  return <article className={"job " + tone + (j.leaving ? " job-leaving" : "")} data-job-id={j.id}
    aria-hidden={j.leaving ? "true" : undefined} inert={j.leaving || undefined}>
    <span className="job-mark" aria-hidden="true">{mark ? <Icon name={mark} size={20} /> : <span className="sh-spinner" />}</span>
    <div className="job-content">
      <strong className="job-title">{jobHeadline(j, drafts)}</strong>
      {failure ? <div className="job-failure">
        <InlineMessage tone="error" title={failure.title}>{failure.hint}</InlineMessage>
        {/* The fix sits right under the reason, where the learner is reading. */}
        {failure.action === "settings" && openModelSettings &&
          <Button size="sm" variant="secondary" icon="model" onClick={openModelSettings}>{ui("去配置模型")}</Button>}
        <Disclosure className="tech-details" summary={ui("技术详情")}><code className="job-raw">{j.stage}</code></Disclosure>
      </div> : <small className="job-stage">{jobStageLabel(j, drafts, jobs)}</small>}
      {code === "partial" && draft && generation && j.type !== "supplement" && <ShortfallReasons draft={draft} compact />}
      {dismissFailure && <p className="job-error" role="alert">{uiFormat("没能移除这条记录：{0}", [dismissFailure])}</p>}
      {j.type !== "draft-publish" && <GenerationTrace job={j} openAgent={openAgent} />}
    </div>
    <div className="job-actions">
      {cancelJob && j.type !== "draft-publish" && ["running", "queued"].includes(j.status) &&
        <Button size="sm" variant="quiet" disabled={busy} title={j.origin === "selection" ? ui("停止补题；题组不会有变化") : ui("停止生成；已保存的题留在草稿里")}
          onClick={() => cancelJob(j.id)}>{ui("停止")}</Button>}
      {draft && !active && <Button size="sm" variant="secondary" onClick={() => openDraft(draft)}>{ui("打开草稿")}</Button>}
      {/* A passage supplement jumps to where its questions went: practise exactly those, or open the deck. */}
      {j.origin === "selection" && j.status === "complete" && j.publication?.cardIds?.length > 0 && <>
        {practiceCards && <Button size="sm" variant="primary" iconEnd="arrow-right" disabled={busy} onClick={() => practiceCards(j.publication.deckId, j.publication.cardIds)}>
          {j.publication.cardIds.length === 1 ? ui("马上练这 1 张") : uiFormat("马上练这 {0} 张", [j.publication.cardIds.length])}</Button>}
        {openDeck && <Button size="sm" variant="secondary" disabled={busy} onClick={() => openDeck(j.publication.deckId)}>{ui("打开题组")}</Button>}
      </>}
      {retryGeneration && generation && j.type !== "supplement" && ["failed", "cancelled"].includes(j.status) && !draft &&
        <Button size="sm" variant="secondary" disabled={busy} onClick={() => retryGeneration(j)}>{ui("按原资料重新设置")}</Button>}
      {/* 已知与删除: done with this card; the draft and approved questions stay. */}
      {dismissJob && !active && <button type="button" className="job-dismiss"
        title={ui("删除这条任务记录；草稿和已通过的题目会保留")} onClick={() => dismissJob(j.id)}>{ui("知道了")}</button>}
    </div>
  </article>;
}

/* Cross-workspace notebook directory. Entries are links, not copies: each
   published notebook's study data stays in its own workspace, and clicking a
   foreign entry opens a fresh conversation there. */
function NotebookDirectory({ notebooks, error, busy, onPublish, onUnpublish, onOpen, refresh, onSearch }) {
  const [open, setOpen] = useState(() => {
    try {
      return localStorage.getItem("study-nb-dir-open") !== "0";
    } catch {
      return true;
    }
  });
  const [query, setQuery] = useState(""),
    [searching, setSearching] = useState(false),
    [results, setResults] = useState(null),
    [searchError, setSearchError] = useState("");
  const searchRequest = useRef(0);
  useEffect(() => {
    searchRequest.current++;
    setResults(null);
    setSearchError("");
    setSearching(false);
  }, [notebooks]);
  const list = notebooks?.notebooks || EMPTY_NOTEBOOKS;
  /* Global due queue: every published notebook's due decks, due first. */
  const dueRows = useMemo(() => {
    const rows = [];
    for (const n of list)
      for (const d of n.decks || [])
        if (!d.archived && d.due > 0) rows.push({ n, d });
    return rows.sort((a, b) => b.d.due - a.d.due).slice(0, 8);
  }, [list]);
  if (!notebooks) return <section className="nb-dir" aria-label={ui("全局笔记本目录")}>
    <div className="section-heading map-heading">
      <h2>{ui("全局笔记本")}</h2>
      <button type="button" onClick={refresh} disabled={busy}>{ui("刷新")}</button>
    </div>
    <p className={error ? "warning" : "muted"} role="status">
      {error ? uiFormat("目录读取失败：{0}", [error]) : ui("正在读取全局笔记本目录…")}
    </p>
  </section>;
  const current = list.find((n) => n.current),
    others = list.filter((n) => !n.current),
    published = list.filter((n) => n.publishedAt).length;
  const toggle = () =>
    setOpen((v) => {
      try {
        localStorage.setItem("study-nb-dir-open", v ? "0" : "1");
      } catch {}
      return !v;
    });
  const stats = (n) =>
    n.exists
      ? uiFormat("{0} 个题组{1}", [n.deckCount, n.dueToday ? uiFormat(' · {0} 道到期', [n.dueToday]) : ""])
      : ui("学习库目录已不可访问");
  const topics = (n) =>
    n.decks
      .filter((d) => !d.archived)
      .slice(0, 4)
      .map((d) => d.title)
      .join(" · ");
  const runSearch = async (e) => {
    e.preventDefault();
    const q = query.trim();
    if (!q || !onSearch || searching) return;
    const request = ++searchRequest.current;
    setSearching(true);
    setSearchError("");
    setResults(null);
    try {
      const found = await onSearch(q);
      if (request === searchRequest.current) setResults(found);
    } catch (error) {
      if (request === searchRequest.current) setSearchError(error.message || String(error));
    } finally {
      if (request === searchRequest.current) setSearching(false);
    }
  };
  return (
    <section className="nb-dir" aria-label={ui("全局笔记本目录")}>
      <div className="section-heading map-heading">
        <h2>
          <button className="map-caret" aria-expanded={open} onClick={toggle}>
            {open ? "▾" : "▸"}
          </button>{" "}{ui("全局笔记本 ")}<span>{published}</span>
        </h2>
        <div className="section-heading-actions">
          <button onClick={refresh} disabled={busy} title={ui("重新读取全局目录")}>{ui("刷新")}</button>
          {!error && (current?.publishedAt ? (
            <button onClick={onUnpublish} disabled={busy}>{ui("取消发布")}</button>
          ) : (
            <button
              onClick={onPublish}
              disabled={busy}
              title={ui("把本工作区的学习笔记本登记到 ~/.dsh 全局目录，其他工作区可一键跳转到这里")}
            >{ui("发布到全局目录")}</button>
          ))}
        </div>
      </div>
      {error && <p className="warning" role="status">{ui("目录读取失败，仍显示上次结果：")}{error}</p>}
      {open && (
        <>
          {dueRows.length > 0 && (
            <div className="nb-due">
              <div className="eyebrow">{ui("全局到期 · 跨工作区")}</div>
              <ul className="nb-list">
                {dueRows.map(({ n, d }) => (
                  <li key={n.root + ":" + d.id}>
                    <button
                      className="nb-row due"
                      disabled={busy || !n.exists}
                      title={n.exists ? uiFormat("在新对话中打开：{0}", [n.workspace]) : n.workspace}
                      onClick={() => onOpen?.(n)}
                    >
                      <span className="nb-main">
                        <strong>{n.title}</strong>
                        <small className="nb-path">{d.title}</small>
                      </span>
                      <span className="nb-stats">{d.due}{ui(" 道到期")}</span>
                      <span className="nb-go" aria-hidden="true">
                        →
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}
          <form className="nb-search" onSubmit={runSearch}>
            <input
              type="search"
              aria-label={ui("跨笔记本搜索")}
              placeholder={ui("跨笔记本搜索题组、主题或题目…")}
              value={query}
              maxLength={100}
              onChange={(e) => setQuery(e.target.value)}
            />
            <button disabled={searching || !query.trim() || !onSearch}>
              {searching ? ui("搜索中…") : ui("搜索")}
            </button>
          </form>
          {searchError && <p className="warning" role="status">{ui("搜索失败：")}{searchError}</p>}
          {results &&
            (results.items?.length ? (
              <ul className="nb-list nb-results">
                {results.items.map((r, i) => (
                  <li key={r.root + ":" + (r.cardId || r.deckId) + ":" + i}>
                    <button
                      className="nb-row"
                      disabled={busy}
                      title={r.workspace}
                      onClick={() => onOpen?.({ workspace: r.workspace })}
                    >
                      <span className="nb-main">
                        <strong>
                          {r.deckTitle}
                          {r.topic ? ` › ${r.topic}` : ""}
                        </strong>
                        <small className="nb-path">{r.prompt || r.cardId || ""}</small>
                      </span>
                      <span className="nb-stats">{r.title}</span>
                      <span className="nb-go" aria-hidden="true">
                        →
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            ) : (
              !searching && <p className="muted nb-empty">{ui("没有匹配的内容。")}</p>
            ))}
          {list.length ? (
            <ul className="nb-list">
              {current?.publishedAt && (
                <li className="nb-row current" title={current.workspace}>
                  <span className="nb-chip">{ui("本工作区")}</span>
                  <span className="nb-main">
                    <strong>{current.title}</strong>
                    <small>{topics(current) || stats(current)}</small>
                  </span>
                  <span className="nb-stats">{stats(current)}</span>
                </li>
              )}
              {others.map((n) => (
                <li key={n.root}>
                  <button
                    className={"nb-row" + (n.exists ? "" : " missing")}
                    disabled={busy || !n.exists || !onOpen}
                    title={n.exists ? uiFormat("在新对话中打开：{0}", [n.workspace]) : n.workspace}
                    onClick={() => onOpen?.(n)}
                  >
                    <span className="nb-main">
                      <strong>{n.title}</strong>
                      <small className="nb-path">{n.workspace}</small>
                    </span>
                    <span className="nb-stats">{stats(n)}</span>
                    <span className="nb-go" aria-hidden="true">
                      →
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="muted nb-empty">{ui("还没有发布的笔记本。在某个工作区的学习库点「发布到全局目录」后，可以在这里跨工作区跳转：点击会新建该工作区的对话。")}</p>
          )}
        </>
      )}
    </section>
  );
}
