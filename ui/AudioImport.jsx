import { getUiLanguage, ui, uiFormat, uiLocale, uiMessage, useUiLanguage } from "./i18n.js";
import React, { useEffect, useRef, useState } from "react";
import CourseField, { parseCourses } from './CourseField.jsx';
import { Button, FileDrop, InlineMessage } from './components/index.js';
import { AudioSetupGate, requestAudioSettingsFocus } from './AudioSettings.jsx';
import { useInjectCss } from './shared.js';
import { TokenEstimate } from './TokenUsage.jsx';
import { dismissJobs, useQuickActions } from './quick-actions.js';
import settingsCss from './audio-settings.css';

/* 音频导入：录音 → 转写 → 校对识别错误的词 → 中英对照逐字稿，存为一份资料。
   这里只管导入；出题仍走「资料 → 生成」。转写在后台进行，进度来自快照里的
   audio-import 任务，取消后已转写的部分会保留，重新导入接着做。

   还没有配置转写服务时，这里显示配置卡片而不是拖放区（字幕文件不需要转写，仍可导入），
   文件也不会开始上传。选好文件后先做预检：格式、时长、要几次请求；超过 1 小时的录音
   给出「无损分段并继续」，读不了的文件给出「跳过此文件继续 / 换一个文件」，其余文件写明在等谁。

   选文件不用输路径：拖进来或点击选择（浏览器把文件分块传给插件），从工作区里搜，
   或在对话输入框里用 @ 选。手输路径留在「高级」里。 */

const PHASES = {
  queued: "排队中", read: "读取并切分音频", transcribe: "转写音频",
  proofread: "校对识别错误的词", translate: "翻译并整理成中英对照", batch: '按顺序整理逐字稿', assemble: '合成逐字稿', done: "完成",
};
const EXTENSIONS = [".mp3", ".wav", ".m4a", ".aac", ".ogg", ".flac", ".opus", ".webm", ".aiff", ".aif"];
// Downloaded subtitles (Bilibili and the like) skip transcription and start at proofreading.
const SUBTITLES = [".srt", ".vtt", ".json", ".txt"];
const MAX_SUBTITLE_BYTES = 8 * 1024 * 1024;
const MAX_BYTES = 512 * 1024 * 1024;
const CHUNK = 3 * 1024 * 1024;
const isActive = (job) => ["queued", "running", "cancelling"].includes(job.status);
const unquote = (value) => value.trim().replace(/^"(.*)"$/, "$1").trim();
const extensionOf = (name) => name.slice(name.lastIndexOf(".")).toLowerCase();
const baseName = (path) => path.replace(/^.*[\\/]/, "");
const isAbsolutePath = (value) => /^[A-Za-z]:[\\/]/.test(value) || value.startsWith("/") || value.startsWith("\\\\");
/** A failure that the audio settings can fix: offer the way there. */
const aboutSettings = (message) => /设置|密钥|Settings|API key|\bkey\b/i.test(String(message || ""));
export const formatSize = (bytes = 0) => (bytes >= 1024 * 1024 * 1024 ? `${(bytes / 1024 ** 3).toFixed(1)} GB` : bytes >= 1024 * 1024 ? `${(bytes / 1024 ** 2).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`);
const toBase64 = (blob) => new Promise((resolve, reject) => {
  const reader = new FileReader();
  reader.onload = () => resolve(String(reader.result).split(",")[1] || "");
  reader.onerror = () => reject(new Error(ui("读取文件失败，请重试。")));
  reader.readAsDataURL(blob);
});
/** A path dropped as text (from a file tree or an explorer that gives text): quoted, or a file:// address. */
function droppedPath(text) {
  let value = unquote(String(text || "").split(/\r?\n/)[0]);
  if (/^file:\/\//i.test(value)) {
    try { value = decodeURIComponent(value.replace(/^file:\/\//i, "")); } catch { return ""; }
    if (/^\/[A-Za-z]:/.test(value)) value = value.slice(1);
  }
  return isAbsolutePath(value) && EXTENSIONS.includes(extensionOf(value)) ? value : "";
}

/** What a failed import already has saved, step by step: a retry does only the rest. */
const STEP_LABELS = [["transcribe", "转写"], ["proofread", "校对"], ["translate", "翻译"]];
const savedSteps = (steps) => STEP_LABELS.filter(([phase]) => steps?.[phase]?.total > 0)
  .map(([phase, label]) => uiFormat("{0} {1}/{2}", [ui(label), steps[phase].done, steps[phase].total])).join(" · ");

const spent = (ms) => {
  const total = Math.max(0, Math.floor(ms / 1000)), minutes = Math.floor(total / 60);
  return minutes ? uiFormat("{0} 分 {1} 秒", [minutes, total % 60]) : uiFormat("{0} 秒", [total]);
};
const requestsOf = (usage) => (usage?.free?.requests || 0) + (usage?.paid?.requests || 0); // Gemini requests; Groq and SiliconFlow have their own lines
const roughly = (ms) => (ms < 45000 ? ui("不到 1 分钟") : uiFormat("约 {0} 分钟", [Math.max(1, Math.round(ms / 60000))]));

/** The work in the order it happens, and how much of the whole each part usually is. */
const ORDER = ["transcribe", "proofread", "translate"];
const WEIGHT = { transcribe: 0.25, proofread: 0.3, translate: 0.45 };
const TASK_KINDS = { transcribe: "转写", proofread: "校对", translate: "翻译", title: "生成标题" };
const TASK_STATUS = { starting: "启动中", running: "执行中", finishing: "结果已返回，正在结束子会话", complete: "已完成", failed: "失败", cancelled: "已取消", skipped: "已跳过" };
const RUNTIME = { subagent: " · DSH 子代理", direct: " · 直接模型调用", gemini: " · Gemini" };
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

function OpenAgent({ task, openAgent }) {
  return task.childId && openAgent
    ? <button type="button" className="link-btn" aria-label={uiFormat('查看子代理：{0}', [taskLabel(task)])}
      onClick={() => openAgent(task.childId)}>{ui("查看子代理")}</button> : null;
}

function AudioTasks({ job, now, openAgent }) {
  const tasks = job.tasks || [];
  const active = isActive(job) ? tasks.filter(task => !task.finishedAt && ['starting', 'running', 'finishing'].includes(task.status)) : [];
  const history = tasks.filter(task => !active.includes(task));
  return <>
    {active.length > 0 && <div className="audio-active-tasks">
      <small>{uiFormat('正在执行 {0} 个任务', [active.length])}</small>
      {active.map(task => <small className="audio-now" key={task.id}>
        {uiFormat('正在做：{0}', [taskLabel(task)])}{ui(RUNTIME[task.runtime] || '')}
        {` · ${ui(TASK_STATUS[task.status] || task.status)}`}{uiFormat(' · 已等待 {0}', [spent(now - Date.parse(task.startedAt))])}
        <OpenAgent task={task} openAgent={openAgent} />
      </small>)}
    </div>}
    {history.length > 0 && <details className="generation-trace audio-trace">
      <summary>{uiFormat('查看历史任务 · {0} 次模型任务', [history.length])}</summary>
      <ol>{[...history].reverse().map(task => <li key={task.id}>
        <strong>{taskLabel(task)}</strong>
        <small>{ui(TASK_STATUS[task.status] || task.status)}{ui(RUNTIME[task.runtime] || '')}
          {task.finishedAt ? uiFormat(' · {0}', [spent(Date.parse(task.finishedAt) - Date.parse(task.startedAt))]) : ''}</small>
        {task.note && <small className="warning">{task.note}</small>}
        {task.reasoning && <small>{getUiLanguage() === 'en' ? 'Reasoning: ' : '推理：'}{task.reasoning}
          {task.reasoningEffort && task.reasoningEffort !== task.reasoning ? ` → ${task.reasoningEffort}` : ''}</small>}
        <OpenAgent task={task} openAgent={openAgent} />
      </li>)}</ol>
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
  const running = isActive(job), [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [running]);
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
          : job.status === "cancelling" ? ui("正在停止")
            : job.total > 0 ? uiFormat("复核存疑处（{0}/{1}）", [Math.min(job.done + 1, job.total), job.total]) : ui("复核存疑处")
    : job.status === "complete"
    ? job.reused ? ui("已导入过，直接复用") : uiFormat("已存为 {0} 份资料 · 校对修正 {1} 处", [job.sourceIds?.length ?? 0, job.corrected ?? 0])
    : held ? ui("有文件没通过预检，这一批还没开始")
      : job.status === "failed" ? ui("导入未完成")
      : job.status === "cancelled" ? ui("导入已取消")
        : job.status === "cancelling" ? ui("正在停止")
          : counted ? uiFormat("{0}（{1}/{2}）", [ui(PHASES[job.phase]), Math.min(job.done + 1, job.total), job.total]) : ui(PHASES[job.phase] || "处理中");
  const order = job.review ? [] : job.subtitle ? ORDER.filter(phase => phase !== "transcribe") : ORDER;
  return (
    <div className={"job " + job.status + (job.leaving ? " job-leaving" : "")} role="status"
      aria-hidden={job.leaving ? "true" : undefined} inert={job.leaving || undefined}>
      <span>{job.status === "failed" ? "!" : job.status === "cancelled" ? "×" : isActive(job) ? "◌" : "✓"}</span>
      <div>
        <strong>{job.filename}</strong>
        <small>{title}{job.minutes ? uiFormat(" · 录音时长 {0} 分钟", [job.minutes]) : ""}
          {took !== null && (running || job.finishedAt) && !held ? uiFormat(running ? " · 已用 {0}" : " · 用时 {0}", [spent(took)]) : ""}</small>
        {running && job.phase !== "queued" && <div className="audio-progress">
          <div className="audio-bar" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={progress.percent}
            title={ui("总进度按步骤估算：转写 25% · 校对 30% · 翻译 45%；每一步里按已完成的段数计算。")}>
            <span style={{ width: `${progress.percent}%` }} />
            {progress.flight > 0 && <i style={{ left: `${progress.percent}%`, width: `${progress.flight}%` }} />}
          </div>
          <div className="audio-progress-line">
            <strong>{progress.percent}%</strong>
            {job.members ? <small>{uiFormat('已完成 {0}/{1} 段音频', [job.members.filter(member => member.status === 'complete').length, job.members.filter(member => member.status !== 'skipped').length])}</small> : <ol className="audio-steps">{order.map((phase) => {
              const step = job.steps?.[phase], state = step?.total > 0 && step.done >= step.total ? "done" : job.phase === phase ? "current" : "todo";
              return <li key={phase} className={state}>{state === "done" ? "✓ " : ""}{ui(TASK_KINDS[phase])}
                {step?.total > 0 ? uiFormat(" 已完成 {0}/{1}", [step.done, step.total]) : ""}</li>;
            })}</ol>}
          </div>
          {progress.eta !== null
            ? <small className="muted">{uiFormat("本步骤预计还需{0}", [roughly(progress.eta)])}</small>
            : job.phase === "transcribe" && <small className="muted">{ui("转写要等服务商处理完整段录音，长录音需要几分钟，不是卡住了；上面的「已用」时间在走。")}</small>}
        </div>}
        {job.status === "failed" && <small className="warning">{job.stage}
          {onOpenSettings && aboutSettings(job.stage) && <> <button type="button" className="link-btn" onClick={onOpenSettings}>{ui('打开音频设置')}</button></>}</small>}
        {job.members?.length > 0 && <ol className="audio-members">{job.members.map((member, index) => {
          const state = memberState(member, running, now);
          return <li key={index}>
            <strong>{member.filename}</strong><small className={state.reason ? 'audio-member-reason' : undefined}>{state.text}</small>
            {ORDER.filter(phase => member.steps?.[phase]?.total > 0).map(phase => <small key={phase}>
              {ui(TASK_KINDS[phase])}{uiFormat(' 已完成 {0}/{1}', [member.steps[phase].done, member.steps[phase].total])}</small>)}
            <AudioTasks job={member} now={now} openAgent={openAgent} />
          </li>;
        })}</ol>}
        {job.status === 'complete' && job.sourceIds?.length > 0 && onOpenSources && <button type="button" className="link-btn"
          onClick={() => onOpenSources(job.sourceIds)}>{ui('打开逐字稿')}</button>}
        {["failed", "cancelled"].includes(job.status) && savedSteps(job.steps) && <small>{uiFormat("已保存：{0}", [savedSteps(job.steps)])}</small>}
        {job.status === "complete" && !job.reused && job.uncertain > 0 && (
          <small>{uiFormat("另有 {0} 处把握不大的疑似错词没有改，可在资料里查看", [job.uncertain])}
            {job.sourceIds?.length > 0 && onOpenSources && <button type="button" className="link-btn" onClick={() => onOpenSources(job.sourceIds.slice(0, 1))}>{ui("去复核")}</button>}</small>
        )}
        {requestsOf(usage) > 0 && (
          <small>
            {uiFormat("Gemini 请求（这份录音累计，含之前的尝试）：免费 {0} 次 · 付费 {1} 次", [usage.free.requests, usage.paid.requests])}
            {paidUsed && usage.estimatedPaidTranscribeUsd > 0 ? uiFormat(" · 转写付费部分约 ${0}", [usage.estimatedPaidTranscribeUsd]) : ""}
          </small>
        )}
        {usage?.siliconflow?.requests > 0 && (
          <small>{uiFormat("硅基流动请求（免费，这份录音累计）：{0} 次", [usage.siliconflow.requests])}</small>
        )}
        {usage?.groq?.requests > 0 && (
          <small>{uiFormat("Groq 请求（免费额度，这份录音累计）：{0} 次", [usage.groq.requests])}</small>
        )}
        {usage && job.usageRun && requestsOf(job.usageRun) !== requestsOf(usage) && (
          <small className="muted">{requestsOf(job.usageRun) === 0
            ? ui("这次没有新发 Gemini 请求：已保存的转写等结果直接复用了")
            : uiFormat("其中本次：免费 {0} 次 · 付费 {1} 次", [job.usageRun.free.requests, job.usageRun.paid.requests])}</small>
        )}
        {usage && job.textProvider === "host" && textStepsRan(job) && <small className="muted">{ui("校对和翻译由 DSH 的模型完成，不在上面的 Gemini 次数里")}</small>}
        {isActive(job) && !job.reused && job.estimatedUsd > 0 && (
          <small>{uiFormat("若全部走付费密钥，转写约 ${0}", [job.estimatedUsd])}</small>
        )}
        {(job.warnings || []).map((warning) => <small className="warning" key={warning}>{warning}</small>)}
        <AudioTasks job={job} now={now} openAgent={openAgent} />
        {["running", "queued"].includes(job.status) &&
          <button type="button" disabled={busy} onClick={() => act("job.cancel", { jobId: job.id })}>{ui("停止（已转写的部分会保留）")}</button>}
        {held && job.retryable && <div className="audio-job-actions">
          <Button variant="primary" size="sm" disabled={busy} onClick={() => act("audio.retry", { jobId: job.id, skip: [job.blocked.index] })}>{ui("跳过此文件继续")}</Button>
          <Button size="sm" disabled={busy} title={ui("修好这个文件或音频设置后，从头再检查一遍；已完成的部分不会重复付费")}
            onClick={() => act("audio.retry", { jobId: job.id })}>{ui("修复后继续")}</Button>
        </div>}
        {!held && ["failed", "cancelled"].includes(job.status) && job.retryable &&
          <button type="button" className="primary" disabled={busy} title={ui("已转写、校对、翻译好的部分会直接复用，不会重复付费；也不用重新选文件")}
            onClick={() => act("audio.retry", { jobId: job.id })}>{ui("接着做（不重复付费）")}</button>}
        {job.legacy && onLegacyRetry && <button type="button" className="primary" disabled={busy}
          onClick={() => onLegacyRetry(job)}>{ui("重新选择原录音继续")}</button>}
        {dismissFailure && <p className="job-error" role="alert">{uiFormat("没能移除这条记录：{0}", [dismissFailure])}</p>}
      </div>
      {!isActive(job) && (
        <button type="button" className="job-dismiss" onClick={() => quick ? dismissJobs(quick, job.id) : act("job.dismiss", { jobId: job.id })}>{ui("知道了")}</button>
      )}
    </div>
  );
}

/** What proofreading changed in an audio source, so the learner can check it; unsure items can be given a second look. */
export function AudioCorrections({ audio, onReview }) {
  const [review, setReview] = useState({ status: "idle", error: "" });
  const applied = audio?.corrections?.applied || [];
  const lowConfidence = (audio?.corrections?.skipped || []).filter((item) => item.skipped === "low-confidence");
  const unsure = lowConfidence.filter((item) => item.review?.verdict !== "reject");
  const kept = lowConfidence.length - unsure.length, pending = unsure.filter((item) => !item.review).length;
  if (!applied.length && !unsure.length) return null;
  const start = async () => {
    setReview({ status: "running", error: "" });
    try { await onReview(); setReview({ status: "started", error: "" }); }
    catch (error) { setReview({ status: "idle", error: String(error?.message || error) }); }
  };
  const row = (item, key) => (
    <li key={key}>
      <strong>{item.wrong} → {item.right}</strong>
      {item.reviewed ? <span> · {ui("复核后采纳")}</span> : null}
      {item.reason ? <span> · {item.reason}</span> : null}
      {item.review?.verdict === "unsure" && item.review.reason ? <span> · {uiFormat("复核：{0}", [item.review.reason])}</span> : null}
      <small className="muted" style={{ display: "block" }}>…{item.context}…</small>
    </li>
  );
  return (
    <details className="audio-corrections">
      <summary>{uiFormat("校对改动 {0} 处 · 未改动的存疑处 {1} 处", [audio.corrections.appliedCount ?? applied.length, unsure.length])}</summary>
      {applied.length > 0 && <ul>{applied.map((item, index) => row(item, `a${index}`))}</ul>}
      {unsure.length > 0 && <>
        <p className="muted">{ui("下面这些把握不大，没有改动，需要时请对照录音核对：")}</p>
        {onReview && pending > 0 && <p>
          <button type="button" disabled={review.status !== "idle"} onClick={start}
            title={ui("用对话模型结合上下文再判一次：能确定的直接改进正稿（译文里的同一处一起改），仍拿不准的留在这里")}>
            {uiFormat("让模型复核这 {0} 处", [pending])}</button>
          {review.status === "started" && <small className="muted"> {ui("已开始复核，进度见音频任务卡片")}</small>}
          {review.error && <small className="warning"> {review.error}</small>}
        </p>}
        <ul>{unsure.map((item, index) => row(item, `u${index}`))}</ul>
      </>}
      {kept > 0 && <p className="muted">{uiFormat("另有 {0} 处经复核判定原文无误，已不再列出", [kept])}</p>}
    </details>
  );
}

/** Progress and results of audio imports; shown in the add-source form and at the top of the sources page. */
export function AudioJobs({ data, busy, act, openAgent, onOpenSources, onLegacyRetry, onOpenSettings }) {
  const jobs = (data.jobs || []).filter((job) => job.type === "audio-import");
  return jobs.length ? <div className="jobs audio-jobs">{jobs.map((job) => <AudioJob key={job.id} job={job} busy={busy} act={act} openAgent={openAgent}
    onOpenSources={onOpenSources} onLegacyRetry={onLegacyRetry} onOpenSettings={onOpenSettings} />)}</div> : null;
}

/** Search the session workspace for audio, like @ in the composer: type a few letters, pick one. */
function WorkspaceAudio({ call, onPick }) {
  const [state, setState] = useState({ status: "idle", files: [], truncated: false, error: "" });
  const [query, setQuery] = useState(""), [opened, setOpened] = useState(false);
  useEffect(() => {
    if (!opened || !call) return;
    let alive = true;
    const timer = setTimeout(() => {
      setState((previous) => ({ ...previous, status: "loading" }));
      call("audio.files", { query }).then(
        (result) => alive && setState({ status: "ready", files: result.files || [], truncated: !!result.truncated, error: "" }),
        (error) => alive && setState({ status: "error", files: [], truncated: false, error: String(error.message || error) }));
    }, query ? 250 : 0);
    return () => { alive = false; clearTimeout(timer); };
  }, [call, opened, query]);
  return (
    <details className="audio-workspace" onToggle={(event) => setOpened(event.currentTarget.open)}>
      <summary>{ui("从工作区里找")}</summary>
      <input type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder={ui("搜索文件名")} aria-label={ui("搜索文件名")} />
      {state.status === "loading" && !state.files.length && <p className="muted">{ui("正在查找…")}</p>}
      {state.status === "error" && <p className="warning" role="alert">{uiFormat("无法列出工作区里的文件：{0}", [state.error])}</p>}
      {state.status === "ready" && !state.files.length && <p className="muted">{ui("工作区里没有找到音频文件。把录音放进工作区，或用上面的方式选择。")}</p>}
      {state.files.length > 0 && <ul className="audio-files">
        {state.files.map((file) => (
          <li key={file.path}>
            <button type="button" onClick={() => onPick(file)}>
              <strong>{file.name}</strong>
              <small>{file.rel.slice(0, Math.max(0, file.rel.length - file.name.length)).replace(/[\\/]$/, "") || ui("工作区根目录")}</small>
              <small>{formatSize(file.size)} · {new Date(file.modified).toLocaleDateString(uiLocale())}</small>
            </button>
          </li>
        ))}
      </ul>}
      {state.truncated && <p className="muted">{ui("只列出最近的一部分，请用搜索缩小范围。")}</p>}
    </details>
  );
}

/**
 * The pre-flight result of each chosen file, in words: a long recording offers a lossless split (the learner confirms
 * the extra requests), a file that cannot be imported says why, and every other file says whom it is waiting for.
 * checks: key → pre-flight probe ({ blocked, issue, seconds, requests }) or { checking: true }; confirmed: keys whose split was accepted.
 */
export function preflightNotes(files, checks = {}, confirmed = new Set()) {
  const notes = {}, audio = files.filter((file) => file.kind !== 'subtitle');
  const blocker = audio.find((file) => checks[file.key]?.blocked);
  const pending = audio.find((file) => checks[file.key]?.issue?.code === 'long-split' && !confirmed.has(file.key));
  for (const file of audio) {
    const check = checks[file.key];
    if (!check) notes[file.key] = null;
    else if (check.checking) notes[file.key] = { kind: 'checking', text: ui('正在检查…') };
    else if (check.blocked) notes[file.key] = { kind: 'blocked', text: uiMessage(check.issue?.message || ui('这个文件不能导入')) };
    else if (check.issue?.code === 'long-split') {
      const { minutes, parts, requests, partMinutes } = check.issue;
      notes[file.key] = confirmed.has(file.key)
        ? { kind: 'split-confirmed', text: uiFormat('将无损分成 {0} 段转写（占用 {1} 次请求）', [parts, requests ?? parts]) }
        : { kind: 'split', text: Number.isFinite(partMinutes)
          ? uiFormat('约 {0} 分钟，按每次最多 {1} 分钟 → 无损分成 {2} 段转写（占用 {3} 次请求）', [minutes, partMinutes, parts, requests ?? parts])
          : uiFormat('约 {0} 分钟 → 无损分成 {1} 段转写（占用 {2} 次请求）', [minutes, parts, requests ?? parts]) };
    } else if (blocker) notes[file.key] = { kind: 'held', text: uiFormat('因「{0}」未通过预检尚未开始', [blocker.name]) };
    else if (pending) notes[file.key] = { kind: 'waiting', text: uiFormat('等待「{0}」处理', [pending.name]) };
    else notes[file.key] = { kind: 'ok', text: check.seconds ? uiFormat('约 {0} 分钟 · {1} 次转写请求', [Math.max(1, Math.round(check.seconds / 60)), check.requests || 1]) : ui('可以导入') };
  }
  return notes;
}
const inputOf = (file) => (file.kind === 'upload' ? { uploadId: file.uploadId } : { path: file.path });
const withoutFiles = (result) => { const status = { ...result }; delete status.files; return status; };

export default function AudioImport({ data, busy, act, call, setNotice, askInChat, canAsk = false, openAgent, onOpenSources, initialFile = null, initialFiles, defaultCourse, defaultCourses, recoveryJobId = '', onRecoveryChange,
  onOpenSettings, initialReadiness = null, initialChecks }) {
  useInjectCss(settingsCss, 'study-audio-settings');
  const language = useUiLanguage();
  const [files, setFiles] = useState(() => (initialFiles || (initialFile ? [initialFile] : [])).map((file, index) => ({ ...file, key: file.key || `initial-${index}` }))), [upload, setUpload] = useState(null);
  const [pathText, setPathText] = useState(""), [problem, setProblem] = useState("");
  const [subject, setSubject] = useState(""), [terms, setTerms] = useState(""), [title, setTitle] = useState('');
  const [chosenCourse, setCourse] = useState(undefined), [paidOnly, setPaidOnly] = useState(false);
  // Pre-flight: whether a transcription provider is configured (null until known), and each chosen file's check.
  const [readiness, setReadiness] = useState(initialReadiness), [checks, setChecks] = useState(initialChecks || {});
  const [confirmed, setConfirmed] = useState(() => new Set()), [submitError, setSubmitError] = useState(''), [starting, setStarting] = useState(false);
  const course = chosenCourse ?? defaultCourses?.join('; ') ?? defaultCourse ?? data.focus?.course ?? '';
  const picker = useRef(null), cancelled = useRef(false), uploadId = useRef("");
  const pendingUploads = useRef(new Set()), nextKey = useRef(0), moving = useRef(null), sending = useRef(false), checking = useRef(0);
  const courses = data.focus?.courses?.map(item => item.name) || [...new Set((data.decks || []).map((deck) => deck.course).filter(Boolean))];
  const openSettings = onOpenSettings ? () => { requestAudioSettingsFocus(); onOpenSettings(); } : undefined;
  // Only unsubmitted uploads belong to this form; a submitted batch owns durable copies.
  useEffect(() => {
    const owned = pendingUploads.current;
    return () => { cancelled.current = true; for (const uploadId of owned) if (call) void call('audio.upload.cancel', { uploadId }).catch(() => {}); };
  }, [call]);
  /** Ask the plugin what is configured; nothing is sent to a provider. */
  const refreshReadiness = async () => {
    if (!call) return null;
    try {
      const result = await call("audio.preflight", {});
      if (!result || typeof result !== 'object') return null;
      const status = withoutFiles(result);
      setReadiness(status);
      return status;
    } catch { return null; }
  };
  useEffect(() => {
    if (!initialReadiness) void refreshReadiness();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [call]);
  // Check the chosen recordings as soon as they are in the list, so a problem shows before the learner presses start.
  const audioFiles = files.filter(file => file.kind !== 'subtitle');
  const signature = audioFiles.map(file => file.key).join('|');
  useEffect(() => {
    if (!call || !audioFiles.length || initialChecks) return;
    const run = ++checking.current;
    setChecks(current => Object.fromEntries(audioFiles.map(file => [file.key, current[file.key] || { checking: true }])));
    const timer = setTimeout(() => {
      void call("audio.preflight", { files: audioFiles.map(inputOf), ...(paidOnly ? { paidOnly: true } : {}) }).then(result => {
        if (run !== checking.current || !Array.isArray(result?.files)) return;
        setChecks(Object.fromEntries(audioFiles.map((file, index) => [file.key, result.files[index]])));
      }, () => { if (run === checking.current) setChecks({}); });
    }, 150);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [call, signature, paidOnly]);
  const append = file => setFiles(current => [...current, { ...file, key: `chosen-${++nextKey.current}` }]);
  const gated = !!readiness && !readiness.transcription && !files.length && !upload && !recoveryJobId;

  const reject = (message) => { setProblem(message); return false; };
  function check(name, size) {
    setProblem("");
    if (!EXTENSIONS.includes(extensionOf(name))) return reject(ui("这不是支持的音频文件。支持 MP3、WAV、M4A、AAC、OGG、FLAC、OPUS、WEBM、AIFF。"));
    if (size !== undefined && size < 1) return reject(ui("文件是空的。"));
    if (size !== undefined && size > MAX_BYTES) return reject(ui("文件超过 512 MB，请先压缩成 MP3 或按章节拆分。"));
    return true;
  }
  /** Send a browser file to the plugin in chunks; the import then uses its upload id. */
  async function send(chosenFiles) {
    if (sending.current) return;
    if (recoveryJobId && chosenFiles.length !== 1) { setProblem(ui('旧任务请选择同一份原录音。')); return; }
    const subtitles = chosenFiles.filter(chosen => SUBTITLES.includes(extensionOf(chosen.name)));
    if (subtitles.length) {
      setProblem("");
      if (subtitles.length !== chosenFiles.length || chosenFiles.length !== 1 || files.length || recoveryJobId)
        return void reject(ui("字幕文件请单独导入：一次选一个字幕文件，不和音频混在一起。"));
      if (subtitles[0].size > MAX_SUBTITLE_BYTES) return void reject(ui("字幕文件超过 8 MB。"));
      sending.current = true;
      cancelled.current = false;
      try {
        const text = await subtitles[0].text();
        if (!cancelled.current) append({ kind: 'subtitle', name: subtitles[0].name, size: subtitles[0].size, text });
      } catch { if (!cancelled.current) reject(ui("读取文件失败，请重试。")); }
      finally { sending.current = false; }
      return;
    }
    if (files.some(file => file.kind === 'subtitle')) { setProblem(ui("字幕文件请单独导入：一次选一个字幕文件，不和音频混在一起。")); return; }
    if (!call || sending.current || !chosenFiles.length || !chosenFiles.every(chosen => check(chosen.name, chosen.size))) return;
    // No upload starts before a transcription provider is configured: a big file would travel for nothing.
    const ready = readiness || await refreshReadiness();
    if (ready && !ready.transcription) { setProblem(ui("请先配置转写服务，再选择录音：文件还没有上传。")); return; }
    sending.current = true;
    cancelled.current = false;
    let currentFile;
    try {
      for (const chosen of chosenFiles) {
        currentFile = chosen;
        if (cancelled.current) throw new Error("cancelled");
        setUpload({ name: chosen.name, size: chosen.size, sent: 0 });
        const started = await call("audio.upload.start", { name: chosen.name, size: chosen.size });
        uploadId.current = started.uploadId;
        pendingUploads.current.add(started.uploadId);
        for (let offset = 0; offset < chosen.size; offset += CHUNK) {
          if (cancelled.current) throw new Error("cancelled");
          await call("audio.upload.chunk", { uploadId: started.uploadId, offset, data: await toBase64(chosen.slice(offset, offset + CHUNK)) });
          setUpload(current => current && { ...current, sent: Math.min(chosen.size, offset + CHUNK) });
        }
        if (cancelled.current) throw new Error('cancelled');
        await call("audio.upload.finish", { uploadId: started.uploadId });
        if (cancelled.current) throw new Error('cancelled');
        append({ kind: 'upload', uploadId: started.uploadId, name: chosen.name, size: chosen.size });
        uploadId.current = '';
      }
      setUpload(null);
    } catch (error) {
      if (uploadId.current) void call("audio.upload.cancel", { uploadId: uploadId.current }).catch(() => {});
      pendingUploads.current.delete(uploadId.current);
      uploadId.current = "";
      setUpload(cancelled.current ? null : { name: currentFile?.name, size: currentFile?.size, sent: 0, error: String(error.message || error) });
    } finally { sending.current = false; }
  }
  function cancelUpload() { cancelled.current = true; }
  function pickPath(path, size) {
    if (sending.current) return;
    if (files.some(file => file.kind === 'subtitle')) return void reject(ui("字幕文件请单独导入：一次选一个字幕文件，不和音频混在一起。"));
    if (!check(path, size)) return;
    append({ kind: "path", path, name: baseName(path), size });
    setPathText('');
  }
  function remove(index, list = files) {
    const file = list[index];
    const next = list.filter((_, at) => at !== index);
    setFiles(next);
    setSubmitError('');
    if (file?.uploadId && call) { pendingUploads.current.delete(file.uploadId); void call('audio.upload.cancel', { uploadId: file.uploadId }).catch(() => {}); }
    return next;
  }
  function move(from, to) {
    if (from === to || from < 0 || to < 0 || to >= files.length) return;
    setFiles(current => { const next = [...current], [file] = next.splice(from, 1); next.splice(to, 0, file); return next; });
  }
  /** A path dragged as text (file trees give text, not files): file drags are taken by the drop zone itself. */
  function dropText(event) {
    const types = Array.from(event.dataTransfer?.types || []);
    if (types.includes('Files') || !types.includes('text/plain')) return;
    event.preventDefault();
    const paths = String(event.dataTransfer.getData('text/plain') || '').split(/\r?\n/).map(droppedPath).filter(Boolean);
    if (paths.length) paths.forEach(path => pickPath(path)); else reject(ui("请拖入音频文件。"));
  }
  function drop(event) {
    event.preventDefault();
    event.stopPropagation();
    const dropped = Array.from(event.dataTransfer?.files || []);
    if (dropped.length) return void send(dropped);
    const paths = String(event.dataTransfer?.getData('text/plain') || '').split(/\r?\n/).map(droppedPath).filter(Boolean);
    if (paths.length) paths.forEach(path => pickPath(path)); else reject(ui("请拖入音频文件。"));
  }
  const failed = (error) => setSubmitError(String(error?.message || error || ''));
  async function start(event, { list = files, accepted = confirmed } = {}) {
    event?.preventDefault?.();
    if (!list.length || upload || starting) return;
    setSubmitError('');
    if (list.some(file => file.kind === 'subtitle') && list.length !== 1)
      return void reject(ui("字幕文件请单独导入：一次选一个字幕文件，不和音频混在一起。"));
    if (recoveryJobId && list.length !== 1) { setProblem(ui('旧任务请选择同一份原录音。')); return; }
    if (list[0].kind === 'subtitle') {
      try {
        await act("audio.subtitles.import", {
          filename: list[0].name, text: list[0].text,
          ...(title.trim() ? { title: title.trim() } : {}),
          ...(subject.trim() ? { subject: subject.trim() } : {}),
          ...(terms.trim() ? { terms: terms.trim() } : {}),
          courses: parseCourses(course),
          ...(paidOnly ? { paidOnly: true } : {}),
        }, () => {
          setFiles([]);
          setTitle('');
          setNotice({ text: ui("已开始后台校对字幕（不需要转写）。完成后会出现在「资料」页的「今天」分组里。"), tone: 'success' });
        }, { rethrow: true });
      } catch (error) { failed(error); }
      return;
    }
    // Pre-flight every file again right before starting: nothing is sent to a provider until all of them can go.
    let current = checks;
    if (call) {
      setStarting(true);
      try {
        const result = await call("audio.preflight", { files: list.map(inputOf), ...(paidOnly ? { paidOnly: true } : {}) });
        if (result && Array.isArray(result.files)) {
          current = Object.fromEntries(list.map((file, index) => [file.key, result.files[index]]));
          setChecks(current);
          const status = withoutFiles(result);
          setReadiness(status);
          if (!status.transcription) return void failed(status.reason === 'paid-missing'
            ? ui("选择了「只用付费密钥」，但还没有配置 Gemini 付费密钥：去掉这个勾选，或在音频设置的「高级」里填写。")
            : ui("还没有配置转写服务：请先在音频设置里填一个密钥。"));
        }
      } catch (error) { return void failed(error); }
      finally { setStarting(false); }
    }
    const notes = preflightNotes(list, current, accepted);
    if (list.some(file => ['blocked', 'split'].includes(notes[file.key]?.kind))) return void failed(ui("有文件需要先处理：见上面每个文件下的提示。"));
    const inputs = list.map(inputOf);
    try {
      await act("audio.import", {
        ...(list.length > 1 ? { files: inputs } : inputs[0]),
        ...(title.trim() ? { title: title.trim() } : {}),
        ...(subject.trim() ? { subject: subject.trim() } : {}),
        ...(terms.trim() ? { terms: terms.trim() } : {}),
        courses: parseCourses(course),
        ...(recoveryJobId ? { recoveryJobId } : {}),
        ...(paidOnly ? { paidOnly: true } : {}),
      }, (started) => {
        list.forEach(file => pendingUploads.current.delete(file.uploadId));
        setFiles([]);
        setTitle('');
        setChecks({});
        setConfirmed(new Set());
        onRecoveryChange?.('');
        setNotice({ tone: 'success', text: started?.status === "queued"
          ? uiFormat("已加入队列（前面还有 {0} 个）：轮到它时自动开始，完成后会出现在「资料」页的「今天」分组里。", [started.queuedBehind])
          : ui("已开始后台转写。长录音需要几分钟到十几分钟，可以先做别的；完成后会出现在「资料」页的「今天」分组里。") });
      }, { rethrow: true });
    } catch (error) { failed(error); }
  }
  /** "Split and continue": accept the lossless split of this file, then start when nothing else is waiting. */
  function confirmSplit(key) {
    const next = new Set(confirmed).add(key);
    setConfirmed(next);
    void start(null, { accepted: next });
  }
  function skipAndContinue(index) {
    const next = remove(index);
    if (next.length) void start(null, { list: next });
  }
  function replaceFile(index) { remove(index); picker.current?.click(); }
  const notes = preflightNotes(files, checks, confirmed);
  // The text steps of the recordings (WP27); transcription is counted in minutes on its own page.
  const audioMinutes = Math.round(audioFiles.reduce((sum, file) => sum + (checks[file.key]?.seconds || 0), 0) / 60);
  const termCount = terms.split(/[\n,，、;；]+/).map((term) => term.trim()).filter(Boolean).length;
  const percent = upload?.size ? Math.min(100, Math.round((upload.sent / upload.size) * 100)) : 0;
  return (
    <div className="pdf-import audio-import">
      <strong>{ui("音频 / 录音 → 中英对照逐字稿")}</strong>
      {recoveryJobId && <p className="muted">{ui('正在接续旧版失败任务：请选择同一份原录音。原提交参数未保存，请核对下面的课程和术语设置。')}
        <button type="button" onClick={() => onRecoveryChange?.('')}>{ui('取消接续')}</button></p>}
      <p className="muted">{ui("先把录音转写成文字（用你在音频设置里配置的服务），再校对识别错误的词、翻译，保存为一份资料。出题仍在「创建题组」里另选。")}</p>
      <input ref={picker} type="file" hidden multiple accept={`audio/*,${[...EXTENSIONS, ...SUBTITLES].join(',')}`}
        onChange={event => { const chosen = Array.from(event.target.files || []); event.target.value = ''; if (chosen.length) void send(chosen); }} />
      <AudioJobs data={data} busy={busy} act={act} openAgent={openAgent} onOpenSources={onOpenSources} onOpenSettings={openSettings}
        onLegacyRetry={job => { onRecoveryChange?.(job.id); picker.current?.click(); }} />
      {gated && <>
        <AudioSetupGate language={language} call={call} onOpenSettings={openSettings} reason={readiness.reason}
          onSaved={() => { void refreshReadiness(); }} />
        {readiness.text !== false && <div className="audio-subtitle-only">
          <p>{ui("字幕文件不需要转写服务，现在就可以导入：")}</p>
          <FileDrop compact accept={SUBTITLES} label={ui("把字幕文件拖到这里")} hint="SRT · VTT · JSON · TXT" buttonLabel={ui("选择字幕文件")}
            disabled={busy} onFiles={(accepted) => { if (accepted.length) void send(accepted); }} />
        </div>}
      </>}
      {!gated && !files.length && !upload && <div className="audio-drop-zone" onDragOver={event => { if (!Array.from(event.dataTransfer?.types || []).includes('Files')) event.preventDefault(); }} onDrop={dropText}>
        <FileDrop multiple accept={[...EXTENSIONS, ...SUBTITLES]} disabled={busy}
          label={ui("把音频文件拖到这里，或点击选择")} hint={`MP3 · WAV · M4A · AAC · OGG · FLAC · OPUS · WEBM · AIFF · ${ui("最大 512 MB")}`}
          onFiles={(accepted) => { if (accepted.length) void send(accepted); }} />
        <small className="muted">{ui("也可以放 B 站等网站下载的带时间戳字幕（SRT · VTT · JSON · TXT）：跳过转写，直接校对和翻译，时间戳会保留。")}</small>
      </div>}
      {problem && <InlineMessage tone="warning">{problem}</InlineMessage>}
      {!upload && !gated && <>
        {files.length > 0 && <div className="audio-add" onDragOver={event => event.preventDefault()} onDrop={drop}>
          <button type="button" disabled={busy} onClick={() => picker.current?.click()}>{ui('添加音频')}</button>
          <small className="muted">{ui('也可把更多音频拖到这里')}</small>
        </div>}
        <div className="audio-ways">
          <WorkspaceAudio call={call} onPick={(picked) => pickPath(picked.path, picked.size)} />
          {canAsk && askInChat && <button type="button" className="link-btn" disabled={busy}
            onClick={() => askInChat(getUiLanguage() === "en"
              ? "Please import these audio files in the order I choose as one transcript with audio.import files:[{path:...}]. Use absolute paths: @"
              : "请把这些音频按我指定的顺序合成一份逐字稿（用 audio.import files:[{path:...}]，路径用绝对路径）：@")}>{ui("在对话里用 @ 选文件")}</button>}
          <details className="audio-path"><summary>{ui("粘贴文件路径（高级）")}</summary>
            <div className="audio-path-row">
              <input value={pathText} onChange={(event) => setPathText(event.target.value)} placeholder={ui("例如：C:\\Users\\你\\Downloads\\lecture.mp3")}
                onKeyDown={(event) => { if (event.key === "Enter" && unquote(pathText)) { event.preventDefault(); pickPath(unquote(pathText)); } }} />
              <button type="button" disabled={!unquote(pathText)} onClick={() => pickPath(unquote(pathText))}>{ui("选用")}</button>
            </div>
          </details>
        </div>
      </>}
      {upload && <div className="audio-upload" role="status">
        <div className="audio-upload-head"><strong>{upload.name}</strong>
          {upload.error ? <button type="button" className="link-btn" onClick={() => setUpload(null)}>{ui("重新选择")}</button>
            : <button type="button" className="link-btn" onClick={cancelUpload}>{ui("取消上传")}</button>}</div>
        {upload.error ? <p className="warning" role="alert">{uiFormat("上传失败：{0}", [upload.error])}</p> : <>
          <div className="audio-bar" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent}><span style={{ width: `${percent}%` }} /></div>
          <small className="muted">{uiFormat("正在上传 {0} / {1}", [formatSize(upload.sent), formatSize(upload.size)])}</small></>}
      </div>}
      {files.length > 0 && <form onSubmit={start}>
        {files.length > 1 && <small className="muted">{ui('按下面的顺序合成一份逐字稿，可拖动或用按钮调整。')}</small>}
        <ol className={`audio-selection${files.length === 1 ? ' single' : ''}`}>{files.map((file, index) => {
          const note = notes[file.key];
          return <li key={file.key} className="audio-chosen" draggable={!busy && files.length > 1}
            onDragStart={event => { moving.current = index; event.dataTransfer.setData('text/plain', file.name); }}
            onDragEnd={() => { moving.current = null; }} onDragOver={event => { if (moving.current !== null) event.preventDefault(); }}
            onDrop={event => { if (moving.current !== null) { event.preventDefault(); event.stopPropagation(); move(moving.current, index); moving.current = null; } }}>
            <span className="audio-drop-icon" aria-hidden="true">{files.length > 1 ? index + 1 : '♫'}</span>
            <div><strong title={file.path || file.name}>{file.name}</strong><small className="muted">{file.size ? `${formatSize(file.size)} · ` : ''}{file.kind === 'subtitle' ? ui('字幕文件 · 不转写，直接校对') : file.kind === 'upload' ? ui('已上传') : ui('来自工作区或路径')}</small>
              {note && <span className={`audio-check audio-check--${note.kind}`} role={note.kind === 'blocked' ? 'alert' : undefined}>
                <span>{note.text}</span>
                {note.kind === 'split' && <Button size="sm" disabled={busy || starting} onClick={() => confirmSplit(file.key)}>{ui('分段并继续')}</Button>}
                {note.kind === 'blocked' && <>
                  {files.length > 1 && <Button size="sm" disabled={busy || starting} onClick={() => skipAndContinue(index)}>{ui('跳过此文件继续')}</Button>}
                  <Button size="sm" variant="quiet" disabled={busy || starting} onClick={() => replaceFile(index)}>{ui('换一个文件')}</Button>
                </>}
              </span>}
            </div>
            <div className="audio-order-actions">{files.length > 1 && <>
              <button type="button" disabled={busy} aria-disabled={busy || index === 0} aria-label={uiFormat('上移 {0}', [file.name])} onClick={() => move(index, index - 1)}>↑</button>
              <button type="button" disabled={busy} aria-disabled={busy || index === files.length - 1} aria-label={uiFormat('下移 {0}', [file.name])} onClick={() => move(index, index + 1)}>↓</button>
            </>}<button type="button" disabled={busy} aria-label={uiFormat('移除 {0}', [file.name])} onClick={() => remove(index)}>{ui(files.length === 1 ? '换一个' : '移除')}</button></div>
          </li>;
        })}</ol>
        <label>{ui('逐字稿名称（可选）')}<input value={title} onChange={event => setTitle(event.target.value)} disabled={busy} maxLength={200} /></label>
        <label>{ui("这段音频讲什么（可选，帮助纠正术语）")}
          <input value={subject} onChange={(e) => setSubject(e.target.value)} disabled={busy} maxLength={300}
            placeholder={ui("例如：SQL 数据库课程，讲事务、分区和索引")} />
        </label>
        <label>{ui("术语表（可选，逗号或换行分隔）")}
          <textarea value={terms} onChange={(e) => setTerms(e.target.value)} disabled={busy} rows={2}
            placeholder={ui("例如：partition, ACID, VARCHAR, PostgreSQL")} />
        </label>
        <CourseField courses={courses} value={course} onChange={setCourse} multiple disabled={busy} label={ui('所属课程（用它的主题词辅助校对）')} />
        <label className="inline-check">
          <input type="checkbox" checked={paidOnly} onChange={(e) => setPaidOnly(e.target.checked)} disabled={busy} />
          {ui("只用付费密钥（免费额度下，Google 可能用内容改进产品）")}
        </label>
        <TokenEstimate call={call} enabled={audioMinutes > 0}
          request={{ feature: "audio", minutes: audioMinutes, language: "en", terms: termCount, subject: subject.trim() }} />
        <div className="audio-submit">
          <button className="primary" disabled={busy || !!upload || starting || audioFiles.some(file => checks[file.key]?.checking)}>{starting ? ui("正在检查…") : ui("开始导入")}</button>
          {submitError && <InlineMessage action={openSettings && aboutSettings(submitError) ? { label: ui('打开音频设置'), onClick: openSettings } : undefined}
            onDismiss={() => setSubmitError('')}>{uiMessage(submitError)}</InlineMessage>}
        </div>
      </form>}
    </div>
  );
}
