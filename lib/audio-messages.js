// The audio family's user-facing wording, in one place for the legacy executor and
// the runtime definitions. Chinese is the source text; lib/application-messages-en.js
// localizes it. Change wording here, never at a call site.

export const AUDIO_TEXT = Object.freeze({
  alreadyRunning: '这个音频已经在处理，请等它完成',
  reused: '这段内容已按同样设置处理过，直接复用',
  cancelled: '已取消；已完成的部分会保留，再来一次会接着做',
  queued: '排队中',
  reading: '读取音频',
  inputChanged: '原录音内容已变化；请作为新录音重新导入，避免接错已保存的进度',
  inputUnavailable: '原录音已无法读取；请重新导入该录音',
  notRetryable: '这个任务不能重试：它已经完成，或已被清除',
  stillRunning: '任务还在进行，请等它结束',
  skipInvalid: '跳过的文件编号无效',
  allSkipped: '没有可以导入的文件：这一批的文件都被跳过了',
  started: '转写、校对和翻译在后台进行，长录音需要几分钟到十几分钟。告诉学习者已开始，进度在学习面板的资料页；只有明确要等待时才用 job.wait，不要轮询或重复提交。完成后是一份资料，不会自动出题。',
});

/** A batch member that cannot be imported holds the others until the learner fixes or skips it. */
export const memberBlocked = filename => `「${filename}」未通过预检，其余文件尚未开始；可以跳过它继续`;
/** A batch member whose bytes are no longer the ones that were submitted. */
export const memberChanged = filename => `音频文件已改变：${filename}。请作为新批次重新提交`;
/** The warning for a file whose content is already in the batch. */
export const duplicateMember = filename => `重复内容：${filename}；保留顺序并复用已完成的处理，不重复请求模型`;

/** "已存为 N 份资料[，校对修正 M 处]" */
export const savedAs = (count, corrected) => `已存为 ${count} 份资料${corrected === undefined ? '' : `，校对修正 ${corrected} 处`}`;

// Runtime refusal codes that a learner can act on, worded like the legacy path.
const RUNTIME_REFUSALS = Object.freeze({
  'input-changed': AUDIO_TEXT.inputChanged,
  'input-unavailable': AUDIO_TEXT.inputUnavailable,
  'not-retryable': AUDIO_TEXT.notRetryable,
  'attempt-active': AUDIO_TEXT.stillRunning,
});

/** A learner-readable error for a runtime refusal; other errors pass through unchanged. A batch names the file that changed. */
export function audioRefusal(error) {
  const text = error?.code === 'input-changed' && error.member ? memberChanged(error.member) : RUNTIME_REFUSALS[error?.code];
  return text ? Object.assign(new Error(text), { code: error.code, cause: error }) : error;
}
