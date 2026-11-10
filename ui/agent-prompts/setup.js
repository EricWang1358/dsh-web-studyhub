import { getUiLanguage } from '../i18n.js';
import { say } from './say.js';
import { partsOf } from './message.js';
import { situationMessage } from './situation.js';
import { SETUP_REPAIRS, repairIdsFor } from './setup-repairs.js';
import { VC_REDIST_URL, fixFor } from '../mineru-install-flow.js';
import { localFix } from '../live-local-flow.js';
import { loopbackFix } from '../live-loopback-flow.js';

/* The hand-off ('setup.failed') of a local tool or companion service (MinerU, Marker, live-local speech engine, live-loopback
   system-audio helper, or the search extension) that did not install, start or pass its check. Built on situation.js: one table
   maps each tool to its area, goal, place and install button, so every setup card shares the same structure with zero per-page prompt logic.
   The chat may repair this computer's environment for the tool, step by step (#939, option A): what it may do for the failure's code is the
   table of ui/agent-prompts/setup-repairs.js; installing and uninstalling stay the learner's buttons (lib/assistant-boundary.js refuses them),
   so the last line names the button to press back, from the card's own pure rules (fixFor / localFix / loopbackFix). */

const PDF_TAIL = '如果我急着导入 PDF，也可以先帮我把转换结果写到工作区的 studyhub-work/ 下再用 study_materials 的 document.import 导入。';
const AUDIO_TAIL = '如果我急着处理已有录音，也可以先问我是否改用云端转写，再用 study_audio 的 audio.import 导入。';

const SETUP_TOOLS = Object.freeze({
  mineru: {
    label: 'MinerU',
    area: 'PDF 转换设置',
    goal: '排查本机 MinerU 的报错并解决',
    checks: '安装位置能不能写、报错里被拒绝的是哪个路径、配置文件夹里已有文件的权限、本机服务的端口有没有被占',
    tail: PDF_TAIL,
    place: '「设置 › PDF 转换」',
    install: '一键安装',
  },
  marker: {
    label: 'Marker',
    area: 'PDF 转换设置',
    goal: '排查本机 Marker 的报错并解决',
    checks: '安装位置能不能写、路径有多长、系统里的 Python 版本、磁盘空间',
    tail: PDF_TAIL,
    place: '「设置 › PDF 转换」',
    install: '一键安装 Marker',
  },
  'live-local': {
    label: 'live-local',
    area: '音频转写设置',
    goal: '排查本地语音识别引擎的报错并解决',
    checks: '安装位置能不能写、磁盘空间、VC++ 运行库、杀毒软件有没有隔离文件',
    tail: AUDIO_TAIL,
    place: '「课堂实录」或「设置 › 音频转写」',
    install: '安装本地转写引擎',
  },
  'live-loopback': {
    label: 'live-loopback',
    area: '音频转写设置',
    goal: '排查电脑声音直采组件的报错并解决',
    checks: '安装位置能不能写、Windows 系统组件、默认播放设备、杀毒软件有没有隔离文件',
    tail: '',
    place: '「课堂实录」或「设置 › 音频转写」',
    install: '安装电脑声音组件',
  },
  'retrieval-extension': {
    label: 'retrieval-extension',
    area: '检索扩展设置',
    goal: '排查检索扩展或检索索引的报错并解决',
    checks: '检索服务有没有在运行、检索模型能不能下载、网络',
    tail: '',
    place: '「设置 › 检索扩展」',
    install: '',
  },
});

const HOW = '做法：先根据下面的「情况」和「错误原文」查清真正的原因，用大白话告诉我；卡片上的说法只是从报错原文猜的，不要照单全收，要自己检查（{0}）。查清后可以直接动手修这台电脑上与它有关的环境，一步一步来：每一步先说明做什么、会改哪里，再去做；要结束进程或删除文件的步骤先问我，我说好再动手；修完用它自己的无害命令验证（例如看版本、启动再停止本地服务），验证时自己启动的东西用完就停掉。';
const REPAIRS = '修复：按「情况」里 code 的这个原因，你可以做：{0}。';
const REPAIRS_UNKNOWN = '修复：「情况」里的 code 不在已知清单里：先查清原因，只做和它直接有关、能撤回的修复，拿不准的先问我。';
const PERMISSION = '权限：这些修复多半要改 StudyHub 文件夹以外的东西（比如这个工具的安装位置）。命令被文件权限拒绝时，不要放弃，也不要把命令丢给我自己敲；告诉我在主会话输入框左下角的权限菜单里选「完全权限」（每个会话单独设置，StudyHub 替我切不了），再重试同一步。';
const BOUNDARY = '边界：修复时不要读取或修改学习库和 DSH 自己的设置，不要动与这次修复无关的文件，不要保存或打印任何密钥，也不要自己安装或卸载这个工具（StudyHub 的安装、卸载操作对你是关着的）；这些只能由我在{0}里点按钮完成。';
const DONE = '做完：用几句话告诉我：原来哪里不对、你改了什么、回 StudyHub 点哪个按钮（{0}）、点完会看到什么，以及再出同样的错时要把什么发回来；最后提醒我把权限换回原来的选项。';
const PRESS = '这次点「{0}」';

// The button of each fix id, in the card's own words; ui/mineru-install-flow.js, live-local-flow.js and live-loopback-flow.js decide which fix a code gets (a test pins the words).
// 'vc-runtime' is the card's download button: once the runtime is installed the learner presses 重试.
const BUTTONS = Object.freeze({
  retry: '重试', 'switch-source': '换下载源重试', continue: '继续安装', relocate: '换位置', 'restart-service': '重新启动服务',
  'stop-external': '停止另一份 MinerU 并重试', 'vc-runtime': '重试', recheck: '重新检测', repair: '修复',
});
const LOOPBACK_CONTINUE = '重新安装';
const ENDED = ['failed', 'cancelled', 'interrupted'];
const originOf = status => /\((install|service|check)\)/.exec(status)?.[1] || '';

// What the extension's card offers: the service that did not start clears itself once DSH restarts; the others are retried from the card's own buttons.
const EXTENSION_PRESS = Object.freeze({
  'companion-not-started': '重启 DSH 后这张卡片会自己消失；还在的话点「修复」',
  'extension-install-failed': '再点一次「安装检索扩展」',
  'extension-update-failed': '再点一次「更新检索扩展」',
});
const EXTENSION_PRESS_INDEX = '再点一次建立索引的按钮';

/** The fix id the card gives this failure, from the card's own pure rules. */
function fixIdOf(tool, { code, status, external, source }) {
  if (tool === 'marker') return ENDED.includes(status) ? 'retry' : 'recheck';
  if (tool === 'live-local') return localFix(code).id;
  if (tool === 'live-loopback') return loopbackFix(code).id;
  return fixFor(code, { origin: originOf(status), external: !!external, source }).id;
}

/** What to press back in StudyHub, as one phrase in `language`. */
function pressPhrase(tool, input, language) {
  if (tool === 'retrieval-extension') return say(language, Object.hasOwn(EXTENSION_PRESS, input.code) ? EXTENSION_PRESS[input.code] : EXTENSION_PRESS_INDEX);
  const id = fixIdOf(tool, input);
  const label = tool === 'live-loopback' && id === 'continue' ? LOOPBACK_CONTINUE : BUTTONS[id];
  return say(language, PRESS, [say(language, label)]);
}

function repairsLine(tool, spec, code, language) {
  const ids = repairIdsFor(tool, code);
  if (!ids.length) return say(language, REPAIRS_UNKNOWN);
  const values = [VC_REDIST_URL, spec.install ? say(language, spec.install) : ''];
  return say(language, REPAIRS, [partsOf(language, ids.map(id => say(language, SETUP_REPAIRS[id], values)))]);
}

/**
 * input: { tool ('mineru' | 'marker' | 'live-local' | 'live-loopback' | 'retrieval-extension'), status, stage, code, summary,
 *   folder, tier, model, source, python, version, command, external, course, log }.
 */
export function setupFailedPrompt({
  tool = 'mineru', status = '', stage = '', code = '', summary = '', folder = '', tier = '', model = '',
  source = '', python = '', version = '', command = '', external = '', course = '', log = '',
} = {}, language = getUiLanguage()) {
  const key = Object.hasOwn(SETUP_TOOLS, tool) ? tool : 'mineru';
  const spec = SETUP_TOOLS[key];
  const error = [summary, log].filter(Boolean).join('\n\n');
  // The notes only name things from the tables above; the failure's own fields (code, stage, log…) stay in the data fence.
  const how = say(language, HOW, [say(language, spec.checks)]);
  const tail = spec.tail ? say(language, spec.tail) : '';
  return situationMessage({
    area: spec.area,
    goal: spec.goal,
    context: 'imports',
    how: how + tail, // (an English tail starts with its space)
    hints: [
      repairsLine(key, spec, code, language),
      say(language, PERMISSION),
      say(language, BOUNDARY, [say(language, spec.place)]),
    ],
    report: say(language, DONE, [pressPhrase(key, { code, status, external, source }, language)]),
    facts: { tool: spec.label, status, stage, code, folder, tier, model, source, python, version, command, external, course },
    error,
  }, language);
}
