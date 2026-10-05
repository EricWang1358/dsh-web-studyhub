import React from "react";
import { ui, uiFormat, uiMessage } from "../i18n.js";
import { Button, Hint, Icon, InlineMessage, JobRow, useNow } from "../components/index.js";
import AgentLink from "../AgentLink.jsx";
import { dismissJobs, useQuickActions } from "../quick-actions.js";
import { formatElapsed, formatNumber, joinMeta } from "../format.js";
import { formatExactTokens, totalTokens } from "../../lib/token-usage.js";
import { STRENGTH_LABEL } from "../../lib/model-effort.js";
import { isActiveJob, isCancellable, JOB_STATUS, JOB_TYPES } from "../../lib/job-status.js";

/* The background audio imports as cards: phase, real progress, the model tasks behind them, what they cost, and what to do next.
   Shown in the add-source form, at the top of the sources page and in the reader. */

const PHASES = {
  queued: "排队中", read: "读取并切分音频", transcribe: "转写音频",
  proofread: "校对识别错误的词", translate: "翻译并整理成中英对照", batch: '按顺序整理逐字稿', assemble: '合成逐字稿', done: "完成",
};
const isActive = isActiveJob;
/** A failure that the audio settings can fix: offer the way there. */
export const aboutSettings = (message) => /设置|密钥|Settings|API key|\bkey\b/i.test(String(message || ""));

/** What a failed import already has saved, step by step: a retry does only the rest. */
const STEP_LABELS = [["transcribe", "转写"], ["proofread", "校对"], ["translate", "翻译"]];
const savedSteps = (steps) => STEP_LABELS.filter(([phase]) => steps?.[phase]?.total > 0)
  .map(([phase, label]) => uiFormat("{0} {1}/{2}", [ui(label), steps[phase].done, steps[phase].total])).join(" · ");

const requestsOf = (usage) => (usage?.free?.requests || 0) + (usage?.paid?.requests || 0); // Gemini requests; Groq and SiliconFlow have their own lines
/** How many proofread / translate windows run at once, and, when the model pushed back, that it was lowered (and came back). */
export function parallelNote(parallel) {
  if (!parallel || !(parallel.limit >= 1)) return '';
  if (parallel.effective < parallel.limit) return uiFormat('并行 {0}（已因限流从 {1} 降到 {0}）', [parallel.effective, parallel.limit]);
  if (parallel.lowest < parallel.limit) return uiFormat('并行 {0}（曾因限流降到 {1}，已恢复）', [parallel.effective, parallel.lowest]);
  return uiFormat('并行 {0}', [parallel.effective]);
}
const inTextSteps = (job) => ['proofread', 'translate'].includes(job.phase) || (job.members || []).some((member) => isActive(member) && ['proofread', 'translate'].includes(member.phase));
/** A recording that went on from a saved transcript did not ask the transcription provider again: say so, so "0 requests" is explained. */
export function reuseNote(steps) {
  const step = steps?.transcribe;
  if (!(step?.reused > 0)) return '';
  if (step.reused >= step.total) return ui('复用已保存的转写，没有向转写服务发请求');
  return uiFormat('复用已保存的转写 {0}/{1} 段，其余 {2} 段重新转写', [step.reused, step.total, step.total - step.reused]);
}
const roughly = (ms) => (ms < 45000 ? ui("不到 1 分钟") : uiFormat("约 {0} 分钟", [Math.max(1, Math.round(ms / 60000))]));

/** The work in the order it happens, and how much of the whole each part usually is. */
const ORDER = ["transcribe", "proofread", "translate"];
const WEIGHT = { transcribe: 0.25, proofread: 0.3, translate: 0.45 };
const TASK_KINDS = { transcribe: "转写", proofread: "校对", translate: "翻译", title: "生成标题" };
const TASK_STATUS = { starting: "启动中", running: "执行中", finishing: "结果已返回，正在结束子会话", complete: "已完成", failed: "失败", cancelled: "已取消", skipped: "已跳过" };
const RUNTIME = { subagent: "DSH 子代理", direct: "直接模型调用", gemini: "Gemini" };
const taskLabel = (task) => {
  const kind = ui(TASK_KINDS[task.kind] || task.stage || "");
  return task.parts ? uiFormat("{0} {1}/{2}", [kind, task.part, task.parts]) : kind;
};

/** Whether proofreading or translation actually ran for this job (or any member of a batch). */
export function textStepsRan(job = {}) {
  if (["proofread", "translate"].some((phase) => job.steps?.[phase]?.done > 0)) return true;
  if ((job.tasks || []).some((task) => ["proofread", "translate"].includes(task.kind) && task.status === "complete")) return true;
  return (job.members || []).some((member) => textStepsRan(member));
}

/**
 * Overall progress from the real step counts: each phase counts for its share of the work, and inside a phase it is
 * the segments finished out of the segments there are. `flight` is the share of the segment now being worked on,
 * which is shown as moving because no one can say how far along a single request is. `eta` is what is left of the
 * current phase at the pace of its finished segments (null until one has taken real time).
 */
export function audioProgress(job, now = Date.now()) {
  if (job.status === "complete") return { percent: 100, flight: 0, eta: null };
  // A review is one step: batches decided out of batches there are.
  if (job.review) return { percent: job.total > 0 ? Math.min(99, Math.floor(job.done / job.total * 100)) : 0,
    flight: isActive(job) && job.total > 0 ? Math.min(100 / job.total, 99) : 0, eta: null };
  if (job.members?.length) {
    const values = job.members.map(member => audioProgress(member, now));
    return { percent: Math.min(99, Math.floor(values.reduce((sum, value) => sum + value.percent, 0) / values.length)),
      flight: isActive(job) ? values.reduce((sum, value) => sum + value.flight, 0) / values.length : 0, eta: null };
  }
  const steps = job.steps || {}, reached = ORDER.indexOf(job.phase);
  let solid = 0;
  ORDER.forEach((phase, index) => {
    const step = steps[phase];
    solid += WEIGHT[phase] * (step?.total > 0 ? step.done / step.total : step || index < reached ? 1 : 0);
  });
  const percent = Math.min(99, Math.floor(solid * 100 + 1e-9));
  const step = steps[job.phase];
  if (!isActive(job) || !ORDER.includes(job.phase) || !(step?.total > 0) || step.done >= step.total) return { percent, flight: 0, eta: null };
  const pace = job.pace?.[job.phase], left = step.total - step.done;
  const eta = pace?.each ? Math.max(pace.each * 0.1, pace.each - Math.max(0, now - pace.at)) + pace.each * (left - 1) : null;
  return { percent, flight: Math.max(0, Math.min(WEIGHT[job.phase] / step.total * 100, 99 - percent)), eta };
}

/** The link to a sub-agent's session: drawn only when the host can open it (host.openAgent is absent otherwise) and the task has one. */
function OpenAgent({ task, openAgent }) {
  return <AgentLink childId={task.childId} parentId={task.parentId} openAgent={openAgent}
    ariaLabel={uiFormat('查看子代理：{0}', [taskLabel(task)])} label={ui("查看子代理")} />;
}

/**
 * What the reasoning setting did for one task, in plain words, or '' when it did exactly what was asked (or nothing was asked).
 * `reasoning` is the strength asked for; the model may have had no such level (lib/model-effort.js says which one it used instead).
 */
export function reasoningNote(task) {
  const wanted = task.reasoning;
  if (!wanted || wanted === 'default') return '';
  const asked = ui(STRENGTH_LABEL[wanted] || wanted);
  if (task.reasoningReason === 'nearest' && task.reasoningName) return uiFormat('推理强度：要求「{0}」，当前模型没有，已用「{1}」', [asked, task.reasoningName]);
  if (task.reasoningReason === 'unsupported' || (!task.reasoningReason && task.reasoningEffort === 'default'))
    return uiFormat('推理强度：要求「{0}」，当前模型没有可调档位，按模型默认', [asked]);
  return '';
}
/** How long a finished task took. */
const tookOf = (task) => (task.finishedAt ? formatElapsed(Date.parse(task.finishedAt) - Date.parse(task.startedAt)) : '');
/** What can be said about a task without opening the sub-agent: the size of its input, what it used, the start of its answer. */
function TaskDetail({ task }) {
  const tokens = task.tokenUsage ? totalTokens(task.tokenUsage) : 0;
  const rows = [task.inputChars > 0 && uiFormat('提示：约 {0} 字的稿件窗口', [formatNumber(task.inputChars)]),
    tokens > 0 && uiFormat('用量：{0} tok', [formatExactTokens(tokens)]),
    task.outputPreview && uiFormat('最近输出：{0}', [task.outputPreview])].filter(Boolean);
  return rows.length ? <details className="audio-task-detail"><summary>{ui('详情')}</summary>{rows.map((row, index) => <small key={index}>{row}</small>)}</details> : null;
}

const HISTORY_PAGE = 5;

function AudioTasks({ job, now, openAgent }) {
  const tasks = job.tasks || [];
  const active = isActive(job) ? tasks.filter(task => !task.finishedAt && ['starting', 'running', 'finishing'].includes(task.status)) : [];
  const history = tasks.filter(task => !active.includes(task)).reverse();
  const [shown, setShown] = React.useState(HISTORY_PAGE);
  // What every row of the history would say again is said once, quietly, above the list.
  const notes = [...new Set(history.map(task => task.note).filter(Boolean))];
  const common = notes.length === 1 && history.filter(task => task.note).length === history.length ? notes[0] : '';
  const runtimes = [...new Set(history.map(task => task.runtime).filter(Boolean))];
  const sameRuntime = runtimes.length === 1 ? runtimes[0] : '';
  const visible = history.slice(0, shown), more = history.length - visible.length;
  return <>
    {active.length > 0 && <div className="audio-active-tasks">
      <small>{uiFormat('正在执行 {0} 个任务', [active.length])}</small>
      {active.map(task => <small className="audio-now" key={task.id}>
        {joinMeta([uiFormat('正在做：{0}', [taskLabel(task)]), ui(RUNTIME[task.runtime] || ''), ui(TASK_STATUS[task.status] || task.status),
          uiFormat('已等待 {0}', [formatElapsed(now - Date.parse(task.startedAt))]),
          task.inputChars > 0 ? uiFormat('输入约 {0} 字', [formatNumber(task.inputChars)]) : ''])}
        <OpenAgent task={task} openAgent={openAgent} />
      </small>)}
    </div>}
    {history.length > 0 && <details className="generation-trace audio-trace">
      <summary>{uiFormat('查看历史任务 · {0} 次模型任务', [history.length])}</summary>
      {(common || sameRuntime) && <Hint as="p" size="xs" className="audio-trace-note">{joinMeta([sameRuntime ? uiFormat('都由「{0}」完成', [ui(RUNTIME[sameRuntime] || sameRuntime)]) : '', common ? ui(common) : ''])}</Hint>}
      <ol>{visible.map(task => <li key={task.id}>
        <span className="audio-trace-line">{joinMeta([taskLabel(task), ui(TASK_STATUS[task.status] || task.status), sameRuntime ? '' : ui(RUNTIME[task.runtime] || ''), tookOf(task),
          reasoningNote(task), task.note && task.note !== common ? ui(task.note) : ''])}</span>
        <OpenAgent task={task} openAgent={openAgent} />
        <TaskDetail task={task} />
      </li>)}</ol>
      {history.length > HISTORY_PAGE && <Button variant="link" size="sm" onClick={() => setShown(more > 0 ? history.length : HISTORY_PAGE)}>
        {more > 0 ? uiFormat('再显示 {0} 条', [more]) : ui('收起')}</Button>}
    </details>}
  </>;
}

/** One batch member's state in words: why it has not started, or how far it is. */
function memberState(member, jobActive, now) {
  if (member.status === 'blocked') return { text: uiFormat('未通过预检：{0}', [uiMessage(member.stage || '')]), reason: true };
  if (member.status === 'waiting') return { text: uiFormat('因「{0}」未通过预检尚未开始', [member.waitingFor || '']), reason: true };
  if (member.status === 'queued' && !jobActive) return { text: ui('未开始') };
  return { text: <>{ui(TASK_STATUS[member.status] || PHASES[member.phase] || '排队中')}
    {isActive(member) && member.phase !== 'queued' ? ` · ${ui(PHASES[member.phase] || '处理中')} · ${audioProgress(member, now).percent}%` : ''}
    {member.status === 'failed' ? ` · ${member.stage || ''}` : ''}</> };
}

function AudioJob({ job, busy, act, openAgent, onOpenSources, onLegacyRetry, onOpenSettings }) {
  const quick = useQuickActions(), dismissFailure = quick?.failures[job.id];
  // The length of the recording is not how long the work takes: show how long it has actually taken.
  const running = isActive(job), now = useNow(1000, { enabled: running });
  const took = job.startedAt && job.status !== "queued" ? (running ? now : Date.parse(job.finishedAt || job.startedAt)) - Date.parse(job.startedAt) : null;
  const counted = ORDER.includes(job.phase) && job.total > 0;
  const progress = audioProgress(job, now);
  const usage = job.usage;
  const paidUsed = usage?.paid.requests > 0;
  const held = job.status === "failed" && job.blocked && job.members?.length > 0;
  const title = job.review
    ? job.status === "complete" ? uiFormat("复核完成：改进正稿 {0} 处 · 判定原文无误 {1} 处 · 仍拿不准 {2} 处", [job.review.applied, job.review.rejected, job.review.unsure])
      : job.status === "failed" ? ui("复核未完成；已复核的部分已保存")
        : job.status === "cancelled" ? ui("复核已取消；已复核的部分已保存")
          : job.status === JOB_STATUS.CANCELLING ? ui("正在停止")
            : job.total > 0 ? uiFormat("复核存疑处（{0}/{1}）", [Math.min(job.done + 1, job.total), job.total]) : ui("复核存疑处")
    : job.status === "complete"
    ? job.reused ? ui("已导入过，直接复用") : uiFormat("已存为 {0} 份资料 · 校对修正 {1} 处", [job.sourceIds?.length ?? 0, job.corrected ?? 0])
    : held ? ui("有文件没通过预检，这一批还没开始")
      : job.status === "failed" ? ui("导入未完成")
      : job.status === "cancelled" ? ui("导入已取消")
        : job.status === JOB_STATUS.CANCELLING ? ui("正在停止")
          : counted ? uiFormat("{0}（{1}/{2}）", [ui(PHASES[job.phase]), Math.min(job.done + 1, job.total), job.total]) : ui(PHASES[job.phase] || "处理中");
  const order = job.review ? [] : job.subtitle ? ORDER.filter(phase => phase !== "transcribe") : ORDER;
  const meta = <>{joinMeta([title, job.minutes ? uiFormat("录音时长 {0} 分钟", [job.minutes]) : "",
    took !== null && (running || job.finishedAt) && !held ? uiFormat(running ? "已用 {0}" : "用时 {0}", [formatElapsed(took)]) : ""])}</>;
  const progressed = running && job.phase !== "queued";
  const retry = (args) => () => act("audio.retry", { jobId: job.id, ...args });
  const actions = [
    ...(isCancellable(job) ? [{ key: "stop", label: ui("停止（已转写的部分会保留）"), disabled: busy, onClick: () => act("job.cancel", { jobId: job.id }) }] : []),
    ...(held && job.retryable ? [
      { key: "skip", label: ui("跳过此文件继续"), variant: "primary", disabled: busy, onClick: retry({ skip: [job.blocked.index] }) },
      { key: "fix", label: ui("修复后继续"), disabled: busy, title: ui("修好这个文件或音频设置后，从头再检查一遍；已完成的部分不会重复付费"), onClick: retry({}) },
    ] : []),
    ...(!held && ["failed", "cancelled"].includes(job.status) && job.retryable ? [{ key: "retry", label: ui("接着做（不重复付费）"), variant: "primary", disabled: busy,
      title: ui("已转写、校对、翻译好的部分会直接复用，不会重复付费；也不用重新选文件"), onClick: retry({}) }] : []),
    ...(job.status === "complete" && job.sourceIds?.length > 0 && onOpenSources ? [{ key: "open", label: ui("打开逐字稿"), variant: "link", onClick: () => onOpenSources(job.sourceIds) }] : []),
    ...(job.legacy && onLegacyRetry ? [{ key: "legacy", label: ui("重新选择原录音继续"), variant: "primary", disabled: busy, onClick: () => onLegacyRetry(job) }] : []),
  ];
  const failure = job.status === "failed" ? { hint: <>{job.stage}
    {onOpenSettings && aboutSettings(job.stage) && <> <Button variant="link" size="sm" onClick={onOpenSettings}>{ui('打开音频设置')}</Button></>}</> } : null;
  const stage = job.status === JOB_STATUS.CANCELLING ? ui("正在停止") : running ? ui(PHASES[job.phase] || "处理中") : undefined;
  return (
    <JobRow status={job.status === JOB_STATUS.CANCELLING ? "running" : job.status} stage={stage} title={job.filename} meta={meta}
      leaving={job.leaving} actions={actions} failure={failure} data-job-id={job.id}
      onDismiss={!isActive(job) ? () => quick ? dismissJobs(quick, job.id) : act("job.dismiss", { jobId: job.id }) : undefined}
      progress={progressed ? { value: progress.percent, max: 100, ahead: progress.flight, label: uiFormat("{0} 的总进度", [job.filename]),
        title: ui("总进度按步骤估算：转写 25% · 校对 30% · 翻译 45%；每一步里按已完成的段数计算。"),
        summary: <>
          <strong>{progress.percent}%</strong>
          {job.members ? <small>{uiFormat('已完成 {0}/{1} 段音频', [job.members.filter(member => member.status === 'complete').length, job.members.filter(member => member.status !== 'skipped').length])}</small> : <ol className="sh-job__steps">{order.map((phase) => {
            const step = job.steps?.[phase], state = step?.total > 0 && step.done >= step.total ? "done" : job.phase === phase ? "current" : "todo";
            return <li key={phase} className={"is-" + state}>{state === "done" && <Icon name="check" size={14} />}{ui(TASK_KINDS[phase])}
              {step?.total > 0 ? uiFormat(" 已完成 {0}/{1}", [step.done, step.total]) : ""}</li>;
          })}</ol>}
        </> } : undefined}>
      {progressed && (progress.eta !== null
        ? <Hint as="small">{uiFormat("本步骤预计还需{0}", [roughly(progress.eta)])}</Hint>
        : job.phase === "transcribe" && <Hint as="small">{ui("转写要等服务商处理完整段录音，长录音需要几分钟，不是卡住了；上面的「已用」时间在走。")}</Hint>)}
      {!job.members && reuseNote(job.steps) && <Hint as="small">{reuseNote(job.steps)}</Hint>}
      {running && job.parallel?.text && inTextSteps(job) && <Hint as="small">{parallelNote(job.parallel.text)}</Hint>}
      {job.members?.length > 0 && <ol className="audio-members">{job.members.map((member, index) => {
        const state = memberState(member, running, now);
        return <li key={index}>
          <strong>{member.filename}</strong><small className={state.reason ? 'audio-member-reason' : undefined}>{state.text}</small>
          {ORDER.filter(phase => member.steps?.[phase]?.total > 0).map(phase => <small key={phase}>
            {ui(TASK_KINDS[phase])}{uiFormat(' 已完成 {0}/{1}', [member.steps[phase].done, member.steps[phase].total])}</small>)}
          {reuseNote(member.steps) && <Hint as="small">{reuseNote(member.steps)}</Hint>}
          <AudioTasks job={member} now={now} openAgent={openAgent} />
        </li>;
      })}</ol>}
      {["failed", "cancelled"].includes(job.status) && savedSteps(job.steps) && <small>{uiFormat("已保存：{0}", [savedSteps(job.steps)])}</small>}
      {job.status === "complete" && !job.reused && job.uncertain > 0 && (
        <small>{uiFormat("另有 {0} 处把握不大的疑似错词没有改，可在资料里查看", [job.uncertain])}
          {job.sourceIds?.length > 0 && onOpenSources && <Button variant="link" size="sm" onClick={() => onOpenSources(job.sourceIds.slice(0, 1))}>{ui("去复核")}</Button>}</small>
      )}
      {requestsOf(usage) > 0 && (
        <small>
          {joinMeta([uiFormat("Gemini 请求（这份录音累计，含之前的尝试）：免费 {0} 次 · 付费 {1} 次", [usage.free.requests, usage.paid.requests]),
            paidUsed && usage.estimatedPaidTranscribeUsd > 0 ? uiFormat("转写付费部分约 ${0}", [usage.estimatedPaidTranscribeUsd]) : ""])}
        </small>
      )}
      {usage?.siliconflow?.requests > 0 && (
        <small>{uiFormat("硅基流动请求（免费，这份录音累计）：{0} 次", [usage.siliconflow.requests])}</small>
      )}
      {usage?.groq?.requests > 0 && (
        <small>{uiFormat("Groq 请求（免费额度，这份录音累计）：{0} 次", [usage.groq.requests])}</small>
      )}
      {usage && job.usageRun && requestsOf(job.usageRun) !== requestsOf(usage) && (
        <Hint as="small">{requestsOf(job.usageRun) === 0
          ? ui("这次没有新发 Gemini 请求：已保存的转写等结果直接复用了")
          : uiFormat("其中本次：免费 {0} 次 · 付费 {1} 次", [job.usageRun.free.requests, job.usageRun.paid.requests])}</Hint>
      )}
      {usage && job.textProvider === "host" && textStepsRan(job) && <Hint as="small">{ui("校对和翻译由 DSH 的模型完成，不在上面的 Gemini 次数里")}</Hint>}
      {isActive(job) && !job.reused && job.estimatedUsd > 0 && (
        <small>{uiFormat("若全部走付费密钥，转写约 ${0}", [job.estimatedUsd])}</small>
      )}
      {(job.warnings || []).map((warning) => <InlineMessage tone="warning" key={warning}>{warning}</InlineMessage>)}
      <AudioTasks job={job} now={now} openAgent={openAgent} />
      {dismissFailure && <InlineMessage tone="error">{uiFormat("没能移除这条记录：{0}", [dismissFailure])}</InlineMessage>}
    </JobRow>
  );
}

/** Progress and results of audio imports; shown in the add-source form and at the top of the sources page. */
export function AudioJobs({ data, busy, act, openAgent, onOpenSources, onLegacyRetry, onOpenSettings }) {
  const jobs = (data.jobs || []).filter((job) => job.type === JOB_TYPES.AUDIO_IMPORT);
  return jobs.length ? <div className="jobs audio-jobs sh-job-list">{jobs.map((job) => <AudioJob key={job.id} job={job} busy={busy} act={act} openAgent={openAgent}
    onOpenSources={onOpenSources} onLegacyRetry={onLegacyRetry} onOpenSettings={onOpenSettings} />)}</div> : null;
}
