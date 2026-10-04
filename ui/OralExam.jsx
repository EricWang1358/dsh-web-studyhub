import { ui, uiFormat } from "./i18n.js";
import React from "react";
import Markdown from "./Markdown.jsx";
import css from "./oral-exam.css";
import { useInjectCss } from "./shared.js";
import { decksInCourse } from './PageScope.jsx';
import { draftKey, readDraft, writeDraft, clearDraft } from './writing-drafts.js';
import { Badge, Button, ErrorState, Hint, Icon, PageHeader, Panel } from './components/index.js';
import ModelSetupGate from './ModelSetupGate.jsx';
import { ExamSetupCard, CountField } from './ExamShell.jsx';
import { modelReadiness } from './generation-status.js';
import { useExamRun } from './exam/useExamRun.js';
import { useStudy } from './study-context.jsx';

/* 口头面试：lifecycle (restore, submit, report) in ui/exam/useExamRun.js; this file keeps the answering UI and the
   answer drafts the browser holds while the learner types. */

const bandName = { strong: "回答扎实", developing: "有待补充", weak: "需要巩固" };
const FIELDS = ['answer', 'followupAnswer'];

export default function OralExam({ data, onExit, onStartRun, initialRunId, onLocation, header, recent, onSetupModel, course = '*', selection = { course } }) {
  useInjectCss(css, "study-oral-exam");
  const { call } = useStudy();
  const exam = useExamRun({ kind: 'oral', call, initialRunId, onLocation });
  const { run, report, busy, error, loading } = exam;
  const [count, setCount] = React.useState(5);
  const [answer, setAnswer] = React.useState("");
  const [followupAnswer, setFollowupAnswer] = React.useState("");
  const current = React.useRef({ run: null, answer: '', followupAnswer: '' });
  const availableDecks = decksInCourse(data, course, selection.includeInactive === true).filter(deck => deck.available &&
    (!selection.scope || selection.scope.some(ref => ref.deckId === deck.id)));

  /** Put a run on screen with the answers the browser still holds for its question (else what the server saved). */
  function showRun(next) {
    const recovered = field => next?.entry
      ? readDraft(draftKey(data.root, 'oral', [next.id, next.entry.cardId, field]))?.value ?? next.entry[field] ?? '' : '';
    const answer = recovered('answer'), followupAnswer = recovered('followupAnswer');
    current.current = { run: next, answer, followupAnswer };
    setAnswer(answer);
    setFollowupAnswer(followupAnswer);
    exam.enter(next);
  }

  const forgetDrafts = (finished) => {
    for (const entry of finished.entries || []) for (const field of FIELDS) clearDraft(draftKey(data.root, 'oral', [finished.runId, entry.cardId, field]));
  };

  function editAnswer(field, value) {
    current.current = { ...current.current, [field]: value };
    (field === 'answer' ? setAnswer : setFollowupAnswer)(value);
    const active = current.current.run;
    try { writeDraft(draftKey(data.root, 'oral', [active.id, active.entry.cardId, field]), value); }
    catch { exam.setError(ui('浏览器暂存不可用，请及时保存草稿。')); }
  }

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

  const start = () => exam.perform(async alive => {
    const next = await call("oral.start", { ...selection, count: Number(count) });
    if (alive()) showRun(next);
  });
  const followup = () => exam.perform(async alive => {
    const saved = await saveAnswers();
    if (!alive()) return;
    if (!saved.entry?.answer) throw new Error(ui("请先写下当前回答，再请求追问"));
    const next = await call('oral.followup', { runId: saved.id, cardId: saved.entry.cardId });
    if (alive()) showRun(next);
  });
  const nextQuestion = () => exam.perform(async alive => {
    const saved = await saveAnswers();
    if (!alive()) return;
    const next = await call('oral.next', { runId: saved.id });
    if (alive()) showRun(next);
  });
  const submit = () => exam.submit({ before: saveAnswers, clearRun: true, after: forgetDrafts });
  const practiceWeak = () => exam.perform(async alive => {
    const next = await call("review.start", { mode: "path", scope: report.weakScope, fresh: true });
    if (!alive()) return;
    if (onStartRun) onStartRun(next, { kind: 'oral', runId: report.runId });
    else onExit();
  });

  const heading = <PageHeader eyebrow={ui("岗位模拟")} title={ui("口头面试")} />;
  const scopeNote = selection.scope ? uiFormat('沿用勾选的 {0} 个题组', [selection.scope.length]) : "";
  const last = run && run.index >= run.total - 1;
  return <section className="page exam oral-exam">
    {!loading && (run || report) ? heading : header || heading}
    {loading && <p className="muted">{ui("正在恢复口头模拟…")}</p>}
    {!loading && !run && !report && <>
      <OralSetup data={data} count={count} onCount={setCount} onStart={start} busy={busy} canStart={availableDecks.length > 0}
        scopeNote={scopeNote} onSetupModel={onSetupModel} />
      {recent}
    </>}
    {run?.entry && !report && <>
      <div className="oral-progress"><span>{uiFormat("第 {0} / {1} 题", [run.index + 1, run.total])}</span><span>{uiFormat("本轮已回答 {0} 题", [run.answered])}</span></div>
      <Panel className="oral-question">
        <Badge tone="info">{run.entry.topic}</Badge>
        <div className="oral-prompt"><Markdown text={run.entry.prompt} links={false} /></div>
        {run.entry.options?.length > 0 && <details><summary>{ui("查看题目选项")}</summary><ul>
          {run.entry.options.map((option) => <li key={option.id}><Markdown text={option.text} links={false} /></li>)}
        </ul></details>}
        <label className="oral-answer-label">{ui("你的口述要点")}<textarea value={answer} disabled={busy} onChange={(event) => editAnswer('answer', event.target.value)} maxLength={8000}
            placeholder={ui("写下你刚才口头回答的要点；这里不会立即判分。")} />
        </label>
        {run.entry.followup && <div className="oral-followup">
          <strong>{ui("面试官追问")}</strong><p>{run.entry.followup}</p>
          <label className="oral-answer-label">{ui("补充回答")}<textarea value={followupAnswer} disabled={busy} maxLength={8000} onChange={(event) => editAnswer('followupAnswer', event.target.value)}
              placeholder={ui("补充回答后继续下一题。")} />
          </label>
        </div>}
      </Panel>
      <div className="oral-actions">
        {!run.entry.followup && <Button disabled={busy || !answer.trim()} onClick={followup}>{ui("追问一次")}</Button>}
        {last
          ? <Button variant="primary" busy={busy} onClick={submit}>{busy ? ui("正在集中评估…") : ui("结束模拟，查看反馈 →")}</Button>
          : <Button variant="primary" disabled={busy} onClick={nextQuestion}>{ui("保存并继续 →")}</Button>}
        {!last && <Button disabled={busy} onClick={submit}>{ui("提前结束")}</Button>}
      </div>
      <p className="muted small">{ui("模拟过程中不会显示对错；回答在本地学习库保存。")}</p>
    </>}
    {report && <Panel className="oral-report">
      <div className="result-kicker">{ui("口头模拟报告")}</div>
      <h2>{report.feedbackStatus === "assessed" ? uiFormat("{0} 题回答扎实", [report.strong]) : ui("回答已保存，尚未评估")}</h2>
      <p className="muted">{uiFormat("{0}/{1} 题已回答 · {2} 题已评估", [report.answered, report.total, report.assessed])}</p>
      {report.feedbackStatus === "assessed" ? <div className="oral-band-bar" role="img"
        aria-label={uiFormat("回答扎实 {0} 题，有待补充 {1} 题，需要巩固 {2} 题", [report.strong, report.developing, report.weak])}>
        {!!report.strong && <span className="strong" style={{ flexGrow: report.strong }} />}
        {!!report.developing && <span className="developing" style={{ flexGrow: report.developing }} />}
        {!!report.weak && <span className="weak" style={{ flexGrow: report.weak }} />}
      </div> : <p>{ui("当前没有可用的模型反馈；未据此更改复习进度。你仍可展开查看回答与参考答案。")}</p>}
      {report.feedbackStatus === "assessed" && <div className="oral-band-legend">
        <span>{uiFormat("回答扎实 {0}", [report.strong])}</span><span>{uiFormat("有待补充 {0}", [report.developing])}</span><span>{uiFormat("需要巩固 {0}", [report.weak])}</span></div>}
      <div className="result-weak"><h3>{ui("优先补的知识点")}</h3>
        {report.weakTopics?.length ? <ol>{report.weakTopics.map((topic) => <li key={topic.topic}>{topic.topic}</li>)}</ol>
          : <p className="muted">{ui("本次没有已评估的薄弱主题。")}</p>}
        {!!report.weakScope?.length && <Button busy={busy} onClick={practiceWeak}>{ui("直接练这些题 →")}</Button>}
      </div>
      <div className="oral-actions"><Button variant="primary" onClick={onExit}>{ui("回到学习库")}</Button>
        <Button onClick={() => exam.leave()}>{ui("再来一轮")}</Button></div>
      <details className="result-details"><summary>{ui("查看逐题反馈与原回答")}</summary>
        {report.entries.map((entry, index) => <article key={`${entry.deckId}:${entry.cardId}`} className="oral-report-entry">
          <strong>{index + 1}. {entry.topic} · {entry.assessment ? ui(bandName[entry.assessment.band]) : ui("未评估")}</strong>
          <Markdown text={entry.prompt} links={false} />
          <p>{ui("你的回答：")}{entry.answer || ui("未答")}</p>
          {entry.followup && <p>{ui("追问：")}{entry.followup}<br />{ui("补充回答：")}{entry.followupAnswer || ui("未答")}</p>}
          {entry.assessment?.reason && <p>{ui("反馈：")}{entry.assessment.reason}</p>}
          <p>{ui("参考答案：")}{entry.expected || ui("本题无参考答案")}</p>
        </article>)}
      </details>
    </Panel>}
    {error && <ErrorState error={error} />}
  </section>;
}

/** The oral interview's setup card: how it works, how many questions, what is sent to the model. */
export function OralSetup({ data, count, onCount, onStart, busy = false, canStart = true, scopeNote = "", onSetupModel }) {
  useInjectCss(css, "study-oral-exam");
  const model = modelReadiness(data);
  const role = data?.focus?.mode === 'interview' && data.focus.role;
  return <ExamSetupCard data-tour="exam-start" title={role || ui("口头面试")}
    intro={ui("像面试官当面提问：你回答，可以被追问，整场结束后一次性给出反馈。")}
    steps={[
      ui("屏幕上会出现一道题，像面试官当面提问；题目来自你选的学习库范围。"),
      ui("把你口头回答的要点写在输入框里（目前是文字作答，没有语音输入）。"),
      ui("想被追问就点「追问一次」，每道题最多追问一次。"),
      ui("点「保存并继续」进入下一题；回答保存在本地学习库。"),
      ui("整场结束后一次性给出每题反馈，中途不显示对错。"),
    ]}
    summary={uiFormat("{0} 题 · 约 {1}–{2} 分钟 · 结束后看反馈", [count, count * 2, count * 3])}
    action={<Button variant="primary" busy={busy} disabled={!canStart} onClick={onStart}>{busy ? ui("正在准备…") : ui("开始口头模拟")}</Button>}>
    <CountField value={count} presets={[3, 5, 8]} min={1} max={10} onChange={onCount}
      hint={ui("1–10 题 · 每个主题先出一题，薄弱和没考过的主题优先。")} />
    {scopeNote && <p className="es-hint">{scopeNote}</p>}
    {!canStart && <p className="es-warning">{ui("学习库里还没有可用于口头模拟的题；先出题再来。")}</p>}
    <p className="es-note"><Icon name="info" size={16} /><span>{ui("发给 AI 模型的内容：追问时是当前题目和你的回答；结束评估时是题目、参考答案和你的全部回答。学习库的其他内容不会发送。")}</span></p>
    <ModelSetupGate variant="inline" feature="grade" model={model} onOpenSettings={onSetupModel} />
    {!model.ready && <Hint>{ui("没有模型时：追问会用固定问题，结束后只保存回答、不评估。")}</Hint>}
  </ExamSetupCard>;
}
