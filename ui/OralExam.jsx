import { ui, uiFormat } from "./i18n.js";
import React from "react";
import Markdown from "./Markdown.jsx";
import css from "./oral-exam.css";
import resultCss from "./review-results.css";
import examCss from "./exam.css";
import { useInjectCss } from "./shared.js";
import { decksInCourse } from './PageScope.jsx';
import { draftKey, readDraft, writeDraft, clearDraft } from './writing-drafts.js';
import { Badge, Button, ErrorState, Hint, Icon, LoadingState, PageHeader, Panel, StackedBar } from './components/index.js';
import ModelSetupGate from './ModelSetupGate.jsx';
import { ExamSetupCard, CountField } from './ExamShell.jsx';
import { modelReadiness } from './generation-status.js';
import { useExamRun } from './exam/useExamRun.js';
import { useStudy } from './study-context.jsx';
import VoiceButton from './voice/VoiceButton.jsx';
import { useVoiceInput } from './voice/useVoiceInput.js';
import CorrectionCard from './review/CorrectionCard.jsx';
import SubmitBlanksDialog from './SubmitBlanksDialog.jsx';

/* 口头面试：lifecycle (restore, submit, report) in ui/exam/useExamRun.js; this file keeps the answering UI and the
   answer drafts the browser holds while the learner types. */

const bandName = { strong: "回答扎实", developing: "有待补充", weak: "需要巩固" };
const bandTone = { strong: "success", developing: "warning", weak: "error" };
const FIELDS = ['answer', 'followupAnswer'];
const ORAL_DRAFT_DEBOUNCE_MS = 500;

export default function OralExam({ data, onExit, onStartRun, initialRunId, onLocation, header, recent, onSetupModel, course = '*', selection = { course } }) {
  useInjectCss(css, "study-oral-exam");
  useInjectCss(resultCss, "review-results");
  useInjectCss(examCss, "study-exam");
  const { call } = useStudy();
  const exam = useExamRun({ kind: 'oral', call, initialRunId, onLocation, tick: false });
  const { run, report, busy, error, loading } = exam;
  const [count, setCount] = React.useState(5);
  const [answer, setAnswer] = React.useState("");
  const [followupAnswer, setFollowupAnswer] = React.useState("");
  const [confirmSubmitOpen, setConfirmSubmitOpen] = React.useState(false);
  const [weakOnly, setWeakOnly] = React.useState(false);
  const current = React.useRef({ run: null, answer: '', followupAnswer: '' });
  const draftTimers = React.useRef({});
  const pendingDrafts = React.useRef(new Map());
  const { setError } = exam;
  const flushDraft = React.useCallback((key) => {
    const flushOne = (k) => {
      if (draftTimers.current[k]) {
        clearTimeout(draftTimers.current[k]);
        delete draftTimers.current[k];
      }
      if (!pendingDrafts.current.has(k)) return;
      const value = pendingDrafts.current.get(k);
      pendingDrafts.current.delete(k);
      try { writeDraft(k, value); }
      catch { setError(ui('浏览器暂存不可用，请及时保存草稿。')); }
    };
    if (key !== undefined) { flushOne(key); return; }
    for (const k of [...pendingDrafts.current.keys()]) flushOne(k);
  }, [setError]);
  const cancelDrafts = React.useCallback(() => {
    for (const timer of Object.values(draftTimers.current)) clearTimeout(timer);
    draftTimers.current = {};
    pendingDrafts.current.clear();
  }, []);
  React.useEffect(() => {
    const onHide = () => flushDraft();
    window.addEventListener?.('pagehide', onHide);
    return () => {
      window.removeEventListener?.('pagehide', onHide);
      flushDraft();
    };
  }, [flushDraft]);
  React.useEffect(() => { setConfirmSubmitOpen(false); }, [run?.id]);
  React.useEffect(() => { setWeakOnly(false); }, [report?.runId]);
  const availableDecks = decksInCourse(data, course, selection.includeInactive === true).filter(deck => deck.available &&
    (!selection.scope || selection.scope.some(ref => ref.deckId === deck.id)));

  /** Put a run on screen with the answers the browser still holds for its question (else what the server saved). */
  function showRun(next) {
    flushDraft();
    const recovered = field => next?.entry
      ? readDraft(draftKey(data.root, 'oral', [next.id, next.entry.cardId, field]))?.value ?? next.entry[field] ?? '' : '';
    const answer = recovered('answer'), followupAnswer = recovered('followupAnswer');
    current.current = { run: next, answer, followupAnswer };
    setAnswer(answer);
    setFollowupAnswer(followupAnswer);
    exam.enter(next);
  }

  const forgetDrafts = (finished) => {
    cancelDrafts();
    for (const entry of finished.entries || []) for (const field of FIELDS) clearDraft(draftKey(data.root, 'oral', [finished.runId, entry.cardId, field]));
  };

  function editAnswer(field, value) {
    current.current = { ...current.current, [field]: value };
    (field === 'answer' ? setAnswer : setFollowupAnswer)(value);
    const active = current.current.run;
    if (!active?.entry) return;
    const key = draftKey(data.root, 'oral', [active.id, active.entry.cardId, field]);
    pendingDrafts.current.set(key, value);
    if (draftTimers.current[key]) clearTimeout(draftTimers.current[key]);
    draftTimers.current[key] = setTimeout(() => flushDraft(key), ORAL_DRAFT_DEBOUNCE_MS);
  }

  // Voice (#1031) is a way to fill the box: the text is appended for editing, then saved by oral.answer like typing.
  const spoken = (field) => (text) => { if (current.current.run?.entry) editAnswer(field, [current.current[field].trimEnd(), text].filter(Boolean).join('\n')); };
  // `scope`: the question on screen; what comes back after the next question opened is dropped, not appended to it.
  const voiceScope = run?.entry ? `${run.id}:${run.entry.cardId}` : '';
  const answerVoice = useVoiceInput({ call, scope: voiceScope, onText: spoken('answer') }), followupVoice = useVoiceInput({ call, scope: voiceScope, onText: spoken('followupAnswer') });

  React.useEffect(() => {
    exam.begin();
    void exam.restore({ ids: [initialRunId || ''],
      load: async () => {
        const active = await call(initialRunId ? 'oral.get' : 'oral.active', initialRunId ? { runId: initialRunId } : {});
        if (!active) return { stop: true };
        return active.submitted
          ? { phase: 'report', run: null, report: await call('oral.report', { runId: active.id }) }
          : { phase: 'running', run: active };
      },
      onFound: (found) => { if (found.phase === 'report') forgetDrafts(found.report); else showRun(found.run); } });
  }, [call, data.root, initialRunId]); // eslint-disable-line react-hooks/exhaustive-deps

  /** Send what is typed that the server does not have yet; resolves the run as the server now knows it. */
  async function saveAnswers() {
    flushDraft();
    const submitted = current.current, active = submitted.run;
    if (!active?.entry) return active;
    let next = active;
    for (const field of FIELDS) {
      if (field === 'followupAnswer' && !active.entry.followup) continue;
      const key = draftKey(data.root, 'oral', [active.id, active.entry.cardId, field]);
      const recovery = readDraft(key);
      if (submitted[field] !== active.entry[field]) next = await call('oral.answer', {
        runId: active.id, cardId: active.entry.cardId, field: field === 'answer' ? 'main' : 'followup', answer: submitted[field],
      });
      if (recovery) clearDraft(key, recovery.revision);
    }
    return next;
  }

  const [pendingAction, setPendingAction] = React.useState(null);
  const runAction = (kind, fn) => async () => {
    setPendingAction(kind);
    try { return await fn(); }
    finally { setPendingAction((currentKind) => (currentKind === kind ? null : currentKind)); }
  };
  const start = () => exam.perform(async alive => {
    const next = await call("oral.start", { ...selection, count: Number(count) });
    if (alive()) showRun(next);
  });
  const followup = runAction('followup', () => exam.perform(async alive => {
    const saved = await saveAnswers();
    if (!alive()) return;
    if (!saved.entry?.answer) throw new Error(ui("请先写下当前回答，再请求追问"));
    const next = await call('oral.followup', { runId: saved.id, cardId: saved.entry.cardId });
    if (alive()) showRun(next);
  }));
  const nextQuestion = runAction('next', () => exam.perform(async alive => {
    const saved = await saveAnswers();
    if (!alive()) return;
    const next = await call('oral.next', { runId: saved.id });
    if (alive()) showRun(next);
  }));
  const submit = runAction('submit', () => exam.submit({ before: saveAnswers, clearRun: true, after: forgetDrafts }));
  const reassess = runAction('assess', () => exam.perform(async alive => {
    if (!report?.runId) return;
    const next = await call("oral.assess", { runId: report.runId });
    if (alive()) exam.showReport(next);
  }));
  const practiceWeak = () => exam.perform(async alive => {
    const next = await call("review.start", { mode: "path", scope: report.weakScope, fresh: true });
    if (!alive()) return;
    if (onStartRun) onStartRun(next, { kind: 'oral', runId: report.runId });
    else onExit();
  });

  const heading = <PageHeader eyebrow={ui("岗位模拟")} title={ui("口头面试")} />;
  const scopeNote = selection.scope ? uiFormat('沿用勾选的 {0} 个题组', [selection.scope.length]) : "";
  const last = run && run.index >= run.total - 1;
  const currentHasAnswer = Boolean(answer.trim());
  const serverCurrentHasAnswer = Boolean(run?.entry?.answer?.trim());
  const effectiveAnswered = run ? run.answered + (currentHasAnswer ? 1 : 0) - (serverCurrentHasAnswer ? 1 : 0) : 0;
  const unansweredCount = run ? Math.max(0, run.total - effectiveAnswered) : 0;
  const requestEarlySubmit = () => {
    if (unansweredCount > 0) setConfirmSubmitOpen(true);
    else void submit();
  };
  const indexedEntries = report ? (report.entries || []).map((entry, index) => ({ entry, index })) : [];
  const needWorkEntries = indexedEntries.filter(({ entry }) => !entry.answer?.trim() || !entry.assessment || entry.assessment.band !== "strong");
  const canFilterWeak = report?.feedbackStatus === "assessed" && needWorkEntries.length > 0 && needWorkEntries.length < indexedEntries.length;
  const visibleEntries = canFilterWeak && weakOnly ? needWorkEntries : indexedEntries;
  const unassessedAnswered = report ? Math.max(0, (report.answered || 0) - (report.assessed || 0)) : 0;
  const allStrong = Boolean(report && report.feedbackStatus === "assessed" && report.total > 0 && report.strong === report.total && report.developing === 0 && report.weak === 0 && unassessedAnswered === 0);
  const allAssessedTopicsClear = Boolean(report && report.feedbackStatus === "assessed" && report.assessed > 0 && report.assessed === report.answered && !report.weakTopics?.length && report.weak === 0 && report.developing === 0);
  const onAnswerKeyDown = (event) => {
    if (event.nativeEvent?.isComposing || event.isComposing || event.keyCode === 229) return;
    if ((event.ctrlKey || event.metaKey) && event.key === "Enter" && !event.altKey) {
      if (event.shiftKey) {
        if (busy || run?.entry?.followup || !answer.trim()) return;
        event.preventDefault();
        void followup();
        return;
      }
      if (busy || (!answer.trim() && !followupAnswer.trim())) return;
      event.preventDefault();
      (last ? submit : nextQuestion)();
    }
  };
  return <section className="page exam oral-exam">
    {!loading && (run || report) ? heading : header || heading}
    {loading && <LoadingState label={ui("正在恢复口头模拟…")} />}
    {!loading && !run && !report && <>
      <OralSetup data={data} course={course} decks={availableDecks} selection={selection} count={count} onCount={setCount} onStart={start} busy={busy} canStart={availableDecks.length > 0}
        scopeNote={scopeNote} onSetupModel={onSetupModel} />
      {recent}
    </>}
    {run?.entry && !report && <>
      <div className="oral-progress"><span>{uiFormat("第 {0} / {1} 题", [run.index + 1, run.total])}</span><span>{uiFormat("本轮已回答 {0} 题", [effectiveAnswered])}</span></div>
      <Panel className="oral-question" tone="paper" data-exam-paper="">
        <Badge tone="info">{run.entry.topic}</Badge>
        <div className="oral-prompt"><Markdown text={run.entry.prompt} links={false} /></div>
        {run.entry.options?.length > 0 && <details><summary>{ui("查看题目选项")}</summary><ul>
          {run.entry.options.map((option) => <li key={option.id}><Markdown text={option.text} links={false} /></li>)}
        </ul></details>}
        <VoiceButton voice={answerVoice} />
        <label className="oral-answer-label">{ui("你的口述要点")}<textarea className="oral-answer-input" value={answer} disabled={busy} onChange={(event) => editAnswer('answer', event.target.value)} onBlur={() => flushDraft()} onKeyDown={onAnswerKeyDown} maxLength={8000}
            placeholder={ui("写下你刚才口头回答的要点；这里不会立即判分。")} />
        </label>
        {run.entry.followup && <div className="oral-followup">
          <strong>{ui("面试官追问")}</strong><p>{run.entry.followup}</p>
          <VoiceButton voice={followupVoice} />
          <label className="oral-answer-label">{ui("补充回答")}<textarea className="oral-answer-input" value={followupAnswer} disabled={busy} maxLength={8000} onChange={(event) => editAnswer('followupAnswer', event.target.value)} onBlur={() => flushDraft()} onKeyDown={onAnswerKeyDown}
              placeholder={ui("补充回答后继续下一题。")} />
          </label>
        </div>}
      </Panel>
      <div className="oral-actions">
        {!run.entry.followup && <Button disabled={!answer.trim()} busy={busy && pendingAction === 'followup'} busyLabel={ui("正在生成追问…")} lock={busy && pendingAction !== 'followup'} onClick={followup}>{ui("追问一次")}</Button>}
        {last
          ? <Button variant="primary" iconEnd="arrow-right" busy={busy && pendingAction === 'submit'} busyLabel={ui("正在集中评估…")} lock={busy && pendingAction !== 'submit'} onClick={submit}>{ui("结束模拟，查看反馈")}</Button>
          : <Button variant="primary" iconEnd="arrow-right" busy={busy && pendingAction === 'next'} lock={busy && pendingAction !== 'next'} onClick={nextQuestion}>{ui("保存并继续")}</Button>}
        {!last && <Button busy={busy && pendingAction === 'submit'} busyLabel={ui("正在集中评估…")} lock={busy && pendingAction !== 'submit'} onClick={requestEarlySubmit}>{ui("提前结束")}</Button>}
      </div>
      <p className="muted small">{ui("模拟过程中不会显示对错；回答在本地学习库保存。")}</p>
      {confirmSubmitOpen && (
        <SubmitBlanksDialog
          onConfirm={() => { setConfirmSubmitOpen(false); void submit(); }}
          onClose={() => setConfirmSubmitOpen(false)}>
          <p>{uiFormat("还有 {0} 题未作答，提前结束将立即完成本次口头模拟。", [unansweredCount])}</p>
        </SubmitBlanksDialog>
      )}
    </>}
    {report && <Panel className="oral-report" tone="paper" data-exam-paper="" data-all-strong={allStrong ? "true" : undefined}>
      <div className="result-kicker">{ui("口头模拟报告")}</div>
      {allStrong && <span className="oral-report__badge" data-testid="oral-all-strong">{ui("全部回答扎实")}</span>}
      <h2>{report.feedbackStatus === "assessed" ? uiFormat("{0} 题回答扎实", [report.strong]) : ui("回答已保存，尚未评估")}</h2>
      <p className="muted">{uiFormat("{0}/{1} 题已回答 · {2} 题已评估", [report.answered, report.total, report.assessed])}</p>
      {report.feedbackStatus === "assessed" ? <StackedBar size="lg" name={uiFormat("回答扎实 {0} 题，有待补充 {1} 题，需要巩固 {2} 题", [report.strong, report.developing, report.weak])}
        segments={[{ value: report.strong, tone: "success" }, { value: report.developing, tone: "warning" }, { value: report.weak, tone: "error" }]} /> : <p>{ui("当前没有可用的模型反馈；未据此更改复习进度。你仍可展开查看回答与参考答案。")}</p>}
      {report.feedbackStatus === "assessed" && <div className="oral-band-legend">
        <span data-tone="success">{uiFormat("回答扎实 {0}", [report.strong])}</span><span data-tone="warning">{uiFormat("有待补充 {0}", [report.developing])}</span><span data-tone="error">{uiFormat("需要巩固 {0}", [report.weak])}</span></div>}
      <div className="result-weak"><h3>{ui(allAssessedTopicsClear ? "全部考查主题均已过关" : "优先补的知识点")}</h3>
        {report.weakTopics?.length ? <ol>{report.weakTopics.map((topic) => <li key={topic.topic}>{topic.topic}</li>)}</ol>
          : allAssessedTopicsClear
            ? <p className="oral-report__clear">{ui("本轮已评估题目均回答扎实，可以直接开启下一轮或回到学习库。")}</p>
            : <p className="muted">{ui("本次没有已评估的薄弱主题。")}</p>}
        {!!report.weakScope?.length && <Button iconEnd="arrow-right" busy={busy} onClick={practiceWeak}>{ui("直接练这些题")}</Button>}
      </div>
      {report.assessmentError && <p className="oral-report__error" role="alert">{report.assessmentError}</p>}
      <div className="oral-actions">
        <Button icon="arrow-left" variant="primary" onClick={onExit}>{ui("回到学习库")}</Button>
        {unassessedAnswered > 0 && (
          <Button busy={busy && pendingAction === 'assess'} busyLabel={ui("正在评估…")} lock={busy && pendingAction !== 'assess'} onClick={reassess}>
            {report.assessed > 0 ? ui("补评估未评题目") : ui("重新评估")}
          </Button>
        )}
        <Button onClick={() => exam.leave()}>{ui("再来一轮")}</Button>
      </div>
      <details className="result-details"><summary>{ui("查看逐题反馈与原回答")}</summary>
        {canFilterWeak && (
          <div className="oral-report-toolbar">
            <Button variant="link" size="sm" aria-pressed={weakOnly} onClick={() => setWeakOnly((prev) => !prev)}>
              {weakOnly ? uiFormat("显示全部 {0} 题", [indexedEntries.length]) : uiFormat("只看需巩固 ({0})", [needWorkEntries.length])}
            </Button>
          </div>
        )}
        {visibleEntries.map(({ entry, index }) => {
          const veilExpected = Boolean(entry.expected && report.feedbackStatus === "assessed" && (!entry.answer?.trim() || (entry.assessment && entry.assessment.band !== "strong")));
          return <article key={`${entry.deckId}:${entry.cardId}`} className="oral-report-entry">
            <div className="oral-report-entry__head">
              <strong>{index + 1}. {entry.topic}</strong>
              <Badge size="sm" tone={entry.assessment ? bandTone[entry.assessment.band] : "neutral"}>
                {entry.assessment ? ui(bandName[entry.assessment.band]) : ui("未评估")}
              </Badge>
            </div>
            <Markdown text={entry.prompt} links={false} />
            <p>{ui("你的回答：")}{entry.answer || ui("未答")}</p>
            {entry.followup && <p>{ui("追问：")}{entry.followup}<br />{ui("补充回答：")}{entry.followupAnswer || ui("未答")}</p>}
            {entry.assessment?.reason && <p>{ui("反馈：")}{entry.assessment.reason}</p>}
            {entry.assessment?.correction && <CorrectionCard feedback={{ correction: entry.assessment.correction }} />}
            <div className="oral-report-expected">
              {veilExpected ? (
                <details className="oral-expected-veil">
                  <summary>{ui("先对照反馈想一想 · 展开参考答案")}</summary>
                  <Markdown text={entry.expected} links={false} />
                </details>
              ) : (
                <>
                  <span>{ui("参考答案：")}</span>
                  {entry.expected ? <Markdown text={entry.expected} links={false} /> : <span>{ui("本题无参考答案")}</span>}
                </>
              )}
            </div>
          </article>;
        })}
      </details>
    </Panel>}
    {error && <ErrorState error={error} />}
  </section>;
}

/** The oral interview's setup card: how it works, how many questions, what is sent to the model. */
export function OralSetup({ data, course, decks, selection, count, onCount, onStart, busy = false, canStart = true, scopeNote = "", onSetupModel }) {
  useInjectCss(css, "study-oral-exam");
  const model = modelReadiness(data);
  const targetCourse = typeof course === 'string' && course !== '*'
    ? course
    : course === '*'
      ? (() => {
        const selected = Array.isArray(decks)
          ? decks
          : decksInCourse(data, '*', selection?.includeInactive === true).filter((deck) =>
            (deck.available !== undefined ? deck.available > 0 : (deck.cards ? deck.cards.length > 0 : true)) &&
            (!selection?.scope || selection.scope.some((ref) => ref.deckId === deck.id)));
        const uniqueCourses = new Set(selected.map((deck) => (deck?.course ?? deck?.folder ?? '') || ''));
        return uniqueCourses.size === 1 ? [...uniqueCourses][0] : '';
      })()
      : (data?.focus?.course || '');
  const role = (targetCourse ? (data?.courses || []).find((item) => item.name === targetCourse)?.interview?.role : '') || '';
  return <ExamSetupCard data-tour="exam-start" title={role || ui("口头面试")}
    intro={ui("像面试官当面提问：你回答，可以被追问，整场结束后一次性给出反馈。")}
    steps={[
      ui("屏幕上会出现一道题，像面试官当面提问；题目来自你选的学习库范围。"),
      ui("按「语音作答」说出回答，转成文字放进输入框，改好再保存；也可以直接打字。录音转成文字后立刻删除。"),
      ui("想被追问就点「追问一次」，每道题最多追问一次。"),
      ui("点「保存并继续」进入下一题；回答保存在本地学习库。"),
      ui("整场结束后一次性给出每题反馈，中途不显示对错。"),
    ]}
    summary={uiFormat("{0} 题 · 约 {1}–{2} 分钟 · 结束后看反馈", [count, count * 2, count * 3])}
    action={<Button iconEnd="arrow-right" variant="primary" busy={busy} disabled={!canStart} onClick={onStart}>{busy ? ui("正在准备…") : ui("开始口头模拟")}</Button>}>
    <CountField value={count} presets={[3, 5, 8]} min={1} max={10} onChange={onCount}
      hint={ui("1–10 题 · 每个主题先出一题，薄弱和没考过的主题优先。")} />
    {scopeNote && <p className="es-hint">{scopeNote}</p>}
    {!canStart && <p className="es-warning">{ui("学习库里还没有可用于口头模拟的题；先出题再来。")}</p>}
    <p className="es-note"><Icon className="sh-icon--inline" name="info" /><span>{ui("发给 AI 模型的内容：追问时是当前题目和你的回答；结束评估时是题目、参考答案和你的全部回答。学习库的其他内容不会发送。")}</span></p>
    <ModelSetupGate variant="inline" feature="grade" model={model} onOpenSettings={onSetupModel} />
    {!model.ready && <Hint>{ui("没有模型时：追问会用固定问题，结束后只保存回答、不评估。")}</Hint>}
  </ExamSetupCard>;
}
