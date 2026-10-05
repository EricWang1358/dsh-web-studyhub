import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ui, uiFormat } from '../i18n.js';
import { Button, useNow } from '../components/index.js';
import { useInjectCss } from '../shared.js';
import { useApp } from '../app/app-context.js';
import { useQuickActions, dismissJobs } from '../quick-actions.js';
import { isCancellable, isActiveJob } from '../../lib/job-status.js';
import { formatDateTime, joinMeta } from '../format.js';
import denseCss from '../dense-surface.css';
import css from './task-console.css';
import { tasksOf, taskFilters, filterTasks, pickTask } from './task-model.js';
import { taskSummary, stateLabel } from './task-summary.js';
import { taskFacts, taskSegments } from './task-facts.js';
import { canPause, isPaused } from './task-control.js';
import ControlRow from './ControlRow.jsx';

/* The 任务 console. One surface for every background job: a list on the left, the whole story of the selected job on the right. It reads
   the jobs of the snapshot as they are (`data.jobs`) and sends the same actions the cards sent (job.cancel, job.dismiss). */

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

function Detail({ task, data, openers }) {
  const { core } = useApp();
  const quick = useQuickActions();
  const summary = taskSummary(task, { drafts: data.drafts, jobs: data.jobs });
  const running = isActiveJob(task), now = useNow(1000, { enabled: running });
  const result = openers.resultOf(task), paused = isPaused(task);
  const pause = async () => { try { await core.call('job.control', { jobId: task.id, patch: { paused: !paused } }); } catch { /* the row below says what went wrong when the learner tries a knob */ } };
  const started = task.startedAt ? formatDateTime(task.startedAt, 'stamp') : '';
  return (
    <section className="tc-detail" aria-label={ui('任务详情')} data-task-id={task.id}>
      <header className="tc-bar tc-head">
        <div className="tc-head__title">
          <h2>{summary.title}</h2>
          <span className="tc-head__sub">{joinMeta([summary.kindLabel, started && uiFormat('{0} 开始', [started])])}</span>
        </div>
        <div className="tc-head__actions">
          {canPause(task) && <Button size="sm" aria-pressed={paused} onClick={pause}>{paused ? ui('继续') : ui('暂停')}</Button>}
          {result && <Button size="sm" onClick={result.run}>{result.label}</Button>}
          {isCancellable(task) && <Button size="sm" variant="danger" disabled={core.busy} onClick={() => core.act('job.cancel', { jobId: task.id })}>{ui('停止')}</Button>}
          {!running && <Button size="sm" variant="quiet" disabled={core.busy} onClick={() => (quick ? dismissJobs(quick, task.id) : core.act('job.dismiss', { jobId: task.id }))}>{ui('知道了')}</Button>}
        </div>
      </header>
      <Metrics job={task} summary={summary} now={now} />
      <ControlRow job={task} />
      <div className="tc-body" />
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
  const shown = useMemo(() => filterTasks(tasks, filter), [tasks, filter]);
  const picked = pickTask({ tasks: shown, focus, current, focusSeen: seen.current });
  // A deep link is followed once; after that the learner's own selection stands.
  useEffect(() => {
    if (focus && focus.nonce !== seen.current && tasks.some((task) => task.id === focus.jobId)) {
      seen.current = focus.nonce;
      setFilter('all');
      setCurrent(focus.jobId);
    }
  }, [focus, tasks]);
  const pick = useCallback((id) => setCurrent(id), []);
  const task = shown.find((item) => item.id === picked) || null;
  const filters = taskFilters(tasks);
  return (
    <div className="tc" data-surface="dense" data-usage-area="tasks">
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
          {shown.map((item) => <TaskRow key={item.id} summary={taskSummary(item, { drafts: data.drafts, jobs: data.jobs })} selected={item.id === picked} onPick={pick} />)}
        </div>
      </section>
      {task ? <Detail key={task.id} task={task} data={data} openers={openers} />
        : <section className="tc-detail" aria-label={ui('任务详情')}><p className="tc-empty">{ui('选择左边的一个任务查看详情。')}</p></section>}
    </div>
  );
}
