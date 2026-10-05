import React, { useState } from 'react';
import { ui, uiFormat } from '../i18n.js';
import { Badge, Button } from '../components/index.js';
import { useApp } from '../app/app-context.js';
import { failureText } from '../failure.js';
import { joinMeta } from '../format.js';

/* 文件: one row per recording (a single recording is one row, and the panel still looks complete), each with its three stage bars and its state. A file
   whose extension and content disagree carries a small 「实为 WAV」 badge on its own row; the grouped notice is the one line in the log. A selected row
   shows, in a strip of fixed height at the bottom, the stage counts and what can be done about that file. */

const STAGES = [['transcribe', '转写'], ['proofread', '校对'], ['translate', '翻译']];
const STATUS_WORD = { complete: '已完成', running: '处理中', queued: '排队中', waiting: '等待中', blocked: '未通过预检', failed: '失败', cancelled: '已取消', skipped: '已跳过' };
const state = (file) => (file.status === 'complete' ? 'done' : file.status === 'running' ? 'run' : file.status === 'failed' || file.status === 'blocked' ? 'fail' : file.status === 'skipped' || file.status === 'cancelled' ? 'stopped' : 'queued');

function Cells({ file }) {
  return (
    <span className="tc-cells" role="img" aria-label={STAGES.map(([stage, label]) => `${ui(label)} ${file.steps?.[stage]?.done ?? 0}/${file.steps?.[stage]?.total ?? 0}`).join('，')}>
      {STAGES.map(([stage]) => {
        const step = file.steps?.[stage], done = step?.total > 0 ? step.done / step.total : file.status === 'complete' ? 1 : 0;
        return <i key={stage} data-stage={stage}><b style={{ transform: `scaleX(${Math.min(1, done)})` }} /></i>;
      })}
    </span>
  );
}

export default function AudioFiles({ contract }) {
  const { core } = useApp();
  const files = contract.detail.files || [], blocked = contract.detail.blocked;
  const [picked, setPicked] = useState(files.length === 1 ? 0 : Number.isInteger(blocked?.index) ? blocked.index : null), [problem, setProblem] = useState('');
  const file = picked !== null ? files[picked] : null;
  const skip = async () => {
    setProblem('');
    try { await core.act('audio.retry', { jobId: contract.attemptId || contract.jobId, skip: [file.index] }); } catch (error) { setProblem(failureText(error)); }
  };
  const canSkip = file && blocked && blocked.index === file.index && contract.actions.retry.available;
  return (
    <div className="tc-files">
      <div className="tc-scroll">
        {files.map((item, index) => (
          <Button key={`${index}:${item.filename}`} variant="quiet" block className="tc-filerow" aria-pressed={picked === index} data-file={item.filename} onClick={() => setPicked(picked === index ? null : index)}>
            <span className="tc-dot" data-state={state(item)} aria-hidden="true" />
            <span className="tc-filerow__name"><span className="tc-filerow__text">{item.filename}</span>{item.actualFormat && <Badge size="sm" tone="info">{uiFormat('实为 {0}', [item.actualFormat])}</Badge>}</span>
            <Cells file={item} />
            <span className="tc-num">{item.status === 'running' && Number.isFinite(item.percent) ? `${item.percent}%` : ui(STATUS_WORD[item.status] || '排队中')}</span>
          </Button>
        ))}
      </div>
      <div className="tc-strip" aria-live="polite">
        {file ? <>
          <span className="tc-strip__title">{file.filename}</span>
          <span className="tc-strip__line">{joinMeta(STAGES.filter(([stage]) => file.steps?.[stage]?.total > 0).map(([stage, label]) => uiFormat('{0} {1}/{2}', [ui(label), file.steps[stage].done, file.steps[stage].total]))) || ui('还没有开始')}
            {file.reused ? ` · ${ui('复用了已保存的结果')}` : ''}{file.stage ? ` · ${file.stage}` : ''}</span>
          {canSkip && <Button size="sm" disabled={core.busy} onClick={skip}>{ui('跳过这个文件继续')}</Button>}
          {problem && <span className="tc-strip__problem">{problem}</span>}
        </> : <span className="tc-strip__hint">{ui('选一个文件，在这里看它每一步的进度。')}</span>}
      </div>
    </div>
  );
}
