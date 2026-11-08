import React, { useEffect, useRef, useState } from "react";
import { ui, uiFormat } from "./i18n.js";
import Markdown from "./Markdown.jsx";
import { Badge, Button, Disclosure, Field, InlineMessage, TextInput, Tooltip } from "./components/index.js";
import { handOffTip, useHandOff } from "./hand-off/use-hand-off.js";
import { useStudy } from "./study-context.jsx";
import { useInjectCss } from "./shared.js";
import css from "./task-card.css";

function checkStatusOf(item) {
  if (item?.status === "satisfied" || item?.status === "missing" || item?.status === "issue") return item.status;
  const awarded = Number(item?.awarded) || 0, max = Number(item?.max) || 0;
  if (max > 0 && awarded >= max) return "satisfied";
  if (awarded <= 0) return "missing";
  return "issue";
}

function StatusBadge({ status, line }) {
  if (status === "satisfied") return <Badge size="sm" tone="success">{ui("满足")}</Badge>;
  if (status === "missing") return <Badge size="sm" tone="warning">{ui("缺失")}</Badge>;
  const hasLine = (Number.isInteger(line) && line > 0) || (typeof line === "string" && line.trim() !== "");
  return (
    <Badge size="sm" tone="error">
      {hasLine ? uiFormat("有问题（第 {0} 行）", [line]) : ui("有问题")}
    </Badge>
  );
}

function TaskReferenceSolution({ solution, enOn, enAnswer, viewedBeforeAnswer = false }) {
  if (!solution?.answer) return null;
  return (
    <div className="task-run__reference" data-testid="task-reference-solution">
      {viewedBeforeAnswer && (
        <p className="task-run__reference-note">
          {ui("本次作答已记录为「看过答案」，不计入独立完成。")}
        </p>
      )}
      <div className="task-run__section-head">
        <span className="task-run__section-title">{ui("参考实现")}</span>
      </div>
      <Markdown text={solution.answer} />
      {enOn && enAnswer?.answer && (
        <div className="en-block">
          <Badge size="sm" tone="accent" className="en-mark">EN</Badge>
          <Markdown links={false} className="md-compact" text={enAnswer.answer} />
        </div>
      )}
    </div>
  );
}

/**
 * Practice body for `kind: 'task'` (动手任务, #778): universal across disciplines, no in-app code editor, never runs tests.
 * Supports main-chat static evaluation (`task.check` -> `card.grade`), folded reference solution tracking (`看过答案`),
 * honest self-report fallback (`自报，未验收`), and FSRS due reminder (`不看答案重写一遍`).
 */
export default function TaskCardRun({
  run,
  data,
  value = "",
  onChange,
  onReveal,
  onSelfReport,
  enOn = false,
  enStem = null,
  enAnswer = null,
}) {
  useInjectCss(css, "study-task-card");
  const { busy } = useStudy();
  const { send } = useHandOff();
  const [sending, setSending] = useState(false);
  const flight = useRef(false);
  const [referenceOpen, setReferenceOpen] = useState(() => !!run?.revealed && !run?.feedback);

  const card = run.card;
  const feedback = run.feedback;
  const taskCheck = feedback?.taskCheck || null;
  const rubric = feedback?.rubric || null;
  const selfReported = !!(feedback?.selfReported || feedback?.assessment === "self-report");
  const viewedBeforeAnswer = !!(
    run.assistance?.revealedBeforeAnswer ||
    feedback?.revealedBeforeAnswer ||
    (run.revealed && !feedback)
  );
  const deckTitle = data?.decks?.find((deck) => deck.id === run.deckId)?.title || "";
  const marks = Number(card.marks) || 0;
  const trimmedInput = String(value ?? "").trim();
  const previousFiles = Array.isArray(taskCheck?.files) ? taskCheck.files.join(", ") : "";

  useEffect(() => {
    setReferenceOpen(!!run?.revealed && !run?.feedback);
  }, [run?.id, run?.index, card?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleCheckInMainChat = async () => {
    if (flight.current) return;
    flight.current = true;
    setSending(true);
    try {
      await send("task.check", {
        deckId: run.deckId,
        cardId: card.id,
        runId: run.id,
        deckTitle,
        topic: card.topic || "",
        prompt: card.prompt || "",
        rubric: card.rubric || "",
        rubricCriteria: Array.isArray(card.rubricCriteria) ? card.rubricCriteria : [],
        filePath: trimmedInput || previousFiles,
      });
    } finally {
      flight.current = false;
      setSending(false);
    }
  };

  const handleViewReference = async () => {
    if (run.revealed) {
      setReferenceOpen((open) => !open);
      return;
    }
    setReferenceOpen(true);
    await onReveal?.();
  };

  const rawChecks = Array.isArray(taskCheck?.checks) && taskCheck.checks.length
    ? taskCheck.checks
    : Array.isArray(rubric?.criteria) ? rubric.criteria : [];
  const checks = rawChecks.map((item, idx) => ({
    id: item.id || `c${idx + 1}`,
    label: item.label || item.id || `c${idx + 1}`,
    status: checkStatusOf(item),
    line: (Number.isInteger(item.line) && item.line > 0) || (typeof item.line === "string" && item.line.trim() !== "") ? item.line : null,
    feedback: item.detail || item.feedback || item.reason || "",
    evidence: item.evidence || item.quote || "",
  }));
  const satisfiedCount = checks.filter((item) => item.status === "satisfied").length;
  const missingCount = checks.filter((item) => item.status === "missing").length;
  const issueCount = checks.filter((item) => item.status === "issue").length;
  const allSatisfied = checks.length > 0 && satisfiedCount === checks.length;
  const lastAttempt = !feedback ? run.lastTaskAttempt : null;

  return (
    <div className="task-run" data-testid="task-card-run" data-tour="task-practice">
      <div className="question" role="heading" aria-level={2}>
        <Markdown text={card.prompt} />
        {enOn && enStem?.prompt && (
          <div className="en-block">
            <Badge size="sm" tone="accent" className="en-mark">EN</Badge>
            <Markdown links={false} className="md-compact" text={enStem.prompt} />
          </div>
        )}
      </div>

      <div className="task-run__meta">
        <Badge size="sm">{ui("动手任务")}</Badge>
        {marks > 0 && <Badge size="sm">{uiFormat("{0} 分", [marks])}</Badge>}
        {viewedBeforeAnswer && (
          <Badge size="sm" tone="warning" data-testid="task-viewed-solution">
            {ui("看过答案")}
          </Badge>
        )}
        {lastAttempt && (lastAttempt.selfReported || lastAttempt.unverified || lastAttempt.assessment === "self-report") && (
          <Badge size="sm" tone="warning" data-testid="task-last-self-report">
            {ui("上次记录：自报，未验收")}
          </Badge>
        )}
        {!lastAttempt?.selfReported && run.lastRubric && !feedback && (
          <Badge size="sm" data-testid="task-last-rubric">
            {uiFormat("上次验收 {0}/{1} 分", [run.lastRubric.total, run.lastRubric.max])}
          </Badge>
        )}
        {lastAttempt?.revealedBeforeAnswer && (
          <Badge size="sm">{ui("上次看过答案")}</Badge>
        )}
      </div>

      {run.dueReview && !feedback && (
        <InlineMessage tone="info" className="task-run__due-tip" data-testid="task-due-reminder">
          {ui("不看答案重写一遍")}
        </InlineMessage>
      )}

      {(card.rubricCriteria?.length > 0 || card.rubric) && (
        <section className="task-run__criteria" aria-label={ui("验收标准")}>
          <div className="task-run__section-head">
            <span className="task-run__section-title">{ui("验收标准")}</span>
            <span className="task-run__section-sub">{ui("对照完成，不在应用内运行测试")}</span>
          </div>
          {card.rubricCriteria?.length > 0 ? (
            <ol className="task-run__criteria-list">
              {card.rubricCriteria.map((criterion) => (
                <li key={criterion.id} className="task-run__criterion">
                  <div className="task-run__criterion-top">
                    <span className="task-run__criterion-label">{criterion.label}</span>
                    {Number(criterion.marks) > 0 && (
                      <span className="task-run__criterion-marks">{uiFormat("{0} 分", [criterion.marks])}</span>
                    )}
                  </div>
                  {criterion.descriptor && (
                    <div className="task-run__criterion-desc">
                      <Markdown links={false} className="md-compact" text={criterion.descriptor} />
                    </div>
                  )}
                </li>
              ))}
            </ol>
          ) : (
            <div className="task-run__rubric-body">
              <Markdown links={false} className="md-compact" text={card.rubric} />
            </div>
          )}
        </section>
      )}

      {!feedback ? (
        <div className="task-run__workspace">
          <Field
            label={ui("文件路径或补充说明（可选）")}
            hint={ui("主会话只读你指定的文件，不扫整个仓库、不跑测试，最多指出 3 处问题，也不会替你改文件。")}
            width="full"
          >
            <TextInput
              value={value}
              maxLength={500}
              readOnly={sending}
              data-testid="task-file-input"
              placeholder={ui("例如：src/stock.lua、queries.sql、proof.md（也可切到主会话再选文件）")}
              onChange={(event) => onChange?.(event.target.value)}
            />
          </Field>
          <div className="task-run__actions">
            <Tooltip layer content={handOffTip("让主会话只读你指定的文件，按验收标准逐条静态检查并把结果写回这张卡")}>
              <Button
                variant="primary"
                data-testid="task-check-main-chat"
                data-hand-off="task.check"
                busy={sending}
                lock={busy}
                onClick={handleCheckInMainChat}
              >
                {ui("在主会话里检查")}
              </Button>
            </Tooltip>
            <Button
              variant="secondary"
              data-testid="task-view-reference"
              lock={busy}
              onClick={handleViewReference}
            >
              {run.revealed && referenceOpen ? ui("收起参考实现") : ui("看参考实现")}
            </Button>
            <Button
              variant="quiet"
              data-testid="task-self-report"
              lock={busy}
              onClick={() => onSelfReport?.(trimmedInput)}
            >
              {ui("写完了（自报）")}
            </Button>
          </div>
          {run.revealed && referenceOpen && run.solution && (
            <TaskReferenceSolution
              solution={run.solution}
              enOn={enOn}
              enAnswer={enAnswer}
              viewedBeforeAnswer
            />
          )}
        </div>
      ) : (
        <>
          {checks.length > 0 && !selfReported && (
            <section className="task-run__result" data-testid="task-static-result" aria-label={ui("静态验收结果")}>
              <div className="task-run__result-head">
                <Badge size="sm" tone={allSatisfied ? "success" : feedback.grade >= 3 ? "warning" : "error"}>
                  {allSatisfied ? ui("静态检查通过") : ui("静态检查反馈")}
                </Badge>
                <span className="task-run__result-counts">
                  {uiFormat("满足 {0} · 缺失 {1} · 有问题 {2}", [satisfiedCount, missingCount, issueCount])}
                </span>
                {rubric?.max > 0 && (
                  <Badge size="sm">{uiFormat("{0}/{1} 分", [rubric.total, rubric.max])}</Badge>
                )}
              </div>
              {taskCheck?.files?.length > 0 && (
                <p className="task-run__files">
                  {uiFormat("检查文件：{0}", [taskCheck.files.join(", ")])}
                </p>
              )}
              <ul className="task-run__checks">
                {checks.map((item) => (
                  <li key={item.id} className="task-run__check" data-status={item.status} data-testid={`task-check-${item.id}`}>
                    <div className="task-run__check-head">
                      <StatusBadge status={item.status} line={item.line} />
                      <span className="task-run__check-label">{item.label}</span>
                    </div>
                    {item.feedback && <p className="task-run__check-feedback">{item.feedback}</p>}
                    {item.evidence && <blockquote className="task-run__evidence">{item.evidence}</blockquote>}
                  </li>
                ))}
              </ul>
              {taskCheck?.issuesTruncated && (
                <p className="task-run__cap-note" data-testid="task-issues-truncated">
                  {uiFormat("按最多指出 3 处具体问题的规则，其余 {0} 处问题已省略，先改好上面这几处再复查。", [
                    taskCheck.omittedIssueCount || Math.max(1, (taskCheck.totalIssuesFound || 0) - (taskCheck.issueCount || 0)),
                  ])}
                </p>
              )}
              {(taskCheck?.summary || rubric?.summary) && (
                <p className="task-run__summary">{taskCheck?.summary || rubric?.summary}</p>
              )}
            </section>
          )}

          {selfReported && (
            <section className="task-run__self-report" data-testid="task-self-report-feedback" aria-label={ui("自报记录")}>
              <div className="task-run__self-report-head">
                <Badge size="sm" tone="warning">{ui("自报，未验收")}</Badge>
              </div>
              <p className="task-run__self-report-text">
                {ui("本次记录为「自报，未验收」，已排入后续间隔复习，不计入 AI 静态验收通过。想补做验收也可以发给主会话检查。")}
              </p>
            </section>
          )}

          <div className="task-run__workspace task-run__workspace--followup">
            <Field
              label={ui("文件路径或补充说明（可选）")}
              hint={ui("主会话只读你指定的文件，不扫整个仓库、不跑测试，最多指出 3 处问题，也不会替你改文件。")}
              width="full"
            >
              <TextInput
                value={value}
                maxLength={500}
                readOnly={sending}
                data-testid="task-file-input"
                placeholder={previousFiles || ui("例如：src/stock.lua、queries.sql、proof.md（也可切到主会话再选文件）")}
                onChange={(event) => onChange?.(event.target.value)}
              />
            </Field>
            <div className="task-run__actions">
              <Tooltip layer content={handOffTip("让主会话只读你指定的文件，按验收标准逐条静态检查并把结果写回这张卡")}>
                <Button
                  variant={!allSatisfied ? "primary" : "secondary"}
                  size={!allSatisfied ? undefined : "sm"}
                  data-testid="task-check-main-chat"
                  data-hand-off="task.check"
                  busy={sending}
                  lock={busy}
                  onClick={handleCheckInMainChat}
                >
                  {selfReported ? ui("在主会话里检查") : ui("重新在主会话里检查")}
                </Button>
              </Tooltip>
              {!run.revealed && (
                <Button
                  variant="secondary"
                  size={!allSatisfied ? undefined : "sm"}
                  data-testid="task-view-reference"
                  lock={busy}
                  onClick={handleViewReference}
                >
                  {ui("看参考实现")}
                </Button>
              )}
            </div>
          </div>

          {run.revealed && run.solution?.answer && (
            <Disclosure className="task-run__solution-fold" summary={ui("参考实现")} defaultOpen={referenceOpen}>
              <TaskReferenceSolution
                solution={run.solution}
                enOn={enOn}
                enAnswer={enAnswer}
                viewedBeforeAnswer={viewedBeforeAnswer}
              />
            </Disclosure>
          )}
        </>
      )}
    </div>
  );
}
