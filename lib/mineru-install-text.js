/* The words of the one-click MinerU install (Chinese source text; lib/application-messages-en.js has the English). One source: the UI imports the
   stage names from here, the engine and the job read the messages from here. */

export const MINERU_STAGE_NAMES = Object.freeze({
  tools: '准备安装工具',
  python: '准备 Python',
  package: '安装 MinerU',
  models: '下载模型',
  enable: '启用本机服务',
  check: '检查能不能用',
});

export const MINERU_INSTALL_MESSAGES = Object.freeze({
  needConfirm: '安装本机 MinerU 会下载约 1–3 GB 并占用磁盘空间，需要先确认：请传 confirm: true。',
  needConfirmUninstall: '卸载前需要先确认：请传 confirm: true。只会删除 StudyHub 创建的内容。',
  busy: 'MinerU 正在安装，请等它完成或先取消。',
  uninstallBusy: 'MinerU 正在安装，请先取消再卸载。',
  notOurs: '这个文件夹不是 StudyHub 创建的 MinerU 安装，不会删除其中任何内容。',
  interrupted: '上次安装被中断（StudyHub 关闭或重启）。',
  cancelled: '已暂停；已下载的部分保留，下次点「继续安装」接着装。',
  badLocation: '这个安装位置不能用。请选择一个已存在或可以新建的文件夹的完整路径。',
  pathTooLong: '这个路径太长了（超过 80 个字符），Windows 上装 MinerU 会出错。请换一个短一些的位置，例如 D:\\StudyHub\\MinerU。',
  folderInUse: '这个位置里已经有别的文件，StudyHub 不会往里面安装。请选一个空文件夹。',
  notWritable: '这个位置没有写入权限，请换一个位置。',
  noSpace: (drive, free, need) => `${drive} 剩余 ${free}，至少需要 ${need}。请换一个空间更大的磁盘。`,
  noSpaceShort: '安装位置所在磁盘的剩余空间不够，安装中断。请换一个空间更大的磁盘。',
  nonAscii: '路径里有中文或特殊字符，个别组件可能加载失败；建议只用英文和数字，例如 D:\\StudyHub\\MinerU。',
  badTier: '模型档位只能是 basic 或 standard。',
  badSource: '下载源只能是 auto、mainland 或 global。',
  badPython: '没有找到这个 Python，或它的版本不在 3.10–3.14 之间。',
  conversionRunning: '有一份 PDF 正在用本机 MinerU 解析，请等它完成或先停止它。',
  network: '下载失败，多半是网络不通或下载源暂时不可用。',
  checksum: '下载的文件校验没有通过（可能下载不完整）。',
  pythonFailed: '没能准备好 Python。',
  packageFailed: 'MinerU 没有安装成功。',
  wrongVersion: (version) => `装好的 MinerU 版本是 ${version || '未知'}，StudyHub 需要 4.x。`,
  modelsFailed: '模型没有下载完整。',
  serviceFailed: '本机服务没能启动。',
  checkFailed: '装好了，但检测没有通过：本机服务没有报告可以解析。',
  vcRuntime: '这台电脑缺少微软 VC++ 运行库，MinerU 的组件加载不了。',
  portInUse: '另一份 MinerU 的服务占用了同一个端口。',
  notInstalled: '还没有安装本机 MinerU：请在「设置 › PDF 转换」点「一键安装」。',
  installing: 'MinerU 正在安装，装好后再开始解析。',
  cloudRemoved: '云端解析已停用：请用本机解析（设置 › PDF 转换 › 一键安装）。',
  needsSession: '后台安装本机 MinerU 需要一个正在使用的学习会话：请先在 DSH 里打开一个会话，再从设置页重新点「一键安装」。',
});

/** The task console's words for an install (the legacy row and the Job). */
export const MINERU_INSTALL_JOB_TEXT = Object.freeze({
  title: '安装本机 MinerU',
  stage: (step, name) => `第 ${step}/6 步：${name}`,
  done: '本机 MinerU 可以用了',
  cancelled: '已暂停；已下载的部分保留',
  failed: '安装没有完成',
});
