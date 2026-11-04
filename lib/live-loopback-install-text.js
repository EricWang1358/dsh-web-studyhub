/* The words of the on-demand system-audio loopback helper and its hot-install (Chinese source text; lib/application-messages-en.js has the English).
   One source: the UI imports the stage names from here, and the installer, capture controller and 课堂实录 read the messages from here. */

export const LIVE_LOOPBACK_STAGE_NAMES = Object.freeze({
  compile: '生成采音组件',
  check: '自检声卡接口',
});

export const LIVE_LOOPBACK_MESSAGES = Object.freeze({
  needConfirm: '安装电脑声音组件会在本机生成约 20 KB 的只读采音程序，需要先确认：请传 confirm: true。',
  needConfirmUninstall: '卸载前需要先确认：请传 confirm: true。只会删除 StudyHub 创建的内容。',
  busy: '电脑声音组件正在安装，请等它完成或先取消。',
  uninstallBusy: '电脑声音组件正在安装，请先取消再卸载。',
  liveRunning: '有一场课堂实录正在采集电脑系统声音，请先结束它再卸载组件。',
  notOurs: '这个文件夹不是 StudyHub 创建的电脑声音组件，不会删除其中任何内容。',
  interrupted: '上次安装被中断（StudyHub 关闭或重启）。',
  cancelled: '已取消安装。',
  badLocation: '这个安装位置不能用。请选择一个已存在或可以新建的文件夹的完整路径。',
  folderInUse: '这个位置里已经有别的文件，StudyHub 不会往里面安装。请选一个空文件夹。',
  notWritable: '这个位置没有写入权限，请换一个位置。',
  noSpace: (drive, free, need) => `${drive} 剩余 ${free}，至少需要 ${need}。请换一个空间更大的磁盘。`,
  noSpaceShort: '安装位置所在磁盘的剩余空间不够，安装中断。请换一个空间更大的磁盘。',
  unsupported: '电脑声音本机直采组件目前仅支持 Windows 10/11。macOS 与 Linux 请使用独立浏览器窗口的「标签页共享」或改用「麦克风」。',
  noCompiler: '没有找到 Windows 自带的 .NET Framework 编译器（csc.exe），无法生成采音组件。',
  compileFailed: '采音组件没有在本地生成成功。',
  checkFailed: '采音组件已生成，但声卡接口自检没有通过。',
  needsInstall: '电脑声音直采组件还没有安装：请先在课堂实录或「设置 › 音频转写」里点「安装电脑声音组件」。',
  installing: '电脑声音直采组件正在安装，装好后再开始实录。',
  noDevice: '当前电脑没有可用的音频播放设备（耳机或扬声器）。请连接或启用播放设备后再开始实录。',
  startFailed: '电脑声音采音组件没能启动。请检查系统播放设备后重试，或在「设置 › 音频转写」里修复组件。',
});

/** The task console's words for the install (its legacy row). */
export const LIVE_LOOPBACK_JOB_TEXT = Object.freeze({
  title: '安装电脑声音直采组件',
  stage: (step, name) => `第 ${step}/2 步：${name}`,
  done: '电脑声音直采组件可以用了',
  cancelled: '已取消安装',
  failed: '安装没有完成',
});
