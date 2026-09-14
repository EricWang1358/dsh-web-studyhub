import React from "react";
import Markdown from "./Markdown.jsx";
import Cloze from "./Cloze.jsx";
import Icon from "./Icon.jsx";
import ReviewNavigator from "./ReviewNavigator.jsx";
import ReviewToolbar from "./ReviewToolbar.jsx";
import ChoiceFeedback from "./ChoiceFeedback.jsx";
import CoachPanel from "./CoachPanel.jsx";
import CoachDebrief from "./CoachDebrief.jsx";
import ThumbFeedback from "./ThumbFeedback.jsx";

/* 复习视图：quiz/multi 选项作答、cloze 填空、闪卡翻面与开放问答自评，
   附前置题条、逐步讲解面板与薄弱主题收尾。会话状态（run）与本地作答
   状态都由 App 持有，本组件只负责渲染与交互转发。 */
const date = (v) =>
  v
    ? new Date(v).toLocaleString("zh-CN", {
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      })
    : "现在";

export default function Review({
  run,
  data,
  busy,
  host,
  choice,
  isCloze,
  shellTitle,
  showBack,
  selected,
  hint,
  explain,
  response,
  teaching,
  teachAnswer,
  clozeValues,
  setModal,
  setPage,
  setFlag,
  setExplain,
  setHint,
  setResponse,
  setTeaching,
  setTeachAnswer,
  setClozeValues,
  choose,
  flipCard,
  reviewAct,
  studyPrerequisites,
  askAboutCard,
  improveCard,
  slayCard,
  coachProps,
  askInChat,
  act,
  enterRun,
}) {
  const pageRef = React.useRef(null);
  const multiple = run.card?.multiple || run.card?.kind === "multi";
  // "下一题" sits below long explanations; bring the next question's top back
  // into view instead of opening it at the previous scroll offset.
  React.useEffect(() => {
    const page = pageRef.current;
    let scroller = page?.parentElement;
    while (scroller && !(scroller.scrollHeight > scroller.clientHeight &&
      /(auto|scroll)/.test(getComputedStyle(scroller).overflowY)))
      scroller = scroller.parentElement;
    if (!page || !scroller) return;
    const bar = page.closest("main")?.querySelector(":scope > .topbar")?.offsetHeight || 0;
    const offset = page.getBoundingClientRect().top - scroller.getBoundingClientRect().top - bar;
    if (offset < 0) scroller.scrollTop = Math.max(0, scroller.scrollTop + offset);
  }, [run.id, run.index, run.complete]);
  const coachPanel = coachProps && run.mode !== "exam" && !run.complete && (
    <CoachPanel
      run={run}
      call={coachProps.call}
      status={coachProps.status}
      autopilot={coachProps.autopilot}
      inline={!coachProps.side}
      onAutopilot={coachProps.onAutopilot}
      onThread={coachProps.onThread}
      onStatus={coachProps.onStatus}
      onPractice={coachProps.onPractice}
      onRefreshRun={coachProps.onRefreshRun}
      askInChat={coachProps.askInChat}
    />
  );
  return (
    <section
      ref={pageRef}
      className={"review-page " + (!choice ? "flash-mode" : "")}
    >
      <div className="review-heading">
        <div>
          <h1>
            {shellTitle}
            {run.mode === "flashcard" ? " · 闪卡" : ""}
            {run.retry && !run.complete ? " · 本轮重练" : ""}
          </h1>
          <button
            className="pill"
            onClick={() => setModal({ type: "sources" })}
          >
            查看 {run.sourceIds?.length || 0} 份资料
          </button>
        </div>
        <div className="review-heading-actions">
          {host.openInSidebar && !run.complete && (
            <button
              className="ghost-btn"
              title="题目放到右栏，主区域回到对话"
              onClick={() => host.openInSidebar(run.id)}
            >
              在右栏打开
            </button>
          )}
          <button onClick={() => setPage("library")}>返回学习库</button>
        </div>
      </div>
      {run.complete ? (
        <div className="session-summary">
          <div className="summary-symbol">✓</div>
          <div className="eyebrow">SESSION COMPLETE</div>
          <h1>
            {run.closed ? "这一轮，已结束。" : "这一轮，完成了。"}
          </h1>
          <p>
            已答 {run.answered} / {run.questions ?? run.total} 道题 · 掌握{" "}
            {run.correct} 道 · 需要巩固 {run.answered - run.correct} 道
            {run.retries > 0 ? ` · 队尾重练 ${run.retries} 次` : ""}
          </p>
          <div className="summary-topics">
            <h3>接下来重点复习</h3>
            {(run.weakTopics || []).map((t) => (
              <span className="tag" key={t}>
                {t}
              </span>
            ))}
            {!run.weakTopics?.length && (
              <p className="muted">
                本轮没有低分记录，继续按间隔复习巩固。
              </p>
            )}
          </div>
          <p className="muted">每道题的下次复习时间已保存。</p>
          {coachProps && run.mode !== "exam" && run.answered > 0 && (
            <CoachDebrief
              run={run}
              call={coachProps.call}
              initial={coachProps.debrief}
              autopilot={coachProps.autopilot}
              busy={busy}
              onPractice={coachProps.onPractice}
              onContinue={coachProps.onContinue}
            />
          )}
          <div className="summary-actions">
            {run.mode === "path" && !run.returnTo && (
              <button
                className="primary"
                disabled={busy}
                onClick={() => act("review.start", { mode: "path", scope: run.scope || [], fresh: true }, enterRun)}
              >
                {run.scope?.length ? "再练此范围" : "继续学习"}
              </button>
            )}
            {run.weakTopics?.length > 0 && (
              <button
                onClick={() =>
                  askInChat(
                    `我刚在「${shellTitle}」里这些主题答得不好：${run.weakTopics.join("、")}。请结合学习库资料逐个讲清楚，并各出一道小题检查我。`,
                  )
                }
              >
                在对话中讲解薄弱点
              </button>
            )}
            <button
              className={run.returnTo ? "" : "primary"}
              onClick={() => setPage("library")}
            >
              回到学习目录
            </button>
            {run.returnTo && (
              <button
                className="primary"
                disabled={busy}
                onClick={() => act("review.get", { runId: run.returnTo }, enterRun)}
              >
                回到原题 →
              </button>
            )}
          </div>
        </div>
      ) : (
        <div className={"review-body" + (coachPanel && coachProps.side ? " with-coach" : "")}>
          <ReviewNavigator run={run} busy={busy} onJump={(index) => reviewAct("review.move", { index })} />
          <div
            className={
              "question-area " +
              (!choice && !isCloze ? "flash-area" : "")
            }
          >
            {run.contentUpdated && <p className="warning" role="status">题目已更新，请按新版重新作答。之前的作答历史已保留。</p>}
            <div className="question-meta">
              <span>
                {run.index + 1} / {run.total}
              </span>
              <div>
                <span>{run.card.topic}</span>
                <button
                  aria-label="标记题目"
                  onClick={() => {
                    setFlag("");
                    setModal({ type: "flag" });
                  }}
                >
                  ⚑
                </button>
              </div>
            </div>
            {run.prerequisites?.length > 0 && (
              <details className="prereq-strip">
                <summary>
                  <span>
                    前置题 {run.prerequisites.length} · 已掌握{" "}
                    {run.prerequisites.filter((p) => !["new", "weak"].includes(p.level)).length}
                  </span>
                  {(() => {
                    const unlearned = run.prerequisites.some((p) => ["new", "weak"].includes(p.level));
                    return (
                      <button
                        className={unlearned ? "primary pill" : "pill"}
                        disabled={busy}
                        title={unlearned ? "先学没掌握的前置题，学完回到这道题" : "把前置题再过一遍自查，做完回到这道题"}
                        onClick={(e) => {
                          e.preventDefault();
                          studyPrerequisites(run.prerequisites);
                        }}
                      >
                        {unlearned ? "先学前置 →" : "自查前置 →"}
                      </button>
                    );
                  })()}
                </summary>
                <ul>
                  {run.prerequisites.map((p) => (
                    <li key={p.deckId + p.cardId}>
                      <button
                        className="prereq-item"
                        disabled={busy}
                        title="只练这一道，做完回到这道题"
                        onClick={() => studyPrerequisites([p])}
                      >
                        <span className={"map-dot lv-" + p.level} />
                        <Markdown className="md-compact" links={false} text={p.prompt} />
                        <span className="prereq-go" aria-hidden="true">→</span>
                      </button>
                    </li>
                  ))}
                </ul>
              </details>
            )}
            {choice ? (
              <>
                <div className="question" role="heading" aria-level={2}>
                  <Markdown text={run.card.prompt} />
                </div>
                {run.card.multiple && (
                  <p className="muted small">
                    多选题 · 选出所有符合条件的选项
                  </p>
                )}
                <ChoiceFeedback options={run.card.options} feedback={run.feedback} solution={run.solution} multiple={multiple} />
                <div className="options">
                  {run.card.options.map((o, i) => {
                    const solution = run.solution?.options?.find(
                      (x) => x.id === o.id,
                    );
                    const picked = run.feedback?.selected?.includes(
                      o.id,
                    );
                    return (
                      <button
                        key={o.id}
                        disabled={busy || !!run.feedback}
                        className={
                          "option " +
                          (run.feedback
                            ? solution?.correct
                              ? "correct"
                              : picked
                                ? "incorrect"
                                : "dim"
                            : selected.includes(o.id)
                              ? "selected"
                              : "")
                        }
                        onClick={() => choose(o.id)}
                      >
                        <span className="option-letter">
                          {String.fromCharCode(65 + i)}.
                        </span>
                        <div>
                          <Markdown text={o.text} links={false} className="md-compact" />
                          {run.feedback && (
                            <>
                              <strong className="answer-state">
                                {solution?.correct
                                  ? picked ? "✓ 已选 · 正确" : multiple ? "漏选 · 正确答案" : "正确答案"
                                  : picked
                                    ? multiple ? "× 已选 · 错选" : "× 你的选择"
                                    : ""}
                              </strong>
                              <Markdown
                                text={solution?.explanation}
                                links={false}
                                className="md-compact option-explanation"
                              />
                            </>
                          )}
                        </div>
                      </button>
                    );
                  })}
                </div>
                {run.card.multiple && !run.feedback && (
                  <button
                    className="primary submit-answer"
                    disabled={busy || !selected.length}
                    onClick={() =>
                      reviewAct("review.answer", { selected })
                    }
                  >
                    提交答案
                  </button>
                )}
              </>
            ) : isCloze ? (
              <>
                <Cloze
                  card={run.card}
                  values={run.feedback?.answers || clozeValues}
                  onChange={(id, value) =>
                    setClozeValues((v) => ({ ...v, [id]: value }))
                  }
                  disabled={busy || !!run.feedback}
                  details={run.feedback?.details || null}
                  solution={run.solution}
                />
                {!run.feedback && (
                  <button
                    className="primary submit-answer"
                    disabled={
                      busy ||
                      !Object.values(clozeValues).some((v) =>
                        String(v).trim(),
                      )
                    }
                    onClick={() =>
                      reviewAct("review.answer", { answers: clozeValues })
                    }
                  >
                    提交答案
                  </button>
                )}
              </>
            ) : (
              <>
                <button
                  key={run.card.id}
                  className={"flashcard" + (showBack ? " flipped" : "")}
                  disabled={busy && !run.revealed}
                  aria-pressed={showBack}
                  aria-label={showBack ? "翻回题目" : "翻面查看答案"}
                  onClick={flipCard}
                >
                  <div className="flip-inner">
                    <div className="flip-face flip-front" aria-hidden={showBack}>
                      <Markdown
                        links={false}
                        className={"flash-prompt" + (run.card.prompt.length > 90 ? " long" : "")}
                        text={run.card.prompt}
                      />
                      <span className="flip-label">
                        {run.revealed ? "点击看答案 · Space" : "点击翻面 · Space"}
                      </span>
                    </div>
                    <div className="flip-face flip-back" aria-hidden={!showBack}>
                      <Markdown links={false} className="flip-question" text={run.card.prompt} />
                      {run.solution ? (
                        <Markdown
                          links={false}
                          className={"flash-prompt" + ((run.solution.answer || "").length > 120 ? " long" : "")}
                          text={run.solution.answer}
                        />
                      ) : (
                        <div className="flash-prompt">
                          <span className="flip-loading" aria-label="正在载入答案" />
                        </div>
                      )}
                      <span className="flip-label">参考答案 · 再点翻回题目</span>
                    </div>
                  </div>
                </button>
                {run.card.kind === "open" && !run.revealed && (
                  <label className="response-label">
                    先组织你的回答
                    <textarea
                      rows={3}
                      value={response}
                      onChange={(e) => setResponse(e.target.value)}
                      placeholder="在脑中作答，或在这里写下思路（仅本轮临时草稿）"
                    />
                  </label>
                )}
                {run.revealed && !run.feedback && (
                  <div className="grading">
                    <p>{run.retry ? "本轮重练 · " : ""}对照答案，你掌握到了哪一步？</p>
                    <p className="muted">按数字键 0–5 评分</p>
                    <div>
                      {[
                        "完全忘记",
                        "答错",
                        "似曾相识",
                        "勉强答对",
                        "熟练",
                        "轻松掌握",
                      ].map((label, grade) => (
                        <button
                          className={
                            grade < 3 ? "grade low" : "grade high"
                          }
                          key={grade}
                          aria-keyshortcuts={String(grade)}
                          title={`快捷键 ${grade}：${label}`}
                          disabled={busy}
                          onClick={() =>
                            reviewAct("review.answer", { grade })
                          }
                        >
                          <strong>{grade}</strong>
                          <span>{label}</span>
                        </button>
                      ))}
                    </div>
                  </div>
                )}
              </>
            )}
            <ReviewToolbar
              run={run} busy={busy} expanded={run.revealed ? explain : hint}
              onToggleHelp={() => run.revealed ? setExplain(!explain) : setHint(!hint)}
              onAsk={askAboutCard} onImprove={improveCard} onSlay={slayCard} onReviewAction={reviewAct}
              thumbs={coachProps && run.mode !== "exam" && (
                <ThumbFeedback run={run} call={coachProps.call} canShortcut={coachProps.canShortcut} onSent={(r) => r.scheduled?.length && coachProps.onStatus()} />
              )}
            />
            {coachProps?.autoAdvance > 0 && (
              <>
                <div className="autopilot-bar" key={run.index} style={{ "--autopilot-ms": coachProps.autoAdvance + "ms" }} />
                <small className="autopilot-note">自动驾驶：马上进入下一题，点任意处或按键可停下</small>
              </>
            )}
            {hint && !run.revealed && (
              <div className="hint">
                <Icon>♧</Icon>
                <Markdown text={run.card.hint} />
              </div>
            )}
            {run.feedback && (
              <p className="next-due">
                {run.feedback.correct ? "✓ 已掌握" : "↻ 将继续巩固"} ·
                下次复习 {date(run.feedback.nextDue)}
                {run.feedback.retryQueued && <span> · 已追加到本轮队尾，稍后再练一次</span>}
              </p>
            )}
            {coachPanel && !coachProps.side && coachPanel}
            {explain && run.solution && (
              <div className="explanation">
                <h3>理解这道题</h3>
                <Markdown text={run.solution.explanation} />
                <h4>容易混淆的地方</h4>
                <Markdown text={run.solution.misconception} />
                {run.solution.rubric && (
                  <>
                    <h4>评分依据</h4>
                    <Markdown text={run.solution.rubric} />
                  </>
                )}
                <div className="citations">
                  {run.solution.citations?.map((c, i) => (
                    <button
                      key={i}
                      onClick={() =>
                        setModal({
                          type: "source",
                          source: data.sources.find(
                            (s) => s.id === c.sourceId,
                          ),
                          quote: c.quote,
                        })
                      }
                    >
                      ↗{" "}
                      {data.sources.find((s) => s.id === c.sourceId)
                        ?.title || "资料"}
                      <blockquote>{c.quote}</blockquote>
                    </button>
                  ))}
                </div>
              </div>
            )}
            <div className="teaching-panel">
              {run.feedback && data.modelReady && !teaching && (
                <button
                  disabled={busy}
                  onClick={() =>
                    act("teach.start", { runId: run.id }, setTeaching)
                  }
                >
                  逐步讲解 · 检查理解
                </button>
              )}
              {teaching && (
                <section className="explanation">
                  <div className="eyebrow">
                    GUIDED UNDERSTANDING ·{" "}
                    {Math.min(teaching.index + 1, teaching.total)} /{" "}
                    {teaching.total}
                  </div>
                  {teaching.feedback && (
                    <Markdown className="teaching-feedback" text={teaching.feedback} />
                  )}
                  {teaching.complete ? (
                    <>
                      <h3>把理解迁移到下一题</h3>
                      <Markdown text={teaching.transfer} />
                    </>
                  ) : (
                    <>
                      <Markdown text={teaching.lesson} />
                      <form
                        onSubmit={(e) => {
                          e.preventDefault();
                          act(
                            "teach.answer",
                            { id: teaching.id, answer: teachAnswer },
                            (next) => {
                              setTeaching(next);
                              setTeachAnswer("");
                            },
                          );
                        }}
                      >
                        <label>
                          <Markdown text={teaching.check} />
                          <textarea
                            required
                            maxLength={10000}
                            rows={3}
                            value={teachAnswer}
                            onChange={(e) =>
                              setTeachAnswer(e.target.value)
                            }
                          />
                        </label>
                        <button
                          className="primary"
                          disabled={busy || !teachAnswer.trim()}
                        >
                          检查理解 →
                        </button>
                      </form>
                    </>
                  )}
                </section>
              )}
            </div>
            <p className="keyboard-note">
              {choice ? "1–6 选择 · " : ""}Enter 下一题 · ← → 切换
              {!choice && !isCloze ? " · 空格翻卡" : ""} · H 提示 · G/B 反馈 · A 自动驾驶 · ? 全部快捷键
            </p>
          </div>
          {coachPanel && coachProps.side && coachPanel}
        </div>
      )}
    </section>
  );
}
