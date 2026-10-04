import { ui, uiFormat } from "./i18n.js";
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Markdown from "./Markdown.jsx";
import css from "./views.css";
import { useInjectCss, plainPrompt } from "./shared.js";
import { createWriteQueue } from "./async.js";
import { EXAM_LIMIT_MS } from "../lib/exam-timing.js";
import ResultBreakdown from "./ResultBreakdown.jsx";
import { ReadingBlock, ReadingSettingsButton } from "./reading-settings/ReadingSettings.jsx";
import OralExam from "./OralExam.jsx";
import { decksInCourse, usePageScope, useShowInactive, scopeArgs } from './PageScope.jsx';
import { readExamTarget } from './learning-navigation.js';
import { CasePaper } from './CaseWorkspace.jsx';
import SubmitBlanksDialog from './SubmitBlanksDialog.jsx';
import caseCss from './case-study.css';
import { Button, Icon, SegmentedControl } from './components/index.js';
import { ExamHeader, ExamSetupCard, CountField, RecentExams } from './ExamShell.jsx';
import { defaultExamFormat, isExamFormat, recentExams, shortDeckTitles } from './exam-format.js';

/* 模拟考试（v0.4 契约 §3）：setup → running → report 自管理状态机。
   选中状态存本地（picks，按 deckId:cardId 键控），每次选择通过
   review.answer 静默保存（exam 运行中服务端只存 entry.selected，不判分、
   不给反馈）；上一题/下一题走 review.move 自由导航，允许未作答移动。
   挂载时从快照 runs 里找回进行中的 exam run 并 review.get 恢复；计时满
   30 分钟自动交卷；卸载不交卷，未交卷的考试保留在服务端可再次接回。 */

const clampCount = (v) => {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.min(50, Math.max(1, n)) : 10;
};
const fmtClock = (ms) => {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
};
const fmtDuration = (ms) => {
  const s = Math.max(0, Math.round((ms || 0) / 1000));
  const m = Math.floor(s / 60);
  return m ? uiFormat("{0} 分 {1} 秒", [m, s % 60]) : uiFormat("{0} 秒", [s]);
};
const scoreChange = (comparison) => comparison.deltaPct > 0
  ? uiFormat("比上次高 {0} 个百分点", [comparison.deltaPct])
  : comparison.deltaPct < 0
    ? uiFormat("比上次低 {0} 个百分点", [-comparison.deltaPct])
    : ui("与上次相同");
const kindLabel = (card) => (card?.multiple ? ui("多选") : ui("单选"));
const examKindLabel = { all: "不限题型", quiz: "只单选", multi: "只多选", balanced: "单双均衡" };
/* 服务端 projection.picks 里已保存的选项（exam 运行专属），用于恢复与导航回填。 */
const picksFromRun = (r) => {
  const map = {};
  for (const p of r?.picks || [])
    if (p?.deckId && p?.cardId && Array.isArray(p.selected) && p.selected.length)
      map[p.deckId + ":" + p.cardId] = p.selected;
  return map;
};

export default function Exam({ call, data, onExit, onCreate, onCreateCase, onStartRun, onNotice, onSetupModel, initialRunId, initialKind = 'exam', onLocation }) {
  useInjectCss(css, "study-views");
  useInjectCss(caseCss, "study-case-workspace");
  const [course, setCourse] = usePageScope(data?.root, 'exam', data?.focus?.mode === 'interview' ? '*' : data?.focus?.course ?? '*');
  const [showInactive, setShowInactive] = useShowInactive(data?.root, 'exam');
  const [deckChoice, setDeckChoice] = usePageScope(data?.root, 'exam-decks', '');
  // The format: a deep link wins, then the learner's last choice (kept for this tab), then what the course's exam profile points at.
  const [savedFormat, setSavedFormat] = usePageScope(data?.root, 'exam-format', '');
  const [picked, setPicked] = useState(() => initialKind === 'oral' || initialKind === 'case' ? initialKind : initialRunId ? 'written' : isExamFormat(savedFormat) ? savedFormat : '');
  const [openRun, setOpenRun] = useState(null);
  const examMode = picked || defaultExamFormat(data, course);
  const [phase, setPhase] = useState("setup"), // setup → running → report
    [run, setRun] = useState(null),
    [report, setReport] = useState(null),
    [picks, setPicks] = useState({}),
    [err, setErr] = useState(""),
    [countDraft, setCountDraft] = useState("10"),
    [typeMode, setTypeMode] = useState("all"),
    [confirming, setConfirming] = useState(false),
    [busy, setBusy] = useState(false),
    [pathNote, setPathNote] = useState("");
  const picksRef = useRef({}),
    retryAt = useRef(0),
    writes = useRef(createWriteQueue()),
    acting = useRef(false);
  const count = clampCount(countDraft);
  const pageRef = useRef(null);
  useEffect(() => {
    if (!initialRunId || !['running', 'report'].includes(phase)) return;
    const heading = pageRef.current?.querySelector('h1');
    if (heading) { heading.tabIndex = -1; heading.focus(); }
  }, [initialRunId, phase]);
  useEffect(() => {
    if (examMode === 'written') onLocation?.({ kind: 'exam', runId: phase === 'report' ? report?.runId : run?.id });
  }, [examMode, onLocation, phase, report?.runId, run?.id]);

  function applyPicks(next) {
    picksRef.current = next;
    setPicks(next);
  }

  const decks = useMemo(
    () => decksInCourse(data, course, showInactive).filter(d => (d.examCount || 0) > 0),
    [data, course, showInactive],
  );
  const deckNames = useMemo(() => shortDeckTitles(decks, course), [decks, course]);
  const savedChoice = useMemo(() => { try { return JSON.parse(deckChoice); } catch { return null; } }, [deckChoice]);
  const explicitDecks = savedChoice?.course === course && Array.isArray(savedChoice.ids);
  const pickedDecks = useMemo(() => new Set(explicitDecks
    ? savedChoice.ids.filter(id => decks.some(deck => deck.id === id)) : decks.map(deck => deck.id)), [decks, explicitDecks, savedChoice]);
  const setPickedDecks = update => setDeckChoice(JSON.stringify({ course, ids: [...(typeof update === 'function' ? update(pickedDecks) : update)] }));
  const chooseCourse = value => { setCourse(value); setDeckChoice(''); };
  const flashOnly = useMemo(
    () => !decks.length && decksInCourse(data, course, showInactive).some(d => d.available > 0),
    [data, decks, course, showInactive],
  );
  const pickedKinds = useMemo(
    () => decks.reduce((counts, deck) => pickedDecks.has(deck.id)
      ? { quiz: counts.quiz + (deck.examQuizCount || 0), multi: counts.multi + (deck.examMultiCount || 0) }
      : counts, { quiz: 0, multi: 0 }),
    [decks, pickedDecks],
  );
  const pickedQuizTotal = pickedKinds.quiz + pickedKinds.multi;
  const typeAvailable = typeMode === "quiz" ? pickedKinds.quiz : typeMode === "multi" ? pickedKinds.multi : pickedQuizTotal;

  /* 挂载时恢复进行中的考试：快照 runs 里的 exam run 用 review.get 接回。 */
  useEffect(() => {
    let live = true;
    (async () => {
      if (initialKind === 'oral' || initialKind === 'case') return;
      const open = initialRunId ? { id: initialRunId }
        : data?.lastRun?.mode === "exam" ? data.lastRun
          : (data?.runs || []).filter((r) => r?.mode === "exam")
            .reduce((latest, candidate) => !latest ||
              (Date.parse(candidate.startedAt) || 0) >= (Date.parse(latest.startedAt) || 0)
              ? candidate : latest, null);
      if (!open) return;
      try {
        const { run: r, report: saved } = await readExamTarget(call, open.id);
        if (!live) return;
        // A case paper lives on the same runs: send it to its own format instead of drawing it as multiple choice.
        if (r.paper) {
          if (initialRunId || (!saved && !picked)) { setOpenRun({ kind: 'case', runId: initialRunId || undefined }); setPicked('case'); }
          return;
        }
        if (saved) {
          if (initialRunId) { setRun(r); setReport(saved); setPhase('report'); }
          return;
        }
        if (!r.card) return;
        retryAt.current = 0;
        setRun(r);
        applyPicks(picksFromRun(r));
        setPhase("running");
      } catch (error) {
        if (live && initialRunId) setErr(error.message || ui('找不到这场笔试'));
      }
    })();
    return () => {
      live = false;
    };
    // 只在挂载时恢复一次；此后 data 的变化不重置考试。
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  /* 秒表：从 run.startedAt 起每秒一格。 */
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (phase !== "running" || !run?.startedAt) return;
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [phase, run?.id, run?.startedAt]);
  const startMs = useMemo(() => {
    const v = new Date(run?.startedAt).getTime();
    return Number.isFinite(v) ? v : null;
  }, [run?.startedAt]);
  const elapsedMs = startMs ? Math.max(0, now - startMs) : 0;
  const expired = elapsedMs >= EXAM_LIMIT_MS;

  async function startExam() {
    if (acting.current || !pickedDecks.size || !typeAvailable) return;
    acting.current = true;
    setBusy(true);
    setErr("");
    try {
      const r = await call("review.start", {
        mode: "exam",
        scope: [...pickedDecks].map((deckId) => ({ deckId })),
        count,
        examKinds: typeMode,
        fresh: true,
      });
      retryAt.current = 0;
      writes.current = createWriteQueue();
      setRun(r);
      applyPicks(picksFromRun(r));
      setPhase("running");
    } catch (e) {
      setErr(e.message || String(e));
    } finally {
      acting.current = false;
      setBusy(false);
    }
  }

  const curKey =
    run?.deckId != null && run?.card?.id ? run.deckId + ":" + run.card.id : null;
  const curPicks = (curKey && picks[curKey]) || [];
  function pick(optionId) {
    if (acting.current || expired || !run?.card || !curKey) return;
    const multi = !!run.card.multiple || run.card.kind === "multi";
    const cur = picksRef.current[curKey] || [];
    const next = multi
      ? cur.includes(optionId)
        ? cur.filter((x) => x !== optionId)
        : [...cur, optionId]
      : [optionId];
    applyPicks({ ...picksRef.current, [curKey]: next });
    // exam 模式的 review.answer 只保存选项、可反复修改，不判分。
    writes.current.enqueue(() => call("review.answer", {
      runId: run.id,
      cardId: run.card.id,
      selected: next,
    })).then(() => setErr(""), (e) => setErr(startMs && Date.now() - startMs >= EXAM_LIMIT_MS
      ? ui("考试时间已到，未确认保存的选择可能不会计入成绩。")
      : ui("选择尚未保存，请重新选择后继续：") + (e.message || String(e))));
  }

  async function move(direction) {
    if (acting.current || expired || !run) return;
    acting.current = true;
    setBusy(true);
    setErr("");
    try {
      await writes.current.flush();
      const next = await call("review.move", { runId: run.id, direction });
      const r = next && next.card ? next : await call("review.get", { runId: run.id });
      setRun(r);
      // All writes finished before navigation; the server is authoritative.
      applyPicks(picksFromRun(r));
    } catch (e) {
      setErr(e.message || String(e));
    } finally {
      acting.current = false;
      setBusy(false);
    }
  }

  const submit = useCallback(async () => {
    if (acting.current || !run) return;
    acting.current = true;
    setBusy(true);
    setErr("");
    setConfirming(false);
    try {
      let unsavedChoice = false;
      try {
        await writes.current.flush();
      } catch (writeError) {
        if (startMs && Date.now() - startMs >= EXAM_LIMIT_MS) {
          unsavedChoice = true;
        } else {
          // A failed last pick can still be retried before the time limit.
          if (!curKey || !Object.hasOwn(picksRef.current, curKey)) throw writeError;
          await writes.current.enqueue(() => call("review.answer", {
            runId: run.id, cardId: run.card.id, selected: picksRef.current[curKey],
          }));
        }
      }
      const rep = await call("exam.submit", { runId: run.id });
      retryAt.current = 0;
      setReport(rep);
      setPhase("report");
      if (unsavedChoice) setErr(ui("最后一次选择未确认保存，成绩按服务端已保存的答案计算。"));
    } catch (e) {
      retryAt.current = Date.now() + 5000;
      const message = e.message || String(e);
      setErr(startMs && Date.now() - startMs >= EXAM_LIMIT_MS
        ? uiFormat("交卷失败，正在自动重试：{0}", [message]) : message);
    } finally {
      acting.current = false;
      setBusy(false);
    }
  }, [call, run, curKey, startMs]);

  /* 计时满 30 分钟自动交卷；失败后每 5 秒重试。 */
  useEffect(() => {
    if (phase !== "running" || !startMs || busy || !expired || Date.now() < retryAt.current) return;
    submit();
  }, [elapsedMs, phase, startMs, busy, expired, submit]);

  const answeredCount = useMemo(
    () => Object.values(picks).filter((a) => Array.isArray(a) && a.length).length,
    [picks],
  );
  const unanswered = Math.max(0, (run?.total || 0) - answeredCount);
  const weakTopicRows = (report?.byTopic || [])
    .filter((topic) => topic.total > topic.correct)
    .sort((a, b) => (b.total - b.correct) - (a.total - a.correct))
    .slice(0, 3);

  async function queueWeak() {
    if (busy || pathNote || !report?.weakScope?.length) return;
    setBusy(true);
    setErr("");
    try {
      const nextRun = await call("review.start", {
        mode: "path",
        scope: report.weakScope,
        fresh: true,
      });
      if (onStartRun) onStartRun(nextRun, { kind: 'exam', runId: report.runId });
      else setPathNote(
        uiFormat("已把 {0} 道答错或未答题排进学习路径，回到学习库即可开始练习。", [report.weakScope.length]),
      );
    } catch (e) {
      setErr(e.message || String(e));
    } finally {
      setBusy(false);
    }
  }

  async function openReport(runId) {
    if (busy) return;
    setBusy(true);
    setErr("");
    try {
      const saved = await call("exam.report", { runId });
      setReport(saved);
      setPathNote("");
      setPhase("report");
    } catch (e) {
      setErr(e.message || String(e));
    } finally {
      setBusy(false);
    }
  }

  function chooseFormat(next) { setPicked(next); setSavedFormat(next); setOpenRun(null); setErr(""); }
  function openRecent(item) {
    if (item.kind === "written") { chooseFormat("written"); openReport(item.runId); return; }
    setOpenRun({ kind: item.kind, runId: item.runId }); setPicked(item.kind); setSavedFormat(item.kind);
  }

  // One page, one switch (WP25): the header, the format's own setup card and the shared recent list.
  const header = <ExamHeader courses={data?.focus?.courses} course={course} onCourse={chooseCourse} format={examMode} onFormat={chooseFormat}
    showInactive={showInactive} onShowInactive={show => { setShowInactive(show); setDeckChoice(''); }} />;
  const recent = <RecentExams items={recentExams(data)} format={examMode} onOpen={openRecent} busy={busy} />;
  const deepRun = (kind) => openRun?.kind === kind ? openRun.runId : initialKind === kind ? initialRunId : undefined;
  // 案例分析卷 (WP12): a timed case paper on the same exam runs, timer and report.
  if (examMode === "case") return <CasePaper key={`case:${deepRun("case") || ""}`} call={call} data={data} onExit={onExit}
    header={header} recent={recent} course={course} onCourseChange={chooseCourse} onSetupModel={onSetupModel}
    onCreate={onCreateCase || onCreate} onStartRun={onStartRun} onNotice={onNotice} onLocation={onLocation}
    initialRunId={deepRun("case")} />;
  if (examMode === "oral") return <OralExam key={`oral:${deepRun("oral") || ""}`} call={call} data={data} onExit={onExit}
    initialRunId={deepRun("oral")} onLocation={onLocation} onStartRun={onStartRun} onSetupModel={onSetupModel}
    header={header} recent={recent}
    course={course} onCourseChange={chooseCourse}
    selection={explicitDecks ? { scope: [...pickedDecks].map(deckId => ({ deckId })) } : scopeArgs(course, showInactive)} />;

  return (
    <section ref={pageRef} className="page exam">
      {phase === "setup" && (
        <div className="exam-setup">
          {header}
          <ExamSetupCard data-tour="exam-start" title={ui("选择题笔试")}
            intro={ui("从勾选的题组里抽单选 / 多选题，先覆盖不同主题；交卷后统一判分。")}
            steps={[
              ui("勾选要考的题组，选好题型和题数。"),
              uiFormat("点「开始考试」，限时 {0} 分钟，到时自动交卷。", [EXAM_LIMIT_MS / 60000]),
              ui("作答中不显示对错，可以上一题 / 下一题，反复修改。"),
              ui("交卷后看成绩单；答错和没答的题可以一键排进学习路径。"),
              ui("再考一次时，优先抽没考过的题；题库不够时会重复。"),
            ]}
            summary={[uiFormat("{0} 题 · 限时 {1} 分钟", [count, EXAM_LIMIT_MS / 60000]),
              decks.length ? (pickedDecks.size ? uiFormat("已选 {0} 个题组 · 共 {1} 道选择题", [pickedDecks.size, pickedQuizTotal])
                : uiFormat("{0} 个题组可用于模考", [decks.length])) : ""].filter(Boolean).join(" · ")}
            action={<Button variant="primary" busy={busy} disabled={!decks.length || !pickedDecks.size || !typeAvailable} onClick={startExam}>
              {busy ? ui("正在出卷…") : decks.length && !pickedDecks.size ? ui("先勾选题组") : decks.length && !typeAvailable ? ui("没有符合题型的题") : ui("开始考试")}
            </Button>}>
            {data?.focus?.mode === "interview" && data.focus.role && <p className="es-note"><Icon name="info" size={16} /><span>{ui("目标岗位：")}{data.focus.role}{ui('。本次按上方范围和勾选题组出题。')}</span></p>}
            {decks.length ? (
              <>
                <div className="es-section">
                  <div className="es-section__head">
                    <div>
                      <strong>{ui("选题组")}</strong>
                      <small>{pickedDecks.size ? uiFormat("已选 {0} 个题组 · 共 {1} 道选择题", [pickedDecks.size, pickedQuizTotal]) : ui("至少勾选一个题组")}</small>
                    </div>
                    <div className="es-tools">
                      <Button size="sm" variant="quiet" disabled={pickedDecks.size === decks.length}
                        onClick={() => setPickedDecks(new Set(decks.map((d) => d.id)))}>{ui("全选")}</Button>
                      <Button size="sm" variant="quiet" disabled={!pickedDecks.size} onClick={() => setPickedDecks(new Set())}>{ui("清空")}</Button>
                    </div>
                  </div>
                  <ul className="es-decks">
                    {decks.map((d) => (
                      <li key={d.id}>
                        <label className={"es-deck" + (pickedDecks.has(d.id) ? " picked" : "")}>
                          <input
                            type="checkbox"
                            checked={pickedDecks.has(d.id)}
                            onChange={(e) =>
                              setPickedDecks((prev) => {
                                const next = new Set(prev);
                                e.target.checked ? next.add(d.id) : next.delete(d.id);
                                return next;
                              })
                            }
                          />
                          <span className="es-deck__name">
                            <strong title={d.title}>{deckNames[d.id] || d.title}</strong>
                            <small>{uiFormat("单选 {0} · 多选 {1}", [d.examQuizCount || 0, d.examMultiCount || 0])}</small>
                          </span>
                        </label>
                      </li>
                    ))}
                  </ul>
                </div>
              <div className="exam-type-settings">
                <strong>{ui("题型")}</strong>
                <SegmentedControl label={ui("考试题型")} value={typeMode} onChange={setTypeMode}
                  options={Object.entries(examKindLabel).map(([value, label]) => ({ value, label: ui(label) }))} />
                <small className="muted">{ui("已选题组：单选 ")}{pickedKinds.quiz}{ui(" 道，多选 ")}{pickedKinds.multi}{ui(" 道。均衡模式尽量各占一半，不足时由另一类补齐。")}</small>
                {pickedDecks.size > 0 && !typeAvailable && <p className="warning">{ui("所选题组没有这种题型，请换题型或题组。")}</p>}
              </div>
                <CountField value={count} presets={[5, 10, 20]} min={1} max={50} onChange={(next) => setCountDraft(String(next))}
                  hint={pickedDecks.size && !typeAvailable
                    ? ui("当前题型可选 0 道")
                    : pickedDecks.size && typeAvailable < count
                      ? uiFormat("符合题型的题只有 {0} 道，将全部出题", [typeAvailable])
                      : ui("1–50 · 默认 10")} />
              </>
            ) : (
              <div className="es-empty">
                <strong>{ui("还没有可以模考的选择题")}</strong>
                <p>
                  {flashOnly
                    ? ui("现有题组都是闪卡。模拟考试只抽单选 / 多选题，创建题组时勾选选择题题型即可。")
                    : ui("模拟考试从题组里抽单选 / 多选题。先创建一个包含选择题的题组，再回来生成试卷。")}
                </p>
                {onCreate && <Button variant="secondary" icon="plus" onClick={onCreate}>{ui("创建题组")}</Button>}
                {data?.decks?.length > 0 && <Button variant="quiet" onClick={onExit}>{ui("去学习库")}</Button>}
              </div>
            )}
          </ExamSetupCard>
          {recent}
          {err && <p className="exam-error">{err}</p>}
        </div>
      )}

      {phase === "running" && run?.card && (
        <>
          <div className="exam-head">
            <div>
              <div className="eyebrow">{ui("模拟考试进行中")}</div>
              <h2>{run.title || ui("模拟考试")}</h2>
            </div>
            <div className="exam-head-right">
              <span className="exam-timer" title={ui("已用时")}>{ui("已用时 ")}{fmtClock(elapsedMs)}
              </span>
              <span className="exam-progress">
                {run.index + 1} / {run.total}
              </span>
            </div>
          </div>
          <div className="exam-card" key={run.card.id}>
            <div className="exam-card-meta">
              <span className="exam-chip">{run.card.topic || ui("未分类")}</span>
              <span className="exam-chip dim">{kindLabel(run.card)}</span>
              <span className="muted small">
                {run.card.multiple ? ui("选出所有符合条件的选项") : ui("选出一项")}
              </span>
            </div>
            <div className="exam-prompt">
              <Markdown text={run.card.prompt} links={false} />
            </div>
            <div className="exam-options">
              {(run.card.options || []).map((o, i) => {
                const picked = curPicks.includes(o.id);
                return (
                  <button
                    key={o.id}
                    className={"exam-option" + (picked ? " picked" : "")}
                    aria-pressed={picked}
                    disabled={busy || expired}
                    onClick={() => pick(o.id)}
                  >
                    <span className="exam-option-letter">
                      {String.fromCharCode(65 + i)}
                    </span>
                    <span className="exam-option-text">
                      <Markdown text={o.text} links={false} className="md-compact" />
                    </span>
                  </button>
                );
              })}
            </div>
          </div>
          <div className="exam-toolbar">
            <button disabled={busy || expired || !run.index} onClick={() => move(-1)}>{ui("← 上一题")}</button>
            <button
              className="primary"
              disabled={busy || expired || run.index >= run.total - 1}
              onClick={() => move(1)}
            >{ui("下一题 →")}</button>
          </div>
          <div className="exam-foot">
            <button disabled={busy} onClick={expired ? submit : () => setConfirming(true)}>
              {expired ? ui("重试交卷") : ui("交卷")}
            </button>
            <p className="muted small">
              {expired ? ui("时间已到，已停止作答；交卷失败时会自动重试。")
                : ui("未交卷的考试会保留在回到题目里 · 计时满 30 分钟自动交卷")}
            </p>
          </div>
          {confirming && <SubmitBlanksDialog onClose={() => setConfirming(false)} onConfirm={submit}>
            <p>{uiFormat("还有 {0} 题未作答，交卷后将立即判分并结束本次考试。", [unanswered])}</p>
          </SubmitBlanksDialog>}
          {err && <p className="exam-error">{err}</p>}
        </>
      )}

      {phase === "running" && !run?.card && (
        <p className="muted">{ui("正在载入试卷…")}</p>
      )}

      {phase === "report" && report && (
        <ReadingBlock className="exam-report">
          <div className="page-heading">
            <div>
              <h1>{ui("考试报告")}</h1>
              <p className="muted">{report.examRole ? `${report.examRole} · ` : ""}{ui("已判分并计入复习计划。")}</p>
            </div>
            <ReadingSettingsButton className="exam-reading" />
          </div>
          <div className="result-hero">
            <div className="result-headline">
              <strong>{Math.round(report.scorePct ?? 0)}%</strong>
              <span>{ui("本次笔试得分 · ")}{report.correct ?? 0}/{report.total ?? 0}{ui(" 题")}</span>
              <small>{ui("用时 ")}{fmtDuration(report.durationMs)}</small>
            </div>
            <ResultBreakdown total={report.total ?? 0} answered={report.answered ?? 0}
              correct={report.correct ?? 0} correctLabel={ui("答对")} />
          </div>
          {report.comparison && <p className="muted">{ui("同范围、题数及题型构成的上次考试为 ")}{report.comparison.scorePct}{ui("%；这次")}{scoreChange(report.comparison)}{ui("。两次抽到的题目可能不同，仅供参考。")}</p>}

          <div className="result-weak">
            <h2>{ui("下次先练这些主题")}</h2>
            {weakTopicRows.length ? <ol>{weakTopicRows.map((t) => <li key={`${t.deckId}:${t.topic}`}>
              {t.topic || ui("未分类")} <span className="muted">· {t.total - t.correct}/{t.total}{ui(" 题答错或未答")}</span>
            </li>)}</ol> : <p className="muted">{ui("本次已答题全部答对。")}</p>}
            {report.weakScope?.length > 0 && <button type="button" disabled={busy || !!pathNote} onClick={queueWeak}>{ui("练习答错与未答的 ")}{report.weakScope.length}{ui(" 道 →")}</button>}
            {pathNote && <p className="muted exam-path-note">{pathNote}</p>}
          </div>

          <div className="exam-report-actions">
            <button className="primary" onClick={onExit}>{ui("回学习库")}</button>
            <button type="button" onClick={() => setPhase("setup")}>{ui("再考一次")}</button>
          </div>

          <details className="result-details"><summary>{ui("查看详细成绩与错题")}</summary>

          <div className="exam-bars">
            <div className="eyebrow">{ui("按主题分布")}</div>
            {report.byTopic?.length ? (
              report.byTopic.map((t) => (
                <div key={`${t.deckId}:${t.topic}`} className="exam-bar-row">
                  <span className="exam-bar-label">{report.byTopic.filter((row) => row.topic === t.topic).length > 1 ? `${t.deckTitle} · ` : ""}{t.topic || ui("未分类")}</span>
                  <span className="exam-bar-track">
                    <span
                      className="exam-bar-fill"
                      style={{
                        width: `${t.total ? Math.round((t.correct / t.total) * 100) : 0}%`,
                      }}
                    />
                  </span>
                  <span className="exam-bar-value">
                    {t.correct}/{t.total}
                  </span>
                </div>
              ))
            ) : (
              <p className="muted">{ui("暂无主题分布。")}</p>
            )}
          </div>

          {report.byDeck?.length > 0 && (
            <div className="exam-bars">
              <div className="eyebrow">{ui("按题组分布")}</div>
              {report.byDeck.map((d) => (
                <div key={d.deckId} className="exam-bar-row">
                  <span className="exam-bar-label">{d.title}</span>
                  <span className="exam-bar-track">
                    <span
                      className="exam-bar-fill soft"
                      style={{
                        width: `${d.total ? Math.round((d.correct / d.total) * 100) : 0}%`,
                      }}
                    />
                  </span>
                  <span className="exam-bar-value">
                    {d.correct}/{d.total}
                  </span>
                </div>
              ))}
            </div>
          )}

          {report.byKind?.length > 0 && <div className="exam-bars">
            <div className="eyebrow">{ui("按题型分布")}</div>
            {report.byKind.map((row) => <div key={row.kind} className="exam-bar-row">
              <span className="exam-bar-label">{row.kind === "multi" ? ui("多选") : ui("单选")}</span>
              <span className="exam-bar-track"><span className="exam-bar-fill soft"
                style={{ width: `${row.total ? Math.round((row.correct / row.total) * 100) : 0}%` }} /></span>
              <span className="exam-bar-value">{row.correct}/{row.total}</span>
            </div>)}
          </div>}

          <div className="exam-wrong">
            <div className="eyebrow">{ui("答错 · ")}{report.wrong?.length || 0}</div>
            {report.wrong?.length ? (
              <ul>
                {report.wrong.map((w) => (
                  <li key={w.deckId + ":" + w.cardId} className="exam-wrong-row">
                    <span className="exam-chip">{w.topic || ui("未分类")}</span>
                    <span className="exam-wrong-prompt" title={plainPrompt(w.prompt)}>
                      {plainPrompt(w.prompt)}
                    </span>
                    <span className="exam-chip dim">{w.kind === "multi" ? ui("多选") : ui("单选")}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="muted">{ui("已答的题目没有答错。")}</p>
            )}
          </div>

          {report.skipped?.length > 0 && <div className="exam-wrong">
            <div className="eyebrow">{ui("未答 · ")}{report.skipped.length}</div>
            <ul>{report.skipped.map((item) => <li key={item.deckId + ":" + item.cardId} className="exam-wrong-row">
              <span className="exam-chip">{item.topic || ui("未分类")}</span>
              <span className="exam-wrong-prompt" title={plainPrompt(item.prompt)}>{plainPrompt(item.prompt)}</span>
              <span className="exam-chip dim">{item.kind === "multi" ? ui("多选") : ui("单选")}</span>
            </li>)}</ul>
          </div>}

          </details>
          {err && <p className="exam-error">{err}</p>}
        </ReadingBlock>
      )}
    </section>
  );
}
