import React, { memo, useEffect, useRef, useState } from "react";
import css from "./coach.css";
import { useInjectCss } from "./shared.js";

/* 陪学栏：答错后给一个可能没弄懂的点 + 两选一小检查，回复全靠点按。
   调用直接走 call()，不占全局 busy，题目区域不会因为陪学而被锁住。
   线程随 review 投影下发（run.coach），这里只在答错且还没有要点时请求。 */

const GOALS = [["exam", "应付考试"], ["interview", "面试求职"], ["work", "工作中落地"], ["explore", "兴趣拓展"]];
const isWrong = (feedback) => !!feedback && (feedback.grade !== undefined ? feedback.grade < 3 : feedback.correct === false);

function Typing({ label }) {
  return (
    <>
      <div className="coach-typing" aria-label={label} role="status"><i /><i /><i /></div>
      <small>{label}</small>
    </>
  );
}

function CoachPanel({ run, call, status, autopilot, inline, onAutopilot, onThread, onStatus, onPractice, onRefreshRun, askInChat }) {
  useInjectCss(css, "study-coach");
  const [pending, setPending] = useState(""),
    [error, setError] = useState("");
  const threadRef = useRef(null);
  const enabled = !!status?.enabled;
  const thread = run.coach || [];
  const current = thread.find((n) => n.type === "nudge" && n.runId === run.id && n.entryIndex === run.index);
  const wrong = isWrong(run.feedback);
  const rewriting = status?.tasks?.some((t) => t.kind === "rewrite" && t.status === "running" && t.cardId === run.card?.id);

  // Ask for the point once per wrong answer; the server has usually started it already.
  const requested = useRef(""),
    shown = useRef("");
  shown.current = `${run.id}:${run.index}`;
  useEffect(() => {
    const key = `${run.id}:${run.index}`;
    if (!enabled || !wrong || current || requested.current === key) return;
    requested.current = key;
    setPending("nudge");
    setError("");
    // Not cancelled on re-render: a late result is still this card's thread,
    // and only the question it was asked for may apply it.
    call("coach.nudge", { runId: run.id, index: run.index })
      .then((r) => shown.current === key && onThread(r.thread))
      .catch((e) => shown.current === key && setError(e.message))
      .finally(() => setPending((p) => (p === "nudge" ? "" : p)));
  }, [enabled, wrong, current, run.id, run.index, call, onThread]);

  useEffect(() => {
    const el = threadRef.current;
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
  }, [thread.length, pending, current?.followups?.length, current?.checked]);

  async function send(action, args, kind = action) {
    setPending(kind);
    setError("");
    try {
      const r = await call(action, args);
      if (r?.thread) onThread(r.thread);
      return r;
    } catch (e) {
      setError(e.message);
    } finally {
      setPending("");
    }
  }

  const consentAsk = enabled && status.consent === null && (wrong || thread.length > 0);
  const goalAsk = enabled && status.consent !== null && !status.goal && thread.length > 0;

  return (
    <aside className={"coach-panel" + (inline ? " inline" : "")} aria-label="陪学">
      <div className="coach-head">
        <span className="coach-avatar" aria-hidden="true">✦</span>
        <strong>陪学</strong>
        <span className="spacer" />
        {status?.ready > 0 && (
          <button className="coach-chip ready" title="开刷为你定制的题（这一轮会保留，可回来继续）" onClick={onPractice}>
            已备 {status.ready} 题
          </button>
        )}
        {status?.preparing && !status?.ready && <span className="coach-chip" title="后台正在准备定制题">备题中…</span>}
        <button
          className={"coach-chip" + (autopilot ? " on" : "")}
          aria-pressed={autopilot}
          aria-keyshortcuts="A"
          title="自动驾驶：答对自动下一题，一轮结束自动执行建议（快捷键 A）"
          onClick={() => onAutopilot(!autopilot)}
        >
          自动驾驶 {autopilot ? "开" : "关"}
        </button>
      </div>
      <div className="coach-thread" ref={threadRef}>
        {!enabled && !inline && <p className="coach-empty">连接模型后，答错时这里会指出你可能没弄懂的点。自动驾驶和 👍/👎 反馈现在就能用。</p>}
        {enabled && !inline && !thread.length && !pending && !consentAsk && (
          <p className="coach-empty">
            {run.feedback ? (wrong ? "" : "答对了，继续。答错时我会在这里指出可能没弄懂的点。") : "先作答。答错时我会指出可能没弄懂的点，不用打字。"}
          </p>
        )}
        {thread.map((n) =>
          n.type === "update" ? (
            <div className="coach-bubble system" key={n.id}>
              <p>
                {n.text}
                {n.revertable && (
                  <>
                    {" "}
                    <button
                      className="coach-chip"
                      disabled={!!pending}
                      onClick={async () => {
                        if (await send("coach.revert", { deckId: n.deckId, cardId: n.cardId }, "revert")) onRefreshRun();
                      }}
                    >
                      撤销修改
                    </button>
                  </>
                )}
              </p>
            </div>
          ) : (
            <React.Fragment key={n.id}>
              <div className="coach-bubble">
                <span className="coach-point">{n.point}</span>
                <p>{n.explain}</p>
                {n.check && (
                  <div className="coach-check">
                    <div className="coach-check-q">{n.check.q}</div>
                    <div className="coach-options">
                      {n.check.options.map((o, i) => (
                        <button
                          key={i}
                          className={"coach-chip" + (n.checked ? (i === n.check.answer ? " right" : n.checked.choice === i ? " wrong" : "") : "")}
                          disabled={!!n.checked || !!pending}
                          onClick={() => send("coach.reply", { noteId: n.id, reply: "check", choice: i }, "check")}
                        >
                          {o}
                        </button>
                      ))}
                    </div>
                    {n.checked && <p className="coach-check-q" style={{ marginTop: 6 }}>{n.checked.correct ? "✓ " : "× "}{n.check.why}</p>}
                  </div>
                )}
              </div>
              {n.reply === "got" && <div className="coach-bubble me">懂了</div>}
              {(n.followups || []).map((f, i) => (
                <React.Fragment key={i}>
                  <div className="coach-bubble me">还是不懂</div>
                  <div className="coach-bubble"><p>{f.explain}</p></div>
                </React.Fragment>
              ))}
              {n === thread.findLast((x) => x.type === "nudge") && n.reply !== "got" && (
                <div className="coach-replies">
                  <button className="coach-chip" disabled={!!pending} onClick={() => send("coach.reply", { noteId: n.id, reply: "got" }, "got")}>懂了</button>
                  {(n.followups || []).length < 2 ? (
                    <button className="coach-chip" disabled={!!pending} onClick={() => send("coach.reply", { noteId: n.id, reply: "confused" }, "confused")}>还是不懂</button>
                  ) : (
                    <button className="coach-chip" onClick={() => askInChat(`「${run.card.prompt}」这道题里「${n.point}」我还是不懂，请结合资料换个方式讲，并出一道小题检查我。`)}>去对话里细问</button>
                  )}
                </div>
              )}
            </React.Fragment>
          ),
        )}
        {pending === "nudge" && <Typing label="正在找你可能没弄懂的点…" />}
        {pending === "confused" && <Typing label="换个角度讲…" />}
        {rewriting && <Typing label="正在按你的反馈改这道题…" />}
        {consentAsk && (
          <div className="coach-card">
            <p>要我在你做题时，悄悄把错题的变式题、应用场景题备好吗？只在答错、反馈或一轮结束时少量调用模型。</p>
            <div className="coach-options">
              <button className="coach-chip on" disabled={!!pending} onClick={async () => { if (await send("coach.consent", { prep: true }, "consent")) onStatus(); }}>好，帮我备题</button>
              <button className="coach-chip" disabled={!!pending} onClick={async () => { if (await send("coach.consent", { prep: false }, "consent")) onStatus(); }}>先不用</button>
            </div>
          </div>
        )}
        {goalAsk && (
          <div className="coach-card">
            <p>学这些主要为了？我会按这个调整题目的场景。</p>
            <div className="coach-options">
              {GOALS.map(([id, label]) => (
                <button key={id} className="coach-chip" disabled={!!pending} onClick={async () => { if (await send("coach.goal", { goal: id }, "goal")) onStatus(); }}>{label}</button>
              ))}
            </div>
          </div>
        )}
        {error && <p className="coach-empty" role="alert">{error}</p>}
      </div>
    </aside>
  );
}
export default memo(CoachPanel);
