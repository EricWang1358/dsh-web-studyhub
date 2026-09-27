import React from "react";
import Markdown from "./Markdown.jsx";
import css from "./oral-exam.css";
import { useInjectCss } from "./shared.js";

const bandName = { strong: "回答扎实", developing: "有待补充", weak: "需要巩固" };

export default function OralExam({ call, data, onWritten, onExit, onStartRun }) {
  useInjectCss(css, "study-oral-exam");
  const [run, setRun] = React.useState(null);
  const [report, setReport] = React.useState(null);
  const [count, setCount] = React.useState(5);
  const [answer, setAnswer] = React.useState("");
  const [followupAnswer, setFollowupAnswer] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState("");
  const [loading, setLoading] = React.useState(true);

  function showRun(next) {
    setRun(next);
    setAnswer(next?.entry?.answer || "");
    setFollowupAnswer(next?.entry?.followupAnswer || "");
  }

  React.useEffect(() => {
    let live = true;
    call("oral.active").then((active) => { if (live && active) showRun(active); })
      .catch((cause) => { if (live) setError(cause.message || String(cause)); })
      .finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, [call]);

  async function perform(work) {
    if (busy) return;
    setBusy(true);
    setError("");
    try { await work(); }
    catch (cause) { setError(cause.message || String(cause)); }
    finally { setBusy(false); }
  }

  async function saveAnswers() {
    if (!run?.entry) return run;
    let next = run;
    if (answer !== run.entry.answer)
      next = await call("oral.answer", { runId: run.id, cardId: run.entry.cardId, answer });
    if (next.entry?.followup && followupAnswer !== next.entry.followupAnswer)
      next = await call("oral.answer", { runId: run.id, cardId: run.entry.cardId,
        field: "followup", answer: followupAnswer });
    showRun(next);
    return next;
  }

  const start = () => perform(async () => {
    const next = await call("oral.start", { count: Number(count) });
    showRun(next);
  });
  const followup = () => perform(async () => {
    const current = await saveAnswers();
    if (!current.entry?.answer) throw new Error("请先写下当前回答，再请求追问");
    showRun(await call("oral.followup", { runId: current.id, cardId: current.entry.cardId }));
  });
  const nextQuestion = () => perform(async () => {
    const current = await saveAnswers();
    showRun(await call("oral.next", { runId: current.id }));
  });
  const submit = () => perform(async () => {
    const current = await saveAnswers();
    const result = await call("oral.submit", { runId: current.id });
    setReport(result);
    setRun(null);
  });
  const openReport = (runId) => perform(async () => {
    setReport(await call("oral.report", { runId }));
    setRun(null);
  });
  const practiceWeak = () => perform(async () => {
    const next = await call("review.start", { mode: "path", scope: report.weakScope, fresh: true });
    if (onStartRun) onStartRun(next);
    else onExit();
  });

  return <section className="page exam oral-exam">
    <div className="oral-heading">
      <div><div className="eyebrow">岗位模拟</div><h1>口头面试</h1></div>
      <button type="button" onClick={onWritten}>切换到限时笔试</button>
    </div>
    {loading && <p className="muted">正在恢复口头模拟…</p>}
    {!loading && !run && !report && <>
      <div className="oral-intro">
        <h2>{data?.focus?.role || "从学习库练习口头表达"}</h2>
        <p>{data?.focus?.role ? "覆盖目标岗位的主要知识点，并适度加入薄弱题。" : "覆盖学习库中的主要知识点，并适度加入薄弱题。"}你可以按需请求追问；整场结束后才显示反馈。</p>
        <label>本轮题数
          <input type="number" min="1" max="10" value={count} onChange={(event) => setCount(event.target.value)} />
        </label>
        <button className="primary" disabled={busy || !data?.decks?.some((deck) => !deck.archived && deck.available)} onClick={start}>
          {busy ? "正在准备…" : "开始口头模拟"}
        </button>
      </div>
      {data?.oralExams?.length > 0 && <div className="oral-history">
        <h2>最近口头模拟</h2>
        {data.oralExams.map((item) => <button key={item.runId} disabled={busy} onClick={() => openReport(item.runId)}>
          {new Date(item.submittedAt).toLocaleString("zh-CN")} · {item.total} 题 · {item.assessed ? `${item.strong} 题回答扎实` : "尚未评估"}
        </button>)}
      </div>}
    </>}
    {run?.entry && !report && <>
      <div className="oral-progress"><span>第 {run.index + 1} / {run.total} 题</span><span>本轮已回答 {run.answered} 题</span></div>
      <div className="oral-question">
        <span className="exam-chip">{run.entry.topic}</span>
        <div className="oral-prompt"><Markdown text={run.entry.prompt} links={false} /></div>
        {run.entry.options?.length > 0 && <details><summary>查看题目选项</summary><ul>
          {run.entry.options.map((option) => <li key={option.id}><Markdown text={option.text} links={false} /></li>)}
        </ul></details>}
        <label className="oral-answer-label">你的口述要点
          <textarea value={answer} onChange={(event) => setAnswer(event.target.value)} maxLength={8000}
            placeholder="写下你刚才口头回答的要点；这里不会立即判分。" />
        </label>
        {run.entry.followup && <div className="oral-followup">
          <strong>面试官追问</strong><p>{run.entry.followup}</p>
          <label className="oral-answer-label">补充回答
            <textarea value={followupAnswer} maxLength={8000} onChange={(event) => setFollowupAnswer(event.target.value)}
              placeholder="补充回答后继续下一题。" />
          </label>
        </div>}
      </div>
      <div className="oral-actions">
        {!run.entry.followup && <button disabled={busy || !answer.trim()} onClick={followup}>追问一次</button>}
        {run.index < run.total - 1
          ? <button className="primary" disabled={busy} onClick={nextQuestion}>保存并继续 →</button>
          : <button className="primary" disabled={busy} onClick={submit}>{busy ? "正在集中评估…" : "结束模拟，查看反馈 →"}</button>}
        {run.index < run.total - 1 && <button disabled={busy} onClick={submit}>提前结束</button>}
      </div>
      <p className="muted small">模拟过程中不会显示对错；回答在本地学习库保存。</p>
    </>}
    {report && <div className="oral-report">
      <div className="result-kicker">口头模拟报告</div>
      <h2>{report.feedbackStatus === "assessed" ? `${report.strong} 题回答扎实` : "回答已保存，尚未评估"}</h2>
      <p className="muted">{report.answered}/{report.total} 题已回答 · {report.assessed} 题已评估</p>
      {report.feedbackStatus === "assessed" ? <div className="oral-band-bar" role="img"
        aria-label={`回答扎实 ${report.strong} 题，有待补充 ${report.developing} 题，需要巩固 ${report.weak} 题`}>
        {!!report.strong && <span className="strong" style={{ flexGrow: report.strong }} />}
        {!!report.developing && <span className="developing" style={{ flexGrow: report.developing }} />}
        {!!report.weak && <span className="weak" style={{ flexGrow: report.weak }} />}
      </div> : <p>当前没有可用的模型反馈；未据此更改复习进度。你仍可展开查看回答与参考答案。</p>}
      {report.feedbackStatus === "assessed" && <div className="oral-band-legend"><span>回答扎实 {report.strong}</span><span>有待补充 {report.developing}</span><span>需要巩固 {report.weak}</span></div>}
      <div className="result-weak"><h3>优先补的知识点</h3>
        {report.weakTopics?.length ? <ol>{report.weakTopics.map((topic) => <li key={topic.topic}>{topic.topic}</li>)}</ol>
          : <p className="muted">本次没有已评估的薄弱主题。</p>}
        {!!report.weakScope?.length && <button disabled={busy} onClick={practiceWeak}>直接练这些题 →</button>}
      </div>
      <div className="oral-actions"><button className="primary" onClick={onExit}>回到学习库</button>
        <button onClick={() => setReport(null)}>再来一轮</button></div>
      <details className="result-details"><summary>查看逐题反馈与原回答</summary>
        {report.entries.map((entry, index) => <article key={`${entry.deckId}:${entry.cardId}`} className="oral-report-entry">
          <strong>{index + 1}. {entry.topic} · {entry.assessment ? bandName[entry.assessment.band] : "未评估"}</strong>
          <Markdown text={entry.prompt} links={false} />
          <p>你的回答：{entry.answer || "未答"}</p>
          {entry.followup && <p>追问：{entry.followup}<br />补充回答：{entry.followupAnswer || "未答"}</p>}
          {entry.assessment?.reason && <p>反馈：{entry.assessment.reason}</p>}
          <p>参考答案：{entry.expected || "本题无参考答案"}</p>
        </article>)}
      </details>
    </div>}
    {error && <p className="exam-error" role="alert">{error}</p>}
  </section>;
}
