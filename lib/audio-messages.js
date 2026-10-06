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
  subtitleStage: '校对字幕',
  subtitleRunning: '这份字幕已经在处理，请等它完成',
  reviewRunning: '这份逐字稿正在复核，请等它完成',
  reviewStage: '复核存疑处',
  liveSaveStage: '校对课堂实录',
  liveSaveRunning: '这场课堂正在保存，请等它完成',
  liveGone: '这场实录已被删除，没有保存',
  interrupted: '上次导入已中断；已完成的部分已保存，点「接着做」继续',
  started: '转写、校对和翻译在后台进行，长录音需要几分钟到十几分钟。告诉学习者已开始，进度在学习面板的资料页；只有明确要等待时才用 job.wait，不要轮询或重复提交。完成后是一份资料，不会自动出题。',
});

/** Shared provider quota is verified for a single import only; every other audio job refuses to start while it is on. */
export const quotaSingleOnly = () => Object.assign(new Error('Shared provider quota currently supports single audio imports only'), { code: 'capability-unverified' });

/** The session announcement of a finished subtitle import (the audio wording of a transcription does not fit a subtitle file). */
export function subtitleNotice({ status, filename, sourceIds = [], id, stage }, language) {
  const english = language === 'en', done = status === 'complete', cancelled = status === 'cancelled';
  const result = done ? (english ? 'proofread and saved as a bilingual transcript' : '已校对并译成中英对照逐字稿')
    : cancelled ? (english ? 'import cancelled' : '导入已取消') : (english ? 'import incomplete' : '导入未完成');
  const saved = done && sourceIds.length;
  return { wakeup: false,
    summary: english ? `Subtitles "${filename}" ${result}` : `字幕「${filename}」${result}`,
    text: english ? `Study notification: subtitle import ${id} for ${filename} has status ${status}. ${stage}.${saved ? ` The transcript is saved in Sources (${sourceIds.join(', ')}); no questions were generated.` : ' Completed work is retained.'}`
      : `学习插件通知：字幕 ${filename} 的导入任务 ${id} 状态 ${status}。${stage}。${saved ? `逐字稿已存为资料 ${sourceIds.join('、')}，本次没有自动出题。` : ''}` };
}

/** The name a review of a transcript goes by on its card. */
const REVIEW_PREFIX = '复核 · ';
export const reviewName = title => `${REVIEW_PREFIX}${title}`;

/** The session announcement of a finished second look at a transcript's unsure fixes. */
export function reviewNotice({ status, filename, id, stage }, language) {
  const english = language === 'en', title = String(filename).replace(REVIEW_PREFIX, '');
  const result = status === 'complete' ? (english ? 'finished' : '已完成') : status === 'cancelled' ? (english ? 'cancelled' : '已取消') : (english ? 'incomplete' : '未完成');
  return { wakeup: false,
    summary: english ? `Review of the unsure fixes in "${title}" ${result}` : `「${title}」存疑处复核${result}`,
    text: english ? `Study notification: review task ${id} for "${title}" has status ${status}. ${stage}. Confirmed fixes are already in the transcript.`
      : `学习插件通知：逐字稿「${title}」的存疑处复核任务 ${id} 状态 ${status}。${stage}。已确认的改动已经写进逐字稿。` };
}

/** The session announcement of a finished proofread save of a live class. */
export function liveSaveNotice({ status, filename, sourceIds = [], id, stage }, language) {
  const english = language === 'en', done = status === 'complete';
  const result = done ? (english ? 'proofread and saved as a bilingual transcript' : '已校对并保存为中英对照逐字稿')
    : status === 'cancelled' ? (english ? 'save cancelled' : '保存已取消') : (english ? 'save incomplete' : '保存未完成');
  const saved = done && sourceIds.length;
  return { wakeup: false,
    summary: english ? `Class "${filename}" ${result}` : `课堂「${filename}」${result}`,
    text: english ? `Study notification: saving class ${id} ("${filename}") has status ${status}. ${stage}.${saved ? ` The transcript is saved in Sources (${sourceIds.join(', ')}); no questions were generated.` : ' Completed work is retained.'}`
      : `学习插件通知：课堂「${filename}」的保存任务 ${id} 状态 ${status}。${stage}。${saved ? `逐字稿已存为资料 ${sourceIds.join('、')}，本次没有自动出题。` : ''}` };
}

/** The longest a failure message may be where it becomes the stage of a card or a file. */
export const STAGE_CHARS = 400;
export const stageText = error => String(error?.message || error).slice(0, STAGE_CHARS);

/** A request field that is too long or not text; `terms` of the wrong kind; too many files for one check. */
export const fieldTooLong = (field, limit) => `${field} 必须是不超过 ${limit} 字的字符串`;
export const termsInvalid = 'terms 必须是字符串或字符串数组';
export const filesLimit = count => `files 必须是至多 ${count} 个音频文件的列表`;

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
