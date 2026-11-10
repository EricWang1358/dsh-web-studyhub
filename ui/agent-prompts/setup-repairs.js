/* What the main chat may repair itself when a local tool failed (#939), as one table: SETUP_REPAIRS says what each repair is, TOOL_REPAIRS says which
   repairs fit which failure code of which tool. The codes are the ones the cards classify (ui/mineru-install-flow.js FIX_FOR, ui/live-local-flow.js,
   ui/live-loopback-flow.js, lib/marker-install.js, lib/retrieval-index.js); a code that is not here (a failure added later) gets the general entry
   in ui/agent-prompts/setup.js, so a new code needs a line here only when it has a repair of its own. Every sentence is a catalogue key
   (ui/locales/en.agent.json); the sentences hold ideas, never a pasted command (the same command is wrong on another system). Values the sentences
   take, by position: {0} the address of the VC++ runtime, {1} the tool's own install button. A repair that ends a process or deletes files says that it asks first. */

export const SETUP_REPAIRS = Object.freeze({
  perms: '配置文件夹的权限：连文件夹带里面已有的文件（日志、配置、模型）一起查，没有任何账户能读的、或不只有当前用户能写的，改成只有当前用户能读写（例如恢复成从所在文件夹继承权限），不要放宽文件夹本身的权限',
  location: '位置不能写、路径太长或没有足够空间：在剩余空间够、路径尽量短、我有写入权限的磁盘上新建一个空文件夹，告诉我在「换位置」里选它',
  port: '端口被占用：找出占用端口的进程，告诉我它是什么，问过我、我说好再结束它',
  'in-use': '文件夹被别的程序占用：找出占用它的进程，告诉我它是什么，问过我、我说好再结束它',
  vc: '缺 VC++ 运行库：把微软官方下载地址 {0} 给我，由我自己下载安装（你不要运行安装包），装好后我点「重试」',
  net: '网络或下载源：先测一下现在的下载源连不连得通（只读的测试），再建议我换成另一个下载源（在这个工具的安装界面里，通常在「更多」里），不要改系统的代理和网络设置',
  broken: '安装损坏：只可以删除安装位置里 StudyHub 创建的内容（程序、Python、虚拟环境、模型），位置里别的文件一概不动，删之前先把要删的列给我，问过我再删，然后让我点「{1}」',
  service: '本地服务起不来：先看它的日志找原因，必要时自己启动一次看报错，启动了什么，试完就停掉，让端口空出来',
  models: '模型文件不完整：只查哪些缺了或坏了，不要手动补，让我点「修复」重新下载缺的部分',
  python: 'Python 版本不对或没有：看这台电脑上有没有这个工具支持的版本，没有就告诉我去哪里下载，由我自己安装',
  build: '缺编译工具：告诉我缺什么和官方下载地址，由我自己安装（你不要运行安装包）',
  av: '杀毒软件拦截或隔离了文件：先看杀毒软件的隔离记录，告诉我哪些文件被隔离，恢复文件或加例外要先问我，不要关掉杀毒软件',
  'ext-model': '检索模型下载失败：先测一下网络和默认的下载地址连不连得通（只读的测试），这个网络连不上的话，建议我在「设置 › 检索扩展」的高级选项里换一个模型下载地址，由我自己填',
  'ext-service': '检索服务没有启动：只读地查它为什么没起来（日志、端口、DSH 的运行状态），不要改 DSH 的设置，需要重启 DSH 的话告诉我，由我自己重启',
});

/* location: the install location cannot be used; the same repairs whichever tool installs there. */
const LOCATION = ['location'];
const NETWORK = ['net'];
const REINSTALL = ['net', 'broken'];

export const TOOL_REPAIRS = Object.freeze({
  mineru: {
    network: NETWORK, checksum: NETWORK,
    'no-space': LOCATION, 'bad-location': LOCATION, 'path-too-long': LOCATION,
    'not-writable': ['perms', 'location'], 'folder-in-use': ['in-use', 'location'],
    'tools-failed': REINSTALL, 'python-failed': REINSTALL, 'package-failed': REINSTALL, 'models-failed': REINSTALL, 'check-failed': REINSTALL,
    'needs-models': ['models', 'net'], 'models-missing': ['models', 'net'],
    'service-failed': ['service', 'perms', 'broken'], 'service-timeout': ['service'], 'port-in-use': ['port'], 'vc-runtime': ['vc'], unreadable: ['service'],
  },
  marker: {
    network: NETWORK, 'no-space': LOCATION, 'path-too-long': LOCATION, 'not-writable': LOCATION,
    'python-too-old': ['python'], 'python-too-new': ['python'], 'pip-build': ['build', 'python'], 'pip-failed': REINSTALL,
    'venv-failed': ['python', 'broken'], 'configure-failed': ['broken'],
  },
  'live-local': {
    'vc-runtime': ['vc'], network: NETWORK, checksum: NETWORK,
    'no-space': LOCATION, 'bad-location': LOCATION, 'path-too-long': LOCATION,
    'not-writable': LOCATION, 'folder-in-use': ['in-use', 'location'], 'needs-repair': ['av', 'broken'],
  },
  'live-loopback': {
    'no-space': LOCATION, 'bad-location': LOCATION, 'path-too-long': LOCATION,
    'not-writable': LOCATION, 'folder-in-use': ['in-use', 'location'], 'needs-repair': ['av', 'broken'],
  },
  'retrieval-extension': {
    'retrieval-model-download': ['ext-model'], 'companion-not-started': ['ext-service'],
    'extension-install-failed': NETWORK, 'extension-update-failed': NETWORK,
  },
});

/** The repair ids for a failure code of a tool: [] when the code is not in the table (an inherited name such as 'toString' is not a code). */
export function repairIdsFor(tool, code) {
  const codes = Object.hasOwn(TOOL_REPAIRS, tool) ? TOOL_REPAIRS[tool] : TOOL_REPAIRS.mineru;
  return Object.hasOwn(codes, code) ? codes[code] : [];
}
