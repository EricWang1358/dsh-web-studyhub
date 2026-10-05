import { ui, uiFormat, errorMessage } from "./i18n.js";
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Markdown from "./Markdown.jsx";
import css from "./views.css";
import { useInjectCss } from "./shared.js";
import { createWriteQueue } from "./async.js";
import { EXAM_LIMIT_MS } from "../lib/exam-timing.js";
import OralExam from "./OralExam.jsx";
import { decksInCourse, usePageScope, useShowInactive, scopeArgs } from './PageScope.jsx';
import { readExamTarget } from './learning-navigation.js';
import { CasePaper } from './CaseWorkspace.jsx';
import SubmitBlanksDialog from './SubmitBlanksDialog.jsx';
import caseCss from './case-study.css';
import { Badge, Button, ErrorState, LoadingState, PageHeader, Panel } from './components/index.js';
import { ExamHeader, RecentExams } from './ExamShell.jsx';
import { defaultExamFormat, isExamFormat, recentExams, shortDeckTitles } from './exam-format.js';
import { formatClock } from './format.js';
import { useExamRun } from './exam/useExamRun.js';
import { DEFAULT_COUNT, cardKindName, clampCount, picksFromRun, typeAvailableOf } from './exam/exam-written.js';
import WrittenSetup from './exam/WrittenSetup.jsx';
import WrittenReport from './exam/WrittenReport.jsx';
import { useStudy } from './study-context.jsx';

/* 模拟考试（v0.4 契约 §3）：选择题笔试。生命周期（setup → running → report、恢复、交卷、计时）在
   ui/exam/useExamRun.js，三种考试形式共用；这里只管作答界面和各形式的外壳。
   选中状态存本地（picks，按 deckId:cardId 键控），每次选择通过 review.answer 静默保存（exam 运行中
   服务端只存 entry.selected，不判分、不给反馈）；上一题/下一题走 review.move 自由导航，允许未作答移动。
   挂载时从快照 runs 里找回进行中的 exam run 并 review.get 恢复；计时满 30 分钟自动交卷；卸载不交卷，
   未交卷的考试保留在服务端可再次接回。 */

const RETRY_SUBMIT_MS = 5000;

export default function Exam({ data, onExit, onCreate, onCreateCase, onStartRun, onSetupModel, initialRunId, initialKind = 'exam', onLocation }) {
  const { call } = useStudy();
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
  const [picks, setPicks] = useState({}),
    [countDraft, setCountDraft] = useState(String(DEFAULT_COUNT)),
    [typeMode, setTypeMode] = useState("all"),
    [confirming, setConfirming] = useState(false),
    [pathNote, setPathNote] = useState("");
  const picksRef = useRef({}), writes = useRef(createWriteQueue());
  const exam = useExamRun({ kind: 'exam', call, initialRunId, onLocation, limitMs: EXAM_LIMIT_MS, retryMs: RETRY_SUBMIT_MS, locate: examMode === 'written',
    autoSubmit: { when: (timing) => timing.expired, run: () => submit() } });
  const { phase, run, report, busy, error: err, elapsedMs, startMs, expired } = exam;
  const count = clampCount(countDraft);
  const pageRef = useRef(null);
  useEffect(() => {
    if (!initialRunId || !['running', 'report'].includes(phase)) return;
    const heading = pageRef.current?.querySelector('h1');
    if (heading) { heading.tabIndex = -1; heading.focus(); }
  }, [initialRunId, phase]);

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
        scope: [...pickedDecks].map((deckId) => ({ deckId })),
        count,
        examKinds: typeMode,
        fresh: true,
      });
      writes.current = createWriteQueue();
      applyPicks(picksFromRun(r));
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
    })).then(() => exam.setError(""), (e) => exam.setError(startMs && Date.now() - startMs >= EXAM_LIMIT_MS
      ? ui("考试时间已到，未确认保存的选择可能不会计入成绩。")
      : uiFormat("选择尚未保存，请重新选择后继续：{0}", [errorMessage(e)])));
  }

  const move = (direction) => {
    if (expired || !run) return;
    return exam.perform(async () => {
      await writes.current.flush();
      const next = await call("review.move", { runId: run.id, direction });
      const r = next && next.card ? next : await call("review.get", { runId: run.id });
      exam.setRun(r);
      // All writes finished before navigation; the server is authoritative.
      applyPicks(picksFromRun(r));
    });
  };

  const submit = useCallback(() => {
    setConfirming(false);
    return exam.submit({
      before: async () => {
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
        return { unsavedChoice };
      },
      after: (_report, { unsavedChoice }) => { if (unsavedChoice) exam.setError(ui("最后一次选择未确认保存，成绩按服务端已保存的答案计算。")); },
      describeError: (e) => {
        const message = errorMessage(e);
        return startMs && Date.now() - startMs >= EXAM_LIMIT_MS ? uiFormat("交卷失败，正在自动重试：{0}", [message]) : message;
      },
    });
  }, [call, exam.submit, exam.setError, run, curKey, startMs]); // eslint-disable-line react-hooks/exhaustive-deps

  const answeredCount = useMemo(
    () => Object.values(picks).filter((a) => Array.isArray(a) && a.length).length,
    [picks],
  );
  const unanswered = Math.max(0, (run?.total || 0) - answeredCount);

  const queueWeak = () => {
    if (pathNote || !report?.weakScope?.length) return;
    return exam.perform(async () => {
      const nextRun = await call("review.start", { mode: "path", scope: report.weakScope, fresh: true });
      if (onStartRun) onStartRun(nextRun, { kind: 'exam', runId: report.runId });
      else setPathNote(uiFormat("已把 {0} 道答错或未答题排进学习路径，回到学习库即可开始练习。", [report.weakScope.length]));
    });
  };

  const openReport = async (runId) => { if (await exam.openReport(runId)) setPathNote(""); };

  function chooseFormat(next) { setPicked(next); setSavedFormat(next); setOpenRun(null); exam.setError(""); }
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
    onCreate={onCreateCase || onCreate} onStartRun={onStartRun} onLocation={onLocation}
    initialRunId={deepRun("case")} />;
  if (examMode === "oral") return <OralExam key={`oral:${deepRun("oral") || ""}`} data={data} onExit={onExit}
    initialRunId={deepRun("oral")} onLocation={onLocation} onStartRun={onStartRun} onSetupModel={onSetupModel}
    header={header} recent={recent}
    course={course} onCourseChange={chooseCourse}
    selection={explicitDecks ? { scope: [...pickedDecks].map(deckId => ({ deckId })) } : scopeArgs(course, showInactive)} />;

  return (
    <section ref={pageRef} className="page exam">
      {phase === "setup" && <WrittenSetup data={data} header={header} recent={recent} decks={decks} deckNames={deckNames} picked={pickedDecks}
        onPick={setPickedDecks} kinds={pickedKinds} typeMode={typeMode} onTypeMode={setTypeMode} count={count}
        onCount={(next) => setCountDraft(String(next))} busy={busy} error={err} flashOnly={flashOnly}
        onStart={startExam} onCreate={onCreate} onExit={onExit} />}

      {phase === "running" && run?.card && (
        <>
          <PageHeader eyebrow={ui("模拟考试进行中")} title={run.title || ui("模拟考试")}
            actions={<>
              <span className="exam-timer" title={ui("已用时")}>{uiFormat("已用时 {0}", [formatClock(elapsedMs)])}</span>
              <span className="exam-progress">{run.index + 1} / {run.total}</span>
            </>} />
          <Panel className="exam-card" key={run.card.id}>
            <div className="exam-card-meta">
              <Badge tone="info">{run.card.topic || ui("未分类")}</Badge>
              <Badge>{cardKindName(run.card)}</Badge>
              <span className="muted small">
                {run.card.multiple ? ui("选出所有符合条件的选项") : ui("选出一项")}
              </span>
            </div>
            <div className="exam-prompt">
              <Markdown text={run.card.prompt} links={false} />
            </div>
            <div className="exam-options">
              {(run.card.options || []).map((o, i) => {
                const chosen = curPicks.includes(o.id);
                // An answer card, not an action button: it carries a letter and a formatted option, and toggles with aria-pressed.
                return (
                  <button key={o.id} className="exam-option" aria-pressed={chosen}
                    disabled={busy || expired} onClick={() => pick(o.id)}>
                    <span className="exam-option-letter">{String.fromCharCode(65 + i)}</span>
                    <span className="exam-option-text"><Markdown text={o.text} links={false} className="md-compact" /></span>
                  </button>
                );
              })}
            </div>
          </Panel>
          <div className="exam-toolbar">
            <Button disabled={busy || expired || !run.index} onClick={() => move(-1)}>{ui("← 上一题")}</Button>
            <Button variant="primary" disabled={busy || expired || run.index >= run.total - 1} onClick={() => move(1)}>{ui("下一题 →")}</Button>
          </div>
          <div className="exam-foot">
            <Button disabled={busy} onClick={expired ? submit : () => setConfirming(true)}>
              {expired ? ui("重试交卷") : ui("交卷")}
            </Button>
            <p className="muted small">
              {expired ? ui("时间已到，已停止作答；交卷失败时会自动重试。")
                : ui("未交卷的考试会保留在回到题目里 · 计时满 30 分钟自动交卷")}
            </p>
          </div>
          {confirming && <SubmitBlanksDialog onClose={() => setConfirming(false)} onConfirm={submit}>
            <p>{uiFormat("还有 {0} 题未作答，交卷后将立即判分并结束本次考试。", [unanswered])}</p>
          </SubmitBlanksDialog>}
          {err && <ErrorState error={err} />}
        </>
      )}

      {phase === "running" && !run?.card && (
        <LoadingState label={ui("正在载入试卷…")} />
      )}

      {phase === "report" && report && <WrittenReport report={report} busy={busy} pathNote={pathNote} error={err}
        onQueueWeak={queueWeak} onExit={onExit} onAgain={() => exam.leave({ clear: false })} />}
    </section>
  );
}
