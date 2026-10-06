/* The words of the local MinerU setup (Chinese source text; lib/application-messages*.js has the English). The setup's job code
   (lib/contexts/audio/setup) carries no prose of its own; the refusals of the local route are LOCAL_MESSAGES in lib/mineru-local.js. */

const FAILED_STEP = Object.freeze({ download: '模型没能下载', start: '本地服务没能启动', configure: '本地设置没能完成' });

export const SETUP_TEXT = Object.freeze({
  title: tier => `准备本地 MinerU（${tier}）`,
  needConfirm: modelsMb => `下载本地模型前需要先确认：约 ${modelsMb} MB，会占用网络和磁盘。`,
  needsSession: '后台准备本地 MinerU 需要一个正在使用的学习会话：请先在 DSH 里打开一个会话，再从设置页重新点「准备本地模型」。',
  noReason: '没有返回原因',
  /** The sentence of a step that exited non-zero. */
  stepFailed: (step, reason) => `${FAILED_STEP[step] ?? FAILED_STEP.configure}：${reason}`,
  stage: (step, { modelsMb = 0 } = {}) => ({
    start: '正在启动本地服务',
    download: `正在下载模型（约 ${modelsMb} MB，只下载一次）`,
    configure: '正在写入本地设置',
    done: '本地 MinerU 已就绪',
    cancelled: '已取消；已下载的模型保留，之前的设置没有改动',
    failed: '准备本地 MinerU 没有完成',
  })[step],
});
