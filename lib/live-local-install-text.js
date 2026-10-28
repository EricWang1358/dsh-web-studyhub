/* The words of the local live engine and its one-click install (Chinese source text; lib/application-messages-en.js has the English). One source:
   the UI imports the stage names from here, the engine, the install and 课堂实录 read the messages from here. */

export const LIVE_LOCAL_STAGE_NAMES = Object.freeze({
  engine: '安装识别引擎',
  model: '下载识别模型',
  check: '检查能不能用',
});

export const LIVE_LOCAL_MESSAGES = Object.freeze({
  needConfirm: '安装本地实录引擎会下载约 240 MB 并占用磁盘空间，需要先确认：请传 confirm: true。',
  needConfirmUninstall: '删除前需要先确认：请传 confirm: true。只会删除 StudyHub 创建的内容。',
  busy: '本地实录引擎正在安装，请等它完成或先暂停。',
  uninstallBusy: '本地实录引擎正在安装，请先暂停再删除。',
  liveRunning: '有一场课堂实录正在用本地引擎，请先结束它再删除。',
  notOurs: '这个文件夹不是 StudyHub 创建的本地实录引擎，不会删除其中任何内容。',
  interrupted: '上次安装被中断（StudyHub 关闭或重启）。',
  cancelled: '已暂停；已下载的部分保留，下次点「继续安装」接着装。',
  badLocation: '这个安装位置不能用。请选择一个已存在或可以新建的文件夹的完整路径。',
  folderInUse: '这个位置里已经有别的文件，StudyHub 不会往里面安装。请选一个空文件夹。',
  notWritable: '这个位置没有写入权限，请换一个位置。',
  noSpace: (drive, free, need) => `${drive} 剩余 ${free}，至少需要 ${need}。请换一个空间更大的磁盘。`,
  noSpaceShort: '安装位置所在磁盘的剩余空间不够，安装中断。请换一个空间更大的磁盘。',
  unsupported: '这台电脑的系统或处理器没有现成的本地识别引擎（支持 Windows x64、macOS 和 64 位 Linux）。课堂实录请用 Gemini，或课后在「音频转写」里导入录音。',
  network: '下载失败，多半是网络不通或下载源暂时不可用。',
  checksum: '下载的文件校验没有通过（可能下载不完整或被改动），已删除这个文件。',
  engineFailed: '识别引擎没有安装成功。',
  modelFailed: '识别模型没有下载完整。',
  checkFailed: '装好了，但识别引擎没能加载模型。',
  vcRuntime: '这台电脑缺少微软 VC++ 运行库，识别引擎加载不了。',
  needsInstall: '本地实录引擎还没有装好：请先在课堂实录或「设置 › 音频转写」里点「安装本地引擎」。',
  installing: '本地实录引擎正在安装，装好后再开始实录。',
});

/** The task console's words for the install (its legacy row). */
export const LIVE_LOCAL_JOB_TEXT = Object.freeze({
  title: '安装本地实录引擎',
  stage: (step, name) => `第 ${step}/3 步：${name}`,
  done: '本地实录引擎可以用了',
  cancelled: '已暂停；已下载的部分保留',
  failed: '安装没有完成',
});

/** 课堂实录's refusals when the engine the learner chose cannot run (never replaced by the other engine). */
export const LIVE_PROVIDER_TEXT = Object.freeze({
  'local-not-ready': LIVE_LOCAL_MESSAGES.needsInstall,
  'no-gemini-key': '选择了用 Gemini 转写，但还没有配置 Gemini 密钥：请在「设置 › 音频转写」里填写，或改选「本地（不联网）」。',
  'no-provider': '课堂实录还不能开始：请安装本地引擎（不联网，不需要密钥），或在「设置 › 音频转写」里填写 Gemini 密钥。',
});
