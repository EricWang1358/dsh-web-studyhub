import React from "react";
import { ui, uiFormat } from "../i18n.js";
import Markdown from "../Markdown.jsx";
import CitationDisclosure from "../CitationDisclosure.jsx";
import { ReadingBlock } from "../reading-settings/ReadingSettings.jsx";
import { Button, ProgressBar } from "../components/index.js";
import { useStudy } from "../study-context.jsx";
import { LazySimilarTry } from "./LazyLearningLoop.jsx";
import TeachingStatus from "./TeachingStatus.jsx";

const CALCULATION_STAGE_LABELS = {
  conditions: "已知条件与未知量",
  formula: "公式与适用理由",
  substitution: "代入与单位",
  computation: "中间计算",
  verification: "结果检查与舍入",
};

/** Step-by-step guided understanding / calculation panel extracted from QuestionRun. */
export default function TeachingPanel({ session, data, model, onModelSettings }) {
  const { openModal } = useStudy();
  const { entry, teachingBusy, teachingAction, teachingError, actions } = session;
  const { teaching, teachAnswer } = entry;
  const stepKey = teaching && !teaching.complete ? `${teaching.id}:${teaching.index}` : "";
  const prevStepRef = React.useRef(stepKey);
  const inputRef = React.useRef(null);

  React.useEffect(() => {
    const prev = prevStepRef.current;
    prevStepRef.current = stepKey;
    if (stepKey && stepKey !== prev) {
      requestAnimationFrame(() => inputRef.current?.focus({ preventScroll: true }));
    }
  }, [stepKey]);

  if (!teaching) return null;

  const submitStep = () => {
    if (teachingBusy || !teachAnswer.trim()) return;
    actions.teachingAct("teach.answer", { id: teaching.id, stepIndex: teaching.index, answer: teachAnswer });
  };
  const skipStep = (all = false) => {
    if (teachingBusy) return;
    actions.teachingAct("teach.skip", { id: teaching.id, stepIndex: teaching.index, ...(all ? { all: true } : {}) });
  };
  const skippedSteps = Array.isArray(teaching.skippedSteps) ? teaching.skippedSteps : [];
  const wrongTries = Number.isInteger(teaching.wrongTries) ? teaching.wrongTries : 0;

  return (
    <div className="teaching-panel">
      <ReadingBlock as="section" measure className="explanation">
        <div className="eyebrow">
          {uiFormat("{0} · {1} / {2}", [teaching.mode === "calculation" ? ui("计算题引导练习") : ui("逐步理解"), Math.min(teaching.index + 1, teaching.total), teaching.total])}
          {skippedSteps.length > 0 ? ` · ${uiFormat("已跳过 {0} 步", [skippedSteps.length])}` : ""}
        </div>
        <ProgressBar className="teaching-progress" size="sm" value={teaching.index} max={teaching.total}
          label={teaching.mode === "calculation" ? ui("计算题引导练习") : ui("逐步理解")} />
        {teaching.mode === "calculation" && <p className="muted small">{ui("每次只练当前步骤。AI 反馈用于辅助学习，不能证明计算正确。")}</p>}
        {teaching.feedback && <Markdown className="teaching-feedback" text={teaching.feedback} />}
        {teaching.complete ? (
          <>
            <h3>{ui("把理解迁移到下一题")}</h3>
            <Markdown text={teaching.transfer} />
            {skippedSteps.length > 0 && (
              <div className="teaching-skipped-summary">
                <p className="muted small">{uiFormat("已跳过 {0} 步（不计为已掌握，可回头再看）：", [skippedSteps.length])}</p>
                <ul>
                  {skippedSteps.map((item) => (
                    <li key={item.index}>{uiFormat("第 {0} 步：{1}", [(item.index ?? 0) + 1, item.lesson || ""])}</li>
                  ))}
                </ul>
              </div>
            )}
            <LazySimilarTry session={session} data={data} model={model} onModelSettings={onModelSettings} />
          </>
        ) : (
          <>
            {teaching.mode === "calculation" && <h3>{ui(CALCULATION_STAGE_LABELS[teaching.stage] || "计算题引导练习")}</h3>}
            <Markdown text={teaching.lesson} />
            {teaching.mode === "calculation" && (
              <>
                <dl className="teaching-context">
                  <div><dt>{ui("本步假设")}</dt><dd><Markdown text={teaching.assumptions} /></dd></div>
                  <div><dt>{ui("本步单位")}</dt><dd><Markdown text={teaching.units} /></dd></div>
                  <div><dt>{ui("精度与舍入")}</dt><dd><Markdown text={teaching.rounding} /></dd></div>
                </dl>
                <CitationDisclosure card={teaching} sources={data.sources}
                  onOpenSource={(source, quote, peekPage) => openModal({ type: "source", source, quote, peekPage, back: true })} />
              </>
            )}
            {wrongTries >= 2 && (
              <p className="muted small teaching-wrong-nudge">{ui("连续答错两次了，可以看要点并继续：点击「跳过这一步」或「剩下的直接讲给我听」。")}</p>
            )}
            <form onSubmit={(e) => { e.preventDefault(); submitStep(); }}>
              <label className="teaching-panel__field">
                <Markdown text={teaching.check} />
                <textarea
                  ref={inputRef}
                  required
                  maxLength={10000}
                  rows={3}
                  aria-label={ui("当前步骤的回答")}
                  value={teachAnswer}
                  onChange={(e) => actions.setTeachAnswer(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.nativeEvent?.isComposing || e.isComposing || e.keyCode === 229) return;
                    if ((e.ctrlKey || e.metaKey) && e.key === "Enter" && !e.shiftKey && !e.altKey) {
                      e.preventDefault();
                      submitStep();
                    }
                  }}
                />
              </label>
              <div className="teaching-panel__actions">
                <Button className="teaching-panel__submit" variant="secondary" size="sm"
                  busy={teachingBusy && teachingAction === "teach.answer"} busyLabel={ui("正在检查…")}
                  disabled={teachingBusy || !teachAnswer.trim()}
                  onPointerUp={(e) => e.currentTarget.closest(".study-app")?.focus({ preventScroll: true })} type="submit">{ui("检查理解")}</Button>
                <Button className="teaching-panel__skip" variant="ghost" size="sm" disabled={teachingBusy}
                  onClick={() => skipStep(false)} type="button">{ui("跳过这一步")}</Button>
                <Button className="teaching-panel__skip-all" variant="ghost" size="sm" disabled={teachingBusy}
                  onClick={() => skipStep(true)} type="button">{ui("剩下的直接讲给我听")}</Button>
              </div>
            </form>
          </>
        )}
        <TeachingStatus busy={teachingBusy} failure={teachingError} onCancel={actions.cancelTeaching} onRetry={actions.retryTeaching} />
      </ReadingBlock>
    </div>
  );
}
