import { ui, uiFormat } from '../i18n.js';
import { contractOf } from './task-model.js';

/* 要求并行 (lib/job-parallel.js; docs/job-contract.md): the words the 任务 console says about the queue of question jobs, read from the contract.
   Every explainer is one plain sentence and at most one consequence line; the same words are the tooltip and (for a refusal or a job sent back) the line that stays visible. */

const CAUSE = { 'rate-limit': '模型请求太频繁，被限流了', overloaded: '模型服务繁忙', timeout: '模型长时间没有响应' };
export const causeWord = (cause) => ui(CAUSE[cause] || '模型出了错');

/** What the contract says about 要求并行 for a task: { action, parallel, requeued, queue }, each null when the task has none (a kind that cannot, a job of the runtime). */
export function parallelOf(task) {
  const contract = contractOf(task), action = contract.actions?.parallel ?? null, detail = contract.detail || {};
  return { action, parallel: detail.parallel ?? null, requeued: detail.requeued ?? null, queue: detail.queue ?? null };
}

/** Whether the header offers the button, and in which form: 'ask' (a button), 'blocked' (a button that says why it cannot), or '' (nothing). */
export function parallelButton(task) {
  const { action } = parallelOf(task);
  if (!action) return '';
  if (action.available) return 'ask';
  return action.reason?.code === 'target-busy' ? 'blocked' : '';
}

const titleOf = (reason) => reason?.by?.title || ui('另一个任务');

/** The button's tooltip: what it does, and what happens when the model fails. */
export const askTip = (requeued) => ({
  lead: ui('现在就开始，不再等前面的任务；多个任务同时调用模型，更快，但更容易触发限流。'),
  more: requeued ? ui('它刚因为模型报错退回了排队；再试一次可能还会被退回，进度不会丢。') : ui('出错时会先退回排队、不丢进度；写同一份草稿或题组的任务不能并行。'),
});

/** The sentence of a refusal because another job writes the same thing: visible beside the button and the tooltip of the button that cannot be pressed. */
export const blockedLine = (reason) => uiFormat('不能并行：「{0}」正在处理同一份草稿、题组或资料，两个任务同时写会互相覆盖。', [titleOf(reason)]);
export const blockedTip = (reason) => ({ lead: blockedLine(reason), more: ui('等它结束，或先停止它，再要求并行。') });

/** The badge of a job that runs beside the queue because the learner asked. */
export const badgeText = () => ui('并行中（手动）');
export const badgeTip = () => ({ lead: ui('这个任务按你的要求，和排在前面的任务同时进行。'), more: ui('模型报错时它会先退回排队，不会丢进度。') });

/** The default queue rule, naming the job ahead when the data has it. */
export function queueTip(queue) {
  const head = queue?.head?.title;
  return { lead: head ? uiFormat('同一个资料库里的任务默认一个接一个，免得同时占满模型额度；排在前面的是「{0}」。', [head]) : ui('同一个资料库里的任务默认一个接一个，免得同时占满模型额度；前面还有任务在进行。'),
    more: ui('想让它现在就开始，可以点「要求并行」。') };
}
export const queueLine = (queue) => (queue?.head?.title ? uiFormat('排队中 · 等「{0}」完成后自动开始', [queue.head.title]) : ui('排队中 · 等前面的任务完成后自动开始'));

/** A job sent back to the queue by a model error: the line that stays visible, and what the tooltip adds. */
export const requeuedLine = (requeued) => uiFormat('模型报错，已退回排队：等前面的任务完成后自动继续（原因：{0}）', [causeWord(requeued?.cause)]);
export const requeuedTip = (requeued) => ({
  lead: uiFormat('刚才模型报错（{0}），这个任务先停下新的调用，已完成的部分都在，没有丢。', [causeWord(requeued?.cause)]),
  more: ui('前面的任务做完后它会自动继续；也可以再点「要求并行」试一次。'),
});
