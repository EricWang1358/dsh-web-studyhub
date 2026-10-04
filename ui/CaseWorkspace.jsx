import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ui, uiFormat, getUiLanguage } from "./i18n.js";
import { useInjectCss } from "./shared.js";
import Markdown from "./Markdown.jsx";
import { countsDeck, courseMatcher, usePageScope } from "./PageScope.jsx";
import { createWriteQueue } from "./async.js";
import { submitAssist } from "./assist-request.js";
import { modelReadiness } from "./generation-status.js";
import { TokenEstimate } from "./TokenUsage.jsx";
import { EXAM_SETTING_LIMITS } from "../lib/courses.js";
import { Badge, Button, Disclosure, InlineMessage, PageHeader, Panel, SegmentedControl, Spinner, useToast } from "./components/index.js";
import ModelSetupGate, { gateTitle } from "./ModelSetupGate.jsx";
import { formatClock } from "./format.js";
import { useExamRun } from "./exam/useExamRun.js";
import SubmitBlanksDialog from "./SubmitBlanksDialog.jsx";
import { ExamSetupCard } from "./ExamShell.jsx";
import {
  scenarioParagraphs, countWords, questionMinutes, lengthHint, suggestedWords, paperPlan, defaultReadingMinutes,
  blankQuestions, courseProfileFromState, DEFAULT_MINUTES_PER_MARK,
} from "../lib/case-study.js";
import {
  HIGHLIGHT_COLORS, addHighlight, removeHighlight, recolorHighlight, annotateHighlight, segmentParagraph,
  paperPhase, phaseRemaining, canType, livePace, tickQuestion, paperTimings, readSession, writeSession,
} from "./case-session.js";
import { RubricResult, CaseReport } from "./CaseResult.jsx";
import { useStudy } from "./study-context.jsx";
import css from "./case-study.css";

/* Case practice inside the existing loop (WP12): the scenario panel (numbered
   paragraphs, multi-colour highlights stored on the run), the rubric answer
   that replaces self-rating for open questions with criteria in review, and
   the timed case paper of 模拟考试 (reading phase, ~3 minutes per mark,
   pacing, paper-practice mode, blank-question warning, graded report). */

const COLOR_LABEL = { yellow: "黄色高亮", green: "绿色高亮", blue: "蓝色高亮", pink: "粉色高亮" };
export function lengthHintLabel(marks) {
  const words = suggestedWords(marks, getUiLanguage());
  const kind = { paragraph: ui("一段话"), short: ui("两三段：观点 + 理由"), structured: ui("分点作答，附例子"), extended: ui("分点作答：例子、论证与取舍") }[lengthHint(marks)];
  return uiFormat("{0} · 约 {1}–{2} 字/词", [kind, words.min, words.max]);
}

/* ---------- the scenario ---------- */

function textOffset(container, node, offset) {
  let total = 0;
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
  for (let current = walker.nextNode(); current; current = walker.nextNode()) {
    if (current === node) return total + offset;
    total += current.textContent.length;
  }
  return node === container ? [...container.childNodes].slice(0, offset).reduce((sum, child) => sum + child.textContent.length, 0) : total;
}

/**
 * The case text with numbered paragraphs. With the highlighter on, selecting
 * text marks it in the chosen colour; a mark opens recolour, note and remove.
 */
export function ScenarioPanel({ title, text, highlights = [], onChange, readOnly = false, className = "", label, ...rest }) {
  useInjectCss(css, "study-case-workspace");
  const paragraphs = useMemo(() => scenarioParagraphs(text), [text]);
  const [color, setColor] = useState("yellow");
  const [pen, setPen] = useState(true);
  const [active, setActive] = useState(null);
  const [note, setNote] = useState("");
  const rootRef = useRef(null);
  const editable = !readOnly && typeof onChange === "function";
  function mark(nextColor = color) {
    const selection = window.getSelection?.();
    if (!editable || !selection || selection.isCollapsed || !selection.rangeCount) return false;
    const range = selection.getRangeAt(0);
    const startText = range.startContainer.parentElement?.closest?.(".case-para__text") || (range.startContainer.closest?.(".case-para__text"));
    const endText = range.endContainer.parentElement?.closest?.(".case-para__text") || (range.endContainer.closest?.(".case-para__text"));
    if (!startText || !rootRef.current?.contains(startText)) return false;
    const paragraph = Number(startText.dataset.paragraph);
    // A selection running past its paragraph (a triple click) is cut at the paragraph's end.
    const start = textOffset(startText, range.startContainer, range.startOffset);
    const end = endText === startText ? textOffset(startText, range.endContainer, range.endOffset) : startText.textContent.length;
    if (!(end > start)) return false;
    onChange(addHighlight(highlights, { id: `h${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, paragraph, start, end, color: nextColor }));
    selection.removeAllRanges();
    return true;
  }
  const current = highlights.find((item) => item.id === active);
  useEffect(() => { setNote(current?.note || ""); }, [active]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <section ref={rootRef} className={`case-scenario ${className}`} aria-label={label || ui("案例原文")} {...rest}>
      <header className="case-scenario__bar">
        <strong className="case-scenario__title">{title || ui("案例原文")}</strong>
        {editable && <div className="case-highlight-tools" role="toolbar" aria-label={ui("高亮工具")}>
          <button type="button" className={"case-pen" + (pen ? " is-on" : "")} aria-pressed={pen}
            title={ui("打开后，选中文字即可高亮")} onClick={() => setPen((value) => !value)}>{ui("荧光笔")}</button>
          {HIGHLIGHT_COLORS.map((name) => (
            <button key={name} type="button" className={`case-swatch hl-${name}`} aria-pressed={color === name} aria-label={ui(COLOR_LABEL[name])}
              title={ui("选中文字后点颜色即可高亮")} onMouseDown={(event) => event.preventDefault()}
              onClick={() => { setColor(name); mark(name); }} />
          ))}
        </div>}
      </header>
      <ol className="case-paras">
        {paragraphs.map((paragraph, index) => {
          const n = index + 1, own = highlights.filter((item) => item.paragraph === n);
          return (
            <li key={n} className="case-para">
              <span className="case-para__n" aria-hidden="true">{n}</span>
              <div>
                <p className="case-para__text" data-paragraph={n} onMouseUp={() => { if (pen) mark(); }}>
                  {segmentParagraph(paragraph, own).map((piece, at) => piece.id
                    ? <mark key={at} className={`case-hl hl-${piece.color}` + (piece.id === active ? " is-active" : "")} title={piece.note || undefined}
                      tabIndex={editable ? 0 : undefined} onClick={() => editable && setActive(piece.id)}
                      onKeyDown={(event) => { if (editable && (event.key === "Enter" || event.key === " ")) { event.preventDefault(); setActive(piece.id); } }}>{piece.text}</mark>
                    : <React.Fragment key={at}>{piece.text}</React.Fragment>)}
                </p>
                {own.filter((item) => item.note).map((item) => <p key={item.id} className="case-para__note"><span className={`case-dot hl-${item.color}`} />{item.note}</p>)}
                {editable && current && current.paragraph === n && <div className="case-mark-tools" role="group" aria-label={ui("编辑这处高亮")}>
                  {HIGHLIGHT_COLORS.map((name) => <button key={name} type="button" className={`case-swatch hl-${name}`} aria-pressed={current.color === name}
                    aria-label={ui(COLOR_LABEL[name])} onClick={() => onChange(recolorHighlight(highlights, current.id, name))} />)}
                  <input aria-label={ui("批注")} placeholder={ui("写一句批注（可选）")} value={note} maxLength={500}
                    onChange={(event) => setNote(event.target.value)}
                    onBlur={() => { if ((current.note || "") !== note.trim()) onChange(annotateHighlight(highlights, current.id, note)); }} />
                  <Button size="sm" variant="quiet" onClick={() => { onChange(removeHighlight(highlights, current.id)); setActive(null); }}>{ui("移除高亮")}</Button>
                  <Button size="sm" variant="link" onClick={() => { if ((current.note || "") !== note.trim()) onChange(annotateHighlight(highlights, current.id, note)); setActive(null); }}>{ui("完成")}</Button>
                </div>}
              </div>
            </li>
          );
        })}
      </ol>
      {!paragraphs.length && <p className="muted">{ui("案例原文已被删除，题目仍可作答。")}</p>}
    </section>
  );
}

/* ---------- a rubric question in review ---------- */

/**
 * An open question with rubric criteria: write the answer, then 提交批改 (a
 * background grading task); the per-criterion result replaces self-rating.
 */
export function RubricAnswer({ run, data, value = "", onChange, onSubmit, task, onSetupModel }) {
  const { busy, call } = useStudy();
  useInjectCss(css, "study-case-workspace");
  const card = run.card, rubric = run.feedback?.rubric;
  const model = modelReadiness(data);
  const grading = task?.status === "running";
  const key = `${run.id}:${card.id}`;
  const [draft, setDraft] = useState(() => value || readSession(data?.root, key)?.answer || "");
  useEffect(() => { if (value && value !== draft) setDraft(value); }, [value]); // eslint-disable-line react-hooks/exhaustive-deps
  const change = (next) => { setDraft(next); onChange?.(next); writeSession(data?.root, key, next ? { answer: next } : null); };
  const marks = Number(card.marks) || 0;
  return (
    <div className="rubric-answer" data-tour="case-practice">
      <div className="question" role="heading" aria-level={2}><Markdown text={card.prompt} /></div>
      <div className="rubric-answer__meta">
        <Badge size="sm">{uiFormat("{0} 分", [marks])}</Badge>
        <Badge size="sm">{uiFormat("建议用时约 {0} 分钟", [questionMinutes(marks)])}</Badge>
        <Badge size="sm">{lengthHintLabel(marks)}</Badge>
        {run.lastRubric && !rubric && <Badge size="sm">{uiFormat("上次批改 {0}/{1} 分", [run.lastRubric.total, run.lastRubric.max])}</Badge>}
      </div>
      {card.rubricCriteria?.length > 0 && !rubric && <details className="rubric-dims">
        <summary>{ui("评分维度")}</summary>
        <ul>{card.rubricCriteria.map((criterion) => <li key={criterion.id}>{criterion.label}<span>{uiFormat("{0} 分", [criterion.marks])}</span></li>)}</ul>
      </details>}
      {rubric ? (
        <>
          {run.feedback.answer && <details className="rubric-my-answer"><summary>{ui("我的回答")}</summary><Markdown text={run.feedback.answer} /></details>}
          <RubricResult rubric={rubric} />
          {run.solution?.answer && <details className="rubric-my-answer" open><summary>{ui("参考答案（批改后揭晓）")}</summary>
            <Markdown text={run.solution.answer} /></details>}
        </>
      ) : (
        <>
          <label className="rubric-editor">
            <span>{ui("你的回答")}</span>
            <textarea rows={10} value={draft} readOnly={grading} maxLength={30000}
              placeholder={ui("写出建议，并用案例里的事实说明理由；案例没说的地方先写假设，再说明为什么不选另一种方案。支持 Markdown。")}
              onChange={(event) => change(event.target.value)} />
          </label>
          <div className="rubric-answer__foot">
            <small className="muted">{uiFormat("{0} 字/词 · 篇幅不等于得分", [countWords(draft)])}</small>
            {model.ready
              ? <Button variant="primary" icon="sparkle" busy={grading} disabled={busy || grading || !draft.trim()} onClick={() => onSubmit?.(draft)}>
                {grading ? ui("正在批改…") : ui("提交批改")}</Button>
              : <ModelSetupGate variant="inline" feature="grade" model={model} onOpenSettings={onSetupModel} />}
          </div>
          {/* What marking this answer is expected to use: the case, the rubric and the answer as typed (WP27). */}
          <TokenEstimate enabled={!!call && !!draft.trim() && !rubric}
            request={{ feature: "grade", deckId: run.deckId, cardId: card.id, answerChars: draft.length }} />
          {grading && <p className="assist-status" role="status"><Spinner size="sm" />
            {ui("正在按评分标准逐项批改：完成后结果显示在这里，也会进信箱。可以先去做别的题。")}</p>}
          {task?.status === "failed" && <InlineMessage>{uiFormat("批改没有完成：{0}。可以重新提交。", [task.message || ui("任务失败")])}</InlineMessage>}
        </>
      )}
    </div>
  );
}

/* ---------- the case paper of 模拟考试 ---------- */

const phaseLabel = (phase, handwriting) => ({ reading: ui("阅读时间"), writing: handwriting ? ui("纸上作答") : ui("作答时间"),
  transcribe: ui("录入答案（不计时）"), over: ui("时间到"), submitted: ui("已交卷") })[phase] || "";
const paceLabel = (pace) => ({ ahead: ui("节奏从容"), "on-track": ui("节奏正常"), behind: ui("时间偏紧：先保证每题都写到") })[pace];

export function CasePaper({ data, call, onExit, onCreate, onStartRun, initialRunId, onLocation, header, recent, course: courseProp, onCourseChange, onSetupModel }) {
  useInjectCss(css, "study-case-workspace");
  const toast = useToast();
  // 模拟考试 owns the course scope and the header; used on its own the paper keeps its own scope.
  const [ownCourse] = usePageScope(data?.root, "exam", data?.focus?.course ?? "*");
  const course = courseProp ?? ownCourse;
  const decks = useMemo(() => {
    const within = courseMatcher(data, course), counts = countsDeck(data, course, false);
    return (data?.decks || []).filter((deck) => deck.format === "case-study" && !deck.archived && within(deck.course || "") && counts(deck));
  }, [data, course]);
  const [deckId, setDeckId] = useState("");
  const deck = decks.find((item) => item.id === deckId) || decks[0] || null;
  // The course profile (WP13) proposes the time model; the learner can override it for this paper.
  const profile = useMemo(() => courseProfileFromState({ courses: data?.courses }, course === "*" ? "" : course), [data?.courses, course]);
  const [settings, setSettings] = useState(() => ({ minutesPerMark: profile.exam.minutesPerMark || DEFAULT_MINUTES_PER_MARK,
    readingMinutes: Number.isFinite(profile.exam.readingMinutes) ? profile.exam.readingMinutes : null, handwriting: false }));
  const [answers, setAnswers] = useState({}), [highlights, setHighlights] = useState([]), [session, setSession] = useState(null);
  const [activeId, setActiveId] = useState(null), [view, setView] = useState("questions");
  const [confirming, setConfirming] = useState(false), [gradingErrors, setGradingErrors] = useState([]);
  // A typed paper is submitted when its time is up; paper practice moves on to transcription instead. The report follows the background grading.
  const exam = useExamRun({ kind: "case", call, initialRunId, onLocation, pollReport: (value) => !!value?.case?.pending,
    autoSubmit: { when: () => currentPhase === "over", run: () => submit() } });
  const { phase, run, report, busy, error, now } = exam;
  const writes = useRef(createWriteQueue()), savedHighlights = useRef(""), lastTick = useRef(Date.now());
  const activeRef = useRef(activeId);
  activeRef.current = activeId;
  const model = modelReadiness(data);

  useEffect(() => {
    setSettings((current) => ({ ...current, minutesPerMark: profile.exam.minutesPerMark || DEFAULT_MINUTES_PER_MARK,
      readingMinutes: Number.isFinite(profile.exam.readingMinutes) ? profile.exam.readingMinutes : null }));
  }, [profile]);

  const paperCards = useMemo(() => run?.paperCards || [], [run?.paperCards]);
  const plan = useMemo(() => paperPlan(paperCards.map((card) => ({ cardId: card.id, marks: card.marks })),
    { minutesPerMark: run?.paper?.minutesPerMark, readingMinutes: run?.paper?.readingMinutes }), [paperCards, run?.paper]);
  const scenario = useMemo(() => {
    const summary = (data?.decks || []).find((item) => item.id === (run?.paper?.deckId || deck?.id));
    return (data?.sources || []).find((source) => source.id === summary?.caseSourceId) || null;
  }, [data, run?.paper?.deckId, deck?.id]);

  /** What the page holds for a paper that is being sat: the answers (server, then this browser), the highlights and the clock's bookkeeping. */
  function setUpPaper(value) {
    const stored = readSession(data?.root, value.id);
    const fromServer = Object.fromEntries((value.responses || []).map((item) => [item.cardId, item.response || ""]));
    setAnswers({ ...fromServer, ...(stored?.answers || {}) });
    setHighlights(value.highlights?.length ? value.highlights : stored?.highlights || []);
    savedHighlights.current = JSON.stringify(value.highlights || []);
    setSession({ startedAt: value.startedAt, readingMinutes: value.paper.readingMinutes, writingMinutes: value.paper.writingMinutes,
      handwriting: value.paper.handwriting, perQuestion: {}, transcribeMs: 0, ...stored?.session });
    setActiveId(value.paperCards?.[0]?.id || null);
    writes.current = createWriteQueue();
  }

  /* resume an unfinished paper */
  useEffect(() => {
    const ids = initialRunId ? [initialRunId] : (data?.runs || []).filter((item) => item.mode === "exam").map((item) => item.id).reverse().slice(0, 3);
    void exam.restore({ ids,
      load: async (id) => {
        const value = await call("review.get", { runId: id });
        if (!value.paper) return null;
        if (!value.closed) return { phase: "running", run: value };
        return initialRunId ? { phase: "report", run: value, report: await call("exam.report", { runId: id }) } : { stop: true };
      },
      onFound: (found) => { if (found.phase === "running") setUpPaper(found.run); },
      // Not a paper any more, or not readable: try the next candidate.
      onError: () => "continue" });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  /* the clock: phases, time per question, transcription time */
  const currentPhase = phase === "running" && session ? paperPhase(session, now) : phase;
  useEffect(() => { lastTick.current = Date.now(); }, [phase]);
  // The seconds that passed since the last tick belong to the question being written or to transcription.
  useEffect(() => {
    if (phase !== "running") return;
    const delta = now - lastTick.current;
    if (delta <= 0) return;
    lastTick.current = now;
    setSession((current) => {
      if (!current) return current;
      const step = paperPhase(current, now);
      if (step === "writing") return { ...current, perQuestion: tickQuestion(current.perQuestion, activeRef.current, delta) };
      if (step === "transcribe") return { ...current, transcribeMs: (current.transcribeMs || 0) + Math.min(delta, 5000) };
      return current;
    });
  }, [now, phase]);
  useEffect(() => { if (run && phase === "running") writeSession(data?.root, run.id, { answers, highlights, session }); }, [answers, highlights, session]); // eslint-disable-line react-hooks/exhaustive-deps

  /* saving: answers per question, highlights on the run */
  const saveTimers = useRef({});
  function answer(cardId, text) {
    setAnswers((current) => ({ ...current, [cardId]: text }));
    clearTimeout(saveTimers.current[cardId]);
    saveTimers.current[cardId] = setTimeout(() => {
      writes.current.enqueue(() => call("review.answer", { runId: run.id, cardId, response: text })).catch((failure) => exam.setError(failure.message));
    }, 1200);
  }
  useEffect(() => {
    if (!run || phase !== "running") return;
    const serialized = JSON.stringify(highlights);
    if (serialized === savedHighlights.current) return;
    const timer = setTimeout(() => {
      savedHighlights.current = serialized;
      call("review.highlights", { runId: run.id, highlights }).catch(() => {});
    }, 800);
    return () => clearTimeout(timer);
  }, [highlights, run, phase, call]);

  const start = () => {
    if (!deck) return;
    return exam.perform(async () => {
      const value = await call("review.start", { mode: "exam", examKinds: "case", scope: [{ deckId: deck.id }], fresh: true,
        paper: { minutesPerMark: settings.minutesPerMark, readingMinutes: settings.readingMinutes ?? defaultReadingMinutes(deck.caseMarks, settings.minutesPerMark),
          handwriting: settings.handwriting } });
      setUpPaper(value);
      exam.enter(value);
    });
  };

  const grade = useCallback(async (value, responses) => {
    const errors = [];
    for (const question of value.case.questions.filter((item) => item.status === "pending")) {
      const request = { mode: "grade", deckId: question.deckId, cardId: question.cardId, runId: value.runId, text: responses[question.cardId] || "", uiLanguage: getUiLanguage() };
      try { await submitAssist(call, request); }
      catch (failure) {
        // Hosts without background help grade through the runtime action instead.
        if (/assist\.start/.test(failure.message)) {
          try { await call("card.grade", { deckId: question.deckId, cardId: question.cardId, runId: value.runId, answer: request.text }); }
          catch (inner) { errors.push(inner.message); }
        } else errors.push(failure.message);
      }
    }
    setGradingErrors(errors);
  }, [call]);

  function submit() {
    setConfirming(false);
    return exam.submit({
      before: async () => {
        for (const timer of Object.values(saveTimers.current)) clearTimeout(timer);
        for (const card of paperCards) writes.current.enqueue(() => call("review.answer", { runId: run.id, cardId: card.id, response: answers[card.id] || "" }));
        await writes.current.flush();
        if (JSON.stringify(highlights) !== savedHighlights.current) await call("review.highlights", { runId: run.id, highlights }).catch(() => {});
      },
      args: () => ({ timings: paperTimings(session, Date.now()) }),
      after: async (value) => {
        writeSession(data?.root, run.id, null);
        if (model.ready) await grade(value, answers);
        else setGradingErrors([uiFormat("{0}，答案已保存；配置模型后点「重新提交批改」。", [gateTitle("inline")])]);
      },
    });
  }

  const drills = (criteria) => exam.perform(async () => {
    const value = await call("case.drills", { deckId: report.case.deckId, ...(criteria ? { criteria } : {}) });
    toast.success(uiFormat("正在把 {0} 个薄弱评分项写成 {1} 道针对练习，完成后加入「薄弱项练习」题组并排进复习。", [value.criteria, value.count]));
  });
  const again = () => exam.perform(async () => {
    await call("generate", { kind: "case", fromDeckId: report.case.deckId, uiLanguage: getUiLanguage() });
    toast.success(ui("已开始出一套同类案例，完成后草稿会出现在学习库。"));
  });

  /* ---------- views ---------- */

  if (phase === "report" && report) return (
    <section className="page exam case-paper">
      <PageHeader eyebrow={ui("案例分析卷")} title={ui("案例分析卷 · 报告")} description={report.case?.title}
        back={{ label: ui("回到模拟考试"), onClick: () => exam.leave() }} />
      <CaseReport report={report} busy={busy} gradingErrors={gradingErrors}
        onRetryGrading={() => grade(report, answers)}
        onDrills={model.ready ? drills : undefined} onAgain={model.ready ? again : undefined}
        onPracticeDeck={onStartRun ? async () => {
          try { onStartRun(await call("review.start", { mode: "path", scope: [{ deckId: report.case.deckId }], fresh: true })); }
          catch (failure) { exam.setError(failure.message); }
        } : undefined} />
      {error && <InlineMessage>{error}</InlineMessage>}
    </section>
  );

  if (phase === "running" && run && session) {
    const remaining = phaseRemaining(session, now), typing = canType(currentPhase, session.handwriting);
    const pace = currentPhase === "writing" ? livePace(plan, session, answers, now) : null;
    const blanks = blankQuestions(plan.questions, answers);
    const questions = (
      <div className="case-paper__questions" aria-label={ui("题目")}>
        {currentPhase === "reading" && <p className="case-paper__lock" role="status">{ui("阅读时间：先通读案例和题目，用不同颜色标出线索。作答区在阅读结束后开放。")}</p>}
        {currentPhase === "transcribe" && <p className="case-paper__lock is-open" role="status">{ui("纸上作答时间已到。现在把要点录入或粘贴进来批改，录入时间不计入考试时间。")}</p>}
        {paperCards.map((card, index) => {
          const spent = session.perQuestion?.[card.id] || 0, budget = questionMinutes(card.marks, run.paper.minutesPerMark) * 60000;
          return (
            <Panel as="article" key={card.id} className={"case-question" + (activeId === card.id ? " is-active" : "")}>
              <header className="case-question__head">
                <strong>{uiFormat("第 {0} 题", [index + 1])}</strong>
                <Badge size="sm">{uiFormat("{0} 分", [card.marks])}</Badge>
                <Badge size="sm" tone={spent > budget ? "warning" : "neutral"}>{uiFormat("{0}/{1} 分钟", [Math.round(spent / 60000), Math.round(budget / 60000)])}</Badge>
              </header>
              <Markdown text={card.prompt} />
              <p className="case-question__hint">{lengthHintLabel(card.marks)}</p>
              {session.handwriting && currentPhase === "writing" ? (
                <button type="button" className={"case-paper__write" + (activeId === card.id ? " is-active" : "")} aria-pressed={activeId === card.id}
                  onClick={() => setActiveId(card.id)}>{activeId === card.id ? ui("正在纸上写这一题") : ui("切到这一题（计时）")}</button>
              ) : (
                <label className="rubric-editor">
                  <span className="sh-visually-hidden">{uiFormat("第 {0} 题的回答", [index + 1])}</span>
                  <textarea rows={8} value={answers[card.id] || ""} readOnly={!typing} aria-readonly={!typing} maxLength={30000}
                    placeholder={typing ? ui("写出建议、案例依据、假设和取舍。") : ui("阅读结束后开放作答")}
                    onFocus={() => setActiveId(card.id)} onChange={(event) => typing && answer(card.id, event.target.value)} />
                  <small className="muted">{uiFormat("{0} 字/词", [countWords(answers[card.id] || "")])}</small>
                </label>
              )}
            </Panel>
          );
        })}
      </div>
    );
    const scenarioPanel = <ScenarioPanel title={scenario?.title} text={scenario?.text || ""} highlights={highlights} onChange={setHighlights}
      label={ui("案例原文（可高亮）")} data-tour="case-practice" />;
    return (
      <section className="page exam case-paper is-running">
        <div className="case-paper__bar" role="region" aria-label={ui("考试状态")}>
          <div>
            <span className="eyebrow">{ui("案例分析卷")}</span>
            <strong>{phaseLabel(currentPhase, session.handwriting)}</strong>
          </div>
          {["reading", "writing"].includes(currentPhase) && <span className="case-paper__clock" aria-live="off">{formatClock(remaining)}</span>}
          {pace && <Badge size="sm" tone={pace === "behind" ? "warning" : pace === "ahead" ? "success" : "neutral"}>{paceLabel(pace)}</Badge>}
          <div className="case-paper__bar-actions">
            {currentPhase === "reading" && <Button size="sm" variant="secondary" onClick={() => setSession({ ...session, readingEndedAt: new Date().toISOString() })}>{ui("提前开始作答")}</Button>}
            {currentPhase === "writing" && session.handwriting && <Button size="sm" variant="secondary" onClick={() => setSession({ ...session, writingEndedAt: new Date().toISOString() })}>{ui("我写完了，开始录入")}</Button>}
            {currentPhase !== "reading" && <Button size="sm" variant="primary" busy={busy}
              onClick={() => (blanks.length ? setConfirming(true) : submit())}>{ui("交卷批改")}</Button>}
          </div>
        </div>
        <SegmentedControl className="case-paper__switch" size="sm" label={ui("显示")} value={view} onChange={setView}
          options={[{ value: "case", label: ui("案例") }, { value: "questions", label: ui("题目") }]} />
        <div className={`case-paper__body show-${view}`}>
          {scenarioPanel}
          {questions}
        </div>
        {error && <InlineMessage>{error}</InlineMessage>}
        {confirming && <SubmitBlanksDialog onClose={() => setConfirming(false)} onConfirm={submit}>
          <p>{uiFormat("第 {0} 题还是空的。漏答一道就会丢掉它的全部分数；哪怕写几行要点也比空着好。", [blanks.map((id) => paperCards.findIndex((card) => card.id === id) + 1).join("、")])}</p>
        </SubmitBlanksDialog>}
      </section>
    );
  }

  /* setup */
  const reading = settings.readingMinutes ?? (deck ? defaultReadingMinutes(deck.caseMarks, settings.minutesPerMark) : 0);
  const writing = deck ? Math.round(deck.caseMarks * settings.minutesPerMark) : 0;
  const courseRecord = (data?.courses || []).find((item) => item && item.name === course);
  const examFormatName = { "open-book-case": ui("开卷案例"), "closed-book": ui("闭卷"), mixed: ui("混合"), other: ui("其他") }[courseRecord?.exam?.format];
  return (
    <section className="page exam case-paper">
      {header || <PageHeader eyebrow={ui("模拟考试")} title={ui("案例分析卷")} />}
      <ExamSetupCard data-tour="exam-start" title={ui("案例分析卷")}
        intro={ui("限时完成一套案例题：先阅读并高亮线索，再按分值分配时间作答。")}
        steps={[
          ui("选一套案例卷，或点「新出一份案例卷」让 AI 按课程资料出一套。"),
          ui("先读：阅读时间里只能看案例和题目，用不同颜色高亮线索。"),
          ui("再写：按每题分值分配作答时间，页面会显示每题的建议用时。"),
          ui("交卷后按评分标准逐条给分，并给出改写建议；批改由 AI 模型完成，结果也会进信箱。"),
        ]}
        summary={deck ? [uiFormat("满分 {0} 分", [deck.caseMarks]),
          uiFormat("阅读 {0} 分钟 · 作答 {1} 分钟（每分约 {2} 分钟）· 共 {3} 分钟", [reading, writing, settings.minutesPerMark, reading + writing])].join(" · ")
          : ui("先选一套案例卷")}
        action={<Button variant="primary" busy={busy} disabled={!deck} onClick={start}>{ui("开始考试")}</Button>}>
        <div className="es-section">
          <div className="es-section__head">
            <div><strong>{ui("案例卷")}</strong><small>{ui("每套案例一次考完，可以重考；最好成绩显示在学习库。")}</small></div>
            {decks.length > 0 && onCreate && <div className="es-tools"><Button size="sm" variant="secondary" icon="plus" onClick={onCreate}>{ui("新出一份案例卷")}</Button></div>}
          </div>
          {decks.length ? (
            <div className="es-papers" role="radiogroup" aria-label={ui("案例题组")}>
              {decks.map((item) => (
                <label key={item.id} className={"es-paper" + (deck?.id === item.id ? " is-picked" : "")}>
                  <input type="radio" name="case-paper-deck" checked={deck?.id === item.id} onChange={() => setDeckId(item.id)} />
                  <span>
                    <strong>{item.title}</strong>
                    <small>{uiFormat("{0} 题 · {1} 分", [item.count, item.caseMarks])}{item.caseBest ? uiFormat(" · 最好成绩 {0}/{1}", [item.caseBest.total, item.caseBest.max]) : ""}</small>
                  </span>
                </label>
              ))}
            </div>
          ) : (
            <div className="es-empty">
              <strong>{ui("还没有案例分析题组")}</strong>
              <p>{ui("在「创建题组 › 案例分析题」里用课程资料出一套案例，或粘贴往年真题仿照出题。")}</p>
              {onCreate && <Button variant="secondary" icon="plus" onClick={onCreate}>{ui("新出一份案例卷")}</Button>}
              <Button variant="quiet" onClick={onExit}>{ui("回学习库")}</Button>
            </div>
          )}
        </div>
        {deck && <div className="es-section">
          <div className="es-times">
            <label>{ui("阅读时间（分钟）")}
              <input type="number" min={EXAM_SETTING_LIMITS.readingMinutes.min} max={EXAM_SETTING_LIMITS.readingMinutes.max} value={reading}
                onChange={(event) => setSettings({ ...settings, readingMinutes: Math.min(EXAM_SETTING_LIMITS.readingMinutes.max, Math.max(EXAM_SETTING_LIMITS.readingMinutes.min, Math.round(Number(event.target.value) || 0))) })} />
            </label>
            <label>{ui("每分用时（分钟）")}
              <input type="number" min={EXAM_SETTING_LIMITS.minutesPerMark.min} max={EXAM_SETTING_LIMITS.minutesPerMark.max} step="any" value={settings.minutesPerMark}
                onChange={(event) => setSettings({ ...settings, minutesPerMark: Math.min(EXAM_SETTING_LIMITS.minutesPerMark.max, Math.max(EXAM_SETTING_LIMITS.minutesPerMark.min, Number(event.target.value) || DEFAULT_MINUTES_PER_MARK)) })} />
            </label>
          </div>
          {examFormatName && <small className="es-hint">{uiFormat("来自课程「{0}」的考试设置：{1}（可在课程设置里修改）", [course, examFormatName])}</small>}
          <label className="es-check">
            <input type="checkbox" checked={settings.handwriting} onChange={(event) => setSettings({ ...settings, handwriting: event.target.checked })} />
            <span><strong>{ui("纸笔练习模式")}</strong><small>{ui("计时阶段隐藏输入框，你在纸上写；时间到后再录入要点批改，录入时间不计时。")}</small></span>
          </label>
        </div>}
        {!model.ready && <div className="es-gate"><ModelSetupGate variant="block" feature="grade" model={model} onOpenSettings={onSetupModel} /></div>}
      </ExamSetupCard>
      {recent}
      {error && <InlineMessage>{error}</InlineMessage>}
    </section>
  );
}

/* ---------- checking a case draft ---------- */

/** The top of a case draft: its scenario, marks and hidden cues, so the learner can check the paper before publishing. */
export function CaseDraftHeader({ draft, data }) {
  useInjectCss(css, "study-case-workspace");
  const source = (data?.sources || []).find((item) => item.id === draft.case?.sourceId);
  const marks = draft.cards.reduce((sum, card) => sum + (Number(card.marks) || 0), 0);
  return (
    <Panel className="case-draft" title={ui("案例分析题组")}
      description={uiFormat("{0} 道题 · 共 {1} 分 · 建议作答约 {2} 分钟", [draft.cards.length, marks, Math.round(marks * DEFAULT_MINUTES_PER_MARK)])}>
      {source ? <ScenarioPanel title={source.title} text={source.text} readOnly className="case-draft__scenario" />
        : <p className="muted">{ui("案例原文会在保存草稿时存为一份资料。")}</p>}
      {draft.case?.cues?.length > 0 && <Disclosure summary={uiFormat("隐藏线索 · {0} 条（会剧透）", [draft.case.cues.length])}>
        <ul className="case-draft__cues">{draft.case.cues.map((cue) => <li key={cue.id}><q>{cue.quote}</q><span>{cue.implies}</span></li>)}</ul>
      </Disclosure>}
    </Panel>
  );
}

/** Rubric criteria of one question; the question's marks follow their sum and the plain rubric text is rewritten. */
export function CriteriaEditor({ criteria = [], onChange, disabled }) {
  useInjectCss(css, "study-case-workspace");
  const total = criteria.reduce((sum, criterion) => sum + (Number(criterion.marks) || 0), 0);
  const set = (index, patch) => onChange(criteria.map((criterion, at) => at === index ? { ...criterion, ...patch } : criterion));
  return (
    <fieldset className="criteria-editor" disabled={disabled}>
      <legend>{uiFormat("评分标准 · 共 {0} 分", [total])}</legend>
      {criteria.map((criterion, index) => (
        <div key={criterion.id || index} className="criteria-editor__row">
          <label>{ui("评分项")}<input value={criterion.label} onChange={(event) => set(index, { label: event.target.value })} /></label>
          <label>{ui("分值")}<input type="number" min={0.5} step={0.5} value={criterion.marks}
            onChange={(event) => set(index, { marks: Math.max(0.5, Number(event.target.value) || 0.5) })} /></label>
          <label className="criteria-editor__wide">{ui("得分要求")}<textarea rows={2} value={criterion.descriptor}
            onChange={(event) => set(index, { descriptor: event.target.value })} /></label>
          <label className="criteria-editor__wide">{ui("要点（每行一条）")}<textarea rows={2} value={(criterion.keyPoints || []).join("\n")}
            onChange={(event) => set(index, { keyPoints: event.target.value.split("\n").map((point) => point.trim()).filter(Boolean) })} /></label>
          {criteria.length > 1 && <Button size="sm" variant="quiet" onClick={() => onChange(criteria.filter((_, at) => at !== index))}>{ui("删除这一项")}</Button>}
        </div>
      ))}
      <Button size="sm" variant="link" icon="plus" onClick={() => onChange([...criteria, { id: `c${Date.now().toString(36)}`, label: "", marks: 1, descriptor: "", keyPoints: [] }])}>
        {ui("添加评分项")}</Button>
    </fieldset>
  );
}
