import { getUiLanguage } from '../i18n.js';
import { situationMessage } from './situation.js';

/* The hand-off ('setup.failed') of a local tool or companion service (MinerU, Marker, live-local speech engine, live-loopback
   system-audio helper, or the search extension) that did not install, start or pass its check. Built on situation.js: one table
   maps each tool to its area, goal and boundary so every setup card shares the same structure with zero per-page prompt logic. */

const SETUP_TOOLS = Object.freeze({
  mineru: {
    label: 'MinerU',
    area: 'PDF 转换设置',
    goal: '排查本机 MinerU 的报错并解决',
    how: '做法：先根据下面的「情况」和「错误原文」查清报错原因，用大白话告诉我；需要检查或修复这台电脑的环境（例如 Python 版本、目录权限、端口占用、VC++ 运行库或网络源）时，先说明要运行什么命令并等我同意；如果我急着导入 PDF，也可以先帮我把转换结果写到工作区的 studyhub-work/ 下再用 study_materials 的 document.import 导入。',
    boundary: '边界：安装、卸载或修改 MinerU 与 Marker 设置只能由我在「设置 › PDF 转换」里点按钮完成；环境修好后，直接告诉我回设置页点哪个按钮（例如「修复」「重试」或「重新检测」）。',
  },
  marker: {
    label: 'Marker',
    area: 'PDF 转换设置',
    goal: '排查本机 Marker 的报错并解决',
    how: '做法：先根据下面的「情况」和「错误原文」查清报错原因，用大白话告诉我；需要检查或修复这台电脑的环境（例如 Python 版本、目录权限、端口占用、VC++ 运行库或网络源）时，先说明要运行什么命令并等我同意；如果我急着导入 PDF，也可以先帮我把转换结果写到工作区的 studyhub-work/ 下再用 study_materials 的 document.import 导入。',
    boundary: '边界：安装、卸载或修改 MinerU 与 Marker 设置只能由我在「设置 › PDF 转换」里点按钮完成；环境修好后，直接告诉我回设置页点哪个按钮（例如「修复」「重试」或「重新检测」）。',
  },
  'live-local': {
    label: 'live-local',
    area: '音频转写设置',
    goal: '排查本地语音识别引擎的报错并解决',
    how: '做法：先根据下面的「情况」和「错误原文」查清报错原因，用大白话告诉我；需要检查或修复这台电脑的环境（例如磁盘空间、目录权限、VC++ 运行库、杀毒软件拦截或网络源）时，先说明要运行什么命令并等我同意；如果我急着处理已有录音，也可以用 study_materials 的 audio.import 导入。',
    boundary: '边界：安装、修复或删除本地转写引擎只能由我在「课堂实录」或「设置 › 音频转写」里点按钮完成；环境修好后，直接告诉我回去点哪个按钮（例如「修复」「重试」或「换位置」）。',
  },
  'live-loopback': {
    label: 'live-loopback',
    area: '音频转写设置',
    goal: '排查电脑声音直采组件的报错并解决',
    how: '做法：先根据下面的「情况」和「错误原文」查清报错原因，用大白话告诉我；需要检查或修复这台电脑的环境（例如 Windows 系统组件、目录权限、播放设备或杀毒软件拦截）时，先说明要运行什么命令并等我同意。',
    boundary: '边界：安装、修复或卸载电脑声音组件只能由我在「课堂实录」或「设置 › 音频转写」里点按钮完成；环境修好后，直接告诉我回去点哪个按钮（例如「修复」「重新安装」或「换位置」）。',
  },
  'retrieval-extension': {
    label: 'retrieval-extension',
    area: '检索扩展设置',
    goal: '排查检索扩展或检索索引的报错并解决',
    how: '做法：先根据下面的「情况」和「错误原文」查清报错原因，用大白话告诉我；需要检查或修复这台电脑的环境（例如网络源、目录权限、检索模型下载或 DSH 运行状态）时，先说明要运行什么命令并等我同意。',
    boundary: '边界：安装、更新、修复或卸载检索扩展及建立索引只能由我在 StudyHub 界面里点按钮完成；环境修好后，直接告诉我回界面点哪个按钮（例如「重试」「修复」或重启 DSH）。',
  },
});

/**
 * input: { tool ('mineru' | 'marker' | 'live-local' | 'live-loopback' | 'retrieval-extension'), status, stage, code, summary,
 *   folder, tier, model, source, python, version, command, external, course, log }.
 */
export function setupFailedPrompt({
  tool = 'mineru', status = '', stage = '', code = '', summary = '', folder = '', tier = '', model = '',
  source = '', python = '', version = '', command = '', external = '', course = '', log = '',
} = {}, language = getUiLanguage()) {
  const spec = Object.hasOwn(SETUP_TOOLS, tool) ? SETUP_TOOLS[tool] : SETUP_TOOLS.mineru;
  const error = [summary, log].filter(Boolean).join('\n\n');
  return situationMessage({
    area: spec.area,
    goal: spec.goal,
    context: 'imports',
    how: spec.how,
    hints: [spec.boundary],
    facts: { tool: spec.label, status, stage, code, folder, tier, model, source, python, version, command, external, course },
    error,
  }, language);
}
