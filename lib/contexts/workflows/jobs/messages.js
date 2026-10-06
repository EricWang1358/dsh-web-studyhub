/* The wording of the Jobs of 学习流 (Chinese source text; English in lib/application-messages-en.js). */
export const WORKFLOW_MESSAGES = Object.freeze({
  teachingTitle: '生成讲解',
  skeletonTitle: '整理知识骨架',
  queued: '等待开始',
  teaching: '正在写讲解并检查',
  skeleton: '正在整理知识骨架',
  cancelled: '已取消，已保存的内容不受影响',
  ended: '本次讲解已结束',
  timeout: '讲解生成超时，请稍后重试',
  skeletonTimeout: '骨架生成超时，可以稍后重试',
  teachingFailed: '讲解生成失败，请重试',
  skeletonFailed: '骨架生成失败，可以重试',
  unavailable: '后台执行器暂时不可用，请稍后再试',
});
