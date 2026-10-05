import { ui, uiFormat } from '../i18n.js';
import { formatElapsed, formatNumber } from '../format.js';
import { formatCompactTokens } from '../../lib/token-usage.js';
import { contractOf, isRunningTask } from './task-model.js';

/* The four facts beside a task's progress and the stage segments of its bar, read from the job's contract. */

const dash = '—';
const UNIT_LABEL = { files: '文件', pages: '页', paragraphs: '段落', questions: '题数' };
const SEGMENT_LABEL = { transcribe: '转写', proofread: '校对', translate: '翻译', save: '保存', plan: '规划', blueprint: '答案与情景', author: '出题', review: '审阅', repair: '修复' };

function elapsedOf(contract, running, now) {
  if (!contract.startedAt) return dash;
  const end = running ? now : Date.parse(contract.finishedAt || contract.startedAt);
  return formatElapsed(Math.max(0, end - Date.parse(contract.startedAt)));
}

/** "151 · 0 失败": model calls made and how many failed. */
function callsFact(contract) {
  const calls = contract.calls.filter((call) => call.kind !== 'wait');
  if (!calls.length) return dash;
  return uiFormat('{0} · {1} 失败', [calls.length, calls.filter((call) => call.status === 'failed').length]);
}

const noticesOf = (contract) => (Array.isArray(contract.detail?.notices) ? contract.detail.notices.length : Array.isArray(contract.detail?.warnings) ? contract.detail.warnings.length : 0);

/** The facts row: what is counted for this kind, the clock, the model calls (with their tokens when metered) and the notices. */
export function taskFacts(job, now = Date.now()) {
  const contract = contractOf(job), { progress, usage } = contract, notices = noticesOf(contract);
  const count = progress.total > 0 ? `${progress.done} / ${progress.total}` : dash;
  return [
    { key: 'primary', label: ui(UNIT_LABEL[progress.unit] || '进度'), value: count },
    { key: 'elapsed', label: ui('已用'), value: elapsedOf(contract, isRunningTask(job), now) },
    { key: 'calls', label: ui('模型任务'), value: usage.tokens > 0 ? `${callsFact(contract)} · ${formatCompactTokens(usage.tokens)}` : callsFact(contract) },
    { key: 'warnings', label: ui('提醒'), value: notices ? uiFormat('{0} 条', [formatNumber(notices)]) : dash },
  ];
}

/** The stage segments of the progress bar: [{ stage, label, done, total }], in the order the work happens. */
export function taskSegments(job) {
  const { progress } = contractOf(job);
  if (progress.segments?.length) return progress.segments.map((segment) => ({ ...segment, label: ui(SEGMENT_LABEL[segment.stage] || '进度') }));
  return [{ stage: 'author', label: ui('进度'), done: progress.done, total: progress.total ?? Math.max(progress.done, 1) }];
}
