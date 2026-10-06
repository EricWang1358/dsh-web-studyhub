import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ui, uiFormat } from '../i18n.js';
import { Button, Checkbox, Tooltip, useNow } from '../components/index.js';
import { useInjectCss } from '../shared.js';
import { useApp } from '../app/app-context.js';
import { useQuickActions, dismissJobs } from '../quick-actions.js';
import { failureText } from '../failure.js';
import { formatDateTime, joinMeta } from '../format.js';
import denseCss from '../dense-surface.css';
import css from './task-console.css';
import { contractOf, tasksOf, taskId, taskFilters, filterTasks, pickTask, isRunningTask, isArchivedTask, archivedTasksOf } from './task-model.js';
import { isSelectableTask, reconcileSelection, selectionSummary, toggleAll, toggleSelection } from './task-selection.js';
import { batchMessage, batchRun } from './task-batch.js';
import SelectBar from './SelectBar.jsx';
import DeleteTasksDialog from './DeleteTasksDialog.jsx';
import { taskSummary, stateLabel } from './task-summary.js';
import { taskFacts, taskSegments, usageLine } from './task-facts.js';
import { headerActions, autoToggle } from './task-control.js';
import RunLine from './RunLine.jsx';
import TimeLimit from './TimeLimit.jsx';
import { limitFacts, marksOf, slowSteps } from './time-limit.js';
import TaskUsage from './TaskUsage.jsx';
import { actionLabel, autoLabel } from '../coverage/copy.js';
import ControlRow from './ControlRow.jsx';
import TaskBody from './TaskBody.jsx';
import { readJSON, writeJSON } from '../storage.js';
import { CoverageTopUpPopover } from '../coverage/CoverageTopUp.jsx';
import { useCoverage } from '../coverage/use-coverage.js';
import { draftShortfall } from '../coverage/use-shortfall.js';
import { topUpArgs, topUpNotice } from '../coverage/top-up.js';
import { modelReadiness } from '../generation-status.js';

/* The 任务 console. One surface for every background job: a list on the left, the whole story of the selected job on the right. It reads the jobs of
   the snapshot through their contract (lib/job-contract.js) and sends every action to job.control; what it offers is what the contract says is available. */

const FILTER_LABEL = { all: '全部', running: '进行中', failed: '失败/中断', archived: '已归档' };

function percentWord(summary) {
  if (summary.state === 'fail') return ui('失败');
  if (summary.state === 'interrupted') return ui('已中断');
  if (summary.state === 'queued') return ui('排队');
  return summary.percent === null ? '—' : `${summary.percent}%`;
}

function TaskRow({ summary, selected, onPick }) {
  return (
    <Button variant="quiet" block className="tc-row" aria-pressed={selected} data-task-id={summary.id} title={summary.title} onClick={() => onPick(summary.id)}>
      <span className="tc-dot" data-state={summary.state} aria-hidden="true" />
      <span className="tc-row__title">{summary.title}</span>
      <span className="tc-num" data-state={summary.state}>{percentWord(summary)}</span>
      <span className="tc-row__sub">{joinMeta([summary.kindLabel, summary.line])}</span>
    </Button>
  );
}

/** A row and, beside it, the box that selects it (only a finished task has one; the others keep the column so the rows line up). */
function TaskItem({ task, summary, picked, checked, onPick, onCheck }) {
  const selectable = isSelectableTask(task);
  return (
    <div className="tc-item" data-checked={checked ? 'true' : undefined}>
      {selectable
        ? <Checkbox className="tc-item__check" label="" checked={checked} aria-label={uiFormat('选择任务：{0}', [summary.title])} onChange={() => onCheck(summary.id)} />
        : <span className="tc-item__check" aria-hidden="true" />}
      <TaskRow summary={summary} selected={picked} onPick={onPick} />
    </div>
  );
}

/** Stage-segmented progress: one segment per stage of the job, as wide as its share of the work, filled by what is done. */
function SegmentedProgress({ segments, label }) {
  return (
    <div className="tc-segments" role="img" aria-label={label}>
      {segments.map((segment) => (
        <span key={segment.stage} className="tc-segment" data-stage={segment.stage} style={{ flexGrow: Math.max(segment.total, 1) }}>
          <i style={{ transform: `scaleX(${segment.total > 0 ? Math.min(1, segment.done / segment.total) : 0})` }} />
        </span>
      ))}
    </div>
  );
}

function Metrics({ job, summary, now }) {
  const segments = taskSegments(job), facts = taskFacts(job, now);
  const label = segments.map((segment) => uiFormat('{0} {1}/{2}', [segment.label, segment.done, segment.total])).join('，');
  return (
    <section className="tc-metrics" aria-label={ui('概览')}>
      <div className="tc-metric tc-metric--progress">
        <div className="tc-metric__top">
          <span className="tc-metric__k">{uiFormat('总进度 · {0}', [stateLabel(summary.state)])}</span>
          <strong className="tc-metric__pct">{summary.percent === null ? '—' : `${summary.percent}%`}</strong>
        </div>
        <SegmentedProgress segments={segments} label={label || ui('总进度')} />
      </div>
      {facts.map((fact) => (
        <div className="tc-metric" key={fact.key}>
          <span className="tc-metric__k">{fact.label}</span>
          <span className="tc-metric__v">{fact.value}</span>
        </div>
      ))}
    </section>
  );
}

/** The row of 即时控制 of an archived task: the same height, and the words for what archived means. */
function ArchivedNote({ task }) {
  const at = task.archived?.at ? formatDateTime(task.archived.at, 'stamp') : '';
  return (
    <div className="tc-controls" role="note" aria-label={ui('已归档')} data-archived="true">
      <span className="tc-controls__title">{ui('已归档')}</span>
      <span className="tc-controls__idle">{at ? uiFormat('{0} 归档。这是只读记录：不能继续、重试或调整；取消归档后恢复。', [at]) : ui('这是只读记录：不能继续、重试或调整；取消归档后恢复。')}</span>
    </div>
  );
}

function Detail({ task, data, openers, full, onFull, onDelete }) {
  const { core, settingsEntry } = useApp();
  const quick = useQuickActions();
  const contract = contractOf(task), summary = taskSummary(task), actions = headerActions(task), archived = isArchivedTask(task);
  const live = isRunningTask(task), now = useNow(1000, { enabled: live });
  const key = contract.jobId, day = contract.kind === 'coach-daily';
  /* 知道了 puts the task in 已归档 (nothing is deleted); 取消归档 puts it back. Both go the light way and say where the task went. */
  const settle = async (run, text) => {
    const done = await run();
    if (done?.ok === false) core.setError?.(done.message || ui('没有完成，请再试一次。')); else { core.notify?.(text); Promise.resolve(core.refresh?.()).catch(() => {}); }
  };
  const archive = () => settle(() => (quick ? dismissJobs(quick, task.id) : core.act('job.archive', { jobId: task.id })), ui('已放进「已归档」，之后可以取消归档或删除。'));
  const unarchive = () => settle(() => batchRun('unarchive', [key], { quick, core }), ui('已取消归档'));
  const result = openers.resultOf(task, data), usage = usageLine(task);
  // The time limit and the steps that took the time (ui/tasks/time-limit.js): drawn by the strip under the facts and marked on the timeline, from the same steps. Only a task whose record knows a limit has them
  // (a transcription that runs long is just a long file). An ended task counts its calls up to its own end, never up to now.
  const limited = limitFacts(contract, { now }), clock = live ? now : Date.parse(contract.finishedAt) || now;
  const hasLimit = !!limited, hit = !!limited?.hit;
  const steps = useMemo(() => (hasLimit ? slowSteps(contract.calls, { now: clock, hitLimit: hit }) : []), [contract.calls, clock, hasLimit, hit]);
  const marks = useMemo(() => marksOf(steps), [steps]);
  const [focusCall, setFocusCall] = useState(null);
  // A coverage run (lib/coverage-run.js): its header says 停在这里 (everything that passed is kept), 接着做 says which round it continues, and 自动补到完整 can be flipped while it runs.
  const run = contract.detail?.run || null, toggle = autoToggle(task);
  const started = contract.startedAt ? formatDateTime(contract.startedAt, 'stamp') : '';
  const act = (action) => core.act('job.control', { jobId: contract.jobId, action });
  // 为没覆盖的部分补题 acts on the draft a run wrote, not on the run: so a finished run, an archived record too, offers it for as long as the draft is there.
  const draft = contract.kind === 'generation' && contract.detail.draftId ? (data?.drafts || []).find((item) => item.id === contract.detail.draftId) || null : null;
  const covered = useCoverage(draft ? { draftId: draft.id } : null, { version: `${data?.revision}:${draft?.draftVersion ?? ''}`, enabled: !live });
  // Where the draft stands (lib/shortfall.js): the same facts and words as the home row, which the strip under the header and the buttons of a refused run read.
  // Only the run that wrote the draft's marker says where the draft stands: an older record of the same draft (a refused run that was continued since) keeps its own numbers and no actions.
  const marker = draft?.editorial?.coverageRun, current = !marker?.jobId || marker.jobId === contract.jobId || marker.jobId === task.id || live;
  const shortfall = draft && current ? draftShortfall(draft, { view: covered.view, jobs: data?.jobs || [] }) : null;
  return (
    <section className="tc-detail" aria-label={ui('任务详情')} data-task-id={contract.jobId} data-status={contract.status} data-archived={archived ? 'true' : undefined}>
      <header className="tc-bar tc-head">
        <div className="tc-head__title">
          <h2>{summary.title}</h2>
          <span className="tc-head__sub">{joinMeta([summary.kindLabel, started && uiFormat('{0} 开始', [started])])}</span>
        </div>
        <div className="tc-head__actions">
          <Button size="sm" variant="quiet" className="tc-head__full" aria-pressed={full} onClick={onFull}>{full ? ui('退出全屏') : ui('全屏')}</Button>
          {actions.pause && <Button size="sm" aria-pressed="false" disabled={core.busy} onClick={() => act('pause')}>{ui('暂停')}</Button>}
          {actions.resume && <Button size="sm" aria-pressed="true" disabled={core.busy} onClick={() => act('resume')}>{ui('继续')}</Button>}
          {actions.retry && <Button size="sm" variant={shortfall?.action === 'model-settings' ? undefined : 'primary'} disabled={core.busy} title={run ? uiFormat('继续第 {0} 轮：已通过的题都保留，这一轮从头重做', [run.round]) : ui('已完成的部分会直接复用，不会重复付费')} onClick={() => act('retry')}>{ui('接着做')}</Button>}
          {toggle && live && <Checkbox className="tc-head__auto" label={autoLabel()} checked={toggle.value} disabled={core.busy} data-run-auto
            onChange={(value) => core.act('job.control', { jobId: contract.jobId, action: 'set', patch: { autoComplete: value } })} />}
          {result && <Button size="sm" onClick={result.run}>{result.label}</Button>}
          {shortfall?.action === 'model-settings' && !live && settingsEntry?.openModelSettings && <Button size="sm" variant="primary" data-shortfall-act="model-settings" onClick={settingsEntry.openModelSettings}>{actionLabel('model-settings')}</Button>}
          {draft && !live && <CoverageTopUpPopover draft={draft} view={covered.view} jobs={data?.jobs || []} modelReady={modelReadiness(data || {}).ready}
            onTopUp={(target, sectionIds) => core.act('generate', topUpArgs(target, sectionIds), (job) => core.notify?.(topUpNotice(target, job)))} />}
          {actions.cancel && <Button size="sm" variant="danger" disabled={core.busy} title={run ? ui('已通过的题都保留') : undefined} onClick={() => act('cancel')}>{run ? ui('停在这里') : ui('停止')}</Button>}
          {archived && <Button size="sm" disabled={core.busy} onClick={unarchive}>{ui('取消归档')}</Button>}
          {!live && !archived && !contract.detail.today && (day
            // A past day of 为你定制 is a record its own file ages out (fourteen days): 知道了 removes it, as it always did.
            ? <Tooltip content={ui('删除这一天的记录；为你定制只保留最近 14 天。')} layer placement="bottom-end">
              <Button size="sm" variant="quiet" disabled={core.busy} onClick={() => core.act('job.dismiss', { jobId: task.id })}>{ui('知道了')}</Button>
            </Tooltip>
            : <Tooltip content={ui('放进「已归档」，不会删除任何东西；之后可以取消归档或删除。')} layer placement="bottom-end">
              <Button size="sm" variant="quiet" disabled={core.busy} onClick={archive}>{ui('知道了')}</Button>
            </Tooltip>)}
          {!live && !day && <Button size="sm" variant="danger" className="tc-head__delete" disabled={core.busy} onClick={() => onDelete([key])}>{ui('删除')}</Button>}
        </div>
      </header>
      <Metrics job={task} summary={summary} now={now} />
      <TaskUsage contract={contract} />
      <RunLine task={task} shortfall={shortfall} />
      <TimeLimit task={task} now={now} steps={steps} onPick={(id) => setFocusCall({ id, at: Date.now() })} />
      {archived ? <ArchivedNote task={task} /> : <ControlRow job={task} />}
      {usage && <p className="tc-usage" aria-label={ui('用量')}>{usage}</p>}
      <TaskBody task={task} archived={archived} marks={marks} focusCall={focusCall} />
    </section>
  );
}

export default function TaskConsole({ data, openers, initialFilter = 'all' }) {
  useInjectCss(denseCss, 'study-dense-surface');
  useInjectCss(css, 'study-task-console');
  const { lib, core } = useApp();
  const quick = useQuickActions();
  const focus = lib.taskFocus;
  // A task that is being archived is already out of the list (it is listed under 已归档 at once; the host's snapshot confirms it a moment later).
  const tasks = useMemo(() => tasksOf(data).filter((task) => !task.leaving), [data]);
  const archived = useMemo(() => archivedTasksOf(data), [data]);
  const [filter, setFilter] = useState(initialFilter), [current, setCurrent] = useState(null), seen = useRef(null), listRef = useRef(null);
  const [selection, setSelection] = useState(() => new Set()), [working, setWorking] = useState(false), [deleting, setDeleting] = useState(null);
  // 全屏 folds the list away so the detail has the whole width; it is remembered for this viewer (and never needed for anything to work).
  const [full, setFull] = useState(() => readJSON('study-task-console-full', false) === true);
  const toggleFull = useCallback(() => setFull((value) => { writeJSON('study-task-console-full', !value); return !value; }), []);
  const shown = useMemo(() => (filter === 'archived' ? archived : filterTasks(tasks, filter)), [tasks, archived, filter]);
  const picked = pickTask({ tasks: shown, focus, current, focusSeen: seen.current });
  // A deep link is followed once; after that the learner's own selection stands.
  useEffect(() => {
    const live = focus && focus.nonce !== seen.current && tasks.find((task) => taskId(task) === focus.jobId || task.id === focus.jobId);
    const kept = focus && focus.nonce !== seen.current && !live && archived.find((task) => taskId(task) === focus.jobId || task.id === focus.jobId);
    const target = live || kept;
    if (target) {
      seen.current = focus.nonce;
      setFilter(live ? 'all' : 'archived');
      setCurrent(taskId(target));
    }
  }, [focus, tasks, archived]);
  // What is selected is only ever what the list in front of the learner shows: another filter or a refresh drops the rest.
  useEffect(() => { setSelection((before) => reconcileSelection(before, shown)); }, [shown]);
  const pick = useCallback((id) => setCurrent(id), []);
  const check = useCallback((id) => setSelection((before) => toggleSelection(before, id)), []);
  const task = shown.find((item) => taskId(item) === picked) || null;
  const filters = taskFilters(tasks, archived);
  const summary = selectionSummary(shown, selection);
  const everything = useMemo(() => new Map([...tasks, ...archived].map((item) => [taskId(item), item])), [tasks, archived]);
  const report = (action, result) => {
    if (result.ok === false) { core.setError?.(result.message || ui('没有完成，请再试一次。')); return false; }
    core.notify?.(batchMessage(action, result));
    Promise.resolve(core.refresh?.()).catch(() => {});
    return true;
  };
  const run = async (action) => {
    const ids = [...selection];
    setWorking(true);
    try { if (report(action, await batchRun(action, ids, { quick, core }))) setSelection(new Set()); } finally { setWorking(false); }
  };
  // 删除 asks first. The dialog names what goes and what stays; it deletes through the same calls and reports the same way.
  const confirmDelete = async () => {
    const ids = deleting.ids, result = await batchRun('delete', ids, { quick, core });
    if (result.ok === false) throw new Error(result.message || failureText(''));
    report('delete', result);
    setSelection((before) => new Set([...before].filter((id) => !ids.includes(id))));
  };
  const askDelete = useCallback((ids) => setDeleting({ ids }), []);
  // Esc ends the selection while the focus is in the list (a box, a row, the bar) or nowhere. It listens on the window, before the tooltip of the box (open while it has the focus) takes the
  // key at the document: one press ends the selection and closes the tooltip, instead of the first press only closing the tooltip. An open dialog has the focus, so its Esc is its own.
  const selecting = selection.size > 0;
  useEffect(() => {
    if (!selecting) return undefined;
    const end = (event) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      const at = event.target;
      if (at === document.body || at === document.documentElement || listRef.current?.contains(at)) setSelection(new Set());
    };
    window.addEventListener('keydown', end, true);
    return () => window.removeEventListener('keydown', end, true);
  }, [selecting]);
  const kind = (id) => { const item = everything.get(id); return item ? contractOf(item).kind : null; };
  return (
    <div className="tc" data-surface="dense" data-usage-area="tasks" data-full={full ? 'true' : 'false'}>
      <section className="tc-list" aria-label={ui('任务列表')} ref={listRef}>
        <div className="tc-bar">
          <h1>{ui('任务')}</h1>
        </div>
        <div className="tc-filterbar">
          <div className="tc-filters" role="group" aria-label={ui('筛选')}>
            {filters.map((item) => (
              <Button key={item.id} size="sm" className="tc-filter" aria-pressed={filter === item.id} onClick={() => setFilter(item.id)}>{`${ui(FILTER_LABEL[item.id])} ${item.count}`}</Button>
            ))}
          </div>
        </div>
        <SelectBar filter={filter} summary={summary} busy={working || core.busy} onToggleAll={() => setSelection((before) => toggleAll(shown, before))}
          onArchive={() => run('archive')} onUnarchive={() => run('unarchive')} onDelete={() => askDelete([...selection])} onClear={() => setSelection(new Set())} />
        <div className="tc-scroll">
          {shown.length === 0 && <p className="tc-empty">{filter === 'archived' ? ui('还没有归档的任务。已结束的任务点「知道了」或选中后点「归档」，会放在这里。') : ui('现在没有任务。生成题目、导入录音或转换 PDF 后，会在这里看到它们。')}</p>}
          {shown.map((item) => <TaskItem key={taskId(item)} task={item} summary={taskSummary(item)} picked={taskId(item) === picked} checked={selection.has(taskId(item))} onPick={pick} onCheck={check} />)}
        </div>
      </section>
      {task ? <Detail key={taskId(task)} task={task} data={data} openers={openers} full={full} onFull={toggleFull} onDelete={askDelete} />
        : <section className="tc-detail" aria-label={ui('任务详情')}><p className="tc-empty">{ui('选择左边的一个任务查看详情。')}</p></section>}
      {deleting && <DeleteTasksDialog count={deleting.ids.length} archived={deleting.ids.filter((id) => archived.some((item) => taskId(item) === id)).length}
        audio={deleting.ids.filter((id) => kind(id) === 'audio-import').length} onConfirm={confirmDelete} onClose={() => setDeleting(null)} />}
    </div>
  );
}
