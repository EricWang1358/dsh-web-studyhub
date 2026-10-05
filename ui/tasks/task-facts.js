import { ui, uiFormat } from '../i18n.js';
import { formatElapsed, formatNumber } from '../format.js';
import { formatCompactTokens, totalTokens } from '../../lib/token-usage.js';
import { isActiveJob } from '../../lib/job-status.js';
import { taskKindOf } from './task-model.js';
import { callsOf } from './task-calls.js';

/* The four facts beside a task's progress and the stage segments of its bar. Both read the job as the snapshot holds it. */

const dash = '—';
const warningsOf = (job) => (Array.isArray(job.warnings) ? job.warnings.length : 0);

function elapsedOf(job, now) {
  if (!job.startedAt) return dash;
  const end = isActiveJob(job) ? now : Date.parse(job.finishedAt || job.startedAt);
  return formatElapsed(Math.max(0, end - Date.parse(job.startedAt)));
}

/** "151 · 0 失败": model calls made and how many failed. */
function callsFact(job) {
  const calls = callsOf(job).filter((call) => call.kind !== 'wait');
  if (!calls.length) return dash;
  const failed = calls.filter((call) => call.status === 'failed').length;
  return uiFormat('{0} · {1} 失败', [calls.length, failed]);
}

const members = (job) => (Array.isArray(job.members) ? job.members.filter((member) => member.status !== 'skipped') : []);

function primaryFact(job) {
  switch (taskKindOf(job)) {
    case 'audio': {
      const list = members(job);
      if (!list.length) return { key: 'primary', label: ui('文件'), value: '1' };
      return { key: 'primary', label: ui('文件'), value: `${list.filter((member) => member.status === 'complete').length} / ${list.length}` };
    }
    case 'pdf': return { key: 'primary', label: ui('页'), value: job.total > 0 ? `${job.done} / ${job.total}` : dash };
    case 'translation': return { key: 'primary', label: ui('段落'), value: job.total > 0 ? `${job.done} / ${job.total}` : dash };
    case 'generation': case 'supplement': return { key: 'primary', label: ui('题数'), value: job.requestedTotal > 0 ? `${job.savedCount ?? 0} / ${job.requestedTotal}` : dash };
    case 'repair': return { key: 'primary', label: ui('修好'), value: job.count > 0 ? `${job.savedCount ?? 0} / ${job.count}` : dash };
    default: return { key: 'primary', label: ui('进度'), value: job.total > 0 ? `${job.done ?? 0} / ${job.total}` : dash };
  }
}

/** The facts row: what is counted for this kind, the clock, the model calls (with their tokens when the job meters them) and the warnings. */
export function taskFacts(job, now = Date.now()) {
  const tokens = job.tokenUsage ? totalTokens(job.tokenUsage) : 0;
  const warnings = warningsOf(job);
  return [
    primaryFact(job),
    { key: 'elapsed', label: ui('已用'), value: elapsedOf(job, now) },
    { key: 'calls', label: ui('模型任务'), value: tokens > 0 ? `${callsFact(job)} · ${formatCompactTokens(tokens)}` : callsFact(job) },
    { key: 'warnings', label: ui('提醒'), value: warnings ? uiFormat('{0} 条', [formatNumber(warnings)]) : dash },
  ];
}

const AUDIO_STAGES = [['transcribe', '转写'], ['proofread', '校对'], ['translate', '翻译']];
const GENERATION_STAGES = [['plan', '规划'], ['author', '出题'], ['review', '审阅'], ['repair', '修复']];

/** The stage segments of the progress bar: [{ stage, label, done, total }], one per stage the job has, in the order the work happens. */
export function taskSegments(job) {
  switch (taskKindOf(job)) {
    case 'audio': {
      const list = members(job).length ? members(job) : [job];
      const segments = AUDIO_STAGES.map(([stage, label]) => ({ stage, label: ui(label),
        done: list.reduce((sum, member) => sum + (member.steps?.[stage]?.done || 0), 0),
        total: list.reduce((sum, member) => sum + (member.steps?.[stage]?.total || 0), 0) }));
      const saved = list.filter((member) => member.status === 'complete' || member.phase === 'done').length;
      segments.push({ stage: 'save', label: ui('保存'), done: job.status === 'complete' ? 1 : members(job).length ? 0 : saved ? 1 : 0, total: 1 });
      return segments.filter((segment) => segment.total > 0);
    }
    case 'generation': case 'supplement': {
      const counted = new Map(GENERATION_STAGES.map(([stage]) => [stage, { done: 0, total: 0 }]));
      for (const call of callsOf(job)) {
        const bucket = counted.get(call.stage);
        if (!bucket) continue;
        bucket.total += 1;
        if (call.status === 'ok') bucket.done += 1;
      }
      const segments = GENERATION_STAGES.map(([stage, label]) => ({ stage, label: ui(label), ...counted.get(stage) })).filter((segment) => segment.total > 0);
      return segments.length ? segments : [{ stage: 'author', label: ui('出题'), done: job.savedCount ?? 0, total: Math.max(job.requestedTotal || 0, 1) }];
    }
    default: {
      const total = job.total > 0 ? job.total : 1, done = job.total > 0 ? job.done || 0 : job.status === 'complete' ? 1 : 0;
      return [{ stage: 'author', label: ui('进度'), done, total }];
    }
  }
}
