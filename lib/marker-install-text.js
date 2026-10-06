/* The words of the Marker install as a task of the 任务 console (Chinese source text; lib/application-messages-en.js has the English).
   The install's job code (lib/contexts/audio/install) carries no prose of its own. The refusals are INSTALL_MESSAGES in lib/marker-install.js. */

export const INSTALL_JOB_TEXT = Object.freeze({
  title: '安装 Marker',
  needsSession: '后台安装需要一个正在使用的学习会话：请先在 DSH 里打开一个会话，再从设置页重新点「一键安装 Marker」。',
  stage: Object.freeze({
    'create-venv': '正在创建 Python 环境',
    install: '正在下载并安装 marker-pdf（可能要几分钟到二十分钟）',
    verify: '正在检测装好的 Marker',
    configure: '正在写入设置',
    done: 'Marker 已装好',
    cancelled: '已取消安装；StudyHub 创建的半成品环境保留，可以在设置里卸载',
    failed: '安装没有完成',
  }),
});
