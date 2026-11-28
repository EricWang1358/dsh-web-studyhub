import React, { useEffect, useId, useMemo, useState } from 'react';
import { ui, uiFormat, uiMessage } from '../i18n.js';
import { Button, Tabs, TabPanel, useNow } from '../components/index.js';
import { useScrollEdges } from '../components/use-scroll-edges.js';
import { useApp } from '../app/app-context.js';
import AgentLink from '../AgentLink.jsx';
import { formatDuration, formatElapsed, formatNumber, joinMeta } from '../format.js';
import { contractOf, isRunningTask, taskKindOf } from './task-model.js';
import { callLabel, runnerLabel, runningCalls } from './call-model.js';
import Timeline from './Timeline.jsx';
import RunningCalls from './RunningCalls.jsx';
import OutputPanel from './OutputPanel.jsx';
import LogPanel from './LogPanel.jsx';
import AudioFiles from './AudioFiles.jsx';
import GenerationParts from './GenerationParts.jsx';
import PlanTable, { planTabItem } from './PlanTable.jsx';
import CoachBatches from './CoachBatches.jsx';
import CoachOutputNote from './CoachOutputNote.jsx';
import { PdfDetail } from '../PdfConvertJob.jsx';
import BookBoard from './BookBoard.jsx';
import InstallStages from '../install/InstallStages.jsx';
import IndexDetail from './IndexDetail.jsx';
import RequestTracePanel from './RequestTracePanel.jsx';

/* The two columns under the controls, one template for every kind of job: on the left the parallel timeline above the tabs 「正在进行」 and the kind's own
   section (文件 for audio, 轮次与批次 for a question run); on the right the tabs 「实时输出」 and 「日志」. Both columns are as tall as the window leaves them and
   every list scrolls inside its own panel, so a job with one file looks as complete as one with fifty, and nothing here grows the page. */

const stepDot = (status) => (status === 'ok' ? 'done' : status === 'failed' ? 'fail' : status === 'cancelled' || status === 'skipped' ? 'stopped' : 'run');
const stepTime = (call, now) => {
  const start = Date.parse(call.startedAt);
  if (!Number.isFinite(start)) return '';
  if (call.endedAt && Number.isFinite(Date.parse(call.endedAt))) return formatDuration(Math.max(0, Date.parse(call.endedAt) - start));
  return formatElapsed(Math.max(0, now - start));
};

function MaterialSteps({ contract, selected, onSelect }) {
  const { host } = useApp();
  const steps = useMemo(() => (contract.calls || []).filter((call) => call.kind !== 'wait'), [contract.calls]);
  const anyRunning = steps.some((call) => call.status === 'running');
  const now = useNow(1000, { enabled: anyRunning });
  if (!steps.length) return <div className="tc-scroll" data-material-steps><p className="tc-empty">{ui('还没有步骤记录。')}</p></div>;
  return (
    <div className="tc-scroll" data-material-steps>
      {steps.map((call) => (
        <div key={call.callId} className="tc-partrow" data-step-stage={call.stage || call.kind}>
          <Button variant="quiet" block className="tc-callrow" aria-pressed={selected === call.callId} data-call-id={call.callId} onClick={() => onSelect(call.callId)}>
            <span className="tc-dot" data-state={stepDot(call.status)} aria-hidden="true" />
            <span className="tc-callrow__step">{callLabel(call)}</span>
            <span className="tc-num">{stepTime(call, now)}</span>
            <span className="tc-callrow__by">{joinMeta([runnerLabel(call), call.tokens > 0 ? uiFormat('{0} tok', [formatNumber(call.tokens)]) : '', call.slot ? `${ui('并发通道')} ${call.slot}` : ''])}</span>
          </Button>
          <AgentLink childId={call.childId} parentId={call.parentId} openAgent={host?.openAgent} className="tc-partrow__open"
            label={ui('查看后台助手')} ariaLabel={uiFormat('查看后台助手：{0}', [callLabel(call)])} />
        </div>
      ))}
    </div>
  );
}

const MATERIAL_STEPS_SECTION = {
  value: 'steps',
  label: '执行步骤',
  count: (contract) => (contract.calls || []).filter((call) => call.kind !== 'wait').length,
  View: MaterialSteps,
};

const SECTIONS = {
  audio: { value: 'files', label: '文件', count: (contract) => contract.detail.files?.length || 0, View: AudioFiles },
  generation: { value: 'parts', label: '轮次与批次', count: (contract) => contract.detail.partList?.length || 0, View: GenerationParts },
  supplement: { value: 'parts', label: '轮次与批次', count: (contract) => contract.detail.partList?.length || 0, View: GenerationParts },
  coach: { value: 'batches', label: '批次', count: (contract) => contract.detail.batches?.length || 0, View: CoachBatches },
  pdf: { value: 'convert', label: '转换详情', count: () => '', View: ({ task }) => <div className="tc-scroll"><PdfDetail job={task} /></div> },
  'material-classify': MATERIAL_STEPS_SECTION,
  'material-organize': MATERIAL_STEPS_SECTION,
  assist: MATERIAL_STEPS_SECTION,
};
/** A one-click install (Marker, MinerU; the legacy row or the Job): its steps, done, active, failed or still to come. */
const INSTALL_SECTION = { value: 'steps', label: '安装步骤', count: (contract) => contract.detail.install.steps.length,
  View: ({ contract }) => <div className="tc-scroll"><InstallStages stages={contract.detail.install.steps.map((step) => ({ ...step, name: uiMessage(step.name) }))} label={ui('安装步骤')} className="tc-steps" markClassName="tc-steps__mark" /></div> };
/** A search-index build: what it wrote, kept and could not write (./IndexDetail.jsx). */
const INDEX_SECTION = { value: 'index', label: '索引详情', count: () => '', View: IndexDetail };
/** A review book build: each knowledge point and where it is (written, reviewed, complete or short). */
const BOOK_SECTION = { value: 'points', label: '知识点', count: (contract) => contract.detail.book?.board?.length || 0, View: BookBoard };

/* `marks` (callId -> 'long' | 'slowest', time-limit.js) draws the steps the time-limit strip points at on the timeline; `focusCall` ({ id, at }) is that strip asking for one of them: it is selected and its output shown, like a click on its bar. */
export default function TaskBody({ task, archived = false, marks, focusCall }) {
  const contract = contractOf(task), calls = contract.calls, live = isRunningTask(task), kind = taskKindOf(task);
  const isMaterialTask = kind === 'material-classify' || kind === 'material-organize';
  const hasStepList = isMaterialTask || kind === 'assist';
  const install = Array.isArray(contract.detail?.install?.steps), index = contract.kind === 'retrieval-index';
  const section = contract.kind === 'audio-live-correction' ? null : contract.kind === 'course-book-build' ? BOOK_SECTION : install ? INSTALL_SECTION : index ? INDEX_SECTION : SECTIONS[kind], left = useId(), right = useId();
  const [selected, setSelected] = useState(null), [leftTab, setLeftTab] = useState(() => (hasStepList && !live ? 'steps' : 'running')), [rightTab, setRightTab] = useState('output');
  // Both tab strips fade the side that still has a panel beyond it (ui/components/scroll-fade.css, #747); the scroll position and the arrow keys are untouched.
  const [leftStrip, leftEdges, measureLeft] = useScrollEdges();
  const [rightStrip, rightEdges, measureRight] = useScrollEdges();
  const running = useMemo(() => runningCalls(calls), [calls]);
  const fallbackCall = hasStepList && !live ? calls.filter((call) => call.kind !== 'wait').at(-1) || null : null;
  const target = calls.find((call) => call.callId === selected) || running.find((call) => call.kind !== 'wait') || fallbackCall;
  const choose = (callId) => { setSelected(callId); setRightTab((cur) => (cur === 'trace' ? 'trace' : 'output')); };
  useEffect(() => { if (focusCall?.id) { setSelected(focusCall.id); setRightTab('output'); } }, [focusCall]);
  // A PDF conversion, an install and a search-index build make no model calls: no timeline, no 正在进行 and no 实时输出 (they would only say there are none); a
  // conversion's windows are in 转换详情, an install's steps in 安装步骤, a build's pages in 索引详情, and the story of each in 日志.
  const callFree = (kind === 'pdf' && !!section) || install || index;
  const leftItems = [...(callFree ? [] : [{ value: 'running', label: uiFormat('正在进行 {0}', [running.length]) }]), ...(section ? [{ value: section.value, label: `${ui(section.label)} ${section.count(contract)}`.trim() }] : [])];
  // 目标与知识点: a question run or a top-up lists the points its plan holds (ui/tasks/PlanTable.jsx), as a third tab beside the two.
  const planned = kind === 'generation' || kind === 'supplement';
  const hasRequestTrace = planned || kind === 'repair' || contract.kind === 'course-book-build' || contract.kind === 'companion-lesson-build';
  if (planned) leftItems.push(planTabItem(contract));
  const tab = leftItems.some((item) => item.value === leftTab) ? leftTab : leftItems[0].value;
  const rightItems = [
    ...(callFree ? [] : [{ value: 'output', label: ui('实时输出') }]),
    ...(hasRequestTrace ? [{ value: 'trace', label: ui('发送内容') }] : []),
    { value: 'log', label: ui('日志') },
  ];
  const rightShown = rightItems.some((item) => item.value === rightTab) ? rightTab : 'log';
  const View = section?.View;
  return (
    <div className="tc-body">
      <div className="tc-col">
        {!callFree && <Timeline calls={calls} running={live} family={kind === 'audio' ? 'audio' : kind === 'coach' ? 'coach' : isMaterialTask ? kind : 'generation'} contractKind={isMaterialTask ? kind : contract.kind} selected={target?.callId} marks={marks} onSelect={choose} />}
        <Tabs id={left} ref={leftStrip} className="tc-tabs sh-fade-x sh-fade-x--pad" data-fade-start={leftEdges.start || undefined} data-fade-end={leftEdges.end || undefined}
          onScroll={measureLeft} itemClassName="tc-tab" label={ui('左侧面板')} value={tab} onChange={setLeftTab} items={leftItems} />
        {!callFree && <TabPanel id={left} value="running" selected={tab} className="tc-panel" tabIndex={undefined}>
          <div className="tc-scroll"><RunningCalls calls={calls} active={live} selected={target?.callId} onSelect={choose} /></div>
        </TabPanel>}
        {section && <TabPanel id={left} value={section.value} selected={tab} className="tc-panel" tabIndex={undefined}><View contract={contract} task={task} selected={target?.callId} onSelect={choose} /></TabPanel>}
        {planned && <TabPanel id={left} value="plan" selected={tab} className="tc-panel" tabIndex={undefined}><PlanTable contract={contract} task={task} /></TabPanel>}
      </div>
      <div className="tc-col">
        <Tabs id={right} ref={rightStrip} className="tc-tabs sh-fade-x sh-fade-x--pad" data-fade-start={rightEdges.start || undefined} data-fade-end={rightEdges.end || undefined}
          onScroll={measureRight} itemClassName="tc-tab" label={ui('右侧面板')} value={rightShown} onChange={setRightTab} items={rightItems} />
        {/* A day of 为你定制 has no sub-agent and keeps no output: its 实时输出 says so and shows the batch instead of asking job.output for nothing. */}
        {!callFree && <TabPanel id={right} value="output" selected={rightShown} className="tc-panel" tabIndex={undefined}>
          {kind === 'coach' ? <CoachOutputNote contract={contract} call={target} /> : <OutputPanel jobId={contract.jobId} call={target} active={live} archived={archived} />}
        </TabPanel>}
        {hasRequestTrace && <TabPanel id={right} value="trace" selected={rightShown} className="tc-panel" tabIndex={undefined}>
          <RequestTracePanel jobId={contract.jobId} selectedCallId={target?.callId || null} callCount={calls.length} archived={archived} />
        </TabPanel>}
        <TabPanel id={right} value="log" selected={rightShown} className="tc-panel" tabIndex={undefined}><LogPanel contract={contract} /></TabPanel>
      </div>
    </div>
  );
}
