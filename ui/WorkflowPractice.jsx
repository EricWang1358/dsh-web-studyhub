import React, { useEffect, useRef, useState } from "react";
import Markdown from "./Markdown.jsx";
import Cloze from "./Cloze.jsx";
import ChoiceFeedback from "./ChoiceFeedback.jsx";
import { kinds } from "./shared.js";

function getDraft(key) { try { return JSON.parse(localStorage.getItem(key)) || {}; } catch { return {}; } }
function keepDraft(key, value) { try { localStorage.setItem(key, JSON.stringify(value)); } catch {} }

function PracticeCard({ run, libraryKey, busy, action }) {
  const key = `study-workflow-practice:${libraryKey}:${run.id}:${run.index}:${run.queueVersion}:${run.card.id}`;
  const [draft, setDraft] = useState(() => getDraft(key));
  useEffect(() => {
    if (!run.feedback) return;
    // Graded selections and fill-in answers are already in the library.
    // Keep only an open-answer draft, which the review API does not store.
    try {
      if (draft.response) localStorage.setItem(key, JSON.stringify({ response: draft.response }));
      else localStorage.removeItem(key);
    } catch {}
  }, [key, run.feedback, draft.response]);
  const selected = run.feedback?.selected || draft.selected || [];
  const answers = run.feedback?.answers || draft.answers || {};
  const multiple = run.card.kind === "multi", choice = ["quiz", "multi"].includes(run.card.kind);
  const change = (fields) => { const next = { ...draft, ...fields }; setDraft(next); keepDraft(key, next); };
  const toggle = (id) => change({ selected: multiple ? selected.includes(id) ? selected.filter((x) => x !== id) : [...selected, id] : [id] });
  return <article className="wf-practice-card">
    <div className="wf-practice-meta"><span>{kinds[run.card.kind] || "练习"}{run.retry ? " · 再练一次" : ""}</span><span>{run.index + 1} / {run.total}</span></div>
    <Markdown text={run.card.prompt} className="wf-question" />
    {run.card.publicationUngrable ? <><p className="wf-notice">这道题缺少可判分内容，可跳过后继续。</p><button type="button" disabled={busy} onClick={() => action("review.skip")}>跳过这道题</button></> : <>
      {choice ? <>
        <fieldset disabled={busy || !!run.feedback} className="wf-choices"><legend className="wf-sr-only">{multiple ? "选择所有正确选项" : "选择一个答案"}</legend>
          {run.card.options.map((option, index) => <label key={option.id} className={selected.includes(option.id) ? "is-picked" : ""}>
            <input type={multiple ? "checkbox" : "radio"} name={`choice-${run.id}-${run.index}`} checked={selected.includes(option.id)} onChange={() => toggle(option.id)} />
            <span className="wf-choice-letter">{String.fromCharCode(65 + index)}</span><Markdown text={option.text} />
          </label>)}
        </fieldset>
        {!run.feedback && <button type="button" className="primary" disabled={busy || !selected.length} onClick={() => action("review.answer", { selected })}>提交答案</button>}
        <ChoiceFeedback options={run.card.options} feedback={run.feedback} solution={run.solution} multiple={multiple} />
      </> : run.card.kind === "cloze" ? <>
        <Cloze card={run.card} values={answers} disabled={busy || !!run.feedback} onChange={(id, value) => change({ answers: { ...answers, [id]: value } })} details={run.feedback?.details} solution={run.solution} />
        {!run.feedback && <button type="button" className="primary" disabled={busy || !Object.values(answers).some((v) => v.trim())} onClick={() => action("review.answer", { answers })}>提交填空</button>}
      </> : <>
        {run.card.kind === "open" && <label className="wf-fields">先组织你的回答<textarea rows={4} value={draft.response || ""} disabled={busy || run.revealed} maxLength={20000} onChange={(e) => change({ response: e.target.value })} placeholder="用自己的话作答；草稿保存在此设备。" /></label>}
        {!run.revealed && <button type="button" className="primary" disabled={busy} onClick={() => action("review.reveal")}>显示参考答案</button>}
        {run.revealed && run.solution && <div className="wf-answer"><h4>参考答案</h4><Markdown text={run.solution.answer} /></div>}
        {run.revealed && !run.feedback && <div className="wf-self-grade"><p className="muted small">对照参考答案，按原有闪卡规则自评。</p><div role="group" aria-label="闪卡自评">{["完全忘记", "记得一点", "有印象", "勉强答对", "熟练", "轻松掌握"].map((label, grade) => <button type="button" key={grade} disabled={busy} onClick={() => action("review.answer", { grade })}><strong>{grade}</strong><span>{label}</span></button>)}</div></div>}
      </>}
      {run.feedback && <p className="wf-feedback" role="status">{choice || run.card.kind === "cloze" ? run.feedback.correct ? "回答正确" : "这题还需要巩固" : `已记录自评 ${run.feedback.grade} 分`}{run.feedback.retryQueued ? " · 本轮稍后会再练一次" : ""}</p>}
      {run.solution && run.revealed && <details className="wf-practice-explanation" open={!!run.feedback}><summary>题解与易错点</summary><Markdown text={run.solution.explanation} />{run.solution.misconception && <Markdown text={run.solution.misconception} />}{run.solution.rubric && <Markdown text={run.solution.rubric} />}
        {choice && run.solution.options?.map((option) => <div className="wf-option-explanation" key={option.id}><strong>{run.card.options.findIndex((o) => o.id === option.id) >= 0 ? String.fromCharCode(65 + run.card.options.findIndex((o) => o.id === option.id)) : ""} · {option.correct ? "正确选项" : "错误选项"}</strong><Markdown text={option.explanation} /></div>)}
      </details>}
    </>}
  </article>;
}

export default function WorkflowPractice({ runId, libraryKey, call, disabled, onBusy, onComplete }) {
  const [run, setRun] = useState(null), [pending, setPending] = useState(false), [error, setError] = useState("");
  const lock = useRef(false), lifecycle = useRef(0);
  useEffect(() => {
    const generation = ++lifecycle.current;
    setPending(false);
    call("review.get", { runId }).then((next) => { if (generation === lifecycle.current) { setRun(next); onComplete(next.navigation?.length > 0 && next.navigation.every((item) => item.answered)); } }).catch((err) => { if (generation === lifecycle.current) setError(err.message); });
    return () => {
      lifecycle.current = generation + 1;
      if (lock.current) { lock.current = false; onBusy(false); }
    };
  }, [call, runId, onBusy, onComplete]);
  async function action(name, payload = {}) {
    if (lock.current || disabled) return;
    const generation = lifecycle.current;
    lock.current = true; setPending(true); onBusy(true); setError("");
    try {
      const next = await call(name, { runId, cardId: run?.card?.id, queueVersion: run?.queueVersion, ...payload });
      if (generation === lifecycle.current) { setRun(next); onComplete(next.navigation?.length > 0 && next.navigation.every((item) => item.answered)); }
    } catch (err) { if (generation === lifecycle.current) setError(err.message); }
    finally { if (generation === lifecycle.current) { lock.current = false; setPending(false); onBusy(false); } }
  }
  return <section className="wf-practice" aria-label="本步题目练习">
    {error && <div className="wf-error" role="alert"><p>{error}</p><button type="button" disabled={pending || disabled} onClick={() => action("review.get")}>重新读取本轮练习</button></div>}
    {!run ? <p className="muted" role="status">正在读取练习…</p> : run.complete ? <div className="wf-notice"><h3>{run.closed ? "这轮练习已结束" : "本步练习已完成"}</h3><p>{run.answered} 道已作答 · {run.correct} 道答对或自评通过{run.retries ? ` · ${run.retries} 次重练` : ""}</p><p className="muted small">在下方记录收获，再决定继续或回补。</p></div> : <>
      <PracticeCard key={`${run.id}:${run.index}:${run.queueVersion}:${run.card.id}`} run={run} libraryKey={libraryKey} busy={pending || disabled} action={action} />
      <div className="wf-practice-nav"><button type="button" disabled={pending || disabled || run.index === 0} onClick={() => action("review.move", { direction: -1 })}>上一题</button><span className="muted small">{run.navigation.filter((item) => item.answered).length} / {run.total} 次作答</span><button type="button" disabled={pending || disabled || !run.feedback} onClick={() => action("review.move", { direction: 1 })}>{run.index + 1 >= run.total ? "查看本步结果" : "下一题"}</button></div>
    </>}
  </section>;
}
