import { ui, uiFormat, uiLocale } from "./i18n.js";
import React from "react";
import Markdown from "./Markdown.jsx";
import css from "./oral-exam.css";
import { useInjectCss } from "./shared.js";
import PageScope, { decksInCourse } from './PageScope.jsx';
import { draftKey, readDraft, writeDraft, clearDraft } from './writing-drafts.js';

const bandName = { strong: "回答扎实", developing: "有待补充", weak: "需要巩固" };

export default function OralExam({ call, data, onWritten, onExit, onStartRun, initialRunId, onLocation, course = '*', onCourseChange, selection = { course } }) {
  useInjectCss(css, "study-oral-exam");
  const [run, setRun] = React.useState(null);
  const [report, setReport] = React.useState(null);
  const [count, setCount] = React.useState(5);
  const [answer, setAnswer] = React.useState("");
  const [followupAnswer, setFollowupAnswer] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState("");
  const [loading, setLoading] = React.useState(true);
  const identity = React.useRef(null), pending = React.useRef(false);
  const current = React.useRef({ run: null, answer: '', followupAnswer: '' });
  const availableDecks = decksInCourse(data, course).filter(deck => deck.available &&
    (!selection.scope || selection.scope.some(ref => ref.deckId === deck.id)));

  function showRun(next) {
    if (!identity.current) return;
    const recovered = field => next?.entry
      ? readDraft(draftKey(data.root, 'oral', [next.id, next.entry.cardId, field]))?.value ?? next.entry[field] ?? '' : '';
    const answer = recovered('answer'), followupAnswer = recovered('followupAnswer');
    current.current = { run: next, answer, followupAnswer };
    setRun(next);
    setAnswer(answer);
    setFollowupAnswer(followupAnswer);
    if (next) onLocation?.({ kind: 'oral', runId: next.id });
  }

  function showReport(next) {
    setReport(next); setRun(null);
    for (const entry of next.entries || []) for (const field of ['answer', 'followupAnswer'])
      clearDraft(draftKey(data.root, 'oral', [next.runId, entry.cardId, field]));
    onLocation?.({ kind: 'oral', runId: next.runId });
  }

  function editAnswer(field, value) {
    current.current = { ...current.current, [field]: value };
    (field === 'answer' ? setAnswer : setFollowupAnswer)(value);
    const active = current.current.run;
    try { writeDraft(draftKey(data.root, 'oral', [active.id, active.entry.cardId, field]), value); }
    catch { setError(ui('浏览器暂存不可用，请及时保存草稿。')); }
  }

  React.useEffect(() => {
    const token = {};
    identity.current = token;
    const live = () => identity.current === token;
    setLoading(true);
    (async () => {
      const active = await call(initialRunId ? 'oral.get' : 'oral.active', initialRunId ? { runId: initialRunId } : {});
      if (!live() || !active) return;
      if (active.submitted) {
        const result = await call('oral.report', { runId: active.id });
        if (live()) showReport(result);
      } else showRun(active);
    })().catch(cause => { if (live()) setError(cause.message || String(cause)); })
      .finally(() => { if (live()) setLoading(false); });
    return () => { if (live()) identity.current = null; };
  }, [call, data.root, initialRunId]); // eslint-disable-line react-hooks/exhaustive-deps

  async function perform(work) {
    if (pending.current) return;
    const token = identity.current, live = () => identity.current === token;
    pending.current = true;
    setBusy(true);
    setError("");
    try { await work(live); }
    catch (cause) { if (live()) setError(cause.message || String(cause)); }
    finally { if (live()) { pending.current = false; setBusy(false); } }
  }

  async function saveAnswers() {
    const token = identity.current;
    const submitted = current.current, active = submitted.run;
    if (!active?.entry) return active;
    let next = active;
    for (const field of ['answer', 'followupAnswer']) {
      if (identity.current !== token) return next;
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

  const start = () => perform(async live => {
    const next = await call("oral.start", { ...selection, count: Number(count) });
    if (live()) showRun(next);
  });
  const followup = () => perform(async live => {
    const current = await saveAnswers();
    if (!live()) return;
    if (!current.entry?.answer) throw new Error(ui("请先写下当前回答，再请求追问"));
    const next = await call('oral.followup', { runId: current.id, cardId: current.entry.cardId });
    if (live()) showRun(next);
  });
  const nextQuestion = () => perform(async live => {
    const current = await saveAnswers();
    if (!live()) return;
    const next = await call('oral.next', { runId: current.id });
    if (live()) showRun(next);
  });
  const submit = () => perform(async live => {
    const current = await saveAnswers();
    if (!live()) return;
    const result = await call("oral.submit", { runId: current.id });
    if (live()) showReport(result);
  });
  const openReport = (runId) => perform(async live => {
    const next = await call('oral.report', { runId });
    if (live()) showReport(next);
  });
  const practiceWeak = () => perform(async live => {
    const next = await call("review.start", { mode: "path", scope: report.weakScope, fresh: true });
    if (!live()) return;
    if (onStartRun) onStartRun(next, { kind: 'oral', runId: report.runId });
    else onExit();
  });

  return <section className="page exam oral-exam">
    <div className="oral-heading">
      <div><div className="eyebrow">{ui("岗位模拟")}</div><h1 tabIndex={-1} data-context-heading>{ui("口头面试")}</h1></div>
      <button type="button" onClick={onWritten}>{ui("切换到限时笔试")}</button>
    </div>
    {loading && <p className="muted">{ui("正在恢复口头模拟…")}</p>}
    {!loading && !run && !report && <>
      <PageScope courses={data?.focus?.courses} value={course} onChange={onCourseChange} />
      {selection.scope && <p className="muted">{uiFormat('沿用勾选的 {0} 个题组', [selection.scope.length])}</p>}
      <div className="oral-intro">
        <h2>{data?.focus?.mode === 'interview' && data.focus.role || ui("从学习库练习口头表达")}</h2>
        <p>{ui('覆盖所选范围的主要知识点，并适度加入薄弱题。')}{ui("你可以按需请求追问；整场结束后才显示反馈。")}</p>
        <label>{ui("本轮题数")}<input type="number" min="1" max="10" value={count} onChange={(event) => setCount(event.target.value)} />
        </label>
        <button className="primary" disabled={busy || !availableDecks.length} onClick={start}>
          {busy ? ui("正在准备…") : ui("开始口头模拟")}
        </button>
      </div>
      {data?.oralExams?.length > 0 && <div className="oral-history">
        <h2>{ui("最近口头模拟")}</h2>
        {data.oralExams.map((item) => <button key={item.runId} disabled={busy} onClick={() => openReport(item.runId)}>
          {new Date(item.submittedAt).toLocaleString(uiLocale())} · {item.total}{ui(" 题 · ")}{item.assessed ? uiFormat("{0} 题回答扎实", [item.strong]) : ui("尚未评估")}
        </button>)}
      </div>}
    </>}
    {run?.entry && !report && <>
      <div className="oral-progress"><span>{ui("第 ")}{run.index + 1} / {run.total}{ui(" 题")}</span><span>{ui("本轮已回答 ")}{run.answered}{ui(" 题")}</span></div>
      <div className="oral-question">
        <span className="exam-chip">{run.entry.topic}</span>
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
      </div>
      <div className="oral-actions">
        {!run.entry.followup && <button disabled={busy || !answer.trim()} onClick={followup}>{ui("追问一次")}</button>}
        {run.index < run.total - 1
          ? <button className="primary" disabled={busy} onClick={nextQuestion}>{ui("保存并继续 →")}</button>
          : <button className="primary" disabled={busy} onClick={submit}>{busy ? ui("正在集中评估…") : ui("结束模拟，查看反馈 →")}</button>}
        {run.index < run.total - 1 && <button disabled={busy} onClick={submit}>{ui("提前结束")}</button>}
      </div>
      <p className="muted small">{ui("模拟过程中不会显示对错；回答在本地学习库保存。")}</p>
    </>}
    {report && <div className="oral-report">
      <div className="result-kicker">{ui("口头模拟报告")}</div>
      <h2>{report.feedbackStatus === "assessed" ? uiFormat("{0} 题回答扎实", [report.strong]) : ui("回答已保存，尚未评估")}</h2>
      <p className="muted">{report.answered}/{report.total}{ui(" 题已回答 · ")}{report.assessed}{ui(" 题已评估")}</p>
      {report.feedbackStatus === "assessed" ? <div className="oral-band-bar" role="img"
        aria-label={uiFormat("回答扎实 {0} 题，有待补充 {1} 题，需要巩固 {2} 题", [report.strong, report.developing, report.weak])}>
        {!!report.strong && <span className="strong" style={{ flexGrow: report.strong }} />}
        {!!report.developing && <span className="developing" style={{ flexGrow: report.developing }} />}
        {!!report.weak && <span className="weak" style={{ flexGrow: report.weak }} />}
      </div> : <p>{ui("当前没有可用的模型反馈；未据此更改复习进度。你仍可展开查看回答与参考答案。")}</p>}
      {report.feedbackStatus === "assessed" && <div className="oral-band-legend"><span>{ui("回答扎实 ")}{report.strong}</span><span>{ui("有待补充 ")}{report.developing}</span><span>{ui("需要巩固 ")}{report.weak}</span></div>}
      <div className="result-weak"><h3>{ui("优先补的知识点")}</h3>
        {report.weakTopics?.length ? <ol>{report.weakTopics.map((topic) => <li key={topic.topic}>{topic.topic}</li>)}</ol>
          : <p className="muted">{ui("本次没有已评估的薄弱主题。")}</p>}
        {!!report.weakScope?.length && <button disabled={busy} onClick={practiceWeak}>{ui("直接练这些题 →")}</button>}
      </div>
      <div className="oral-actions"><button className="primary" onClick={onExit}>{ui("回到学习库")}</button>
        <button onClick={() => setReport(null)}>{ui("再来一轮")}</button></div>
      <details className="result-details"><summary>{ui("查看逐题反馈与原回答")}</summary>
        {report.entries.map((entry, index) => <article key={`${entry.deckId}:${entry.cardId}`} className="oral-report-entry">
          <strong>{index + 1}. {entry.topic} · {entry.assessment ? bandName[entry.assessment.band] : ui("未评估")}</strong>
          <Markdown text={entry.prompt} links={false} />
          <p>{ui("你的回答：")}{entry.answer || ui("未答")}</p>
          {entry.followup && <p>{ui("追问：")}{entry.followup}<br />{ui("补充回答：")}{entry.followupAnswer || ui("未答")}</p>}
          {entry.assessment?.reason && <p>{ui("反馈：")}{entry.assessment.reason}</p>}
          <p>{ui("参考答案：")}{entry.expected || ui("本题无参考答案")}</p>
        </article>)}
      </details>
    </div>}
    {error && <p className="exam-error" role="alert">{error}</p>}
  </section>;
}
