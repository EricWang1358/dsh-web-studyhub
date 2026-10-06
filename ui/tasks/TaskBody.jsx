import React, { useEffect, useId, useMemo, useState } from 'react';
import { ui, uiFormat } from '../i18n.js';
import { Tabs, TabPanel } from '../components/index.js';
import { contractOf, isRunningTask, taskKindOf } from './task-model.js';
import { runningCalls } from './call-model.js';
import Timeline from './Timeline.jsx';
import RunningCalls from './RunningCalls.jsx';
import OutputPanel from './OutputPanel.jsx';
import LogPanel from './LogPanel.jsx';
import AudioFiles from './AudioFiles.jsx';
import GenerationParts from './GenerationParts.jsx';
import CoachBatches from './CoachBatches.jsx';
import { PdfDetail } from '../PdfConvertJob.jsx';

/* The two columns under the controls, one template for every kind of job: on the left the parallel timeline above the tabs 「正在进行」 and the kind's own
   section (文件 for audio, 轮次与批次 for a question run); on the right the tabs 「实时输出」 and 「日志」. Both columns are as tall as the window leaves them and
   every list scrolls inside its own panel, so a job with one file looks as complete as one with fifty, and nothing here grows the page. */

const SECTIONS = {
  audio: { value: 'files', label: '文件', count: (contract) => contract.detail.files?.length || 0, View: AudioFiles },
  generation: { value: 'parts', label: '轮次与批次', count: (contract) => contract.detail.partList?.length || 0, View: GenerationParts },
  supplement: { value: 'parts', label: '轮次与批次', count: (contract) => contract.detail.partList?.length || 0, View: GenerationParts },
  coach: { value: 'batches', label: '批次', count: (contract) => contract.detail.batches?.length || 0, View: CoachBatches },
  pdf: { value: 'convert', label: '转换详情', count: () => '', View: ({ task }) => <div className="tc-scroll"><PdfDetail job={task} /></div> },
};

/* `marks` (callId -> 'long' | 'slowest', time-limit.js) draws the steps the time-limit strip points at on the timeline; `focusCall` ({ id, at }) is that strip asking for one of them: it is selected and its output shown, like a click on its bar. */
export default function TaskBody({ task, archived = false, marks, focusCall }) {
  const contract = contractOf(task), calls = contract.calls, live = isRunningTask(task), kind = taskKindOf(task);
  const section = SECTIONS[kind], left = useId(), right = useId();
  const [selected, setSelected] = useState(null), [leftTab, setLeftTab] = useState('running'), [rightTab, setRightTab] = useState('output');
  const running = useMemo(() => runningCalls(calls), [calls]);
  const target = calls.find((call) => call.callId === selected) || running.find((call) => call.kind !== 'wait') || null;
  const choose = (callId) => { setSelected(callId); setRightTab('output'); };
  useEffect(() => { if (focusCall?.id) { setSelected(focusCall.id); setRightTab('output'); } }, [focusCall]);
  const leftItems = [{ value: 'running', label: uiFormat('正在进行 {0}', [running.length]) }, ...(section ? [{ value: section.value, label: `${ui(section.label)} ${section.count(contract)}`.trim() }] : [])];
  const View = section?.View;
  return (
    <div className="tc-body">
      <div className="tc-col">
        <Timeline calls={calls} running={live} family={kind === 'audio' ? 'audio' : kind === 'coach' ? 'coach' : 'generation'} selected={target?.callId} marks={marks} onSelect={choose} />
        <Tabs id={left} className="tc-tabs" itemClassName="tc-tab" label={ui('左侧面板')} value={leftTab} onChange={setLeftTab} items={leftItems} />
        <TabPanel id={left} value="running" selected={leftTab} className="tc-panel" tabIndex={undefined}>
          <div className="tc-scroll"><RunningCalls calls={calls} active={live} selected={target?.callId} onSelect={choose} /></div>
        </TabPanel>
        {section && <TabPanel id={left} value={section.value} selected={leftTab} className="tc-panel" tabIndex={undefined}><View contract={contract} task={task} /></TabPanel>}
      </div>
      <div className="tc-col">
        <Tabs id={right} className="tc-tabs" itemClassName="tc-tab" label={ui('右侧面板')} value={rightTab} onChange={setRightTab}
          items={[{ value: 'output', label: ui('实时输出') }, { value: 'log', label: ui('日志') }]} />
        <TabPanel id={right} value="output" selected={rightTab} className="tc-panel" tabIndex={undefined}><OutputPanel jobId={contract.jobId} call={target} active={live} archived={archived} /></TabPanel>
        <TabPanel id={right} value="log" selected={rightTab} className="tc-panel" tabIndex={undefined}><LogPanel contract={contract} /></TabPanel>
      </div>
    </div>
  );
}
