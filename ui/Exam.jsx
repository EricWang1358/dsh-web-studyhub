import { ui, uiFormat, errorMessage } from "./i18n.js";
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Markdown from "./Markdown.jsx";
import css from "./views.css";
import { useInjectCss } from "./shared.js";
import { createWriteQueue } from "./async.js";
import { LIMIT_MINUTES, defaultLimitMinutes, examLimitMs } from "../lib/exam-timing.js";
import OralExam from "./OralExam.jsx";
import { decksInCourse, usePageScope, useShowInactive, scopeArgs } from './PageScope.jsx';
import { practiceArgs, readExamTarget } from './learning-navigation.js';
import { CasePaper } from './CaseWorkspace.jsx';
import SubmitBlanksDialog from './SubmitBlanksDialog.jsx';
import caseCss from './case-study.css';
import examCss from './exam.css';
import { Badge, Button, ErrorState, LoadingState, PageHeader, Panel, Tooltip, focusQuietly } from './components/index.js';
import { ExamHeader, RecentExams } from './ExamShell.jsx';
import { defaultExamFormat, isExamFormat, recentExams, shortDeckTitles } from './exam-format.js';
import { formatClock, joinMeta } from './format.js';
import { useExamRun, useExamClock } from './exam/useExamRun.js';
import { DEFAULT_COUNT, cardKindName, clampCount, firstUnansweredIndex, picksFromRun, typeAvailableOf, unansweredCount } from './exam/exam-written.js';
import { fixedOptionLabel } from './option-label.js';
import OptionMark from './OptionMark.jsx';
import WrittenSetup from './exam/WrittenSetup.jsx';
import WrittenReport from './exam/WrittenReport.jsx';
import { useStudy } from './study-context.jsx';

/* 模拟考试（v0.4 契约 §3）：选择题笔试。生命周期（setup → running → report、恢复、交卷、计时）在
   ui/exam/useExamRun.js，三种考试形式共用；这里只管作答界面和各形式的外壳。
   选中状态存本地（picks，按 deckId:cardId 键控），每次选择通过 review.answer 静默保存（exam 运行中
   服务端只存 entry.selected，不判分、不给反馈）；上一题/下一题走 review.move 自由导航，允许未作答移动。
   挂载时从快照 runs 里找回进行中的 exam run 并 review.get 恢复；计时满限时自动交卷（限时在开考前选好，默认取课程的
   作答时间，没有就 30 分钟，存在 run 上，lib/exam-timing.js）；卸载不交卷，未交卷的考试保留在服务端可再次接回。 */

const RETRY_SUBMIT_MS = 5000;
const LOW_TIME_MS = 5 * 60 * 1000;
const FINAL_MINUTE_MS = 60 * 1000;

/** Determine discrete countdown warning milestones for assertive screen-reader announcements. */
export function examTimeWarning(remainingMs, expired) {
  if (expired || remainingMs <= 0) return { key: "expired", text: ui("考试时间已到，正在自动交卷。") };
  if (remainingMs <= FINAL_MINUTE_MS) return { key: "1m", text: ui("考试剩余不足 1 分钟。") };
  if (remainingMs < LOW_TIME_MS) return { key: "5m", text: ui("考试剩余不足 5 分钟。") };
  return { key: "", text: "" };
}

/** Leaf 1-second timer for written exams: keeps the countdown ticking without re-rendering the exam paper or option list. */
const WrittenExamClock = React.memo(function WrittenExamClock({ run, limitMs, active, autoSubmitReady, onExpire, onAutoSubmit }) {
  const timing = useExamClock(run, { enabled: active, limitMs });
  const hasLimit = Number.isFinite(limitMs) && limitMs > 0;
  const remainingMs = hasLimit ? Math.max(0, limitMs - timing.elapsedMs) : 0;
  const lowTime = hasLimit && remainingMs < LOW_TIME_MS;
  const warning = active && hasLimit ? examTimeWarning(remainingMs, timing.expired) : { key: "", text: "" };
  const warnedRef = useRef({ runId: run?.id || "", key: "" });
  const [urgentWarning, setUrgentWarning] = useState("");
  const onExpireRef = useRef(onExpire);
  onExpireRef.current = onExpire;
  const onAutoSubmitRef = useRef(onAutoSubmit);
  onAutoSubmitRef.current = onAutoSubmit;
  useEffect(() => {
    const runId = run?.id || "";
    if (!active || !hasLimit) {
      if (warnedRef.current.key) {
        warnedRef.current = { runId, key: "" };
        setUrgentWarning("");
      }
      return;
    }
    if (warnedRef.current.runId !== runId) {
      warnedRef.current = { runId, key: "" };
      setUrgentWarning("");
    }
    if (warning.key && warnedRef.current.key !== warning.key) {
      warnedRef.current = { runId, key: warning.key };
      setUrgentWarning(warning.text);
    }
  }, [active, hasLimit, run?.id, warning.key, warning.text]);
  useEffect(() => {
    if (active && timing.expired) onExpireRef.current?.();
  }, [active, timing.expired]);
  useEffect(() => {
    if (active && timing.expired && autoSubmitReady?.()) onAutoSubmitRef.current?.();
  }, [active, timing.expired, timing.elapsedMs, autoSubmitReady]);
  return (
    <>
      <Tooltip layer content={hasLimit ? uiFormat("已用时 {0}", [formatClock(timing.elapsedMs)]) : ui("已用时")}>
        <span className={"exam-timer exam-countdown" + (lowTime ? " is-low" : "")} tabIndex={0}>
          {hasLimit ? uiFormat("剩余时间 {0}", [formatClock(remainingMs)]) : uiFormat("已用时 {0}", [formatClock(timing.elapsedMs)])}
        </span>
      </Tooltip>
      <span className="sh-visually-hidden" role="alert" aria-live="assertive" aria-atomic="true" data-live-announcer="exam-timer">
        {urgentWarning}
      </span>
    </>
  );
});

export default function Exam({ data, onExit, onCreate, onCreateCase, onStartRun, onSetupModel, onOpenSource, initialRunId, initialKind = 'exam', onLocation }) {
  const { call, act } = useStudy();
  useInjectCss(css, "study-views");
  useInjectCss(caseCss, "study-case-workspace");
  useInjectCss(examCss, "study-exam");
  const [course, setCourse] = usePageScope(data?.root, 'exam', data?.focus?.course ?? '*');
  const [showInactive, setShowInactive] = useShowInactive(data?.root, 'exam');
  const [deckChoice, setDeckChoice] = usePageScope(data?.root, 'exam-decks', '');
  // The time limit the learner chose for this course (kept for this tab like the decks); unchosen follows the course's own 作答时间.
  const [limitChoice, setLimitChoice] = usePageScope(data?.root, 'exam-limit', '');
  // The format: a deep link wins, then the learner's last choice (kept for this tab), then what the course's exam profile points at.
  const [savedFormat, setSavedFormat] = usePageScope(data?.root, 'exam-format', '');
  const [picked, setPicked] = useState(() => initialKind === 'oral' || initialKind === 'case' ? initialKind : initialRunId ? 'written' : isExamFormat(savedFormat) ? savedFormat : '');
  const [openRun, setOpenRun] = useState(null);
  const examMode = picked || defaultExamFormat(data, course);
  const [picks, setPicks] = useState({}),
    [countDraft, setCountDraft] = useState(String(DEFAULT_COUNT)),
    [typeMode, setTypeMode] = useState("all"),
    [confirming, setConfirming] = useState(false),
    [pathNote, setPathNote] = useState("");
  const picksRef = useRef({}), writes = useRef(createWriteQueue());
  const [expiredRunId, setExpiredRunId] = useState(null);
  const exam = useExamRun({ kind: 'exam', call, initialRunId, onLocation, limitMs: (current) => examLimitMs(current) ?? Infinity, retryMs: RETRY_SUBMIT_MS, locate: examMode === 'written', tick: false });
  const { phase, run, report, busy, error: err, startMs } = exam;
  const expired = Boolean(phase === 'running' && run?.id && (exam.expired || expiredRunId === run.id));
  const count = clampCount(countDraft);
  // How long this paper lasts: what the run says once it is running; before that, the learner's choice for this course, else the course's own time.
  const runLimitMs = examLimitMs(run) ?? Infinity;
  const limitDefault = defaultLimitMinutes(data, course);
  const savedLimit = useMemo(() => { try { return JSON.parse(limitChoice); } catch { return null; } }, [limitChoice]);
  const limitMinutes = savedLimit?.course === course && Number.isInteger(savedLimit.minutes) && savedLimit.minutes >= LIMIT_MINUTES.min && savedLimit.minutes <= LIMIT_MINUTES.max
    ? savedLimit.minutes : limitDefault.minutes;
  const pageRef = useRef(null);
  const examPromptRef = useRef(null);
  const [statusAnnouncement, setStatusAnnouncement] = useState("");
  const prevExamViewRef = useRef({ phase, cardId: phase === "running" ? (run?.card?.id || "") : "" });
  useEffect(() => {
    if (!initialRunId || !['running', 'report'].includes(phase)) return;
    const heading = pageRef.current?.querySelector('h1');
    if (heading) { heading.tabIndex = -1; heading.focus(); }
  }, [initialRunId, phase]);
  useEffect(() => {
    const cardId = phase === "running" ? (run?.card?.id || "") : "";
    const prev = prevExamViewRef.current;
    if (prev.phase === phase && prev.cardId === cardId) return;
    prevExamViewRef.current = { phase, cardId };
    if (prev.phase !== "running" && phase === "running" && run?.total) {
      setStatusAnnouncement(uiFormat("模拟考试已开始，共 {0} 题", [run.total]));
    } else if (prev.phase === "running" && phase === "report") {
      setStatusAnnouncement(ui("模拟考试已交卷，成绩报告已生成"));
    } else if (phase === "setup") {
      setStatusAnnouncement("");
    }
    const switchedQuestion = prev.phase === "running" && prev.cardId && prev.cardId !== cardId;
    const enteredFromSetup = prev.phase === "setup" && phase === "running";
    if (phase === "running" && cardId && (switchedQuestion || enteredFromSetup) && !confirming && examPromptRef.current) {
      focusQuietly(examPromptRef.current, { preventScroll: true });
    }
  }, [phase, run?.card?.id, run?.total, confirming]);

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
      ? { quiz: counts.quiz + (deck.examQuizCount || 0), multi: counts.multi + (deck.examMultiCount || 0), truefalse: counts.truefalse + (deck.examTrueFalseCount || 0),
        all: counts.all + (deck.examCount || 0) }
      : counts, { quiz: 0, multi: 0, truefalse: 0, all: 0 }),
    [decks, pickedDecks],
  );

  /* 挂载时恢复进行中的考试：快照 runs 里的 exam run 用 review.get 接回。 */
  useEffect(() => {
    if (initialKind === 'oral' || initialKind === 'case') return;
    const open = initialRunId ? { id: initialRunId }
      : data?.lastRun?.mode === "exam" ? data.lastRun
        : (data?.runs || []).filter((r) => r?.mode === "exam")
          .reduce((latest, candidate) => !latest ||
            (Date.parse(candidate.startedAt) || 0) >= (Date.parse(latest.startedAt) || 0)
            ? candidate : latest, null);
    if (!open) return;
    void exam.restore({ ids: [open.id],
      load: async (id) => {
        const { run: r, report: saved } = await readExamTarget(call, id);
        // A case paper lives on the same runs: send it to its own format instead of drawing it as multiple choice.
        if (r.paper) {
          if (initialRunId || (!saved && !picked)) { setOpenRun({ kind: 'case', runId: initialRunId || undefined }); setPicked('case'); }
          return { stop: true };
        }
        if (saved) return initialRunId ? { phase: 'report', run: r, report: saved } : { stop: true };
        if (!r.card) return { stop: true };
        return { phase: 'running', run: r };
      },
      onFound: (found) => { if (found.phase === 'running') applyPicks(picksFromRun(found.run)); },
      // Only a deep link to a run that cannot be read is worth an error; a stale snapshot entry is skipped silently.
      onError: () => (initialRunId ? undefined : 'continue') });
    // 只在挂载时恢复一次；此后 data 的变化不重置考试。
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const startExam = () => {
    if (!pickedDecks.size || !typeAvailableOf(pickedKinds, typeMode)) return;
    return exam.perform(async () => {
      const r = await call("review.start", {
        mode: "exam",
        course,
        scope: [...pickedDecks].map((deckId) => ({ deckId })),
        count,
        examKinds: typeMode,
        limitMinutes,
        fresh: true,
      });
      writes.current = createWriteQueue();
      applyPicks(picksFromRun(r));
      setPathNote("");
      exam.enter(r);
    });
  };

  const curKey =
    run?.deckId != null && run?.card?.id ? run.deckId + ":" + run.card.id : null;
  const curPicks = (curKey && picks[curKey]) || [];
  function pick(optionId) {
    if (exam.isBusy() || expired || !run?.card || !curKey) return;
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
    })).then(() => exam.setError(""), (e) => exam.setError(startMs && Date.now() - startMs >= runLimitMs
      ? ui("考试时间已到，未确认保存的选择可能不会计入成绩。")
      : uiFormat("选择尚未保存，请重新选择后继续：{0}", [errorMessage(e)])));
  }

  const navigate = (step) => {
    if (expired || !run) return;
    return exam.perform(async () => {
      await writes.current.flush();
      const next = await call("review.move", { runId: run.id, ...step });
      const r = next && next.card ? next : await call("review.get", { runId: run.id });
      exam.setRun(r);
      // All writes finished before navigation; the server is authoritative.
      applyPicks(picksFromRun(r));
    });
  };
  const move = (direction) => navigate({ direction });
  const jumpTo = (index) => (index === run?.index ? undefined : navigate({ index }));

  const submit = useCallback(() => {
    setConfirming(false);
    return exam.submit({
      before: async () => {
        let unsavedChoice = false;
        try {
          await writes.current.flush();
        } catch (writeError) {
          if (startMs && Date.now() - startMs >= runLimitMs) {
            unsavedChoice = true;
          } else {
            // A failed last pick can still be retried before the time limit.
            if (!curKey || !Object.hasOwn(picksRef.current, curKey)) throw writeError;
            await writes.current.enqueue(() => call("review.answer", {
              runId: run.id, cardId: run.card.id, selected: picksRef.current[curKey],
            }));
          }
        }
        return { unsavedChoice };
      },
      after: (_report, { unsavedChoice }) => { if (unsavedChoice) exam.setError(ui("最后一次选择未确认保存，成绩按服务端已保存的答案计算。")); },
      describeError: (e) => {
        const message = errorMessage(e);
        return startMs && Date.now() - startMs >= runLimitMs ? uiFormat("交卷失败，正在自动重试：{0}", [message]) : message;
      },
    });
  }, [call, exam.submit, exam.setError, run, curKey, startMs, runLimitMs]); // eslint-disable-line react-hooks/exhaustive-deps

  const unanswered = useMemo(() => unansweredCount(run, picks), [run, picks]);
  const firstBlank = useMemo(() => firstUnansweredIndex(run, picks), [run, picks]);

  const kbRef = useRef(null);
  kbRef.current = { options: run?.card?.options || [], index: run?.index ?? 0, total: run?.total ?? 0, busy, pick, move };
  useEffect(() => {
    if (examMode !== "written" || phase !== "running" || !run?.card || confirming || expired) return undefined;
    const onKeyDown = (event) => {
      if (event.defaultPrevented || event.isComposing || event.keyCode === 229 || event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target;
      if (target && (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName) || target.closest?.('[role="dialog"]'))) return;
      const { options, index, total, busy: isBusy, pick: choose, move: step } = kbRef.current || {};
      if (event.key === "ArrowLeft") {
        if (!isBusy && index > 0) { event.preventDefault(); step(-1); }
        return;
      }
      if (event.key === "ArrowRight") {
        if (!isBusy && index < total - 1) { event.preventDefault(); step(1); }
        return;
      }
      const num = /^[1-9]$/.test(event.key) ? Number(event.key) - 1 : -1;
      const letter = /^[a-iA-I]$/.test(event.key) ? event.key.toUpperCase().charCodeAt(0) - 65 : -1;
      const idx = num >= 0 ? num : letter;
      if (idx >= 0 && options[idx] && !isBusy) {
        event.preventDefault();
        choose(options[idx].id);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [examMode, phase, run?.card, confirming, expired]);

  const practiceScope = (scope) => {
    if (pathNote || !scope?.length) return;
    const runId = report?.runId;
    return exam.perform(async () => {
      const nextRun = await call("review.start", { mode: "path", scope, fresh: true });
      if (onStartRun) onStartRun(nextRun, runId ? { kind: 'exam', runId } : undefined);
      else setPathNote(uiFormat("已把 {0} 道题排进学习路径，回到学习库即可开始练习。", [scope.length]));
    });
  };

  const queueWeak = () => {
    if (pathNote || !report?.weakScope?.length) return;
    const runId = report.runId;
    return exam.perform(async () => {
      const nextRun = await call("review.start", { mode: "path", scope: report.weakScope, fresh: true });
      if (onStartRun) onStartRun(nextRun, runId ? { kind: 'exam', runId } : undefined);
      else setPathNote(uiFormat("已把 {0} 道答错或未答题排进学习路径，回到学习库即可开始练习。", [report.weakScope.length]));
    });
  };

  // One weak topic of the report: the same practice the dashboard's 练这个主题 starts (a path round over that topic of that deck), with the way back to this report.
  const practiceTopic = (row) => {
    if (pathNote || !row?.deckId) return;
    const runId = report?.runId;
    return exam.perform(async () => {
      const nextRun = await call("review.start", practiceArgs([{ deckId: row.deckId, topic: row.topic }], { fresh: false }));
      if (onStartRun) onStartRun(nextRun, runId ? { kind: 'exam', runId } : undefined);
      else setPathNote(uiFormat("已把「{0}」的题排进学习路径，回到学习库即可开始练习。", [row.topic]));
    });
  };

  const openReport = async (runId) => { if (await exam.openReport(runId)) setPathNote(""); };

  function chooseFormat(next) { setPicked(next); setSavedFormat(next); setOpenRun(null); exam.setError(""); }
  function openRecent(item) {
    if (item.kind === "written") { chooseFormat("written"); openReport(item.runId); return; }
    setOpenRun({ kind: item.kind, runId: item.runId }); setPicked(item.kind); setSavedFormat(item.kind);
  }

  const togglePostmortem = useCallback(async (next) => {
    if (typeof act !== 'function') return false;
    const res = await act('settings.practice.set', { patch: { examPostmortemBridge: next ? true : null } });
    return res !== undefined;
  }, [act]);

  // One page, one switch (WP25): the header, the format's own setup card and the shared recent list.
  const recentItems = useMemo(
    () => (examMode !== 'written' || phase === 'setup' ? recentExams(data) : null),
    [data, examMode, phase],
  );
  const header = <ExamHeader courses={data?.focus?.courses} course={course} onCourse={chooseCourse} format={examMode} onFormat={chooseFormat}
    showInactive={showInactive} onShowInactive={show => { setShowInactive(show); setDeckChoice(''); }} />;
  const recent = recentItems ? <RecentExams items={recentItems} format={examMode} onOpen={openRecent} busy={busy} /> : null;
  const deepRun = (kind) => openRun?.kind === kind ? openRun.runId : initialKind === kind ? initialRunId : undefined;
  // 案例分析卷 (WP12): a timed case paper on the same exam runs, timer and report.
  if (examMode === "case") {
    const createCase = onCreateCase || onCreate;
    const caseHeader = createCase ? (
      <div className="es-case-header">
        {header}
        <div className="es-case-cta">
          <Button size="sm" variant="secondary" iconEnd="arrow-right" onClick={onCreateCase || onCreate}>
            {ui('用当前资料出一套案例卷')}
          </Button>
        </div>
      </div>
    ) : header;
    return <CasePaper key={`case:${deepRun("case") || ""}`} data={data} onExit={onExit}
      header={caseHeader} recent={recent} course={course} onCourseChange={chooseCourse} onSetupModel={onSetupModel}
      onCreate={createCase} onStartRun={onStartRun} onLocation={onLocation}
      initialRunId={deepRun("case")} />;
  }
  if (examMode === "oral") return <OralExam key={`oral:${deepRun("oral") || ""}`} data={data} onExit={onExit}
    initialRunId={deepRun("oral")} onLocation={onLocation} onStartRun={onStartRun} onSetupModel={onSetupModel}
    header={header} recent={recent}
    course={course} onCourseChange={chooseCourse}
    selection={explicitDecks ? { course, scope: [...pickedDecks].map(deckId => ({ deckId })) } : scopeArgs(course, showInactive)} />;

  return (
    <section ref={pageRef} className="page exam">
      <div className="sh-visually-hidden" role="status" aria-live="polite" aria-atomic="true" data-live-announcer="exam-status">
        {statusAnnouncement}
      </div>
      {phase === "setup" && <WrittenSetup data={data} header={header} recent={recent} decks={decks} deckNames={deckNames} picked={pickedDecks}
        onPick={setPickedDecks} kinds={pickedKinds} typeMode={typeMode} onTypeMode={setTypeMode} count={count}
        onCount={(next) => setCountDraft(String(next))} busy={busy} error={err} flashOnly={flashOnly}
        limit={{ minutes: limitMinutes, defaults: limitDefault, course }} onLimit={(minutes) => setLimitChoice(JSON.stringify({ course, minutes }))}
        onStart={startExam} onCreate={onCreate} onExit={onExit} />}

      {phase === "running" && run?.card && (
        <>
          <PageHeader eyebrow={ui("模拟考试进行中")} title={run.title || ui("模拟考试")}
            actions={<>
              <WrittenExamClock run={run} limitMs={runLimitMs} active={examMode === 'written' && phase === 'running'}
                autoSubmitReady={exam.autoSubmitReady}
                onExpire={() => { if (run?.id) setExpiredRunId(run.id); }}
                onAutoSubmit={submit} />
              <span className="exam-progress">{run.index + 1} / {run.total}</span>
            </>} />
          {run.total > 1 && <nav className="exam-jump" aria-label={ui("题目跳转与掌握程度")}>
            {Array.from({ length: run.total }, (_, i) => {
              const slot = Array.isArray(run.picks) && run.picks.length === run.total ? run.picks[i] : i === run.index ? { deckId: run.deckId, cardId: run.card.id } : null;
              const answered = Boolean(slot?.deckId != null && slot?.cardId && picks[`${slot.deckId}:${slot.cardId}`]?.length);
              const current = i === run.index;
              return (
                <Button key={i} size="sm" variant={current ? "secondary" : "quiet"}
                  className={"exam-jump__btn" + (answered ? " is-answered" : "") + (current ? " is-current" : "")}
                  aria-current={current ? "step" : undefined}
                  aria-label={joinMeta([uiFormat("第 {0} 题", [i + 1]), answered ? ui("已选") : ui("未答")])}
                  disabled={expired} lock={busy} onClick={() => jumpTo(i)}>
                  {i + 1}
                </Button>
              );
            })}
          </nav>}
          <Panel className="exam-card" tone="paper" data-exam-paper="" key={run.card.id}>
            <div className="exam-card-meta">
              <Badge tone="info">{run.card.topic || ui("未分类")}</Badge>
              <Badge>{cardKindName(run.card)}</Badge>
              <span className="muted small">
                {run.card.multiple ? ui("选出所有符合条件的选项") : run.card.kind === "truefalse" ? ui("判断这句话对不对") : ui("选出一项")}
              </span>
            </div>
            <div ref={examPromptRef} className="exam-prompt" role="heading" aria-level={2} tabIndex={-1}>
              <Markdown text={run.card.prompt} links={false} />
            </div>
            <div className="exam-options">
              {(run.card.options || []).map((o, i) => {
                const chosen = curPicks.includes(o.id);
                // An answer card, not an action button: it carries a letter and a formatted option, and toggles with aria-pressed.
                return (
                  <button key={o.id} className="exam-option" aria-pressed={chosen}
                    disabled={busy || expired} onClick={() => pick(o.id)}>
                    <span className="exam-option-letter"><OptionMark card={run.card} option={o} index={i} /></span>
                    <span className="exam-option-text">{fixedOptionLabel(run.card, o) ?? <Markdown text={o.text} links={false} className="md-compact" />}</span>
                  </button>
                );
              })}
            </div>
          </Panel>
          <div className="exam-toolbar">
            <Button icon="arrow-left" disabled={expired || !run.index} lock={busy} onClick={() => move(-1)}>{ui("上一题")}</Button>
            <Button variant="primary" iconEnd="arrow-right" disabled={expired || run.index >= run.total - 1} lock={busy} onClick={() => move(1)}>{ui("下一题")}</Button>
          </div>
          <div className="exam-foot">
            <Button lock={busy} onClick={expired || !unanswered ? submit : () => setConfirming(true)}>
              {expired ? ui("重试交卷") : ui("交卷")}
            </Button>
            <p className="muted small">
              {expired ? ui("时间已到，已停止作答；交卷失败时会自动重试。")
                : uiFormat("未交卷的考试会保留在回到题目里 · 计时满 {0} 分钟自动交卷", [Math.round(runLimitMs / 60000)])}
            </p>
          </div>
          {confirming && unanswered > 0 && <SubmitBlanksDialog
            firstBlankNumber={firstBlank >= 0 ? firstBlank + 1 : 0}
            onJumpFirstBlank={() => { setConfirming(false); if (firstBlank >= 0) jumpTo(firstBlank); }}
            onClose={() => setConfirming(false)}
            onConfirm={submit}>
            <p>{uiFormat("还有 {0} 题未作答，交卷后将立即判分并结束本次考试。", [unanswered])}</p>
          </SubmitBlanksDialog>}
          {err && <ErrorState error={err} />}
        </>
      )}

      {phase === "running" && !run?.card && (
        <LoadingState label={ui("正在载入试卷…")} />
      )}

      {phase === "report" && report && <WrittenReport report={report} busy={busy} pathNote={pathNote} error={err}
        practiceSettings={data?.settings?.practice} decks={data?.decks} sources={data?.sources}
        onQueueWeak={queueWeak} onPracticeTopic={practiceTopic} onPracticeScope={practiceScope} onOpenSource={onOpenSource}
        onTogglePostmortem={togglePostmortem}
        onExit={onExit} onAgain={() => { setPathNote(""); exam.leave({ clear: false }); }} />}
    </section>
  );
}
