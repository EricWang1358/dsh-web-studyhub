import { getUiLanguage } from '../i18n.js';
import { say } from './say.js';
import { partsOf } from './message.js';
import { situationMessage } from './situation.js';
import { SETUP_REPAIRS, needsWrite, repairIdsFor } from './setup-repairs.js';
import { VC_REDIST_URL, fixFor } from '../mineru-install-flow.js';
import { localFix } from '../live-local-flow.js';
import { loopbackFix } from '../live-loopback-flow.js';

/* The hand-off ('setup.failed') of a local tool or companion service (MinerU, Marker, live-local speech engine, live-loopback
   system-audio helper, or the search extension) that did not install, start or pass its check. Built on situation.js: one table
   maps each tool to its area, goal, place and the names of its own buttons, so every setup card shares the same structure with zero per-page prompt logic.
   The chat may repair this computer's environment for the tool, step by step (#939, option A): what it may do for the failure's code is the
   table of ui/agent-prompts/setup-repairs.js; installing and uninstalling stay the learner's buttons (lib/assistant-boundary.js refuses them), and the chat
   never starts or stops the tool's service (StudyHub starts it with its own environment), so the last line names the card's control to press back:
   its check first, and its fix button only if the card still shows the error (after a repair done in place the fix button is the wrong one: for
   MinerU's not-writable it is 换位置, a reinstall). The fix button comes from the card's own pure rules (fixFor / localFix / loopbackFix). */

const PDF_TAIL = '如果我急着导入 PDF，也可以先帮我把转换结果写到工作区的 studyhub-work/ 下再用 study_materials 的 document.import 导入。';
const AUDIO_TAIL = '如果我急着处理已有录音，也可以先问我是否改用云端转写，再用 study_audio 的 audio.import 导入。';
const EXCEPTION = '（「做法」里导入的备选是唯一的例外）';

/* The names of each card's own controls: install (the primary one of a tool that is not there), repair, uninstall, move (the location), where the download
   source is chosen (none: the tool has no other source). */
const SETUP_TOOLS = Object.freeze({
  mineru: {
    label: 'MinerU', area: 'PDF 转换设置', goal: '排查本机 MinerU 的报错并解决', tail: PDF_TAIL, place: '「设置 › PDF 转换」',
    install: '一键安装', repair: '修复', uninstall: '卸载', move: '换位置', source: '在「更多」里',
  },
  marker: {
    label: 'Marker', area: 'PDF 转换设置', goal: '排查本机 Marker 的报错并解决', tail: PDF_TAIL, place: '「设置 › PDF 转换」',
    install: '一键安装 Marker', repair: '重试', uninstall: '卸载', move: '更改位置', source: '在「下载源」里',
  },
  'live-local': {
    label: 'live-local', area: '音频转写设置', goal: '排查本地语音识别引擎的报错并解决', tail: AUDIO_TAIL, place: '「课堂实录」或「设置 › 音频转写」',
    install: '安装本地转写引擎', repair: '修复', uninstall: '删除本地转写引擎', move: '换位置', source: '',
  },
  'live-loopback': {
    label: 'live-loopback', area: '音频转写设置', goal: '排查电脑声音直采组件的报错并解决', tail: '', place: '「课堂实录」或「设置 › 音频转写」',
    install: '安装电脑声音组件', repair: '修复', uninstall: '卸载电脑声音组件', move: '换位置', source: '',
  },
  'retrieval-extension': {
    label: 'retrieval-extension', area: '检索扩展设置', goal: '排查检索扩展或检索索引的报错并解决', tail: '', place: '「设置 › 检索扩展」',
    install: '', repair: '修复', uninstall: '卸载检索扩展', move: '', source: '',
  },
});

const HOW = '做法：先根据下面的「情况」和「错误原文」查清真正的原因，用大白话告诉我；卡片上的说法只是从报错原文猜的，不要照单全收，要自己检查。查清后可以直接动手修这台电脑上与它有关的环境，一步一步来：每一步先说明做什么、会改哪里，再去做；要结束进程、删除文件或改权限的步骤先问我，我说好再动手；验证只用只读的办法（看版本、读日志、查端口、看文件权限），不要启动或停止这个工具的服务。';
const REPAIRS = '修复：按「情况」里 code 的这个原因，你可以做：{0}。';
const REPAIRS_UNKNOWN = '修复：「情况」里的 code 不在已知清单里：先查清原因，只做和它直接有关、能撤回的修复，拿不准的先问我。';
const PERMISSION = '权限：这些修复多半要改 StudyHub 文件夹以外的东西。命令被文件权限拒绝时，不要放弃，也不要把命令丢给我自己敲；告诉我在主会话输入框左下角的权限菜单里选「完全权限」（每个会话单独设置，StudyHub 替我切不了），再重试同一步。';
const BOUNDARY = '边界：修复时不要读取或修改学习库{1}和 DSH 自己的设置，不要动与这次修复无关的文件，不要保存或打印任何密钥，不要改系统设置（PATH、注册表、防火墙、代理、执行策略、杀毒软件），不要提权；要管理员权限、或在「完全权限」下还是被拒绝时，停下来告诉我。不要自己安装、卸载这个工具，也不要启动或停止它的服务（StudyHub 的安装、卸载操作对你是关着的）；这些只能由我在{0}里点按钮完成。';
const NEVER = '不要：没问过我就装软件；删除或覆盖我的原文件；改 StudyHub 设置（需要时让我去设置页）。';
const DONE = '做完：用几句话告诉我：原来哪里不对、你改了什么、回 StudyHub 点哪个按钮（{0}）、点完会看到什么，以及再出同样的错时要把什么发回来{1}。';
const DONE_PERMISSION = '；最后提醒我把权限换回原来的选项';
const PRESS_FIX = '这次点「{0}」';
const PRESS_CHECK = '先点「{0}」，卡片还显示出错的话再点「{1}」';
const PRESS_CHECK_ONLY = '先点「{0}」';

// The fix button of each fix id, in the card's own words; ui/mineru-install-flow.js, live-local-flow.js and live-loopback-flow.js decide which fix a code gets (a test pins
// the words). 'vc-runtime' is the card's download button: once the runtime is installed the learner presses 重试.
const BUTTONS = Object.freeze({
  retry: '重试', 'switch-source': '换下载源重试', continue: '继续安装', relocate: '换位置', 'restart-service': '重新启动服务',
  'stop-external': '停止另一份 MinerU 并重试', 'vc-runtime': '重试', recheck: '重新检测', repair: '修复',
  // MinerU's card (#942): during an install it resets the permissions of the files in the settings folder, for a service start it restarts after doing so (see permissionButton)
  'repair-permissions': '修复权限',
});
const PERMISSION_RESTART = '修复权限并重启';
/** The permission-repair button of the MinerU card: 「修复权限」 during an install, 「修复权限并重启」 for a service start. */
const permissionButton = status => (originOf(status) === 'service' ? PERMISSION_RESTART : BUTTONS['repair-permissions']);
const LOOPBACK_CONTINUE = '重新安装';
const ENDED = ['failed', 'cancelled', 'interrupted'];
const originOf = status => /\((install|service|check)\)/.exec(status)?.[1] || '';
const buttonOf = id => (Object.hasOwn(BUTTONS, id) ? BUTTONS[id] : BUTTONS.repair); // a fix added later: the card's default

// What the extension's card offers: no single fix button, so sentences (the service that did not start clears itself once DSH restarts).
const EXTENSION_PRESS = Object.freeze({
  'companion-not-started': '重启 DSH 后这张卡片会自己消失；还在的话点「修复」',
  'retrieval-index-unavailable': '重启 DSH 后这张卡片会自己消失；还在的话点「修复」',
  'extension-install-failed': '再点一次「安装检索扩展」',
  'extension-update-failed': '再点一次「更新检索扩展」',
});
const EXTENSION_PRESS_INDEX = '再点一次建立索引的按钮';

/** The card's controls for this failure: { fix, check } as Chinese labels ('' when it has none): the check control first, the fix button if the card still shows the error. */
function controlsOf(tool, { code, status, external, source, attempts }) {
  if (tool === 'marker') {
    if (ENDED.includes(status)) return { fix: '重试', check: '' };
    return { fix: '', check: status === 'blocked' || status === 'needs-docker' ? '重新检测' : '检测并保存' };
  }
  if (tool === 'live-local') return { fix: buttonOf(localFix(code).id), check: '' };
  if (tool === 'live-loopback') { const id = loopbackFix(code).id; return { fix: id === 'continue' ? LOOPBACK_CONTINUE : buttonOf(id), check: '' }; }
  // home-permissions is named here too, so this fits whether or not fixFor knows the new fix id yet
  const id = code === 'home-permissions' ? 'repair-permissions' : fixFor(code, { origin: originOf(status), external: !!external, source, attempts: Number(attempts) || 1 }).id;
  return { fix: id === 'repair-permissions' ? permissionButton(status) : buttonOf(id), check: '重新检测' };
}

/** What to press back in StudyHub, as one phrase in `language`. */
function pressPhrase(tool, spec, input, language) {
  if (tool === 'retrieval-extension') return say(language, Object.hasOwn(EXTENSION_PRESS, input.code) ? EXTENSION_PRESS[input.code] : EXTENSION_PRESS_INDEX);
  const ids = repairIdsFor(tool, input.code), { fix, check } = controlsOf(tool, input);
  // The location truly cannot be used: the move button is the answer, whatever the card's fix is called.
  if (ids.length === 1 && ids[0] === 'location' && spec.move) return say(language, PRESS_FIX, [say(language, spec.move)]);
  if (check && fix && fix !== check) return say(language, PRESS_CHECK, [say(language, check), say(language, fix)]);
  return say(language, check ? PRESS_CHECK_ONLY : PRESS_FIX, [say(language, check || fix)]);
}

function repairsLine(tool, spec, code, status, language) {
  const ids = repairIdsFor(tool, code);
  if (!ids.length) return say(language, REPAIRS_UNKNOWN);
  const values = [VC_REDIST_URL, ...['install', 'repair', 'uninstall', 'move', 'source'].map(key => (spec[key] ? say(language, spec[key]) : '')), say(language, permissionButton(status))];
  return say(language, REPAIRS, [partsOf(language, ids.map(id => say(language, SETUP_REPAIRS[id], values)))]);
}

/**
 * input: { tool ('mineru' | 'marker' | 'live-local' | 'live-loopback' | 'retrieval-extension'), status, stage, code, summary,
 *   folder, tier, model, source, python, version, command, external, course, attempts, log }.
 */
export function setupFailedPrompt({
  tool = 'mineru', status = '', stage = '', code = '', summary = '', folder = '', tier = '', model = '',
  source = '', python = '', version = '', command = '', external = '', course = '', attempts = '', log = '',
} = {}, language = getUiLanguage()) {
  const key = Object.hasOwn(SETUP_TOOLS, tool) ? tool : 'mineru';
  const spec = SETUP_TOOLS[key];
  const error = [summary, log].filter(Boolean).join('\n\n');
  const writes = needsWrite(key, code);
  // The notes only name things from the tables above; the failure's own fields (code, stage, log…) stay in the data fence.
  return situationMessage({
    area: spec.area,
    goal: spec.goal,
    context: 'imports',
    how: say(language, HOW) + (spec.tail ? say(language, spec.tail) : ''), // (an English tail starts with its space)
    hints: [
      repairsLine(key, spec, code, status, language),
      ...(writes ? [say(language, PERMISSION)] : []),
      say(language, BOUNDARY, [say(language, spec.place), spec.tail ? say(language, EXCEPTION) : '']),
    ],
    never: say(language, NEVER),
    report: say(language, DONE, [pressPhrase(key, spec, { code, status, external, source, attempts }, language), writes ? say(language, DONE_PERMISSION) : '']),
    facts: { tool: spec.label, status, stage, code, folder, tier, model, source, python, version, command, external, course },
    error,
  }, language);
}
