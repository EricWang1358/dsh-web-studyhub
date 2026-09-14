import React, { useEffect, useRef, useState } from "react";
import css from "./coach.css";
import { useInjectCss } from "./shared.js";

/* 一轮结束的「雷霆建议」：认知层次分布 + 规则洞察 + 模型一句话。
   服务端按已答题数缓存；App 在最后一题答完时已预取，这里通常直接有数据。
   自动驾驶开启时按 next 倒计时执行（白名单动作，可取消）。 */

const LEVELS = [["recall", "记忆"], ["concept", "概念辨析"], ["apply", "应用分析"]];
const COUNTDOWN = 5;

export default function CoachDebrief({ run, call, initial, autopilot, onPractice, onContinue, busy }) {
  useInjectCss(css, "study-coach");
  const [debrief, setDebrief] = useState(initial || null),
    [status, setStatus] = useState(initial?.status || null),
    [error, setError] = useState(""),
    [left, setLeft] = useState(null);
  useEffect(() => {
    let live = true;
    call("coach.debrief", { runId: run.id })
      .then((d) => {
        if (!live) return;
        setDebrief(d);
        setStatus(d.status);
      })
      .catch((e) => live && setError(e.message));
    return () => {
      live = false;
    };
  }, [run.id, call]);
  // While variants are being written, watch the cheap status call until they land.
  const waiting = !!status?.preparing && !status?.ready;
  useEffect(() => {
    if (!waiting) return;
    const t = setInterval(() => call("coach.status").then(setStatus).catch(() => {}), 2000);
    return () => clearInterval(t);
  }, [waiting, call]);

  const ready = status?.ready || 0;
  const next = ready ? "practice_prepared" : debrief?.next === "practice_prepared" ? (waiting ? "wait" : "continue_path") : debrief?.next;
  const action = next === "practice_prepared" ? onPractice : next === "continue_path" || next === "review_weak" ? onContinue : null;
  const label = next === "practice_prepared" ? `刷 ${ready} 道为你定制的题 →` : next === "review_weak" ? "先补薄弱点 →" : "继续学习 →";

  // Autopilot: count down, then take the suggested step; any click cancels.
  const cancelled = useRef(false);
  useEffect(() => {
    if (!autopilot || !debrief || !action || cancelled.current || busy) {
      setLeft(null);
      return;
    }
    setLeft(COUNTDOWN);
    const t = setInterval(() => setLeft((n) => (n > 0 ? n - 1 : 0)), 1000);
    return () => clearInterval(t);
  }, [autopilot, !!debrief, next, busy]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (left === 0 && action && !cancelled.current) {
      cancelled.current = true;
      action();
    }
  }, [left, action]);
  useEffect(() => {
    const stop = () => {
      cancelled.current = true;
      setLeft(null);
    };
    window.addEventListener("pointerdown", stop, { once: true });
    return () => window.removeEventListener("pointerdown", stop);
  }, []);

  if (error && !debrief) return null;
  if (!debrief)
    return (
      <div className="coach-debrief" aria-busy="true" aria-label="正在分析这一轮">
        <div className="eyebrow">陪学 · 本轮分析</div>
        <div className="skeleton h" />
        <div className="skeleton l" />
        <div className="skeleton s" />
      </div>
    );
  const m = debrief.metrics || {};
  return (
    <div className="coach-debrief" role="region" aria-label="本轮建议">
      <div className="eyebrow">陪学 · 本轮建议</div>
      <h2>{debrief.headline}</h2>
      {debrief.why && <p>{debrief.why}</p>}
      {m.answered > 0 && (
        <>
          <div className="coach-levels" aria-hidden="true">
            {LEVELS.map(([id]) => (
              <span key={id} className={id} style={{ flexGrow: m.levels?.[id]?.n || 0 }} />
            ))}
          </div>
          <div className="coach-legend">
            {LEVELS.map(([id, name]) => (
              <span key={id}>
                <i className={"coach-levels-dot " + id} style={{ background: `var(--${id === "recall" ? "text-faint" : id === "concept" ? "info" : "ok"})` }} />
                {name} {m.levels?.[id]?.correct || 0}/{m.levels?.[id]?.n || 0}
              </span>
            ))}
          </div>
        </>
      )}
      {debrief.insights?.length > 1 && (
        <ul className="coach-insights">
          {debrief.insights.slice(1).map((i) => <li key={i.code}>{i.text}</li>)}
        </ul>
      )}
      <div className="coach-actions">
        {next === "wait" && (
          <button className="primary" disabled>
            正在为你备应用题…
          </button>
        )}
        {action && (
          <button
            className="primary"
            disabled={busy}
            onClick={() => {
              cancelled.current = true;
              action();
            }}
          >
            {label}
          </button>
        )}
        {left !== null && left > 0 && (
          <span className="coach-countdown" role="status">
            自动驾驶：{left} 秒后执行 ·{" "}
            <button className="coach-chip" onClick={() => { cancelled.current = true; setLeft(null); }}>取消</button>
          </span>
        )}
        {next === "rest" && <span className="coach-countdown">今天到这儿就很好，明天按间隔回来复习。</span>}
      </div>
    </div>
  );
}
