import { ui, uiFormat } from "./i18n.js";
import { uiRich } from "./i18n-rich.jsx";
import React, { useEffect, useRef, useState } from "react";
import css from "./coach.css";
import { useInjectCss } from "./shared.js";
import { usePolling } from "./use-polling.js";
import { ReadingBlock } from "./reading-settings/ReadingSettings.jsx";
import { Button, ErrorState, StackedBar } from "./components/index.js";
import { useLiveEffect } from './use-async.js';

/* 一轮结束的「雷霆建议」：认知层次分布 + 规则洞察 + 模型一句话。
   服务端按已答题数缓存；App 在最后一题答完时已预取，这里通常直接有数据。
   自动驾驶开启时按 next 倒计时执行（白名单动作，可取消）。
   「继续学习」的去向由页面决定（destination：{ kind, label, go }，见 ui/review/session-logic.js continueDestination）：
   去向是回到原题时，这张卡不再提供任何会把人带去别处的按钮，只让自动驾驶倒计时走回原题；页面自己的「回到原题」是唯一主动作。 */

const LEVELS = [["recall", "记忆"], ["concept", "概念辨析"], ["apply", "应用分析"]];
const COUNTDOWN = 5;

export default function CoachDebrief({ run, call, initial, autopilot, onPractice, onContinue, onReviewWeak, destination, busy }) {
  useInjectCss(css, "study-coach");
  const [debrief, setDebrief] = useState(initial || null),
    [status, setStatus] = useState(initial?.status || null),
    [error, setError] = useState(""),
    [left, setLeft] = useState(null),
    [consent, setConsent] = useState({ busy: false, answer: null, error: "" });
  useLiveEffect((live) => {
    call("coach.debrief", { runId: run.id })
      .then((d) => {
        if (!live()) return;
        setDebrief(d);
        setStatus(d.status);
      })
      .catch((e) => live() && setError(e.message));
  }, [run.id, call]);
  // While variants are being written, watch the cheap status call until they land.
  const waiting = !!status?.preparing && !status?.ready;
  usePolling(() => call("coach.status").then(setStatus).catch(() => {}), { intervalMs: 2000, enabled: waiting });

  const ready = status?.ready || 0;
  // A prerequisite round has one way on: back to the question it came from (autopilot included); nothing else competes with it.
  const back = destination?.kind === "original";
  const next = back ? "original" : ready ? "practice_prepared" : debrief?.next === "practice_prepared" ? (waiting ? "wait" : "continue_path") : debrief?.next;
  const onward = destination?.go || onContinue;
  const action = next === "original" ? destination.go : next === "practice_prepared" ? onPractice
    : next === "review_weak" ? onReviewWeak : next === "continue_path" ? onward : null;
  const label = next === "practice_prepared" ? uiFormat("刷 {0} 道为你定制的题 →", [ready]) : next === "review_weak" ? ui("先补薄弱点 →") : destination?.label || ui("继续学习 →");

  // Autopilot: count down, then take the suggested step; any click cancels.
  const cancelled = useRef(false);
  useEffect(() => {
    if (!autopilot || !debrief || !action || cancelled.current || busy) {
      setLeft(null);
      return;
    }
    setLeft(COUNTDOWN);
  }, [autopilot, !!debrief, next, busy]); // eslint-disable-line react-hooks/exhaustive-deps
  // The countdown keeps its seconds even if the tab is in the background: the suggested step is taken on time.
  usePolling(() => setLeft((n) => (n > 0 ? n - 1 : 0)), { intervalMs: 1000, enabled: left !== null && left > 0, pauseWhenHidden: false });
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

  /* 定制题 need the learner's yes. The 陪学 column that used to ask is gone, so
     the round's debrief asks once; the answer is kept and editable in 设置. */
  async function answerConsent(prep) {
    cancelled.current = true;
    setLeft(null);
    setConsent({ busy: true, answer: null, error: "" });
    try {
      setStatus(await call("coach.consent", { prep, runId: run.id }));
      setConsent({ busy: false, answer: prep, error: "" });
    } catch (e) {
      setConsent({ busy: false, answer: null, error: e.message });
    }
  }
  const askConsent = !!status?.enabled && status.consent === null && consent.answer === null;

  if (error && !debrief) return null;
  if (!debrief)
    return (
      <div className="coach-debrief" aria-busy="true" aria-label={ui("正在分析这一轮")}>
        <div className="eyebrow">{ui("陪学 · 本轮分析")}</div>
        <div className="skeleton h" />
        <div className="skeleton l" />
        <div className="skeleton s" />
      </div>
    );
  const m = debrief.metrics || {};
  return (
    <ReadingBlock className="coach-debrief" data-next={next} role="region" aria-label={ui("本轮建议")}>
      <div className="eyebrow">{ui("陪学 · 本轮建议")}</div>
      <h2>{debrief.headline}</h2>
      {debrief.why && <p>{debrief.why}</p>}
      {(m.gradedAnswered > 0 || m.selfAnswered > 0) && <div className="coach-score-split">
        {m.gradedAnswered > 0 && <span>{uiRich("客观题答对 {0}", <strong>{m.gradedCorrect}/{m.gradedAnswered}</strong>)}</span>}
        {m.selfAnswered > 0 && <span>{uiRich("自评达标 {0}", <strong>{m.selfMet}/{m.selfAnswered}</strong>)}</span>}
      </div>}
      {m.answered > 0 && (
        <>
          <StackedBar className="coach-stack" aria-hidden="true" segments={LEVELS.map(([id]) => ({ value: m.levels?.[id]?.n || 0, tone: id === "recall" ? "neutral" : id === "concept" ? "info" : "success" }))} />
          <div className="coach-legend">
            {LEVELS.map(([id, name]) => (
              <span key={id}>
                <i className={"coach-levels-dot " + id} style={{ background: `var(--${id === "recall" ? "decor-faint" : id === "concept" ? "info" : "ok"})` }} />
                {uiFormat("{0} 达标 {1}/{2}", [ui(name), m.levels?.[id]?.met ?? m.levels?.[id]?.correct ?? 0, m.levels?.[id]?.n || 0])}
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
          <Button variant="primary" disabled>{ui("正在为你备应用题…")}</Button>
        )}
        {action && !back && (
          <Button
            variant="primary"
            disabled={busy}
            onClick={() => {
              cancelled.current = true;
              action();
            }}
          >
            {label}
          </Button>
        )}
        {left !== null && left > 0 && (
          <span className="coach-countdown" role="status">{back ? uiFormat("自动驾驶：{0} 秒后{1} ·", [left, label.replace(/\s*→$/, "")]) : uiFormat("自动驾驶：{0} 秒后执行 ·", [left])}{" "}
            <Button variant="link" size="sm" onClick={() => { cancelled.current = true; setLeft(null); }}>{ui("取消")}</Button>
          </span>
        )}
        {next === "rest" && <span className="coach-countdown">{ui("今天到这儿就很好，明天按间隔回来复习。")}</span>}
      </div>
      {askConsent && (
        <div className="coach-card coach-consent">
          <p>{ui("要给你备几道变式题和应用场景题吗？开启时会从最近的错题中选最多 4 道备题；之后点「生成变式」或标记「太简单 / 太难」时，也会在后台少量调用模型备题。本轮回顾发现还缺应用练习时，也会准备应用题。")}</p>
          <div className="coach-options">
            <Button size="sm" disabled={consent.busy} onClick={() => answerConsent(true)}>{ui("好，帮我备题")}</Button>
            <Button variant="quiet" size="sm" disabled={consent.busy} onClick={() => answerConsent(false)}>{ui("先不用")}</Button>
          </div>
          {consent.error && <ErrorState compact className="coach-consent__problem" error={consent.error} />}
        </div>
      )}
      {consent.answer === true && !ready && (
        <p className="coach-consent-note" role="status">
          {status?.preparing
            ? ui("正在按这一轮备题，备好后这里会出现开刷按钮。")
            : status?.tasks?.findLast((t) => t.kind === "prep")?.status === "failed"
              ? ui("这次备题没成功，可以在「错题与待巩固」选择题目，再点「生成变式」重试。")
              : ui("这次没有要变式的题。之后可以点「生成变式」，或标记「太简单 / 太难」来备题。")}
        </p>
      )}
      {consent.answer === false && (
        <p className="coach-consent-note" role="status">{ui("好的，不备题。想开启时去「设置 › 学习画像与导览」里的「陪学」。")}</p>
      )}
    </ReadingBlock>
  );
}
