import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Markdown from "./Markdown.jsx";
import css from "./views.css";

/* 模拟考试（v0.4 契约 §3）：setup → running → report 自管理状态机。
   选中状态存本地（picks，按 deckId:cardId 键控），每次选择通过
   review.answer 静默保存（exam 运行中服务端只存 entry.selected，不判分、
   不给反馈）；上一题/下一题走 review.move 自由导航，允许未作答移动。
   挂载时从快照 runs 里找回进行中的 exam run 并 review.get 恢复；计时满
   30 分钟自动交卷；卸载不交卷，未交卷的考试保留在服务端可再次接回。 */

const EXAM_LIMIT_MS = 30 * 60 * 1000;

function useInjectViewsCss() {
  useEffect(() => {
    if (document.querySelector("style[data-study-views]")) return;
    const el = document.createElement("style");
    el.setAttribute("data-study-views", "");
    el.textContent = css;
    document.head.appendChild(el);
  }, []);
}

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
  return m ? `${m} 分 ${s % 60} 秒` : `${s} 秒`;
};
const kindLabel = (card) => (card?.multiple ? "多选" : "单选");
/* Cloze prompts carry raw {{id}} markers; the report shows a blank instead. */
const plainPrompt = (p) => String(p ?? "").replace(/\{\{[^{}]+\}\}/g, "＿＿");
/* 服务端 projection.picks 里已保存的选项（exam 运行专属），用于恢复与导航回填。 */
const picksFromRun = (r) => {
  const map = {};
  for (const p of r?.picks || [])
    if (p?.deckId && p?.cardId && Array.isArray(p.selected) && p.selected.length)
      map[p.deckId + ":" + p.cardId] = p.selected;
  return map;
};

export default function Exam({ call, data, onExit }) {
  useInjectViewsCss();
  const [phase, setPhase] = useState("setup"), // setup → running → report
    [run, setRun] = useState(null),
    [report, setReport] = useState(null),
    [picks, setPicks] = useState({}),
    [err, setErr] = useState(""),
    [countDraft, setCountDraft] = useState("10"),
    [pickedDecks, setPickedDecks] = useState(() => new Set()),
    [confirming, setConfirming] = useState(false),
    [busy, setBusy] = useState(false),
    [pathNote, setPathNote] = useState("");
  const picksRef = useRef({}),
    autoSent = useRef(false);
  const count = clampCount(countDraft);

  function applyPicks(next) {
    picksRef.current = next;
    setPicks(next);
  }

  const decks = useMemo(
    () =>
      (data?.decks || []).filter((d) => d && !d.archived && (d.quizCount || 0) > 0),
    [data],
  );

  /* 挂载时恢复进行中的考试：快照 runs 里的 exam run 用 review.get 接回。 */
  useEffect(() => {
    let live = true;
    (async () => {
      const open = (data?.runs || []).find((r) => r && r.mode === "exam");
      if (!open) return;
      try {
        const r = await call("review.get", { runId: open.id });
        if (!live || !r || r.closedAt || r.complete || !r.card) return;
        autoSent.current = false;
        setRun(r);
        applyPicks(picksFromRun(r));
        setPhase("running");
      } catch {
        /* run 已失效：停留在出卷页 */
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

  async function startExam() {
    if (busy || !pickedDecks.size) return;
    setBusy(true);
    setErr("");
    try {
      const r = await call("review.start", {
        mode: "exam",
        scope: [...pickedDecks].map((deckId) => ({ deckId })),
        count,
        fresh: true,
      });
      autoSent.current = false;
      setRun(r);
      applyPicks(picksFromRun(r));
      setPhase("running");
    } catch (e) {
      setErr(e.message || String(e));
    } finally {
      setBusy(false);
    }
  }

  const curKey =
    run?.deckId != null && run?.card?.id ? run.deckId + ":" + run.card.id : null;
  const curPicks = (curKey && picks[curKey]) || [];
  function pick(optionId) {
    if (!run?.card || !curKey) return;
    const multi = !!run.card.multiple || run.card.kind === "multi";
    const cur = picksRef.current[curKey] || [];
    const next = multi
      ? cur.includes(optionId)
        ? cur.filter((x) => x !== optionId)
        : [...cur, optionId]
      : [optionId];
    applyPicks({ ...picksRef.current, [curKey]: next });
    // exam 模式的 review.answer 只保存选项、可反复修改，不判分。
    call("review.answer", {
      runId: run.id,
      cardId: run.card.id,
      selected: next,
    }).catch((e) => setErr(e.message || String(e)));
  }

  async function move(direction) {
    if (busy || !run) return;
    setBusy(true);
    setErr("");
    try {
      const next = await call("review.move", { runId: run.id, direction });
      const r = next && next.card ? next : await call("review.get", { runId: run.id });
      setRun(r);
      // 服务端已保存的选项打底；本地尚未落库的选择优先展示，避免闪烁丢失。
      applyPicks({ ...picksFromRun(r), ...picksRef.current });
    } catch (e) {
      setErr(e.message || String(e));
    } finally {
      setBusy(false);
    }
  }

  async function submit() {
    if (busy || !run) return;
    setBusy(true);
    setErr("");
    setConfirming(false);
    try {
      const rep = await call("exam.submit", { runId: run.id });
      setReport(rep);
      setPhase("report");
    } catch (e) {
      setErr(e.message || String(e));
    } finally {
      setBusy(false);
    }
  }

  /* 计时满 30 分钟自动交卷（只触发一次）。 */
  useEffect(() => {
    if (phase !== "running" || !startMs || autoSent.current) return;
    if (elapsedMs >= EXAM_LIMIT_MS) {
      autoSent.current = true;
      submit();
    }
  }, [elapsedMs, phase, startMs]);

  const answeredCount = useMemo(
    () => Object.values(picks).filter((a) => Array.isArray(a) && a.length).length,
    [picks],
  );
  const unanswered = Math.max(0, (run?.total || 0) - answeredCount);

  async function queueWeak() {
    if (busy || pathNote || !report?.weakScope?.length) return;
    setBusy(true);
    setErr("");
    try {
      await call("review.start", {
        mode: "path",
        scope: report.weakScope,
        fresh: true,
      });
      setPathNote(
        `已把 ${report.weakScope.length} 道错题排进学习路径，回到学习库即可开始练习。`,
      );
    } catch (e) {
      setErr(e.message || String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="exam">
      {phase === "setup" && (
        <div className="exam-setup">
          <div className="eyebrow">模拟考试</div>
          <h2>选择题组，生成一份试卷</h2>
          <p className="muted">
            从勾选的题组里随机抽选选择题；作答过程中不显示对错，交卷后统一判分并计入复习计划。
          </p>
          {decks.length ? (
            <>
              <div className="exam-setup-tools">
                <button
                  disabled={pickedDecks.size === decks.length}
                  onClick={() => setPickedDecks(new Set(decks.map((d) => d.id)))}
                >
                  全选
                </button>
                <button
                  disabled={!pickedDecks.size}
                  onClick={() => setPickedDecks(new Set())}
                >
                  清空
                </button>
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
                        <small>{d.quizCount} 道选择题</small>
                      </span>
                    </label>
                  </li>
                ))}
              </ul>
              <div className="exam-setup-foot">
                <label className="exam-count">
                  题数
                  <input
                    type="number"
                    min={1}
                    max={50}
                    value={countDraft}
                    onChange={(e) => setCountDraft(e.target.value)}
                    onBlur={() => setCountDraft(String(clampCount(countDraft)))}
                  />
                  <small>1–50 · 默认 10</small>
                </label>
                <button
                  className="primary"
                  disabled={!pickedDecks.size || busy}
                  onClick={startExam}
                >
                  {busy ? "正在出卷…" : "开始考试"}
                </button>
              </div>
            </>
          ) : (
            <p className="muted">当前没有含选择题的题组，先在学习库生成题目后再来模考。</p>
          )}
          {err && <p className="exam-error">{err}</p>}
        </div>
      )}

      {phase === "running" && run?.card && (
        <>
          <div className="exam-head">
            <div>
              <div className="eyebrow">模拟考试进行中</div>
              <h2>{run.title || "模拟考试"}</h2>
            </div>
            <div className="exam-head-right">
              <span className="exam-timer" title="已用时">
                已用时 {fmtClock(elapsedMs)}
              </span>
              <span className="exam-progress">
                {run.index + 1} / {run.total}
              </span>
            </div>
          </div>
          <div className="exam-card" key={run.card.id}>
            <div className="exam-card-meta">
              <span className="exam-chip">{run.card.topic || "未分类"}</span>
              <span className="exam-chip dim">{kindLabel(run.card)}</span>
              <span className="muted small">
                {run.card.multiple ? "选出所有符合条件的选项" : "选出一项"}
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
            <button disabled={busy || !run.index} onClick={() => move(-1)}>
              ← 上一题
            </button>
            <button
              className="primary"
              disabled={busy || run.index >= run.total - 1}
              onClick={() => move(1)}
            >
              下一题 →
            </button>
          </div>
          {confirming ? (
            <div className="exam-confirm" role="alertdialog" aria-label="确认交卷">
              <p>
                还有 <strong>{unanswered}</strong> 题未作答，交卷后将立即判分并结束本次考试。
              </p>
              <div className="exam-confirm-actions">
                <button disabled={busy} onClick={() => setConfirming(false)}>
                  继续作答
                </button>
                <button className="primary" disabled={busy} onClick={submit}>
                  {busy ? "正在交卷…" : "确认交卷"}
                </button>
              </div>
            </div>
          ) : (
            <div className="exam-foot">
              <button disabled={busy} onClick={() => setConfirming(true)}>
                交卷
              </button>
              <p className="muted small">
                未交卷的考试会保留在回到题目里 · 计时满 30 分钟自动交卷
              </p>
            </div>
          )}
          {err && <p className="exam-error">{err}</p>}
        </>
      )}

      {phase === "running" && !run?.card && (
        <p className="muted">正在载入试卷…</p>
      )}

      {phase === "report" && report && (
        <div className="exam-report">
          <div className="eyebrow">考试报告</div>
          <div className="exam-score-row">
            <div className="exam-score">
              <strong>
                {Math.round(report.scorePct ?? 0)}
                <i>%</i>
              </strong>
              <small>得分</small>
            </div>
            <ul className="exam-stats">
              <li>
                <strong>{report.correct ?? 0}</strong>
                <small>答对</small>
              </li>
              <li>
                <strong>{report.answered ?? 0}</strong>
                <small>已答</small>
              </li>
              <li>
                <strong>{report.unanswered ?? 0}</strong>
                <small>未答</small>
              </li>
              <li>
                <strong>{fmtDuration(report.durationMs)}</strong>
                <small>用时</small>
              </li>
            </ul>
          </div>

          <div className="exam-bars">
            <div className="eyebrow">按主题分布</div>
            {report.byTopic?.length ? (
              report.byTopic.map((t) => (
                <div key={t.topic} className="exam-bar-row">
                  <span className="exam-bar-label">{t.topic || "未分类"}</span>
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
              <p className="muted">暂无主题分布。</p>
            )}
          </div>

          {report.byDeck?.length > 0 && (
            <div className="exam-bars">
              <div className="eyebrow">按题组分布</div>
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

          <div className="exam-wrong">
            <div className="eyebrow">错题 · {report.wrong?.length || 0}</div>
            {report.wrong?.length ? (
              <ul>
                {report.wrong.map((w) => (
                  <li key={w.deckId + ":" + w.cardId} className="exam-wrong-row">
                    <span className="exam-chip">{w.topic || "未分类"}</span>
                    <span className="exam-wrong-prompt" title={plainPrompt(w.prompt)}>
                      {plainPrompt(w.prompt)}
                    </span>
                    <span className="exam-chip dim">{w.kind === "multi" ? "多选" : "单选"}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="muted">全部答对，没有错题。</p>
            )}
          </div>

          <div className="exam-report-actions">
            <button className="primary" onClick={onExit}>
              回学习库
            </button>
            {report.weakScope?.length > 0 && (
              <button disabled={busy || !!pathNote} onClick={queueWeak}>
                把错题排进学习路径
              </button>
            )}
            {pathNote && <p className="muted exam-path-note">{pathNote}</p>}
          </div>
          {err && <p className="exam-error">{err}</p>}
        </div>
      )}
    </section>
  );
}
