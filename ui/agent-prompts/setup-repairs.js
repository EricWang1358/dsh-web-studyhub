/* What the main chat may repair itself when a local tool failed (#939), as one table: SETUP_REPAIRS says what each repair is, TOOL_REPAIRS says which
   repairs fit which failure code of which tool. The codes are the ones the tools raise (lib/mineru-install.js, lib/marker-install.js, lib/live-local-install.js,
   lib/live-loopback-install.js, lib/retrieval-index.js) and the cards classify; tests/setup-repair-prompt.test.mjs reads those sources and fails when a code is
   neither here nor on its explicit allow-list. A code that is not here (a failure added later) gets the general entry in ui/agent-prompts/setup.js.
   Every sentence is a catalogue key (ui/locales/en.agent.json) and holds an idea, never a pasted command (the same command is wrong on another system).
   What every repair shares (say what a step changes first; ask before ending a process, deleting files or changing permissions; verify read-only; never start
   or stop the tool's service) is said once, in the HOW line of setup.js, not here. Values a sentence takes, by position: {0} the address of the VC++ runtime,
   {1} the tool's install button, {2} its repair button, {3} its uninstall button, {4} its move button, {5} where its download source is chosen, {6} the card's
   own fix for this failure (for MinerU's home-permissions: 修复权限 / 修复权限并重启, which resets the files of its settings folder itself, #942; for a MinerU
   StudyHub did not install: 重新启动服务, ui/mineru-install-flow.js fixFor). */

export const SETUP_REPAIRS = Object.freeze({
  perms: '配置文件夹的权限：只查「情况」里 folder 这个安装位置之内、这个工具自己的文件夹和里面的文件（MinerU 是它的配置文件夹），没有任何账户能读、或权限被改乱的文件，恢复成继承所在文件夹的权限；不要动安装位置以外的任何东西（包括用户主目录里的其他文件），不要放宽任何文件夹的权限；报错里被拒绝的路径如果在安装位置之外，不要改，告诉我它是什么就停下',
  'home-perms': '配置文件夹里的文件权限不对：先让我点卡片上的「{6}」（它会把配置文件夹里的文件恢复成继承所在文件夹的权限）；只有这个按钮已经点过、卡片说还是没修好，才由你动手：只限安装位置之内这个配置文件夹和里面的文件，恢复成继承所在文件夹的权限，不要动安装位置以外的任何东西（包括用户主目录里的其他文件），不要放宽任何文件夹的权限，被拒绝的路径在安装位置之外就停下，告诉我它是什么',
  // A MinerU StudyHub did not install (#942 N3): the card has no permission repair for it (StudyHub never changes a folder it did not create) and no install location.
  'other-home-perms': '这份 MinerU 不是 StudyHub 装的，它的配置文件夹里的文件权限不对：先让我点卡片上的「{6}」再试一次；还是不行才由你动手：只限报错里被拒绝的那个路径所在的、这份 MinerU 自己的配置文件夹和里面的文件，让我自己能读写、并且只有我、系统和管理员能用；改权限之前先问我；不要动这份 MinerU 的其他任何东西（程序、模型、它的安装文件夹），不要动配置文件夹以外的任何东西，不要放宽任何文件夹的权限；报错里没有写出被拒绝的路径时什么都不要改，告诉我就停下',
  location: '位置本身不能写、路径太长或没有足够空间：在剩余空间够、路径尽量短、我有写入权限的磁盘上新建一个空文件夹，告诉我在「{4}」里选它',
  port: '端口被占用：找出占用端口的进程，告诉我它是什么',
  'in-use': '文件夹被别的程序占用：找出占用它的进程，告诉我它是什么',
  vc: '缺 VC++ 运行库：把微软官方下载地址 {0} 给我，由我自己下载安装（你不要运行安装包）',
  net: '网络或下载源：只读地测一下现在的下载源连不连得通，再建议我换成另一个下载源（{5}）',
  'net-fixed': '网络：只读地测一下下载地址连不连得通，告诉我结果（这个工具没有别的下载源可换）',
  broken: '安装可能损坏：只列出看起来坏了或缺了的东西，什么都不要删；由我点「{2}」，不行就先点「{3}」，再点「{1}」重装',
  'broken-retry': '安装可能损坏：只列出看起来坏了或缺了的东西，什么都不要删；由我点「{2}」，不行就在「{4}」里换一个位置重新安装',
  docker: 'Docker 没有运行：只读地查 Docker Desktop 有没有装好、是不是在运行，告诉我结果，由我自己启动它',
  'marker-missing': 'Marker 程序找不到：只读地查配置的程序路径还在不在、这台电脑上有没有 marker_single，告诉我；由我点「{1}」重装，或自己填路径',
  'marker-unavailable': 'Marker 程序暂时用不了：只读地看它的版本检查报了什么（第一次启动慢是正常的），告诉我结果',
  service: '本地服务起不来：只读地找原因（读它的日志、查端口有没有被占、看文件权限）',
  models: '模型文件不完整：只查哪些缺了或坏了，不要手动补；由我点「{2}」重新下载缺的部分',
  python: 'Python 版本不对或没有：看这台电脑上有没有这个工具支持的版本；没有就告诉我去哪里下载，由我自己安装',
  build: '缺编译工具：告诉我缺什么和官方下载地址，由我自己安装（你不要运行安装包）',
  av: '杀毒软件拦截或隔离了文件：看杀毒软件的隔离记录，告诉我哪些文件被隔离、在杀毒软件的哪里可以恢复或加例外，由我自己去做；你不要改杀毒软件的任何设置',
  unsupported: '这个系统不支持这个工具：没有什么可以修复的，告诉我原因，不要去装别的东西',
  'ext-model': '检索模型下载失败：只读地测一下网络和默认的下载地址连不连得通；这个网络连不上的话，建议我在「设置 › 检索扩展」的高级选项里换一个模型下载地址，由我自己填',
  'ext-service': '检索服务没有启动：只读地查它为什么没起来（日志、端口、DSH 的运行状态）；需要重启 DSH 的话告诉我，由我自己重启',
  'ext-index': '建立索引没成功：只读地查原因（失败那几页的报错、检索服务有没有在运行），告诉我结果',
});

/* The repairs that change files or permissions: only these need the chat to be allowed to write outside the workspace (the others read, test or tell me). */
const WRITES = Object.freeze(['perms', 'home-perms', 'other-home-perms', 'location']);

const LOCATION = ['location'];
const NETWORK = ['net'];
const REINSTALL = ['net', 'broken'];
const STUCK_FOLDER = ['in-use', 'location'];

export const TOOL_REPAIRS = Object.freeze({
  mineru: {
    network: NETWORK, checksum: NETWORK,
    'no-space': LOCATION, 'bad-location': LOCATION, 'path-too-long': LOCATION,
    'not-writable': ['perms', 'location'], 'home-permissions': ['home-perms'], 'folder-in-use': STUCK_FOLDER,
    'tools-failed': REINSTALL, 'python-failed': REINSTALL, 'package-failed': REINSTALL, 'models-failed': REINSTALL, 'check-failed': REINSTALL,
    'needs-models': ['models', 'net'], 'models-missing': ['models', 'net'],
    'service-failed': ['service', 'perms'], 'server-start-failed': ['service', 'perms'], 'service-timeout': ['service'], 'port-in-use': ['port'],
    'vc-runtime': ['vc'], unreadable: ['service'],
  },
  marker: {
    network: NETWORK, 'no-space': LOCATION, 'path-too-long': LOCATION, 'not-writable': LOCATION, 'bad-location': LOCATION, 'folder-in-use': STUCK_FOLDER,
    'python-missing': ['python'], 'python-too-old': ['python'], 'python-too-new': ['python'], 'pip-build': ['build', 'python'], 'pip-failed': ['net', 'broken-retry'],
    'venv-failed': ['python', 'broken-retry'], 'configure-failed': ['broken-retry'], 'verify-failed': ['python', 'broken-retry'], 'verify-missing': ['broken-retry'], 'no-venv': ['broken-retry'],
    // the states of marker_single's own check (lib/marker-local.js), which markerDiagnostic uses as the code when no install failed
    'needs-docker': ['docker'], 'not-installed': ['marker-missing'], unavailable: ['marker-unavailable'], 'not-ready': ['marker-unavailable'],
  },
  'live-local': {
    'vc-runtime': ['vc'], network: ['net-fixed'], checksum: ['net-fixed'], 'model-failed': ['net-fixed'],
    'no-space': LOCATION, 'bad-location': LOCATION, 'path-too-long': LOCATION, 'not-writable': LOCATION, 'folder-in-use': STUCK_FOLDER,
    'engine-failed': ['vc', 'av'], 'check-failed': ['vc', 'av'], 'needs-repair': ['av', 'broken'], unsupported: ['unsupported'],
  },
  'live-loopback': {
    'no-space': LOCATION, 'bad-location': LOCATION, 'path-too-long': LOCATION, 'not-writable': LOCATION, 'folder-in-use': STUCK_FOLDER,
    'no-compiler': ['build'], 'compile-failed': ['build', 'av'], 'check-failed': ['av'], 'needs-repair': ['av', 'broken'], unsupported: ['unsupported'],
  },
  'retrieval-extension': {
    'retrieval-model-download': ['ext-model'], 'companion-not-started': ['ext-service'], 'retrieval-index-unavailable': ['ext-service'],
    'retrieval-index-failed': ['ext-index'], 'index-start-failed': ['ext-index'],
    'extension-install-failed': ['net-fixed'], 'extension-update-failed': ['net-fixed'],
  },
});

/* The codes whose repairs differ when the tool was NOT installed by StudyHub (the diagnostic's `installedBy: 'other'`, the card's `ours` false): a MinerU found
   through MINERU_BIN or the PATH has no install location and gets no 修复权限 (ui/mineru-install-flow.js fixFor), so its permission repairs are scoped to its own
   settings folder instead. Every other code keeps the table above. */
export const OTHER_INSTALL_REPAIRS = Object.freeze({
  // A start that failed for another reason only reads: the scoped repair of the install location ('perms') has no location to apply to here.
  mineru: { 'home-permissions': ['other-home-perms'], 'not-writable': ['other-home-perms'], 'service-failed': ['service'], 'server-start-failed': ['service'] },
});

const codesOf = tool => (Object.hasOwn(TOOL_REPAIRS, tool) ? TOOL_REPAIRS[tool] : TOOL_REPAIRS.mineru);
const toolOf = tool => (Object.hasOwn(TOOL_REPAIRS, tool) ? tool : 'mineru');

/** The repair ids for a failure code of a tool: [] when the code is not in the table (an inherited name such as 'toString' is not a code). `installedBy`
 *  'other': the tool StudyHub did not install (OTHER_INSTALL_REPAIRS first). */
export function repairIdsFor(tool, code, installedBy = '') {
  const other = installedBy === 'other' && Object.hasOwn(OTHER_INSTALL_REPAIRS, toolOf(tool)) ? OTHER_INSTALL_REPAIRS[toolOf(tool)] : null;
  if (other && Object.hasOwn(other, code)) return other[code];
  const codes = codesOf(tool);
  return Object.hasOwn(codes, code) ? codes[code] : [];
}

/**
 * Whether the repairs for this failure may write files or permissions outside the workspace, so the chat needs DSH's full permission (the hint on the bar and the
 * permission line of the prompt). A known code: any of its repairs writes. An unknown code gets the general entry, which may make small reversible repairs, so it
 * counts as writing wherever the tool has a repair that writes at all.
 */
export function needsWrite(tool, code, installedBy = '') {
  const codes = codesOf(tool), ids = repairIdsFor(tool, code, installedBy);
  if (ids.length) return ids.some(id => WRITES.includes(id));
  return Object.values(codes).some(list => list.some(id => WRITES.includes(id)));
}
