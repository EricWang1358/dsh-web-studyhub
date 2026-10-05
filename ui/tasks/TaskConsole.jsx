import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ui, uiFormat } from '../i18n.js';
import { Button, useNow } from '../components/index.js';
import { useInjectCss } from '../shared.js';
import { useApp } from '../app/app-context.js';
import { useQuickActions, dismissJobs } from '../quick-actions.js';
import { formatDateTime, joinMeta } from '../format.js';
import denseCss from '../dense-surface.css';
import css from './task-console.css';
import { contractOf, tasksOf, taskId, taskFilters, filterTasks, pickTask, isRunningTask } from './task-model.js';
import { taskSummary, stateLabel } from './task-summary.js';
import { taskFacts, taskSegments } from './task-facts.js';
import { headerActions } from './task-control.js';
import ControlRow from './ControlRow.jsx';
import TaskBody from './TaskBody.jsx';
import { readJSON, writeJSON } from '../storage.js';

/* The 任务 console. One surface for every background job: a list on the left, the whole story of the selected job on the right. It reads the jobs of
   the snapshot through their contract (lib/job-contract.js) and sends every action to job.control; what it offers is what the contract says is available. */

const FILTER_LABEL = { all: '全部', running: '进行中', failed: '失败' };

function percentWord(summary) {
  if (summary.state === 'fail') return ui('失败');
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

function Detail({ task, data, openers, full, onFull }) {
  const { core } = useApp();
  const quick = useQuickActions();
  const contract = contractOf(task), summary = taskSummary(task), actions = headerActions(task);
  const live = isRunningTask(task), now = useNow(1000, { enabled: live });
  const result = openers.resultOf(task, data);
  const started = contract.startedAt ? formatDateTime(contract.startedAt, 'stamp') : '';
  const act = (action) => core.act('job.control', { jobId: contract.jobId, action });
  return (
    <section className="tc-detail" aria-label={ui('任务详情')} data-task-id={contract.jobId} data-status={contract.status}>
      <header className="tc-bar tc-head">
        <div className="tc-head__title">
          <h2>{summary.title}</h2>
          <span className="tc-head__sub">{joinMeta([summary.kindLabel, started && uiFormat('{0} 开始', [started])])}</span>
        </div>
        <div className="tc-head__actions">
          <Button size="sm" variant="quiet" className="tc-head__full" aria-pressed={full} onClick={onFull}>{full ? ui('退出全屏') : ui('全屏')}</Button>
          {actions.pause && <Button size="sm" aria-pressed="false" disabled={core.busy} onClick={() => act('pause')}>{ui('暂停')}</Button>}
          {actions.resume && <Button size="sm" aria-pressed="true" disabled={core.busy} onClick={() => act('resume')}>{ui('继续')}</Button>}
          {actions.retry && <Button size="sm" variant="primary" disabled={core.busy} title={ui('已完成的部分会直接复用，不会重复付费')} onClick={() => act('retry')}>{ui('接着做')}</Button>}
          {result && <Button size="sm" onClick={result.run}>{result.label}</Button>}
          {actions.cancel && <Button size="sm" variant="danger" disabled={core.busy} onClick={() => act('cancel')}>{ui('停止')}</Button>}
          {!live && <Button size="sm" variant="quiet" disabled={core.busy} onClick={() => (quick ? dismissJobs(quick, task.id) : core.act('job.dismiss', { jobId: task.id }))}>{ui('知道了')}</Button>}
        </div>
      </header>
      <Metrics job={task} summary={summary} now={now} />
      <ControlRow job={task} />
      <TaskBody task={task} />
    </section>
  );
}

export default function TaskConsole({ data, openers }) {
  useInjectCss(denseCss, 'study-dense-surface');
  useInjectCss(css, 'study-task-console');
  const { lib } = useApp();
  const focus = lib.taskFocus;
  const tasks = useMemo(() => tasksOf(data), [data]);
  const [filter, setFilter] = useState('all'), [current, setCurrent] = useState(null), seen = useRef(null);
  // 全屏 folds the list away so the detail has the whole width; it is remembered for this viewer (and never needed for anything to work).
  const [full, setFull] = useState(() => readJSON('study-task-console-full', false) === true);
  const toggleFull = useCallback(() => setFull((value) => { writeJSON('study-task-console-full', !value); return !value; }), []);
  const shown = useMemo(() => filterTasks(tasks, filter), [tasks, filter]);
  const picked = pickTask({ tasks: shown, focus, current, focusSeen: seen.current });
  // A deep link is followed once; after that the learner's own selection stands.
  useEffect(() => {
    const target = focus && focus.nonce !== seen.current && tasks.find((task) => taskId(task) === focus.jobId || task.id === focus.jobId);
    if (target) {
      seen.current = focus.nonce;
      setFilter('all');
      setCurrent(taskId(target));
    }
  }, [focus, tasks]);
  const pick = useCallback((id) => setCurrent(id), []);
  const task = shown.find((item) => taskId(item) === picked) || null;
  const filters = taskFilters(tasks);
  return (
    <div className="tc" data-surface="dense" data-usage-area="tasks" data-full={full ? 'true' : 'false'}>
      <section className="tc-list" aria-label={ui('任务列表')}>
        <div className="tc-bar">
          <h1>{ui('任务')}</h1>
          <div className="tc-filters" role="group" aria-label={ui('筛选')}>
            {filters.map((item) => (
              <Button key={item.id} size="sm" className="tc-filter" aria-pressed={filter === item.id} onClick={() => setFilter(item.id)}>{`${ui(FILTER_LABEL[item.id])} ${item.count}`}</Button>
            ))}
          </div>
        </div>
        <div className="tc-scroll">
          {shown.length === 0 && <p className="tc-empty">{ui('现在没有任务。生成题目、导入录音或转换 PDF 后，会在这里看到它们。')}</p>}
          {shown.map((item) => <TaskRow key={taskId(item)} summary={taskSummary(item)} selected={taskId(item) === picked} onPick={pick} />)}
        </div>
      </section>
      {task ? <Detail key={taskId(task)} task={task} data={data} openers={openers} full={full} onFull={toggleFull} />
        : <section className="tc-detail" aria-label={ui('任务详情')}><p className="tc-empty">{ui('选择左边的一个任务查看详情。')}</p></section>}
    </div>
  );
}
