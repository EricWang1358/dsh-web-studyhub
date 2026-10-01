import { ui, uiFormat, uiLocale } from "./i18n.js";
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Markdown from "./Markdown.jsx";
import css from "./views.css";
import { useInjectCss, plainPrompt } from "./shared.js";
import { createWriteQueue } from "./async.js";
import { EXAM_LIMIT_MS } from "../lib/exam-timing.js";
import ResultBreakdown from "./ResultBreakdown.jsx";
import OralExam from "./OralExam.jsx";
import PageScope, { decksInCourse, usePageScope } from './PageScope.jsx';
import { readExamTarget } from './learning-navigation.js';
import { CasePaper } from './CaseWorkspace.jsx';
import caseCss from './case-study.css';
import { SegmentedControl } from './components/index.js';

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

export default function Exam({ call, data, onExit, onCreate, onCreateCase, onStartRun, onNotice, initialRunId, initialKind = 'exam', onLocation }) {
  useInjectCss(css, "study-views");
  useInjectCss(caseCss, "study-case-workspace");
  const [course, setCourse] = usePageScope(data?.root, 'exam', data?.focus?.mode === 'interview' ? '*' : data?.focus?.course ?? '*');
  const [deckChoice, setDeckChoice] = usePageScope(data?.root, 'exam-decks', '');
  const [examMode, setExamMode] = useState(initialKind === 'oral' ? 'oral' : initialKind === 'case' ? 'case' : 'written');
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
    () => decksInCourse(data, course).filter(d => (d.examCount || 0) > 0),
    [data, course],
  );
  const savedChoice = useMemo(() => { try { return JSON.parse(deckChoice); } catch { return null; } }, [deckChoice]);
  const explicitDecks = savedChoice?.course === course && Array.isArray(savedChoice.ids);
  const pickedDecks = useMemo(() => new Set(explicitDecks
    ? savedChoice.ids.filter(id => decks.some(deck => deck.id === id)) : decks.map(deck => deck.id)), [decks, explicitDecks, savedChoice]);
  const setPickedDecks = update => setDeckChoice(JSON.stringify({ course, ids: [...(typeof update === 'function' ? update(pickedDecks) : update)] }));
  const chooseCourse = value => { setCourse(value); setDeckChoice(''); };
  const flashOnly = useMemo(
    () => !decks.length && decksInCourse(data, course).some(d => d.available > 0),
    [data, decks, course],
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

  // 案例分析卷 (WP12): a timed case paper on the same exam runs, timer and report.
  if (examMode === "case") return <CasePaper call={call} data={data} onExit={onExit} onWritten={() => setExamMode("written")}
    onCreate={onCreateCase || onCreate} onStartRun={onStartRun} onNotice={onNotice} onLocation={onLocation}
    initialRunId={initialKind === 'case' ? initialRunId : undefined} />;
  if (examMode === "oral") return <OralExam call={call} data={data} onExit={onExit}
    initialRunId={initialKind === 'oral' ? initialRunId : undefined} onLocation={onLocation}
    onStartRun={onStartRun} onWritten={() => setExamMode("written")}
    course={course} onCourseChange={chooseCourse}
    selection={explicitDecks ? { scope: [...pickedDecks].map(deckId => ({ deckId })) } : { course }} />;

  return (
    <section ref={pageRef} className="page exam">
      {phase === "setup" && (
        <div className="exam-setup">
          <div className="page-heading">
            <div>
              <h1>{ui("模拟考试")}</h1>
              <PageScope courses={data?.focus?.courses} value={course} onChange={chooseCourse} />
              <p className="muted">{ui("从勾选的题组里抽选择题，先覆盖不同主题，同主题优先抽较少考过的题；交卷后统一判分。")}</p>
              {data?.focus?.mode === "interview" && data.focus.role && <p className="muted">{ui("目标岗位：")}{data.focus.role}{ui('。本次按上方范围和勾选题组出题。')}</p>}
            </div>
            <div className="exam-mode-switch">
              <button type="button" className="ghost-btn" data-tour="exam-case" onClick={() => setExamMode("case")}>{ui("案例分析卷 →")}</button>
              <button type="button" className="ghost-btn" onClick={() => setExamMode("oral")}>{ui("切换到口头面试 →")}</button>
            </div>
          </div>
          {decks.length ? (
            <div className="exam-panel exam-sheet" data-tour="exam-start">
              <div className="exam-panel-head">
                <div>
                  <strong>{uiFormat("试卷 · {0} 题 · 限时 30 分钟", [count])}</strong>
                  <small className="muted">
                    {pickedDecks.size
                      ? uiFormat("已选 {0} 个题组 · 共 {1} 道选择题", [pickedDecks.size, pickedQuizTotal])
                      : uiFormat("{0} 个题组可用于模考", [decks.length])}
                  </small>
                </div>
                <div className="exam-setup-tools">
                  <button
                    disabled={pickedDecks.size === decks.length}
                    onClick={() => setPickedDecks(new Set(decks.map((d) => d.id)))}
                  >{ui("全选")}</button>
                  <button
                    disabled={!pickedDecks.size}
                    onClick={() => setPickedDecks(new Set())}
                  >{ui("清空")}</button>
                </div>
              </div>
              <ul className="exam-decks">
                {decks.map((d) => (
                  <li key={d.id}>
                    <label
                      className={"exam-deck" + (pickedDecks.has(d.id) ? " picked" : "")}
                    >
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
                      <span className="exam-deck-name">
                        <strong>{d.title}</strong>
                        <small>{ui("单选 ")}{d.examQuizCount || 0}{ui(" · 多选 ")}{d.examMultiCount || 0}</small>
                      </span>
                    </label>
                  </li>
                ))}
              </ul>
              <div className="exam-type-settings">
                <strong>{ui("题型")}</strong>
                <SegmentedControl label={ui("考试题型")} value={typeMode} onChange={setTypeMode}
                  options={Object.entries(examKindLabel).map(([value, label]) => ({ value, label: ui(label) }))} />
                <small className="muted">{ui("已选题组：单选 ")}{pickedKinds.quiz}{ui(" 道，多选 ")}{pickedKinds.multi}{ui(" 道。均衡模式尽量各占一半，不足时由另一类补齐。")}</small>
                {pickedDecks.size > 0 && !typeAvailable && <p className="warning">{ui("所选题组没有这种题型，请换题型或题组。")}</p>}
              </div>
              <div className="exam-setup-foot">
                <label className="exam-count">{ui("题数")}<input
                    type="number"
                    min={1}
                    max={50}
                    value={countDraft}
                    onChange={(e) => setCountDraft(e.target.value)}
                    onBlur={() => setCountDraft(String(clampCount(countDraft)))}
                  />
                  <small>
                    {pickedDecks.size && !typeAvailable
                      ? ui("当前题型可选 0 道")
                      : pickedDecks.size && typeAvailable < count
                      ? uiFormat("符合题型的题只有 {0} 道，将全部出题", [typeAvailable])
                      : ui("1–50 · 默认 10")}
                  </small>
                </label>
                <button
                  className="primary"
                  disabled={!pickedDecks.size || !typeAvailable || busy}
                  onClick={startExam}
                >
                  {busy ? ui("正在出卷…") : !pickedDecks.size ? ui("先勾选题组") : !typeAvailable ? ui("没有符合题型的题") : ui("开始考试")}
                </button>
              </div>
              {/* House rules read as the fine print at the foot of the paper. */}
              <ul className="exam-rules" aria-label={ui("考试规则")}>
                <li>{ui("单选 / 多选")}</li>
                <li>{ui("限时 30 分钟，到时自动交卷")}</li>
                <li>{ui("作答中不显示对错，可反复修改")}</li>
                <li>{ui("重考优先抽未考过的题，题库不够时会重复")}</li>
                <li>{ui("交卷后可回看报告，答错与未答题可排进学习路径")}</li>
              </ul>
            </div>
          ) : (
            <div className="empty exam-empty" data-tour="exam-start">
              <span className="empty-icon" aria-hidden="true">
                ✎
              </span>
              <h2>{ui("还没有可以模考的选择题")}</h2>
              <p className="muted">
                {flashOnly
                  ? ui("现有题组都是闪卡。模拟考试只抽单选 / 多选题，创建题组时勾选选择题题型即可。")
                  : ui("模拟考试从题组里抽单选 / 多选题。先创建一个包含选择题的题组，再回来生成试卷。")}
              </p>
              <div className="exam-empty-actions">
                {onCreate && (
                  <button className="primary" onClick={onCreate}>{ui("＋ 创建题组")}</button>
                )}
                {data?.decks?.length > 0 && <button onClick={onExit}>{ui("去学习库")}</button>}
              </div>
            </div>
          )}
          {data?.exams?.length > 0 && <div className="exam-panel exam-history">
            <div className="exam-panel-head"><strong>{ui("最近考试")}</strong><small className="muted">{ui("可重新查看成绩与待练题")}</small></div>
            <ul>{data.exams.map((past) => <li key={past.runId}>
              <span><strong>{past.scorePct}%</strong> · {past.correct}/{past.total}{ui(" 题 · ")}{new Date(past.submittedAt).toLocaleString(uiLocale())}
                <small>{past.decks.join("、")} · {examKindLabel[past.examKinds] || examKindLabel.all}</small>
                {past.comparison && <small>{ui("同范围、题数及题型构成：上次 ")}{past.comparison.scorePct}% · {scoreChange(past.comparison)}</small>}</span>
              <button type="button" disabled={busy} onClick={() => openReport(past.runId)}>{ui("查看报告")}</button>
            </li>)}</ul>
          </div>}
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
          {confirming ? (
            <div className="exam-confirm" role="alertdialog" aria-label={ui("确认交卷")}>
              <p>{ui("还有 ")}<strong>{unanswered}</strong>{ui(" 题未作答，交卷后将立即判分并结束本次考试。")}</p>
              <div className="exam-confirm-actions">
                <button disabled={busy} onClick={() => setConfirming(false)}>{ui("继续作答")}</button>
                <button className="primary" disabled={busy} onClick={submit}>
                  {busy ? ui("正在交卷…") : ui("确认交卷")}
                </button>
              </div>
            </div>
          ) : (
            <div className="exam-foot">
              <button disabled={busy} onClick={expired ? submit : () => setConfirming(true)}>
                {expired ? ui("重试交卷") : ui("交卷")}
              </button>
              <p className="muted small">
                {expired ? ui("时间已到，已停止作答；交卷失败时会自动重试。")
                  : ui("未交卷的考试会保留在回到题目里 · 计时满 30 分钟自动交卷")}
              </p>
            </div>
          )}
          {err && <p className="exam-error">{err}</p>}
        </>
      )}

      {phase === "running" && !run?.card && (
        <p className="muted">{ui("正在载入试卷…")}</p>
      )}

      {phase === "report" && report && (
        <div className="exam-report">
          <div className="page-heading">
            <div>
              <h1>{ui("考试报告")}</h1>
              <p className="muted">{report.examRole ? `${report.examRole} · ` : ""}{ui("已判分并计入复习计划。")}</p>
            </div>
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
        </div>
      )}
    </section>
  );
}
